/** Goal-only decision tool; scope and attribution are derived by the Host writer. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'

interface GoalDecisionArgs {
  run_id: string
  path: string
  operation_id: string
  expected_version: string
  summary: string
  evidence: string
  target_project_id?: string
}

/** Describe knowledge increments distinct from task logs and current-understanding replacement.
 * @param execute - source-Goal writer enforcing the signed page scope at file publication.
 * @returns a timeline-only tool with a pure acknowledgement card.
 */
export function createGoalDecisionTool(execute: (args: GoalDecisionArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'wud_write_decision',
    description: 'During an approved RUNNING Goal, append a supported, reusable decision to an existing active decision page. '
      + 'The exact Brain-relative path must appear in the signed plan brainRefs; a slug or alias is not write permission. '
      + 'To write another project in this workspace, set target_project_id to its exact ID listed in the signed brainProjectIds. Omission writes the conversation project. '
      + 'Read the page first with brain_read and pass its exact version. Evaluate knowledge increments after task results or a milestone; '
      + 'write nothing for mechanical work or an unverified claim. Explain supporting evidence without copying task IDs or execution logs. '
      + 'The Host records the Goal and approved master route. No new user quote is needed under the approved scope. '
      + 'This appends a Timeline entry only: it cannot replace current understanding, create pages, change status or write roots. '
      + 'Report needed out-of-scope changes to the user; never widen the plan yourself. Retain the operation UUID and every input for retries.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact approved Goal run identity.' },
      target_project_id: { type: 'string', description: 'Exact workspace project ID explicitly signed in brainProjectIds; omit for the source conversation project.' },
      path: { type: 'string', required: true, description: 'Existing active decision page path explicitly signed in brainRefs.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      expected_version: { type: 'string', required: true, description: 'Exact version from the successful informing brain_read.' },
      summary: { type: 'string', required: true, description: 'Reusable project decision, not task progress or an execution log.' },
      evidence: { type: 'string', required: true, description: 'Supporting observations and reasoning; task self-reports alone do not establish truth.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
