/** Project task intent and execution receipts, independent of process-local jobs. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NativeTaskToolDefinition } from '@deepseek-ai/dsh-subagent/native-tools'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArtifactRenditionId, ArtifactPreviewRef } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { DocumentImportFormat, DocumentImportSourceId, DocumentTextExtraction, DocumentImportDocxImageOmission } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'

/** Opaque original-import identity supplied by the registered Task evidence provider. */
export type ProjectTaskReviewImportId = string & Branded<'KnowledgeImportId'>

/** Human-selected imported document; the Task proposal and project path never select sources. */
export interface ProjectTaskReviewSourceSelection {
  readonly importId: ProjectTaskReviewImportId
  readonly sessionId: SessionId
  readonly documentId: DocumentImportSourceId
}

/** Actual reviewer route and remaining aggregate budget passed to an original-source provider. */
export interface ProjectTaskReviewSourceVisualOptions {
  readonly imageCapable: boolean
  readonly maxImages: number
  readonly maxTotalBytes: number
}

/** Original PDF pages supplied as durable images, with explicit omissions rather than an understanding claim. */
export interface ProjectTaskReviewPdfVisualEvidence {
  readonly coverage: {
    readonly pageCount: number
    readonly renderedPages: readonly number[]
    readonly omittedReason?: 'text-only-route' | 'page-limit' | 'byte-limit' | 'render-failed' | undefined
  }
  readonly images: readonly { readonly page: number
    readonly attachment: ImageAttachmentRef }[]
}

/** Actual extracted DOCX images; embedded-image numbering never denotes Word pages. */
export interface ProjectTaskReviewDocxVisualEvidence {
  readonly coverage: {
    readonly imageCount: number
    readonly suppliedImages: readonly number[]
    readonly omittedImages: readonly { readonly image: number
      readonly reason: DocumentImportDocxImageOmission }[]
    readonly layoutReviewed: false
  }
  readonly images: readonly ImageAttachmentRef[]
}

/** Converted text and optional visual evidence, verified against the imported original on each provider read. */
export interface ProjectTaskReviewSource extends ProjectTaskReviewSourceSelection {
  readonly name: string
  readonly format: DocumentImportFormat
  readonly bytes: number
  readonly sourceSha256: string
  readonly text: string
  readonly textBytes: number
  readonly textSha256: string
  readonly extraction?: DocumentTextExtraction | undefined
  readonly pdfVisual?: ProjectTaskReviewPdfVisualEvidence | undefined
  readonly docxVisual?: ProjectTaskReviewDocxVisualEvidence | undefined
}

/** Optional provider registration; a selected Task fails closed when absent, while omitted options verify bytes without rendering. */
export type ProjectTaskReviewSourceReader = (workspaceId: WorkspaceId,
  selection: ProjectTaskReviewSourceSelection, signal: AbortSignal,
  options?: ProjectTaskReviewSourceVisualOptions) => Promise<ProjectTaskReviewSource>

/** Every non-plain-text artifact entry in the complete retained directory, in directory order. */
export type ProjectTaskArtifactCoverage = readonly ({ readonly path: string
  readonly bytes: number
  readonly sha256: string } & (
  | { readonly kind: 'opaque'
    readonly reason: 'unsupported-format' | 'unreadable-text' | 'too-large'
    | 'unreadable' | 'too-many-pages' | 'no-readable-text' }
  | { readonly kind: 'converted-text'
    readonly format: 'pdf' | 'docx'
    readonly extraction: DocumentTextExtraction }
))[]

/** Native catalog advertisement, not an authentication, quota or model-quality check. */
export interface ProjectTaskCodexModel {
  /** Exact native execution selector, independent of catalog entry identity. */
  readonly model: string
  readonly label: string
  readonly description: string
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly reasoningEfforts: readonly { readonly id: string
    readonly description: string }[]
}

/** Native Codex settings for coding, read-only research or private workspace-write documentation, not a Harness model route. */
export interface ProjectTaskCodexSelection {
  readonly sandbox: 'read-only' | 'workspace-write'
  /** Omission preserves the model configured in the native Codex account. */
  readonly model?: string | undefined
  /** Exact native effort; omission retains the native configuration, not the catalog default. */
  readonly reasoningEffort?: string | undefined
}

/** A Codex thread is never interchangeable with a Harness Session or Task identity. */
export type ProjectTaskCodexThreadId = Branded<'CodexThreadId'>

/** Research requires plan; documentation requires dontAsk with separately authorized sandboxed Bash. No permission bypass. */
export interface ProjectTaskClaudeSelection {
  readonly runtime: 'claude'
  readonly permissionMode: 'dontAsk' | 'acceptEdits' | 'auto' | 'plan'
  readonly model?: string | undefined
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
}

/** Claude-issued identity, distinct from the Task's local audit Session. */
export type ProjectTaskClaudeSessionId = Branded<'ClaudeCodeSessionId'>

/** Bounded provider-authored failure detail; raw exceptions and native notifications are excluded. */
export interface ProjectTaskNativeFailure {
  /** Provider stop reason; native providers may add values beyond the known recovery hints. */
  readonly stopReason: string
  /** Safe diagnostic, at most 4096 UTF-8 bytes. */
  readonly diagnostic?: string | undefined
}

/** Complete Host-acknowledged documentation bytes retained in the native audit Session. */
export interface ProjectTaskArtifactCheckpoint {
  readonly path: string
  readonly dataBase64: string
  readonly sha256: string
}

/** Complete task-owned research-output bytes, distinct from worker-authored native notifications. */
export interface ProjectTaskResearchCheckpoint {
  readonly fileName: string
  readonly dataBase64: string
  readonly sha256: string
}

/** Retained native Claude input, exact SDK events and terminal outcome. */
export type ProjectTaskClaudeEvent = { readonly messageId: MessageId } & (
  | { readonly kind: 'input'
    readonly text: string
    readonly selection: ProjectTaskClaudeSelection
    readonly nativeSessionId: ProjectTaskClaudeSessionId }
  | { readonly kind: 'session'
    readonly sessionId: ProjectTaskClaudeSessionId }
  | { readonly kind: 'notification'
    readonly json: string }
  | ({ readonly kind: 'artifact-checkpoint-v2' } & ProjectTaskArtifactCheckpoint)
  | ({ readonly kind: 'research-output-checkpoint-v1' } & ProjectTaskResearchCheckpoint)
  | { readonly kind: 'result'
    readonly status: 'closed-success' | 'closed-failed' | 'closed-cancelled'
    readonly reason: string
    readonly output: string
    readonly nativeFailure?: ProjectTaskNativeFailure | undefined }
)

/** Append-only external task evidence. Input is durable before a native turn can start. */
export type ProjectTaskCodexEvent = { readonly messageId: MessageId } & (
  | { readonly kind: 'input'
    readonly text: string
    readonly selection: ProjectTaskCodexSelection }
  | { readonly kind: 'thread'
    readonly threadId: ProjectTaskCodexThreadId }
  | { readonly kind: 'notification'
    readonly method: string
    readonly params: string }
  | ({ readonly kind: 'artifact-checkpoint-v2' } & ProjectTaskArtifactCheckpoint)
  | ({ readonly kind: 'research-output-checkpoint-v1' } & ProjectTaskResearchCheckpoint)
  | { readonly kind: 'result'
    readonly status: 'closed-success' | 'closed-failed' | 'closed-cancelled'
    readonly reason: string
    readonly output: string
    readonly nativeFailure?: ProjectTaskNativeFailure | undefined }
)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** External Task input, native identity, notifications and terminal receipt; not Harness model history. */
    'project-task/codex': ProjectTaskCodexEvent
    /** Native Claude Task evidence; not Harness model history. */
    'project-task/claude': ProjectTaskClaudeEvent
  }
}

/** Read-only execution journal; live entries are recorded events, not token-stream deltas. */
export interface ProjectTaskExecutionLog {
  readonly claude?: ProjectTaskClaudeSelection & { readonly sessionId?: ProjectTaskClaudeSessionId | undefined } | undefined
  readonly state: 'not-started' | 'unavailable' | 'ready'
  readonly sessionId: SessionId | null
  readonly model: ModelSelection | null
  /** Native execution metadata; the Session id remains the independent local audit identity. */
  readonly codex?: ProjectTaskCodexSelection & { readonly threadId?: ProjectTaskCodexThreadId | undefined } | undefined
  /** Newest suffix of the confirmed input's turn, in chronological order. */
  readonly entries: readonly ProjectTaskLogEntry[]
  /** Earlier entries excluded by the response byte limit; stored events are unchanged. */
  readonly omittedEntries: number
}

/** One recorded task event; data is complete JSON, never executable markup. */
export interface ProjectTaskLogEntry {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: string
}

/** Original registered project of a retained task Session, independent of its execution directory. */
export interface ProjectTaskSessionProject {
  readonly id: WorkspaceId
  readonly path: string
}

/** Explicit knowledge selection; omitted collections resolve to empty at dispatch. */
export interface ProjectTaskKnowledgeSelection {
  /** Proposed maintenance intent; explicit user prohibitions must be retained as read-only. Confirmation owns authorization. */
  readonly knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode | undefined
  readonly brainRefs?: readonly string[] | undefined
  readonly rootPageRefs?: ProjectGoalPlan['rootPageRefs'] | undefined
}

/** Provider captures a bounded, complete knowledge contribution before task input is retained.
 * @param project - original registered project and its retained path.
 * @param selection - explicitly resolved references and the execution's available knowledge reader kind.
 * @param signal - cancellation before task admission.
 * @returns source text and versions as one bounded serialized contribution.
 */
export type ProjectTaskKnowledgeReader = (
  project: ProjectTaskSessionProject,
  selection: {
    readonly brainRefs: readonly string[]
    readonly rootPageRefs: ProjectGoalPlan['rootPageRefs']
    readonly readMode: 'tools' | 'files'
  },
  signal: AbortSignal,
) => Promise<string>

/** Resolve every explicitly selected active decision page to its current version without granting writes. */
export type ProjectTaskKnowledgeReviewPages = (project: ProjectTaskSessionProject,
  refs: readonly string[], signal: AbortSignal) => Promise<readonly { readonly path: string
  readonly version: string }[]>

/** Original logged Timeline call, retained only for read-only reconciliation of an ended Task review. */
export interface ProjectTaskTimelineAppend {
  readonly path: string
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly expectedVersion: string
  readonly kind: 'decision' | 'observation' | 'source' | 'reversal'
  readonly summary: string
  readonly source?: string
  readonly affects?: readonly string[]
  readonly evidence?: string
}

/** Inspect the original project's current Brain file without starting a model or repeating a write. */
export type ProjectTaskTimelineReceipt = (project: ProjectTaskSessionProject, sessionId: SessionId,
  append: ProjectTaskTimelineAppend, signal: AbortSignal) => Promise<boolean>

/** Bind read-only knowledge queries to the original project and its current Brain location.
 * @param project - retained project identity and directory; model arguments cannot replace them.
 * @returns definitions and a reader; throws when the project or provider is unavailable.
 */
export type ProjectTaskKnowledgeTools = (project: ProjectTaskSessionProject) => {
  readonly definitions: readonly NativeTaskToolDefinition[]
  /** Read one bounded result; the Task consumer owns durable call/result acknowledgement.
   * @param name - one advertised query name.
   * @param args - untrusted native model arguments.
   * @param signal - execution and provider cancellation.
   * @returns complete knowledge and access accounting deferred until durable acknowledgement;
   * rejects invalid, revoked or oversized requests.
   */
  readonly read: (name: string, args: unknown, signal: AbortSignal) => Promise<{
    readonly text: string
    /** Record successful access after complete output admission; never writes knowledge files. */
    readonly recordAccess: () => Promise<void>
  }>
}

/** Prepare a task-owned standalone knowledge process without an application-host connection.
 * @param taskId - immutable task identity retained before preparation.
 * @param project - original registered project, independent of execution directory.
 * @param directory - caller-owned private directory; retained after Terminal handoff.
 * @param inputText - complete initial native prompt, retained in the standalone knowledge Session.
 * @param signal - preparation lifetime; cancellation does not stop an accepted Terminal session.
 * @returns launch specification, final authorization check, and release for a handoff that never reaches the OS.
 */
export type ProjectTaskTerminalKnowledge = (taskId: ProjectTaskId, project: ProjectTaskSessionProject,
  directory: string, inputText: string, signal: AbortSignal) => Promise<{
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Recheck the captured knowledge location immediately before handoff.
   * @param signal - current handoff lifetime.
   */
  readonly validate: (signal: AbortSignal) => void
  /** Revoke the grant when preparation fails before the OS handoff starts; never call after the OS call starts. */
  readonly release: () => Promise<void>
}>

/** Explicit native runtime for an interactive task; permissions are never escalated by handoff. */
export type ProjectTaskTerminalSelection = { readonly runtime: 'codex'
  readonly selection: ProjectTaskCodexSelection }
  | { readonly runtime: 'claude'
    readonly selection: ProjectTaskClaudeSelection }

/** Caller-retained UUID for one task proposal and its confirmation retries. */
export type ProjectTaskId = Branded<'ProjectTaskId'>

/** Conversation proposal identity; it is not an execution task identity. */
export type ProjectTaskCardId = Branded<'ProjectTaskCardId'>

/** Read-only attention counts for a source conversation, aggregated across its current workspace. */
export interface TaskConversationAttention {
  readonly sessionId: SessionId
  readonly pendingProposals: number
  readonly pendingCompletions: number
}

/** One product goal run; distinct from the same-session goal driver's identity. */
export type ProjectGoalRunId = Branded<'ProjectGoalRunId'>

/** Caller-retained goal-entry identity, scoped to its source Session. */
export type ProjectGoalRequestId = Branded<'ProjectGoalRequestId'>

/** Sub-goal identity local to one submitted plan. */
export type ProjectSubGoalId = Branded<'ProjectSubGoalId'>

/** A proposed verification operation; submission never executes it. */
export type ProjectGoalCheck = { readonly kind: 'command'
  readonly command: string
  readonly timeoutMs?: number | undefined }
  | { readonly kind: 'http'
    readonly url: string
    readonly timeoutMs?: number | undefined }

/** Machine-verifiable and human-readable forms of the same acceptance condition. */
export interface ProjectGoalCriterion {
  readonly machine: string
  readonly plain: string
  readonly weak?: boolean | undefined
  readonly check?: ProjectGoalCheck | undefined
}

/** One independently verifiable sub-goal with explicit dependency identities. */
export interface ProjectSubGoal {
  readonly id: ProjectSubGoalId
  readonly title: string
  readonly criteria: readonly ProjectGoalCriterion[]
  readonly dependsOn: readonly ProjectSubGoalId[]
  readonly complexity: 'simple' | 'medium' | 'complex'
  readonly affectedFiles: readonly string[]
}

/** Complete proposed objective and acyclic sub-goal graph, before execution authorization. */
export interface ProjectGoalPlan {
  /** Proposed maintenance intent, preserved by signoff unless the person explicitly changes it. */
  readonly knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode | undefined
  readonly goal: string
  /** False forbids every new signed-run task; omission permits normal dispatch. */
  readonly allowTaskDispatch?: boolean | undefined
  readonly subGoals: readonly ProjectSubGoal[]
  readonly brainRefs: readonly string[]
  /** Additional exact workspace-project identities authorized for the same signed knowledge paths. */
  readonly brainProjectIds?: readonly WorkspaceId[] | undefined
  readonly rootPageRefs: readonly ('background' | 'architecture' | 'flow' | 'mindmap' | 'stack' | 'roadmap')[]
}

/** Authored plan; resolution fills omitted collections and medium complexity before retention. */
export interface ProjectGoalPlanInput {
  readonly knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode | undefined
  readonly goal?: string
  readonly allowTaskDispatch?: boolean | undefined
  readonly subGoals: readonly (Omit<ProjectSubGoal, 'dependsOn' | 'complexity' | 'affectedFiles'>
    & Partial<Pick<ProjectSubGoal, 'dependsOn' | 'complexity' | 'affectedFiles'>>)[]
  readonly brainRefs?: readonly string[]
  readonly brainProjectIds?: readonly WorkspaceId[] | undefined
  readonly rootPageRefs?: readonly string[]
}

/** Call-stable submitted plan retained while awaiting explicit user signoff. */
export interface ProjectGoalPlanSubmission {
  readonly requestId: ProjectGoalRequestId
  readonly input: ProjectGoalPlan
  readonly submittedAt: number
}

/** User-adjustable thresholds retained with the approved plan. */
export interface ProjectGoalBudget {
  /** Consecutive outcomes without newly accepted criteria before an advisory; never an automatic pause. */
  readonly noProgressPauseThreshold: number
  /** Cumulative task count warning; dispatch remains available. */
  readonly runSpawnCap: number
  /** Reported task token warning threshold, excluding master usage. */
  readonly runTokenWarnThreshold: number
  /** Task model-step warning threshold, excluding master turns. */
  readonly runTurnWarnThreshold: number
}

/** Explicit native task route; sandbox permissions derive from the signed task kind. */
export interface ProjectGoalCodexModel {
  readonly runtime: 'codex'
  readonly model: string
  /** Exact approved native effort; omission preserves the native configuration. */
  readonly reasoningEffort?: string | undefined
}

/** Explicit Claude route; coding policy is signed, while research always enforces read-only tools. */
export interface ProjectGoalClaudeModel {
  readonly runtime: 'claude'
  readonly model: string
  /** Exact approved coding policy; research uses plan mode instead. */
  readonly permissionMode: Exclude<ProjectTaskClaudeSelection['permissionMode'], 'plan'>
  /** Exact approved native effort; omission preserves the native configuration. */
  readonly reasoningEffort?: ProjectTaskClaudeSelection['effort']
}

/** Harness provider or explicit native identity, never an implicit account default. */
export type ProjectGoalTaskModel = ModelSelection | ProjectGoalCodexModel | ProjectGoalClaudeModel

/** Independent Harness master and eligible task routes; selections never change global defaults. */
export interface ProjectGoalModels {
  readonly master: ModelSelection
  readonly tasks: readonly ProjectGoalTaskModel[]
}

/** Explicit coding-only follow-up choices retained with one signed Goal plan. */
export interface ProjectGoalCodingPostSteps {
  readonly autoReview: boolean
  readonly autoRunTests: boolean
  readonly autoFix: boolean
}

/** Explicit review of one exact submitted plan; retries retain every field. */
export type ProjectGoalReviewInput = {
  readonly requestId: ProjectGoalRequestId
  readonly planRequestId: ProjectGoalRequestId
} & ({
  readonly decision: 'approve'
  readonly models: ProjectGoalModels
  readonly budget: ProjectGoalBudget
  /**
   * Preset frozen for this approval's Harness child tasks; omission keeps the dispatch default. Native routes and the source Agent
   * ignore it.
   */
  readonly agentPreset?: AgentPresetRow['id'] | undefined
  /** Explicit permission for independent result discovery to maintain knowledge; omission grants none. */
  readonly knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode | undefined
  /** Explicit permission for signed research command checks to run in the original project. Omission grants none. */
  readonly researchProjectChecks?: boolean | undefined
  /** Explicitly permits signed sub-goals to produce private documentation artifacts. */
  readonly documentationTasks?: boolean | undefined
  /** Omission grants no coding review, automatic test guidance or review-driven repair to this approval. */
  readonly codingPostSteps?: ProjectGoalCodingPostSteps | undefined
}
  | { readonly decision: 'reject'
    readonly feedback?: string })

/** Git commit fixed before allocating a project-owned worktree. */
export type ProjectGitCommitId = Branded<'ProjectGitCommitId'>

/** Immutable Git tree selected before committing a task's staged files. */
export type ProjectGitTreeId = Branded<'ProjectGitTreeId'>

/** Retained checkout location and starting commit, without a claim of execution or merging. */
export interface ProjectGitWorkspace {
  readonly branch: string
  readonly baseBranch: string | null
  readonly baseCommit: ProjectGitCommitId
  readonly relativePath: string
}

/** Prepared local integration branch for an approved Goal. */
export type ProjectGoalIntegration = ProjectGitWorkspace

/** Local task-to-integration result; none of these states establishes acceptance. */
export type ProjectGoalTaskMerge = { readonly status: 'preparing' | 'merging' }
  | { readonly status: 'merged' | 'empty'
    readonly commit: ProjectGitCommitId }
  | { readonly status: 'conflict'
    readonly files: readonly string[] }

/** Retained review intent and source-input delivery, independent of model completion. */
export interface ProjectGoalReview {
  readonly knowledgeMaintenanceAuthorization?: ProjectTaskKnowledgeMaintenanceAuthorization | undefined
  readonly input: ProjectGoalReviewInput
  readonly delivery: 'pending' | 'sent'
}

/** Current selectable routes and deployment defaults for the review form. */
export interface ProjectGoalReviewOptions {
  readonly catalog: ModelCatalog
  readonly budget: ProjectGoalBudget
  /** Fresh local capability claims; these are not adapter guarantees or execution permissions. */
  readonly capabilities?: readonly ProjectGoalModelCapability[] | undefined
}

/** A source-authored model assessment; provider-qualified identity prevents cross-provider reuse. */
export interface ProjectGoalModelCapabilityInput {
  readonly requestId: ProjectGoalRequestId
  readonly provider: string
  readonly model: string
  readonly tier: 'frontier' | 'balanced' | 'fast' | 'unknown'
  readonly summary: string
  /** Public research source, not private project content or credentials. */
  readonly source: string
  /** True for a guess or inconclusive research; false is a research claim, not independent verification. */
  readonly assumed: boolean
}

/** Retained assessment with a fixed validity interval; retries cannot renew it. */
export interface ProjectGoalModelCapability extends Omit<ProjectGoalModelCapabilityInput, 'requestId'> {
  readonly recordedAt: number
  readonly expiresAt: number
}

/** Card-free instructions for signed sub-goals, pre-plan gathering or model capability research. */
export type ProjectGoalDispatchInput = ProjectGoalSubGoalDispatchInput | ProjectGoalGatherDispatchInput | ProjectGoalProbeDispatchInput

/** Coding or research request for one approved sub-goal; retries retain every field. */
export interface ProjectGoalSubGoalDispatchInput {
  readonly requestId: ProjectGoalRequestId
  readonly subGoalId: ProjectSubGoalId
  readonly probe?: undefined
  /** Omission selects coding; documentation publishes a private artifact directory. */
  readonly taskType?: 'coding' | 'deep-research' | 'documentation' | undefined
  readonly description: string
  /** Omit to use the approved master route, never the mutable global default. */
  readonly model?: ProjectGoalTaskModel | undefined
}

/** Unbound research or coding spike during GATHER or PLAN, using the master's current route. */
export interface ProjectGoalGatherDispatchInput extends ProjectTaskKnowledgeSelection {
  readonly requestId: ProjectGoalRequestId
  readonly subGoalId?: undefined
  readonly probe?: undefined
  readonly taskType: 'coding' | 'deep-research'
  readonly title: string
  readonly description: string
  /** Task outcomes for gathering, not signed-plan acceptance conditions. */
  readonly acceptanceCriteria?: readonly string[] | undefined
  /** Manual review steps; dispatch and completion never execute or check these steps. */
  readonly verifySteps?: readonly string[] | undefined
  /** Context only; paths grant neither file access nor permission to edit. */
  readonly affectedFiles?: readonly string[] | undefined
}

/** RUNNING-only research about a signed model, independent of the approved model executing it. */
export interface ProjectGoalProbeDispatchInput extends Omit<ProjectGoalGatherDispatchInput, 'probe' | 'taskType'> {
  readonly taskType: 'deep-research'
  /** Provider-qualified subject; this selection grants no execution permission. */
  readonly probe: Pick<ModelSelection, 'provider' | 'model'>
  /** Research runner; omit for the approved master route. */
  readonly model?: ProjectGoalTaskModel | undefined
}

/** Host-owned result of one approved deterministic criterion check. */
export interface ProjectGoalCheckResult {
  readonly index: number
  readonly passed: boolean
  readonly detail: string
}

/** Collected Task evidence; delivery records input admission, not a completed model turn. */
export interface ProjectGoalReport {
  readonly requestId: ProjectGoalRequestId
  readonly checks: readonly ProjectGoalCheckResult[]
  readonly delivery: 'checking' | 'pending' | 'sent'
  readonly summary: string
  readonly summaryTruncated: boolean
}

/** Collected attempt or signed master-only review of criteria without deterministic checks. */
export interface ProjectGoalOutcomeInput {
  readonly requestId: ProjectGoalRequestId
  readonly subGoalId: ProjectSubGoalId
  /** Reserved master marker is accepted only when the signed plan forbids child tasks. */
  readonly taskId: ProjectTaskId | 'master'
  readonly criteriaPassed: readonly number[]
  readonly verdict: 'passed' | 'failed'
  readonly decision: 'NEXT' | 'RETRY' | 'DONE' | 'ESCALATE'
  readonly failureReason?: string | undefined
  readonly escalateReason?: string | undefined
}

/** Explicit recheck request for one collected attempt; omitted indices rerun every checked criterion. */
export interface ProjectGoalVerifyInput {
  readonly requestId: ProjectGoalRequestId
  readonly subGoalId: ProjectSubGoalId
  readonly taskId: ProjectTaskId
  readonly criteria?: readonly number[] | undefined
}

/** Exact user gesture; revision rejects stale controls after another pause or resume. */
export interface ProjectGoalControlInput {
  readonly requestId: ProjectGoalRequestId
  readonly action: 'pause' | 'resume' | 'exit'
  readonly revision: number
  /** Resume-only increases; smaller values preserve the current thresholds. */
  readonly budgetOverride?: { readonly [Key in Exclude<keyof ProjectGoalBudget, 'noProgressPauseThreshold'>]?: number | undefined } | undefined
}

/** Settled task model steps; absent provider token reports remain explicit. */
export interface ProjectTaskUsage {
  readonly turns: number
  readonly totalTokens: number
  readonly unreportedSteps: number
}

/** Cumulative admitted tasks and settled worker usage; master usage is excluded. */
export interface ProjectGoalUsage extends ProjectTaskUsage {
  readonly spawnsUsed: number
  /** Tasks without a settled usage receipt, including running tasks and older records. */
  readonly unaccountedTasks: number
  readonly noProgressStreak: number
}

/** Highest-priority soft warning; it never changes phase or dispatch authority. */
export interface ProjectGoalBudgetNotice {
  readonly dimension: 'no-progress' | 'spawn' | 'token' | 'turn'
  readonly used: number
  readonly threshold: number
  readonly advisory: true
}

/** Retained control receipt; pending pause or exit does not yet assert execution quiescence. */
export interface ProjectGoalControl {
  readonly input: ProjectGoalControlInput
  readonly delivery: 'pending' | 'sent'
  readonly cancelledTaskIds: readonly ProjectTaskId[]
}

/** Explicit user choice after a run ends; never admitted by a model tool. */
export interface ProjectGoalDeliveryInput {
  readonly requestId: ProjectGoalRequestId
  readonly action: 'keep' | 'merge' | 'checkout'
}

/** Latest final delivery receipt; conflicts leave both original edits and the result branch intact. */
export interface ProjectGoalDelivery {
  readonly input: ProjectGoalDeliveryInput
  readonly status: 'pending' | 'kept' | 'merged' | 'checked-out' | 'conflict'
  readonly commit?: ProjectGitCommitId | undefined
  readonly files?: readonly string[] | undefined
}

/** Acceptance marks projected from collected checks and explicit master outcomes. */
export interface ProjectGoalProgress {
  readonly subGoalId: ProjectSubGoalId
  readonly taskId: ProjectTaskId | null
  readonly status: 'pending' | 'dispatched' | 'done' | 'failed'
  readonly criteria: readonly {
    readonly index: number
    readonly passed: boolean
    readonly verifiedBy?: 'tier0' | 'master' | undefined
    readonly detail?: string | undefined
  }[]
}

/** Persisted goal-entry request; a retry cannot replace its objective. */
export interface ProjectGoalRequest {
  readonly requestId: ProjectGoalRequestId
  readonly sourceSessionId: SessionId
  readonly goal: string
}

/** Goal state; RUNNING records prepared approval, not successful execution or verification. */
export interface ProjectGoalState extends ProjectGoalRequest {
  readonly id: ProjectGoalRunId
  readonly phase: 'GATHER' | 'SIGNOFF' | 'PLAN' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ESCALATED' | 'EXITED'
  readonly control?: ProjectGoalControl | undefined
  readonly delivery?: ProjectGoalDelivery | undefined
  readonly controlRevision?: number | undefined
  /** Number of admitted user resumes; absent means the initial execution interval. */
  readonly resumeRevision?: number | undefined
  readonly budget?: ProjectGoalBudget | undefined
  readonly usage?: ProjectGoalUsage | undefined
  readonly budgetNotice?: ProjectGoalBudgetNotice | undefined
  readonly plan?: ProjectGoalPlanSubmission | undefined
  readonly review?: ProjectGoalReview | undefined
  /** Replaced plans retain approval evidence and task ownership, but grant no current execution or write authority. */
  readonly planHistory?: readonly {
    readonly plan: ProjectGoalPlanSubmission
    readonly review: ProjectGoalReview
    readonly taskIds: readonly ProjectTaskId[]
    readonly budget?: ProjectGoalBudget | undefined
    readonly retiredAt: number
  }[] | undefined
  readonly integration?: ProjectGoalIntegration | undefined
  /** Execution receipts are not acceptance verdicts; completed tasks still require collection. */
  readonly tasks?: readonly ProjectTaskState[] | undefined
  readonly progress?: readonly ProjectGoalProgress[] | undefined
  readonly outcomes?: readonly ProjectGoalOutcomeInput[] | undefined
  /** Fresh capability claims for the signed pool, captured into logged tool results or source input. */
  readonly capabilities?: readonly ProjectGoalModelCapability[] | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Terminal task evidence retained for its source conversation; human checks remain separate. */
export interface ProjectTaskCompletion {
  /** Independent automatic maintenance, never a human candidate decision. */
  readonly knowledgeAutomatic?: ProjectTaskKnowledgeAutomaticState | undefined
  readonly taskId: ProjectTaskId
  readonly status: Extract<ProjectTaskStatus, `closed-${string}`>
  /** Terminal timestamp from the admitted task turn; absent when it never reached a logged turn end. */
  readonly completedAt: number | null
  readonly summary: string
  readonly summaryTruncated: boolean
  readonly delivery: 'pending' | 'queued' | 'followed' | 'viewed' | 'ignored'
  /** Task-authored report, parsed before truncation; does not establish acceptance or authorize Git actions. */
  readonly wrapUpSummary?: ProjectTaskWrapUpSummary | undefined
  /** Retained primary research result; native file actions revalidate current project access. */
  readonly researchReport?: Pick<ProjectResearchReport, 'artifactId' | 'fileName' | 'summary'> | undefined
  readonly artifactOutput?: ProjectTaskArtifact | undefined
  /** Immutable coding-task report; original project files remain at their execution location. */
  readonly completionReport?: ProjectTaskCompletionReport | undefined
  /** Independent Brain review result; notification delivery and model prose cannot close it. */
  readonly knowledgeReview?: ProjectTaskKnowledgeReview | undefined
  /** Read-only discovery of reusable knowledge when the original Task selected no Brain pages. */
  readonly knowledgeDiscovery?: ProjectTaskKnowledgeDiscovery | undefined
  /** Human disposition of one discovered candidate; pending Brain writes retain exact retry identities. */
  readonly knowledgeDecision?: ProjectTaskKnowledgeDecision | undefined
  /** Earlier comparisons and their human decisions remain readable after an explicit refresh. */
  readonly knowledgeDiscoveryHistory?: readonly ProjectTaskKnowledgeHistoryEntry[] | undefined
  /** The most recent explicit refresh identity; a cold queued refresh never starts itself. */
  readonly knowledgeDiscoveryRefresh?: ProjectTaskKnowledgeRefresh | undefined
}

/** Opaque identity of one path observed in a completed Task's retained checkout. */
export type ProjectTaskOutputFileId = Branded<'ProjectTaskOutputFileId'>

/** One observed Task path; running documentation entries represent complete Harness tool writes, not published artifacts. */
export interface ProjectTaskOutputFile {
  readonly id: ProjectTaskOutputFileId
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly bytes: number | null
  readonly version: string | null
  readonly readable: boolean
}

/** Bounded checkout observation retained at success; an unavailable result never invents files. */
export interface ProjectTaskOutputInventory {
  readonly status: 'available' | 'unavailable'
  readonly observedAt: number | null
  readonly files: readonly ProjectTaskOutputFile[]
  readonly truncated: boolean
  readonly reason?: 'unsupported-isolation' | 'interrupted' | 'inspection-failed' | undefined
}

/** One completion-time coding output omitted from textual knowledge evidence. */
export interface ProjectTaskCodingOmission {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly bytes: number | null
  readonly version: string | null
  readonly reason: 'deleted' | 'unreadable' | 'non-text' | 'empty'
  /** Present when the exact omitted bytes were read but had no citable text. */
  readonly sha256?: string | undefined
}

/** One fresh, complete published documentation listing; older Tasks need no record migration. */
export interface ProjectTaskDocumentationInventory extends ProjectTaskOutputInventory {
  readonly artifactId: ArtifactRenditionId
  /** Exact root-version and full-tree digest captured together before any selected file read. */
  readonly directoryVersion: string
}

/** Transient complete-checkpoint observation of active coding, research or documentation execution; files may change before settlement. */
export interface ProjectTaskLiveOutput {
  readonly taskId: ProjectTaskId
  readonly sessionId: SessionId
  readonly observedAt: number
  readonly files: readonly ProjectTaskOutputFile[]
  readonly truncated: boolean
}

/** One on-demand read of the recorded version; a changed file is rejected as stale. */
export interface ProjectTaskOutputFileContent {
  readonly id: ProjectTaskOutputFileId
  readonly fileName: string
  readonly version: string
  readonly dataBase64: string
}

/** Brain writer identity retained without a knowledge-controller package dependency. */
export type ProjectTaskKnowledgeOperationId = Branded<'KnowledgeUpdateId'>

/** New confirmations choose automatic maintenance or preserve an explicit knowledge-write prohibition. */
export type ProjectTaskKnowledgeMaintenanceMode = 'automatic' | 'read-only'

/** Host-issued identity of one immutable confirmation permission. */
export type ProjectTaskKnowledgeAuthorizationId = Branded<'KnowledgeAutomaticAuthorizationId'>

/** Historical absence grants no automatic write authority. */
export interface ProjectTaskKnowledgeMaintenanceAuthorization {
  readonly mode: ProjectTaskKnowledgeMaintenanceMode
  readonly authorizationId: ProjectTaskKnowledgeAuthorizationId
}

/** Exact independent reviewer evidence frozen before an automatic Brain operation. */
export interface ProjectTaskKnowledgeAutomaticRequest {
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly authority: {
    readonly kind: 'task' | 'goal'
    readonly sourceSessionId: SessionId
    readonly taskSessionId: SessionId
    readonly taskId: ProjectTaskId
    readonly authorizationId: ProjectTaskKnowledgeAuthorizationId
    readonly goalRunId?: ProjectGoalRunId | undefined
    readonly planRequestId?: ProjectGoalRequestId | undefined
  }
  readonly reviewerSessionId: SessionId
  readonly resultSha256: string
  readonly candidateSha256: string
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly locationRevision: string | null
  readonly catalogSha256: string
  readonly sourceCoverage: 'complete' | 'incomplete'
  readonly sources: readonly { readonly sourceId: string
    readonly text: string }[]
  readonly sourceDispositions: readonly ProjectTaskKnowledgeSourceDisposition[]
  readonly comparedPages: readonly ProjectTaskKnowledgeComparedPage[]
  readonly titleSearch: { readonly query: string
    readonly hits: readonly { readonly path: string
      readonly version: string }[] }
  readonly topicSearch?: ProjectTaskKnowledgeAutomaticRequest['titleSearch'] | undefined
  readonly change: { readonly truth: string
    readonly summary: string
    readonly evidence: string } & (
    | { readonly kind: 'update'
      readonly documentId: ProjectTaskKnowledgeDocumentId
      readonly expectedVersion: string }
    | { readonly kind: 'create'
      readonly documentId: ProjectTaskKnowledgeDocumentId
      readonly title: string
      readonly category: 'decision'
      readonly tags: readonly string[] })
}

/** A provider never reports an uncertain receipt as an absent operation. */
export type ProjectTaskKnowledgeAutomaticResult =
  | { readonly status: 'applied'
    readonly receipt: ProjectTaskKnowledgeReceipt }
  | { readonly status: 'deferred'
    readonly reason: 'conflict' | 'source-incomplete' | 'catalog-changed' }

/** Read-only reconciliation of one frozen automatic operation. */
export type ProjectTaskKnowledgeAutomaticInspection = ProjectTaskKnowledgeAutomaticResult
  | { readonly status: 'absent' | 'unknown' }

/** Durable automatic intent and receipt; deferred candidates remain available to an AI without overwriting active knowledge. */
export type ProjectTaskKnowledgeAutomatic = {
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly resultSha256: string
  readonly candidateSha256: string
} & (
  | { readonly status: 'deferred'
    readonly reason: 'conflict' | 'source-incomplete' | 'catalog-changed' | 'unavailable' }
  | { readonly status: 'pending' | 'unknown'
    readonly project: ProjectTaskSessionProject
    readonly request: ProjectTaskKnowledgeAutomaticRequest }
  | { readonly status: 'applied'
    readonly project: ProjectTaskSessionProject
    readonly request: ProjectTaskKnowledgeAutomaticRequest
    readonly receipt: ProjectTaskKnowledgeReceipt })

/** Client receipt omits private Host paths and complete frozen source bodies. */
export type ProjectTaskKnowledgeAutomaticState = Pick<ProjectTaskKnowledgeAutomatic, 'candidateId' | 'resultSha256' | 'candidateSha256'> & (
  | { readonly status: 'deferred'
    readonly reason: 'conflict' | 'source-incomplete' | 'catalog-changed' | 'unavailable' }
  | { readonly status: 'pending' | 'unknown' }
  | { readonly status: 'applied'
    readonly receipt: ProjectTaskKnowledgeReceipt })

/** One user retry identity; an acknowledgement retry keeps the same UUID. */
export type ProjectTaskKnowledgeDiscoveryRequestId = Branded<'ProjectTaskKnowledgeDiscoveryRequestId'>
/** One Host-retained candidate identity; model text does not choose it. */
export type ProjectTaskKnowledgeCandidateId = Branded<'ProjectTaskKnowledgeCandidateId'>
/** Brain-relative page path selected by a person, validated again by the Brain owner. */
export type ProjectTaskKnowledgeDocumentId = Branded<'KnowledgeDocumentId'>

/** Complete original-project Brain evidence admitted for one tool-free Task discovery. */
export interface ProjectTaskKnowledgeDiscoveryEvidence {
  readonly locationRevision: string | null
  readonly pages: readonly {
    readonly path: string
    readonly version: string
    readonly title: string
    readonly status: string
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
  readonly searches: readonly {
    readonly query: string
    readonly hits: readonly {
      readonly path: string
      readonly version: string
    }[]
  }[]
}

/** Brain owner reads every indexed document or rejects incomplete evidence. */
export type ProjectTaskKnowledgeDiscoveryReader = (project: ProjectTaskSessionProject, query: string,
  limits: {
    readonly maxPages: number
    readonly maxInputBytes: number
  }, signal: AbortSignal,
) => Promise<ProjectTaskKnowledgeDiscoveryEvidence>

/** One complete, catalog-bound Brain slice for an independent logged reviewer call. */
export interface ProjectTaskKnowledgeDiscoveryBatch extends ProjectTaskKnowledgeDiscoveryEvidence {
  readonly catalogSha256: string
  readonly offset: number
  readonly totalPages: number
  readonly nextOffset: number | null
}

/** Read one bounded slice; a continuation must keep the first slice's catalog digest. */
export type ProjectTaskKnowledgeDiscoveryBatchReader = (project: ProjectTaskSessionProject, query: string,
  request: { readonly offset: number
    readonly expectedCatalogSha256?: string | undefined
    readonly maxPages: number
    readonly maxBytes: number }, signal: AbortSignal,
) => Promise<ProjectTaskKnowledgeDiscoveryBatch>

/** Host-owned failure stage; it never contains model output, provider diagnostics or project text. */
export type ProjectTaskKnowledgeDiscoveryDiagnostic = 'source-incomplete' | 'source-read-failed' | 'unsupported-result' | 'input-limit'
  | 'model-route-failed' | 'review-attempt-failed' | 'output-limit' | 'invalid-result'
  | 'evidence-changed' | 'retention-limit' | 'image-required' | 'visual-unreadable' | 'unknown'

/** Original PDF pages actually supplied to the completed Task reviewer, not proof of visual understanding. */
export interface ProjectTaskImportedPdfCoverage {
  readonly sourceId: string
  readonly name: string
  readonly pageCount: number
  readonly renderedPages: readonly number[]
  readonly omittedReason?: 'text-only-route' | 'page-limit' | 'byte-limit' | 'render-failed' | undefined
}

/** DOCX images actually supplied to the reviewer, not a Word layout or interpretation verdict. */
export type ProjectTaskImportedDocxCoverage = ProjectTaskReviewDocxVisualEvidence['coverage'] & {
  readonly sourceId: string
  readonly name: string
}

/** Safe subtype of an invalid Task reviewer result; no model output is retained. */
export type ProjectTaskKnowledgeInvalidResult = 'json-syntax' | 'schema' | 'compared-page-set'
  | 'compared-page-quote' | 'compared-page-relation' | 'new-page-topic-query'
  | 'unexpected-topic-query' | 'source-dispositions'

/** A review of one complete Brain page; `supports` means new evidence supports the old fact,
 * and `supersedes` means new evidence replaces the old fact. Absent relation marks a readable legacy verdict.
 */
export interface ProjectTaskKnowledgeComparedPage {
  readonly path: string
  readonly version: string
  readonly relation?: 'unrelated' | 'unknown' | 'duplicate' | 'conflict' | 'supports' | 'supersedes' | undefined
  readonly quote?: string | undefined
  readonly reason?: string | undefined
}

/** One completed page-review call, with its full request and response retained in the named Session. */
export interface ProjectTaskKnowledgeBatchReceipt {
  readonly offset: number
  readonly nextOffset: number | null
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly inputSha256: string
  readonly outputSha256: string
  readonly finding: string
  readonly comparedPages: readonly ProjectTaskKnowledgeComparedPage[]
}

/** Durable continuation for an unchanged Task result and Brain catalog. */
export interface ProjectTaskKnowledgeBatchProgress {
  readonly catalogSha256: string
  readonly locationRevision: string | null
  readonly totalPages: number
  readonly nextOffset: number | null
  readonly resultSha256: string
  readonly taskEvidenceSha256: string
  /** Complete non-text review evidence; a different route or image set starts a fresh page-review prefix. */
  readonly reviewEvidenceSha256?: string | undefined
  readonly titleSearch: { readonly query: string
    readonly hits: readonly { readonly path: string
      readonly version: string }[] }
  readonly batches: readonly ProjectTaskKnowledgeBatchReceipt[]
}

/** Durable Goal continuation tied to the signed report and one unchanged Brain catalog. */
export interface ProjectGoalKnowledgeBatchProgress {
  readonly catalogSha256: string
  readonly locationRevision: string | null
  readonly totalPages: number
  readonly nextOffset: number | null
  readonly reportSha256: string
  readonly resultSha256: string
  readonly titleSearch: { readonly query: string
    readonly hits: readonly { readonly path: string
      readonly version: string }[] }
  readonly batches: readonly ProjectTaskKnowledgeBatchReceipt[]
}

/** One model assessment of an exact Host-readable Task or Goal source; classification needs human review. */
export interface ProjectTaskKnowledgeSourceDisposition {
  readonly sourceId: string
  readonly disposition: 'current' | 'superseded' | 'unresolved' | 'not-relevant'
  readonly quote?: string | undefined
  readonly rationale: string
}

/** Fixed schema location and violated rule; array indexes and model-supplied keys are excluded. */
export interface ProjectTaskKnowledgeSchemaIssue {
  readonly field: 'result' | 'decision' | 'kind' | 'reason' | 'summary' | 'proposedTruth'
    | 'evidence' | 'comparedPages' | 'comparedPages[].path' | 'comparedPages[].version'
    | 'comparedPages[].relation' | 'comparedPages[].quote' | 'comparedPages[].reason' | 'topicQuery'
    | 'sourceDispositions'
  readonly rule: 'missing' | 'type' | 'empty' | 'invalid-value' | 'too-long' | 'unexpected-field'
}

/** Sealed reviewer outcome for a blocked discovery; no provider detail or model text is retained. */
export type ProjectTaskKnowledgeReviewFailure = 'turn-incomplete' | 'max-tokens' | 'empty-final-text'
  | 'result-persistence-failed' | 'unknown-execution-error'

/** Read-only result of one completed ordinary Task without a preselected Brain destination. */
export type ProjectTaskKnowledgeDiscovery = ProjectTaskKnowledgeDiscoveryProgress
  | ProjectTaskKnowledgeNoChangeVerdict | ProjectTaskKnowledgeCandidateVerdict

/** Queued, active or blocked ordinary Task comparison without a retained verdict. */
export type ProjectTaskKnowledgeDiscoveryProgress = { readonly status: 'queued' }
  | {
    readonly status: 'reviewing'
    readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly attemptSessionId: SessionId
    readonly attemptMessageId: MessageId
    /** Completed calls survive a failed later batch and can resume after source/catalog revalidation. */
    readonly batchProgress?: ProjectTaskKnowledgeBatchProgress | undefined
  }
  | {
    readonly status: 'blocked'
    readonly failure: 'unavailable' | 'interrupted' | 'missing-evidence' | 'input-unconfirmed'
    /** Optional because released blocked cards do not identify the failing operation. */
    readonly diagnostic?: ProjectTaskKnowledgeDiscoveryDiagnostic | undefined
    /** Optional for blocked cards written before invalid results were classified. */
    readonly invalidResult?: ProjectTaskKnowledgeInvalidResult | undefined
    /** Optional fixed detail for a field rejection; never contains a reviewer value or key. */
    readonly schemaIssue?: ProjectTaskKnowledgeSchemaIssue | undefined
    /** Optional for cards written before reviewer outcomes were classified. */
    readonly reviewFailure?: ProjectTaskKnowledgeReviewFailure | undefined
    readonly requestId?: ProjectTaskKnowledgeDiscoveryRequestId | undefined
    readonly attemptSessionId?: SessionId | undefined
    readonly attemptMessageId?: MessageId | undefined
    readonly batchProgress?: ProjectTaskKnowledgeBatchProgress | undefined
  }

/** Completed ordinary Task comparison that retains no new knowledge candidate. */
export interface ProjectTaskKnowledgeNoChangeVerdict {
  readonly status: 'no-change'
  /** Final cross-batch decision Session; absent on older verdicts. */
  readonly discoveryId?: SessionId | undefined
  readonly reason: string
  readonly pages: readonly string[]
  /** Absent on released verdicts; without these receipts a prior result cannot safely be re-reviewed. */
  readonly resultSha256?: string | undefined
  readonly taskEvidenceSha256?: string | undefined
  /** Complete completion-time coding file bodies were read at the reviewer request; absent means unproved. */
  readonly codingEvidenceSha256?: string | undefined
  readonly importedCoverage?: readonly ProjectTaskImportedPdfCoverage[] | undefined
  readonly importedDocxCoverage?: readonly ProjectTaskImportedDocxCoverage[] | undefined
  readonly artifactDirectory?: { readonly id: ArtifactRenditionId
    readonly version: string
    readonly digest: string
    readonly coverageSha256?: string | undefined } | undefined
  /** Present only when every captured Brain page received an explicit relation. */
  readonly comparisonFormat?: 'semantic-v1' | undefined
  readonly comparedPages: readonly ProjectTaskKnowledgeComparedPage[]
  /** Absent on released verdicts; new model verdicts retain a complete, quoted source review. */
  readonly sourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
  readonly reviewedAt: number
  /** Model inputs and outputs for each full-body page slice are retained in these Sessions. */
  readonly batchReviews?: readonly ProjectTaskKnowledgeBatchReceipt[] | undefined
}

/** Ordinary Task candidate with its exact source and completion evidence. */
export interface ProjectTaskKnowledgeCandidateVerdict extends KnowledgeCandidateContent {
  readonly status: 'candidate'
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly discoveryId: SessionId
  readonly resultSha256: string
  /** Optional for released candidates; absent evidence cannot authorize a new Brain write. */
  readonly taskEvidenceSha256?: string | undefined
  /** Digest of readable coding bodies and explicit omissions, not a stored source copy. */
  readonly codingEvidenceSha256?: string | undefined
  /** Missing coding content keeps this candidate draft-only, including after restart. */
  readonly codingOmissions?: readonly ProjectTaskCodingOmission[] | undefined
  readonly importedCoverage?: readonly ProjectTaskImportedPdfCoverage[] | undefined
  readonly importedDocxCoverage?: readonly ProjectTaskImportedDocxCoverage[] | undefined
}

/** Archived comparison and settled Brain receipts; a fresh comparison never rewrites prior conclusions. */
export type ProjectTaskKnowledgeHistoryEntry =
  | { readonly discovery: Extract<ProjectTaskKnowledgeDiscovery, { status: 'candidate' }>
    readonly decision?: ProjectTaskKnowledgeDecision | undefined
    readonly refreshRequestId: ProjectTaskKnowledgeDiscoveryRequestId }
  | { readonly kind: 'no-change'
    readonly discovery: Extract<ProjectTaskKnowledgeDiscovery, { status: 'no-change' }>
    readonly refreshRequestId: ProjectTaskKnowledgeDiscoveryRequestId }

/** One explicit new comparison of a completed ordinary Task. */
export type ProjectTaskKnowledgeRefresh =
  | { readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly sourceCandidateId: ProjectTaskKnowledgeCandidateId }
  | { readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly sourceNoChangeSha256: string }

/** The same candidate content and review receipts accompany distinct Task and Goal authority fields. */
export interface KnowledgeCandidateContent {
  /** Complete documentation tree bound to this candidate; absent on released candidates. */
  readonly artifactDirectory?: { readonly id: ArtifactRenditionId
    readonly version: string
    readonly digest: string
    readonly coverageSha256?: string | undefined } | undefined
  /** Complete non-plain-text coverage; absent on released candidates without a coverage receipt. */
  readonly artifactCoverage?: ProjectTaskArtifactCoverage | undefined
  /** Absent on released candidates; an active draft needs a complete verified matrix. */
  readonly sourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
  readonly candidateSha256: string
  readonly kind: 'existing-page' | 'new-page' | 'conflict'
  readonly summary: string
  readonly proposedTruth: string
  readonly evidence: string
  /** Complete source-subject search captured independently of the Task-title query for new pages. */
  readonly topicSearch?: { readonly query: string
    readonly hits: readonly { readonly path: string
      readonly version: string }[] } | undefined
  /** Absent on legacy read-only candidates. */
  readonly comparisonFormat?: 'semantic-v1' | undefined
  readonly comparedPages: readonly ProjectTaskKnowledgeComparedPage[]
  readonly reviewedAt: number
  readonly batchReviews?: readonly ProjectTaskKnowledgeBatchReceipt[] | undefined
}

/** Goal candidate with signed result authority; its enclosing discovery retains the report message. */
export interface ProjectGoalKnowledgeCandidateVerdict extends KnowledgeCandidateContent {
  readonly status: 'candidate'
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly discoveryId: SessionId
  readonly goalRunId: ProjectGoalRunId
  readonly planRequestId: ProjectGoalRequestId
  /** SHA-256 of the complete retained research report or fixed coding-result evidence. */
  readonly reportSha256: string
  readonly resultSha256: string
  readonly catalogSha256?: string | undefined
}

/** Goal research, coding or documentation comparison; it grants no Brain destination or write permission. */
export type ProjectGoalKnowledgeDiscovery = { readonly reportMessageId: MessageId } & (
  | { readonly status: 'queued'
    readonly batchProgress?: ProjectGoalKnowledgeBatchProgress | undefined }
  | { readonly status: 'reviewing'
    readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly attemptSessionId: SessionId
    readonly attemptMessageId: MessageId
    readonly batchProgress?: ProjectGoalKnowledgeBatchProgress | undefined }
  | { readonly status: 'blocked'
    readonly failure: 'unavailable' | 'interrupted' | 'missing-evidence'
    /** Optional because released Goal reports do not retain a safe failure stage. */
    readonly diagnostic?: ProjectTaskKnowledgeDiscoveryDiagnostic | undefined
    /** Optional sealed outcome for review-attempt-failed; older Goal receipts lack this detail. */
    readonly reviewFailure?: ProjectTaskKnowledgeReviewFailure | undefined
    readonly requestId?: ProjectTaskKnowledgeDiscoveryRequestId | undefined
    readonly attemptSessionId?: SessionId | undefined
    readonly attemptMessageId?: MessageId | undefined
    readonly batchProgress?: ProjectGoalKnowledgeBatchProgress | undefined }
  | ProjectGoalKnowledgeNoChangeVerdict
  | ProjectGoalKnowledgeCandidateVerdict
)

/** Completed Goal comparison with unchanged knowledge and signed result evidence. */
export interface ProjectGoalKnowledgeNoChangeVerdict {
  readonly status: 'no-change'
  /** Final cross-batch reviewer Session; absent on older verdicts and fixed empty coding diffs. */
  readonly discoveryId?: SessionId | undefined
  /** Exact Brain index digest; absent on older aggregate verdicts. */
  readonly catalogSha256?: string | undefined
  /** SHA-256 of the complete retained research report or fixed coding-result evidence. */
  readonly reportSha256: string
  readonly resultSha256: string
  readonly reason: string
  readonly comparisonFormat?: 'semantic-v1' | undefined
  readonly comparedPages: readonly ProjectTaskKnowledgeComparedPage[]
  /** Absent on released verdicts and deterministic empty-diff results. */
  readonly sourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
  readonly reviewedAt: number
  readonly batchReviews?: readonly ProjectTaskKnowledgeBatchReceipt[] | undefined
}

/** Exact signed Goal result and read-only candidate selected for one human knowledge decision. */
export interface ProjectGoalKnowledgeDecisionSubject {
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly planRequestId: ProjectGoalRequestId
  readonly reportMessageId: MessageId
  readonly reportSha256: string
  readonly discoveryId: SessionId
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly resultSha256: string
  readonly candidateSha256: string
}

/** Human Goal knowledge decision; ordinary Task card decisions cannot create this state. */
export interface ProjectGoalKnowledgeDecision {
  readonly subject: ProjectGoalKnowledgeDecisionSubject
  readonly decision: ProjectTaskKnowledgeDecision
  /** Durable no-write finding for the retained UUID; a new human choice may replace only this attempt. */
  readonly prewriteConflict?: {
    readonly kind: 'decision' | 'publication'
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly observedAt: number
  } | undefined
  /** Earlier provably unwritten attempts retained when the human selects a new UUID. */
  readonly abandonedOperations?: readonly {
    readonly kind: 'decision' | 'publication'
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly observedAt: number
  }[] | undefined
}

/** Previous signed verdict and its original human action retained before a fresh comparison. */
export type ProjectGoalKnowledgeHistoryEntry =
  | { readonly discovery: Extract<ProjectGoalKnowledgeDiscovery, { status: 'candidate' }>
    readonly decision: ProjectGoalKnowledgeDecision }
  | { readonly kind: 'no-change'
    readonly discovery: Extract<ProjectGoalKnowledgeDiscovery, { status: 'no-change' }>
    readonly refreshRequestId: ProjectTaskKnowledgeDiscoveryRequestId }

/** Exact human UUID that admitted a fresh comparison after a pre-write conflict. */
export type ProjectGoalKnowledgeRefresh =
  | { readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly sourceCandidateId: ProjectTaskKnowledgeCandidateId }
  | { readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
    readonly sourceNoChangeSha256: string }

/** First human action on a still-current signed Goal result candidate. */
export interface ProjectGoalKnowledgeDecisionRequest {
  readonly subject: ProjectGoalKnowledgeDecisionSubject
  readonly choice: ProjectTaskKnowledgeDecisionRequest
}

/** Separate human confirmation of a complete Goal-held draft and active catalog. */
export interface ProjectGoalKnowledgePublishRequest {
  readonly subject: ProjectGoalKnowledgeDecisionSubject
  readonly publication: ProjectTaskKnowledgePublishRequest
}

/** Separate human disposition of a changed Goal publication's observed page and catalog. */
export interface ProjectGoalKnowledgeAcknowledgeRequest {
  readonly subject: ProjectGoalKnowledgeDecisionSubject
  readonly acknowledgement: ProjectTaskKnowledgeAcknowledgeRequest
}

/** Optional human corrections retained under the exact decision or publication gesture. */
export interface KnowledgeHumanSourceReview {
  readonly reviewedSummary?: string | undefined
  readonly reviewedTruth?: string | undefined
  readonly reviewedEvidence?: string | undefined
  readonly reviewedSourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
}

/** Explicit human choice for one immutable Task discovery candidate. */
export type ProjectTaskKnowledgeDecisionRequest = {
  readonly decisionId: ProjectTaskKnowledgeOperationId
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly resultSha256: string
  readonly candidateSha256: string
} & (
  | { readonly action: 'dismiss'
    readonly reason: string }
  | ({ readonly action: 'propose-existing'
    readonly path: ProjectTaskKnowledgeDocumentId
    readonly expectedVersion: string
  } & KnowledgeHumanSourceReview)
  | ({ readonly action: 'save-draft'
    readonly path: ProjectTaskKnowledgeDocumentId
    readonly title: string
    readonly category: 'project' | 'concept' | 'decision' | 'person' | 'reference'
    readonly tags: readonly string[]
    readonly kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
  } & KnowledgeHumanSourceReview)
)

/** Separate human confirmation of the exact held draft and active catalog shown by review. */
export interface ProjectTaskKnowledgePublishRequest {
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly draftOperationId: ProjectTaskKnowledgeOperationId
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  readonly reviewedPages: readonly ProjectTaskKnowledgePageJudgment[]
  /** Complete human correction for a saved draft; retained with this publication UUID. */
  readonly reviewedSourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
}

/** Human relation to one versioned active page in the reviewed Brain catalog. */
export interface ProjectTaskKnowledgePageJudgment {
  readonly path: ProjectTaskKnowledgeDocumentId
  readonly title: string
  readonly version: string
  readonly relation: 'distinct' | 'duplicate' | 'conflict' | 'unknown'
}

/** One full active-page read retained under the exact held draft and catalog. */
export interface ProjectTaskKnowledgeCatalogReadReceipt {
  readonly draftVersion: string
  readonly activeIndexDigest: string
  readonly path: ProjectTaskKnowledgeDocumentId
  readonly title: string
  readonly version: string
  readonly bodySha256: string
}

/** Version-bound request for one active document in a Task or Goal publication review. */
export interface ProjectTaskKnowledgeCatalogReadRequest {
  readonly expectedDraftVersion: string
  readonly expectedActiveIndexDigest: string
  readonly path: ProjectTaskKnowledgeDocumentId
  readonly expectedPageVersion: string
}

/** A changed document/catalog is never retained as a publication read receipt. */
export type ProjectTaskKnowledgeCatalogRead = { readonly kind: 'changed' }
  | { readonly kind: 'page' | 'root'
    readonly id: ProjectTaskKnowledgeDocumentId
    readonly title: string
    readonly status: 'active'
    readonly version: string
    readonly body: string }

/** Brain receipt retained after a matching UUID write or recovered on exact retry. */
export interface ProjectTaskKnowledgeReceipt {
  readonly documentId: ProjectTaskKnowledgeDocumentId
  readonly version: string
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly disposition: 'written' | 'already-applied'
}

/** Post-publication comparison of other active pages at the time of observation. */
export type ProjectTaskKnowledgePublicationReview =
  | { readonly status: 'verified'
    readonly observedActiveIndexDigest: string
    readonly currentPageVersion: string }
  | { readonly status: 'required'
    readonly reason: 'active-catalog-changed'
    readonly observedActiveIndexDigest: string
    readonly currentPageVersion: string }
  | { readonly status: 'unknown'
    readonly reason: 'catalog-unavailable' | 'receipt-recovered' | 'receipt-unconfirmed' }

/** Human disposition of a post-publication directory change at one observed page/catalog revision. */
export interface ProjectTaskKnowledgePublicationAcknowledgement {
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly publicationOperationId: ProjectTaskKnowledgeOperationId
  readonly expectedPageVersion: string
  readonly observedActiveIndexDigest: string
  readonly disposition: 'keep-published' | 'revise-needed'
  readonly note: string
  readonly acknowledgedAt: number
}

/** Separate user gesture for a required post-publication reconciliation. */
export type ProjectTaskKnowledgeAcknowledgeRequest = Omit<ProjectTaskKnowledgePublicationAcknowledgement, 'acknowledgedAt'>

/** Immutable human decision and its separately recoverable Brain publication receipts. */
export type ProjectTaskKnowledgeDecision = {
  readonly decisionId: ProjectTaskKnowledgeOperationId
  readonly candidateId: ProjectTaskKnowledgeCandidateId
  readonly resultSha256: string
  readonly candidateSha256: string
} & (
  | { readonly status: 'dismissed'
    readonly reason: string
    readonly decidedAt: number }
  | ({ readonly status: 'proposal-pending' | 'proposal-saved'
    readonly path: ProjectTaskKnowledgeDocumentId
    readonly expectedVersion: string
    readonly receipt?: ProjectTaskKnowledgeReceipt | undefined } & KnowledgeHumanSourceReview)
  | ({ readonly status: 'draft-pending' | 'draft-saved'
    readonly path: ProjectTaskKnowledgeDocumentId
    readonly title: string
    readonly category: 'project' | 'concept' | 'decision' | 'person' | 'reference'
    readonly tags: readonly string[]
    readonly kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
    readonly draftOperationId: ProjectTaskKnowledgeOperationId
    /** Host-retained full reads; legacy decisions omit them and cannot newly publish against active documents. */
    readonly catalogPageReads?: readonly ProjectTaskKnowledgeCatalogReadReceipt[] | undefined
    readonly receipt?: ProjectTaskKnowledgeReceipt | undefined
    readonly publication?: {
      readonly status: 'pending' | 'published'
      readonly operationId: ProjectTaskKnowledgeOperationId
      readonly expectedDraftVersion: string
      readonly expectedActiveIndexDigest: string
      /** Absent only on released publication receipts before page judgments existed. */
      readonly reviewedPages?: readonly ProjectTaskKnowledgePageJudgment[] | undefined
      /** Human correction supplied at publication, after saving the draft. */
      readonly reviewedSourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
      readonly receipt?: ProjectTaskKnowledgeReceipt | undefined
      readonly review?: ProjectTaskKnowledgePublicationReview | undefined
      readonly acknowledgement?: ProjectTaskKnowledgePublicationAcknowledgement | undefined
    } | undefined } & KnowledgeHumanSourceReview)
)

/** File-owned Task draft hold; its fields are rechecked inside the Brain writer lock. */
export interface ProjectTaskKnowledgePublicationHold {
  readonly version: 1
  readonly workspaceId: WorkspaceId
  readonly taskId: ProjectTaskId
  readonly discoveryId: string
  readonly resultSha256: string
  readonly candidateSha256: string
  readonly decisionId: string
  readonly draftOperationId: ProjectTaskKnowledgeOperationId
}

/** File-owned Goal draft hold; Brain checks every field before an independent publication. */
export interface ProjectGoalKnowledgePublicationHold {
  readonly version: 1
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly planRequestId: ProjectGoalRequestId
  readonly taskId: ProjectTaskId
  readonly reportSha256: string
  readonly candidateSha256: string
  readonly decisionId: ProjectTaskKnowledgeOperationId
  readonly draftOperationId: ProjectTaskKnowledgeOperationId
}

/** Complete human-visible held draft plus the active catalog snapshot required for publication. */
export interface ProjectTaskKnowledgeDraftReview {
  readonly document: {
    readonly id: ProjectTaskKnowledgeDocumentId
    readonly version: string
    readonly title: string
    readonly category: string | null
    readonly tags: readonly string[]
    readonly body: string
    readonly markdown: string
    readonly timeline: readonly ProjectTaskKnowledgeDiscoveryEvidence['pages'][number]['timeline'][number][]
  }
  readonly activeIndexDigest: string
  readonly activePageCount: number
  readonly activePages: readonly {
    readonly id: ProjectTaskKnowledgeDocumentId
    readonly title: string
    readonly version: string
  }[]
}

/** Stable current page and active catalog read before a human resolves a changed publication. */
export type ProjectTaskKnowledgePublicationInspection =
  | { readonly status: 'unknown'
    readonly reason: 'catalog-unavailable' | 'receipt-unconfirmed' }
  | {
    readonly status: 'ready'
    readonly review: Extract<ProjectTaskKnowledgePublicationReview, { status: 'verified' | 'required' }>
    readonly currentPage: { readonly id: ProjectTaskKnowledgeDocumentId
      readonly title: string
      readonly body: string
      readonly version: string }
    readonly activePages: readonly { readonly id: ProjectTaskKnowledgeDocumentId
      readonly title: string
      readonly version: string }[]
  }

/** Shared held-draft operations; callers retain their distinct Task or Goal publication hold. */
export interface KnowledgeDraftWriter<Hold> extends KnowledgeDraftPublicationWriter<Hold>,
  KnowledgePublicationInspectionWriter<Hold> {
  createDraft(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId, request: {
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly title: string
    readonly status: 'draft'
    readonly category: 'project' | 'concept' | 'decision' | 'person' | 'reference'
    readonly tags: readonly string[]
    readonly truth: string
    readonly kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
    readonly summary: string
    readonly source: string
    readonly evidence: string
  }, hold: Hold, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<ProjectTaskKnowledgeReceipt>
  reviewDraft(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId,
    hold: Hold, signal: AbortSignal): Promise<ProjectTaskKnowledgeDraftReview>
  readCatalogPage(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId,
    hold: Hold, request: ProjectTaskKnowledgeCatalogReadRequest,
    signal: AbortSignal): Promise<ProjectTaskKnowledgeCatalogRead>
}

/** Publish or review one held draft against the exact active catalog. */
export interface KnowledgeDraftPublicationWriter<Hold> {
  publishDraft(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId, request: {
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly expectedVersion: string
    readonly status: 'active'
    readonly reason: string
    readonly source: string
    readonly evidence: string
  }, hold: Hold, expectedActiveIndexDigest: string, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<ProjectTaskKnowledgeReceipt>
  reviewPublication(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId, request: {
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly expectedVersion: string
    readonly status: 'active'
    readonly reason: string
    readonly source: string
    readonly evidence: string
  }, hold: Hold, expectedActiveIndexDigest: string,
    signal: AbortSignal): Promise<ProjectTaskKnowledgePublicationReview>
}

/** Inspect a held publication without repeating its write. */
export interface KnowledgePublicationInspectionWriter<Hold> {
  inspectPublication(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId, request: {
    readonly operationId: ProjectTaskKnowledgeOperationId
    readonly expectedVersion: string
    readonly status: 'active'
    readonly reason: string
    readonly source: string
    readonly evidence: string
  }, hold: Hold, expectedActiveIndexDigest: string,
    signal: AbortSignal): Promise<ProjectTaskKnowledgePublicationInspection>
}

/** Optional automatic maintenance requires its own request and recovery identity. */
export interface KnowledgeAutomaticWriter {
  /** Optional on older providers; absence never grants a human writer automatic authority. */
  applyAutomatic?(project: ProjectTaskSessionProject, request: ProjectTaskKnowledgeAutomaticRequest,
    signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>): Promise<ProjectTaskKnowledgeAutomaticResult>
  /** Recover the exact durable UUID without repeating a write when its outcome is unknown. */
  inspectAutomatic?(project: ProjectTaskSessionProject, request: ProjectTaskKnowledgeAutomaticRequest,
    signal: AbortSignal): Promise<ProjectTaskKnowledgeAutomaticInspection>
}

/** Complete existing-page proposal text shared by the Task and Goal human writers. */
export interface KnowledgeExistingProposal {
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly expectedVersion: string
  readonly truth: string
  readonly summary: string
  readonly evidence: string
}

/** Brain writer methods are Host-only; Task never acquires a generic conversation write capability. */
export interface ProjectTaskKnowledgeDiscoveryWriter extends KnowledgeDraftWriter<ProjectTaskKnowledgePublicationHold>,
  KnowledgeAutomaticWriter {
  proposeExisting(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId,
    taskId: ProjectTaskId, request: KnowledgeExistingProposal & { readonly source: string }, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<ProjectTaskKnowledgeReceipt>
}

/** Host-only Goal human writer; it does not expose Brain writes to a Goal agent or ordinary Task card. */
export interface ProjectGoalKnowledgeDiscoveryWriter extends KnowledgeDraftWriter<ProjectGoalKnowledgePublicationHold>,
  KnowledgeAutomaticWriter {
  proposeExisting(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId,
    taskId: ProjectTaskId, request: KnowledgeExistingProposal, subject: ProjectGoalKnowledgeDecisionSubject, signal: AbortSignal,
    beforePublish: (retry: boolean) => Promise<void>): Promise<ProjectTaskKnowledgeReceipt>
  inspectOperation(project: ProjectTaskSessionProject, documentId: ProjectTaskKnowledgeDocumentId,
    operation: ProjectGoalKnowledgeOperation, failure: unknown, signal: AbortSignal): Promise<
    | { readonly status: 'applied'; readonly receipt: ProjectTaskKnowledgeReceipt }
    | { readonly status: 'absent' }
    | { readonly status: 'unknown' }>
}

/** Exact Goal Brain operation used to reconcile an in-process pre-write refusal. */
export type ProjectGoalKnowledgeOperation =
  | { readonly kind: 'proposal'
    readonly request: Parameters<ProjectGoalKnowledgeDiscoveryWriter['proposeExisting']>[3]
    readonly subject: ProjectGoalKnowledgeDecisionSubject
    readonly taskId: ProjectTaskId }
  | { readonly kind: 'draft'
    readonly request: Parameters<ProjectGoalKnowledgeDiscoveryWriter['createDraft']>[2]
    readonly hold: ProjectGoalKnowledgePublicationHold }
  | { readonly kind: 'publication'
    readonly request: Parameters<ProjectGoalKnowledgeDiscoveryWriter['publishDraft']>[2]
    readonly hold: ProjectGoalKnowledgePublicationHold
    readonly expectedActiveIndexDigest: string }

/** Persisted source-conversation knowledge review of one completed ordinary Task. */
export type ProjectTaskKnowledgeReview =
  | { readonly status: 'needs-review' }
  | { readonly status: 'reviewing'
    readonly attemptMessageId: MessageId }
  | { readonly status: 'blocked'
    readonly failure: 'missing-evidence' | 'interrupted' | 'unavailable' | 'input-unconfirmed'
    readonly attemptMessageId?: MessageId | undefined }
  | { readonly status: 'reviewed-no-change'
    readonly pages: readonly string[]
    readonly reviewedAt: number }
  | { readonly status: 'updated'
    readonly pages: readonly string[]
    readonly operations: readonly { readonly page: string
      readonly operationId: ProjectTaskKnowledgeOperationId }[]
    readonly reviewedAt: number }

/** Reported changes, performed checks and inert commit suggestion, independently preserved from raw text. */
export interface ProjectTaskWrapUpSummary {
  readonly whatChanged: readonly string[]
  readonly verificationDone: readonly string[]
  readonly suggestedCommit: { readonly title: string
    readonly body: string }
  readonly truncated: boolean
}

/** Immutable outcome displayed at its source conversation's admitted follow-up input. */
export interface ProjectTaskCompletionNotice extends Omit<ProjectTaskCompletion, 'delivery' | 'knowledgeReview'> {
  readonly title: string
  /** Fixed-commit changes captured before Goal result delivery; absent when not collected. */
  readonly files?: readonly ProjectTaskFileStat[] | undefined
}

/** One changed Git path; binary changes have no textual line counts. */
export interface ProjectTaskFileStat {
  readonly path: string
  readonly added: number | null
  readonly removed: number | null
}

/** Read-only comparison of a collected task's fixed base and result commits. */
export interface ProjectGoalTaskDiff {
  readonly files: readonly ProjectTaskFileStat[]
  readonly patch: string
}

/** Complete UTF-8 bodies selected from one Goal Task's fixed commits. */
export interface ProjectGoalCodingFiles {
  readonly format: 'goal-coding-files-v1'
  readonly baseCommit: ProjectGitCommitId
  readonly taskCommit: ProjectGitCommitId
  readonly files: readonly {
    readonly path: string
    readonly change: 'added' | 'modified' | 'deleted'
    /** Blob OID from the task commit, or from the base commit for a deletion. */
    readonly version: string
    readonly bytes: number
    readonly sha256: string
    readonly text: string
  }[]
  /** Digest of the complete ordered file manifest, excluding this field. */
  readonly sha256: string
}

/** Read-only direct-execution preflight; Git failures reject instead of returning a state. */
export type ProjectTaskDirectWorkspaceState = 'clean' | 'dirty' | 'not-git'

/** Explicit execution directory selection; worktrees start from committed HEAD, not dirty source files. */
export interface ProjectTaskProposal extends ProjectTaskKnowledgeSelection {
  readonly id: ProjectTaskId
  readonly title: string
  readonly description: string
  readonly acceptanceCriteria: readonly string[]
  readonly verifySteps: readonly string[]
  /** Task context only; listed paths grant neither file access nor permission to edit. */
  readonly affectedFiles?: readonly string[] | undefined
  readonly isolation: 'direct' | 'worktree' | 'tempdir'
  /** Task-local route; omission uses the configured default at dispatch. */
  readonly model?: ModelSelection | undefined
  /** Research tasks require temporary isolation and their original conversation; checklists remain manual. */
  readonly research?: { readonly sourceSessionId: SessionId } | undefined
  /** Worker writes private output; an optional confirmed trace is handled by the source conversation after success. */
  readonly artifact?: {
    readonly sourceSessionId: SessionId
    readonly type: 'docs'
    readonly trace?: { readonly page: string
      readonly framework: string } | undefined
  } | undefined
}

/** Retained complete documentation project owned by the originating conversation. */
export interface ProjectTaskArtifact {
  readonly artifactId: ArtifactRenditionId
  readonly directoryName: string
  readonly type: 'docs'
}

/** A successful coding Task's retained report, not acceptance or a copy of changed files. */
export interface ProjectTaskCompletionReport {
  readonly artifactId: ArtifactRenditionId
  readonly fileName: string
  /** Immutable generated bytes and location, when retained by this version. */
  readonly contentSha256?: string | undefined
  readonly projectRelativePath?: string | undefined
}

/** A retained source-conversation report; its existence does not assert factual accuracy. */
export interface ProjectResearchReport {
  readonly artifactId: ArtifactRenditionId
  readonly fileName: string
  readonly recovered: boolean
  /** Digest of the published Markdown bytes; absent on reports retained before this field existed. */
  readonly contentSha256?: string | undefined
  /** Every collected flat output; absent on report-only stored records. */
  readonly outputs?: readonly { readonly artifactId: ArtifactRenditionId
    readonly fileName: string }[] | undefined
  /** Private task preview, not a visible artifact-list entry. */
  readonly preview?: ArtifactPreviewRef | undefined
  readonly summary: {
    readonly title?: string | undefined
    readonly confidence?: 'high' | 'medium' | 'low' | undefined
    /** Top-level reported list entries; null when absent, ambiguous or written as prose. */
    readonly sourceCount: number | null
    /** Top-level reported list entries; explicit None is zero, unextractable text is null. */
    readonly gapCount: number | null
  }
}

/** Execution success does not assert that the human verification checklist passed. */
export type ProjectTaskStatus = 'draft' | 'dispatched' | 'running' | 'opened-terminal'
  | 'closed-success' | 'closed-failed' | 'closed-cancelled'

/** Reviewer routes never grant project writes or inherit the executor's permissions. */
export type ProjectTaskReviewSelection =
  | { readonly runtime: 'harness'
    readonly model?: ModelSelection | undefined }
  | { readonly runtime: 'codex'
    readonly model?: string | undefined
    readonly reasoningEffort?: string | undefined }
  | { readonly runtime: 'claude'
    readonly model?: string | undefined
    readonly effort?: ProjectTaskClaudeSelection['effort'] }

/** Explicit manual or execution-owned review authority; reviewers retain read-only project access. */
export interface ProjectTaskReviewPolicy {
  readonly selection: ProjectTaskReviewSelection
  readonly allowFallback: boolean
}

/** Executor guidance within existing permissions; these choices do not certify test or review outcomes. */
export interface ProjectTaskPostSteps {
  readonly autoRunTests: boolean
  readonly autoFix: boolean
}

/** One confirmation freezes the executor, optional reviewer and independent testing/fix guidance. */
export interface ProjectTaskCodingConfirmation {
  /** Explicit confirmation choice, independent of executor and its project permissions. */
  readonly knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode | undefined
  readonly execution:
    | { readonly runtime: 'harness'
      readonly model?: ModelSelection | undefined
      /** Task-local preset; omission uses the dispatch default and never changes global settings. */
      readonly agentPreset?: AgentPresetRow['id'] | undefined }
    | { readonly runtime: 'codex'
      readonly selection: ProjectTaskCodexSelection }
    | { readonly runtime: 'claude'
      readonly selection: ProjectTaskClaudeSelection }
  readonly review?: ProjectTaskReviewPolicy | undefined
  /** Omission retains review-only confirmation behavior; new UI confirmations always choose both flags. */
  readonly postSteps?: ProjectTaskPostSteps | undefined
  /** Original imports explicitly selected by the person confirming this Task; never model-proposed paths. */
  readonly reviewSources?: readonly ProjectTaskReviewSourceSelection[] | undefined
}

/** Frozen original/conversion digests; the independent reviewer re-reads exact imports after Task completion. */
export interface ProjectTaskReviewSourceReceipt extends ProjectTaskReviewSourceSelection {
  readonly sourceSha256: string
  readonly textSha256: string
  readonly textBytes: number
}

/** One task-owned review call, distinct from each model attempt and its audit Session. */
export type ProjectTaskReviewTicket = Branded<'ProjectTaskReviewTicket'>

/** Reviewer findings are model assessments, not proof of tests or acceptance. */
export interface ProjectTaskReviewResult {
  readonly status: 'passed' | 'issues'
  readonly summary: string
  readonly issues: readonly {
    readonly severity: 'critical' | 'warning' | 'nit'
    readonly file: string
    readonly line?: number | undefined
    readonly message: string
  }[]
}

/** Every primary or fallback attempt retains a separate append-only Session. */
export interface ProjectTaskReviewCall {
  readonly id: ProjectTaskReviewTicket
  readonly number: number
  readonly status: 'pending' | 'passed' | 'issues' | 'no-diff' | 'failed' | 'interrupted' | 'cancelled'
  readonly selection: ProjectTaskReviewSelection
  /** Absent for manual calls; an execution cannot poll another owner's review. */
  readonly origin?: { readonly kind: 'execution'
    readonly sessionId: SessionId } | undefined
  /** Calls admitted before manual fallback consent may omit this; new calls retain the decision. */
  readonly allowFallback?: boolean | undefined
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  readonly result?: ProjectTaskReviewResult | undefined
  readonly failure?: string | undefined
  readonly fallbackUsed?: boolean | undefined
  readonly attempts: readonly {
    readonly sessionId: SessionId
    readonly selection: ProjectTaskReviewSelection
    readonly status: 'pending' | 'completed' | 'failed'
    readonly failure?: string | undefined
  }[]
}

/** Call limits are retained with the first admission; cold reads never restart model work. */
export interface ProjectTaskReviewState {
  readonly maxCalls: number
  readonly calls: readonly ProjectTaskReviewCall[]
}

/** Durable task metadata; Session logs own detailed execution input, tools and outputs. */
export interface ProjectTaskState extends ProjectTaskProposal {
  readonly knowledgeMaintenanceAuthorization?: ProjectTaskKnowledgeMaintenanceAuthorization | undefined
  /** Only fresh direct confirmations may select a new policy; accepted cards retain their decision. */
  readonly reviewConfigurable?: boolean | undefined
  readonly automaticReview?: ProjectTaskReviewPolicy | undefined
  readonly postSteps?: ProjectTaskPostSteps | undefined
  readonly reviewSources?: readonly ProjectTaskReviewSourceReceipt[] | undefined
  /** False for tasks without a captured Git baseline or with unsupported execution ownership. */
  readonly reviewAvailable?: boolean | undefined
  readonly review?: ProjectTaskReviewState | undefined
  /** Source-owned review of the terminal result; absent before completion or without selected Brain pages. */
  readonly knowledgeReview?: ProjectTaskKnowledgeReview | undefined
  /** Current no-reference discovery and bounded self-report; absent without source-project access. */
  readonly knowledgeCompletion?: {
    readonly sourceSessionId: SessionId
    /** Frozen Task self-report, not the complete research body, output files or acceptance evidence. */
    readonly reportedResult: Pick<ProjectTaskCompletion, 'summary' | 'summaryTruncated'>
    readonly discovery: ProjectTaskKnowledgeDiscovery
    readonly automatic?: ProjectTaskKnowledgeAutomaticState | undefined
    readonly decision?: ProjectTaskKnowledgeDecision | undefined
    readonly history?: readonly ProjectTaskKnowledgeHistoryEntry[] | undefined
    readonly refresh?: ProjectTaskKnowledgeRefresh | undefined
  } | undefined
  /** Confirmed Claude init identity is present only after native startup. */
  readonly claude?: ProjectTaskClaudeSelection & { readonly sessionId?: ProjectTaskClaudeSessionId | undefined } | undefined
  /** Native execution selection and retained thread, separate from the proposal's Harness route. */
  readonly codex?: ProjectTaskCodexSelection & { readonly threadId?: ProjectTaskCodexThreadId | undefined } | undefined
  readonly status: ProjectTaskStatus
  /** OS acknowledgement is not native execution, task completion, or verification. */
  readonly terminal?: { readonly phase: 'prepared' | 'opened' | 'unconfirmed'
    readonly selection: ProjectTaskTerminalSelection } | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly verifyCheckedIndices: readonly number[]
  readonly sessionId: SessionId | null
  readonly closedReason: string | null
  /** Safe native diagnostic for a failed Codex or Claude Task, independent of the machine close reason. */
  readonly nativeFailure?: ProjectTaskNativeFailure | undefined
  readonly usage?: ProjectTaskUsage | undefined
  readonly researchReport?: ProjectResearchReport | undefined
  readonly artifactOutput?: ProjectTaskArtifact | undefined
  /** Present only after successful publication of a coding Task's report. */
  readonly completionReport?: ProjectTaskCompletionReport | undefined
  /** Files observed at completion in a retained checkout; bodies are read only by explicit selection. */
  readonly outputInventory?: ProjectTaskOutputInventory | undefined
  /** Allocated checkout retained after completion; paths are relative to the original project. */
  readonly executionWorkspace?: ProjectGitWorkspace | undefined
  /** Goal ownership; gathering and capability research grant no sub-goal acceptance. */
  readonly goal?: {
    readonly runId: ProjectGoalRunId
    readonly subGoalId?: ProjectSubGoalId | undefined
    readonly gather?: true | undefined
    readonly probe?: Pick<ModelSelection, 'provider' | 'model'> | undefined
  } | undefined
  /** Retained integration progress, independent of execution status and verification. */
  readonly goalMerge?: ProjectGoalTaskMerge | undefined
  readonly goalReports?: readonly ProjectGoalReport[] | undefined
  /** Read-only, tool-free comparison of an approved Goal Task result against complete Brain evidence. */
  readonly goalKnowledgeDiscovery?: ProjectGoalKnowledgeDiscovery | undefined
  readonly goalKnowledgeAutomatic?: ProjectTaskKnowledgeAutomaticState | undefined
  /** Human Goal candidate decision and its independently recoverable Brain receipts. */
  readonly goalKnowledgeDecision?: ProjectGoalKnowledgeDecision | undefined
  readonly goalKnowledgeHistory?: readonly ProjectGoalKnowledgeHistoryEntry[] | undefined
  readonly goalKnowledgeRefresh?: ProjectGoalKnowledgeRefresh | undefined
}

/** Immutable conversation proposal, retained before any execution task exists. */
export interface ProjectTaskCardRequest {
  readonly id: ProjectTaskCardId
  readonly sourceSessionId: SessionId
  /** Durable native or PTC tool correlation; absent for manually posted proposals. */
  readonly sourceCallId?: ToolCallId | undefined
  readonly draft: Omit<ProjectTaskProposal, 'id'>
}

/** Acceptance records a decision, not successful dispatch or task completion. */
export type ProjectTaskCardState = ProjectTaskCardRequest & {
  /** Registered execution destination, independent of the source conversation's own project. */
  readonly workspaceId: WorkspaceId
  readonly createdAt: number
  readonly updatedAt: number
  readonly completion?: ProjectTaskCompletion | undefined
} & (
  | { readonly status: 'pending' | 'dismissed'
    readonly taskId: null }
  | { readonly status: 'accepted'
    readonly knowledgeMaintenanceAuthorization?: ProjectTaskKnowledgeMaintenanceAuthorization | undefined
    readonly taskId: ProjectTaskId
    readonly automaticReview?: ProjectTaskReviewPolicy | undefined
    readonly postSteps?: ProjectTaskPostSteps | undefined
    readonly reviewSources?: readonly ProjectTaskReviewSourceSelection[] | undefined
    /** Explicit Harness preset frozen at acceptance, including retries after dispatch preparation fails. */
    readonly agentPreset?: AgentPresetRow['id'] | undefined
    /** Acceptance into an interactive Terminal, not the application-owned task runner. */
    readonly terminal?: true | undefined
    /** Explicit native selection retained before task creation. */
    readonly codex?: ProjectTaskCodexSelection | undefined
    readonly claude?: ProjectTaskClaudeSelection | undefined
    /** Input and resolved route retained together before task creation; absent on unselected confirmations. */
    readonly selection?: { readonly input: ModelSelection
      readonly resolved: ModelSelection } | undefined }
)

/** Explicit native handoff; continuation is limited to failed retained Codex tasks. */
export type ProjectTaskTerminalAction = 'open' | 'resume'

/** Stable task admission errors; transport, persistence and provider errors remain separate. */
export type ProjectTaskFailure = 'busy' | 'invalid-proposal' | 'proposal-changed' | 'task-not-found'
  | 'report-changed'
  | 'review-unavailable'
  | 'terminal-unavailable' | 'terminal-task-unavailable' | 'terminal-directory-missing' | 'terminal-resume-unavailable' | 'terminal-handoff-failed'
  | 'project-changed' | 'task-limit' | 'proposal-too-large' | 'invalid-checks'
  | 'card-not-found' | 'card-limit' | 'card-decision-conflict' | 'source-session-changed'
  | 'completion-not-ready' | 'completion-decision-conflict' | 'completion-too-large'
  | 'knowledge-review-unavailable' | 'knowledge-review-conflict' | 'knowledge-source-identifiers-missing'
  | 'knowledge-source-review-required'
  | 'knowledge-page-review-required' | 'knowledge-page-overlap-unresolved' | 'knowledge-page-review-stale'
  | 'invalid-goal' | 'goal-too-large' | 'goal-limit' | 'goal-active' | 'goal-request-changed'
  | 'goal-not-found' | 'task-recursive-goal'
  | 'invalid-goal-plan' | 'goal-phase-conflict'
  | 'invalid-goal-review' | 'goal-review-conflict' | 'goal-git-conflict'
  | 'task-git-conflict' | 'task-git-dirty'
  | 'invalid-goal-dispatch' | 'goal-model-not-approved' | 'goal-subgoal-not-ready' | 'goal-task-required'
  | 'goal-research-checks-not-approved'
  | 'goal-dispatch-not-approved'
  | 'invalid-goal-outcome' | 'goal-outcome-conflict' | 'invalid-goal-verification' | 'goal-knowledge-review-required'
  | 'invalid-goal-capability' | 'invalid-goal-knowledge-discovery'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Host-authored confirmation instructions for an accepted Task card.
     * @persistenceAttribution
     */
    'project-task-confirmation': { readonly kind: 'project-task-confirmation' } & ContextFormed
    /** Historical confirmation input retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-task-confirmation': { readonly kind: 'plugin:project-task-confirmation' } & ContextFormed
    /** Independently dispatched Task or original-source reviewer input.
     * @persistenceAttribution
     */
    'project-task-review': { readonly kind: 'project-task-review' } & ContextFormed
    /** Historical reviewer input retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-task-review': { readonly kind: 'plugin:project-task-review' } & ContextFormed
    /** Independently dispatched read-only Goal knowledge discovery input.
     * @persistenceAttribution
     */
    'project-goal-knowledge-discovery': { readonly kind: 'project-goal-knowledge-discovery' } & ContextFormed
    /** Historical discovery input retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-goal-knowledge-discovery': { readonly kind: 'plugin:project-goal-knowledge-discovery' } & ContextFormed
    /** Logged Goal-source coordination instructions, not a user authorization.
     * @persistenceAttribution
     */
    'project-goal-mode': { readonly kind: 'project-goal-mode' } & ContextFormed
    /** Historical coordination context retained by the released V3-to-V4 migration.
     * @persistenceAttribution
     */
    'plugin:project-goal-mode': { readonly kind: 'plugin:project-goal-mode' } & ContextFormed
    /** An explicit dashboard resume, never model-authorized continuation. */
    'project-goal-resume': {
      readonly kind: 'project-goal-resume'
      readonly runId: ProjectGoalRunId
      readonly requestId: ProjectGoalRequestId
    }
    /** Collected Goal evidence delivered to its exact approved source conversation. */
    'project-goal-result': {
      readonly kind: 'project-goal-result'
      readonly runId: ProjectGoalRunId
      readonly taskId: ProjectTaskId
      readonly requestId: ProjectGoalRequestId
      /** Absent on older result inputs; readers must not reconstruct it from prompt prose. */
      readonly notice?: ProjectTaskCompletionNotice | undefined
    }
    /** Explicit plan review, retained before waking its owning conversation. */
    'project-goal-review': {
      readonly kind: 'project-goal-review'
      readonly runId: ProjectGoalRunId
      readonly requestId: ProjectGoalRequestId
      readonly decision: 'approve' | 'reject'
    }
    /** Durable input of an explicitly confirmed or Goal-authorized project task. */
    'project-task': {
      readonly kind: 'project-task'
      readonly taskId: ProjectTaskId
      /** Exact Goal ownership, including pre-plan tasks without a sub-goal. */
      readonly goal?: {
        readonly runId: ProjectGoalRunId
        readonly subGoalId?: ProjectSubGoalId | undefined
        readonly gather?: true | undefined
        readonly probe?: Pick<ModelSelection, 'provider' | 'model'> | undefined
      } | undefined
    }
    /** Explicit follow-up of a retained task outcome, not a new human-authored message. */
    'project-task-completion': {
      readonly kind: 'project-task-completion'
      readonly taskId: ProjectTaskId
      /** Absent on inputs recorded before self-contained outcome presentation. */
      readonly notice?: ProjectTaskCompletionNotice | undefined
    }
    /** User-confirmed knowledge-only retry of an ordinary Task's frozen result. */
    'project-task-knowledge-review': {
      readonly kind: 'project-task-knowledge-review'
      readonly taskId: ProjectTaskId
      readonly cardId: ProjectTaskCardId
    }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'project-task/codex-catalog': { readonly reason: 'unavailable' }
    'project-task/rejected': { readonly reason: ProjectTaskFailure }
    /** Selected Task file is absent, unsafe, changed or above its explicit read limit. */
    'project-task/output-file': { readonly reason: 'not-found' | 'unavailable' | 'stale' | 'unsafe' | 'too-large' }
    /** Complete original-project Brain evidence exceeds the configured discovery page or byte limit. */
    'project-task/discovery-input-limit': {}
  }
}
