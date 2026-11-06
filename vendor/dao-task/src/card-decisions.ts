/** Durable dispatch acknowledgements resume their original live conversation, independently of Task completion. */
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectTaskCardRecord } from './records.ts'
import type { ProjectTaskCardId } from './types.ts'

type Decision = NonNullable<ProjectTaskCardRecord['decisions']>[number]

/** Freeze one decision input; uncertainty never asserts dispatch or authorizes another task.
 * @param record - card's retained source and execution identity.
 * @param outcome - observed confirmation result, or unconfirmed dispatch after interrupted admission.
 * @param maxBytes - configured limit for the complete retained notification.
 * @returns private durable receipt, separate from task completion and manual verification.
 */
export function taskCardDecision(record: ProjectTaskCardRecord, outcome: Decision['outcome'], maxBytes: number): Decision {
  const guidance = outcome === 'opened-terminal'
    ? 'The user accepted this task into an interactive native Terminal. The operating system acknowledged the handoff; this does not establish CLI startup, task completion, verification, or a knowledge update. The terminal session is user-owned and can continue after the application exits. Briefly acknowledge the task identity; do not dispatch another application-owned execution.'
    : outcome === 'terminal-unconfirmed'
      ? 'The user accepted this task for an interactive native Terminal, but the handoff is unconfirmed. Ask the user to inspect their Terminal before explicitly retrying this same task. Do not claim it is running or complete, and do not start an application-owned execution.'
      : outcome === 'dispatched'
        ? 'The user confirmed this task and its dispatch was admitted. Briefly acknowledge the task identity. This acknowledgement does not establish task completion or verification; check its current status before describing its progress.'
        : outcome === 'dismissed'
          ? 'The user dismissed this task proposal. No task was created by this decision. Briefly acknowledge the dismissal. Do not propose or start a replacement unless the user asks.'
          : 'This task confirmation did not retain a dispatch acknowledgement. Dispatch may have failed or been interrupted after admission. Explain that its outcome is unconfirmed, inspect the existing task identity, and do not create a replacement or claim it is running.'
  const decision: Decision = { outcome, delivery: 'pending', messageId: brandString<MessageId>(randomUUID()),
    inputText: guidance + '\n\n' + JSON.stringify({ cardId: record.id, taskId: record.taskId,
      targetProjectId: record.workspaceId, title: record.draft.title, isolation: record.draft.isolation }) }
  if (Buffer.byteLength(JSON.stringify(decision), 'utf8') > maxBytes) {
    throw new RemoteError('project-task/rejected', 'task confirmation feedback exceeds the configured notification limit', { reason: 'completion-too-large' })
  }
  return decision
}

interface SourceDelivery {
  readonly agent: Agent
  readonly abort: AbortController
  readonly signal: AbortSignal
  done: Promise<void>
}

/** Per-source input admission; cold sources stay parked until their own Agent is restored. */
export class TaskCardDecisions {
  /** Observe live decision-notification delivery without counting retained acknowledgements.
   * @returns true through each delivery promise's final cleanup.
   */
  hasActiveOperations(): boolean { return this.sources.size > 0 }

  private readonly sources = new Map<SessionId, SourceDelivery>()

  /** @param ctx - live Agent registry, Session persistence and owned lifecycle events.
   * @param table - controller-owned card receipts.
   * @param lifetime - aborted before draining and closing the card domain.
   * @param settled - waits for a card's confirm or dismiss command to release its final outcome.
   * @param owner - verifies retained source identity and current workspace membership.
   */
  constructor(private readonly ctx: Context, private readonly table: KvTable<ProjectTaskCardId, ProjectTaskCardRecord>,
    private readonly lifetime: AbortSignal, private readonly settled: (id: ProjectTaskCardId) => Promise<void>,
    private readonly owner: (record: ProjectTaskCardRecord) => void) {
    ctx.on('agent/created', ({ agent }) => { this.schedule(agent.id) })
    ctx.on('agent/disposed', ({ agent }) => { this.sources.get(agent.id)?.abort.abort() })
    ctx.on('agent/error', ({ agent }) => { this.sources.get(agent.id)?.abort.abort() })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') this.sources.get(session.id)?.abort.abort()
    })
  }

  /** Wake only the exact live source; repeated calls share its current admission worker.
   * @param id - original conversation, never the currently focused or execution-task Session.
   */
  schedule(id: SessionId): void {
    if (this.lifetime.aborted || this.sources.has(id) || this.pending(id) === undefined) return
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) return
    const abort = new AbortController()
    const source: SourceDelivery = { agent, abort, signal: AbortSignal.any([this.lifetime, abort.signal]), done: Promise.resolve() }
    this.sources.set(id, source)
    source.done = Promise.resolve().then(() => this.consume(source)).catch((error: unknown) => {
      if (!source.signal.aborted) this.ctx.logger.error('Task confirmation feedback remains pending for its original conversation', error)
    }).finally(() => { this.sources.delete(id) })
  }

  /** Preserve decision-before-completion ordering without waiting for a model reply.
   * @param id - original source conversation.
   * @returns false while decision admission owns this source; throws if admission failed and remains pending.
   */
  readyForCompletion(id: SessionId): boolean {
    if (this.pending(id) === undefined) return true
    if (this.sources.has(id)) return false
    throw new Error('Task confirmation feedback is pending before completion delivery')
  }

  /** Join all admitted work after controller cancellation.
   * @returns when no worker can append input or change a receipt.
   */
  async drain(): Promise<void> { await Promise.allSettled([...this.sources.values()].map(source => source.done)) }

  private pending(id: SessionId): ProjectTaskCardRecord | undefined {
    return [...this.table.entries()].map(([, record]) => record)
      .filter(record => record.sourceSessionId === id && record.decisions?.some(item => item.delivery === 'pending'))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
  }

  private async consume(source: SourceDelivery): Promise<void> {
    while (true) {
      source.signal.throwIfAborted()
      const pending = this.pending(source.agent.id)
      if (pending === undefined) return
      await this.settled(pending.id)
      const aborted = Promise.withResolvers<never>()
      const listener = addAbortListener(source.signal, () => { aborted.reject(source.signal.reason) })
      try { await Promise.race([source.agent.whenIdle(), aborted.promise]) }
      finally { listener[Symbol.dispose]() }
      source.signal.throwIfAborted()
      if (this.ctx.agents.get(source.agent.id) !== source.agent) throw new Error('Task confirmation source Agent was replaced')
      let admitted: Promise<void>
      try {
        admitted = source.agent.runMaintenance(activity =>
          this.deliver(pending.id, source.agent, AbortSignal.any([source.signal, activity])))
      }
      catch (_busy: unknown) {
        // runMaintenance throws synchronously only when another activity owns the Agent.
        continue
      }
      await admitted
    }
  }

  private async deliver(id: ProjectTaskCardId, agent: Agent, signal: AbortSignal): Promise<void> {
    const record = this.table.get(id)
    const decision = record?.decisions?.find(item => item.delivery === 'pending')
    if (record === undefined || decision === undefined) return
    signal.throwIfAborted()
    this.owner(record)
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const retained = agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === decision.messageId)
      || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === decision.messageId)
    if (!retained) agent.followup(freezeMessage({ role: 'user', id: decision.messageId,
      source: { kind: 'project-task-confirmation' }, content: [{ type: 'text', text: decision.inputText }] }))
    try {
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Task confirmation source has no Session durability listener')
      signal.throwIfAborted()
      this.owner(record)
    } catch (error) {
      if (!retained) {
        agent.inbox.remove(decision.messageId)
        try {
          if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Task confirmation rollback has no Session durability listener')
        } catch (rollback) { throw new AggregateError([error, rollback], 'Task confirmation input rollback did not persist') }
      }
      throw error
    }
    await this.table.update(id, current => ({ ...current, decisions: current.decisions?.map(item =>
      item.messageId === decision.messageId ? { ...item, delivery: 'sent' } : item) }))
  }
}
