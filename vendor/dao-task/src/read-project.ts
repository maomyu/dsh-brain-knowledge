/** Current workspace membership selects read targets independently of task dispatch authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'

/** Resolve an active read target without restoring Agents or granting project writes.
 * @param ctx - live Agent registry and authoritative workspace membership.
 * @param agent - calling conversation, never a task or its direct child.
 * @param isTaskSession - task execution ownership lookup.
 * @param target - exact project ID; only a project-owned conversation has an implicit target.
 * @returns an active project in the conversation's current workspace; absent ownership or target rejects.
 */
export function resolveTaskReadProject(ctx: Context, agent: Agent | undefined,
  isTaskSession: (id: SessionId) => boolean, target: string | undefined): Workspace {
  if (agent === undefined || ctx.agents.get(agent.id) !== agent || isTaskSession(agent.id)
    || (agent.session.header.parentSession !== undefined && isTaskSession(agent.session.header.parentSession))) {
    throw new Error('Reading task records and research reports requires a registered non-task conversation')
  }
  const own = ctx.workspaceRegistry.list().find(project => project.sessionIds.includes(agent.id))
  const space = ctx.workspaceRegistry.spaces.find(candidate => own === undefined
    ? candidate.looseSessionIds?.includes(agent.id) : candidate.projectIds.includes(own.id))
  const project = space?.projectIds.map(id => ctx.workspaceRegistry.get(id))
    .find(candidate => candidate !== undefined && candidate.archivedAt === undefined && candidate.id === (target ?? own?.id))
  if (project === undefined) throw new Error('Choose a registered target_project_id in this conversation’s workspace')
  return project
}
