/** Restrict automatic conversation maintenance without changing ordinary or human-requested work. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from './types.ts'
import { applyCurationProgress, curationProgressRefusal, curationProgressSchema, emptyCurationProgress,
  type CurationProgress } from './curation-progress.ts'

interface AutomaticReviewState {
  readonly turn: number | null
  readonly active: boolean
  readonly human: boolean
  readonly workflow: boolean
  readonly checked: boolean
  readonly attempted: boolean
  readonly answered: boolean
  readonly workInStep: boolean
  readonly requestAutomatic: boolean
  readonly progress: CurationProgress
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Current-turn automatic-review execution policy, reconstructed before resumed requests. */
    knowledgeAutomaticReview: AutomaticReviewState
  }
}

const capabilities = new Set([
  'brain_read', 'brain_search', 'brain_read_proposals', 'brain_read_health_report',
  'brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page',
  'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_merge_pages',
  'brain_normalize_page_format', 'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex',
  'brain_mark_health_finding', 'skill',
])
const skillProviders = new Map([['ingest', 'project-brain-curator'], ['page-management', 'project-brain']])
const brainWrites = new Set([...capabilities].filter(name => name !== 'skill' && ![
  'brain_read', 'brain_search', 'brain_read_proposals', 'brain_read_health_report',
].includes(name)))

/** Recognize review instructions without assigning automatic authority to historical records.
 * @param message - a message with its recorded producer.
 * @returns whether the message belongs to the conversation-review producer.
 */
export function isCurationMessage(message: { source: { kind: string } }): boolean {
  return message.source.kind === 'project-brain-curation-check' || message.source.kind === 'plugin:project-brain-curation-check'
}

function workflowInput(kind: string): boolean {
  return kind === 'knowledge-import' || kind === 'goal' || kind === 'tool-goal' || kind === 'brain-maintenance'
    || kind.startsWith('project-task') || kind.startsWith('project-goal')
    || kind.startsWith('plugin:project-task-') || kind.startsWith('plugin:project-goal-')
}

/** Identify admitted human/workflow/manual work that supersedes automatic continuation.
 * @param message - source-attributed admitted input.
 * @returns whether automatic review restrictions no longer own this step.
 */
export function startsConversationWork(message: UserMessage): boolean {
  return message.source.kind === 'user' || workflowInput(message.source.kind)
    || isCurationMessage(message) && (message.source.kind !== 'project-brain-curation-check'
      || message.source.reviewKind !== 'automatic')
}

function calledIngest(argumentsValue: unknown): boolean {
  let parsed = argumentsValue
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch {
      // Malformed model JSON does not identify an ingest invocation.
      return false
    }
  }
  return typeof parsed === 'object' && parsed !== null && 'name' in parsed && parsed.name === 'ingest'
}

/** Detect native and PTC retention attempts without claiming that a write succeeded.
 * @param events - durable events from the current turn only.
 * @returns whether a call attempted ingest or a Brain write.
 */
export function hasRetentionAttempt(events: readonly SessionEvent[]): boolean {
  return events.some(event => (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
    || event.type === 'tool/ptc-dispatch') && (brainWrites.has(event.data.name)
      || event.data.name === 'skill' && calledIngest(event.data.arguments)))
}

function reviewMode(active: boolean, messages: readonly UserMessage[]): boolean {
  if (messages.some(startsConversationWork)) return false
  for (const message of messages) {
    if (message.source.kind === 'project-brain-curation-check') {
      active = message.source.reviewKind === 'automatic'
    }
  }
  return active
}

function emptyReview(requestAutomatic = false): AutomaticReviewState {
  return { turn: null, active: false, human: false, workflow: false, checked: false, attempted: false,
    answered: false, workInStep: false, requestAutomatic, progress: emptyCurationProgress() }
}

const reviewProjection = {
  key: 'knowledgeAutomaticReview', stateVersion: 4,
  stateSchema: z.object({ turn: z.number().nullable(), active: z.boolean(), human: z.boolean(),
    workflow: z.boolean(), checked: z.boolean(), attempted: z.boolean(), answered: z.boolean(), workInStep: z.boolean(),
    requestAutomatic: z.boolean(), progress: curationProgressSchema }),
  init: (): AutomaticReviewState => emptyReview(),
  apply(state, event) {
    if (event.type === 'turn/start') return { ...emptyReview(state.requestAutomatic), turn: event.data.turn }
    if (event.type === 'turn/end') return emptyReview(state.requestAutomatic)
    if (state.turn === null) return state
    state = { ...state, progress: applyCurationProgress(state.progress, event, state.active) }
    if (event.type === 'request/header') return { ...state, requestAutomatic: state.active }
    if (event.type === 'step/start') return { ...state, workInStep: false }
    if (event.type === 'user/message') return { ...state,
      active: !state.workInStep && reviewMode(state.active, [event.data]),
      workInStep: state.workInStep || startsConversationWork(event.data),
      human: state.human || event.data.source.kind === 'user', workflow: state.workflow || workflowInput(event.data.source.kind),
      checked: state.checked || isCurationMessage(event.data) }
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(isCurationMessage)) return { ...state, checked: true }
    if (hasRetentionAttempt([event])) return { ...state, attempted: true }
    if (event.type === 'assistant/attempt') return { ...state, answered: false }
    if (event.type === 'assistant/message') return { ...state, answered: event.data.stream.some(record => record.type === 'chunk'
      && record.chunk.type === 'finish' && record.chunk.reason.kind === 'stop') }
    return state
  },
} satisfies ProjectionDefinition<'knowledgeAutomaticReview'>

function requestedSkill(args: unknown): string | undefined {
  return typeof args === 'object' && args !== null && 'name' in args && typeof args.name === 'string'
    ? args.name : undefined
}

/** Restrict automatic review execution and start a declaration series when entering or leaving its native tools.
 * The last committed request mode survives turn closure so later ordinary and manual requests restore their tool baseline.
 * An automatic request also replaces a historical baseline without an immediately available permitted tool.
 * @param ctx - curator lifetime with live Agents, tools, and the skill registry.
 * @param maxAutomaticToolCalls - validated maximum attempted tools in one automatic interval.
 * @param maxAutomaticReadRecoveries - validated nonterminal refused-read allowance for the same interval.
 * @returns current-turn review state reconstructed by the registered projection.
 */
export function registerCurationAccess(ctx: Context, maxAutomaticToolCalls: number,
  maxAutomaticReadRecoveries: number): (agent: Agent) => AutomaticReviewState {
  if (ctx.get('sessionProjections') === undefined) throw new Error('Automatic knowledge review requires sessionProjections.')
  ctx.sessionProjections.register(reviewProjection)
  const current = (agent: Agent): AutomaticReviewState => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'knowledgeAutomaticReview')
    /* v8 ignore if -- Registered before current; the owning scope's required injection rejects calls after withdrawal. */
    if (state === undefined) throw new Error('Automatic knowledge review projection is unavailable.')
    return state
  }
  const claimed = new WeakMap<Agent, { turn: number; messages: UserMessage[] }>()
  const admitted = new WeakMap<Agent, { turn: number; active: boolean }>()
  const checkedSkills = new WeakSet<ToolExecution>()
  const active = (agent: Agent): boolean => {
    const state = current(agent)
    if (state.turn === null) return false
    const pending = claimed.get(agent)
    if (pending?.turn === state.turn) return reviewMode(state.active, pending.messages)
    const accepted = admitted.get(agent)
    return accepted?.turn === state.turn ? accepted.active : state.active
  }
  const agentFor = (scope: object | undefined): Agent | undefined =>
    scope === undefined ? undefined : ctx.agents.list().find(agent => agent === scope)
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const pending = claimed.get(agent)
    if (pending?.turn === turn) pending.messages.push(message)
    else claimed.set(agent, { turn, messages: [message] })
  })
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    const state = current(agent)
    const automatic = decision.kind === 'enter' && reviewMode(state.turn === turn && state.active, decision.messages)
    if (automatic && (state.progress.stopReason !== null
      || state.progress.calls.filter(call => call.automatic).length >= maxAutomaticToolCalls)) {
      agent.cancel({ kind: 'hook', reason: state.progress.stopReason
        ?? 'Automatic knowledge review reached its configured tool allowance; review remains unfinished.' })
      return { kind: 'reject' }
    }
    admitted.set(agent, { turn, active: automatic })
    claimed.delete(agent)
    const reset = automatic !== state.requestAutomatic || automatic && !agent.session.toolHistory().tools.some(tool =>
      tool.deferLoading !== true && capabilities.has(tool.name) && ctx.tools.get(tool.name, agent) !== undefined)
    return decision.kind === 'enter' && reset
      ? { ...decision, startsRequestSeries: true } : decision
  }, true)
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') {
      claimed.delete(agent)
      admitted.delete(agent)
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' && event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent?.session === session) admitted.delete(agent)
  })
  ctx.tools.forceNativeWhen((scope) => {
    const agent = agentFor(scope)
    return agent !== undefined && active(agent)
  })
  ctx.tools.restrictAccess((name, scope) => {
    const agent = agentFor(scope)
    return agent === undefined || !active(agent) || capabilities.has(name)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined || !active(exec.agent) || exec.name !== 'skill') return next()
    const name = requestedSkill(exec.arguments)
    const provider = name === undefined ? undefined : skillProviders.get(name)
    if (provider === undefined || name === undefined) return next()
    const definition = await ctx.skills.get(name, { cwd: exec.agent.session.workingDirectory(),
      scope: exec.agent, signal: exec.signal })
    if (definition?.source === 'bundled' && definition.provider === provider) checkedSkills.add(exec)
    return next()
  })
  ctx.tools.guard((exec) => {
    if (exec.agent === undefined || !active(exec.agent)) return undefined
    const refusal = curationProgressRefusal(current(exec.agent).progress, exec.callId,
      maxAutomaticToolCalls, maxAutomaticReadRecoveries)
    if (refusal !== undefined) return refusal
    if (!capabilities.has(exec.name)) return 'Automatic knowledge review only permits Brain maintenance tools.'
    if (exec.name === 'skill' && !checkedSkills.has(exec)) {
      return 'Automatic knowledge review only permits the bundled ingest and page-management skills.'
    }
    return undefined
  })
  return current
}
