/** Host lifetime and project ownership for explicitly requested documentation servers. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ArtifactSiteRun } from './site-run.ts'
import type { ArtifactSiteConfig, SiteLocation } from './site-run.ts'
import type { SiteProcessHost } from './site-processes.ts'
import type { ArtifactRenditionId, ArtifactSiteAction, ArtifactSiteId, ArtifactSiteStatus } from './types.ts'

interface SiteRecord {
  state: ArtifactSiteStatus
  readonly run: ArtifactSiteRun
  readonly monitorAbort: AbortController
  readonly admit: (signal: AbortSignal) => Promise<void>
  monitor: Promise<void>
  location?: SiteLocation
  stopping?: Promise<void>
  released: boolean
}

/** One live site per project; replacements await old cleanup and service unload joins pending requests. */
export class ArtifactSiteManager {
  private readonly lifetime = new AbortController()
  private readonly records = new Map<WorkspaceId, SiteRecord>()
  private readonly starting = new Set<WorkspaceId>()
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param host - mounted, same-world process and confinement providers.
   * @param config - validated source, execution and capacity bounds.
   * @param open - system browser handoff; only a ready, owned URL reaches this callback.
   */
  constructor(private readonly host: SiteProcessHost, private readonly config: ArtifactSiteConfig,
    private readonly open: (url: string, signal: AbortSignal) => Promise<void>) {}

  /** Read retained progress without starting work.
   * @param workspaceId - project owning the preview.
   * @returns its latest immutable state, or undefined before the first explicit start.
   */
  status(workspaceId: WorkspaceId): ArtifactSiteStatus | undefined { return this.records.get(workspaceId)?.state }

  /** Replace a project's old preview only after cleanup; cancellation remains live through browser handoff.
   * @param workspaceId - registered project.
   * @param renditionId - validated documentation directory identity.
   * @param source - matching local artifact directory.
   * @param title - artifact display title.
   * @param admit - revalidate project and artifact membership throughout this run.
   * @param signal - requesting view lifetime until startup and browser handoff settle.
   * @returns after browser handoff or an explicit stop during startup; live serving belongs to this manager.
   */
  start(workspaceId: WorkspaceId, renditionId: ArtifactRenditionId, source: string, title: string,
    admit: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    return this.track(async () => {
      const request = AbortSignal.any([signal, this.lifetime.signal])
      request.throwIfAborted()
      if (this.starting.has(workspaceId)) throw new Error('A documentation preview is already starting for this project')
      const occupied = new Set([...this.records].filter(([id, record]) => id !== workspaceId && !record.released).map(([id]) => id))
      for (const id of this.starting) occupied.add(id)
      if (occupied.size >= this.config.maxActiveSites) throw new Error('Stop another documentation preview before starting this one')
      this.starting.add(workspaceId)
      try {
        const previous = this.records.get(workspaceId)
        if (previous !== undefined) await this.stopRecord(previous)
        request.throwIfAborted()
        await admit(request)
        request.throwIfAborted()
        const state: ArtifactSiteStatus = { id: brandString<ArtifactSiteId>(randomUUID()), renditionId, title,
          phase: 'preparing', mode: null, detail: null }
        const run = new ArtifactSiteRun(source, title, this.host, this.config, admit,
          (phase, detail) => { if (!record.stopping) record.state = { ...record.state, phase, detail } })
        const record: SiteRecord = { state, run, admit, monitorAbort: new AbortController(), monitor: Promise.resolve(), released: false }
        const activeRequest = AbortSignal.any([request, record.monitorAbort.signal])
        this.records.set(workspaceId, record)
        const cancel = (): void => { run.cancel() }
        request.addEventListener('abort', cancel, { once: true })
        this.monitor(record)
        try {
          const location = await run.start()
          request.throwIfAborted()
          await admit(activeRequest)
          this.assertActive(record)
          await this.open(location.url, activeRequest)
          request.throwIfAborted()
          this.assertActive(record)
          record.location = location
          record.state = { ...record.state, phase: 'ready', mode: location.mode, detail: location.detail }
          if (location.finished !== null) {
            void location.finished.then(() => { this.backgroundFailure(record, new Error('Documentation framework exited')) })
          }
        } catch (error) {
          if (!request.aborted && record.stopping) { await record.stopping; return }
          if (request.aborted) await this.stopRecord(record)
          else await this.fail(record, error)
          throw error
        } finally { request.removeEventListener('abort', cancel) }
      } finally { this.starting.delete(workspaceId) }
    })
  }

  /** Act on an exact run identity; stale requests never reach its replacement.
   * @param workspaceId - project owning the retained run.
   * @param id - exact process-local run identity from the catalog.
   * @param action - reopen the ready URL or stop and await all owned resources.
   * @param signal - cancels admission/handoff; an admitted stop always joins cleanup.
   * @returns after handoff or quiescent cleanup, without regenerating the site.
   */
  action(workspaceId: WorkspaceId, id: ArtifactSiteId, action: ArtifactSiteAction, signal: AbortSignal): Promise<void> {
    return this.track(async () => {
      const request = AbortSignal.any([signal, this.lifetime.signal])
      request.throwIfAborted()
      const record = this.records.get(workspaceId)
      if (record === undefined || record.state.id !== id) throw new Error('This documentation preview was replaced or is unavailable')
      if (action === 'stop') { await this.stopRecord(record); return }
      if (record.state.phase !== 'ready' || record.location === undefined) throw new Error('Documentation preview is not ready')
      await record.admit(request)
      request.throwIfAborted()
      if (record.stopping || record.released) throw new Error('Documentation preview was stopped')
      await this.open(record.location.url, AbortSignal.any([request, record.monitorAbort.signal]))
    })
  }

  /** Cancel new and pending operations, then release every owned site.
   * @returns after commands, listeners, HTTP connections and private source copies are gone; cleanup errors propagate.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const record of this.records.values()) { record.monitorAbort.abort(); record.run.cancel() }
    await Promise.allSettled(this.pending)
    const results = await Promise.allSettled([...this.records.values()].map(record => this.stopRecord(record)))
    const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Documentation preview cleanup failed')
  }

  private monitor(record: SiteRecord): void {
    const signal = AbortSignal.any([record.monitorAbort.signal, this.lifetime.signal])
    record.monitor = (async () => {
      while (!signal.aborted) {
        await delay(this.config.ownershipIntervalMs, undefined, { signal })
        await record.admit(signal)
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        record.run.cancel()
        // The monitor must settle before failure cleanup joins it.
        queueMicrotask(() => { this.backgroundFailure(record, error) })
      }
    })
  }

  private backgroundFailure(record: SiteRecord, error: unknown): void {
    if (record.stopping || record.released || this.lifetime.signal.aborted) return
    void this.track(() => this.fail(record, error)).catch(() => {
      // fail retains the cleanup error in catalog state and keeps the owner for a later explicit stop.
    })
  }

  private async fail(record: SiteRecord, error: unknown): Promise<void> {
    try { await this.stopRecord(record) } catch (cleanup) {
      error = new AggregateError([error, cleanup], 'Documentation preview failed and cleanup needs retry')
    }
    record.state = { ...record.state, phase: 'failed', detail: this.message(error) }
  }

  private stopRecord(record: SiteRecord): Promise<void> {
    if (record.released) { record.state = { ...record.state, phase: 'stopped' }; return Promise.resolve() }
    record.state = { ...record.state, phase: 'stopping' }
    record.monitorAbort.abort()
    record.run.cancel()
    return record.stopping ??= (async () => {
      await record.monitor
      await record.run.stop()
      record.released = true
      delete record.location
      record.state = { ...record.state, phase: 'stopped' }
    })().catch((error: unknown) => {
      delete record.stopping
      record.state = { ...record.state, phase: 'failed', detail: this.message(error) }
      throw error
    })
  }

  private message(error: unknown): string {
    const bytes = Buffer.from(error instanceof Error ? error.message : String(error))
    // Streaming decoding retains, rather than replaces, an incomplete final UTF-8 sequence.
    return new TextDecoder().decode(bytes.subarray(0, this.config.outputBytes), { stream: true })
  }

  private assertActive(record: SiteRecord): void {
    if (record.stopping || record.released) throw new Error('Documentation preview was stopped during startup')
  }

  private track<T>(run: () => Promise<T>): Promise<T> {
    const task = run()
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }
}
