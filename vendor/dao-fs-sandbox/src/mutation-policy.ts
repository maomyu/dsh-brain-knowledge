/** Explicit filesystem mutation policy shared by trusted in-process providers. */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { isPathUnder } from './containment.ts'

/**
 * Check an explicit mutation policy without resolving ambient policy or writing.
 * Workspace-write returns the freshly resolved target; full access without
 * exclusions returns the original target. Read-only and containment denials throw
 * `FS_SANDBOX_DENIED`; filesystem resolution errors propagate unchanged.
 *
 * Callers must mutate the returned target and recheck at their final commit.
 * This does not lock paths or eliminate resolve-to-syscall races.
 * @param fs - filesystem that owns and resolves the target.
 * @param target - previously resolved target whose display path is rechecked.
 * @param policy - complete policy authorized for this operation.
 * @returns the exact target admitted for mutation.
 */
export async function resolveWritableTarget(
  fs: FileSystem,
  target: FsTarget,
  policy: SandboxExecutionPolicy,
): Promise<FsTarget> {
  const { mode } = policy
  if (mode === 'read-only') {
    throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
  }
  if (mode === 'danger-full-access' && (policy.protectedWriteRoots?.length ?? 0) === 0) return target
  const fresh = await fs.resolve(target.displayPath)
  for (const root of policy.protectedWriteRoots ?? []) {
    if (await isPathUnder(fresh.targetKey, root, false)) {
      throw new FsError(`cannot write "${target.displayPath}": protected directory is read-only to generic tools`, 'FS_SANDBOX_DENIED')
    }
  }
  if (mode === 'danger-full-access') return fresh
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) return fresh
  }
  throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
}

/** Refuse a tree publication that would replace an ancestor of protected knowledge.
 * @param fs - filesystem that resolves the current destination identity.
 * @param target - tree destination, including an as-yet missing path.
 * @param policy - complete per-call mutation policy.
 * @returns freshly admitted destination.
 */
export async function resolveWritableTreeTarget(fs: FileSystem, target: FsTarget,
  policy: SandboxExecutionPolicy): Promise<FsTarget> {
  const fresh = await resolveWritableTarget(fs, target, policy)
  for (const root of policy.protectedWriteRoots ?? []) {
    if (await isPathUnder(root, fresh.targetKey, false)) {
      throw new FsError(`cannot replace "${target.displayPath}": tree contains a protected directory`, 'FS_SANDBOX_DENIED')
    }
  }
  return fresh
}
