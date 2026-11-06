/** Logical workspace identifiers and durable membership validation. */
import type { ProjectSpace, ProjectSpaceId, WorkspaceId } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable migration destination for project registrations created before logical workspaces existed. */
export const PERSONAL_SPACE_ID = 'personal' as ProjectSpaceId

/** Verify that every registered project has exactly one existing logical workspace.
 * @param spaces - stored logical workspaces.
 * @param projectIds - authoritative directory-level registry order.
 */
export function validateProjectSpaces(spaces: readonly ProjectSpace[], projectIds: readonly WorkspaceId[]): void {
  const ids = new Set<ProjectSpaceId>()
  const projects = new Set(projectIds)
  const owned = new Set<WorkspaceId>()
  const conversations = new Set<SessionId>()
  for (const space of spaces) {
    if (ids.has(space.spaceId)) throw new Error(`duplicate logical workspace '${space.spaceId}'`)
    ids.add(space.spaceId)
    for (const id of space.looseSessionIds ?? []) {
      if (conversations.has(id)) throw new Error(`duplicate logical workspace ownership for conversation '${id}'`)
      conversations.add(id)
    }
    for (const id of space.projectIds) {
      if (!projects.has(id) || owned.has(id)) throw new Error(`invalid logical workspace membership for project '${id}'`)
      owned.add(id)
    }
  }
  if (!ids.has(PERSONAL_SPACE_ID) || owned.size !== projects.size) throw new Error('logical workspace membership is incomplete')
}
