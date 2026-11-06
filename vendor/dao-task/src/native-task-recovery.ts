/** Cold native Task identity recovery from the exact acknowledged audit Session. */
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskCodexThreadId } from './types.ts'

type TaskExecution = NonNullable<ProjectTaskRecord['execution']>

/** Adopt a native identity only from this Task's original, unseeded input and one matching start event.
 * @param execution - committed Task attempt, including its exact native input and selection.
 * @param cwd - current directory derived from the Task's retained project and allocation.
 * @param audit - validated durable Session opened by the committed execution Session id.
 * @returns the original execution when any owner, input or identity observation is absent or ambiguous.
 */
export function recoverNativeTaskIdentity(execution: TaskExecution, cwd: string,
  audit: SessionInspection): TaskExecution {
  if ((execution.runtime !== 'codex' && execution.runtime !== 'claude')
    || audit.meta.id !== execution.sessionId || audit.meta.cwd !== cwd
    || audit.meta.isSeeded || audit.inheritedEventCount !== 0) return execution
  const [input, ...rest] = audit.events
  if (execution.runtime === 'codex') {
    if (execution.threadId !== undefined || input?.type !== 'project-task/codex'
      || input.data.messageId !== execution.messageId || input.data.kind !== 'input'
      || input.data.text !== execution.inputText
      || input.data.selection.sandbox !== execution.selection.sandbox
      || input.data.selection.model !== execution.selection.model
      || input.data.selection.reasoningEffort !== execution.selection.reasoningEffort) return execution
    let threadId: ProjectTaskCodexThreadId | undefined
    for (const event of rest) {
      if (event.type !== 'project-task/codex' || event.data.messageId !== execution.messageId
        || event.data.kind === 'input') return execution
      if (event.data.kind !== 'thread') continue
      if (threadId !== undefined) return execution
      threadId = event.data.threadId
    }
    return threadId === undefined ? execution : { ...execution, threadId }
  }
  if (execution.initialized || input?.type !== 'project-task/claude'
    || input.data.messageId !== execution.messageId || input.data.kind !== 'input'
    || input.data.text !== execution.inputText || input.data.nativeSessionId !== execution.nativeSessionId
    || input.data.selection.permissionMode !== execution.selection.permissionMode
    || input.data.selection.model !== execution.selection.model
    || input.data.selection.effort !== execution.selection.effort) return execution
  let initialized = false
  for (const event of rest) {
    if (event.type !== 'project-task/claude' || event.data.messageId !== execution.messageId
      || event.data.kind === 'input') return execution
    if (event.data.kind !== 'session') continue
    if (initialized || event.data.sessionId !== execution.nativeSessionId) return execution
    initialized = true
  }
  return initialized ? { ...execution, initialized: true } : execution
}
