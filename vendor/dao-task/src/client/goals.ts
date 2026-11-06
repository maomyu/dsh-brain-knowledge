/** Session-owned live Goal review state; only explicit gestures admit review input. */
import { sameKnowledgeSubject } from '../knowledge-subject.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectGoalReviewInput, ProjectGoalReviewOptions, ProjectGoalRequestId, ProjectGoalRunId, ProjectGoalState,
  ProjectGoalControlInput, ProjectGoalDeliveryInput, ProjectGoalTaskDiff, ProjectGoalCodingFiles,
  ProjectGoalKnowledgeDiscovery, ProjectTaskId,
  ProjectTaskKnowledgeDiscoveryRequestId, ProjectGoalKnowledgeDecisionRequest, ProjectGoalKnowledgePublishRequest,
  ProjectGoalKnowledgeAcknowledgeRequest, ProjectTaskKnowledgeDraftReview,
  ProjectTaskKnowledgePublicationInspection, ProjectTaskKnowledgeOperationId, ProjectTaskState } from '../types.ts'

/** Editable choice before the Client assigns the immutable command identity. */
export type GoalReviewDecision = ProjectGoalReviewInput extends infer Input
  ? Input extends ProjectGoalReviewInput ? Omit<Input, 'requestId' | 'planRequestId'> : never : never

/** One explicit Goal research retry; an uncertain response retains its UUID for the same-operation retry. */
export interface GoalKnowledgeDiscoveryRetry {
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly taskId: ProjectTaskId
  readonly reportMessageId: ProjectGoalKnowledgeDiscovery['reportMessageId']
  readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
  readonly status: 'pending' | 'unconfirmed'
}

/** In-memory exact human knowledge command retained across panel remount until Host receipt reconciliation. */
export type GoalKnowledgeCommandRetry = {
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly taskId: ProjectTaskId
  readonly membership: string
  readonly status: 'pending' | 'unconfirmed'
} & (
  | { readonly kind: 'decision'
    readonly request: ProjectGoalKnowledgeDecisionRequest }
  | { readonly kind: 'publication'
    readonly request: ProjectGoalKnowledgePublishRequest }
  | { readonly kind: 'acknowledgement'
    readonly request: ProjectGoalKnowledgeAcknowledgeRequest }
)

/** Joined Host refusal plus a read-only no-pending Task observation; no Brain publication was admitted. */
export interface GoalKnowledgePreAdmissionConflict {
  readonly kind: 'publication'
  readonly taskId: ProjectTaskId
  readonly operationId: ProjectTaskKnowledgeOperationId
  readonly reason: 'pre-admission-conflict'
}

/** Explicit fresh model comparison intent; same UUID is reused after a lost response. */
export interface GoalKnowledgeRefreshRetry {
  readonly workspaceId: WorkspaceId
  readonly goalRunId: ProjectGoalRunId
  readonly taskId: ProjectTaskId
  readonly membership: string
  readonly requestId: ProjectTaskKnowledgeDiscoveryRequestId
  readonly status: 'pending' | 'unconfirmed'
}

/** Explicit no-change recheck intent, separate from a candidate refresh gesture. */
export interface GoalKnowledgeNoChangeRecheckRetry extends GoalKnowledgeRefreshRetry {}

/** Stream-owned Goal and local review transport state for one conversation. */
export interface GoalReviewSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly goal: ProjectGoalState | null
  readonly error: string | null
  readonly options: ProjectGoalReviewOptions | null
  readonly optionsPhase: 'idle' | 'loading' | 'ready' | 'error'
  readonly optionsError: string | null
  readonly pending: boolean
  readonly commandError: string | null
  readonly retry: ProjectGoalReviewInput | null
  readonly controlRetry: ProjectGoalControlInput | null
  readonly deliveryRetry: ProjectGoalDeliveryInput | null
  /** A local transport intent, not proof that the Host admitted or finished another review. */
  readonly goalKnowledgeDiscoveryRetry: GoalKnowledgeDiscoveryRetry | null
  /** Local same-UUID retry intent, not a durable Host or Brain receipt. */
  readonly goalKnowledgeCommandRetry: GoalKnowledgeCommandRetry | null
  readonly goalKnowledgePreAdmissionConflict: GoalKnowledgePreAdmissionConflict | null
  readonly goalKnowledgeRefreshRetry: GoalKnowledgeRefreshRetry | null
  readonly noChangeRecheckRetry: GoalKnowledgeNoChangeRecheckRetry | null
}

/** Exact-plan commands; rendering and reconnecting never approve or wake a source. */
export interface ConversationGoalReview {
  readonly state: ObservableSnapshot<GoalReviewSnapshot>
  /** Read one recorded task result, including an older run in this conversation.
   * @param id - logged Goal identity.
   * @param taskId - logged task identity.
   * @param signal - card lifetime; membership replacement also cancels the request.
   * @returns complete fixed-commit difference or a visible read error.
   */
  diff(id: ProjectGoalRunId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalTaskDiff>
  /** Read every complete UTF-8 changed file from the Task's fixed Git commits.
   * @param id - logged Goal identity.
   * @param taskId - logged coding Task identity.
   * @param signal - card lifetime; membership replacement also cancels the request.
   * @returns versioned file bodies or a visible read error.
   */
  codingFiles(id: ProjectGoalRunId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalCodingFiles>
  /** Submit a choice for the plan the user actually reviewed.
   * @param id - displayed run identity.
   * @param planId - displayed submission identity.
   * @param decision - explicit user choice, frozen before transport.
   * @returns whether the still-current request was acknowledged; failures remain visible.
   */
  review(id: ProjectGoalRunId, planId: ProjectGoalRequestId, decision: GoalReviewDecision): Promise<boolean>
  /** Retry the retained decision, never a newly edited choice.
   * @param id - displayed run identity.
   * @param planId - displayed submission identity.
   * @returns whether the still-current retry was acknowledged.
   */
  retry(id: ProjectGoalRunId, planId: ProjectGoalRequestId): Promise<boolean>
  /** Apply an explicit pause, resume or quiescent exit to the displayed run.
   * @param id - displayed Goal identity.
   * @param action - user-selected control.
   * @param budgetOverride - resume-only threshold increases, frozen with the gesture.
   * @returns whether the current request was acknowledged.
   */
  control(id: ProjectGoalRunId, action: ProjectGoalControlInput['action'], budgetOverride?: ProjectGoalControlInput['budgetOverride']): Promise<boolean>
  /** Retry the retained control without minting another gesture.
   * @param id - displayed Goal identity.
   * @returns whether the retry was acknowledged.
   */
  retryControl(id: ProjectGoalRunId): Promise<boolean>
  /** Deliver the displayed terminal run; omitting action retries the retained gesture.
   * @param id - displayed Goal identity.
   * @param action - explicit user choice, or omitted for retry.
   * @returns whether the current request was acknowledged.
   */
  deliver(id: ProjectGoalRunId, action?: ProjectGoalDeliveryInput['action']): Promise<boolean>
  /** Retry one blocked, current-run research comparison after an explicit human gesture.
   * @param id - displayed Goal run.
   * @param taskId - displayed research Task.
   * @param reportMessageId - exact completed report receipt shown to the user.
   * @returns whether the current request resolved to a saved Task state.
   */
  retryGoalKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId,
    reportMessageId: ProjectGoalKnowledgeDiscovery['reportMessageId']): Promise<boolean>
  /** Start a fresh, potentially paid read-only comparison after a provably unwritten decision. */
  refreshGoalKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Recheck a settled no-change conclusion with an independently retained UUID.
   * @param id - displayed Goal run.
   * @param taskId - completed research Task with the retained conclusion.
   * @returns whether the Host acknowledged this recheck.
   */
  recheckNoChangeKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Reconcile the already-frozen automatic UUID without a new permission.
   * @param id - displayed Goal run.
   * @param taskId - completed signed Task with pending or unknown automatic intent.
   * @returns whether original-project recovery was acknowledged.
   */
  resumeGoalAutomaticKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Submit one human decision; a definite source-identifier refusal leaves the evidence editable. */
  decideGoalKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeDecisionRequest): Promise<boolean | 'source-identifiers-missing'>
  /** Read the full held draft and active catalog before a separate publication gesture. */
  reviewGoalKnowledgeDraft(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<ProjectTaskKnowledgeDraftReview>
  /** Submit a second UUID after reviewing the complete held draft and catalog. */
  publishGoalKnowledgeDraft(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgePublishRequest): Promise<boolean>
  /** Recheck an uncertain published receipt without a write. */
  reviewGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Read the published page and current catalog before human disposition. */
  inspectGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<ProjectTaskKnowledgePublicationInspection>
  /** Retain a separate human disposition of a changed publication catalog. */
  acknowledgeGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeAcknowledgeRequest): Promise<boolean>
  /** Recover a durable pending Brain operation with its retained UUID. */
  resumeGoalKnowledgeDecision(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Retry a transport-unknown first gesture using the same local UUID. */
  retryGoalKnowledgeCommand(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean>
  /** Reopen failed reads without retrying a decision. */
  refresh(): void
}

/** Session binding owns one lazily subscribed review model. */
export interface IProjectGoals {
  /** Resolve the materialized conversation's review source.
   * @param sessionId - conversation whose original project supplies review authority.
   * @returns one stable source for the binding's lifetime.
   */
  forSession(sessionId: SessionId): ConversationGoalReview
}

/** Generated review operations consumed by this Client owner. */
export type GoalReviewRemote = Pick<ClientRemote['projectTasks'], 'goalReviewOptions' | 'reviewGoalPlan' | 'controlGoal' | 'deliverGoal' | 'getGoalTaskDiff' | 'getGoalTaskCodingFiles' | 'retryGoalKnowledgeDiscovery'
  | 'refreshGoalKnowledgeDiscovery' | 'recheckGoalNoChangeKnowledgeDiscovery' | 'inspect'
  | 'decideGoalKnowledge' | 'reviewGoalKnowledgeDraft' | 'publishGoalKnowledgeDraft' | 'reviewGoalKnowledgePublication'
  | 'inspectGoalKnowledgePublication' | 'acknowledgeGoalKnowledgePublication' | 'resumeGoalKnowledgeDecision' | 'resumeGoalAutomaticKnowledge'>
/** Gateway-supervised complete-state feed. */
export type GoalReviewFollow = (workspaceId: WorkspaceId, sessionId: SessionId) => RemoteStream<ProjectGoalState | null>

const initial = (workspaceId: WorkspaceId | null): GoalReviewSnapshot => ({ workspaceId,
  phase: workspaceId === null ? 'idle' : 'loading', goal: null, error: null, options: null,
  optionsPhase: 'idle', optionsError: null, pending: false, commandError: null, retry: null, controlRetry: null,
  deliveryRetry: null, goalKnowledgeDiscoveryRetry: null, goalKnowledgeCommandRetry: null,
  goalKnowledgePreAdmissionConflict: null, goalKnowledgeRefreshRetry: null, noChangeRecheckRetry: null })

/** Shares one feed; matching terminal receipts retire their own commands, and disposal joins withdrawn work. */
export class ClientGoalReview implements ConversationGoalReview {
  private readonly store = createSnapshotStore<GoalReviewSnapshot>(initial(null))
  readonly state: ObservableSnapshot<GoalReviewSnapshot>
  private readonly work = new Set<Promise<unknown>>()
  private stream: RemoteStream<ProjectGoalState | null> | undefined
  private command: AbortController | undefined
  private discoveryCommand: { kind: 'retry' | 'refresh' | 'recheck'; request: AbortController } | undefined
  private knowledgeCommand: AbortController | undefined
  private knowledgeIntent: GoalKnowledgeCommandRetry | undefined
  private preAdmissionConflict: GoalKnowledgePreAdmissionConflict | undefined
  private preAdmissionMembership: string | undefined
  private refreshIntent: GoalKnowledgeRefreshRetry | undefined
  private recheckIntent: GoalKnowledgeNoChangeRecheckRetry | undefined
  private readonly reads = new Set<AbortController>()
  private membership: string | undefined
  private stopWorkspace: (() => void) | undefined
  private subscribers = 0
  private generation = 0
  private disposed = false
  private intent: { membership: string; id: ProjectGoalRunId; input: ProjectGoalReviewInput } | undefined
  private controlIntent: { membership: string; id: ProjectGoalRunId; input: ProjectGoalControlInput } | undefined
  private deliveryIntent: { membership: string; id: ProjectGoalRunId; input: ProjectGoalDeliveryInput } | undefined

  /** @param sessionId - immutable source identity.
   * @param workspaces - authoritative project membership and readiness.
   * @param remote - generated review operations.
   * @param follow - reconnecting stream factory; no model execution is started by reading it.
   */
  constructor(private readonly sessionId: SessionId, private readonly workspaces: WorkspaceSource,
    private readonly remote: GoalReviewRemote, private readonly follow: GoalReviewFollow) {
    this.state = { getSnapshot: () => this.store.getSnapshot(), subscribe: (listener) => {
      if (this.disposed) return () => {}
      const off = this.store.subscribe(listener)
      if (++this.subscribers === 1) {
        this.stopWorkspace = workspaces.subscribe(() => { this.sync() })
        this.sync()
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        off()
        if (--this.subscribers === 0) { this.stopWorkspace?.(); this.stopWorkspace = undefined; this.replace(null) }
      }
    } }
  }

  private checkedKnowledgeRefresh(saved: ProjectTaskState,
    intent: Pick<GoalKnowledgeRefreshRetry, 'workspaceId' | 'goalRunId' | 'taskId' | 'requestId'>, recheck = false) {
    const current = this.store.getSnapshot()
    if (saved.id !== intent.taskId || saved.goal?.runId !== intent.goalRunId
      || saved.goalKnowledgeRefresh?.requestId !== intent.requestId
      || recheck && !('sourceNoChangeSha256' in saved.goalKnowledgeRefresh)
      || current.workspaceId !== intent.workspaceId || current.goal?.id !== intent.goalRunId) return undefined
    return { ...current, goal: current.goal }
  }

  private async readGoalResult<T>(signal: AbortSignal,
    read: (workspaceId: WorkspaceId, live: AbortSignal) => Promise<RemoteResult<T>>): Promise<T> {
    const workspaceId = this.store.getSnapshot().workspaceId
    if (this.disposed || workspaceId === null || this.membership === undefined) throw new Error('Goal source project is unavailable')
    const request = new AbortController()
    const live = AbortSignal.any([signal, request.signal])
    this.reads.add(request)
    return this.track((async () => {
      try {
        live.throwIfAborted()
        const result = await read(workspaceId, live)
        live.throwIfAborted()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      } finally { this.reads.delete(request) }
    })())
  }

  async diff(id: ProjectGoalRunId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalTaskDiff> {
    return this.readGoalResult(signal,
      (workspaceId, live) => this.remote.getGoalTaskDiff(workspaceId, this.sessionId, id, taskId, live))
  }

  async codingFiles(id: ProjectGoalRunId, taskId: ProjectTaskId, signal: AbortSignal): Promise<ProjectGoalCodingFiles> {
    return this.readGoalResult(signal,
      (workspaceId, live) => this.remote.getGoalTaskCodingFiles(workspaceId, this.sessionId, id, taskId, live))
  }

  refreshGoalKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    const task = state.goal?.tasks?.find(item => item.id === taskId)
    const old = this.refreshIntent
    if (this.disposed || this.discoveryCommand !== undefined || this.knowledgeCommand !== undefined
      || state.phase !== 'ready' || workspaceId === null || this.membership === undefined
      || state.goal?.id !== id || task?.goal?.runId !== id
      || (old === undefined && task.goalKnowledgeDecision?.prewriteConflict?.kind !== 'decision')
      || old !== undefined && (old.workspaceId !== workspaceId || old.goalRunId !== id
        || old.taskId !== taskId || old.membership !== this.membership || old.status === 'pending')) return Promise.resolve(false)
    const intent: GoalKnowledgeRefreshRetry = old ?? { workspaceId, goalRunId: id, taskId,
      membership: this.membership, requestId: brandString<ProjectTaskKnowledgeDiscoveryRequestId>(randomUUID()),
      status: 'unconfirmed' }
    const request = new AbortController()
    const command = { kind: 'refresh' as const, request }
    this.discoveryCommand = command
    this.refreshIntent = { ...intent, status: 'pending' }
    this.publish({ goalKnowledgeRefreshRetry: this.refreshIntent, commandError: null })
    return this.track((async () => {
      try {
        const result = await this.remote.refreshGoalKnowledgeDiscovery(workspaceId, taskId,
          intent.requestId, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        if (request.signal.aborted || this.discoveryCommand !== command) return this.hasSavedKnowledgeRefresh(intent, false)
        const saved = result.value
        const current = this.checkedKnowledgeRefresh(saved, intent)
        if (current === undefined) return false
        const settled = this.refreshSettled(intent, saved)
        this.refreshIntent = settled ? undefined : { ...intent, status: 'unconfirmed' }
        this.publish({ goal: { ...current.goal, tasks: current.goal.tasks?.map(item => item.id === taskId ? saved : item) },
          goalKnowledgeRefreshRetry: this.refreshIntent ?? null })
        return true
      } catch (error) {
        if (request.signal.aborted) return this.hasSavedKnowledgeRefresh(intent, false)
        /* v8 ignore else -- Retiring this exact command aborts it before clearing its slot or changing Goal scope. */
        if (!request.signal.aborted && this.discoveryCommand === command
          && this.store.getSnapshot().goal?.id === id) {
          this.refreshIntent = { ...intent, status: 'unconfirmed' }
          this.publish({ goalKnowledgeRefreshRetry: this.refreshIntent, commandError: String(error) })
        }
        return false
      } finally { if (this.discoveryCommand === command) this.discoveryCommand = undefined }
    })())
  }

  private refreshSettled(intent: GoalKnowledgeRefreshRetry, task: ProjectTaskState): boolean {
    const discovery = task.goalKnowledgeDiscovery
    return task.goalKnowledgeRefresh?.requestId === intent.requestId
      && (discovery?.status === 'candidate' || discovery?.status === 'no-change'
        || discovery?.status === 'blocked')
  }

  recheckNoChangeKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    const task = state.goal?.tasks?.find(item => item.id === taskId)
    const old = this.recheckIntent
    const durableQueued = task?.goalKnowledgeDiscovery?.status === 'queued'
      && task.goalKnowledgeRefresh !== undefined && 'sourceNoChangeSha256' in task.goalKnowledgeRefresh
      ? task.goalKnowledgeRefresh.requestId : undefined
    if (this.disposed || this.discoveryCommand !== undefined || this.knowledgeCommand !== undefined
      || this.refreshIntent !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id || task?.goal?.runId !== id
      || old === undefined && task.goalKnowledgeDiscovery?.status !== 'no-change' && durableQueued === undefined
      || old !== undefined && (old.workspaceId !== workspaceId || old.goalRunId !== id
        || old.taskId !== taskId || old.membership !== this.membership || old.status === 'pending')) return Promise.resolve(false)
    const intent: GoalKnowledgeNoChangeRecheckRetry = old ?? { workspaceId, goalRunId: id, taskId,
      membership: this.membership, requestId: durableQueued ?? brandString<ProjectTaskKnowledgeDiscoveryRequestId>(randomUUID()),
      status: 'unconfirmed' }
    const request = new AbortController()
    const command = { kind: 'recheck' as const, request }
    this.discoveryCommand = command
    this.recheckIntent = { ...intent, status: 'pending' }
    this.publish({ noChangeRecheckRetry: this.recheckIntent, commandError: null })
    return this.track((async () => {
      try {
        const result = await this.remote.recheckGoalNoChangeKnowledgeDiscovery(workspaceId, taskId,
          intent.requestId, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        if (request.signal.aborted || this.discoveryCommand !== command) return this.hasSavedKnowledgeRefresh(intent, true)
        const saved = result.value
        const current = this.checkedKnowledgeRefresh(saved, intent, true)
        if (current === undefined) return false
        const settled = this.refreshSettled(intent, saved)
        this.recheckIntent = settled ? undefined : { ...intent, status: 'unconfirmed' }
        this.publish({ goal: { ...current.goal, tasks: current.goal.tasks?.map(item => item.id === taskId ? saved : item) },
          noChangeRecheckRetry: this.recheckIntent ?? null })
        return true
      } catch (error) {
        if (request.signal.aborted) return this.hasSavedKnowledgeRefresh(intent, true)
        /* v8 ignore else -- Retiring this exact command aborts it before clearing its slot or changing Goal scope. */
        if (!request.signal.aborted && this.discoveryCommand === command
          && this.store.getSnapshot().goal?.id === id) {
          this.recheckIntent = { ...intent, status: 'unconfirmed' }
          this.publish({ noChangeRecheckRetry: this.recheckIntent, commandError: String(error) })
        }
        return false
      } finally { if (this.discoveryCommand === command) this.discoveryCommand = undefined }
    })())
  }

  decideGoalKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeDecisionRequest): Promise<boolean | 'source-identifiers-missing'> {
    return this.sendKnowledge(id, taskId, { kind: 'decision', request }, signal =>
      this.remote.decideGoalKnowledge(request.subject.workspaceId, taskId, request, signal), true)
  }

  publishGoalKnowledgeDraft(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgePublishRequest): Promise<boolean> {
    return this.sendKnowledge(id, taskId, { kind: 'publication', request }, signal =>
      this.remote.publishGoalKnowledgeDraft(request.subject.workspaceId, taskId, request, signal))
  }

  acknowledgeGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId,
    request: ProjectGoalKnowledgeAcknowledgeRequest): Promise<boolean> {
    return this.sendKnowledge(id, taskId, { kind: 'acknowledgement', request }, signal =>
      this.remote.acknowledgeGoalKnowledgePublication(request.subject.workspaceId, taskId, request, signal))
  }

  retryGoalKnowledgeCommand(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    const intent = this.knowledgeIntent
    if (intent?.goalRunId !== id || intent.taskId !== taskId || intent.status === 'pending'
      || this.store.getSnapshot().workspaceId !== intent.workspaceId
      || this.membership !== intent.membership) return Promise.resolve(false)
    switch (intent.kind) {
      case 'decision':
      case 'publication': return this.refreshKnowledge(id, taskId, (workspaceId, signal) =>
        this.remote.resumeGoalKnowledgeDecision(workspaceId, taskId, signal))
      case 'acknowledgement': return this.sendKnowledge(id, taskId, intent, signal =>
        this.remote.acknowledgeGoalKnowledgePublication(intent.workspaceId, taskId, intent.request, signal))
    }
  }

  resumeGoalKnowledgeDecision(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    return this.refreshKnowledge(id, taskId, (workspaceId, signal) =>
      this.remote.resumeGoalKnowledgeDecision(workspaceId, taskId, signal))
  }

  resumeGoalAutomaticKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    return this.refreshKnowledge(id, taskId, (workspaceId, signal) =>
      this.remote.resumeGoalAutomaticKnowledge(workspaceId, taskId, signal))
  }

  reviewGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<boolean> {
    return this.refreshKnowledge(id, taskId, (workspaceId, signal) =>
      this.remote.reviewGoalKnowledgePublication(workspaceId, taskId, signal))
  }

  reviewGoalKnowledgeDraft(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<ProjectTaskKnowledgeDraftReview> {
    return this.readKnowledge(id, taskId, (workspaceId, signal) =>
      this.remote.reviewGoalKnowledgeDraft(workspaceId, taskId, signal))
  }

  inspectGoalKnowledgePublication(id: ProjectGoalRunId, taskId: ProjectTaskId): Promise<ProjectTaskKnowledgePublicationInspection> {
    return this.readKnowledge(id, taskId, (workspaceId, signal) =>
      this.remote.inspectGoalKnowledgePublication(workspaceId, taskId, signal))
  }

  private async readKnowledge<T>(id: ProjectGoalRunId, taskId: ProjectTaskId,
    call: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<
      { ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    if (this.disposed || workspaceId === null || this.membership === undefined || state.goal?.id !== id
      || !state.goal.tasks?.some(task => task.id === taskId && task.goal?.runId === id)) throw new Error('Goal knowledge source is unavailable')
    const membership = this.membership
    const request = new AbortController()
    this.reads.add(request)
    return this.track((async () => {
      try {
        const result = await call(workspaceId, request.signal)
        request.signal.throwIfAborted()
        if (!result.ok) throw new Error(result.error.message)
        if (this.membership !== membership || this.store.getSnapshot().goal?.id !== id) throw new Error('Goal knowledge source changed')
        return result.value
      } finally { this.reads.delete(request) }
    })())
  }

  private sendKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    input: Pick<GoalKnowledgeCommandRetry, 'kind' | 'request'>,
    call: (signal: AbortSignal) => ReturnType<GoalReviewRemote['decideGoalKnowledge']>,
    sourceRefusal: true): Promise<boolean | 'source-identifiers-missing'>
  private sendKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    input: Pick<GoalKnowledgeCommandRetry, 'kind' | 'request'>,
    call: (signal: AbortSignal) => ReturnType<GoalReviewRemote['decideGoalKnowledge']>): Promise<boolean>
  private sendKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    input: Pick<GoalKnowledgeCommandRetry, 'kind' | 'request'>,
    call: (signal: AbortSignal) => ReturnType<GoalReviewRemote['decideGoalKnowledge']>,
    sourceRefusal = false): Promise<boolean | 'source-identifiers-missing'> {
    const retry = this.knowledgeIntent
    if (retry?.status === 'unconfirmed' && (retry.kind === 'decision' || retry.kind === 'publication')
      && retry.kind === input.kind && retry.goalRunId === id && retry.taskId === taskId
      && JSON.stringify(retry.request) === JSON.stringify(input.request)) {
      return this.retryGoalKnowledgeCommand(id, taskId)
    }
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    const task = state.goal?.tasks?.find(item => item.id === taskId)
    if (this.disposed || this.knowledgeCommand !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id || task?.goal?.runId !== id
      || input.request.subject.workspaceId !== workspaceId || input.request.subject.goalRunId !== id
      || this.knowledgeIntent !== undefined && (this.knowledgeIntent.kind !== input.kind
        || JSON.stringify(this.knowledgeIntent.request) !== JSON.stringify(input.request))) return Promise.resolve(false)
    const intent: GoalKnowledgeCommandRetry = { ...input, workspaceId, goalRunId: id, taskId,
      membership: this.membership, status: 'pending' } as GoalKnowledgeCommandRetry
    const request = new AbortController()
    this.knowledgeCommand = request
    this.knowledgeIntent = intent
    this.preAdmissionConflict = undefined
    this.preAdmissionMembership = undefined
    this.publish({ pending: true, commandError: null, goalKnowledgeCommandRetry: intent,
      goalKnowledgePreAdmissionConflict: null })
    return this.track((async () => {
      try {
        const result = await call(request.signal)
        if (!result.ok) {
          if (sourceRefusal && input.kind === 'decision' && result.error.code === 'project-task/rejected'
            && result.error.details.reason === 'knowledge-source-identifiers-missing' && !request.signal.aborted) {
            this.knowledgeIntent = undefined
            this.publish({ goalKnowledgeCommandRetry: null, commandError: null })
            return 'source-identifiers-missing'
          }
          if (await this.confirmPreAdmissionConflict(intent, result.error)) return false
          throw new Error(result.error.message)
        }
        if (request.signal.aborted) return this.hasGoalKnowledgeReceipt(intent)
        return this.acceptKnowledgeState(id, taskId, workspaceId, result.value, intent)
      } catch (error) {
        if (request.signal.aborted) return this.hasGoalKnowledgeReceipt(intent)
        if (this.knowledgeCommand === request && this.store.getSnapshot().goal?.id === id) {
          const settled = this.hasGoalKnowledgeReceipt(intent)
          this.knowledgeIntent = settled ? undefined : { ...intent, status: 'unconfirmed' }
          this.publish({ commandError: settled ? null : String(error), goalKnowledgeCommandRetry: this.knowledgeIntent ?? null })
          return settled
        }
        return false
      } finally {
        if (this.knowledgeCommand === request) { this.knowledgeCommand = undefined; this.publish({ pending: false }) }
      }
    })())
  }

  private refreshKnowledge(id: ProjectGoalRunId, taskId: ProjectTaskId,
    call: (workspaceId: WorkspaceId, signal: AbortSignal) => ReturnType<GoalReviewRemote['resumeGoalKnowledgeDecision']>): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    if (this.disposed || this.knowledgeCommand !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id
      || !state.goal.tasks?.some(task => task.id === taskId && task.goal?.runId === id)) return Promise.resolve(false)
    const request = new AbortController()
    this.knowledgeCommand = request
    this.publish({ pending: true, commandError: null })
    return this.track((async () => {
      try {
        const result = await call(workspaceId, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        if (request.signal.aborted) return false
        return this.acceptKnowledgeState(id, taskId, workspaceId, result.value, this.knowledgeIntent)
      } catch (error) {
        if (!request.signal.aborted && this.store.getSnapshot().goal?.id === id) this.publish({ commandError: String(error) })
        return false
      } finally {
        if (this.knowledgeCommand === request) { this.knowledgeCommand = undefined; this.publish({ pending: false }) }
      }
    })())
  }

  private acceptKnowledgeState(id: ProjectGoalRunId, taskId: ProjectTaskId, workspaceId: WorkspaceId,
    saved: ProjectTaskState, intent?: GoalKnowledgeCommandRetry): boolean {
    if (saved.id !== taskId || saved.goal?.runId !== id) throw new Error('Goal knowledge source changed')
    const current = this.store.getSnapshot()
    if (current.workspaceId !== workspaceId || current.goal?.id !== id) return false
    const goal = { ...current.goal, tasks: current.goal.tasks?.map(item => item.id === taskId ? saved : item) }
    const settled = intent !== undefined && this.goalKnowledgeSettled(intent, saved)
    if (settled) this.knowledgeIntent = undefined
    else if (intent !== undefined) this.knowledgeIntent = { ...intent, status: 'unconfirmed' }
    this.publish({ goal, goalKnowledgeCommandRetry: this.knowledgeIntent ?? null })
    return true
  }

  private goalKnowledgeSettled(intent: GoalKnowledgeCommandRetry, task: ProjectTaskState): boolean {
    const state = task.goalKnowledgeDecision
    if (state === undefined || JSON.stringify(state.subject) !== JSON.stringify(intent.request.subject)) return false
    const decision = state.decision
    switch (intent.kind) {
      case 'decision':
        return decision.decisionId === intent.request.choice.decisionId
          && (decision.status === 'dismissed' || decision.status === 'proposal-saved' || decision.status === 'draft-saved')
      case 'publication':
        return decision.status === 'draft-saved' && decision.publication?.status === 'published'
          && decision.publication.operationId === intent.request.publication.operationId
          && decision.publication.receipt?.operationId === intent.request.publication.operationId
      case 'acknowledgement':
        return decision.status === 'draft-saved' && decision.publication?.status === 'published'
          && decision.publication.acknowledgement?.operationId === intent.request.acknowledgement.operationId
    }
  }

  private hasGoalKnowledgeReceipt(intent: GoalKnowledgeCommandRetry): boolean {
    const state = this.store.getSnapshot()
    const task = state.goal?.tasks?.find(item => item.id === intent.taskId)
    return state.workspaceId === intent.workspaceId && state.goal?.id === intent.goalRunId
      && task !== undefined && this.goalKnowledgeSettled(intent, task)
  }

  private async confirmPreAdmissionConflict(intent: GoalKnowledgeCommandRetry, error: RemoteFailure): Promise<boolean> {
    if (intent.kind !== 'publication' || error.code !== 'project-task/rejected'
      || error.details.reason !== 'knowledge-review-conflict' || this.knowledgeCommand?.signal.aborted === true) return false
    const observed = await this.remote.inspect(intent.workspaceId, intent.taskId)
    if (!observed.ok || observed.value === null || this.membership !== intent.membership) return false
    const task = observed.value
    const current = this.store.getSnapshot()
    const decision = task.goalKnowledgeDecision
    if (current.workspaceId !== intent.workspaceId || current.goal?.id !== intent.goalRunId
      || task.goal?.runId !== intent.goalRunId || decision?.decision.status !== 'draft-saved'
      || decision.decision.publication !== undefined
      || decision.decision.draftOperationId !== intent.request.publication.draftOperationId
      || !sameKnowledgeSubject(decision.subject, intent.request.subject)) return false
    this.knowledgeIntent = undefined
    this.preAdmissionConflict = { kind: 'publication', taskId: intent.taskId,
      operationId: intent.request.publication.operationId, reason: 'pre-admission-conflict' }
    this.preAdmissionMembership = intent.membership
    this.publish({ goal: { ...current.goal, tasks: current.goal.tasks?.map(item => item.id === intent.taskId ? task : item) },
      goalKnowledgeCommandRetry: null, goalKnowledgePreAdmissionConflict: this.preAdmissionConflict,
      commandError: error.message })
    return true
  }



  refresh(): void {
    if (this.disposed || this.subscribers === 0) return
    this.replace(this.store.getSnapshot().workspaceId, this.membership)
  }

  review(id: ProjectGoalRunId, planId: ProjectGoalRequestId, decision: GoalReviewDecision): Promise<boolean> {
    const state = this.store.getSnapshot()
    if (state.retry !== null || state.goal?.phase !== 'SIGNOFF') return Promise.resolve(false)
    const input: ProjectGoalReviewInput = { ...structuredClone(decision), planRequestId: planId,
      requestId: brandString<ProjectGoalRequestId>(randomUUID()) }
    return this.send(id, planId, input)
  }

  retry(id: ProjectGoalRunId, planId: ProjectGoalRequestId): Promise<boolean> {
    const input = this.store.getSnapshot().retry
    return input === null ? Promise.resolve(false) : this.send(id, planId, input)
  }

  control(id: ProjectGoalRunId, action: ProjectGoalControlInput['action'], budgetOverride?: ProjectGoalControlInput['budgetOverride']): Promise<boolean> {
    const state = this.store.getSnapshot()
    if (state.goal === null || state.controlRetry !== null || (action === 'exit'
      ? state.goal.phase === 'DONE' || state.goal.phase === 'EXITED'
      : action === 'pause' ? state.goal.phase !== 'RUNNING' : state.goal.phase !== 'PAUSED' && state.goal.phase !== 'ESCALATED')
      || (action !== 'resume' && budgetOverride !== undefined)) return Promise.resolve(false)
    return this.sendControl(id, { requestId: brandString<ProjectGoalRequestId>(randomUUID()), action,
      revision: state.goal.controlRevision ?? 0,
      ...(budgetOverride === undefined ? {} : { budgetOverride: structuredClone(budgetOverride) }) })
  }

  retryControl(id: ProjectGoalRunId): Promise<boolean> {
    const intent = this.store.getSnapshot().controlRetry
    return intent === null ? Promise.resolve(false) : this.sendControl(id, intent)
  }

  deliver(id: ProjectGoalRunId, action?: ProjectGoalDeliveryInput['action']): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    if (this.disposed || this.command !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id || state.controlRetry !== null
      || !['DONE', 'ESCALATED', 'EXITED'].includes(state.goal.phase)
      || (action !== undefined && (state.deliveryRetry !== null || state.goal.delivery?.status === 'merged'
        || state.goal.delivery?.status === 'checked-out' || (action === 'keep' && state.goal.delivery?.status === 'kept')))) return Promise.resolve(false)
    const input = action === undefined ? state.deliveryRetry : { requestId: brandString<ProjectGoalRequestId>(randomUUID()), action }
    if (input === null) return Promise.resolve(false)
    const request = new AbortController()
    this.command = request
    this.deliveryIntent = { membership: this.membership, id, input }
    this.publish({ pending: true, commandError: null, deliveryRetry: input })
    return this.trackGoalCommand(id, request,
      () => this.remote.deliverGoal(workspaceId, this.sessionId, id, input, request.signal))
  }

  retryGoalKnowledgeDiscovery(id: ProjectGoalRunId, taskId: ProjectTaskId,
    reportMessageId: ProjectGoalKnowledgeDiscovery['reportMessageId']): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    const goal = state.goal
    const task = goal?.tasks?.find(item => item.id === taskId)
    if (this.disposed || this.discoveryCommand !== undefined || this.command !== undefined || state.phase !== 'ready'
      || state.pending || workspaceId === null || this.membership === undefined || goal?.id !== id
      || (goal.phase !== 'RUNNING' && goal.phase !== 'DONE') || task?.goal?.runId !== id
      || task.goalKnowledgeDiscovery?.status !== 'blocked'
      || task.goalKnowledgeDiscovery.reportMessageId !== reportMessageId
      || goal.planHistory?.some(item => item.taskIds.includes(taskId))) return Promise.resolve(false)
    const old = state.goalKnowledgeDiscoveryRetry
    if (old !== null && (old.workspaceId !== workspaceId || old.goalRunId !== id || old.taskId !== taskId
      || old.reportMessageId !== reportMessageId || old.status === 'pending')) return Promise.resolve(false)
    const intent: GoalKnowledgeDiscoveryRetry = old ?? { workspaceId, goalRunId: id, taskId, reportMessageId,
      requestId: brandString<ProjectTaskKnowledgeDiscoveryRequestId>(randomUUID()), status: 'unconfirmed' }
    const request = new AbortController()
    const command = { kind: 'retry' as const, request }
    this.discoveryCommand = command
    this.publish({ goalKnowledgeDiscoveryRetry: { ...intent, status: 'pending' } })
    return this.track((async () => {
      try {
        const result = await this.remote.retryGoalKnowledgeDiscovery(workspaceId, taskId, intent.requestId, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        if (request.signal.aborted || this.discoveryCommand !== command) return this.hasSavedDiscoveryReceipt(intent)
        const saved = result.value
        if (saved.id !== taskId || saved.goal?.runId !== id
          || saved.goalKnowledgeDiscovery?.reportMessageId !== reportMessageId) throw new Error('Goal discovery source changed')
        const current = this.store.getSnapshot()
        /* v8 ignore if -- The checked live command retains its workspace and Goal; scope changes abort it. */
        if (current.workspaceId !== workspaceId || current.goal?.id !== id) return false
        this.publish({ goal: { ...current.goal, tasks: current.goal.tasks?.map(item => item.id === taskId ? saved : item) },
          goalKnowledgeDiscoveryRetry: null })
        return true
      } catch {
        if (request.signal.aborted) return this.hasSavedDiscoveryReceipt(intent)
        /* v8 ignore else -- Only this finalizer or an aborting retirement can clear or replace this command. */
        if (this.discoveryCommand === command) {
          const current = this.store.getSnapshot()
          /* v8 ignore else -- The live command retains its scope until an aborting retirement, without an intervening callback. */
          if (current.workspaceId === workspaceId && current.goal?.id === id) {
            const observed = current.goal.tasks?.find(item => item.id === taskId)?.goalKnowledgeDiscovery
            const settled = observed?.reportMessageId === reportMessageId && (observed.status === 'candidate'
              || observed.status === 'no-change' || observed.status === 'blocked' && observed.requestId === intent.requestId)
            this.publish({ goalKnowledgeDiscoveryRetry: settled ? null : { ...intent, status: 'unconfirmed' } })
            return settled
          }
        }
        /* v8 ignore next -- Only an already-rejected owner or scope can reach this retained fallback. */
        return false
      } finally {
        if (this.discoveryCommand === command) this.discoveryCommand = undefined
      }
    })())
  }

  private trackGoalCommand(id: ProjectGoalRunId, request: AbortController,
    send: () => Promise<RemoteResult<unknown>>): Promise<boolean> {
    return this.track((async () => {
      try {
        const result = await send()
        if (!result.ok) throw new Error(result.error.message)
        return !request.signal.aborted
      } catch (error) {
        if (!request.signal.aborted && this.store.getSnapshot().goal?.id === id) this.publish({ commandError: String(error) })
        return false
      } finally {
        if (this.command === request) { this.command = undefined; this.publish({ pending: false }) }
      }
    })())
  }

  private sendControl(id: ProjectGoalRunId, input: ProjectGoalControlInput): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    if (this.disposed || this.command !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id) return Promise.resolve(false)
    const request = new AbortController()
    this.command = request
    this.controlIntent = { membership: this.membership, id, input }
    this.publish({ pending: true, commandError: null, controlRetry: input })
    return this.trackGoalCommand(id, request,
      () => this.remote.controlGoal(workspaceId, this.sessionId, id, input, request.signal))
  }

  private send(id: ProjectGoalRunId, planId: ProjectGoalRequestId, input: ProjectGoalReviewInput): Promise<boolean> {
    const state = this.store.getSnapshot()
    const workspaceId = state.workspaceId
    if (this.disposed || this.command !== undefined || state.phase !== 'ready' || workspaceId === null
      || this.membership === undefined || state.goal?.id !== id || state.goal.plan?.requestId !== planId
      || input.planRequestId !== planId || state.goal.phase === 'EXITED' || state.goal.review?.delivery === 'sent') return Promise.resolve(false)
    const request = new AbortController()
    this.command = request
    this.intent = { membership: this.membership, id, input }
    this.publish({ pending: true, commandError: null, retry: input })
    return this.track((async () => {
      try {
        const result = await this.remote.reviewGoalPlan(workspaceId, this.sessionId, id, input, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        return !request.signal.aborted
      } catch (error) {
        if (!request.signal.aborted && this.matches(id, planId)) this.publish({ commandError: String(error) })
        return false
      } finally {
        if (this.command === request) { this.command = undefined; this.publish({ pending: false }) }
      }
    })())
  }

  private matches(id: ProjectGoalRunId, planId: ProjectGoalRequestId): boolean {
    const goal = this.store.getSnapshot().goal
    return goal?.id === id && goal.plan?.requestId === planId
  }

  private hasSavedKnowledgeRefresh(intent: GoalKnowledgeRefreshRetry, recheck: boolean): boolean {
    const state = this.store.getSnapshot()
    const task = state.goal?.tasks?.find(item => item.id === intent.taskId)
    return this.membership === intent.membership && state.workspaceId === intent.workspaceId
      && state.goal?.id === intent.goalRunId && task?.goal?.runId === intent.goalRunId
      && (!recheck || task.goalKnowledgeRefresh !== undefined && 'sourceNoChangeSha256' in task.goalKnowledgeRefresh)
      && this.refreshSettled(intent, task)
  }

  private hasSavedDiscoveryReceipt(intent: GoalKnowledgeDiscoveryRetry): boolean {
    const state = this.store.getSnapshot()
    const task = state.goal?.tasks?.find(item => item.id === intent.taskId)
    const result = task?.goalKnowledgeDiscovery
    return state.workspaceId === intent.workspaceId && state.goal?.id === intent.goalRunId
      && task?.goal?.runId === intent.goalRunId && result?.reportMessageId === intent.reportMessageId
      && (result.status === 'candidate' || result.status === 'no-change'
        || result.status === 'blocked' && result.requestId === intent.requestId)
  }

  private sync(): void {
    const state = this.workspaces.getSnapshot()
    const project = state.phase === 'ready' ? state.items.find(item => item.sessionIds.includes(this.sessionId)) : undefined
    const key = project === undefined ? undefined : JSON.stringify([project.workspaceId, project.path])
    if (key !== this.membership) this.replace(project?.workspaceId ?? null, key)
  }

  private replace(workspaceId: WorkspaceId | null, membership?: string): void {
    for (const request of this.reads) request.abort()
    const generation = ++this.generation
    const previous = this.stream
    this.stream = undefined
    this.membership = membership
    if (previous !== undefined) void this.track(previous.dispose())
    this.command?.abort()
    this.command = undefined
    this.discoveryCommand?.request.abort()
    this.discoveryCommand = undefined
    this.knowledgeCommand?.abort()
    this.knowledgeCommand = undefined
    if (this.knowledgeIntent?.status === 'pending') this.knowledgeIntent = { ...this.knowledgeIntent, status: 'unconfirmed' }
    if (this.refreshIntent?.status === 'pending') this.refreshIntent = { ...this.refreshIntent, status: 'unconfirmed' }
    if (this.recheckIntent?.status === 'pending') this.recheckIntent = { ...this.recheckIntent, status: 'unconfirmed' }
    if (membership !== undefined && this.knowledgeIntent?.membership !== membership) this.knowledgeIntent = undefined
    if (membership !== undefined && this.refreshIntent?.membership !== membership) this.refreshIntent = undefined
    if (membership !== undefined && this.recheckIntent?.membership !== membership) this.recheckIntent = undefined
    if (membership !== undefined && this.preAdmissionMembership !== membership) {
      this.preAdmissionConflict = undefined
      this.preAdmissionMembership = undefined
    }
    this.store.set({ ...initial(workspaceId), goalKnowledgeCommandRetry: this.knowledgeIntent !== undefined
      && membership === this.knowledgeIntent.membership ? this.knowledgeIntent : null,
    goalKnowledgeRefreshRetry: this.refreshIntent !== undefined && membership === this.refreshIntent.membership
      ? this.refreshIntent : null,
    noChangeRecheckRetry: this.recheckIntent !== undefined && membership === this.recheckIntent.membership
      ? this.recheckIntent : null,
    goalKnowledgePreAdmissionConflict: this.preAdmissionConflict ?? null })
    if (workspaceId === null) return
    const stream = this.follow(workspaceId, this.sessionId)
    this.stream = stream
    void this.track((async () => {
      try {
        for await (const item of stream) {
          if (this.stream !== stream) return
          item.accept()
          const goal = item.value
          const old = this.store.getSnapshot().goal
          const discoveryRetry = this.store.getSnapshot().goalKnowledgeDiscoveryRetry
          const discoveryTask = goal?.tasks?.find(task => task.id === discoveryRetry?.taskId)
          const discoveryValid = discoveryRetry !== null && goal?.id === discoveryRetry.goalRunId
            && (goal.phase === 'RUNNING' || goal.phase === 'DONE') && discoveryTask?.goal?.runId === goal.id
            && discoveryTask.goalKnowledgeDiscovery?.reportMessageId === discoveryRetry.reportMessageId
            && !goal.planHistory?.some(history => history.taskIds.includes(discoveryRetry.taskId))
          const discoverySettled = discoveryValid && (discoveryTask.goalKnowledgeDiscovery.status === 'candidate'
            || discoveryTask.goalKnowledgeDiscovery.status === 'no-change'
            || discoveryTask.goalKnowledgeDiscovery.status === 'blocked'
              && discoveryTask.goalKnowledgeDiscovery.requestId === discoveryRetry.requestId)
          if (this.discoveryCommand?.kind === 'retry' && (!discoveryValid || discoverySettled)) {
            this.discoveryCommand.request.abort(); this.discoveryCommand = undefined
          }
          const knowledgeIntent = this.knowledgeIntent
          const knowledgeTask = goal?.tasks?.find(task => task.id === knowledgeIntent?.taskId)
          if (knowledgeIntent !== undefined && knowledgeIntent.membership === membership
            && knowledgeIntent.goalRunId === goal?.id && knowledgeTask !== undefined
            && this.goalKnowledgeSettled(knowledgeIntent, knowledgeTask)) this.knowledgeIntent = undefined
          const refreshIntent = this.refreshIntent
          const refreshedTask = goal?.tasks?.find(task => task.id === refreshIntent?.taskId)
          const refreshValid = refreshIntent !== undefined && refreshedTask !== undefined
            && refreshIntent.membership === membership && refreshIntent.goalRunId === goal?.id
            && refreshedTask.goal?.runId === refreshIntent.goalRunId
          if (!refreshValid || this.refreshSettled(refreshIntent, refreshedTask)) {
            if (this.discoveryCommand?.kind === 'refresh') {
              this.discoveryCommand.request.abort(); this.discoveryCommand = undefined
            }
            this.refreshIntent = undefined
          }
          const recheckIntent = this.recheckIntent
          const recheckedTask = goal?.tasks?.find(task => task.id === recheckIntent?.taskId)
          const recheckValid = recheckIntent !== undefined && recheckedTask !== undefined
            && recheckIntent.membership === membership && recheckIntent.goalRunId === goal?.id
            && recheckedTask.goal?.runId === recheckIntent.goalRunId
          if (!recheckValid || recheckedTask.goalKnowledgeRefresh?.requestId === recheckIntent.requestId
            && 'sourceNoChangeSha256' in recheckedTask.goalKnowledgeRefresh
            && this.refreshSettled(recheckIntent, recheckedTask)) {
            if (this.discoveryCommand?.kind === 'recheck') {
              this.discoveryCommand.request.abort(); this.discoveryCommand = undefined
            }
            this.recheckIntent = undefined
          }
          const intent = this.intent
          const changedPlan = old?.id !== goal?.id || old?.plan?.requestId !== goal?.plan?.requestId
          if (changedPlan && this.command !== undefined) { this.command.abort(); this.command = undefined }
          const retained = intent !== undefined && intent.membership === membership && intent.id === goal?.id
            && intent.input.planRequestId === goal.plan?.requestId ? intent.input : null
          const retry = goal?.phase === 'EXITED' || goal?.review?.delivery === 'sent' ? null : goal?.review?.input ?? retained
          const gesture = this.controlIntent
          const uncertain = gesture !== undefined && gesture.membership === membership && gesture.id === goal?.id
            && (goal.controlRevision ?? 0) <= gesture.input.revision ? gesture.input : null
          const controlRetry = goal?.control?.delivery === 'pending' ? goal.control.input : uncertain
          const delivery = this.deliveryIntent
          const undelivered = delivery !== undefined && delivery.membership === membership && delivery.id === goal?.id
            && goal.delivery?.input.requestId !== delivery.input.requestId
            && goal.delivery?.status !== 'merged' && goal.delivery?.status !== 'checked-out' ? delivery.input : null
          const deliveryRetry = goal?.delivery?.status === 'pending' ? goal.delivery.input : undelivered
          this.publish({ goal, phase: 'ready', error: null, retry, controlRetry, deliveryRetry,
            goalKnowledgeDiscoveryRetry: discoveryValid && !discoverySettled ? discoveryRetry : null,
            goalKnowledgeCommandRetry: this.knowledgeIntent !== undefined
              && this.knowledgeIntent.membership === membership
              && this.knowledgeIntent.goalRunId === goal?.id ? this.knowledgeIntent : null,
            goalKnowledgeRefreshRetry: this.refreshIntent !== undefined
              && this.refreshIntent.membership === membership
              && this.refreshIntent.goalRunId === goal?.id ? this.refreshIntent : null,
            noChangeRecheckRetry: this.recheckIntent !== undefined
              && this.recheckIntent.membership === membership
              && this.recheckIntent.goalRunId === goal?.id ? this.recheckIntent : null,
            goalKnowledgePreAdmissionConflict: this.preAdmissionConflict ?? null,
            ...(changedPlan ? { commandError: null, pending: false, options: null, optionsPhase: 'idle', optionsError: null } : {}) })
          if (goal?.phase === 'SIGNOFF' && goal.plan !== undefined && this.store.getSnapshot().optionsPhase === 'idle') {
            this.readOptions(workspaceId, generation, goal.id, goal.plan.requestId)
          }
        }
      } catch (error) {
        if (this.stream === stream) this.publish({ phase: 'error', error: String(error) })
      }
    })())
  }

  private readOptions(workspaceId: WorkspaceId, generation: number, id: ProjectGoalRunId, planId: ProjectGoalRequestId): void {
    this.publish({ optionsPhase: 'loading', optionsError: null })
    void this.track((async () => {
      try {
        const result = await this.remote.goalReviewOptions(workspaceId, this.sessionId)
        if (!result.ok) throw new Error(result.error.message)
        if (generation === this.generation && this.matches(id, planId)) this.publish({ options: result.value, optionsPhase: 'ready' })
      } catch (error) {
        if (generation === this.generation && this.matches(id, planId)) this.publish({ optionsPhase: 'error', optionsError: String(error) })
      }
    })())
  }

  /** Withdraw membership, feed and decision work, then join transport settlement.
   * @returns after no old operation can publish another snapshot.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopWorkspace?.()
    this.stopWorkspace = undefined
    this.replace(null)
    this.knowledgeIntent = undefined
    this.refreshIntent = undefined
    this.recheckIntent = undefined
    this.preAdmissionConflict = undefined
    this.preAdmissionMembership = undefined
    await Promise.allSettled(this.work)
  }

  private publish(patch: Partial<GoalReviewSnapshot>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }

  private track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work)
    void work.then(() => { this.work.delete(work) }, () => { this.work.delete(work) })
    return work
  }
}
