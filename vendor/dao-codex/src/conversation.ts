/** Codex CLI model route; the Harness owns conversation history and tool execution. */
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { listCodexModels, type CodexModelChoice } from './models.ts'
import { startCodexRun } from './run.ts'
import type { CodexConversationEvent } from './types.ts'

/** Deployment-owned native request, catalog, and audit bounds. */
export interface CodexConversationConfig {
  /** Expose the native CLI route in ordinary conversation model catalogs. */
  enabled: boolean
  /** Non-empty LLM route name, independent of the subagent registry name. */
  providerName: string
  /** Maximum native model request lifetime in milliseconds, including startup. */
  timeoutMs: number
  /** Maximum native catalog lookup lifetime in milliseconds. */
  catalogTimeoutMs: number
  /** Inclusive UTF-8 bytes of the complete serialized conversation request. */
  maxRequestBytes: number
  /** Inclusive UTF-8 bytes of each complete audit event and queued native notifications. */
  maxEventBytes: number
  /** Inclusive native catalog entry count, including hidden entries. */
  maxModels: number
  /** Inclusive native catalog response bytes across initialization and all pages. */
  maxCatalogBytes: number
  /** Inclusive bytes of the complete effective native configuration response. */
  maxConfigBytes: number
  /** Maximum ambient MCP entries disabled before native inference. */
  maxMcpServers: number
}

/** Validated defaults remain configurable through the owning plugin row. */
export const ConversationConfig: z<Partial<CodexConversationConfig>, CodexConversationConfig> = z.object({
  enabled: z.boolean().default(false), providerName: z.string().min(1).default('codex-cli'),
  timeoutMs: z.natural().min(1).max(2_147_483_647).default(300000),
  catalogTimeoutMs: z.natural().min(1).max(2_147_483_647).default(30000),
  maxRequestBytes: z.natural().min(1).default(4000000), maxEventBytes: z.natural().min(1).default(8000000),
  maxModels: z.natural().min(1).default(200), maxCatalogBytes: z.natural().min(1).default(2000000),
  maxConfigBytes: z.natural().min(1).default(2000000), maxMcpServers: z.natural().default(100),
})

const instructions = 'Act as the model of the supplied Harness conversation. The input is JSON containing its complete ordered messages and available tool definitions. Follow its system instructions and answer the latest input. Do not use native Codex tools or inspect local files. Request Harness tools only by returning toolCalls; each arguments value is a JSON string. Return text for the user and an empty toolCalls array when no tool is needed. Never claim a requested tool has executed until its result appears in the supplied history.'

function outputSchema(names: readonly string[]): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['text', 'toolCalls'], properties: {
    text: { type: 'string' }, toolCalls: { type: 'array', ...(names.length === 0 ? { maxItems: 0 } : {}),
      items: { type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
        name: names.length === 0 ? { type: 'string' } : { type: 'string', enum: names }, arguments: { type: 'string' },
      } } },
  } }
}

/** Validate untrusted native output before publishing any assistant content or tool request.
 * @param text - complete native structured reply.
 * @param names - exact tool names advertised for this request.
 * @returns text and validated tool requests; arguments remain JSON for the Harness executor.
 */
export function parseCodexConversationOutput(text: string, names: readonly string[]): {
  text: string
  toolCalls: { name: string; arguments: string }[]
} {
  const value: unknown = JSON.parse(text)
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!record(value) || typeof value.text !== 'string' || !Array.isArray(value.toolCalls)
    || Object.keys(value).some(key => key !== 'text' && key !== 'toolCalls')) throw new Error('Invalid Codex CLI reply')
  const toolCalls = value.toolCalls.map((call) => {
    if (!record(call) || typeof call.name !== 'string' || !names.includes(call.name) || typeof call.arguments !== 'string'
      || Object.keys(call).some(key => key !== 'name' && key !== 'arguments')) throw new Error('Invalid Codex CLI tool request')
    const args: unknown = JSON.parse(call.arguments)
    if (!record(args)) throw new Error('Codex CLI tool arguments must be an object')
    return { name: call.name, arguments: call.arguments }
  })
  if (value.text.trim() === '' && toolCalls.length === 0) throw new Error('Codex CLI returned an empty reply')
  return { text: value.text, toolCalls }
}

/** One caller may stop waiting without cancelling discovery shared with other callers. */
function waitForCatalog(result: Promise<readonly CodexModelChoice[]>, signal?: AbortSignal): Promise<readonly CodexModelChoice[]> {
  if (signal === undefined) return result
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const listener = addAbortListener(signal, () => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('Codex CLI model resolution was cancelled', { cause: reason }))
    })
    void result.then((models) => {
      listener[Symbol.dispose]()
      resolve(models)
    }, (error: unknown) => {
      listener[Symbol.dispose]()
      if (error instanceof Error) reject(error)
      else reject(new Error('Codex CLI model discovery failed', { cause: error }))
    })
  })
}

/** Native model discovery and request execution over the existing managed subprocess provider. */
export class CodexConversationAdapter extends LlmAdapter {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private catalogPending: Promise<readonly CodexModelChoice[]> | undefined
  private catalogSnapshot: readonly CodexModelChoice[] | undefined

  /** Revoke model and catalog requests and join their managed process cleanup. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.lifetime.abort(new Error('Codex CLI provider was unloaded'))
    await Promise.allSettled([...this.pending])
  }

  /**
   * @param ctx - scoped native subprocess and durable Session owners.
   * @param config - validated model-route and transport limits.
   * @param graceMs - managed process termination grace.
   * @param env - explicit native environment, layered over the shared credential scrub.
   */
  constructor(private readonly ctx: Context, private readonly config: CodexConversationConfig,
    private readonly graceMs: number, private readonly env: Record<string, string>) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'Codex CLI' } }

  override async listModels(provider: string) {
    return (await this.catalog()).map(model => ({ provider, id: model.model, name: model.label,
      description: model.description, inputModalities: ['text' as const] }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const selected = (this.catalogSnapshot ?? await this.catalog(signal)).find(item => item.model === model)
    if (selected === undefined) throw new LlmError('Codex CLI model is unavailable', 'MODEL_NOT_FOUND')
    return { provider, id: model, name: selected.label, inputModalities: ['text'], reasoning: {
      efforts: selected.reasoningEfforts.map(item => ({ id: ReasoningEffortId(item.id), name: item.id, description: item.description })),
      defaultEffort: ReasoningEffortId(selected.defaultReasoningEffort),
    } }
  }

  private catalog(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.catalogPending !== undefined) return waitForCatalog(this.catalogPending, signal)
    const result = listCodexModels({ cwd: process.cwd(), env: this.env, disposeGraceMs: this.graceMs,
      timeoutMs: this.config.catalogTimeoutMs, maxModels: this.config.maxModels, maxBytes: this.config.maxCatalogBytes,
      spawn: spec => this.ctx.subprocess.spawn(spec) }, this.lifetime.signal)
    this.catalogPending = result
    this.pending.add(result)
    void result.then((models) => {
      this.catalogSnapshot = models
      this.catalogPending = undefined
      this.pending.delete(result)
    }, () => {
      this.catalogSnapshot = undefined
      this.catalogPending = undefined
      this.pending.delete(result)
    })
    return waitForCatalog(result, signal)
  }

  override async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
    if (session === undefined) throw new LlmError('Codex CLI requires an active Harness conversation', 'SESSION_NOT_FOUND')
    const names = (options.tools ?? []).map(tool => tool.name)
    const text = JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools ?? [] })
    if (Buffer.byteLength(text) > this.config.maxRequestBytes) throw new LlmError('Codex CLI request exceeds maxRequestBytes', 'REQUEST_TOO_LARGE')
    const callId = brandString<MessageId>(randomUUID())
    const audit = async (event: CodexConversationEvent): Promise<void> => {
      const candidate = { type: 'codex-model/call', data: event, seq: session.seq, time: Date.now() }
      if (Buffer.byteLength(JSON.stringify(candidate)) > this.config.maxEventBytes) throw new Error('Codex CLI audit exceeds maxEventBytes')
      session.append('codex-model/call', event)
      if (!await this.ctx.sessions.flush(session)) throw new Error('Codex CLI audit could not be saved')
    }
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal, options.signal ?? new AbortController().signal])
    const timer = setTimeout(() => { lifetime.abort(new Error('Codex CLI model request timed out')) }, this.config.timeoutMs)
    timer.unref()
    const done = Promise.withResolvers<void>()
    this.pending.add(done.promise)
    let directory: string | undefined
    try {
      signal.throwIfAborted()
      await audit({ callId, kind: 'input', text, model: options.model, instructions, outputSchema: JSON.stringify(outputSchema(names)),
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) })
      signal.throwIfAborted()
      directory = await mkdtemp(join(tmpdir(), 'dsh-codex-model-'))
      const run = await startCodexRun({ prompt: [{ type: 'text', text }], signal }, {
        cwd: directory, model: options.model, permissionMode: 'never', env: this.env, disposeGraceMs: this.graceMs,
        spawn: spec => this.ctx.subprocess.spawn(spec), reviewerIsolation: {
          maxConfigBytes: this.config.maxConfigBytes, maxMcpServers: this.config.maxMcpServers },
        modelRequest: { instructions, outputSchema: outputSchema(names),
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) },
        journal: { sandbox: 'read-only', ephemeral: true, maxPendingBytes: this.config.maxEventBytes,
          started: threadId => audit({ callId, kind: 'thread', threadId }),
          event: (method, params) => audit({ callId, kind: 'notification', method, params: JSON.stringify(params) }),
        },
      })
      let result: Awaited<typeof run.result>
      try { result = await run.result } finally { await run.dispose() }
      const output = result.output.flatMap((block) => {
        /* v8 ignore else -- the owned Codex wire collector constructs text blocks only from strings. */
        if (block.type === 'text') return [block.text]
        else return []
      }).join('\n')
      await audit({ callId, kind: 'output', text: output, stopReason: result.stopReason })
      signal.throwIfAborted()
      if (result.stopReason !== 'completed') {
        let diagnostic = result.diagnostic
        /* v8 ignore if -- failed/max-token runs retain owned diagnostics; aborted requests throw above. */
        if (diagnostic === undefined) diagnostic = 'Codex CLI did not complete'
        throw new LlmError(diagnostic, 'NATIVE_EXECUTION_FAILED')
      }
      const reply = parseCodexConversationOutput(output, names)
      let index = 0
      if (reply.text !== '') {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: reply.text }
        yield { type: 'block-end', index: index++, block: { type: 'text', text: reply.text } }
      }
      for (const call of reply.toolCalls) {
        const id = brandString<import('@deepseek-ai/dsh-llm').ToolCallId>(randomUUID())
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: index++, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      }
      yield { type: 'finish', reason: { kind: reply.toolCalls.length === 0 ? 'stop' : 'tool-calls' } }
    } finally {
      clearTimeout(timer)
      lifetime.abort()
      try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) }
      finally { done.resolve(); this.pending.delete(done.promise) }
    }
  }
}
