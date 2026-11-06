/** Metadata-only tag replacement schema with a pure acknowledgement card. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

interface BrainTagsArgs {
  path: string
  target_project_id?: string
  expected_version: string
  tags: string[]
}

/** Describe complete replacement of one page's topic tags, without changing knowledge or lifecycle.
 * @param execute - workspace-authorized metadata writer requiring the destination's retained read.
 * @returns tag tool with bounded output and generic result presentation.
 */
export function createBrainTagsTool(execute: (args: BrainTagsArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_set_page_tags',
    description: 'Replace only a Brain page’s frontmatter tags. Read it first with brain_read and use the exact returned version. '
      + 'Supply the complete list, or [] to clear it. Tags become lowercase ASCII words joined with hyphens; non-ASCII text is not transliterated. '
      + 'Empty and duplicate normalized tags are ignored. Keep at most eight tags; normalized tags longer than 50 characters are discarded, not truncated. '
      + 'This updates metadata time, not current understanding, lifecycle or Timeline history. An already equal tag list does not rewrite the file. '
      + 'After a conflict, read the page again before deciding a new replacement. Do not bypass a refused write through a file or shell tool.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing Brain-relative page path returned by brain_read.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; use the same target as brain_read.' },
      expected_version: { type: 'string', required: true, description: 'Exact version from the retained informing brain_read.' },
      tags: { type: 'array', items: { type: 'string' }, required: true, description: 'Full replacement list; [] clears the page tags.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
