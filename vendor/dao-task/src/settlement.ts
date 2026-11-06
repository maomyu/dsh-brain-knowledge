/** Task execution results derived from the admitted input's own durable turn, never Agent idle alone. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectTaskNativeFailure, ProjectTaskStatus, ProjectTaskUsage } from './types.ts'

/** Account settled model requests only in the confirmed input's admitted turn.
 * @param events - ordered task Session events, already validated by the Session reader.
 * @param messageId - frozen task input identity.
 * @returns reported full-call tokens and explicit missing reports; retries count as separate requests.
 */
export function taskUsage(events: readonly SessionEvent[], messageId: MessageId): ProjectTaskUsage {
  let entered = false
  let turns = 0
  let totalTokens = 0
  let unreportedSteps = 0
  for (const event of events) {
    if (entered && (event.type === 'turn/start' || event.type === 'turn/end')) break
    if (event.type === 'user/message' && event.data.id === messageId) entered = true
    if (!entered || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')) continue
    turns++
    const usage = event.type === 'assistant/message' ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
    if (usage === undefined) unreportedSteps++
    else totalTokens += usage.totalTokens
      ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  return { turns, totalTokens, unreportedSteps }
}

/** Fold the confirmed input's settlement; missing or incomplete evidence is failure, not success.
 * @param events - one task Session's ordered durable events.
 * @param messageId - frozen confirmation input identity.
 * @returns terminal execution status, reason and optional safe native failure detail; verification remains independently unchecked.
 */
export function taskSettlement(events: readonly SessionEvent[], messageId: MessageId): {
  status: Extract<ProjectTaskStatus, `closed-${string}`>
  closedReason: string
  nativeFailure?: ProjectTaskNativeFailure | undefined
} {
  let currentTurn: number | undefined
  let taskTurn: number | undefined
  let entered = false
  const inbox: Record<'next-turn' | 'next-step', MessageId[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if ((event.type === 'project-task/codex' || event.type === 'project-task/claude') && event.data.messageId === messageId && event.data.kind === 'result') {
      return { status: event.data.status, closedReason: event.data.reason,
        ...(event.data.nativeFailure === undefined ? {} : { nativeFailure: event.data.nativeFailure }) }
    }
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = inbox[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted.map(message => message.id))
      if (removed.includes(messageId)) {
        if (splice.outcome === 'canceled') return { status: 'closed-cancelled', closedReason: 'cancelled' }
        taskTurn = currentTurn
      }
    }
    if (event.type === 'user/message' && event.data.id === messageId && currentTurn === taskTurn) entered = true
    if (event.type !== 'turn/end' || event.data.turn !== taskTurn) continue
    const reason = event.data.reason
    if (reason.kind === 'aborted') {
      return reason.reason.kind === 'disposed'
        ? { status: 'closed-failed', closedReason: 'interrupted' }
        : { status: 'closed-cancelled', closedReason: 'cancelled' }
    }
    switch (reason.kind) {
      case 'completed': return entered
        ? { status: 'closed-success', closedReason: 'completed' }
        : { status: 'closed-failed', closedReason: 'input-not-entered' }
      case 'error': return { status: 'closed-failed', closedReason: 'execution-error' }
      // TurnEndReason is merge-extensible; unknown terminal reasons cannot prove success.
      default: return { status: 'closed-failed', closedReason: reason.kind }
    }
  }
  return { status: 'closed-failed', closedReason: 'interrupted' }
}

/** Read only the final assistant text in the confirmed input's admitted turn.
 * @param events - ordered events from the task's durable Session.
 * @param messageId - immutable task input identity.
 * @returns reported result and terminal timestamp; no tool output, reasoning or unrelated turn is included.
 */
export function taskResultEvidence(events: readonly SessionEvent[], messageId: MessageId): { summary: string; completedAt: number | null } {
  let entered = false
  let result = ''
  for (const event of events) {
    if ((event.type === 'project-task/codex' || event.type === 'project-task/claude') && event.data.messageId === messageId && event.data.kind === 'result') {
      return { summary: event.data.output, completedAt: event.time }
    }
    if (event.type === 'turn/start') {
      if (entered) return { summary: result, completedAt: null }
      result = ''
    }
    if (event.type === 'user/message' && event.data.id === messageId) entered = true
    if (!entered) continue
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.trim().length > 0) result = text
    }
    if (event.type === 'turn/end') return { summary: result, completedAt: event.time }
  }
  return { summary: result, completedAt: null }
}
