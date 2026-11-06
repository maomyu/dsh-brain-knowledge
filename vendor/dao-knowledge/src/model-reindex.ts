/** Explicit derived-index rebuilding for ordinary workspace conversations. */
import { brainTextOutput } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Describe a page-file scan and atomic portable-index replacement, without rewriting knowledge.
 * @param execute - controller-backed writer with live workspace and selected-Brain authorization.
 * @returns logged model tool; malformed pages retain warning rows, while incomplete reads preserve the old index.
 */
export function createBrainReindexTool(
  execute: (args: { target_project_id?: string }, exec: ToolRunContext) => Promise<string>,
): ToolDefinition {
  return defineTool({
    name: 'brain_reindex',
    description: 'Rebuild the selected project’s portable brain/index.md from current page files, including drafts and archives. '
      + 'Use after external file edits or to refresh the portable catalog. This does not change page knowledge, tags or Timeline history, '
      + 'and does not run an embedding or model job. Malformed pages retain their paths with parse-warning rows. Missing Brains, unreadable files, '
      + 'incomplete scans and concurrent changes reject without replacing the previous index. Fix the reported files or configured scan limits and retry. '
      + 'Page creation, lifecycle changes and archival refresh this file automatically; the application’s live page list scans files independently.',
    parameters: {
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; required when a workspace conversation has several projects.' },
    },
    output: brainTextOutput,
    presentResult(_args, result) { return { card: 'generic', title: 'index.md', content: result.content } },
    execute,
  })
}
