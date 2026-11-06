/** Page-title tool schema and pure generic result presentation. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

interface BrainTitleArgs {
  path: string
  target_project_id?: string
  expected_version: string
  title: string
}

/** Describe display-name changes without changing a page's identity or knowledge.
 * @param execute - workspace-authorized writer requiring the destination's retained read.
 * @returns title tool with complete acknowledgement and generic result presentation.
 */
export function createBrainTitleTool(execute: (args: BrainTitleArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_update_page_title',
    description: 'Change only a Brain page’s display title and metadata time, then refresh index.md. '
      + 'Read it first with brain_read and use the exact returned version. The trimmed title must not be empty. '
      + 'The file path, page id, current understanding, lifecycle and Timeline stay unchanged. '
      + 'An already equal title leaves the page untouched and still refreshes the index. '
      + 'If the page is saved but indexing fails, retry the same original request. After a conflicting edit, read again before deciding a new title. '
      + 'Do not bypass a refused write through a file or shell tool.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing Brain-relative page path returned by brain_read.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; use the same target as brain_read.' },
      expected_version: { type: 'string', required: true, description: 'Exact version from the retained informing brain_read.' },
      title: { type: 'string', required: true, description: 'New human-readable display title; whitespace-only values are refused.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
