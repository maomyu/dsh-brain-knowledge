/** Independently followed project indexes for the logical workspace knowledge overview. */
import { createSnapshotStore, retainedEntries, retireEntries, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ClientKnowledgeModel, KnowledgeSnapshot } from './model.ts'
import type { KnowledgeHealthSnapshot } from './health.ts'

/** Read-only indexes; document reads remain qualified by their originating project. */
export interface IKnowledgeProjects {
  readonly state: ObservableSnapshot<readonly KnowledgeSnapshot[]>
  /** Retain unchanged projects and cancel removed ones.
   * @param ids - ordered visible project identities; empty releases every subscription.
   */
  watch(ids: readonly WorkspaceId[]): void
  /** Rescan every retained project, including failed indexes. */
  refresh(): void
}

/** Read-only report listings for the visible logical workspace's projects. */
export interface IKnowledgeHealthProjects extends Omit<IKnowledgeProjects, 'state'> {
  readonly state: ObservableSnapshot<readonly KnowledgeHealthSnapshot[]>
}

/** Project observer whose disposal joins every owned read. */
interface ProjectObserver<T> {
  readonly state: ObservableSnapshot<T>
  watch(id: WorkspaceId): void
  refresh(): void
  dispose(): Promise<void>
}

/** Owns project observers and awaits withdrawn requests before disposal completes. */
export class ClientProjectCollection<T> {
  /** Latest snapshots in the deduplicated watch order; departed projects are absent immediately. */
  readonly state = createSnapshotStore<readonly T[]>([])
  private entries = new Map<WorkspaceId, { model: ProjectObserver<T>; unsubscribe: () => void }>()
  private readonly retiring = new Set<Promise<void>>()
  private disposed = false

  /** @param create - allocates an observer for the retained project identity without issuing requests. */
  constructor(private readonly create: (id: WorkspaceId) => ProjectObserver<T>) {}

  /** Retain unchanged observers and withdraw departed projects immediately.
   * @param ids - ordered visible project identities, deduplicated before observation.
   */
  watch(ids: readonly WorkspaceId[]): void {
    if (this.disposed) return
    const previous = this.entries
    const next = retainedEntries(ids, previous, (id) => {
      const model = this.create(id)
      model.watch(id)
      return { model, unsubscribe: model.state.subscribe(() => { this.publish() }) }
    })
    if (next === previous) return
    this.entries = next
    for (const [id, entry] of previous) if (!this.entries.has(id)) this.retire(entry)
    this.publish()
  }

  /** Restart retained observers, including failures. */
  refresh(): void {
    if (!this.disposed) for (const { model } of this.entries.values()) model.refresh()
  }

  /** Withdraw all observations and join outstanding reads, including previously removed projects.
   * @returns after the owned requests and streams settle.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    retireEntries(this.entries, (entry) =>{  this.retire(entry) })
    this.publish()
    await Promise.allSettled(this.retiring)
  }

  private retire(entry: { model: ProjectObserver<T>; unsubscribe: () => void }): void {
    entry.unsubscribe()
    void trackPending(this.retiring, entry.model.dispose())
  }

  private publish(): void {
    this.state.set([...this.entries.values()].map(entry => entry.model.state.getSnapshot()))
  }
}

/** Index-only collection; ordinary document reads stay with the selected project. */
export class ClientKnowledgeCollection extends ClientProjectCollection<KnowledgeSnapshot> implements IKnowledgeProjects {
  /** @param create - allocates an index model without issuing requests. */
  constructor(create: () => ClientKnowledgeModel) {
    super((id) => {
      const model = create()
      return { state: model.state,
        watch: (id) => { model.setWatching(true); void model.load(id) },
        refresh: () => { void model.load(id) },
        dispose: () => model.dispose() }
    })
  }
}
