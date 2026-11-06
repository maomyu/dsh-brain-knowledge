/** Explicit compilation gestures and metadata-only progress; document bytes remain in private operations. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KnowledgeImportComparedPageDecision, KnowledgeImportComparedPageRead,
  KnowledgeImportSourceDispositionDecision,
  KnowledgeImportComparedPageReadRequest, KnowledgeImportFailure, KnowledgeImportId, KnowledgeImportManifest, KnowledgeImportReviewDecision,
  KnowledgeImportSaveDraftRequest, KnowledgeImportPublishDraftRequest,
  KnowledgeImportHeldCatalogPageReadRequest,
  KnowledgeImportReviewLookup, KnowledgeImportReviewSource, KnowledgeImportState } from '../types.ts'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'

/** Persisted by the calling UI before submission, including when delivery acknowledgement is lost. */
export interface KnowledgeImportIntent {
  readonly id: KnowledgeImportId
  readonly locale: 'en' | 'zh-CN'
  readonly scope?: KnowledgeImportManifest['scope']
  readonly maintenance?: KnowledgeImportManifest['maintenance']
}

/** Local failures join Host refusal reasons without publishing exception text or document contents. */
export type KnowledgeImportSubmissionFailure = KnowledgeImportFailure | 'documents-required' | 'remote-failed' | 'cancelled'

/** Latest observed receipt and the current request, not the model's compilation outcome. */
export interface KnowledgeImportSubmission {
  readonly workspaceId: WorkspaceId
  /** Project-owned preparation captured for this submission, independent of its destination. */
  readonly draftWorkspaceId: WorkspaceId
  readonly intent: KnowledgeImportIntent
  readonly phase: 'idle' | 'checking' | 'hashing' | 'uploading' | 'compiling'
  readonly receipt: KnowledgeImportState | null
  readonly failure: KnowledgeImportSubmissionFailure | null
}

/** Client-lifetime progress; persisted receipts remain owned by the Host. */
export interface KnowledgeImportSubmissionSnapshot {
  readonly projects: readonly KnowledgeImportSubmission[]
}

/** One Session's Host-owned review observation; absence means it is not an import Session. */
export interface KnowledgeImportReviewObservation {
  readonly sessionId: SessionId
  readonly phase: 'loading' | 'ready' | 'deciding' | 'failed'
  readonly lookup: KnowledgeImportReviewLookup | null
  readonly failure: KnowledgeImportFailure | 'remote-failed' | null
  /** Exact Host writer-lock path for a busy failure; informational, never a deletion instruction. */
  readonly writerLockPath?: string
}

/** Review observations remain metadata-only until the exact proposal is requested from the Host. */
export interface KnowledgeImportReviewSnapshot {
  readonly sessions: readonly KnowledgeImportReviewObservation[]
}

/** Submit complete prepared selections to the Host; no operation starts merely by subscribing. */
export interface IKnowledgeImports {
  readonly state: ObservableSnapshot<KnowledgeImportSubmissionSnapshot>
  readonly reviews: ObservableSnapshot<KnowledgeImportReviewSnapshot>
  /**
   * Read unfinished selections owned by a project, excluding accepted and abandoned imports.
   * Session-created rows remain inspectable; only Host-verified ownership permits their exact retry.
   * @param workspaceId - registered project owning the selections.
   * @param signal - cancels this observation and suppresses a late result.
   * @returns metadata-only receipts; each later action rechecks recoverability on the Host.
   */
  listPending(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly KnowledgeImportState[]>
  /**
   * Explicitly retire a selection before any Session exists, retaining its record and attachments.
   * @param workspaceId - original registered project.
   * @param importId - retained selection identity.
   * @param signal - caller cancellation; a committed tombstone can be recovered with inspect.
   * @returns durable abandoned receipt; an uncertain result is resolved through inspect.
   */
  abandon(workspaceId: WorkspaceId, importId: KnowledgeImportId, signal: AbortSignal): Promise<KnowledgeImportState>
  /**
   * Read a retained receipt without capturing sources, uploading, compiling, or changing submission progress.
   * @param workspaceId - original registered destination project.
   * @param intent - saved import identity, language, and scope to verify against the receipt.
   * @param signal - cancels observation; the existing Host metadata read is not interruptible.
   * @returns metadata, or null for a missing receipt; cancellation, reset, and mismatched scope reject.
   */
  inspect(workspaceId: WorkspaceId, intent: KnowledgeImportIntent, signal: AbortSignal): Promise<KnowledgeImportState | null>
  /**
   * Read the latest exact settled proposal and durable decision without running a model.
   * @param sessionId - possible source import Session.
   * @param signal - cancels observation and retires its result.
   * @returns after the Session observation is published.
   */
  inspectReview(sessionId: SessionId, signal: AbortSignal): Promise<void>
  /**
   * Fetch one original visual document for explicit human review; no model turn or publication occurs.
   * @param sessionId - exact retained import Session.
   * @param documentId - frozen selection's PDF or DOCX identity.
   * @param signal - cancels the read and suppresses a late result after Client disposal.
   * @returns verified original bytes encoded for transport.
   */
  readReviewSource(sessionId: SessionId, documentId: DocumentImportSourceId,
    signal: AbortSignal): Promise<KnowledgeImportReviewSource>
  /** Serve a complete version-matched compared page or fixed root and retain the Host's proposal-specific read receipt.
   * @param sessionId - exact import conversation under review.
   * @param request - current proposal and compared-page identity.
   * @param signal - cancels the read; a committed Host receipt may survive an uncertain response.
   * @returns full Brain document body, without deciding its semantic relation.
   */
  readComparedPage(sessionId: SessionId, request: KnowledgeImportComparedPageReadRequest,
    signal: AbortSignal): Promise<KnowledgeImportComparedPageRead>
  /** Read and receipt one full active-page or fixed-root body against the retained import draft and current catalog.
   * @param sessionId - exact retained import conversation.
   * @param request - draft, catalog, and page identity shown to the reviewer.
   * @param signal - cancels the read; an accepted Host receipt may survive a lost response.
   * @returns the complete version-matched body; this does not approve publication.
   */
  readHeldDraftCatalogPage(sessionId: SessionId, request: KnowledgeImportHeldCatalogPageReadRequest,
    signal: AbortSignal): Promise<KnowledgeImportComparedPageRead>
  /**
   * Persist one user's exact related-page judgment without approving knowledge publication.
   * @param sessionId - retained import Session carrying the Host-verified proposal.
   * @param request - observed proposal, page identity, and optimistic choice digest.
   * @param signal - cancels the attempt; a committed judgment remains recoverable by inspection.
   * @returns whether the requested relation is present in the refreshed Host observation.
   */
  setComparedPageDecision(sessionId: SessionId, request: KnowledgeImportComparedPageDecision,
    signal: AbortSignal): Promise<boolean>
  /** Persist one explicit source-assessment judgment before active knowledge approval.
   * @param sessionId - retained import Session carrying the exact proposal.
   * @param request - source quote/classification identity and optimistic review digest.
   * @param signal - cancels the attempt; a committed choice remains recoverable by inspection.
   * @returns whether the refreshed Host observation contains the judgment.
   */
  setSourceDispositionDecision(sessionId: SessionId, request: KnowledgeImportSourceDispositionDecision,
    signal: AbortSignal): Promise<boolean>
  /**
   * Submit an explicit decision and recover an uncertain response through the same Session lookup.
   * @param sessionId - source import Session containing the displayed proposal.
   * @param request - retained operation, proposal identity, and revision.
   * @param signal - cancels the Client decision attempt.
   * @returns whether the durable decision was observed under this operation id.
   */
  decideReview(sessionId: SessionId, request: KnowledgeImportReviewDecision, signal: AbortSignal): Promise<boolean>
  /** Save the exact verified zero-hit creation as a held Brain draft; uncertain results are inspected before retry.
   * @param sessionId - original import Session.
   * @param request - retained save operation and exact proposal change.
   * @param signal - cancels the Client observation, not a committed Brain write.
   * @returns whether the draft writer receipt is durably visible.
   */
  saveZeroHitDraft(sessionId: SessionId, request: KnowledgeImportSaveDraftRequest, signal: AbortSignal): Promise<boolean>
  /** Release a held draft only for a separate explicit publication operation and observed Brain versions.
   * @param sessionId - original import Session.
   * @param request - retained publication identity, exact draft version and active catalog digest.
   * @param signal - cancels the Client observation, not a committed Brain write.
   * @returns whether the publication writer receipt is durably visible.
   */
  publishZeroHitDraft(sessionId: SessionId, request: KnowledgeImportPublishDraftRequest, signal: AbortSignal): Promise<boolean>
  /**
   * Inspect the retained identity, upload missing exact sources, then explicitly queue compilation.
   * @param workspaceId - registered destination project captured by the gesture.
   * @param intent - identity and language saved by the caller before any network request.
   * @param draftWorkspaceId - preparation owner whose exact sources are captured synchronously;
   * changing destinations does not move its drafts.
   * @returns accepted receipt, or null after a published failure, cancellation, or refused concurrent admission.
   */
  submit(workspaceId: WorkspaceId, intent: KnowledgeImportIntent, draftWorkspaceId: WorkspaceId): Promise<KnowledgeImportState | null>
  /**
   * Abort and join the active request; already delivered input is not retracted.
   * @param workspaceId - destination project whose current submission should stop.
   * @returns after that operation settles; the caller must retain its retry identity.
   */
  cancel(workspaceId: WorkspaceId): Promise<void>
  /**
   * Remove local progress and prevent late publication after project removal or successful navigation.
   * @param workspaceId - destination project to release, without deleting Host records or the caller's retry identity.
   * @returns after the removed operation settles.
   */
  forget(workspaceId: WorkspaceId): Promise<void>
  /**
   * Release local progress and invalidate pending receipt observations when the connection resets.
   * Abort active submissions and source reads before joining either; retained retry identities remain caller-owned.
   * @returns after active submissions and source reads settle; uninterruptible metadata reads cannot publish their results.
   */
  clear(): Promise<void>
}
