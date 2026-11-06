/** Current-project Brain location commands; authoritative values come from the Host. */
import { createSnapshotStore, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeLocation, KnowledgeLocationRevision, KnowledgeLocationSelection } from '../types.ts'

/** Last observed location and the status of its metadata read. */
export interface KnowledgeLocationSnapshot {
  workspaceId: WorkspaceId | null
  location: KnowledgeLocation | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Generated location methods, with no filesystem access in the Client. */
export type KnowledgeLocationRemote = Pick<ClientRemote['knowledge'], 'location' | 'setLocation'>

/** Project-scoped location metadata and revision-checked selection. */
export interface IKnowledgeLocations {
  readonly state: ObservableSnapshot<KnowledgeLocationSnapshot>
  /** Read the committed location or release the current project.
   * @param workspaceId - selected project, or null to clear metadata.
   * @returns after the read settles; errors are published in state.
   */
  load(workspaceId: WorkspaceId | null): Promise<void>
  /** Select a directory using the revision displayed when the interaction began.
   * @param workspaceId - initiating project; navigation never retargets the write.
   * @param path - chosen absolute directory, or null for the default.
   * @param revision - revision captured before picking or confirming.
   * @param initialize - explicit consent to initialize an unrecognized directory.
   * @param signal - originating view lifetime; disposal also cancels the request.
   * @returns Host result; only a committed selection updates displayed metadata.
   */
  select(workspaceId: WorkspaceId, path: string | null, revision: KnowledgeLocationRevision | null,
    initialize: boolean, signal: AbortSignal): Promise<KnowledgeLocationSelection>
  /** Cancel this view's requests and drain admitted calls.
   * @returns after pending Host calls settle without late publication.
   */
  dispose(): Promise<void>
}

/** Rejects obsolete reads and drains in-flight selections during plugin teardown. */
export class ClientKnowledgeLocations implements IKnowledgeLocations {
  readonly state = createSnapshotStore<KnowledgeLocationSnapshot>({ workspaceId: null, location: null, status: 'idle', error: null })
  private read: AbortController | undefined
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param remote - generated Host metadata and selection methods. */
  constructor(private readonly remote: KnowledgeLocationRemote) {}

  load(workspaceId: WorkspaceId | null): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.read?.abort()
    const read = new AbortController()
    this.read = read
    this.state.set({ workspaceId, location: null, status: workspaceId === null ? 'idle' : 'loading', error: null })
    if (workspaceId === null) return Promise.resolve()
    return trackPending(this.pending, (async () => {
      try {
        const result = await this.remote.location(workspaceId)
        if (read.signal.aborted) return
        this.state.set(result.ok ? { workspaceId, location: result.value, status: 'ready', error: null }
          : { workspaceId, location: null, status: 'error', error: result.error.message })
      } catch (error) {
        if (!read.signal.aborted) this.state.set({ workspaceId, location: null, status: 'error', error: String(error) })
      }
    })())
  }

  select(workspaceId: WorkspaceId, path: string | null, revision: KnowledgeLocationRevision | null,
    initialize: boolean, signal: AbortSignal): Promise<KnowledgeLocationSelection> {
    const live = AbortSignal.any([signal, this.lifetime.signal])
    const observedRead = this.read
    return trackPending(this.pending, (async () => {
      live.throwIfAborted()
      const result = await this.remote.setLocation(workspaceId, path, revision, initialize, live)
      live.throwIfAborted()
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.ok && this.read === observedRead && this.state.getSnapshot().workspaceId === workspaceId) {
        this.read?.abort()
        this.state.set({ workspaceId, location: result.value.location, status: 'ready', error: null })
      }
      return result.value
    })())
  }

  /** Cancel requests and wait for every admitted operation to settle.
   * @returns after pending Host calls settle, without publishing late results.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.read?.abort()
    await Promise.allSettled(this.pending)
  }

}
