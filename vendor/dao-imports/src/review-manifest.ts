/** Exact Brain tool calls proposed for one human review. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KnowledgeImportApprovedChange, KnowledgeImportComparedPageChoice, KnowledgeImportReviewChange,
  KnowledgeImportSourceDispositionChoice } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const page = z.string().regex(/^pages\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u)
const root = z.enum(['background.md', 'architecture.md', 'flow.md', 'mindmap.md', 'stack.md', 'roadmap.md'])
const document = z.union([page, root])
const project = z.string().min(1)
const version = z.string().min(1)
const operation = z.uuid()
const text = z.string().min(1)
const kind = z.enum(['decision', 'observation', 'source', 'reversal', 'evidence'])
const target = { target_project_id: project }
const existingPage = { ...target, path: page, operation_id: operation, expected_version: version }
const laterUserQuote = new Set(['brain_update_truth', 'brain_create_page', 'brain_set_page_status',
  'brain_write_root', 'brain_archive_page'])

/** Identify reviewed calls whose actual execution must cite one later user-authored message.
 * @param tool - dispatched Brain tool name.
 * @returns whether the execution schema requires an evidence quote outside the reviewed arguments.
 */
export function requiresLaterUserQuote(tool: string): boolean { return laterUserQuote.has(tool) }

/** A health finding has no target_project_id in its tool schema, so it cannot receive exact import approval. */
const argumentsByTool = {
  brain_append_timeline: z.object({ ...existingPage, kind: kind.exclude(['evidence']), summary: text,
    source: z.string().optional(), affects: z.array(z.string()).optional(), evidence: z.string().optional() }).strict(),
  brain_update_truth: z.object({ ...existingPage, truth: text, kind, summary: text }).strict(),
  brain_propose_truth: z.object({ ...target, path: document, operation_id: operation, expected_version: version,
    truth: text, summary: text, evidence: text }).strict(),
  brain_create_page: z.object({ ...target, path: page, operation_id: operation, title: text,
    status: z.enum(['draft', 'active', 'archived']), category: z.enum(['project', 'concept', 'decision', 'person', 'reference']),
    tags: z.array(z.string()), truth: text, kind, summary: text }).strict(),
  brain_set_page_status: z.object({ ...existingPage, status: z.enum(['draft', 'active']), reason: text,
  }).strict(),
  brain_write_root: z.object({ ...target, path: root, operation_id: operation,
    expected_version: version.nullable(), body: text, reason: text }).strict(),
  brain_archive_page: z.object({ ...existingPage, superseded_by: page.nullable() }).strict(),
  brain_normalize_page_format: z.object({ ...target, paths: z.array(page).min(1) }).strict(),
  brain_set_page_tags: z.object({ ...target, path: page, expected_version: version, tags: z.array(z.string()) }).strict(),
  brain_update_page_title: z.object({ ...target, path: page, expected_version: version, title: text }).strict(),
  brain_reindex: z.object(target).strict(),
} as const

/** Compact exact field inventory for the logged review prompt; optional fields carry `?`.
 * @returns one semicolon-separated inventory of allowed Brain calls.
 */
export function reviewToolArgumentGuide(): string {
  return Object.entries(argumentsByTool).map(([tool, schema]) => {
    const fields = Object.entries(schema.shape as Record<string, z.ZodType>)
      .map(([name, field]) => `${name}${field.safeParse(undefined).success ? '?' : ''}`)
    return `${tool}(${fields.join(', ')})`
  }).join('; ')
}

/** Supply parseable examples without inventing source evidence or approval for the actual import.
 * @param format - frozen proposal format whose envelope and evidence fields the examples use.
 * @returns separate draft-creation and absent-root examples; their synthetic values must be replaced after reading.
 */
export function reviewProposalExamples(format: ReviewFormat): readonly string[] {
  const source = { document_id: 'example-source', quote: 'Example source statement.' }
  const evidence = { sources: [source], compared_pages: [],
    ...format === 'brain-review-json-v6' ? { source_dispositions: [{ ...source, disposition: 'current',
      rationale: 'The example source states this example fact.' }] } : {} }
  const examples = [
    { tool: 'brain_create_page', arguments: { target_project_id: 'example-project', path: 'pages/example-topic.md',
      operation_id: '11111111-1111-4111-8111-111111111111', title: 'Example topic', status: 'draft',
      category: 'reference', tags: [], truth: '# Example topic\n\nExample source statement.', kind: 'source',
      summary: 'Retain the example statement for review.' } },
    { tool: 'brain_write_root', arguments: { target_project_id: 'example-project', path: 'background.md',
      operation_id: '22222222-2222-4222-8222-222222222222', expected_version: null,
      body: '# Background\n\nExample source statement.', reason: 'Initialize the absent example root.' } },
  ]
  return examples.map(change => JSON.stringify({ changes: [{ ...change,
    ...format === 'brain-review-json-v1' ? {} : { evidence } }],
  ...format === 'brain-review-json-v5' || format === 'brain-review-json-v6' ? { discovery: [] } : {} }))
}

const legacyEnvelope = z.object({ changes: z.array(z.object({
  tool: z.string(), arguments: z.record(z.string(), z.unknown()),
}).strict()) }).strict()
const sourceEvidence = z.object({ document_id: z.string().min(1), quote: z.string().min(1) }).strict()
const comparedPage = z.object({ target_project_id: project, path: document, version,
  relation: z.enum(['duplicate', 'conflict', 'supports', 'supersedes']) }).strict()
const evidenceSchema = z.object({ sources: z.array(sourceEvidence).min(1), compared_pages: z.array(comparedPage) }).strict()
const evidenceSchemaV3 = z.object({ sources: z.array(sourceEvidence).min(1),
  compared_pages: z.array(comparedPage.extend({ quote: z.string().optional() })) }).strict()
const sourceDisposition = z.object({ document_id: z.string().min(1),
  disposition: z.enum(['current', 'superseded', 'unresolved', 'not-relevant']),
  quote: z.string().min(1), rationale: z.string().min(1) }).strict()
const evidenceSchemaV6 = evidenceSchemaV3.extend({ source_dispositions: z.array(sourceDisposition).optional() })
const evidenceEnvelope = z.object({ changes: z.array(z.object({
  tool: z.string(), arguments: z.record(z.string(), z.unknown()),
  evidence: evidenceSchema,
}).strict()) }).strict()
const evidenceEnvelopeV3 = z.object({ changes: z.array(z.object({
  tool: z.string(), arguments: z.record(z.string(), z.unknown()),
  evidence: evidenceSchemaV3,
}).strict()) }).strict()
const discoveryDeclaration = z.discriminatedUnion('mode', [
  z.object({ change_index: z.number().int().min(0), mode: z.literal('search'), query: z.string().trim().min(1) }).strict(),
  z.object({ change_index: z.number().int().min(0), mode: z.literal('empty-index') }).strict(),
])
const evidenceEnvelopeV5 = evidenceEnvelopeV3.extend({ discovery: z.array(discoveryDeclaration) })
const evidenceEnvelopeV6 = z.object({ changes: z.array(z.object({ tool: z.string(),
  arguments: z.record(z.string(), z.unknown()), evidence: evidenceSchemaV6 }).strict()),
discovery: z.array(discoveryDeclaration) }).strict()

/** Model-declared v5/v6 discovery choice; search hits are never accepted from model JSON. */
export type ReviewDiscoveryDeclaration = z.infer<typeof discoveryDeclaration>

/** Frozen review protocol on the import record; absent means legacy v1. */
export type ReviewFormat = 'brain-review-json-v1' | 'brain-review-json-v2' | 'brain-review-json-v3' | 'brain-review-json-v4' | 'brain-review-json-v5' | 'brain-review-json-v6'

/** A proposed active page cannot resolve a relationship the model itself reports as duplicate or conflicting.
 * @param changes - exact model-proposed Brain calls and their cited page relationships.
 * @returns whether any new active page has an unresolved self-declared overlap.
 */
export function hasSelfDeclaredActiveOverlap(changes: readonly KnowledgeImportReviewChange[]): boolean {
  return changes.some(change => change.tool === 'brain_create_page' && change.arguments.status === 'active'
    && change.evidence?.compared_pages.some(page => page.relation === 'duplicate' || page.relation === 'conflict'))
}

/** A truth update cannot resolve its own reported overlap with a different Brain document.
 * @param changes - exact model-proposed Brain calls and compared documents.
 * @returns whether a truth update names another document as duplicate or conflicting.
 */
export function hasSelfDeclaredUpdateOverlap(changes: readonly KnowledgeImportReviewChange[]): boolean {
  return changes.some(change => change.tool === 'brain_update_truth'
    && change.evidence?.compared_pages.some(page => (page.relation === 'duplicate' || page.relation === 'conflict')
      && (page.target_project_id !== change.arguments.target_project_id || page.path !== change.arguments.path)))
}

/** A fixed-root body write cannot resolve its own reported overlap with another Brain document.
 * @param changes - exact model-proposed Brain calls and compared documents.
 * @returns whether a root write names another document as duplicate or conflicting.
 */
export function hasSelfDeclaredRootOverlap(changes: readonly KnowledgeImportReviewChange[]): boolean {
  return changes.some(change => change.tool === 'brain_write_root'
    && change.evidence?.compared_pages.some(page => (page.relation === 'duplicate' || page.relation === 'conflict')
      && (page.target_project_id !== change.arguments.target_project_id || page.path !== change.arguments.path)))
}

/** Activating an archived page cannot resolve its own reported overlap with another Brain document.
 * @param changes - exact model-proposed Brain calls and compared documents.
 * @returns whether an active status change names another document as duplicate or conflicting.
 */
export function hasSelfDeclaredStatusOverlap(changes: readonly KnowledgeImportReviewChange[]): boolean {
  return changes.some(change => change.tool === 'brain_set_page_status' && change.arguments.status === 'active'
    && change.evidence?.compared_pages.some(page => (page.relation === 'duplicate' || page.relation === 'conflict')
      && (page.target_project_id !== change.arguments.target_project_id || page.path !== change.arguments.path)))
}

/** Identify writes that require a decision for every selected import source.
 * @param change - proposed Brain operation.
 * @returns whether v6 must account for every selected source before publishing active knowledge.
 */
export function needsSourceDisposition(change: KnowledgeImportReviewChange): boolean {
  return change.tool === 'brain_update_truth' || change.tool === 'brain_write_root'
    || change.tool === 'brain_append_timeline'
    || change.tool === 'brain_create_page' && change.arguments.status === 'active'
    || change.tool === 'brain_set_page_status' && change.arguments.status === 'active'
}

function sortJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('review arguments exceed nesting limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => sortJson(item, depth + 1))
  if (typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('review arguments must be JSON values')
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1
    /* v8 ignore else -- Object.entries keys are unique; Array.sort still requires equality to return zero. */
    if (left > right) return 1
    else return 0
  })
    .map(([key, item]) => [key, sortJson(item, depth + 1)]))
}

/** Canonical JSON ignores object-key order but preserves all argument values and array order.
 * @param value - complete JSON-compatible value to canonicalize.
 * @returns JSON text with sorted object keys.
 */
export function canonicalReviewJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

/** Digest one exact tool name and its complete parsed argument object.
 * @param tool - reviewed Brain tool name.
 * @param args - complete validated Brain arguments.
 * @returns SHA-256 digest of the canonical call.
 */
export function reviewChangeSha256(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalReviewJson({ tool, arguments: args })).digest('hex')
}

/** Remove only the later user confirmation quote from an actual model call before exact comparison.
 * @param tool - dispatched Brain tool name.
 * @param args - complete dispatched arguments.
 * @returns reviewed arguments or null when a required confirmation quote is missing.
 */
export function reviewExecutionArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
  if (!requiresLaterUserQuote(tool)) return args
  if (typeof args.evidence_quote !== 'string' || args.evidence_quote.trim().length === 0) return null
  const reviewed = { ...args }
  delete reviewed.evidence_quote
  return reviewed
}

/** Digest an ordered list of complete reviewed tool calls.
 * @param changes - reviewed calls in execution order.
 * @returns SHA-256 digest of their ordered call digests.
 */
export function reviewChangesSha256(changes: readonly Pick<KnowledgeImportReviewChange, 'sha256'>[]): string {
  return createHash('sha256').update(canonicalReviewJson(changes.map(change => change.sha256))).digest('hex')
}

/** Enumerate exact active-creation comparisons; user judgments start unknown and cannot be inferred from model labels.
 * @param changes - current Host-verified proposal changes.
 * @returns compared-page identities with unknown user relations.
 */
export function comparedPageChoices(changes: readonly KnowledgeImportReviewChange[]): KnowledgeImportComparedPageChoice[] {
  return changes.flatMap((change, changeIndex) => change.tool === 'brain_create_page'
    && change.arguments.status === 'active'
    ? (change.evidence?.compared_pages ?? []).map((page, pageIndex) => ({
      changeIndex, pageIndex, changeSha256: change.sha256, targetProjectId: page.target_project_id,
      path: page.path, version: page.version,
      pageSha256: createHash('sha256').update(canonicalReviewJson(page)).digest('hex'),
      relation: 'unknown' as const,
    })) : [])
}

/** Digest ordered page identities and human relations for optimistic review and approval.
 * @param choices - complete ordered compared-page decisions.
 * @returns SHA-256 digest of the choices.
 */
export function comparedPageReviewSha256(choices: readonly KnowledgeImportComparedPageChoice[]): string {
  return createHash('sha256').update(canonicalReviewJson(choices)).digest('hex')
}

/** Require one exact judgment for every compared page in an active creation.
 * @param changes - current Host-verified proposal changes.
 * @param choices - persisted user decisions to check.
 * @returns whether every compared-page identity still matches exactly.
 */
export function sameComparedPageChoices(changes: readonly KnowledgeImportReviewChange[],
  choices: readonly KnowledgeImportComparedPageChoice[]): boolean {
  const expected = comparedPageChoices(changes)
  return expected.length === choices.length && expected.every((page, index) => {
    const chosen = choices[index]
    return chosen !== undefined && chosen.changeIndex === page.changeIndex && chosen.pageIndex === page.pageIndex
      && chosen.changeSha256 === page.changeSha256 && chosen.targetProjectId === page.targetProjectId
      && chosen.path === page.path && chosen.version === page.version && chosen.pageSha256 === page.pageSha256
  })
}

/** Start each source's human judgment unknown without inheriting its model classification.
 * @param changes - exact proposed Brain operations.
 * @returns ordered source identities with digests of complete quoted assessments.
 */
export function sourceDispositionChoices(changes: readonly KnowledgeImportReviewChange[]): KnowledgeImportSourceDispositionChoice[] {
  return changes.flatMap((change, changeIndex) => needsSourceDisposition(change)
    ? (change.evidence?.source_dispositions ?? []).map((item, sourceIndex) => ({
      changeIndex, sourceIndex, changeSha256: change.sha256, documentId: item.document_id,
      dispositionSha256: createHash('sha256').update(canonicalReviewJson(item)).digest('hex'),
      judgment: 'unknown' as const,
    })) : [])
}

/** Bind the ordered human source decisions to their exact selected inputs.
 * @param choices - complete ordered human source judgments.
 * @returns SHA-256 digest binding source identities and decisions.
 */
export function sourceDispositionReviewSha256(choices: readonly KnowledgeImportSourceDispositionChoice[]): string {
  return createHash('sha256').update(canonicalReviewJson(choices)).digest('hex')
}

/** Compare retained source decisions against the complete current proposal.
 * @param changes - current exact proposal.
 * @param choices - stored judgments to validate against it.
 * @returns whether every source identity, quote, disposition, and rationale still matches.
 */
export function sameSourceDispositionChoices(changes: readonly KnowledgeImportReviewChange[],
  choices: readonly KnowledgeImportSourceDispositionChoice[]): boolean {
  const expected = sourceDispositionChoices(changes)
  return expected.length === choices.length && expected.every((source, index) => {
    const chosen = choices[index]
    return chosen !== undefined && chosen.changeIndex === source.changeIndex && chosen.sourceIndex === source.sourceIndex
      && chosen.changeSha256 === source.changeSha256 && chosen.documentId === source.documentId
      && chosen.dispositionSha256 === source.dispositionSha256
  })
}

/** Retain target identifiers and digests without copying proposed body text into import storage.
 * @param change - complete reviewed Brain call.
 * @returns durable approval fields for the call.
 */
export function approvedChange(change: KnowledgeImportReviewChange): KnowledgeImportApprovedChange {
  const args = change.arguments
  return { tool: change.tool, targetProjectId: args.target_project_id as WorkspaceId,
    path: (args.path ?? args.paths ?? 'index.md') as string | string[], sha256: change.sha256 }
}

interface ReviewLimits {
  maxReviewChanges: number
  maxReviewJsonBytes: number
  maxEvidenceQuoteBytes: number
  maxEvidenceSourcesPerChange: number
  maxComparedPagesPerChange: number
}

function decodedReviewBlock(text: string, limits: ReviewLimits, format: ReviewFormat): { value: unknown } | null {
  const openings = [...text.matchAll(/^```brain-review-json-v[123456][ \t]*\r?$/gmu)]
  if (openings.length !== 1) return null
  const block = new RegExp(`(?:^|\\n)\`\`\`${format}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*$`, 'u').exec(text)
  if (block === null || block[1] === undefined || Buffer.byteLength(block[1], 'utf8') > limits.maxReviewJsonBytes) return null
  try { return { value: JSON.parse(block[1]) } } catch { return null }
}

/** Parse only model-declared v5/v6 discovery queries; actual hits come from retained tool results.
 * @param text - settled proposal text containing the sole matching review block.
 * @param limits - complete JSON byte allowance shared with review changes.
 * @returns declarations in proposal order, or null for malformed JSON.
 */
export function parseReviewDiscovery(text: string, limits: ReviewLimits): readonly ReviewDiscoveryDeclaration[] | null {
  const decoded = decodedReviewBlock(text, limits, 'brain-review-json-v6')
    ?? decodedReviewBlock(text, limits, 'brain-review-json-v5')
  const parsed = decoded === null ? null : (decodedReviewBlock(text, limits, 'brain-review-json-v6') === null
    ? evidenceEnvelopeV5 : evidenceEnvelopeV6).safeParse(decoded.value)
  return parsed?.success ? parsed.data.discovery : null
}

/** Parse the sole final review block and validate every exact tool argument before approval.
 * @param text - settled proposal text containing a review block.
 * @param limits - review-size and evidence limits.
 * @param isProjectId - checks whether a target project ID is available.
 * @param format - frozen review format for this import.
 * @returns exact parsed changes, or null when the proposal is invalid.
 */
export function parseReviewManifest(text: string, limits: ReviewLimits,
  isProjectId: (id: string) => boolean, format: ReviewFormat = 'brain-review-json-v1'): KnowledgeImportReviewChange[] | null {
  const decoded = decodedReviewBlock(text, limits, format)
  if (decoded === null) return null
  const parsed = (format === 'brain-review-json-v6' ? evidenceEnvelopeV6
    : format === 'brain-review-json-v5' ? evidenceEnvelopeV5
      : format === 'brain-review-json-v3' || format === 'brain-review-json-v4' ? evidenceEnvelopeV3
        : format === 'brain-review-json-v2' ? evidenceEnvelope : legacyEnvelope).safeParse(decoded.value)
  if (!parsed.success || parsed.data.changes.length === 0 || parsed.data.changes.length > limits.maxReviewChanges) return null
  const changes: KnowledgeImportReviewChange[] = []
  const checkedChanges: readonly (z.infer<typeof legacyEnvelope>['changes'][number]
    & { evidence?: z.infer<typeof evidenceSchemaV6> })[] = parsed.data.changes
  for (const change of checkedChanges) {
    if (!(change.tool in argumentsByTool)) return null
    const schema = argumentsByTool[change.tool as keyof typeof argumentsByTool]
    const args = schema.safeParse(change.arguments)
    if (!args.success || !isProjectId(args.data.target_project_id)) return null
    const evidence = change.evidence
    const dispositions = evidence?.source_dispositions
    if (evidence !== undefined) {
      if (evidence.sources.length > limits.maxEvidenceSourcesPerChange
        || evidence.compared_pages.length > limits.maxComparedPagesPerChange
        || evidence.sources.some(source => source.quote.trim().length === 0
          || Buffer.byteLength(source.quote, 'utf8') > limits.maxEvidenceQuoteBytes)
        || evidence.compared_pages.some(compared => !isProjectId(compared.target_project_id)
          || 'quote' in compared && typeof compared.quote === 'string'
            && Buffer.byteLength(compared.quote, 'utf8') > limits.maxEvidenceQuoteBytes)
        || dispositions?.some(item =>
          item.quote.trim().length === 0 || item.rationale.trim().length === 0
            || Buffer.byteLength(item.quote, 'utf8') > limits.maxEvidenceQuoteBytes
            || Buffer.byteLength(item.rationale, 'utf8') > limits.maxEvidenceQuoteBytes)) return null
    }
    // JSON.parse supplied the complete tree; strict tool schemas above checked its fields.
    const arguments_ = args.data as Record<string, JsonValue>
    changes.push({ tool: change.tool, arguments: arguments_, sha256: reviewChangeSha256(change.tool, arguments_),
      ...evidence === undefined ? {} : { evidence: {
        sources: evidence.sources.map(source => ({ ...source,
          document_id: brandString<DocumentImportSourceId>(source.document_id) })),
        ...dispositions === undefined ? {} : { source_dispositions: dispositions.map(item => ({ ...item,
          document_id: brandString<DocumentImportSourceId>(item.document_id) })) },
        compared_pages: evidence.compared_pages.map(({ quote, ...compared }) => ({ ...compared,
          target_project_id: brandString<WorkspaceId>(compared.target_project_id),
          ...quote === undefined ? {} : { quote } })),
      } } })
  }
  return changes
}
