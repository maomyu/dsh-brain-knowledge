/** Read every byte of one retained documentation tree without executing or changing its files. */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactTaskDirectoryFile } from './types.ts'

/** Inclusive bounds for one complete Host-local directory response. */
export interface TaskDirectoryReadLimits {
  /** Maximum files and directories visited, excluding the root. */
  readonly maxEntries: number
  /** Maximum regular files returned. */
  readonly maxFiles: number
  /** Maximum nested directory depth below the root. */
  readonly maxDepth: number
  /** Inclusive raw byte limit for each file. */
  readonly maxFileBytes: number
  /** Inclusive sum of raw bytes across all files. */
  readonly maxTotalBytes: number
  /** Inclusive UTF-8 byte limit for the complete serialized result object. */
  readonly maxResponseBytes: number
}

/** Failure category before a directory can be represented as complete evidence. */
export class TaskDirectoryReadError extends Error {
  /** Why the Host cannot return a complete tree. */
  readonly reason: 'unsafe-path' | 'invalid' | 'too-large'
  /**
   * @param reason - unsafe entry, changed/inaccessible tree, or exceeded bound.
   * @param message - caller-visible explanation without source bytes.
   */
  constructor(reason: 'unsafe-path' | 'invalid' | 'too-large', message: string) {
    super(message)
    this.name = 'TaskDirectoryReadError'
    this.reason = reason
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function admittedName(name: string): boolean {
  const lower = name.toLowerCase()
  return name !== '' && name !== '.' && name !== '..' && !/[\\/:\u0000-\u001f\u007f]/u.test(name)
    && lower !== '.git' && lower !== 'node_modules' && lower !== '.ds_store'
    && lower !== '.env' && !lower.startsWith('.env.') && lower !== '.npmrc'
    && lower !== '.yarnrc' && lower !== '.yarnrc.yml'
}

async function names(directory: string): Promise<string[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const raw = await readdir(directory, { encoding: 'buffer' })
  let entries: string[]
  try { entries = raw.map(name => decoder.decode(name)) } catch {
    // Fatal decoding rejects an invalid filename before it can enter the evidence manifest.
    throw new TaskDirectoryReadError('unsafe-path', 'Documentation tree contains an invalid UTF-8 name')
  }
  entries.sort()
  if (new Set(entries).size !== entries.length || entries.some(name => !admittedName(name))) {
    throw new TaskDirectoryReadError('unsafe-path', 'Documentation tree contains an unsafe or excluded name')
  }
  return entries
}

async function regularFile(path: string, before: BigIntStats, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new TaskDirectoryReadError('unsafe-path', 'Documentation tree contains a link or unsupported file')
  }
  if (before.size > BigInt(limit)) throw new TaskDirectoryReadError('too-large', 'Documentation tree exceeds its byte limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1n) {
      throw new TaskDirectoryReadError('invalid', 'Documentation file changed before reading')
    }
    const content = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < content.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(content, offset, content.length - offset)
      if (bytesRead === 0) throw new TaskDirectoryReadError('invalid', 'Documentation file ended during reading')
      offset += bytesRead
    }
    const tail = Buffer.alloc(1)
    if ((await handle.read(tail)).bytesRead !== 0) {
      throw new TaskDirectoryReadError('invalid', 'Documentation file grew during reading')
    }
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(opened, after) || !sameIdentity(after, await lstat(path, { bigint: true }))) {
      throw new TaskDirectoryReadError('invalid', 'Documentation file changed during reading')
    }
    return content
  } finally { await handle.close() }
}

/** Capture a complete stable tree, including empty directories, within configured traversal and raw-byte budgets.
 * @param root - already admitted Host directory owned by a retained successful Task.
 * @param limits - validated file, entry, depth and raw-byte bounds; the owner checks serialized response bytes.
 * @param signal - cancels scans and reads without returning partial evidence.
 * @returns sorted paths, complete raw file bytes, and a path/content digest independent of process lifetime.
 * Concurrent hostile parent replacement is not descriptor-level isolated; observed links and changes are rejected.
 */
export async function readTaskDirectoryTree(root: string, limits: TaskDirectoryReadLimits, signal: AbortSignal): Promise<{
  readonly directories: readonly string[]
  readonly files: readonly ArtifactTaskDirectoryFile[]
  readonly totalBytes: number
  readonly digest: string
}> {
  signal.throwIfAborted()
  const directories: string[] = []
  const files: ArtifactTaskDirectoryFile[] = []
  const observedDirectories: { path: string; info: BigIntStats; entries: readonly string[] }[] = []
  const observedFiles: { path: string; info: BigIntStats }[] = []
  let entries = 0
  let totalBytes = 0
  const walk = async (path: string, relative: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (depth > limits.maxDepth) throw new TaskDirectoryReadError('too-large', 'Documentation tree exceeds its depth limit')
    const before = await lstat(path, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new TaskDirectoryReadError('unsafe-path', 'Documentation tree requires real directories')
    }
    const children = await names(path)
    observedDirectories.push({ path, info: before, entries: children })
    if (relative) directories.push(relative)
    for (const name of children) {
      signal.throwIfAborted()
      if (++entries > limits.maxEntries) throw new TaskDirectoryReadError('too-large', 'Documentation tree exceeds its entry limit')
      const child = join(path, name)
      const childPath = relative ? `${relative}/${name}` : name
      const info = await lstat(child, { bigint: true })
      if (info.isSymbolicLink()) throw new TaskDirectoryReadError('unsafe-path', 'Documentation tree contains a symbolic link')
      if (info.isDirectory()) {
        await walk(child, childPath, depth + 1)
      } else {
        if (files.length >= limits.maxFiles) throw new TaskDirectoryReadError('too-large', 'Documentation tree exceeds its file limit')
        const content = await regularFile(child, info, Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes), signal)
        totalBytes += content.byteLength
        files.push({ path: childPath, bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'), dataBase64: content.toString('base64') })
        observedFiles.push({ path: child, info })
      }
    }
    if (!sameIdentity(before, await lstat(path, { bigint: true }))
      || JSON.stringify(children) !== JSON.stringify(await names(path))) {
      throw new TaskDirectoryReadError('invalid', 'Documentation directory changed during reading')
    }
  }
  try {
    await walk(root, '', 0)
    if (files.length === 0) throw new TaskDirectoryReadError('invalid', 'Documentation tree has no files')
    for (const directory of observedDirectories) {
      signal.throwIfAborted()
      if (!sameIdentity(directory.info, await lstat(directory.path, { bigint: true }))
        || JSON.stringify(directory.entries) !== JSON.stringify(await names(directory.path))) {
        throw new TaskDirectoryReadError('invalid', 'Documentation directory changed during reading')
      }
    }
    for (const file of observedFiles) {
      signal.throwIfAborted()
      if (!sameIdentity(file.info, await lstat(file.path, { bigint: true }))) {
        throw new TaskDirectoryReadError('invalid', 'Documentation file changed during reading')
      }
    }
    directories.sort()
    files.sort((left, right) => {
      if (left.path < right.path) return -1
      /* v8 ignore else -- Checked unique child names produce one file for each relative path. */
      if (left.path > right.path) return 1
      /* v8 ignore next -- Each admitted path is visited once in this module's private traversal. */
      return 0
    })
    const digest = createHash('sha256').update(JSON.stringify({ directories,
      files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) })).digest('hex')
    return { directories, files, totalBytes, digest }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TaskDirectoryReadError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(error.code)) {
      throw new TaskDirectoryReadError('invalid', 'Documentation tree could not be read completely')
    }
    throw error
  }
}
