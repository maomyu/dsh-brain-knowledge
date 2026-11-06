import { detachedAuditSession } from '../../dao-runtime/audit-session.ts'
/** Fresh, independently owned review Sessions; no execution permissions or Task-state mutations. */
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { freezeMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import { startCodexRun } from '@deepseek-ai/dsh-subagent-codex'
import { startClaudeCodeRun } from '@deepseek-ai/dsh-subagent-claude-code'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TaskCodexConfig } from './codex-task.ts'
import type { TaskClaudeConfig } from './claude-task.ts'
import type { ProjectTaskClaudeSessionId, ProjectTaskKnowledgeReviewFailure, ProjectTaskReviewSelection, ProjectTaskKnowledgeBatchReceipt } from './types.ts'
import { taskResultEvidence, taskSettlement } from './settlement.ts'

/** An immutable review attempt; the caller supplies a new audit identity for every execution. */
export interface TaskReviewRequest {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly cwd: string
  readonly inputText: string
  /** Exact original-document images retained in the reviewer Session, never inferred OCR text. */
  readonly images?: readonly TaskReviewImage[] | undefined
  /** Complete text, image references and base64-equivalent encoded image allowance. */
  readonly maxInputBytes?: number | undefined
  /** Harness output cap for bounded internal comparisons. */
  readonly maxTokens?: number | undefined
  /** Logged source of a tool-free Harness reviewer input; ordinary Task review is the default. */
  readonly sourcePlugin?: 'project-goal-knowledge-discovery' | undefined
  /** Harness routes must already contain a resolved concrete model. */
  readonly selection: ProjectTaskReviewSelection
}

/** One durable source image with its original document identity. */
interface TaskReviewSourceImage {
  readonly sourceId: string
  readonly name: string
  readonly attachment: ImageAttachmentRef
}

/** One original PDF page image. */
export interface TaskReviewPdfImage extends TaskReviewSourceImage {
  readonly kind: 'pdf'
  readonly page: number
}

/** One original DOCX embedded image; its ordinal is not a page number. */
export interface TaskReviewDocxImage extends TaskReviewSourceImage {
  readonly kind: 'docx'
  readonly image: number
}

/** Format-specific original-image identity shared by dispatch and complete-input budgeting. */
export type TaskReviewImage = TaskReviewPdfImage | TaskReviewDocxImage

function imageLabel(image: TaskReviewImage): string {
  switch (image.kind) {
    case 'pdf': return `Source ${image.sourceId} — PDF ${JSON.stringify(image.name)} — Original Page ${image.page}`
    case 'docx': return `Source ${image.sourceId} — DOCX ${JSON.stringify(image.name)} — Original Embedded Image ${image.image} (not a page)`
    /* v8 ignore next -- closed-union exhaustiveness guard. */
    default: return assertNever(image)
  }
}

/** Construct the exact logged review input, including format-specific original-image labels.
 * @param request - fresh identity and immutable source evidence.
 * @returns frozen user input; image-bearing requests require image-capable dispatch.
 */
export function taskReviewMessage(request: TaskReviewRequest): Readonly<UserMessage> {
  return freezeMessage({ role: 'user', id: request.messageId,
    source: request.sourcePlugin === 'project-goal-knowledge-discovery'
      ? { kind: 'project-goal-knowledge-discovery' } : { kind: 'project-task-review' },
    ...(request.images?.length ? { requiredInputModalities: ['image'] as const } : {}),
    content: [{ type: 'text', text: request.inputText }, ...(request.images ?? []).flatMap(image => [
      { type: 'text' as const, text: imageLabel(image) },
      { type: 'image' as const, attachment: image.attachment },
    ])] })
}

/** Measure the complete reviewer content, including encoded image bytes not embedded in the log.
 * @param inputText - exact first text block.
 * @param images - durable original document images with PDF page or DOCX image identities.
 * @returns UTF-8 serialized content bytes plus the base64 size of every referenced image.
 */
export function taskReviewInputBytes(inputText: string, images: readonly TaskReviewImage[] = []): number {
  const content = [{ type: 'text', text: inputText }, ...images.flatMap(image => [
    { type: 'text', text: imageLabel(image) },
    { type: 'image', attachment: image.attachment },
  ])]
  return Buffer.byteLength(JSON.stringify(content), 'utf8')
    + images.reduce((bytes, image) => bytes + 4 * Math.ceil(image.attachment.bytes / 3), 0)
}

/** Explicit process, model-step and native configuration limits for one review attempt. */
export interface TaskReviewWorkerConfig {
  readonly codex: TaskCodexConfig
  readonly claude: TaskClaudeConfig
  readonly maxSteps: number
  readonly reviewerIsolation: { readonly maxConfigBytes: number
    readonly maxMcpServers: number }
}

/** A sealed classification; only `kind` may be copied to a blocked Task or Goal discovery. */
export class TaskReviewFailureError extends Error {
  constructor(readonly kind: ProjectTaskKnowledgeReviewFailure, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** A durably audited model failure; callers may choose another reviewer, unlike persistence or setup failures. */
export class TaskReviewRuntimeError extends TaskReviewFailureError {
  constructor(message: string, kind: ProjectTaskKnowledgeReviewFailure = 'unknown-execution-error') {
    super(kind, message)
  }
}

/** Run one tool-restricted review and return only its complete, durably retained successful output.
 * @param ctx - review owner's real Agent, Session persistence and subprocess services.
 * @param request - fresh audit identity, exact captured input and resolved reviewer route.
 * @param config - deployment-owned execution and native isolation limits.
 * @param signal - review lifetime; cancellation joins all owned model and process work.
 * @returns complete reviewer text after audit durability; incomplete, empty or cancelled attempts reject.
 */
export async function executeTaskReview(ctx: Context, request: TaskReviewRequest,
  config: TaskReviewWorkerConfig, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (request.maxInputBytes !== undefined && taskReviewInputBytes(request.inputText, request.images) > request.maxInputBytes) {
    throw new Error('Complete Task review input exceeds its byte allowance')
  }
  if (request.selection.runtime !== 'harness' && request.images?.length) {
    throw new Error('Original-document image review requires a Harness image-capable route')
  }
  switch (request.selection.runtime) {
    case 'harness': return harnessReview(ctx, request, config, signal)
    case 'codex':
    case 'claude': return nativeReview(ctx, request, config, signal)
    /* v8 ignore next -- closed-union exhaustiveness guard. */
    default: return assertNever(request.selection)
  }
}

async function harnessReview(ctx: Context, request: TaskReviewRequest,
  config: TaskReviewWorkerConfig, signal: AbortSignal): Promise<string> {
  const selection = request.selection
  if (selection.runtime !== 'harness' || selection.model === undefined) throw new Error('Review requires a resolved Harness model')
  const model = selection.model
  const handle = await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: request.cwd, origin: 'subagent' },
    signal, agentOptions: { provider: model.provider, model: model.model,
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) },
    setup(owner) {
      owner.tools.restrictAccess(() => false)
      owner.on('agent/pre-step', (step, next) => {
        if (step.step > config.maxSteps) throw new Error('Review model-step limit reached')
        return next()
      })
    } })
  const agent = handle.agent
  const cancellation = addAbortListener(signal, () => { agent.cancel({ kind: 'hook', reason: 'Task review cancelled' }) })
  try {
    await agent.runMaintenance(async (activity) => {
      const live = AbortSignal.any([activity, signal])
      live.throwIfAborted()
      agent.followup(taskReviewMessage(request))
      try {
        if (!await ctx.sessions.flush(agent.session)) throw new Error('Review input has no Session durability listener')
        live.throwIfAborted()
      } catch (error) {
        // Maintenance must discard its pending wake before it releases the model driver.
        agent.cancel({ kind: 'disposed' })
        throw error
      }
    })
    await agent.whenIdle()
    try {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('Review result has no Session durability listener')
    } catch (error) {
      throw new TaskReviewFailureError('result-persistence-failed', 'Review result could not be retained', { cause: error })
    }
    signal.throwIfAborted()
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = agent.session.snapshotEvents()
    const settled = taskSettlement(events, request.messageId)
    if (settled.status !== 'closed-success') {
      const message = `Task review did not complete: ${settled.closedReason}`
      const kind = settled.closedReason === 'max-tokens' ? 'max-tokens' : 'turn-incomplete'
      if (events.some(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')) {
        throw new TaskReviewRuntimeError(message, kind)
      }
      throw new TaskReviewFailureError(kind, message)
    }
    const output = taskResultEvidence(events, request.messageId).summary
    if (output.trim() === '') throw new TaskReviewRuntimeError('Task review returned no assessment', 'empty-final-text')
    return output
  } finally {
    cancellation[Symbol.dispose]()
    await handle.dispose()
  }
}

async function nativeReview(ctx: Context, request: TaskReviewRequest,
  config: TaskReviewWorkerConfig, signal: AbortSignal): Promise<string> {
  const selection = request.selection
  /* v8 ignore if -- executeTaskReview synchronously dispatches only Codex and Claude routes here. */
  if (selection.runtime === 'harness') throw new Error('Native review requires a native route')
  const session = detachedAuditSession(ctx.sessions, request.sessionId, { meta: { cwd: request.cwd, origin: 'subagent' } })
  await using handle = await ctx.sessionPersistence.create(session.header)
  type NativeEvent = { readonly type: 'project-task/codex'
    readonly data: SessionEventMap['project-task/codex'] }
    | { readonly type: 'project-task/claude'
      readonly data: SessionEventMap['project-task/claude'] }
  const maxBytes = selection.runtime === 'codex' ? config.codex.maxPendingBytes : config.claude.maxEventBytes
  let auditFailure: { readonly cause: unknown } | undefined
  const append = async (event: NativeEvent): Promise<void> => {
    try {
      if (Buffer.byteLength(JSON.stringify(event.data), 'utf8') > maxBytes) throw new Error('Complete review event exceeds its byte allowance')
      const receipt = event.type === 'project-task/codex'
        ? session.append('project-task/codex', event.data) : session.append('project-task/claude', event.data)
      await handle.append([{ ...receipt, ignorable: true }])
      await handle.flush()
    } catch (error) { auditFailure ??= { cause: error }; throw error }
  }
  const messageId = request.messageId
  const eventType = selection.runtime === 'codex' ? 'project-task/codex' : 'project-task/claude'
  const nativeSessionId = brandString<ProjectTaskClaudeSessionId>(randomUUID())
  if (selection.runtime === 'codex') {
    await append({ type: 'project-task/codex', data: { messageId, kind: 'input', text: request.inputText,
      selection: { sandbox: 'read-only', ...(selection.model === undefined ? {} : { model: selection.model }),
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) } } })
  } else {
    await append({ type: 'project-task/claude', data: { messageId, kind: 'input', text: request.inputText, nativeSessionId,
      selection: { runtime: 'claude', permissionMode: 'dontAsk', ...(selection.model === undefined ? {} : { model: selection.model }),
        ...(selection.effort === undefined ? {} : { effort: selection.effort }) } } })
  }
  let output = ''
  let failure: { readonly cause: unknown } | undefined
  try {
    signal.throwIfAborted()
    const run = selection.runtime === 'codex'
      ? await startCodexRun({ prompt: [{ type: 'text', text: request.inputText }], signal }, {
        cwd: request.cwd, env: {}, permissionMode: 'never', disposeGraceMs: config.codex.graceMs,
        reviewerIsolation: config.reviewerIsolation,
        ...(selection.model === undefined ? {} : { model: selection.model }),
        spawn: spec => ctx.subprocess.spawn(spec),
        journal: { sandbox: 'read-only', maxPendingBytes: config.codex.maxPendingBytes,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          started: threadId => append({ type: 'project-task/codex', data: { messageId, kind: 'thread', threadId } }),
          event: (method, params) => append({ type: 'project-task/codex', data: { messageId, kind: 'notification', method, params: JSON.stringify(params) } }),
        },
      })
      : await startClaudeCodeRun({ prompt: [{ type: 'text', text: request.inputText }], signal }, {
        cwd: request.cwd, env: {}, permissionMode: 'dontAsk', disposeGraceMs: config.claude.graceMs,
        readOnly: { projectDirectory: request.cwd, maxTurns: config.maxSteps, scope: 'files' },
        ...(selection.model === undefined ? {} : { model: selection.model }),
        spawn: spec => ctx.subprocess.spawn(spec),
        journal: { sessionId: nativeSessionId, maxEventBytes: config.claude.maxEventBytes,
          ...(selection.effort === undefined ? {} : { effort: selection.effort }),
          started: sessionId => append({ type: 'project-task/claude', data: { messageId, kind: 'session', sessionId } }),
          event: json => append({ type: 'project-task/claude', data: { messageId, kind: 'notification', json } }),
        },
      })
    try {
      const outcome = await run.result
      output = outcome.output.flatMap(block => block.type === 'text' ? [block.text]
        : /* v8 ignore next -- both owned native collectors construct text blocks only from strings. */ []).join('\n')
      signal.throwIfAborted()
      if (auditFailure !== undefined) throw auditFailure.cause
      if (outcome.stopReason !== 'completed') throw new TaskReviewRuntimeError('Native task review did not complete', 'turn-incomplete')
      /* v8 ignore if -- both owned native collectors reject an empty completed answer before publishing their result. */
      if (output.trim() === '') throw new TaskReviewRuntimeError('Task review returned no assessment', 'empty-final-text')
    } finally { await run.dispose() }
  } catch (error) { failure = { cause: error } }
  if (auditFailure !== undefined) throw auditFailure.cause
  const status = signal.aborted ? 'closed-cancelled' : failure === undefined ? 'closed-success' : 'closed-failed'
  await append({ type: eventType, data: { messageId, kind: 'result', status,
    reason: signal.aborted ? 'cancelled' : failure === undefined ? 'completed' : 'execution-error', output } })
  signal.throwIfAborted()
  if (failure !== undefined) throw failure.cause
  return output
}

/** Resolve the existing reviewer process and isolation limits for Task/Goal discovery.
 * @param config - deployment-owned native, discovery and reviewer settings.
 * @returns the complete limits consumed by the shared tool-free review executor.
 */
export function knowledgeReviewWorkerConfig(config: { readonly codex: TaskCodexConfig
  readonly claude: TaskClaudeConfig
  readonly knowledgeDiscovery: { readonly maxSteps: number }
  readonly review: { readonly maxConfigBytes: number
    readonly maxMcpServers: number } }): TaskReviewWorkerConfig {
  return { codex: config.codex, claude: config.claude, maxSteps: config.knowledgeDiscovery.maxSteps,
    reviewerIsolation: { maxConfigBytes: config.review.maxConfigBytes, maxMcpServers: config.review.maxMcpServers } }
}

/** Audit one completed reviewer Session without activating its Agent.
 * @param ctx - Session persistence owner.
 * @param receipt - exact retained reviewer Session and input identity.
 * @param source - original reviewer input source.
 * @param textOnly - Goal inputs require exactly one text part; Task inputs may retain original images.
 * @param invalid - original owner-specific incomplete-review error.
 * @param validate - optional exact original-document input comparison, under the read lease.
 * @returns complete input and settled reviewer output from that Session.
 */
export async function auditDiscoveryReview(ctx: Context, receipt: ProjectTaskKnowledgeBatchReceipt,
  source: 'project-task-review' | 'project-goal-knowledge-discovery', textOnly: boolean, invalid: () => Error,
  validate?: (message: UserMessage, inputText: string) => void): Promise<{ readonly inputText: string
  readonly outputText: string }> {
  await using handle = await ctx.sessionPersistence.open(receipt.sessionId, 'read')
  const events = (await handle.read()).events
  const messages = events.filter(event => event.type === 'user/message' && event.data.id === receipt.messageId
    && (event.data.source.kind === source || event.data.source.kind === `plugin:${source}`))
  if (messages.length !== 1 || messages[0]?.type !== 'user/message'
    || textOnly && messages[0].data.content.length !== 1 || messages[0].data.content[0]?.type !== 'text'
    || taskSettlement(events, receipt.messageId).status !== 'closed-success') throw invalid()
  validate?.(messages[0].data, messages[0].data.content[0].text)
  return { inputText: messages[0].data.content[0].text, outputText: taskResultEvidence(events, receipt.messageId).summary }
}
