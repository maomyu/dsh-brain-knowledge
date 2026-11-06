/** Workspace gallery subscriptions retain each project's independent catalog and file ownership. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArtifactSnapshot, ClientArtifactCatalog } from './model.ts'

/** Project indexes contributing to the selected logical workspace. */
export interface IArtifactProjects {
  readonly state: ObservableSnapshot<readonly ArtifactSnapshot[]>
  /**
   * Follow the supplied projects, retaining unchanged subscriptions and withdrawing removed ones immediately.
   * @param ids - ordered project ids; duplicates contribute only once.
   */
  watch(ids: readonly WorkspaceId[]): void
  /** Reload every contributing catalog, including failed subscriptions. */
  refresh(): void
}

/** Owns active and retired catalog lifetimes until every transport has stopped. */
export class ClientArtifactCollection implements IArtifactProjects {
  readonly state = createSnapshotStore<readonly ArtifactSnapshot[]>([])
  private projects = new Map<WorkspaceId, { model: ClientArtifactCatalog; unsubscribe: () => void }>()
  private readonly retiring = new Set<Promise<void>>()
  private readonly failures: unknown[] = []
  private disposal: Promise<void> | undefined
  private disposed = false
  private reconciling = false

  /** @param create - one independent supervised catalog per project. */
  constructor(private readonly create: () => ClientArtifactCatalog) {}

  watch(ids: readonly WorkspaceId[]): void {
    if (this.disposed) return
    const ordered = [...new Set(ids)]
    const previous = [...this.projects.keys()]
    if (ordered.length === previous.length && ordered.every((id, i) => id === previous[i])) return
    this.reconciling = true
    try {
      for (const [id, entry] of this.projects) if (!ordered.includes(id)) {
        entry.unsubscribe()
        this.retire(entry.model)
      }
      this.projects = new Map(ordered.map((id) => {
        const retained = this.projects.get(id)
        if (retained !== undefined) return [id, retained]
        const model = this.create()
        const unsubscribe = model.state.subscribe(() => { this.publish() })
        model.open(id)
        return [id, { model, unsubscribe }]
      }))
    } finally { this.reconciling = false; this.publish() }
  }

  refresh(): void {
    if (this.disposed) return
    for (const [id, entry] of this.projects) entry.model.open(id)
  }

  /**
   * Withdraw all snapshots and join current and previously removed projects.
   * @returns after every catalog stops; any failed teardown is reported together.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const entry of this.projects.values()) { entry.unsubscribe(); this.retire(entry.model) }
    this.projects.clear()
    this.publish()
    this.disposal = Promise.all(this.retiring).then(() => {
      if (this.failures.length > 0) throw new AggregateError(this.failures, 'Artifact collection disposal failed')
    })
    return this.disposal
  }

  private publish(): void {
    if (!this.reconciling) this.state.set([...this.projects.values()].map(entry => entry.model.state.getSnapshot()))
  }

  private retire(model: ClientArtifactCatalog): void {
    const settled = model.dispose().catch((error: unknown) => { this.failures.push(error) })
    this.retiring.add(settled)
    void settled.then(() => { this.retiring.delete(settled) })
  }
}
