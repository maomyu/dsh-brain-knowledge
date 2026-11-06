/** Bounded source staging for an explicitly requested artifact-site run; preparation executes no project code. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/** Validated deployment bounds for the complete site source, including files not served as pages. */
export interface SiteSnapshotLimits {
  /** Maximum directory entries examined, including excluded names. */
  readonly maxEntries: number
  /** Maximum source-directory depth below the artifact root. */
  readonly maxDepth: number
  /** Inclusive captured byte limit for one source file. */
  readonly maxFileBytes: number
  /** Inclusive captured byte limit across all source files. */
  readonly maxTotalBytes: number
}

/** One source file retained in a private site snapshot. */
export interface SiteSnapshotFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: boolean
}

/** A private copy, owned until its execution and readers have stopped. */
export interface SiteSnapshot {
  readonly root: string
  readonly source: string
  readonly files: readonly SiteSnapshotFile[]
  readonly directories: readonly string[]
  readonly totalBytes: number
  readonly digest: string
  /** Read the retained source bytes and reject changes to the staged files.
   * @param signal - cancellation of this read; the owner joins reads before disposal or project execution.
   * @returns a complete path-to-bytes map matching the preparation digest.
   */
  readFiles(signal: AbortSignal): Promise<ReadonlyMap<string, Uint8Array>>
  /** Remove only the originally allocated temporary directory.
   * @returns after removal; a replaced directory is refused and remains untouched. Failed cleanup can be retried.
   */
  dispose(): Promise<void>
}

/** Site preparation failures retain their category without exposing file contents. */
export class SiteSnapshotError extends Error {
  /**
   * @param reason - preparation failure category.
   * @param message - explanation without source contents.
   */
  constructor(readonly reason: 'unsafe-source' | 'changed-source' | 'limit' | 'empty', message: string) {
    super(message)
    this.name = 'SiteSnapshotError'
  }
}

function excluded(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === '.DS_Store'
    || name === '.npmrc' || name === '.yarnrc' || name === '.yarnrc.yml'
    || name === '.env' || name.startsWith('.env.')
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

async function readBoundedFile(path: string, info: Stats, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!info.isFile() || info.isSymbolicLink()) throw new SiteSnapshotError('unsafe-source', 'Site source is not a regular file')
  if (info.size > limit) throw new SiteSnapshotError('limit', 'Site source exceeds its byte limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size
      || before.mtimeMs !== info.mtimeMs) throw new SiteSnapshotError('changed-source', 'Site source changed during preparation')
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - size + 1))
      const { bytesRead } = await handle.read(buffer)
      if (bytesRead === 0) break
      size += bytesRead
      if (size > limit) throw new SiteSnapshotError('limit', 'Site source exceeds its byte limit')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || size !== before.size) {
      throw new SiteSnapshotError('changed-source', 'Site source changed during preparation')
    }
    return Buffer.concat(chunks, size)
  } finally { await handle.close() }
}

/** Copy an admitted artifact directory without following links or executing its package scripts.
 * @param source - absolute artifact directory; the caller owns project membership and artifact admission.
 * @param temporaryRoot - existing local directory in which this operation atomically allocates a private child.
 * @param limits - inclusive entry, depth and byte limits, validated by the owning plugin configuration.
 * @param signal - cancels preparation; rejected operations remove their own partial copy.
 * @returns the complete staged files, content digest and awaited cleanup capability.
 * Path checks are not descriptor-level isolation against concurrent hostile parent-directory replacement.
 */
export async function prepareSiteSnapshot(source: string, temporaryRoot: string,
  limits: SiteSnapshotLimits, signal: AbortSignal): Promise<SiteSnapshot> {
  signal.throwIfAborted()
  if (!isAbsolute(source)) throw new SiteSnapshotError('unsafe-source', 'Site source must be an absolute admitted directory')
  const initial = await lstat(source)
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new SiteSnapshotError('unsafe-source', 'Site source must be a real directory')
  const original = await realpath(source)
  const root = await mkdtemp(join(await realpath(temporaryRoot), 'dsh-site-preview-'))
  const allocated = await lstat(root)
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    let current: Stats
    try { current = await lstat(root) } catch (error) {
      // An already-removed owned directory needs no further cleanup; other failures remain visible.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== allocated.dev || current.ino !== allocated.ino) {
      throw new SiteSnapshotError('unsafe-source', 'Site temporary directory was replaced; refusing cleanup')
    }
    await rm(root, { recursive: true })
  })().catch((error: unknown) => {
    disposal = undefined
    throw error
  })
  const files: SiteSnapshotFile[] = []
  const directories: string[] = []
  let totalBytes = 0
  let entries = 0
  try {
    await chmod(root, 0o700)
    async function walk(directory: string, path: string, depth: number): Promise<void> {
      signal.throwIfAborted()
      if (depth > limits.maxDepth) throw new SiteSnapshotError('limit', 'Site source exceeds the directory depth limit')
      if (!contained(original, await realpath(directory))) throw new SiteSnapshotError('unsafe-source', 'Site source leaves its admitted directory')
      for await (const entry of await opendir(directory)) {
        signal.throwIfAborted()
        if (++entries > limits.maxEntries) throw new SiteSnapshotError('limit', 'Site source exceeds the entry limit')
        if (excluded(entry.name)) continue
        if (/[\\:\u0000-\u001f\u007f]/u.test(entry.name)) throw new SiteSnapshotError('unsafe-source', 'Site source contains an unsupported filename')
        const child = join(directory, entry.name)
        const destination = path === '' ? entry.name : `${path}/${entry.name}`
        const info = await lstat(child)
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new SiteSnapshotError('unsafe-source', 'Site source contains a link or unsupported file')
        }
        if (info.isDirectory()) {
          directories.push(destination)
          await mkdir(join(root, destination), { mode: 0o700 })
          await walk(child, destination, depth + 1)
          continue
        }
        if (!contained(original, await realpath(child))) throw new SiteSnapshotError('unsafe-source', 'Site file leaves its admitted directory')
        const remaining = Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes)
        const content = await readBoundedFile(child, info, remaining, signal)
        signal.throwIfAborted()
        await writeFile(join(root, destination), content, { flag: 'wx', mode: 0o600 | (info.mode & 0o100) })
        totalBytes += content.length
        files.push({ path: destination, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
          executable: (info.mode & 0o100) !== 0 })
      }
    }
    await walk(original, '', 0)
    signal.throwIfAborted()
    if (files.length === 0) throw new SiteSnapshotError('empty', 'Site source has no previewable files')
    const final = await lstat(source)
    if (!final.isDirectory() || final.dev !== initial.dev || final.ino !== initial.ino) {
      throw new SiteSnapshotError('changed-source', 'Site source was replaced during preparation')
    }
    files.sort((left, right) => {
      if (left.path < right.path) return -1
      /* v8 ignore else -- Exclusive stage creation prevents two retained entries with the same path. */
      if (left.path > right.path) return 1
      /* v8 ignore next -- Retained paths follow exclusive wx creation in this module's private staging tree. */
      return 0
    })
    const readFiles = async (readSignal: AbortSignal): Promise<ReadonlyMap<string, Uint8Array>> => {
      readSignal.throwIfAborted()
      const current = await lstat(root)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== allocated.dev || current.ino !== allocated.ino) {
        throw new SiteSnapshotError('unsafe-source', 'Site temporary directory was replaced')
      }
      const result = new Map<string, Uint8Array>()
      for (const file of files) {
        readSignal.throwIfAborted()
        const path = join(root, file.path)
        if (!contained(root, await realpath(path))) throw new SiteSnapshotError('unsafe-source', 'Site staged file leaves its directory')
        const content = await readBoundedFile(path, await lstat(path), file.bytes, readSignal)
        if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
          throw new SiteSnapshotError('changed-source', 'Site staged file changed after preparation')
        }
        result.set(file.path, content)
      }
      return result
    }
    return { root, source: original, files, directories: directories.sort(), totalBytes, readFiles,
      digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), dispose }
  } catch (error) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Site preparation and cleanup failed') }
    throw error
  }
}
