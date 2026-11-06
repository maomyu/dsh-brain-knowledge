/** Selection-owned completion delivery registration, independent of retained card feeds and visible tabs. */
import { ActivityStreams } from './activity-stream.ts'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

interface TaskActivitySessions {
  readonly list: ObservableSnapshot<Pick<SessionListState, 'byId' | 'phase'>>
  binding(id: SessionId): { readonly session: ObservableSnapshot<Pick<SessionSnapshot, 'inspection'>> } | undefined
}

/** Owns one selected-source stream; replacements wait for the previous stream's quiescent close. */
export class ClientTaskActivity {
  private project: WorkspaceId | null = null
  private space: ProjectSpaceId | undefined
  private key: string | undefined
  private disposed = false
  private readonly streams: ActivityStreams
  private readonly unsubscribe: Array<() => void>
  private selectedSession: ObservableSnapshot<Pick<SessionSnapshot, 'inspection'>> | undefined
  private stopSelectedSession = (): void => {}

  /** @param sessions - main-view reference counts and borrowed inspection state; no history is opened.
   * @param workspaces - authoritative project membership and readiness.
   * @param follow - Gateway-supervised selected-source registration.
   * @param failed - owner diagnostic; failed registration leaves outcomes pending for explicit review.
   */
  constructor(private readonly sessions: TaskActivitySessions,
    private readonly workspaces: WorkspaceSource,
    private readonly follow: (workspaceId: WorkspaceId, sessionId: SessionId) => RemoteStream<true>,
    failed: (error: unknown) => void) {
    this.streams = new ActivityStreams(failed)
    this.unsubscribe = [sessions.list.subscribe(() => { this.sync() }), workspaces.subscribe(() => { this.sync() })]
  }

  /** Select the project whose current conversation may receive newly completed outcomes.
   * @param workspaceId - selected project on any tab, or null to withdraw registration.
   * @param spaceId - selected logical workspace for a projectless source; omission withdraws it.
   */
  watch(workspaceId: WorkspaceId | null, spaceId?: ProjectSpaceId): void {
    if (this.disposed) return
    this.project = workspaceId
    this.space = spaceId
    this.sync()
  }

  private sync(): void {
    const sessions = this.sessions.list.getSnapshot()
    const workspaces = this.workspaces.getSnapshot()
    const sessionId = Object.values(sessions.byId)
      .find(row => Object.entries(row.retainedBy).some(([source, count]) => source === 'mainView' && count > 0))?.id
    const selected = this.disposed || sessionId === undefined ? undefined : this.sessions.binding(sessionId)?.session
    if (selected !== this.selectedSession) {
      this.stopSelectedSession()
      this.selectedSession = selected
      this.stopSelectedSession = selected?.subscribe(() => { this.sync() }) ?? (() => {})
    }
    const looseSpace = this.project !== null || sessionId === undefined ? undefined
      : workspaces.spaces.find(item => item.spaceId === this.space && item.looseSessionIds?.includes(sessionId))
    const workspace = workspaces.items.find(item => item.workspaceId === this.project
      || looseSpace?.projectIds.includes(item.workspaceId))
    const target = !this.disposed && sessions.phase === 'ready' && workspaces.phase === 'ready'
      && selected !== undefined && !selected.getSnapshot().inspection
      && sessionId !== undefined && workspace !== undefined && (workspace.sessionIds.includes(sessionId) || looseSpace !== undefined)
      ? { workspaceId: workspace.workspaceId, sessionId, path: workspace.path } : undefined
    const key = target === undefined ? undefined : JSON.stringify(target)
    if (key === this.key) return
    this.key = key
    this.streams.replace(target === undefined ? undefined : () => this.follow(target.workspaceId, target.sessionId))
  }

  /** Stop subscriptions and join registration replacements and consumers.
   * @returns after no old selection can reopen or consume another frame.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const off of this.unsubscribe) off()
    this.sync()
    await this.streams.dispose()
  }
}
