/** Managed dependency and framework processes for a private documentation source copy. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { mergeConfinementEnv, type SandboxProvider } from '@deepseek-ai/dsh-sandbox'

/** Validated deployment choices for package commands and readiness observation. */
export interface SiteProcessConfig {
  /** Automatic discovery, a named executable, or a deployment-owned executable and argument prefix. */
  readonly packageManager: 'auto' | 'npm' | 'pnpm' | {
    /** Package CLI semantics used for installation and script execution. */
    readonly kind: 'npm' | 'pnpm'
    /** Executable resolved by the same-world subprocess provider. */
    readonly executable: string
    /** Literal arguments preceding the package command, such as a bundled CLI module path. */
    readonly args: string[]
  }
  /** Dependency-installation deadline; cleanup continues after it expires. */
  readonly installTimeoutMs: number
  /** Framework readiness deadline; expiration stops the managed process range. */
  readonly startupTimeoutMs: number
  /** Deadline for each loopback HTTP readiness probe. */
  readonly probeTimeoutMs: number
  /** Delay between framework-output and readiness checks. */
  readonly pollIntervalMs: number
  /** Grace period before the process provider escalates termination. */
  readonly graceMs: number
  /** Retained bytes per output stream and maximum catalog diagnostic bytes. */
  readonly outputBytes: number
}

/** Same-world process and file-effect providers; neither is replaced with a raw child-process escape. */
export interface SiteProcessHost {
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
}

/** A selected package manager; the executable is resolved in the mounted provider's world. */
export interface SitePackageManager {
  readonly kind: 'npm' | 'pnpm'
  readonly executable: string
  readonly args: readonly string[]
}

/** A process exit or provider failure, observed without an unhandled rejected promise. */
export type SiteProcessExit = { readonly kind: 'exit'; readonly outcome: SubprocessOutcome }
  | { readonly kind: 'error'; readonly error: unknown }

/** A framework URL is exposed only after an HTTP readiness response. */
export interface FrameworkSite {
  readonly url: string
  readonly finished: Promise<SiteProcessExit>
}

interface OwnedProcess {
  readonly handle: SubprocessHandle
  readonly finished: Promise<SiteProcessExit>
  observed?: SiteProcessExit
  stopping?: Promise<void>
}

/** Package-command failure preserves timeout and process outcome as independent observations. */
export class SiteCommandError extends Error {
  /**
   * @param message - operation failure without inherited environment values.
   * @param timedOut - the operation deadline elapsed, independently of process exit status.
   * @param outcome - observed child exit, if the provider produced one.
   */
  constructor(message: string, readonly timedOut: boolean, readonly outcome: SubprocessOutcome | undefined) {
    super(message)
    this.name = 'SiteCommandError'
  }
}

/** Own every package process until its managed range is empty; failed cleanup remains retryable. */
export class SiteProcessGroup {
  private readonly children = new Set<OwnedProcess>()
  private readonly environment: Record<string, string | undefined> & { PATH: string }

  /**
   * @param host - same-world subprocess and confinement services.
   * @param config - explicit validated command, deadline, polling and output limits.
   * @param root - private source-copy root; package caches and generated files stay under this root.
   * @param admit - recheck retained project/artifact ownership immediately before each spawn.
   */
  constructor(private readonly host: SiteProcessHost, private readonly config: SiteProcessConfig,
    private readonly root: string, private readonly admit: (signal: AbortSignal) => Promise<void>) {
    this.environment = { CI: 'true', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: undefined, NODE_PATH: undefined }
  }

  /** Resolve an explicit command without substitution, or discover a named manager.
   * @param signal - cancels executable resolution.
   * @returns the manager identity and its canonical executable.
   */
  async manager(signal: AbortSignal): Promise<SitePackageManager> {
    const configured = this.config.packageManager
    if (typeof configured !== 'string') {
      const executable = await this.host.subprocess.resolveExecutable(configured.executable, { PATH: this.environment.PATH }, signal)
      this.environment.PATH = `${dirname(executable)}${delimiter}${this.environment.PATH}`
      return { kind: configured.kind, executable, args: configured.args }
    }
    const kinds: readonly ('pnpm' | 'npm')[] = configured === 'auto' ? ['pnpm', 'npm'] : [configured]
    const failures: unknown[] = []
    for (const kind of kinds) {
      signal.throwIfAborted()
      try {
        const executable = await this.host.subprocess.resolveExecutable(kind, { PATH: this.environment.PATH }, signal)
        return { kind, executable, args: [] }
      } catch (error) { signal.throwIfAborted(); failures.push(error) }
    }
    throw new AggregateError(failures, 'No configured documentation package manager is available')
  }

  /** Install declared dependencies with lifecycle scripts disabled and private configuration/cache files.
   * @param manager - previously resolved package manager.
   * @param cwd - selected project directory within the private source copy.
   * @param signal - operation cancellation; cleanup is always joined without this cancelled signal.
   * @returns after successful installation and complete installer-process cleanup.
   */
  async install(manager: SitePackageManager, cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const runtime = await mkdtemp(join(this.root, '.dsh-site-runtime-'))
    const user = join(runtime, 'user.npmrc'), global = join(runtime, 'global.npmrc')
    await writeFile(user, '', { flag: 'wx', mode: 0o600 })
    await writeFile(global, '', { flag: 'wx', mode: 0o600 })
    Object.assign(this.environment, { npm_config_userconfig: user, npm_config_globalconfig: global,
      npm_config_cache: join(runtime, 'cache'), npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' })
    const args = manager.kind === 'pnpm'
      ? ['install', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', join(runtime, 'store')]
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund']
    await this.deadline(this.config.installTimeoutMs, signal, async (limited, expired) => {
      const child = await this.spawn([manager.executable, ...manager.args, ...args], cwd, limited)
      let outcome: SiteProcessExit
      try { outcome = await child.finished } finally { await this.release(child) }
      signal.throwIfAborted()
      if (expired() || outcome.kind === 'error' || outcome.outcome.exitCode !== 0) {
        throw new SiteCommandError(`Documentation dependency installation ${expired() ? 'timed out' : 'failed'}${this.tail(child)}`,
          expired(), outcome.kind === 'exit' ? outcome.outcome : undefined)
      }
    })
  }

  /** Start the retained script and observe a loopback HTTP endpoint before exposing its URL.
   * @param manager - resolved package manager.
   * @param cwd - selected project directory within the private source copy.
   * @param scriptName - one allowlisted script name selected from captured package metadata.
   * @param signal - lifetime cancellation for the owned framework process.
   * @returns the ready URL and a separately observed process exit; stop still joins the complete managed range.
   * @throws SiteCommandError for an early exit or startup deadline; caller cancellation preserves its reason.
   */
  async serve(manager: SitePackageManager, cwd: string, scriptName: string, signal: AbortSignal): Promise<FrameworkSite> {
    return this.deadline(this.config.startupTimeoutMs, signal, async (limited, expired) => {
      const child = await this.spawn([manager.executable, ...manager.args, 'run', scriptName], cwd, limited)
      try {
        while (!limited.aborted) {
          if (this.hasExited(child)) break
          for (const url of this.urls(child)) {
            if (await this.ready(url, limited)) {
              limited.throwIfAborted()
              if (this.hasExited(child)) break
              return { url, finished: child.finished }
            }
          }
          await delay(this.config.pollIntervalMs, undefined, { signal: limited })
        }
        limited.throwIfAborted()
        const outcome = child.observed?.kind === 'exit' ? child.observed.outcome : undefined
        throw new SiteCommandError(`Documentation framework exited before readiness${this.tail(child)}`, false, outcome)
      } catch (error) {
        await this.release(child)
        signal.throwIfAborted()
        if (expired() && !(error instanceof SiteCommandError)) {
          throw new SiteCommandError(`Documentation framework startup timed out${this.tail(child)}`, true,
            child.observed?.kind === 'exit' ? child.observed.outcome : undefined)
        }
        throw error
      }
    })
  }

  /** Stop all retained commands, including any whose earlier cleanup failed.
   * @returns after every managed range is empty; rejects and retains failed owners for an explicit retry.
   */
  async stop(): Promise<void> {
    const results = await Promise.allSettled([...this.children].map(child => this.release(child)))
    const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Documentation processes could not be fully stopped')
  }

  private async spawn(argv: readonly string[], cwd: string, signal: AbortSignal): Promise<OwnedProcess> {
    signal.throwIfAborted()
    const confined = await this.host.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: this.root }, signal, { cwd })
    if (confined.enforcement !== 'full') throw new Error('Documentation execution requires complete file-effect confinement')
    await this.admit(signal)
    signal.throwIfAborted()
    const handle = this.host.subprocess.spawn({ argv: confined.argv, cwd,
      env: mergeConfinementEnv(this.environment, confined.env, confined), signal, graceMs: this.config.graceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.outputBytes }, stderr: { maxBytes: this.config.outputBytes } } })
    const finished = handle.done.then<SiteProcessExit, SiteProcessExit>(outcome => ({ kind: 'exit', outcome }),
      (error: unknown) => ({ kind: 'error', error }))
    const child: OwnedProcess = { handle, finished }
    this.children.add(child)
    void finished.then((outcome) => { child.observed = outcome })
    return child
  }

  private release(child: OwnedProcess): Promise<void> {
    return child.stopping ??= (async () => {
      child.handle.terminate()
      if (!await child.handle.waitForExit()) throw new Error('Documentation process quiescence was not confirmed')
      await child.finished
      this.children.delete(child)
    })().catch((error: unknown) => { delete child.stopping; throw error })
  }

  private tail(child: OwnedProcess): string {
    const output = stripVTControlCharacters([child.handle.collected.stdout?.readFrom(0).text,
      child.handle.collected.stderr?.readFrom(0).text].filter(Boolean).join('\n')).trim().slice(-this.config.outputBytes)
    return output === '' ? '' : `: ${output}`
  }

  private urls(child: OwnedProcess): readonly string[] {
    const matches = this.tail(child).match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s<>"']*)?/g) ?? []
    return [...new Set(matches)].reverse().filter((value) => {
      try { return new URL(value).port !== '' } catch { return false }
    })
  }

  private async ready(url: string, signal: AbortSignal): Promise<boolean> {
    return this.deadline(this.config.probeTimeoutMs, signal, async (limited) => {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: limited })
        const ready = response.status === 200
        await response.body?.cancel()
        return ready
      } catch { signal.throwIfAborted(); return false }
    })
  }

  private hasExited(child: OwnedProcess): boolean { return child.observed !== undefined }

  private async deadline<T>(ms: number, signal: AbortSignal,
    run: (limited: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('Documentation operation deadline elapsed')) }, ms)
    timer.unref()
    try { return await run(AbortSignal.any([signal, timeout.signal]), () => timeout.signal.aborted) } finally { clearTimeout(timer) }
  }
}
