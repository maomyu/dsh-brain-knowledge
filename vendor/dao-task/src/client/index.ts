/** Install the React-free task projection over the generated Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { ClientTaskModel } from './model.ts'
import { ClientTaskCollection, type IProjectTaskCollection } from './collection.ts'
import { ClientTaskCards, type ITaskCards } from './cards.ts'
import { ClientTaskActivity } from './activity.ts'
import { ClientTaskAttention } from './attention.ts'
import { ClientGoalActivity } from './goal-activity.ts'
import { ClientGoalReview, type IProjectGoals } from './goals.ts'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'

export type { IProjectTasks, TaskSnapshot } from './model.ts'
export type { IProjectTaskCollection } from './collection.ts'
export type { ITaskCards, ConversationTaskCards, TaskCardSnapshot } from './cards.ts'
export type { TaskAttentionSnapshot } from './attention.ts'
export type { IProjectGoals, ConversationGoalReview, GoalReviewSnapshot, GoalReviewDecision } from './goals.ts'
export type * from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project-qualified commands and stream-derived task records. */
    projectTasks: IProjectTaskCollection
    /** Allocate an independent project task subscription; the caller must dispose it. */
    projectTaskClients: () => ClientTaskModel
    /** Lazy conversation-scoped proposal models, separate from the Task page selection. */
    taskCards: ITaskCards
    /** Session-owned live Goal review and explicit decisions. */
    projectGoals: IProjectGoals
  }
}

/** Generated namespace required by the task Client model. */
export const inject = ['remote', 'remote.projectTasks', 'sessions', 'workspaces']

/** @param ctx - Client root with the task Remote contribution. */
export function apply(ctx: Context): void {
  const createTasks = (): ClientTaskModel => new ClientTaskModel(ctx.remote.projectTasks, workspaceId => ctx.remote.$stream({
    name: 'Project task stream', open: signal => ctx.remote.projectTasks.follow(workspaceId, signal),
    ended: () => new RemoteStreamCarrierError('Task stream ended without cancellation'),
  }))
  const model = new ClientTaskCollection(createTasks)
  const attention = new ClientTaskAttention(() => ctx.remote.$stream({ name: 'Task conversation attention',
    open: signal => ctx.remote.projectTasks.followTaskAttention(signal),
    ended: () => new RemoteStreamCarrierError('Task attention stream ended without cancellation'),
  }))
  const pickerClients = new Set<ClientTaskModel>()
  const unprovideClients = ctx.reflect.provide('projectTaskClients', () => {
    const client = createTasks()
    pickerClients.add(client)
    const dispose = client.dispose.bind(client)
    client.dispose = async () => { await dispose(); pickerClients.delete(client) }
    return client
  })
  const goalActivity = new ClientGoalActivity(id => ctx.remote.$stream({ name: 'Selected Goal project',
    open: signal => ctx.remote.projectTasks.followGoalProject(id, signal),
    ended: () => new Error('Goal project registration ended'),
  }), (error) => { ctx.logger.error('Goal project registration failed; results remain pending', error) })
  const activity = new ClientTaskActivity(ctx.sessions, ctx.workspaces.list,
    (workspaceId, sessionId) => ctx.remote.$stream({ name: 'Selected task source',
      open: signal => ctx.remote.projectTasks.followActiveSource(workspaceId, sessionId, signal),
      ended: () => new Error('Selected task source registration ended'),
    }), (error) => { ctx.logger.error('Task source registration failed; outcomes require explicit review', error) })
  const byBinding = new WeakMap<SessionBinding, ClientTaskCards>()
  const active = new Set<ClientTaskCards>()
  const goalBindings = new WeakMap<SessionBinding, ClientGoalReview>()
  const activeGoals = new Set<ClientGoalReview>()
  const goals: IProjectGoals = { forSession: (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('Goal review requires a materialized conversation')
    const found = goalBindings.get(binding)
    if (found !== undefined) return found
    const source = new ClientGoalReview(sessionId, ctx.workspaces.list, ctx.remote.projectTasks,
      (workspaceId, id) => ctx.remote.$stream({ name: 'Conversation goal',
        open: signal => ctx.remote.projectTasks.followGoal(workspaceId, id, signal),
        ended: () => new RemoteStreamCarrierError('Goal stream ended without cancellation'),
      }))
    goalBindings.set(binding, source)
    activeGoals.add(source)
    binding.ctx.effect(() => async () => { await source.dispose(); activeGoals.delete(source) }, 'goal review: Session lifetime')
    return source
  } }
  const cards: ITaskCards = {
    attention: attention.state, refreshAttention: () => { attention.refresh() },
    watchActiveProject: (id, spaceId) => { activity.watch(id, spaceId); goalActivity.watch(id) }, forSession: (sessionId) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error('Task cards require a materialized conversation')
      const found = byBinding.get(binding)
      if (found !== undefined) return found
      const source = new ClientTaskCards(sessionId, ctx.workspaces.list, ctx.remote.projectTasks,
        (workspaceId, id) => ctx.remote.$stream({ name: 'Conversation task proposals',
          open: signal => ctx.remote.projectTasks.followCards(workspaceId, id, signal),
          ended: () => new RemoteStreamCarrierError('Task card stream ended without cancellation'),
        }), new ClientTaskCollection(createTasks))
      byBinding.set(binding, source)
      active.add(source)
      binding.ctx.effect(() => async () => { await source.dispose(); active.delete(source) }, 'task cards: Session lifetime')
      return source
    } }
  const unprovide = ctx.reflect.provide('projectTasks', model)
  const unprovideCards = ctx.reflect.provide('taskCards', cards)
  const unprovideGoals = ctx.reflect.provide('projectGoals', goals)
  ctx.effect(() => async () => {
    await Promise.all([attention.dispose(), activity.dispose(), goalActivity.dispose(), model.dispose(),
      ...[...active].map(source => source.dispose()),
      ...[...activeGoals].map(source => source.dispose()), ...[...pickerClients].map(source => source.dispose())])
    await unprovideClients()
    await unprovideGoals()
    await unprovideCards()
    await unprovide()
  }, 'task-controller: client lifetime')
}
