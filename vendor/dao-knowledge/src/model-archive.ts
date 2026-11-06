/** Archival schema and pure result presentation shared by model dispatch and catalog harvest. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'

interface BrainArchiveArgs {
  path: string
  target_project_id?: string
  operation_id: string
  expected_version: string
  superseded_by: string | null
  evidence_quote: string
}

/** Describe explicit archival while retaining knowledge and any requested replacement relationship.
 * @param execute - project-bound writer requiring a logged informing read and actual user-message identity.
 * @returns an archival-only tool with a pure acknowledgement card.
 */
export function createBrainArchiveTool(execute: (args: BrainArchiveArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_archive_page',
    description: 'Archive an existing Brain page for an explicit user request, preserving its current understanding and history. '
      + 'Read it first with brain_read; use include_inactive=true for drafts or archived pages. '
      + 'Set superseded_by to an existing page path in the same project only when the user requests a replacement; otherwise use null. '
      + 'A replacement adds one reversal to history; null leaves history unchanged. Neither page is deleted. '
      + 'Archived pages leave ordinary active context and require explicit inactive reading. Restore with brain_set_page_status. '
      + 'Ask for clarification when archival or the replacement is uncertain. Cite exact supporting user text; a source reference does not prove approval. '
      + 'Retain the UUID and all inputs for retries; an identical retry preserves later edits and restoration.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing Brain-relative page path returned by brain_read.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; use the same project as brain_read. Omitted uses the conversation default.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      expected_version: { type: 'string', required: true, description: 'Exact version from the logged informing brain_read.' },
      superseded_by: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true,
        description: 'Existing Brain-relative replacement page path in this project, or null for archival without replacement.' },
      evidence_quote: { type: 'string', required: true, description: 'Exact supporting text from one visible user-authored message.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
