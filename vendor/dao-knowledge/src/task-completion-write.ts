/** Identify the admitted task-completion inputs in the currently executing conversation turn. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { successfulTaskRead } from '@deepseek-ai/dsh-api-task-controller'
import type { ProjectTaskCardState, ProjectTaskId, ProjectTaskCardId } from '@deepseek-ai/dsh-api-task-controller/types'

/** A Host-authored completion input, identified independently of its untrusted text. */
export interface ActiveTaskCompletion {
  readonly messageId: MessageId
  readonly taskId: ProjectTaskId
  readonly kind: 'project-task-completion' | 'project-task-knowledge-review'
  readonly cardId?: ProjectTaskCardId | undefined
}

/** Read only completion inputs admitted since the latest unfinished turn started.
 * @param session - live source conversation with durable turn and user-message events.
 * @returns current completion identities, or undefined outside a completion turn.
 */
export function activeTaskCompletions(session: Session): readonly ActiveTaskCompletion[] | undefined {
  let current: ActiveTaskCompletion[] | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') current = []
    else if (event.type === 'turn/end') current = undefined
    else if (event.type === 'user/message' && (event.data.source.kind === 'project-task-completion'
      || event.data.source.kind === 'project-task-knowledge-review') && current !== undefined) {
      current.push({ messageId: event.data.id, taskId: event.data.source.taskId,
        kind: event.data.source.kind,
        ...(event.data.source.kind === 'project-task-knowledge-review' ? { cardId: event.data.source.cardId } : {}) })
    }
  }
  return current?.length ? current : undefined
}

/** Match one current completion to its original accepted card in the selected project.
 * @param cards - Host-owned cards for this source conversation and project.
 * @param completions - admitted completion identities in this turn.
 * @returns matching completed cards; another project's completion grants no write in this project.
 */
function matchesCard(card: ProjectTaskCardState, completion: ActiveTaskCompletion): boolean {
  if (card.status !== 'accepted' || card.completion === undefined || completion.taskId !== card.taskId) return false
  const review = card.completion.knowledgeReview
  if (completion.kind === 'project-task-completion') return review === undefined
    || (review.status === 'reviewing' && review.attemptMessageId === completion.messageId)
  return completion.cardId === card.id && review?.status === 'reviewing'
    && review.attemptMessageId === completion.messageId
}

/** Select accepted cards owned by the completion inputs admitted in this turn.
 * @param cards - retained cards for the selected project.
 * @param completions - Host-authored completion identities in the current turn.
 * @returns cards whose task and completion or review identity match an admitted input.
 */
export function taskCompletionCards(cards: readonly ProjectTaskCardState[],
  completions: readonly ActiveTaskCompletion[]): readonly ProjectTaskCardState[] {
  return cards.filter(card => completions.some(completion => matchesCard(card, completion)))
}

/** Require frozen automatic permission for every successful selected-page completion in this source turn.
 * @param cards - original-project cards matched against the admitted completion identities.
 * @param completions - Host-authored inputs in the currently executing source turn.
 * @returns whether independently reviewed truth updates may supplement the Task's separate generation trace.
 */
export function automaticTaskCompletion(cards: readonly ProjectTaskCardState[],
  completions: readonly ActiveTaskCompletion[]): boolean {
  return cards.length > 0 && completions.every(completion => cards.some(card => matchesCard(card, completion)))
    && cards.every(card => card.status === 'accepted' && card.completion?.status === 'closed-success'
      && card.knowledgeMaintenanceAuthorization?.mode === 'automatic' && (card.draft.brainRefs?.length ?? 0) > 0)
}

/** Require each coding completion that owns this project write to have read its exact retained Task in this turn.
 * @param session - live source conversation with paired tool calls and results.
 * @param cards - admitted completed cards for the selected project.
 * @param completions - Host-authored inputs admitted in the live turn.
 * @returns whether every coding card has a complete successful Task read; research and documentation use their own evidence.
 */
export function codingTaskReadsComplete(session: Session, cards: readonly ProjectTaskCardState[],
  completions: readonly ActiveTaskCompletion[]): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  return cards.every(card => card.status === 'accepted' && (card.draft.research !== undefined
    || card.draft.artifact !== undefined || completions.some(completion => matchesCard(card, completion)
      && successfulTaskRead(events, completion.messageId, card.taskId, card.workspaceId))))
}

/** Compare exact completion-message identities when publication resumes after asynchronous work.
 * @param first - completion inputs captured at write admission.
 * @param current - completion inputs in the live turn.
 * @returns whether the same admitted inputs still own the writer.
 */
export function sameTaskCompletions(first: readonly ActiveTaskCompletion[] | undefined,
  current: readonly ActiveTaskCompletion[] | undefined): boolean {
  return JSON.stringify(first) === JSON.stringify(current)
}
