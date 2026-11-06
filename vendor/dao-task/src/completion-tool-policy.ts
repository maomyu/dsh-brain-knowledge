/** Limit a source conversation's task-completion turn to review reads and scoped Brain evidence. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ProjectTaskCardId, ProjectTaskId } from './types.ts'
import type {} from '@deepseek-ai/dsh-tools'

const reviewTools = new Set([
  'read_task', 'read_research_report',
  'complete_task_knowledge_review',
  'brain_read', 'brain_search', 'brain_read_proposals', 'brain_read_health_report', 'brain_append_timeline',
  'read_code_file', 'list_code_dir', 'search_code',
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
  'skill', 'list_skills', 'read_skill', 'read_skill_file',
])

const installed = new WeakSet<Context>()

interface TurnState {
  session: Session
  nextSeq: number
  turn: number | undefined
  admitted: boolean
  claimedTurn: number | undefined
  inputs: Array<{ messageId: MessageId; taskId: ProjectTaskId; cardId?: ProjectTaskCardId }>
}

/** Install a Host-lifetime policy; controller reload cannot expose general write tools mid-review.
 * @param root - shared Host context containing the tool and Agent registries.
 */
export function installCompletionToolPolicy(root: Context): void {
  if (installed.has(root)) return
  installed.add(root)
  root.inject(['tools', 'agents'], (scope: Context) => {
    const agents = new WeakSet(scope.agents.list())
    const turns = new WeakMap<Agent, TurnState>()
    scope.on('agent/created', ({ agent }) => { agents.add(agent) })
    scope.on('agent/disposed', ({ agent }) => { agents.delete(agent); turns.delete(agent) })
    const stateOf = (agent: Agent): TurnState => {
      const session = agent.session
      let state = turns.get(agent)
      if (state === undefined || state.session !== session) {
        state = { session, nextSeq: 0, turn: undefined, admitted: false, claimedTurn: undefined, inputs: [] }
        turns.set(agent, state)
      }
      for (let seq = state.nextSeq; seq < session.seq; seq += 1) {
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const event = session.eventAt(SessionSeq(seq))
        /* v8 ignore if -- Session append and validated replay keep every event contiguous through session.seq. */
        if (event === undefined) throw new Error('Task completion policy found a missing Session event')
        if (event.type === 'turn/start') {
          state.turn = event.data.turn
          state.admitted = false
          state.claimedTurn = undefined
          state.inputs = []
        } else if (event.type === 'turn/end') {
          state.turn = undefined
          state.admitted = false
          state.claimedTurn = undefined
          state.inputs = []
        } else if (state.turn !== undefined && event.type === 'user/message'
          && (event.data.source.kind === 'project-task-completion'
            || event.data.source.kind === 'project-task-knowledge-review')) {
          state.admitted = true
          state.inputs.push({ messageId: event.data.id, taskId: event.data.source.taskId,
            ...(event.data.source.kind === 'project-task-knowledge-review' ? { cardId: event.data.source.cardId } : {}) })
        }
      }
      state.nextSeq = session.seq
      return state
    }
    scope.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (message.source.kind === 'project-task-completion' || message.source.kind === 'project-task-knowledge-review') {
        const state = stateOf(agent)
        state.claimedTurn = turn
        state.inputs.push({ messageId: message.id, taskId: message.source.taskId,
          ...(message.source.kind === 'project-task-knowledge-review' ? { cardId: message.source.cardId } : {}) })
      }
    })
    const reviewing = (agent: Agent): boolean => {
      const state = stateOf(agent)
      return state.turn !== undefined && (state.admitted || state.claimedTurn === state.turn)
    }
    // Durable reviewing cards already require nonempty brainRefs.
    const automaticUpdate = (agent: Agent): boolean => {
      const inputs = stateOf(agent).inputs
      const tasks = scope.get('taskController')
      if (inputs.length === 0 || tasks === undefined) return false
      const registry = scope.get('workspaceRegistry')
      const execution = registry?.conversationExecutionProjects(agent.id)
      // Task card reads are qualified by the source's logical workspace.
      const space = registry?.spaces.find(item => item.spaceId === execution?.spaceId)
      return space?.projectIds.some((projectId) => {
        const cards = tasks.listCards(projectId, agent.id)
        return inputs.every(input => cards.some(card => card.status === 'accepted'
          && card.taskId === input.taskId && (input.cardId === undefined || card.id === input.cardId)
          && card.completion?.status === 'closed-success' && card.completion.knowledgeReview?.status === 'reviewing'
          && card.completion.knowledgeReview.attemptMessageId === input.messageId
          && card.knowledgeMaintenanceAuthorization?.mode === 'automatic'))
      }) === true
    }
    scope.tools.restrictAccess((name, caller) => {
      if (caller === undefined || !agents.has(caller as Agent)) return true
      return !reviewing(caller as Agent) || reviewTools.has(name)
        || name === 'brain_update_truth' && automaticUpdate(caller as Agent)
    })
    scope.tools.forceNativeWhen(caller => caller !== undefined && agents.has(caller as Agent)
      && reviewing(caller as Agent))
    // PTC programs can reach Node APIs without a binding; its reserved transport ignores restrictAccess.
    scope.tools.guard(exec => exec.name === 'run_code' && exec.agent !== undefined
      && reviewing(exec.agent) ? 'Task completion review does not allow code execution.' : undefined)
  })
}
