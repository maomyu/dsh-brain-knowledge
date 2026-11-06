/** Batch format repair tool retains per-page outcomes without requesting replacement knowledge. */
import { brainTextOutput } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Describe format-only repair for selected pages or the complete project page listing.
 * @param execute - project-authorized batch writer with bounded output and cancellation.
 * @returns the tool and its pure generic result presentation.
 */
export function createBrainFormatTool(
  execute: (args: { paths?: string[]; target_project_id?: string }, exec: ToolRunContext) => Promise<string>,
): ToolDefinition {
  return defineTool({
    name: 'brain_normalize_page_format',
    description: 'Repair Brain history markers to <!-- timeline --> followed by ## Timeline, retaining compatible compiled-truth markers. '
      + 'This format-only operation preserves current understanding, metadata, timestamps and timeline evidence; it appends no history. '
      + 'Omit paths or supply an empty list to inspect every page, including drafts and archived pages. '
      + 'Canonical pages are skipped. Changed, skipped and failed paths are returned separately; inspect failed pages before retrying. '
      + 'Each page commits separately; cancellation or a later failure does not undo earlier repairs. '
      + 'Use for storage-format findings, not to rewrite conclusions or resolve semantic conflicts.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional Brain-relative page paths; omitted or empty means all pages.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; omitted uses the conversation default. An empty paths list repairs only this selected project.' },
    },
    output: brainTextOutput,
    presentResult(_args, result) { return { card: 'generic', content: result.content } },
    execute,
  })
}
