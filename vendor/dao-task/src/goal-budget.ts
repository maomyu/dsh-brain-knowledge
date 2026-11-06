/** Worker-only budget accounting and advisory thresholds; no execution authority. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectGoalBudget, ProjectGoalBudgetNotice, ProjectGoalControlInput, ProjectGoalProgress,
  ProjectGoalUsage, ProjectSubGoalId, ProjectTaskState } from './types.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** A task's single settlement receipt, persisted with its terminal status. */
export const taskUsageSchema = z.object({ turns: count, totalTokens: count, unreportedSteps: count }).strict()
  .refine(value => value.unreportedSteps <= value.turns)

/** Previously credited criteria keep retries from manufacturing progress. */
export const goalCreditsSchema = z.object({ streak: count,
  passed: z.array(z.object({
    subGoalId: z.string().min(1).transform(value => brandString<ProjectSubGoalId>(value)), index: count,
  }).strict()),
}).strict().refine(value => new Set(value.passed.map(mark => JSON.stringify([mark.subGoalId, mark.index]))).size
  === value.passed.length)

/** Highest-priority model-visible advisory. */
export const goalBudgetNoticeSchema = z.object({ dimension: z.enum(['no-progress', 'spawn', 'token', 'turn']),
  used: count, threshold: count, advisory: z.literal(true) }).strict()

/** Resolve monotonically raised user thresholds without changing the original signoff.
 * @param approved - complete original budget.
 * @param controls - retained user gestures in revision order.
 * @returns current thresholds; pause gestures and lower overrides have no effect.
 */
export function resolveGoalBudget(approved: ProjectGoalBudget, controls: readonly ProjectGoalControlInput[]): ProjectGoalBudget {
  const budget = { ...approved }
  for (const control of controls) if (control.action === 'resume') {
    const override = control.budgetOverride
    for (const key of ['runSpawnCap', 'runTokenWarnThreshold', 'runTurnWarnThreshold'] as const) {
      if (override?.[key] !== undefined) budget[key] = Math.max(budget[key], override[key])
    }
  }
  return budget
}

/** Credit newly accepted criteria once across all attempts in the run.
 * @param prior - retained credits, or absent for a run without recorded outcomes.
 * @param progress - current acceptance after the new outcome.
 * @returns cumulative credits and the new consecutive no-progress count.
 */
export function creditGoalProgress(prior: z.infer<typeof goalCreditsSchema> | undefined,
  progress: readonly ProjectGoalProgress[]): z.infer<typeof goalCreditsSchema> {
  const passed = [...prior?.passed ?? []]
  const before = passed.length
  for (const subGoal of progress) for (const mark of subGoal.criteria) {
    if (mark.passed && !passed.some(item => item.subGoalId === subGoal.subGoalId && item.index === mark.index)) {
      passed.push({ subGoalId: subGoal.subGoalId, index: mark.index })
    }
  }
  return { passed, streak: passed.length > before ? 0 : (prior?.streak ?? 0) + 1 }
}

/** Sum one usage receipt per admitted task; missing reports do not imply zero consumption.
 * @param tasks - unique task records owned by this run.
 * @param noProgressStreak - retained consecutive outcomes without a new acceptance credit.
 * @returns worker totals and explicit missing accounting counts.
 */
export function goalUsage(tasks: readonly ProjectTaskState[], noProgressStreak: number): ProjectGoalUsage {
  return tasks.reduce<ProjectGoalUsage>((sum, task) => ({ ...sum,
    turns: sum.turns + (task.usage?.turns ?? 0), totalTokens: sum.totalTokens + (task.usage?.totalTokens ?? 0),
    unreportedSteps: sum.unreportedSteps + (task.usage?.unreportedSteps ?? 0),
    unaccountedTasks: sum.unaccountedTasks + (task.usage === undefined ? 1 : 0),
  }), { spawnsUsed: tasks.filter(task => task.goal?.gather !== true && task.goal?.probe === undefined).length,
    turns: 0, totalTokens: 0, unreportedSteps: 0, unaccountedTasks: 0, noProgressStreak })
}

/** Select the native priority order without stopping or blocking dispatch.
 * @param budget - resolved user thresholds.
 * @param usage - cumulative worker accounting.
 * @returns the first reached advisory, or undefined below all thresholds.
 */
export function goalBudgetNotice(budget: ProjectGoalBudget, usage: ProjectGoalUsage): ProjectGoalBudgetNotice | undefined {
  const candidates = [
    ['no-progress', usage.noProgressStreak, budget.noProgressPauseThreshold],
    ['spawn', usage.spawnsUsed, budget.runSpawnCap],
    ['token', usage.totalTokens, budget.runTokenWarnThreshold],
    ['turn', usage.turns, budget.runTurnWarnThreshold],
  ] as const
  const found = candidates.find(([, used, threshold]) => used >= threshold)
  return found === undefined ? undefined : { dimension: found[0], used: found[1], threshold: found[2], advisory: true }
}
