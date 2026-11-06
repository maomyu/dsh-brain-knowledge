/**
 * Public type vocabulary of the workspace entity: the `WorkspaceId` brand and
 * the `Workspace` consumer interface. Types only — the `WorkspaceId` factory
 * lives in `index.ts` (this file carries no runtime code).
 * @module @deepseek-ai/dsh-workspace/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Identifies one named-project creation request across transport retries. */
export type WorkspaceCreationId = Branded<'WorkspaceCreationId'>

/** Logical product workspace identity; never a filesystem path or a directory-level WorkspaceId. */
export type ProjectSpaceId = Branded<'ProjectSpaceId'>

/** A logical workspace containing independently located projects. Creating it performs no filesystem operations. */
export interface ProjectSpace {
  readonly spaceId: ProjectSpaceId
  /** Empty only for the migrated personal workspace, whose name is locale-owned. */
  readonly title: string
  readonly projectIds: readonly WorkspaceId[]
  /** Ordinary conversations created without a project in this logical workspace. */
  readonly looseSessionIds?: readonly SessionId[] | undefined
}

/** Persistent conversation focus; selections grant neither filesystem nor task-write permissions. */
export interface ConversationProjectContext {
  readonly sessionId: SessionId
  readonly spaceId: ProjectSpaceId
  /** Additional active projects in the conversation's logical workspace, in selection order. */
  readonly projectIds: readonly WorkspaceId[]
  /** Durable mutation counter, independent of conversation activity and project timestamps. */
  readonly revision: number
}

/** Project execution selection, independent of read-only references and the conversation directory. */
export type ConversationExecutionScope = { readonly kind: 'none' } | { readonly kind: 'all' }
  | { readonly kind: 'explicit'; readonly projectIds: readonly WorkspaceId[] }

/** Current execution selection and its available projects; reading this value grants no filesystem access. */
export interface ConversationExecutionProjects {
  readonly sessionId: SessionId
  readonly spaceId: ProjectSpaceId
  readonly scope: ConversationExecutionScope
  /** Zero denotes the implicit own-project or projectless-none selection. */
  readonly revision: number
  /** Active canonical directories in the owning logical workspace, never context-only references. */
  readonly writableProjectIds: readonly WorkspaceId[]
}

/** User-authored project identity, independent of its directory and creation receipt. */
export interface WorkspaceDetails {
  readonly title: string
  readonly description: string
}

/** Original named-project input, retained independently of later title changes. */
export interface WorkspaceCreation {
  readonly creationId: WorkspaceCreationId
  readonly title: string
  readonly description: string
  /** Absolute parent chosen at creation; omission uses the Host's configured default. */
  readonly parentDirectory?: string | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No registration carries that Workspace identity. */
    'workspace/not-found': { readonly workspaceId: WorkspaceId }
  }
}

/**
 * Activity families a `workspace/session-activity` listener may report. This
 * package declares none: each provider merges its own key from a module both
 * its Host and Client faces import, so a consumer that renders the families
 * sees exactly the keys its program compiled and falls through to a generic
 * description for any other. The shipped providers merge `turn` (the Agent
 * registry), `job` (the job registry seam), `subagent` (the Subagent
 * runtime), and `schedule` (the Schedule plugin).
 */
export interface SessionActivityKindMap {}

/** One activity family key. */
export type SessionActivityKind = keyof SessionActivityKindMap

/** One active item of a family that has per-item identity. */
export interface SessionActivityItem {
  /** Family-specific identity: a session id, a job id, or a schedule id. */
  readonly id: string
  /** Display label when the family carries one (a job label, a subagent label). */
  readonly label?: string
}

/**
 * One reason a session counts as active for archive admission. Families with
 * per-item identity list their items so a caller can name what must stop.
 */
export interface SessionActivity {
  readonly kind: SessionActivityKind
  /** Active items of the family; absent for a family without per-item identity (`turn`). */
  readonly items?: readonly SessionActivityItem[]
}

/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a header matching its saved creation identity; an unbound
 * candidate requires a matching directory fact. Consumers see this interface.
 */
export interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** Current description; empty when neither a saved description nor a creation receipt supplies one. */
  readonly description: string

  /** ISO-8601 pin instant; absent when not pinned. Pins do not change manual order. */
  readonly pinnedAt: string | undefined

  /** ISO-8601 archive instant; absent for active projects. Files and Sessions remain intact. */
  readonly archivedAt: string | undefined

  /** Present for managed projects; absent for adopted directories and legacy records. */
  readonly creation?: WorkspaceCreation | undefined

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 mutation version, strictly increasing per record even within one clock millisecond. */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously against saved header identity. Directory
   * loss does not detach a bound session. Missing or changed headers are not
   * returned; accepted writes prune invalid candidates and their bindings.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /** Set pin status durably; repeating the current value preserves its timestamp.
   * @param pinned - whether this project belongs before unpinned projects.
   * @returns resolution after durability, or without writing when unchanged.
   */
  setPinned(pinned: boolean): Promise<void>

  /** Hide or restore the project without changing its identity, files or Session membership.
   * @param archived - true to archive; false to restore.
   * @returns resolution after durability, or without writing when unchanged.
   */
  setArchived(archived: boolean): Promise<void>

  /**
   * Atomically replace title and description while preserving the directory and creation receipt.
   * An already-applied value resolves without writing; a different current value rejects with
   * WorkspaceDetailsConflictError unless it matches expected at the storage write slot.
   * @param details - New title and description; caller owns text validation and title uniqueness.
   * @param expected - Identity read when editing started.
   * @returns resolution after durability, or without a write when already applied.
   */
  setDetails(details: WorkspaceDetails, expected: WorkspaceDetails): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, mismatches, and ids accounted
   * by another project reject without writing. A changed saved identity also
   * rejects; callers must explicitly detach it before attaching a new identity.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
