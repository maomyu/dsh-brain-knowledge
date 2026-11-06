/** Independent artifact reads and native requests owned by the Client plugin lifetime. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactFile, ArtifactFileActions, ArtifactNativeAction, ArtifactRenditionId, ArtifactSiteId, ArtifactSiteAction } from '../types.ts'

/** Host reason for a failed rendition byte read. */
export type ArtifactReadFailureReason = RemoteErrorDetailsMap['artifact/file']['reason']

/** Preserve the Host's artifact failure reason for an independent file reader. */
export class ArtifactReadFailure extends Error {
  /** @param reason - Host-classified failure for the exact rendition.
   * @param message - Host diagnostic retained for callers outside the gallery.
   */
  constructor(readonly reason: ArtifactReadFailureReason, message: string) { super(message) }
}

/** File requests use project/rendition identities, never renderer-supplied system paths. */
export interface IArtifactActions {
  /** Identify a read failure created by this provider's package instance.
   * @param error - rejected read value.
   * @returns Host reason for an artifact read failure, otherwise undefined.
   */
  readFailureReason(error: unknown): ArtifactReadFailureReason | undefined
  /** Read a rendition without replacing the selected-file model.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity.
   * @param signal - cancels this independent read.
   * @returns Host-validated bounded bytes; rejects after caller cancellation or plugin unload.
   */
  read(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFile>
  /** Inspect the selected file without launching an application.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity.
   * @param signal - cancels the requesting view's operation.
   * @returns available native actions after Host validation.
   */
  inspect(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFileActions>
  /** Execute a native handoff or confirmed site startup; the Host revalidates the target.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity.
   * @param action - chosen application handoff or site startup.
   * @param signal - cancels validation and startup; already-open applications and ready sites remain independent.
   * @returns after the native command or site startup settles.
   */
  run(workspaceId: WorkspaceId, id: ArtifactRenditionId, action: ArtifactNativeAction, signal: AbortSignal): Promise<void>
  /** Operate an already-owned site by its exact run identity.
   * @param workspaceId - originating project.
   * @param id - current site identity from its catalog.
   * @param action - browser handoff or awaited cleanup.
   * @param signal - requesting view lifetime.
   * @returns after the Host operation settles.
   */
  site(workspaceId: WorkspaceId, id: ArtifactSiteId, action: ArtifactSiteAction, signal: AbortSignal): Promise<void>
}

/** Joins pending Remote calls on unload and rejects late completions after cancellation. */
export class ClientArtifactActions implements IArtifactActions {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param remote - generated namespace callbacks, including Remote error projection. */
  constructor(private readonly remote: Omit<IArtifactActions, 'readFailureReason'>) {}

  readFailureReason(error: unknown): ArtifactReadFailureReason | undefined {
    return error instanceof ArtifactReadFailure ? error.reason : undefined
  }

  read(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFile> {
    return this.track(signal, combined => this.remote.read(workspaceId, id, combined))
  }

  inspect(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFileActions> {
    return this.track(signal, combined => this.remote.inspect(workspaceId, id, combined))
  }

  run(workspaceId: WorkspaceId, id: ArtifactRenditionId, action: ArtifactNativeAction, signal: AbortSignal): Promise<void> {
    return this.track(signal, combined => this.remote.run(workspaceId, id, action, combined))
  }

  site(workspaceId: WorkspaceId, id: ArtifactSiteId, action: ArtifactSiteAction, signal: AbortSignal): Promise<void> {
    return this.track(signal, combined => this.remote.site(workspaceId, id, action, combined))
  }

  /** Cancel requests and retain ownership until every call settles.
   * @returns after all pending reads, inspections and handoffs settle.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }

  private track<T>(signal: AbortSignal, perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const task = (async () => {
      combined.throwIfAborted()
      const value = await perform(combined)
      combined.throwIfAborted()
      return value
    })()
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }
}
