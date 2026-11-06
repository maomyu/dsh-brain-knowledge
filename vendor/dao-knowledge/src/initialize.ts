/** Desktop conversation preparation fills absent local Brain outlines without replacing knowledge. */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-task-controller'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from './index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { z } from 'zod'
import { ensureLocalBrain, inspectBrainPath } from './local-brain.ts'
import { hasTaskInput } from './model-task.ts'
import type { KnowledgeLocation } from './types.ts'

/** Project-relative local directory; must match the knowledge controller. */
export interface Config { readonly directory: string }

/** Loader identity for the explicitly mounted local initialization policy. */
export const name = 'project-brain-initialize'
/** Task ownership and project membership must be available before admitting a write. */
export const inject = ['workspaceRegistry', 'taskController', 'agents', 'fs', 'storageDomain', 'knowledgeController']
/** No remote or cwd-derived project is initialized by this plugin. */
export const Config: Schema<Config> = Schema.object({ directory: Schema.string().required() })

const initialization = defineDomain({ name: 'knowledge_initialization', version: 1, tables: {
  projects: domainTable<WorkspaceId, { path: string; directory: string; updatedAt: string; complete: boolean }>(z.object({
    path: z.string().min(1), directory: z.string().min(1), updatedAt: z.iso.datetime(), complete: z.boolean(),
  })),
} })

/**
 * Await missing local outlines before an attached discussion starts; existing regular files remain unchanged.
 * @param ctx - Host-owned project, task, filesystem and durable storage services.
 * @param config - relative Brain location, without traversal or symlink components.
 * @returns after registering the awaited preparation listener; disposal cancels and drains admitted work.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const parts = config.directory.split('/')
  if (/[\\:\0]/.test(config.directory) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('project-brain-initialize: directory must be project-relative without traversal')
  }
  const domain = await ctx.storageDomain.open(initialization)
  const table = domain.table('projects')
  const lifetime = new AbortController()
  const pending = new Map<WorkspaceId, Promise<void>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending.values()])
    await domain.close()
  }, 'project-brain-initialize: local writes')

  const prepare = async (location: KnowledgeLocation, sessionId: SessionId, signal: AbortSignal): Promise<void> => {
    const workspaceId = location.workspaceId
    signal.throwIfAborted()
    const project = ctx.workspaceRegistry.get(workspaceId)
    if (project === undefined || !project.sessionIds.includes(sessionId)) throw new Error('Project membership changed before initialization')
    const session = ctx.agents.get(sessionId)?.session
    if (ctx.taskController.projectForSession(sessionId) !== undefined || (session !== undefined && hasTaskInput(session))) return
    const authorize = async (): Promise<void> => {
      signal.throwIfAborted()
      const current = ctx.workspaceRegistry.get(workspaceId)
      if (current?.path !== project.path || !current.sessionIds.includes(sessionId)) throw new Error('Project membership changed before initialization')
      if (ctx.taskController.projectForSession(sessionId) !== undefined) throw new Error('Execution Tasks cannot initialize project knowledge')
      if (await realpath(project.path) !== project.path) throw new Error('Project location changed before initialization')
      signal.throwIfAborted()
    }
    await authorize()
    if (location.revision !== null) {
      // A saved external destination may be an unmounted drive; only explicit selection can recreate it.
      const info = await inspectBrainPath(location.path)
      if (info === undefined) throw new Error('Selected Brain directory is unavailable; select an available Brain before continuing')
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Brain directory must not contain links or files')
      const parent = dirname(location.path)
      await ensureLocalBrain(ctx.fs, parent, [basename(location.path)], new Date().toISOString(), signal, authorize)
      return
    }
    if (location.directory !== config.directory) throw new Error('Brain initializer directory must match the knowledge controller')
    const prior = table.get(workspaceId)
    if (prior !== undefined && (prior.path !== project.path || prior.directory !== config.directory)) {
      throw new Error('Brain initialization location differs from its durable record')
    }
    // Directory creation is local; an unshared filesystem provider must fail before any native write.
    const processRoot = ctx.fs.processPathFromHostPath(project.path)
    if (processRoot === undefined) throw new Error('Brain initialization requires a Host-shared filesystem')
    let directory = project.path
    for (const part of parts) {
      directory = join(directory, part)
      const info = await inspectBrainPath(directory)
      if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Brain directory must not contain links or files')
    }
    const record = prior?.complete === false ? prior
      : { path: project.path, directory: config.directory, updatedAt: new Date().toISOString(), complete: false }
    await authorize()
    await table.put(workspaceId, record)
    await ensureLocalBrain(ctx.fs, project.path, parts, record.updatedAt, signal, authorize)
    await table.put(workspaceId, { ...record, complete: true })
  }
  ctx.on('api-session/prepare-project', async (workspaceId, sessionId) => {
    // A second conversation rechecks its own membership after the project's earlier operation settles.
    const earlier = pending.get(workspaceId)
    const operation = (async () => {
      if (earlier !== undefined) { try { await earlier } catch { /* This caller retries the retained partial initialization. */ } }
      lifetime.signal.throwIfAborted()
      await ctx.knowledgeController.withLocation(workspaceId, lifetime.signal, async (location, live) => {
        await prepare(location, sessionId, live)
      })
    })()
    pending.set(workspaceId, operation)
    try { await operation } finally { if (pending.get(workspaceId) === operation) pending.delete(workspaceId) }
  })
}
