/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord, WorkspaceSessionBinding } from './spec.ts'
import type { Workspace, WorkspaceCreation, WorkspaceDetails, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, indexed membership validation,
 * and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Validate an accounted session against its binding or legacy directory fact.
   * @param record - Project carrying the session account and saved bindings.
   * @param id - Accounted session to validate.
   * @returns whether the current header still identifies the accounted session.
   */
  matchesSession(record: WorkspaceRecord, id: SessionId): boolean

  /**
   * Capture immutable identity from an indexed session header.
   * @param id - Session whose directory or existing binding was validated.
   * @returns the identity, or undefined for a missing header or cwd.
   */
  sessionBinding(id: SessionId): WorkspaceSessionBinding | undefined

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The saved project identity differs from the editor's original values. */
export class WorkspaceDetailsConflictError extends Error {
  /** @param workspaceId - Project whose current identity must be read again. */
  constructor(readonly workspaceId: WorkspaceId) {
    super('Project details changed while editing; reopen the editor to load the current values')
    this.name = 'WorkspaceDetailsConflictError'
  }
}

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, membership validation, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get description(): string {
    return this.record.description ?? this.record.creation?.description ?? ''
  }

  get creation(): WorkspaceCreation | undefined {
    return this.record.creation
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get pinnedAt(): string | undefined { return this.record.pinnedAt }

  get archivedAt(): string | undefined { return this.record.archivedAt }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter(id => this.host.matchesSession(this.record, id))
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async setPinned(pinned: boolean): Promise<void> {
    await this.setTimestamp('pinnedAt', pinned)
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.setTimestamp('archivedAt', archived)
  }

  private async setTimestamp(field: 'pinnedAt' | 'archivedAt', enabled: boolean): Promise<void> {
    await this.mutate((record) => {
      if (Boolean(record[field]) === enabled) throw unchangedSentinel
      const next = { ...record }
      if (enabled) next[field] = new Date().toISOString()
      else Reflect.deleteProperty(next, field)
      return next
    })
  }

  async setDetails(details: WorkspaceDetails, expected: WorkspaceDetails): Promise<void> {
    await this.mutate((record) => {
      const description = record.description ?? record.creation?.description ?? ''
      if (record.title === details.title && description === details.description) throw unchangedSentinel
      if (record.title !== expected.title || description !== expected.description) {
        throw new WorkspaceDetailsConflictError(this.id)
      }
      return { ...record, title: details.title, description: details.description }
    })
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    if (this.record.sessionBindings !== undefined && Object.hasOwn(this.record.sessionBindings, sessionId)
      && !this.host.matchesSession(this.record, sessionId)) {
      throw new Error(`cannot attach session '${sessionId}': its header no longer matches the saved project binding`)
    }
    // Existing bindings survive unavailable directories; new ownership still
    // requires an existing directory. Membership writes use the domain chain.
    if (!this.record.sessionIds.includes(sessionId) || !this.host.matchesSession(this.record, sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate((record) => {
      for (const [id, other] of this.host.table().entries()) {
        if (id !== this.id && other.sessionIds.includes(sessionId)) {
          throw new Error(`cannot attach session '${sessionId}': workspace '${id}' already accounts it`)
        }
      }
      return record.sessionIds.includes(sessionId)
        ? record
        : { ...record, sessionIds: [sessionId, ...record.sessionIds] }
    })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer identify an owned session and retaining bindings only for the
   * resulting account, then swap the snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.matchesSession(changed, id),
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        // Unary replies and stream updates compare this version, including writes in the same millisecond.
        const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString()
        const sessionBindings = Object.fromEntries(sessionIds.map(id => [
          id, this.host.sessionBinding(id) as WorkspaceSessionBinding,
        ]))
        return { ...changed, sessionIds, sessionBindings, updatedAt }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
