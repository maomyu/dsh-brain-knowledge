import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
export * from '@deepseek-ai/dsh-subagent'

// Dao's out-of-process adapter resolves child paths against the parent session.
export function resolveChildCwd(prefix, configured, parentCwd) {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) {
    throw new Error(`${prefix}: no working directory for the child — configure \x60cwd\x60 or delegate from a parent session that has one`)
  }
  return assertUsableCwd(prefix, 'parent session cwd', parentCwd)
}
