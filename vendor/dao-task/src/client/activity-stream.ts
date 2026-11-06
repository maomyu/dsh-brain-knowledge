/** Consume one selected activity stream; the caller owns replacement and disposal. */
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'

/** Accept frames only while the originating selection still owns the stream.
 * @param stream - Gateway-supervised eligibility or completion stream.
 * @param current - exact owner and revision check.
 * @param failed - owner diagnostic for a still-current stream failure.
 * @returns when the stream ends, selection is withdrawn, or its supervised consumption fails.
 */
export async function consumeActivityStream(stream: RemoteStream<true>, current: () => boolean,
  failed: (error: unknown) => void): Promise<void> {
  try {
    for await (const item of stream) {
      if (!current() || item.signal.aborted) return
      item.accept()
    }
  } catch (error) { if (current()) failed(error) }
}

/** One selected activity registration; replacements join prior streams before opening another. */
export class ActivityStreams {
  private revision = 0
  private disposed = false
  private stream: RemoteStream<true> | undefined
  private transition = Promise.resolve()
  private readonly work = new Set<Promise<void>>()

  /** @param failed - owner diagnostic for current registration and consumption failures. */
  constructor(private readonly failed: (error: unknown) => void) {}

  /** Replace or withdraw the selected registration.
   * @param open - opens the new stream after prior registration teardown, or undefined to withdraw it.
   */
  replace(open: (() => RemoteStream<true>) | undefined): void {
    const revision = ++this.revision
    const previous = this.stream
    this.stream = undefined
    this.transition = Promise.all([this.transition, previous?.dispose()]).then(() => {
      if (this.disposed || revision !== this.revision || open === undefined) return
      const stream = this.stream = open()
      const work = consumeActivityStream(stream, () => !this.disposed && revision === this.revision, this.failed)
        .finally(() => { this.work.delete(work) })
      this.work.add(work)
    }).catch(this.failed)
  }

  /** Withdraw the current registration and join its consumer and all pending replacements.
   * @returns after no owned stream can accept another frame or reopen.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.replace(undefined)
    await this.transition
    await Promise.allSettled(this.work)
  }
}
