/** Project knowledge reads, guarded updates and logged manual or opt-in post-write health assessments. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { setTimeout as delay } from 'node:timers/promises'
import { join, parse, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { withFileLock, WriterLockTimeoutError } from '@deepseek-ai/dsh-atomic-write'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-task-controller'
import { documentationTraceOperationId, hasIndependentKnowledgeTerm } from '@deepseek-ai/dsh-api-task-controller'
import type { ProjectGoalRunId, ProjectTaskCardState, ProjectTaskId } from '@deepseek-ai/dsh-api-task-controller/types'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { canRevealNativePath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import { parseKnowledgeDocument, ROOT_DOCUMENTS } from './documents.ts'
import { KnowledgeActivityCollector } from './activity.ts'
import { knowledgeSourceReferences, resolveKnowledgeSource } from './source-reference.ts'
import { KnowledgePendingProposalCollector } from './pending-proposals.ts'
import { KnowledgeFiles, relativeSegments, documentVersion, filesystemFailure } from './files.ts'
import { collectKnowledgeMatches } from './search.ts'
import { KnowledgeAccessStore, knowledgeAccessDomain, type KnowledgeAccess, type KnowledgeAccessPolicy } from './access.ts'
import { hasTruthUpdateReceipt, prepareTruthUpdate } from './update.ts'
import { prepareTruthRestore, readTruthHistory } from './truth-history.ts'
import { prepareTruthProposal, readProposalReview, prepareProposalResolution } from './proposals.ts'
import { goalProposalSource } from './goal-proposal.ts'
import { goalOperationDigest, goalPrewriteProof, goalPrewriteRefusal, type GoalWriteObservation } from './goal-operation.ts'
import { knowledgeSessionWritable, knowledgeWritePolicy } from './write-policy.ts'
import { prepareGoalDecision, validateGoalDecision } from './decision.ts'
import { KnowledgeGoalHistoryStore, knowledgeGoalHistoryDomain, type KnowledgeGoalHistoryPolicy } from './goal-history.ts'
import { hasTimelineAppendReceipt, prepareTimelineAppend } from './timeline.ts'
import { captureBrainScope, selectBrainProjects, revalidateBrainScope } from './model-scope.ts'
import { prepareGoalRootCreation, prepareGoalRewrite, prepareGoalReview, readGoalFileReview, validateGoalRewrite } from './goal-change.ts'
import { hasGoalApproval, hasTaskInput } from './model-task.ts'
import { hasOrdinaryPublicationReceipt, hasStatusUpdateReceipt, prepareStatusUpdate } from './status.ts'
import { preparePageArchive } from './archive.ts'
import { KnowledgePageMergeStore, knowledgePageMergeDomain, requireMergeableActivePage,
  type KnowledgePageMergePolicy, type PageMergeOperations, type PageMergeInitiator, type PageMergeRecord } from './page-merges.ts'
import { KnowledgeEditorDraftStore, knowledgeEditorDraftDomain } from './editor-drafts.ts'
import { KnowledgeOrdinaryPublicationStore, knowledgeOrdinaryPublicationDomain, ordinaryReviewEvidence,
  validateOrdinaryPublicationRequest, type OrdinaryPublicationReviewEvidence } from './ordinary-publication.ts'
import { KnowledgeOrdinaryCatalogReadStore, knowledgeOrdinaryCatalogReadDomain } from './ordinary-catalog-read.ts'
import { KnowledgeAutomaticMaintenanceStore, knowledgeAutomaticMaintenanceDomain, automaticMaintenanceSource,
  automaticMaintenanceEvidenceFailure, automaticMaintenanceReviewEvidenceFailure,
  validateAutomaticMaintenanceRequest, type KnowledgeAutomaticMaintenanceReview,
  type KnowledgeAutomaticMaintenanceRecord } from './automatic-maintenance.ts'
import { decodeAutomaticConversationReview, reviewAutomaticConversation } from './automatic-review.ts'
import { collectConversationReviewSources, conversationContextDispositionsAllowed,
  frozenConversationSourcesMatch } from './conversation-review-sources.ts'
import { normalizeKnowledgePage } from './format.ts'
import { preparePageTags } from './tags.ts'
import { preparePageTitle } from './title.ts'
import { renderBrainIndex } from './reindex.ts'
import { knowledgeSource } from './source.ts'
import { knowledgeReferencesProjection } from './conversation-references.ts'
import { curationStatusProjection } from './curation-status.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { healthReportPath, parseHealthReport, prepareHealthFindingUpdate } from './health-report.ts'
import { prepareHealthReportWrite, healthGenerationApplied } from './health-generation.ts'
import { appendHealthHistory, healthHistoryId, healthHistoryReferences, type HealthHistoryReference } from './health-history.ts'
import { runKnowledgeHealthCheck, HealthAssessmentIncompleteError, type HealthCheckPolicy } from './health-check.ts'
import { reviewAutomaticConsistency } from './automatic-consistency.ts'
import { KnowledgeHealthCheckStore, knowledgeHealthCheckDomain } from './health-status.ts'
import { startupHealthDue, type HealthStartupPolicy } from './health-startup.ts'
import { hasRootWriteReceipt, prepareRootWrite } from './root.ts'
import { preparePageCreation, requireCreationReceipt } from './create.ts'
import { readImportPublicationHold } from './import-publication-hold.ts'
import { readTaskPublicationHold, sameTaskPublicationHold } from './task-publication-hold.ts'
import { readGoalPublicationHold, sameGoalPublicationHold } from './goal-publication-hold.ts'
import { inspectLocalBrainLocation } from './location.ts'
import { currentBrainModelWrite, type BrainModelWriteExecution } from './model-write-context.ts'
import { activeTaskCompletions, automaticTaskCompletion, codingTaskReadsComplete, sameTaskCompletions, taskCompletionCards } from './task-completion-write.ts'
import { KnowledgeLocationStore, knowledgeLocationDomain, knowledgeSourceDomain } from './location-store.ts'
import { ensureBrainDirectories, inspectBrainPath } from './local-brain.ts'
import { requireCurrentBrainContext, requireInformedBrainRead, requireUserEvidenceSource } from './model-write-evidence.ts'
import type {
  KnowledgeDocument, KnowledgeFileDocument, KnowledgeDocumentId, KnowledgeEntry, KnowledgeIndex, KnowledgeIssue,
  KnowledgeTruthReceipt, KnowledgeTruthUpdate, KnowledgeTruthHistory, KnowledgeTruthRestore,
  KnowledgeTruthProposal, KnowledgeGoalTruthProposalIdentity, KnowledgeProposalReview, KnowledgeProposalResolution,
  KnowledgePageCreate, KnowledgePageStatusUpdate, KnowledgeImportPublicationHold, KnowledgeTaskPublicationHold, KnowledgeTaskDraftReview,
  KnowledgeTaskPublicationReview, KnowledgeTaskPublicationInspection, KnowledgeGoalPublicationHold, KnowledgeGoalDraftReview,
  KnowledgeGoalPublicationReview, KnowledgeGoalPublicationInspection, KnowledgeGoalOperation,
  KnowledgeGoalOperationInspection,
  KnowledgeRootWrite, KnowledgeUpdateId,
  KnowledgePageTagsUpdate, KnowledgePageTitleUpdate, KnowledgeMutationReceipt, KnowledgeReindexResult,
  KnowledgeTimelineAppend, KnowledgeGoalDecision, KnowledgeGoalRewrite, KnowledgeGoalReview, KnowledgeGoalChangeView, KnowledgePageArchive,
  KnowledgeHealthReportId, KnowledgeHealthReport, KnowledgeHealthFileReport, KnowledgeHealthReports,
  KnowledgeHealthHistoryId, KnowledgeHealthHistoryEntry, KnowledgeHealthReportHistory, KnowledgeHealthHistoricalReport,
  KnowledgeHealthFindingUpdate, KnowledgeHealthReportWrite, KnowledgeHealthCheckOptions, KnowledgeHealthCheckResult,
  KnowledgeSearchRequest, KnowledgeSearchResult, KnowledgeLocationInspection,
  KnowledgeLocation, KnowledgeLocationRevision, KnowledgeLocationSelection, KnowledgeSourceDirectories, KnowledgeHealthClientId,
  KnowledgeGoalWriteHistory, KnowledgeGoalTarget, KnowledgeSourceResolution,
  KnowledgePageMergeRequest, KnowledgePageMergeReview, KnowledgePageMergeList, KnowledgePageMergeAbandon,
  KnowledgeEditorDraftPolicy, KnowledgeEditorDraftList, KnowledgeEditorDraftRow, KnowledgeEditorDraftSave, KnowledgeEditorDraftRemoval,
  KnowledgeOrdinaryDraftReview, KnowledgeOrdinaryCatalogReadRequest, KnowledgeOrdinaryCatalogRead,
  KnowledgeOrdinaryDraftPublishRequest, KnowledgeOrdinaryDraftPublicationInspection,
  KnowledgeOrdinaryDraftAbandonResult,
  KnowledgeOrdinaryPublicationRelease,
  KnowledgeDiscoveryPageBatch, KnowledgeDiscoveryPageBatchRequest,
  KnowledgeAutomaticMaintenancePolicy, KnowledgeAutomaticMaintenanceRequest, KnowledgeAutomaticMaintenanceResult,
  KnowledgeAutomaticMaintenanceInspection, KnowledgeAutomaticAuthorizationId, KnowledgeAutomaticConversationResult,
  KnowledgeAutomaticTimelineResult,
} from './types.ts'

export type * from './types.ts'
export { hasInformedBrainRead, requireUserEvidenceSource } from './model-write-evidence.ts'
export { parseAutomaticMaintenanceReview, automaticMaintenanceReviewDigest, automaticMaintenancePageId,
  automaticMaintenanceReviewEvidenceFailure, validateAutomaticMaintenanceRequest } from './automatic-maintenance.ts'
export type { KnowledgeAutomaticMaintenanceReview } from './automatic-maintenance.ts'

/** Internal continuation result; the tool returns the actual two-file progress instead of claiming no write. */
class AutomaticMergeIncompleteError extends Error {
  constructor(readonly review: KnowledgePageMergeReview) { super(review.lastError ?? review.blockedReason ?? 'AI consolidation remains incomplete') }
}

interface GoalWriteAttempt {
  readonly operation: KnowledgeGoalOperation
  readonly observation: GoalWriteObservation
}

/** Knowledge directory, read/write bounds and writer coordination. */
export interface Config {
  /** Explicit AI maintenance opt-in and private retention, full-review and model execution bounds. */
  readonly automaticMaintenance: KnowledgeAutomaticMaintenancePolicy
  /** Maximum distinct knowledge references retained per conversation; changing this rebuilds the projection cache. */
  readonly maxConversationReferences: number
  /** Durable successful-access retention and host-local trend length. */
  readonly access: KnowledgeAccessPolicy
  /** Retained rejected Goal writes and complete per-run attempt record bounds. */
  readonly goalHistory: KnowledgeGoalHistoryPolicy
  /** Durable human two-page approvals, bounded without discarding unfinished or completed operations. */
  readonly pageMerges: KnowledgePageMergePolicy
  /** Private human editor inputs, retained outside Brain files and model context with compare-and-set revisions. */
  readonly editorDrafts: KnowledgeEditorDraftPolicy
  /** Absent disables model-assisted checking; supplied policy enables the existing Agent engine. */
  readonly healthCheck?: HealthCheckPolicy | null
  /** Opt-in delayed health assessment after a successful UI page or root publication; requires healthCheck. */
  readonly healthAfterWrite?: {
    /** Delay after each publication; an active background assessment suppresses another due check. */
    readonly delayMs: number
  } | null
  /** Opt-in one-shot startup assessment of the Client's current project; requires healthCheck. */
  readonly healthOnStartup?: HealthStartupPolicy | null
  /** Allow Finder selection on supported macOS hosts; false disables the action in remote deployments. */
  readonly nativeReveal?: boolean
  /** Enable explicit local Brain selection; remote deployments leave this disabled. */
  readonly localLocations?: boolean
  /** Maximum retained reference-folder registrations per project; registering grants no write permission. */
  readonly maxSourceDirectories: number
  /** Project-relative knowledge directory; absolute paths and traversal are refused. */
  readonly directory: string
  /** Inclusive byte cap for a complete document, retained report file or update request. */
  readonly maxDocumentBytes: number
  /** Scan/archive-read byte budget and complete health listing/detail cap; failed reads consume their requested allowance. */
  readonly maxIndexBytes: number
  /** Maximum scanned paths and history references in one daily report; history growth beyond it rejects without pruning. */
  readonly maxEntries: number
  /** Maximum newest non-archived Timeline observations retained in each project index. */
  readonly maxActivityEntries: number
  /** Complete activity JSON cap, including metadata and the result envelope. */
  readonly maxActivityBytes: number
  /** Maximum newest unresolved proposal summaries retained per project, including archived pages. */
  readonly maxPendingProposalEntries: number
  /** Complete pending-proposal JSON cap, including counts and the result envelope; summaries are never shortened. */
  readonly maxPendingProposalBytes: number
  /** Maximum page depth below the pages directory; direct pages have depth one. */
  readonly maxDepth: number
  /** Delay between completed scans while a Client follows project knowledge. */
  readonly refreshIntervalMs: number
  /** Maximum wait for another product writer; cancellation drains this bounded acquisition. */
  readonly writeLockWaitMs: number
}

/** Host file-selection integrations replaceable by direct unit tests. */
export interface KnowledgeControllerInternals {
  readonly now?: () => number
  readonly healthDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  readonly canRevealPath?: () => boolean
}

interface HealthClientContext {
  readonly location: KnowledgeLocation | null
  readonly locale: 'en' | 'zh-CN'
  readonly model: ModelSelection | null
}

interface HealthClientCycle {
  readonly lifetime: AbortController
  readonly operations: Set<Promise<void>>
  startup?: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the project knowledge Remote namespace. */
    knowledgeController: KnowledgeController
  }
}

/** Reads project Brain Markdown and publishes page understanding with retained evidence. */
export class KnowledgeController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'fs', 'storageDomain']
  static Config: z<Config> = z.object({
    automaticMaintenance: z.object({
      enabled: z.boolean().default(false),
      maxRecords: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
      maxRecordBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
      maxReviewBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
      maxReviewAttempts: z.number().step(1).min(1).max(2).default(2),
      maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2 * 1024 * 1024),
      maxOutputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16384),
      reasoningEffort: z.union([z.string().min(1), z.const(undefined)]),
      timeoutMs: z.number().step(1).min(1).max(2147483647).default(120000),
    }).default({ enabled: false, maxRecords: 1000, maxRecordBytes: 32 * 1024 * 1024,
      maxReviewBytes: 16 * 1024 * 1024, maxReviewAttempts: 2, maxOutputBytes: 2 * 1024 * 1024, maxOutputTokens: 16384, timeoutMs: 120000 }),
    maxConversationReferences: z.number().step(1).min(1).max(1000).default(8),
    editorDrafts: z.object({
      enabled: z.boolean().default(true),
      maxRecords: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
      maxRecordBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
      maxListBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
    }).default({ enabled: true, maxRecords: 1000, maxRecordBytes: 16 * 1024 * 1024, maxListBytes: 32 * 1024 * 1024 }),
    pageMerges: z.object({
      maxRecords: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
      maxRecordBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
      maxListBytes: z.number().step(1).min(1).default(256 * 1024),
    }).default({ maxRecords: 1000, maxRecordBytes: 16 * 1024 * 1024, maxListBytes: 256 * 1024 }),
    goalHistory: z.object({
      maxRejected: z.number().step(1).min(1).max(10000).default(20),
      maxReasonChars: z.number().step(1).min(1).default(300),
      maxRecordBytes: z.number().step(1).min(1).default(65536),
    }).default({ maxRejected: 20, maxReasonChars: 300, maxRecordBytes: 65536 }),
    access: z.object({
      recentLimit: z.number().step(1).min(1).max(10000).default(100),
      retentionDays: z.number().step(1).min(2).max(3660).default(40),
      trendDays: z.number().step(1).min(2).max(3660).default(30),
    }).default({ recentLimit: 100, retentionDays: 40, trendDays: 30 }),
    healthCheck: z.union([z.const(null), z.object({
      backgroundReasoningEffort: z.string().min(1).max(64).pattern(/^[^\s\0]+$/u),
      maxConcurrent: z.number().step(1).min(1).required(),
      maxContextBytes: z.number().step(1).min(1).required(),
      maxOutputTokens: z.number().step(1).min(1).required(),
      maxOutputBytes: z.number().step(1).min(1).required(),
      timeoutMs: z.number().step(1).min(1).max(2147483647).required(),
      code: z.object({
        gitExecutable: z.string().min(1).required(), maxCommits: z.number().step(1).min(1).required(),
        maxEntries: z.number().step(1).min(1).required(), maxFiles: z.number().step(1).min(1).required(),
        maxDepth: z.number().step(1).min(1).required(), maxFileBytes: z.number().step(1).min(1).required(),
        maxEvidenceBytes: z.number().step(1).min(1).required(), maxTerms: z.number().step(1).min(1).required(),
        maxMatches: z.number().step(1).min(1).required(), commandBytes: z.number().step(1).min(1).required(),
        graceMs: z.number().step(1).min(1).max(2147483647).required(),
      }).required(),
    })]).default(null),
    healthAfterWrite: z.union([z.const(null), z.object({
      delayMs: z.number().step(1).min(1).max(2147483647).required(),
    })]).default(null),
    healthOnStartup: z.union([z.const(null), z.object({
      delayMs: z.number().step(1).min(1).max(2147483647).required(),
      minReportAgeMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      maxEntries: z.number().step(1).min(1).required(),
      maxDepth: z.number().step(1).min(0).required(),
      extensions: z.array(z.string().pattern(/^\.[a-zA-Z0-9]+$/)).min(1).required(),
      excludedDirectories: z.array(z.string().pattern(/^[^/\\\0]+$/)).required(),
    })]).default(null),
    nativeReveal: z.boolean(),
    localLocations: z.boolean().default(false),
    maxSourceDirectories: z.number().step(1).min(1).default(32),
    directory: z.string().default('brain'),
    maxDocumentBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxIndexBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
    maxEntries: z.number().step(1).min(1).default(1000),
    maxActivityEntries: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(50),
    maxActivityBytes: z.number().step(1).min(64).default(64 * 1024),
    maxPendingProposalEntries: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(50),
    maxPendingProposalBytes: z.number().step(1).min(64).default(64 * 1024),
    maxDepth: z.number().step(1).min(1).default(6),
    refreshIntervalMs: z.number().step(1).min(1).max(2147483647).default(2000),
    writeLockWaitMs: z.number().step(1).min(1).max(2147483647).default(2000),
  })

  private readonly files: KnowledgeFiles
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canRevealPath: () => boolean
  private readonly lifetime = new AbortController()
  private readonly updates = new Set<Promise<unknown>>()
  private readonly sessionWriteAdmissions = new Set<(session: Session, execution: BrainModelWriteExecution | undefined) => void>()
  private readonly sessionCreateAdmissions = new Set<(session: Session,
    execution: BrainModelWriteExecution | undefined, projectId: WorkspaceId,
    documentId: KnowledgeDocumentId, signal: AbortSignal) => Promise<void>>()
  private readonly sessionUpdateAdmissions = new Set<(session: Session,
    execution: BrainModelWriteExecution | undefined, projectId: WorkspaceId,
    documentId: KnowledgeDocumentId, signal: AbortSignal) => Promise<void>>()
  private readonly checks = new Set<WorkspaceId>()
  private backgroundHealthRunning = false
  private readonly healthClients = new Map<KnowledgeHealthClientId, { revision: number; context: HealthClientContext | null }>()
  private healthCycle: HealthClientCycle | undefined
  private readonly healthDelay: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private healthCheckStore!: KnowledgeHealthCheckStore
  private accessStore!: KnowledgeAccessStore
  private goalHistory!: KnowledgeGoalHistoryStore
  private mergeStore!: KnowledgePageMergeStore
  private draftStore!: KnowledgeEditorDraftStore
  private ordinaryPublicationStore!: KnowledgeOrdinaryPublicationStore
  private ordinaryCatalogReads!: KnowledgeOrdinaryCatalogReadStore
  private automaticMaintenanceStore!: KnowledgeAutomaticMaintenanceStore
  private readonly ordinaryPublicationInFlight = new Map<string, { request: KnowledgeOrdinaryDraftPublishRequest; projectPath: string }>()
  private locations!: KnowledgeLocationStore
  private readonly now: () => number

  /**
   * @param ctx - Host context carrying the Workspace registry and filesystem.
   * @param config - validated directory and scan bounds.
   * @param internals - native file-selection integrations for adapter tests.
   */
  constructor(ctx: Context, private readonly config: Config, internals: KnowledgeControllerInternals = {}) {
    super(ctx, 'knowledgeController', { namespace: 'knowledge' })
    relativeSegments(config.directory)
    this.files = new KnowledgeFiles(ctx.fs, config, (location) => { this.locations.assertCurrent(location) })
    if (config.access.trendDays > config.access.retentionDays) throw new Error('knowledge access trendDays must not exceed retentionDays')
    if (config.healthAfterWrite != null && config.healthCheck == null) throw new Error('healthAfterWrite requires healthCheck')
    if (config.healthOnStartup != null && config.healthCheck == null) throw new Error('healthOnStartup requires healthCheck')
    this.now = internals.now ?? Date.now
    this.healthDelay = internals.healthDelay ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }))
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canRevealPath = () => config.nativeReveal !== false && (internals.canRevealPath ?? canRevealNativePath)()
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
    }, 'knowledge-controller: page updates')
  }

  /** Register an import owner's live authorization check for conversation Brain writes.
   * @param admission - checks the retained Session, model tool arguments and durable review at every write admission.
   * @returns a disposer attached to the registering plugin's lifetime.
   */
  registerSessionWriteAdmission(
    admission: (session: Session, execution: BrainModelWriteExecution | undefined) => void,
  ): () => Promise<void> {
    return this.ctx.effect(() => {
      this.sessionWriteAdmissions.add(admission)
      return () => { this.sessionWriteAdmissions.delete(admission) }
    }, 'knowledge-controller: import write admission')
  }

  /** Register a session page-creation check inside the selected project's publication queue.
   * @param admission - async pre-publication check that must not enter another location operation for this project.
   * @returns a disposer attached to the registering plugin's lifetime.
   */
  registerSessionCreateAdmission(admission: (session: Session, execution: BrainModelWriteExecution | undefined,
    projectId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal) => Promise<void>): () => Promise<void> {
    return this.ctx.effect(() => {
      this.sessionCreateAdmissions.add(admission)
      return () => { this.sessionCreateAdmissions.delete(admission) }
    }, 'knowledge-controller: import create admission')
  }

  /** Register a session truth-update check inside the selected project's publication queue.
   * @param admission - async pre-publication check that must not enter another location operation for this project.
   * @returns a disposer attached to the registering plugin's lifetime.
   */
  registerSessionUpdateAdmission(admission: (session: Session, execution: BrainModelWriteExecution | undefined,
    projectId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal) => Promise<void>): () => Promise<void> {
    return this.ctx.effect(() => {
      this.sessionUpdateAdmissions.add(admission)
      return () => { this.sessionUpdateAdmissions.delete(admission) }
    }, 'knowledge-controller: import update admission')
  }

  private async assertSessionUpdateAdmission(sessionId: SessionId, projectId: WorkspaceId,
    documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<void> {
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (session === undefined) throw new Error('Brain authoring conversation changed before truth publication')
    const execution = currentBrainModelWrite(this.ctx.root, sessionId)
    for (const admission of this.sessionUpdateAdmissions) {
      await admission(session, execution, projectId, documentId, signal)
    }
  }

  private async assertSessionCreateAdmission(sessionId: SessionId, projectId: WorkspaceId,
    documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<void> {
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (session === undefined) throw new Error('Brain authoring conversation changed before page publication')
    const execution = currentBrainModelWrite(this.ctx.root, sessionId)
    for (const admission of this.sessionCreateAdmissions) {
      await admission(session, execution, projectId, documentId, signal)
    }
  }

  private assertSessionWriteAdmission(session: Session): void {
    if (!this.isKnowledgeImportSession(session)) return
    if (this.sessionWriteAdmissions.size === 0) throw new Error('Knowledge import review authorization is unavailable')
    const execution = currentBrainModelWrite(this.ctx.root, session.id)
    for (const admission of this.sessionWriteAdmissions) admission(session, execution)
  }

  private isKnowledgeImportSession(session: Session): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return session.snapshotEvents().some((event) => {
      if (event.type !== 'user/message') return false
      const sourceKind: string = event.data.source.kind
      return sourceKind === 'knowledge-import'
    })
  }

  private requireReviewedSessionPublication(sessionId: SessionId, documentId: KnowledgeDocumentId): void {
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (session === undefined || !this.isKnowledgeImportSession(session)) {
      throw new RemoteError('knowledge/update',
        'Ordinary conversations cannot publish active Brain pages; retain a draft for separate human review',
        { path: documentId, reason: 'read-only' })
    }
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.inject(['sessionProjections'], (ctx) => {
      ctx.sessionProjections.register(knowledgeReferencesProjection(this.config.maxConversationReferences))
      ctx.sessionProjections.register(curationStatusProjection)
    })
    const locations = await this.ctx.storageDomain.open(knowledgeLocationDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await locations.close()
    }, 'knowledge-controller: Brain locations')
    const sources = await this.ctx.storageDomain.open(knowledgeSourceDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await sources.close()
    }, 'knowledge-controller: source folders')
    this.locations = new KnowledgeLocationStore(locations.table('projects'), this.ctx.fs, this.config.directory,
      id => this.workspacePath(id), sources.table('projects'), this.config.maxSourceDirectories,
      () => {
        const subprocess = this.ctx.get('subprocess')
        if (subprocess === undefined) throw new Error('Changing the Brain location requires a subprocess provider')
        const sandboxPolicy = this.ctx.get('sandboxPolicy')
        if (sandboxPolicy === undefined) throw new Error('Changing the Brain location requires a sandbox policy')
        const releaseProcess = subprocess.reserveQuiescentWindow()
        try {
          const releaseMutation = sandboxPolicy.reserveProtectedRootChange()
          return () => { releaseMutation(); releaseProcess() }
        } catch (error) {
          releaseProcess()
          throw error
        }
      })
    this.ctx.inject(['sandboxPolicy'], (scope: Context) => {
      scope.sandboxPolicy.registerProtectedWriteRoots(() => this.ctx.workspaceRegistry.list()
        .map(project => this.locations.get(project.id).path))
    })
    const domain = await this.ctx.storageDomain.open(knowledgeAccessDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await domain.close()
    }, 'knowledge-controller: access history')
    this.accessStore = new KnowledgeAccessStore(domain.table('history'), this.config.access, this.now,
      (error) => { this.ctx.logger.warn('Knowledge access statistics could not be persisted: %s', error) })
    await this.accessStore.initialize()
    const merges = await this.ctx.storageDomain.open(knowledgePageMergeDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await merges.close()
    }, 'knowledge-controller: human page merges')
    this.mergeStore = new KnowledgePageMergeStore(merges.table('operations'), this.config.pageMerges, this.config.maxDocumentBytes)
    await this.mergeStore.initialize()
    const drafts = await this.ctx.storageDomain.open(knowledgeEditorDraftDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await drafts.close()
    }, 'knowledge-controller: private editor drafts')
    this.draftStore = new KnowledgeEditorDraftStore(drafts.table('drafts'), this.config.editorDrafts)
    const ordinaryPublications = await this.ctx.storageDomain.open(knowledgeOrdinaryPublicationDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await ordinaryPublications.close()
    }, 'knowledge-controller: ordinary draft confirmations')
    this.ordinaryPublicationStore = new KnowledgeOrdinaryPublicationStore(ordinaryPublications.table('confirmations'),
      this.config.editorDrafts)
    const ordinaryReads = await this.ctx.storageDomain.open(knowledgeOrdinaryCatalogReadDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await ordinaryReads.close()
    }, 'knowledge-controller: ordinary full-page read receipts')
    this.ordinaryCatalogReads = new KnowledgeOrdinaryCatalogReadStore(ordinaryReads.table('receipts'),
      this.config.editorDrafts)
    const automatic = await this.ctx.storageDomain.open(knowledgeAutomaticMaintenanceDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await automatic.close()
    }, 'knowledge-controller: automatic maintenance intents')
    this.automaticMaintenanceStore = new KnowledgeAutomaticMaintenanceStore(automatic.table('operations'),
      this.config.automaticMaintenance)
    const healthChecks = await this.ctx.storageDomain.open(knowledgeHealthCheckDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await healthChecks.close()
    }, 'knowledge-controller: health check outcomes')
    this.healthCheckStore = new KnowledgeHealthCheckStore(healthChecks.table('projects'), this.now)
    await this.healthCheckStore.initialize()
    const history = await this.ctx.storageDomain.open(knowledgeGoalHistoryDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.updates])
      await history.close()
    }, 'knowledge-controller: Goal write history')
    this.goalHistory = new KnowledgeGoalHistoryStore(history.table('runs'), this.config.goalHistory)
    for (const [runId, record] of history.table('runs').entries()) {
      await this.goalHistory.initialize({ runId, sourceSessionId: record.sourceSessionId,
        workspaceId: record.workspaceId, projectPath: record.projectPath }, record.trackedFromStart)
    }
    this.ctx.on('project-goal/prepare', (workspaceId, sourceSessionId, runId, signal) =>
      this.trackOperation(signal, async (live) => {
        const projectPath = this.workspacePath(workspaceId)
        live.throwIfAborted()
        await this.goalHistory.initialize({ workspaceId, sourceSessionId, runId, projectPath }, true)
      }))
  }

  /** Resolve the project's saved Brain selection without filesystem work.
   * @param workspaceId - currently registered project.
   * @returns committed location and revision; unfinished initialization does not change reads.
   */
  @Remote
  location(workspaceId: WorkspaceId): KnowledgeLocation { return this.locations.get(workspaceId) }

  /** Read complete private editor inputs and deletion revisions without opening files or activating an Agent.
   * @param workspaceId - registered project whose private drafts are requested.
   * @param signal - cancels queued reads; unload rejects new work and drains admitted calls.
   * @returns all retained rows and deployment policy; failures never masquerade as an empty list.
   * @throws for model initiators, changed project registration, corrupt persistence, or configured capacity.
   */
  @Remote
  async editorDrafts(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgeEditorDraftList> {
    const projectPath = this.draftProject(workspaceId, false)
    return this.trackOperation(signal, live => this.draftStore.list(workspaceId, projectPath, () => {
      live.throwIfAborted()
      this.assertDraftProject(workspaceId, projectPath, false)
    }))
  }

  /** Save the complete editor state; this grants no authority to publish its text as knowledge.
   * @param workspaceId - registered, non-archived project owning the editor.
   * @param request - full baseline, input, optional original confirmation, and observed draft revision.
   * @param signal - cancels before durable admission; an admitted write can finish and must be inspected after an uncertain response.
   * @returns the durable row with its new revision; equal payloads still reject stale revisions.
   * @throws for unauthorized callers, stale revisions, disabled saving, invalid identity, limits or persistence failure.
   */
  @Remote
  async saveEditorDraft(workspaceId: WorkspaceId, request: KnowledgeEditorDraftSave,
    signal: AbortSignal): Promise<KnowledgeEditorDraftRow> {
    const projectPath = this.draftProject(workspaceId, true)
    return this.trackOperation(signal, live => this.draftStore.save(workspaceId, projectPath, request, () => {
      live.throwIfAborted()
      this.assertDraftProject(workspaceId, projectPath, true)
    }))
  }

  /** Discard only the currently observed draft, retaining a deletion revision against stale-window recreation.
   * @param workspaceId - registered project owning the private draft.
   * @param request - exact editor identity and observed revision; null reserves an unseen identity against a delayed initial save.
   * @param signal - cancels before storage admission; accepted persistence is drained on unload.
   * @returns the acknowledged deletion marker; any accepted knowledge operation remains independent.
   * @throws for unauthorized callers, changed registration, stale revisions, limits or persistence failure.
   */
  @Remote
  async removeEditorDraft(workspaceId: WorkspaceId, request: KnowledgeEditorDraftRemoval,
    signal: AbortSignal): Promise<KnowledgeEditorDraftRow> {
    const projectPath = this.draftProject(workspaceId, false)
    return this.trackOperation(signal, live => this.draftStore.remove(workspaceId, projectPath, request, () => {
      live.throwIfAborted()
      this.assertDraftProject(workspaceId, projectPath, false)
    }))
  }

  private draftProject(workspaceId: WorkspaceId, writing: boolean): string {
    if (this.ctx.get('agents')?.currentInitiator() !== undefined) {
      throw new RemoteError('knowledge/draft', 'Private knowledge editor drafts are available only to trusted UI or Host callers', { reason: 'not-human' })
    }
    const projectPath = this.workspacePath(workspaceId)
    if (writing && this.ctx.workspaceRegistry.get(workspaceId)?.archivedAt !== undefined) {
      throw new RemoteError('knowledge/draft', 'Archived projects cannot save new knowledge editor inputs', { reason: 'invalid' })
    }
    return projectPath
  }

  private assertDraftProject(workspaceId: WorkspaceId, projectPath: string, writing: boolean): void {
    if (this.draftProject(workspaceId, writing) !== projectPath) {
      throw new RemoteError('knowledge/draft', 'Project registration changed while waiting to access knowledge editor drafts', { reason: 'identity-conflict' })
    }
  }

  /** List the project's reference-folder registrations without probing their files.
   * @param workspaceId - registered project whose references are requested.
   * @returns saved absolute paths and their revision, independent of the Brain selection.
   * @throws when the project is absent or persisted paths belong to another project directory.
   */
  @Remote
  sourceDirectories(workspaceId: WorkspaceId): KnowledgeSourceDirectories { return this.locations.getSources(workspaceId) }

  /** Add or remove one project reference-folder registration; file access and write permissions are unchanged.
   * @param workspaceId - registered project owning this reference.
   * @param path - explicit absolute Host folder; unavailable folders may remain registered.
   * @param present - true to add, false to remove; repeated requests retain the current revision.
   * @param signal - cancels before storage admission; unload also cancels and drains accepted work.
   * @returns the committed reference-folder list and revision.
   * @throws for disabled local selection, invalid paths, capacity, changed registration or persistence failure.
   */
  @Remote
  async setSourceDirectory(workspaceId: WorkspaceId, path: string, present: boolean,
    signal: AbortSignal): Promise<KnowledgeSourceDirectories> {
    if (this.config.localLocations !== true) throw new Error('Local source-folder registration is disabled in this deployment')
    return this.trackOperation(signal, live => this.locations.setSource(workspaceId, path, present, live))
  }

  /** Save a local Brain selection after initialization, without moving or deleting either directory.
   * @param workspaceId - registered project; its working directory remains unchanged.
   * @param path - absolute local directory, or null to restore the configured project-relative default.
   * @param expectedRevision - selection revision displayed to the user, including null before first selection.
   * @param initIfEmpty - explicit permission to initialize an unrecognized selected directory.
   * @param signal - cancels before final storage admission; accepted persistence may still complete.
   * @returns saved selection or a non-writing confirmation/missing-parent response.
   * @throws when local selection is disabled, the revision is stale, a changed explicit path overlaps a source folder,
   * paths are unsafe or initialization fails.
   */
  @Remote
  async setLocation(workspaceId: WorkspaceId, path: string | null, expectedRevision: KnowledgeLocationRevision | null,
    initIfEmpty: boolean, signal: AbortSignal): Promise<KnowledgeLocationSelection> {
    if (this.config.localLocations !== true) throw new Error('Local Brain selection is disabled in this deployment')
    return this.trackOperation(signal, live => this.locations.select(workspaceId, path, expectedRevision, initIfEmpty, live))
  }

  /** Admit Host-owned local preparation against one unchanged project selection.
   * @param workspaceId - registered project owning the operation.
   * @param signal - caller lifecycle; controller unload also cancels and drains the operation.
   * @param operation - work on the admitted location; must not enqueue another location operation for this project.
   * @returns after the operation settles; location changes wait behind it and stale queued work rejects.
   */
  async withLocation<T>(workspaceId: WorkspaceId, signal: AbortSignal,
    operation: (location: KnowledgeLocation, live: AbortSignal) => Promise<T>): Promise<T> {
    return this.trackOperation(signal, live => this.locations.run(workspaceId, live, location => operation(location, live)))
  }

  /** Account for a completed operation without granting access to its document.
   * @param access - identity captured by the authorized UI or model operation; never caller-supplied project authority.
   * @returns after statistics publication; a storage failure marks counts incomplete without failing the completed operation.
   */
  async recordAccess(access: KnowledgeAccess): Promise<void> {
    this.ctx.emit('knowledge/access', access)
    const pending = this.accessStore.record(access)
    this.updates.add(pending)
    try { await pending } finally { this.updates.delete(pending) }
  }

  /** Inspect a user-selected local Brain candidate without saving it or creating files.
   * @param workspaceId - registered project for which the user is selecting a folder.
   * @param path - explicit absolute Host folder; this does not grant file-content access or write authority.
   * @param signal - cancels metadata checks; unload also cancels and drains the operation.
   * @returns presence of structural Brain markers, need for confirmation, or a missing parent.
   * @throws for changed registration, non-directory components, links, unavailable Host sharing or filesystem errors.
   */
  @Remote
  async inspectLocation(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<KnowledgeLocationInspection> {
    const projectPath = this.workspacePath(workspaceId)
    return this.trackOperation(signal, async (live) => {
      const authorize = (): void => {
        if (this.ctx.workspaceRegistry.get(workspaceId)?.path !== projectPath) throw new Error('Project registration changed during Brain location inspection')
        live.throwIfAborted()
      }
      return { workspaceId, ...await inspectLocalBrainLocation(this.ctx.fs, path, live, authorize) }
    })
  }

  /** Run one read-only model assessment and publish its version-qualified daily report.
   * @param workspaceId - registered project to capture; one check may run per project.
   * @param options - explicit scope, language and optional implementation evidence.
   * @param signal - cancels analysis before publication admission; teardown drains the owned Agent.
   * @returns the published report and durable analysis Session identity; lastCheck retains settlement independently of old reports.
   * @throws when checking is disabled, another check is active, capture fails or the model does not finish validly.
   */
  @Remote
  async checkHealth(
    workspaceId: WorkspaceId, options: KnowledgeHealthCheckOptions, signal: AbortSignal,
  ): Promise<KnowledgeHealthCheckResult> {
    const policy = this.config.healthCheck
    if (policy === undefined || policy === null) throw new Error('Brain Health model checking is disabled in this deployment')
    if (this.checks.has(workspaceId)) throw new Error('A Brain Health check is already running for this project')
    if (this.checks.size >= policy.maxConcurrent) throw new Error('Brain Health has reached its configured concurrent-check limit')
    const location = this.locations.get(workspaceId)
    this.checks.add(workspaceId)
    try {
      return await this.trackOperation(signal, async (live) => {
        live.throwIfAborted()
        const attempt = await this.healthCheckStore.begin(location)
        try {
          const result = await runKnowledgeHealthCheck(this.ctx, workspaceId, options, policy,
            relative(location.projectPath, location.path).split('\\').join('/'), live, () => { this.locations.assertCurrent(location) })
          await this.healthCheckStore.finish(attempt, result)
          return result
        } catch (error) {
          await this.healthCheckStore.finish(attempt, error instanceof HealthAssessmentIncompleteError ? error.reason
            : error instanceof TimeoutReason ? 'timeout' : live.aborted ? 'cancelled' : 'error')
          throw error
        }
      })
    } finally { this.checks.delete(workspaceId) }
  }

  /** Register one connected Client; the first remaining registration owns automatic assessment context.
   * @param signal - connection lifetime; cancellation immediately withdraws this Client.
   * @returns one Host-issued identity, followed by an open stream until withdrawal or Host unload.
   * @remarks The first registration starts the configured startup delay. Removing the last registration
   * cancels and drains automatic work; a later registration establishes a new startup cycle.
   */
  @Remote({ mode: 'stream' })
  async *registerHealthClient(signal: AbortSignal): AsyncIterable<KnowledgeHealthClientId> {
    const live = AbortSignal.any([signal, this.lifetime.signal])
    live.throwIfAborted()
    const id = randomUUID() as KnowledgeHealthClientId
    const cycle = this.healthCycle ?? { lifetime: new AbortController(), operations: new Set<Promise<void>>() }
    this.healthClients.set(id, { revision: -1, context: null })
    if (this.healthCycle === undefined) {
      this.healthCycle = cycle
      this.startStartupHealth(cycle)
    }
    const withdrawn = Promise.withResolvers<void>()
    const withdraw = (): void => {
      if (!this.healthClients.delete(id)) return
      if (this.healthClients.size !== 0) { withdrawn.resolve(); return }
      this.healthCycle = undefined
      cycle.lifetime.abort()
      void Promise.allSettled(cycle.operations).then(() => { withdrawn.resolve() })
    }
    live.addEventListener('abort', withdraw, { once: true })
    try { yield id; await withdrawn.promise } finally {
      live.removeEventListener('abort', withdraw)
      withdraw()
      await withdrawn.promise
    }
  }

  /** Update one registered Client without starting a conversation or enabling an unconfigured policy.
   * @param clientId - identity supplied by this Client's still-open registration stream.
   * @param revision - increasing nonnegative safe integer; reordered older notifications are ignored.
   * @param workspaceId - current Client project, or null when none is selected.
   * @param locale - current Client language used when the delayed check captures its target.
   * @param model - resolved Client selection, or null to withhold automatic checks until a selection is available.
   * @param signal - cancels notification admission, not already accepted Host-owned background work.
   * @returns after this registration cycle's startup work settles; notifications share that completion.
   * @throws when the registration has ended or the revision is invalid.
   * @remarks Only the first remaining Client supplies automatic context. Notifications never restart a timer.
   * A missing project or model at the deadline skips checking. Failed attempts remain visible and are not retried on reconnect.
   */
  @Remote
  scheduleStartupHealth(clientId: KnowledgeHealthClientId, revision: number, workspaceId: WorkspaceId | null,
    locale: 'en' | 'zh-CN', model: ModelSelection | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Brain Health Client revision must be a nonnegative safe integer')
    const client = this.healthClients.get(clientId)
    if (client === undefined) throw new Error('Brain Health Client registration is no longer connected')
    if (revision > client.revision) {
      const location = workspaceId === null ? null : this.locations.get(workspaceId)
      client.context = { location, locale, model }
      client.revision = revision
    }
    return this.healthCycle?.startup ?? Promise.resolve()
  }

  private startStartupHealth(cycle: HealthClientCycle): void {
    const policy = this.config.healthOnStartup
    if (policy == null) return
    cycle.startup = this.trackAutomaticHealth(cycle, async (live) => {
      let location: KnowledgeLocation | undefined
      let admitted = false
      try {
        await this.healthDelay(policy.delayMs, live)
        live.throwIfAborted()
        const current = this.healthClients.values().next().value?.context
        if (current == null || current.location === null || current.model === null) {
          this.ctx.logger.debug('Startup Brain Health check skipped: Client project or model is unavailable')
          return
        }
        location = current.location
        this.locations.assertCurrent(current.location)
        if (this.healthCheckStore.read(current.location).status === 'failed') return
        const reports = await this.healthReports(current.location.workspaceId, live)
        if (reports.truncated || reports.issues.length > 0) throw new Error('Startup health report history is incomplete or unreadable')
        if (!await startupHealthDue(this.ctx, current.location, reports.reports[0]?.checkedAt, this.now(), policy, live)) return
        this.locations.assertCurrent(current.location)
        admitted = true
        await this.runBackgroundHealth(current.location, { locale: current.locale, scope: 'all-active', pageId: null,
          model: current.model,
          includeDrafts: false, includeArchived: false, checkCodeChanges: true }, live)
      } catch (error) {
        if (!live.aborted) {
          if (location !== undefined && !admitted) await this.retainHealthPreflightFailure(location)
          this.ctx.logger.warn('Startup Brain Health check skipped or failed: %s', error)
        }
      }
    })
  }

  /** Replace current understanding, append evidence and refresh the portable index after page publication.
   * @param workspaceId - registered project owning the existing page.
   * @param documentId - Brain-relative page identity; root documents are not accepted.
   * @param request - complete retained input and version from the informing read.
   * @param signal - cancels before publication; pending lock acquisition is drained before return.
   * @returns a durable operation receipt; retrying identical input never republishes or appends again.
   * @throws for invalid, archived, stale, conflicting, missing, unsafe or oversized documents and inputs.
   * @remarks Index failure reports an already-saved page; an identical request retries indexing without repeating evidence.
   */
  @Remote
  async updateTruth(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgeTruthUpdate, signal: AbortSignal,
  ): Promise<KnowledgeTruthReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.admitUpdate(workspaceId, documentId, request, signal, () => { this.locations.assertCurrent(location) }, true)
    await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  /** Read complete retained ordinary rewrite images without exposing them as current model knowledge.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing Brain-relative page or fixed root identity.
   * @param signal - cancels reads and joins them during controller disposal.
   * @returns the current version and retained normalized page understanding or exact root body bytes; no invented legacy history.
   * @throws for malformed recovery metadata, unsafe paths or a complete result exceeding maxDocumentBytes.
   */
  @Remote
  async truthHistory(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<KnowledgeTruthHistory> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return readTruthHistory(documentId, text,
        version, this.config.maxDocumentBytes)
    })
  }

  /** Inspect one exact ordinary update receipt in the selected project's current file without admitting a write.
   * @param workspaceId - registered project owning the original update.
   * @param documentId - exact existing Brain page, never a root or another project's page.
   * @param request - original complete update, including its operation UUID and informing version.
   * @param signal - cancels the bounded read; no Agent or model is started.
   * @returns current file version only when one real Timeline receipt matches the complete request; null when absent.
   * @throws for changed project selection, malformed files, conflicting operation identities or unavailable pages.
   */
  @Remote
  async truthUpdateReceipt(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeTruthUpdate, signal: AbortSignal): Promise<{ readonly version: string } | null> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return hasTruthUpdateReceipt(documentId, text, version,
        request, this.config.maxDocumentBytes) ? { version } : null
    })
  }

  /** Review an ordinary saved draft against two independent complete active searches and a stable catalog.
   * @param workspaceId - registered project that owns the draft.
   * @param documentId - exact Brain page, not a root or held import, Task or Goal draft.
   * @param topicQuery - human-selected subject terms containing a token outside the page title.
   * @param signal - cancels bounded reads without publishing.
   * @returns full draft, search receipts, active pages and roots, and a location-qualified review digest.
   * @throws when a draft, search, catalog or selected Brain is incomplete or changes during review.
   */
  @Remote
  async reviewOrdinaryDraft(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    topicQuery: string, signal: AbortSignal): Promise<KnowledgeOrdinaryDraftReview> {
    return this.trackOperation(signal, async (live) => {
      const result = await this.ordinaryDraftReview(workspaceId, documentId, topicQuery, live)
      return result.review
    })
  }

  /** Deliver one complete active body and retain a Host-only receipt only while its draft review stays stable.
   * @param workspaceId - registered project that owns the draft and old document.
   * @param documentId - exact ordinary draft page.
   * @param request - review digest, catalog and old-document identity shown to the human.
   * @param signal - cancels review and full-document reads.
   * @returns exact body or changed without a receipt; the method does not infer a relation.
   */
  @Remote
  async readOrdinaryDraftCatalogPage(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeOrdinaryCatalogReadRequest, signal: AbortSignal): Promise<KnowledgeOrdinaryCatalogRead> {
    return this.trackOperation(signal, async (live) => {
      const first = await this.ordinaryDraftReview(workspaceId, documentId, request.topicQuery, live)
      const old = first.review.activePages.find(page => page.id === request.path)
      if (first.review.document.entry.version !== request.expectedDraftVersion
        || first.review.activeIndexDigest !== request.expectedActiveIndexDigest
        || first.review.reviewDigest !== request.reviewDigest || old?.version !== request.expectedPageVersion) {
        return { kind: 'changed' }
      }
      const page = await this.read(workspaceId, request.path, live)
      const second = await this.ordinaryDraftReview(workspaceId, documentId, request.topicQuery, live)
      if (page.entry.id !== old.id || page.entry.title !== old.title
        || page.entry.status !== 'active' || page.entry.version !== old.version
        || second.review.reviewDigest !== first.review.reviewDigest
        || JSON.stringify(second.review.activePages) !== JSON.stringify(first.review.activePages)) return { kind: 'changed' }
      this.locations.assertCurrent(first.location)
      live.throwIfAborted()
      await this.ordinaryCatalogReads.retain({ workspaceId, projectPath: first.location.projectPath,
        brainDirectory: first.location.directory, locationRevision: first.location.revision,
        draftId: documentId, draftVersion: first.review.document.entry.version,
        activeIndexDigest: first.review.activeIndexDigest, reviewDigest: first.review.reviewDigest,
        topicQuery: first.review.topicQuery, pageId: old.id, pageTitle: old.title,
        pageVersion: old.version, bodySha256: createHash('sha256').update(page.body).digest('hex') })
      return { kind: page.entry.kind, id: old.id, title: old.title, status: 'active', version: old.version, body: page.body }
    })
  }

  /** Return the exact running or durable human confirmation after a UI reload.
   * @param workspaceId - currently registered project.
   * @param documentId - exact Brain page.
   * @param signal - cancels the private read.
   * @returns original request while this Host is executing it or after retention, otherwise null.
   */
  @Remote
  async ordinaryDraftPublicationPending(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    signal: AbortSignal): Promise<KnowledgeOrdinaryDraftPublishRequest | null> {
    return this.trackOperation(signal, (live) => {
      live.throwIfAborted()
      const location = this.locations.get(workspaceId)
      const running = this.ordinaryPublicationInFlight.get(JSON.stringify([workspaceId, documentId]))
      if (running !== undefined && running.projectPath !== location.projectPath) throw new RemoteError('knowledge/update',
        'Ordinary publication is running for a different project root', { path: documentId, reason: 'identity-conflict' })
      return Promise.resolve(running === undefined
        ? this.ordinaryPublicationStore.pending(workspaceId, documentId, location.projectPath)
        : structuredClone(running.request))
    })
  }

  /** Publish only the reviewed ordinary draft after a separate human confirmation.
   * @param workspaceId - original registered project.
   * @param documentId - exact saved draft page.
   * @param request - retained independent UUID, reviewed versions, subject query, reason and evidence.
   * @param signal - cancellation before Brain publication admission.
   * @returns file-owned status receipt; identical input never appends another Timeline row.
   * @remarks A private Host confirmation is durably saved under the Brain/page locks before the file write.
   */
  @Remote
  async publishOrdinaryDraft(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeOrdinaryDraftPublishRequest, signal: AbortSignal): Promise<KnowledgeTruthReceipt> {
    this.assertOrdinaryHuman()
    const input = validateOrdinaryPublicationRequest(request)
    const location = this.locations.get(workspaceId)
    const flightKey = JSON.stringify([workspaceId, documentId])
    if (this.ordinaryPublicationInFlight.has(flightKey)) throw new RemoteError('knowledge/update',
      'Another ordinary publication is still running for this page', { path: documentId, reason: 'busy' })
    this.ordinaryPublicationInFlight.set(flightKey, { request: input, projectPath: location.projectPath })
    try {
      const { target } = await this.documentTarget(workspaceId, documentId, signal)
      const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
      const fileOrigin = this.ordinaryDraftOrigin(documentId, this.files.decodeText(documentId, content.bytes))
      const retained = this.ordinaryPublicationStore.get(workspaceId, documentId, location.projectPath)
      // A legacy draft has no creation row, so its publication becomes the first Timeline row.
      const origin = retained !== null && !retained.abandoned
        && retained.brainDirectory === location.directory && retained.locationRevision === location.revision
        && retained.request.operationId === input.operationId && retained.review.draftOperationId === null
        && fileOrigin.operationId === input.operationId
        ? { operationId: retained.review.draftOperationId, digest: retained.review.draftRequestDigest }
        : fileOrigin
      if (origin.operationId !== null && input.operationId === origin.operationId) throw new RemoteError('knowledge/update',
        'Ordinary publication requires an independent human confirmation UUID', { path: documentId, reason: 'invalid' })
      const release = this.ordinaryRelease(workspaceId, documentId, input, origin)
      const status = this.ordinaryStatusRequest(input)
      const receipt = await this.admitStatus(workspaceId, documentId, status, signal,
        () => { this.locations.assertCurrent(location) }, release, async (retry) => {
          const prior = this.ordinaryPublicationStore.get(workspaceId, documentId, location.projectPath)
          if (retry) {
            if (prior === null || prior.abandoned || JSON.stringify(prior.request) !== JSON.stringify(input)
            || prior.review.draftOperationId !== origin.operationId
            || prior.review.draftRequestDigest !== origin.digest) throw new RemoteError('knowledge/update',
              'Ordinary publication receipt has no matching retained human confirmation',
              { path: documentId, reason: 'identity-conflict' })
            return
          }
          const current = await this.ordinaryDraftReview(workspaceId, documentId, input.topicQuery, signal)
          if (current.review.document.entry.version !== input.expectedDraftVersion
          || current.review.activeIndexDigest !== input.expectedActiveIndexDigest
          || current.review.reviewDigest !== input.reviewDigest
          || current.evidence.draftOperationId !== origin.operationId
          || current.evidence.draftRequestDigest !== origin.digest) throw new RemoteError('knowledge/update',
            'Ordinary draft, searches or active catalog changed since human review', { path: documentId, reason: 'conflict' })
          this.ordinaryCatalogReads.requireDistinct({ workspaceId, projectPath: location.projectPath,
            brainDirectory: location.directory, locationRevision: location.revision, draftId: documentId },
          current.review, input.reviewedPages)
          let replaceSettled = false
          if (prior !== null && !prior.abandoned && JSON.stringify(prior.request) !== JSON.stringify(input)) {
            const { target: currentTarget } = await this.documentTarget(workspaceId, documentId, signal)
            const present = await this.files.readLocated(documentId, currentTarget, this.config.maxDocumentBytes, signal)
            replaceSettled = hasOrdinaryPublicationReceipt(documentId, this.files.decodeText(documentId, present.bytes),
              documentVersion(present.bytes, location), this.ordinaryStatusRequest(prior.request),
              this.ordinaryRelease(workspaceId, documentId, prior.request,
                { operationId: prior.review.draftOperationId, digest: prior.review.draftRequestDigest }))
          }
          await this.ordinaryPublicationStore.retain({ workspaceId, projectPath: location.projectPath,
            brainDirectory: location.directory, locationRevision: location.revision,
            documentId, request: input, review: current.evidence, abandoned: false }, replaceSettled)
        })
      await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
      this.scheduleHealthAfterWrite(location, receipt)
      return receipt
    } finally {
      this.ordinaryPublicationInFlight.delete(flightKey)
    }
  }

  /** Inspect an exact ordinary publication without retrying, changing the page or starting a model.
   * @param workspaceId - original registered project.
   * @param documentId - exact page identity.
   * @param request - complete original human confirmation, never a caller digest alone.
   * @param signal - cancels bounded stable reads.
   * @returns historical publication separately from the current page lifecycle, or explicit uncertainty.
   */
  @Remote
  async ordinaryDraftPublicationReceipt(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeOrdinaryDraftPublishRequest, signal: AbortSignal): Promise<KnowledgeOrdinaryDraftPublicationInspection> {
    const input = validateOrdinaryPublicationRequest(request)
    return this.trackOperation(signal, async (live) => {
      const location = this.locations.get(workspaceId)
      const saved = this.ordinaryPublicationStore.get(workspaceId, documentId, location.projectPath)
      if (saved === null) return { status: 'unknown', reason: 'unavailable' }
      if (JSON.stringify(saved.request) !== JSON.stringify(input)) return { status: 'unknown', reason: 'identity-conflict' }
      if (saved.brainDirectory !== location.directory || saved.locationRevision !== location.revision) {
        return { status: 'unknown', reason: 'unavailable' }
      }
      try {
        const { target } = await this.documentTarget(workspaceId, documentId, live)
        const first = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
        const second = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
        this.locations.assertCurrent(location)
        if (documentVersion(first.bytes, location) !== documentVersion(second.bytes, location)) {
          return { status: 'unknown', reason: 'unavailable' }
        }
        const text = this.files.decodeText(documentId, second.bytes)
        const version = documentVersion(second.bytes, location)
        const origin = saved.review === null ? this.ordinaryDraftOrigin(documentId, text)
          : { operationId: saved.review.draftOperationId, digest: saved.review.draftRequestDigest }
        if (!hasOrdinaryPublicationReceipt(documentId, text, version, this.ordinaryStatusRequest(input),
          this.ordinaryRelease(workspaceId, documentId, input, origin))) {
          return { status: 'not-recorded' }
        }
        const current = parseKnowledgeDocument(documentId, text, version)
        return { status: 'published', operationId: input.operationId, documentId,
          version, currentStatus: current.entry.status }
      } catch (error) {
        if (live.aborted) throw error
        const failure = remoteErrorOf(error)
        return { status: 'unknown', reason: failure?.code === 'knowledge/update' && failure.details.reason === 'identity-conflict'
          ? 'identity-conflict' : 'unavailable' }
      }
    })
  }

  /** Abandon an uncommitted human decision only after its exact file receipt is absent under writer locks.
   * @param workspaceId - original registered project.
   * @param documentId - exact page identity.
   * @param request - complete original confirmation selected by the human.
   * @param signal - cancels before a private tombstone is admitted.
   * @returns abandoned only after a stable absence proof; published or uncertain decisions remain retained.
   */
  @Remote
  async abandonOrdinaryDraftPublication(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeOrdinaryDraftPublishRequest, signal: AbortSignal): Promise<KnowledgeOrdinaryDraftAbandonResult> {
    this.assertOrdinaryHuman()
    const input = validateOrdinaryPublicationRequest(request)
    try {
      return await this.withLocation(workspaceId, signal, (location, live) => this.withBrainPublication(location, live, async () => {
        const saved = this.ordinaryPublicationStore.get(workspaceId, documentId, location.projectPath)
        if (saved !== null && JSON.stringify(saved.request) !== JSON.stringify(input)) {
          return { status: 'refused', reason: 'identity-conflict' } as const
        }
        if (saved !== null && (saved.brainDirectory !== location.directory || saved.locationRevision !== location.revision)) {
          return { status: 'refused', reason: 'unknown' } as const
        }
        const initial = await this.documentTarget(workspaceId, documentId, live)
        return withFileLock(initial.path, async () => {
          const current = await this.documentTarget(workspaceId, documentId, live)
          if (initial.target.targetKey !== current.target.targetKey) return { status: 'refused', reason: 'unknown' } as const
          const first = await this.files.readLocated(documentId, current.target, this.config.maxDocumentBytes, live)
          const second = await this.files.readLocated(documentId, current.target, this.config.maxDocumentBytes, live)
          this.locations.assertCurrent(location)
          if (documentVersion(first.bytes, location) !== documentVersion(second.bytes, location)) {
            return { status: 'refused', reason: 'unknown' } as const
          }
          const text = this.files.decodeText(documentId, second.bytes)
          const version = documentVersion(second.bytes, location)
          const origin = saved?.review === null || saved === null ? this.ordinaryDraftOrigin(documentId, text)
            : { operationId: saved.review.draftOperationId, digest: saved.review.draftRequestDigest }
          if (hasOrdinaryPublicationReceipt(documentId, text, version, this.ordinaryStatusRequest(input),
            this.ordinaryRelease(workspaceId, documentId, input, origin))) {
            return { status: 'refused', reason: 'published' } as const
          }
          live.throwIfAborted()
          if (!await this.ordinaryPublicationStore.abandon(saved === null ? {
            workspaceId, projectPath: location.projectPath, brainDirectory: location.directory,
            locationRevision: location.revision, documentId, request: input, review: null, abandoned: true,
          } : { ...saved, abandoned: true })) {
            return { status: 'refused', reason: 'identity-conflict' } as const
          }
          return { status: 'abandoned' } as const
        }, { waitMs: this.config.writeLockWaitMs })
      }))
    } catch (error) {
      if (signal.aborted) throw error
      const failure = remoteErrorOf(error)
      return { status: 'refused', reason: failure?.code === 'knowledge/update'
        && failure.details.reason === 'identity-conflict' ? 'identity-conflict' : 'unknown' }
    }
  }

  /** Inspect one exact Task-review Timeline append without granting a write or recording access.
   * @param workspaceId - original registered Task project.
   * @param documentId - exact selected Brain page.
   * @param request - complete original logged append request.
   * @param sessionId - original source conversation that authored the attempt.
   * @param signal - cancels the bounded current-file read.
   * @returns true only for one matching durable row; false when absent.
   * @throws for changed Brain location, invalid or unreadable files, and conflicting operation identities.
   */
  async timelineAppendReceipt(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeTimelineAppend, sessionId: SessionId, signal: AbortSignal): Promise<boolean> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return hasTimelineAppendReceipt(documentId, text,
        version, request, sessionId, this.config.maxDocumentBytes)
    })
  }

  /** Resolve retained attribution for non-activating history navigation within the current logical workspace.
   * @param workspaceId - registered project whose current Brain contains the attribution.
   * @param documentId - bounded existing page or root holding the source.
   * @param source - exact source literal or explicit Timeline Session fallback; arbitrary text is not interpreted as a path.
   * @param signal - cancels page and single-Session reads; no Agent is created or resumed.
   * @returns the current inspection address and optional actual message sequence, or an explicit unavailable reason.
   * @throws for corrupt or unreadable documents/logs, missing read services, or a revoked Brain location.
   */
  @Remote
  async resolveSource(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, source: string,
    signal: AbortSignal): Promise<KnowledgeSourceResolution> {
    return this.trackOperation(signal, async (live) => {
      const { target, location } = await this.documentTarget(workspaceId, documentId, live)
      const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
      this.locations.assertCurrent(location)
      const version = documentVersion(content.bytes, location)
      const references = knowledgeSourceReferences(documentId, this.files.decodeText(documentId, content.bytes), version)
      return resolveKnowledgeSource(this.ctx, workspaceId, source, references, live, async () => {
        this.locations.assertCurrent(location)
        const current = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
        this.locations.assertCurrent(location)
        live.throwIfAborted()
        return documentVersion(current.bytes, location) === version
      })
    })
  }

  /** Read pending and resolved proposals separately from current knowledge.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing page or fixed root identity.
   * @param signal - cancels the bounded read and rejects stale location results.
   * @returns complete current, baseline and proposed text with retained human decisions.
   */
  @Remote
  async proposals(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<KnowledgeProposalReview> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return readProposalReview(documentId, text,
        version, this.config.maxDocumentBytes)
    })
  }

  /** Resolve a displayed proposal and publish its disposition and any truth change atomically.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing non-archived page or fixed root; proposals cannot initialize documents.
   * @param request - explicit human choice, note, displayed version and retained operation identity.
   * @param signal - cancels before publication; admitted writes are joined.
   * @returns a durable receipt; identical retries never repeat the decision or overwrite subsequent edits.
   * @remarks Keeping current knowledge changes only proposal metadata and schedules no health assessment.
   */
  @Remote
  async resolveProposal(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeProposalResolution, signal: AbortSignal): Promise<KnowledgeTruthReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => prepareProposalResolution(documentId, text, version, request,
        new Date().toISOString(), this.config.maxDocumentBytes),
      live, () => { this.locations.assertCurrent(location) }, request.expectedVersion,
      request.action !== 'keep' && !ROOT_DOCUMENTS.some(path => path === documentId)))
    if (request.action !== 'keep') {
      await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
      this.scheduleHealthAfterWrite(location, receipt)
    }
    return receipt
  }

  /** Retain an ordinary conversation's proposed replacement without publishing it as knowledge.
   * @param sessionId - live writable project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - existing page or fixed root from the successful logged informing read.
   * @param request - complete proposal, source description and evidence; these do not imply approval.
   * @param signal - cancels before atomic publication admission.
   * @param targetProject - exact project id or unambiguous name; omission selects the conversation project.
   * @returns the metadata receipt, not a successful truth update or semantic verification.
   */
  async proposeSessionTruth(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTruthProposal, signal: AbortSignal, targetProject?: string): Promise<KnowledgeTruthReceipt> {
    const { project, session, authorize } = this.workspaceSessionWriter(sessionId, targetProject)
    const admit = (): void => {
      authorize()
      requireInformedBrainRead(session, project.path, documentId, request.expectedVersion)
    }
    admit()
    return this.trackOperation(signal, live => this.updatePage(project.id, documentId, request.operationId,
      (text, version) => prepareTruthProposal(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes),
      live, admit, request.expectedVersion))
  }

  /** Save an unapproved Task discovery proposal on the human-selected active decision page.
   * @param workspaceId - original registered Task project.
   * @param documentId - exact active decision page selected by the human.
   * @param taskId - original retained Task identity; request source must name it.
   * @param request - original version, independent decision UUID, complete proposed understanding and Task evidence.
   * @param signal - cancels before publication admission.
   * @param beforePublish - Task owner's durable candidate and decision recheck under the page writer lock.
   * The retry flag identifies a matching file receipt.
   * @returns a file-derived proposal receipt without changing current understanding.
   */
  async proposeTaskTruth(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, taskId: ProjectTaskId,
    request: KnowledgeTruthProposal, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<KnowledgeTruthReceipt> {
    if (request.source !== `task:${taskId}`) throw new RemoteError('knowledge/update',
      'Task discovery proposal must cite its original Task', { path: documentId, reason: 'invalid' })
    const location = this.locations.get(workspaceId)
    return this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => {
        const page = parseKnowledgeDocument(documentId, text, version).entry
        const proposed = prepareTruthProposal(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes)
        if (proposed !== undefined && (page.kind !== 'page' || page.status !== 'active' || page.category !== 'decision')) {
          throw new RemoteError('knowledge/update', 'Task discovery proposals require a selected active decision page',
            { path: documentId, reason: 'read-only' })
        }
        return proposed
      }, live, () => { this.locations.assertCurrent(location) }, request.expectedVersion, false, beforePublish))
  }

  /** Retain a Goal-human proposal on the exact active decision page without changing current understanding.
   * @param workspaceId - original registered project of the signed Goal research Task.
   * @param documentId - exact active decision page selected by the human.
   * @param identity - signed plan, complete report, candidate and first human decision UUID.
   * @param request - displayed page version and complete unapproved replacement with canonical Goal source references.
   * @param signal - cancels before atomic publication admission.
   * @param beforePublish - Goal owner's retained-decision recheck under the Brain-wide and page writer locks;
   * the retry flag identifies an identical file receipt.
   * @returns file-derived proposal receipt; neither the active truth nor Timeline changes.
   */
  async proposeGoalTruth(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    identity: KnowledgeGoalTruthProposalIdentity, request: KnowledgeTruthProposal, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<KnowledgeTruthReceipt> {
    if (identity.workspaceId !== workspaceId || request.operationId !== identity.decisionId
      || request.source !== goalProposalSource(identity)) throw new RemoteError('knowledge/update',
      'Goal proposal must cite its original Goal report and human decision', { path: documentId, reason: 'invalid' })
    const location = this.locations.get(workspaceId)
    const attempt: GoalWriteAttempt = { operation: { kind: 'proposal', identity, request },
      observation: { writeStarted: false } }
    return this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => {
        const page = parseKnowledgeDocument(documentId, text, version).entry
        const proposed = prepareTruthProposal(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes)
        if (proposed !== undefined && (page.kind !== 'page' || page.status !== 'active' || page.category !== 'decision')) {
          throw new RemoteError('knowledge/update', 'Goal proposals require a selected active decision page',
            { path: documentId, reason: 'read-only' })
        }
        return proposed
      }, live, () => { this.locations.assertCurrent(location) }, request.expectedVersion, false, beforePublish, attempt))
  }

  /** Restore an explicitly selected ordinary before-image without overwriting later understanding.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing non-archived Brain page or fixed root.
   * @param request - retained human choice with the displayed version and a fresh operation UUID.
   * @param signal - cancels before atomic publication; admitted writes are joined before return.
   * @returns the durable receipt; identical retries preserve later changes and retry only index refresh.
   * @throws for changed versions or understanding, missing images, archived pages and conflicting operation identities.
   * @remarks Pages retain Timeline evidence; roots retain exact body bytes and root receipts.
   * Both retain reversible images; no model restore tool is registered.
   */
  @Remote
  async restoreTruth(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeTruthRestore, signal: AbortSignal): Promise<KnowledgeTruthReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => prepareTruthRestore(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes),
      live, () => { this.locations.assertCurrent(location) }, request.expectedVersion, !ROOT_DOCUMENTS.some(path => path === documentId)))
    await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  /** Publish a conversation-owned update, rechecking its project before admitting the atomic write.
   * @param sessionId - live project or workspace conversation; cwd grants no access.
   * @param documentId - existing Brain-relative page.
   * @param request - retained update, source and evidence.
   * @param signal - cancels pending work before publication admission.
   * @param targetProject - workspace project id or unique name; omitted uses the conversation default.
   * @returns the same durable receipt as an API update.
   * @throws when project membership changes before write admission; an admitted filesystem write may already be in flight.
   */
  async updateSessionTruth(
    sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTruthUpdate, signal: AbortSignal, targetProject?: string,
  ): Promise<KnowledgeTruthReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.admitUpdate(projectId, documentId, request, signal, authorize,
        false, live => this.assertSessionUpdateAdmission(sessionId, projectId, documentId, live)), request.expectedVersion)
  }

  /** Append knowledge in a project available to the authoring conversation's logical workspace.
   * @param sessionId - live registered source conversation; execution Tasks cannot append.
   * @param documentId - existing page path from a successful retained brain_read.
   * @param request - four-kind entry with optional reference text, retained UUID and read version.
   * @param signal - cancels before publication; admitted native writes may already be in flight.
   * @param targetProject - explicit registered id or unambiguous name; omitted selects the conversation default.
   * @returns durable receipt, with one successful access observation for the selected project.
   * @throws for absent or changed workspace membership, approved Goals, unread pages, invalid or conflicting writes,
   * and exact Timeline evidence duplicates across Sessions.
   */
  async appendSessionTimeline(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTimelineAppend, signal: AbortSignal, targetProject?: string): Promise<KnowledgeTruthReceipt> {
    const model = currentBrainModelWrite(this.ctx.root, sessionId)
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (model !== undefined && session !== undefined && activeTaskCompletions(session) === undefined
      && this.automaticConversationEnabled(sessionId)) {
      throw new Error('Automatic conversation Timeline writes require independent review; use the reviewed Timeline operation')
    }
    return this.appendSessionTimelineCore(sessionId, documentId, request, signal, targetProject)
  }

  /** Independently assess an ordinary model Timeline intent without changing manual or Task publication.
   * @param sessionId - actual model conversation owning the original human sources.
   * @param documentId - existing active page at the informing read version.
   * @param request - complete original append intent; references never establish approval.
   * @param signal - cancels review and publication before atomic admission.
   * @param targetProject - accessible project selection; omission follows the conversation default.
   * @param assertAcknowledgement - optional model-output admission check, called before an append with its actual assessment identity.
   * @returns original append receipt, a reviewed no-change, or deferral without a knowledge write.
   * @throws for missing reads, changed sources/catalog, conflicting UUIDs or invalid review output.
   */
  async appendAutomaticSessionTimeline(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTimelineAppend, signal: AbortSignal, targetProject?: string,
    assertAcknowledgement?: (review: KnowledgeAutomaticTimelineResult['review']) => void): Promise<KnowledgeAutomaticTimelineResult> {
    const original = structuredClone(request)
    return this.trackOperation(signal, async (live) => {
      const { project, session, authorize, taskCards } = this.workspaceSessionWriter(sessionId, targetProject, 'timeline')
      if (taskCards !== undefined) {
        assertAcknowledgement?.(undefined)
        return { status: 'applied', receipt:
          await this.appendSessionTimelineCore(sessionId, documentId, original, live, targetProject) }
      }
      if (!this.automaticConversationEnabled(sessionId)) return { status: 'deferred', reason: 'disabled' }
      requireInformedBrainRead(session, project.path, documentId, original.expectedVersion)
      if (await this.timelineAppendReceipt(project.id, documentId, original, sessionId, live)) {
        assertAcknowledgement?.(undefined)
        return { status: 'applied', receipt: await this.appendSessionTimelineCore(sessionId, documentId, original, live, targetProject) }
      }
      const history = await this.automaticConversationHistory(session, live)
      const latest = history.findLast((event): event is SessionEvent<'user/message'> =>
        event.type === 'user/message' && event.data.source.kind === 'user')
      if (latest === undefined) return { status: 'deferred', reason: 'source-incomplete' }
      const sources = collectConversationReviewSources(session, history, latest.data.id, this.config.automaticMaintenance.maxReviewBytes)
      if (sources === undefined || !frozenConversationSourcesMatch(sessionId, history, sources)) {
        return { status: 'deferred', reason: 'source-incomplete' }
      }
      const evidence = original.evidence?.trim() ? original.evidence
        : latest.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (!sources.some(source => !source.sourceId.includes('/assistant:') && source.text.includes(evidence))) {
        return { status: 'deferred', reason: 'source-incomplete' }
      }
      const catalog = await this.automaticMaintenanceCatalog(project.id, live)
      const target = catalog.pages.find(page => page.path === documentId)
      if (target?.status !== 'active' || target.version !== original.expectedVersion) return { status: 'deferred', reason: 'catalog-changed' }
      const candidate = { kind: 'update' as const, documentId, expectedVersion: original.expectedVersion,
        truth: target.body, summary: original.summary, evidence }
      const titleSearch = await this.automaticConversationSearch(project.id, target.title, catalog, live)
      const assessed = await reviewAutomaticConversation(this.ctx, project.path,
        { action: 'update', projectId: project.id, catalog, sources, titleSearch, candidate,
          timelineIntent: { sourceSessionId: sessionId, request: original } }, this.config.automaticMaintenance, live)
      authorize()
      const review = assessed.review
      const assessment = { reviewerSessionId: assessed.reviewerSessionId, resultSha256: assessed.resultSha256 }
      const invalid = automaticMaintenanceReviewEvidenceFailure(review, sources, catalog)
      if (invalid !== null) return { status: 'deferred', reason: invalid, review: assessment }
      if (!conversationContextDispositionsAllowed(sessionId, sources, review.sourceDispositions)) {
        return { status: 'deferred', reason: 'conflict', review: assessment }
      }
      if (review.decision === 'no-change') {
        if (review.comparedPages.some(page => page.relation === 'unknown' || page.relation === 'conflict')) {
          return { status: 'deferred', reason: 'conflict', review: assessment }
        }
        return { status: 'no-change', reason: review.reason, review: assessment }
      }
      if (review.decision !== 'change' || !this.sameAutomaticConversationChange(review.change, candidate)
        || !review.sourceDispositions.some(source => source.disposition === 'current')
        || review.titleQuery !== titleSearch.query || review.comparedPages.find(page => page.path === documentId)?.relation !== 'supports'
        || catalog.pages.some((page, index) => page.path !== documentId
          && review.comparedPages[index]?.relation !== 'unrelated' && review.comparedPages[index]?.relation !== 'supports'
          && !(page.status !== 'active' && review.comparedPages[index]?.relation === 'duplicate'))) {
        return { status: 'deferred', reason: 'conflict', review: assessment }
      }
      const beforePublish = async (retry: boolean): Promise<void> => {
        authorize()
        if (retry) return
        const current = await this.automaticConversationHistory(session, live)
        const human = current.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
        if (human?.type !== 'user/message' || human.data.id !== latest.data.id
          || !frozenConversationSourcesMatch(sessionId, current, sources)
          || JSON.stringify(collectConversationReviewSources(session, current, latest.data.id,
            this.config.automaticMaintenance.maxReviewBytes)) !== JSON.stringify(sources)) {
          throw new Error('Timeline review sources changed before publication')
        }
        const actual = await this.automaticMaintenanceCatalog(project.id, live)
        if (actual.catalogSha256 !== catalog.catalogSha256 || actual.locationRevision !== catalog.locationRevision) {
          throw new Error('Timeline review catalog changed before publication')
        }
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence === undefined) throw new Error('Timeline review durability is unavailable')
        await using retained = await persistence.open(assessed.reviewerSessionId, 'read', { signal: live })
        const events = (await retained.read(undefined, undefined, { signal: live })).events
        const inputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'brain-maintenance')
        const answers = events.filter(event => event.type === 'assistant/message')
        const ends = events.filter(event => event.type === 'turn/end')
        const input = inputs[0], answer = answers[0]
        const block = input?.type === 'user/message' ? input.data.content[0] : undefined
        if (inputs.length !== 1 || answers.length !== 1 || answer === undefined || block?.type !== 'text'
          || ends.length !== 1 || ends[0]?.data.reason.kind !== 'completed' || events.some(event => event.type === 'tool/call')) {
          throw new Error('Timeline review no longer has one complete retained assessment')
        }
        const logged: unknown = JSON.parse(block.text)
        const output = answer.data.message.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
        if (typeof logged !== 'object' || logged === null || !('timelineIntent' in logged)
          || JSON.stringify(logged.timelineIntent) !== JSON.stringify({ sourceSessionId: sessionId, request: original })
          || createHash('sha256').update(output).digest('hex') !== assessed.resultSha256
          || JSON.stringify(decodeAutomaticConversationReview(output, block.text, sources)) !== JSON.stringify(review)) {
          throw new Error('Timeline review no longer owns the exact append intent and classifications')
        }
      }
      assertAcknowledgement?.(assessment)
      return { status: 'applied', review: assessment, receipt:
        await this.appendSessionTimelineCore(sessionId, documentId, original, live, targetProject, beforePublish) }
    })
  }

  private async appendSessionTimelineCore(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTimelineAppend, signal: AbortSignal, targetProject?: string,
    beforePublish?: (retry: boolean) => Promise<void>): Promise<KnowledgeTruthReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize, taskCards) => this.trackOperation(signal, live => this.updatePage(projectId, documentId, request.operationId,
        async (text, version) => {
          if (taskCards !== undefined) {
            await this.assertTaskCompletionTimelinePage(projectId, documentId, text, version, request, taskCards, live)
          }
          return prepareTimelineAppend(documentId, text, version, request, sessionId,
            new Date().toISOString(), this.config.maxDocumentBytes)
        }, live, authorize, request.expectedVersion, false, beforePublish)), request.expectedVersion, 'timeline')
  }

  private async assertTaskCompletionTimelinePage(projectId: WorkspaceId, documentId: KnowledgeDocumentId,
    text: string, version: string, request: KnowledgeTimelineAppend,
    cards: readonly ProjectTaskCardState[], signal: AbortSignal): Promise<void> {
    const entry = parseKnowledgeDocument(documentId, text, version).entry
    const traces = cards.filter(card => card.status === 'accepted'
      && card.completion?.status === 'closed-success' && card.completion.artifactOutput !== undefined
      && card.draft.artifact?.trace?.page === documentId)
    if (traces.length > 0) {
      if (entry.kind !== 'page' || entry.status !== 'active' || request.kind !== 'observation'
        || !traces.some(card => card.status === 'accepted'
          && request.operationId === documentationTraceOperationId(projectId, card.taskId))) {
        throw new RemoteError('knowledge/update', 'Documentation trace requires its selected active page, observation kind and retained operation ID',
          { path: documentId, reason: 'read-only' })
      }
      return
    }
    if (entry.kind !== 'page' || entry.status !== 'active' || entry.category !== 'decision') {
      throw new RemoteError('knowledge/update', 'Task completion can update only a selected active decision page',
        { path: documentId, reason: 'read-only' })
    }
    const refs = cards.flatMap(card => card.draft.brainRefs ?? [])
    if (refs.includes(documentId)) return
    const aliases = refs.filter(ref => !ref.startsWith('pages/'))
    if (aliases.length > 0) {
      const index = await this.index(projectId, signal)
      if (!index.truncated && index.issues.length === 0 && aliases.some((ref) => {
        const matches = index.entries.filter(candidate => candidate.kind === 'page'
          && (candidate.id === ref || candidate.slug === ref))
        return matches.length === 1 && matches[0]?.id === documentId && matches[0].version === version
      })) return
    }
    throw new RemoteError('knowledge/update', 'Task completion page is outside its selected Brain references',
      { path: documentId, reason: 'read-only' })
  }

  private workspaceSessionWriter(sessionId: SessionId, targetProject?: string, intent: 'ordinary' | 'timeline' | 'automatic-update' = 'ordinary') {
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (session === undefined) throw new Error('Brain writes require a live registered conversation')
    const taskTurn = activeTaskCompletions(session)
    const capture = () => {
      if (this.ctx.get('agents')?.get(sessionId)?.session !== session) throw new Error('Brain authoring conversation changed')
      this.assertSessionWriteAdmission(session)
      if (!knowledgeSessionWritable(this.ctx, session)) throw new Error('Read-only conversations cannot write Brain knowledge')
      const tasks = this.ctx.get('taskController')
      const parentId = session.header.parentSession
      const parent = parentId === undefined ? undefined : this.ctx.get('agents')?.get(parentId)?.session
      if (tasks?.projectForSession(sessionId) !== undefined || hasTaskInput(session) || (parent !== undefined && hasTaskInput(parent))) {
        throw new Error('Execution Tasks cannot write project knowledge')
      }
      const owner = this.ctx.workspaceRegistry.list().find(project => project.sessionIds.includes(sessionId))
      if ((tasks === undefined || owner === undefined) && hasGoalApproval(session)) throw new Error('Goal write authority is unavailable')
      const goal = owner === undefined ? undefined : tasks?.currentGoal(owner.id, sessionId)
      if (goal?.review?.input.decision === 'approve' && goal.phase !== 'EXITED') {
        throw new Error('Approved Goals must use scoped Goal knowledge operations, not ordinary Brain writers')
      }
      return captureBrainScope(this.ctx, session, owner === undefined ? undefined : { ...owner, readOnly: false })
    }
    const scope = capture()
    if (scope === undefined) throw new Error('Brain writes require a registered project or workspace conversation')
    const projects = selectBrainProjects(scope, targetProject, false)
    const project = projects[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const tasks = this.ctx.get('taskController')
    const taskCards = taskTurn === undefined ? undefined : taskCompletionCards(tasks?.listCards(project.id, sessionId) ?? [], taskTurn)
    if (taskTurn !== undefined && (taskCards === undefined || taskCards.length === 0
      || intent !== 'timeline' && (intent !== 'automatic-update' || !this.config.automaticMaintenance.enabled
        || !automaticTaskCompletion(taskCards, taskTurn)))) {
      throw new Error('Task completion permits only selected Brain Timeline updates in its source turn')
    }
    if (taskCards?.some(card => card.status === 'accepted'
      && (card.knowledgeMaintenanceAuthorization?.mode ?? card.draft.knowledgeMaintenance) === 'read-only')) {
      throw new Error('This Task was explicitly confirmed without knowledge writes')
    }
    const location = this.locations.get(project.id)
    const authorize = (): void => {
      revalidateBrainScope(scope, capture(), projects)
      this.locations.assertCurrent(location)
      requireCurrentBrainContext(session, location)
      if (!sameTaskCompletions(taskTurn, activeTaskCompletions(session))) {
        throw new Error('Task completion turn changed before Brain publication')
      }
      if (taskCards !== undefined) {
        if (taskTurn === undefined) throw new Error('Task completion ownership has no admitted source turn')
        const current = taskCompletionCards(tasks?.listCards(project.id, sessionId) ?? [], taskTurn)
        if (current.length !== taskCards.length || current.some((card, index) => card.id !== taskCards[index]?.id)) {
          throw new Error('Task completion ownership changed before Brain publication')
        }
        if (intent === 'automatic-update' && (!this.config.automaticMaintenance.enabled
          || !automaticTaskCompletion(current, taskTurn))) {
          throw new Error('Task automatic knowledge permission changed before Brain publication')
        }
        if (current.some(card => card.status === 'accepted'
          && (card.knowledgeMaintenanceAuthorization?.mode ?? card.draft.knowledgeMaintenance) === 'read-only')) {
          throw new Error('This Task was explicitly confirmed without knowledge writes')
        }
        if (!codingTaskReadsComplete(session, current, taskTurn)) {
          throw new Error('Coding Task Brain publication requires a successful read_task for each exact Task and project in this turn')
        }
      }
    }
    authorize()
    return { project, location, session, authorize, taskCards }
  }

  private async conversationWrite<T extends KnowledgeMutationReceipt>(
    sessionId: SessionId, documentId: KnowledgeDocumentId, targetProject: string | undefined,
    execute: (projectId: WorkspaceId, authorize: () => void, taskCards?: readonly ProjectTaskCardState[]) => Promise<T>,
    readVersion?: string, intent: 'ordinary' | 'timeline' = 'ordinary'): Promise<T> {
    const { project, location, session, authorize, taskCards } = this.workspaceSessionWriter(sessionId, targetProject, intent)
    const admit = (): void => {
      authorize()
      if (readVersion !== undefined) requireInformedBrainRead(session, project.path, documentId, readVersion)
    }
    admit()
    const receipt = await execute(project.id, admit, taskCards)
    await this.recordAccess({ projectId: project.id, documentId, kind: 'write', writerSessionId: sessionId })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  private sessionWriter(sessionId: SessionId, mode: 'discussion' | 'goal' = 'discussion', modelWrite = true) {
    const project = this.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
    if (project === undefined) throw new Error('This conversation does not belong to a registered project')
    const projectPath = project.path
    const sourceSession = this.ctx.get('agents')?.get(sessionId)?.session
    const taskTurn = sourceSession === undefined ? undefined : activeTaskCompletions(sourceSession)
    if (taskTurn !== undefined) throw new Error('Task completion permits only selected Brain Timeline updates in its source turn')
    const authorize = (): void => {
      const current = this.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
      if (current?.id !== project.id || current.path !== projectPath) throw new Error('Project membership changed before Brain write admission')
      const tasks = this.ctx.get('taskController')
      const session = this.ctx.get('agents')?.get(sessionId)?.session
      if (session !== undefined) this.assertSessionWriteAdmission(session)
      if (session !== undefined && activeTaskCompletions(session) !== undefined) {
        throw new Error('Task completion began before Brain publication')
      }
      if (session !== undefined && !knowledgeSessionWritable(this.ctx, session)) throw new Error('Read-only conversations cannot write Brain knowledge')
      if (modelWrite) requireCurrentBrainContext(session, this.locations.get(project.id))
      if (tasks?.projectForSession(sessionId) !== undefined || (session !== undefined && hasTaskInput(session))) {
        throw new Error('Execution Tasks cannot write project knowledge')
      }
      if (tasks === undefined && session !== undefined && hasGoalApproval(session)) throw new Error('Goal write authority is unavailable')
      const goal = tasks?.currentGoal(project.id, sessionId)
      if (mode === 'discussion' && goal?.review?.input.decision === 'approve' && goal.phase !== 'EXITED') {
        throw new Error('Approved Goals must use scoped Goal knowledge operations, not ordinary Brain writers')
      }
    }
    return { project, authorize }
  }

  /** Append a supported decision under an exact approved Goal, without changing current understanding.
   * @param sessionId - directly registered source conversation; execution Tasks have no write authority.
   * @param runId - retained approved run identity, never an implicit current run.
   * @param documentId - existing active decision page selected by the signed plan.
   * @param request - retained UUID, informing read version and task-id-free knowledge increment.
   * @param signal - cancels before publication admission; admitted native writes cannot be revoked.
   * @param targetProjectId - exact additional project signed in this plan; omission selects the source project.
   * @returns durable file receipt; identical retries preserve subsequent knowledge changes.
   * @throws for missing Goal services, inactive runs, changed membership, ambiguous or unapproved pages and invalid updates.
   */
  async appendGoalDecision(
    sessionId: SessionId, runId: ProjectGoalRunId, documentId: KnowledgeDocumentId,
    request: KnowledgeGoalDecision, signal: AbortSignal, targetProjectId?: WorkspaceId,
  ): Promise<KnowledgeTruthReceipt> {
    validateGoalDecision(documentId, request)
    return this.goalWriteAttempt(sessionId, runId, documentId, request, 'timeline', signal, async (live, publication) => {
      const { project, authorize, owner } = this.goalChangeOwner(sessionId, runId, documentId, 'write', targetProjectId)
      const attribution = { source: `goal:${runId}`, author: owner.author }
      const check = (): void => {
        const { goal, plan } = authorize()
        if (!plan.input.brainRefs.includes(documentId)) {
          throw new RemoteError('knowledge/update', 'Decision page path is outside the signed Brain write scope; aliases do not grant writes',
            { path: documentId, reason: 'read-only' })
        }
        const content = `${request.summary}\n${request.evidence}`
        if (goal.tasks?.some(task => content.includes(task.id))) {
          throw new RemoteError('knowledge/update', 'Record reusable knowledge, not execution task IDs; task source references stay in the Goal history',
            { path: documentId, reason: 'read-only' })
        }
      }
      return this.updatePage(project.id, documentId, request.operationId,
        async (text, version) => {
          const next = prepareGoalDecision(documentId, text, version, request, attribution,
            new Date().toISOString(), this.config.maxDocumentBytes)
          await publication()
          return next
        },
        live, check, request.expectedVersion)
    }, targetProjectId)
  }

  private goalAuthority(sessionId: SessionId, runId: ProjectGoalRunId, modelWrite: boolean) {
    const { project, authorize: membership } = this.sessionWriter(sessionId, 'goal', false)
    const inspect = () => {
      membership()
      const tasks = this.ctx.get('taskController')
      if (tasks === undefined) throw new Error('Goal knowledge authority is unavailable')
      const goal = tasks.inspectGoal(project.id, sessionId, runId)
      if (goal?.plan === undefined || goal.review?.delivery !== 'sent' || goal.review.input.decision !== 'approve') {
        throw new Error('Knowledge changes require the exact approved and delivered Goal')
      }
      if (modelWrite && goal.phase !== 'RUNNING') throw new Error('Knowledge writing requires a RUNNING Goal')
      if (modelWrite && (goal.review.knowledgeMaintenanceAuthorization?.mode
        ?? goal.plan.input.knowledgeMaintenance) === 'read-only') {
        throw new Error('This Goal was explicitly confirmed without knowledge writes')
      }
      return { goal, plan: goal.plan, reviewId: goal.review.input.requestId, master: goal.review.input.models.master }
    }
    const initial = inspect()
    const authorize = () => {
      const current = inspect()
      if (current.plan.requestId !== initial.plan.requestId || current.reviewId !== initial.reviewId) {
        throw new Error('Goal approval changed during the knowledge operation; refresh it')
      }
      return current
    }
    return { project, authorize }
  }

  private async goalWriteAttempt(sessionId: SessionId, runId: ProjectGoalRunId, documentId: KnowledgeDocumentId,
    request: KnowledgeGoalDecision | KnowledgeGoalRewrite, kind: 'timeline' | 'truth' | 'root-page', signal: AbortSignal,
    work: (live: AbortSignal, publication: () => Promise<void>) => Promise<KnowledgeTruthReceipt>,
    targetProjectId?: WorkspaceId): Promise<KnowledgeTruthReceipt> {
    const { project, authorize } = this.goalAuthority(sessionId, runId, true)
    relativeSegments(documentId)
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxDocumentBytes) {
      throw new RemoteError('knowledge/document', 'Goal write request exceeds the document byte limit', { path: documentId, reason: 'too-large' })
    }
    const owner = { runId, sourceSessionId: sessionId, workspaceId: project.id, projectPath: project.path }
    const fields = 'summary' in request ? [request.expectedVersion, request.summary, request.evidence]
      : [request.expectedVersion, request.markdown, request.rationale, request.evidence]
    const digest = createHash('sha256').update(JSON.stringify([kind, documentId, ...fields,
      ...targetProjectId === undefined ? [] : [targetProjectId]])).digest('hex')
    return this.trackOperation(signal, async (live) => {
      try {
        return await work(live, async () => {
          live.throwIfAborted()
          authorize()
          await this.goalHistory.publication(owner, documentId, targetProjectId)
        })
      } catch (error) {
        const failure = remoteErrorOf(error)
        const refusal = (failure?.code === 'knowledge/update' && failure.details.reason === 'read-only')
          || (failure?.code === 'knowledge/document' && failure.details.reason === 'not-found' && kind !== 'root-page')
        if (refusal && !live.aborted) {
          authorize()
          await this.goalHistory.reject(owner, { operationId: request.operationId, digest, kind, path: documentId,
            ...(targetProjectId === undefined ? {} : { targetProjectId }),
            at: new Date(this.now()).toISOString(), reason: failure.message })
        }
        throw error
      }
    })
  }

  private goalChangeOwner(sessionId: SessionId, runId: ProjectGoalRunId, documentId: KnowledgeDocumentId,
    action: 'read' | 'write' | 'review', targetProjectId?: WorkspaceId) {
    const { project: source, authorize: authority } = this.goalAuthority(sessionId, runId, action === 'write')
    const select = () => {
      const { goal, plan, master } = authority()
      if (action === 'review' && goal.phase !== 'DONE' && goal.phase !== 'ESCALATED') {
        throw new Error('Knowledge review is available only at DONE or ESCALATED')
      }
      const root = ROOT_DOCUMENTS.find(path => path === documentId)
      const plans = [plan, ...action === 'write' ? [] : goal.planHistory
        ?.filter(item => item.review.input.decision === 'approve').map(item => item.plan) ?? []]
      const inScope = plans.some(item => (targetProjectId === undefined || item.input.brainProjectIds?.includes(targetProjectId))
        && (root === undefined ? item.input.brainRefs.includes(documentId)
          : item.input.rootPageRefs.some(slug => `${slug}.md` === root)))
      if (!inScope) throw new RemoteError('knowledge/update', 'Knowledge path is outside the signed Goal write scope',
        { path: documentId, reason: 'read-only' })
      const space = this.ctx.workspaceRegistry.spaces.find(item => item.projectIds.includes(source.id))
      const project = this.ctx.workspaceRegistry.get(targetProjectId ?? source.id)
      if (project === undefined || project.archivedAt !== undefined || space === undefined || !space.projectIds.includes(project.id)) {
        throw new RemoteError('knowledge/update', 'Goal knowledge target must be an active project in the source workspace',
          { path: documentId, reason: 'read-only' })
      }
      return { goal, plan, master, project, spaceId: space.spaceId }
    }
    const { master, goal, project, spaceId } = select()
    const projectPath = project.path
    const location = this.locations.get(project.id)
    const revision = (state: typeof goal) => (state.resumeRevision ?? 0)
      + (state.planHistory?.filter(item => item.review.input.decision === 'approve').length ?? 0)
    const resumeRevision = revision(goal)
    const check = () => {
      const current = select()
      if (current.spaceId !== spaceId || current.project.path !== projectPath) {
        throw new RemoteError('knowledge/update', 'Goal knowledge project moved during the operation; refresh it',
          { path: documentId, reason: 'read-only' })
      }
      this.locations.assertCurrent(location)
      if (action === 'write') requireCurrentBrainContext(this.ctx.get('agents')?.get(sessionId)?.session, location)
      if (revision(current.goal) !== resumeRevision) {
        throw new RemoteError('knowledge/update', 'Goal resumed during the knowledge operation; refresh it',
          { path: documentId, reason: 'conflict' })
      }
      return current
    }
    check()
    return { project, authorize: check, owner: { runId, sourceSessionId: sessionId,
      author: `agent:goal-master:${master.provider}/${master.model}`, resumeRevision } }
  }

  /** Replace signed knowledge and retain complete accumulated recovery images in the same atomic file write.
   * @param sessionId - directly registered source Goal conversation, never an execution Task.
   * @param runId - exact approved RUNNING run.
   * @param documentId - existing signed decision page or signed fixed root filename.
   * @param request - retained operation, informing version or null for root creation, complete Markdown and evidence.
   * @param signal - cancels before publication admission.
   * @param targetProjectId - exact additional project signed with this path; omission selects the source project.
   * @returns an idempotent file receipt; later unrelated edits are never absorbed into the run's recovery image.
   */
  async rewriteGoalKnowledge(sessionId: SessionId, runId: ProjectGoalRunId, documentId: KnowledgeDocumentId,
    request: KnowledgeGoalRewrite, signal: AbortSignal, targetProjectId?: WorkspaceId): Promise<KnowledgeTruthReceipt> {
    validateGoalRewrite(documentId, request)
    const kind = ROOT_DOCUMENTS.some(path => path === documentId) ? 'root-page' : 'truth'
    return this.goalWriteAttempt(sessionId, runId, documentId, request, kind, signal, async (live, publication) => {
      const { project, authorize, owner } = this.goalChangeOwner(sessionId, runId, documentId, 'write', targetProjectId)
      const check = (): void => {
        const { goal } = authorize()
        if (goal.tasks?.some(task => `${request.markdown}\n${request.rationale}\n${request.evidence}`.includes(task.id))) {
          throw new RemoteError('knowledge/update', 'Knowledge records project understanding, not execution task IDs',
            { path: documentId, reason: 'read-only' })
        }
      }
      const prepare = (text: string, version: string) => prepareGoalRewrite(documentId, text, version, request, owner,
        new Date().toISOString(), this.config.maxDocumentBytes)
      if (request.expectedVersion !== null) return this.updatePage(project.id, documentId,
        request.operationId, async (text, version) => {
          const next = prepare(text, version)
          await publication()
          return next
        }, live, check, request.expectedVersion)
      const text = prepareGoalRootCreation(documentId, request, owner, new Date().toISOString(), this.config.maxDocumentBytes)
      return this.publishNewDocument(project.id, documentId, request.operationId, text,
        (text, version) => { prepare(text, version) }, live, check, 'knowledge', publication)
    }, targetProjectId)
  }

  /** Read attempts without inspecting or modifying knowledge files.
   * @param sessionId - directly registered source of the approved run.
   * @param runId - exact current or historical approved Goal.
   * @param signal - caller lifetime, checked before returning the snapshot.
   * @returns coverage, publication candidates and retained refusals; old missing records remain unknown.
   */
  @Remote
  async goalWriteHistory(sessionId: SessionId, runId: ProjectGoalRunId, signal: AbortSignal): Promise<KnowledgeGoalWriteHistory> {
    const { project, authorize } = this.goalAuthority(sessionId, runId, false)
    signal.throwIfAborted()
    authorize()
    return Promise.resolve(this.goalHistory.snapshot({ runId, sourceSessionId: sessionId,
      workspaceId: project.id, projectPath: project.path }))
  }

  /** Read complete before/after images without creating a Session, modifying a file or running a model.
   * @param sessionId - source conversation owning the approved run.
   * @param runId - current or historical approved run identity.
   * @param document - source path or destination paired with this path in one approved plan; missing files reject.
   * @param signal - cancels the file read.
   * @returns the current version, accumulated change or null, and receipt-backed autonomous Timeline count.
   */
  @Remote
  async goalChange(sessionId: SessionId, runId: ProjectGoalRunId, document: KnowledgeGoalTarget,
    signal: AbortSignal): Promise<KnowledgeGoalChangeView> {
    const documentId = typeof document === 'string' ? document : document.path
    const targetProjectId = typeof document === 'string' ? undefined : document.projectId
    const { project, authorize, owner } = this.goalChangeOwner(sessionId, runId, documentId, 'read', targetProjectId)
    const { target, location } = await this.documentTarget(project.id, documentId, signal)
    const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
    authorize()
    signal.throwIfAborted()
    const text = this.files.decodeText(documentId, content.bytes)
    this.locations.assertCurrent(location)
    const version = documentVersion(content.bytes, location)
    return readGoalFileReview(documentId, text, version, owner)
  }

  /** Resolve one displayed terminal Goal change; reverting preserves later Timeline and metadata edits.
   * @param sessionId - source conversation of the approved Goal.
   * @param runId - exact DONE or ESCALATED run selected by the user.
   * @param document - source path or exact signed destination and path displayed in the review.
   * @param request - retained explicit keep/revert decision and displayed file version.
   * @param signal - cancels before publication admission.
   * @returns the atomic review receipt; stale views and changed understanding reject without overwriting.
   */
  @Remote
  async reviewGoalChange(sessionId: SessionId, runId: ProjectGoalRunId, document: KnowledgeGoalTarget,
    request: KnowledgeGoalReview, signal: AbortSignal): Promise<KnowledgeTruthReceipt> {
    const documentId = typeof document === 'string' ? document : document.path
    const targetProjectId = typeof document === 'string' ? undefined : document.projectId
    const { project, authorize, owner } = this.goalChangeOwner(sessionId, runId, documentId, 'review', targetProjectId)
    return this.trackOperation(signal, live => this.updatePage(project.id, documentId, request.operationId,
      (text, version) => prepareGoalReview(documentId, text, version, request, owner,
        new Date().toISOString(), this.config.maxDocumentBytes),
      live, authorize, request.expectedVersion))
  }

  /** Create one complete page without overwriting existing knowledge, including when Brain is absent.
   * @param workspaceId - registered project owning the new page.
   * @param documentId - direct pages/<lowercase-hyphenated-id>.md identity.
   * @param request - retained creation UUID, explicit metadata, current understanding and evidence.
   * @param signal - cancels before publication; empty parent directories may remain after cancellation.
   * @returns a durable receipt; an identical retry preserves later edits and returns their current version.
   * @throws for unsafe paths, invalid input, existing unrelated pages or conflicting retry identities.
   * @remarks Creation and identical retries refresh index.md; index failure does not roll back the saved page.
   */
  async createPage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate, signal: AbortSignal,
  ): Promise<KnowledgeTruthReceipt> {
    return this.publishCreatedPage(workspaceId, documentId, request, signal)
  }
  /** Save a reviewed import proposal as a real, publication-held Brain draft.
   * @param workspaceId - registered project selected by the import review.
   * @param documentId - new direct Brain page path.
   * @param request - draft creation and original evidence; its UUID must match the hold.
   * @param hold - exact import and proposal identity persisted in the page.
   * @param signal - cancellation before atomic creation admission.
   * @param beforePublish - import owner's Host recheck inside project admission; retry is true only for an exact creation receipt.
   * @returns durable creation receipt; an identical retry keeps later page edits.
   * @throws if the import owner, path, status, identity, location or publication recheck rejects.
   */
  async createHeldImportDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate,
    hold: KnowledgeImportPublicationHold, signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (request.status !== 'draft' || request.operationId !== hold.draftOperationId) {
      throw new RemoteError('knowledge/update', 'import publication holds require the matching draft operation',
        { path: documentId, reason: 'invalid' })
    }
    return this.publishCreatedPage(workspaceId, documentId, request, signal, beforePublish, hold)
  }
  /** Save a Task discovery as a real draft whose file-owned hold blocks ordinary active publication.
   * @param workspaceId - original registered Task project, matching the hold.
   * @param documentId - new direct page path selected by the human.
   * @param request - retained creation UUID, complete draft understanding and Task evidence.
   * @param hold - exact Task, result, candidate and human-decision identity.
   * @param signal - cancellation before atomic creation admission.
   * @param beforePublish - Task owner's durable decision recheck under the Brain writer lock; retry identifies an exact creation receipt.
   * @returns durable creation receipt without adding active knowledge.
   */
  async createHeldTaskDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate,
    hold: KnowledgeTaskPublicationHold, signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (workspaceId !== hold.workspaceId || request.status !== 'draft' || request.operationId !== hold.draftOperationId
      || request.source !== `task:${hold.taskId}`) {
      throw new RemoteError('knowledge/update', 'Task draft requires its original project, source and creation identity',
        { path: documentId, reason: 'invalid' })
    }
    return this.publishCreatedPage(workspaceId, documentId, request, signal, beforePublish, hold)
  }
  /** Save a Goal research candidate as a human-held draft, without granting Goal execution a write operation.
   * @param workspaceId - original registered project matching the signed Goal candidate.
   * @param documentId - new direct page path selected by the human.
   * @param request - complete draft and report evidence with the original creation UUID.
   * @param hold - exact Goal run, signed plan, Task, report, candidate and human decision identity.
   * @param signal - cancellation before atomic creation admission.
   * @param beforePublish - Goal-human owner's durable decision recheck under the Brain writer lock; retry denotes the exact receipt.
   * @returns durable draft receipt, without adding active knowledge.
   * @throws for a changed project, source, identity, location or decision; no model tool calls this method.
   */
  async createHeldGoalDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate,
    hold: KnowledgeGoalPublicationHold, signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (workspaceId !== hold.workspaceId || request.status !== 'draft' || request.operationId !== hold.draftOperationId
      || request.source !== `goal:${hold.goalRunId}:task:${hold.taskId}`) {
      throw new RemoteError('knowledge/update', 'Goal draft requires its original project, source and creation identity',
        { path: documentId, reason: 'invalid' })
    }
    const attempt: GoalWriteAttempt = { operation: { kind: 'draft', hold, request },
      observation: { writeStarted: false } }
    return this.publishCreatedPage(workspaceId, documentId, request, signal, beforePublish, hold, attempt)
  }
  /** Create a page in one project of the executing conversation's logical workspace.
   * @param sessionId - live ordinary project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - new direct Brain page path.
   * @param request - complete retained creation intent and evidence.
   * @param signal - cancellation before atomic publication admission.
   * @param targetProject - project id or unique name; omitted uses the conversation default.
   * @returns the same durable creation receipt as the Remote operation.
   * @throws when membership changes or an ordinary conversation requests active publication;
   * an admitted filesystem write cannot be revoked.
   */
  async createSessionPage(
    sessionId: SessionId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate, signal: AbortSignal, targetProject?: string,
  ): Promise<KnowledgeTruthReceipt> {
    if (request.status === 'active') this.requireReviewedSessionPublication(sessionId, documentId)
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.trackOperation(signal, live => this.publishNewPage(projectId, documentId, request,
        live, authorize, () => this.assertSessionCreateAdmission(sessionId, projectId, documentId, live))))
  }

  /** Independently review and automatically admit a new active page from one actual ordinary user message.
   * @param sessionId - live ordinary conversation in the original logical workspace; imports, Tasks and signed Goals use their own owners.
   * @param documentId - direct new page path retained by the original tool request.
   * @param request - original UUID, complete candidate and exact actual user evidence.
   * @param signal - cancellation before review and atomic publication.
   * @param targetProject - exact accessible project selection; omission uses the conversation default.
   * @returns durable publication, a complete duplicate verdict, or visible deferral with no active write.
   * @throws for changed request/source identities, unavailable permissions or incomplete durable model output.
   */
  async createAutomaticSessionPage(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgePageCreate, signal: AbortSignal, targetProject?: string): Promise<KnowledgeAutomaticConversationResult> {
    return this.automaticConversationPage(sessionId, documentId, { kind: 'create', request }, signal, targetProject)
  }

  /** Independently review an existing active page update without requesting human acceptance.
    * @param sessionId - ordinary conversation, or exact source Task review with frozen automatic permission, owning the actual user
    * evidence and informing page read.
   * @param documentId - existing active page in the selected accessible project.
   * @param request - original UUID, exact read version, complete new understanding and actual user evidence.
   * @param signal - cancellation before independent review and atomic publication.
   * @param targetProject - accessible project identity; omission uses the conversation default.
   * @returns exact publication receipt, no-change assessment or visible AI deferral with no active overwrite.
   * @throws for changed identities, missing informing reads, unavailable authority or incomplete durable output.
   */
  async updateAutomaticSessionTruth(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgeTruthUpdate, signal: AbortSignal, targetProject?: string): Promise<KnowledgeAutomaticConversationResult> {
    return this.automaticConversationPage(sessionId, documentId, { kind: 'update', request }, signal, targetProject)
  }

  private async automaticConversationPage(sessionId: SessionId, documentId: KnowledgeDocumentId,
    intent: { readonly kind: 'create'; readonly request: KnowledgePageCreate }
      | { readonly kind: 'update'; readonly request: KnowledgeTruthUpdate }
      | { readonly kind: 'merge'; readonly request: KnowledgePageMergeRequest },
    signal: AbortSignal, targetProject?: string): Promise<KnowledgeAutomaticConversationResult> {
    return this.trackOperation(signal, async (live) => {
      if (!this.config.automaticMaintenance.enabled) return { status: 'deferred', reason: 'disabled' }
      const request = intent.request
      if (intent.kind === 'create' && intent.request.status !== 'active') throw new Error('Automatic conversation admission requires explicit active intent')
      const { project, session, authorize, taskCards } = this.workspaceSessionWriter(sessionId, targetProject,
        intent.kind === 'update' ? 'automatic-update' : 'ordinary')
      if (this.isKnowledgeImportSession(session)) throw new Error('Knowledge imports require their own automatic permission')
      const selectedTaskPage = async (): Promise<void> => {
        if (taskCards === undefined) return
        const tasks = this.ctx.get('taskController')
        if (tasks === undefined || intent.kind !== 'update') throw new Error('Task knowledge updates require their original selected-page provider')
        const pages = await tasks.resolveKnowledgeReviewPages({ id: project.id, path: project.path },
          taskCards.flatMap(card => card.draft.brainRefs ?? []), live)
        if (!pages.some(page => page.path === documentId)) throw new Error('Task automatic knowledge update is outside its selected active decision pages')
        authorize()
      }
      await selectedTaskPage()
      const retained = this.automaticMaintenanceStore.conversation(project.id, project.path, request.operationId)
      const priorAuthority = retained?.request.authority
      const source = priorAuthority?.kind === 'conversation'
        ? `session:${sessionId}/message:${priorAuthority.messageId}` : requireUserEvidenceSource(session, request.evidence)
      if (intent.kind !== 'merge' && source !== intent.request.source) throw new Error('Automatic knowledge evidence must identify its actual user message')
      const history = await this.automaticConversationHistory(session, live)
      const event = history.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'user' && `session:${sessionId}/message:${event.data.id}` === source)
      const user = event?.data
      if (user === undefined || request.evidence.trim() === '' || user.content.some(block => block.type !== 'text')
        || !user.content.some(block => block.type === 'text' && block.text.includes(request.evidence))) {
        return { status: 'deferred', reason: 'source-incomplete' }
      }
      const sources = retained?.request.sources ?? (taskCards === undefined
        ? collectConversationReviewSources(session, history, user.id, this.config.automaticMaintenance.maxReviewBytes)
        : [{ sourceId: source, text: user.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }])
      if (sources === undefined || !frozenConversationSourcesMatch(sessionId, history, sources)) {
        return { status: 'deferred', reason: 'source-incomplete' }
      }
      const candidate = intent.kind === 'create'
        ? { kind: 'create' as const, title: intent.request.title, category: intent.request.category, tags: intent.request.tags,
          truth: request.truth, summary: request.summary, evidence: request.evidence }
        : intent.kind === 'update'
          ? { kind: 'update' as const, documentId, expectedVersion: intent.request.expectedVersion,
            truth: request.truth, summary: request.summary, evidence: request.evidence }
          : { kind: 'merge' as const, documentId, expectedVersion: intent.request.target.expectedVersion,
            sourceDocumentId: intent.request.source.documentId, sourceExpectedVersion: intent.request.source.expectedVersion,
            truth: request.truth, summary: request.summary, evidence: request.evidence, reason: intent.request.note }
      if (intent.kind === 'create') preparePageCreation(documentId, intent.request, new Date().toISOString(), this.config.maxDocumentBytes)
      else if (intent.kind === 'update') requireInformedBrainRead(session, project.path, documentId, intent.request.expectedVersion)
      else {
        requireInformedBrainRead(session, project.path, documentId, intent.request.target.expectedVersion)
        requireInformedBrainRead(session, project.path, intent.request.source.documentId, intent.request.source.expectedVersion)
      }
      const hashedRequest = intent.kind === 'create' ? request : intent.kind === 'update' ? {
        operationId: request.operationId, expectedVersion: intent.request.expectedVersion, truth: request.truth,
        kind: intent.request.kind, summary: request.summary, source: intent.request.source, evidence: request.evidence,
      } : { operationId: request.operationId,
        target: { documentId, expectedVersion: intent.request.target.expectedVersion },
        source: { documentId: intent.request.source.documentId, expectedVersion: intent.request.source.expectedVersion },
        truth: request.truth, summary: request.summary, evidence: request.evidence, note: intent.request.note }
      const candidateSha256 = createHash('sha256').update(JSON.stringify({ documentId, request: hashedRequest, targetProject })).digest('hex')
      const guarded = async (original: KnowledgeAutomaticMaintenanceRequest, retry = true): Promise<void> => {
        authorize()
        await selectedTaskPage()
        const current = await this.automaticConversationHistory(session, live)
        const currentSources = retained !== null || taskCards !== undefined ? sources
          : collectConversationReviewSources(session, current, user.id, this.config.automaticMaintenance.maxReviewBytes)
        const latestHuman = current.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
        const laterHuman = retained !== null && taskCards === undefined && !retry
          && latestHuman?.type === 'user/message'
          && !sources.some(item => item.sourceId === `session:${sessionId}/message:${latestHuman.data.id}`)
        if (this.isKnowledgeImportSession(session) || retained === null && requireUserEvidenceSource(session, request.evidence) !== source
          || original.authority.kind !== 'conversation' || original.authority.sourceSessionId !== sessionId
          || original.authority.messageId !== user.id || original.candidateSha256 !== candidateSha256
          || original.change.documentId !== documentId || original.change.kind !== intent.kind
          || JSON.stringify(original.sources) !== JSON.stringify(sources)
          || JSON.stringify(currentSources) !== JSON.stringify(sources)
          || !frozenConversationSourcesMatch(sessionId, current, sources)
          || !conversationContextDispositionsAllowed(sessionId, sources, original.sourceDispositions) || laterHuman) {
          throw new Error('Automatic conversation permission, candidate or source changed before publication')
        }
        await this.requireAutomaticConversationResult(original, candidate, live)
        authorize()
      }
      if (retained !== null) {
        await guarded(retained.request)
        return this.maintainAutomatically(project.id, retained.request, live, retry => guarded(retained.request, retry))
      }
      let catalog: KnowledgeDiscoveryPageBatch
      try { catalog = await this.automaticMaintenanceCatalog(project.id, live) } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'knowledge/document' && failure.details.reason === 'too-large') return { status: 'deferred', reason: 'source-incomplete' }
        throw error
      }
      let title: string
      if (candidate.kind === 'create') title = candidate.title
      else {
        const target = catalog.pages.find(page => page.path === documentId)
        if (target?.status !== 'active' || target.version !== candidate.expectedVersion) {
          return { status: 'deferred', reason: 'catalog-changed' }
        }
        title = target.title
      }
      const titleSearch = await this.automaticConversationSearch(project.id, title, catalog, live)
      let assessed: Awaited<ReturnType<typeof reviewAutomaticConversation>>
      try {
        assessed = await reviewAutomaticConversation(this.ctx, project.path,
          candidate.kind === 'create'
            ? { projectId: project.id, catalog, sources, titleSearch, candidate: { title: candidate.title,
              category: candidate.category, tags: candidate.tags, truth: candidate.truth, summary: candidate.summary,
              evidence: candidate.evidence } }
            : { action: candidate.kind, projectId: project.id, catalog, sources, titleSearch, candidate },
          this.config.automaticMaintenance, live)
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'knowledge/document' && failure.details.reason === 'too-large') return { status: 'deferred', reason: 'source-incomplete' }
        throw error
      }
      authorize()
      const review = assessed.review
      const unresolved = review.sourceDispositions.find(item => item.disposition === 'unresolved')
      const assessment = { reviewerSessionId: assessed.reviewerSessionId, resultSha256: assessed.resultSha256,
        ...review.decision === 'deferred' || review.decision === 'no-change' ? { reason: review.reason }
          : unresolved === undefined ? {} : { reason: unresolved.rationale } }
      const invalid = automaticMaintenanceReviewEvidenceFailure(review, sources, catalog)
      if (invalid !== null) return { status: 'deferred', reason: invalid, review: { ...assessment,
        reason: assessment.reason ?? 'The assessment did not match the complete source quotations or current catalog. Recheck the cited evidence.' } }
      if (!conversationContextDispositionsAllowed(sessionId, sources, review.sourceDispositions)) {
        return { status: 'deferred', reason: 'conflict', review: { ...assessment,
          reason: 'Assistant discussion cannot establish external facts. Cite the original human statement or successful web result.' } }
      }
      if (review.decision === 'deferred') return { status: 'deferred', reason: 'conflict', review: assessment }
      if (review.decision === 'no-change') {
        if (review.comparedPages.some(page => page.relation === 'unknown' || page.relation === 'conflict')) return { status: 'deferred', reason: 'conflict', review: assessment }
        return { status: 'no-change', reason: review.reason, review: assessment }
      }
      const change = review.change
      if (!this.sameAutomaticConversationChange(change, candidate) || review.titleQuery !== title
        || candidate.kind === 'create' && (review.topicQuery === undefined
          || !hasIndependentKnowledgeTerm(review.topicQuery, review.titleQuery))) return { status: 'deferred', reason: 'conflict',
        review: { ...assessment, reason: 'The assessment changed the candidate or omitted a distinct topic search. Keep the reviewed candidate and source references exact.' } }
      const topicSearch = review.topicQuery === undefined ? undefined
        : await this.automaticConversationSearch(project.id, review.topicQuery, catalog, live)
      const maintenance: KnowledgeAutomaticMaintenanceRequest = { operationId: request.operationId,
        authority: { kind: 'conversation', authorizationId: brandString<KnowledgeAutomaticAuthorizationId>(randomUUID()),
          sourceSessionId: sessionId, messageId: user.id }, reviewerSessionId: assessed.reviewerSessionId,
        resultSha256: assessed.resultSha256, candidateSha256, sourceCoverage: 'complete', sources,
        locationRevision: catalog.locationRevision, catalogSha256: catalog.catalogSha256,
        sourceDispositions: review.sourceDispositions, comparedPages: review.comparedPages, titleSearch, topicSearch,
        change: change.kind === 'update' && intent.kind === 'update'
          ? { ...change, documentId, entryKind: intent.request.kind } : { ...change, documentId } }
      return this.maintainAutomatically(project.id, maintenance, live, retry => guarded(maintenance, retry))
    })
  }

  /** Read full original discussion through storage because compaction may hide earlier human turns from model history. */
  private async automaticConversationHistory(session: Session, signal: AbortSignal): Promise<readonly SessionEvent[]> {
    const sessions = this.ctx.get('sessions'), persistence = this.ctx.get('sessionPersistence')
    if (sessions === undefined || persistence === undefined || !await sessions.flush(session)) {
      throw new Error('Complete automatic conversation evidence requires durable Session storage')
    }
    signal.throwIfAborted()
    const handle = await persistence.open(session.id, 'read', { signal })
    try { return (await handle.read(undefined, undefined, { signal })).events }
    finally { await handle.close() }
  }

  private async automaticConversationSearch(projectId: WorkspaceId, query: string,
    catalog: KnowledgeDiscoveryPageBatch, signal: AbortSignal) {
    const result = await this.search(projectId, { query, statuses: ['active', 'draft', 'archived'],
      maxResults: Math.max(1, catalog.totalPages), maxMatches: 1 }, signal)
    if (result.truncated || result.issues.length > 0) throw new Error('Automatic conversation search could not inspect complete knowledge')
    return { query, hits: result.hits.map(hit => ({ path: hit.path, version: hit.version })) }
  }

  private async requireAutomaticConversationResult(request: KnowledgeAutomaticMaintenanceRequest,
    candidate: Extract<KnowledgeAutomaticMaintenanceReview, { readonly decision: 'change' }>['change'],
    signal: AbortSignal): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Automatic knowledge review durability is unavailable')
    await using stored = await persistence.open(request.reviewerSessionId, 'read', { signal })
    const { events } = await stored.read(undefined, undefined, { signal })
    const inputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'brain-maintenance')
    const answers = events.filter(event => event.type === 'assistant/message')
    const ends = events.filter(event => event.type === 'turn/end')
    const answer = answers[0]
    if (inputs.length !== 1 || answer === undefined || answers.length !== 1 || ends.length !== 1
      || ends[0]?.data.reason.kind !== 'completed' || events.some(event => event.type === 'tool/call')) {
      throw new Error('Automatic knowledge reviewer no longer has one complete tool-free retained result')
    }
    const output = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (createHash('sha256').update(output).digest('hex') !== request.resultSha256) throw new Error('Automatic knowledge reviewer result changed')
    const originalInput = inputs[0]
    if (originalInput?.type !== 'user/message') throw new Error('Automatic knowledge reviewer source input is unavailable')
    const input = originalInput.data.content[0]
    if (input?.type !== 'text') throw new Error('Automatic knowledge reviewer source binding input is unavailable')
    const review = decodeAutomaticConversationReview(output, input.text, request.sources)
    if (review.decision !== 'change' || !this.sameAutomaticConversationChange(review.change, candidate)
      || JSON.stringify(review.sourceDispositions) !== JSON.stringify(request.sourceDispositions)
      || JSON.stringify(review.comparedPages) !== JSON.stringify(request.comparedPages)
      || review.titleQuery !== request.titleSearch.query || review.topicQuery !== request.topicSearch?.query) {
      throw new Error('Automatic knowledge reviewer does not own the retained candidate and exact classifications')
    }
  }

  private sameAutomaticConversationChange(
    actual: Extract<KnowledgeAutomaticMaintenanceReview, { readonly decision: 'change' }>['change'],
    expected: Extract<KnowledgeAutomaticMaintenanceReview, { readonly decision: 'change' }>['change']): boolean {
    if (actual.truth !== expected.truth || actual.summary !== expected.summary || actual.evidence !== expected.evidence) return false
    if (actual.kind === 'create' && expected.kind === 'create') {
      return actual.title === expected.title && actual.category === expected.category
        && JSON.stringify(actual.tags) === JSON.stringify(expected.tags)
    }
    if (actual.kind === 'merge' && expected.kind === 'merge') {
      return actual.documentId === expected.documentId && actual.expectedVersion === expected.expectedVersion
        && actual.sourceDocumentId === expected.sourceDocumentId && actual.sourceExpectedVersion === expected.sourceExpectedVersion
        && actual.reason === expected.reason
    }
    return actual.kind === 'update' && expected.kind === 'update'
      && actual.documentId === expected.documentId && actual.expectedVersion === expected.expectedVersion
  }

  private async admitUpdate(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgeTruthUpdate, signal: AbortSignal, authorize: () => void,
    refreshIndex = false, beforePublish?: (signal: AbortSignal) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    return this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => prepareTruthUpdate(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes),
      live, authorize, request.expectedVersion, refreshIndex,
      beforePublish === undefined ? undefined : () => beforePublish(live)))
  }

  /** Change an existing page lifecycle, preserving its understanding and recording evidence.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing Brain-relative page path.
   * @param request - retained governance intent, original read version and evidence.
   * @param signal - cancels before publication admission.
   * @returns a durable receipt; identical retries preserve later status and content changes.
   * @throws for roots, unreviewed draft publication, stale versions, unsafe paths, conflicting identities or a status already in effect.
   * @remarks Status publication refreshes index.md; an index failure reports partial success and permits an identical retry.
   */
  async setPageStatus(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate, signal: AbortSignal,
  ): Promise<KnowledgeTruthReceipt> {
    return this.admitStatus(workspaceId, documentId, request, signal, () => {})
  }

  /** Inspect an exact direct lifecycle receipt for an in-process import retry without admitting a write.
   * @param workspaceId - registered project owning the original status change.
   * @param documentId - exact existing Brain page.
   * @param request - original complete status request, including its user evidence.
   * @param signal - cancels the bounded file read.
   * @returns current file version for one matching Timeline receipt, or null when absent.
   * @throws for changed project selection, malformed files or conflicting operation identities.
   */
  async statusUpdateReceipt(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgePageStatusUpdate, signal: AbortSignal): Promise<{ readonly version: string } | null> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return hasStatusUpdateReceipt(documentId, text, version,
        request) ? { version } : null
    })
  }

  /** Publish only the exact held import draft after the import owner records human confirmation.
   * @param workspaceId - registered project selected by the retained import intent.
   * @param documentId - existing held draft path.
   * @param request - active status change with exact draft version and retained confirmation UUID.
   * @param hold - exact metadata read from the reviewed import record.
   * @param signal - cancellation before file publication admission.
   * @param beforePublish - import owner's Host recheck under the page writer lock; retry is true for the matching status receipt.
   * @returns durable status receipt; an identical retry does not change later content.
   * @throws on changed draft, hold mismatch, missing confirmation or active catalog conflict.
   */
  async publishHeldImportDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeImportPublicationHold, signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (request.status !== 'active') {
      throw new RemoteError('knowledge/update', 'held import draft publication requires active status',
        { path: documentId, reason: 'invalid' })
    }
    return this.admitStatus(workspaceId, documentId, request, signal, () => {}, hold, beforePublish)
  }

  /** Read the exact held Task draft and current active page/root catalog for second human confirmation.
   * @param workspaceId - original registered Task project.
   * @param documentId - retained draft path.
   * @param hold - original Task candidate and draft identity.
   * @param signal - cancels complete document and catalog reads.
   * @returns complete draft and twice-checked active pages and roots with a location-qualified catalog digest.
   */
  async reviewHeldTaskDraft(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    hold: KnowledgeTaskPublicationHold, signal: AbortSignal): Promise<KnowledgeTaskDraftReview> {
    return this.reviewHeldDraft(workspaceId, documentId, hold, signal, 'Task',
      readTaskPublicationHold, sameTaskPublicationHold)
  }
  /** Release only an exact held Task draft after a separate human confirmation.
   * @param workspaceId - original registered Task project matching the hold.
   * @param documentId - retained held draft path.
   * @param request - separate publication UUID and displayed draft version.
   * @param hold - original Task discovery and draft creation identity.
   * @param expectedActiveIndexDigest - catalog digest displayed with the reviewed draft.
   * @param signal - cancellation before publication admission.
   * @param beforePublish - Task owner's confirmation recheck under the page writer lock; retry identifies an exact status receipt.
   * @returns a durable publication receipt, or an unchanged retry receipt.
   */
  async publishHeldTaskDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeTaskPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (!this.isHeldPublicationRequest(workspaceId, request, hold, expectedActiveIndexDigest)) {
      throw new RemoteError('knowledge/update', 'Task publication requires a separate confirmation and reviewed active catalog',
        { path: documentId, reason: 'invalid' })
    }
    const location = this.locations.get(workspaceId)
    return this.admitStatus(workspaceId, documentId, request, signal,
      () => { this.locations.assertCurrent(location) }, hold, async (retry) => {
        if (!retry) {
          const catalog = await this.taskActiveCatalog(workspaceId, location, signal)
          if (catalog.digest !== expectedActiveIndexDigest) throw new RemoteError('knowledge/update',
            'Active knowledge changed since Task draft review; review the current catalog before publishing',
            { path: documentId, reason: 'conflict' })
        }
        await beforePublish(retry)
      })
  }

  /** Inspect an exact Task publication receipt and the active catalog after the page became active.
   * @param workspaceId - original registered Task project.
   * @param documentId - page released from the retained Task hold.
   * @param request - exact second human publication request, including its independent UUID.
   * @param hold - file-owned Task draft identity used to derive the publication receipt.
   * @param expectedActiveIndexDigest - catalog digest displayed before publication.
   * @param signal - cancellation of the bounded read-only inspection.
   * @returns verified only for a stable current catalog excluding the newly published page; otherwise required or unknown.
   */
  async reviewTaskPublication(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeTaskPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
  ): Promise<KnowledgeTaskPublicationReview> {
    const inspection = await this.inspectTaskPublication(workspaceId, documentId, request, hold,
      expectedActiveIndexDigest, signal)
    return inspection.status === 'ready' ? inspection.review : inspection
  }

  /** Read the published Task page and active catalog for a human response to a changed catalog.
   * @param workspaceId - original registered Task project.
   * @param documentId - page released from the retained Task hold.
   * @param request - exact second human publication request and receipt identity.
   * @param hold - file-owned Task draft identity used to derive the publication receipt.
   * @param expectedActiveIndexDigest - original catalog digest shown before publication.
   * @param signal - cancellation of the bounded read-only inspection.
   * @returns page body and twice-checked active-page metadata only when the receipt and catalog are stable.
   */
  async inspectTaskPublication(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeTaskPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
  ): Promise<KnowledgeTaskPublicationInspection> {
    if (workspaceId !== hold.workspaceId || request.status !== 'active' || !/^[a-f0-9]{64}$/u.test(expectedActiveIndexDigest)) {
      return { status: 'unknown', reason: 'receipt-unconfirmed' }
    }
    return this.inspectHeldPublication(workspaceId, documentId, request, hold, expectedActiveIndexDigest,
      signal, 'Task', readTaskPublicationHold)
  }
  /** Read the exact Goal-held draft and stable active catalog for a second human decision.
   * @param workspaceId - original registered project of the Goal research Task.
   * @param documentId - retained draft path.
   * @param hold - Goal, signed plan, report, candidate and draft identity.
   * @param signal - cancellation of the complete document and catalog reads.
   * @returns complete draft and twice-checked active pages and roots with a location-qualified catalog digest.
   */
  async reviewHeldGoalDraft(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    hold: KnowledgeGoalPublicationHold, signal: AbortSignal): Promise<KnowledgeGoalDraftReview> {
    return this.reviewHeldDraft(workspaceId, documentId, hold, signal, 'Goal',
      readGoalPublicationHold, sameGoalPublicationHold)
  }
  /** Publish only the exact Goal-human held draft after a distinct second confirmation.
   * @param workspaceId - original project matching the hold.
   * @param documentId - retained held draft path.
   * @param request - active status change with a new UUID and displayed draft version.
   * @param hold - immutable signed plan, Task report, candidate and first decision identity.
   * @param expectedActiveIndexDigest - complete active catalog digest displayed with the draft.
   * @param signal - cancellation before publication admission.
   * @param beforePublish - Goal-human owner's independent publication decision recheck under the page writer lock.
   * @returns durable publication receipt, or an unchanged exact retry receipt.
   * @throws for stale version, changed catalog, hold mismatch or missing human confirmation.
   */
  async publishHeldGoalDraft(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeGoalPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>,
  ): Promise<KnowledgeTruthReceipt> {
    if (!this.isHeldPublicationRequest(workspaceId, request, hold, expectedActiveIndexDigest)) {
      throw new RemoteError('knowledge/update', 'Goal publication requires a separate confirmation and reviewed active catalog',
        { path: documentId, reason: 'invalid' })
    }
    const location = this.locations.get(workspaceId)
    const attempt: GoalWriteAttempt = { operation: { kind: 'publication', hold, request, expectedActiveIndexDigest },
      observation: { writeStarted: false } }
    return this.admitStatus(workspaceId, documentId, request, signal,
      () => { this.locations.assertCurrent(location) }, hold, async (retry) => {
        if (!retry) {
          const catalog = await this.taskActiveCatalog(workspaceId, location, signal, undefined, 'Goal')
          if (catalog.digest !== expectedActiveIndexDigest) throw goalPrewriteRefusal(new RemoteError('knowledge/update',
            'Active knowledge changed since Goal draft review; review the current catalog before publishing',
            { path: documentId, reason: 'conflict' }), attempt.observation, workspaceId, documentId, attempt.operation)
        }
        await beforePublish(retry)
      }, attempt)
  }

  /** Reconcile one joined Goal-human write against its exact file receipt under Brain and page locks.
   * @param workspaceId - original project of the signed Goal research Task.
   * @param documentId - selected page from the retained human decision.
   * @param operation - exact proposal, held draft or independent publication request.
   * @param failure - original error object caught from this process's joined writer call.
   * @param signal - cancellation of lock acquisition and bounded file inspection.
   * @returns applied for an exact retained receipt; absent only for unchanged same-process pre-write proof;
   * unknown for cold recovery, changed targets and ambiguous writes. An absent result is not historical absence proof.
   */
  async inspectGoalOperation(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    operation: KnowledgeGoalOperation, failure: unknown, signal: AbortSignal): Promise<KnowledgeGoalOperationInspection> {
    const unknown: KnowledgeGoalOperationInspection = { status: 'unknown' }
    try {
      relativeSegments(documentId)
      if (!documentId.startsWith('pages/')) return unknown
      if (operation.kind === 'proposal') {
        if (operation.identity.workspaceId !== workspaceId || operation.request.operationId !== operation.identity.decisionId
          || operation.request.source !== goalProposalSource(operation.identity)) return unknown
      } else if (operation.hold.workspaceId !== workspaceId || operation.kind === 'draft'
        && (operation.request.status !== 'draft' || operation.request.operationId !== operation.hold.draftOperationId
          || operation.request.source !== `goal:${operation.hold.goalRunId}:task:${operation.hold.taskId}`)
        || operation.kind === 'publication' && (operation.request.status !== 'active'
          || operation.request.operationId === operation.hold.decisionId
          || operation.request.operationId === operation.hold.draftOperationId
          || !/^[a-f0-9]{64}$/u.test(operation.expectedActiveIndexDigest))) return unknown
      return await this.trackOperation(signal, live => this.locations.run(workspaceId, live, location =>
        this.withBrainPublication(location, live, async () => {
          const base = await this.files.base(location, live)
          if (base === undefined) return unknown
          return withFileLock(join(location.path, documentId), async () => {
            live.throwIfAborted()
            this.locations.assertCurrent(location)
            const located = await this.files.locate(base, documentId, live)
            if (located !== undefined && located.kind !== 'file') return unknown
            const target = located?.target ?? await this.ctx.fs.resolve(documentId,
              { cwd: this.ctx.fs.processPath(base), signal: live })
            if (!this.ctx.fs.contains(base, target)) return unknown
            let text: string | undefined
            let version: string | null = null
            if (located !== undefined) {
              const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
              text = this.files.decodeText(documentId, content.bytes)
              version = documentVersion(content.bytes, location)
            }
            if (text !== undefined && version !== null) {
              try {
                let applied = false
                switch (operation.kind) {
                  case 'proposal':
                    applied = prepareTruthProposal(documentId, text, version, operation.request,
                      new Date().toISOString(), this.config.maxDocumentBytes) === undefined
                    break
                  case 'draft': {
                    const prepared = preparePageCreation(documentId, operation.request,
                      new Date().toISOString(), this.config.maxDocumentBytes, operation.hold)
                    requireCreationReceipt(documentId, text, operation.request.operationId, prepared.digest)
                    applied = true
                    break
                  }
                  case 'publication':
                    applied = prepareStatusUpdate(documentId, text, version, operation.request,
                      new Date().toISOString(), this.config.maxDocumentBytes, operation.hold) === undefined
                    break
                }
                if (applied) return { status: 'applied', receipt: {
                  operationId: operation.request.operationId, documentId, version,
                  disposition: 'already-applied',
                } } as const
              } catch { /* A mismatched or malformed receipt does not prove non-publication. */ }
            }
            const proof = goalPrewriteProof(failure)
            if (proof === undefined || proof.workspaceId !== workspaceId || proof.documentId !== documentId
              || proof.operationDigest !== goalOperationDigest(workspaceId, documentId, operation)
              || proof.snapshot.locationRevision !== location.revision
              || proof.snapshot.targetKey !== target.targetKey || proof.snapshot.version !== version) return unknown
            return { status: 'absent' } as const
          }, { waitMs: this.config.writeLockWaitMs })
        })))
    } catch { return unknown }
  }

  /** Verify a Goal-human publication receipt and the current active catalog without changing knowledge.
   * @param workspaceId - original project of the Goal candidate.
   * @param documentId - page released from the retained Goal hold.
   * @param request - exact second human publication request.
   * @param hold - Goal draft identity used to derive the file receipt.
   * @param expectedActiveIndexDigest - catalog digest displayed before publication.
   * @param signal - cancellation of the bounded inspection.
   * @returns verified, changed-catalog required, or evidence-unavailable unknown.
   */
  async reviewGoalPublication(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeGoalPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
  ): Promise<KnowledgeGoalPublicationReview> {
    const inspection = await this.inspectGoalPublication(workspaceId, documentId, request, hold,
      expectedActiveIndexDigest, signal)
    return inspection.status === 'ready' ? inspection.review : inspection
  }

  /** Inspect a published Goal-human page and stable active catalog for later human disposition.
   * @param workspaceId - original project of the Goal candidate.
   * @param documentId - page released from the retained Goal hold.
   * @param request - exact second human publication request and receipt identity.
   * @param hold - file-owned Goal draft identity used to derive the receipt.
   * @param expectedActiveIndexDigest - original catalog digest shown before publication.
   * @param signal - cancellation of the bounded read-only inspection.
   * @returns current page and catalog only when the receipt and catalog are stable.
   */
  async inspectGoalPublication(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeGoalPublicationHold, expectedActiveIndexDigest: string, signal: AbortSignal,
  ): Promise<KnowledgeGoalPublicationInspection> {
    if (!this.isHeldPublicationRequest(workspaceId, request, hold, expectedActiveIndexDigest)) {
      return { status: 'unknown', reason: 'receipt-unconfirmed' }
    }
    return this.inspectHeldPublication(workspaceId, documentId, request, hold, expectedActiveIndexDigest,
      signal, 'Goal', readGoalPublicationHold)
  }
  private reviewHeldDraft<Hold extends { readonly workspaceId: WorkspaceId }>(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, hold: Hold, signal: AbortSignal, owner: 'Task' | 'Goal',
    readHold: (metadata: unknown) => Hold | null, sameHold: (left: Hold, right: Hold) => boolean,
  ): Promise<KnowledgeTaskDraftReview> {
    return this.trackOperation(signal, async (live) => {
      if (workspaceId !== hold.workspaceId) throw new RemoteError('knowledge/update', `${owner} draft belongs to another project`,
        { path: documentId, reason: 'conflict' })
      const { target, location } = await this.documentTarget(workspaceId, documentId, live)
      const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
      const text = this.files.decodeText(documentId, content.bytes)
      const document = parseKnowledgeDocument(documentId, text, documentVersion(content.bytes, location))
      const held = readHold(knowledgeSource(text, true).frontmatter.value)
      if (document.entry.status !== 'draft' || held === null || !sameHold(held, hold)) {
        throw new RemoteError('knowledge/update', `${owner} draft differs from the retained human decision`,
          { path: documentId, reason: 'conflict' })
      }
      const first = await this.taskActiveCatalog(workspaceId, location, live, undefined, owner)
      const again = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
      const second = await this.taskActiveCatalog(workspaceId, location, live, undefined, owner)
      if (documentVersion(again.bytes, location) !== document.entry.version || first.digest !== second.digest
        || JSON.stringify(first.activePages) !== JSON.stringify(second.activePages)) {
        throw new RemoteError('knowledge/update', `${owner} draft or active catalog changed during review`,
          { path: documentId, reason: 'conflict' })
      }
      this.locations.assertCurrent(location)
      return { document, activeIndexDigest: second.digest, activePageCount: second.pageCount,
        activePages: second.activePages }
    })
  }


  private isHeldPublicationRequest(workspaceId: WorkspaceId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold, expectedActiveIndexDigest: string): boolean {
    return workspaceId === hold.workspaceId && request.status === 'active'
      && request.operationId !== hold.draftOperationId && request.operationId !== hold.decisionId
      && /^[a-f0-9]{64}$/u.test(expectedActiveIndexDigest)
  }

  private inspectHeldPublication(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    hold: KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold, expectedActiveIndexDigest: string,
    signal: AbortSignal, owner: 'Task' | 'Goal',
    readHold: (metadata: unknown) => KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold | null,
  ): Promise<KnowledgeTaskPublicationInspection> {
    return this.trackOperation(signal, async (live) => {
      let published: {
        readonly version: string
        readonly target: FsTarget
        readonly location: KnowledgeLocation
        readonly currentPage: {
          readonly id: KnowledgeDocumentId
          readonly title: string
          readonly body: string
          readonly version: string
        }
      }
      try {
        const { target, location } = await this.documentTarget(workspaceId, documentId, live)
        const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, live)
        const text = this.files.decodeText(documentId, content.bytes)
        const version = documentVersion(content.bytes, location)
        const document = parseKnowledgeDocument(documentId, text, version)
        const remainingHold = readHold(knowledgeSource(text, true).frontmatter.value)
        if (document.entry.status !== 'active' || remainingHold !== null
          || prepareStatusUpdate(documentId, text, version, request, new Date().toISOString(),
            this.config.maxDocumentBytes, hold) !== undefined) {
          return { status: 'unknown', reason: 'receipt-unconfirmed' }
        }
        published = { version, target, location,
          currentPage: { id: document.entry.id, title: document.entry.title, body: document.body, version } }
      } catch {
        return { status: 'unknown', reason: 'receipt-unconfirmed' }
      }
      try {
        const first = await this.taskActiveCatalog(workspaceId, published.location, live, documentId, owner)
        const again = await this.files.readLocated(documentId, published.target, this.config.maxDocumentBytes, live)
        if (documentVersion(again.bytes, published.location) !== published.version
          || first.excludedVersion !== published.version) return { status: 'unknown', reason: 'receipt-unconfirmed' }
        const second = await this.taskActiveCatalog(workspaceId, published.location, live, documentId, owner)
        if (first.digest !== second.digest || second.excludedVersion !== published.version
          || JSON.stringify(first.activePages) !== JSON.stringify(second.activePages)) {
          return { status: 'unknown', reason: 'catalog-unavailable' }
        }
        const review: Exclude<KnowledgeTaskPublicationReview, { readonly status: 'unknown' }> =
          second.digest === expectedActiveIndexDigest
            ? { status: 'verified', observedActiveIndexDigest: second.digest, currentPageVersion: published.version }
            : { status: 'required', reason: 'active-catalog-changed', observedActiveIndexDigest: second.digest,
              currentPageVersion: published.version }
        return { status: 'ready', review, currentPage: published.currentPage, activePages: second.activePages }
      } catch {
        return { status: 'unknown', reason: 'catalog-unavailable' }
      }
    })
  }


  private ordinaryDraftOrigin(documentId: KnowledgeDocumentId, text: string):
  { operationId: KnowledgeUpdateId | null; digest: string | null } {
    const source = knowledgeSource(text, true)
    const metadata = source.frontmatter.value
    if (readImportPublicationHold(metadata) !== null || readTaskPublicationHold(metadata) !== null
      || readGoalPublicationHold(metadata) !== null) throw new RemoteError('knowledge/update',
      'Import, Task and Goal drafts keep their separate publication owner', { path: documentId, reason: 'read-only' })
    const timeline = source.timeline.value as Record<string, unknown>[] | null
    const first = timeline?.[0]
    const hasId = first?.dsh_operation_id !== undefined, hasDigest = first?.dsh_request_digest !== undefined
    if (!hasId && !hasDigest) return { operationId: null, digest: null }
    if (typeof first.dsh_operation_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(first.dsh_operation_id)
      || typeof first.dsh_request_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(first.dsh_request_digest)) {
      throw new RemoteError('knowledge/update', 'Ordinary draft has an incomplete creation receipt',
        { path: documentId, reason: 'read-only' })
    }
    return { operationId: first.dsh_operation_id as KnowledgeUpdateId, digest: first.dsh_request_digest }
  }

  private assertOrdinaryHuman(): void {
    if (this.ctx.get('agents')?.currentInitiator() !== undefined) throw new RemoteError('knowledge/update',
      'Ordinary draft publication requires explicit trusted UI or Host confirmation', { path: 'pages', reason: 'read-only' })
  }

  private ordinaryStatusRequest(request: KnowledgeOrdinaryDraftPublishRequest): KnowledgePageStatusUpdate {
    return { operationId: request.operationId, expectedVersion: request.expectedDraftVersion, status: 'active',
      reason: request.reason, source: 'user:ordinary-draft-publication', evidence: request.evidence }
  }

  private ordinaryRelease(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeOrdinaryDraftPublishRequest, origin: { operationId: KnowledgeUpdateId | null; digest: string | null }):
  KnowledgeOrdinaryPublicationRelease {
    return { kind: 'ordinary', workspaceId, documentId, draftOperationId: origin.operationId,
      draftRequestDigest: origin.digest, reviewDigest: request.reviewDigest,
      activeIndexDigest: request.expectedActiveIndexDigest }
  }

  private async ordinaryDraftReview(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    topicInput: string, signal: AbortSignal): Promise<{ review: KnowledgeOrdinaryDraftReview
    evidence: OrdinaryPublicationReviewEvidence
    location: KnowledgeLocation }> {
    const topicQuery = topicInput.trim()
    if (topicQuery.length === 0 || topicQuery.includes('\0')
      || Buffer.byteLength(topicQuery, 'utf8') > this.config.maxDocumentBytes) throw new RemoteError('knowledge/update',
      'Ordinary draft review requires a bounded independent subject query', { path: documentId, reason: 'invalid' })
    const { target, location } = await this.documentTarget(workspaceId, documentId, signal)
    const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
    const text = this.files.decodeText(documentId, content.bytes)
    const document = parseKnowledgeDocument(documentId, text, documentVersion(content.bytes, location))
    if (document.entry.kind !== 'page' || document.entry.status !== 'draft') throw new RemoteError('knowledge/update',
      'Only a current saved ordinary draft can be reviewed for publication', { path: documentId, reason: 'read-only' })
    const origin = this.ordinaryDraftOrigin(documentId, text)
    const titleQuery = document.entry.title.trim()
    const tokens = (value: string): readonly string[] => value.normalize('NFC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    const titleTokens = new Set(tokens(titleQuery))
    if (titleQuery.length === 0 || !tokens(topicQuery).some(token => !titleTokens.has(token))) {
      throw new RemoteError('knowledge/update', 'Subject query must contain a word outside the draft title',
        { path: documentId, reason: 'invalid' })
    }
    const first = await this.taskActiveCatalog(workspaceId, location, signal)
    const search = (query: string) => this.search(workspaceId, { query, statuses: ['active'],
      maxResults: this.config.maxEntries, maxMatches: this.config.maxEntries }, signal)
    const titleSearch = await search(titleQuery)
    const topicSearch = await search(topicQuery)
    const complete = (result: KnowledgeSearchResult) => result.exists && !result.truncated
      && result.issues.length === 0 && result.hits.every(hit => !hit.linesTruncated && hit.status === 'active')
    if (!complete(titleSearch) || !complete(topicSearch)) throw new RemoteError('knowledge/update',
      'An active-page search was incomplete; the draft remains unpublished', { path: documentId, reason: 'conflict' })
    const again = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
    const second = await this.taskActiveCatalog(workspaceId, location, signal)
    this.locations.assertCurrent(location)
    if (documentVersion(again.bytes, location) !== document.entry.version || first.digest !== second.digest
      || JSON.stringify(first.activePages) !== JSON.stringify(second.activePages)) throw new RemoteError('knowledge/update',
      'Draft or active catalog changed during ordinary publication review', { path: documentId, reason: 'conflict' })
    const basis = { document, titleQuery, titleSearch, topicQuery, topicSearch,
      activeIndexDigest: second.digest, activePages: second.activePages }
    const evidence = ordinaryReviewEvidence(workspaceId, location.projectPath,
      `${location.directory}:${location.revision}`, documentId, basis, origin.operationId, origin.digest)
    if (Buffer.byteLength(JSON.stringify(evidence)) > this.config.editorDrafts.maxRecordBytes) throw new RemoteError('knowledge/update',
      'Ordinary publication review exceeds the private confirmation limit', { path: documentId, reason: 'invalid' })
    return { review: { ...basis, reviewDigest: evidence.reviewDigest }, evidence, location }
  }

  private async taskActiveCatalog(workspaceId: WorkspaceId, location: KnowledgeLocation,
    signal: AbortSignal, excluded?: KnowledgeDocumentId, owner: 'Task' | 'Goal' = 'Task'): Promise<{
    digest: string
    pageCount: number
    excludedVersion: string | null
    activePages: readonly { id: KnowledgeDocumentId; title: string; version: string }[]
  }> {
    const project = this.ctx.workspaceRegistry.get(workspaceId)
    if (project === undefined || project.archivedAt !== undefined || project.path !== location.projectPath) {
      throw new RemoteError('knowledge/update', `Original ${owner} project is unavailable`,
        { path: location.path, reason: 'conflict' })
    }
    const index = await this.index(workspaceId, signal)
    this.locations.assertCurrent(location)
    if (!index.exists || index.truncated || index.issues.length > 0) throw new RemoteError('knowledge/update',
      'Current active knowledge catalog is incomplete; publication requires a complete review',
      { path: location.path, reason: 'conflict' })
    const excludedEntry = excluded === undefined ? undefined : index.entries.find(entry => entry.kind === 'page' && entry.id === excluded)
    const activePages = index.entries.filter(entry => entry.status === 'active' && entry.id !== excluded)
      .map(entry => ({ id: entry.id, title: entry.title, version: entry.version }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    const pages = activePages.map(({ id, version }) => [id, version] as const)
    const digest = createHash('sha256').update(JSON.stringify({ projectId: workspaceId, projectPath: project.path,
      directory: index.directory, locationRevision: index.locationRevision, pages })).digest('hex')
    return { digest, pageCount: pages.length, activePages,
      excludedVersion: excludedEntry?.status === 'active' ? excludedEntry.version : null }
  }

  /** Change page lifecycle in one project of the executing conversation's logical workspace.
   * @param sessionId - live ordinary project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - existing Brain page; no creation or archival is performed.
   * @param request - retained status change with its read version and evidence.
   * @param signal - cancellation before admission; an admitted filesystem write cannot be revoked.
   * @param targetProject - project id or unique name matching the informing read; omitted uses the conversation default.
   * @returns the same durable receipt as the Remote operation.
   * @throws if project membership changes or an ordinary conversation requests active publication.
   */
  async setSessionPageStatus(
    sessionId: SessionId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate, signal: AbortSignal, targetProject?: string,
  ): Promise<KnowledgeTruthReceipt> {
    if (request.status === 'active') this.requireReviewedSessionPublication(sessionId, documentId)
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.admitStatus(projectId, documentId, request, signal, authorize), request.expectedVersion)
  }

  private admitStatus(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageStatusUpdate,
    signal: AbortSignal, authorize: () => void,
    release?: KnowledgeImportPublicationHold | KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold
      | KnowledgeOrdinaryPublicationRelease,
    beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
  ): Promise<KnowledgeTruthReceipt> {
    return this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => prepareStatusUpdate(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes,
        release), live, authorize, request.expectedVersion, true, beforePublish, goalAttempt))
  }

  /** Archive a page without deleting it; an optional existing replacement adds a reversal to history.
   * @param workspaceId - registered project owning both pages.
   * @param documentId - existing Brain page, never a root.
   * @param request - retained archival UUID, informing version, optional replacement and evidence.
   * @param signal - cancels before publication admission.
   * @returns a durable receipt; identical retries preserve later edits without requiring the replacement to remain present.
   * @throws for stale input, unsafe or missing pages, malformed receipts or conflicting identities.
   * @remarks Archival refreshes index.md; an index failure reports partial success and permits an identical retry.
   */
  @Remote
  async archivePage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageArchive, signal: AbortSignal,
  ): Promise<KnowledgeTruthReceipt> {
    return this.admitArchive(workspaceId, documentId, request, signal, () => {})
  }

  /** Archive knowledge in one project of the executing conversation's logical workspace.
   * @param sessionId - live ordinary project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - existing Brain page identity.
   * @param request - complete retained archival intent.
   * @param signal - cancels before admission; an admitted filesystem write cannot be revoked.
   * @param targetProject - project id or unique name matching the informing read; omitted uses the conversation default.
   * @returns the same durable receipt as the Remote operation.
   * @throws if membership changes before publication admission.
   */
  async archiveSessionPage(
    sessionId: SessionId, documentId: KnowledgeDocumentId, request: KnowledgePageArchive, signal: AbortSignal, targetProject?: string,
  ): Promise<KnowledgeTruthReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.admitArchive(projectId, documentId, request, signal, authorize), request.expectedVersion)
  }

  private admitArchive(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageArchive,
    signal: AbortSignal, authorize: () => void,
  ): Promise<KnowledgeTruthReceipt> {
    return this.trackOperation(signal, live => this.updatePage(workspaceId, documentId, request.operationId,
      (text, version) => preparePageArchive(documentId, text, version, request, new Date().toISOString(),
        this.config.maxDocumentBytes, async (path) => {
          const replacement = await this.read(workspaceId, path, live)
          if (replacement.entry.kind !== 'page') {
            throw new RemoteError('knowledge/update', 'archive replacement must be a page in the same project', { path, reason: 'invalid' })
          }
          return replacement.entry.slug
        }), live, authorize, request.expectedVersion, true))
  }

  /** Retain a confirmed two-page merge before publishing the kept page and archiving the duplicate.
   * @param workspaceId - registered project owning both distinct ordinary pages.
   * @param request - complete human approval, original versions and retained operation UUID.
   * @param signal - stops before the next stage; admitted file and domain writes are drained.
   * @returns file-verified progress, including retained partial failure or a changed-page refusal.
   * @remarks Trusted UI/Host entry; Agent-initiated calls are refused, not authenticated as human approval.
   */
  @Remote
  async mergePages(workspaceId: WorkspaceId, request: KnowledgePageMergeRequest, signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    this.assertMergeHuman(workspaceId)
    return this.trackOperation(signal, live => this.locations.run(workspaceId, live, location =>
      this.withBrainPublication(location, live, async () => {
        const operations = this.mergeOperations(location, live, true)
        const record = await this.mergeStore.prepare(request, operations, live)
        return this.mergeStore.continue(record, operations, live)
      })))
  }

  /** Consolidate two active pages under the executing ordinary model conversation, never human approval.
   * @param sessionId - live owner of the current brain_merge_pages tool execution.
   * @param request - complete merged text, both original read versions, exact user evidence and AI rationale in note.
   * @param signal - cancels before the next publication; committed stages remain recoverable.
   * @param targetProject - permitted workspace project id or unique name matching both informing reads.
    * @returns retained progress after target publication, source archival and index refresh; enabled automatic policies first run
    * independent full-catalog review, and partial success is explicit.
   * @throws for missing complete current reads, another owner, Tasks, approved Goals, draft holds or pending proposals.
   * @remarks Retrying retains every original input and additionally requires complete reads of both current versions.
   */
  async mergeSessionPages(sessionId: SessionId, request: KnowledgePageMergeRequest,
    signal: AbortSignal, targetProject?: string): Promise<KnowledgePageMergeReview> {
    const execution = currentBrainModelWrite(this.ctx.root, sessionId)
    if (execution?.name !== 'brain_merge_pages') throw new Error('AI consolidation requires its executing brain_merge_pages conversation')
    const { project, location, session, authorize: membership } = this.workspaceSessionWriter(sessionId, targetProject)
    const initiator: PageMergeInitiator = { sessionId, source: requireUserEvidenceSource(session, request.evidence) }
    const authorize = (): void => {
      membership()
      if (currentBrainModelWrite(this.ctx.root, sessionId) !== execution) throw new Error('AI consolidation execution changed')
      if (requireUserEvidenceSource(session, request.evidence) !== initiator.source) throw new Error('AI consolidation evidence changed')
      requireInformedBrainRead(session, project.path, request.target.documentId, request.target.expectedVersion)
      requireInformedBrainRead(session, project.path, request.source.documentId, request.source.expectedVersion)
    }
    authorize()
    if (this.config.automaticMaintenance.enabled && !this.isKnowledgeImportSession(session)) {
      try {
        const outcome = await this.automaticConversationPage(sessionId, request.target.documentId,
          { kind: 'merge', request }, signal, targetProject)
        authorize()
        if (outcome.status !== 'applied') throw new RemoteError('knowledge/merge',
          `AI consolidation ${outcome.status}: ${outcome.reason}; current knowledge was retained`, { reason: 'invalid' })
        const record = this.mergeStore.get(project.id, request.operationId)
        return await this.mergeStore.review(record, this.mergeOperations(location, signal, false, { initiator, authorize }), signal)
      } catch (error) {
        if (!(error instanceof AutomaticMergeIncompleteError)) throw error
        authorize()
        return error.review
      }
    }
    return this.trackOperation(signal, live => this.locations.run(project.id, live, (captured) => {
      if (captured.path !== location.path || captured.revision !== location.revision) throw new Error('Brain location changed before AI consolidation')
      return this.withBrainPublication(captured, live, async () => {
        const operations = this.mergeOperations(captured, live, true, { initiator, authorize })
        const record = await this.mergeStore.prepare(request, operations, live)
        for (const selected of [request.target, request.source]) {
          const current = await operations.read(selected.documentId)
          requireInformedBrainRead(session, project.path, selected.documentId, current.version)
        }
        return this.mergeStore.continue(record, operations, live)
      })
    }))
  }

  /** List retained merge identities without reading pages, starting inference or continuing writes.
   * @param workspaceId - currently registered project; saved Brain selections are not retargeted.
   * @param signal - cancels the read and controller lifetime.
   * @returns bounded summaries with acknowledged stages, explicit preview omission and complete retained counts.
   */
  @Remote
  async pageMerges(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgePageMergeList> {
    return this.trackOperation(signal, (live) => {
      this.workspacePath(workspaceId)
      live.throwIfAborted()
      return Promise.resolve(this.mergeStore.list(workspaceId))
    })
  }

  /** Compare retained approval with actual current file receipts without promoting or resuming an operation.
   * @param workspaceId - currently registered owning project.
   * @param operationId - exact retained merge identity, never a filename.
   * @param signal - cancels queued inspection and complete file reads.
   * @returns full baseline, current pages and explicit missing, changed or completed state.
   */
  @Remote
  async pageMerge(workspaceId: WorkspaceId, operationId: KnowledgeUpdateId, signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    return this.trackOperation(signal, live => this.locations.run(workspaceId, live, location =>
      this.mergeStore.review(this.mergeStore.get(workspaceId, operationId), this.mergeOperations(location, live, false), live)))
  }

  /** Explicitly continue only the original retained approval, reconciling uncertain writes from file receipts first.
   * @param workspaceId - registered owning project; roots, other projects and model initiators cannot acquire this writer.
   * @param operationId - original merge UUID; versions and proposed text cannot be replaced during continuation.
   * @param signal - stops before the next stage and joins admitted work.
   * @returns actual progress or a blocking conflict; completed receipts never roll back subsequent user edits.
   */
  @Remote
  async continuePageMerge(workspaceId: WorkspaceId, operationId: KnowledgeUpdateId,
    signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    this.assertMergeHuman(workspaceId)
    return this.trackOperation(signal, live => this.locations.run(workspaceId, live, location =>
      this.withBrainPublication(location, live, () =>
        this.mergeStore.continue(this.mergeStore.get(workspaceId, operationId), this.mergeOperations(location, live, true), live))))
  }

  /** Permanently end one retained merge attempt without undoing or completing its file publications.
   * @param workspaceId - currently registered owning project; model initiators and archived projects are refused.
   * @param operationId - original retained merge UUID.
   * @param decision - explicit decision UUID and note; uncertain retries must preserve both.
   * @param signal - cancels queued work; admitted domain writes are drained before completion.
   * @returns original intent, actual file observations and the immutable terminal decision, even for unavailable pages.
   * @remarks Trusted UI/Host entry, not human authentication. No page, index, access count or health job is written.
   */
  @Remote
  async abandonPageMerge(workspaceId: WorkspaceId, operationId: KnowledgeUpdateId,
    decision: KnowledgePageMergeAbandon, signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    this.assertMergeHuman(workspaceId)
    return this.trackOperation(signal, live => this.locations.run(workspaceId, live, location =>
      this.withBrainPublication(location, live, () =>
        this.mergeStore.abandon(this.mergeStore.get(workspaceId, operationId), decision,
          this.mergeOperations(location, live, true), live))))
  }

  private assertMergeHuman(workspaceId: WorkspaceId): void {
    if (this.ctx.get('agents')?.currentInitiator() !== undefined) {
      throw new RemoteError('knowledge/merge', 'Page consolidation requires explicit trusted UI or Host confirmation', { reason: 'not-human' })
    }
    this.workspacePath(workspaceId)
    if (this.ctx.workspaceRegistry.get(workspaceId)?.archivedAt !== undefined) {
      throw new RemoteError('knowledge/merge', 'Archived projects cannot continue knowledge consolidation', { reason: 'invalid' })
    }
  }

  private mergeOperations(location: KnowledgeLocation, signal: AbortSignal, writing: boolean,
    model?: { initiator: PageMergeInitiator; authorize: () => void; beforePublish?: () => Promise<void> }): PageMergeOperations {
    const authorize = (): void => {
      signal.throwIfAborted()
      this.locations.assertCurrent(location)
      if (writing) {
        if (model === undefined) this.assertMergeHuman(location.workspaceId)
        else model.authorize()
      }
    }
    return {
      location, authorize, ...model === undefined ? {} : { initiator: model.initiator },
      read: async (id) => {
        authorize()
        const { target } = await this.documentTarget(location.workspaceId, id, signal)
        const content = await this.files.readLocated(id, target, this.config.maxDocumentBytes, signal)
        const text = this.files.decodeText(id, content.bytes), version = documentVersion(content.bytes, location)
        authorize()
        return { text, version, document: parseKnowledgeDocument(id, text, version) }
      },
      publish: async (id, before, after, kind) => {
        if (!writing) throw new Error('Read-only merge inspection cannot publish')
        authorize()
        const receipt = await this.modifyLocatedPage(location, id, (text, version) => {
          if (text !== before) throw new RemoteError('knowledge/update', 'Page changed before its merge publication', { path: id, reason: 'conflict' })
          if (model !== undefined) requireMergeableActivePage({ text, version, document: parseKnowledgeDocument(id, text, version) })
          return after
        }, signal, authorize, 'knowledge', undefined, model === undefined ? undefined
          : async () => {
            await this.assertSessionUpdateAdmission(model.initiator.sessionId, location.workspaceId, id, signal)
            await model.beforePublish?.()
            authorize()
          })
        if (kind === 'truth' && receipt.disposition === 'written') {
          await this.recordAccess({ projectId: location.workspaceId, documentId: id, kind: 'write',
            ...model === undefined ? {} : { writerSessionId: model.initiator.sessionId } })
          this.scheduleHealthAfterWrite(location, receipt)
        }
      },
      reindex: async () => {
        if (!writing) throw new Error('Read-only merge inspection cannot rebuild the index')
        await model?.beforePublish?.()
        authorize()
        await this.reindexLocated(location, signal, authorize)
      },
    }
  }

  /** Normalize one page's legacy section markers without changing knowledge, metadata or history.
   * @param workspaceId - registered project owning the page.
   * @param documentId - existing page path; roots are refused.
   * @param signal - cancels before publication; admitted filesystem writes cannot be revoked.
   * @returns true for a repaired page, false for an already canonical or unmarked page.
   * @throws for malformed, unsafe, missing, concurrently changed or oversized pages.
   */
  @Remote
  async normalizePageFormat(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<boolean> {
    return this.admitFormat(workspaceId, documentId, signal, () => {})
  }

  /** Repair page storage markers in one project of an ordinary conversation's logical workspace.
   * @param sessionId - live project or workspace conversation; Tasks and approved unexited Goals are refused.
   * @param documentId - existing page path, including draft and archived pages.
   * @param signal - cancels before admission and drains pending lock acquisition.
   * @param targetProject - project id or unique name; omitted uses the conversation default.
   * @returns true when markers changed; repeat calls preserve subsequent edits.
   * @throws when membership changes or the page cannot be safely repaired.
   */
  async normalizeSessionPageFormat(sessionId: SessionId, documentId: KnowledgeDocumentId, signal: AbortSignal,
    targetProject?: string): Promise<boolean> {
    const { project, authorize } = this.workspaceSessionWriter(sessionId, targetProject)
    return this.admitFormat(project.id, documentId, signal, authorize)
  }

  private admitFormat(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal, authorize: () => void,
  ): Promise<boolean> {
    return this.trackOperation(signal, async (live) => {
      const result = await this.modifyPage(workspaceId, documentId,
        (text, version) => normalizeKnowledgePage(documentId, text, version, this.config.maxDocumentBytes), live, authorize)
      return result.disposition === 'written'
    })
  }

  /** Replace a page's tags without rewriting its understanding or history.
   * @param workspaceId - registered destination project, independent of any Session.
   * @param documentId - existing page, including drafts and archives; roots are refused.
   * @param request - complete tag list and observed document version.
   * @param signal - cancels before publication; admitted native writes may finish.
   * @returns written metadata or a non-writing acknowledgement of an already equal normalized list.
   * @throws for invalid, stale, unsafe, relocated or oversized documents and requests.
   * @remarks Remote saves refresh index.md; an index failure reports the saved page and permits an identical retry.
   */
  @Remote
  async setPageTags(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgePageTagsUpdate, signal: AbortSignal): Promise<KnowledgeMutationReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.admitTags(workspaceId, documentId, request, signal, () => { this.locations.assertCurrent(location) }, true)
    await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  /** Replace metadata tags in one project of the live conversation's logical workspace.
   * @param sessionId - live ordinary project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - page path from a retained successful read of the destination project.
   * @param request - replacement tags and exact informing read version; no new Timeline evidence is created.
   * @param signal - cancels pending work before publication admission.
   * @param targetProject - project id or unique name; omitted uses the conversation default.
   * @returns publication metadata, with access attributed to the selected project.
   * @throws for changed ownership, unread pages, stale differing tags or invalid publication inputs.
   */
  async setSessionPageTags(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgePageTagsUpdate, signal: AbortSignal, targetProject?: string): Promise<KnowledgeMutationReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.admitTags(projectId, documentId, request, signal, authorize), request.expectedVersion)
  }

  private admitTags(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgePageTagsUpdate, signal: AbortSignal, authorize: () => void, refreshIndex = false): Promise<KnowledgeMutationReceipt> {
    return this.trackOperation(signal, live => this.modifyPage(workspaceId, documentId,
      (text, version) => preparePageTags(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes),
      live, authorize, 'knowledge', request.expectedVersion, refreshIndex))
  }

  /** Change a page's display title in the live conversation's logical workspace and refresh index.md.
   * @param sessionId - live ordinary conversation; Tasks and approved Goals are refused.
   * @param documentId - existing page path from a retained successful destination read.
   * @param request - trimmed non-empty title and exact informing read version.
   * @param signal - cancels before admission; an admitted file write may finish.
   * @param targetProject - project id or unique name; omitted uses the conversation default.
   * @returns publication metadata with access attributed to the selected project.
   * @throws for changed ownership, unread pages, stale differing titles or unsafe inputs.
   * @remarks Index failure leaves the page saved; the same request can retry indexing without changing the page again.
   */
  async updateSessionPageTitle(sessionId: SessionId, documentId: KnowledgeDocumentId,
    request: KnowledgePageTitleUpdate, signal: AbortSignal, targetProject?: string): Promise<KnowledgeMutationReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.trackOperation(signal, live => this.modifyPage(projectId, documentId,
        (text, version) => preparePageTitle(documentId, text, version, request, new Date().toISOString(), this.config.maxDocumentBytes),
        live, authorize, 'knowledge', request.expectedVersion, true)), request.expectedVersion)
  }

  /** Observe actual in-flight knowledge work for the Desktop quit and update admission.
    * @returns whether tracked operations or running health checks still own work; retained history and pending recovery records are
    * not busy state.
   * @remarks Host-only. A tracked scheduled delay remains active until its operation settles or is cancelled.
   */
  hasActiveOperations(): boolean { return this.updates.size > 0 || this.checks.size > 0 }

  private async trackOperation<T>(
    signal: AbortSignal, run: (live: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const live = AbortSignal.any([signal, this.lifetime.signal])
    live.throwIfAborted()
    const operation = run(live)
    this.updates.add(operation)
    try { return await operation } finally { this.updates.delete(operation) }
  }

  private scheduleHealthAfterWrite(location: KnowledgeLocation, receipt: KnowledgeMutationReceipt): void {
    const policy = this.config.healthAfterWrite
    const cycle = this.healthCycle
    if (policy == null || cycle === undefined || receipt.disposition !== 'written' || this.lifetime.signal.aborted) return
    const pageId = receipt.documentId.startsWith('pages/') ? receipt.documentId : null
    void this.trackAutomaticHealth(cycle, async (live) => {
      try {
        await this.healthDelay(policy.delayMs, live)
        live.throwIfAborted()
        this.locations.assertCurrent(location)
        const current = this.healthClients.values().next().value?.context
        if (current == null || current.model === null) {
          this.ctx.logger.debug('Post-write Brain Health check skipped: Client model is unavailable')
          return
        }
        await this.runBackgroundHealth(location, { locale: current.locale, scope: pageId === null ? 'all-active' : 'related-pages',
          model: current.model,
          pageId, includeDrafts: true, includeArchived: false, checkCodeChanges: false }, live)
      } catch (error) {
        if (!live.aborted) this.ctx.logger.warn('Post-write Brain Health check skipped or failed: %s', error)
      }
    })
  }

  private trackAutomaticHealth(cycle: HealthClientCycle, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const task = this.trackOperation(cycle.lifetime.signal, run)
    cycle.operations.add(task)
    void task.then(() => { cycle.operations.delete(task) }, () => { cycle.operations.delete(task) })
    return task
  }

  private async runBackgroundHealth(location: KnowledgeLocation, options: KnowledgeHealthCheckOptions, signal: AbortSignal): Promise<void> {
    if (this.backgroundHealthRunning || this.checks.has(location.workspaceId)) return
    this.backgroundHealthRunning = true
    const effort = this.config.healthCheck?.backgroundReasoningEffort
    const request = effort === undefined || options.model === undefined ? options
      : { ...options, model: { ...options.model, reasoningEffort: effort } }
    try { await this.checkHealth(location.workspaceId, request, signal) } finally { this.backgroundHealthRunning = false }
  }

  private async retainHealthPreflightFailure(location: KnowledgeLocation): Promise<void> {
    if (this.checks.has(location.workspaceId)) return
    this.checks.add(location.workspaceId)
    try {
      const attempt = await this.healthCheckStore.begin(location)
      await this.healthCheckStore.finish(attempt, 'error')
    } finally { this.checks.delete(location.workspaceId) }
  }

  /** Initialize one absent root or replace its complete body at an observed content version.
   * @param workspaceId - registered project owning the root.
   * @param documentId - one of the six fixed Brain root filenames.
   * @param request - retained intent; null version creates only, a read version replaces only.
   * @param signal - cancels before atomic publication admission.
   * @returns a durable receipt; identical retries preserve subsequent root edits.
   * @throws for stale versions, unsafe paths, invalid input or conflicting retry identities.
   */
  @Remote
  async writeRoot(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgeRootWrite, signal: AbortSignal,
  ): Promise<KnowledgeTruthReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.admitRoot(workspaceId, documentId, request, signal, () => { this.locations.assertCurrent(location) })
    await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  /** Inspect one exact root write receipt in the selected project's current file without admitting a write.
   * @param workspaceId - registered project owning the root.
   * @param documentId - one of the six fixed Brain root filenames.
   * @param request - original complete canonical write including its operation UUID.
   * @param signal - cancels the bounded read without starting a model.
   * @returns current file version only for an exact file-owned receipt; null when absent.
   * @throws for changed registration, malformed files or conflicting operation identities.
   */
  @Remote
  async rootWriteReceipt(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    request: KnowledgeRootWrite, signal: AbortSignal): Promise<{ readonly version: string } | null> {
    return this.trackOperation(signal, async (live) => {
      const { text, version } = await this.readDocumentSource(workspaceId, documentId, live)
      return hasRootWriteReceipt(documentId, text, version,
        request, this.config.maxDocumentBytes) ? { version } : null
    })
  }

  /** Write a root in one project of the executing conversation's logical workspace.
   * @param sessionId - live ordinary project or workspace conversation; Tasks and approved Goals are refused.
   * @param documentId - fixed Brain root filename.
   * @param request - complete retained root intent and evidence.
   * @param signal - cancellation before admission; an admitted filesystem write cannot be revoked.
   * @param targetProject - project id or unique name; omitted uses the conversation default.
   * @returns the same durable receipt as the Remote operation.
   * @throws when project membership changes before publication admission.
   */
  async writeSessionRoot(
    sessionId: SessionId, documentId: KnowledgeDocumentId, request: KnowledgeRootWrite, signal: AbortSignal, targetProject?: string,
  ): Promise<KnowledgeTruthReceipt> {
    return this.conversationWrite(sessionId, documentId, targetProject,
      (projectId, authorize) => this.admitRoot(projectId, documentId, request, signal, authorize), request.expectedVersion ?? undefined)
  }

  private admitRoot(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgeRootWrite,
    signal: AbortSignal, authorize: () => void,
  ): Promise<KnowledgeTruthReceipt> {
    const prepare = (current: { text: string; version: string } | null) =>
      prepareRootWrite(documentId, current, request, new Date().toISOString(), this.config.maxDocumentBytes)
    return this.trackOperation(signal, (live) => {
      if (request.expectedVersion !== null) {
        return this.updatePage(workspaceId, documentId, request.operationId,
          (text, version) => prepare({ text, version }), live, authorize, request.expectedVersion)
      }
      const text = prepareRootWrite(documentId, null, request, new Date().toISOString(), this.config.maxDocumentBytes)
      return this.publishNewDocument(workspaceId, documentId, request.operationId, text,
        (text, version) => { prepare({ text, version }) }, live, authorize)
    })
  }

  private async publishCreatedPage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate, signal: AbortSignal,
    beforePublish?: (retry: boolean) => Promise<void>,
    hold?: KnowledgeImportPublicationHold | KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold,
    attempt?: GoalWriteAttempt,
  ): Promise<KnowledgeTruthReceipt> {
    const location = this.locations.get(workspaceId)
    const receipt = await this.trackOperation(signal, live => this.publishNewPage(workspaceId, documentId, request, live,
      () => { this.locations.assertCurrent(location) }, beforePublish, hold, attempt))
    await this.recordAccess({ projectId: workspaceId, documentId, kind: 'write' })
    this.scheduleHealthAfterWrite(location, receipt)
    return receipt
  }

  private async publishNewPage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, request: KnowledgePageCreate, signal: AbortSignal,
    authorize: () => void, beforePublish?: (retry: boolean) => Promise<void>,
    hold?: KnowledgeImportPublicationHold | KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold,
    goalAttempt?: GoalWriteAttempt,
    afterDirectoryCreation?: () => void,
  ): Promise<KnowledgeTruthReceipt> {
    authorize()
    const prepared = preparePageCreation(documentId, request, new Date().toISOString(), this.config.maxDocumentBytes, hold)
    return this.publishNewDocument(workspaceId, documentId, request.operationId, prepared.text,
      (text) => { requireCreationReceipt(documentId, text, request.operationId, prepared.digest) }, signal,
      authorize, 'knowledge', beforePublish, goalAttempt, afterDirectoryCreation)
  }

  private async publishNewDocument(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, operationId: KnowledgeUpdateId, text: string,
    requireReceipt: (text: string, version: string) => void, signal: AbortSignal, authorize: () => void,
    kind: 'knowledge' | 'health-report' = 'knowledge',
    beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
    afterDirectoryCreation?: () => void,
  ): Promise<KnowledgeTruthReceipt> {
    return this.locations.run(workspaceId, signal, async (location) => {
      return this.withBrainPublication(location, signal, async () => {
        const receipt = await this.publishLocatedDocument(location, documentId, operationId, text,
          requireReceipt, signal, authorize, kind, beforePublish, goalAttempt)
        if (kind === 'knowledge' && documentId.startsWith('pages/')) await this.refreshPageIndex(location, documentId, signal, authorize)
        return receipt
      }, true, afterDirectoryCreation)
    })
  }

  /** Serialize one Brain's cooperative writers across Host processes before page and index locks.
   * @param location - retained selected Brain; the writer lock lives inside this directory.
   * @param signal - cancellation checked after acquisition and before any publication.
   * @param operation - complete admission, file write and index refresh, without another Brain-wide acquisition.
   * @param createMissing - permit a missing default Brain for a new document only, with project-local directory creation coordination.
   * @param afterDirectoryCreation - owning automatic admission observation after this operation creates the absent default directory.
   * @returns the operation's result after releasing the Brain-wide lock.
   */
  private withBrainPublication<T>(location: KnowledgeLocation, signal: AbortSignal,
    operation: () => Promise<T>, createMissing = false, afterDirectoryCreation?: () => void): Promise<T> {
    if (this.ctx.fs.sandboxMode === 'read-only') throw new RemoteError('knowledge/update',
      'Brain is read-only; no writer lock or document can be created', { path: location.path, reason: 'read-only' })
    const authorize = (): void => { signal.throwIfAborted(); this.locations.assertCurrent(location) }
    const locked = async <Result>(filename: string, work: () => Promise<Result>): Promise<Result> => {
      try {
        return await withFileLock(filename, work, { waitMs: this.config.writeLockWaitMs })
      } catch (error) {
        if (error instanceof WriterLockTimeoutError) throw new RemoteError('knowledge/update',
          'Brain writer lock remained held; retry the same operation after its writer finishes',
          { path: error.lockPath, reason: 'busy' })
        throw error
      }
    }
    const acquire = async (): Promise<T> => {
      authorize()
      if (await this.files.base(location, signal) === undefined) throw new RemoteError('knowledge/document',
        'Brain does not exist or is unavailable; initialize or reselect it before writing',
        { path: location.path, reason: 'not-found' })
      return locked(join(location.path, '.dsh-brain-publication'), async () => {
        authorize()
        if (await this.files.base(location, signal) === undefined) throw new RemoteError('knowledge/update',
          'Brain directory changed while acquiring its writer lock', { path: location.path, reason: 'conflict' })
        return operation()
      })
    }
    return (async () => {
      if (!location.isDefault) return acquire()
      const bootstrap = join(location.projectPath, `.dsh-brain-bootstrap-${createHash('sha256')
        .update(location.path).digest('hex').slice(0, 16)}`)
      const bootstrapLock = `${bootstrap}.lock`
      const deadline = Date.now() + this.config.writeLockWaitMs
      for (;;) {
        authorize()
        const exists = await this.files.base(location, signal) !== undefined
        // Once the directory exists, its publication lock serializes every writer, including the bootstrap owner.
        // A leftover bootstrap lock must not strand a usable Brain after its creator exits.
        if (exists) return acquire()
        if (await inspectBrainPath(bootstrapLock) !== undefined) {
          if (Date.now() >= deadline) throw new RemoteError('knowledge/update',
            'Brain writer lock remained held; retry the same operation after its writer finishes',
            { path: bootstrapLock, reason: 'busy' })
          await delay(Math.min(20, Math.max(1, deadline - Date.now())), undefined, { signal })
          continue
        }
        if (!createMissing) return acquire()
        break
      }
      const mapped = this.ctx.fs.processPathFromHostPath(location.projectPath)
      const destination = this.ctx.fs.processPathFromHostPath(location.path)
      if (mapped === undefined || destination === undefined) throw new RemoteError('knowledge/document',
        'Project is unavailable in this filesystem', { path: location.projectPath, reason: 'unsafe-path' })
      const root = await this.ctx.fs.resolve(mapped, { signal })
      const target = await this.ctx.fs.resolve(destination, { signal })
      if (!this.ctx.fs.contains(root, target)) throw new RemoteError('knowledge/document',
        'Brain directory leaves its registered project', { path: location.path, reason: 'unsafe-path' })
      return locked(bootstrap, async () => {
        authorize()
        if (await this.files.base(location, signal) === undefined) {
          await ensureBrainDirectories(location.projectPath, location.directory.split('/'), signal, authorize)
          afterDirectoryCreation?.()
        }
        return acquire()
      })
    })()
  }

  private async publishLocatedDocument(
    location: KnowledgeLocation, documentId: KnowledgeDocumentId, operationId: KnowledgeUpdateId, text: string,
    requireReceipt: (text: string, version: string) => void, signal: AbortSignal, authorize: () => void,
    kind: 'knowledge' | 'health-report',
    beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
  ): Promise<KnowledgeTruthReceipt> {
    authorize()
    const { workspaceId, projectPath } = location
    const parent = location.isDefault ? projectPath : parse(location.path).root
    const mapped = this.ctx.fs.processPathFromHostPath(parent)
    if (mapped === undefined) throw new RemoteError('knowledge/document', 'project is unavailable in this filesystem', { path: documentId, reason: 'unsafe-path' })
    const root = await this.ctx.fs.resolve(mapped, { signal })
    if ((await this.ctx.fs.stat(root, signal))?.type !== 'directory') {
      throw new RemoteError('knowledge/document', 'registered project directory is absent', { path: documentId, reason: 'not-found' })
    }
    const relativePath = `${relative(parent, location.path).split('\\').join('/')}/${documentId}`
    const located = await this.files.locate(root, relativePath, signal)
    const retry = async (): Promise<KnowledgeTruthReceipt> => {
      const { target } = await this.documentTarget(workspaceId, documentId, signal, kind)
      const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
      const text = this.files.decodeText(documentId, content.bytes)
      const version = documentVersion(content.bytes, location)
      if (goalAttempt !== undefined) goalAttempt.observation.snapshot = {
        locationRevision: location.revision, targetKey: target.targetKey, version }
      if (kind === 'knowledge') parseKnowledgeDocument(documentId, text, version)
      try { requireReceipt(text, version) } catch (error) {
        throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
          workspaceId, documentId, goalAttempt.operation)
      }
      try { await beforePublish?.(true) } catch (error) {
        throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
          workspaceId, documentId, goalAttempt.operation, 'task-catalog')
      }
      authorize()
      this.locations.assertCurrent(location)
      signal.throwIfAborted()
      return { operationId, documentId, version, disposition: 'already-applied' }
    }
    if (located !== undefined) return retry()
    const target = await this.ctx.fs.resolve(relativePath, { cwd: this.ctx.fs.processPath(root), signal })
    if (!this.ctx.fs.contains(root, target)) throw new RemoteError('knowledge/document', 'knowledge creation leaves the project', { path: documentId, reason: 'unsafe-path' })
    const hostPath = this.ctx.fs.processPathFromHostPath(join(location.path, documentId))
    if (hostPath === undefined || (await this.ctx.fs.resolve(hostPath, { signal })).targetKey !== target.targetKey) {
      throw new RemoteError('knowledge/document', 'knowledge creation has no matching Host path', { path: documentId, reason: 'unsafe-path' })
    }
    if (goalAttempt !== undefined) goalAttempt.observation.snapshot = {
      locationRevision: location.revision, targetKey: target.targetKey, version: null }
    try { await beforePublish?.(false) } catch (error) {
      throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
        workspaceId, documentId, goalAttempt.operation, 'task-catalog')
    }
    signal.throwIfAborted()
    authorize()
    this.locations.assertCurrent(location)
    if (goalAttempt !== undefined) goalAttempt.observation.writeStarted = true
    try {
      await this.ctx.fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, knowledgeWritePolicy(this.ctx.fs, location.path))
    } catch (error) {
      signal.throwIfAborted()
      if (filesystemFailure(error)?.code === 'FS_NOT_OBSERVED') return retry()
      throw error
    }
    return { operationId, documentId, version: documentVersion(text, location), disposition: 'written' }
  }

  private async updatePage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, operationId: KnowledgeUpdateId,
    prepare: (text: string, version: string) => string | undefined | Promise<string | undefined>,
    signal: AbortSignal, authorize: () => void, expectedVersion: string,
    refreshIndex = false, beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
  ): Promise<KnowledgeTruthReceipt> {
    return { ...await this.modifyPage(workspaceId, documentId, prepare, signal, authorize, 'knowledge',
      expectedVersion, refreshIndex, undefined, beforePublish, goalAttempt), operationId }
  }

  private async modifyPage(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    prepare: (text: string, version: string) => string | undefined | Promise<string | undefined>,
    signal: AbortSignal, authorize: () => void, kind: 'knowledge' | 'health-report' = 'knowledge', expectedVersion?: string,
    refreshIndex = false,
    retainReport?: { reportId: KnowledgeHealthReportId; capturedAt: string },
    beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
  ): Promise<Omit<KnowledgeTruthReceipt, 'operationId'>> {
    return this.locations.run(workspaceId, signal, async (location) => {
      if (expectedVersion !== undefined && (expectedVersion.includes(':') ? expectedVersion.split(':')[0] : null) !== location.revision) {
        throw new RemoteError('knowledge/update', 'Brain location changed since this read; refresh before writing',
          { path: documentId, reason: 'conflict' })
      }
      return this.withBrainPublication(location, signal, async () => {
        const receipt = await this.modifyLocatedPage(location, documentId, prepare, signal, authorize,
          kind, retainReport, beforePublish, goalAttempt)
        if (refreshIndex) await this.refreshPageIndex(location, documentId, signal, authorize)
        return receipt
      })
    })
  }

  private async refreshPageIndex(location: KnowledgeLocation, documentId: KnowledgeDocumentId,
    signal: AbortSignal, authorize: () => void): Promise<void> {
    try { await this.reindexLocated(location, signal, authorize) } catch (error) {
      throw new RemoteError('knowledge/update', `Page ${documentId} is saved, but index.md was not refreshed: ${String(error)}. Retry the same original request to refresh the index without repeating the page change.`,
        { path: documentId, reason: 'conflict' })
    }
  }

  private async modifyLocatedPage(
    location: KnowledgeLocation, documentId: KnowledgeDocumentId,
    prepare: (text: string, version: string) => string | undefined | Promise<string | undefined>,
    signal: AbortSignal, authorize: () => void, kind: 'knowledge' | 'health-report',
    retainReport?: { reportId: KnowledgeHealthReportId; capturedAt: string },
    beforePublish?: (retry: boolean) => Promise<void>,
    goalAttempt?: GoalWriteAttempt,
  ): Promise<Omit<KnowledgeTruthReceipt, 'operationId'>> {
    const { workspaceId } = location
    authorize()
    const initial = await this.documentTarget(workspaceId, documentId, signal, kind)
    return withFileLock(initial.path, async () => {
      authorize()
      const { target } = await this.documentTarget(workspaceId, documentId, signal, kind)
      if (target.targetKey !== initial.target.targetKey) {
        throw new RemoteError('knowledge/update', 'knowledge target changed while awaiting its writer lock',
          { path: documentId, reason: 'conflict' })
      }
      const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
      const text = this.files.decodeText(documentId, content.bytes)
      const version = documentVersion(content.bytes, location)
      if (goalAttempt !== undefined) goalAttempt.observation.snapshot = {
        locationRevision: location.revision, targetKey: target.targetKey, version }
      let next: string | undefined
      try { next = await prepare(text, version) } catch (error) {
        throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
          workspaceId, documentId, goalAttempt.operation)
      }
      const receipt = { documentId, version }
      if (next !== undefined && retainReport !== undefined) {
        next = await this.retainHealthReport(location, retainReport.reportId, content.bytes, next, retainReport.capturedAt, signal)
      }
      try { await beforePublish?.(next === undefined) } catch (error) {
        throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
          workspaceId, documentId, goalAttempt.operation, 'task-catalog')
      }
      signal.throwIfAborted()
      authorize()
      const current = await this.documentTarget(workspaceId, documentId, signal, kind)
      if (current.target.targetKey !== target.targetKey) {
        const error = new RemoteError('knowledge/update', 'knowledge target changed during update preparation',
          { path: documentId, reason: 'conflict' })
        throw goalAttempt === undefined ? error : goalPrewriteRefusal(error, goalAttempt.observation,
          workspaceId, documentId, goalAttempt.operation)
      }
      authorize()
      this.locations.assertCurrent(location)
      if (next === undefined) return { ...receipt, disposition: 'already-applied' }
      if (goalAttempt !== undefined) goalAttempt.observation.writeStarted = true
      try {
        await this.ctx.fs.writeText(target, next, { kind: 'replaceIfVersion', version: content.version }, signal,
          knowledgeWritePolicy(this.ctx.fs, location.path))
        return { ...receipt, version: documentVersion(next, location), disposition: 'written' }
      } catch (error) {
        signal.throwIfAborted()
        const failure = filesystemFailure(error)
        if (failure?.code === 'FS_STALE_VERSION') {
          throw new RemoteError('knowledge/update', 'knowledge changed before publication; read it again',
            { path: documentId, reason: 'conflict' })
        }
        throw error
      }
    }, { waitMs: this.config.writeLockWaitMs })
  }

  /**
   * Read a bounded project index; absent roots are omitted and invalid files are reported.
   * @param workspaceId - registered project identity, independent of any Session.
   * @param signal - cancels filesystem work.
   * @returns authored catalog count, current searchable knowledge, bounded activity and unapproved review summaries.
   */
  @Remote
  async index(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgeIndex> {
    const activity = new KnowledgeActivityCollector(this.config.maxActivityEntries, this.config.maxActivityBytes)
    const pending = new KnowledgePendingProposalCollector(this.config.maxPendingProposalEntries, this.config.maxPendingProposalBytes)
    const entries: KnowledgeEntry[] = []
    let pageCount = 0
    const location = this.locations.get(workspaceId)
    const scan = await this.files.scan(location, ['index.md', ...ROOT_DOCUMENTS, 'pages'], signal, (document, source) => {
      entries.push(document.entry)
      activity.add(document)
      pending.add(document, source)
    }, undefined, (source) => { pageCount = [...source.matchAll(/^\s*- \[[^\]]+\]\(/gm)].length })
    return { workspaceId, directory: location.directory, locationRevision: location.revision, ...scan, entries,
      pageCount: scan.issues.some(issue => issue.path === 'index.md') ? null : pageCount, activity: activity.result(),
      calls: this.accessStore.snapshot(workspaceId), pendingProposals: pending.result(!scan.truncated && scan.issues.length === 0) }
  }

  /** Read complete Brain documents in bounded Host-only batches against one catalog identity.
   * @param project - registered project and its original absolute path; navigation cannot retarget a continuation.
   * @param request - zero-based offset, exact catalog digest for continuations, and complete-response limits.
   * @param signal - cancellation of both index checks and all document reads.
   * @returns full bodies and Timelines without file paths, writes, a Session or a model request.
   * @throws if the project, Brain location, catalog or a read document changes; incomplete scans and undersized
   * response budgets reject instead of returning a partial document or a nonterminal empty batch.
   */
  async captureDiscoveryPageBatch(project: { readonly id: WorkspaceId; readonly path: string },
    request: KnowledgeDiscoveryPageBatchRequest, signal: AbortSignal): Promise<KnowledgeDiscoveryPageBatch> {
    const reject = (reason: 'invalid-request' | 'project-changed' | 'index-incomplete'
      | 'catalog-changed' | 'input-limit'): never => {
      throw new RemoteError('knowledge/discovery-batch', `Brain discovery batch ${reason}`, { reason })
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0
      || !Number.isSafeInteger(request.maxPages) || request.maxPages < 1
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1
      || request.offset > 0 && request.expectedCatalogSha256 === undefined) reject('invalid-request')
    const projectCurrent = (): void => {
      const current = this.ctx.workspaceRegistry.get(project.id)
      if (current?.path !== project.path || current.archivedAt !== undefined) reject('project-changed')
    }
    const catalogIdentity = (index: KnowledgeIndex): string => createHash('sha256').update(JSON.stringify({
      locationRevision: index.locationRevision, exists: index.exists, pageCount: index.pageCount,
      entries: index.entries,
    })).digest('hex')
    signal.throwIfAborted()
    projectCurrent()
    const index = await this.index(project.id, signal)
    if (index.truncated || index.issues.length > 0) reject('index-incomplete')
    const catalogSha256 = catalogIdentity(index)
    if (request.expectedCatalogSha256 !== undefined && request.expectedCatalogSha256 !== catalogSha256) {
      reject('catalog-changed')
    }
    if (request.offset > index.entries.length
      || request.offset === index.entries.length && index.entries.length > 0) reject('invalid-request')
    const pages: KnowledgeDiscoveryPageBatch['pages'][number][] = []
    const response = (nextOffset: number | null): KnowledgeDiscoveryPageBatch => ({
      catalogSha256, locationRevision: index.locationRevision, offset: request.offset,
      totalPages: index.entries.length, pages, nextOffset,
    })
    if (Buffer.byteLength(JSON.stringify(response(index.entries.length === 0 ? null : request.offset)), 'utf8')
      > request.maxBytes) reject('input-limit')
    for (let position = request.offset;
      position < index.entries.length && pages.length < request.maxPages; position++) {
      signal.throwIfAborted()
      const entry = index.entries[position] ?? reject('catalog-changed')
      const document = await this.read(project.id, entry.id, signal)
      if (JSON.stringify(document.entry) !== JSON.stringify(entry)) reject('catalog-changed')
      const page: KnowledgeDiscoveryPageBatch['pages'][number] = {
        path: entry.id, version: entry.version, title: entry.title, status: entry.status,
        body: document.body,
        timeline: document.timeline.map(item => ({ time: item.time, kind: item.kind,
          summary: item.summary, source: item.source, affects: item.affects, evidence: item.evidence,
          ...(item.author === undefined ? {} : { author: item.author }) })),
      }
      pages.push(page)
      const nextOffset = position + 1 === index.entries.length ? null : position + 1
      if (Buffer.byteLength(JSON.stringify(response(nextOffset)), 'utf8') > request.maxBytes) {
        pages.pop()
        if (pages.length === 0) reject('input-limit')
        break
      }
    }
    if (index.entries.length > 0 && pages.length === 0) reject('input-limit')
    const nextPosition = request.offset + pages.length
    const result = response(nextPosition === index.entries.length ? null : nextPosition)
    projectCurrent()
    const fresh = await this.index(project.id, signal)
    if (fresh.truncated || fresh.issues.length > 0 || catalogIdentity(fresh) !== catalogSha256) {
      reject('catalog-changed')
    }
    signal.throwIfAborted()
    projectCurrent()
    return result
  }

  /** Resolve the configured automatic-maintenance policy without granting a write.
   * @returns deployment-owned admission and complete review limits.
   */
  automaticMaintenancePolicy(): KnowledgeAutomaticMaintenancePolicy { return { ...this.config.automaticMaintenance } }

  /** Determine whether a live writable conversation has independently reviewed automatic page maintenance.
   * @param sessionId - actual executing conversation; retained imports keep their separate admission.
    * @returns true for an enabled ordinary conversation or successful selected-page Task source turn with frozen automatic
    * permission; never for imports, Task workers, active approved Goals or missing Agents.
   */
  automaticConversationEnabled(sessionId: SessionId): boolean {
    const session = this.ctx.get('agents')?.get(sessionId)?.session
    if (!this.config.automaticMaintenance.enabled || session === undefined || this.isKnowledgeImportSession(session)
      || !knowledgeSessionWritable(this.ctx, session) || hasTaskInput(session)) return false
    const tasks = this.ctx.get('taskController')
    const parent = session.header.parentSession === undefined ? undefined : this.ctx.get('agents')?.get(session.header.parentSession)?.session
    if (tasks?.projectForSession(sessionId) !== undefined || parent !== undefined && hasTaskInput(parent)) return false
    const owner = this.ctx.workspaceRegistry.list().find(project => project.sessionIds.includes(sessionId))
    if ((tasks === undefined || owner === undefined) && hasGoalApproval(session)) return false
    const goal = owner === undefined ? undefined : tasks?.currentGoal(owner.id, sessionId)
    if (goal?.review?.input.decision === 'approve' && goal.phase !== 'EXITED') return false
    const completion = activeTaskCompletions(session)
    if (completion === undefined) return true
    return this.ctx.workspaceRegistry.list().some(project => automaticTaskCompletion(
      taskCompletionCards(tasks?.listCards(project.id, sessionId) ?? [], completion), completion))
  }

  /** Capture the complete original-project catalog for an independent AI maintenance review.
   * @param workspaceId - registered project whose selected Brain remains fixed during capture.
   * @param signal - cancellation through all full document reads.
   * @returns the same catalog identity and full bodies used by Task discovery; partial batches reject.
   * @throws for incomplete scans, changed locations, unregistered projects or configured byte limits.
   */
  async automaticMaintenanceCatalog(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgeDiscoveryPageBatch> {
    const current = this.ctx.workspaceRegistry.get(workspaceId)
    if (current === undefined || current.archivedAt !== undefined) throw new Error('Automatic knowledge maintenance requires an active registered project')
    const catalog = await this.captureDiscoveryPageBatch({ id: workspaceId, path: current.path }, {
      offset: 0, maxPages: this.config.maxEntries, maxBytes: this.config.automaticMaintenance.maxReviewBytes,
    }, signal)
    if (catalog.nextOffset !== null) throw new RemoteError('knowledge/document',
      'Complete automatic knowledge catalog exceeds maxReviewBytes; no partial review can authorize publication',
      { path: 'pages', reason: 'too-large' })
    return catalog
  }

  /** Apply one independently reviewed AI intent without creating a human decision or widening its project scope.
   * @param workspaceId - original project frozen by the conversation, Task, Goal or import owner.
   * @param input - immutable automatic permission, complete sources, catalog relations and change.
   * @param signal - cancellation before atomic admission; uncertain results retain the same UUID and input.
   * @param beforePublish - owning consumer's durable permission, source/result and AI-review recheck under writer locks;
   * true means the exact file receipt already exists and no new page update is admitted.
   * @returns an exact durable file receipt, or a retained pre-write deferral with no active knowledge change.
   * @throws for changed operation identities, permission failures, unavailable files or uncertain write/retention results.
   */
  async maintainAutomatically(workspaceId: WorkspaceId, input: KnowledgeAutomaticMaintenanceRequest,
    signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>): Promise<KnowledgeAutomaticMaintenanceResult> {
    const request = validateAutomaticMaintenanceRequest(input, this.config.automaticMaintenance.maxRecordBytes)
    return this.trackOperation(signal, async (live) => {
      if (!this.config.automaticMaintenance.enabled) return { status: 'deferred', reason: 'disabled' }
      const location = this.locations.get(workspaceId)
      const project = this.ctx.workspaceRegistry.get(workspaceId)
      if (project === undefined || project.archivedAt !== undefined || project.path !== location.projectPath) {
        throw new Error('AI maintenance requires its original active project')
      }
      const prior = this.automaticMaintenanceStore.get(workspaceId, project.path, request)
      if (prior?.result?.status === 'deferred') return prior.result
      const retained = prior ?? await this.automaticMaintenanceStore.retain({ workspaceId, projectPath: project.path,
        brainDirectory: location.directory, locationRevision: location.revision, request,
        requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), result: null })
      const authorize = (): void => {
        live.throwIfAborted()
        this.locations.assertCurrent(location)
        const current = this.ctx.workspaceRegistry.get(workspaceId)
        if (current?.path !== retained.projectPath || current.archivedAt !== undefined
          || location.directory !== retained.brainDirectory || location.revision !== retained.locationRevision) {
          throw new Error('AI maintenance project or Brain location changed')
        }
      }
      authorize()
      if (request.change.kind === 'merge') {
        return this.maintainAutomaticMerge(retained, live, authorize, beforePublish)
      }
      const inspection = await this.inspectAutomaticMaintenance(workspaceId, request, live)
      if (inspection.status === 'unknown') throw new Error('AI maintenance receipt is uncertain; inspect the original operation before retrying')
      if (inspection.status === 'deferred') return inspection
      if (inspection.status !== 'applied') {
        const catalog = await this.automaticMaintenanceCatalog(workspaceId, live)
        const failure = automaticMaintenanceEvidenceFailure(request, catalog)
        if (failure !== null) return this.automaticMaintenanceStore.settle(retained, { status: 'deferred', reason: failure })
        await this.requireAutomaticSearches(workspaceId, request, catalog, live)
        if (request.authority.kind === 'conversation') {
          try {
            const consistency = await reviewAutomaticConsistency(this.ctx, project.path, {
              projectId: workspaceId, operationId: request.operationId, candidateSha256: request.candidateSha256,
              catalog, sources: request.sources, candidate: request.change,
            }, this.config.automaticMaintenance, live)
            authorize()
            if (consistency.decision !== 'consistent') {
              return await this.automaticMaintenanceStore.settle(retained, { status: 'deferred', reason: 'conflict',
                review: { reviewerSessionId: consistency.reviewerSessionId, resultSha256: consistency.resultSha256,
                  ...consistency.reason === undefined ? {} : { reason: consistency.reason } } })
            }
          } catch (error) {
            // No publication follows an incomplete independent assessment; cancellation retains its original cause.
            if (live.aborted) throw error
            authorize()
            return this.automaticMaintenanceStore.settle(retained, { status: 'deferred', reason: 'source-incomplete' })
          }
        }
      }
      let createdDefaultDirectory = false
      const guarded = async (retry: boolean): Promise<void> => {
        authorize()
        await beforePublish(retry)
        if (!retry) {
          const fresh = await this.automaticMaintenanceCatalog(workspaceId, live)
          const selfCreatedEmpty = createdDefaultDirectory && request.change.kind === 'create'
            && request.comparedPages.length === 0 && fresh.pages.length === 0
            && await this.matchesAbsentAutomaticCatalog(workspaceId, request, live)
          const changed = automaticMaintenanceEvidenceFailure(request,
            selfCreatedEmpty ? { ...fresh, catalogSha256: request.catalogSha256 } : fresh)
          if (changed !== null) throw new RemoteError('knowledge/update',
            `AI maintenance evidence ${changed}; retain the current knowledge and re-review the changed evidence`,
            { path: request.change.documentId, reason: 'conflict' })
          await this.requireAutomaticSearches(workspaceId, request, fresh, live)
        }
        authorize()
      }
      const source = automaticMaintenanceSource(request)
      const common = { operationId: request.operationId, truth: request.change.truth,
        kind: request.change.kind === 'update' && request.change.entryKind !== undefined ? request.change.entryKind : 'evidence' as const,
        summary: request.change.summary, evidence: request.change.evidence, source }
      const receipt = request.change.kind === 'create'
        ? await this.publishNewPage(workspaceId, request.change.documentId,
          { ...common, title: request.change.title, category: request.change.category, tags: [...request.change.tags], status: 'active' },
          live, authorize, guarded, undefined, undefined, () => { createdDefaultDirectory = true })
        : await this.updatePage(workspaceId, request.change.documentId, request.operationId,
          (text, version) => prepareTruthUpdate(request.change.documentId, text, version,
            { ...common, expectedVersion: request.change.kind === 'update' ? request.change.expectedVersion : version },
            new Date().toISOString(), this.config.maxDocumentBytes),
          live, authorize, request.change.expectedVersion, true, guarded)
      const outcome = await this.automaticMaintenanceStore.settle(retained, { status: 'applied', receipt })
      await this.recordAccess({ projectId: workspaceId, documentId: request.change.documentId, kind: 'write' })
      this.scheduleHealthAfterWrite(location, receipt)
      return outcome
    })
  }

  private automaticMergeRequest(request: KnowledgeAutomaticMaintenanceRequest): KnowledgePageMergeRequest {
    if (request.change.kind !== 'merge') throw new Error('AI consolidation requires its exact retained merge input')
    const change = request.change
    return { operationId: request.operationId,
      target: { documentId: change.documentId, expectedVersion: change.expectedVersion },
      source: { documentId: change.sourceDocumentId, expectedVersion: change.sourceExpectedVersion },
      truth: change.truth, summary: change.summary, evidence: change.evidence, note: change.reason }
  }

  private automaticMergeRecord(workspaceId: WorkspaceId, request: KnowledgeAutomaticMaintenanceRequest): PageMergeRecord | null {
    try {
      const record = this.mergeStore.get(workspaceId, request.operationId)
      if (JSON.stringify(record.request) !== JSON.stringify(this.automaticMergeRequest(request))
        || request.authority.kind !== 'conversation' || record.initiator?.sessionId !== request.authority.sourceSessionId
        || record.initiator.source !== automaticMaintenanceSource(request)) throw new Error('AI consolidation journal belongs to different input or authority')
      return record
    } catch (error) {
      const remote = remoteErrorOf(error)
      if (remote?.code === 'knowledge/merge' && remote.details.reason === 'not-found') return null
      throw error
    }
  }

  private async maintainAutomaticMerge(retained: KnowledgeAutomaticMaintenanceRecord, signal: AbortSignal,
    projectAuthority: () => void, beforePublish: (retry: boolean) => Promise<void>): Promise<KnowledgeAutomaticMaintenanceResult> {
    const { request, workspaceId } = retained
    if (request.authority.kind !== 'conversation' || request.change.kind !== 'merge') throw new Error('AI consolidation is owned only by its ordinary conversation')
    const sessionId = request.authority.sourceSessionId
    const { project, session, authorize: membership } = this.workspaceSessionWriter(sessionId, workspaceId)
    const execution = currentBrainModelWrite(this.ctx.root, sessionId)
    if (execution?.name !== 'brain_merge_pages') throw new Error('Automatic consolidation requires the actual executing merge tool')
    const mergeRequest = this.automaticMergeRequest(request)
    const initiator: PageMergeInitiator = { sessionId, source: automaticMaintenanceSource(request) }
    const authorize = (): void => {
      projectAuthority()
      membership()
      if (project.id !== workspaceId || currentBrainModelWrite(this.ctx.root, sessionId) !== execution
        || requireUserEvidenceSource(session, mergeRequest.evidence) !== initiator.source) throw new Error('AI consolidation scope, tool or source changed')
      requireInformedBrainRead(session, project.path, mergeRequest.target.documentId, mergeRequest.target.expectedVersion)
      requireInformedBrainRead(session, project.path, mergeRequest.source.documentId, mergeRequest.source.expectedVersion)
    }
    authorize()
    return this.locations.run(workspaceId, signal, current => this.withBrainPublication(current, signal, async () => {
      authorize()
      const prior = this.automaticMergeRecord(workspaceId, request)
      const readonly = this.mergeOperations(current, signal, false, { initiator, authorize })
      const observation = prior === null ? null : await this.mergeStore.review(prior, readonly, signal)
      const receiptBacked = observation !== null && observation.blockedReason === null && observation.abandonment === null
        && (observation.stage === 'target-written' || observation.stage === 'source-archived' || observation.stage === 'complete')
      await beforePublish(receiptBacked)
      if (prior === null) {
        if (retained.result?.status === 'applied') throw new Error('The applied consolidation journal is unavailable; its result remains unknown')
        const catalog = await this.automaticMaintenanceCatalog(workspaceId, signal)
        const failure = automaticMaintenanceEvidenceFailure(request, catalog)
        if (failure !== null) return this.automaticMaintenanceStore.settle(retained, { status: 'deferred', reason: failure })
        await this.requireAutomaticSearches(workspaceId, request, catalog, signal)
      }
      const guarded = async (): Promise<void> => {
        authorize()
        const record = this.automaticMergeRecord(workspaceId, request)
        if (record === null) throw new Error('AI consolidation journal disappeared before publication')
        const review = await this.mergeStore.review(record, readonly, signal)
        if (review.stage === null || review.blockedReason !== null || review.abandonment !== null) {
          throw new Error('AI consolidation receipts or current pages changed; no further publication was admitted')
        }
        await beforePublish(review.stage !== 'prepared')
        const catalog = await this.automaticMaintenanceCatalog(workspaceId, signal)
        if (catalog.locationRevision !== request.locationRevision || catalog.pages.length !== request.comparedPages.length
          || catalog.pages.some((page, index) => {
            const original = request.comparedPages[index]
            return original?.path !== page.path || page.path !== mergeRequest.target.documentId
              && page.path !== mergeRequest.source.documentId && original.version !== page.version
          })) throw new Error('AI consolidation catalog changed outside its two receipt-verified pages')
        if (review.stage === 'prepared') {
          const failure = automaticMaintenanceEvidenceFailure(request, catalog)
          if (failure !== null) throw new Error(`AI consolidation evidence ${failure}; current knowledge was retained`)
          await this.requireAutomaticSearches(workspaceId, request, catalog, signal)
        }
        authorize()
      }
      const operations = this.mergeOperations(current, signal, true, { initiator, authorize, beforePublish: guarded })
      const record = await this.mergeStore.prepare(mergeRequest, operations, signal)
      const initial = await this.mergeStore.review(record, readonly, signal)
      for (const selected of [mergeRequest.target, mergeRequest.source]) {
        const page = await operations.read(selected.documentId)
        requireInformedBrainRead(session, project.path, selected.documentId, page.version)
      }
      const review = await this.mergeStore.continue(record, operations, signal)
      if (review.stage !== 'complete' || review.blockedReason !== null || review.abandonment !== null) {
        throw new AutomaticMergeIncompleteError(review)
      }
      const target = await operations.read(mergeRequest.target.documentId)
      return this.automaticMaintenanceStore.settle(retained, { status: 'applied', receipt: {
        documentId: mergeRequest.target.documentId, version: target.version,
        operationId: record.targetOperationId, disposition: initial.stage === 'complete' ? 'already-applied' : 'written' } })
    }))
  }

  private async matchesAbsentAutomaticCatalog(workspaceId: WorkspaceId, request: KnowledgeAutomaticMaintenanceRequest,
    signal: AbortSignal): Promise<boolean> {
    const index = await this.index(workspaceId, signal)
    return index.exists && !index.truncated && index.issues.length === 0 && index.entries.length === 0
      && index.locationRevision === request.locationRevision
      && createHash('sha256').update(JSON.stringify({ locationRevision: index.locationRevision,
        exists: false, pageCount: index.pageCount, entries: index.entries })).digest('hex') === request.catalogSha256
  }

  private async requireAutomaticSearches(workspaceId: WorkspaceId, request: KnowledgeAutomaticMaintenanceRequest,
    catalog: KnowledgeDiscoveryPageBatch, signal: AbortSignal): Promise<void> {
    for (const retained of [request.titleSearch, ...(request.topicSearch === undefined ? [] : [request.topicSearch])]) {
      const current = await this.search(workspaceId, { query: retained.query, statuses: ['active', 'draft', 'archived'],
        maxResults: Math.max(1, catalog.totalPages), maxMatches: 1 }, signal)
      if (current.truncated || current.issues.length > 0 || JSON.stringify(current.hits.map(hit =>
        ({ path: hit.path, version: hit.version }))) !== JSON.stringify(retained.hits)) throw new RemoteError('knowledge/update',
        'AI maintenance searches changed or were incomplete; no publication was admitted',
        { path: request.change.documentId, reason: 'conflict' })
    }
  }

  /** Inspect only the retained exact AI operation; unknown does not authorize replay or another UUID.
   * @param workspaceId - original registered project, not the current navigation selection.
   * @param input - every original input, including the frozen automatic permission.
   * @param signal - cancellation of the bounded file read.
   * @returns exact file-derived receipt, proven absence, a retained deferral, or unknown for inaccessible/conflicting state.
   */
  async inspectAutomaticMaintenance(workspaceId: WorkspaceId, input: KnowledgeAutomaticMaintenanceRequest,
    signal: AbortSignal): Promise<KnowledgeAutomaticMaintenanceInspection> {
    const request = validateAutomaticMaintenanceRequest(input, this.config.automaticMaintenance.maxRecordBytes)
    const location = this.locations.get(workspaceId)
    const saved = this.automaticMaintenanceStore.get(workspaceId, location.projectPath, request)
    if (saved === null) return { status: 'absent' }
    if (saved.result?.status === 'deferred') return saved.result
    if (saved.locationRevision !== location.revision || saved.brainDirectory !== location.directory) return { status: 'unknown' }
    try {
      if (request.change.kind === 'merge') {
        if (request.authority.kind !== 'conversation') return { status: 'unknown' }
        const record = this.automaticMergeRecord(workspaceId, request)
        if (record === null) {
          if (saved.result?.status === 'applied') return { status: 'unknown' }
          for (const selected of [this.automaticMergeRequest(request).target, this.automaticMergeRequest(request).source]) {
            const { target } = await this.documentTarget(workspaceId, selected.documentId, signal)
            const current = await this.files.readLocated(selected.documentId, target, this.config.maxDocumentBytes, signal)
            if (documentVersion(current.bytes, location) !== selected.expectedVersion) return { status: 'unknown' }
          }
          this.locations.assertCurrent(location)
          return { status: 'absent' }
        }
        const review = await this.mergeStore.review(record, this.mergeOperations(location, signal, false,
          { initiator: { sessionId: request.authority.sourceSessionId, source: automaticMaintenanceSource(request) },
            authorize: () => { this.locations.assertCurrent(location) } }), signal)
        if (review.stage !== 'complete' || review.blockedReason !== null || review.abandonment !== null
          || review.current.target.status !== 'available') return { status: 'unknown' }
        return { status: 'applied', receipt: { documentId: request.change.documentId,
          version: review.current.target.document.entry.version, operationId: record.targetOperationId, disposition: 'already-applied' } }
      }
      const { target } = await this.documentTarget(workspaceId, request.change.documentId, signal)
      const content = await this.files.readLocated(request.change.documentId, target, this.config.maxDocumentBytes, signal)
      this.locations.assertCurrent(location)
      signal.throwIfAborted()
      const text = this.files.decodeText(request.change.documentId, content.bytes)
      const version = documentVersion(content.bytes, location)
      const source = automaticMaintenanceSource(request)
      const common = { operationId: request.operationId, truth: request.change.truth,
        kind: request.change.kind === 'update' && request.change.entryKind !== undefined ? request.change.entryKind : 'evidence' as const,
        summary: request.change.summary, evidence: request.change.evidence, source }
      if (request.change.kind === 'create') {
        const prepared = preparePageCreation(request.change.documentId, { ...common, status: 'active',
          title: request.change.title, category: request.change.category, tags: [...request.change.tags] },
        new Date().toISOString(), this.config.maxDocumentBytes)
        requireCreationReceipt(request.change.documentId, text, request.operationId, prepared.digest)
      } else if (!hasTruthUpdateReceipt(request.change.documentId, text, version,
        { ...common, expectedVersion: request.change.expectedVersion }, this.config.maxDocumentBytes)) {
        return saved.result?.status === 'applied' ? { status: 'unknown' } : { status: 'absent' }
      }
      return { status: 'applied', receipt: { documentId: request.change.documentId, version,
        operationId: request.operationId, disposition: 'already-applied' } }
    } catch (error) {
      signal.throwIfAborted()
      const remote = remoteErrorOf(error)
      if (remote?.code === 'knowledge/document' && remote.details.reason === 'not-found' && saved.result?.status !== 'applied') {
        return { status: 'absent' }
      }
      return { status: 'unknown' }
    }
  }

  /** Rebuild the portable index from a complete validated page scan, without editing pages or access counts.
   * @param workspaceId - registered project owning the selected Brain.
   * @param signal - cancels before publication admission; an admitted native write may finish.
   * @returns the derived index path, total page count and committed version.
   * @throws without replacing the index for missing/unsafe Brains, incomplete reads or observed concurrent changes.
   * @remarks Malformed pages retain their paths as parse-warning rows.
   */
  @Remote
  async reindex(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgeReindexResult> {
    return this.withLocation(workspaceId, signal, (location, live) =>
      this.withBrainPublication(location, live, () => this.reindexLocated(location, live, () => {})))
  }

  /** Rebuild one ordinary conversation's selected workspace-project index without granting code-write permission.
   * @param sessionId - live ordinary conversation; execution Tasks and approved Goals are refused.
   * @param signal - cancellation before publication admission.
   * @param targetProject - project id or unique name; an ambiguous workspace requires a target.
   * @returns the portable-index receipt; no page Timeline or model-assisted health job is created.
   * @throws when live membership or the informed Brain selection changes before admission.
   */
  async reindexSession(sessionId: SessionId, signal: AbortSignal, targetProject?: string): Promise<KnowledgeReindexResult> {
    const { project, authorize } = this.workspaceSessionWriter(sessionId, targetProject)
    return this.withLocation(project.id, signal, (location, live) =>
      this.withBrainPublication(location, live, () => this.reindexLocated(location, live, authorize)))
  }

  private async reindexLocated(location: KnowledgeLocation, signal: AbortSignal,
    authorize: () => void): Promise<KnowledgeReindexResult> {
    const id = 'index.md' as KnowledgeDocumentId
    const fail = (message: string): never => { throw new RemoteError('knowledge/update', message, { path: id, reason: 'conflict' }) }
    const resolve = async () => {
      signal.throwIfAborted()
      authorize()
      this.locations.assertCurrent(location)
      const base = await this.files.base(location, signal)
      if (base === undefined) return fail('Brain does not exist; initialize it before rebuilding the index')
      const located = await this.files.locate(base, id, signal)
      if (located !== undefined && located.kind !== 'file') return fail('Brain index is not a regular file')
      const target = located?.target ?? await this.ctx.fs.resolve(id, { cwd: this.ctx.fs.processPath(base), signal })
      const host = this.ctx.fs.processPathFromHostPath(join(location.path, id))
      if (host === undefined || (await this.ctx.fs.resolve(host, { signal })).targetKey !== target.targetKey) {
        return fail('Brain index has no matching Host path')
      }
      return { target, exists: located !== undefined }
    }
    const initial = await resolve()
    return withFileLock(join(location.path, id), async () => {
      const current = await resolve()
      if (current.target.targetKey !== initial.target.targetKey) return fail('Brain index target changed while awaiting its writer lock')
      const prior = current.exists ? await this.files.readLocated(id, current.target, this.config.maxIndexBytes, signal) : undefined
      const capture = async () => {
        const pages: Array<{ id: KnowledgeDocumentId; version: string; document: KnowledgeDocument | null; truth: string }> = []
        const scan = await this.files.scan(location, ['pages'], signal, (document, source) => {
          pages.push({ id: document.entry.id, version: document.entry.version, document, truth: knowledgeSource(source, true).truth })
        }, (id, version) => {
          pages.push({ id, version, document: null, truth: '' })
        })
        if (!scan.exists || scan.truncated || scan.issues.length > 0) {
          return fail(`Cannot rebuild an incomplete Brain index; check scan limits and page files${scan.issues[0] === undefined
            ? '' : `: ${scan.issues[0].path}: ${scan.issues[0].message}`}`)
        }
        return pages
      }
      const pages = await capture()
      const text = renderBrainIndex(pages, new Date(this.now()).toISOString())
      if (Buffer.byteLength(text) > this.config.maxIndexBytes) return fail('Generated Brain index exceeds maxIndexBytes')
      const fingerprint = (entries: typeof pages) => JSON.stringify(entries.map(page =>
        [page.id, page.version] as const).sort((a, b) => a[0] < b[0] ? -1 : 1))
      if (fingerprint(pages) !== fingerprint(await capture())) return fail('Brain pages changed while rebuilding the index; retry')
      const final = await resolve()
      if (final.target.targetKey !== current.target.targetKey) return fail('Brain index target changed before publication')
      signal.throwIfAborted()
      authorize()
      this.locations.assertCurrent(location)
      await this.ctx.fs.writeText(current.target, text, prior === undefined
        ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: prior.version }, signal,
      knowledgeWritePolicy(this.ctx.fs, location.path))
      return { path: 'index.md', count: pages.length, version: documentVersion(text, location) }
    }, { waitMs: this.config.writeLockWaitMs })
  }

  /** Search validated page and fixed-root source without creating a Session, writing files or accounting for access.
   * @param workspaceId - registered project; health reports and unrelated files are excluded.
   * @param request - resolved query, lifecycle scope and positive limits supplied by the Consumer.
   * @param signal - cancels the shared bounded scan.
   * @returns lexically ordered document paths, source snippets, per-file failures and explicit scan/result truncation.
   * @throws when the Brain directory is unsafe, registration changes or the scan is cancelled.
   */
  async search(workspaceId: WorkspaceId, request: KnowledgeSearchRequest, signal: AbortSignal): Promise<KnowledgeSearchResult> {
    const matches = collectKnowledgeMatches(request)
    const scan = await this.files.scan(this.locations.get(workspaceId), [...ROOT_DOCUMENTS, 'pages'], signal, (document, source) => { matches.add(source, document.entry) })
    return { ...scan, hits: matches.hits, truncated: scan.truncated || matches.omitted() }
  }

  /**
   * Read one recognized knowledge file, refusing symlinks, traversal and oversized content.
   * @param workspaceId - registered project identity.
   * @param documentId - Brain-relative Markdown path.
   * @param signal - cancels filesystem work.
   * @returns complete metadata, Markdown, timeline and Host file actions, without a model request.
   */
  @Remote
  async read(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<KnowledgeFileDocument> {
    const { target, path, location } = await this.documentTarget(workspaceId, documentId, signal)
    const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
    this.locations.assertCurrent(location)
    const document = parseKnowledgeDocument(documentId, this.files.decodeText(documentId, content.bytes),
      documentVersion(content.bytes, location))
    return { ...document, file: { path, canReveal: this.canRevealPath() } }
  }

  /** List health reports newest first without adding them to ordinary knowledge or creating a Session.
   * @param workspaceId - registered project owning the reports directory.
   * @param signal - cancels filesystem reads.
   * @returns bounded reports and per-file failures; truncation means the listing is incomplete.
   * @throws when the directory is unsafe or the complete result exceeds maxIndexBytes.
   */
  @Remote
  async healthReports(workspaceId: WorkspaceId, signal: AbortSignal): Promise<KnowledgeHealthReports> {
    const location = this.locations.get(workspaceId)
    const base = await this.files.base(location, signal)
    const directory = base === undefined ? undefined : await this.files.locate(base, 'reports', signal)
    if (directory !== undefined && directory.kind !== 'directory') {
      throw new RemoteError('knowledge/document', 'health reports path is not a directory', { path: 'reports', reason: 'invalid' })
    }
    const reports: KnowledgeHealthFileReport[] = [], issues: KnowledgeIssue[] = []
    let truncated = false, remaining = this.config.maxIndexBytes, examined = 0
    const entries = directory === undefined ? [] : await this.ctx.fs.listDir(directory.target, signal)
    for (const entry of [...entries].sort((a, b) => b.name.localeCompare(a.name))) {
      if (!entry.name.startsWith('brain-health-') || !entry.name.endsWith('.md')) continue
      if (examined >= this.config.maxEntries || remaining <= 0) { truncated = true; break }
      examined++
      const id = entry.name.slice(0, -3) as KnowledgeHealthReportId
      try {
        const path = healthReportPath(id)
        const { target, path: hostPath } = await this.documentTarget(workspaceId, path, signal, 'health-report')
        const limit = Math.min(remaining, this.config.maxDocumentBytes)
        remaining -= limit
        const content = await this.files.readLocated(path, target, limit, signal)
        remaining += limit - content.bytes.byteLength
        reports.push({ ...parseHealthReport(id, this.files.decodeText(path, content.bytes), documentVersion(content.bytes, location)),
          file: { path: hostPath, canReveal: this.canRevealPath() } })
      } catch (error) {
        signal.throwIfAborted()
        const failure = remoteErrorOf(error) ?? filesystemFailure(error)
        if (failure === undefined) throw error
        issues.push({ path: `reports/${entry.name}`, message: failure.message })
      }
    }
    signal.throwIfAborted()
    this.locations.assertCurrent(location)
    reports.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || b.id.localeCompare(a.id))
    const saved = this.healthCheckStore.read(location)
    const previous = reports[0]
    const lastCheck = saved.status !== 'unchecked' || previous === undefined ? saved
      : { status: 'completed' as const, startedAt: previous.checkedAt, finishedAt: previous.checkedAt,
        reportId: previous.id, sessionId: null }
    const result = { workspaceId, reports, issues, truncated, lastCheck }
    if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxIndexBytes) {
      throw new RemoteError('knowledge/document', 'complete health report listing exceeds maxIndexBytes', { path: 'reports', reason: 'too-large' })
    }
    return result
  }

  /** Follow complete health report snapshots without placing reports in the active page index.
   * @param workspaceId - registered project owning the reports.
   * @param signal - cancels filesystem reads and the interval between scans.
   * @returns the initial listing and subsequent changed listings, including scan failures and truncation.
   */
  @Remote({ mode: 'stream' })
  async *followHealthReports(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<KnowledgeHealthReports> {
    let previous: string | undefined
    while (true) {
      const reports = await this.healthReports(workspaceId, signal)
      const serialized = JSON.stringify(reports)
      if (serialized !== previous) { previous = serialized; yield reports }
      await delay(this.config.refreshIntervalMs, undefined, { signal })
    }
  }

  /** Reveal an existing health report in Finder after checking its project and every path component.
   * @param workspaceId - registered project owning the report.
   * @param reportId - canonical dated report identity.
   * @param signal - cancels validation or native handoff, not an already-open Finder window.
   * @throws for unsafe or missing reports and unavailable native file selection.
   */
  @Remote
  async revealHealthReport(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId, signal: AbortSignal): Promise<void> {
    return this.revealDocument(workspaceId, healthReportPath(reportId), signal, 'health-report')
  }

  /** Read an existing health report with its findings and report-only history.
   * @param workspaceId - registered project, independent of any Session.
   * @param reportId - canonical dated report identity, not a page path.
   * @param signal - cancels reading.
   * @returns the bounded report and its content version.
   * @throws for missing, linked, malformed or oversized reports.
   */
  @Remote
  async readHealthReport(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId, signal: AbortSignal): Promise<KnowledgeHealthReport> {
    const path = healthReportPath(reportId)
    const { target, location } = await this.documentTarget(workspaceId, path, signal, 'health-report')
    const content = await this.files.readLocated(path, target, this.config.maxDocumentBytes, signal)
    this.locations.assertCurrent(location)
    return parseHealthReport(reportId, this.files.decodeText(path, content.bytes), documentVersion(content.bytes, location))
  }

  private async healthHistoryTarget(location: KnowledgeLocation, reportId: KnowledgeHealthReportId,
    revisionId: KnowledgeHealthHistoryId, signal: AbortSignal,
    allowMissing = false): Promise<{ path: KnowledgeDocumentId; target: FsTarget }> {
    healthReportPath(reportId)
    if (!/^[a-f0-9]{64}$/.test(revisionId)) throw new RemoteError('knowledge/document',
      'health history identity must be a complete SHA-256 hash', { path: reportId, reason: 'unsafe-path' })
    const path = `reports/history/${reportId}/${revisionId}.md` as KnowledgeDocumentId
    const base = await this.files.base(location, signal)
    if (base === undefined) throw new RemoteError('knowledge/document', 'Brain directory is missing', { path, reason: 'not-found' })
    const located = await this.files.locate(base, path, signal)
    if (located === undefined && !allowMissing) throw new RemoteError('knowledge/document',
      'referenced health history file is missing', { path, reason: 'not-found' })
    if (located !== undefined && located.kind !== 'file') throw new RemoteError('knowledge/document',
      'health history is not a regular file', { path, reason: 'invalid' })
    const target = located?.target ?? await this.ctx.fs.resolve(path, { cwd: this.ctx.fs.processPath(base), signal })
    const mapped = this.ctx.fs.processPathFromHostPath(join(location.path, path))
    if (!this.ctx.fs.contains(base, target) || mapped === undefined
      || (await this.ctx.fs.resolve(mapped, { signal })).targetKey !== target.targetKey) {
      throw new RemoteError('knowledge/document', 'health history has no matching contained Host path', { path, reason: 'unsafe-path' })
    }
    this.locations.assertCurrent(location)
    return { path, target }
  }

  private async retainHealthReport(location: KnowledgeLocation, reportId: KnowledgeHealthReportId,
    bytes: Uint8Array, next: string, capturedAt: string, signal: AbortSignal): Promise<string> {
    const reference = { revisionId: healthHistoryId(bytes), capturedAt }
    // ignoreBOM preserves the BOM as text so UTF-8 publication reproduces every captured byte.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const result = appendHealthHistory(reportId, text, next, reference, this.config.maxEntries, this.config.maxDocumentBytes)
    parseHealthReport(reportId, result, documentVersion(result, location))
    const { path, target } = await this.healthHistoryTarget(location, reportId, reference.revisionId, signal, true)
    signal.throwIfAborted()
    this.locations.assertCurrent(location)
    try {
      await this.ctx.fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, knowledgeWritePolicy(this.ctx.fs, location.path))
    } catch (error) {
      signal.throwIfAborted()
      if (filesystemFailure(error)?.code !== 'FS_NOT_OBSERVED') throw error
      // A previous failed publication may have left this exact, still-unreferenced file.
    }
    const stored = await this.healthHistoryTarget(location, reportId, reference.revisionId, signal)
    const retained = await this.files.readLocated(path, stored.target, this.config.maxDocumentBytes, signal)
    if (!Buffer.from(retained.bytes).equals(Buffer.from(bytes))) throw new RemoteError('knowledge/document',
      'health history file differs from its complete captured bytes; current report was not replaced', { path, reason: 'invalid' })
    this.locations.assertCurrent(location)
    return result
  }

  private async healthHistoryCurrent(location: KnowledgeLocation, reportId: KnowledgeHealthReportId, signal: AbortSignal) {
    const path = healthReportPath(reportId)
    const { target } = await this.documentTarget(location.workspaceId, path, signal, 'health-report')
    const content = await this.files.readLocated(path, target, this.config.maxDocumentBytes, signal)
    const text = this.files.decodeText(path, content.bytes)
    const currentVersion = documentVersion(content.bytes, location)
    parseHealthReport(reportId, text, currentVersion)
    const fields = knowledgeSource(text, false).frontmatter.value as Record<string, unknown> | null
    return { path, target, content, currentVersion, references: healthHistoryReferences(reportId, fields ?? {}) }
  }

  private async assertHealthHistoryCurrent(location: KnowledgeLocation, current: Awaited<ReturnType<KnowledgeController['healthHistoryCurrent']>>,
    signal: AbortSignal): Promise<void> {
    const { target } = await this.documentTarget(location.workspaceId, current.path, signal, 'health-report')
    const observed = await this.ctx.fs.stat(target, signal)
    if (target.targetKey !== current.target.targetKey || observed?.version !== current.content.version) {
      throw new RemoteError('knowledge/update', 'current health report changed while reading history; read the list again',
        { path: current.path, reason: 'conflict' })
    }
    signal.throwIfAborted()
    this.locations.assertCurrent(location)
  }

  private async readLocatedHealthHistory(location: KnowledgeLocation, reportId: KnowledgeHealthReportId,
    reference: HealthHistoryReference, maxBytes: number, signal: AbortSignal) {
    const { path, target } = await this.healthHistoryTarget(location, reportId, reference.revisionId, signal)
    const content = await this.files.readLocated(path, target, maxBytes, signal)
    if (healthHistoryId(content.bytes) !== reference.revisionId) throw new RemoteError('knowledge/document',
      'health history file does not match its referenced complete hash', { path, reason: 'invalid' })
    const report = parseHealthReport(reportId, this.files.decodeText(path, content.bytes), documentVersion(content.bytes, location))
    return { report, bytes: content.bytes.byteLength }
  }

  /** List prior generations reachable from the current daily report without starting an assessment.
   * @param workspaceId - registered project whose current Brain contains the report.
   * @param reportId - canonical dated report identity.
   * @param signal - cancels reads and rejects changed project or Brain selection.
   * @returns newest-first complete summaries, explicit file issues and incomplete-list indication.
   * @throws for invalid current metadata, changed current report or an oversized complete response.
   */
  @Remote
  async healthReportHistory(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId,
    signal: AbortSignal): Promise<KnowledgeHealthReportHistory> {
    return this.withLocation(workspaceId, signal, async (location, live) => {
      const current = await this.healthHistoryCurrent(location, reportId, live)
      const entries: KnowledgeHealthHistoryEntry[] = [], issues: KnowledgeIssue[] = []
      let remaining = this.config.maxIndexBytes, examined = 0, truncated = false
      for (const reference of [...current.references].reverse()) {
        if (examined >= this.config.maxEntries || remaining <= 0) { truncated = true; break }
        examined++
        const limit = Math.min(remaining, this.config.maxDocumentBytes)
        remaining -= limit
        try {
          const { report, bytes } = await this.readLocatedHealthHistory(location, reportId, reference, limit, live)
          remaining += limit - bytes
          entries.push({ ...reference, checkedAt: report.checkedAt, updatedAt: report.updatedAt,
            activePageCount: report.activePageCount, findingCount: report.findingCount, openHighRiskCount: report.openHighRiskCount,
            handledCount: report.handledCount, snoozedCount: report.snoozedCount })
        } catch (error) {
          live.throwIfAborted()
          const failure = remoteErrorOf(error) ?? filesystemFailure(error)
          if (failure === undefined) throw error
          issues.push({ path: `reports/history/${reportId}/${reference.revisionId}.md`, message: failure.message })
          const remote = remoteErrorOf(error)
          if (remote?.code === 'knowledge/document' && remote.details.reason === 'too-large') truncated = true
        }
      }
      await this.assertHealthHistoryCurrent(location, current, live)
      const result = { workspaceId, reportId, locationRevision: location.revision, currentVersion: current.currentVersion,
        entries, issues, truncated }
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxIndexBytes) throw new RemoteError('knowledge/document',
        'complete health history listing exceeds maxIndexBytes', { path: current.path, reason: 'too-large' })
      return result
    })
  }

  /** Read one immutable prior report referenced by the currently selected Brain's daily report.
   * @param workspaceId - registered project owning the current report and retained files.
   * @param reportId - canonical daily identity, not an arbitrary path.
   * @param revisionId - full-file SHA-256 identity present in the current manifest.
   * @param signal - cancels filesystem work; this never resumes a Session or writes a report.
   * @returns the complete report and its capture identity; no mutation capability is attached.
   * @throws for unreferenced, missing, linked, corrupt, changed or oversized data.
   */
  @Remote
  async readHealthReportHistory(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId, revisionId: KnowledgeHealthHistoryId,
    signal: AbortSignal): Promise<KnowledgeHealthHistoricalReport> {
    return this.withLocation(workspaceId, signal, async (location, live) => {
      const current = await this.healthHistoryCurrent(location, reportId, live)
      const reference = current.references.find(entry => entry.revisionId === revisionId)
      if (reference === undefined) throw new RemoteError('knowledge/document',
        'health history identity is not referenced by the current report', { path: current.path, reason: 'not-found' })
      const { report } = await this.readLocatedHealthHistory(location, reportId, reference, this.config.maxDocumentBytes, live)
      await this.assertHealthHistoryCurrent(location, current, live)
      const result = { workspaceId, reportId, ...reference, report }
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxIndexBytes) throw new RemoteError('knowledge/document',
        'complete health history detail exceeds maxIndexBytes', { path: current.path, reason: 'too-large' })
      return result
    })
  }

  /** Publish a complete assessment without changing ordinary knowledge; same-day rechecks replace findings and dispositions.
   * @param workspaceId - registered project owning the daily report.
   * @param reportId - fixed dated report identity.
   * @param request - reviewed findings and retained UUID; null version creates only, an observed version replaces only.
   * @param signal - cancels before publication admission; identical committed retries preserve subsequent dispositions.
   * @returns the committed report file receipt, not proof of model execution or factual correctness.
   * @throws for invalid findings, stale versions, conflicting retry identities, unsafe paths or oversized reports.
   */
  @Remote
  async writeHealthReport(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId,
    request: KnowledgeHealthReportWrite, signal: AbortSignal): Promise<KnowledgeTruthReceipt> {
    return this.trackOperation(signal, async (live) => {
      const prepared = prepareHealthReportWrite(reportId, request, new Date().toISOString(), this.config.maxDocumentBytes)
      const path = healthReportPath(reportId)
      const applied = (text: string): boolean => healthGenerationApplied(reportId, text, request.operationId, prepared.digest)
      if (request.expectedVersion === null) {
        return this.publishNewDocument(workspaceId, path, request.operationId, prepared.text, (text) => {
          if (!applied(text)) throw new RemoteError('knowledge/update',
            'health report already exists; read it before rechecking', { path, reason: 'conflict' })
        }, live, () => {}, 'health-report')
      }
      return { ...await this.modifyPage(workspaceId, path, (text, version) => {
        if (applied(text)) return undefined
        if (version !== request.expectedVersion) throw new RemoteError('knowledge/update',
          'health report changed while checking; read it again before replacing findings', { path, reason: 'conflict' })
        return prepared.text
      }, live, () => {}, 'health-report', request.expectedVersion, false,
      { reportId, capturedAt: new Date().toISOString() }), operationId: request.operationId }
    })
  }

  /** Mark one report finding and update its counters and history atomically; referenced pages are untouched.
   * @param workspaceId - registered project owning the existing report.
   * @param reportId - dated report identity.
   * @param request - observed version and explicit disposition; stale retries require a new read.
   * @param signal - cancels before publication admission.
   * @returns the committed report version.
   * @throws for stale reports, invalid findings, unsafe paths and oversized replacements.
   */
  @Remote
  async markHealthFinding(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId,
    request: KnowledgeHealthFindingUpdate, signal: AbortSignal): Promise<string> {
    return this.admitHealthFinding(workspaceId, reportId, request, signal, () => {})
  }

  /** Mark a finding in the ordinary conversation's directly registered project.
   * @param sessionId - directly assigned source conversation; execution Tasks and approved Goals are refused.
   * @param reportId - dated report identity.
   * @param request - report version and finding disposition.
   * @param signal - cancellation before atomic publication admission.
   * @returns the committed report version.
   * @throws when authority changes before publication admission.
   */
  async markSessionHealthFinding(sessionId: SessionId, reportId: KnowledgeHealthReportId,
    request: KnowledgeHealthFindingUpdate, signal: AbortSignal): Promise<string> {
    const { project, authorize } = this.sessionWriter(sessionId)
    return this.admitHealthFinding(project.id, reportId, request, signal, authorize)
  }

  private admitHealthFinding(workspaceId: WorkspaceId, reportId: KnowledgeHealthReportId,
    request: KnowledgeHealthFindingUpdate, signal: AbortSignal, authorize: () => void): Promise<string> {
    return this.trackOperation(signal, async live => (await this.modifyPage(workspaceId, healthReportPath(reportId),
      (text, version) => prepareHealthFindingUpdate(reportId, text, version, request,
        new Date().toISOString(), this.config.maxDocumentBytes),
      live, authorize, 'health-report', request.expectedVersion)).version)
  }

  /**
   * Select a recognized document in Finder after rechecking its project and path.
   * @param workspaceId - registered project identity, independent of any Session.
   * @param documentId - Brain-relative Markdown identity; arbitrary Host paths are refused.
   * @param signal - cancels validation or the native handoff, not an already-open Finder window.
   * @returns after the native handoff; missing, linked or unsupported files reject without launching an application.
   */
  @Remote
  async reveal(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal): Promise<void> {
    return this.revealDocument(workspaceId, documentId, signal, 'knowledge')
  }

  private async revealDocument(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId,
    signal: AbortSignal, kind: 'knowledge' | 'health-report'): Promise<void> {
    signal.throwIfAborted()
    if (!this.canRevealPath()) throw new RemoteError('gateway/internal', 'native file selection is unavailable on this host', {})
    const { path } = await this.documentTarget(workspaceId, documentId, signal, kind)
    signal.throwIfAborted()
    try { await this.revealPath(path, signal) } catch (error) {
      signal.throwIfAborted()
      throw new RemoteError('gateway/internal', `native file selection failed: ${error instanceof Error ? error.message : String(error)}`, {})
    }
  }

  private async readDocumentSource(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal) {
    const { target, location } = await this.documentTarget(workspaceId, documentId, signal)
    const content = await this.files.readLocated(documentId, target, this.config.maxDocumentBytes, signal)
    this.locations.assertCurrent(location)
    signal.throwIfAborted()
    return { text: this.files.decodeText(documentId, content.bytes), version: documentVersion(content.bytes, location) }
  }

  private async documentTarget(
    workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, signal: AbortSignal, kind: 'knowledge' | 'health-report' = 'knowledge',
  ): Promise<{ target: FsTarget; path: string; location: KnowledgeLocation }> {
    signal.throwIfAborted()
    relativeSegments(documentId)
    const accepted = kind === 'health-report'
      ? documentId === healthReportPath(documentId.slice('reports/'.length, -3) as KnowledgeHealthReportId)
      : ROOT_DOCUMENTS.some(path => path === documentId) || (documentId.startsWith('pages/') && documentId.endsWith('.md'))
    if (!accepted) {
      throw new RemoteError('knowledge/document', 'path is not a knowledge root or page', { path: documentId, reason: 'unsafe-path' })
    }
    const location = this.locations.get(workspaceId)
    const base = await this.files.base(location, signal)
    const located = base === undefined ? undefined : await this.files.locate(base, documentId, signal)
    if (located === undefined || located.kind !== 'file') {
      throw new RemoteError('knowledge/document', 'knowledge document does not exist', { path: documentId, reason: 'not-found' })
    }
    const path = join(location.path, documentId)
    const mapped = this.ctx.fs.processPathFromHostPath(path)
    if (mapped === undefined || (await this.ctx.fs.resolve(mapped, { signal })).targetKey !== located.target.targetKey) {
      throw new RemoteError('knowledge/document', 'knowledge file has no matching Host path', { path: documentId, reason: 'unsafe-path' })
    }
    this.locations.assertCurrent(location)
    return { target: located.target, path, location }
  }

  /**
   * Follow bounded filesystem snapshots, including creation of an initially missing Brain.
   * @param workspaceId - registered project identity.
   * @param signal - cancels scans and the delay between them.
   * @returns an initial index, then complete indexes only when their contents change.
   */
  @Remote({ mode: 'stream' })
  async *follow(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<KnowledgeIndex> {
    let previous: string | undefined
    while (true) {
      const index = await this.index(workspaceId, signal)
      const serialized = JSON.stringify(index)
      if (serialized !== previous) {
        previous = serialized
        yield index
      }
      await delay(this.config.refreshIntervalMs, undefined, { signal })
    }
  }

  private workspacePath(workspaceId: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'project is not registered', { workspaceId })
    return workspace.path
  }
}

export default KnowledgeController
