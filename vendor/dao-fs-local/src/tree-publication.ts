/** Local whole-tree writes keep preparation hidden and commit under a cooperative file lock. */
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { FsError, sameTree, treeEntries } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget, FsTreeEntry, FsTreeWriteOptions } from '@deepseek-ai/dsh-fs'

/** Publish complete bytes inside the owning provider's Host filesystem.
 * @param fs - provider owning target identity and bounded comparison reads.
 * @param target - resolved directory destination.
 * @param entries - complete directory entries, unchanged until settlement.
 * @param options - caller authority and cooperative lock bound.
 * @param signal - cancellation before commit.
 * @param cleanupFailed - reports cleanup failures after successful commit.
 * @returns whether this operation created or reused the complete directory.
 */
export async function publishLocalTree(fs: FileSystem, target: FsTarget, entries: readonly FsTreeEntry[], options: FsTreeWriteOptions,
  signal: AbortSignal | undefined, cleanupFailed: (error: unknown) => void): Promise<'created' | 'identical'> {
  const expected = treeEntries(entries)
  const destination = fs.processPath(target)
  const parent = dirname(destination)
  const staging = join(parent, '.dsh-tree-publication')
  const admit = async (): Promise<void> => {
    signal?.throwIfAborted()
    await options.beforeCommit()
    const fresh = await fs.resolve(target.displayPath, signal === undefined ? {} : { signal })
    if (fresh.targetKey !== target.targetKey) throw new FsError('Directory destination was reassigned', 'FS_STALE_VERSION')
    signal?.throwIfAborted()
  }
  await admit()
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await admit()
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const stagingInfo = await lstat(staging)
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || await realpath(staging) !== staging) {
    throw new FsError('Directory publication staging path is not a real directory', 'FS_IO_ERROR')
  }
  const root = await mkdtemp(join(staging, 'tree-'))
  const identity = await lstat(root)
  const state: { outcome?: 'created' | 'identical' } = {}
  let failure: unknown
  try {
    const directories = entries.filter(entry => entry.kind === 'directory').sort((left, right) => left.path.length - right.path.length)
    for (const entry of directories) {
      signal?.throwIfAborted()
      await mkdir(join(root, entry.path), { mode: 0o700 })
    }
    for (const entry of entries) {
      if (entry.kind !== 'file') continue
      signal?.throwIfAborted()
      await writeFile(join(root, entry.path), entry.content, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 })
    }
    return await withFileLock(join(staging, basename(destination)), async () => {
      await admit()
      const existing = await fs.lstat(destination, undefined, signal)
      if (existing !== undefined) {
        if (existing.type !== 'directory' || !await sameTree(fs, target, expected, signal)) {
          throw new FsError('Directory output already exists with different content; it was not replaced', 'FS_NOT_OBSERVED')
        }
        await admit()
        state.outcome = 'identical'
        return 'identical' as const
      }
      await admit()
      if (await fs.lstat(destination, undefined, signal) !== undefined) {
        throw new FsError('Directory destination appeared during publication; it was not replaced', 'FS_NOT_OBSERVED')
      }
      signal?.throwIfAborted()
      await rename(root, destination)
      state.outcome = 'created'
      return 'created' as const
    }, { waitMs: options.lockWaitMs })
  } catch (error) {
    failure = error
    if (state.outcome === undefined) throw error
    cleanupFailed(error)
    return state.outcome
  } finally {
    try {
      let current
      try { current = await lstat(root) } catch (error) {
        // A renamed, committed private directory has no remaining staging entry.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current !== undefined) {
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new FsError('Directory staging was replaced; refusing cleanup', 'FS_IO_ERROR')
        }
        await rm(root, { recursive: true })
      }
    } catch (error) {
      if (state.outcome !== undefined) cleanupFailed(error)
      else if (failure !== undefined) throw new AggregateError([failure, error], 'Directory publication and cleanup failed')
      else throw error
    }
  }
}
