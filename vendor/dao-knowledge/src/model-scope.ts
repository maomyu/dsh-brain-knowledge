/** Session-owned workspace knowledge selection, independent of project code-writing authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'
import { hasTaskInput } from './model-task.ts'

/** Registered knowledge identity; a display name never grants filesystem access. */
interface ScopeProject {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
}

/** Captured membership used again before publishing model-visible file content. */
export interface BrainReadScope {
  readonly kind: 'task' | 'project' | 'workspace'
  /** Retained research task or its direct researcher may also look up original project source. */
  readonly research?: true
  readonly spaceId: ProjectSpaceId | null
  readonly defaultProjectId: WorkspaceId | null
  readonly projects: readonly ScopeProject[]
}

/** Resolve workspace knowledge membership and the conversation's selected implicit project.
 * @param ctx - authoritative project and logical-workspace registry.
 * @param session - registered executing Agent's retained Session.
 * @param binding - directly owned project or retained read-only Task project, resolved by the model Consumer.
 * @returns current permitted projects, or no authority for an unbound conversation or withdrawn Task.
 */
export function captureBrainScope(ctx: Context, session: Session,
  binding: { id: WorkspaceId; path: string; readOnly: boolean; research?: true } | undefined): BrainReadScope | undefined {
  if (binding?.readOnly) {
    const project = ctx.workspaceRegistry.get(binding.id)
    if (project === undefined || project.path !== binding.path) return undefined
    return { kind: 'task', ...(binding.research ? { research: true as const } : {}), spaceId: null, defaultProjectId: project.id,
      projects: [{ id: project.id, path: project.path, title: project.title }] }
  }
  if (hasTaskInput(session)) return undefined
  const space = ctx.workspaceRegistry.spaces.find(candidate => binding === undefined
    ? candidate.looseSessionIds?.includes(session.id) : candidate.projectIds.includes(binding.id))
  if (space === undefined) return undefined
  const projects = space.projectIds.flatMap((id) => {
    const project = ctx.workspaceRegistry.get(id)
    return project === undefined || project.archivedAt !== undefined ? [] : [{ id, path: project.path, title: project.title }]
  })
  const execution = ctx.workspaceRegistry.conversationExecutionProjects(session.id)
  if (execution === undefined || execution.spaceId !== space.spaceId) return undefined
  const defaultProjectId = execution.scope.kind === 'explicit' && execution.writableProjectIds.length === 1
    ? execution.writableProjectIds[0] as WorkspaceId : null
  return { kind: binding === undefined ? 'workspace' : 'project', spaceId: space.spaceId,
    defaultProjectId, projects }
}

/** Choose exact project ids or one unambiguous case-insensitive display name within captured membership.
 * @param scope - current conversation-owned knowledge scope.
 * @param target - optional explicit project id or display name, never a path.
 * @param aggregate - permit all workspace projects when neither an explicit nor an implicit target exists.
 * @returns selected registered projects; missing or ambiguous targets reject before any file read.
 */
export function selectBrainProjects(scope: BrainReadScope, target: string | undefined, aggregate: boolean): readonly ScopeProject[] {
  if (target === undefined && scope.defaultProjectId === null && aggregate) return scope.projects
  const requested = target ?? scope.defaultProjectId
  const exact = scope.projects.find(project => project.id === requested)
  if (exact !== undefined) return [exact]
  if (target === undefined && requested === null && scope.projects.length === 1) return scope.projects
  const normalized = target?.trim().toLocaleLowerCase()
  const matches = normalized ? scope.projects.filter(project => project.title.trim().toLocaleLowerCase() === normalized) : []
  if (matches.length === 1) return matches
  throw new Error(`Choose one available Project by target_project_id; missing or ambiguous names grant no access. Available Projects: ${
    scope.projects.map(project => `${project.title} (${project.id})`).join(', ') || 'none'}`)
}

/** Refuse content captured before its conversation, workspace membership or registered path changed.
 * @param captured - scope at operation admission.
 * @param current - scope resolved again immediately before publication.
 * @param selected - project identities whose data would be returned.
 */
export function revalidateBrainScope(captured: BrainReadScope, current: BrainReadScope | undefined,
  selected: readonly ScopeProject[]): void {
  if (current === undefined || captured.kind !== current.kind || captured.research !== current.research
    || captured.spaceId !== current.spaceId
    || captured.defaultProjectId !== current.defaultProjectId
    || selected.some(project => !current.projects.some(candidate => candidate.id === project.id && candidate.path === project.path))) {
    throw new Error('Project membership changed while reading Brain; retry from the current workspace')
  }
}
