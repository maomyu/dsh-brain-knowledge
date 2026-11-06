/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError, WorkspaceDetailsConflictError } from './entity.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import { PERSONAL_SPACE_ID, validateProjectSpaces } from './spaces.ts'
import type { WorkspaceDomainState, WorkspaceRecord, WorkspaceSessionBinding } from './spec.ts'
import type { ConversationExecutionProjects, ConversationExecutionScope, ConversationProjectContext, ProjectSpace, ProjectSpaceId, SessionActivity, Workspace, WorkspaceCreation, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type { SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, Workspace, WorkspaceDetails } from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'
export { PERSONAL_SPACE_ID } from './spaces.ts'
export type { ConversationExecutionProjects, ConversationExecutionScope, ConversationProjectContext, ProjectSpace, ProjectSpaceId } from './types.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * An archiveSession or pinSession request named a session neither live nor in
 * session persistence — a definite miss only; storage faults propagate as
 * themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   * @param verb - The registry operation that named the session.
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin' | 'attach') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * An archiveSession request named a session that at least one
 * `workspace/session-activity` listener reported active. Nothing was written;
 * `activity` names what must stop before the session can be archived.
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - The active session id.
   * @param activity - The reported activity, in listener order.
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** A pinSession request named a session currently in the archive set; pinning and archival are mutually exclusive. */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - The archived session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


/** The session an archive request is about to write into the archive set. */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** Caller choices for {@link WorkspaceRegistry.archiveSession}. */
export interface ArchiveSessionOptions {
  /**
   * Ask the composed providers to stop the session's running work instead of
   * refusing the archive because of it. The archive is written first, then
   * the stops are requested; running work is never awaited to settlement, and
   * a provider failure is logged without undoing the archive.
   */
  readonly stopActivity?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * Ask the composed providers what still runs for a session before it is
     * archived. A listener prepends its own {@link SessionActivity} entries to
     * the result of `next()`; the registry's innermost callback returns an
     * empty list, so a composition without providers archives freely. Any
     * non-empty result refuses the archive without a write.
     * @param request - the session about to be archived.
     * @param next - delegate to the remaining providers.
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * Stop a session's running work because the caller archived it with
     * `stopActivity`; the archive set is durable when this dispatches. Each
     * provider stops its own families — cancelling a turn, its subagent
     * descendants, owned jobs, or active schedules — through the same cancel
     * paths the user's own stop actions use, so the session log ends every
     * open turn regularly and a later unarchive can continue the
     * conversation. Listeners issue their stop requests without waiting for
     * running work to settle; a listener may await its own durability
     * barrier. A rejection is logged by the registry and does not undo the
     * archive.
     * @param request - the session being archived.
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

function executionCandidates(scope: ConversationExecutionScope, projects: readonly WorkspaceId[]): readonly WorkspaceId[] {
  switch (scope.kind) {
    case 'none': return []
    case 'all': return projects
    case 'explicit': return scope.projectIds
    /* v8 ignore next -- Scope is a validated closed union; retain the exhaustive runtime rejection. */
    default: return assertNever(scope)
  }
}

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    matchesSession: (record, id) => this.matchesSession(record, id),
    sessionBinding: (id) => {
      const header = this.headers.get(id)
      return header?.cwd === undefined ? undefined : { createdAt: header.createdAt, cwd: header.cwd }
    },
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0 || (this.state.conversationProjectContexts?.length ?? 0) > 0
      || (this.state.conversationExecutionScopes?.length ?? 0) > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    await this.bindLegacyAccounts()
    if (this.requireState().spaces === undefined) {
      const state = this.requireState()
      await this.setState({ ...state, spaces: [{ spaceId: PERSONAL_SPACE_ID, title: '', projectIds: [...state.workspaceIds] }] })
    }
    validateProjectSpaces(this.spaces, this.requireState().workspaceIds)
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for an existing directory. The fully qualified
   * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
   * non-directory path rejects. Repeated calls for the same canonical path
   * return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in a fully qualified path spelling.
   * @param title - Display title used only when a new record is created.
   * @param creation - original managed-project input persisted with a new record.
   * @param spaceId - logical workspace owning the project; omission selects the migrated personal workspace.
   * @returns the existing or newly durable workspace.
   */
  async create(path: string, title?: string, creation?: WorkspaceCreation,
    spaceId: ProjectSpaceId = PERSONAL_SPACE_ID): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title, creation, spaceId))
  }

  /** Named logical workspaces and their directory-level project memberships. */
  get spaces(): readonly ProjectSpace[] { return this.requireState().spaces ?? [] }

  /** Resolve execution projects from saved scope and current header-validated ownership.
   * @param sessionId - project or logical-workspace conversation; no event body is opened.
   * @returns current selection with active canonical directories, or undefined for an unknown or rebound owner.
   */
  conversationExecutionProjects(sessionId: SessionId): ConversationExecutionProjects | undefined {
    const state = this.global?.get()
    if (state === undefined) throw new Error('workspace registry is not started yet')
    const header = this.ctx.get('sessions')?.get(sessionId)?.header ?? this.headers.get(sessionId)
    const owner = this.projectContextOwner(sessionId, state)
    if (header === undefined || owner === undefined) return undefined
    const saved = state.conversationExecutionScopes?.find(item => item.sessionId === sessionId)
    if (saved !== undefined && (saved.spaceId !== owner.space.spaceId
      || saved.binding.createdAt !== header.createdAt || saved.binding.cwd !== header.cwd)) return undefined
    const scope: ConversationExecutionScope = saved?.scope ?? (owner.project === undefined
      ? { kind: 'none' } : { kind: 'explicit', projectIds: [owner.project.id] })
    const candidates = executionCandidates(scope, owner.space.projectIds)
    const writableProjectIds = candidates.filter((id) => {
      const project = this.requireTable().get(id)
      if (!owner.space.projectIds.includes(id) || project === undefined || project.archivedAt !== undefined) return false
      try { return realpathSync.native(project.path) === project.path && statSync(project.path).isDirectory() }
      catch (error) {
        // Missing, inaccessible or looping directory links withdraw this project's execution scope.
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))) return false
        throw error
      }
    })
    return { sessionId, spaceId: owner.space.spaceId, scope: structuredClone(scope), revision: saved?.revision ?? 0, writableProjectIds }
  }

  /** Save execution scope without changing references, membership, files or Session input.
   * @param sessionId - known conversation in a registered logical workspace.
   * @param scope - none, every active project, or explicit active projects in that workspace.
   * @param expectedRevision - current revision for replacement; null initializes only and never overwrites a saved selection.
   * @returns durable selection; stale revisions, foreign projects and changed Session identities reject.
   */
  setConversationExecutionScope(sessionId: SessionId, scope: ConversationExecutionScope,
    expectedRevision: number | null): Promise<ConversationExecutionProjects> {
    const selection = structuredClone(scope)
    return this.enqueueOperation(async () => {
      const header = await this.readSessionHeader(sessionId)
      const current = this.conversationExecutionProjects(sessionId)
      if (current === undefined) throw new Error('execution scope requires an unchanged conversation in a registered logical workspace')
      if (expectedRevision === null && current.revision > 0) return current
      if (expectedRevision !== null && expectedRevision !== current.revision) throw new Error('execution scope revision changed; reload before saving')
      if (selection.kind === 'explicit') {
        if (new Set(selection.projectIds).size !== selection.projectIds.length) throw new Error('execution scope contains duplicate projects')
        const space = this.spaces.find(item => item.spaceId === current.spaceId)
        if (space === undefined) throw new Error('execution scope workspace is unavailable')
        for (const id of selection.projectIds) {
          const project = this.entities.get(id)
          if (!space.projectIds.includes(id) || project === undefined || project.archivedAt !== undefined
            || await project.status() !== 'ok') throw new Error('execution scope requires active projects in the conversation workspace')
        }
      }
      const revision = current.revision + 1
      if (!Number.isSafeInteger(revision)) throw new Error('conversation execution scope revision exhausted')
      const fresh = await this.readSessionHeader(sessionId)
      const owner = this.projectContextOwner(sessionId)
      if (fresh.createdAt !== header.createdAt || fresh.cwd !== header.cwd || owner?.space.spaceId !== current.spaceId) {
        throw new Error('execution scope conversation owner changed before saving')
      }
      if (selection.kind === 'explicit' && selection.projectIds.some(id => !owner.space.projectIds.includes(id)
        || this.entities.get(id)?.archivedAt !== undefined || !this.entities.has(id))) {
        throw new Error('execution scope project changed before saving')
      }
      const state = this.requireState()
      await this.setState({ ...state, conversationExecutionScopes: [
        ...state.conversationExecutionScopes?.filter(item => item.sessionId !== sessionId) ?? [],
        { sessionId, spaceId: current.spaceId, scope: selection.kind === 'explicit'
          ? { kind: 'explicit', projectIds: [...selection.projectIds] } : { ...selection }, revision,
        binding: { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } } },
      ] })
      const saved = this.conversationExecutionProjects(sessionId)
      if (saved === undefined) throw new Error('execution scope owner changed while saving')
      return saved
    })
  }

  /** Read saved focus for a header-validated conversation without loading its event body.
   * @param sessionId - existing project or logical-workspace conversation.
   * @returns active additional projects, or undefined when the conversation has no verified selection.
   */
  conversationProjectContext(sessionId: SessionId): ConversationProjectContext | undefined {
    const state = this.global?.get()
    if (state === undefined) throw new Error('workspace registry is not started yet')
    const saved = state.conversationProjectContexts?.find(item => item.sessionId === sessionId)
    const header = this.ctx.get('sessions')?.get(sessionId)?.header ?? this.headers.get(sessionId)
    if (saved === undefined || header === undefined || saved.binding.createdAt !== header.createdAt
      || saved.binding.cwd !== header.cwd) return undefined
    const owner = this.projectContextOwner(sessionId, state)
    if (owner === undefined || owner.space.spaceId !== saved.spaceId) return undefined
    return { sessionId, spaceId: saved.spaceId, revision: saved.revision,
      projectIds: saved.projectIds.filter((id) => {
        const record = this.requireTable().get(id)
        return id !== owner.project?.id && owner.space.projectIds.includes(id) && record !== undefined && record.archivedAt === undefined
      }) }
  }

  /** Change one persistent focus selection; serialized deltas preserve concurrent selections.
   * @param sessionId - known conversation with an existing logical-workspace owner.
   * @param projectId - additional project; selecting the conversation's working project is a no-op.
   * @param selected - add or remove the project without modifying membership or permissions.
   * @returns committed focus and revision; unknown, archived or foreign additions reject without writing.
   */
  setConversationProjectContext(sessionId: SessionId, projectId: WorkspaceId, selected: boolean): Promise<ConversationProjectContext> {
    return this.enqueueOperation(async () => {
      const header = await this.readSessionHeader(sessionId)
      const owner = this.projectContextOwner(sessionId)
      if (owner === undefined) throw new Error('project context requires a conversation in a registered logical workspace')
      const project = this.entities.get(projectId)
      if (selected && (project === undefined || project.archivedAt !== undefined || !owner.space.projectIds.includes(projectId))) {
        throw new Error('project context must belong to the conversation\'s active logical workspace')
      }
      const current = this.conversationProjectContext(sessionId)
      const state = this.requireState()
      const saved = state.conversationProjectContexts?.find(item => item.sessionId === sessionId)
      const priorIds = current !== undefined && saved !== undefined ? saved.projectIds : []
      const projectIds = [...priorIds]
      const index = projectIds.indexOf(projectId)
      if (selected && index === -1 && owner.project?.id !== projectId) projectIds.push(projectId)
      if (!selected && index !== -1) projectIds.splice(index, 1)
      if (projectIds.length === priorIds.length && projectIds.every((id, i) => id === priorIds[i])) {
        return current ?? { sessionId, spaceId: owner.space.spaceId, projectIds, revision: 0 }
      }
      const revision = (saved?.revision ?? 0) + 1
      if (!Number.isSafeInteger(revision)) throw new Error('conversation project context revision exhausted')
      const value: ConversationProjectContext = { sessionId, spaceId: owner.space.spaceId, projectIds, revision }
      await this.setState({ ...state, conversationProjectContexts: [
        ...state.conversationProjectContexts?.filter(item => item.sessionId !== sessionId) ?? [],
        { ...value, projectIds, binding: { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } } },
      ] })
      return this.conversationProjectContext(sessionId) ?? { ...value, projectIds: [] }
    })
  }

  private projectContextOwner(sessionId: SessionId,
    state = this.requireState()): { space: ProjectSpace; project: Workspace | undefined } | undefined {
    const projectId = state.workspaceIds.find((id) => {
      const record = this.requireTable().get(id)
      return record !== undefined && record.sessionIds.includes(sessionId) && this.matchesSession(record, sessionId)
    })
    const project = projectId === undefined ? undefined : this.entities.get(projectId)
    const space = state.spaces?.find(item => project === undefined
      ? item.looseSessionIds?.includes(sessionId) : item.projectIds.includes(project.id))
    return space === undefined ? undefined : { space, project }
  }

  /** Create a logical workspace by name, without allocating or moving directories.
   * @param spaceId - stable request UUID, reused after uncertain transport failures.
   * @param title - non-blank display name; identity reuse requires the same name.
   * @returns the durable logical workspace.
   */
  createSpace(spaceId: ProjectSpaceId, title: string): Promise<ProjectSpace> {
    return this.enqueueOperation(async () => {
      if (title.trim() === '' || title.includes('\0')) throw new Error('logical workspace requires a non-blank name without NUL')
      const existing = this.spaces.find(space => space.spaceId === spaceId)
      if (existing !== undefined) {
        if (existing.title !== title) throw new Error('logical workspace identity was already used with a different name')
        return existing
      }
      const space = { spaceId, title, projectIds: [] }
      const state = this.requireState()
      await this.setState({ ...state, spaces: [...state.spaces ?? [], space] })
      return space
    })
  }

  /** Associate a known projectless conversation with its logical workspace without changing the Session log.
   * @param spaceId - existing logical workspace.
   * @param sessionId - newly created or idempotently retried conversation.
   * @returns after metadata persistence; a different owner rejects without writing.
   */
  attachSpaceSession(spaceId: ProjectSpaceId, sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      const space = this.spaces.find(candidate => candidate.spaceId === spaceId)
      if (space === undefined) throw new Error('logical workspace does not exist')
      const project = this.list().find(project => project.sessionIds.includes(sessionId))
      const owner = this.spaces.find(candidate => candidate.looseSessionIds?.includes(sessionId))
      if ((project !== undefined && !space.projectIds.includes(project.id)) || (owner !== undefined && owner.spaceId !== spaceId)) {
        throw new Error('conversation already belongs to another logical workspace')
      }
      if (owner !== undefined || project !== undefined) return
      if (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId, 'attach')
      await this.setState({ ...this.requireState(), spaces: this.requireState().spaces?.map(candidate => candidate.spaceId === spaceId
        ? { ...candidate, looseSessionIds: [...candidate.looseSessionIds ?? [], sessionId] } : candidate) })
    })
  }

  /**
   * Initialize the default Workspace only while both the registry and Session
   * history are empty. Repeated requests reuse its durable identity; deleting
   * that registration permanently disables automatic creation.
   * @param resolveDirectory - resolve the absolute directory; called only for
   * eligible creation, inside the registry mutation queue. Missing directories
   * are created recursively before registration, and the initial title is the
   * requested directory's own final segment — not the canonical one, so a
   * symlink at that path does not retitle the Workspace after its target.
   * After resolution, caller cancellation does not roll back creation or registration.
   * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // A Session can start outside the registry queue while directory preparation awaits I/O.
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createCanonical(canonical, defaultWorkspaceTitle(path), undefined, PERSONAL_SPACE_ID, true)
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter validates its saved bindings against the
   * header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    })
  }

  /**
   * Unarchive one session durably by dropping it from the registry-global
   * archive set; the accounting slot was never touched, so the session
   * returns to its recorded position. Unarchiving runs no session-existence
   * check because removing an id cannot introduce an unknown one, so an
   * entry whose session is gone still resolves. An id that is not archived
   * resolves without writing.
   * @param sessionId - The session to unarchive.
   * @returns resolution after durability.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent archive.
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * The registry-global pin set: sessions surfaced ahead of every unpinned
   * session on grouping surfaces. Pinning never touches workspace accounting.
   * @returns Session ids in pin order (most recently pinned first).
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * Pin one session durably, prepending it to the registry-global pin set.
   * The session must exist (live or in session persistence) and must not be
   * archived. An already pinned id resolves without writing or reordering.
   * @param sessionId - The session to pin.
   * @returns resolution after durability.
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another pin or archive.
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * Unpin one session durably by dropping it from the registry-global pin
   * set. Unpinning runs no session-existence check because removing an id
   * cannot introduce an unknown one, so an entry whose session is gone still
   * resolves. An id that is not pinned resolves without writing.
   * @param sessionId - The session to unpin.
   * @returns resolution after durability.
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent pin.
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** Request every provider's stop; a failing provider is logged, never a reason to keep the session visible. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in a fully qualified spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title: string | undefined,
    creation: WorkspaceCreation | undefined, spaceId: ProjectSpaceId, firstUse = false): Promise<WorkspaceEntity> {
    const space = this.spaces.find(candidate => candidate.spaceId === spaceId)
    if (space === undefined) throw new Error(`logical workspace '${spaceId}' does not exist`)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) {
        if (!space.projectIds.includes(entity.id)) throw new Error('project folder already belongs to another logical workspace')
        return entity
      }
    }

    const workspaceName = title ?? defaultWorkspaceTitle(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      ...creation === undefined ? {} : { creation },
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        pendingMutation: undefined,
        initialized: true,
        ...(firstUse ? { defaultWorkspaceId: id } : {}),
        workspaceIds: [id, ...state.workspaceIds],
        archivedSessionIds: state.archivedSessionIds,
        spaces: state.spaces?.map(space => ({ ...space,
          projectIds: space.spaceId === spaceId ? [id, ...space.projectIds] : space.projectIds })),
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      pendingMutation: undefined,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
      archivedSessionIds: state.archivedSessionIds,
      spaces: state.spaces?.map(space => space.projectIds.includes(id) ? {
        ...space,
        projectIds: space.projectIds.filter(projectId => projectId !== id),
        ...(entity.sessionIds.length === 0 ? {} : {
          looseSessionIds: [...new Set([...space.looseSessionIds ?? [], ...entity.sessionIds])],
        }),
      } : space),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({ ...state, pendingMutation: undefined })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: defaultWorkspaceTitle(group.path),
          sessionIds,
          sessionBindings: Object.fromEntries(sessionIds.map(id => [id, this.host.sessionBinding(id) as WorkspaceSessionBinding])),
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined
          || (accounted.get(sessionId) === id && this.matchesSession(current, sessionId)))
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        sessionBindings: {
          ...record.sessionBindings,
          ...Object.fromEntries(historical.map(id => [id, this.host.sessionBinding(id) as WorkspaceSessionBinding])),
        },
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({
        initialized: false,
        workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
      })
    }
    await this.setState({ ...state, initialized: true, workspaceIds,
      spaces: [{ spaceId: PERSONAL_SPACE_ID, title: '', projectIds: [...workspaceIds] }] })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const executionSessions = new Set<SessionId>()
    for (const entry of state.conversationExecutionScopes ?? []) {
      if (executionSessions.has(entry.sessionId) || (entry.scope.kind === 'explicit'
        && new Set(entry.scope.projectIds).size !== entry.scope.projectIds.length)) {
        throw new Error('workspace domain is inconsistent: duplicate conversation execution scope identity')
      }
      executionSessions.add(entry.sessionId)
    }
    const contextSessions = new Set<SessionId>()
    for (const context of state.conversationProjectContexts ?? []) {
      if (contextSessions.has(context.sessionId) || new Set(context.projectIds).size !== context.projectIds.length) {
        throw new Error('workspace domain is inconsistent: duplicate conversation project context identity')
      }
      contextSessions.add(context.sessionId)
    }
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of Object.keys(record.sessionBindings ?? {})) {
        if (!record.sessionIds.some(id => id === sessionId)) {
          throw new Error(`workspace domain is inconsistent: binding '${sessionId}' has no account in workspace '${id}'`)
        }
      }
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private matchesSession(record: WorkspaceRecord, id: SessionId): boolean {
    const header = this.headers.get(id)
    if (header?.cwd === undefined) return false
    const bindings = record.sessionBindings
    const binding = bindings !== undefined && Object.hasOwn(bindings, id) ? bindings[id] : undefined
    if (binding !== undefined) return binding.createdAt === header.createdAt && binding.cwd === header.cwd
    // A canonical creation path remains an identity fact when offline. An
    // unbound alias needs realpath evidence while its directory is available.
    return header.cwd === record.path || this.sessionPaths.get(id) === record.path
  }

  private async bindLegacyAccounts(): Promise<void> {
    for (const [id, record] of this.requireTable().entries()) {
      const unbound = record.sessionIds.filter(sessionId =>
        (record.sessionBindings === undefined || !Object.hasOwn(record.sessionBindings, sessionId))
        && this.matchesSession(record, sessionId))
      if (unbound.length === 0) continue
      await this.requireTable().update(id, current => ({
        ...current,
        sessionBindings: {
          ...current.sessionBindings,
          ...Object.fromEntries(unbound.map(id => [id, this.host.sessionBinding(id) as WorkspaceSessionBinding])),
        },
        updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
      }))
    }
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch {
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /** Every stored session's header, projected from the persistence snapshot listing. */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        if (this.matchesSession(record, sessionId)) continue
        const path = this.sessionPaths.get(sessionId)
        const reason = record.sessionBindings !== undefined && Object.hasOwn(record.sessionBindings, sessionId)
          ? 'session header is missing or differs from its saved binding'
          : this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
