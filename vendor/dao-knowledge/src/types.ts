/** Session-independent knowledge document identities and wire values. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectGoalRequestId, ProjectGoalRunId, ProjectTaskId, ProjectTaskKnowledgeCandidateId } from '@deepseek-ai/dsh-api-task-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Project Brain context retained in an ordinary conversation.
     * @persistenceAttribution
     */
    'project-brain': { readonly kind: 'project-brain' } & ContextFormed
    /** Historical Brain context retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-brain': { readonly kind: 'plugin:project-brain' } & ContextFormed
    /** Selected conversation projects, without additional write authority.
     * @persistenceAttribution
     */
    'conversation-project-focus': { readonly kind: 'conversation-project-focus' } & ContextFormed
    /** Historical project selection retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:conversation-project-focus': { readonly kind: 'plugin:conversation-project-focus' } & ContextFormed
    /** Host-authored health review input, not a human evidence quote.
     * @persistenceAttribution
     */
    'brain-health': { readonly kind: 'brain-health' } & ContextFormed
    /** Historical health review input retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:brain-health': { readonly kind: 'plugin:brain-health' } & ContextFormed
    /** Logged project knowledge review instructions; this source grants no writing permission.
     * @persistenceAttribution
     */
    'project-brain-curation-check': {
      readonly kind: 'project-brain-curation-check'
      /** Explicit automatic reviews restrict execution; absent historical values retain manual behavior. */
      readonly reviewKind?: 'automatic' | 'manual'
    } & ContextFormed
    /** Tool-free independent AI maintenance review; this input is not a user confirmation.
     * @persistenceAttribution
     */
    'brain-maintenance': { readonly kind: 'brain-maintenance' } & ContextFormed
    /** Historical review attribution retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-brain-curation-check': { readonly kind: 'plugin:project-brain-curation-check' } & ContextFormed
  }
}

/** One retained conversation reference, not permission to read a project or proof of current page contents. */
export interface KnowledgeConversationReference {
  readonly project: { readonly kind: 'id'; readonly value: WorkspaceId }
    | { readonly kind: 'path' | 'selector'; readonly value: string }
    | { readonly kind: 'unqualified' }
  readonly resource: { readonly kind: 'document'; readonly path: KnowledgeDocumentId }
    | { readonly kind: 'slug'; readonly slug: string }
  readonly source: 'user' | 'assistant' | 'read-request' | 'read'
  /** Native or PTC read identity retained only to correlate its settled output. */
  readonly callId: ToolCallId | null
}

/** Review completion reconstructed from logged input and Assistant output, independent of Brain writes. */
export interface KnowledgeReviewStatusState {
  /** A logged review has not produced a completed answer. */
  readonly unfinished: boolean
  /** The review input entered model history and can own a later answer. */
  readonly admitted: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Newest distinct knowledge references across the complete retained Session log. */
    knowledgeReferences: readonly KnowledgeConversationReference[]
    /** A logged conversation knowledge review has not produced a completed answer; this says nothing about saved files. */
    knowledgeReviewUnfinished: boolean
  }
  interface SessionProjectionStateMap {
    /** Rebuilt from retained review inputs and settled Assistant output. */
    knowledgeReviewUnfinished: KnowledgeReviewStatusState
  }
}

/** Brain-relative Markdown path; the Host validates every path component. */
export type KnowledgeDocumentId = Branded<'KnowledgeDocumentId'>

/** Receipt for a complete derived page catalog; pages and access counts are unchanged. */
export interface KnowledgeReindexResult {
  readonly path: 'index.md'
  readonly count: number
  readonly version: string
}

/** Caller-retained UUID identifying one complete knowledge update across retries. */
export type KnowledgeUpdateId = Branded<'KnowledgeUpdateId'>

/** Host-issued automatic-maintenance permission frozen by the owning conversation, Task, Goal or import. */
export type KnowledgeAutomaticAuthorizationId = Branded<'KnowledgeAutomaticAuthorizationId'>

/** Import-owner identity retained without granting that import a generic Brain writer. */
export type KnowledgeAutomaticImportId = Branded<'KnowledgeImportId'>

/** Original source identity; this permission is distinct from a historical human decision. */
export type KnowledgeAutomaticAuthority = {
  readonly authorizationId: KnowledgeAutomaticAuthorizationId
  readonly sourceSessionId: SessionId
} & (
  | { readonly kind: 'conversation'; readonly messageId: MessageId }
  | { readonly kind: 'task'; readonly taskId: ProjectTaskId; readonly taskSessionId: SessionId; readonly candidateId: ProjectTaskKnowledgeCandidateId }
  | { readonly kind: 'goal'
    readonly goalRunId: ProjectGoalRunId
    readonly planRequestId: ProjectGoalRequestId
    readonly taskId: ProjectTaskId
    readonly taskSessionId: SessionId
    readonly candidateId: ProjectTaskKnowledgeCandidateId }
  | { readonly kind: 'import'; readonly importId: KnowledgeAutomaticImportId }
)

/** Complete AI-authored maintenance intent supplied after a durably logged independent review. */
export interface KnowledgeAutomaticMaintenanceRequest {
  readonly operationId: KnowledgeUpdateId
  readonly authority: KnowledgeAutomaticAuthority
  readonly reviewerSessionId: SessionId
  readonly resultSha256: string
  readonly candidateSha256: string
  readonly locationRevision: string | null
  readonly catalogSha256: string
  /** Incomplete visual, opaque or omitted sources cannot authorize an active write. */
  readonly sourceCoverage: 'complete' | 'incomplete'
  readonly sources: readonly { readonly sourceId: string; readonly text: string }[]
  readonly sourceDispositions: readonly {
    readonly sourceId: string
    readonly disposition: 'current' | 'superseded' | 'unresolved' | 'not-relevant'
    readonly quote?: string | undefined
    readonly rationale: string
  }[]
  readonly comparedPages: readonly {
    readonly path: string
    readonly version: string
    readonly relation: 'unrelated' | 'unknown' | 'duplicate' | 'conflict' | 'supports' | 'supersedes'
    readonly quote?: string | undefined
    readonly reason?: string | undefined
  }[]
  readonly titleSearch: { readonly query: string; readonly hits: readonly { readonly path: string; readonly version: string }[] }
  readonly topicSearch?: {
    readonly query: string
    readonly hits: readonly { readonly path: string; readonly version: string }[]
  } | undefined
  readonly change: {
    readonly documentId: KnowledgeDocumentId
    readonly truth: string
    readonly summary: string
    readonly evidence: string
  } & (
    | { readonly kind: 'update'
      readonly expectedVersion: string
      /** Original conversation's evidence category; omission preserves older AI evidence records. */
      readonly entryKind?: KnowledgeTruthUpdate['kind'] | undefined }
    | { readonly kind: 'create'; readonly title: string; readonly category: KnowledgePageCreate['category']; readonly tags: readonly string[] }
    | { readonly kind: 'merge'
      readonly expectedVersion: string
      readonly sourceDocumentId: KnowledgeDocumentId
      readonly sourceExpectedVersion: string
      readonly reason: string }
  )
}

/** Retained identity and optional explanation of a completed independent assessment. */
export interface KnowledgeAutomaticReview {
  /** Session retaining the complete independent assessment. */
  readonly reviewerSessionId: SessionId
  /** SHA-256 of the settled visible assessment text. */
  readonly resultSha256: string
  /** Specific unsupported claim or contradiction; absent when the assessment supplied none. */
  readonly reason?: string | undefined
}

/** Automatic maintenance never treats incomplete evidence or an uncertain relation as permission to replace active knowledge. */
export type KnowledgeAutomaticMaintenanceResult =
  | { readonly status: 'applied'; readonly receipt: KnowledgeTruthReceipt }
  | { readonly status: 'deferred'; readonly reason: 'conflict' | 'source-incomplete' | 'catalog-changed' | 'disabled'; readonly review?: KnowledgeAutomaticReview | undefined }

/** Exact file-receipt inspection; unknown is not permission to replay or use another UUID. */
export type KnowledgeAutomaticMaintenanceInspection = KnowledgeAutomaticMaintenanceResult
  | { readonly status: 'absent' }
  | { readonly status: 'unknown' }

/** A completed independent conversation review may retain no new page without claiming a file receipt. */
export type KnowledgeAutomaticConversationResult = KnowledgeAutomaticMaintenanceResult
  | { readonly status: 'no-change'; readonly reason: string; readonly review?: KnowledgeAutomaticReview | undefined }

/** Timeline tool results identify the exact retained independent assessment when this call performed one.
 * An exact file-receipt retry may have no assessment identity when the former tool result was never retained.
 */
export type KnowledgeAutomaticTimelineResult = KnowledgeAutomaticConversationResult & {
  readonly review?: { readonly reviewerSessionId: SessionId; readonly resultSha256: string } | undefined
}

/** Deployment-owned automatic-maintenance retention, complete-review and execution limits. */
export interface KnowledgeAutomaticMaintenancePolicy {
  /** Admit new AI-maintenance operations without upgrading legacy human permissions. */
  readonly enabled: boolean
  /** Maximum retained AI operation records, including unfinished operations; records are not evicted. */
  readonly maxRecords: number
  /** Maximum UTF-8 bytes of one complete retained operation record, including its request and result receipt. */
  readonly maxRecordBytes: number
  /** Maximum UTF-8 bytes of complete review input, including all source and catalog bodies; partial reviews reject. */
  readonly maxReviewBytes: number
  /** Maximum complete, tool-free assessments, including schema-only recovery; one disables recovery. */
  readonly maxReviewAttempts: number
  /** Maximum combined UTF-8 bytes of complete model answers across one review's assessments. */
  readonly maxOutputBytes: number
  /** Maximum model output tokens for each independent review call. */
  readonly maxOutputTokens: number
  /** Adapter-owned reasoning effort for independent reviews; omission inherits the selected model's effort. */
  readonly reasoningEffort?: string | undefined
  /** Whole-review deadline in milliseconds, including all assessments and durable result flushes. */
  readonly timeoutMs: number
}

/** Host-issued draft revision; deleted identities retain revisions to reject stale windows. */
export type KnowledgeDraftRevision = Branded<'KnowledgeDraftRevision'>

/** A project-local editor identity, independent from a knowledge publication operation. */
export type KnowledgeDraftIdentity =
  | { readonly kind: 'proposal'; readonly documentId: KnowledgeDocumentId; readonly proposalId: KnowledgeUpdateId }
  | { readonly kind: 'merge'; readonly documentId: KnowledgeDocumentId }
  | { readonly kind: 'direct'; readonly documentId: KnowledgeDocumentId }
  | { readonly kind: 'root'; readonly documentId: KnowledgeDocumentId }

/** Complete human proposal input; an uncertain submission retains its original confirmation UUID and input. */
export interface KnowledgeProposalDraft {
  kind: 'proposal'
  workspaceId: WorkspaceId
  documentId: KnowledgeDocumentId
  proposalId: KnowledgeUpdateId
  baseline: KnowledgeProposalReview
  proposal: KnowledgeProposalRecord
  action: KnowledgeProposalResolution['action'] | null
  truth: string
  note: string
  confirmation: KnowledgeProposalResolution | null
  attempted: boolean
}

/** Complete editor baseline, including optional native-file metadata returned by the document read API. */
export interface KnowledgeDraftDocument extends KnowledgeDocument {
  readonly file?: KnowledgeFileDocument['file']
}

/** Complete human two-page input; later inspections do not replace the retained original baseline. */
export interface KnowledgeMergeDraft {
  kind: 'merge'
  workspaceId: WorkspaceId
  documentId: KnowledgeDocumentId
  baseline: { target: KnowledgeDraftDocument; source: KnowledgeDraftDocument | null }
  sourceId: KnowledgeDocumentId | null
  truth: string
  summary: string
  evidence: string
  note: string
  confirmation: KnowledgePageMergeRequest | null
  attempted: boolean
}

/** Complete manual page-body input; a confirmed request keeps its original UUID across uncertain retries. */
export interface KnowledgeDirectDraft {
  kind: 'direct'
  workspaceId: WorkspaceId
  documentId: KnowledgeDocumentId
  baseline: KnowledgeDraftDocument
  truth: string
  kindOfChange: KnowledgeTruthUpdate['kind']
  summary: string
  evidence: string
  confirmation: KnowledgeTruthUpdate | null
  attempted: boolean
}

/** Complete manual root-body input; the fixed title and original publication UUID survive recovery. */
export interface KnowledgeRootDraft {
  kind: 'root'
  workspaceId: WorkspaceId
  documentId: KnowledgeDocumentId
  baseline: KnowledgeDraftDocument
  body: string
  reason: string
  evidence: string
  confirmation: KnowledgeRootWrite | null
  attempted: boolean
}

/** Private editor input, never current knowledge, model context, or permission to publish. */
export type KnowledgeDraft = KnowledgeProposalDraft | KnowledgeMergeDraft | KnowledgeDirectDraft | KnowledgeRootDraft

/** Complete durable editor observation; null is a retained deletion, not an unknown identity. */
export interface KnowledgeEditorDraftRow {
  readonly identity: KnowledgeDraftIdentity
  readonly revision: KnowledgeDraftRevision
  readonly draft: KnowledgeDraft | null
}

/** Draft retention bounds; capacity failures preserve all previously acknowledged rows. */
export interface KnowledgeEditorDraftPolicy {
  /** Enable new saves; disabled deployments still permit inspection and explicit removal. */
  readonly enabled: boolean
  /** Maximum retained identities across this Host, including deletion markers. */
  readonly maxRecords: number
  /** Inclusive complete durable record bytes, including the original baseline and confirmation. */
  readonly maxRecordBytes: number
  /** Inclusive complete project listing bytes; lists are never silently shortened. */
  readonly maxListBytes: number
}

/** Complete project draft listing, including deletion revisions required for safe subsequent saves. */
export interface KnowledgeEditorDraftList {
  readonly rows: readonly KnowledgeEditorDraftRow[]
  readonly policy: KnowledgeEditorDraftPolicy
}

/** Compare-and-set save; null is valid only for an identity that has never been retained. */
export interface KnowledgeEditorDraftSave {
  readonly draft: KnowledgeDraft
  readonly expectedRevision: KnowledgeDraftRevision | null
}

/** Compare-and-set removal; null reserves an unseen identity against a delayed first save and never cancels a knowledge write. */
export interface KnowledgeEditorDraftRemoval {
  readonly identity: KnowledgeDraftIdentity
  readonly expectedRevision: KnowledgeDraftRevision | null
}

/** Durable attempts are separate from successful file receipts; false coverage never implies no historical attempts. */
export interface KnowledgeGoalWriteHistory {
  readonly trackedFromStart: boolean
  readonly publicationPaths: readonly KnowledgeDocumentId[]
  /** Additional publication candidates; equal relative paths in different projects remain distinct. */
  readonly publicationTargets?: readonly { readonly projectId: WorkspaceId; readonly path: KnowledgeDocumentId }[] | undefined
  readonly rejected: readonly {
    readonly operationId: KnowledgeUpdateId
    readonly kind: 'timeline' | 'truth' | 'root-page'
    readonly path: KnowledgeDocumentId
    readonly targetProjectId?: WorkspaceId | undefined
    readonly at: string
    readonly reason: string
  }[]
}

/** Host-issued identity valid only while its Brain Health Client stream remains connected. */
export type KnowledgeHealthClientId = Branded<'KnowledgeHealthClientId'>

/** Identifies a committed project Brain selection, including restoration of the default directory. */
export type KnowledgeLocationRevision = Branded<'KnowledgeLocationRevision'>

/** Independently owned terminal query audit; not the native CLI's conversation or a task completion verdict. */
export type KnowledgeTerminalEvent =
  | { readonly kind: 'opened'; readonly taskId: ProjectTaskId; readonly initialInput: string; readonly location: KnowledgeLocation }
  | { readonly kind: 'notification'; readonly json: string }
  | { readonly kind: 'access'; readonly access: KnowledgeAccess }
  | { readonly kind: 'closed' }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete terminal-owned knowledge requests and acknowledgements, without restoring an application Task. */
    'knowledge/terminal': KnowledgeTerminalEvent
  }
}

/** Identifies one committed set of project source-folder registrations. */
export type KnowledgeSourceRevision = Branded<'KnowledgeSourceRevision'>

/** Project-specific reference folders; registering a path grants no filesystem writing permission. */
export interface KnowledgeSourceDirectories {
  readonly workspaceId: WorkspaceId
  readonly projectPath: string
  /** Explicit absolute Host paths, retained even while their directories are unavailable. */
  readonly paths: readonly string[]
  readonly revision: KnowledgeSourceRevision | null
}

/** Effective local Brain selection, independent from the project's working directory. */
export interface KnowledgeLocation {
  readonly workspaceId: WorkspaceId
  readonly projectPath: string
  readonly path: string
  /** Project-relative configured directory, or the absolute explicitly selected directory. */
  readonly directory: string
  readonly revision: KnowledgeLocationRevision | null
  readonly isDefault: boolean
}

/** A selection either commits after initialization or returns a non-writing confirmation requirement. */
export type KnowledgeLocationSelection =
  | { readonly ok: true; readonly location: KnowledgeLocation }
  | { readonly ok: false; readonly path: string; readonly reason: 'needs-initialization' | 'missing-parent' }

/** Read-only local folder observation, not a saved selection or permission to initialize it. */
export interface KnowledgeLocationInspection {
  readonly workspaceId: WorkspaceId
  /** Normalized absolute Host path; publication must revalidate its filesystem identity. */
  readonly path: string
  readonly state: 'existing-brain' | 'needs-initialization' | 'missing-parent'
  /** Existing structural markers only; their contents have not been read or validated. */
  readonly markers: readonly string[]
}

/** Dated health report identity, distinct from ordinary knowledge pages. */
export type KnowledgeHealthReportId = Branded<'KnowledgeHealthReportId'>

/** SHA-256 of a complete retained health report file, including its original encoding bytes. */
export type KnowledgeHealthHistoryId = Branded<'KnowledgeHealthHistoryId'>

/** One reachable prior report; counts describe its saved findings and human dispositions. */
export interface KnowledgeHealthHistoryEntry {
  readonly revisionId: KnowledgeHealthHistoryId
  readonly capturedAt: string
  readonly checkedAt: string
  readonly updatedAt: string
  readonly activePageCount: number
  readonly findingCount: number
  readonly openHighRiskCount: number
  readonly handledCount: number
  readonly snoozedCount: number
}

/** Referenced prior generations only; failures and resource limits never become an empty success. */
export interface KnowledgeHealthReportHistory {
  readonly workspaceId: WorkspaceId
  readonly reportId: KnowledgeHealthReportId
  readonly locationRevision: KnowledgeLocationRevision | null
  readonly currentVersion: string
  /** Newest captured generation first. */
  readonly entries: readonly KnowledgeHealthHistoryEntry[]
  readonly issues: readonly KnowledgeIssue[]
  readonly truncated: boolean
}

/** Read-only retained generation verified against the current daily report's references. */
export interface KnowledgeHealthHistoricalReport {
  readonly workspaceId: WorkspaceId
  readonly reportId: KnowledgeHealthReportId
  readonly revisionId: KnowledgeHealthHistoryId
  readonly capturedAt: string
  readonly report: KnowledgeHealthReport
}

/** Human or conversation disposition; marking fixed does not itself repair knowledge. */
export type KnowledgeHealthFindingStatus = 'open' | 'fixed' | 'snoozed' | 'not-an-issue'

/** One numbered finding retained in a Markdown health report. */
export interface KnowledgeHealthFinding {
  readonly number: number
  readonly severity: 'high' | 'medium'
  readonly title: string
  readonly status: KnowledgeHealthFindingStatus
  readonly description: string
  readonly evidence: string
  readonly related: readonly string[]
}

/** File-derived health report, with counts recomputed from structured findings when present. */
export interface KnowledgeHealthReport {
  readonly id: KnowledgeHealthReportId
  readonly version: string
  readonly title: string
  readonly checkedAt: string
  readonly updatedAt: string
  readonly activePageCount: number
  readonly findingCount: number
  readonly openHighRiskCount: number
  readonly handledCount: number
  readonly snoozedCount: number
  readonly body: string
  readonly timeline: string
  readonly findings: readonly KnowledgeHealthFinding[]
}

/** A report with a Host-validated file location for explicit copy and reveal gestures. */
export interface KnowledgeHealthFileReport extends KnowledgeHealthReport {
  readonly file: KnowledgeFileDocument['file']
}

/** Bounded report listing, separate from the active knowledge index. */
export interface KnowledgeHealthReports {
  readonly workspaceId: WorkspaceId
  /** Latest attempt for this exact project and Brain selection; independent from retained successful reports. */
  readonly lastCheck: KnowledgeHealthCheckState
  readonly reports: readonly KnowledgeHealthFileReport[]
  readonly issues: readonly KnowledgeIssue[]
  readonly truncated: boolean
}

/** Safe retained failure categories; provider responses and arbitrary errors never enter this projection. */
export type KnowledgeHealthCheckFailureReason = 'max-tokens' | 'incomplete' | 'timeout' | 'cancelled' | 'interrupted' | 'error'

/** Last model assessment, not a claim about current knowledge health or report freshness. */
export type KnowledgeHealthCheckState = { readonly status: 'unchecked' }
  | { readonly status: 'running'; readonly startedAt: string }
  | { readonly status: 'failed'
    readonly startedAt: string
    readonly finishedAt: string
    readonly reason: KnowledgeHealthCheckFailureReason }
  | { readonly status: 'completed'
    readonly startedAt: string
    readonly finishedAt: string
    readonly reportId: KnowledgeHealthReportId
    readonly sessionId: SessionId | null }

/** Mark the finding from an observed report; stale retries require another read. */
export interface KnowledgeHealthFindingUpdate {
  readonly expectedVersion: string
  readonly findingNumber: number
  readonly status: KnowledgeHealthFindingStatus
  readonly note?: string
}

/** Complete reviewed findings for a new daily report or a version-qualified same-day recheck. */
export interface KnowledgeHealthReportWrite {
  readonly operationId: KnowledgeUpdateId
  /** Null permits creation only; an existing report requires its observed content version. */
  readonly expectedVersion: string | null
  readonly locale: 'en' | 'zh-CN'
  readonly activePageCount: number
  readonly summary: string
  readonly findings: readonly Omit<KnowledgeHealthFinding, 'number' | 'status'>[]
}

/** Explicit scope and inclusion choices for one model-assisted assessment. */
export interface KnowledgeHealthCheckOptions {
  /** Active Client selection; absent explicitly resolves the Host default before capture. */
  readonly model?: ModelSelection
  readonly locale: 'en' | 'zh-CN'
  readonly scope: 'all-active' | 'current-page' | 'related-pages'
  readonly pageId: KnowledgeDocumentId | null
  readonly includeDrafts: boolean
  readonly includeArchived: boolean
  readonly checkCodeChanges: boolean
}

/** Published report and the independent logged analysis that produced it. */
export interface KnowledgeHealthCheckResult {
  readonly reportId: KnowledgeHealthReportId
  readonly sessionId: SessionId
  readonly version: string
}

/** Append one knowledge observation without replacing current understanding or lifecycle. */
export interface KnowledgeTimelineAppend {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly kind: 'decision' | 'observation' | 'source' | 'reversal'
  readonly summary: string
  /** Optional reference text, not proof of permission or correctness. */
  readonly source?: string
  /** Absent selects the destination page; an explicit empty list stays empty. */
  readonly affects?: readonly string[]
  readonly evidence?: string
}

/** Append a Goal master's supported decision without replacing current understanding or lifecycle. */
export interface KnowledgeGoalDecision {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly summary: string
  readonly evidence: string
}

/** Goal-owned complete understanding or root-body replacement, retained with an exact recovery image. */
export interface KnowledgeGoalRewrite {
  readonly operationId: KnowledgeUpdateId
  /** Informing read version; null permits creation of an absent signed root only. */
  readonly expectedVersion: string | null
  readonly markdown: string
  readonly rationale: string
  readonly evidence: string
}

/** Retained human review; revisions count user resumes and replaced approved plans. Absence denotes the initial interval. */
export interface KnowledgeGoalReviewRecord {
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  readonly resolution: 'confirmed' | 'reverted'
  readonly resumeRevision?: number | undefined
  /** Hash of understanding after this review; compares later edits without duplicating recovery text. */
  readonly truthDigest?: string | undefined
}

/** One run's accumulated change, retaining its first before-image across user resumes. */
export interface KnowledgeGoalChange {
  readonly runId: ProjectGoalRunId
  readonly sourceSessionId: SessionId
  readonly author: string
  readonly before: string
  readonly after: string
  readonly rewrites: readonly {
    readonly operationId: KnowledgeUpdateId
    readonly at: string
    readonly rationale: string
    /** Present for writes recorded with step history; older records have no recoverable intermediate body. */
    readonly snapshot?: {
      readonly before: string
      readonly after: string
      readonly evidence: string
    } | undefined
  }[]
  readonly review?: KnowledgeGoalReviewRecord | undefined
  readonly reviewHistory?: readonly KnowledgeGoalReviewRecord[] | undefined
}

/** Explicit human resolution of the exact accumulated change that was displayed. */
export interface KnowledgeGoalReview {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly resolution: 'confirmed' | 'reverted'
  /** Displayed knowledge authority revision, including resumes and replaced approvals; omitted means the initial interval. */
  readonly expectedResumeRevision?: number | undefined
}

/** A source-project path, or an exact signed destination and its project-relative knowledge path. */
export type KnowledgeGoalTarget = KnowledgeDocumentId | { readonly projectId: WorkspaceId; readonly path: KnowledgeDocumentId }

/** Version-qualified file review; a null change means the selected run has no retained rewrite here. */
export interface KnowledgeGoalChangeView {
  readonly documentId: KnowledgeDocumentId
  readonly version: string
  readonly resumeRevision: number
  readonly kind: 'page' | 'root'
  readonly change: KnowledgeGoalChange | null
  /** Successful autonomous writes from retained file receipts, across resumes; excludes user reversals and root writes. */
  readonly timelineWrites: number
}

/** Rename a page's display title without changing its path or appending Timeline evidence. */
export interface KnowledgePageTitleUpdate {
  readonly expectedVersion: string
  readonly title: string
}

/** Replace one existing page's current understanding and append its explanation together. */
export interface KnowledgeTruthUpdate {
  readonly operationId: KnowledgeUpdateId
  /** Exact opaque version returned by the document read that informed this update. */
  readonly expectedVersion: string
  /** Complete authored Markdown; ordinary Timeline headings are allowed, storage markers are not. */
  readonly truth: string
  readonly kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
  readonly summary: string
  readonly source: string
  readonly evidence: string
}

/** One retained ordinary rewrite: normalized page understanding or exact root body bytes, separate from model-facing knowledge. */
export interface KnowledgeTruthChange {
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  readonly summary: string
  readonly source: string
  readonly evidence: string
  readonly before: string
  readonly after: string
  /** Display hint computed from the current file; restore always rechecks version and body independently. */
  readonly canRestore: boolean
}

/** Complete retained ordinary rewrites at one location-qualified document version; legacy files may have no records. */
export interface KnowledgeTruthHistory {
  readonly documentId: KnowledgeDocumentId
  readonly version: string
  readonly changes: readonly KnowledgeTruthChange[]
}

/** Explicit human restore of a retained before-image; no model write permission is implied. */
export interface KnowledgeTruthRestore {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly targetOperationId: KnowledgeUpdateId
}

/** Unapproved complete replacement retained separately from current knowledge and its Timeline. */
export interface KnowledgeTruthProposal {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly truth: string
  readonly summary: string
  /** Conversation identity and reference description, not independently verified evidence. */
  readonly source: string
  readonly evidence: string
}

/** Exact signed Goal research candidate and first human decision for an unapproved existing-page proposal. */
export interface KnowledgeGoalTruthProposalIdentity {
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly planRequestId: ProjectGoalRequestId
  readonly taskId: ProjectTaskId
  readonly reportMessageId: MessageId
  readonly reportSha256: string
  readonly discoveryId: SessionId
  readonly resultSha256: string
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly candidateSha256: string
  readonly decisionId: KnowledgeUpdateId
}

/** Exact Host-only Goal-human operation inspected after one joined Brain write attempt. */
export type KnowledgeGoalOperation =
  | { readonly kind: 'proposal'
    readonly identity: KnowledgeGoalTruthProposalIdentity
    readonly request: KnowledgeTruthProposal }
  | { readonly kind: 'draft'
    readonly hold: KnowledgeGoalPublicationHold
    readonly request: KnowledgePageCreate }
  | { readonly kind: 'publication'
    readonly hold: KnowledgeGoalPublicationHold
    readonly request: KnowledgePageStatusUpdate
    readonly expectedActiveIndexDigest: string }

/** An exact file receipt, a same-process proven pre-write refusal, or unresolved publication. */
export type KnowledgeGoalOperationInspection =
  | { readonly status: 'applied'; readonly receipt: KnowledgeTruthReceipt }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown' }

/** Human decision about one displayed proposal at the currently displayed document version. */
export type KnowledgeProposalResolution = {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  readonly proposalId: KnowledgeUpdateId
  readonly note: string
} & ({ readonly action: 'keep' | 'replace'; readonly truth: null }
  | { readonly action: 'merge'; readonly truth: string })

/** File-owned proposal and optional human disposition; neither pending nor rejected text is current knowledge. */
export interface KnowledgeProposalRecord {
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  readonly before: string
  readonly proposed: string
  readonly summary: string
  readonly source: string
  readonly evidence: string
  readonly resolution: null | {
    readonly operationId: KnowledgeUpdateId
    readonly at: string
    readonly action: 'keep' | 'replace' | 'merge'
    readonly note: string
  }
}

/** Complete document-owned proposal ledger and current text required for deliberate reconciliation. */
export interface KnowledgeProposalReview {
  readonly documentId: KnowledgeDocumentId
  readonly version: string
  readonly current: string
  readonly archived: boolean
  readonly proposals: readonly KnowledgeProposalRecord[]
}

/** Create one page with an explicit lifecycle state and its initial evidence; never replace an existing page. */
export interface KnowledgePageCreate {
  readonly operationId: KnowledgeUpdateId
  readonly title: string
  readonly status: 'draft' | 'active' | 'archived'
  readonly category: 'project' | 'concept' | 'decision' | 'person' | 'reference'
  readonly tags: readonly string[]
  readonly truth: string
  readonly kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
  readonly summary: string
  readonly source: string
  readonly evidence: string
}

/** File-owned hold for a knowledge-import draft; only its matching reviewed publication may release it. */
export interface KnowledgeImportPublicationHold {
  readonly version: 1
  readonly importId: string & Branded<'KnowledgeImportId'>
  readonly proposalMessageId: MessageId
  readonly proposalSha256: string
  readonly changeSha256: string
  readonly draftOperationId: KnowledgeUpdateId
}

/** File-owned hold for a Task discovery draft; only its matching second human decision may publish it. */
export interface KnowledgeTaskPublicationHold {
  readonly version: 1
  readonly workspaceId: WorkspaceId
  readonly taskId: ProjectTaskId
  readonly discoveryId: string
  readonly resultSha256: string
  readonly candidateSha256: string
  readonly decisionId: string
  readonly draftOperationId: KnowledgeUpdateId
}

/** File-owned hold for one human-reviewed Goal research candidate; Goal agent writes cannot release it. */
export interface KnowledgeGoalPublicationHold {
  readonly version: 1
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  /** Signed plan identity, distinct from the Goal run when a plan is replaced. */
  readonly planRequestId: ProjectGoalRequestId
  readonly taskId: ProjectTaskId
  readonly reportSha256: string
  readonly candidateSha256: string
  readonly decisionId: string
  readonly draftOperationId: KnowledgeUpdateId
}

/** Complete Task draft and current active page/root catalog shown before a separate publication confirmation. */
export interface KnowledgeTaskDraftReview {
  readonly document: KnowledgeDocument
  readonly activeIndexDigest: string
  readonly activePageCount: number
  readonly activePages: readonly { readonly id: KnowledgeDocumentId; readonly title: string; readonly version: string }[]
}

/** Complete Goal-held draft and stable active page/root catalog for a separate human publication decision. */
export interface KnowledgeGoalDraftReview {
  readonly document: KnowledgeDocument
  readonly activeIndexDigest: string
  readonly activePageCount: number
  readonly activePages: readonly { readonly id: KnowledgeDocumentId; readonly title: string; readonly version: string }[]
}

/** Ordinary draft, two complete active-page searches and stable page/root catalog shown before human confirmation. */
export interface KnowledgeOrdinaryDraftReview {
  readonly document: KnowledgeDocument
  readonly titleQuery: string
  readonly titleSearch: KnowledgeSearchResult
  readonly topicQuery: string
  readonly topicSearch: KnowledgeSearchResult
  readonly activeIndexDigest: string
  readonly activePages: readonly { readonly id: KnowledgeDocumentId; readonly title: string; readonly version: string }[]
  readonly reviewDigest: string
}

/** One old active page or root delivered in full against an unchanged ordinary draft review. */
export interface KnowledgeOrdinaryCatalogReadRequest {
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  readonly reviewDigest: string
  readonly topicQuery: string
  readonly path: KnowledgeDocumentId
  readonly expectedPageVersion: string
}

/** A changed review or document never supplies a body or a durable read receipt. */
export type KnowledgeOrdinaryCatalogRead =
  | { readonly kind: 'changed' }
  | {
    readonly kind: 'page' | 'root'
    readonly id: KnowledgeDocumentId
    readonly title: string
    readonly status: 'active'
    readonly version: string
    readonly body: string
  }

/** A new ordinary publication explicitly classifies every active page and root; unknown relations block writing. */
export interface KnowledgeOrdinaryPageRelation {
  readonly id: KnowledgeDocumentId
  readonly title: string
  readonly version: string
  readonly relation: 'distinct' | 'duplicate' | 'conflict' | 'unknown'
}

/** Exact second human decision retained by the Host before any ordinary draft publication write. */
export interface KnowledgeOrdinaryDraftPublishRequest {
  readonly operationId: KnowledgeUpdateId
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  readonly reviewDigest: string
  readonly topicQuery: string
  readonly reason: string
  readonly evidence: string
  /** Absent only in historic retained decisions; new publication requires the complete reviewed catalog. */
  readonly reviewedPages?: readonly KnowledgeOrdinaryPageRelation[] | undefined
}

/** Host-only release identity derived from one retained ordinary confirmation and original draft receipt. */
export interface KnowledgeOrdinaryPublicationRelease {
  readonly kind: 'ordinary'
  readonly workspaceId: WorkspaceId
  readonly documentId: KnowledgeDocumentId
  /** Null marks an existing draft without an original file-owned creation receipt. */
  readonly draftOperationId: KnowledgeUpdateId | null
  readonly draftRequestDigest: string | null
  readonly reviewDigest: string
  readonly activeIndexDigest: string
}

/** A historical exact receipt does not assert that the page remains active. */
export type KnowledgeOrdinaryDraftPublicationInspection =
  | { readonly status: 'published'
    readonly operationId: KnowledgeUpdateId
    readonly documentId: KnowledgeDocumentId
    readonly version: string
    readonly currentStatus: KnowledgeEntry['status'] }
  | { readonly status: 'not-recorded' }
  | { readonly status: 'unknown'; readonly reason: 'unavailable' | 'identity-conflict' }

/** Explicit abandonment is accepted only after the original file receipt is proven absent under writer locks. */
export type KnowledgeOrdinaryDraftAbandonResult =
  | { readonly status: 'abandoned' }
  | { readonly status: 'refused'; readonly reason: 'published' | 'unknown' | 'identity-conflict' }

/** Post-publication observation; only a verified result proves the displayed active catalog still matches at inspection. */
export type KnowledgeTaskPublicationReview =
  | {
    readonly status: 'verified'
    readonly observedActiveIndexDigest: string
    readonly currentPageVersion: string
  }
  | {
    readonly status: 'required'
    readonly reason: 'active-catalog-changed'
    readonly observedActiveIndexDigest: string
    readonly currentPageVersion: string
  }
  | { readonly status: 'unknown'; readonly reason: 'catalog-unavailable' | 'receipt-unconfirmed' }

/** Stable read-only evidence for a person's disposition of a published Task page and changed active catalog. */
export type KnowledgeTaskPublicationInspection =
  | { readonly status: 'ready'
    readonly review: Exclude<KnowledgeTaskPublicationReview, { readonly status: 'unknown' }>
    readonly currentPage: { readonly id: KnowledgeDocumentId; readonly title: string; readonly body: string; readonly version: string }
    readonly activePages: readonly { readonly id: KnowledgeDocumentId; readonly title: string; readonly version: string }[] }
  | { readonly status: 'unknown'; readonly reason: 'catalog-unavailable' | 'receipt-unconfirmed' }

/** Read-only result for a Goal-human publication, never an automatic Goal acceptance verdict. */
export type KnowledgeGoalPublicationReview = KnowledgeTaskPublicationReview

/** Stable published Goal page and active catalog for an independent human disposition. */
export type KnowledgeGoalPublicationInspection = KnowledgeTaskPublicationInspection

/** Publish, withdraw or restore an existing page without replacing its current understanding. */
export interface KnowledgePageStatusUpdate {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  /** Archival requires a separate operation with replacement-page semantics. */
  readonly status: 'draft' | 'active'
  readonly reason: string
  readonly source: string
  readonly evidence: string
}

/** Archive a page without deleting its understanding; a replacement adds one reversal to its history. */
export interface KnowledgePageArchive {
  readonly operationId: KnowledgeUpdateId
  readonly expectedVersion: string
  /** Existing page in the same project, or null when no replacement is requested. */
  readonly supersededBy: KnowledgeDocumentId | null
  readonly source: string
  readonly evidence: string
}

/** Explicit human consolidation of two distinct ordinary pages in one project. */
export interface KnowledgePageMergeRequest {
  readonly operationId: KnowledgeUpdateId
  readonly target: { readonly documentId: KnowledgeDocumentId; readonly expectedVersion: string }
  readonly source: { readonly documentId: KnowledgeDocumentId; readonly expectedVersion: string }
  /** Complete resulting current understanding; the source page and both Timelines remain retained. */
  readonly truth: string
  readonly summary: string
  readonly evidence: string
  readonly note: string
}

/** Confirmed publication milestones; separate file writes never form an atomic two-page transaction. */
export type KnowledgePageMergeStage = 'prepared' | 'target-written' | 'source-archived' | 'complete'

/** Explicit terminal decision for a retained merge; it neither reverses nor completes publication. */
export interface KnowledgePageMergeAbandon {
  readonly operationId: KnowledgeUpdateId
  readonly note: string
}

/** Immutable saved decision; exact retries retain the original timestamp and note. */
export interface KnowledgePageMergeAbandonment extends KnowledgePageMergeAbandon {
  readonly at: string
}

/** Retained intent summary; lastConfirmedStage may lag a committed file after interruption. */
export interface KnowledgePageMergeSummary {
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  readonly target: { readonly documentId: KnowledgeDocumentId; readonly title: string }
  readonly source: { readonly documentId: KnowledgeDocumentId; readonly title: string }
  readonly summary: string
  readonly lastConfirmedStage: KnowledgePageMergeStage
  readonly abandonment: KnowledgePageMergeAbandonment | null
  /** True when title/summary previews were omitted to retain the operation identity in the bounded list. */
  readonly previewOmitted: boolean
}

/** Bounded human discovery; omission never deletes retained operations. */
export interface KnowledgePageMergeList {
  readonly workspaceId: WorkspaceId
  readonly count: number
  readonly entries: readonly KnowledgePageMergeSummary[]
  readonly omitted: number
  readonly countComplete: boolean
}

/** Current observation of a selected file; unavailable files remain explicit rather than becoming empty documents. */
export type KnowledgePageMergeCurrent =
  | { readonly status: 'available'; readonly document: KnowledgeDocument }
  | { readonly status: 'unavailable'; readonly reason: string }

/** Complete retained approval and current file observations; reading never resumes publication. */
export interface KnowledgePageMergeReview {
  readonly workspaceId: WorkspaceId
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  readonly request: KnowledgePageMergeRequest
  readonly baseline: { readonly target: KnowledgeDocument; readonly source: KnowledgeDocument }
  readonly current: { readonly target: KnowledgePageMergeCurrent; readonly source: KnowledgePageMergeCurrent }
  /** File-receipt-derived stage; null means the present files cannot establish an unambiguous stage. */
  readonly stage: KnowledgePageMergeStage | null
  readonly lastConfirmedStage: KnowledgePageMergeStage
  /** Independent terminal decision; publication stage and retained file receipts remain unchanged. */
  readonly abandonment: KnowledgePageMergeAbandonment | null
  readonly canContinue: boolean
  readonly blockedReason: string | null
  /** The last write failure; a subsequent read can establish success despite an uncertain response. */
  readonly lastError: string | null
}

/** Initialize an absent root or replace its complete body at an observed version; roots have no Timeline. */
export interface KnowledgeRootWrite {
  readonly operationId: KnowledgeUpdateId
  /** Null means create only; a content version means replace only. */
  readonly expectedVersion: string | null
  readonly body: string
  readonly reason: string
  readonly source: string
  readonly evidence: string
}

/** Full replacement of page tags; an equal normalized list is a non-writing acknowledgement. */
export interface KnowledgePageTagsUpdate {
  readonly expectedVersion: string
  readonly tags: readonly string[]
}

/** Committed document metadata; already-applied reports current bytes without another publication. */
export interface KnowledgeMutationReceipt {
  readonly documentId: KnowledgeDocumentId
  readonly version: string
  readonly disposition: 'written' | 'already-applied'
}

/** A committed update receipt; an idempotent retry reports the current document version. */
export interface KnowledgeTruthReceipt extends KnowledgeMutationReceipt {
  readonly operationId: KnowledgeUpdateId
}

/** File-derived metadata used by page, category, tag and search navigation. */
export interface KnowledgeEntry {
  readonly id: KnowledgeDocumentId
  readonly slug: string
  readonly title: string
  readonly kind: 'root' | 'page'
  readonly status: 'active' | 'draft' | 'archived'
  readonly category: string | null
  readonly tags: readonly string[]
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly version: string
  /** Unresolved ordinary proposals on this page, including archived pages; roots have none. */
  readonly pendingProposalCount: number
  /** Unique authored wiki page slugs; resolution belongs to the current project index. */
  readonly references: readonly string[]
  /** First trimmed understanding line, capped at 120 UTF-16 units including an ellipsis; empty when absent. */
  readonly summary: string
  /** Bounded document text searched locally; never sent to a model by this API. */
  readonly searchText: string
}

/** One parsed chronological observation; unknown source fields remain in the file. */
export interface KnowledgeTimelineEntry {
  readonly time: string
  readonly kind: string
  readonly summary: string
  readonly source: string | null
  readonly affects: readonly string[]
  readonly evidence: string | null
  readonly author?: string | undefined
  /** Human navigation fallback retained by the Timeline writer; not an additional model input. */
  readonly sourceSessionId?: SessionId
}

/** A current retained attribution resolved for read-only navigation, never authority to activate an Agent. */
export type KnowledgeSourceResolution =
  | {
    readonly status: 'available'
    readonly sessionId: SessionId
    readonly workspaceId: WorkspaceId | null
    readonly spaceId: ProjectSpaceId
    readonly archived: boolean
    readonly message?: { readonly id: MessageId; readonly seq: SessionSeq }
  }
  | {
    readonly status: 'unavailable'
    readonly reason: 'unsupported-source' | 'source-changed' | 'session-unavailable'
      | 'outside-workspace' | 'message-missing' | 'unsupported-session'
  }

/** One file-owned observation in the project activity feed; ordinal distinguishes equal timestamps. */
export interface KnowledgeActivityEntry {
  readonly documentId: KnowledgeDocumentId
  readonly ordinal: number
  readonly title: string
  readonly time: string
  readonly kind: string
  readonly summary: string
  readonly author: string | null
}

/** Newest non-archived page observations within the configured count and complete JSON byte bounds. */
export interface KnowledgeActivity {
  readonly entries: readonly KnowledgeActivityEntry[]
  readonly limit: number
  readonly truncated: boolean
}

/** Complete bounded document body without frontmatter or the structured Timeline section. */
export interface KnowledgeDocument {
  readonly entry: KnowledgeEntry
  /** Normalized current understanding before title removal or Wiki-link projection. */
  readonly body: string
  /** Current understanding with a matching leading title removed and Wiki links projected. */
  readonly markdown: string
  readonly timeline: readonly KnowledgeTimelineEntry[]
}

/** Readable document and its Host-owned native file actions. */
export interface KnowledgeFileDocument extends KnowledgeDocument {
  /** Absolute Host path; copy does not grant arbitrary-path access to the reveal operation. */
  readonly file: { readonly path: string; readonly canReveal: boolean }
}

/** Host-only, complete-page Brain capture; offsets belong to one unchanged catalog digest. */
export interface KnowledgeDiscoveryPageBatchRequest {
  /** Zero starts a capture; later offsets require the preceding batch's catalog digest. */
  readonly offset: number
  readonly expectedCatalogSha256?: string | undefined
  /** Maximum complete documents returned in one batch. */
  readonly maxPages: number
  /** Inclusive UTF-8 byte limit on the complete serialized response. */
  readonly maxBytes: number
}

/** Full current-understanding bodies and Timeline records, without native file paths or write authority. */
export interface KnowledgeDiscoveryPageBatch {
  readonly catalogSha256: string
  readonly locationRevision: KnowledgeLocationRevision | null
  readonly offset: number
  readonly totalPages: number
  readonly pages: readonly {
    readonly path: KnowledgeDocumentId
    readonly version: string
    readonly title: string
    readonly status: KnowledgeEntry['status']
    readonly body: string
    readonly timeline: readonly {
      readonly time: string
      readonly kind: string
      readonly summary: string
      readonly source: string | null
      readonly affects: readonly string[]
      readonly evidence: string | null
      readonly author?: string | undefined
    }[]
  }[]
  /** Null only after the final document; an empty first batch is valid for an empty Brain. */
  readonly nextOffset: number | null
}

/** A file that could not be included; malformed or unreadable input is never silently hidden. */
export interface KnowledgeIssue {
  readonly path: string
  readonly message: string
}

/** Explicit keyword-search scope and retained result limits. */
export interface KnowledgeSearchRequest {
  readonly query: string
  readonly statuses: readonly KnowledgeEntry['status'][]
  readonly maxResults: number
  readonly maxMatches: number
}

/** One matching page or fixed root, with one-based source line numbers rather than rendered Markdown positions. */
export interface KnowledgeSearchHit {
  readonly path: KnowledgeDocumentId
  readonly title: string
  readonly status: KnowledgeEntry['status']
  readonly version: string
  readonly lines: readonly { readonly line: number; readonly snippet: string }[]
  readonly linesTruncated: boolean
}

/** Bounded keyword matches; skipped files and omitted documents remain distinct from an empty result. */
export interface KnowledgeSearchResult {
  readonly exists: boolean
  readonly hits: readonly KnowledgeSearchHit[]
  readonly issues: readonly KnowledgeIssue[]
  readonly truncated: boolean
}

/** Completed knowledge operation metadata; content, prompts and native paths are excluded. */
export interface KnowledgeAccess {
  readonly projectId: WorkspaceId
  readonly documentId: KnowledgeDocumentId
  readonly kind: 'read' | 'write' | 'search'
  /** Live model-write attribution; omitted for direct API actions and never retained in access history. */
  readonly writerSessionId?: SessionId
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A successful operation reached access accounting; delivery is live-only, before statistics persistence.
     * @mode emit
     * @param access - project-qualified metadata captured by the admitted operation.
     */
    'knowledge/access'(access: KnowledgeAccess): void
  }
}

/** Successful accesses by host-local calendar day, independent of document activity and recent-event retention. */
export interface KnowledgeCalls {
  readonly days: readonly { readonly day: string; readonly count: number }[]
  /** A statistics publication failed during this Host lifetime; displayed totals are lower bounds. */
  readonly incomplete: boolean
}

/** Unapproved update metadata for human discovery, not a statement of current knowledge. */
export interface KnowledgePendingProposalSummary {
  readonly documentId: KnowledgeDocumentId
  readonly operationId: KnowledgeUpdateId
  readonly at: string
  /** Complete authored summary; proposed understanding and evidence are available only in the page review. */
  readonly summary: string
}

/** Bounded human review inbox observed during one project scan, including archived pages. */
export interface KnowledgePendingProposals {
  /** Number observed in successfully read pages; a lower bound when countComplete is false. */
  readonly count: number
  readonly entries: readonly KnowledgePendingProposalSummary[]
  /** Observed proposals omitted from entries by the item or complete-result byte limit. */
  readonly omitted: number
  /** Every candidate was scanned without an issue; separate file reads are not an atomic project snapshot. */
  readonly countComplete: boolean
}

/** One project scan; absence of the Brain directory is an explicit empty state. */
export interface KnowledgeIndex {
  /** Null until the first explicit selection; retained model snapshots qualify subsequent writes with this revision. */
  readonly locationRevision: KnowledgeLocationRevision | null
  readonly workspaceId: WorkspaceId
  readonly directory: string
  readonly exists: boolean
  /** Authored index.md list-link count; zero when absent, null when the catalog cannot be read safely. */
  readonly pageCount: number | null
  readonly entries: readonly KnowledgeEntry[]
  readonly activity: KnowledgeActivity
  readonly pendingProposals: KnowledgePendingProposals
  readonly calls: KnowledgeCalls
  readonly issues: readonly KnowledgeIssue[]
  readonly truncated: boolean
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Private editor storage refused an operation without replacing any previously retained draft. */
    'knowledge/draft': { readonly reason: 'invalid' | 'conflict' | 'identity-conflict' | 'capacity' | 'not-human' | 'disabled' }
    /** Human merge admission; absent intent is distinct from an uncertain file publication. */
    'knowledge/merge': { readonly reason: 'invalid' | 'identity-conflict' | 'not-found' | 'capacity' | 'not-human' }
    /** An explicit Brain selection equals, contains, or lies inside a registered source folder. */
    'knowledge/source-overlap': { readonly path: string; readonly source: string }
    /** Knowledge path is absent, linked, outside the project, malformed, or over a configured bound. */
    'knowledge/document': { readonly path: string; readonly reason: 'not-found' | 'unsafe-path' | 'invalid' | 'too-large' }
    /** Host-only full-page comparison refuses a stale catalog, incomplete scan or unrepresentable batch. */
    'knowledge/discovery-batch': { readonly reason: 'invalid-request' | 'project-changed' | 'index-incomplete'
      | 'catalog-changed' | 'input-limit' }
    /** A refused update writes nothing; duplicate evidence refers to an existing operation, not a receipt for the requested UUID. */
    'knowledge/update': { readonly path: string; readonly reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only' | 'busy' }
      | { readonly path: string; readonly reason: 'duplicate'; readonly existingOperationId: KnowledgeUpdateId }
  }
}
