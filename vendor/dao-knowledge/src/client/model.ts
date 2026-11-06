/** React-free current-project knowledge reads with cancellation and stale-response rejection. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeFileDocument, KnowledgeDocumentId, KnowledgeIndex } from '../types.ts'

/** Independent status of one knowledge index or document request. */
export type KnowledgeReadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Current project data; navigation state belongs to the UI's declared stores. */
export interface KnowledgeSnapshot {
  readonly workspaceId: WorkspaceId | null
  /** Non-null whenever indexStatus is ready; failures may retain a prior index. */
  readonly index: KnowledgeIndex | null
  readonly indexStatus: KnowledgeReadStatus
  readonly indexError: string | null
  readonly document: KnowledgeFileDocument | null
  readonly documentId: KnowledgeDocumentId | null
  readonly documentStatus: KnowledgeReadStatus
  readonly documentError: string | null
}

/** Namespace operations called by the knowledge read model. */
export type KnowledgeRemote = Pick<ClientRemote['knowledge'], 'index' | 'read'>

/** Construct one Gateway-supervised index stream for a registered project. */
export type KnowledgeFollowFactory = (workspaceId: WorkspaceId) => RemoteStream<KnowledgeIndex>

/** Current knowledge data and cancellable project/document requests. */
export interface IKnowledgeDocuments {
  readonly state: ObservableSnapshot<KnowledgeSnapshot>
  /**
   * Scan a project or clear its data; a successor cancels previous reads.
   * @param workspaceId - project to scan, or null to release it.
   * @returns after the scan settles, with failures published in state.
   */
  load(workspaceId: WorkspaceId | null): Promise<void>
  /**
   * Read a document in the loaded project.
   * @param documentId - Brain-relative document identity.
   * @returns after this read settles, with failures published in state.
   */
  read(documentId: KnowledgeDocumentId): Promise<void>
  /**
   * Follow external file changes only while the knowledge surface is active.
   * @param active - false closes the stream while retaining the last data.
   */
  setWatching(active: boolean): void
}

const empty = (): KnowledgeSnapshot => ({
  workspaceId: null, index: null, indexStatus: 'idle', indexError: null,
  document: null, documentId: null, documentStatus: 'idle', documentError: null,
})

/** Owns one project read generation and one document read generation. */
export class ClientKnowledgeModel implements IKnowledgeDocuments {
  readonly state = createSnapshotStore<KnowledgeSnapshot>(empty())
  private indexRequest: AbortController | undefined
  private documentRequest: AbortController | undefined
  private readonly pending = new Set<Promise<void>>()
  private disposed = false
  private watching = false
  private stream: RemoteStream<KnowledgeIndex> | undefined

  /**
   * @param remote - generated unary knowledge namespace.
   * @param follow - Gateway-supervised stream factory.
   */
  constructor(private readonly remote: KnowledgeRemote, private readonly follow: KnowledgeFollowFactory) {}

  load(workspaceId: WorkspaceId | null): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.indexRequest?.abort()
    this.documentRequest?.abort()
    this.documentRequest = undefined
    this.stopFollowing()
    const request = new AbortController()
    this.indexRequest = request
    this.state.set({ ...empty(), workspaceId, indexStatus: workspaceId === null ? 'idle' : 'loading' })
    if (workspaceId === null) return Promise.resolve()
    this.startFollowing(workspaceId)
    return this.track((async () => {
      try {
        const result = await this.remote.index(workspaceId, request.signal)
        if (request.signal.aborted) return
        this.publish(result.ok ? { index: result.value, indexStatus: 'ready' }
          : { indexError: result.error.message, indexStatus: 'error' })
      } catch (error) {
        if (request.signal.aborted) return
        this.publish({ indexError: String(error), indexStatus: 'error' })
      }
    })())
  }

  setWatching(active: boolean): void {
    if (this.disposed || this.watching === active) return
    this.watching = active
    this.stopFollowing()
    const workspaceId = this.state.getSnapshot().workspaceId
    if (workspaceId !== null) this.startFollowing(workspaceId)
  }

  read(documentId: KnowledgeDocumentId): Promise<void> {
    const workspaceId = this.state.getSnapshot().workspaceId
    if (this.disposed || workspaceId === null) return Promise.resolve()
    this.documentRequest?.abort()
    const request = new AbortController()
    this.documentRequest = request
    this.publish({ documentId, document: null, documentStatus: 'loading', documentError: null })
    return this.track((async () => {
      try {
        const result = await this.remote.read(workspaceId, documentId, request.signal)
        if (request.signal.aborted) return
        this.publish(result.ok ? { document: result.value, documentStatus: 'ready' }
          : { documentError: result.error.message, documentStatus: 'error' })
      } catch (error) {
        if (request.signal.aborted) return
        this.publish({ documentError: String(error), documentStatus: 'error' })
      }
    })())
  }

  /**
   * Stop accepting requests and await cancellation of outstanding reads.
   * @returns after every outstanding remote read settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.indexRequest?.abort()
    this.documentRequest?.abort()
    this.stopFollowing()
    await Promise.allSettled(this.pending)
  }

  private startFollowing(workspaceId: WorkspaceId): void {
    if (!this.watching) return
    const stream = this.follow(workspaceId)
    this.stream = stream
    void this.track((async () => {
      try {
        for await (const item of stream) {
          if (this.stream !== stream) return
          item.accept()
          this.acceptIndex(item.value)
        }
      } catch (error) {
        if (this.stream !== stream) return
        this.indexRequest?.abort()
        this.publish({ indexError: String(error), indexStatus: 'error' })
      }
    })())
  }

  private stopFollowing(): void {
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) void this.track(stream.dispose())
  }

  private acceptIndex(index: KnowledgeIndex): void {
    const before = this.state.getSnapshot()
    const documentId = before.documentId
    const changed = documentId !== null && (before.index?.locationRevision !== index.locationRevision
      || before.index.entries.find(entry => entry.id === documentId)?.version
        !== index.entries.find(entry => entry.id === documentId)?.version)
    this.indexRequest?.abort()
    const after: KnowledgeSnapshot = { ...before, index, indexStatus: 'ready', indexError: null }
    this.state.set(after)
    if (changed && this.state.getSnapshot() === after) void this.read(documentId)
  }

  private track(task: Promise<void>): Promise<void> {
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task) })
    return task
  }

  private publish(change: Partial<KnowledgeSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }
}
