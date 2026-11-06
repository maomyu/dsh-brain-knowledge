/** Bounded native model discovery; never creates a thread or submits a turn. */
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { codexAppServerArgv, disposeCodexChild } from './run.ts'
import { CodexAppServerWire } from './wire.ts'

/** Native pagination identity, valid only within one catalog connection. */
export type CodexModelCursor = Branded<'CodexModelCursor'>

/** Native advertised choice; availability, authentication and quota are not certified. */
export interface CodexModelChoice {
  /** Exact execution selector from the native `model` field, not the catalog entry id. */
  readonly model: string
  readonly label: string
  readonly description: string
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly reasoningEfforts: readonly { readonly id: string; readonly description: string }[]
}

/** Resolved deployment bounds and managed process owner for one catalog request. */
export interface CodexModelCatalogSpec {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly disposeGraceMs: number
  readonly timeoutMs: number
  /** Inclusive count across all received entries, including hidden entries. */
  readonly maxModels: number
  /** Inclusive stdout byte allowance across initialization and every catalog page. */
  readonly maxBytes: number
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex model catalog')
  return value as Record<string, unknown>
}

/** Discover visible models and join native process termination before settling.
 * @param spec - resolved limits, cwd and credential-scrubbed subprocess owner.
 * @param signal - caller or controller cancellation, effective through discovery.
 * @returns complete visible native choices, without changing any execution selection.
 * @throws for cancellation, timeout, malformed/incomplete catalogs or process failure; never returns a partial list.
 */
export async function listCodexModels(spec: CodexModelCatalogSpec, signal: AbortSignal): Promise<readonly CodexModelChoice[]> {
  signal.throwIfAborted()
  const stop = new AbortController()
  const lifetime = AbortSignal.any([signal, stop.signal])
  const child = spec.spawn({ argv: codexAppServerArgv(), cwd: spec.cwd, env: spec.env,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: spec.disposeGraceMs })
  const timer = setTimeout(() => { stop.abort(new Error('Codex model discovery timed out')) }, spec.timeoutMs)
  timer.unref()
  // Both streams are pipes in the explicit spawn spec; the subprocess service owns this guarantee.
  const stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
  const stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
  const stderr = child.stderr as NonNullable<SubprocessHandle['stderr']>
  const wire = new CodexAppServerWire(stdout, stdin, 'never')
  let receivedBytes = 0
  const onData = (chunk: Buffer): void => {
    receivedBytes += chunk.byteLength
    if (receivedBytes > spec.maxBytes) stop.abort(new Error('Codex model catalog exceeds the byte limit'))
  }
  stdout.on('data', onData)
  stderr.on('error', () => { stop.abort(new Error('Codex diagnostic stream failed')) })
  stderr.resume()
  const exited = child.done.then(() => { throw new Error('Codex exited during model discovery') },
    () => { throw new Error('Codex process failed during model discovery') })
  void exited.catch(() => {})
  try {
    wire.start()
    await Promise.race([wire.initialize(lifetime), exited])
    const models: CodexModelChoice[] = []
    const selectors = new Set<string>()
    const cursors = new Set<string>()
    let count = 0
    let cursor: CodexModelCursor | undefined
    do {
      lifetime.throwIfAborted()
      const page = record(await Promise.race([wire.modelList(cursor, spec.maxModels - count, lifetime), exited]))
      if (!Array.isArray(page.data) || count + page.data.length > spec.maxModels) throw new Error('Invalid or oversized Codex model catalog')
      count += page.data.length
      for (const value of page.data) {
        const entry = record(value)
        if (typeof entry.model !== 'string' || entry.model.trim() === '' || entry.model !== entry.model.trim()
          || typeof entry.displayName !== 'string' || typeof entry.description !== 'string'
          || typeof entry.hidden !== 'boolean' || typeof entry.isDefault !== 'boolean'
          || selectors.has(entry.model)) throw new Error('Invalid Codex model catalog entry')
        selectors.add(entry.model)
        if (typeof entry.defaultReasoningEffort !== 'string' || entry.defaultReasoningEffort.trim() === ''
          || !Array.isArray(entry.supportedReasoningEfforts)) throw new Error('Invalid Codex model catalog reasoning options')
        const efforts = new Set<string>()
        const reasoningEfforts = entry.supportedReasoningEfforts.map((value) => {
          const option = record(value)
          if (typeof option.reasoningEffort !== 'string' || option.reasoningEffort.trim() === ''
            || option.reasoningEffort !== option.reasoningEffort.trim() || efforts.has(option.reasoningEffort)
            || typeof option.description !== 'string') throw new Error('Invalid Codex model catalog reasoning option')
          efforts.add(option.reasoningEffort)
          return { id: option.reasoningEffort, description: option.description }
        })
        if (!entry.hidden) models.push({ model: entry.model, label: entry.displayName,
          description: entry.description, isDefault: entry.isDefault,
          defaultReasoningEffort: entry.defaultReasoningEffort, reasoningEfforts })
      }
      const next = page.nextCursor
      if (next === null || next === undefined) break
      if (typeof next !== 'string' || next.length === 0 || cursors.has(next)
        || page.data.length === 0 || count >= spec.maxModels) throw new Error('Incomplete Codex model catalog')
      cursors.add(next)
      cursor = brandString<CodexModelCursor>(next)
    } while (true)
    lifetime.throwIfAborted()
    return models
  } finally {
    clearTimeout(timer)
    try { await disposeCodexChild(wire, child) }
    finally { stdout.off('data', onData) }
  }
}
