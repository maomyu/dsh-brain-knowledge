/** Shared read-only task attention feed; history never materializes conversation models. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { TaskConversationAttention } from '../types.ts'

/** Complete source counts and feed readiness; an unavailable feed is not an empty result. */
export interface TaskAttentionSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly items: readonly TaskConversationAttention[]
  readonly error: string | null
}

/** Shares one passive subscription and drains it after the final subscriber leaves. */
export class ClientTaskAttention {
  private readonly store = createSnapshotStore<TaskAttentionSnapshot>({ phase: 'idle', items: [], error: null })
  /** Identity-stable source; its first subscriber starts the passive feed. */
  readonly state: ObservableSnapshot<TaskAttentionSnapshot>
  private stream: RemoteStream<readonly TaskConversationAttention[]> | undefined
  private subscribers = 0
  private disposed = false
  private readonly work = new Set<Promise<void>>()

  /** @param follow - allocates a Gateway-supervised metadata stream without Session or task commands. */
  constructor(private readonly follow: () => RemoteStream<readonly TaskConversationAttention[]>) {
    this.state = { getSnapshot: () => this.store.getSnapshot(), subscribe: (listener) => {
      if (this.disposed) return () => {}
      const off = this.store.subscribe(listener)
      if (++this.subscribers === 1) this.start()
      let active = true
      return () => {
        if (!active) return
        active = false
        off()
        if (--this.subscribers === 0) this.stop()
      }
    } }
  }

  /** Retry a failed feed only while a consumer is subscribed. */
  refresh(): void {
    if (this.disposed || this.subscribers === 0) return
    this.stop()
    this.start()
  }

  /** Withdraw the stream and wait for all replaced consumers and transports.
   * @returns when no owned operation can publish another snapshot.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stop()
    await Promise.allSettled(this.work)
  }

  private start(): void {
    const stream = this.follow()
    this.stream = stream
    this.store.set({ phase: 'loading', items: [], error: null })
    this.track((async () => {
      try {
        for await (const item of stream) {
          if (this.stream !== stream) return
          item.accept()
          this.store.set({ phase: 'ready', items: item.value, error: null })
        }
      } catch (error) {
        if (this.stream === stream) this.store.set({ ...this.store.getSnapshot(), phase: 'error', error: String(error) })
      }
    })())
  }

  private stop(): void {
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) this.track(stream.dispose())
    this.store.set({ phase: 'idle', items: [], error: null })
  }

  private track(work: Promise<void>): void {
    this.work.add(work)
    void work.finally(() => { this.work.delete(work) })
  }
}
