/** Independent, project-qualified document readers for visible chat previews. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeDocumentId } from '../types.ts'
import type { ClientKnowledgeModel, KnowledgeSnapshot } from './model.ts'

/** A document identity is local to its registered project. */
export interface KnowledgePreviewTarget {
  readonly workspaceId: WorkspaceId
  readonly documentId: KnowledgeDocumentId
}

/** Concurrent readers; the consumer owns the set of visible targets. */
export interface IKnowledgePreviews {
  readonly state: ObservableSnapshot<readonly KnowledgeSnapshot[]>
  /** Follow the exact visible targets, releasing requests for removed targets.
   * @param targets - project-qualified documents; duplicates share one reader.
   */
  watch(targets: readonly KnowledgePreviewTarget[]): void
}

interface Reader {
  readonly model: ClientKnowledgeModel
  readonly off: () => void
}

/** Reuses the API read model without changing the main Brain reader's selection. */
export class ClientKnowledgePreviews implements IKnowledgePreviews {
  readonly state = createSnapshotStore<readonly KnowledgeSnapshot[]>([])
  private readonly readers = new Map<string, Reader>()
  private readonly retiring = new Set<Promise<void>>()
  private disposed = false

  /** @param create - factory allocating an independent cancellable reader. */
  constructor(private readonly create: () => ClientKnowledgeModel) {}

  watch(targets: readonly KnowledgePreviewTarget[]): void {
    if (this.disposed) return
    const wanted = new Map(targets.map(target => [JSON.stringify([target.workspaceId, target.documentId]), target]))
    for (const [key, reader] of this.readers) if (!wanted.has(key)) {
      this.readers.delete(key)
      reader.off()
      const task = reader.model.dispose()
      this.retiring.add(task)
      void task.finally(() => { this.retiring.delete(task) })
    }
    for (const [key, target] of wanted) if (!this.readers.has(key)) {
      const model = this.create()
      const reader = { model, off: model.state.subscribe(() => { this.publish() }) }
      this.readers.set(key, reader)
      model.setWatching(true)
      // load establishes the project synchronously; read must not wait for an index stream.
      void model.load(target.workspaceId)
      void model.read(target.documentId)
    }
    this.publish()
  }

  /** Release all readers, including those removed during earlier visibility changes.
   * @returns after every owned remote operation has settled.
   */
  async dispose(): Promise<void> {
    this.watch([])
    this.disposed = true
    await Promise.all(this.retiring)
  }

  private publish(): void {
    const next = [...this.readers.values()].map(reader => reader.model.state.getSnapshot())
    const before = this.state.getSnapshot()
    if (next.length !== before.length || next.some((item, index) => item !== before[index])) this.state.set(next)
  }
}
