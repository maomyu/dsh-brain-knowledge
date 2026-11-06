/** Execution-local review tools share task authority and complete results across Harness and native transports. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { NativeTaskTools, NativeTaskToolResult } from '@deepseek-ai/dsh-subagent/native-tools'
import { z } from 'zod'
import { TaskReviewRequestError, type TaskReviewScope } from './task-review.ts'
import type { ProjectTaskReviewCall, ProjectTaskReviewTicket } from './types.ts'

const reviewStartInstruction = 'Before reporting this coding task complete, use review_start to review the tracked changes, then review_poll with its ticket until the review settles. '
const reviewEvidenceInstruction = 'Review findings are assessments, not proof that tests ran or acceptance criteria passed. Do not start another task or review from a reviewer.'

/** Stable instructions for executions without a separately confirmed post-step policy. */
export const taskReviewInstruction = reviewStartInstruction
  + 'A pending response is not a verdict. Address concrete findings within the task permissions and use another review only when necessary and within the remaining call allowance. '
  + reviewEvidenceInstruction

/** Compose reviewer guidance without granting the executor new repair or tool permissions.
 * @param autoFix - whether review findings request automatic repairs within the original task's scope.
 * @returns complete start/poll guidance and the confirmed repair policy, not an enforced execution schedule.
 */
export function taskReviewExecutionInstruction(autoFix: boolean): string {
  const findings = autoFix
    ? 'When review finds concrete issues, fix them only within the original task scope and existing permissions. '
      + 'After fixes, request another review only while the authorized review-call allowance remains, and poll its ticket until it settles. '
      + 'If no calls remain or a new review is refused, report unresolved findings and the review limitation; do not claim the fixes passed review. '
    : 'When review finds issues, report them without automatically fixing them because of the review. '
      + 'Repairs explicitly requested by the original task remain within its existing scope and permissions. '
  return reviewStartInstruction + 'A pending response is not a verdict. ' + findings + reviewEvidenceInstruction
}

const names = ['review_start', 'review_poll'] as const
const startArguments = z.object({}).strict()
const pollArguments = z.object({ ticket: z.uuid() }).strict()
const description = {
  review_start: 'Start the authorized read-only code review for this coding task. Takes no arguments and returns a ticket. '
    + 'This consumes a review call, including when there are no tracked changes; a pending duplicate reuses its ticket. '
    + 'The reviewer and optional fallback are already authorized. A new admitted review invalidates older tickets. It does not edit files, run tests or complete this task.',
  review_poll: 'Read the current review ticket of this coding task. Waits for a bounded interval and may return pending; call again with the same ticket. '
    + 'Repeated terminal reads do not start models or consume review calls. Tickets from other tasks or earlier reviews are unavailable. '
    + 'Findings are model assessments, not proof of tests or acceptance.',
} as const

function complete(text: string, scope: TaskReviewScope): string {
  if (Buffer.byteLength(text, 'utf8') > scope.maxResultBytes) throw new Error('Complete review tool response exceeds maxToolResultBytes')
  return text
}

function result(call: ProjectTaskReviewCall, scope: TaskReviewScope): string {
  return complete(JSON.stringify({ ticket: call.id, number: call.number, status: call.status,
    fallback_used: call.fallbackUsed === true,
    ...(call.result === undefined ? {} : call.result),
    ...(call.failure === undefined ? {} : { failure: call.failure }) }), scope)
}

async function execute(scope: TaskReviewScope, name: string, args: unknown, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (name === 'review_start') {
    if (!startArguments.safeParse(args).success) throw new TaskReviewRequestError('review_start accepts only an empty object')
    return result(await scope.start(signal), scope)
  }
  if (name === 'review_poll') {
    const parsed = pollArguments.safeParse(args)
    if (!parsed.success) throw new TaskReviewRequestError('review_poll requires only a valid ticket')
    return result(await scope.poll(brandString<ProjectTaskReviewTicket>(parsed.data.ticket), signal), scope)
  }
  throw new TaskReviewRequestError('This task does not provide that review tool')
}

/** Install tools before task input; child Agents neither see nor execute inherited review definitions.
 * Non-recoverable tool failures cancel only this executor before the tools pipeline can resume its model.
 * @param agent - the exact confirmed coding executor, never a reviewer or its parent conversation.
 * @param scope - task-owned review authority; its caller retains async-disposal ownership.
 * @returns an effect-owned registration disposer; it does not dispose the shared review scope.
 */
export function installTaskReviewTools(agent: Agent, scope: TaskReviewScope): () => void {
  const releases: Array<() => void> = []
  try {
    releases.push(agent.ctx.tools.restrictAccess((name, caller) => !names.some(value => value === name) || caller === agent))
    for (const name of names) {
      const tool = defineTool({ name, description: description[name],
        parameters: name === 'review_start' ? {} : { ticket: { type: 'string', required: true, description: 'Current ticket returned by review_start.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        presentCall: () => ({ card: 'generic', title: name, kind: name === 'review_start' ? 'execute' : 'read' }),
        execute: async (args, exec) => {
          if (exec.agent !== agent) throw new Error('Review tools belong only to their confirmed coding executor')
          try { return await execute(scope, name, args, exec.signal) }
          catch (error) {
            if (!(error instanceof TaskReviewRequestError) && !exec.signal.aborted) {
              agent.cancel({ kind: 'hook', reason: 'Task review authority, complete output or persistence failed' })
            }
            throw error
          }
        },
      })
      releases.push(agent.ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } }))
    }
  } catch (error) { for (const release of releases.reverse()) release(); throw error }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    for (const release of releases.reverse()) release()
  }
}

/** Adapt fixed task authority to native tools; the native consumer must durably acknowledge definitions, calls and results.
 * @param scope - confirmed coding execution authority and complete response allowance.
 * @returns explicit side-effect metadata and bounded recoverable errors; cancellation, revoked authority and persistence failures reject.
 */
export function createTaskReviewNativeTools(scope: TaskReviewScope): NativeTaskTools {
  return {
    definitions: names.map(name => ({ name, description: description[name], readOnly: name === 'review_poll',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: name === 'review_start' ? {} : { ticket: { type: 'string', description: 'Current ticket returned by review_start.' } },
        required: name === 'review_start' ? [] : ['ticket'] } })),
    async call(name, args, signal): Promise<NativeTaskToolResult> {
      try { return { text: await execute(scope, name, args, signal), isError: false } }
      catch (error) {
        if (!(error instanceof TaskReviewRequestError)) throw error
        return { text: complete(error.message, scope), isError: true }
      }
    },
  }
}
