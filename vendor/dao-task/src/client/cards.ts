/** Conversation-scoped proposal subscriptions and explicit decision commands. */
import { createSnapshotStore, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProjectTaskCardId, ProjectTaskCardState, ProjectTaskId, ProjectTaskKnowledgeDiscoveryRequestId,
  ProjectTaskKnowledgeDecisionRequest, ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgePublishRequest,
  ProjectTaskKnowledgeAcknowledgeRequest, ProjectTaskKnowledgePublicationInspection } from '../types.ts'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectTaskCodexSelection, ProjectTaskClaudeSelection, ProjectTaskCodingConfirmation } from '../types.ts'
import type { TaskSnapshot } from './model.ts'
import type { ClientTaskCollection } from './collection.ts'
import type { TaskAttentionSnapshot } from './attention.ts'
import { DirectTaskAdmission } from './direct-admission.ts'

/** Host decisions and transient command feedback for one source conversation. */
export interface TaskCardSnapshot {
  readonly workspaceId: WorkspaceId | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  /** Cards from project feeds with a current replacement frame; other feeds may still load or fail. */
  readonly cards: readonly ProjectTaskCardState[]
  readonly error: string | null
  readonly pending: readonly ProjectTaskCardId[]
  readonly dirtyConfirmations: readonly ProjectTaskCardId[]
  readonly commandErrors: Readonly<Partial<Record<ProjectTaskCardId, string>>>
}

/** Presentation-independent conversation card source and commands. */
export interface ConversationTaskCards {
  readonly state: ObservableSnapshot<TaskCardSnapshot>
  readonly executions: ObservableSnapshot<readonly TaskSnapshot[]>
  /** Explicitly accept or dismiss retained intent; no automatic retry occurs.
   * @param id - card in this source conversation.
   * @param decision - requested durable decision.
   * @param selection - task-local model on acceptance; omission retries the retained selection.
   * @param coding - explicitly confirmed review, post-step guidance and Task-local Harness preset; omission retries retained choices.
   * @returns after acknowledgement; failures remain in the snapshot.
   */
  decide(id: ProjectTaskCardId, decision: 'accept' | 'dismiss' | 'terminal', selection?: ModelSelection | ProjectTaskCodexSelection | ProjectTaskClaudeSelection, coding?: Pick<ProjectTaskCodingConfirmation, 'review' | 'postSteps' | 'reviewSources' | 'knowledgeMaintenance'> & { readonly execution?: Pick<Extract<ProjectTaskCodingConfirmation['execution'], { runtime: 'harness' }>, 'runtime' | 'agentPreset'> }): Promise<void>
  /** Resolve this card's dirty prompt, or withdraw its unfinished inspection; no choice is retained.
   * @param id - card shown in the confirmation.
   * @param allow - continue this attempt or cancel without accepting.
   */
  decideDirty(id: ProjectTaskCardId, allow: boolean): void
  /** Resolve a retained outcome by explicit gesture; automatic delivery is owned by current selection.
   * @param id - accepted card in this conversation.
   * @param action - follow up, mark viewed, or ignore the retained outcome.
   * @returns whether this still-current command succeeded; errors remain local and retain the pending outcome.
   */
  complete(id: ProjectTaskCardId, action: 'followup' | 'view' | 'ignore'): Promise<boolean>
  /** Explicitly start or stop the retained task's knowledge review; delivery remains independent.
   * @param id - accepted card in this source conversation.
   * @param action - start a review turn or stop only its current turn.
   * @returns whether the current project-qualified command was acknowledged.
   */
  reviewKnowledge(id: ProjectTaskCardId, action: 'start' | 'stop'): Promise<boolean>
  /** Retry a blocked, read-only no-reference discovery; the caller retains the same UUID on uncertain acknowledgement.
   * @param id - accepted card in this source conversation.
   * @param requestId - one explicit user gesture UUID.
   * @returns whether the original project-qualified request was acknowledged.
   */
  retryKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Explicitly recompare the current candidate; settled older decisions and Brain receipts remain in history.
   * @param id - accepted card in this source conversation.
   * @param requestId - new gesture UUID, reused only after uncertain acknowledgement.
   * @returns whether the original project-qualified request was acknowledged.
   */
  refreshKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Recheck an archived no-change conclusion with a separate human gesture UUID.
   * @param id - accepted card in this source conversation.
   * @param requestId - UUID retained for an uncertain response.
   * @returns whether the original project-qualified request was acknowledged.
   */
  recheckNoChangeKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean>
  /** Commit a human disposition of one retained candidate; pending writer intent is resumable by UUID.
   * @param id - accepted completed Task card.
   * @param request - exact candidate and human decision.
   * @returns acknowledgement, an exact source-ID prewrite refusal, or false for an uncertain or other failure.
   */
  decideKnowledge(id: ProjectTaskCardId, request: ProjectTaskKnowledgeDecisionRequest):
  Promise<boolean | 'source-identifiers-missing'>
  /** Read the complete held draft and active catalog before a separate publication gesture.
   * Withdrawal aborts the read; disposal joins its settlement and late bytes are rejected.
   * @param id - accepted completed Task card with a saved held draft.
   * @returns current draft and catalog evidence; failures reject and remain on the card.
   */
  reviewKnowledgeDraft(id: ProjectTaskCardId): Promise<ProjectTaskKnowledgeDraftReview>
  /** Publish one held draft with a separate UUID and displayed versions.
   * @param id - accepted completed Task card.
   * @param request - exact held draft and active catalog confirmation.
   * @returns whether the current project-qualified command was acknowledged.
   */
  publishKnowledgeDraft(id: ProjectTaskCardId, request: ProjectTaskKnowledgePublishRequest): Promise<boolean>
  /** Reconcile only the frozen automatic UUID; never selects a new candidate or permission.
   * @param id - accepted completed Task card.
   * @returns whether the original project-qualified receipt recovery was acknowledged.
   */
  resumeAutomaticKnowledge(id: ProjectTaskCardId): Promise<boolean>
  /** Retry only the exact pending proposal, draft save or publication retained by the Host.
   * @param id - accepted completed Task card.
   * @returns whether an existing decision was acknowledged.
   */
  resumeKnowledgeDecision(id: ProjectTaskCardId): Promise<boolean>
  /** Recheck only an uncertain post-publication catalog; this never repeats the Brain write.
   * @param id - accepted completed Task card with a published receipt.
   * @returns whether the read-only review was acknowledged.
   */
  reviewKnowledgePublication(id: ProjectTaskCardId): Promise<boolean>
  /** Read the current published page and active catalog before a human resolves a changed directory.
   * @param id - accepted completed Task card with a published receipt.
   * @returns stable page and catalog evidence, or explicit unknown.
   */
  inspectKnowledgePublication(id: ProjectTaskCardId): Promise<ProjectTaskKnowledgePublicationInspection>
  /** Retain a person's response to a changed active catalog without silently clearing the required finding.
   * @param id - accepted completed Task card with a required publication review.
   * @param request - independent UUID, observed revisions, choice and note.
   * @returns whether the current project-qualified command was acknowledged.
   */
  acknowledgeKnowledgePublication(id: ProjectTaskCardId, request: ProjectTaskKnowledgeAcknowledgeRequest): Promise<boolean>
  /** Reopen failed proposal and execution streams. */
  refresh(): void
}

/** Session-owned proposal model lookup; root and Session disposal withdraw its work. */
export interface ITaskCards {
  /** Shared passive counts; subscribing never selects a source for automatic completion delivery. */
  readonly attention: ObservableSnapshot<TaskAttentionSnapshot>
  /** Retry the shared attention feed while it has subscribers. */
  refreshAttention(): void
  /** Register the selected project's current conversation for fresh completion delivery, independent of visible tabs.
   * @param workspaceId - selected project, or null for a workspace conversation or withdrawal.
   * @param spaceId - selected logical workspace when the conversation belongs to no project; omission withdraws that source.
   */
  watchActiveProject(workspaceId: WorkspaceId | null, spaceId?: ProjectSpaceId): void
  /** Resolve one stable model without following an unrendered conversation.
   * @param sessionId - materialized conversation identity.
   * @returns its card source and explicit commands.
   */
  forSession(sessionId: SessionId): ConversationTaskCards
}

/** Generated card decisions consumed by the Client model. */
export type TaskCardRemote = Pick<ClientRemote['projectTasks'], 'inspectDirectWorkspace' | 'acceptCard' | 'acceptCodexCard' | 'acceptClaudeCard' | 'acceptCodingCard' | 'acceptTerminalCard' | 'dismissCard' | 'completeCard' | 'reviewTaskKnowledge' | 'cancelTaskKnowledgeReview' | 'retryTaskKnowledgeDiscovery' | 'refreshTaskKnowledgeDiscovery' | 'recheckTaskNoChangeKnowledgeDiscovery' | 'decideTaskKnowledge' | 'reviewTaskKnowledgeDraft' | 'publishTaskKnowledgeDraft' | 'resumeTaskAutomaticKnowledge' | 'resumeTaskKnowledgeDecision' | 'reviewTaskKnowledgePublication' | 'inspectTaskKnowledgePublication' | 'acknowledgeTaskKnowledgePublication'>
/** Gateway-owned reconnecting conversation subscription. */
export type TaskCardFollow = (workspaceId: WorkspaceId, sessionId: SessionId) => RemoteStream<readonly ProjectTaskCardState[]>

const initial = (workspaceId: WorkspaceId | null, projectIds: readonly WorkspaceId[] = []): TaskCardSnapshot => ({ workspaceId,
  phase: projectIds.length === 0 ? 'idle' : 'loading', cards: [], pending: [], dirtyConfirmations: [], error: null, commandErrors: {} })

/** First subscriber opens feeds; the last subscriber withdraws commands and both feeds. */
export class ClientTaskCards implements ConversationTaskCards {
  private readonly store = createSnapshotStore<TaskCardSnapshot>(initial(null))
  readonly state: ObservableSnapshot<TaskCardSnapshot>
  readonly executions: ObservableSnapshot<readonly TaskSnapshot[]>
  private readonly commands = new Map<ProjectTaskCardId, AbortController>()
  private readonly work = new Set<Promise<void>>()
  private streams = new Map<WorkspaceId, RemoteStream<readonly ProjectTaskCardState[]>>()
  private projectIds: readonly WorkspaceId[] = []
  private stopWorkspace: (() => void) | undefined
  private subscriptions = 0
  private disposed = false
  private readonly admission: DirectTaskAdmission<ProjectTaskCardId>

  /** @param sessionId - immutable source conversation.
   * @param workspaces - authoritative membership source.
   * @param remote - generated durable decision commands.
   * @param follow - Gateway-supervised card feed factory.
   * @param tasks - independently owned task projection; never the selected Task page's model.
   */
  constructor(private readonly sessionId: SessionId, private readonly workspaces: WorkspaceSource,
    private readonly remote: TaskCardRemote, private readonly follow: TaskCardFollow, private readonly tasks: ClientTaskCollection) {
    this.admission = new DirectTaskAdmission((...args) => remote.inspectDirectWorkspace(...args), (dirtyConfirmations) => {
      this.store.set({ ...this.store.getSnapshot(), dirtyConfirmations })
    })
    this.executions = tasks.state
    this.state = {
      getSnapshot: () => this.store.getSnapshot(),
      subscribe: (listener) => {
        if (this.disposed) return () => {}
        const off = this.store.subscribe(listener)
        if (++this.subscriptions === 1) {
          const sync = (): void => {
            const state = this.workspaces.getSnapshot()
            const owner = state.items.find(item => item.sessionIds.includes(this.sessionId))
            const space = state.spaces.find(item => owner === undefined
              ? item.looseSessionIds?.includes(this.sessionId) : item.projectIds.includes(owner.workspaceId))
            const ids = state.phase !== 'ready' ? [] : space === undefined ? owner === undefined ? [] : [owner.workspaceId]
              : state.items.filter(item => space.projectIds.includes(item.workspaceId)).map(item => item.workspaceId)
            const id = owner?.workspaceId ?? null
            if (id !== this.store.getSnapshot().workspaceId || ids.length !== this.projectIds.length
              || ids.some((value, index) => value !== this.projectIds[index])) this.replace(id, ids)
          }
          this.stopWorkspace = this.workspaces.subscribe(sync)
          sync()
        }
        let active = true
        return () => {
          if (!active) return
          active = false
          off()
          if (--this.subscriptions === 0) {
            this.stopWorkspace?.()
            this.stopWorkspace = undefined
            this.replace(null, [])
          }
        }
      },
    }
  }

  refresh(): void {
    if (!this.disposed && this.subscriptions > 0) {
      this.tasks.refresh()
      this.replace(this.store.getSnapshot().workspaceId, this.projectIds)
    }
  }

  decide(id: ProjectTaskCardId, decision: 'accept' | 'dismiss' | 'terminal', selection?: ModelSelection | ProjectTaskCodexSelection | ProjectTaskClaudeSelection, coding?: Pick<ProjectTaskCodingConfirmation, 'review' | 'postSteps' | 'reviewSources' | 'knowledgeMaintenance'> & { readonly execution?: Pick<Extract<ProjectTaskCodingConfirmation['execution'], { runtime: 'harness' }>, 'runtime' | 'agentPreset'> }): Promise<void> {
    return this.command(id, async (workspaceId, signal) => {
      if (decision === 'dismiss') return this.remote.dismissCard(workspaceId, id, signal)
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      if (card === undefined) return undefined
      const task = this.executions.getSnapshot().find(value => value.workspaceId === workspaceId)
        ?.tasks.find(value => value.id === card.taskId)
      const preparing = task === undefined || task.status === 'draft' || (task.terminal !== undefined && task.terminal.phase !== 'opened')
      const admission = preparing && card.draft.isolation === 'direct' && card.draft.research === undefined && card.draft.artifact === undefined
        ? await this.admission.check(workspaceId, id, signal) : { allowDirty: false }
      if (admission === undefined) return undefined
      signal.throwIfAborted()
      const { allowDirty } = admission
      if (decision === 'terminal') return this.remote.acceptTerminalCard(workspaceId, id,
        selection !== undefined && 'runtime' in selection ? { runtime: 'claude', selection }
          : selection !== undefined && 'sandbox' in selection ? { runtime: 'codex', selection } : null, allowDirty, signal)
      if (coding !== undefined) return this.remote.acceptCodingCard(workspaceId, id, { ...coding,
        execution: selection !== undefined && 'runtime' in selection ? { runtime: 'claude', selection }
          : selection !== undefined && 'sandbox' in selection ? { runtime: 'codex', selection }
            : { runtime: 'harness', ...(selection === undefined ? {} : { model: selection }),
              ...(coding.execution?.agentPreset === undefined ? {} : { agentPreset: coding.execution.agentPreset }) } }, allowDirty, signal)
      if (selection !== undefined && 'runtime' in selection) return this.remote.acceptClaudeCard(workspaceId, id, selection, allowDirty, signal)
      if (selection !== undefined && 'sandbox' in selection) return this.remote.acceptCodexCard(workspaceId, id, selection, allowDirty, signal)
      return this.remote.acceptCard(workspaceId, id, selection ?? null, allowDirty, signal)
    }).then(() => {})
  }

  decideDirty(id: ProjectTaskCardId, allow: boolean): void { this.admission.decide(id, allow) }

  complete(id: ProjectTaskCardId, action: 'followup' | 'view' | 'ignore'): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => this.remote.completeCard(workspaceId, id, action, signal))
  }

  reviewKnowledge(id: ProjectTaskCardId, action: 'start' | 'stop'): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      if (card?.status !== 'accepted') return Promise.resolve(undefined)
      return action === 'start' ? this.remote.reviewTaskKnowledge(workspaceId, card.taskId, signal)
        : this.remote.cancelTaskKnowledgeReview(workspaceId, card.taskId, signal)
    })
  }

  retryKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      if (card?.status !== 'accepted') return Promise.resolve(undefined)
      return this.remote.retryTaskKnowledgeDiscovery(workspaceId, card.taskId, requestId, signal)
    })
  }

  refreshKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      if (card?.status !== 'accepted') return Promise.resolve(undefined)
      return this.remote.refreshTaskKnowledgeDiscovery(workspaceId, card.taskId, requestId, signal)
    })
  }

  recheckNoChangeKnowledgeDiscovery(id: ProjectTaskCardId, requestId: ProjectTaskKnowledgeDiscoveryRequestId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      if (card?.status !== 'accepted') return Promise.resolve(undefined)
      return this.remote.recheckTaskNoChangeKnowledgeDiscovery(workspaceId, card.taskId, requestId, signal)
    })
  }

  decideKnowledge(id: ProjectTaskCardId, request: ProjectTaskKnowledgeDecisionRequest):
  Promise<boolean | 'source-identifiers-missing'> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.decideTaskKnowledge(workspaceId, card.taskId, request, signal) : Promise.resolve(undefined)
    }, error => error.code === 'project-task/rejected'
      && error.details.reason === 'knowledge-source-identifiers-missing' ? 'source-identifiers-missing' : undefined)
  }

  reviewKnowledgeDraft(id: ProjectTaskCardId): Promise<ProjectTaskKnowledgeDraftReview> {
    return this.readKnowledge(id, (workspaceId, taskId, signal) => this.remote.reviewTaskKnowledgeDraft(workspaceId, taskId, signal))
  }

  private async readKnowledge<T>(id: ProjectTaskCardId,
    read: (workspaceId: WorkspaceId, taskId: ProjectTaskId,
      signal: AbortSignal) => Promise<RemoteResult<T>>): Promise<T> {
    const state = this.store.getSnapshot()
    const card = state.cards.find(value => value.id === id)
    if (this.disposed || card?.status !== 'accepted' || this.commands.has(id)) {
      throw new Error('Task knowledge draft is unavailable')
    }
    const request = new AbortController()
    this.commands.set(id, request)
    const work = this.track(Promise.resolve().then(async () => {
      try {
        request.signal.throwIfAborted()
        const result = await read(card.workspaceId, card.taskId, request.signal)
        request.signal.throwIfAborted()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      } catch (error) {
        if (!request.signal.aborted) this.store.set({ ...this.store.getSnapshot(),
          commandErrors: { ...this.store.getSnapshot().commandErrors, [id]: String(error) } })
        throw error
      } finally {
        if (this.commands.get(id) === request) {
          this.commands.delete(id)
          this.store.set({ ...this.store.getSnapshot(), pending: [...this.commands.keys()] })
        }
      }
    }))
    this.store.set({ ...state, pending: [...this.commands.keys()],
      commandErrors: Object.fromEntries(Object.entries(state.commandErrors).filter(([key]) => key !== id)) })
    return work
  }

  publishKnowledgeDraft(id: ProjectTaskCardId, request: ProjectTaskKnowledgePublishRequest): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.publishTaskKnowledgeDraft(workspaceId, card.taskId, request, signal) : Promise.resolve(undefined)
    })
  }

  resumeKnowledgeDecision(id: ProjectTaskCardId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.resumeTaskKnowledgeDecision(workspaceId, card.taskId, signal) : Promise.resolve(undefined)
    })
  }

  resumeAutomaticKnowledge(id: ProjectTaskCardId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.resumeTaskAutomaticKnowledge(workspaceId, card.taskId, signal) : Promise.resolve(undefined)
    })
  }

  reviewKnowledgePublication(id: ProjectTaskCardId): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.reviewTaskKnowledgePublication(workspaceId, card.taskId, signal) : Promise.resolve(undefined)
    })
  }

  inspectKnowledgePublication(id: ProjectTaskCardId): Promise<ProjectTaskKnowledgePublicationInspection> {
    return this.readKnowledge(id, (workspaceId, taskId, signal) =>
      this.remote.inspectTaskKnowledgePublication(workspaceId, taskId, signal))
  }

  acknowledgeKnowledgePublication(id: ProjectTaskCardId, request: ProjectTaskKnowledgeAcknowledgeRequest): Promise<boolean> {
    return this.command(id, (workspaceId, signal) => {
      const card = this.store.getSnapshot().cards.find(value => value.id === id)
      return card?.status === 'accepted'
        ? this.remote.acknowledgeTaskKnowledgePublication(workspaceId, card.taskId, request, signal) : Promise.resolve(undefined)
    })
  }

  private command(id: ProjectTaskCardId,
    run: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<Awaited<ReturnType<TaskCardRemote['acceptCard']>> | undefined>): Promise<boolean>
  private command<Failure extends string>(id: ProjectTaskCardId,
    run: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<Awaited<ReturnType<TaskCardRemote['acceptCard']>> | undefined>,
    classify: (error: RemoteFailure) => Failure | undefined): Promise<boolean | Failure>
  private command<Failure extends string>(id: ProjectTaskCardId,
    run: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<Awaited<ReturnType<TaskCardRemote['acceptCard']>> | undefined>,
    classify?: (error: RemoteFailure) => Failure | undefined): Promise<boolean | Failure> {
    const state = this.store.getSnapshot()
    const workspaceId = state.cards.find(card => card.id === id)?.workspaceId
    if (this.disposed || workspaceId === undefined || this.commands.has(id)) return Promise.resolve(false)
    const request = new AbortController()
    this.commands.set(id, request)
    this.store.set({ ...state, pending: [...this.commands.keys()],
      commandErrors: Object.fromEntries(Object.entries(state.commandErrors).filter(([key]) => key !== id)) })
    const work = (async () => {
      try {
        const result = await run(workspaceId, request.signal)
        if (result === undefined) return false
        if (!result.ok) {
          const classified = classify?.(result.error)
          if (classified !== undefined) return classified
          throw new Error(result.error.message)
        }
        return !request.signal.aborted
      } catch (error) {
        if (!request.signal.aborted) this.store.set({ ...this.store.getSnapshot(),
          commandErrors: { ...this.store.getSnapshot().commandErrors, [id]: String(error) } })
        return false
      } finally {
        if (this.commands.get(id) === request) {
          this.commands.delete(id)
          this.store.set({ ...this.store.getSnapshot(), pending: [...this.commands.keys()] })
        }
      }
    })()
    void this.track(work.then(() => {}))
    return work
  }

  /** Withdraw feeds and commands, then join their transport settlements.
   * @returns when no operation can publish another snapshot.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopWorkspace?.()
    this.stopWorkspace = undefined
    this.replace(null, [])
    await Promise.allSettled([...this.work, this.tasks.dispose()])
  }

  private replace(workspaceId: WorkspaceId | null, projectIds: readonly WorkspaceId[]): void {
    const previous = this.streams
    const streams = new Map<WorkspaceId, RemoteStream<readonly ProjectTaskCardState[]>>()
    this.streams = streams
    this.projectIds = [...projectIds]
    for (const stream of previous.values()) void this.track(stream.dispose())
    for (const controller of this.commands.values()) controller.abort()
    this.commands.clear()
    this.store.set(initial(workspaceId, projectIds))
    this.tasks.watch(projectIds)
    const frames = new Map<WorkspaceId, readonly ProjectTaskCardState[]>()
    const errors = new Map<WorkspaceId, string>()
    const publish = (): void => {
      if (this.streams !== streams) return
      this.store.set({ ...this.store.getSnapshot(),
        cards: [...frames.values()].flat().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        phase: errors.size > 0 ? 'error' : frames.size === projectIds.length ? 'ready' : 'loading',
        error: errors.values().next().value ?? null })
    }
    for (const id of projectIds) {
      const stream = this.follow(id, this.sessionId)
      streams.set(id, stream)
      void this.track((async () => {
        try {
          for await (const item of stream) {
            if (this.streams !== streams) return
            item.accept()
            frames.set(id, item.value)
            publish()
          }
        } catch (error) {
          frames.delete(id)
          errors.set(id, String(error))
          publish()
        }
      })())
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    trackPending(this.work, work.then(() => {}, () => {}))
    return work
  }
}
