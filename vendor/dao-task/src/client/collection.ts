/** Workspace task browsing reuses independently followed project models. */
import { createSnapshotStore, retainedEntries, retireEntries, trackPending, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ClientTaskModel, IProjectTasks, TaskSnapshot } from './model.ts'

/** Project-qualified task commands over the currently followed project set. */
export interface IProjectTaskCollection extends Pick<IProjectTasks, 'confirm' | 'confirmCodex' | 'confirmClaude' | 'confirmCoding' | 'retryTerminal' | 'decideDirty' | 'cancel' | 'verify' | 'startReview' | 'cancelReview' | 'reviewTaskKnowledge' | 'cancelTaskKnowledgeReview' | 'retryKnowledgeDiscovery' | 'refreshKnowledgeDiscovery' | 'recheckNoChangeKnowledgeDiscovery' | 'decideKnowledge' | 'reviewKnowledgeDraft' | 'publishKnowledgeDraft' | 'resumeKnowledgeDecision' | 'resumeAutomaticKnowledge' | 'reviewKnowledgePublication' | 'inspectKnowledgePublication' | 'acknowledgeKnowledgePublication'> {
  readonly state: ObservableSnapshot<readonly TaskSnapshot[]>
  /** Follow the supplied projects, retaining unchanged subscriptions and withdrawing removed commands.
   * @param workspaceIds - ordered project identities; an empty array releases all projects.
   */
  watch(workspaceIds: readonly WorkspaceId[]): void
  /** Reopen all currently followed project streams. */
  refresh(): void
}

/** Owns project subscriptions and joins removed models before disposal completes. */
export class ClientTaskCollection implements IProjectTaskCollection {
  readonly state = createSnapshotStore<readonly TaskSnapshot[]>([])
  private entries = new Map<WorkspaceId, { model: ClientTaskModel; unsubscribe: () => void }>()
  private readonly retiring = new Set<Promise<void>>()
  private disposed = false

  /** @param create - allocates an independently owned project model without starting a stream. */
  constructor(private readonly create: () => ClientTaskModel) {}

  watch(workspaceIds: readonly WorkspaceId[]): void {
    if (this.disposed) return
    const previous = this.entries
    this.entries = retainedEntries(workspaceIds, previous, (id) => {
      const model = this.create()
      model.watch(id)
      return { model, unsubscribe: model.state.subscribe(() => { this.publish() }) }
    })
    if (this.entries === previous) return
    for (const [id, entry] of previous) {
      if (!this.entries.has(id)) this.retire(entry)
    }
    this.publish()
  }

  refresh(): void {
    if (!this.disposed) for (const { model } of this.entries.values()) model.refresh()
  }

  /** @param args - Originating project and stored draft identity. */
  confirm(...args: Parameters<IProjectTasks['confirm']>): Promise<void> {
    return this.entries.get(args[0])?.model.confirm(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, draft and explicit Codex selection. */
  confirmCodex(...args: Parameters<IProjectTasks['confirmCodex']>): Promise<void> {
    return this.entries.get(args[0])?.model.confirmCodex(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, draft and explicit Claude selection. */
  confirmClaude(...args: Parameters<IProjectTasks['confirmClaude']>): Promise<void> {
    return this.entries.get(args[0])?.model.confirmClaude(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, draft and confirmed automatic-review authority. */
  confirmCoding(...args: Parameters<IProjectTasks['confirmCoding']>): Promise<void> {
    return this.entries.get(args[0])?.model.confirmCoding(...args) ?? Promise.resolve()
  }

  /** @param args - Original project and retained uncertain Terminal Task. */
  retryTerminal(...args: Parameters<IProjectTasks['retryTerminal']>): Promise<void> {
    return this.entries.get(args[0])?.model.retryTerminal(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, task and this attempt's explicit dirty choice. */
  decideDirty(...args: Parameters<IProjectTasks['decideDirty']>): void {
    this.entries.get(args[0])?.model.decideDirty(...args)
  }

  /** @param args - Originating project and execution identity. */
  cancel(...args: Parameters<IProjectTasks['cancel']>): Promise<void> {
    return this.entries.get(args[0])?.model.cancel(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, task identity and human-checked indices. */
  verify(...args: Parameters<IProjectTasks['verify']>): Promise<void> {
    return this.entries.get(args[0])?.model.verify(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project, task identity and reviewer selection. */
  startReview(...args: Parameters<IProjectTasks['startReview']>): Promise<void> {
    return this.entries.get(args[0])?.model.startReview(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project and task owning the pending review. */
  cancelReview(...args: Parameters<IProjectTasks['cancelReview']>): Promise<void> {
    return this.entries.get(args[0])?.model.cancelReview(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project and task requiring explicit knowledge review. */
  reviewTaskKnowledge(...args: Parameters<IProjectTasks['reviewTaskKnowledge']>): Promise<void> {
    return this.entries.get(args[0])?.model.reviewTaskKnowledge(...args) ?? Promise.resolve()
  }

  /** @param args - Originating project and currently reviewing task. */
  cancelTaskKnowledgeReview(...args: Parameters<IProjectTasks['cancelTaskKnowledgeReview']>): Promise<void> {
    return this.entries.get(args[0])?.model.cancelTaskKnowledgeReview(...args) ?? Promise.resolve()
  }

  /** @param args - Original project, completed Task and stable discovery request identity. */
  retryKnowledgeDiscovery(...args: Parameters<IProjectTasks['retryKnowledgeDiscovery']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.retryKnowledgeDiscovery(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project, completed Task and stable recomparison request identity. */
  refreshKnowledgeDiscovery(...args: Parameters<IProjectTasks['refreshKnowledgeDiscovery']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.refreshKnowledgeDiscovery(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project, completed Task and stable no-change recheck identity. */
  recheckNoChangeKnowledgeDiscovery(...args: Parameters<IProjectTasks['recheckNoChangeKnowledgeDiscovery']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.recheckNoChangeKnowledgeDiscovery(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project, completed Task and exact human disposition. */
  decideKnowledge(...args: Parameters<IProjectTasks['decideKnowledge']>): ReturnType<IProjectTasks['decideKnowledge']> {
    return this.entries.get(args[0])?.model.decideKnowledge(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project and completed Task with a held draft. */
  reviewKnowledgeDraft(...args: Parameters<IProjectTasks['reviewKnowledgeDraft']>): ReturnType<IProjectTasks['reviewKnowledgeDraft']> {
    return this.entries.get(args[0])?.model.reviewKnowledgeDraft(...args)
      ?? Promise.reject(new Error('Task knowledge draft is unavailable'))
  }

  /** @param args - Original project, completed Task and separately confirmed publication. */
  publishKnowledgeDraft(...args: Parameters<IProjectTasks['publishKnowledgeDraft']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.publishKnowledgeDraft(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project and completed Task with a retained pending write. */
  resumeKnowledgeDecision(...args: Parameters<IProjectTasks['resumeKnowledgeDecision']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.resumeKnowledgeDecision(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project and completed Task with the exact automatic UUID. */
  resumeAutomaticKnowledge(...args: Parameters<IProjectTasks['resumeAutomaticKnowledge']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.resumeAutomaticKnowledge(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project and completed Task with an uncertain publication review. */
  reviewKnowledgePublication(...args: Parameters<IProjectTasks['reviewKnowledgePublication']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.reviewKnowledgePublication(...args) ?? Promise.resolve(false)
  }

  /** @param args - Original project and completed Task with a changed published catalog. */
  inspectKnowledgePublication(...args: Parameters<IProjectTasks['inspectKnowledgePublication']>): ReturnType<IProjectTasks['inspectKnowledgePublication']> {
    return this.entries.get(args[0])?.model.inspectKnowledgePublication(...args)
      ?? Promise.reject(new Error('Task knowledge publication is unavailable'))
  }

  /** @param args - Original project, completed Task and version-bound human disposition. */
  acknowledgeKnowledgePublication(...args: Parameters<IProjectTasks['acknowledgeKnowledgePublication']>): Promise<boolean> {
    return this.entries.get(args[0])?.model.acknowledgeKnowledgePublication(...args) ?? Promise.resolve(false)
  }

  /** Withdraw every subscription and command, including previously removed projects.
   * @returns when no owned model can publish or retain remote work.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    retireEntries(this.entries, (entry) => { this.retire(entry) })
    await Promise.allSettled(this.retiring)
  }

  private retire(entry: { model: ClientTaskModel; unsubscribe: () => void }): void {
    entry.unsubscribe()
    const done = entry.model.dispose()
    void trackPending(this.retiring, done)
  }

  private publish(): void {
    this.state.set([...this.entries.values()].map(entry => entry.model.state.getSnapshot()))
  }
}
