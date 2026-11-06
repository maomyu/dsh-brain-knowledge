/** One selected artifact read, with cancellation and version-aware request replacement. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArtifactFile, ArtifactRenditionId } from '../types.ts'

/** File read state independent of catalog following and UI selection. */
export interface ArtifactFileSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly id: ArtifactRenditionId | null
  readonly requestedVersion: string | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly file: ArtifactFile | null
  readonly error: string | null
}

/** Cancellable regular-file reads for artifact presentation. */
export interface IArtifactFiles {
  readonly state: ObservableSnapshot<ArtifactFileSnapshot>
  /** Read a selected catalog rendition, replacing any previous request.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity.
   * @param version - index version that prompted this read.
   * @returns after success, failure publication or supersession.
   */
  load(workspaceId: WorkspaceId, id: ArtifactRenditionId, version: string): Promise<void>
  /** Clear data and cancel the outstanding read.
   * @returns after all owned reads settle.
   */
  clear(): Promise<void>
}

/** Joins reads on unload and prevents superseded results from publishing. */
export class ClientArtifactFiles implements IArtifactFiles {
  readonly state = createSnapshotStore<ArtifactFileSnapshot>({ workspaceId: null, id: null, requestedVersion: null,
    phase: 'idle', file: null, error: null })
  private current: AbortController | undefined
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  /** @param read - composed Remote regular-file operation. */
  constructor(private readonly read: (workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal) => Promise<ArtifactFile>) {}

  load(workspaceId: WorkspaceId, id: ArtifactRenditionId, version: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.current?.abort()
    const request = new AbortController()
    this.current = request
    this.state.set({ workspaceId, id, requestedVersion: version, phase: 'loading', file: null, error: null })
    const task = (async () => {
      try {
        const file = await this.read(workspaceId, id, request.signal)
        if (this.current === request) this.state.set({ workspaceId, id, requestedVersion: version, phase: 'ready', file, error: null })
      } catch (error) {
        if (this.current === request) this.state.set({ workspaceId, id, requestedVersion: version, phase: 'error', file: null, error: String(error) })
      }
    })()
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task) })
    return task
  }

  async clear(): Promise<void> {
    const request = this.current
    this.current = undefined
    request?.abort()
    this.state.set({ workspaceId: null, id: null, requestedVersion: null, phase: 'idle', file: null, error: null })
    await Promise.all(this.pending)
  }

  /** End publication and join outstanding reads.
   * @returns after every owned read settles.
   */
  async dispose(): Promise<void> { this.disposed = true; await this.clear() }
}
