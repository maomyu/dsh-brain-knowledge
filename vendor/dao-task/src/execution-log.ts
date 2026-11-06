/** Bounded task-turn journals projected from validated Session events without activating Agents. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskExecutionLog, ProjectTaskLogEntry } from './types.ts'

function terminalExecution(terminal: NonNullable<ProjectTaskRecord['terminal']>): NonNullable<ProjectTaskRecord['execution']> {
  const shared = { sessionId: terminal.sessionId, messageId: terminal.messageId, inputText: terminal.inputText }
  if (terminal.selection.runtime === 'codex') return { ...shared, runtime: 'codex', selection: terminal.selection.selection }
  assert(terminal.nativeSessionId !== undefined, 'Claude terminal input requires a retained native identity')
  return { ...shared, runtime: 'claude', selection: terminal.selection.selection, nativeSessionId: terminal.nativeSessionId, initialized: false }
}

/** Project the confirmed input's own turn, excluding later conversation turns and internal prompt material.
 * @param record - retained task execution identity and model route.
 * @param events - validated live or persisted events, or null when the Session is missing.
 * @param maxBytes - inclusive UTF-8 limit for the complete serialized response.
 * @returns chronological event suffix with an explicit omission count; storage is never modified.
 * @throws when execution metadata alone exceeds the configured response limit.
 */
export function taskExecutionLog(
  record: ProjectTaskRecord, events: readonly SessionEvent[] | null, maxBytes: number,
): ProjectTaskExecutionLog {
  const terminal = record.terminal
  const execution = record.execution ?? (terminal === undefined ? undefined : terminalExecution(terminal))
  const entries: ProjectTaskLogEntry[] = []
  let entered = false
  if (execution !== undefined && events !== null) for (const event of events) {
    if (execution.runtime === 'codex' || execution.runtime === 'claude') {
      if (((event.type === 'project-task/codex' && execution.runtime === 'codex')
        || (event.type === 'project-task/claude' && execution.runtime === 'claude')) && event.data.messageId === execution.messageId) {
        if (event.data.kind === 'artifact-checkpoint-v2' || event.data.kind === 'research-output-checkpoint-v1') continue
        if (event.data.kind === 'notification' && (event.type === 'project-task/codex'
          ? event.data.method === 'task-artifact/checkpoint-v1'
          : event.data.json.includes('"type":"task-artifact/checkpoint-v1"'))) continue
        entries.push({ seq: event.seq, time: event.time, type: event.type, data: JSON.stringify(event.data) })
      }
      continue
    }
    if (event.type === 'user/message' && event.data.id === execution.messageId) entered = true
    if (!entered || event.type === 'turn/start') {
      if (entered) break
      continue
    }
    if (['user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) {
      entries.push({ seq: event.seq, time: event.time, type: event.type, data: JSON.stringify(event.data) })
    }
    if (event.type === 'turn/end') break
  }
  const result: ProjectTaskExecutionLog = {
    state: execution === undefined ? 'not-started' : events === null ? 'unavailable' : 'ready',
    sessionId: execution?.sessionId ?? null,
    model: execution === undefined || execution.runtime === 'codex' || execution.runtime === 'claude' ? null : { provider: execution.provider, model: execution.model,
      ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }) },
    entries: [], omittedEntries: entries.length,
    ...(execution?.runtime === 'codex' ? { codex: { ...execution.selection,
      ...(execution.threadId === undefined ? {} : { threadId: execution.threadId }) } } : {}),
    ...(execution?.runtime === 'claude' ? { claude: { ...execution.selection,
      ...(execution.initialized ? { sessionId: execution.nativeSessionId } : {}) } } : {}),
  }
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (size(result) > maxBytes) throw new Error('Task execution metadata exceeds maxExecutionLogBytes')
  // Reserve omission-count digits before selecting a suffix; removing entries never grows this envelope.
  let bytes = size(result)
  let start = entries.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const next = size(entries[index]) + (start < entries.length ? 1 : 0)
    if (bytes + next > maxBytes) break
    bytes += next
    start = index
  }
  return { ...result, entries: entries.slice(start), omittedEntries: start }
}
