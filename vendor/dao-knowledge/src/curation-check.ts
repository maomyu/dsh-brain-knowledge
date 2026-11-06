/** One-pass retention review at the ordinary conversation turn boundary. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { isCurationMessage as isOwnMessage, registerCurationAccess } from './curation-access.ts'

export { hasRetentionAttempt } from './curation-access.ts'

const source = 'project-brain-curation-check'
const instruction = 'Before this turn ends, check whether the user settled reusable project knowledge that was not yet retained. '
  + 'If so, load ingest, check existing Brain knowledge, and use only authorized Brain tools; a reminder is not user approval. '
  + 'Retain newly settled facts and reversals with brain_update_truth, which already records evidence history. Timeline append is only for new supporting evidence that leaves current understanding unchanged or a human-explicit confirmation event; never append a stop, duplicate-correction or no-op review note. '
  + 'Reuse successful complete reads from this turn, including those before ingest. Read each document version once; follow incomplete-read continuations. A search excerpt marked linesTruncated or snippetTruncated, or a controlled duplicate-read refusal, does not invalidate an earlier successful complete read. Treat that refusal as a blocked duplicate request, not an I/O failure; use its original call and version instead of retrying. Read again only when actual complete coverage is missing or a changed content version requires it. '
  + 'If a complete read already covers the settled information and no confirmation event was requested, finish without another read or write. '
  + 'If the discussion is casual, unresolved, duplicate, or the user asked not to remember it, make no write. '
  + 'A new message or another declaration that an existing rule is final is not new evidence; do not append a Timeline entry for that repeated confirmation unless the user explicitly asks to record the confirmation itself as an event. '
  + 'This is a background review. The application hides every Assistant reply from this automatic review and preserves the earlier user-facing answer. Only when you have actually completed the assessment, end with a short internal status stating what happened: supported knowledge was saved, existing knowledge already covers the discussion, or the completed screening found nothing eligible for retention (for example casual or tentative discussion, or an explicit request not to retain it). Do not require an empty response. An unresolved failure is not a completed assessment; preserve the existing error or unfinished handling instead of issuing a completion status. Do not claim a save, a completed assessment or an independent semantic review unless it actually happened. '
  + 'Do not repeat or revise the user-facing answer. The internal status is not a user-visible footer and must not be copied into ordinary replies; keep the user\'s requested visible answer format.'
const manualInstruction = 'The user explicitly requested a new review of this conversation for reusable project knowledge. '
  + 'Check existing Brain knowledge before any write, and use only authorized Brain tools; this request is not approval '
  + 'to publish a draft or replace substantial current understanding. Respect requests not to remember, and leave casual, '
  + 'unresolved, or duplicate discussion unchanged. Do not repeat earlier answers. Report the persisted change, or say '
  + 'that no new knowledge was retained. Do not claim a save that did not succeed.'
const resumeInstruction = 'The user explicitly requested continuation of the already queued knowledge review. '
  + 'Complete that review once; do not repeat earlier answers or claim an unconfirmed save.'

/** Add one logged model-facing review only when an ordinary writable turn omitted retention.
 * @param ctx - curator's scoped Agent event and effective-tool registry.
 * @param maxAutomaticToolCalls - validated attempted-tool allowance; exhausted reviews remain unfinished.
 * @param maxAutomaticReadRecoveries - validated refused-read recovery allowance for one automatic interval.
 */
export function registerCurationCheck(ctx: Context, maxAutomaticToolCalls: number, maxAutomaticReadRecoveries: number): void {
  const current = registerCurationAccess(ctx, maxAutomaticToolCalls, maxAutomaticReadRecoveries)
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted || ctx.tools.get('brain_append_timeline', agent) === undefined) return
    const state = current(agent)
    if (state.turn !== turn || state.workflow || !state.human || state.checked || state.attempted || !state.answered) return
    agent.steer(createUserMessage({ source: { kind: source, form: 'instructions', reviewKind: 'automatic' },
      content: [{ type: 'text', text: instruction }] }))
  })
}

/** Register an explicit human command without replaying a canceled or uncertain check on restart.
 * @param ctx - curator lifetime with optional human-command composition.
 */
export function registerManualCurationCheck(ctx: Context): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'knowledge-check',
      description: 'Review this conversation for reusable knowledge',
      handler: ({ agent, rawInput, signal }) => {
        if (rawInput.trim() !== '') return { kind: 'error', text: '/knowledge-check does not accept arguments.' }
        if (signal.aborted) return { kind: 'error', text: 'Knowledge review was canceled before submission.' }
        if (agent.session.header.origin === 'subagent'
          || commandCtx.tools.get('brain_append_timeline', agent) === undefined) {
          return { kind: 'error', text: 'Knowledge review is unavailable in this conversation.' }
        }
        if (agent.status !== 'idle' || agent.inbox.nextTurn.length > 0) {
          return { kind: 'error', text: 'Wait until the current conversation work finishes, then request a knowledge review.' }
        }
        const pending = agent.inbox.nextStep
        if (pending.some(message => !isOwnMessage(message)) || pending.length > 1) {
          return { kind: 'error', text: 'Pending conversation input must settle before a knowledge review can start.' }
        }
        const queued = pending[0]
        const content = [...queued?.content ?? [],
          { type: 'text' as const, text: pending.length === 1 ? resumeInstruction : manualInstruction }]
        const message = createUserMessage({ source: { kind: source, form: 'instructions', reviewKind: 'manual' }, content })
        if (queued !== undefined) {
          agent.inbox.remove(queued.id)
          agent.steer(message)
        } else agent.followup(message)
        return { kind: 'success', text: pending.length === 1
          ? 'Queued knowledge review resumed by your request. No knowledge has been saved yet.'
          : 'New knowledge review requested. No knowledge has been saved yet.' }
      },
    })
  })
}
