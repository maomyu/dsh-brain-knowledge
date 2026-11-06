/** Project reference folders; Client metadata never grants filesystem write access. */
import { createSnapshotStore, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeSourceDirectories } from '../types.ts'

/** Last observed project registrations and their metadata-read status. */
export interface KnowledgeSourceSnapshot {
  workspaceId: WorkspaceId | null
  directories: KnowledgeSourceDirectories | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Generated Host operations used by the project source-folder controls. */
export type KnowledgeSourceRemote = Pick<ClientRemote['knowledge'], 'sourceDirectories' | 'setSourceDirectory'>

/** Project-specific source references, independent of Brain location and writable roots. */
export interface IKnowledgeSources {
  readonly state: ObservableSnapshot<KnowledgeSourceSnapshot>
  /** Load source metadata or withdraw the current project.
   * @param workspaceId - selected project, or null to clear.
   * @returns after the read settles; failures appear in state.
   */
  load(workspaceId: WorkspaceId | null): Promise<void>
  /** Register or remove a path without modifying its contents.
   * @param workspaceId - initiating project; navigation never retargets the operation.
   * @param path - absolute Host folder selected by the user.
   * @param present - true to add, false to remove; both operations are idempotent.
   * @param signal - originating interaction lifetime; cancellation prevents queued submission.
   * @returns after Host persistence and current-project metadata refresh settle.
   * @throws when cancelled or the Host rejects the update.
   */
  setDirectory(workspaceId: WorkspaceId, path: string, present: boolean, signal: AbortSignal): Promise<void>
}

/** Serializes registration commands and ignores metadata from obsolete views. */
export class ClientKnowledgeSources implements IKnowledgeSources {
  readonly state = createSnapshotStore<KnowledgeSourceSnapshot>({ workspaceId: null, directories: null, status: 'idle', error: null })
  private read: AbortController | undefined
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private write: Promise<void> | undefined

  /** @param remote - generated Host reference-list and mutation methods. */
  constructor(private readonly remote: KnowledgeSourceRemote) {}

  load(workspaceId: WorkspaceId | null): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.read?.abort()
    const read = new AbortController()
    this.read = read
    const current = this.state.getSnapshot()
    this.state.set({ workspaceId, directories: current.workspaceId === workspaceId ? current.directories : null,
      status: workspaceId === null ? 'idle' : 'loading', error: null })
    if (workspaceId === null) return Promise.resolve()
    return trackPending(this.pending, (async () => {
      try {
        const result = await this.remote.sourceDirectories(workspaceId)
        if (read.signal.aborted) return
        this.state.set(result.ok ? { workspaceId, directories: result.value, status: 'ready', error: null }
          : { workspaceId, directories: null, status: 'error', error: result.error.message })
      } catch (error) {
        if (!read.signal.aborted) this.state.set({ workspaceId, directories: null, status: 'error', error: String(error) })
      }
    })())
  }

  setDirectory(workspaceId: WorkspaceId, path: string, present: boolean, signal: AbortSignal): Promise<void> {
    const live = AbortSignal.any([signal, this.lifetime.signal])
    const previous = this.write
    const write = trackPending(this.pending, (async () => {
      if (previous !== undefined) { try { await previous } catch { /* Failed registration releases the next queued command. */ } }
      live.throwIfAborted()
      const result = await this.remote.setSourceDirectory(workspaceId, path, present, live)
      live.throwIfAborted()
      if (!result.ok) throw new Error(result.error.message)
      if (this.state.getSnapshot().workspaceId === workspaceId) await this.load(workspaceId)
    })())
    this.write = write
    void write.finally(() => { if (this.write === write) this.write = undefined })
      .catch(() => { /* The caller owns the rejected command. */ })
    return write
  }

  /** Cancel queued work and join every admitted Host call.
   * @returns after all pending operations settle, without publishing late results.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.read?.abort()
    await Promise.allSettled(this.pending)
  }

}
