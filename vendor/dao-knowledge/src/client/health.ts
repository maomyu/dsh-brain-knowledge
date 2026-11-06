/** React-free report following and explicit disposition writes share one selected-project lifetime. */
import { createSnapshotStore, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeHealthReportId, KnowledgeHealthReports, KnowledgeHealthFindingUpdate,
  KnowledgeHealthCheckOptions, KnowledgeHealthCheckResult, KnowledgeHealthHistoryId,
  KnowledgeHealthReportHistory, KnowledgeHealthHistoricalReport } from '../types.ts'
import type { KnowledgeReadStatus } from './model.ts'

/** Complete report projection; an error or loading phase may retain the last observed listing. */
export interface KnowledgeHealthSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly status: KnowledgeReadStatus
  readonly listing: KnowledgeHealthReports | null
  readonly error: string | null
  readonly updating: { readonly reportId: KnowledgeHealthReportId; readonly findingNumber: number } | null
  readonly updateError: string | null
  readonly checkStatus: 'idle' | 'running' | 'cancelling'
  readonly checkError: string | null
}

/** Exact historical address; null historyId selects the retained version list. */
export interface KnowledgeHealthHistoryTarget {
  readonly workspaceId: WorkspaceId
  readonly reportId: KnowledgeHealthReportId
  readonly historyId: KnowledgeHealthHistoryId | null
}

/** Read-only history, separate from the live reports used by current health metrics. */
export interface KnowledgeHealthHistorySnapshot {
  readonly target: KnowledgeHealthHistoryTarget | null
  readonly status: KnowledgeReadStatus
  readonly listing: KnowledgeHealthReportHistory | null
  readonly detail: KnowledgeHealthHistoricalReport | null
  readonly error: { readonly kind: 'identity' } | { readonly kind: 'request'; readonly message: string } | null
}

/** Cancellable reports and explicit version-qualified updates, independent of ordinary page reads. */
export interface IKnowledgeHealth {
  readonly state: ObservableSnapshot<KnowledgeHealthSnapshot>
  readonly history: ObservableSnapshot<KnowledgeHealthHistorySnapshot>
  /** Select one historical address, cancelling its predecessor without touching live metrics.
   * @param target - project, daily report and retained version, or null to release reads.
   */
  selectHistory(target: KnowledgeHealthHistoryTarget | null): void
  /** Reload only the selected history; never initiate an assessment or disposition. */
  refreshHistory(): void
  /** Follow a visible project's reports; null releases data and cancels its work.
   * @param workspaceId - selected registered project, or null when the view is inactive.
   */
  watch(workspaceId: WorkspaceId | null): void
  /** Restart the current report stream; an outstanding disposition must settle first. */
  refresh(): void
  /** Mark a finding from the exact displayed report; failures stay visible and never auto-retry.
   * @param reportId - displayed report identity.
   * @param request - observed version, finding number, status and optional note.
   * @returns after the write settles; a committed update restarts the authoritative listing.
   */
  mark(reportId: KnowledgeHealthReportId, request: KnowledgeHealthFindingUpdate): Promise<void>
  /** Run an explicit assessment for the followed project; never retry an uncertain model request.
   * @param options - complete language and scope choices.
   * @returns the published report, or undefined after failure, cancellation or project departure.
   */
  check(options: KnowledgeHealthCheckOptions): Promise<KnowledgeHealthCheckResult | undefined>
  /** Cancel the current check and retain its busy state until the request settles. */
  cancelCheck(): void
}

const empty = (): KnowledgeHealthSnapshot => ({ workspaceId: null, status: 'idle', listing: null,
  error: null, updating: null, updateError: null, checkStatus: 'idle', checkError: null })

const emptyHistory = (): KnowledgeHealthHistorySnapshot => ({ target: null, status: 'idle', listing: null, detail: null, error: null })

/** Owns report stream replacement, write cancellation and disposal to quiescence. */
export class ClientKnowledgeHealth implements IKnowledgeHealth {
  readonly state = createSnapshotStore<KnowledgeHealthSnapshot>(empty())
  readonly history = createSnapshotStore<KnowledgeHealthHistorySnapshot>(emptyHistory())
  private historyRead: AbortController | undefined
  private stream: RemoteStream<KnowledgeHealthReports> | undefined
  private write: AbortController | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private disposed = false

  /**
   * @param remote - generated report disposition method.
   * @param follow - Gateway-supervised complete report stream factory.
   */
  constructor(private readonly remote: Pick<ClientRemote['knowledge'], 'markHealthFinding' | 'checkHealth' | 'healthReportHistory' | 'readHealthReportHistory'>,
    private readonly follow: (workspaceId: WorkspaceId) => RemoteStream<KnowledgeHealthReports>) {}

  selectHistory(target: KnowledgeHealthHistoryTarget | null): void {
    if (this.disposed) return
    const previous = this.history.getSnapshot().target
    if (previous?.workspaceId === target?.workspaceId && previous?.reportId === target?.reportId
      && previous?.historyId === target?.historyId) return
    this.historyRead?.abort()
    this.historyRead = undefined
    this.history.set({ ...emptyHistory(), target })
    if (target !== null) this.refreshHistory()
  }

  refreshHistory(): void {
    const target = this.history.getSnapshot().target
    if (this.disposed || target === null) return
    this.historyRead?.abort()
    const read = new AbortController()
    this.historyRead = read
    this.history.set({ ...emptyHistory(), target, status: 'loading' })
    void trackPending(this.pending, (async () => {
      try {
        const [listing, detail] = await Promise.all([
          trackPending(this.pending, this.remote.healthReportHistory(target.workspaceId, target.reportId, read.signal)),
          target.historyId === null ? undefined
            : trackPending(this.pending,
              this.remote.readHealthReportHistory(target.workspaceId, target.reportId, target.historyId, read.signal)),
        ])
        if (read.signal.aborted || this.historyRead !== read) return
        if (!listing.ok) throw new Error(listing.error.message)
        if (detail !== undefined && !detail.ok) throw new Error(detail.error.message)
        const value = detail?.value ?? null
        if (listing.value.workspaceId !== target.workspaceId || listing.value.reportId !== target.reportId
          || (value !== null && (value.workspaceId !== target.workspaceId || value.reportId !== target.reportId
            || value.revisionId !== target.historyId || value.report.id !== target.reportId))) {
          this.history.set({ ...emptyHistory(), target, status: 'error', error: { kind: 'identity' } })
          return
        }
        this.history.set({ target, status: 'ready', listing: listing.value, detail: value, error: null })
      } catch (error) {
        if (!read.signal.aborted && this.historyRead === read) {
          this.history.set({ ...emptyHistory(), target, status: 'error', error: {
            kind: 'request', message: error instanceof Error ? error.message : String(error),
          } })
        }
      } finally {
        read.abort()
        if (this.historyRead === read) this.historyRead = undefined
      }
    })())
  }

  watch(workspaceId: WorkspaceId | null): void {
    if (this.disposed || this.state.getSnapshot().workspaceId === workspaceId) return
    this.write?.abort()
    this.write = undefined
    this.stop()
    this.state.set({ ...empty(), workspaceId })
    this.restart()
  }

  refresh(): void {
    if (!this.disposed && this.write === undefined) this.restart()
  }

  mark(reportId: KnowledgeHealthReportId, request: KnowledgeHealthFindingUpdate): Promise<void> {
    const before = this.state.getSnapshot()
    if (this.disposed || this.write !== undefined || before.workspaceId === null || before.status !== 'ready') return Promise.resolve()
    const workspaceId = before.workspaceId
    const write = new AbortController()
    this.write = write
    this.publish({ updating: { reportId, findingNumber: request.findingNumber }, updateError: null })
    return trackPending(this.pending, (async () => {
      try {
        const result = await this.remote.markHealthFinding(workspaceId, reportId, request, write.signal)
        if (write.signal.aborted) return
        if (!result.ok) this.publish({ updateError: result.error.message })
        else this.restart()
      } catch (error) {
        if (!write.signal.aborted) this.publish({ updateError: String(error) })
      } finally {
        if (this.write === write) { this.write = undefined; this.publish({ updating: null }) }
      }
    })())
  }

  check(options: KnowledgeHealthCheckOptions): Promise<KnowledgeHealthCheckResult | undefined> {
    const before = this.state.getSnapshot()
    if (this.disposed || this.write !== undefined || before.workspaceId === null || before.status !== 'ready') return Promise.resolve(undefined)
    const write = new AbortController()
    this.write = write
    this.publish({ checkStatus: 'running', checkError: null, updateError: null })
    const workspaceId = before.workspaceId
    return trackPending(this.pending, (async () => {
      try {
        const result = await this.remote.checkHealth(workspaceId, options, write.signal)
        if (write.signal.aborted) return undefined
        if (!result.ok) { this.publish({ checkError: result.error.message }); return undefined }
        this.restart()
        return result.value
      } catch (error) {
        if (!write.signal.aborted) this.publish({ checkError: String(error) })
        return undefined
      } finally {
        if (this.write === write) { this.write = undefined; this.publish({ checkStatus: 'idle' }) }
      }
    })())
  }

  cancelCheck(): void {
    if (this.state.getSnapshot().checkStatus !== 'running' || this.write === undefined) return
    this.publish({ checkStatus: 'cancelling' })
    this.write.abort()
  }

  /** Cancel outstanding reads and writes, then await all owned work.
   * @returns after no owned request can publish another snapshot.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.historyRead?.abort()
    this.historyRead = undefined
    this.history.set(emptyHistory())
    this.write?.abort()
    this.write = undefined
    this.stop()
    await Promise.allSettled(this.pending)
  }

  private restart(): void {
    this.stop()
    const workspaceId = this.state.getSnapshot().workspaceId
    if (workspaceId === null) return
    this.publish({ status: 'loading', error: null })
    const stream = this.follow(workspaceId)
    this.stream = stream
    void trackPending(this.pending, (async () => {
      try {
        for await (const item of stream) {
          if (this.stream !== stream) return
          item.accept()
          this.publish({ status: 'ready', listing: item.value, error: null })
        }
      } catch (error) {
        if (this.stream === stream) this.publish({ status: 'error', error: String(error) })
      }
    })())
  }

  private stop(): void {
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) void trackPending(this.pending, stream.dispose())
  }


  private publish(change: Partial<KnowledgeHealthSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }
}
