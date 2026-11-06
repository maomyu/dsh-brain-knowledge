/** Persisted task proposals, explicit confirmation and Session-backed execution. */
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { canOpenNativeTerminal, openNativeTerminal } from '@deepseek-ai/dsh-native-command'
import { codexResumeArgv, listCodexModels } from '@deepseek-ai/dsh-subagent-codex'
import type { CodexThreadId } from '@deepseek-ai/dsh-subagent-codex'
import { claudeCodeResumeArgv } from '@deepseek-ai/dsh-subagent-claude-code'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { freezeMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-api-artifact-controller'
import type { ArtifactPreviewFile, ArtifactTaskId } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { ArtifactTaskDirectory } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { projectGoalDomain, projectTaskCardDomain, projectTaskDomain, proposalSchema, taskState, validTaskIsolation,
  type ProjectGoalTaskBinding, type ProjectTaskRecord } from './records.ts'
import { TaskCards } from './cards.ts'
import { taskSourceProject } from './source-project.ts'
import { TaskGoals } from './goals.ts'
import { isNativeGoalModel } from './goal-model.ts'
import { ProjectGit } from './project-git.ts'
import { TaskOutputFiles, type TaskOutputConfig } from './task-output-files.ts'
import { TaskCommandPool } from './commands.ts'
import { TaskReviews, type TaskReviewConfig, type TaskReviewScope } from './task-review.ts'
import { installTaskReviewTools, taskReviewInstruction } from './task-review-tools.ts'
import { taskPostStepsInstruction } from './task-post-steps.ts'
import type { ProjectTaskReviewPolicy, ProjectTaskCodingConfirmation, ProjectTaskPostSteps, ProjectTaskDirectWorkspaceState,
  ProjectTaskReviewSource, ProjectTaskReviewSourceReader, ProjectTaskReviewSourceReceipt,
  ProjectTaskReviewSourceSelection, ProjectTaskReviewSourceVisualOptions } from './types.ts'
import { taskResultEvidence, taskSettlement, taskUsage } from './settlement.ts'
import { completionReportMarkdown } from './completion-report.ts'
import { taskExecutionLog } from './execution-log.ts'
import { codexSelectionSchema, claudeSelectionSchema, codingConfirmationSchema,
  taskReviewSourceSelectionSchema } from './records.ts'
import { executeCodexTask, type TaskCodexConfig } from './codex-task.ts'
import { executeClaudeTask, type TaskClaudeConfig } from './claude-task.ts'
import { recoverNativeTaskIdentity } from './native-task-recovery.ts'
import type { ProjectTaskClaudeSelection, ProjectTaskClaudeSessionId } from './types.ts'
import type { ProjectTaskCodexModel, ProjectTaskCodexSelection, ProjectTaskCodexThreadId, ProjectTaskTerminalAction } from './types.ts'
import type { ProjectTaskExecutionLog } from './types.ts'
import { installTaskTool } from './tool.ts'
import { installTaskReadTool } from './read-tool.ts'
import { taskWrapUpInstruction } from './task-wrap-up.ts'
import { installCompletionToolPolicy } from './completion-tool-policy.ts'
import { retainTerminalInput, terminalDirectory, terminalInvocation } from './terminal-handoff.ts'
import { terminalSelectionSchema } from './records.ts'
import type { ProjectTaskTerminalKnowledge, ProjectTaskTerminalSelection } from './types.ts'
import { installGoalTools } from './goal-tools.ts'
import { installGoalMasterContext } from './goal-master.ts'
import { ResearchFiles, researchInstruction, nativeResearchInstruction, type ResearchConfig } from './research.ts'
import { ArtifactTaskFiles, artifactInstruction, nativeArtifactInstruction, codexArtifactInstruction, type ArtifactTaskConfig } from './artifact-task.ts'
import type { ResearchWorkersConfig } from './research-waves.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectGoalBudget, ProjectGoalDispatchInput, ProjectGoalOutcomeInput, ProjectGoalVerifyInput,
  ProjectGoalReviewInput, ProjectGoalReviewOptions, ProjectGoalControlInput, ProjectGoalDeliveryInput,
  ProjectGoalPlanInput, ProjectGoalRequest, ProjectGoalRequestId, ProjectGoalRunId, ProjectGoalState,
  ProjectTaskCardId, ProjectTaskCardRequest, ProjectTaskCardState, TaskConversationAttention,
  ProjectTaskFailure, ProjectTaskId, ProjectTaskProposal, ProjectTaskState, ProjectGoalTaskDiff, ProjectGoalCodingFiles,
  ProjectTaskKnowledgeReader, ProjectTaskKnowledgeTools, ProjectTaskSessionProject, ProjectGoalModelCapabilityInput,
  ProjectGoalModelCapability,
  ProjectTaskTimelineAppend, ProjectTaskTimelineReceipt } from './types.ts'
import type { ProjectTaskDocumentationInventory, ProjectTaskLiveOutput, ProjectTaskOutputFileContent,
  ProjectTaskOutputFileId, ProjectTaskOutputInventory } from './types.ts'
import type { ProjectTaskKnowledgeMaintenanceMode, ProjectTaskKnowledgeAuthorizationId, ProjectTaskKnowledgeMaintenanceAuthorization } from './types.ts'
import type { ProjectTaskKnowledgeDiscoveryEvidence, ProjectTaskKnowledgeDiscoveryBatch,
  ProjectTaskKnowledgeDiscoveryBatchReader, ProjectTaskKnowledgeDiscoveryReader, ProjectTaskKnowledgeDiscoveryRequestId,
  ProjectTaskKnowledgeDiscoveryWriter, ProjectTaskKnowledgeDecisionRequest, ProjectTaskKnowledgePublishRequest,
  ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgeCatalogReadRequest, ProjectTaskKnowledgeCatalogRead,
  ProjectTaskKnowledgeAcknowledgeRequest,
  ProjectTaskKnowledgePublicationInspection,
  ProjectTaskKnowledgeReviewPages } from './types.ts'
import type { ProjectGoalKnowledgeDiscoveryWriter, ProjectGoalKnowledgeDecisionRequest,
  ProjectGoalKnowledgePublishRequest, ProjectGoalKnowledgeAcknowledgeRequest } from './types.ts'

export type * from './types.ts'
export { documentationTraceOperationId } from './completion.ts'
export { successfulTaskRead } from './task-knowledge-review.ts'
export { hasIndependentKnowledgeTerm } from './knowledge-discovery.ts'

type NativeTaskSelection = { runtime: 'codex'; selection: ProjectTaskCodexSelection }
  | { runtime: 'claude'; selection: ProjectTaskClaudeSelection }

function documentationOutputId(taskId: ProjectTaskId, path: string): ProjectTaskOutputFileId {
  return brandString<ProjectTaskOutputFileId>(createHash('sha256').update(JSON.stringify([taskId, path])).digest('hex'))
}

/** Deployment-owned storage and concurrent request limits; no execution mode is silently selected. */
export interface Config {
  /** Explicit ordinary-task review costs, process lifetimes and complete input/output limits. */
  review: TaskReviewConfig
  /** Explicit local-desktop Terminal handoff; disabled in generic web/remote deployments. */
  nativeTerminal: {
    /** Allow a user gesture to open the local macOS Terminal. */
    enabled: boolean
    /** Absolute private data root for retained draft handoffs; required when using that entry. */
    directory: string
    /** OS handoff deadline in milliseconds, not an interactive session timeout. */
    timeoutMs: number
    /** Pending handoff process termination grace in milliseconds. */
    graceMs: number
  }
  /** Native Task process release and acknowledgement-buffer limits. */
  codex: TaskCodexConfig
  /** Claude Task process release and complete SDK event limits. */
  claude: TaskClaudeConfig
  /** Native catalog discovery limits, independent of Task execution. */
  codexCatalog: {
    /** Deadline including native initialization and all pages, excluding joined termination. */
    timeoutMs: number
    /** Inclusive received entry count; incomplete catalogs fail rather than truncate. */
    maxModels: number
    /** Inclusive stdout bytes across the complete discovery connection. */
    maxBytes: number
  }
  /** Inclusive UTF-8 limit for a complete execution-log response; older entries remain in Session storage. */
  maxExecutionLogBytes: number
  /** Inclusive UTF-8 allowance for one complete model-facing retained task record. */
  maxTaskReadBytes: number
  /** Durable ordinary-Task file-list and selected-file read limits. */
  outputFiles: TaskOutputConfig
  /** Delay between active Task checkout observations while a gallery follows them. */
  liveOutputRefreshIntervalMs: number
  /** Research report, model-step and permitted read-tool limits. */
  research: ResearchConfig
  /** Read-only post-Task discovery limits; exceeding any bound blocks rather than truncating evidence. */
  knowledgeDiscovery: {
    /** Inclusive count of indexed Brain pages read for one complete comparison. */
    maxPages: number
    /** Inclusive UTF-8 bytes of one complete Task, report and Brain reviewer input. */
    maxInputBytes: number
    /** Inclusive UTF-8 bytes of the complete reviewer response retained for parsing. */
    maxOutputBytes: number
    /** Per-request model output-token cap for the tool-free reviewer. */
    maxOutputTokens: number
    /** Optional exact model effort for independent Task and Goal reviewers; omission preserves the selected route. */
    reasoningEffort?: string | undefined
    /** Maximum model steps in the independent reviewer Session. */
    maxSteps: number
  }
  /** Private documentation worker limits and source-read capabilities. */
  artifact: ArtifactTaskConfig
  /** Independent read-only researcher execution limits. */
  researchWorkers: ResearchWorkersConfig
  /** Approved deterministic checks use this shell and these bounded execution limits. */
  goalChecks: {
    /** Executable in the configured subprocess world. */
    executable: string
    /** Arguments preceding the approved command string. */
    args: string[]
    /** Default per-check deadline in milliseconds. */
    timeoutMs: number
    /** Child termination grace period in milliseconds. */
    graceMs: number
    /** Inclusive retained byte limit per output stream. */
    maxOutputBytes: number
    /** Code-point limit per check detail, raw Goal summary, and combined structured report strings. */
    maxDetailChars: number
  }
  /** Inclusive UTF-8 byte limit for one complete serialized proposal. */
  maxProposalBytes: number
  /** Inclusive UTF-8 byte limit for one notification, one Goal merge receipt, or all reports of one Goal Task. */
  maxCompletionBytes: number
  /** Maximum retained tasks per registered project, including closed tasks. */
  maxTasksPerProject: number
  /** Maximum retained conversation proposals per project, including resolved cards. */
  maxCardsPerProject: number
  /** Inclusive UTF-8 byte limit for each complete goal record, including a submitted plan. */
  maxGoalBytes: number
  /** Maximum retained goal runs per registered project, including exited runs. */
  maxGoalRunsPerProject: number
  /** Initial review-form thresholds; explicit user selections are retained per plan. */
  goalBudget: ProjectGoalBudget
  /** Validity periods for researched claims and unverified assumptions; new receipts freeze their expiry. */
  goalCapabilities: {
    /** Maximum validity of a sourced claim in milliseconds. */
    researchedTtlMs: number
    /** Maximum validity of an assumption in milliseconds, capped by the researched validity. */
    assumedTtlMs: number
  }
  /** Shared Task/Goal Git limits and identity for application-authored baseline, task and merge commits. */
  goalGit: {
    /** Executable resolved by the configured subprocess provider. */
    executable: string
    /** Maximum duration of each Git command in milliseconds. */
    timeoutMs: number
    /** Milliseconds allowed for child termination before escalation. */
    graceMs: number
    /** Inclusive byte limit for each output stream, complete diff response and local exclusion file. */
    maxOutputBytes: number
    /** Author and committer name for application-authored local Goal commits. */
    baselineName: string
    /** Author and committer email for application-authored local Goal commits. */
    baselineEmail: string
  }
  /** Maximum concurrent requests in each task, conversation-card and goal command pool. */
  maxConcurrent: number
  /** Maximum preparing or active task executions across projects. */
  maxExecutions: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Prepare independent durable records before a new Goal is committed; failure prevents Goal creation.
     * @mode serial
     * @param workspaceId - registered project containing the source conversation.
     * @param sourceSessionId - directly registered Goal source.
     * @param runId - newly allocated run identity, not yet visible to Goal readers.
     * @param signal - creation lifetime; admitted durable work must settle before returning.
     */
    'project-goal/prepare'(workspaceId: WorkspaceId, sourceSessionId: SessionId, runId: ProjectGoalRunId, signal: AbortSignal): Promise<void>
  }
  interface Context {
    /** Durable project task intent and explicitly confirmed execution. */
    taskController: TaskController
  }
}

/** Accepts task intent without starting an Agent until explicit confirmation. */
export class TaskController extends TypertRemoteService {
  static inject = ['storageDomain', 'workspaceRegistry', 'sessionController', 'sessions',
    'sessionPersistence', 'agents', 'agentDefaultModel', 'llm', 'tools', 'fs', 'subprocess', 'sessionProjections', 'artifactController']
  static Config: z<Config> = z.object({
    review: z.object({ maxCalls: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
      maxConcurrent: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
      timeoutMs: z.number().step(1).min(1).max(2147483647).default(600000),
      pollTimeoutMs: z.number().step(1).min(1).max(30000).default(28000),
      maxInputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(200000),
      maxResultBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65536),
      maxToolResultBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262144),
      maxFailureChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
      maxIssues: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100),
      maxSteps: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
      maxConfigBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1048576),
      maxMcpServers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256) }),
    nativeTerminal: z.object({ enabled: z.boolean().default(false),
      directory: z.string().default(''),
      timeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
      graceMs: z.number().step(1).min(1).max(2147483647).default(1000) }),
    codex: z.object({ graceMs: z.number().step(1).min(1).max(2147483647).default(3000),
      maxPendingBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4 * 1024 * 1024),
      maxConfigBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1048576),
      maxMcpServers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256) }),
    claude: z.object({ graceMs: z.number().step(1).min(1).max(2147483647).default(3000),
      maxEventBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4 * 1024 * 1024) }),
    codexCatalog: z.object({ timeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
      maxModels: z.number().step(1).min(1).max(4294967295).default(256),
      maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1024 * 1024) }),
    maxExecutionLogBytes: z.number().step(1).min(512).max(Number.MAX_SAFE_INTEGER).default(262144),
    maxTaskReadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65536),
    outputFiles: z.object({
      maxEntries: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
      maxInventoryBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32768),
      maxPathBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4096),
      maxReadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(25 * 1024 * 1024),
    }).default({ maxEntries: 128, maxInventoryBytes: 32768, maxPathBytes: 4096, maxReadBytes: 25 * 1024 * 1024 }),
    liveOutputRefreshIntervalMs: z.number().step(1).min(1).max(2147483647).default(2000),
    researchWorkers: z.object({ provider: z.string().min(1).default('spawn'),
      maxConcurrent: z.number().step(1).min(1).default(4), maxWaves: z.number().step(1).min(1).default(3),
      maxSteps: z.number().step(1).min(1).default(50), maxResultBytes: z.number().step(1).min(1).default(65536) }),
    artifact: z.object({ maxSteps: z.number().step(1).min(1).default(96),
      maxEntries: z.number().step(1).min(1).default(512), maxDepth: z.number().step(1).min(1).default(20),
      maxFileBytes: z.number().step(1).min(1).default(4 * 1024 * 1024),
      maxTotalBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
      maxCheckpointAuditBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
      readTools: z.array(z.string()).default(['brain_read', 'brain_search', 'read_code_file', 'list_code_dir', 'search_code', 'web_search', 'web_fetch']) }),
    research: z.object({ maxReportBytes: z.number().step(1).min(1).default(1024 * 1024),
      maxSteps: z.number().step(1).min(1).default(50),
      maxOutputFiles: z.number().step(1).min(1).default(128),
      maxOutputBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
      maxCheckpointAuditBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
      readTools: z.array(z.string()).default(['brain_read', 'brain_search', 'read_code_file', 'list_code_dir', 'search_code', 'web_search', 'web_fetch']) }),
    knowledgeDiscovery: z.object({
      maxPages: z.number().step(1).min(1).default(128),
      maxInputBytes: z.number().step(1).min(1).default(524288),
      maxOutputBytes: z.number().step(1).min(1).default(32768),
      maxOutputTokens: z.number().step(1).min(1).default(4096),
      reasoningEffort: z.union([z.string().min(1), z.const(undefined)]),
      maxSteps: z.number().step(1).min(1).default(2),
    }).default({ maxPages: 128, maxInputBytes: 524288, maxOutputBytes: 32768,
      maxOutputTokens: 4096, reasoningEffort: undefined, maxSteps: 2 }),
    goalChecks: z.object({ executable: z.string().min(1).required(), args: z.array(z.string()).required(),
      timeoutMs: z.number().step(1).min(1).max(2147483647).required(), graceMs: z.number().step(1).min(1).max(2147483647).required(),
      maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      maxDetailChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required() }).required(),
    maxProposalBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxCompletionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxTasksPerProject: z.number().step(1).min(1).required(),
    maxCardsPerProject: z.number().step(1).min(1).required(),
    maxGoalBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxGoalRunsPerProject: z.number().step(1).min(1).required(),
    goalBudget: z.object({ noProgressPauseThreshold: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      runSpawnCap: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      runTokenWarnThreshold: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      runTurnWarnThreshold: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required() }).required(),
    goalCapabilities: z.object({
      researchedTtlMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30 * 24 * 60 * 60 * 1000),
      assumedTtlMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(24 * 60 * 60 * 1000),
    }),
    goalGit: z.object({ executable: z.string().min(1).required(), timeoutMs: z.number().step(1).min(1).max(2147483647).required(),
      graceMs: z.number().step(1).min(1).max(2147483647).required(),
      maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
      baselineName: z.string().min(1).required(), baselineEmail: z.string().min(1).required() }).required(),
    maxConcurrent: z.number().step(1).min(1).required(),
    maxExecutions: z.number().step(1).min(1).required(),
  })

  private readonly lifetime = new AbortController()
  private quiescence: Promise<void> | undefined
  private drainWork!: () => Promise<void>
  private readonly commands: TaskCommandPool<ProjectTaskId, ProjectTaskState>
  private readonly modelReads: TaskCommandPool<WorkspaceId, readonly ProjectTaskCodexModel[]>
  private readonly git: ProjectGit
  private readonly outputFiles: TaskOutputFiles
  private reviews!: TaskReviews
  private readonly researchFiles: ResearchFiles
  private readonly artifactFiles: ArtifactTaskFiles
  private readonly preparing = new Set<ProjectTaskId>()
  private readonly executions = new Map<ProjectTaskId, { cancel: (disposed: boolean) => void; done: Promise<void> }>()
  private readonly logReads = new Set<Promise<ProjectTaskExecutionLog>>()
  private table!: KvTable<ProjectTaskId, ProjectTaskRecord>
  private skillAuthorityReady = false
  private cards!: TaskCards
  private cardsRecovered = false
  private goalRuns!: TaskGoals
  private knowledgeReader: { readonly capture: ProjectTaskKnowledgeReader } | undefined
  private taskReviewSourceReader: { readonly read: ProjectTaskReviewSourceReader } | undefined
  private knowledgeReviewPages: { readonly resolve: ProjectTaskKnowledgeReviewPages } | undefined
  private knowledgeDiscoveryReader: { readonly capture: ProjectTaskKnowledgeDiscoveryReader
    readonly batch?: ProjectTaskKnowledgeDiscoveryBatchReader | undefined } | undefined
  private knowledgeDiscoveryWriterRegistration: { readonly writer: ProjectTaskKnowledgeDiscoveryWriter } | undefined
  private goalKnowledgeDiscoveryWriterRegistration: { readonly writer: ProjectGoalKnowledgeDiscoveryWriter } | undefined
  private knowledgeTimelineReceipt: { readonly inspect: ProjectTaskTimelineReceipt } | undefined
  private knowledgeTools: { readonly create: ProjectTaskKnowledgeTools } | undefined
  private terminalKnowledge: { readonly prepare: ProjectTaskTerminalKnowledge } | undefined

  /** Bind current selected decision-page resolution for Task no-change admission.
   * @param resolve - Brain owner checks each retained reference and returns every active decision page with its version.
   * @returns disposer; a missing provider leaves reviews open rather than inferring an empty set.
   */
  registerKnowledgeReviewPages(resolve: ProjectTaskKnowledgeReviewPages): () => void {
    if (this.knowledgeReviewPages !== undefined) throw new Error('Task knowledge review page provider is already installed')
    const registration = { resolve }
    this.knowledgeReviewPages = registration
    return () => { if (this.knowledgeReviewPages === registration) this.knowledgeReviewPages = undefined }
  }

  /** Bind the Brain owner's complete read-only evidence capture for no-reference Tasks.
   * @param capture - reads only the exact registered Task project and fails on incomplete Brain evidence.
   * @param batch - optional complete-page reader for independently logged bounded reviewer calls.
   * @returns disposer; no discovery runs without a current provider.
   */
  registerKnowledgeDiscoveryReader(capture: ProjectTaskKnowledgeDiscoveryReader,
    batch?: ProjectTaskKnowledgeDiscoveryBatchReader): () => void {
    if (this.knowledgeDiscoveryReader !== undefined) throw new Error('Task knowledge discovery reader is already installed')
    const registration = { capture, batch }
    this.knowledgeDiscoveryReader = registration
    if (this.cardsRecovered) {
      this.cards.startKnowledgeDiscoveryRecovery()
      this.goalRuns.startKnowledgeDiscoveryRecovery()
      void this.cards.recoverAutomaticKnowledge().catch((error: unknown) => { this.ctx.logger.error('Task automatic knowledge recovery failed', error) })
      void this.goalRuns.recoverAutomaticKnowledge().catch((error: unknown) => { this.ctx.logger.error('Goal automatic knowledge recovery failed', error) })
    }
    return () => { if (this.knowledgeDiscoveryReader === registration) this.knowledgeDiscoveryReader = undefined }
  }

  /** Bind Host-only Brain Task proposal and held-draft writers without exposing them as model tools.
   * @param writer - original-project writer whose callbacks recheck durable Task decisions under its file lock.
   * @returns disposer; an unmounted writer leaves pending human decisions resumable, not silently complete.
   */
  registerKnowledgeDiscoveryWriter(writer: ProjectTaskKnowledgeDiscoveryWriter): () => void {
    if (this.knowledgeDiscoveryWriterRegistration !== undefined) throw new Error('Task knowledge discovery writer is already installed')
    const registration = { writer }
    this.knowledgeDiscoveryWriterRegistration = registration
    if (this.cardsRecovered) void this.cards.recoverAutomaticKnowledge()
      .catch((error: unknown) => { this.ctx.logger.error('Task automatic knowledge recovery failed', error) })
    return () => { if (this.knowledgeDiscoveryWriterRegistration === registration) this.knowledgeDiscoveryWriterRegistration = undefined }
  }

  /** Resolve the current Host-only Brain writer for one admitted human decision.
   * @returns registered writer or undefined while Brain is unavailable.
   */
  knowledgeDiscoveryWriter(): ProjectTaskKnowledgeDiscoveryWriter | undefined {
    return this.knowledgeDiscoveryWriterRegistration?.writer
  }

  /** Bind Goal-human Brain operations without exposing the ordinary Task card writer to Goal tasks.
   * @param writer - original-project Goal proposal and held-draft writer.
   * @returns disposer that withdraws only this exact registration.
   */
  registerGoalKnowledgeDiscoveryWriter(writer: ProjectGoalKnowledgeDiscoveryWriter): () => void {
    if (this.goalKnowledgeDiscoveryWriterRegistration !== undefined) throw new Error('Goal knowledge writer is already installed')
    const registration = { writer }
    this.goalKnowledgeDiscoveryWriterRegistration = registration
    if (this.cardsRecovered) void this.goalRuns.recoverAutomaticKnowledge()
      .catch((error: unknown) => { this.ctx.logger.error('Goal automatic knowledge recovery failed', error) })
    return () => { if (this.goalKnowledgeDiscoveryWriterRegistration === registration) {
      this.goalKnowledgeDiscoveryWriterRegistration = undefined
    } }
  }

  /** Resolve the current Host-only Goal-human Brain writer.
   * @returns registered writer or undefined while Brain is unavailable.
   */
  goalKnowledgeDiscoveryWriter(): ProjectGoalKnowledgeDiscoveryWriter | undefined {
    return this.goalKnowledgeDiscoveryWriterRegistration?.writer
  }

  /** Capture complete original-project Brain evidence without granting an internal reviewer file tools.
   * @param project - retained Task project identity and path.
   * @param query - Task title used only for a bounded lexical cross-check.
   * @param signal - discovery lifetime.
   * @returns complete page bodies, versions and search observations.
   */
  captureKnowledgeDiscovery(project: ProjectTaskSessionProject, query: string,
    signal: AbortSignal): Promise<ProjectTaskKnowledgeDiscoveryEvidence> {
    if (this.knowledgeDiscoveryReader === undefined) throw new Error('Task knowledge discovery requires the Brain reader')
    return this.knowledgeDiscoveryReader.capture(project, query, this.config.knowledgeDiscovery, signal)
  }

  /** Capture a complete Brain slice for one model request; the caller owns catalog continuation and Session audit.
   * @param project - original retained project identity.
   * @param query - exact source-subject or Task-title search text.
   * @param request - offset, catalog identity and complete slice limits.
   * @param signal - discovery lifetime.
   * @returns full page bodies and complete search hits for this unchanged catalog.
   */
  captureKnowledgeDiscoveryBatch(project: ProjectTaskSessionProject, query: string,
    request: Parameters<ProjectTaskKnowledgeDiscoveryBatchReader>[2], signal: AbortSignal): Promise<ProjectTaskKnowledgeDiscoveryBatch> {
    const batch = this.knowledgeDiscoveryReader?.batch
    if (batch === undefined) throw new Error('Task knowledge discovery requires the Brain batch reader')
    return batch(project, query, request, signal)
  }

  /** Whether the mounted Brain provider supports independently logged page batches.
   * @returns true when a batch reader is registered.
   */
  canCaptureKnowledgeDiscoveryBatch(): boolean { return this.knowledgeDiscoveryReader?.batch !== undefined }

  /** Resolve current selected decision pages without accepting a model claim as evidence.
   * @param project - original registered Task project.
   * @param refs - exact retained references.
   * @param signal - current review admission lifetime.
   * @returns canonical pages and versions; missing Brain capability rejects.
   */
  resolveKnowledgeReviewPages(project: ProjectTaskSessionProject, refs: readonly string[], signal: AbortSignal): Promise<readonly {
    readonly path: string
    readonly version: string
  }[]> {
    if (this.knowledgeReviewPages === undefined) throw new Error('Task knowledge review requires the Brain page provider')
    return this.knowledgeReviewPages.resolve(project, refs, signal)
  }

  /** Register exact read-only Brain receipts for ended ordinary Task review attempts.
   * @param inspect - Brain-owned current-file verifier; registration cannot start a model or repeat a write.
   * @returns disposer that prevents later receipt inspection through this registration.
   */
  registerKnowledgeTimelineReceipt(inspect: ProjectTaskTimelineReceipt): () => void {
    if (this.knowledgeTimelineReceipt !== undefined) throw new Error('Task knowledge Timeline receipt provider is already installed')
    const registration = { inspect }
    this.knowledgeTimelineReceipt = registration
    void this.cards.reconcileBlockedKnowledge().catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.ctx.logger.error('Task knowledge receipt recovery remains blocked', error)
    })
    return () => { if (this.knowledgeTimelineReceipt === registration) this.knowledgeTimelineReceipt = undefined }
  }

  /** Check one retained original call against the current Brain file, or refuse when its provider was removed.
   * @param project - original registered Task project.
   * @param sessionId - original source conversation.
   * @param append - complete logged Timeline input.
   * @param signal - current Task review or controller lifetime.
   * @returns whether the exact authored row is still present.
   */
  inspectKnowledgeTimelineReceipt(project: ProjectTaskSessionProject, sessionId: SessionId,
    append: ProjectTaskTimelineAppend, signal: AbortSignal): Promise<boolean> {
    const provider = this.knowledgeTimelineReceipt
    if (provider === undefined) throw new Error('Task knowledge Timeline receipt provider is unavailable')
    return provider.inspect(project, sessionId, append, signal).then((found) => {
      if (this.knowledgeTimelineReceipt !== provider) throw new Error('Task knowledge Timeline receipt provider changed during inspection')
      return found
    })
  }

  /** Install the local standalone knowledge profile owner.
   * @param prepare - creates a retained private profile without an application-host connection.
   * @returns disposer withdrawing future handoffs, without stopping user-owned terminal sessions.
   */
  registerTerminalKnowledge(prepare: ProjectTaskTerminalKnowledge): () => void {
    if (this.terminalKnowledge !== undefined) throw new Error('Task Terminal knowledge provider is already installed')
    const registration = { prepare }
    this.terminalKnowledge = registration
    return () => { if (this.terminalKnowledge === registration) this.terminalKnowledge = undefined }
  }

  /** Read retained native handoffs eligible for Host knowledge-grant restoration without exposing prompts or argv.
   * @returns opened or unconfirmed handoffs still owned by their original registered project.
   */
  terminalKnowledgeHandoffs(): readonly { readonly taskId: ProjectTaskId
    readonly project: ProjectTaskSessionProject
    readonly directory: string }[] {
    this.lifetime.signal.throwIfAborted()
    return [...this.table.entries()].flatMap(([taskId, record]) => {
      if (record.status !== 'opened-terminal'
        || record.terminal.phase === 'prepared'
        || !this.ownsTerminalKnowledgeHandoff(record, record.workspaceId, record.workspacePath, record.terminal.directory)) return []
      return [{ taskId, project: { id: record.workspaceId, path: record.workspacePath }, directory: record.terminal.directory }]
    })
  }

  /** Check the durable Task and current project before each detached knowledge query.
   * @param taskId - original accepted Task, never inferred from the native process cwd.
   * @param project - original registered project and path captured at handoff.
   * @param directory - exact private handoff directory retained by that Task.
   * @returns whether the current Task still owns a prepared, opened or unconfirmed handoff at that directory.
   */
  ownsTerminalKnowledge(taskId: ProjectTaskId, project: ProjectTaskSessionProject, directory: string): boolean {
    if (this.lifetime.signal.aborted) return false
    const record = this.table.get(taskId)
    return record !== undefined && this.ownsTerminalKnowledgeHandoff(record, project.id, project.path, directory)
  }

  private ownsTerminalKnowledgeHandoff(record: ProjectTaskRecord, workspaceId: WorkspaceId,
    projectPath: string, directory: string): boolean {
    const root = this.config.nativeTerminal.directory
    return this.config.nativeTerminal.enabled && root.length > 0 && record.status === 'opened-terminal'
      && record.workspaceId === workspaceId && record.workspacePath === projectPath
      && record.terminal.directory === directory && dirname(directory) === root
      && /^handoff-[A-Za-z0-9_-]{6}$/.test(basename(directory))
      && this.ctx.workspaceRegistry.get(workspaceId)?.path === projectPath
  }

  /** Install project-bound native queries; disposal revokes previously bound callbacks.
   * @param create - knowledge owner binding the original project and Brain location.
   * @returns identity-safe disposer; native execution logs remain readable without the provider.
   * @throws when another native knowledge provider is installed.
   */
  registerKnowledgeTools(create: ProjectTaskKnowledgeTools): () => void {
    this.lifetime.signal.throwIfAborted()
    if (this.knowledgeTools !== undefined) throw new Error('Native task knowledge tools are already installed')
    const registration = { create: ((project) => {
      const reader = create(project)
      return { definitions: reader.definitions, read: async (name, args, signal) => {
        this.lifetime.signal.throwIfAborted()
        if (this.knowledgeTools !== registration) throw new Error('Native task knowledge provider was removed')
        const result = await reader.read(name, args, signal)
        if (this.knowledgeTools !== registration) throw new Error('Native task knowledge provider was removed')
        return { ...result, recordAccess: async () => {
          if (this.knowledgeTools !== registration) throw new Error('Native task knowledge provider was removed')
          await result.recordAccess()
        } }
      } }
    }) satisfies ProjectTaskKnowledgeTools }
    this.knowledgeTools = registration
    return () => { if (this.knowledgeTools === registration) this.knowledgeTools = undefined }
  }

  /** Install the sole provider of selected Brain content; the caller owns its registration effect.
   * @param reader - captures actual source text and versions with complete output bounds.
   * @returns a disposer; retained execution input remains usable without the provider.
   * @throws when another reader is installed.
   */
  registerKnowledgeReader(reader: ProjectTaskKnowledgeReader): () => void {
    this.lifetime.signal.throwIfAborted()
    if (this.knowledgeReader !== undefined) throw new Error('A task knowledge reader is already installed')
    const registration = { capture: reader }
    this.knowledgeReader = registration
    return () => { if (this.knowledgeReader === registration) this.knowledgeReader = undefined }
  }

  /** Install one import-owned exact source reader for explicit ordinary Task review selections.
   * @param reader - same-project original and conversion verifier; no paths or model proposals are accepted.
   * @returns disposer; selected Tasks fail closed while the provider is unavailable.
   */
  registerTaskReviewSourceReader(reader: ProjectTaskReviewSourceReader): () => void {
    if (this.taskReviewSourceReader !== undefined) throw new Error('A Task review source reader is already installed')
    const registration = { read: reader }
    this.taskReviewSourceReader = registration
    return () => { if (this.taskReviewSourceReader === registration) this.taskReviewSourceReader = undefined }
  }

  /** Resolve task ownership from retained execution or a live direct research child's recorded parent.
   * @param sessionId - task or live direct researcher identity; cwd grants no authority.
   * @returns the original project and research-read eligibility, or undefined for an unrelated Session.
   * @throws when project or research source membership changed; callers must not fall back to another project.
   */
  projectForSession(sessionId: SessionId): (ProjectTaskSessionProject & { readonly research?: true }) | undefined {
    this.lifetime.signal.throwIfAborted()
    const session = this.ctx.agents.get(sessionId)?.session
    const records = [...this.table.entries()]
    const record = records.find(([, item]) => item.execution?.sessionId === sessionId)?.[1]
      ?? (session?.header.origin === 'subagent' ? records.find(([, item]) => item.proposal.research !== undefined
        && item.status === 'running' && item.execution.sessionId === session.header.parentSession)?.[1] : undefined)
    if (record === undefined) return undefined
    const project = this.workspace(record.workspaceId)
    if (project.path !== record.workspacePath) this.refuse('project-changed')
    if (record.proposal.research !== undefined || record.proposal.artifact !== undefined) this.assertDispatchOwner(record)
    return { id: project.id, path: project.path,
      ...(record.proposal.research === undefined && record.proposal.artifact === undefined ? {} : { research: true as const }) }
  }

  private async captureKnowledge(record: ProjectTaskRecord, readMode: 'tools' | 'files', signal: AbortSignal): Promise<string | undefined> {
    const selection = { brainRefs: record.proposal.brainRefs ?? [], rootPageRefs: record.proposal.rootPageRefs ?? [], readMode }
    if (selection.brainRefs.length === 0 && selection.rootPageRefs.length === 0) return undefined
    const reader = this.knowledgeReader
    if (reader === undefined) throw new Error('Selected Brain references require the project Brain plugin; enable it before confirming this task')
    return reader.capture({ id: record.workspaceId, path: record.workspacePath }, selection, signal)
  }

  /** @param ctx - existing project, storage and Agent services.
   * @param config - explicit complete-proposal and retained-task bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'taskController', { namespace: 'projectTasks' })
    installCompletionToolPolicy(ctx.root)
    this.commands = new TaskCommandPool(this.lifetime.signal, config.maxConcurrent)
    this.modelReads = new TaskCommandPool(this.lifetime.signal, config.maxConcurrent)
    this.git = new ProjectGit(ctx, config, this.lifetime.signal)
    this.outputFiles = new TaskOutputFiles(ctx, this.git, config.outputFiles)
    this.researchFiles = new ResearchFiles(ctx, config.research, config.outputFiles)
    this.artifactFiles = new ArtifactTaskFiles(ctx, config.artifact, config.outputFiles)
    const chatSkillTools = new Set(['list_skills', 'read_skill', 'read_skill_file', 'create_skill', 'update_skill', 'delete_skill'])
    ctx.tools.restrictAccess((name, scope) => {
      if (!chatSkillTools.has(name)) return true
      if (this.lifetime.signal.aborted || !this.skillAuthorityReady) return false
      const caller = ctx.agents.list().find(agent => agent === scope)
      return caller !== undefined && this.projectForSession(caller.session.id) === undefined
    })
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectTaskDomain)
    this.table = domain.table('tasks')
    this.skillAuthorityReady = true
    this.reviews = new TaskReviews(this.ctx, this.table, this.config, this.git, this.lifetime.signal, {
      record: (workspaceId, taskId) => this.record(workspaceId, taskId),
      guard: (record) => { this.assertDispatchOwner(record) }, cwd: record => this.executionDirectory(record),
    })
    const cardCleanup: { close?: () => Promise<void>; drain?: () => Promise<void> } = {}
    const goalCleanup: { close?: () => Promise<void>; drain?: () => Promise<void> } = {}
    this.drainWork = async () => {
      this.lifetime.abort(new Error('task controller disposed'))
      for (const execution of this.executions.values()) execution.cancel(true)
      await Promise.allSettled(this.logReads)
      await this.modelReads.drain()
      await cardCleanup.drain?.()
      await goalCleanup.drain?.()
      await this.commands.drain()
      await this.reviews.drain()
      await this.git.drain()
      await Promise.allSettled([...this.executions.values()].map(execution => execution.done))
    }
    this.ctx.effect(() => async () => {
      await this.quiesce()
      try { await cardCleanup.close?.() }
      finally {
        try { await goalCleanup.close?.() }
        finally { await domain.close() }
      }
    }, 'task-controller.shutdown')
    await this.reviews.recover()
    const goalDomain = await this.ctx.storageDomain.open(projectGoalDomain)
    goalCleanup.close = () => goalDomain.close()
    const isTaskSession = (id: SessionId): boolean => [...this.table.entries()].some(([, record]) => record.execution?.sessionId === id)
    this.goalRuns = new TaskGoals(this.ctx, goalDomain.table('runs'), this.config, this.lifetime.signal, isTaskSession, this.git,
      this.table, async (workspaceId, proposal, binding, signal, agentPreset) => {
        await this.proposeTask(workspaceId, proposal, signal, binding)
        const coding = this.goalRuns.codingTaskConfirmation(this.record(workspaceId, proposal.id))
        if (!isNativeGoalModel(binding.model)) return this.confirmTask(workspaceId, proposal.id, signal, 'goal',
          coding.review, undefined, coding.postSteps, false, undefined, agentPreset)
        if (binding.model.runtime === 'codex') return this.confirmCodexTask(workspaceId, proposal.id, { model: binding.model.model,
          ...(binding.model.reasoningEffort === undefined ? {} : { reasoningEffort: binding.model.reasoningEffort }),
          sandbox: proposal.research === undefined ? 'workspace-write' : 'read-only' }, signal, 'goal', false,
        coding.review, coding.postSteps)
        return this.confirmNativeTask(workspaceId, proposal.id, { runtime: 'claude', selection: {
          runtime: 'claude', model: binding.model.model,
          permissionMode: proposal.research === undefined ? binding.model.permissionMode : 'plan',
          ...(binding.model.reasoningEffort === undefined ? {} : { effort: binding.model.reasoningEffort }),
        } }, signal, 'goal', coding.review, coding.postSteps)
      }, (workspaceId, taskId, signal) => this.cancel(workspaceId, taskId, signal),
      (project, query, signal) => this.captureKnowledgeDiscovery(project, query, signal),
      (project, query, request, signal) => this.captureKnowledgeDiscoveryBatch(project, query, request, signal),
      () => this.canCaptureKnowledgeDiscoveryBatch(),
      (workspaceId, taskId, signal) => this.readResearchReport(workspaceId, taskId, signal),
      () => this.goalKnowledgeDiscoveryWriter())
    goalCleanup.drain = () => this.goalRuns.drain()
    const currentGoal = (source: SessionId): ProjectGoalState | null => {
      if (isTaskSession(source)) return null
      const project = this.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(source))
      return project === undefined ? null : this.goalRuns.current(project.id, source)
    }
    installGoalMasterContext(this.ctx, currentGoal)
    const cardDomain = await this.ctx.storageDomain.open(projectTaskCardDomain)
    cardCleanup.close = () => cardDomain.close()
    this.cards = new TaskCards(this.ctx, cardDomain.table('cards'), {
      canPropose: (source) => { const goal = currentGoal(source); return goal === null || goal.phase === 'EXITED' },
      propose: (workspaceId, proposal, signal, sourceSessionId) =>
        this.proposeTask(workspaceId, proposal, signal, undefined, sourceSessionId),
      inspectDirectWorkspace: (workspaceId, signal) => this.inspectDirectWorkspace(workspaceId, signal),
      validateReviewSources: (workspaceId, selections, signal) => this.validateReviewSources(workspaceId, selections, signal),
      readTaskReviewSources: (workspaceId, taskId, signal, options) => this.readTaskReviewSources(workspaceId, taskId, signal, options),
      terminalHandoffOpened: (workspaceId, workspacePath, taskId) => {
        const task = this.table.get(taskId)
        return task?.workspaceId === workspaceId && task.workspacePath === workspacePath
          && this.ctx.workspaceRegistry.get(workspaceId)?.path === workspacePath
          && task.status === 'opened-terminal' && task.terminal.phase === 'opened'
      },
      confirm: (workspaceId, taskId, allowDirty, signal) => this.confirmTask(workspaceId, taskId, signal, 'ordinary', undefined, undefined, undefined, allowDirty),
      confirmCodex: (workspaceId, taskId, selection, allowDirty, signal) =>
        this.confirmCodex(workspaceId, taskId, selection, allowDirty, signal),
      confirmClaude: (workspaceId, taskId, selection, allowDirty, signal) =>
        this.confirmClaude(workspaceId, taskId, selection, allowDirty, signal),
      confirmCoding: (workspaceId, taskId, request, allowDirty, signal) =>
        this.confirmCoding(workspaceId, taskId, request, allowDirty, signal),
      openDraftTerminal: (workspaceId, taskId, selection, allowDirty, signal) =>
        this.openDraftTerminal(workspaceId, taskId, selection, allowDirty, signal),
      readResearchReport: (workspaceId, taskId, signal) => this.readResearchReport(workspaceId, taskId, signal),
      readTaskDirectory: (workspaceId, workspacePath, taskId, artifactId, version, signal) =>
        this.ctx.artifactController.readTaskDirectory(workspaceId, workspacePath,
          brandString<ArtifactTaskId>(taskId), artifactId, version, signal),
      resolveKnowledgeReviewPages: (project, refs, signal) => this.resolveKnowledgeReviewPages(project, refs, signal),
      readKnowledgeDiscoveryTask: (workspaceId, taskId) => {
        const projected = this.inspect(workspaceId, taskId)
        if (projected === null) return null
        const { knowledgeCompletion: _knowledgeCompletion, ...task } = projected
        return task
      },
      readOutputFile: (workspaceId, taskId, fileId, signal) =>
        this.readOutputFile(workspaceId, taskId, fileId, signal),
      captureKnowledgeDiscovery: (project, query, signal) => this.captureKnowledgeDiscovery(project, query, signal),
      captureKnowledgeDiscoveryBatch: (project, query, request, signal) =>
        this.captureKnowledgeDiscoveryBatch(project, query, request, signal),
      canCaptureKnowledgeDiscoveryBatch: () => this.canCaptureKnowledgeDiscoveryBatch(),
      knowledgeDiscoveryWriter: () => this.knowledgeDiscoveryWriter(),
      canDiscover: () => this.knowledgeDiscoveryReader !== undefined,
      inspectKnowledgeTimelineReceipt: (project, sessionId, append, signal) =>
        this.inspectKnowledgeTimelineReceipt(project, sessionId, append, signal),
    }, this.config, this.lifetime.signal)
    cardCleanup.drain = () => this.cards.drain()
    await this.cards.recover()
    installTaskTool(this.ctx, isTaskSession)
    installTaskReadTool(this.ctx, isTaskSession, this.config.maxTaskReadBytes)
    installGoalTools(this.ctx)
    for (const [id, record] of this.table.entries()) {
      if (id !== record.proposal.id) throw new Error('task key does not match its proposal identity')
      if (record.status !== 'dispatched' && record.status !== 'running') {
        let retained = record
        const execution = record.execution
        if (record.status === 'closed-failed'
          && (record.closedReason === 'interrupted' || record.closedReason === 'execution-log-error')
          && (execution?.runtime === 'codex' && execution.threadId === undefined
            || execution?.runtime === 'claude' && !execution.initialized)
          && await this.ctx.sessionPersistence.stat(execution.sessionId) !== undefined) {
          await using handle = await this.ctx.sessionPersistence.open(execution.sessionId, 'read')
          const recovered = recoverNativeTaskIdentity(execution, this.executionDirectory(record), {
            meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events })
          if (recovered !== execution) {
            retained = { ...record, execution: recovered }
            await this.table.put(id, retained)
          }
        }
        if (retained.status.startsWith('closed-')) {
          await this.retainOutputInventory(retained, false)
          await this.retainCompletionReport(retained)
          await this.cleanupResearch(retained)
        }
        continue
      }
      const execution = record.execution
      let recoveredExecution = execution
      let outcome: ReturnType<typeof taskSettlement> = { status: 'closed-failed', closedReason: 'interrupted' }
      let usage: ReturnType<typeof taskUsage> | undefined
      let events: readonly SessionEvent[] = []
      if (await this.ctx.sessionPersistence.stat(execution.sessionId) !== undefined) {
        const handle = await this.ctx.sessionPersistence.open(execution.sessionId, 'read')
        try {
          events = (await handle.read()).events
          if (execution.runtime === 'codex' || execution.runtime === 'claude') {
            recoveredExecution = recoverNativeTaskIdentity(execution, this.executionDirectory(record), {
              meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events })
          }
          outcome = taskSettlement(events, execution.messageId)
          if (execution.runtime !== 'codex' && execution.runtime !== 'claude') usage = taskUsage(events, execution.messageId)
        }
        finally { await handle.close() }
      }
      const restored = { ...record, execution: recoveredExecution }
      const recoveredOutcome = record.artifactWriteProtocol === 'host-checkpoint-v1'
        && outcome.status === 'closed-failed' && outcome.closedReason === 'interrupted'
        ? { status: 'closed-failed' as const,
          closedReason: 'Legacy native artifact checkpoints have no trusted Host receipt; start a new documentation Task' }
        : outcome
      const terminal = await this.researchOutcome(restored, recoveredOutcome, events)
      const settled = { ...restored, ...terminal, ...(usage === undefined ? {} : { usage }),
        updatedAt: Math.max(record.updatedAt, Date.now()) }
      await this.table.put(id, settled)
      await this.retainOutputInventory(settled, false)
      await this.retainCompletionReport(settled, events)
      await this.cleanupResearch(settled)
    }
    for (const [, record] of this.table.entries()) await this.cards.captureCompletion(record)
    await this.goalRuns.recoverKnowledgeDiscovery()
    this.cardsRecovered = true
    this.cards.startResearchRecovery()
    this.cards.startKnowledgeDiscoveryRecovery()
  }

  /** Observe live Task and Goal work for Host quit and update inspection without reading result content.
    * @returns true until execution, preparation, commands, reviews, collections or knowledge work settle; retained states alone do
    * not count.
   */
  hasActiveOperations(): boolean {
    return this.commands.hasActiveOperations() || this.modelReads.hasActiveOperations()
      || this.preparing.size > 0 || this.executions.size > 0 || this.logReads.size > 0
      || this.cards.hasActiveOperations() || this.goalRuns.hasActiveOperations() || this.reviews.hasActiveOperations()
  }

  /** Stop admission and join Task work while its persistence services are still mounted.
   * Desktop shutdown calls this before concurrent root-fiber disposal; direct root disposal remains crash recovery.
   * @returns after owned execution, journal writes, commands and Goal work settle; repeated calls share the drain.
   */
  quiesce(): Promise<void> {
    return this.quiescence ??= this.drainWork()
  }

  /** Apply an explicit user pause, resume or quiescent exit to the exact displayed Goal.
   * @param workspaceId - original project containing the source.
   * @param sourceSessionId - owning master conversation.
   * @param id - retained run identity.
   * @param input - user gesture, request identity and observed control revision.
   * @param signal - caller cancellation before admission; retained commands complete under controller lifetime.
   * @returns pause or exit after joined cancellation, or resume after durable source input; Agent-initiated calls are refused.
   */
  @Remote
  controlGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalControlInput, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.control(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Deliver a terminal Goal result through an explicit user choice.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - owning conversation; delivery never starts a model turn.
   * @param id - displayed Goal run.
   * @param input - keep, merge or checkout gesture and retained request identity.
   * @param signal - caller cancellation before admission; admitted Git work settles under controller lifetime.
   * @returns durable local result; uncommitted changes are never discarded and nothing is pushed.
   */
  @Remote
  deliverGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalDeliveryInput, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.deliver(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Save a project goal for gathering without starting execution or changing permissions.
   * @param workspaceId - registered project containing the source Session.
   * @param request - objective and caller-retained entry identity.
   * @param signal - caller lifetime until admission; committed state survives acknowledgement loss.
   * @returns one durable run; identical retries return its current state even after exit.
   */
  @Remote
  enterGoal(workspaceId: WorkspaceId, request: ProjectGoalRequest, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.enter(workspaceId, request, signal)
  }

  /** Submit a complete plan for review without granting execution permissions or running checks.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - owning project conversation.
   * @param id - exact gathering run.
   * @param requestId - caller-retained submission identity for acknowledgement retries.
   * @param input - objective and acyclic sub-goals with machine and plain-language acceptance criteria.
   * @param signal - caller lifetime until durable write admission.
   * @returns retained SIGNOFF state; identical retries return its current state even after exit.
   */
  @Remote
  submitGoalPlan(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    requestId: ProjectGoalRequestId, input: ProjectGoalPlanInput, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.submit(workspaceId, sourceSessionId, id, requestId, input, signal)
  }

  /** Describe approval choices without resuming a source or changing defaults.
   * @param workspaceId - registered project containing the conversation.
   * @param sourceSessionId - exact conversation whose current model is preferred.
   * @returns adapter-owned catalog and deployment budget defaults.
   */
  @Remote
  goalReviewOptions(workspaceId: WorkspaceId, sourceSessionId: SessionId): Promise<ProjectGoalReviewOptions> {
    return this.goalRuns.options(workspaceId, sourceSessionId)
  }

  /** Query native advertised choices on a user gesture; never creates a Session or task.
   * @param workspaceId - registered project whose native configuration supplies the catalog.
   * @param signal - cancellation combined with the controller lifetime.
   * @returns complete visible choices after native process teardown; no account or quota certification.
   * @throws when the project is missing, the request pool is busy, or discovery fails; raw native errors are not exposed.
   */
  @Remote
  async codexModels(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly ProjectTaskCodexModel[]> {
    return this.modelReads.run(workspaceId, signal, async (lifetime) => {
      const project = this.workspace(workspaceId)
      try {
        const models = await listCodexModels({ cwd: project.path, env: {}, disposeGraceMs: this.config.codex.graceMs,
          ...this.config.codexCatalog, spawn: spec => this.ctx.subprocess.spawn(spec) }, lifetime)
        lifetime.throwIfAborted()
        /* v8 ignore if -- a registered project ID retains its immutable canonical path; workspace() still rejects a removed project. */
        if (this.workspace(workspaceId).path !== project.path) this.refuse('project-changed')
        return models
      } catch {
        // Native errors can contain local configuration or provider credentials; expose only a fixed diagnostic.
        lifetime.throwIfAborted()
        throw new RemoteError('project-task/codex-catalog', 'Codex model discovery failed; check native Codex configuration and retry', { reason: 'unavailable' })
      }
    })
  }

  /** Retain a reusable model assessment without selecting a model or starting work.
   * @param workspaceId - registered project containing the source.
   * @param sourceSessionId - owning master conversation, never a task execution.
   * @param id - exact non-exited Goal; committed identical retries also survive exit.
   * @param input - call-stable claim and public research source; not independently verified by this operation.
   * @param signal - caller cancellation before write admission.
   * @returns original receipt on retry, with expiry unchanged across restart.
   */
  @Remote
  recordGoalModelCapability(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalModelCapabilityInput, signal: AbortSignal): Promise<ProjectGoalModelCapability> {
    return this.goalRuns.recordCapability(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Apply one explicit exact-plan review, prepare approval and durably wake its source once.
   * @param workspaceId - original project containing the conversation.
   * @param sourceSessionId - owning conversation, resumed only by this explicit gesture.
   * @param id - exact retained goal run.
   * @param input - stable decision identity, submitted-plan identity and approved settings or revision feedback.
   * @param signal - caller lifetime; committed intent survives loss of acknowledgement for explicit retry.
   * @returns current committed state after source-input admission, not task completion; callers are not authenticated as human.
   */
  @Remote
  reviewGoalPlan(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalReviewInput, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.review(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Admit a card-free coding Task from an exact approved Goal sub-goal.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - conversation owning the approval.
   * @param id - exact approved Goal run.
   * @param input - immutable dispatch identity, instructions and approved route.
   * @param signal - request lifetime; admitted execution and binding survive acknowledgement loss.
   * @returns Task execution receipt, not a verified or integrated sub-goal result.
   */
  @Remote
  dispatchGoalTask(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalDispatchInput, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.dispatch(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Record source judgement and advance accepted dependencies.
   * @param workspaceId - registered project.
   * @param sourceSessionId - owning Goal conversation.
   * @param id - exact run identity.
   * @param input - stable outcome of a collected attempt.
   * @param signal - caller lifetime.
   * @returns authoritative acceptance and phase.
   */
  @Remote
  recordGoalOutcome(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalOutcomeInput, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.outcome(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Retain an explicit deterministic recheck before returning to the master.
   * @param workspaceId - registered project.
   * @param sourceSessionId - live owning conversation.
   * @param id - exact RUNNING run.
   * @param input - round identity and optional criterion indices.
   * @param signal - caller lifetime through admission.
   * @returns pending round; results wake the same source after its turn ends.
   */
  @Remote
  verifyGoalTask(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    input: ProjectGoalVerifyInput, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.verify(workspaceId, sourceSessionId, id, input, signal)
  }

  /** Keep pre-approval Goal results eligible while this Client selects the project; approved running Goals continue independently.
   * @param workspaceId - selected project, independent of selected conversation.
   * @param signal - project replacement or connection lifetime.
   * @returns registration acknowledgement; never restores or wakes historical sources on mount.
   */
  @Remote({ mode: 'stream' })
  async *followGoalProject(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<true> {
    yield* this.goalRuns.followProject(workspaceId, signal)
  }

  /** Follow one conversation's latest goal without restoring an Agent.
   * @param workspaceId - registered project containing the conversation.
   * @param sourceSessionId - exact source conversation.
   * @param signal - subscriber lifetime.
   * @returns initial state and subsequent committed changes until cancellation or membership failure.
   */
  @Remote({ mode: 'stream' })
  async *followGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId, signal: AbortSignal): AsyncIterable<ProjectGoalState | null> {
    yield* this.followRecords(() => this.currentGoal(workspaceId, sourceSessionId), 'project_goals', signal)
  }

  /** Read the source's latest entered run without restoring an Agent.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - conversation still belonging to that project.
   * @returns current retained run, or null before first entry; reading does not restore its source.
   */
  @Remote
  currentGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId): ProjectGoalState | null {
    return this.goalRuns.current(workspaceId, sourceSessionId)
  }

  /** Read an exact retained run without using the currently selected conversation.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - owning conversation, still a project member.
   * @param id - retained goal identity.
   * @returns committed run, or null if absent; another source cannot read it.
   */
  @Remote
  inspectGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId): ProjectGoalState | null {
    return this.goalRuns.inspect(workspaceId, sourceSessionId, id)
  }

  /** Exit an exact run without claiming success, removing worktrees or affecting ordinary tasks.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - owning conversation, still a project member.
   * @param id - exact run; an older exited run cannot close a newer one.
   * @param signal - caller lifetime until the write is admitted.
   * @returns retained exited state; an approved run with a running source refuses exit.
   */
  @Remote
  exitGoal(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId, signal: AbortSignal): Promise<ProjectGoalState> {
    return this.goalRuns.exit(workspaceId, sourceSessionId, id, signal)
  }

  /** Persist a conversation proposal without creating a task or requesting model execution.
   * @param workspaceId - writable target project in the source conversation's logical workspace.
   * @param request - immutable draft, source conversation and caller-retained card UUID.
   * @param signal - caller lifetime; a committed card survives cancellation.
   * @returns committed card, including any earlier decision on identical resubmission.
   */
  @Remote
  postCard(workspaceId: WorkspaceId, request: ProjectTaskCardRequest, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.post(workspaceId, request, signal)
  }

  /** Inspect current project changes without accepting a card, restoring a Session or starting execution.
   * @param workspaceId - exact live registered execution project, not the selected conversation's directory.
   * @param signal - read lifetime; cancellation joins the managed Git process.
   * @returns clean, dirty or not-git; permission, Git and output-limit failures reject. This observation grants no execution permission.
   */
  @Remote
  inspectDirectWorkspace(workspaceId: WorkspaceId, signal: AbortSignal): Promise<ProjectTaskDirectWorkspaceState> {
    const path = this.workspace(workspaceId).path
    return this.git.inspectDirectWorkspace(workspaceId, path, () => {
      /* v8 ignore if -- a registered project ID retains its immutable canonical path; workspace() still rejects a removed project. */
      if (this.workspace(workspaceId).path !== path) this.refuse('project-changed')
    }, AbortSignal.any([signal, this.lifetime.signal]))
  }

  /** Persist acceptance, then create and dispatch the card's single reserved task identity.
   * @param workspaceId - original target project, still selected for source-conversation execution.
   * @param cardId - pending or accepted card; dismissal rejects acceptance.
   * @param selection - task-local model and effort, or null to retain the draft/default route; validated before acceptance.
   * @param signal - caller lifetime; retry the same card after an interrupted dispatch.
   * @param allowDirty - explicit consent for this attempt only; false refuses uncommitted direct-project changes.
   * @returns accepted decision after dispatch admission, not task completion; callers are not authenticated as human.
   */
  @Remote
  acceptCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId,
    selection: ModelSelection | null, allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.accept(workspaceId, cardId, signal, selection ?? undefined,
      undefined, undefined, false, undefined, undefined, undefined, allowDirty)
  }

  /** Accept one proposal with explicit executor, optional Harness preset and coding-only review and post-steps.
   * @param workspaceId - original target project selected by the source conversation.
   * @param cardId - pending card or identical retained acceptance.
   * @param request - executor, optional Task-local Harness preset, reviewer and post-steps guidance; retries retain the accepted choices.
   * @param signal - acceptance lifetime; a committed decision survives dispatch failure.
   * @param allowDirty - current gesture's direct-project consent; never retained for another attempt.
   * @returns retained decision after execution admission, not a review verdict.
   */
  @Remote
  async acceptCodingCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, request: ProjectTaskCodingConfirmation,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskCardState> {
    const parsed = codingConfirmationSchema.safeParse(request)
    if (!parsed.success) this.refuse('invalid-proposal')
    const { execution, review, postSteps, reviewSources, knowledgeMaintenance } = parsed.data
    const card = this.cards.inspect(workspaceId, cardId)
    if (card?.status === 'pending') {
      if ((card.draft.research !== undefined || card.draft.artifact !== undefined)
        && (review !== undefined || postSteps !== undefined || reviewSources !== undefined)) this.refuse('review-unavailable')
    }
    if (card?.status === 'pending' && review !== undefined) {
      const path = this.workspace(workspaceId).path
      const guard = (): void => {
        /* v8 ignore if -- a registered project ID retains its immutable canonical path; workspace() still rejects a removed project. */
        if (this.workspace(workspaceId).path !== path) this.refuse('project-changed')
        taskSourceProject(this.ctx, workspaceId, card.sourceSessionId, true)
      }
      guard()
      const baseline = await this.git.reviewBaseline(workspaceId, path, guard, AbortSignal.any([signal, this.lifetime.signal]))
      if (baseline === null) this.refuse('review-unavailable')
    }
    return this.cards.accept(workspaceId, cardId, signal, execution.runtime === 'harness' ? execution.model : undefined,
      execution.runtime === 'codex' ? execution.selection : undefined,
      execution.runtime === 'claude' ? execution.selection : undefined, false, review, postSteps, execution.runtime,
      allowDirty, reviewSources, execution.runtime === 'harness' ? execution.agentPreset : undefined, knowledgeMaintenance)
  }

  /** Accept a proposal into an interactive native Terminal, without dispatching an application task runner.
   * @param workspaceId - original target project.
   * @param cardId - pending card or earlier terminal acceptance.
   * @param selection - native runtime and permissions, or null to retry the retained selection.
   * @param signal - preparation and OS handoff lifetime.
   * @param allowDirty - consent for this handoff attempt only; uncertain retries check again and need fresh consent.
   * @returns retained card after OS acknowledgement; no completion or verification is inferred.
   */
  @Remote
  acceptTerminalCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, selection: ProjectTaskTerminalSelection | null,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskCardState> {
    if (selection !== null && !terminalSelectionSchema.safeParse(selection).success) this.refuse('invalid-proposal')
    return this.cards.accept(workspaceId, cardId, signal, undefined,
      selection?.runtime === 'codex' ? selection.selection : undefined,
      selection?.runtime === 'claude' ? selection.selection : undefined, true, undefined, undefined, undefined, allowDirty)
  }

  /** Accept a conversation proposal with an explicit native Codex runtime selection.
   * @param workspaceId - original execution project.
   * @param cardId - pending card or identical retained acceptance.
   * @param selection - native sandbox and optional native model; may use the configured Codex account quota.
   * @param signal - confirmation lifetime; accepted execution is independent.
   * @param allowDirty - direct-project consent for this attempt, not a persisted permission.
   * @returns retained decision; this does not assert execution or verification success.
   */
  @Remote
  acceptCodexCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, selection: ProjectTaskCodexSelection,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.accept(workspaceId, cardId, signal, undefined, selection,
      undefined, false, undefined, undefined, undefined, allowDirty)
  }

  /** Accept an ordinary conversation proposal for retained native Claude execution.
   * @param workspaceId - original target project.
   * @param cardId - pending card or identical retained acceptance.
   * @param selection - explicit Claude model, effort and permission policy; account quota may be used.
   * @param signal - confirmation lifetime, independent of accepted execution.
   * @param allowDirty - direct-project consent for this attempt, not a persisted permission.
   * @returns durable decision after dispatch admission, not completion.
   */
  @Remote
  acceptClaudeCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, selection: ProjectTaskClaudeSelection,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.accept(workspaceId, cardId, signal, undefined, undefined,
      selection, false, undefined, undefined, undefined, allowDirty)
  }

  /** Dismiss a proposal without creating or cancelling an execution task.
   * @param workspaceId - original target project in the source conversation's logical workspace.
   * @param cardId - pending or dismissed card; accepted cards reject dismissal.
   * @param signal - caller lifetime; committed dismissal survives cancellation.
   * @returns durable dismissed decision.
   */
  @Remote
  dismissCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.dismiss(workspaceId, cardId, signal)
  }

  /** Read a Goal task's collected commit difference without executing or delivering it.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - exact source conversation.
   * @param id - retained Goal identity, not an implicit current run.
   * @param taskId - collected task owned by that run.
   * @param signal - caller lifetime.
   * @returns complete fixed-commit evidence; missing or oversized evidence rejects.
   */
  @Remote
  getGoalTaskDiff(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalTaskDiff> {
    return this.goalRuns.taskDiff(workspaceId, sourceSessionId, id, taskId, signal)
  }

  /** Read complete changed coding file bodies from one delivered Goal Task.
   * @param workspaceId - original project.
   * @param sourceSessionId - owning conversation.
   * @param id - retained Goal run.
   * @param taskId - successful coding Task.
   * @param signal - bounded read lifetime.
   * @returns fixed-commit file versions, digests and UTF-8 bodies; unsupported files reject all evidence.
   */
  @Remote
  getGoalTaskCodingFiles(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalCodingFiles> {
    return this.goalRuns.taskCodingFiles(workspaceId, sourceSessionId, id, taskId, signal)
  }

  /** Supply the Goal source's coding read tool without an additional public result copy.
   * @param workspaceId - original project.
   * @param sourceSessionId - owning conversation.
   * @param id - signed Goal run.
   * @param taskId - successful delivered coding Task.
   * @param signal - bounded Host read lifetime.
   * @returns complete fixed-commit file evidence.
   */
  readGoalTaskCoding(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalCodingFiles> {
    return this.goalRuns.taskCodingFiles(workspaceId, sourceSessionId, id, taskId, signal)
  }

  /** Read one complete signed documentation result for the Goal master's evidence review.
   * @param workspaceId - original registered project.
   * @param sourceSessionId - exact source conversation.
   * @param id - signed Goal run.
   * @param taskId - successful delivered documentation Task.
   * @param expectedVersion - optional frozen directory version for a recheck.
   * @param signal - bounded Host read lifetime.
   * @returns complete directory bytes and digest; failure returns no partial tree.
   */
  readGoalTaskDocumentation(workspaceId: WorkspaceId, sourceSessionId: SessionId, id: ProjectGoalRunId,
    taskId: ProjectTaskId, expectedVersion: string | undefined, signal: AbortSignal): Promise<ArtifactTaskDirectory> {
    return this.goalRuns.taskDocumentation(workspaceId, sourceSessionId, id, taskId, expectedVersion, signal)
  }

  /** Resolve a retained outcome by explicit gesture, independently of fresh-result automatic delivery.
   * @param workspaceId - original target project in the source conversation's logical workspace.
   * @param cardId - accepted proposal with a retained terminal result.
   * @param action - follow up once, mark viewed, or ignore without invoking a model.
   * @param signal - caller lifetime; committed decisions and delivered inputs survive acknowledgement loss.
   * @returns committed card; busy sources buffer follow-up without interruption. Restart or failed source turns restore pending decisions.
   */
  @Remote
  completeCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId, action: 'followup' | 'view' | 'ignore',
    signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.complete(workspaceId, cardId, action, signal)
  }

  /** Explicitly send a knowledge-only review input to the original source conversation.
   * @param workspaceId - original Task project, checked against current membership.
   * @param taskId - completed accepted ordinary Task.
   * @param signal - user command lifetime through durable input admission.
   * @returns the retained card without rerunning Task execution or automatically consuming model quota on reads.
   */
  @Remote
  reviewTaskKnowledge(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.reviewKnowledge(workspaceId, taskId, signal)
  }

  /** Resume queued or retry blocked read-only discovery of a completed Task without selected Brain pages.
   * @param workspaceId - original registered Task project.
   * @param taskId - retained successful ordinary Task.
   * @param requestId - one user gesture UUID; repeat only after uncertain acknowledgement.
   * @param signal - current command lifetime.
   * @returns durable candidate, no-change or explicit blocked state; no Brain write occurs.
   */
  @Remote
  retryTaskKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.retryKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Explicitly recompare a completed Task while preserving prior candidates, decisions and Brain receipts.
   * @param workspaceId - original registered Task project.
   * @param taskId - retained successful ordinary Task.
   * @param requestId - new human gesture UUID, reused only to resolve uncertain acknowledgement.
   * @param signal - current command lifetime.
   * @returns a new read-only verdict or blocked state; old writes remain unchanged.
   */
  @Remote
  refreshTaskKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.refreshKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Recheck a settled Task no-change only after archiving its result and source receipts.
   * @param workspaceId - original registered Task project.
   * @param taskId - completed ordinary Task.
   * @param requestId - human gesture UUID retained across uncertain acknowledgement and restart.
   * @param signal - current command lifetime.
   * @returns card with the archived conclusion and current read-only review status.
   */
  @Remote
  recheckTaskNoChangeKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.recheckNoChangeKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Inspect or retry the existing automatic UUID without granting new knowledge permission.
   * @param workspaceId - original registered project.
   * @param taskId - completed ordinary Task with frozen automatic intent.
   * @param signal - explicit receipt recovery lifetime.
   * @returns retained card; an unknown inspection never repeats a write.
   */
  @Remote
  resumeTaskAutomaticKnowledge(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.resumeAutomaticKnowledge(workspaceId, taskId, signal)
  }

  /** Retain one human disposition before any Task-derived Brain write; exact retries reuse its UUID.
   * @param workspaceId - original Task project.
   * @param taskId - completed ordinary Task with one durable candidate.
   * @param request - dismissal, selected existing page, or new held-draft destination.
   * @param signal - command lifetime; a pending decision survives uncertain writer acknowledgement.
   * @returns card with a dismissal, pending intent, or file-derived receipt.
   */
  @Remote
  decideTaskKnowledge(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectTaskKnowledgeDecisionRequest, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.decideKnowledge(workspaceId, taskId, request, signal)
  }

  /** Inspect the complete current held Task draft and active catalog before a separate publication decision.
   * @param workspaceId - original Task project.
   * @param taskId - Task whose initial draft save has a Brain receipt.
   * @param signal - read lifetime.
   * @returns current held draft body, metadata, version and active catalog digest.
   */
  @Remote
  reviewTaskKnowledgeDraft(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskKnowledgeDraftReview> {
    return this.cards.reviewKnowledgeDraft(workspaceId, taskId, signal)
  }

  /** Read and receipt one versioned active page for this held Task draft.
   * @param workspaceId - original Task project.
   * @param taskId - completed ordinary Task with a saved held draft.
   * @param request - exact draft, catalog and old-page versions from the review.
   * @param signal - read and durable receipt lifetime.
   * @returns full current body or changed; an unavailable read grants no publication authority.
   */
  @Remote
  readTaskKnowledgeCatalogPage(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectTaskKnowledgeCatalogReadRequest, signal: AbortSignal): Promise<ProjectTaskKnowledgeCatalogRead> {
    return this.cards.readKnowledgeCatalogPage(workspaceId, taskId, request, signal)
  }

  /** Publish a held Task draft only after a second human confirmation of its displayed version and catalog.
   * @param workspaceId - original Task project.
   * @param taskId - completed ordinary Task with a saved held draft.
   * @param request - separate UUID and exact version/catalog observation.
   * @param signal - command lifetime; pending publication retains its UUID after uncertainty.
   * @returns card with publication receipt and post-publication review when admitted.
   */
  @Remote
  publishTaskKnowledgeDraft(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectTaskKnowledgePublishRequest, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.publishKnowledgeDraft(workspaceId, taskId, request, signal)
  }

  /** Recheck an uncertain published Task receipt and directory without repeating the publication write.
   * @param workspaceId - original Task project.
   * @param taskId - Task with a retained published Brain receipt and unknown post-publication review.
   * @param signal - read lifetime.
   * @returns card with file-derived verified, required, or still-unknown review.
   */
  @Remote
  reviewTaskKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.reviewKnowledgePublication(workspaceId, taskId, signal)
  }

  /** Read a stable current published page and active catalog before a required human resolution.
   * @param workspaceId - original Task project.
   * @param taskId - Task whose held draft has a published Brain receipt.
   * @param signal - read lifetime.
   * @returns current page text, active pages and exact publication review, or explicit unknown.
   */
  @Remote
  inspectTaskKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskKnowledgePublicationInspection> {
    return this.cards.inspectKnowledgePublication(workspaceId, taskId, signal)
  }

  /** Retain a human resolution of a changed post-publication catalog without rewriting the published page.
   * @param workspaceId - original Task project.
   * @param taskId - Task whose published draft requires human reconciliation.
   * @param request - distinct UUID, currently observed page/catalog versions, choice and note.
   * @param signal - confirmation lifetime.
   * @returns card retaining the original required review and separate human acknowledgement.
   */
  @Remote
  acknowledgeTaskKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectTaskKnowledgeAcknowledgeRequest, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.acknowledgeKnowledgePublication(workspaceId, taskId, request, signal)
  }

  /** Resume only the exact pending human decision retained on a completed Task card.
   * @param workspaceId - original Task project.
   * @param taskId - completed ordinary Task with a pending proposal, draft save or publication.
   * @param signal - retry lifetime; no new UUID or authority is synthesized.
   * @returns file-derived receipt or unchanged terminal decision.
   */
  @Remote
  resumeTaskKnowledgeDecision(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.resumeKnowledgeDecision(workspaceId, taskId, signal)
  }

  /** Stop only the currently admitted Task-knowledge turn; an unrelated source turn is not interrupted.
   * @param workspaceId - original Task project.
   * @param taskId - exact Task whose review is running.
   * @param signal - stop command lifetime.
   * @returns settled or blocked card; an admitted Brain write may have completed before cancellation.
   */
  @Remote
  cancelTaskKnowledgeReview(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskCardState> {
    return this.cards.cancelKnowledgeReview(workspaceId, taskId, signal)
  }

  /** Admit a model verdict only from the exact active source review with complete selected-page evidence.
   * @param agent - exact original source Agent.
   * @param taskId - retained completed Task.
   * @param projectId - original Task project.
   * @param decision - model's explicit no-change or updated judgment.
   * @param reason - bounded explanation retained in the tool call.
   * @param signal - tool execution lifetime.
   * @returns acknowledgement; durable closure waits for a logged tool result and turn end.
   */
  knowledgeDecision(agent: Agent, taskId: ProjectTaskId, projectId: WorkspaceId,
    decision: 'no-change' | 'updated', reason: string, signal: AbortSignal): Promise<string> {
    return this.cards.knowledgeDecision(agent, taskId, projectId, decision, reason, signal)
  }

  /** Read a conversation proposal without restoring an Agent.
   * @param workspaceId - original registered project.
   * @param cardId - retained conversation proposal identity.
   * @returns committed decision, or null for an unknown card.
   */
  @Remote
  inspectCard(workspaceId: WorkspaceId, cardId: ProjectTaskCardId): ProjectTaskCardState | null {
    return this.cards.inspect(workspaceId, cardId)
  }

  /** Read retained cards belonging to one conversation.
   * @param workspaceId - original target project, independent of current execution selection.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @returns oldest-first proposals, including resolved decisions.
   */
  @Remote
  listCards(workspaceId: WorkspaceId, sourceSessionId: SessionId): readonly ProjectTaskCardState[] {
    return this.cards.list(workspaceId, sourceSessionId)
  }

  /** Follow durable conversation proposals without restoring an Agent.
   * @param workspaceId - original target project, independent of current execution selection.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @param signal - request lifetime; controller shutdown also closes this stream.
   * @returns complete replacement card lists; slow readers coalesce intervening writes.
   */
  @Remote({ mode: 'stream' })
  async *followCards(
    workspaceId: WorkspaceId, sourceSessionId: SessionId, signal: AbortSignal,
  ): AsyncIterable<readonly ProjectTaskCardState[]> {
    yield* this.followRecords(() => this.listCards(workspaceId, sourceSessionId), 'project_task_cards', signal)
  }

  /** Follow unresolved task counts across currently registered source workspaces without activating conversations.
   * @param signal - subscriber lifetime; controller shutdown also ends the stream.
   * @returns complete replacement counts after committed card or membership changes; no task text or execution is loaded.
   */
  @Remote({ mode: 'stream' })
  async *followTaskAttention(signal: AbortSignal): AsyncIterable<readonly TaskConversationAttention[]> {
    yield* this.followRecords(() => this.cards.attention(), 'project_task_cards', signal)
  }

  /** Register the Client's current conversation for fresh completion delivery, regardless of task destination or visible tab.
   * @param workspaceId - active project anchoring the selected logical workspace.
   * @param sourceSessionId - currently selected conversation bound to that logical workspace.
   * @param signal - selection and connection lifetime; shutdown and membership loss also withdraw registration.
   * @returns a registration acknowledgement; selecting or reconnecting never drains existing pending outcomes or restores an Agent.
   */
  @Remote({ mode: 'stream' })
  async *followActiveSource(workspaceId: WorkspaceId, sourceSessionId: SessionId, signal: AbortSignal): AsyncIterable<true> {
    yield* this.cards.followActiveSource(workspaceId, sourceSessionId, signal)
  }

  /** Store a proposal, or return the same immutable proposal after a lost acknowledgement.
   * @param workspaceId - registered logical project; no task Session is created here.
   * @param proposal - caller-retained UUID and complete task instructions.
   * @param signal - request lifetime; a committed write survives caller cancellation.
   * @returns committed draft or the current state of an identical earlier proposal.
   */
  @Remote
  propose(workspaceId: WorkspaceId, proposal: ProjectTaskProposal, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.proposeTask(workspaceId, proposal, signal)
  }

  private proposeTask(workspaceId: WorkspaceId, proposal: ProjectTaskProposal, signal: AbortSignal,
    goal?: ProjectGoalTaskBinding, sourceSessionId?: SessionId): Promise<ProjectTaskState> {
    const parsed = proposalSchema.safeParse(proposal)
    if (!parsed.success) this.refuse('invalid-proposal')
    const accepted = parsed.data
    if (!validTaskIsolation(accepted)) this.refuse('invalid-proposal')
    if (Buffer.byteLength(JSON.stringify(accepted), 'utf8') > this.config.maxProposalBytes) this.refuse('proposal-too-large')
    const source = sourceSessionId ?? accepted.research?.sourceSessionId ?? accepted.artifact?.sourceSessionId
    return this.commands.run(accepted.id, signal, async (lifetime) => {
      const workspace = this.workspace(workspaceId)
      if (source !== undefined) taskSourceProject(this.ctx, workspaceId, source, true)
      if (sourceSessionId !== undefined && accepted.research !== undefined && sourceSessionId !== accepted.research.sourceSessionId) this.refuse('invalid-proposal')
      if (accepted.artifact !== undefined && ((goal !== undefined
        && (goal.gather === true || goal.probe === true || goal.request.taskType !== 'documentation'))
        || (sourceSessionId !== undefined && sourceSessionId !== accepted.artifact.sourceSessionId))) this.refuse('invalid-proposal')
      const existing = this.table.get(accepted.id)
      if (existing !== undefined) {
        this.assertOwner(existing, workspaceId)
        if (JSON.stringify(existing.proposal) !== JSON.stringify(accepted)
          || JSON.stringify(existing.goal) !== JSON.stringify(goal)
          || (existing.sourceSessionId !== undefined && existing.sourceSessionId !== source)) this.refuse('proposal-changed')
        return taskState(existing)
      }
      const retained = [...this.table.entries()].filter(([, record]) => record.workspaceId === workspaceId).length
      const release = this.commands.reserveProject(workspaceId, retained, this.config.maxTasksPerProject, 'task-limit')
      try {
        const now = Date.now()
        const record: ProjectTaskRecord = { proposal: accepted, workspaceId, workspacePath: workspace.path,
          ...(source === undefined ? {} : { sourceSessionId: source }),
          createdAt: now, updatedAt: now, status: 'draft', verifyCheckedIndices: [], closedReason: null,
          ...(goal === undefined ? {} : { goal }) }
        lifetime.throwIfAborted()
        await this.table.put(accepted.id, record)
        return taskState(record)
      } finally { release() }
    })
  }

  /** Start an unconfirmed task, or retry its accepted background card using that card's original execution choices.
   * @param workspaceId - original registered project; direct execution uses this project directory.
   * @param taskId - persisted proposal; repeated confirmation never starts another execution.
   * @param signal - cancellation before dispatch stops preparation; accepted execution outlives the request.
   * @param allowDirty - consent to current direct-project changes for this attempt only; Git errors still reject.
   * @returns durable task state, not a claim that acceptance criteria or verification passed.
   */
  @Remote
  confirm(workspaceId: WorkspaceId, taskId: ProjectTaskId, allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    this.lifetime.signal.throwIfAborted()
    signal.throwIfAborted()
    return Promise.resolve().then(async () => {
      const record = this.record(workspaceId, taskId)
      if (record.status === 'draft' && record.sourceSessionId !== undefined
        && record.goal === undefined && this.cards.executionConfirmation(taskId) !== undefined) {
        await this.cards.retryExecution(workspaceId, taskId, signal, allowDirty)
        return taskState(this.record(workspaceId, taskId))
      }
      return this.confirmTask(workspaceId, taskId, signal, 'ordinary', undefined, undefined, undefined, allowDirty)
    })
  }

  /** Freeze a Task-local Harness preset and optional coding review and post-steps before ordinary execution.
   * @param workspaceId - original registered execution project.
   * @param taskId - unconfirmed task or identical previously dispatched execution.
    * @param request - explicit executor, optional Task-local Harness preset, reviewer and testing/fix guidance; coding-only choices
    * reject unsupported tasks before dispatch.
   * @param signal - confirmation lifetime, independent of accepted execution.
   * @param allowDirty - this attempt's consent to direct-project changes; never saved in the execution choices.
   * @returns retained execution identity and choices, not a test or review verdict.
   */
  @Remote
  confirmCoding(workspaceId: WorkspaceId, taskId: ProjectTaskId, request: ProjectTaskCodingConfirmation,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    const parsed = codingConfirmationSchema.safeParse(request)
    if (!parsed.success) this.refuse('invalid-proposal')
    const { execution, review, postSteps, reviewSources, knowledgeMaintenance } = parsed.data
    return execution.runtime === 'harness'
      ? this.confirmTask(workspaceId, taskId, signal, 'ordinary', review, execution.model, postSteps, allowDirty, reviewSources, execution.agentPreset, knowledgeMaintenance)
      : this.confirmNativeTask(workspaceId, taskId, execution, signal, 'ordinary', review, postSteps, allowDirty, reviewSources, knowledgeMaintenance)
  }

  /** Verify explicit imported source selections before a Task confirmation becomes durable.
   * @param workspaceId - original Task project, also required to own each import.
   * @param selections - exact user-selected import, Session and document identities.
   * @param signal - confirmation lifetime.
   * @returns immutable source/conversion digests; no source bytes are retained on the Task.
   */
  async validateReviewSources(workspaceId: WorkspaceId, selections: readonly ProjectTaskReviewSourceSelection[],
    signal: AbortSignal): Promise<readonly ProjectTaskReviewSourceReceipt[]> {
    const parsed = zod.array(taskReviewSourceSelectionSchema).min(1).safeParse(selections)
    if (!parsed.success || new Set(parsed.data.map(item => JSON.stringify([item.importId, item.documentId]))).size
      !== parsed.data.length || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > this.config.knowledgeDiscovery.maxInputBytes) {
      this.refuse('invalid-proposal')
    }
    const reader = this.taskReviewSourceReader
    if (reader === undefined) this.refuse('knowledge-review-unavailable')
    const receipts: ProjectTaskReviewSourceReceipt[] = []
    let total = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
    for (const selection of parsed.data) {
      const source = await reader.read(workspaceId, selection, signal)
      total += source.textBytes
      if (total > this.config.knowledgeDiscovery.maxInputBytes) this.refuse('knowledge-review-unavailable')
      receipts.push({ ...selection, sourceSha256: source.sourceSha256,
        textSha256: source.textSha256, textBytes: source.textBytes })
    }
    return receipts
  }

  /** Re-read a Task's selected originals through the import owner, refusing changed bytes or ownership.
   * @param workspaceId - retained Task project.
   * @param taskId - exact confirmed Task whose reviewer is opening evidence.
   * @param signal - complete read lifetime.
   * @param options - actual reviewer route and complete selected-source image budget; omission only verifies source and text.
   * @returns original-verified text and optional PDF/DOCX images, in the person's confirmation order with one shared image budget.
   */
  async readTaskReviewSources(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal, options?: ProjectTaskReviewSourceVisualOptions): Promise<readonly ProjectTaskReviewSource[]> {
    const record = this.record(workspaceId, taskId)
    const retained = record.reviewSources
    if (retained === undefined) return []
    const reader = this.taskReviewSourceReader
    if (reader === undefined) this.refuse('knowledge-review-unavailable')
    const sources: ProjectTaskReviewSource[] = []
    let total = 0
    let remaining = options
    for (const receipt of retained) {
      const source = await reader.read(workspaceId, receipt, signal, remaining)
      if (source.sourceSha256 !== receipt.sourceSha256 || source.textSha256 !== receipt.textSha256
        || source.textBytes !== receipt.textBytes) this.refuse('knowledge-review-conflict')
      total += source.textBytes
      if (total > this.config.knowledgeDiscovery.maxInputBytes) this.refuse('knowledge-review-unavailable')
      if (remaining !== undefined) {
        const images = [...(source.pdfVisual?.images.map(image => image.attachment) ?? []), ...(source.docxVisual?.images ?? [])]
        const bytes = images.reduce((sum, image) => sum + image.bytes, 0)
        if (images.length > remaining.maxImages || bytes > remaining.maxTotalBytes) this.refuse('knowledge-review-unavailable')
        remaining = { ...remaining, maxImages: remaining.maxImages - images.length, maxTotalBytes: remaining.maxTotalBytes - bytes }
      }
      sources.push(source)
    }
    signal.throwIfAborted()
    this.assertOwner(record, workspaceId)
    /* v8 ignore if -- execution freezes source receipts; later Task writes retain them and stored records are immutable. */
    if (JSON.stringify(this.table.get(taskId)?.reviewSources) !== JSON.stringify(retained)) this.refuse('knowledge-review-conflict')
    return sources
  }

  /** Start a bounded read-only review through an explicit user gesture; acceptance is not a verdict.
   * @param workspaceId - original registered project.
   * @param taskId - ordinary coding execution with a captured Git baseline.
   * @param policy - reviewer route and confirmed fallback authority, retained with the call.
   * @param signal - cancellation before admission; accepted work continues in the background.
   * @returns retained call and task state; repeated pending starts never spend another call.
   */
  @Remote
  startReview(workspaceId: WorkspaceId, taskId: ProjectTaskId, policy: ProjectTaskReviewPolicy,
    signal: AbortSignal): Promise<ProjectTaskState> {
    return this.reviews.start(workspaceId, taskId, policy, signal)
  }

  /** Cancel only the active review and join its worker without modifying the task executor.
   * @param workspaceId - original registered project.
   * @param taskId - exact task whose reviewer must stop.
   * @param signal - request cancellation before admission of cancellation intent.
   * @returns the durably closed review, or unchanged completed assessment.
   */
  @Remote
  cancelReview(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.reviews.cancel(workspaceId, taskId, signal)
  }

  /** Confirm an ordinary task using the native Codex account and explicitly selected sandbox.
   * @param workspaceId - original registered project.
   * @param taskId - frozen ordinary proposal; research requires read-only mode, and Goal tasks remain separate.
   * @param selection - native model and sandbox, never a Harness provider selection.
   * @param signal - preparation lifetime; committed execution continues independently.
   * @param allowDirty - this attempt's direct-project consent; Git checks still run and errors reject.
   * @returns retained dispatch identity; duplicate confirmation never starts a second native thread.
   */
  @Remote
  confirmCodex(workspaceId: WorkspaceId, taskId: ProjectTaskId, selection: ProjectTaskCodexSelection,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.confirmCodexTask(workspaceId, taskId, selection, signal, 'ordinary', allowDirty)
  }

  private confirmCodexTask(workspaceId: WorkspaceId, taskId: ProjectTaskId, selection: ProjectTaskCodexSelection,
    signal: AbortSignal, source: 'ordinary' | 'goal', allowDirty = false,
    automaticReview?: ProjectTaskReviewPolicy, postSteps?: ProjectTaskPostSteps): Promise<ProjectTaskState> {
    const parsed = codexSelectionSchema.safeParse(selection)
    if (!parsed.success) this.refuse('invalid-proposal')
    return this.confirmNativeTask(workspaceId, taskId, { runtime: 'codex', selection: parsed.data }, signal, source,
      automaticReview, postSteps, allowDirty)
  }

  /** Confirm a Task with explicit Claude permissions; research enforces read-only tools.
   * @param workspaceId - original registered project.
   * @param taskId - frozen ordinary proposal; signed Goal routes require separate admission.
   * @param selection - native model, effort and non-interactive permission policy.
   * @param signal - preparation lifetime; a committed execution continues independently.
   * @param allowDirty - this attempt's direct-project consent; it is not retained after acknowledgement loss.
   * @returns retained dispatch identity; retries never spawn a second native session.
   */
  @Remote
  confirmClaude(workspaceId: WorkspaceId, taskId: ProjectTaskId, selection: ProjectTaskClaudeSelection,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    const parsed = claudeSelectionSchema.safeParse(selection)
    if (!parsed.success) this.refuse('invalid-proposal')
    return this.confirmNativeTask(workspaceId, taskId, { runtime: 'claude', selection: parsed.data }, signal, 'ordinary', undefined, undefined, allowDirty)
  }

  private confirmNativeTask(workspaceId: WorkspaceId, taskId: ProjectTaskId, native: NativeTaskSelection,
    signal: AbortSignal, source: 'ordinary' | 'goal', automaticReview?: ProjectTaskReviewPolicy,
    postSteps?: ProjectTaskPostSteps, allowDirty = false,
    reviewSources?: readonly ProjectTaskReviewSourceSelection[],
    knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode): Promise<ProjectTaskState> {
    return this.commands.run(taskId, signal, async (lifetime) => {
      let record = this.record(workspaceId, taskId)
      this.assertExecutionConfirmation(record, automaticReview, postSteps, native, reviewSources)
      if (record.proposal.artifact !== undefined
        && (native.runtime === 'codex' ? native.selection.sandbox !== 'workspace-write'
          : native.selection.permissionMode !== 'dontAsk')) this.refuse('invalid-proposal')
      if (source === 'ordinary' && record.goal !== undefined) this.refuse('goal-task-required')
      if (native.runtime === 'claude' && (record.proposal.research === undefined
        ? native.selection.permissionMode === 'plan' : native.selection.permissionMode !== 'plan')) this.refuse('invalid-proposal')
      if (record.goal !== undefined) {
        const signed = record.goal.model
        if (!isNativeGoalModel(signed) || signed.runtime !== native.runtime || signed.model !== native.selection.model) this.refuse('proposal-changed')
        if (native.runtime === 'codex') {
          if (signed.reasoningEffort !== native.selection.reasoningEffort
            || native.selection.sandbox !== (record.proposal.research === undefined ? 'workspace-write' : 'read-only')) this.refuse('proposal-changed')
        } else if (signed.runtime !== 'claude' || signed.reasoningEffort !== native.selection.effort
          || native.selection.permissionMode !== (record.proposal.research === undefined ? signed.permissionMode : 'plan')) this.refuse('proposal-changed')
      }
      if (record.proposal.research !== undefined && native.runtime === 'codex' && native.selection.sandbox !== 'read-only') this.refuse('invalid-proposal')
      record = await this.freezeKnowledgeMaintenance(record, knowledgeMaintenance)
      if (record.execution !== undefined) {
        if ((record.execution.runtime !== 'codex' && record.execution.runtime !== 'claude') || record.execution.runtime !== native.runtime
          || JSON.stringify(record.execution.selection) !== JSON.stringify(native.selection)) this.refuse('proposal-changed')
        return taskState(record)
      }
      if (record.status !== 'draft') return taskState(record)
      if (this.executions.size + this.preparing.size >= this.config.maxExecutions) this.refuse('busy')
      this.preparing.add(taskId)
      try {
        await this.assertDirectAdmission(record, allowDirty, lifetime)
        const boundSources = reviewSources === undefined ? undefined
          : await this.validateReviewSources(workspaceId, reviewSources, lifetime)
        const knowledge = await this.captureKnowledge(record, 'files', lifetime)
        const knowledgeTools = this.knowledgeTools?.create({ id: record.workspaceId, path: record.workspacePath })
        lifetime.throwIfAborted()
        this.assertDispatchOwner(record)
        record = await this.prepareTask(record, lifetime)
        this.assertReviewBaseline(record, automaticReview)
        lifetime.throwIfAborted()
        this.assertDispatchOwner(record)
        const { model: _harnessModel, ...nativeProposal } = record.proposal
        record = { ...record, status: 'dispatched', updatedAt: Math.max(record.updatedAt, Date.now()),
          ...(record.proposal.artifact === undefined ? {} : { artifactWriteProtocol: 'host-checkpoint-v2' as const }),
          ...(record.proposal.research === undefined ? {} : { researchWriteProtocol: 'host-checkpoint-v1' as const }),
          ...this.dispatchOptions(record, automaticReview, postSteps, boundSources), execution: {
            ...(native.runtime === 'codex' ? { runtime: 'codex' as const, selection: native.selection }
              : { runtime: 'claude' as const, selection: native.selection,
                nativeSessionId: brandString<ProjectTaskClaudeSessionId>(randomUUID()), initialized: false }),
            sessionId: brandString<SessionId>(`session-${randomUUID()}`), messageId: brandString<MessageId>(randomUUID()),
            inputText: JSON.stringify({ projectPath: this.executionDirectory(record), ...nativeProposal,
              ...this.dispatchInputPolicy(record, automaticReview, postSteps),
              ...(record.proposal.research === undefined && record.proposal.artifact === undefined
                ? {} : { sourceProjectPath: record.workspacePath }),
              resultFormat: record.proposal.artifact !== undefined ? (native.runtime === 'codex' ? codexArtifactInstruction : nativeArtifactInstruction)
                : record.proposal.research === undefined ? taskWrapUpInstruction : nativeResearchInstruction,
              ...this.dispatchInputContext(record, knowledge) }),
          } }
        await this.table.put(taskId, record)
        const cancel = new AbortController()
        if (this.lifetime.signal.aborted) cancel.abort('disposed')
        const offProject = this.ctx.on('domain/changed', (change) => {
          if (change.domain !== 'workspace') return
          try { this.assertDispatchOwner(record) }
          catch { cancel.abort('project-changed') }
        }, { global: true })
        const changed = async (nativeId?: ProjectTaskCodexThreadId | ProjectTaskClaudeSessionId): Promise<void> => {
          await this.table.update(taskId, (current) => {
            const execution = current.execution
            if (execution?.runtime !== 'codex' && execution?.runtime !== 'claude') throw new Error('Native Task lost its execution identity')
            if (execution.runtime === 'claude' && nativeId !== undefined && nativeId !== execution.nativeSessionId) {
              throw new Error('Claude Task init identity changed')
            }
            return { ...current, status: 'running', updatedAt: Math.max(current.updatedAt, Date.now()),
              execution: execution.runtime === 'codex'
                ? { ...execution, ...(nativeId === undefined ? {} : { threadId: brandString<ProjectTaskCodexThreadId>(nativeId) }) }
                : { ...execution, initialized: execution.initialized || nativeId !== undefined } }
          })
        }
        const running = Promise.resolve().then(() => {
          assert(record.execution !== undefined)
          const reviewScope = this.reviews.openExecution(workspaceId, taskId, record.execution.sessionId, cancel.signal)
          return native.runtime === 'codex'
            ? executeCodexTask(this.ctx, record, this.executionDirectory(record), this.config.codex,
              cancel.signal, changed, knowledgeTools, reviewScope, this.artifactFiles,
              () => { this.assertDispatchOwner(record) }, this.researchFiles)
            : executeClaudeTask(this.ctx, record, this.executionDirectory(record), this.config.claude,
              record.proposal.artifact === undefined ? this.config.research.maxSteps : this.config.artifact.maxSteps,
              cancel.signal, changed, knowledgeTools, reviewScope, this.artifactFiles,
              () => { this.assertDispatchOwner(record) }, this.researchFiles)
        })
        const done = running
          .then(async () => {
            const current = this.table.get(taskId)
            assert(current !== undefined)
            assert(current.execution !== undefined)
            const execution = current.execution
            await using handle = await this.ctx.sessionPersistence.open(current.execution.sessionId, 'read')
            const events = (await handle.read()).events
            const outcome = await this.researchOutcome(current, taskSettlement(events, execution.messageId), events)
            const terminal = await this.table.update(taskId, value => ({ ...value,
              execution, ...outcome, updatedAt: Math.max(value.updatedAt, Date.now()) }))
            await this.cleanupResearch(terminal)
            const observed = await this.retainOutputInventory(terminal, true)
            const published = await this.retainCompletionReport(observed, events)
            await this.cards.captureCompletion(published)
            this.goalRuns.captureCompletion(published)
          }).catch(async (error: unknown) => {
            this.ctx.logger.error('Native Task audit or completion failed', error)
            await this.table.update(taskId, value => value.status === 'dispatched' || value.status === 'running'
              ? { ...value, status: 'closed-failed', closedReason: 'execution-log-error', updatedAt: Math.max(value.updatedAt, Date.now()) }
              : value)
          }).finally(() => { offProject(); this.executions.delete(taskId) })
        void done.catch((error: unknown) => { this.ctx.logger.error('Native Task settlement could not be persisted', error) })
        this.executions.set(taskId, { cancel: (disposed) => { cancel.abort(disposed ? 'disposed' : 'user') }, done })
        return taskState(record)
      } finally { this.preparing.delete(taskId) }
    })
  }

  private async freezeKnowledgeMaintenance(record: ProjectTaskRecord,
    requested: ProjectTaskKnowledgeMaintenanceMode | undefined): Promise<ProjectTaskRecord> {
    const retained = record.goal === undefined ? this.cards.maintenanceAuthorization(record.proposal.id)
      : this.goalRuns.maintenanceAuthorization(record)
    const current = record.knowledgeMaintenanceAuthorization
    if (requested !== undefined && retained === undefined
      && (record.goal !== undefined || this.cards.executionConfirmation(record.proposal.id) !== undefined)) this.refuse('proposal-changed')
    if (requested !== undefined && (current !== undefined ? current.mode !== requested
      : retained !== undefined ? retained.mode !== requested : record.execution !== undefined)) this.refuse('proposal-changed')
    if (current !== undefined) {
      if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(current)) this.refuse('proposal-changed')
      return record
    }
    // Released executions and omitted confirmations never receive retrospective write authority.
    if (record.execution !== undefined) return record
    let authorization: ProjectTaskKnowledgeMaintenanceAuthorization
    if (retained === undefined) {
      if (requested === undefined) return record
      authorization = { mode: requested, authorizationId: brandString<ProjectTaskKnowledgeAuthorizationId>(randomUUID()) }
    } else authorization = retained
    const next = { ...record, knowledgeMaintenanceAuthorization: authorization }
    await this.table.put(record.proposal.id, next)
    return next
  }

  private confirmTask(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal,
    source: 'ordinary' | 'goal', automaticReview?: ProjectTaskReviewPolicy,
    requestedModel?: ModelSelection, postSteps?: ProjectTaskPostSteps, allowDirty = false,
    reviewSources?: readonly ProjectTaskReviewSourceSelection[], requestedPreset?: AgentPresetRow['id'],
    knowledgeMaintenance?: ProjectTaskKnowledgeMaintenanceMode): Promise<ProjectTaskState> {
    return this.commands.run(taskId, signal, async (lifetime) => {
      let record = this.record(workspaceId, taskId)
      const retained = this.cards.executionConfirmation(taskId)
      const agentPreset = requestedPreset ?? (retained?.execution.runtime === 'harness' ? retained.execution.agentPreset : undefined)
      this.assertExecutionConfirmation(record, automaticReview, postSteps,
        { runtime: 'harness', ...(requestedModel === undefined ? {} : { model: requestedModel }),
          ...(agentPreset === undefined ? {} : { agentPreset }) }, reviewSources)
      if (source === 'ordinary' && record.goal !== undefined) this.refuse('goal-task-required')
      if (record.execution?.runtime === 'codex' || record.execution?.runtime === 'claude') this.refuse('proposal-changed')
      if (record.execution !== undefined && requestedPreset !== undefined
        && record.execution.agentPreset !== requestedPreset) this.refuse('proposal-changed')
      if (record.execution !== undefined && requestedModel !== undefined) {
        const resolved = await this.ctx.llm.resolveCallConfig({ provider: requestedModel.provider, model: requestedModel.model,
          ...(requestedModel.reasoningEffort === undefined ? {}
            : { reasoningEffort: ReasoningEffortId(requestedModel.reasoningEffort) }) }, lifetime)
        if (resolved.provider !== record.execution.provider || resolved.model !== record.execution.model
          || resolved.reasoningEffort !== record.execution.reasoningEffort) this.refuse('proposal-changed')
      }
      record = await this.freezeKnowledgeMaintenance(record, knowledgeMaintenance)
      if (record.status !== 'draft' && record.status !== 'dispatched' && record.status !== 'running') return taskState(record)
      if (this.executions.has(taskId)) return taskState(record)
      if (this.executions.size + this.preparing.size >= this.config.maxExecutions) this.refuse('busy')
      this.preparing.add(taskId)
      try {
        if (record.execution === undefined) {
          await this.assertDirectAdmission(record, allowDirty, lifetime)
          const boundSources = reviewSources === undefined ? undefined
            : await this.validateReviewSources(workspaceId, reviewSources, lifetime)
          const route = requestedModel ?? record.goal?.model ?? record.proposal.model ?? this.ctx.agentDefaultModel.currentSelection()
          if (isNativeGoalModel(route)) this.refuse('proposal-changed')
          const selection = await this.ctx.llm.resolveCallConfig({ provider: route.provider, model: route.model,
            ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) }, lifetime)
          const presets = this.ctx.get('agentPresets')
          if (presets === undefined && agentPreset !== undefined) {
            throw new RemoteError('agent-preset/invalid', 'Task preset selection requires an available preset registry',
              { agentPreset, reason: 'preset registry unavailable' })
          }
          const selectedPreset = presets === undefined ? undefined : await presets.resolve(agentPreset)
          if (selectedPreset?.broken !== undefined) {
            throw new RemoteError('agent-preset/invalid', selectedPreset.broken,
              { agentPreset: selectedPreset.id, reason: selectedPreset.broken })
          }
          lifetime.throwIfAborted()
          this.assertDispatchOwner(record)
          const knowledge = await this.captureKnowledge(record, 'tools', lifetime)
          lifetime.throwIfAborted()
          this.assertDispatchOwner(record)
          record = await this.prepareTask(record, lifetime)
          this.assertReviewBaseline(record, automaticReview)
          record = { ...record, status: 'dispatched', updatedAt: Math.max(record.updatedAt, Date.now()),
            ...this.dispatchOptions(record, automaticReview, postSteps, boundSources), execution: {
              sessionId: brandString<SessionId>(`session-${randomUUID()}`),
              messageId: brandString<MessageId>(randomUUID()), provider: selection.provider, model: selection.model,
              ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
              ...(selectedPreset === undefined ? {} : { agentPreset: selectedPreset.id }),
              inputText: JSON.stringify({ projectPath: this.executionDirectory(record), ...record.proposal,
                ...this.dispatchInputPolicy(record, automaticReview, postSteps),
                resultFormat: record.proposal.artifact !== undefined ? artifactInstruction
                  : record.proposal.research === undefined ? taskWrapUpInstruction : researchInstruction,
                ...this.dispatchInputContext(record, knowledge) }),
            } }
          await this.table.put(taskId, record)
        } else record = await this.prepareTask(record, lifetime)
        const execution = record.execution
        assert(execution !== undefined)
        assert(execution.runtime !== 'codex' && execution.runtime !== 'claude')
        lifetime.throwIfAborted()
        this.assertDispatchOwner(record)
        const location = record.proposal.isolation === 'direct' ? { workspaceId } : { cwd: this.executionDirectory(record) }
        await this.ctx.sessionController.create({ ...location, sessionId: execution.sessionId,
          ...(execution.agentPreset === undefined ? {} : { agentPreset: execution.agentPreset }) })
        lifetime.throwIfAborted()
        this.assertDispatchOwner(record)
        const found = await this.ctx.sessionController.resolveAgent(execution.sessionId)
        if ('error' in found) throw found.error
        const { agent } = found
        let releaseResearch: (() => void) | undefined
        let releaseReview: (() => void) | undefined
        let reviewScope: TaskReviewScope | undefined
        const reviewCancellation = new AbortController()
        try {
          reviewScope = this.reviews.openExecution(workspaceId, taskId, execution.sessionId,
            AbortSignal.any([this.lifetime.signal, reviewCancellation.signal]))
          if (reviewScope !== undefined) releaseReview = installTaskReviewTools(agent, reviewScope)
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          const delivered = agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === execution.messageId))
          if (record.proposal.research !== undefined) {
            releaseResearch = this.researchFiles.install(agent, record,
              () => { this.assertDispatchOwner(record) }, this.config.researchWorkers)
          } else if (record.proposal.artifact !== undefined) {
            releaseResearch = this.artifactFiles.install(agent, record, () => { this.assertDispatchOwner(record) })
          }
          if (!delivered) {
            await this.ctx.sessionController.selectModel({ sessionId: execution.sessionId,
              provider: execution.provider, model: execution.model,
              ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }), persistDefault: false })
            await this.table.update(taskId, current => ({ ...current, execution,
              status: 'running', updatedAt: Math.max(current.updatedAt, Date.now()) }))
            lifetime.throwIfAborted()
            this.assertDispatchOwner(record)
            agent.followup(freezeMessage({ role: 'user', id: execution.messageId, source: { kind: 'project-task', taskId,
              ...(record.goal === undefined ? {} : { goal: taskState(record).goal }) },
            content: [{ type: 'text', text: execution.inputText }] }))
          }
          const release = releaseResearch
          const scope = reviewScope
          const releaseTools = releaseReview
          const done = this.settle(taskId, agent, execution, scope).finally(() => {
            release?.(); releaseTools?.(); this.executions.delete(taskId)
          })
          releaseResearch = undefined
          reviewScope = undefined
          releaseReview = undefined
          void done.catch((error: unknown) => { this.ctx.logger.error('task settlement could not be persisted', error) })
          this.preparing.delete(taskId)
          this.executions.set(taskId, { cancel: (disposed) => {
            reviewCancellation.abort(disposed ? 'disposed' : 'user')
            agent.cancel({ kind: disposed ? 'disposed' : 'user' })
          }, done })
          if (!await this.ctx.sessions.flush(agent.session)) throw new Error('task confirmation has no Session durability listener')
          return taskState(this.record(workspaceId, taskId))
        } finally { releaseResearch?.(); releaseReview?.(); await reviewScope?.[Symbol.asyncDispose]() }
      } finally { this.preparing.delete(taskId) }
    })
  }

  /** Cancel a draft or request cancellation and join the task's actual execution.
   * @param workspaceId - original registered logical project.
   * @param taskId - task to cancel; terminal results are preserved.
   * @param signal - caller lifetime; cancellation intent remains effective after request loss.
   * @returns committed terminal state after execution quiescence, or an unchanged terminal result.
   */
  @Remote
  cancel(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.commands.run(taskId, signal, async () => {
      const record = this.record(workspaceId, taskId)
      const active = this.executions.get(taskId)
      if (active !== undefined) {
        active.cancel(false)
        await active.done
        return taskState(this.record(workspaceId, taskId))
      }
      if (record.status.startsWith('closed-') || record.status === 'opened-terminal') return taskState(record)
      const next = { ...record, status: 'closed-cancelled' as const, closedReason: 'cancelled', updatedAt: Math.max(record.updatedAt, Date.now()) }
      await this.table.put(taskId, next)
      await this.cleanupResearch(next)
      await this.cards.captureCompletion(next)
      return taskState(next)
    })
  }

  /** Persist human verification separately from execution status.
   * @param workspaceId - original registered project.
   * @param taskId - task whose frozen verification steps are being reviewed.
   * @param indices - unique zero-based indices of checked steps; invalid indices are rejected.
   * @param signal - caller lifetime, independent of the task execution.
   * @returns committed checklist without changing the task's execution result.
   */
  @Remote
  verify(workspaceId: WorkspaceId, taskId: ProjectTaskId, indices: readonly number[], signal: AbortSignal): Promise<ProjectTaskState> {
    return this.commands.run(taskId, signal, async () => {
      const record = this.record(workspaceId, taskId)
      if (new Set(indices).size !== indices.length
        || indices.some(index => !Number.isInteger(index) || index < 0 || index >= record.proposal.verifySteps.length)) this.refuse('invalid-checks')
      const next = await this.table.update(taskId, current => ({ ...current,
        verifyCheckedIndices: [...indices].sort((a, b) => a - b), updatedAt: Math.max(current.updatedAt, Date.now()) }))
      return taskState(next)
    })
  }

  /** Read a task without creating an Agent or restarting interrupted work.
   * @param workspaceId - original registered project.
   * @param taskId - persisted proposal identity.
   * @returns committed task metadata, or null for an unknown identity.
   */
  @Remote
  inspect(workspaceId: WorkspaceId, taskId: ProjectTaskId): ProjectTaskState | null {
    this.lifetime.signal.throwIfAborted()
    this.workspace(workspaceId)
    const record = this.table.get(taskId)
    if (record === undefined) return null
    this.assertOwner(record, workspaceId)
    const review = this.cards.knowledgeReview(taskId)
    const knowledgeCompletion = this.cards.knowledgeCompletion(workspaceId, taskId)
    return { ...taskState(record), ...(review === undefined ? {} : { knowledgeReview: review }),
      ...(knowledgeCompletion === undefined ? {} : { knowledgeCompletion }) }
  }

  /** Read one Task's retained file metadata without scanning its checkout.
   * @param workspaceId - original project, checked against the durable Task owner.
   * @param taskId - retained coding Task identity.
   * @returns observed paths or null for records without a file-observation intent.
   */
  @Remote
  listOutputFiles(workspaceId: WorkspaceId, taskId: ProjectTaskId): ProjectTaskOutputInventory | null {
    const record = this.record(workspaceId, taskId)
    this.assertOutputReadOwner(record)
    return record.outputInventory ?? null
  }

  /** List every file of a successful published documentation Task without altering historical records.
   * @param workspaceId - registered original project.
   * @param taskId - exact Task that retained the published directory rendition.
   * @param signal - cancels the complete bounded Host scan.
   * @returns complete Task-scoped metadata, or null for a non-documentation Task.
   */
  @Remote
  async listDocumentationFiles(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskDocumentationInventory | null> {
    const record = this.record(workspaceId, taskId)
    if (record.proposal.artifact === undefined || record.artifactOutput === undefined
      || record.status !== 'closed-success') return null
    this.assertDocumentationReadOwner(record)
    const listing = await this.ctx.artifactController.listTaskDirectoryFiles(workspaceId, record.workspacePath,
      brandString<ArtifactTaskId>(taskId), record.artifactOutput.artifactId, signal)
    this.assertDocumentationReadOwner(record)
    const files = listing.files.map(file => ({ id: documentationOutputId(taskId, file.path), path: file.path,
      change: 'added' as const, bytes: file.bytes, version: file.sha256,
      readable: file.bytes <= this.config.outputFiles.maxReadBytes }))
    const inventory: ProjectTaskDocumentationInventory = { status: 'available', observedAt: record.updatedAt,
      files, truncated: false, artifactId: record.artifactOutput.artifactId,
      directoryVersion: `${listing.version}:${listing.digest}` }
    if (files.length > this.config.outputFiles.maxEntries
      || files.some(file => Buffer.byteLength(file.path, 'utf8') > this.config.outputFiles.maxPathBytes)
      || Buffer.byteLength(JSON.stringify(inventory), 'utf8') > this.config.outputFiles.maxInventoryBytes) {
      throw new RemoteError('project-task/output-file', 'Task documentation listing is too-large.', { reason: 'too-large' })
    }
    return inventory
  }

  /** Read one listed documentation file only while the complete published directory is unchanged.
   * @param workspaceId - registered original project.
   * @param taskId - exact successful documentation Task.
   * @param fileId - opaque Task/path identity returned by the Host listing.
   * @param directoryVersion - exact listing version including its whole-tree digest.
   * @param signal - cancels both bounded Host checks.
   * @returns only the selected file's bytes and content version.
   */
  @Remote
  async readDocumentationFile(workspaceId: WorkspaceId, taskId: ProjectTaskId, fileId: ProjectTaskOutputFileId,
    directoryVersion: string, signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    const listed = await this.listDocumentationFiles(workspaceId, taskId, signal)
    if (listed === null) throw new RemoteError('project-task/output-file', 'Task documentation file is unavailable.', { reason: 'unavailable' })
    if (listed.directoryVersion !== directoryVersion) {
      throw new RemoteError('project-task/output-file', 'Task documentation file is stale.', { reason: 'stale' })
    }
    const file = listed.files.find(item => item.id === fileId)
    if (file === undefined || file.version === null) {
      throw new RemoteError('project-task/output-file', 'Task documentation file is not-found.', { reason: 'not-found' })
    }
    if (file.bytes !== null && file.bytes > this.config.outputFiles.maxReadBytes) {
      throw new RemoteError('project-task/output-file', 'Task documentation file is too-large.', { reason: 'too-large' })
    }
    const record = this.documentationOutputRecord(workspaceId, taskId)
    assert(record.artifactOutput !== undefined)
    const split = directoryVersion.lastIndexOf(':')
    const version = directoryVersion.slice(0, split)
    const digest = directoryVersion.slice(split + 1)
    const content = await this.ctx.artifactController.readTaskDirectoryFile(workspaceId, record.workspacePath,
      brandString<ArtifactTaskId>(taskId), record.artifactOutput.artifactId, file.path, version, digest,
      file.version, signal)
    this.assertDocumentationReadOwner(record)
    return { id: file.id, fileName: file.path.slice(file.path.lastIndexOf('/') + 1),
      version: file.version, dataBase64: content.dataBase64 }
  }

  /** Read the exact retained file version from the Task's original Git worktree.
   * @param workspaceId - original registered project; rebinding refuses the read.
   * @param taskId - Task owning the worktree and output identity.
   * @param fileId - opaque identity from this Task's retained inventory, never a path.
   * @param signal - caller lifetime for Git validation and bounded byte read.
   * @returns complete selected bytes; moved or changed files reject without substituting current content.
   */
  @Remote
  readOutputFile(workspaceId: WorkspaceId, taskId: ProjectTaskId, fileId: ProjectTaskOutputFileId,
    signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    const record = this.record(workspaceId, taskId)
    const guard = (): void => { this.assertOutputReadOwner(record) }
    guard()
    return this.outputFiles.read(record, fileId, guard, signal)
  }

  /** Follow bounded provisional file observations from active isolated coding, research and documentation Tasks.
   * @param workspaceId - registered source project, checked on every observation.
   * @param signal - subscription lifetime; no observation survives cancellation or controller disposal.
   * @returns complete replacement lists; files remain provisional until a successful Task settles.
   */
  @Remote({ mode: 'stream' })
  async *followLiveOutputFiles(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<readonly ProjectTaskLiveOutput[]> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    let previous: string | undefined
    const reported = new Set<ProjectTaskId>()
    while (!lifetime.aborted) {
      this.workspace(workspaceId)
      const outputs: ProjectTaskLiveOutput[] = []
      for (const [, record] of this.table.entries()) {
        if (record.workspaceId !== workspaceId || record.status !== 'running'
          || (record.proposal.artifact === undefined && record.proposal.research === undefined
            && record.proposal.isolation !== 'worktree')
          || !this.executions.has(record.proposal.id)) continue
        try {
          const current = this.liveOutputRecord(workspaceId, record.proposal.id, record.execution.sessionId)
          const sessionId = record.execution.sessionId
          const guard = (): void => { this.liveOutputRecord(workspaceId, current.proposal.id, sessionId) }
          const inventory = current.proposal.research !== undefined
            ? await this.researchFiles.observe(current, guard, lifetime)
            : current.proposal.artifact !== undefined ? await this.artifactFiles.observe(current, guard, lifetime)
              : await this.outputFiles.collect(current, guard, lifetime)
          guard()
          if (inventory.observedAt !== null && (!('status' in inventory) || inventory.status === 'available')) outputs.push({
            taskId: current.proposal.id, sessionId, observedAt: inventory.observedAt,
            files: inventory.files, truncated: inventory.truncated })
          reported.delete(current.proposal.id)
        } catch (error) {
          lifetime.throwIfAborted()
          if (!reported.has(record.proposal.id)) {
            this.ctx.logger.warn('Running Task file observation is unavailable', error)
            reported.add(record.proposal.id)
          }
        }
      }
      const serialized = JSON.stringify(outputs.map(({ observedAt: _time, ...value }) => value))
      if (serialized !== previous) { previous = serialized; yield outputs }
      await delay(this.config.liveOutputRefreshIntervalMs, undefined, { signal: lifetime })
    }
  }

  /** Read one exact provisional file version from the same active coding, research or documentation execution.
   * @param workspaceId - original registered source project.
   * @param taskId - Task owning the isolated execution.
   * @param sessionId - execution identity observed in the live file stream.
   * @param fileId - opaque path identity from that observation.
   * @param version - exact filesystem version observed before the click.
   * @param signal - selected-read lifetime.
   * @returns complete current bytes, or a stale/unavailable refusal when ownership or version changes.
   */
  @Remote
  async readLiveOutputFile(workspaceId: WorkspaceId, taskId: ProjectTaskId, sessionId: SessionId,
    fileId: ProjectTaskOutputFileId, version: string, signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    const record = this.liveOutputRecord(workspaceId, taskId, sessionId)
    const guard = (): void => { this.liveOutputRecord(workspaceId, taskId, sessionId) }
    if (record.proposal.research !== undefined) return this.researchFiles.read(record, fileId, version, guard, signal)
    if (record.proposal.artifact !== undefined) return this.artifactFiles.read(record, fileId, version, guard, signal)
    const inventory = await this.outputFiles.collect(record, guard, signal)
    guard()
    const file = inventory.files.find(item => item.id === fileId)
    if (file === undefined) throw new RemoteError('project-task/output-file', 'Task output file is not-found.', { reason: 'not-found' })
    if (file.version !== version) throw new RemoteError('project-task/output-file', 'Task output file is stale.', { reason: 'stale' })
    return this.outputFiles.readObserved(record, file, guard, signal)
  }

  private liveOutputRecord(workspaceId: WorkspaceId, taskId: ProjectTaskId, sessionId: SessionId): ProjectTaskRecord {
    const record = this.record(workspaceId, taskId)
    this.assertOutputReadOwner(record)
    if (record.status !== 'running' || record.execution.sessionId !== sessionId
      || !this.executions.has(taskId)
      || (record.proposal.research !== undefined
        ? record.proposal.isolation !== 'tempdir' || !this.researchFiles.hasExecution(record)
        : record.proposal.artifact !== undefined ? record.proposal.isolation !== 'tempdir' || !this.artifactFiles.hasExecution(record)
          : record.proposal.isolation !== 'worktree' || record.preparation === undefined)) {
      throw new RemoteError('project-task/output-file', 'Task output file is unavailable.', { reason: 'unavailable' })
    }
    if (record.proposal.artifact !== undefined) taskSourceProject(this.ctx, workspaceId, record.proposal.artifact.sourceSessionId, true)
    if (record.proposal.research !== undefined) taskSourceProject(this.ctx, workspaceId, record.proposal.research.sourceSessionId, true)
    return record
  }

  /** List this project's retained tasks without starting or restoring Agents.
   * @param workspaceId - currently registered logical project.
   * @returns newest-first committed task metadata, bounded by the configured retained-task limit.
   */
  @Remote
  list(workspaceId: WorkspaceId): readonly ProjectTaskState[] {
    this.lifetime.signal.throwIfAborted()
    this.workspace(workspaceId)
    return [...this.table.entries()].map(([, record]) => record).filter(record => record.workspaceId === workspaceId)
      .map((record) => {
        this.assertOwner(record, workspaceId)
        const review = this.cards.knowledgeReview(record.proposal.id)
        const knowledgeCompletion = this.cards.knowledgeCompletion(workspaceId, record.proposal.id)
        return { ...taskState(record), ...(review === undefined ? {} : { knowledgeReview: review }),
          ...(knowledgeCompletion === undefined ? {} : { knowledgeCompletion }) }
      })
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  }

  /** Follow committed metadata without restoring an Agent.
   * @param workspaceId - registered project whose tasks are visible.
   * @param signal - closes this subscription; controller disposal also closes it.
   * @returns complete replacement lists; slow readers coalesce intervening writes.
   */
  @Remote({ mode: 'stream' })
  async *follow(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<readonly ProjectTaskState[]> {
    yield* this.followRecords(() => this.list(workspaceId), ['project_tasks', 'project_task_cards'], signal)
  }

  /** Hand a closed isolated task to the local terminal without changing its result or submitting a prompt.
   * @param workspaceId - original registered project, checked again immediately before handoff.
   * @param taskId - retained closed coding task; active and direct tasks are refused.
   * @param action - open a shell, or resume a failed Codex or Claude task with a retained native identity.
   * @param signal - request lifetime; an already accepted Terminal tab is user-owned.
   * @returns unchanged task state after native handoff, not a claim of successful continuation; a changed Git worktree refuses the handoff.
   */
  @Remote
  openTerminal(workspaceId: WorkspaceId, taskId: ProjectTaskId, action: ProjectTaskTerminalAction,
    signal: AbortSignal): Promise<ProjectTaskState> {
    return this.commands.run(taskId, signal, async (lifetime) => {
      const record = this.record(workspaceId, taskId)
      if (!this.config.nativeTerminal.enabled || !canOpenNativeTerminal()) this.refuse('terminal-unavailable')
      if (record.proposal.isolation !== 'worktree' || record.preparation === undefined
        || record.proposal.research !== undefined || !record.status.startsWith('closed-')
        || this.executions.has(taskId) || this.preparing.has(taskId)) this.refuse('terminal-task-unavailable')
      const cwd = this.executionDirectory(record)
      if (this.ctx.fs.processPathFromHostPath(cwd) !== cwd) this.refuse('terminal-unavailable')
      let argv: readonly string[] = []
      if (action === 'resume') {
        const execution = record.execution
        if (record.status !== 'closed-failed') this.refuse('terminal-resume-unavailable')
        if (execution?.runtime === 'claude' && execution.initialized) {
          argv = ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))}`,
            ...claudeCodeResumeArgv(execution.nativeSessionId, execution.selection)]
        } else if (execution?.runtime === 'codex' && execution.threadId !== undefined) {
          argv = ['/usr/bin/env', `CODEX_HOME=${resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))}`,
            ...codexResumeArgv(brandString<CodexThreadId>(execution.threadId), cwd, execution.selection)]
        } else this.refuse('terminal-resume-unavailable')
      }
      let exists: boolean
      try { exists = (await stat(cwd)).isDirectory() }
      catch { exists = false /* An unreadable or removed execution directory cannot be handed to Terminal. */ }
      if (!exists) this.refuse('terminal-directory-missing')
      try {
        await this.git.verifyTaskWorktree(workspaceId, record.workspacePath, taskId, record.preparation,
          () => { this.assertOwner(record, workspaceId) }, lifetime)
      } catch (error) {
        lifetime.throwIfAborted()
        this.assertOwner(record, workspaceId)
        this.ctx.logger.warn('Task Terminal worktree identity check failed', error)
        this.refuse('task-git-conflict')
      }
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      try {
        await openNativeTerminal(cwd, argv, AbortSignal.any([lifetime, AbortSignal.timeout(this.config.nativeTerminal.timeoutMs)]), {
          run: async (command, args, signal) => {
            const child = this.ctx.subprocess.spawn({ argv: [command, ...args], cwd, signal,
              graceMs: this.config.nativeTerminal.graceMs, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
            child.stdout?.resume()
            child.stderr?.resume()
            let outcome
            try { outcome = await child.done }
            finally { child.terminate(); await child.waitForExit() }
            signal.throwIfAborted()
            if (outcome.exitCode !== 0 || outcome.signal !== null) throw new Error('Terminal did not acknowledge the handoff')
            return { stdout: '', stderr: '' }
          },
        })
      }
      catch (error) {
        lifetime.throwIfAborted()
        this.ctx.logger.warn('Task Terminal handoff failed', error)
        this.refuse('terminal-handoff-failed')
      }
      return taskState(record)
    })
  }

  /** Accept an ordinary draft into a user-owned interactive Terminal session.
   * @param workspaceId - original registered project, rechecked before handoff.
   * @param taskId - retained draft or uncertain terminal handoff identity.
   * @param selection - native route and initial permissions, including Claude plan mode, frozen by the first retained handoff attempt.
   * @param signal - OS request lifetime; accepted native sessions outlive this controller.
   * @param allowDirty - explicit direct-project consent for this handoff attempt; uncertain retries do not inherit it.
   * @returns retained handoff state; OS acknowledgement establishes neither CLI startup nor task success.
   */
  @Remote
  openDraftTerminal(workspaceId: WorkspaceId, taskId: ProjectTaskId, selection: ProjectTaskTerminalSelection,
    allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.openDraftTerminalAttempt(workspaceId, taskId, selection, allowDirty, signal)
  }

  /** Retry only a retained uncertain Terminal handoff from Task details.
   * @param workspaceId - original registered project, rechecked during handoff.
   * @param taskId - retained interactive Task identity.
   * @param phase - phase shown at confirmation; a changed phase refuses this request.
   * @param selection - exact retained native route and permission choice shown at confirmation.
   * @param allowDirty - direct-project consent for this attempt only.
   * @param signal - request lifetime; an accepted native session remains user-owned.
   * @returns opened Task after its source-card receipt is updated when one exists.
   */
  @Remote
  async retryDraftTerminal(workspaceId: WorkspaceId, taskId: ProjectTaskId, phase: 'prepared' | 'unconfirmed',
    selection: ProjectTaskTerminalSelection, allowDirty: boolean, signal: AbortSignal): Promise<ProjectTaskState> {
    const opened = await this.openDraftTerminalAttempt(workspaceId, taskId, selection, allowDirty, signal, phase)
    await this.cards.recordTerminalHandoff(workspaceId, taskId)
    return opened
  }

  private openDraftTerminalAttempt(workspaceId: WorkspaceId, taskId: ProjectTaskId, selection: ProjectTaskTerminalSelection,
    allowDirty: boolean, signal: AbortSignal, expectedPhase?: 'prepared' | 'unconfirmed'): Promise<ProjectTaskState> {
    const selected = terminalSelectionSchema.safeParse(selection)
    if (!selected.success) this.refuse('invalid-proposal')
    return this.commands.run(taskId, signal, async (lifetime) => {
      let record = this.record(workspaceId, taskId)
      if (expectedPhase !== undefined && (record.status !== 'opened-terminal' || record.terminal.phase !== expectedPhase)) {
        this.refuse('terminal-task-unavailable')
      }
      if (!this.config.nativeTerminal.enabled || !canOpenNativeTerminal() || this.config.nativeTerminal.directory.length === 0) this.refuse('terminal-unavailable')
      if (record.goal !== undefined || record.proposal.research !== undefined || record.proposal.artifact !== undefined
        || (record.status !== 'draft' && record.status !== 'opened-terminal')
        || this.executions.has(taskId) || this.preparing.has(taskId)) this.refuse('terminal-task-unavailable')
      if (record.terminal !== undefined && JSON.stringify(record.terminal.selection) !== JSON.stringify(selected.data)) this.refuse('proposal-changed')
      const retained = this.cards.terminalConfirmation(taskId)
      if (this.cards.executionConfirmation(taskId) !== undefined
        || (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(selected.data))) this.refuse('card-decision-conflict')
      if (record.terminal?.phase === 'opened') return taskState(record)
      const provider = this.terminalKnowledge
      if (provider === undefined) this.refuse('terminal-unavailable')
      this.preparing.add(taskId)
      try {
        await this.assertDirectAdmission(record, allowDirty, lifetime)
        const knowledge = await this.captureKnowledge(record, 'tools', lifetime)
        record = await this.prepareTask(record, lifetime)
        const cwd = this.executionDirectory(record)
        if (this.ctx.fs.processPathFromHostPath(cwd) !== cwd) this.refuse('terminal-unavailable')
        if (!(await stat(cwd)).isDirectory()) this.refuse('terminal-directory-missing')
        const directory = await terminalDirectory(this.config.nativeTerminal.directory, lifetime)
        const { model: _model, ...proposal } = record.proposal
        const inputText = JSON.stringify({ projectPath: cwd, sourceProjectPath: record.workspacePath, ...proposal,
          resultFormat: taskWrapUpInstruction, ...(knowledge === undefined ? {} : { knowledge }) })
        if (Buffer.byteLength(inputText, 'utf8') > this.config.maxExecutionLogBytes) this.refuse('proposal-too-large')
        const grant = await provider.prepare(taskId, { id: workspaceId, path: record.workspacePath }, directory, inputText, lifetime)
        let argv: readonly string[]
        try {
          const nativeSessionId = selected.data.runtime === 'claude' ? brandString<ProjectTaskClaudeSessionId>(randomUUID()) : undefined
          argv = await terminalInvocation(directory, cwd, selected.data, inputText, grant, lifetime, nativeSessionId)
          lifetime.throwIfAborted()
          this.assertDispatchOwner(record)
          grant.validate(lifetime)
          if (this.terminalKnowledge !== provider) this.refuse('terminal-unavailable')
          record = { ...record, status: 'opened-terminal', execution: undefined, terminal: { phase: 'prepared', selection: selected.data,
            directory, cwd, argv: [...argv], inputText, sessionId: brandString<SessionId>(`session-${randomUUID()}`),
            messageId: brandString<MessageId>(randomUUID()), ...(nativeSessionId === undefined ? {} : { nativeSessionId }) },
          updatedAt: Math.max(record.updatedAt, Date.now()) }
          await this.table.put(taskId, record)
          await retainTerminalInput(this.ctx, record.terminal, selected.data.runtime === 'claude'
            ? this.config.claude.maxEventBytes : this.config.codex.maxPendingBytes)
          this.assertDispatchOwner(record)
          grant.validate(lifetime)
          if (this.terminalKnowledge !== provider) this.refuse('terminal-unavailable')
        } catch (error) {
          try { await grant.release() }
          catch (releaseError) { this.ctx.logger.warn('Task Terminal unaccepted knowledge grant release failed', releaseError) }
          throw error
        }
        try {
          await openNativeTerminal(cwd, argv, AbortSignal.any([lifetime, AbortSignal.timeout(this.config.nativeTerminal.timeoutMs)]), {
            run: async (command, args, request) => {
              const child = this.ctx.subprocess.spawn({ argv: [command, ...args], cwd, signal: request,
                graceMs: this.config.nativeTerminal.graceMs, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
              child.stdout?.resume(); child.stderr?.resume()
              let result
              try { result = await child.done }
              finally { child.terminate(); await child.waitForExit() }
              request.throwIfAborted()
              if (result.exitCode !== 0 || result.signal !== null) throw new Error('Terminal did not acknowledge the draft handoff')
              return { stdout: '', stderr: '' }
            },
          })
        } catch (error) {
          await this.table.update(taskId, (value) => {
            assert(value.terminal !== undefined, 'terminal handoff lost its retained input')
            return { ...value, terminal: { ...value.terminal, phase: 'unconfirmed' }, updatedAt: Math.max(value.updatedAt, Date.now()) }
          })
          lifetime.throwIfAborted()
          this.ctx.logger.warn('Task draft Terminal handoff remains unconfirmed', error)
          this.refuse('terminal-handoff-failed')
        }
        return taskState(await this.table.update(taskId, (value) => {
          assert(value.terminal !== undefined, 'terminal handoff lost its retained input')
          return { ...value, terminal: { ...value.terminal, phase: 'opened' }, updatedAt: Math.max(value.updatedAt, Date.now()) }
        }))
      } finally { this.preparing.delete(taskId) }
    })
  }

  /** Follow this task's recorded execution without starting or restoring an Agent.
   * @param workspaceId - original registered project; ownership is checked before and after every read.
   * @param taskId - retained task identity, independent of sidebar Session membership.
   * @param signal - subscription lifetime; cancellation and controller disposal release listeners and reads.
   * @returns bounded replacement journals; slow readers coalesce writes, and missing storage stays explicit.
   */
  @Remote({ mode: 'stream' })
  async *followExecutionLog(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): AsyncIterable<ProjectTaskExecutionLog> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    let wake = Promise.withResolvers<undefined>()
    const changed = (): void => { wake.resolve(undefined) }
    const offRecords = this.ctx.on('domain/changed', (change) => {
      if (change.domain === 'project_tasks' || change.domain === 'workspace') changed()
    })
    const offEvents = this.ctx.on('session/event', (session) => {
      if (this.table.get(taskId)?.execution?.sessionId === session.id) changed()
    }, { global: true })
    const offCreated = this.ctx.on('session/created', (session) => {
      if (this.table.get(taskId)?.execution?.sessionId === session.id) changed()
    }, { global: true })
    const stop = (): void => { offCreated(); offEvents(); offRecords(); changed() }
    lifetime.addEventListener('abort', stop, { once: true })
    try {
      while (!lifetime.aborted) {
        const pending = wake.promise
        const read = this.readExecutionLog(workspaceId, taskId, lifetime)
        this.logReads.add(read)
        let snapshot: ProjectTaskExecutionLog
        try { snapshot = await read }
        finally { this.logReads.delete(read) }
        lifetime.throwIfAborted()
        yield snapshot
        await pending
        wake = Promise.withResolvers<undefined>()
      }
    } catch (error) {
      if (!lifetime.aborted) throw error
    } finally {
      stop()
      lifetime.removeEventListener('abort', stop)
    }
  }

  private async readExecutionLog(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskExecutionLog> {
    const record = this.record(workspaceId, taskId)
    const id = record.execution?.sessionId ?? record.terminal?.sessionId
    let events: readonly SessionEvent[] | null = null
    if (id !== undefined) {
      const live = this.ctx.agents.get(id)?.session
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      if (live !== undefined) events = live.snapshotEvents()
      else if (await this.ctx.sessionPersistence.stat(id, { signal }) !== undefined) {
        await using handle = await this.ctx.sessionPersistence.open(id, 'read', { signal })
        events = (await handle.read(undefined, undefined, { signal })).events
      }
    }
    signal.throwIfAborted()
    this.assertOwner(record, workspaceId)
    return taskExecutionLog(record, events, this.config.maxExecutionLogBytes)
  }

  private async *followRecords<T>(read: () => T, domain: string | readonly string[], signal: AbortSignal): AsyncIterable<T> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    let wake = Promise.withResolvers<undefined>()
    const changed = (): void => { wake.resolve(undefined) }
    const off = this.ctx.on('domain/changed', (change) => {
      if ((Array.isArray(domain) ? domain.includes(change.domain) : change.domain === domain) || change.domain === 'workspace'
        || (domain === 'project_goals' && change.domain === 'project_tasks')) changed()
    })
    lifetime.addEventListener('abort', changed, { once: true })
    try {
      while (!lifetime.aborted) {
        const pending = wake.promise
        yield read()
        await pending
        wake = Promise.withResolvers<undefined>()
      }
    } finally {
      off()
      lifetime.removeEventListener('abort', changed)
    }
  }

  private async settle(taskId: ProjectTaskId, agent: Agent, execution: NonNullable<ProjectTaskRecord['execution']>,
    reviewScope?: TaskReviewScope): Promise<void> {
    try { await agent.whenIdle() }
    finally { await reviewScope?.[Symbol.asyncDispose]() }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('task settlement has no Session durability listener')
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = agent.session.snapshotEvents()
    const current = this.table.get(taskId)
    assert(current !== undefined)
    const outcome = await this.researchOutcome(current, taskSettlement(events, execution.messageId), events)
    const record = await this.table.update(taskId, current => ({ ...current, execution, ...outcome,
      usage: taskUsage(events, execution.messageId),
      updatedAt: Math.max(current.updatedAt, Date.now()) }))
    await this.cleanupResearch(record)
    const observed = await this.retainOutputInventory(record, true)
    const published = await this.retainCompletionReport(observed, events)
    await this.cards.captureCompletion(published)
    this.goalRuns.captureCompletion(published)
  }

  private dispatchOptions(record: ProjectTaskRecord, automaticReview: ProjectTaskReviewPolicy | undefined,
    postSteps: ProjectTaskPostSteps | undefined, sources: readonly ProjectTaskReviewSourceReceipt[] | undefined) {
    return { ...(record.proposal.research === undefined && record.proposal.artifact === undefined
      ? { completionReportOnSuccess: true as const, outputInventoryOnSuccess: true as const } : {}),
    ...(automaticReview === undefined ? {} : { automaticReview }),
    ...(postSteps === undefined ? {} : { postSteps }),
    ...(sources === undefined ? {} : { reviewSources: [...sources] }) }
  }

  private dispatchInputPolicy(record: ProjectTaskRecord, automaticReview: ProjectTaskReviewPolicy | undefined,
    postSteps: ProjectTaskPostSteps | undefined) {
    return { ...(record.knowledgeMaintenanceAuthorization === undefined ? {}
      : { knowledgeMaintenanceAuthorization: record.knowledgeMaintenanceAuthorization }),
    ...(automaticReview === undefined ? {} : { automaticReview }),
    ...(postSteps === undefined ? (automaticReview === undefined ? {} : { reviewInstruction: taskReviewInstruction })
      : { postSteps, postStepsInstruction: taskPostStepsInstruction(postSteps, automaticReview !== undefined) }) }
  }

  private dispatchInputContext(record: ProjectTaskRecord, knowledge: string | undefined) {
    return { ...(knowledge === undefined ? {} : { knowledge }),
      ...(record.goal === undefined ? {} : { goal: taskState(record).goal }),
      ...(record.preparation === undefined ? {} : { executionWorkspace: record.preparation }) }
  }

  private assertExecutionConfirmation(record: ProjectTaskRecord, policy: ProjectTaskReviewPolicy | undefined,
    postSteps: ProjectTaskPostSteps | undefined,
    execution: ProjectTaskCodingConfirmation['execution'],
    reviewSources?: readonly ProjectTaskReviewSourceSelection[]): void {
    if (record.status === 'draft' && this.cards.terminalConfirmation(record.proposal.id) !== undefined) this.refuse('card-decision-conflict')
    const retained = record.sourceSessionId === undefined ? undefined : this.cards.executionConfirmation(record.proposal.id)
    if (reviewSources !== undefined && (record.goal !== undefined || record.terminal !== undefined
      || record.proposal.research !== undefined || record.proposal.artifact !== undefined)) this.refuse('review-unavailable')
    if (record.execution !== undefined && reviewSources !== undefined
      && JSON.stringify(reviewSources) !== JSON.stringify(record.reviewSources?.map(({ importId, sessionId, documentId }) =>
        ({ importId, sessionId, documentId })))) this.refuse('proposal-changed')
    if (record.execution === undefined && retained !== undefined
      && JSON.stringify(reviewSources) !== JSON.stringify(retained.reviewSources)) this.refuse('card-decision-conflict')
    if (record.execution === undefined && retained !== undefined) {
      const model = execution.runtime === 'harness' ? execution.model ?? record.proposal.model : undefined
      const requested = execution.runtime === 'harness' ? {
        runtime: execution.runtime, ...(model === undefined ? {} : { model }),
        ...(execution.agentPreset === undefined ? {} : { agentPreset: execution.agentPreset }),
      } : execution
      if (JSON.stringify(requested) !== JSON.stringify(retained.execution)) this.refuse('card-decision-conflict')
    }
    if (record.goal !== undefined) {
      const signed = this.goalRuns.codingTaskConfirmation(record)
      if (JSON.stringify(policy) !== JSON.stringify(signed.review)
        || JSON.stringify(postSteps) !== JSON.stringify(signed.postSteps)
        || (postSteps?.autoFix === true && policy === undefined)) this.refuse('review-unavailable')
    }
    if (policy === undefined && postSteps === undefined) {
      if (record.execution === undefined && (retained?.review !== undefined || retained?.postSteps !== undefined)) this.refuse('card-decision-conflict')
      return
    }
    if (record.terminal !== undefined || record.proposal.research !== undefined
      || record.proposal.artifact !== undefined) this.refuse('review-unavailable')
    if (record.execution !== undefined && (JSON.stringify(record.automaticReview) !== JSON.stringify(policy)
      || JSON.stringify(record.postSteps) !== JSON.stringify(postSteps))) this.refuse('proposal-changed')
    if (record.goal === undefined && record.sourceSessionId !== undefined && (JSON.stringify(retained?.review) !== JSON.stringify(policy)
      || JSON.stringify(retained?.postSteps) !== JSON.stringify(postSteps)
      || JSON.stringify(retained?.execution) !== JSON.stringify(execution))) this.refuse('card-decision-conflict')
  }

  private assertReviewBaseline(record: ProjectTaskRecord, policy: ProjectTaskReviewPolicy | undefined): void {
    if (policy !== undefined && record.preparation === undefined && record.reviewBaseCommit == null) this.refuse('review-unavailable')
  }

  private async assertDirectAdmission(record: ProjectTaskRecord, allowDirty: boolean, signal: AbortSignal): Promise<void> {
    if (record.goal !== undefined || record.proposal.isolation !== 'direct'
      || record.proposal.research !== undefined || record.proposal.artifact !== undefined) return
    const state = await this.git.inspectDirectWorkspace(record.workspaceId, record.workspacePath,
      () => { this.assertDispatchOwner(record) }, signal)
    // RPC consent authorizes only the literal boolean true, never a truthy wire value.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    if (state === 'dirty' && allowDirty !== true) this.refuse('task-git-dirty')
  }

  private async prepareTask(record: ProjectTaskRecord, signal: AbortSignal): Promise<ProjectTaskRecord> {
    if (record.proposal.isolation === 'direct') {
      if (record.execution !== undefined || record.reviewBaseCommit != null) return record
      const reviewBaseCommit = await this.git.reviewBaseline(record.workspaceId, record.workspacePath,
        () => { this.assertDispatchOwner(record) }, signal)
      signal.throwIfAborted(); this.assertDispatchOwner(record)
      return this.table.update(record.proposal.id, current => ({ ...current, reviewBaseCommit }))
    }
    if (record.proposal.artifact !== undefined) {
      if (record.artifactDirectory !== undefined) await this.artifactFiles.validate(record.artifactDirectory)
      else {
        const artifactDirectory = await this.artifactFiles.prepare(signal)
        try {
          this.assertDispatchOwner(record)
          signal.throwIfAborted()
          await this.table.update(record.proposal.id, current => ({ ...current, artifactDirectory }))
        } catch (error) { await this.artifactFiles.remove(artifactDirectory); throw error }
      }
      return this.record(record.workspaceId, record.proposal.id)
    }
    if (record.proposal.research !== undefined) {
      if (record.researchDirectory !== undefined) await this.researchFiles.validate(record.researchDirectory)
      else {
        const researchDirectory = await this.researchFiles.prepare(signal)
        try {
          this.assertDispatchOwner(record)
          signal.throwIfAborted()
          await this.table.update(record.proposal.id, current => ({ ...current, researchDirectory }))
        } catch (error) { await this.researchFiles.remove(researchDirectory); throw error }
      }
      return this.record(record.workspaceId, record.proposal.id)
    }
    assert(record.goal?.probe !== true, 'Capability research requires temporary-directory isolation')
    const gitGoal = record.goal
    let authority: Parameters<ProjectGit['prepareTask']>[6]
    if (gitGoal === undefined) authority = { kind: 'ordinary' }
    else if (gitGoal.gather === true) authority = { kind: 'gather' }
    else {
      const integration = gitGoal.integration
      if (integration === undefined) this.refuse('goal-phase-conflict')
      authority = { kind: 'approved', integration }
    }
    await this.git.prepareTask(record.workspaceId, record.workspacePath, record.proposal.id, record.preparation, async (preparation) => {
      this.assertDispatchOwner(record)
      signal.throwIfAborted()
      await this.table.update(record.proposal.id, current => ({ ...current, preparation,
        updatedAt: Math.max(current.updatedAt, Date.now()) }))
      signal.throwIfAborted()
      this.assertDispatchOwner(record)
    }, signal, authority)
    return this.record(record.workspaceId, record.proposal.id)
  }

  private executionDirectory(record: ProjectTaskRecord): string {
    if (record.proposal.isolation === 'direct') return record.workspacePath
    if (record.proposal.artifact !== undefined) {
      assert(record.artifactDirectory !== undefined, 'artifact execution requires retained temporary allocation')
      return record.artifactDirectory.path
    }
    if (record.proposal.research !== undefined) {
      assert(record.researchDirectory !== undefined, 'research execution requires retained temporary allocation')
      return record.researchDirectory.path
    }
    assert(record.preparation !== undefined, 'worktree execution requires retained preparation')
    return join(record.workspacePath, record.preparation.relativePath)
  }

  private workspace(workspaceId: WorkspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'task project is unavailable', { workspaceId })
    return workspace
  }

  private assertOwner(record: ProjectTaskRecord, workspaceId: WorkspaceId): void {
    if (record.workspaceId !== workspaceId || this.workspace(workspaceId).path !== record.workspacePath) this.refuse('project-changed')
  }

  private assertOutputReadOwner(record: ProjectTaskRecord): void {
    this.assertOwner(record, record.workspaceId)
    if (this.workspace(record.workspaceId).archivedAt !== undefined) this.refuse('project-changed')
    if (record.sourceSessionId !== undefined) taskSourceProject(this.ctx, record.workspaceId, record.sourceSessionId, false)
  }

  private assertDocumentationReadOwner(record: ProjectTaskRecord): void {
    this.assertOutputReadOwner(record)
    const current = this.table.get(record.proposal.id)
    if (record.status !== 'closed-success' || record.proposal.artifact === undefined
      || record.artifactOutput?.type !== 'docs' || current?.status !== 'closed-success'
      || current.artifactOutput?.artifactId !== record.artifactOutput.artifactId) {
      throw new RemoteError('project-task/output-file', 'Task documentation file is unavailable.', { reason: 'unavailable' })
    }
    taskSourceProject(this.ctx, record.workspaceId, record.proposal.artifact.sourceSessionId, false)
  }

  private documentationOutputRecord(workspaceId: WorkspaceId, taskId: ProjectTaskId): ProjectTaskRecord {
    const record = this.record(workspaceId, taskId)
    this.assertDocumentationReadOwner(record)
    return record
  }

  private assertDispatchOwner(record: ProjectTaskRecord): void {
    this.assertOwner(record, record.workspaceId)
    const source = record.sourceSessionId ?? record.proposal.research?.sourceSessionId ?? record.proposal.artifact?.sourceSessionId
    if (source !== undefined) taskSourceProject(this.ctx, record.workspaceId, source, true)
    if (record.goal === undefined) return
    if (record.execution !== undefined) {
      const signed = this.goalRuns.codingTaskConfirmation(record)
      if (JSON.stringify(record.automaticReview) !== JSON.stringify(signed.review)
        || JSON.stringify(record.postSteps) !== JSON.stringify(signed.postSteps)) this.refuse('review-unavailable')
    }
    const goal = this.goalRuns.inspect(record.workspaceId, record.goal.sourceSessionId, record.goal.runId)
    if (goal?.planHistory?.some(item => item.taskIds.includes(record.proposal.id))) {
      if (record.execution === undefined || !['PLAN', 'SIGNOFF', 'RUNNING', 'DONE', 'ESCALATED'].includes(goal.phase)) {
        this.refuse('goal-phase-conflict')
      }
      return
    }
    if (record.goal.gather === true) {
      const phases = record.execution === undefined ? ['GATHER', 'PLAN'] : ['GATHER', 'PLAN', 'SIGNOFF', 'RUNNING']
      if (goal === null || !phases.includes(goal.phase)) this.refuse('goal-phase-conflict')
    } else if (goal?.phase !== 'RUNNING' || goal.review?.delivery !== 'sent') this.refuse('goal-phase-conflict')
  }

  private record(workspaceId: WorkspaceId, id: ProjectTaskId): ProjectTaskRecord {
    const record = this.table.get(id)
    if (record === undefined) this.refuse('task-not-found')
    this.assertOwner(record, workspaceId)
    return record
  }

  private refuse(reason: ProjectTaskFailure): never {
    throw new RemoteError('project-task/rejected', 'project task request was not accepted', { reason })
  }

  private async researchOutcome(record: ProjectTaskRecord, outcome: ReturnType<typeof taskSettlement>, events: readonly SessionEvent[]) {
    if (record.proposal.artifact !== undefined && outcome.status === 'closed-success') {
      try {
        this.assertDispatchOwner(record)
        const artifactOutput = record.artifactWriteProtocol !== undefined
          ? await this.artifactFiles.collectNative(record, events, this.lifetime.signal)
          : await this.artifactFiles.collect(record, this.lifetime.signal)
        return { ...outcome, artifactOutput }
      } catch (error) {
        return { status: 'closed-failed' as const,
          closedReason: `artifact-publication-failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (record.proposal.research === undefined || outcome.status !== 'closed-success') return outcome
    try {
      this.assertDispatchOwner(record)
      const researchReport = await this.researchFiles.collect(record, events, this.lifetime.signal)
      return { ...outcome, researchReport }
    } catch (error) {
      return { status: 'closed-failed' as const,
        closedReason: `research-report-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Retain an observed source-file list only for an admitted coding Task.
   * A cold start never reconstructs completion-time files from a later working tree.
   */
  private async retainOutputInventory(record: ProjectTaskRecord, observeNow: boolean): Promise<ProjectTaskRecord> {
    if (record.outputInventoryOnSuccess !== true || record.status !== 'closed-success'
      || record.proposal.research !== undefined
      || record.proposal.artifact !== undefined || record.outputInventory !== undefined) return record
    let inventory: ProjectTaskOutputInventory
    if (!observeNow) {
      inventory = { status: 'unavailable', observedAt: null, files: [], truncated: false, reason: 'interrupted' }
    } else {
      try {
        inventory = await this.outputFiles.collect(record, () => { this.assertOutputReadOwner(record) }, this.lifetime.signal)
      } catch {
        this.ctx.logger.warn('Successful Task file observation is unavailable; no source paths were retained')
        inventory = { status: 'unavailable', observedAt: null, files: [], truncated: false,
          reason: this.lifetime.signal.aborted ? 'interrupted' : 'inspection-failed' }
      }
    }
    return this.table.update(record.proposal.id, (current) => {
      if (current.status !== 'closed-success' || current.workspaceId !== record.workspaceId
        || current.workspacePath !== record.workspacePath) throw new Error('Task file observation owner changed before retention')
      if (current.outputInventory !== undefined) return current
      return { ...current, outputInventory: { ...inventory, files: [...inventory.files] },
        updatedAt: Math.max(current.updatedAt, Date.now()) }
    })
  }

  /** Publish a marked coding Task's immutable report after its execution status is durable.
   * Historical executions without the admission marker remain read-only on startup.
   * Publication failure leaves the execution verdict unchanged and an absent receipt for cold retry.
   */
  private async retainCompletionReport(record: ProjectTaskRecord, events?: readonly SessionEvent[]): Promise<ProjectTaskRecord> {
    if (record.completionReportOnSuccess !== true || record.status !== 'closed-success'
      || record.proposal.research !== undefined
      || record.proposal.artifact !== undefined || record.completionReport !== undefined) return record
    try {
      let evidenceEvents = events
      if (evidenceEvents === undefined) {
        await using handle = await this.ctx.sessionPersistence.open(record.execution.sessionId, 'read')
        evidenceEvents = (await handle.read()).events
      }
      const evidence = taskResultEvidence(evidenceEvents, record.execution.messageId)
      this.assertOwner(record, record.workspaceId)
      if (record.sourceSessionId !== undefined) taskSourceProject(this.ctx, record.workspaceId, record.sourceSessionId, true)
      const markdown = completionReportMarkdown(record, evidence.summary, this.config.maxCompletionBytes)
      const artifactId = await this.ctx.artifactController.publishTaskReport(record.workspaceId, record.workspacePath,
        brandString<ArtifactTaskId>(record.proposal.id), record.sourceSessionId ?? record.goal?.sourceSessionId,
        markdown, this.lifetime.signal)
      const fileName = `task-${record.proposal.id}.md`
      return await this.table.update(record.proposal.id, (current) => {
        if (current.status !== 'closed-success' || current.workspaceId !== record.workspaceId
          || current.workspacePath !== record.workspacePath) throw new Error('Task report owner changed before retention')
        if (current.completionReport !== undefined) return current
        return { ...current, completionReport: { artifactId, fileName,
          contentSha256: createHash('sha256').update(markdown).digest('hex'),
          projectRelativePath: this.ctx.artifactController.taskReportRelativePath(brandString<ArtifactTaskId>(record.proposal.id),
            record.sourceSessionId ?? record.goal?.sourceSessionId) }, updatedAt: Math.max(current.updatedAt, Date.now()) }
      })
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.ctx.logger.warn('Successful Task report remains unpublished for cold retry', error)
      return record
    }
  }

  private async cleanupResearch(record: ProjectTaskRecord): Promise<void> {
    if (record.artifactDirectory !== undefined) {
      try { await this.artifactFiles.remove(record.artifactDirectory) }
      catch (error) {
        // Completed removal is idempotent after restart; changed identities are never deleted.
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
        this.ctx.logger.warn('Artifact temporary directory could not be removed; retained task metadata identifies it', error)
      }
    }
    if (record.researchDirectory === undefined) return
    try { await this.researchFiles.remove(record.researchDirectory) }
    catch (error) {
      // Completed cleanup is idempotent across cold startup; changed identities remain untouched.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
      this.ctx.logger.warn('Research temporary directory could not be removed; retained task metadata identifies it', error)
    }
  }

  /** Inspect or retry the existing signed automatic UUID without another signoff.
   * @param workspaceId - original registered project.
   * @param taskId - completed signed Task with frozen automatic intent.
   * @param signal - explicit receipt recovery lifetime.
   * @returns retained Task; unknown inspection does not replay a write.
   */
  @Remote
  resumeGoalAutomaticKnowledge(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.resumeAutomaticKnowledge(workspaceId, taskId, signal)
  }

  /** Retry one blocked Goal research knowledge comparison after explicit user action.
   * @param workspaceId - original registered project.
   * @param taskId - signed Goal research Task with a delivered report.
   * @param requestId - new UUID for a paid read-only review; an identical retry does not rerun it.
   * @param signal - caller lifetime until reviewer completion or blocked receipt.
   * @returns current Task with the retained comparison status.
   */
  @Remote
  retryGoalKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.retryKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Start one human-authorized fresh model comparison after a provably unwritten Goal attempt.
   * @param workspaceId - original project.
   * @param taskId - same completed signed Goal research Task.
   * @param requestId - fresh comparison UUID retained through cold recovery.
   * @param signal - review lifetime.
   * @returns Task state with the old candidate archived and a new read-only verdict.
   */
  @Remote
  refreshGoalKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.refreshKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Recheck a settled Goal no-change after archiving its exact report verdict.
   * @param workspaceId - original registered Goal Task project.
   * @param taskId - completed signed Goal Task.
   * @param requestId - human gesture UUID retained for uncertain acknowledgement and cold recovery.
   * @param signal - current command lifetime.
   * @returns Task with the archived conclusion and new read-only review status.
   */
  @Remote
  recheckGoalNoChangeKnowledgeDiscovery(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.recheckNoChangeKnowledgeDiscovery(workspaceId, taskId, requestId, signal)
  }

  /** Retain a human decision on one signed Goal research candidate.
   * @param workspaceId - original registered project.
   * @param taskId - completed signed Goal research Task.
   * @param request - exact candidate and immutable decision UUID.
   * @param signal - caller lifetime before the Brain write settles.
   * @returns Task with a dismissed, pending, or saved Goal knowledge decision.
   */
  @Remote
  decideGoalKnowledge(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeDecisionRequest, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.decideKnowledge(workspaceId, taskId, request, signal)
  }

  /** Read the complete held Goal draft and current active catalog for separate publication consent.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param signal - bounded read lifetime.
   * @returns draft body and current catalog version evidence.
   */
  @Remote
  reviewGoalKnowledgeDraft(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskKnowledgeDraftReview> {
    return this.goalRuns.reviewKnowledgeDraft(workspaceId, taskId, signal)
  }

  /** Read and receipt one versioned active page for this Goal-human held draft.
   * @param workspaceId - original signed Goal project.
   * @param taskId - completed signed research Task with a saved held draft.
   * @param request - exact draft, catalog and old-page versions from the review.
   * @param signal - read and durable receipt lifetime.
   * @returns full current body or changed; a missing read cannot authorize publication.
   */
  @Remote
  readGoalKnowledgeCatalogPage(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectTaskKnowledgeCatalogReadRequest, signal: AbortSignal): Promise<ProjectTaskKnowledgeCatalogRead> {
    return this.goalRuns.readKnowledgeCatalogPage(workspaceId, taskId, request, signal)
  }

  /** Publish a reviewed Goal-held draft only after a distinct human UUID.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param request - exact candidate, draft version and active catalog digest.
   * @param signal - caller lifetime; pending publication remains resumable.
   * @returns Task with pending or published receipt and post-publication review.
   */
  @Remote
  publishGoalKnowledgeDraft(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgePublishRequest, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.publishKnowledgeDraft(workspaceId, taskId, request, signal)
  }

  /** Recheck an uncertain published Goal receipt and active catalog without a Brain write.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param signal - read lifetime.
   * @returns Task retaining its published receipt and current review status.
   */
  @Remote
  reviewGoalKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.reviewKnowledgePublication(workspaceId, taskId, signal)
  }

  /** Inspect a published Goal page and catalog before a human disposition.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param signal - bounded read lifetime.
   * @returns stable current page/catalog or an explicit unknown observation.
   */
  @Remote
  inspectGoalKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskKnowledgePublicationInspection> {
    return this.goalRuns.inspectKnowledgePublication(workspaceId, taskId, signal)
  }

  /** Retain a human disposition of a still-current changed Goal publication catalog.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param request - current page/catalog evidence and independent human UUID.
   * @param signal - read and durable-decision lifetime.
   * @returns Task with the published receipt, required finding and human acknowledgement.
   */
  @Remote
  acknowledgeGoalKnowledgePublication(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeAcknowledgeRequest, signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.acknowledgeKnowledgePublication(workspaceId, taskId, request, signal)
  }

  /** Reuse only the exact pending human Goal knowledge UUID after uncertainty or restart.
   * @param workspaceId - original project.
   * @param taskId - completed Goal research Task.
   * @param signal - retry lifetime.
   * @returns Task with unchanged terminal decision or recovered Brain receipt.
   */
  @Remote
  resumeGoalKnowledgeDecision(workspaceId: WorkspaceId, taskId: ProjectTaskId,
    signal: AbortSignal): Promise<ProjectTaskState> {
    return this.goalRuns.resumeKnowledgeDecision(workspaceId, taskId, signal)
  }

  /** Read a successful research report from its retained source-conversation artifact.
   * @param workspaceId - original registered project.
   * @param taskId - completed research Task identity.
   * @param signal - cancels the bounded file read.
   * @returns complete UTF-8 Markdown without starting an Agent or publishing Brain knowledge.
   * @throws when the current artifact differs from its completion-time digest; older reports without a digest remain unverified.
   */
  @Remote
  async readResearchReport(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<string> {
    const record = this.record(workspaceId, taskId)
    const report = record.researchReport
    const source = record.proposal.research
    if (source === undefined || record.status !== 'closed-success' || report === undefined) throw new Error('This task has no completed research report')
    if (!report.artifactId.startsWith(`${encodeURIComponent(source.sourceSessionId)}/reports/`)) throw new Error('Research report ownership is invalid')
    const file = await this.ctx.artifactController.read(workspaceId, report.artifactId, signal)
    this.assertOwner(record, workspaceId)
    const bytes = Buffer.from(file.dataBase64, 'base64')
    if (bytes.byteLength > this.config.research.maxReportBytes) throw new Error('Research report exceeds its byte limit')
    if (report.contentSha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== report.contentSha256) {
      throw new RemoteError('project-task/rejected', 'Research report changed since completion', { reason: 'report-changed' })
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  /** Read a completed task's separately retained raster preview without starting inference.
   * @param workspaceId - original registered project.
   * @param taskId - completed research Task identity.
   * @param signal - cancels the bounded file read.
   * @returns complete preview bytes; missing previews or changed source ownership reject.
   */
  @Remote
  async readResearchPreview(workspaceId: WorkspaceId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ArtifactPreviewFile> {
    const record = this.record(workspaceId, taskId)
    const preview = record.researchReport?.preview
    const source = record.proposal.research
    if (source === undefined || record.status !== 'closed-success' || preview === undefined) throw new Error('This task has no retained research preview')
    const file = await this.ctx.artifactController.readPreview(workspaceId, record.workspacePath, source.sourceSessionId,
      brandString<ArtifactTaskId>(taskId), preview.id, signal)
    this.assertOwner(record, workspaceId)
    if (Buffer.from(file.dataBase64, 'base64').byteLength > this.config.research.maxOutputBytes) throw new Error('Research preview exceeds its byte limit')
    return file
  }
}

export default TaskController
