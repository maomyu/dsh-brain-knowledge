/** Selected-project eligibility for pre-approval Goal results, independent of conversation selection. */
import { ActivityStreams } from './activity-stream.ts'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Owns one project stream and joins replacements before admitting another selection. */
export class ClientGoalActivity {
  private selected: WorkspaceId | null = null
  private readonly streams: ActivityStreams

  /** @param follow - Gateway-supervised project eligibility stream.
   * @param failed - owner diagnostic when automatic collection is unavailable.
   */
  constructor(private readonly follow: (id: WorkspaceId) => RemoteStream<true>, failed: (error: unknown) => void) {
    this.streams = new ActivityStreams(failed)
  }

  /** Select the project without replaying historical results.
   * @param id - selected project or null to withdraw pre-approval result eligibility; approved running Goals are Host-owned.
   */
  watch(id: WorkspaceId | null): void {
    if (this.selected === id) return
    this.selected = id
    this.streams.replace(id === null ? undefined : () => this.follow(id))
  }

  /** Withdraw eligibility and join all stream replacements.
   * @returns after no old project can become eligible again.
   */
  async dispose(): Promise<void> {
    this.watch(null)
    await this.streams.dispose()
  }
}
