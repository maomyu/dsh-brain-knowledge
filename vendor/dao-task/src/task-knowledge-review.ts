/** Source-Session evidence for a completed ordinary Task's selected Brain pages. */
import { createHash } from 'node:crypto'
import { readEvidenceObject as object, readEvidenceJson as json, readBrainFragment, type BrainReadFragment } from './knowledge-review-evidence.ts'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectTaskId, ProjectTaskCardId, ProjectTaskKnowledgeOperationId, ProjectTaskTimelineAppend } from './types.ts'

/** Context producers may update the same turn without replacing its review input. */
function isReviewContext(source: UserMessage['source']): boolean {
  return source.kind.startsWith('plugin:') || 'form' in source
    || ['project-brain', 'conversation-project-focus', 'brain-health', 'project-goal-mode',
      'project-task-confirmation', 'project-task-review', 'project-goal-knowledge-discovery'].includes(source.kind)
}

interface Page { readonly path: string
  readonly version: string }
interface Operation { readonly page: string
  readonly operationId: ProjectTaskKnowledgeOperationId }
type Chunk = BrainReadFragment
interface Call {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly kind: 'native' | 'ptc'
  readonly writeAttempt?: Operation
  readonly append?: ProjectTaskTimelineAppend
}
const updateIdSchema = z.uuid()
const timelineCallSchema = z.object({
  path: z.string().min(1), target_project_id: z.string().min(1).optional(), operation_id: z.uuid(),
  expected_version: z.string().min(1), kind: z.enum(['decision', 'observation', 'source', 'reversal']),
  summary: z.string().min(1), source: z.string().optional(), affects: z.array(z.string()).optional(),
  evidence: z.string().optional(),
}).strict()

function timelineAppend(args: Record<string, unknown>, projectId: WorkspaceId): ProjectTaskTimelineAppend | undefined {
  const parsed = timelineCallSchema.safeParse(args)
  if (!parsed.success || parsed.data.target_project_id !== undefined && parsed.data.target_project_id !== projectId) return undefined
  const { path, operation_id, expected_version, kind, summary, source, affects, evidence } = parsed.data
  return { path, operationId: brandString<ProjectTaskKnowledgeOperationId>(operation_id), expectedVersion: expected_version,
    kind, summary, ...(source === undefined ? {} : { source }), ...(affects === undefined ? {} : { affects }),
    ...(evidence === undefined ? {} : { evidence }) }
}

function operationId(value: unknown): ProjectTaskKnowledgeOperationId | undefined {
  return typeof value === 'string' && updateIdSchema.safeParse(value).success
    ? brandString<ProjectTaskKnowledgeOperationId>(value) : undefined
}

function parseOperations(value: unknown): Operation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: Operation[] = []
  for (const entry of value) {
    const item = object(entry)
    const id = operationId(item?.operation_id)
    if (typeof item?.page !== 'string' || id === undefined) return undefined
    parsed.push({ page: item.page, operationId: id })
  }
  return parsed
}

function complete(value: Record<string, unknown>, projectId: WorkspaceId, projectPath: string,
  path: string): value is Record<string, unknown> & { version: string } {
  return value.format === undefined && value.partial === undefined && value.project === projectPath
    && (value.project_id === undefined || value.project_id === projectId) && value.path === path
    && value.status === 'active' && typeof value.version === 'string' && typeof value.markdown === 'string'
    && Array.isArray(value.timeline)
}

function completeChunks(chunks: readonly Chunk[], projectId: WorkspaceId, projectPath: string,
  path: string): string | undefined {
  const first = chunks[0]
  /* v8 ignore if -- The only caller pushes a validated fragment into its owned array immediately before this call. */
  if (first === undefined) return undefined
  const parts: Uint8Array[] = []
  let end = 0
  for (const part of chunks.toSorted((a, b) => a.startByte - b.startByte || b.endByte - a.endByte)) {
    if (part.startByte > end) return undefined
    if (part.endByte <= end) continue
    parts.push(Buffer.from(part.fragment, 'utf8').subarray(end - part.startByte))
    end = part.endByte
  }
  if (end !== first.totalBytes) return undefined
  const bytes = Buffer.concat(parts)
  if (createHash('sha256').update(bytes).digest('hex') !== first.sha256) return undefined
  let value: Record<string, unknown> | undefined
  try { value = json(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return undefined }
  return value !== undefined && complete(value, projectId, projectPath, path)
    && value.project_id === projectId && value.version === first.version ? first.version : undefined
}

/** Logged proof available from one exact admitted completion or explicit review input. */
export interface TaskKnowledgeEvidence {
  readonly admitted: boolean
  readonly ended: SessionEvent | undefined
  readonly taskRead: boolean
  readonly reads: ReadonlyMap<string, ReadonlySet<string>>
  readonly writeAttempts: readonly Operation[]
  readonly operations: readonly Operation[]
  readonly unreceiptedWrites: readonly ProjectTaskTimelineAppend[]
  readonly uninspectableWrites: boolean
  readonly verdicts: readonly {
    readonly decision: 'no-change' | 'updated'
    readonly pages: readonly string[]
    readonly operations: readonly Operation[]
    readonly event: SessionEvent
  }[]
}

/** Confirm one complete retained Task read after the exact completion input and before its turn ends.
 * @param events - durable source Session events, or the live snapshot before tool settlement.
 * @param attemptId - exact completion or user-confirmed review input identity.
 * @param taskId - original completed Task identity.
 * @param projectId - original registered project identity.
 * @returns whether a paired successful tool result names that closed Task and project.
 */
export function successfulTaskRead(events: readonly SessionEvent[], attemptId: MessageId, taskId: ProjectTaskId,
  projectId: WorkspaceId): boolean {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === attemptId
    && (event.data.source.kind === 'project-task-completion' || event.data.source.kind === 'project-task-knowledge-review')
    && event.data.source.taskId === taskId)
  if (start < 0) return false
  const calls = new Map<string, { readonly kind: 'native' | 'ptc'
    readonly args: Record<string, unknown> }>()
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const successful = new Set<string>()
  const results = new Set<string>()
  const before = events.slice(0, start)
  let turnStarted = before.findLastIndex(event => event.type === 'turn/start')
    > before.findLastIndex(event => event.type === 'turn/end')
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start') {
      if (turnStarted) break
      turnStarted = true
      continue
    }
    if (event.type === 'turn/end' || event.type === 'user/message' && !isReviewContext(event.data.source)) break
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const callId = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
      if (seen.has(callId)) duplicates.add(callId)
      seen.add(callId)
      if (event.data.name !== 'read_task') continue
      const args = event.type === 'tool/call' ? json(event.data.arguments) : object(event.data.arguments)
      if (args?.task_id === taskId && (args.target_project_id === undefined || args.target_project_id === projectId)) {
        calls.set(callId, { kind: event.type === 'tool/call' ? 'native' : 'ptc', args })
      }
      continue
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') continue
    const callId = event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId
    if (results.has(callId)) duplicates.add(callId)
    results.add(callId)
    const call = calls.get(callId)
    if (call === undefined || call.kind !== (event.type === 'tool/result' ? 'native' : 'ptc')) continue
    if (event.type === 'tool/ptc-dispatch' && (event.data.name !== 'read_task'
      || JSON.stringify(event.data.arguments) !== JSON.stringify(call.args))) continue
    const result = event.type === 'tool/result' ? event.data.message : event.data
    if (result.isError === true || result.content.length !== 1 || result.content[0]?.type !== 'text') continue
    const value = json(result.content[0].text)
    const task = object(value?.task)
    if (value?.project_id === projectId && value.format === undefined && value.partial === undefined
      && task?.id === taskId && (task.status === 'closed-success' || task.status === 'closed-failed'
        || task.status === 'closed-cancelled')) {
      successful.add(callId)
    }
  }
  return [...successful].some(callId => !duplicates.has(callId))
}

/** Keep a Stop action from cancelling a pre-existing ordinary source turn while allowing same-turn plugin notices.
 * @param events - live source Session events.
 * @param attemptId - exact user-confirmed review input.
 * @returns whether the attempt is the first user input of the current unfinished turn.
 */
export function exactOpenTaskKnowledgeTurn(events: readonly SessionEvent[], attemptId: MessageId): boolean {
  const input = events.findIndex(event => event.type === 'user/message' && event.data.id === attemptId)
  if (input < 0) return false
  const start = events.findLastIndex((event, index) => index < input && event.type === 'turn/start')
  if (start < 0 || events.slice(start + 1, input).some(event => event.type === 'user/message' || event.type === 'turn/end')) return false
  return !events.slice(input + 1).some(event => (event.type === 'user/message' && !isReviewContext(event.data.source))
    || event.type === 'turn/end' || event.type === 'turn/start')
}

/** Locate an unclaimed Host-authored review or original completion input in the durable Inbox projection.
 * @param events - complete persisted source log, including every Inbox splice.
 * @param attemptId - exact card-retained review input identity.
 * @param taskId - original Task identity.
 * @param cardId - accepted source card identity for explicit review inputs.
 * @param completionId - immutable original completion input identity for automatic follow-up.
 * @returns one target and index, or undefined when the review was already claimed or canceled.
 */
export function pendingTaskKnowledgeInput(events: readonly SessionEvent[], attemptId: MessageId, taskId: ProjectTaskId,
  cardId: ProjectTaskCardId, completionId: MessageId): { readonly target: 'next-turn' | 'next-step'
    readonly index: number } | undefined {
  const inbox: { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const { target, start, removedCount = 0, inserted } = event.data
    const queue = inbox[target]
    if (!Number.isSafeInteger(start) || start < 0 || start > queue.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > queue.length) {
      throw new Error('Task knowledge recovery found an invalid durable Inbox splice')
    }
    inbox[target] = queue.toSpliced(start, removedCount, ...inserted)
    const ids = [...inbox['next-turn'], ...inbox['next-step']].map(message => message.id)
    if (new Set(ids).size !== ids.length) throw new Error('Task knowledge recovery found duplicate pending input IDs')
  }
  for (const target of ['next-turn', 'next-step'] as const) {
    const index = inbox[target].findIndex(message => message.id === attemptId)
    if (index < 0) continue
    const source = inbox[target][index]?.source
    const ownReview = source?.kind === 'project-task-knowledge-review' && source.taskId === taskId && source.cardId === cardId
    const ownCompletion = source?.kind === 'project-task-completion' && source.taskId === taskId && attemptId === completionId
    if (!ownReview && !ownCompletion) {
      throw new Error('Task knowledge recovery input identity does not match its card')
    }
    return { target, index }
  }
  return undefined
}

/** Inspect paired successful tool calls in the exact source turn; unpaired, old and other-project results are ignored.
 * @param events - durable source Session events, or the live snapshot before tool settlement.
 * @param attemptId - exact completion or user-confirmed review input identity.
 * @param taskId - original completed Task, not a new execution identity.
 * @param projectId - retained target project.
 * @param projectPath - retained project path used in Brain read results.
 * @returns read versions, written receipts and explicit verdict receipts from this interval only.
 */
export function taskKnowledgeEvidence(events: readonly SessionEvent[], attemptId: MessageId, taskId: ProjectTaskId,
  projectId: WorkspaceId, projectPath: string): TaskKnowledgeEvidence {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === attemptId
    && (event.data.source.kind === 'project-task-completion' || event.data.source.kind === 'project-task-knowledge-review')
    && event.data.source.taskId === taskId)
  const reads = new Map<string, Set<string>>()
  const writeAttempts: Operation[] = []
  const operations: Operation[] = []
  const successfulCalls = new Set<string>()
  const verdicts: TaskKnowledgeEvidence['verdicts'][number][] = []
  if (start < 0) return { admitted: false, ended: undefined, taskRead: false, reads, writeAttempts, operations,
    unreceiptedWrites: [], uninspectableWrites: false, verdicts }
  const calls = new Map<string, Call>()
  let duplicateWriteCall = false
  let uninspectableWriteCall = false
  const chunks = new Map<string, Chunk[]>()
  const recordRead = (path: string, version: string): void => {
    const versions = reads.get(path) ?? new Set<string>()
    versions.add(version)
    reads.set(path, versions)
  }
  let ended: SessionEvent | undefined
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/end') { ended = event; break }
    if (event.type === 'user/message' && !isReviewContext(event.data.source)) break
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const args = event.type === 'tool/call' ? json(event.data.arguments) : object(event.data.arguments)
      const isWrite = event.data.name === 'brain_append_timeline' || event.data.name === 'brain_update_truth'
      if (isWrite && args === undefined) uninspectableWriteCall = true
      if (args !== undefined) {
        const callId = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
        const id = operationId(args.operation_id)
        const writeAttempt = isWrite && typeof args.path === 'string'
          && id !== undefined && (args.target_project_id === undefined || args.target_project_id === projectId)
          ? { page: args.path, operationId: id } : undefined
        if (isWrite && writeAttempt === undefined) uninspectableWriteCall = true
        const previous = calls.get(callId)
        if (previous !== undefined && (previous.writeAttempt !== undefined || writeAttempt !== undefined)) {
          duplicateWriteCall = true
        }
        const append = event.data.name !== 'brain_append_timeline' || writeAttempt === undefined ? undefined : timelineAppend(args, projectId)
        calls.set(callId, { name: event.data.name, args, kind: event.type === 'tool/call' ? 'native' : 'ptc',
          ...(writeAttempt === undefined ? {} : { writeAttempt }), ...(append === undefined ? {} : { append }) })
        if (writeAttempt !== undefined) writeAttempts.push(writeAttempt)
      }
      continue
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') continue
    const kind = event.type === 'tool/result' ? 'native' : 'ptc'
    const callId = event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId
    const call = calls.get(callId)
    if (call === undefined || call.kind !== kind) continue
    if (event.type === 'tool/ptc-dispatch' && (event.data.name !== call.name
      || JSON.stringify(event.data.arguments) !== JSON.stringify(call.args))) continue
    const result = event.type === 'tool/result' ? event.data.message : event.data
    if (result.isError === true) continue
    for (const block of result.content) {
      if (block.type !== 'text') continue
      const value = json(block.text)
      if (value === undefined) continue
      const writeId = operationId(call.args.operation_id)
      if (call.name === 'brain_read' && typeof call.args.path === 'string'
        && (call.args.target_project_id === undefined || call.args.target_project_id === projectId)) {
        const path = call.args.path
        const version = complete(value, projectId, projectPath, path) ? value.version : undefined
        const part = readBrainFragment(value, projectId, projectPath, path)
        if (part !== undefined) {
          const key = JSON.stringify([part.path, part.version, part.sha256, part.totalBytes])
          const collected = chunks.get(key) ?? []
          collected.push(part)
          chunks.set(key, collected)
          const whole = completeChunks(collected, projectId, projectPath, path)
          if (whole !== undefined) recordRead(path, whole)
        }
        if (version !== undefined) recordRead(path, version)
      } else if ((call.name === 'brain_append_timeline' || call.name === 'brain_update_truth') && typeof call.args.path === 'string'
        && (call.args.target_project_id === undefined || call.args.target_project_id === projectId)
        && value.path === call.args.path && value.operation_id === call.args.operation_id
        && value.disposition === 'written' && (value.project_id === undefined || value.project_id === projectId)
        && writeId !== undefined && typeof call.args.expected_version === 'string'
        && reads.get(call.args.path)?.has(call.args.expected_version)) {
        operations.push({ page: call.args.path, operationId: writeId })
        successfulCalls.add(callId)
      } else if (call.name === 'complete_task_knowledge_review' && call.args.task_id === taskId
        && call.args.target_project_id === projectId && value.task_id === taskId
        && value.target_project_id === projectId && value.decision === call.args.decision
        && (value.decision === 'no-change' || value.decision === 'updated')
        && Array.isArray(value.pages) && value.pages.length > 0 && value.pages.every(page => typeof page === 'string')) {
        const operations = parseOperations(value.operations)
        if (operations !== undefined) verdicts.push({ decision: value.decision, pages: value.pages, operations, event })
      }
    }
  }
  const unreceipted = [...calls.entries()].filter(([id, call]) => call.writeAttempt !== undefined && !successfulCalls.has(id))
  return { admitted: true, ended, taskRead: successfulTaskRead(events, attemptId, taskId, projectId), reads, writeAttempts, operations,
    unreceiptedWrites: unreceipted.flatMap(([, call]) => call.append === undefined ? [] : [call.append]),
    uninspectableWrites: uninspectableWriteCall || duplicateWriteCall
      || unreceipted.some(([, call]) => call.append === undefined), verdicts }
}

/** Earlier Task review writes cannot be relabeled as a later no-change outcome.
 * @param events - complete source Session events.
 * @param attemptId - current review input, excluded from prior evidence.
 * @param taskId - retained completed Task identity.
 * @param projectId - original project identity.
 * @param projectPath - original project path.
 * @returns confirmed earlier writes and exact ended prior calls requiring file-receipt inspection.
 */
function historyBefore(events: readonly SessionEvent[], current: number, taskId: ProjectTaskId,
  projectId: WorkspaceId, projectPath: string): {
  readonly operations: readonly Operation[]
  readonly unresolved: boolean
  readonly uninspectable: boolean
  readonly pendingReceipts: readonly ProjectTaskTimelineAppend[]
} {
  const known = new Map<string, Operation>()
  let unresolved = false
  const pendingReceipts: ProjectTaskTimelineAppend[] = []
  for (const event of events.slice(0, current)) {
    if (event.type !== 'user/message'
      || (event.data.source.kind !== 'project-task-completion' && event.data.source.kind !== 'project-task-knowledge-review')
      || event.data.source.taskId !== taskId) continue
    const evidence = taskKnowledgeEvidence(events, event.data.id, taskId, projectId, projectPath)
    for (const operation of evidence.operations) known.set(JSON.stringify(operation), operation)
    if (evidence.writeAttempts.length > 0 && (evidence.ended === undefined || events.indexOf(evidence.ended) >= current)) {
      unresolved = true
      continue
    }
    if (evidence.uninspectableWrites) unresolved = true
    pendingReceipts.push(...evidence.unreceiptedWrites)
  }
  return { operations: [...known.values()], unresolved: unresolved || pendingReceipts.length > 0,
    uninspectable: unresolved, pendingReceipts }
}

/** Inspect completed knowledge-review writes before the specified attempt input.
 * @param events - complete retained source Session events.
 * @param attemptId - exact user-message identity starting the current review attempt.
 * @param taskId - retained completed Task identity.
 * @param projectId - original Task project.
 * @param projectPath - original Task project path.
 * @returns confirmed operations and unreceipted calls; a missing attempt returns unresolved, uninspectable history.
 */
export function taskKnowledgeHistory(events: readonly SessionEvent[], attemptId: MessageId, taskId: ProjectTaskId,
  projectId: WorkspaceId, projectPath: string): {
  readonly operations: readonly Operation[]
  readonly unresolved: boolean
  readonly uninspectable: boolean
  readonly pendingReceipts: readonly ProjectTaskTimelineAppend[]
} {
  const current = events.findIndex(event => event.type === 'user/message' && event.data.id === attemptId)
  return current < 0 ? { operations: [], unresolved: true, uninspectable: true, pendingReceipts: [] }
    : historyBefore(events, current, taskId, projectId, projectPath)
}

/** Inspect ended earlier Task-review turns before admitting a new explicit model input.
 * @param events - complete current source Session log, with no fabricated retry input.
 * @param taskId - retained completed Task identity.
 * @param projectId - original Task project.
 * @param projectPath - original Task project path.
 * @returns confirmed writes and exact unreceipted calls before the end of the current log.
 */
export function taskKnowledgeHistoryBeforeRetry(events: readonly SessionEvent[], taskId: ProjectTaskId,
  projectId: WorkspaceId, projectPath: string): ReturnType<typeof taskKnowledgeHistory> {
  return historyBefore(events, events.length, taskId, projectId, projectPath)
}

/** Require every current selected active decision page to have a complete read before explicit closure.
 * @param evidence - current-turn tool evidence.
 * @param pages - canonical current selected active decision pages.
 * @param decision - requested overall no-change or updated verdict.
 * @param requireTaskRead - coding completion requires a successful exact retained Task read in this turn.
 * @returns exact pages and new write receipts, or undefined when evidence is incomplete.
 */
export function taskKnowledgeVerdict(evidence: TaskKnowledgeEvidence, pages: readonly Page[], decision: 'no-change' | 'updated',
  requireTaskRead: boolean):
  { readonly pages: readonly string[]
    readonly operations: readonly Operation[] } | undefined {
  if (!evidence.admitted || requireTaskRead && !evidence.taskRead
    || evidence.uninspectableWrites || pages.length === 0 || pages.some((page) => {
    const reads = evidence.reads.get(page.path)
    return reads === undefined || reads.size === 0 || (decision === 'no-change' && !reads.has(page.version))
      || (decision === 'updated' && !reads.has(page.version)
        && !evidence.operations.some(operation => operation.page === page.path))
  })) return undefined
  const selected = new Set(pages.map(page => page.path))
  if (evidence.operations.some(operation => !selected.has(operation.page))) return undefined
  if (decision === 'no-change' && evidence.writeAttempts.length > 0) return undefined
  if (evidence.writeAttempts.some(operation => !evidence.operations.some(written =>
    written.page === operation.page && written.operationId === operation.operationId))) return undefined
  if (decision === 'updated' && evidence.operations.length === 0) return undefined
  return { pages: pages.map(page => page.path), operations: evidence.operations }
}
