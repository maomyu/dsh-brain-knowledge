/** Goal knowledge writers retain distinct signed scopes over one versioned publication path. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'

/** Complete retained rewrite input; the Host derives authority from the source Goal. */
export interface GoalRewriteArgs {
  run_id: string
  path: string
  operation_id: string
  expected_version: string | null
  markdown: string
  rationale: string
  evidence: string
  target_project_id?: string
}

/** Describe immediate knowledge replacement followed by terminal human review.
 * @param kind - active decision understanding or a fixed root document.
 * @param execute - source-owned writer requiring a logged replacement read and publication-time authorization.
 * @returns the Goal tool with a pure acknowledgement presenter.
 */
export function createGoalRewriteTool(kind: 'page' | 'root',
  execute: (args: GoalRewriteArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: kind === 'page' ? 'wud_rewrite_truth' : 'wud_update_root_page',
    description: 'During an approved RUNNING Goal, immediately replace '
      + (kind === 'page' ? 'the current understanding of an existing active decision page explicitly signed in brainRefs. '
        : 'or initialize a fixed root document explicitly signed in rootPageRefs. ')
      + (kind === 'page' ? 'Read the exact file with brain_read first and retain its version. '
        : 'For replacement, read the exact file with brain_read first and retain its version. Use expected_version=null only to create an absent root; creation never overwrites an existing file. ')
      + 'Supply complete Markdown, a reusable knowledge rationale '
      + 'and independently supported evidence. Do not include execution task IDs, logs, invented conclusions or out-of-scope changes. '
      + 'The Host retains exact before/after images for human keep or guarded revert at DONE/ESCALATED. '
      + 'Knowledge changes now, not as a pre-write proposal. No new user quote is required within the approved scope. '
      + 'Set target_project_id only to an exact workspace project ID in signed brainProjectIds; omission writes the source conversation project. '
      + 'Retain the operation UUID and all inputs for identical retries; a changed file requires a new informing read.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact approved Goal run identity.' },
      target_project_id: { type: 'string', description: 'Exact workspace project ID explicitly signed in brainProjectIds; omit for the source conversation project.' },
      path: { type: 'string', required: true, description: kind === 'page'
        ? 'Exact existing active decision page path in brainRefs, such as pages/storage.md.'
        : 'Exact fixed root filename whose slug is in rootPageRefs, such as architecture.md.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      expected_version: kind === 'page'
        ? { type: 'string', required: true, description: 'Exact version from the successful informing brain_read.' }
        : { oneOf: [{ type: 'string' }, { type: 'null' }], required: true,
          description: 'Exact informing brain_read version for replacement, or null to create an absent root only.' },
      markdown: { type: 'string', required: true, description: 'Complete replacement understanding or root body; never a partial patch or Timeline.' },
      rationale: { type: 'string', required: true, description: 'Why verified observations require this knowledge change.' },
      evidence: { type: 'string', required: true, description: 'Supporting observations, not task IDs or unverified self-reports.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
