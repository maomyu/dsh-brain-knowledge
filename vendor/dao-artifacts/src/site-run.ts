/** Own preparation, framework execution, fallback and cleanup for one explicitly requested documentation preview. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSiteSnapshot } from './site-snapshot.ts'
import type { SiteSnapshot, SiteSnapshotLimits } from './site-snapshot.ts'
import { resolveSiteProject } from './site-project.ts'
import { SiteProcessGroup } from './site-processes.ts'
import type { SiteProcessConfig, SiteProcessExit, SiteProcessHost } from './site-processes.ts'
import { startStaticSite } from './site-static.ts'
import type { StaticSite } from './site-static.ts'

/** Validated bounds for one prepared site and its owned execution. */
export interface ArtifactSiteConfig extends SiteSnapshotLimits, SiteProcessConfig {
  /** Inclusive complete static-response byte limit, after Markdown rendering. */
  readonly maxRenderedBytes: number
  /** Maximum projects concurrently preparing or retaining a live site. */
  readonly maxActiveSites: number
  /** Delay between checks that the original project still owns the artifact path. */
  readonly ownershipIntervalMs: number
}

/** Observable startup transitions before browser handoff. */
export type SiteStartupPhase = 'preparing' | 'installing' | 'starting' | 'fallback'

/** A ready site and its serving mode and execution details; captured HTML and static fallback have no child process. */
export interface SiteLocation {
  readonly url: string
  readonly mode: 'framework' | 'html' | 'static'
  readonly framework: string
  readonly detail: string | null
  readonly finished: Promise<SiteProcessExit> | null
}

/** One cancellation owner, independent of the requesting RPC's lifetime after successful handoff. */
export class ArtifactSiteRun {
  private readonly lifetime = new AbortController()
  private preparation: Promise<SiteLocation> | undefined
  private snapshot: SiteSnapshot | undefined
  private processes: SiteProcessGroup | undefined
  private staticSite: StaticSite | undefined
  private stopping: Promise<void> | undefined

  /**
   * @param source - admitted documentation artifact directory on this Host.
   * @param title - catalog display name.
   * @param host - mounted process and file-confinement providers.
   * @param config - validated limits and process choices.
   * @param admit - revalidate the original project/path relationship before execution.
   * @param progress - owning controller's startup-state publisher.
   */
  constructor(private readonly source: string, private readonly title: string, private readonly host: SiteProcessHost,
    private readonly config: ArtifactSiteConfig, private readonly admit: (signal: AbortSignal) => Promise<void>,
    private readonly progress: (phase: SiteStartupPhase, detail: string | null) => void) {}

  /** Prepare and start at most once; no command runs before this explicit call.
   * @returns the ready framework, interactive HTML or script-disabled fallback location, before browser handoff.
   */
  start(): Promise<SiteLocation> {
    return this.preparation ??= this.prepareAndStart()
  }

  /** Request cancellation; stop must still be awaited before releasing this owner. */
  cancel(): void { this.lifetime.abort() }

  /** Stop startup and live serving before removing the originally allocated source copy.
   * @returns after all managed processes, server connections and owned temporary files are released.
   */
  stop(): Promise<void> {
    this.cancel()
    return this.stopping ??= (async () => {
      // Startup's caller owns its success/failure; cleanup joins either outcome before examining acquired resources.
      await this.preparation?.then(() => undefined, () => undefined)
      await this.processes?.stop()
      await this.staticSite?.stop()
      await this.snapshot?.dispose()
    })().catch((error: unknown) => { this.stopping = undefined; throw error })
  }

  private async prepareAndStart(): Promise<SiteLocation> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    this.progress('preparing', null)
    await this.admit(signal)
    this.snapshot = await prepareSiteSnapshot(this.source, tmpdir(), this.config, signal)
    const files = await this.snapshot.readFiles(signal)
    const project = resolveSiteProject(files, this.title)
    const contentPrefix = project.contentRoot === '' ? '' : `${project.contentRoot}/`
    if (!project.hasPackage && project.framework === 'generic'
      && ['index.html', 'index.htm'].some(file => files.has(contentPrefix + file))) {
      await this.admit(signal)
      this.progress('starting', null)
      this.staticSite = await startStaticSite(files, project, this.config.maxRenderedBytes, signal, 'local')
      signal.throwIfAborted()
      return { url: this.staticSite.url, mode: 'html', framework: project.framework, detail: null, finished: null }
    }
    this.processes = new SiteProcessGroup(this.host, this.config, this.snapshot.root, this.admit)
    let reason: string
    try {
      if (!project.hasPackage || project.scriptName === null) throw new Error('Documentation project has no supported package startup script')
      const cwd = join(this.snapshot.root, project.root)
      const manager = await this.processes.manager(signal)
      this.progress('installing', null)
      await this.processes.install(manager, cwd, signal)
      signal.throwIfAborted()
      this.progress('starting', null)
      const server = await this.processes.serve(manager, cwd, project.scriptName, signal)
      signal.throwIfAborted()
      return { ...server, mode: 'framework', framework: project.framework, detail: null }
    } catch (error) {
      signal.throwIfAborted()
      // A failed framework must be quiescent before fallback; a cleanup failure propagates and retains the source copy.
      await this.processes.stop()
      reason = (error instanceof Error ? error.message : String(error)).slice(-this.config.outputBytes)
    }
    signal.throwIfAborted()
    await this.admit(signal)
    this.progress('fallback', reason)
    this.staticSite = await startStaticSite(files, project, this.config.maxRenderedBytes, signal, 'disabled')
    signal.throwIfAborted()
    return { url: this.staticSite.url, mode: 'static', framework: project.framework, detail: reason, finished: null }
  }
}
