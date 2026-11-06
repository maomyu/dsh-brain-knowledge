/** Two-page consolidation schema; the Host derives the author from the executing conversation. */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'

interface BrainMergeArgs {
  target_path: string
  target_version: string
  source_path: string
  source_version: string
  target_project_id?: string
  operation_id: string
  truth: string
  summary: string
  reason: string
  evidence_quote: string
}

/** Bounded publication progress, not a claim of atomic two-file success. */
export interface BrainMergeResult {
  project_id: string
  operation_id: string
  target_path: string
  source_path: string
  stage: 'prepared' | 'target-written' | 'source-archived' | 'complete' | null
  can_continue: boolean
  blocked: boolean
  publication_error: boolean
  ended: boolean
}

/** Describe an AI consolidation that retains both source histories and its recovery journal.
 * @param execute - conversation-bound writer checking complete reads, versions and protected publication.
 * @returns a model tool with explicit partial progress and pure cards for both paths.
 */
export function createBrainMergeTool(execute: (args: BrainMergeArgs, exec: ToolRunContext) => Promise<BrainMergeResult>): ToolDefinition {
  return defineTool({
    name: 'brain_merge_pages',
    description: 'Consolidate two confirmed active Brain pages in the same project: replace the target understanding and archive the source with a replacement reference. '
      + 'First read BOTH complete pages with brain_read and use their exact versions. Preserve every still-valid fact, constraint and reference in the complete merged Markdown. '
      + 'Do not resolve an unconfirmed conflict by overwriting it: retain current knowledge and report the uncertainty. Enabled automatic maintenance independently reviews complete sources and the whole catalog before publication; a deferred review does not request routine human acceptance. Drafts, publication holds and unresolved proposals cannot be merged. '
      + 'Cite exact supporting user text; the Host records the actual authoring conversation and message, not human approval. '
      + 'Both histories and the source body remain retained; files publish separately. Inspect stage and blocked/publication_error, never report full success unless stage is complete. '
      + 'On an uncertain or partial result, read BOTH current files completely again and retry the SAME operation UUID and ALL original inputs, including original versions. '
      + 'A retry cannot overwrite independent edits or resume another conversation’s operation. Do not bypass a refusal with another UUID or filesystem tools.',
    parameters: {
      target_path: { type: 'string', required: true, description: 'Existing active page to retain, pages/<id>.md.' },
      target_version: { type: 'string', required: true, description: 'Exact complete target brain_read version; retain the original version on retry.' },
      source_path: { type: 'string', required: true, description: 'Distinct existing active page to archive in this same project.' },
      source_version: { type: 'string', required: true, description: 'Exact complete source brain_read version; retain the original version on retry.' },
      target_project_id: { type: 'string', description: 'Project id or unique name in this workspace; use the same project for both reads and the merge.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      truth: { type: 'string', required: true, description: 'Complete merged current-understanding Markdown without frontmatter or Brain storage markers.' },
      summary: { type: 'string', required: true, description: 'Concise description of the consolidation.' },
      reason: { type: 'string', required: true, description: 'AI rationale for merging these topics; not a human approval claim.' },
      evidence_quote: { type: 'string', required: true, description: 'Exact supporting text from one visible user-authored message.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      project_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true },
      target_path: { type: 'string', required: true }, source_path: { type: 'string', required: true },
      stage: { oneOf: [{ type: 'string', enum: ['prepared', 'target-written', 'source-archived', 'complete'] }, { type: 'null' }], required: true },
      can_continue: { type: 'boolean', required: true }, blocked: { type: 'boolean', required: true },
      publication_error: { type: 'boolean', required: true }, ended: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall(args) { return { card: 'generic', title: `${args.source_path} → ${args.target_path}`,
      locations: [{ path: args.target_path }, { path: args.source_path }] } },
    presentResult(args, result) { return { card: 'generic', title: `${args.source_path} → ${args.target_path}`, content: result.content } },
    execute,
  })
}
