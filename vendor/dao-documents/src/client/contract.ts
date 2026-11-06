/** Ephemeral, project-owned document preparation; source readers stay outside render props. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DocumentImportFailure, DocumentImportFormat, DocumentImportInput, DocumentImportResult, DocumentImportSourceId, DocumentTextExtraction } from '../types.ts'

export type { DocumentImportSourceId } from '../types.ts'

/** Explicitly selected source, never an instruction to read a Host path. */
export interface DocumentImportSource {
  readonly id: DocumentImportSourceId
  readonly name: string
  readonly size: number
  readonly format: DocumentImportFormat | null
  /**
   * Read canonical base64 only after admission; settle after cancellation releases the reader.
   * @param signal - this candidate's read/conversion lifetime.
   * @returns original source bytes, without a data-URL prefix.
   */
  readonly read: (signal: AbortSignal) => Promise<string>
}

/** Fully resolved selection limits supplied by the acquisition owner. */
export interface DocumentImportSelectionLimits {
  /** Positive decoded-byte admission cap; Host conversion independently enforces its own cap. */
  readonly maxSourceBytes: number
  /** Positive ready-candidate allowance. */
  readonly maxReady: number
  /** Count retained ready entries as well as this batch, or only this batch's successes. */
  readonly readyScope: 'project' | 'selection'
}

/** Localized by the UI; source and transport exception messages are not published. */
export type DocumentImportDraftFailure = DocumentImportFailure | 'unsupported' | 'too-many' | 'read-failed' | 'remote-failed' | 'cancelled'

/** Metadata-only row; neither original bytes nor extracted text enter observable state. */
export type DocumentImportDraftEntry = {
  readonly id: DocumentImportSourceId
  readonly name: string
  readonly size: number
  /** Selected source format; older metadata-only rows may omit it. */
  readonly sourceFormat?: DocumentImportFormat | null
} & (
  | { readonly status: 'queued' | 'reading' | 'preparing' }
  | { readonly status: 'ready'; readonly outputName: string; readonly textBytes: number; readonly extraction?: DocumentTextExtraction }
  | { readonly status: 'rejected'; readonly reason: DocumentImportDraftFailure }
)

/** One project's preparation status, independent of the currently displayed project. */
export interface DocumentImportProjectDraft {
  readonly workspaceId: WorkspaceId
  readonly busy: boolean
  readonly entries: readonly DocumentImportDraftEntry[]
}

/** Metadata retained for the Client plugin lifetime, never localStorage. */
export interface DocumentImportDraftSnapshot {
  readonly projects: readonly DocumentImportProjectDraft[]
}

/** Original bytes and readable output captured together for a later durable submission. */
export interface PreparedDocumentImport {
  readonly id: DocumentImportSourceId
  readonly source: DocumentImportInput
  readonly output: Extract<DocumentImportResult, { status: 'ready' }>
}

/** React-free preparation consumer of the generated Host method. */
export interface IDocumentImportDrafts {
  readonly state: ObservableSnapshot<DocumentImportDraftSnapshot>
  /**
   * Merge by source identity, replacing matching rows, then process sequentially within this project.
   * @param workspaceId - registered project selected by the caller.
   * @param sources - explicit selections; duplicate identities use their final supplied value.
   * @param limits - resolved limits; rejected candidates do not spend ready allowance.
   * @returns false without mutation when this project is busy or the model is disposed; otherwise true after settlement.
   */
  prepare(workspaceId: WorkspaceId, sources: readonly DocumentImportSource[], limits: DocumentImportSelectionLimits): Promise<boolean>
  /**
   * Remove one row and cancel its work; a late result cannot restore it.
   * @param workspaceId - owning project.
   * @param sourceId - candidate identity.
   */
  remove(workspaceId: WorkspaceId, sourceId: DocumentImportSourceId): void
  /**
   * Cancel the current batch, retaining settled rows and marking uncompleted rows cancelled.
   * @param workspaceId - owning project.
   * @returns after all batch readers and Remote calls settle.
   */
  cancel(workspaceId: WorkspaceId): Promise<void>
  /**
   * Capture independent, readonly payloads after preparation; no upload or Session is created.
   * @param workspaceId - owning project.
   * @returns ready payloads, or null while busy; an absent project has an empty selection.
   */
  prepared(workspaceId: WorkspaceId): readonly PreparedDocumentImport[] | null
  /**
   * Release a project's draft immediately and cancel/join its batch without affecting a successor draft.
   * @param workspaceId - project removed, reset or successfully submitted by the consumer.
   * @returns after the removed draft's work settles.
   */
  forget(workspaceId: WorkspaceId): Promise<void>
}
