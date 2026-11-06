/** React-free catalog following; one stream owns each selected project's current state. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArtifactIndex } from '../types.ts'

/** Current catalog and independent loading/failure state. */
export interface ArtifactSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly index: ArtifactIndex | null
  readonly error: string | null
}
/** Project selection and observable Host catalog; UI selection stays outside this model. */
export interface IArtifactCatalog {
  readonly state: ObservableSnapshot<ArtifactSnapshot>
  /**
   * Replace the selected project, or clear it; late frames from previous streams cannot publish.
   * @param workspaceId - registered project, or null to stop following.
   */
  open(workspaceId: WorkspaceId | null): void
}

/** Owns and joins every stream through project changes and disposal. */
export class ClientArtifactCatalog implements IArtifactCatalog {
  readonly state = createSnapshotStore<ArtifactSnapshot>({ workspaceId: null, phase: 'idle', index: null, error: null })
  private current: RemoteStream<ArtifactIndex> | undefined
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  /**
   * @param follow - factory for Gateway-supervised, reconnecting catalog streams.
   */
  constructor(private readonly follow: (workspaceId: WorkspaceId) => RemoteStream<ArtifactIndex>) {}

  open(workspaceId: WorkspaceId | null): void {
    if (this.disposed) return
    this.close()
    this.state.set({ workspaceId, phase: workspaceId === null ? 'idle' : 'loading', index: null, error: null })
    if (workspaceId === null) return
    const stream = this.follow(workspaceId)
    this.current = stream
    this.track((async () => {
      try {
        for await (const frame of stream) {
          if (this.current !== stream) return
          frame.accept()
          this.state.set({ workspaceId, phase: 'ready', index: frame.value, error: null })
        }
      } catch (error) {
        if (this.current === stream) this.state.set({ ...this.state.getSnapshot(), phase: 'error', error: String(error) })
      }
    })())
  }

  /**
   * Stop publication and join all current or superseded stream operations.
   * @returns after the owned streams have settled; disposal failures reject.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.close()
    const results = await Promise.allSettled(this.pending)
    const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Artifact catalog disposal failed')
  }

  private close(): void {
    const current = this.current
    this.current = undefined
    if (current !== undefined) this.track(current.dispose())
  }

  private track(task: Promise<void>): void {
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => {
      // Retain a failed teardown until dispose() reports it, without an unhandled rejection.
    })
  }
}
