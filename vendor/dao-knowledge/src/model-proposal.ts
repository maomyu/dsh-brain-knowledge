/** Unapproved page or root replacement schema and pure result presentation. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'

interface BrainProposalArgs {
  path: string
  target_project_id?: string
  operation_id: string
  expected_version: string
  truth: string
  summary: string
  evidence: string
}

/** Describe retaining a proposed replacement without publishing it as current understanding.
 * @param execute - ordinary-conversation writer deriving the source reference from the executing Session.
 * @returns proposal tool with a complete pending-review acknowledgement and generic card.
 */
export function createBrainProposalTool(execute: (args: BrainProposalArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_propose_truth',
    description: 'Save an unapproved replacement for an existing Brain page or fixed root document for human review, without changing its current content. '
      + 'First read the complete document with brain_read and use its exact version and target project. '
      + 'Supply the complete proposed Markdown, explain the conflict or impact, and identify the supporting source or location. '
      + 'For a root, supply the entire body including its heading and all still-valid sections, not only changed paragraphs. Roots have no page Timeline. '
      + 'The tool records your actual conversation as the source; evidence is reference data, not proof of user approval. '
      + 'No user quote or approval claim is required to retain this unapproved proposal. Report pending review, never that knowledge was updated. '
      + 'An already-applied retry reports proposal-retained; it does not establish that human review is still pending. Use brain_read_proposals with this path, project and operation_id to inspect its retained human disposition and note. '
      + 'That historical decision does not prove the current knowledge still matches the proposal; use brain_read for the current document. '
      + 'If the user already approved this specific replacement, use brain_update_truth for a page or brain_write_root for a root, with the required user evidence instead. '
      + 'When an import or other workflow requires confirmation before any write, wait for that confirmation before saving proposal metadata too. '
      + 'Keep the UUID and every input unchanged when retrying. After a version conflict, reread and prepare a new operation. '
      + 'This tool does not create documents, publish proposed content, restore archives, or grant execution Tasks or approved Goals ordinary write authority.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing Brain-relative page or fixed root-document path returned by brain_read.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; use the same target as the informing brain_read. Omitted uses the conversation default.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      expected_version: { type: 'string', required: true, description: 'Exact version from the successful full-document read that informed this proposal.' },
      truth: { type: 'string', required: true, description: 'Complete proposed page understanding or entire root body, including its heading and all sections, without frontmatter. Page understanding must also omit Brain storage markers.' },
      summary: { type: 'string', required: true, description: 'The disagreement, uncertainty or impact the human should review.' },
      evidence: { type: 'string', required: true, description: 'Supporting source text or precise location; not a claim that the user approved the replacement.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
