/** Bounded command lifetimes and project admission shared by tasks and conversation cards. */
import { addAbortListener } from 'node:events'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Each instance owns an independent command pool; shutdown aborts the supplied lifetime before drain. */
export class TaskCommandPool<Id extends string, Result> {
  private readonly operations = new Map<Id, Promise<Result>>()
  private readonly admissions = new Set<WorkspaceId>()

  /** @param lifetime - owner cancellation, shared with its commands.
   * @param maxConcurrent - deployment-owned request count, excluding model execution.
   */
  constructor(private readonly lifetime: AbortSignal, private readonly maxConcurrent: number) {}

  /** Observe only currently reserved commands and project admissions.
   * @returns true until their owned work releases each reservation.
   */
  hasActiveOperations(): boolean { return this.operations.size > 0 || this.admissions.size > 0 }

  /** Reserve one identity until its operation settles; overlapping requests reject rather than queue.
   * @param id - task or card identity owned by this pool.
   * @param signal - caller cancellation, combined with owner cancellation.
   * @param operation - work admitted only while both lifetimes remain active.
   * @returns operation result after releasing its reservation.
   */
  run<T extends Result>(id: Id, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lifetime = AbortSignal.any([signal, this.lifetime])
    lifetime.throwIfAborted()
    if (this.operations.has(id) || this.operations.size >= this.maxConcurrent) this.refuse('busy')
    const work = Promise.resolve().then(() => { lifetime.throwIfAborted(); return operation(lifetime) })
      .finally(() => { this.operations.delete(id) })
    this.operations.set(id, work)
    return work
  }

  /** Wait for background admission, rechecking identity and capacity before reserving either.
   * @param id - retained task or card identity whose background work must not overlap.
   * @param signal - caller cancellation, combined with owner cancellation while waiting and running.
   * @param operation - work admitted after earlier reservations settle, without retrying their results.
   * @returns operation result, or cancellation before admission.
   */
  async runAfterSettled<T extends Result>(id: Id, signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lifetime = AbortSignal.any([signal, this.lifetime])
    while (true) {
      lifetime.throwIfAborted()
      const previous = this.operations.get(id)
      const pending = previous === undefined
        ? this.operations.size >= this.maxConcurrent ? [...this.operations.values()] : []
        : [previous]
      if (pending.length === 0) return this.run(id, lifetime, operation)
      const aborted = Promise.withResolvers<never>()
      const listener = addAbortListener(lifetime, () => { aborted.reject(lifetime.reason) })
      try {
        await Promise.race([Promise.race(pending).then(() => {}, () => {}), aborted.promise])
      } finally { listener[Symbol.dispose]() }
    }
  }

  /** Serialize retained-count admission before any asynchronous write.
   * @param workspaceId - project whose count was read synchronously by the caller.
   * @param retained - current retained count; calculate immediately before reserving.
   * @param limit - configured retained count for this record kind.
   * @param reason - public error when the configured count is exhausted.
   * @returns disposer that must run after the admission write settles, including failure.
   */
  reserveProject(workspaceId: WorkspaceId, retained: number, limit: number, reason: 'card-limit' | 'task-limit' | 'goal-limit'): () => void {
    if (this.admissions.has(workspaceId)) this.refuse('busy')
    if (retained >= limit) this.refuse(reason)
    this.admissions.add(workspaceId)
    return () => { this.admissions.delete(workspaceId) }
  }

  /** Join all admitted commands; the owner must stop new work by aborting first.
   * @returns settlement of the commands active at shutdown.
   */
  async drain(): Promise<void> { await Promise.allSettled(this.operations.values()) }

  /** Wait for the current reservation without adopting its result or retrying its command.
   * @param id - identity whose earlier admission must settle before background delivery.
   * @returns after that reservation, successful or failed, has been released.
   */
  async whenSettled(id: Id): Promise<void> { await Promise.allSettled([this.operations.get(id)]) }

  private refuse(reason: 'busy' | 'card-limit' | 'task-limit' | 'goal-limit'): never {
    throw new RemoteError('project-task/rejected', 'project task request was not accepted', { reason })
  }
}
