/** Non-overwriting local scaffolding shared by conversation preparation and explicit Brain selection. */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { brainScaffold } from './scaffold.ts'
import { knowledgeWritePolicy } from './write-policy.ts'

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** Inspect a local entry without following its final link; only absence becomes undefined.
 * @param path - explicit Host path previously authorized by the caller.
 * @returns local metadata, or undefined for an absent entry.
 */
export async function inspectBrainPath(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Create only validated directory components beneath one canonical existing Host parent.
 * @param parent - registered canonical project path or selected Brain parent.
 * @param parts - validated relative directory components, never empty or traversal names.
 * @param signal - cancels before the next directory admission.
 * @param authorize - rechecks ownership before each native operation.
 * @returns when every component exists as a real directory, without creating outline files.
 */
export async function ensureBrainDirectories(parent: string, parts: readonly string[], signal: AbortSignal,
  authorize: () => void | Promise<void>): Promise<void> {
  let path = parent
  for (const segment of parts) {
    await authorize()
    signal.throwIfAborted()
    if (await realpath(path) !== path) throw new Error('Brain parent changed before directory creation')
    path = join(path, segment)
    try { await mkdir(path, { mode: 0o700 }) } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
    }
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Brain directory must not contain links or files')
  }
}

/** Fill missing Brain outlines without overwriting existing regular files.
 * @param fs - Host-shared filesystem used for exclusive file publication.
 * @param parent - canonical existing Host directory containing the permitted destination.
 * @param parts - validated relative directory components below parent.
 * @param updatedAt - retained attempt timestamp shared by every new outline.
 * @param signal - cancels before the next publication admission.
 * @param authorize - revalidates ownership before each native operation.
 * @returns after all outline and pages-directory operations settle.
 * @throws for links, non-regular outlines, unavailable Host mapping, changed paths or write failures; partial files remain.
 */
export async function ensureLocalBrain(fs: FileSystem, parent: string, parts: readonly string[], updatedAt: string,
  signal: AbortSignal, authorize: () => Promise<void>): Promise<void> {
  await authorize()
  const processRoot = fs.processPathFromHostPath(parent)
  if (processRoot === undefined) throw new Error('Brain initialization requires a Host-shared filesystem')
  const root = await fs.resolve(processRoot, { signal })
  const brain = join(parent, ...parts)
  await ensureBrainDirectories(parent, parts, signal, authorize)
  for (const file of brainScaffold(updatedAt)) {
    await authorize()
    if (await realpath(brain) !== brain) throw new Error('Brain directory changed before file creation')
    const hostPath = join(brain, file.path)
    const existing = await inspectBrainPath(hostPath)
    if (existing !== undefined) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Brain outline must be a regular file')
      continue
    }
    const processPath = fs.processPathFromHostPath(hostPath)
    if (processPath === undefined) throw new Error('Brain outline is not shared with the Host')
    const target = await fs.resolve(processPath, { signal })
    if (!fs.contains(root, target)) throw new Error('Brain outline escaped the permitted directory')
    await authorize()
    try { await fs.writeText(target, file.text, { kind: 'createIfAbsent' }, signal, knowledgeWritePolicy(fs, brain)) } catch (error) {
      // A competing writer may win publication; its regular file remains authoritative.
      if (!isCode(error, 'FS_NOT_OBSERVED')) throw error
      const winner = await inspectBrainPath(hostPath)
      if (winner === undefined || !winner.isFile() || winner.isSymbolicLink()) throw error
    }
  }
  await ensureBrainDirectories(parent, [...parts, 'pages'], signal, authorize)
  await authorize()
}
