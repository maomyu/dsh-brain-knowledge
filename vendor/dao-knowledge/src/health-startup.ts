/** Metadata-only eligibility for the one-shot startup assessment. */
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { KnowledgeLocation } from './types.ts'

/** Deployment-owned startup delay and relevant-file traversal limits. */
export interface HealthStartupPolicy {
  /** Delay from the first Client registration; the first remaining Client supplies context at expiry. */
  readonly delayMs: number
  /** Minimum age of an existing report before file changes can cause another assessment. */
  readonly minReportAgeMs: number
  /** Maximum unique metadata candidates examined across overlapping scan roots. */
  readonly maxEntries: number
  /** Maximum directory depth below each scan root, whose depth is zero. */
  readonly maxDepth: number
  /** Case-insensitive filename extensions, including the leading dot, that can invalidate an old report. */
  readonly extensions: string[]
  /** Exact directory basenames omitted from recursive scanning. */
  readonly excludedDirectories: string[]
}

async function readable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  try { return await operation() } catch (error) {
    signal.throwIfAborted()
    if (typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('FS_')) return undefined
    throw error
  }
}

/** Decide whether an absent, undated or old report needs a startup assessment; file contents are never read.
 * @param ctx - filesystem provider in the project's execution world.
 * @param location - captured project and Brain directories.
 * @param checkedAt - newest parsed report timestamp, absent when there is no report.
 * @param now - current Unix time in milliseconds.
 * @param policy - age threshold, relevant extensions and traversal limits.
 * @param signal - cancels every metadata operation.
 * @returns true without a usable report, or when an old report predates a relevant regular file.
 * @throws when the candidate bound is exhausted or a provider cannot supply modification times.
 */
export async function startupHealthDue(ctx: Context, location: KnowledgeLocation, checkedAt: string | undefined,
  now: number, policy: HealthStartupPolicy, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  const checked = checkedAt === undefined ? NaN : Date.parse(checkedAt)
  if (!Number.isFinite(checked)) return true
  if (now - checked < policy.minReportAgeMs) return false
  const extensions = new Set(policy.extensions.map(value => value.toLowerCase()))
  const excluded = new Set(policy.excludedDirectories)
  const examined = new Set<string>()
  const brain = await readable(() => ctx.fs.lstat(location.path, {}, signal), signal)
  const roots = new Set(brain?.type === 'directory'
    ? [join(location.path, 'pages'), location.path, location.projectPath] : [location.projectPath])
  for (const path of roots) {
    const info = await readable(() => ctx.fs.lstat(path, {}, signal), signal)
    if (info?.type !== 'directory') continue
    const root = await readable(() => ctx.fs.resolve(path, { signal }), signal)
    if (root === undefined) continue
    const visit = async (directory: string, depth: number): Promise<boolean> => {
      signal.throwIfAborted()
      if (depth > policy.maxDepth) return false
      const target = await readable(() => ctx.fs.resolve(directory, { cwd: path, signal }), signal)
      if (target === undefined || !ctx.fs.contains(root, target)) return false
      const entries = await readable(() => ctx.fs.listDir(target, signal), signal)
      if (entries === undefined) return false
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        signal.throwIfAborted()
        const child = directory === '.' ? entry.name : `${directory}/${entry.name}`
        examined.add(join(path, child))
        if (examined.size > policy.maxEntries) throw new Error('Startup health scan exceeds maxEntries')
        const info = await readable(() => ctx.fs.lstat(child, { cwd: path }, signal), signal)
        if (info === undefined || info.type === 'symlink' || info.type === 'other') continue
        if (info.type === 'directory') {
          if (!excluded.has(entry.name) && await visit(child, depth + 1)) return true
        } else if (extensions.has(extname(entry.name).toLowerCase())) {
          if (info.modifiedAt === undefined) throw new Error('Startup health scan requires filesystem modification times')
          if (info.modifiedAt > checked) return true
        }
      }
      return false
    }
    if (await visit('.', 0)) return true
  }
  return false
}
