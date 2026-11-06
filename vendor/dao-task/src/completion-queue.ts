/** Source-owned completion buffers wait outside the Agent inbox until durable admission is possible. */
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectTaskCardId } from './types.ts'
import type { ProjectTaskCardRecord, ProjectTaskCompletionRecord } from './records.ts'

/** Accepted source proposal with a frozen result available for delivery. */
export type CompletedTaskCard = Extract<ProjectTaskCardRecord, { status: 'accepted' }> & { completion: ProjectTaskCompletionRecord }

interface QueuedEntry {
  readonly record: CompletedTaskCard
  readonly ready: ReturnType<typeof Promise.withResolvers<boolean>>
}

interface SourceQueue {
  readonly agent: Agent
  readonly abort: AbortController
  readonly signal: AbortSignal
  readonly entries: Map<ProjectTaskCardId, QueuedEntry>
  done: Promise<void>
}

/** One serial buffer per live source; shutdown and interrupted turns demote undelivered entries. */
export class TaskCompletionQueue {
  private readonly sources = new Map<SessionId, SourceQueue>()

  /** Observe live source-delivery buffers without counting stored queued or pending outcomes.
   * @returns true through queue writes, waits and final cleanup.
   */
  hasActiveOperations(): boolean { return this.sources.size > 0 }

  /** @param ctx - lifecycle events and failure reporting.
   * @param table - controller-owned durable card table.
   * @param lifetime - aborted before queue drain and domain closure.
   * @param deliver - synchronous idle claim; undefined means another activity won the claim.
   */
  constructor(private readonly ctx: Context, private readonly table: KvTable<ProjectTaskCardId, ProjectTaskCardRecord>,
    private readonly lifetime: AbortSignal,
    private readonly deliver: (record: CompletedTaskCard, agent: Agent, signal: AbortSignal) => Promise<unknown> | undefined) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') this.interrupt(session.id)
    })
    ctx.on('agent/error', ({ agent }) => { this.interrupt(agent.id) })
    ctx.on('agent/disposed', ({ agent }) => { this.interrupt(agent.id) })
  }

  /** Demote a previous process's queues without restoring an Agent or waking a model.
   * @returns after every interrupted buffer is a durable pending notification.
   */
  async recover(): Promise<void> {
    for (const [id, record] of this.table.entries()) {
      if (record.status === 'accepted' && record.completion?.delivery === 'queued') await this.demote(id)
    }
  }

  /** Whether an earlier completion still owns this source's delivery order.
   * @param sessionId - original source conversation.
   * @returns true through queue teardown, including interrupted admission writes.
   */
  has(sessionId: SessionId): boolean { return this.sources.has(sessionId) }

  /** Persist one follow-up intent before acknowledging a busy-source buffer.
   * @param record - pending outcome reserved by the card command pool.
   * @param agent - exact live source, never an execution task's Agent.
   * @param signal - caller lifetime until the queue write is admitted.
   * @returns durable queued record; the queue then outlives caller disconnection.
   */
  async enqueue(record: CompletedTaskCard, agent: Agent, signal: AbortSignal): Promise<ProjectTaskCardRecord> {
    signal.throwIfAborted()
    let source = this.sources.get(agent.id)
    if (source === undefined) {
      const abort = new AbortController()
      source = { agent, abort, signal: AbortSignal.any([this.lifetime, abort.signal]), entries: new Map(), done: Promise.resolve() }
      this.sources.set(agent.id, source)
      const owned = source
      source.done = Promise.resolve().then(() => this.consume(owned))
      void source.done.catch((error: unknown) => { ctxQueueError(this.ctx, error) })
    }
    source.signal.throwIfAborted()
    const queueSignal = source.signal
    const entry: QueuedEntry = { record, ready: Promise.withResolvers<boolean>() }
    source.entries.set(record.id, entry)
    let committed = false
    try {
      const updated = await this.table.update(record.id, (current) => {
        signal.throwIfAborted()
        queueSignal.throwIfAborted()
        if (current.status !== 'accepted' || current.completion?.delivery !== 'pending') throw new Error('task completion is not pending')
        return { ...current, completion: { ...current.completion, delivery: 'queued' } }
      })
      committed = true
      return updated
    } finally { entry.ready.resolve(committed) }
  }

  /** Join queue writes and waits after controller cancellation and card command drain.
   * @returns after no source queue can mutate a card or deliver input.
   */
  async drain(): Promise<void> { await Promise.allSettled([...this.sources.values()].map(source => source.done)) }

  private interrupt(id: SessionId): void { this.sources.get(id)?.abort.abort(new Error('source conversation interrupted')) }

  private async consume(source: SourceQueue): Promise<void> {
    try {
      while (true) {
        await waitForIdle(source.agent, source.signal)
        const [entry] = [...source.entries.values()].sort((a, b) =>
          (a.record.completion.completedAt ?? 0) - (b.record.completion.completedAt ?? 0))
        if (entry === undefined) return
        const committed = await entry.ready.promise
        source.signal.throwIfAborted()
        if (!committed) { source.entries.delete(entry.record.id); continue }
        /* v8 ignore if -- removing this announced Agent synchronously aborts its queue through agent/disposed. */
        if (this.ctx.agents.get(source.agent.id) !== source.agent) throw new Error('task completion source Agent was replaced')
        const delivery = this.deliver(entry.record, source.agent, source.signal)
        if (delivery === undefined) continue
        await delivery
        source.entries.delete(entry.record.id)
      }
    } catch (error) {
      if (!source.signal.aborted) ctxQueueError(this.ctx, error)
      source.abort.abort(error)
      for (const entry of source.entries.values()) {
        if (await entry.ready.promise) await this.demote(entry.record.id)
      }
    } finally { this.sources.delete(source.agent.id) }
  }

  private async demote(id: ProjectTaskCardId): Promise<void> {
    await this.table.update(id, current => current.status === 'accepted' && current.completion?.delivery === 'queued'
      ? { ...current, completion: { ...current.completion, delivery: 'pending' } } : current)
  }
}

function ctxQueueError(ctx: Context, error: unknown): void {
  ctx.logger.error('task completion queue could not settle; retained outcomes require review', error)
}

async function waitForIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const listener = addAbortListener(signal, () => { aborted.reject(signal.reason) })
  try { await Promise.race([agent.whenIdle(), aborted.promise]); signal.throwIfAborted() }
  finally { listener[Symbol.dispose]() }
}
