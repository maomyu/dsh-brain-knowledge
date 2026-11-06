/** Logged Goal-source guidance; worker tools and execution authority remain with their existing owners. */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectGoalState } from './types.ts'

/** Evidence-driven knowledge review for every approved task completion, including coding. */
export const goalKnowledgeReviewInstruction = 'KNOWLEDGE REVIEW: after each completed task, read the signed in-scope Brain pages and assess whether the actual artifacts add durable project knowledge. When the signed plan selects brainRefs, a successful coding Task with changed files requires a complete fixed-commit read with wud_read_task_coding after its latest result input before recording NEXT or DONE; a diff, summary or earlier read does not count. The Host also requires a successful complete read of one signed active decision page after that result input; an earlier or unrelated read and a write alone do not count. RETRY and ESCALATE remain available when review cannot establish acceptance. Use only the dedicated Goal knowledge tools within signed brainRefs and rootPageRefs. Write nothing when there is no knowledge increment; synthetic confirmations, repeated conclusions, dispatches, verdicts, retries and task identifiers alone do not justify a knowledge update. Record a durable project decision with wud_write_decision; use wud_rewrite_truth with a rationale only when a core conclusion changes; update signed root pages at structural milestones, not after every task.'

/** Add changed role guidance to already-admitted source turns, never waking an idle source.
 * @param ctx - controller-owned listener lifetime.
 * @param current - latest Goal for a directly registered source; task workers return null.
 */
export function installGoalMasterContext(ctx: Context, current: (source: SessionId) => ProjectGoalState | null): void {
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    const source = 'project-goal-mode'
    const previous = agent.session.deriveMessages().findLast(message => message.role === 'user'
      && (message.source.kind === source || message.source.kind === 'plugin:project-goal-mode'))
    const state = current(agent.id)
    if ((state === null || state.phase === 'EXITED') && previous === undefined) return decision
    const text = state === null || state.phase === 'EXITED'
      ? 'Goal mode is inactive. Its orchestration role no longer applies. Continue ordinary conversation under existing project permissions; this notice grants no execution or knowledge-write permission.'
      : [
        `Goal mode source context: ${JSON.stringify({ runId: state.id, phase: state.phase,
          ...(state.planHistory === undefined ? {} : { planRequestId: state.plan?.requestId,
            detachedTaskIds: state.planHistory.flatMap(item => item.taskIds) }) })}`,
        state.plan?.input.allowTaskDispatch === false
          ? 'This plan forbids child-task dispatch, including capability research. After user approval, complete the review with master-side read tools and dedicated signed Goal knowledge tools; do not edit project code, create artifacts or delegate through another channel. Record semantic review evidence with wud_record_outcome using taskId=master. Deterministic checks remain host-owned; never claim them. Changing the dispatch scope requires a complete revised plan and fresh user approval.'
          : 'Act as the coordinator, not an implementation worker. Read evidence, plan, dispatch and assess results; do not directly edit project files, produce artifacts or propose patches. Use wud_dispatch_task for research and implementation, never create_task or a separate delegation channel. End your turn after dispatch or verification; completions wake this conversation. Do not poll for progress.',
        'GATHER and PLAN permit investigation and blocking questions, not signed-plan acceptance. SIGNOFF waits for the user decision. RUNNING permits only the signed objective, criteria, scope and model pool. Within-scope user hints may adjust priorities. Changed goals, criteria or scope require wud_submit_plan with the complete revised plan, followed by a fresh user decision; never absorb them silently. Resubmission resets acceptance and detaches earlier tasks without stopping them or resetting cumulative usage. Detached results are context only, never current acceptance or new write authority. PAUSED and ESCALATED wait for user resume. DONE does not authorize more work or publishing.',
        'Judge semantic criteria from actual worker artifacts, not the worker’s success claim. Deterministic check marks belong to the host. Record acceptance before dispatching dependent work. Budget warnings are advisories, not automatic permission to stop or weaken acceptance.',
        'While RUNNING, retain knowledge as a separate, signed responsibility. ' + goalKnowledgeReviewInstruction,
      ].join('\n\n')
    if (previous?.role === 'user' && previous.content.length === 1
      && previous.content[0]?.type === 'text' && previous.content[0].text === text) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: source, form: 'snapshot', sections: [{ name: source, text }] } })] }
  })
}
