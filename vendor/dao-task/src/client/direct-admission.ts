/** One command's transient dirty-workspace choice; no permission survives its settlement. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Shares the same command signal for inspection, user choice and eventual dispatch. */
export class DirectTaskAdmission<Id extends string> {
  private readonly active = new Map<Id, { resolve: (allow: boolean) => void; waiting: boolean; cancelled: boolean }>()

  /** @param inspect - authoritative Git inspection; errors reject admission.
   * @param publish - publishes only commands currently waiting for an explicit choice.
   */
  constructor(private readonly inspect: ClientRemote['projectTasks']['inspectDirectWorkspace'],
    private readonly publish: (ids: readonly Id[]) => void) {}

  /** Inspect once for this gesture, without accepting or executing the task.
   * @param workspaceId - command's original project.
   * @param id - command's task or card identity.
   * @param signal - command lifetime, withdrawn with its owning model.
   * @returns single-attempt permission, or undefined when the user cancels.
   */
  async check(workspaceId: WorkspaceId, id: Id, signal: AbortSignal): Promise<{ allowDirty: boolean } | undefined> {
    signal.throwIfAborted()
    const choice = Promise.withResolvers<boolean>()
    const entry = { resolve: choice.resolve, waiting: false, cancelled: false }
    this.active.set(id, entry)
    const abort = (): void => { choice.reject(signal.reason) }
    try {
      const result = await this.inspect(workspaceId, signal)
      signal.throwIfAborted()
      if (entry.cancelled) return undefined
      if (!result.ok) throw new Error(result.error.message)
      if (result.value !== 'dirty') return { allowDirty: false }
      signal.addEventListener('abort', abort, { once: true })
      entry.waiting = true
      this.changed()
      return await choice.promise ? { allowDirty: true } : undefined
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.active.get(id) === entry) {
        this.active.delete(id)
        this.changed()
      }
    }
  }

  /** Withdraw inspection or resolve a visible dirty confirmation, never a running execution.
   * @param id - command identity shown in the confirmation.
   * @param allow - true only for a visible question; false also withdraws an unfinished inspection.
   */
  decide(id: Id, allow: boolean): void {
    const entry = this.active.get(id)
    if (entry === undefined || (allow && !entry.waiting)) return
    if (!allow) entry.cancelled = true
    entry.resolve(allow)
  }

  private changed(): void { this.publish([...this.active].filter(([, value]) => value.waiting).map(([id]) => id)) }
}
