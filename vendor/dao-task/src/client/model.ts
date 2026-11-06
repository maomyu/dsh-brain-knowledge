/** Project-scoped task snapshots; only the ordered follow stream publishes task records. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-task-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectTaskClaudeSelection, ProjectTaskCodexSelection, ProjectTaskId, ProjectTaskCodingConfirmation,
  ProjectTaskReviewPolicy, ProjectTaskState, ProjectTaskKnowledgeDiscoveryRequestId, ProjectTaskKnowledgeDecisionRequest,
  ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgePublishRequest, ProjectTaskKnowledgePublicationInspection,
  ProjectTaskKnowledgeAcknowledgeRequest } from '../types.ts'
import { DirectTaskAdmission } from './direct-admission.ts'

/** Current stream state and locally outstanding gestures; task fields are Host-owned. */
export interface TaskSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly tasks: readonly ProjectTaskState[]
  readonly error: string | null
  readonly pending: readonly ProjectTaskId[]
  readonly dirtyConfirmations: readonly ProjectTaskId[]
  readonly commandErrors: Readonly<Partial<Record<ProjectTaskId, string>>>
}

/** Operations used by the task presentation, excluding model proposal creation. */
export type TaskRemote = Pick<ClientRemote['projectTasks'], 'inspectDirectWorkspace' | 'confirm' | 'confirmCodex' | 'confirmClaude' | 'confirmCoding' | 'retryDraftTerminal' | 'cancel' | 'verify' | 'startReview' | 'cancelReview' | 'reviewTaskKnowledge' | 'cancelTaskKnowledgeReview' | 'retryTaskKnowledgeDiscovery' | 'refreshTaskKnowledgeDiscovery' | 'recheckTaskNoChangeKnowledgeDiscovery' | 'decideTaskKnowledge' | 'reviewTaskKnowledgeDraft' | 'publishTaskKnowledgeDraft' | 'resumeTaskKnowledgeDecision' | 'resumeTaskAutomaticKnowledge' | 'reviewTaskKnowledgePublication' | 'inspectTaskKnowledgePublication' | 'acknowledgeTaskKnowledgePublication'>
/** Gateway-owned reconnecting task subscription factory. */
export type TaskFollowFactory = (workspaceId: WorkspaceId) => RemoteStream<readonly ProjectTaskState[]>

/** React-free task projection and project-qualified commands. */
export interface IProjectTasks {
  readonly state: ObservableSnapshot<TaskSnapshot>
  /** Replace the followed project and withdraw its old commands.
   * @param workspaceId - active task project, or null to release it.
   */
  watch(workspaceId: WorkspaceId | null): void
  /** Reopen the current project's failed stream. */
  refresh(): void
  /** Request execution of the selected persisted draft.
   * @param workspaceId - project visible when the gesture occurred.
   * @param id - stored draft identity.
   * @returns after acknowledgement; failure is published, not thrown.
   */
  confirm(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Confirm a native Codex execution without adding automatic review authority.
   * @param workspaceId - original project.
   * @param id - retained draft.
   * @param selection - explicitly chosen native execution policy.
   * @returns after acknowledgement; errors remain in the snapshot.
   */
  confirmCodex(workspaceId: WorkspaceId, id: ProjectTaskId, selection: ProjectTaskCodexSelection): Promise<void>
  /** Confirm a native Claude execution without adding automatic review authority.
   * @param workspaceId - original project.
   * @param id - retained draft.
   * @param selection - explicitly chosen native execution policy.
   * @returns after acknowledgement; errors remain in the snapshot.
   */
  confirmClaude(workspaceId: WorkspaceId, id: ProjectTaskId, selection: ProjectTaskClaudeSelection): Promise<void>
  /** Confirm coding execution together with explicit review and post-step choices.
   * @param workspaceId - original project.
   * @param id - retained ordinary coding draft.
   * @param request - chosen executor, optional reviewer authority and retained test/fix guidance.
   * @returns after acknowledgement; records publish only through the follow stream.
   */
  confirmCoding(workspaceId: WorkspaceId, id: ProjectTaskId, request: ProjectTaskCodingConfirmation): Promise<void>
  /** Retry only a retained uncertain interactive handoff after separate user confirmation.
   * @param workspaceId - original project, including the current direct-project consent check.
   * @param id - prepared or unconfirmed Task; its selected runtime is sent unchanged.
   * @returns after acknowledgement; the follow stream publishes the resulting state.
   */
  retryTerminal(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Resolve this task's dirty prompt, or withdraw its unfinished inspection when leaving the view.
   * @param workspaceId - original project.
   * @param id - task shown in the confirmation.
   * @param allow - continue once or cancel without dispatch.
   */
  decideDirty(workspaceId: WorkspaceId, id: ProjectTaskId, allow: boolean): void
  /** Request cancellation and expose any command failure in the snapshot.
   * @param workspaceId - project visible when the gesture occurred.
   * @param id - execution to cancel.
   * @returns after cancellation acknowledgement; failure is published.
   */
  cancel(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Persist human checks without predicting the Host's resulting record.
   * @param workspaceId - project visible when the gesture occurred.
   * @param id - task whose human verification changes.
   * @param indices - checked verification steps.
   * @returns after durability acknowledgement; failure is published.
   */
  verify(workspaceId: WorkspaceId, id: ProjectTaskId, indices: readonly number[]): Promise<void>
  /** Explicitly admit a code review; progress remains owned by the follow stream.
   * @param workspaceId - project visible when the gesture occurred.
   * @param id - execution with a retained review baseline.
   * @param policy - independently selected reviewer and confirmed fallback choice.
   * @returns after admission acknowledgement; failure is published.
   */
  startReview(workspaceId: WorkspaceId, id: ProjectTaskId, policy: ProjectTaskReviewPolicy): Promise<void>
  /** Cancel a pending review without changing the task's execution result.
   * @param workspaceId - project visible when the gesture occurred.
   * @param id - task owning the pending review.
   * @returns after the reviewer stops; failure is published.
   */
  cancelReview(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Explicitly resume knowledge review in the source conversation without rerunning execution.
   * @param workspaceId - task's original project.
   * @param id - completed task whose signed knowledge references need review.
   * @returns after admission acknowledgement; the follow stream owns the review state.
   */
  reviewTaskKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Stop only the current knowledge-review turn, preserving the completed task and its result.
   * @param workspaceId - task's original project.
   * @param id - task with a running knowledge review.
   * @returns after stop acknowledgement; failures remain in the snapshot.
   */
  cancelTaskKnowledgeReview(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void>
  /** Retry a blocked or interrupted discovery without rerunning the Task.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param requestId - stable UUID for this explicit retry.
   * @returns whether the Host acknowledged the same operation; failure remains in the snapshot.
   */
  retryKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Recompare one retained candidate after an explicit human confirmation.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param requestId - stable UUID for this recomparison.
   * @returns whether the Host acknowledged the same operation; failure remains in the snapshot.
   */
  refreshKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Recheck a settled no-change conclusion while preserving the original in history.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param requestId - human gesture UUID, reused on an uncertain response.
   * @returns whether the Host acknowledged the project-qualified operation.
   */
  recheckNoChangeKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Commit a human decision against the exact retained candidate.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param request - candidate digest, operation UUID and reviewed disposition.
   * @returns acknowledgement, a definite source-ID refusal, or false for other uncertainty.
   */
  decideKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgeDecisionRequest): Promise<boolean | 'source-identifiers-missing'>
  /** Read the held draft and active catalog without publishing it.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @returns current draft and catalog; rejects on read failure or withdrawal.
   */
  reviewKnowledgeDraft(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<ProjectTaskKnowledgeDraftReview>
  /** Submit a separately confirmed publication of a held draft.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param request - reviewed draft, catalog versions and operation UUID.
   * @returns whether the Host acknowledged the request; publication remains receipt-driven.
   */
  publishKnowledgeDraft(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgePublishRequest): Promise<boolean>
  /** Retry only a Host-retained pending decision with its original identity.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @returns whether the Host acknowledged the pending operation.
   */
  resumeKnowledgeDecision(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean>
  /** Inspect or retry the Host's exact automatic UUID without a new permission.
   * @param workspaceId - original task project.
   * @param id - completed Task with pending or unknown automatic intent.
   * @returns whether original-project receipt recovery was acknowledged.
   */
  resumeAutomaticKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean>
  /** Recheck an uncertain post-publication catalog without writing again.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @returns whether the Host acknowledged the read-only check.
   */
  reviewKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean>
  /** Read the published page and current catalog before resolving a changed directory.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @returns current page and catalog, or an explicit unknown result; rejects on read failure.
   */
  inspectKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<ProjectTaskKnowledgePublicationInspection>
  /** Record a separate human disposition of the post-publication finding.
   * @param workspaceId - original task project.
   * @param id - retained completed task.
   * @param request - observed versions, choice and stable operation UUID.
   * @returns whether the Host acknowledged the disposition.
   */
  acknowledgeKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgeAcknowledgeRequest): Promise<boolean>
}

const empty = (workspaceId: WorkspaceId | null): TaskSnapshot => ({
  workspaceId, phase: workspaceId === null ? 'idle' : 'loading', tasks: [], error: null, pending: [], dirtyConfirmations: [], commandErrors: {},
})

/** Owns one selected-project generation and joins all withdrawn remote work. */
export class ClientTaskModel implements IProjectTasks {
  readonly state = createSnapshotStore<TaskSnapshot>(empty(null))
  private stream: RemoteStream<readonly ProjectTaskState[]> | undefined
  private readonly commands = new Map<ProjectTaskId, AbortController>()
  private readonly work = new Set<Promise<void>>()
  private disposed = false
  private readonly admission: DirectTaskAdmission<ProjectTaskId>

  /** @param remote - generated task command namespace.
   * @param follow - Gateway-supervised stream factory.
   */
  constructor(private readonly remote: TaskRemote, private readonly follow: TaskFollowFactory) {
    this.admission = new DirectTaskAdmission((...args) => remote.inspectDirectWorkspace(...args), (dirtyConfirmations) => {
      this.publish({ dirtyConfirmations })
    })
  }

  watch(workspaceId: WorkspaceId | null): void {
    if (this.disposed || workspaceId === this.state.getSnapshot().workspaceId) return
    this.replace(workspaceId)
  }

  refresh(): void {
    if (!this.disposed) this.replace(this.state.getSnapshot().workspaceId)
  }

  confirm(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    return this.admit(workspaceId, id, (signal, allowDirty) => this.remote.confirm(workspaceId, id, allowDirty, signal))
  }

  confirmCodex(workspaceId: WorkspaceId, id: ProjectTaskId, selection: ProjectTaskCodexSelection): Promise<void> {
    return this.admit(workspaceId, id, (signal, allowDirty) => this.remote.confirmCodex(workspaceId, id, selection, allowDirty, signal))
  }

  confirmClaude(workspaceId: WorkspaceId, id: ProjectTaskId, selection: ProjectTaskClaudeSelection): Promise<void> {
    return this.admit(workspaceId, id, (signal, allowDirty) => this.remote.confirmClaude(workspaceId, id, selection, allowDirty, signal))
  }

  confirmCoding(workspaceId: WorkspaceId, id: ProjectTaskId, request: ProjectTaskCodingConfirmation): Promise<void> {
    return this.admit(workspaceId, id, (signal, allowDirty) => this.remote.confirmCoding(workspaceId, id, request, allowDirty, signal))
  }

  retryTerminal(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    const task = this.state.getSnapshot().workspaceId === workspaceId
      ? this.state.getSnapshot().tasks.find(value => value.id === id) : undefined
    if (task?.status !== 'opened-terminal' || task.terminal === undefined || task.terminal.phase === 'opened') return Promise.resolve()
    const { phase, selection } = task.terminal
    return this.admit(workspaceId, id, (signal, allowDirty) =>
      this.remote.retryDraftTerminal(workspaceId, id, phase, selection, allowDirty, signal))
  }

  decideDirty(workspaceId: WorkspaceId, id: ProjectTaskId, allow: boolean): void {
    if (this.state.getSnapshot().workspaceId === workspaceId) this.admission.decide(id, allow)
  }

  cancel(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.cancel(workspaceId, id, signal))
  }

  verify(workspaceId: WorkspaceId, id: ProjectTaskId, indices: readonly number[]): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.verify(workspaceId, id, indices, signal))
  }

  startReview(workspaceId: WorkspaceId, id: ProjectTaskId, policy: ProjectTaskReviewPolicy): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.startReview(workspaceId, id, policy, signal))
  }

  cancelReview(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.cancelReview(workspaceId, id, signal))
  }

  reviewTaskKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.reviewTaskKnowledge(workspaceId, id, signal))
  }

  cancelTaskKnowledgeReview(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<void> {
    return this.command(workspaceId, id, signal => this.remote.cancelTaskKnowledgeReview(workspaceId, id, signal))
  }

  retryKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal =>
      this.remote.retryTaskKnowledgeDiscovery(workspaceId, id, requestId, signal))
  }

  refreshKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal =>
      this.remote.refreshTaskKnowledgeDiscovery(workspaceId, id, requestId, signal))
  }

  recheckNoChangeKnowledgeDiscovery(workspaceId: WorkspaceId, id: ProjectTaskId,
    requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal =>
      this.remote.recheckTaskNoChangeKnowledgeDiscovery(workspaceId, id, requestId, signal))
  }

  decideKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgeDecisionRequest): Promise<boolean | 'source-identifiers-missing'> {
    return this.knowledgeCommand(workspaceId, id,
      signal => this.remote.decideTaskKnowledge(workspaceId, id, request, signal),
      error => error.code === 'project-task/rejected'
        && error.details.reason === 'knowledge-source-identifiers-missing' ? 'source-identifiers-missing' : undefined)
  }

  reviewKnowledgeDraft(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<ProjectTaskKnowledgeDraftReview> {
    return this.knowledgeRead(workspaceId, id, signal => this.remote.reviewTaskKnowledgeDraft(workspaceId, id, signal))
  }

  publishKnowledgeDraft(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgePublishRequest): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal => this.remote.publishTaskKnowledgeDraft(workspaceId, id, request, signal))
  }

  resumeKnowledgeDecision(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal => this.remote.resumeTaskKnowledgeDecision(workspaceId, id, signal))
  }

  resumeAutomaticKnowledge(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal => this.remote.resumeTaskAutomaticKnowledge(workspaceId, id, signal))
  }

  reviewKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal => this.remote.reviewTaskKnowledgePublication(workspaceId, id, signal))
  }

  inspectKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId): Promise<ProjectTaskKnowledgePublicationInspection> {
    return this.knowledgeRead(workspaceId, id, signal => this.remote.inspectTaskKnowledgePublication(workspaceId, id, signal))
  }

  acknowledgeKnowledgePublication(workspaceId: WorkspaceId, id: ProjectTaskId,
    request: ProjectTaskKnowledgeAcknowledgeRequest): Promise<boolean> {
    return this.knowledgeCommand(workspaceId, id, signal =>
      this.remote.acknowledgeTaskKnowledgePublication(workspaceId, id, request, signal))
  }

  /** Withdraw subscriptions and gestures, then join their transport completion.
   * @returns when no task operation can publish another snapshot.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stop()
    await Promise.allSettled(this.work)
  }

  private replace(workspaceId: WorkspaceId | null): void {
    this.stop()
    this.state.set(empty(workspaceId))
    if (workspaceId === null) return
    const stream = this.follow(workspaceId)
    this.stream = stream
    void this.track((async () => {
      try {
        for await (const item of stream) {
          if (this.stream !== stream) return
          item.accept()
          this.publish({ tasks: item.value, phase: 'ready', error: null })
        }
      } catch (error) {
        if (this.stream === stream) this.publish({ phase: 'error', error: String(error) })
      }
    })())
  }

  private stop(): void {
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) void this.track(stream.dispose())
    for (const request of this.commands.values()) request.abort()
    this.commands.clear()
  }

  private admit(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal, allowDirty: boolean) => ReturnType<TaskRemote['confirm']>): Promise<void> {
    return this.command(workspaceId, id, async (signal) => {
      const task = this.state.getSnapshot().tasks.find(value => value.id === id)
      if (task === undefined) return undefined
      const preparing = task.status === 'draft' || (task.terminal !== undefined && task.terminal.phase !== 'opened')
      const admission = preparing && task.isolation === 'direct' && task.research === undefined && task.artifact === undefined && task.goal === undefined
        ? await this.admission.check(workspaceId, id, signal) : { allowDirty: false }
      if (admission === undefined) return undefined
      signal.throwIfAborted()
      return invoke(signal, admission.allowDirty)
    })
  }

  private command(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal) => Promise<
      { ok: true; value: unknown } | { ok: false; error: { message: string } } | undefined
    >): Promise<void> {
    if (this.disposed || this.state.getSnapshot().workspaceId !== workspaceId || this.commands.has(id)) return Promise.resolve()
    const request = new AbortController()
    this.commands.set(id, request)
    const errors = Object.fromEntries(Object.entries(this.state.getSnapshot().commandErrors).filter(([key]) => key !== id))
    this.publish({ pending: [...this.commands.keys()], commandErrors: errors })
    return this.track((async () => {
      try {
        const result = await invoke(request.signal)
        if (result === undefined) return
        if (!result.ok) throw new Error(result.error.message)
        // Unary echoes can precede newer stream commits; only the stream publishes records.
      } catch (error) {
        if (!request.signal.aborted) this.publish({ commandErrors: { ...this.state.getSnapshot().commandErrors, [id]: String(error) } })
      } finally {
        if (this.commands.get(id) === request) {
          this.commands.delete(id)
          this.publish({ pending: [...this.commands.keys()] })
        }
      }
    })())
  }

  private knowledgeCommand(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal) => Promise<RemoteResult<unknown> | undefined>): Promise<boolean>
  private knowledgeCommand<Failure extends string>(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal) => Promise<RemoteResult<unknown> | undefined>,
    classify: (error: RemoteFailure) => Failure | undefined): Promise<boolean | Failure>
  private async knowledgeCommand<Failure extends string>(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal) => Promise<RemoteResult<unknown> | undefined>,
    classify?: (error: RemoteFailure) => Failure | undefined): Promise<boolean | Failure> {
    let outcome: boolean | Failure = false
    await this.command(workspaceId, id, async (signal) => {
      const result = await invoke(signal)
      if (result !== undefined && !result.ok) {
        const failure = classify?.(result.error)
        if (failure !== undefined) {
          outcome = failure
          return undefined
        }
      }
      outcome = result?.ok === true && !signal.aborted
      return result
    })
    return outcome
  }

  private async knowledgeRead<T>(workspaceId: WorkspaceId, id: ProjectTaskId,
    invoke: (signal: AbortSignal) => Promise<RemoteResult<T>>): Promise<T> {
    let value: T | undefined
    await this.command(workspaceId, id, async (signal) => {
      const result = await invoke(signal)
      if (result.ok && !signal.aborted) value = result.value
      return result
    })
    if (value === undefined || this.disposed || this.state.getSnapshot().workspaceId !== workspaceId) {
      throw new Error('Task knowledge read is unavailable')
    }
    return value
  }

  private publish(change: Partial<TaskSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...change }) }

  private track(work: Promise<void>): Promise<void> {
    this.work.add(work)
    void work.finally(() => { this.work.delete(work) })
    return work
  }
}
