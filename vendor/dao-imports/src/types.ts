/** Wire metadata for resumable knowledge imports; document bytes never appear in status responses. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DocumentImportFailure, DocumentImportFormat, DocumentImportSourceId, DocumentTextExtraction,
  DocumentImportDocxImageOmission } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ProjectSpaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { KnowledgeTruthReceipt } from '@deepseek-ai/dsh-api-knowledge-controller/types'

/** Caller-generated UUID retained across every retry of the same accepted selection. */
export type KnowledgeImportId = string & Branded<'KnowledgeImportId'>

/** Host-generated UUID proving which retained import created its Session. */
export type KnowledgeImportCreationClaim = string & Branded<'KnowledgeImportCreationClaim'>

/** Caller-generated UUID identifying one durable review decision retry. */
export type KnowledgeImportReviewId = string & Branded<'KnowledgeImportReviewId'>

/** Caller-retained UUID for one explicit held-draft save or later publication. */
export type KnowledgeImportDraftActionId = string & Branded<'KnowledgeImportDraftActionId'>

/** A proposed active creation held from publication until its missing review is resolved. */
export type KnowledgeImportHeldDraftReason = 'zero-hit-draft-required' | 'source-conflict-draft-required'
  | 'discovery-coverage-draft-required'

/** Save exactly one verified active-creation proposal as a held Brain draft, without approving the plan. */
export interface KnowledgeImportSaveDraftRequest {
  readonly operationId: KnowledgeImportDraftActionId
  readonly proposalMessageId: MessageId
  readonly expectedProposalSha256: string
  readonly changeIndex: number
  readonly expectedChangeSha256: string
}

/** Publish one held draft after a separate human confirmation of its current body and active page/root catalog. */
export interface KnowledgeImportPublishDraftRequest {
  readonly operationId: KnowledgeImportDraftActionId
  readonly draftOperationId: KnowledgeImportDraftActionId
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  /** Explicit judgments for every active page or root in the reviewed catalog; only distinct relations permit publication. */
  readonly reviewedPages: readonly KnowledgeImportHeldPageChoice[]
}

/** One human judgment bound to the exact catalog document identity seen before held-draft publication. */
export interface KnowledgeImportHeldPageChoice {
  readonly path: string
  readonly title: string
  readonly version: string
  readonly relation: 'distinct' | 'duplicate' | 'conflict' | 'unknown'
}

/** Exact held-draft and active-catalog document selected for a full-body read receipt. */
export interface KnowledgeImportHeldCatalogPageReadRequest {
  readonly draftOperationId: KnowledgeImportDraftActionId
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  readonly path: string
  readonly title: string
  readonly version: string
}

/** Publication-time comparison of the other active pages, after the held page becomes active. */
export type KnowledgeImportPublicationReview =
  | { readonly status: 'verified'; readonly observedActiveIndexDigest: string }
  | {
    readonly status: 'required'
    readonly reason: 'active-catalog-changed'
    readonly observedActiveIndexDigest: string
  }
  | {
    readonly status: 'unknown'
    readonly reason: 'catalog-unavailable' | 'receipt-recovered' | 'receipt-unconfirmed' | 'not-recorded'
  }

/** Durable held-draft result and current publication evidence shown to the reviewer. */
export interface KnowledgeImportHeldDraft {
  readonly operationId: KnowledgeImportDraftActionId
  readonly proposalMessageId: MessageId
  readonly proposalSha256: string
  readonly changeIndex: number
  readonly changeSha256: string
  readonly targetProjectId: WorkspaceId
  readonly path: string
  readonly sourceDocumentId: DocumentImportSourceId
  readonly sourceQuote: string
  /** Historical receipts without a reason were created by the zero-hit route. */
  readonly reason?: KnowledgeImportHeldDraftReason
  readonly phase: 'saving' | 'saved' | 'edited' | 'published' | 'conflict'
  readonly savedVersion?: string
  readonly current?: {
    readonly version: string
    readonly body: string
    readonly title: string
    readonly activeIndexDigest: string
    readonly activePageCount: number
    /** Complete current active pages and roots; each body still requires a version-matched read. */
    readonly activePages: readonly { readonly path: string; readonly title: string; readonly version: string }[]
  }
  readonly publicationOperationId?: KnowledgeImportDraftActionId
  readonly publishedVersion?: string
  /** A missing historical comparison or interrupted receipt never means the catalog was verified. */
  readonly publicationReview?: KnowledgeImportPublicationReview
  /** Retained uncertain publication intent; the same fields must be reused after Client loss. */
  readonly pendingPublication?: {
    readonly operationId: KnowledgeImportDraftActionId
    readonly expectedDraftVersion: string
    readonly expectedActiveIndexDigest: string
    /** Absent on historical intents, which cannot authorize a new publication retry. */
    readonly reviewedPages?: readonly KnowledgeImportHeldPageChoice[]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Initial import identity record; it does not enter model history. */
    'knowledge-import/creation-claim': {
      readonly importId: KnowledgeImportId
      readonly workspaceId: WorkspaceId
      readonly spaceId: ProjectSpaceId | null
      readonly claim: KnowledgeImportCreationClaim
    }
    /** Durable ordering point for one v6 review approval; this event does not enter model history. */
    'knowledge-import/review-approved': {
      readonly importId: KnowledgeImportId
      readonly operationId: KnowledgeImportReviewId
      readonly proposalMessageId: MessageId
    }
  }
}

/** Explicit decision over the latest settled assistant proposal and its listed Brain changes. */
export interface KnowledgeImportReviewDecision {
  readonly operationId: KnowledgeImportReviewId
  readonly decision: 'approve' | 'reject'
  readonly proposalMessageId: MessageId
  /** Digest of the complete proposal text shown when this decision was prepared. */
  readonly expectedProposalSha256: string
  readonly expectedRevision: number
  /** Required for v5/v6 active creations with compared pages; binds the displayed user choices. */
  readonly expectedComparedPageReviewSha256?: string
  /** Required for v6 active changes; binds each selected source's explicit human assessment. */
  readonly expectedSourceDispositionReviewSha256?: string
}

/** One human assessment of a model-labelled source, bound to its exact quote and rationale. */
export interface KnowledgeImportSourceDispositionChoice {
  readonly changeIndex: number
  readonly sourceIndex: number
  readonly changeSha256: string
  readonly documentId: DocumentImportSourceId
  readonly dispositionSha256: string
  readonly judgment: 'unknown' | 'confirmed' | 'disputed'
}

/** Durable or synthesized source assessments for one exact proposal. */
export interface KnowledgeImportSourceDispositionReview {
  readonly choices: readonly KnowledgeImportSourceDispositionChoice[]
  readonly sha256: string
}

/** Replace one source assessment without approving its proposed Brain change. */
export interface KnowledgeImportSourceDispositionDecision extends KnowledgeImportSourceDispositionChoice {
  readonly proposalMessageId: MessageId
  readonly expectedProposalSha256: string
  readonly expectedReviewSha256: string
}

/** Human judgment about one exact Host-verified comparison, never a semantic Host finding. */
export interface KnowledgeImportComparedPageChoice {
  readonly changeIndex: number
  readonly pageIndex: number
  readonly changeSha256: string
  readonly targetProjectId: WorkspaceId
  readonly path: string
  readonly version: string
  readonly pageSha256: string
  readonly relation: 'distinct' | 'duplicate' | 'conflict' | 'unknown'
}

/** Durable or synthesized choices for one exact proposal. Missing choices default to unknown. */
export interface KnowledgeImportComparedPageReview {
  readonly choices: readonly KnowledgeImportComparedPageChoice[]
  readonly sha256: string
}

/** Exact comparison selected for a complete Host read; this request grants no relation judgment. */
export type KnowledgeImportComparedPageReadRequest = Omit<KnowledgeImportComparedPageDecision, 'relation'>

/** Complete current page or fixed-root body served for the selected comparison and retained as a Host read receipt. */
export interface KnowledgeImportComparedPageRead {
  readonly kind: 'page' | 'root'
  readonly path: string
  readonly version: string
  readonly body: string
}

/** Explicit replacement of one compared-page judgment; all identities come from Host inspection. */
export interface KnowledgeImportComparedPageDecision {
  readonly proposalMessageId: MessageId
  readonly expectedProposalSha256: string
  readonly expectedReviewSha256: string
  readonly changeIndex: number
  readonly pageIndex: number
  readonly changeSha256: string
  readonly targetProjectId: WorkspaceId
  readonly path: string
  readonly version: string
  readonly pageSha256: string
  readonly relation: KnowledgeImportComparedPageChoice['relation']
}

/** One exact Brain tool call, including its complete parsed arguments and canonical digest. */
export interface KnowledgeImportReviewChange {
  readonly tool: string
  readonly arguments: Readonly<Record<string, JsonValue>>
  readonly sha256: string
  /** Model-selected relationships; Host verifies the cited source text and complete page reads, not semantic truth. */
  readonly evidence?: {
    readonly sources: readonly { readonly document_id: DocumentImportSourceId; readonly quote: string }[]
    /** V6 model assessments for every selected source; quotes are checked, classifications remain human-reviewed. */
    readonly source_dispositions?: readonly { readonly document_id: DocumentImportSourceId
      readonly disposition: 'current' | 'superseded' | 'unresolved' | 'not-relevant'
      readonly quote: string
      readonly rationale: string }[]
    readonly compared_pages: readonly {
      readonly target_project_id: WorkspaceId
      readonly path: string
      readonly version: string
      readonly relation: 'duplicate' | 'conflict' | 'supports' | 'supersedes'
      /** Verbatim current-understanding text required by v3–v6; historical v2 reviews omit it. */
      readonly quote?: string
    }[]
  }
}

/** Host-observed v5/v6 topical search or a complete empty Brain index for one active creation. */
export interface KnowledgeImportDiscovery {
  readonly changeIndex: number
  readonly targetProjectId: WorkspaceId
  readonly mode: 'search' | 'empty-index'
  /** The model's declared query, matched to a completed search in the retained Session log. */
  readonly query?: string | undefined
  readonly exists: boolean
  readonly hits: readonly { readonly path: string; readonly title: string; readonly version: string }[]
}

/** Complete logged title search retained for human review of a zero-hit topical proposal. */
export interface KnowledgeImportTitleSearch {
  readonly targetProjectId: WorkspaceId
  readonly query: string
  readonly exists: boolean
  readonly hits: readonly { readonly path: string; readonly title: string; readonly version: string }[]
}

/** Durable approval summary; full proposed arguments remain in the Session proposal. */
export interface KnowledgeImportApprovedChange {
  readonly tool: string
  readonly targetProjectId: WorkspaceId
  readonly path: string | string[]
  readonly sha256: string
}

/** One v4–v6 ordered step committed by the Brain writer and then durably acknowledged by the import Host. */
export interface KnowledgeImportAppliedStep {
  readonly index: number
  readonly changeSha256: string
  readonly operationId: string
  readonly targetProjectId: WorkspaceId
  readonly path: string
  readonly postVersion: string
  readonly postActiveIndexDigest: string
}

/** Host-verified execution state for a v4–v6 mixed plan or v5/v6 single active creation. */
export interface KnowledgeImportReviewExecution {
  readonly status: 'awaiting-approval' | 'ready' | 'partially-applied' | 'complete' | 'blocked'
  readonly nextChangeIndex: number
  readonly appliedSteps: readonly KnowledgeImportAppliedStep[]
  readonly reason?: 'step-receipt-missing' | 'step-receipt-stale' | 'active-index-changed'
    | 'root-catalog-review-required'
    | 'candidate-search-changed' | 'compared-page-changed' | 'review-rejected'
    | 'discovery-search-changed' | 'discovery-empty-index-changed' | 'self-declared-overlap-unresolved'
    | 'compared-page-review-required' | KnowledgeImportHeldDraftReason
    | 'missing-source-dispositions' | 'invalid-source-dispositions'
    | 'source-review-required'
}

/** Current Host admission for exact reviewed Brain changes and separately confirmed task proposals. */
export interface KnowledgeImportReviewState {
  readonly revision: number
  /** Exact accepted decision retry identity for recovery after a lost response. */
  readonly operationId: KnowledgeImportReviewId
  readonly decision: 'approved' | 'rejected'
  readonly proposalMessageId: MessageId
  readonly proposalSha256: string
  /** Absent on historical decisions; such approvals grant no further writes. */
  readonly changes?: readonly KnowledgeImportApprovedChange[]
  readonly changesSha256?: string
  /** Digest of v5/v6 discovery projected from retained tool results; omitted for older formats. */
  readonly discoverySha256?: string
  /** Exact user judgments retained with approval for cold pending active-creation admission. */
  readonly comparedPageReviewSha256?: string
  /** Exact per-source human assessments captured by this approval. */
  readonly sourceDispositionReviewSha256?: string
  /** Persisted Brain writer results for an approved v4–v6 ordered proposal. */
  readonly appliedSteps?: readonly KnowledgeImportAppliedStep[]
  /** False when a v6 approval needs an explicit revoke-and-reapprove recovery before any further Brain write. */
  readonly confirmationBoundaryReady?: boolean
  readonly decidedAt: number
}

/** Import metadata and latest settled proposal recovered from a Session identity. */
export interface KnowledgeImportReviewLookup {
  readonly importId: KnowledgeImportId
  readonly workspaceId: WorkspaceId
  readonly state: KnowledgeImportState
  /** A real Brain draft retained under an import-specific publication hold. */
  readonly zeroHitDraft?: KnowledgeImportHeldDraft
  readonly proposal: {
    readonly messageId: MessageId
    readonly text: string
    readonly sha256: string
    readonly changes: readonly KnowledgeImportReviewChange[] | null
    /** Legacy v1 imports retain their original approval format. */
    readonly format: 'brain-review-json-v1' | 'brain-review-json-v2' | 'brain-review-json-v3' | 'brain-review-json-v4' | 'brain-review-json-v5' | 'brain-review-json-v6'
    /** V5/v6 discoveries come from logged search results or a complete empty index, never model-reported hits. */
    readonly discovery?: readonly KnowledgeImportDiscovery[]
    /** Host-verified exact-title receipt; zero topical hits still require a held draft. */
    readonly zeroHitTitleSearch?: KnowledgeImportTitleSearch
    /** Host-persisted judgments, with unknown defaults, for active-creation compared pages. */
    readonly comparedPageReview?: KnowledgeImportComparedPageReview
    /** Model source classifications begin unknown until each is explicitly confirmed or disputed. */
    readonly sourceDispositionReview?: KnowledgeImportSourceDispositionReview
    /** Present for a strict v4–v6 mixed plan or v5/v6 single active creation. */
    readonly execution?: KnowledgeImportReviewExecution
    /** Exact source and read records and current compared-page versions; semantic relationships are not verified. */
    readonly verification: {
      readonly status: 'verified' | 'invalid'
      readonly reason?: 'invalid-format' | 'source-not-in-selection' | 'source-quote-not-found'
        | 'compared-page-not-read' | 'compared-page-changed' | 'missing-target-comparison'
        | 'missing-candidate-search' | 'candidate-search-incomplete' | 'candidate-page-not-read'
        | 'candidate-search-changed' | 'duplicate-active-title' | 'active-index-incomplete' | 'mixed-versioned-review'
        | 'root-catalog-review-required'
        | 'compared-page-quote-missing' | 'compared-page-quote-not-found'
        | 'step-receipt-missing' | 'step-receipt-stale' | 'active-index-changed' | 'review-rejected'
        | 'missing-discovery-search' | 'discovery-search-incomplete' | 'discovery-query-is-title'
        | 'discovery-page-not-read' | 'discovery-search-changed' | 'discovery-empty-index-changed'
        | 'too-many-active-creations' | 'self-declared-overlap-unresolved'
        | 'self-declared-update-overlap-unresolved' | 'self-declared-root-overlap-unresolved'
        | 'self-declared-status-overlap-unresolved'
        | 'compared-page-review-required' | KnowledgeImportHeldDraftReason
        | 'missing-source-dispositions' | 'invalid-source-dispositions'
        | 'source-review-required'
    }
    /** A retained v2 approval lacks the active-index receipt required for new active pages. */
    readonly approvalNeedsRenewal?: boolean
  } | null
}

/** Original PDF or DOCX bytes released only for one exact retained import Session and selected document. */
export interface KnowledgeImportReviewSource {
  readonly id: DocumentImportSourceId
  readonly name: string
  readonly format: 'pdf' | 'docx'
  readonly bytes: number
  readonly sha256: string
  readonly dataBase64: string
}

/** Exact imported document chosen by a person for an ordinary Task's later independent knowledge review. */
export interface KnowledgeImportTaskSourceSelection {
  readonly importId: KnowledgeImportId
  readonly sessionId: SessionId
  readonly documentId: DocumentImportSourceId
}

/** Metadata-only eligible documents; listing grants neither source bytes nor Task execution. */
export interface KnowledgeImportTaskSourceGroup {
  readonly importId: KnowledgeImportId
  readonly sessionId: SessionId
  readonly documents: readonly (KnowledgeImportDocument & { readonly extraction?: DocumentTextExtraction | undefined })[]
}

/** Actual reviewer route and remaining image budget; omission verifies source bytes without rendering. */
export interface KnowledgeImportTaskSourceReadOptions {
  readonly imageCapable: boolean
  /** Remaining PDF page-image and DOCX embedded-image count for the complete Task request. */
  readonly maxImages: number
  readonly maxTotalBytes: number
}

/** Original-page image references supplied only after an explicitly visual Task-review read. */
export interface KnowledgeImportTaskPdfVisualEvidence {
  readonly coverage: KnowledgeImportPdfVisualCoverage
  readonly images: readonly { readonly page: number; readonly attachment: ImageAttachmentRef }[]
}

/** Embedded-image references preserve converter numbering without inventing Word page coordinates. */
export interface KnowledgeImportTaskDocxVisualEvidence {
  readonly coverage: KnowledgeImportDocxVisualCoverage
  readonly images: readonly ImageAttachmentRef[]
}

/** Original-byte-verified conversion and optional PDF/DOCX visual evidence for a selected Task reviewer. */
export interface KnowledgeImportTaskSource extends KnowledgeImportTaskSourceSelection {
  readonly name: string
  readonly format: DocumentImportFormat
  readonly bytes: number
  readonly sourceSha256: string
  readonly text: string
  readonly textBytes: number
  readonly textSha256: string
  readonly extraction?: DocumentTextExtraction | undefined
  readonly pdfVisual?: KnowledgeImportTaskPdfVisualEvidence | undefined
  readonly docxVisual?: KnowledgeImportTaskDocxVisualEvidence | undefined
}

/** Stable admission and conversion failures; transport/storage failures remain separate. */
export type KnowledgeImportFailure = DocumentImportFailure
  | 'too-many-documents' | 'source-too-large' | 'batch-too-large' | 'selection-changed'
  | 'document-not-in-selection' | 'source-changed' | 'invalid-base64'
  | 'converted-batch-too-large' | 'project-changed' | 'import-not-found' | 'documents-not-ready'
  | 'image-required' | 'visual-unreadable'
  | 'session-unverified'
  | 'review-not-ready' | 'proposal-changed' | 'review-revision-changed' | 'review-operation-changed'
  | 'compared-page-review-required' | 'compared-page-not-read' | 'compared-page-changed'
  | 'source-review-required'
  | 'draft-operation-changed' | 'draft-not-ready' | 'draft-publication-changed'
  | 'writer-busy'
  | 'import-abandoned' | 'import-already-started'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Logged knowledge compilation input, independent of ordinary user input. */
    'knowledge-import': { readonly kind: 'knowledge-import'; readonly importId: KnowledgeImportId }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'knowledge-import/rejected': { readonly reason: KnowledgeImportFailure; readonly writerLockPath?: string }
  }
}

/** One frozen source; its digest covers decoded original bytes, not the display name or base64 spelling. */
export interface KnowledgeImportDocument {
  readonly id: DocumentImportSourceId
  readonly name: string
  readonly format: DocumentImportFormat
  readonly bytes: number
  readonly sha256: string
}

/** Complete ordered selection submitted before uploading individual documents. */
export interface KnowledgeImportManifest {
  readonly id: KnowledgeImportId
  readonly locale: 'en' | 'zh-CN'
  /** Omission retains the original explicit project destination; workspace scope is frozen before upload. */
  readonly scope?: { readonly kind: 'workspace'; readonly spaceId: ProjectSpaceId } | undefined
  /** Explicit new-import policy; omission retains historical review and publication requirements. */
  readonly maintenance?: 'automatic' | 'read-only' | undefined
  readonly documents: readonly KnowledgeImportDocument[]
}

/** Host-owned automatic progress; receipts name actual file writes, not proposed model output. */
export interface KnowledgeImportAutomaticState {
  readonly status: 'reviewing' | 'applying' | 'updated' | 'no-change' | 'deferred' | 'failed' | 'budget-stopped'
  readonly rounds: number
  readonly writes: readonly Pick<KnowledgeTruthReceipt, 'documentId' | 'version' | 'operationId'>[]
  readonly reason?: 'conflict' | 'source-incomplete' | 'catalog-changed' | 'disabled' | 'unavailable' | 'unknown' | 'invalid-review' | 'repeated-candidate' | undefined
  /** The retained exact owner can be resumed; this does not authorize publishing historical held drafts. */
  readonly recoverable: boolean
}

/** Durable preparation receipt; reserving a Session id does not create that Session. */
export interface KnowledgeImportState {
  readonly id: KnowledgeImportId
  readonly sessionId: SessionId
  /** Observed from Session storage; a failed compile may create a Session without accepting its input. */
  readonly sessionCreated: boolean
  /** An unaccepted Session needs manual recovery; only a retained binding permits same-identity retry. */
  readonly sessionRecovery?: 'delivery-unconfirmed' | 'identity-unconfirmed'
  /** Observation hint for exact creation-only import abandonment; mutation rechecks and does not cancel other Session input. */
  readonly createdAbandonable?: true
  readonly locale: 'en' | 'zh-CN'
  /** Actual retained destination, independent of the Client's currently selected project. */
  readonly scope?: { readonly kind: 'workspace'; readonly spaceId: ProjectSpaceId } | undefined
  readonly maintenance?: KnowledgeImportManifest['maintenance']
  readonly automatic?: KnowledgeImportAutomaticState | undefined
  /** Accepted means durably queued, not that knowledge generation succeeded; abandoned retains all source receipts. */
  readonly status: 'preparing' | 'ready' | 'accepted' | 'abandoned'
  /** Present only after an explicit abandon decision; any created Session and attachments remain. */
  readonly abandonedAt?: number
  /** Omission means no explicit Host decision has been recorded. */
  readonly review?: KnowledgeImportReviewState
  /** Publication progress survives Client restart without exposing source attachment bytes. */
  readonly zeroHitDraft?: Omit<KnowledgeImportHeldDraft, 'current'>
  readonly documents: readonly (KnowledgeImportDocument & {
    readonly status: 'pending' | 'stored'
    /** Stored PDF or DOCX text coverage; omission on a stored converted document means coverage is unknown. */
    readonly extraction?: DocumentTextExtraction
    /** Original PDF page images supplied to the frozen review, not a claim that the model understood them. */
    readonly visual?: KnowledgeImportPdfVisualCoverage
    /** Supplied embedded DOCX images, not Word pages or proof of complete visual understanding. */
    readonly docxVisual?: KnowledgeImportDocxVisualCoverage
  })[]
}

/** Durable account of which original PDF pages were supplied as image blocks. */
export interface KnowledgeImportPdfVisualCoverage {
  readonly pageCount: number
  readonly renderedPages: readonly number[]
  readonly omittedReason?: 'text-only-route' | 'page-limit' | 'byte-limit' | 'render-failed' | undefined
}

/** Actual Mammoth-emitted images supplied to a frozen review; unextracted drawings remain unknown. */
export interface KnowledgeImportDocxVisualCoverage {
  readonly imageCount: number
  readonly suppliedImages: readonly number[]
  readonly omittedImages: readonly { readonly image: number; readonly reason: DocumentImportDocxImageOmission }[]
  /** Embedded raster extraction does not inspect Word page layout, charts or every drawing. */
  readonly layoutReviewed: false
}
