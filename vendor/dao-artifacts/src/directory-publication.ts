/** Documentation preparation admits source bytes; the composed filesystem owns every project write. */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileSystem, FsTreeEntry } from '@deepseek-ai/dsh-fs'
import { prepareSiteSnapshot, type SiteSnapshotLimits } from './site-snapshot.ts'

/** Complete source-tree limits and cooperative publication-lock deadline. */
export interface DirectoryPublicationConfig {
  /** Maximum examined entries, including excluded source names. */
  readonly maxEntries: number
  /** Maximum source-directory depth below the documentation root. */
  readonly maxDepth: number
  /** Inclusive total copied file bytes across the complete directory. */
  readonly maxTotalBytes: number
  /** Maximum cooperative publication-lock wait in milliseconds. */
  readonly lockWaitMs: number
}

/** Host source and project identity retained while preparing a publication. */
export interface DirectoryPublicationTarget {
  readonly projectRoot: string
  readonly segments: readonly string[]
  readonly source: string
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
}

/** Prepare complete documentation bytes and publish through the filesystem's write policy.
 * @param fs - composed filesystem with admitted Host source and project mappings.
 * @param target - task-owned quiescent source and authorized project-relative output.
 * @param limits - inclusive complete-tree limits and cooperative lock deadline.
 * @param admit - rechecks original source-conversation and project authority.
 * @param signal - cancellation before commit; committed output is retained.
 * @param cleanupFailed - reports private-source cleanup failure after successful publication.
 * @returns after complete publication or identical reuse and joined private-source cleanup.
 */
export async function publishDocumentationDirectory(fs: FileSystem, target: DirectoryPublicationTarget,
  limits: SiteSnapshotLimits & { readonly lockWaitMs: number }, admit: () => Promise<void>, signal: AbortSignal,
  cleanupFailed: (error: unknown) => void): Promise<void> {
  await admit()
  if (target.segments.length < 3 || target.segments.some(part => !part || part === '.' || part === '..'
    || /[\\/:\u0000-\u001f\u007f]/u.test(part))) throw new Error('Documentation publication requires safe artifact path components')
  const root = await fs.resolve(target.projectRoot, { signal })
  const locate = async () => {
    await admit()
    signal.throwIfAborted()
    const current = await fs.resolve(target.projectRoot, { signal })
    if (current.targetKey !== root.targetKey) throw new Error('Documentation project was replaced')
    let destination = current
    for (const segment of target.segments) {
      const cwd = fs.processPath(destination)
      const info = await fs.lstat(segment, { cwd }, signal)
      if (info !== undefined && info.type !== 'directory') throw new Error('Documentation publication requires real directories')
      destination = await fs.resolve(segment, { cwd, signal })
      if (!fs.contains(root, destination)) throw new Error('Documentation output leaves its project')
    }
    await admit()
    return destination
  }
  const destination = await locate()
  const source = await realpath(target.source)
  const output = join(target.projectRoot, ...target.segments)
  const temporaryRoot = await realpath(tmpdir())
  if (contains(source, output) || contains(output, source) || contains(source, temporaryRoot)) {
    throw new Error('Documentation source, output and private staging must not overlap')
  }
  const snapshot = await prepareSiteSnapshot(source, temporaryRoot, limits, signal)
  let committed = false
  let failure: unknown
  try {
    const bytes = await snapshot.readFiles(signal)
    const entries: FsTreeEntry[] = snapshot.directories.map(path => ({ kind: 'directory', path }))
    const executable = new Set(snapshot.files.filter(file => file.executable).map(file => file.path))
    for (const [path, content] of bytes) {
      entries.push({ kind: 'file', path, content, executable: executable.has(path) })
    }
    await fs.publishTree(destination, entries, {
      lockWaitMs: limits.lockWaitMs,
      beforeCommit: async () => {
        if ((await locate()).targetKey !== destination.targetKey) throw new Error('Documentation destination was replaced')
      },
    }, signal, { mode: 'workspace-write', workspaceRoot: fs.processPath(root) })
    committed = true
  } catch (error) { failure = error; throw error } finally {
    try { await snapshot.dispose() } catch (error) {
      if (committed) cleanupFailed(error)
      else throw new AggregateError([failure, error], 'Documentation preparation and cleanup failed')
    }
  }
}
