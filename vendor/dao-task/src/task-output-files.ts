/** Retain bounded Git-observed paths; read original checkout bytes only after an explicit file selection. */
import { createHash } from 'node:crypto'
import { basename } from 'node:path/posix'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskOutputFile, ProjectTaskOutputFileContent, ProjectTaskOutputFileId,
  ProjectTaskOutputInventory } from './types.ts'
import { ProjectGit } from './project-git.ts'

/** Complete retained-list and selected-file read limits. */
export interface TaskOutputConfig {
  /** Maximum number of paths retained from one completed Task checkout. */
  readonly maxEntries: number
  /** Maximum serialized byte size of one retained file inventory. */
  readonly maxInventoryBytes: number
  /** Maximum UTF-8 byte length of each relative output path. */
  readonly maxPathBytes: number
  /** Maximum bytes returned for one explicitly selected source file. */
  readonly maxReadBytes: number
}

function outputFailure(reason: 'not-found' | 'unavailable' | 'stale' | 'unsafe' | 'too-large'): never {
  throw new RemoteError('project-task/output-file', `Task output file is ${reason}.`, { reason })
}

function pathSegments(path: string, maxBytes: number): string[] {
  if (Buffer.byteLength(path, 'utf8') > maxBytes || path.includes('�') || /[\\:\u0000-\u001f\u007f]/u.test(path)) outputFailure('unsafe')
  const parts = path.split('/')
  if (!parts.every(part => part !== '' && part !== '.' && part !== '..') || parts[0] === '.git' || parts[0] === '.dsh') {
    outputFailure('unsafe')
  }
  return parts
}

function outputId(taskId: string, path: string): ProjectTaskOutputFileId {
  return brandString<ProjectTaskOutputFileId>(createHash('sha256').update(JSON.stringify([taskId, path])).digest('hex'))
}

/** Task-owned source references, never copied publication or self-reported affected-file names. */
export class TaskOutputFiles {
  /** @param ctx - composed filesystem matching the project checkout.
   * @param git - retained Git worktree identity verifier.
   * @param config - complete listing and selected-read bounds.
   */
  constructor(private readonly ctx: Context, private readonly git: ProjectGit, private readonly config: TaskOutputConfig) {}

  /** Observe one newly admitted coding Task after its successful execution settles.
   * @param record - durable Task and worktree reservation.
   * @param guard - current project and task owner check.
   * @param signal - controller lifetime.
   * @returns bounded metadata only; ignored files and over-limit tails are not guessed.
   */
  async collect(record: ProjectTaskRecord, guard: () => void, signal: AbortSignal): Promise<ProjectTaskOutputInventory> {
    if (record.proposal.isolation !== 'worktree' || record.preparation === undefined) {
      return { status: 'unavailable', observedAt: null, files: [], truncated: false, reason: 'unsupported-isolation' }
    }
    const worker = await this.git.verifyTaskWorktree(record.workspaceId, record.workspacePath, record.proposal.id,
      record.preparation, guard, signal)
    const changes = await this.git.taskOutputPaths(record.workspaceId, record.workspacePath, record.proposal.id,
      record.preparation, guard, signal)
    const files: ProjectTaskOutputFile[] = []
    let truncated = false
    for (const change of changes) {
      signal.throwIfAborted(); guard()
      if (files.length >= this.config.maxEntries) { truncated = true; break }
      let parts: string[]
      try { parts = pathSegments(change.path, this.config.maxPathBytes) }
      catch { truncated = true; continue /* Git paths outside the supported file vocabulary are not readable. */ }
      const located = change.change === 'deleted' ? undefined : await this.locate(worker, parts, signal)
      const info = located?.info
      const file: ProjectTaskOutputFile = {
        id: outputId(record.proposal.id, change.path), path: change.path, change: change.change,
        bytes: info?.type === 'file' ? info.size ?? null : null,
        version: info?.type === 'file' ? info.version : null,
        readable: info?.type === 'file',
      }
      if (Buffer.byteLength(JSON.stringify({ files: [...files, file], truncated }), 'utf8') > this.config.maxInventoryBytes) {
        truncated = true; break
      }
      files.push(file)
    }
    guard()
    await this.git.verifyTaskWorktree(record.workspaceId, record.workspacePath, record.proposal.id,
      record.preparation, guard, signal)
    return { status: 'available', observedAt: Date.now(), files, truncated }
  }

  /** Read only the exact retained version from the Task's still-owned checkout.
   * @param record - Task selected through its project and opaque identity.
   * @param id - one durable file identity; callers never provide an absolute or relative path.
   * @param guard - current project and source membership check, repeated around I/O.
   * @param signal - selected-read lifetime.
   * @returns bounded complete bytes, or a stale/unavailable error without substituting newer content.
   */
  async read(record: ProjectTaskRecord, id: ProjectTaskOutputFileId, guard: () => void,
    signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    const file = record.outputInventory?.files.find(item => item.id === id)
    if (file === undefined) outputFailure('not-found')
    return this.readObserved(record, file, guard, signal)
  }

  /** Read an exact provisional observation after its active execution is checked by the caller.
   * @param record - original Task with its retained worktree reservation.
   * @param file - Host-observed file and version, never a client-supplied path.
   * @param guard - active execution and source ownership check repeated around I/O.
   * @param signal - selected-read lifetime.
   * @returns complete bytes only when the observed file stays unchanged.
   */
  async readObserved(record: ProjectTaskRecord, file: ProjectTaskOutputFile, guard: () => void,
    signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    if (file.id !== outputId(record.proposal.id, file.path)) outputFailure('unsafe')
    if (!file.readable || file.version === null) outputFailure('unavailable')
    const checkout = record.preparation
    if (checkout === undefined || record.proposal.isolation !== 'worktree') outputFailure('unavailable')
    guard()
    const worker = await this.git.verifyTaskWorktree(record.workspaceId, record.workspacePath, record.proposal.id,
      checkout, guard, signal)
    const located = await this.locate(worker, pathSegments(file.path, this.config.maxPathBytes), signal)
    if (located === undefined || located.info.type !== 'file'
      || located.info.version !== file.version || (located.info.size ?? null) !== file.bytes) outputFailure('stale')
    if (located.info.size !== undefined && located.info.size > this.config.maxReadBytes) outputFailure('too-large')
    guard()
    let bytes: Uint8Array
    try { bytes = await this.ctx.fs.readBytes(located.target, signal, this.config.maxReadBytes) }
    catch (error) {
      signal.throwIfAborted()
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_TOO_LARGE') outputFailure('too-large')
      throw error
    }
    const after = await this.ctx.fs.stat(located.target, signal)
    guard()
    if (after === undefined || after.type !== 'file' || after.version !== file.version
      || (after.size ?? null) !== file.bytes) outputFailure('stale')
    await this.git.verifyTaskWorktree(record.workspaceId, record.workspacePath, record.proposal.id,
      checkout, guard, signal)
    return { id: file.id, fileName: basename(file.path), version: after.version,
      dataBase64: Buffer.from(bytes).toString('base64') }
  }

  private async locate(worker: string, parts: readonly string[], signal: AbortSignal): Promise<{
    target: FsTarget
    info: FsPathInfo
  } | undefined> {
    const mapped = this.ctx.fs.processPathFromHostPath(worker)
    if (mapped === undefined) outputFailure('unsafe')
    const root = await this.ctx.fs.resolve(mapped, { signal })
    if (this.ctx.fs.processPath(root) !== worker) outputFailure('unsafe')
    let parent = root
    let result: { target: FsTarget; info: FsPathInfo } | undefined
    for (const [index, part] of parts.entries()) {
      const cwd = this.ctx.fs.processPath(parent)
      const info = await this.ctx.fs.lstat(part, { cwd }, signal)
      if (info === undefined) return undefined
      if (info.type === 'symlink' || info.type === 'other'
        || (index < parts.length - 1 && info.type !== 'directory')) outputFailure('unsafe')
      const target = await this.ctx.fs.resolve(part, { cwd, signal })
      if (!this.ctx.fs.contains(root, target)) outputFailure('unsafe')
      parent = target
      result = { target, info }
    }
    return result
  }
}
