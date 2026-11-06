/** General Timeline append schema and pure result presentation. */
import { brainTextOutput, presentBrainPathResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OPERATION_ID_DESCRIPTION } from './model-operation.ts'
import type { KnowledgeAutomaticTimelineResult, KnowledgeTruthReceipt } from './types.ts'

type ReviewedResult = Exclude<KnowledgeAutomaticTimelineResult, { status: 'applied' }>
  | { readonly status: 'applied'
    readonly disposition: KnowledgeTruthReceipt['disposition']
    readonly review: KnowledgeAutomaticTimelineResult['review'] }

/** Render one complete reviewed result without truncating its reason or assessment identity.
 * @param args - exact logged append identity.
 * @param result - actual assessment, or the applied acknowledgement reserved before publication.
 * @param maxBytes - configured complete UTF-8 result allowance.
 * @returns complete tool JSON, including its reviewer identity when known.
 * @throws when the complete acknowledgement does not fit; applied variants must be checked before publication.
 */
export function renderReviewedTimelineResult(args: { path: string; operation_id: string }, result: ReviewedResult,
  maxBytes: number): string {
  const text = JSON.stringify(result.status === 'applied'
    ? { operation_id: args.operation_id, path: args.path, disposition: result.disposition, review: result.review }
    : { status: result.status, reason: result.reason, knowledge_changed: false, path: args.path,
      operation_id: args.operation_id, review: result.review, next: result.status === 'no-change'
        ? 'This candidate is already covered or contains no new project knowledge. Do not reread or write a stop/correction entry for it. Continue only distinct uncovered facts, otherwise finish without visible review text.'
        : 'No Timeline entry was written. A new settled rule belongs in complete current understanding via brain_update_truth, which already records its evidence history. Do not append a stopping or repair note.' })
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Complete Brain review acknowledgement exceeds maxReadBytes')
  return text
}

interface TimelineArgs {
  path: string
  target_project_id?: string
  operation_id: string
  expected_version: string
  kind: 'decision' | 'observation' | 'source' | 'reversal'
  summary: string
  source?: string
  affects?: string[]
  evidence?: string
}

/** Describe evidence retention without replacing the page's current understanding.
 * @param execute - conversation-authorized append with an informing read and durable retry identity.
 * @returns four-kind append tool with optional references and a pure acknowledgement card.
 */
export function createBrainTimelineTool(execute: (args: TimelineArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_append_timeline',
    description: 'Append a decision, observation, source or reversal to an existing Brain page without replacing current understanding or prior history. '
      + 'First read the page with brain_read and pass its exact version; inactive pages require an explicit historical read. '
      + 'Choose a permitted workspace project with target_project_id when the destination is not the conversation’s default project. '
      + 'Source and evidence are optional reference text, not proof that a claim is verified or that the user approved it. Distinguish observations from settled decisions. '
      + 'When automatic conversation retention is enabled, an independent review compares the exact append intent with complete original human sources and the complete Brain. A no-change or deferred result writes nothing. New settled facts and reversals belong in brain_update_truth, which records its own evidence history. Append only genuinely new supporting evidence that leaves current understanding unchanged, or a confirmation event the human explicitly requested. Never append stopping, duplicate-correction or no-op bookkeeping. '
      + 'When reviewing task completion, consider only the selected active decision pages and record a supported reusable knowledge increment, not task IDs or lifecycle updates. '
      + 'A documentation completion with an explicitly confirmed generation trace is a separate case: append an observation of the artifact, selected sources and agreed framework only to its selected active page, using its supplied operation UUID. This is not a new decision or verified build result. '
      + 'Execution Tasks cannot write knowledge; approved Goals use their signed wud_* operations. This does not create pages, change status or update roots. '
      + 'Keep the operation UUID and all inputs for retries. After a version conflict, read again and use a new operation, except a confirmed documentation trace must keep its supplied UUID. On an identity conflict, stop and report it; do not mint another UUID to bypass an existing trace.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing Brain-relative page path returned by brain_read.' },
      target_project_id: { type: 'string', description: 'Exact project id or unambiguous visible name in this workspace; follows brain_read selection.' },
      operation_id: { type: 'string', required: true, description: OPERATION_ID_DESCRIPTION },
      expected_version: { type: 'string', required: true, description: 'Exact version of the successful brain_read that informed this entry.' },
      kind: { type: 'string', required: true, enum: ['decision', 'observation', 'source', 'reversal'] },
      summary: { type: 'string', required: true, description: 'Concise reusable observation or conclusion in the user’s working language.' },
      source: { type: 'string', description: 'Optional source reference, such as a URL, file path or discussion description.' },
      affects: { type: 'array', items: { type: 'string' }, description: 'Affected page ids; omitted uses the destination page, an empty array means none.' },
      evidence: { type: 'string', description: 'Optional supporting excerpt; do not invent verification or user agreement.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainPathResult,
    execute,
  })
}
