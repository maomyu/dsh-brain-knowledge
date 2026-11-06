/** Task-scoped stdio knowledge application plugin, launched only through a dsh profile. */
import { addAbortListener } from 'node:events'
import { isAbsolute, parse, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openNativeKnowledge } from '@deepseek-ai/dsh-api-task-controller/native-knowledge'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectTaskId } from '@deepseek-ai/dsh-api-task-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeLocationRevision, KnowledgeTerminalEvent } from './types.ts'
import { terminalKnowledgeSource } from './terminal-source.ts'
import { createNativeKnowledgeQueries } from './native-task.ts'
import { TerminalKnowledgePolicy } from './terminal-policy.ts'
import { requireTerminalKnowledgeGrant } from './terminal-grant.ts'

/** Cordis application plugin name. */
export const name = 'task-knowledge-terminal'
/** No workspace registry, model, web server or application database is mounted by this consumer. */
export const inject = ['fs', 'sessions', 'sessionPersistence']

/** Original project identity, live Host grant endpoint and query allowances supplied by the private profile. */
export interface Config extends TerminalKnowledgePolicy {
  taskId: string
  initialInput: string
  projectId: string
  projectPath: string
  brainPath: string
  locationRevision: string | null
  grantEndpoint: string
}

/** Explicit project grant with the shared terminal query policy. */
export const Config: z<Config> = z.intersect([TerminalKnowledgePolicy, z.object({
  taskId: z.string().min(1).required(), projectId: z.string().min(1).required(),
  initialInput: z.string().min(1).required(),
  projectPath: z.string().min(1).required(), brainPath: z.string().min(1).required(),
  locationRevision: z.union([z.string().min(1), z.const(null)]).default(null),
  grantEndpoint: z.string().min(1).required(),
})])

/** Mount one stdio service whose queries and Session writes settle before profile shutdown.
 * @param ctx - dsh-launched filesystem and Session persistence services.
 * @param config - validated task grant and explicit query bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('Task knowledge terminal requires the dsh profile launcher')
  for (const path of [config.projectPath, config.brainPath]) {
    if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path || parse(path).root === path) {
      throw new Error('Terminal knowledge requires normalized absolute project and Brain directories, not a filesystem root')
    }
  }
  const lifetime = new AbortController()
  const work = serve(ctx, config, lifetime)
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Task knowledge profile disposed'))
    await work.catch(() => { /* The attached completion handler reports a failed serve operation to the launcher. */ })
  }, 'terminal knowledge: revoke and drain')
  void work.then(() => { exit(0) }, (error: unknown) => {
    ctx.logger.error('Task knowledge terminal failed', error)
    exit(1)
  })
}

async function serve(ctx: Context, config: Config, lifetime: AbortController): Promise<void> {
  const authorize = (signal: AbortSignal) => requireTerminalKnowledgeGrant(config.grantEndpoint, signal)
  await authorize(AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.queryTimeoutMs)]))
  const location = { workspaceId: brandString<WorkspaceId>(config.projectId), projectPath: config.projectPath,
    path: config.brainPath, directory: config.brainPath, isDefault: false,
    revision: config.locationRevision === null ? null : brandString<KnowledgeLocationRevision>(config.locationRevision) }
  const taskId = brandString<ProjectTaskId>(config.taskId)
  const session = ctx.sessions.prepare(undefined, { meta: { cwd: config.projectPath } })
  await using handle = await ctx.sessionPersistence.create(session.header)
  let writes = Promise.resolve()
  const append = (data: KnowledgeTerminalEvent): Promise<void> => {
    writes = writes.then(async () => {
      const event = session.append('knowledge/terminal', data)
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > config.maxEventBytes) throw new Error('Complete terminal knowledge Session event exceeds maxEventBytes')
      await handle.append([event])
      await handle.flush()
    })
    return writes
  }
  await append({ kind: 'opened', taskId, initialInput: config.initialInput, location })
  const source = terminalKnowledgeSource(ctx.fs, location, config,
    (signal) => { signal.throwIfAborted(); lifetime.signal.throwIfAborted() },
    async (access) => {
      await authorize(AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.queryTimeoutMs)]))
      await append({ kind: 'access', access })
    })
  await using queries = await openNativeKnowledge(createNativeKnowledgeQueries(source, config), lifetime.signal, config.maxEventBytes,
    json => append({ kind: 'notification', json }))
  const tools = queries.tools
  /* v8 ignore if -- A defined query reader makes openNativeKnowledge retain its tools. */
  if (tools === undefined) throw new Error('Terminal knowledge query definitions were not retained')
  const server = new McpServer({ name: 'brain', version: '1.0.0' }, { capabilities: { tools: {} } })
  const closed = Promise.withResolvers<undefined>()
  const listener = addAbortListener(lifetime.signal, () => { closed.resolve(undefined) })
  const end = () => { lifetime.abort(new Error('Terminal knowledge stdin ended')) }
  process.stdin.once('end', end)
  server.server.onclose = () => { lifetime.abort(new Error('Terminal knowledge peer closed')); closed.resolve(undefined) }
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    lifetime.signal.throwIfAborted()
    await authorize(AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.queryTimeoutMs)]))
    return { tools: tools.definitions.map(tool => ({ ...tool,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) }
  })
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const signal = AbortSignal.any([lifetime.signal, extra.signal, AbortSignal.timeout(config.queryTimeoutMs)])
    await authorize(signal)
    const result = await tools.call(request.params.name, request.params.arguments ?? {}, signal)
    await authorize(signal)
    signal.throwIfAborted()
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError }
  })
  try {
    await server.connect(new StdioServerTransport())
    if (process.stdin.readableEnded) end()
    await closed.promise
  } finally {
    listener[Symbol.dispose]()
    process.stdin.off('end', end)
    lifetime.abort(new Error('Terminal knowledge connection closed'))
    try { await server.close() }
    finally { await queries[Symbol.asyncDispose]() }
  }
  await append({ kind: 'closed' })
}
