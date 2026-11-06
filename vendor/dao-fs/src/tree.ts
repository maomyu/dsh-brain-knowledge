/** Provider-shared validation and exact retained-tree comparison; no filesystem writes occur here. */
import { FsError } from './types.ts'
import type { FsTarget, FsTreeEntry } from './types.ts'
import type { FileSystem } from './index.ts'

/** Validate filesystem-derived relative paths and complete directory ancestry before acquiring write resources.
 * @param entries - bounded complete publication entries, retained unchanged by their caller.
 * @returns entries keyed by their normalized relative path.
 */
export function treeEntries(entries: readonly FsTreeEntry[]): ReadonlyMap<string, FsTreeEntry> {
  const result = new Map<string, FsTreeEntry>()
  for (const entry of entries) {
    if (entry.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f]/u.test(part))) {
      throw new FsError('Directory publication contains an unsafe relative path', 'FS_IO_ERROR')
    }
    if (result.has(entry.path)) throw new FsError('Directory publication contains a duplicate path', 'FS_IO_ERROR')
    result.set(entry.path, entry)
  }
  for (const entry of entries) {
    const components = entry.path.split('/')
    components.pop()
    while (components.length > 0) {
      if (result.get(components.join('/'))?.kind !== 'directory') {
        throw new FsError('Directory publication requires every parent directory entry', 'FS_IO_ERROR')
      }
      components.pop()
    }
  }
  return result
}

/** Compare retained regular files and directories without reading more file bytes than the proposed complete tree.
 * @param fs - filesystem provider that owns both destination identity and reads.
 * @param root - retained destination directory.
 * @param expected - validated complete entries.
 * @param signal - cancellation of the bounded comparison.
 * @returns true only when file bytes and all directory names match; links and extra entries differ.
 */
export async function sameTree(fs: FileSystem, root: FsTarget, expected: ReadonlyMap<string, FsTreeEntry>,
  signal?: AbortSignal): Promise<boolean> {
  let seen = 0
  async function walk(parent: FsTarget, prefix: string): Promise<boolean> {
    signal?.throwIfAborted()
    for (const child of await fs.listDir(parent, signal)) {
      const path = prefix ? `${prefix}/${child.name}` : child.name
      const entry = expected.get(path)
      if (entry === undefined || ++seen > expected.size) return false
      const info = await fs.lstat(child.name, { cwd: fs.processPath(parent) }, signal)
      if (info?.type !== entry.kind) return false
      if (entry.kind === 'directory') {
        if (!await walk(child.target, path)) return false
      } else {
        if (info.size !== undefined && info.size !== entry.content.byteLength) return false
        const bytes = await fs.readBytes(child.target, signal, entry.content.byteLength)
        if (bytes.byteLength !== entry.content.byteLength || bytes.some((value, index) => value !== entry.content[index])) return false
      }
    }
    return true
  }
  return await walk(root, '') && seen === expected.size
}
