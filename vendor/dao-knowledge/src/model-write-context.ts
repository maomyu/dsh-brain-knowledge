/** Keep a model Brain tool's parsed arguments attached to its asynchronous writer calls. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One model tool execution, distinct from a direct Controller or Remote call. */
export interface BrainModelWriteExecution {
  readonly owner: Context
  readonly sessionId: SessionId
  /** Registry-assigned model call that the import owner may bind to a persisted in-flight write. */
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: unknown
}

const activeWrite = new AsyncLocalStorage<BrainModelWriteExecution>()

/** Carry the exact accepted model arguments through asynchronous Brain publication.
 * @param execution - registry execution whose agent owns the writer.
 * @param next - remaining tool dispatch, including the writer and its rechecks.
 * @returns the delegated tool result.
 */
export function withBrainModelWrite<T>(execution: BrainModelWriteExecution, next: () => Promise<T>): Promise<T> {
  return activeWrite.run(execution, next)
}

/** Read the matching model call without granting direct Controller callers ambient authority.
 * @param owner - Host plugin root that owns the tool and writer.
 * @param sessionId - authoring Session expected by the writer.
 * @returns matching execution, or undefined outside that tool's asynchronous call.
 */
export function currentBrainModelWrite(owner: Context, sessionId: SessionId): BrainModelWriteExecution | undefined {
  const execution = activeWrite.getStore()
  return execution?.owner === owner && execution.sessionId === sessionId ? execution : undefined
}
