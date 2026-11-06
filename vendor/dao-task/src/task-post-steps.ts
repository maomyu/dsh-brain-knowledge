/** Confirmed coding-task follow-up guidance; existing executors own tools, permissions and actual execution evidence. */
import type { ProjectTaskPostSteps } from './types.ts'
import { taskReviewExecutionInstruction } from './task-review-tools.ts'

/** Compose independent testing and review-repair guidance for the caller's durable execution input.
 * @param postSteps - explicitly resolved, confirmed coding-task choices.
 * @param reviewEnabled - whether this execution has separately authorized review tools.
 * @returns complete model guidance; it starts no work and does not establish test results or human acceptance.
 */
export function taskPostStepsInstruction(postSteps: ProjectTaskPostSteps, reviewEnabled: boolean): string {
  const testing = postSteps.autoRunTests
    ? [
      reviewEnabled
        ? 'Before the final code review, use the existing task tools and permissions to run relevant project type checks, automated tests and smoke checks when feasible.'
        : 'Before the final response, use the existing task tools and permissions to run relevant project type checks, automated tests and smoke checks when feasible.',
      'Use the project\'s existing commands and dependencies. Do not skip feasible relevant checks. If a check cannot run, report the specific reason and mark it as not run.',
      reviewEnabled
        ? 'After any fixes, rerun the affected checks before the next review.'
        : 'After any fixes, rerun the affected checks before the final response.',
      'Report the actual commands, exit codes and observed output, distinguishing passed, failed and unrun checks. Do not invent output or treat a review verdict as a test result.',
      'Do not install dependencies, change security settings or obtain additional permissions for this follow-up. If existing permissions block a check, report the limitation.',
    ].join(' ')
    : 'Automatic test follow-up is disabled; this policy adds no test-running requirement. Tests explicitly requested by the original task remain within its existing scope and permissions.'
  return [testing,
    ...(reviewEnabled ? [taskReviewExecutionInstruction(postSteps.autoFix)] : []),
    'These follow-up instructions grant no additional tool or file access. Reported checks and review findings do not mark the human verification checklist or prove acceptance criteria passed.',
  ].join('\n\n')
}
