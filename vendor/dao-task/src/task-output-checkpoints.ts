/** Shared provisional metadata and passive reads for acknowledged complete private-output files. */
import { createHash } from 'node:crypto'
import { basename } from 'node:path/posix'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TaskOutputConfig } from './task-output-files.ts'
import type { ProjectTaskId, ProjectTaskLiveOutput, ProjectTaskOutputFile, ProjectTaskOutputFileContent,
  ProjectTaskOutputFileId } from './types.ts'

/** Complete acknowledged bytes and their exact observed version; owners enforce write and allocation limits. */
export interface TaskOutputCheckpoint {
  readonly file: ProjectTaskOutputFile & { readonly version: string
    readonly bytes: number }
  readonly bytes: Buffer
}

function unavailable(reason: 'not-found' | 'stale' | 'too-large'): never {
  throw new RemoteError('project-task/output-file', `Task output file is ${reason}.`, { reason })
}

/** Retain complete bytes only after the caller's write and authorization checks succeed.
 * @param taskId - immutable Task owning this file.
 * @param files - this execution's acknowledged checkpoints.
 * @param path - owner-validated relative output filename.
 * @param version - actual filesystem or durable Host-checkpoint version.
 * @param bytes - complete acknowledged bytes, copied before publication.
 * @param maxReadBytes - deployment's selected-read allowance.
 * @param revised - whether the writer replaced an earlier acknowledged version.
 */
export function retainTaskOutputCheckpoint(taskId: ProjectTaskId, files: Map<string, TaskOutputCheckpoint>, path: string,
  version: string, bytes: Buffer, maxReadBytes: number, revised = files.has(path)): void {
  const id = brandString<ProjectTaskOutputFileId>(createHash('sha256').update(JSON.stringify([taskId, path])).digest('hex'))
  files.set(path, { file: { id, path, change: revised ? 'modified' : 'added', bytes: bytes.byteLength, version,
    readable: bytes.byteLength <= maxReadBytes }, bytes: Buffer.from(bytes) })
}

/** Observe bounded metadata only for acknowledged checkpoints still accepted by their current owner.
 * @param files - execution-owned complete-file checkpoints.
 * @param config - whole inventory, path and selected-read limits.
 * @param verify - asynchronous allocation and file-version check; false withdraws a changed file.
 * @param guard - synchronous current execution and source-authorization check.
 * @param signal - observation lifetime.
 * @returns bounded provisional metadata, never private paths or byte bodies.
 */
export async function observeTaskOutputCheckpoints(files: Map<string, TaskOutputCheckpoint>, config: TaskOutputConfig,
  verify: (path: string, checkpoint: TaskOutputCheckpoint) => Promise<boolean>, guard: () => void,
  signal: AbortSignal): Promise<Pick<ProjectTaskLiveOutput, 'observedAt' | 'files' | 'truncated'>> {
  const observed: ProjectTaskOutputFile[] = []
  let truncated = false
  for (const [path, checkpoint] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    signal.throwIfAborted(); guard()
    if (observed.length >= config.maxEntries) { truncated = true; break }
    if (Buffer.byteLength(path, 'utf8') > config.maxPathBytes) { truncated = true; continue }
    if (!await verify(path, checkpoint)) { if (files.get(path) === checkpoint) files.delete(path); continue }
    guard(); signal.throwIfAborted()
    if (files.get(path) !== checkpoint) continue
    if (Buffer.byteLength(JSON.stringify({ files: [...observed, checkpoint.file], truncated }), 'utf8') > config.maxInventoryBytes) {
      truncated = true; break
    }
    observed.push(checkpoint.file)
  }
  guard(); signal.throwIfAborted()
  return { observedAt: Date.now(), files: observed, truncated }
}

/** Read complete checkpoint bytes while the owner and exact observed version remain current.
 * @param files - execution-owned acknowledged checkpoints.
 * @param id - opaque identity from this execution's live metadata.
 * @param version - exact version selected by the user.
 * @param verify - allocation and version validation around asynchronous I/O.
 * @param guard - current execution and source authorization.
 * @param signal - selected-read lifetime.
 * @returns complete bytes or an explicit stale, missing or oversized refusal.
 */
export async function readTaskOutputCheckpoint(files: Map<string, TaskOutputCheckpoint>, id: ProjectTaskOutputFileId,
  version: string, verify: (path: string, checkpoint: TaskOutputCheckpoint) => Promise<boolean>, guard: () => void,
  signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
  signal.throwIfAborted(); guard()
  const known = [...files.entries()].find(([, item]) => item.file.id === id)
  if (known === undefined) unavailable('not-found')
  const [path, checkpoint] = known
  if (checkpoint.file.version !== version) unavailable('stale')
  if (!checkpoint.file.readable) unavailable('too-large')
  if (!await verify(path, checkpoint)) unavailable('stale')
  signal.throwIfAborted(); guard()
  if (files.get(path) !== checkpoint) unavailable('stale')
  return { id, fileName: basename(path), version, dataBase64: checkpoint.bytes.toString('base64') }
}
