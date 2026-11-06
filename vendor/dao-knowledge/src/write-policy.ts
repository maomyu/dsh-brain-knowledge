/** File writes use the admitted Brain directory, never the unrelated application-launch cwd. */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Check the live conversation mode without deriving knowledge membership from code-write roots.
 * @param ctx - caller's composed filesystem and optional shared sandbox-policy service.
 * @param session - conversation whose retained mode is authoritative when the policy service is mounted.
 * @returns false for a read-only conversation or read-only filesystem deployment.
 */
export function knowledgeSessionWritable(ctx: Context, session: Session): boolean {
  return ctx.fs.sandboxMode !== 'read-only' && ctx.get('sandboxPolicy')?.resolve({ session }).mode !== 'read-only'
}

/** Narrow a registered knowledge operation to its selected Brain while retaining a read-only deployment.
 * @param fs - composed filesystem; non-sandboxing providers ignore the explicit policy.
 * @param brain - Host path captured and revalidated by the knowledge operation owner.
 * @returns a Brain-only workspace policy with no additional writable roots.
 * @throws when the selected Brain has no process-filesystem mapping.
 */
export function knowledgeWritePolicy(fs: FileSystem, brain: string): NonNullable<Parameters<FileSystem['writeText']>[4]> {
  const workspaceRoot = fs.processPathFromHostPath(brain)
  if (workspaceRoot === undefined) throw new Error('Selected Brain is unavailable in this filesystem')
  return { mode: fs.sandboxMode === 'read-only' ? 'read-only' : 'workspace-write', workspaceRoot }
}
