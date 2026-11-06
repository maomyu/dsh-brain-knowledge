/** Execute only checks retained in the user's approved plan, with bounded output and joined teardown. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'
import type { ProjectGoalCheck } from './types.ts'

/** Run one deterministic check; cancellation never produces an acceptance mark.
 * @param ctx - configured subprocess execution world.
 * @param check - approved command or HTTP probe, not worker-authored output.
 * @param cwd - retained Task execution directory.
 * @param config - deployment-owned execution and reporting bounds.
 * @param signal - owning Goal collection lifetime.
 * @returns host-observed success and bounded diagnostic text after response or process cleanup and cancellation checks.
 */
export async function runGoalCheck(ctx: Context, check: ProjectGoalCheck, cwd: string,
  config: Config['goalChecks'], signal: AbortSignal): Promise<{ passed: boolean; detail: string }> {
  signal.throwIfAborted()
  const timeoutMs = Math.min(check.timeoutMs ?? config.timeoutMs, 2147483647)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error(`timed out after ${timeoutMs}ms`)) }, timeoutMs)
  const live = AbortSignal.any([signal, deadline.signal])
  const bounded = (text: string): string => Array.from(text.trim()).slice(-config.maxDetailChars).join('')
  try {
    if (check.kind === 'http') {
      const response = await fetch(check.url, { method: 'GET', redirect: 'follow', signal: live })
      await response.body?.cancel()
      live.throwIfAborted()
      return { passed: response.ok, detail: bounded(`GET ${check.url}: ${response.status} ${response.statusText}`) }
    }
    const executable = await ctx.subprocess.resolveExecutable(config.executable, undefined, live)
    const handle = ctx.subprocess.spawn({ argv: [executable, ...config.args, check.command], cwd, signal: live,
      graceMs: config.graceMs, stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } } })
    let outcome
    try { outcome = await handle.done }
    finally { handle.terminate(); await handle.waitForExit() }
    live.throwIfAborted()
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    /* v8 ignore if -- the subprocess Service Definition supplies readers iff the requested streams use collect mode. */
    if (stdout === undefined || stderr === undefined) throw new Error('check output was not collected')
    return { passed: outcome.exitCode === 0 && outcome.signal === null && !stdout.lossy && !stderr.lossy,
      detail: bounded(`exit ${outcome.exitCode}${outcome.signal === null ? '' : `; signal ${outcome.signal}`}`
        + `${stdout.lossy || stderr.lossy ? '; output limit exceeded' : ''}\n${stdout.text}\n${stderr.text}`) }
  } catch (error) {
    signal.throwIfAborted()
    return { passed: false, detail: bounded(deadline.signal.aborted ? `timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error)) }
  } finally { clearTimeout(timer) }
}
