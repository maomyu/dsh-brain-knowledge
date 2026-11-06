/** Durable Goal check rounds and acceptance projection, separate from immutable signed plans. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { taskFileStatsSchema } from './task-file-stats.ts'
import { taskWrapUpSchema } from './task-wrap-up.ts'
import { researchReportSchema } from './research.ts'
import { taskArtifactSchema } from './artifact-task.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ProjectGoalOutcomeInput, ProjectGoalPlan, ProjectGoalProgress, ProjectGoalRequestId,
  ProjectSubGoalId, ProjectTaskId, ProjectTaskState } from './types.ts'

const identity = z.string().min(1).transform(value => brandString<ProjectGoalRequestId>(value))
const indices = z.array(z.number().int().nonnegative()).refine(value => new Set(value).size === value.length)

/** Explicit deterministic rerun, validated before background admission. */
export const goalVerifySchema = z.object({ requestId: identity,
  subGoalId: z.string().min(1).transform(value => brandString<ProjectSubGoalId>(value)),
  taskId: z.uuid().transform(value => brandString<ProjectTaskId>(value)), criteria: indices.optional(),
}).strict()

/** Source judgement cannot set the host-owned deterministic marks. */
export const goalOutcomeSchema = z.object({ requestId: identity,
  subGoalId: z.string().min(1).transform(value => brandString<ProjectSubGoalId>(value)),
  taskId: z.union([z.literal('master'), z.uuid().transform(value => brandString<ProjectTaskId>(value))]), criteriaPassed: indices,
  verdict: z.enum(['passed', 'failed']), decision: z.enum(['NEXT', 'RETRY', 'DONE', 'ESCALATE']),
  failureReason: z.string().trim().min(1).optional(), escalateReason: z.string().trim().min(1).optional(),
}).strict().refine(value => value.decision !== 'RETRY' || value.failureReason !== undefined)

/** A retry resumes its retained round; checks without retained results may execute again after interruption. */
export const goalReportSchema = z.object({ requestId: identity, indices,
  detached: z.literal(true).optional(),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  checks: z.array(z.object({ index: z.number().int().nonnegative(), passed: z.boolean(), detail: z.string() }).strict()),
  delivery: z.enum(['checking', 'pending', 'sent']), summary: z.string(), summaryTruncated: z.boolean(),
  notice: z.object({ taskId: z.uuid().transform(value => brandString<ProjectTaskId>(value)), title: z.string().min(1),
    status: z.enum(['closed-success', 'closed-failed', 'closed-cancelled']), completedAt: z.number().int().nonnegative().nullable(),
    summary: z.string(), summaryTruncated: z.boolean(), wrapUpSummary: taskWrapUpSchema.optional(),
    researchReport: researchReportSchema.pick({ artifactId: true, fileName: true, summary: true }).optional(),
    artifactOutput: taskArtifactSchema.optional(),
    files: taskFileStatsSchema.optional() }).strict().optional(),
  inputText: z.string().min(1).optional(),
}).strict().refine(value => new Set(value.checks.map(check => check.index)).size === value.checks.length
  && (value.detached !== true || value.indices.length === 0)
  && (value.notice === undefined || (value.notice.summary === value.summary && value.notice.summaryTruncated === value.summaryTruncated))
  && (value.notice?.researchReport === undefined || value.notice.status === 'closed-success')
  && (value.notice?.artifactOutput === undefined || value.notice.status === 'closed-success')
  && value.checks.every(check => value.indices.includes(check.index))
  && (value.delivery === 'checking' || (value.inputText !== undefined && value.checks.length === value.indices.length)))

/** Private message identity and prompt retained before automatic source admission. */
export type GoalReportRecord = z.infer<typeof goalReportSchema>

/** Compute current acceptance without modifying the signed plan.
 * @param plan - immutable approved criteria and dependencies.
 * @param tasks - run-owned attempts in admission order.
 * @param outcomes - source judgements of exact collected attempts or signed master-only sub-goals.
 * @param pausedTasks - retained attempts cancelled by an explicit user pause.
 * @returns latest-attempt marks; a new attempt cannot inherit a previous attempt's success.
 */
export function goalProgress(plan: ProjectGoalPlan, tasks: readonly ProjectTaskState[],
  outcomes: readonly ProjectGoalOutcomeInput[], pausedTasks: ReadonlySet<ProjectTaskId> = new Set()): ProjectGoalProgress[] {
  return plan.subGoals.map((subGoal) => {
    const task = tasks.filter(item => item.goal?.subGoalId === subGoal.id).at(-1)
    const judged = outcomes.filter(item => item.subGoalId === subGoal.id
      && item.taskId === (plan.allowTaskDispatch === false ? 'master' : task?.id))
    const outcome = judged.at(-1)
    const passed = new Set(judged.flatMap(item => item.criteriaPassed))
    const checks = new Map(task?.goalReports?.flatMap(report => report.checks).map(check => [check.index, check]))
    const criteria = subGoal.criteria.map((criterion, index) => {
      const check = checks.get(index)
      return criterion.check !== undefined
        ? { index, passed: check?.passed ?? false, ...(check === undefined ? {} : { verifiedBy: 'tier0' as const, detail: check.detail }) }
        : { index, passed: passed.has(index), ...(passed.has(index) ? { verifiedBy: 'master' as const } : {}) }
    })
    const done = outcome !== undefined && criteria.every(item => item.passed)
    return { subGoalId: subGoal.id, taskId: task?.id ?? null, criteria,
      status: done ? 'done' : outcome?.verdict === 'failed' || (task !== undefined && pausedTasks.has(task.id)) ? 'failed'
        : task !== undefined && outcome === undefined ? 'dispatched' : 'pending' }
  })
}
