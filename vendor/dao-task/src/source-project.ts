/** Task source ownership and execution selection, independent of the displayed project. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Resolve a source's retained project or require current execution authority.
 * @param ctx - current registry and header-validated conversation ownership.
 * @param workspaceId - task's registered target project.
 * @param sessionId - original source conversation, never the task execution Session.
 * @param writable - require execution permission for admission, not retained result reads.
 * @returns the target project; missing identity, changed ownership or withdrawn authority rejects.
 */
export function taskSourceProject(ctx: Context, workspaceId: WorkspaceId, sessionId: SessionId, writable: boolean): Workspace {
  const project = ctx.workspaceRegistry.get(workspaceId)
  const scope = ctx.workspaceRegistry.conversationExecutionProjects(sessionId)
  const space = scope === undefined ? undefined : ctx.workspaceRegistry.spaces.find(item => item.spaceId === scope.spaceId)
  if (project === undefined || scope === undefined || !space?.projectIds.includes(workspaceId)) {
    throw new RemoteError('project-task/rejected', 'Task source or target is no longer in its workspace', { reason: 'source-session-changed' })
  }
  if (writable && !scope.writableProjectIds.includes(workspaceId)) {
    throw new RemoteError('project-task/rejected', 'Task target is not currently writable by its source conversation', { reason: 'project-changed' })
  }
  return project
}
