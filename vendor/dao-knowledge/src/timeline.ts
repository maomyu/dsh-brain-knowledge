/** Append general knowledge observations without rewriting understanding or prior history. */
import { createHash } from 'node:crypto'
import { preparePageTimeline } from './page-metadata.ts'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import type { KnowledgeDocumentId, KnowledgeTimelineAppend, KnowledgeUpdateId } from './types.ts'

const textField = z.string().refine(value => !value.includes('\0'))
const requiredText = textField.refine(value => value.trim().length > 0)
const requestSchema = z.object({
  operationId: z.uuid(), expectedVersion: requiredText,
  kind: z.enum(['decision', 'observation', 'source', 'reversal']), summary: requiredText,
  source: textField.optional(), affects: z.array(textField).optional(), evidence: textField.optional(),
}).strict()

function validatedTimelineAppend(id: KnowledgeDocumentId, request: KnowledgeTimelineAppend,
  sessionId: SessionId, maxBytes: number) {
  if (Buffer.byteLength(JSON.stringify({ request, sessionId }), 'utf8') > maxBytes) {
    throw new RemoteError('knowledge/document', 'Timeline entry and history exceed the document byte limit',
      { path: id, reason: 'too-large' })
  }
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) throw new RemoteError('knowledge/update',
    'Timeline append requires an operation UUID, read version, supported kind and nonempty summary',
    { path: id, reason: 'invalid' })
  const input = parsed.data
  const digest = createHash('sha256').update(JSON.stringify([
    'timeline-append', input.expectedVersion, input.kind, input.summary, input.source, input.affects, input.evidence, sessionId,
  ])).digest('hex')
  return { input, digest }
}

/** Inspect one exact append in the current file without preparing or publishing a replacement.
 * @param id - existing Brain page identity.
 * @param text - complete current file from a controlled project read.
 * @param version - location-qualified version of those bytes.
 * @param request - original complete request, including the informing version and operation UUID.
 * @param sessionId - actual original authoring Session, not optional reference text.
 * @param maxBytes - configured complete request and document limit.
 * @returns true only for one matching retained Timeline row; false when its identity is absent.
 * @throws for malformed files, invalid requests, roots, or conflicting and ambiguous identities.
 */
export function hasTimelineAppendReceipt(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeTimelineAppend, sessionId: SessionId, maxBytes: number): boolean {
  const { input, digest } = validatedTimelineAppend(id, request, sessionId, maxBytes)
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') throw new RemoteError('knowledge/update', 'Root documents have no page Timeline',
    { path: id, reason: 'read-only' })
  const rows = knowledgeSource(text, true).timeline.value as Record<string, unknown>[] | null
  const receipts = rows?.filter(row => row.dsh_operation_id === input.operationId) ?? []
  if (receipts.length === 0) return false
  const row = receipts[0]
  const affects = input.affects ?? [prior.entry.slug]
  if (receipts.length !== 1 || row?.dsh_request_digest !== digest || row.dsh_session_id !== sessionId
    || row.kind !== input.kind || row.summary !== input.summary || row.source !== input.source
    || row.evidence !== input.evidence || JSON.stringify(row.affects) !== JSON.stringify(affects)) {
    throw new RemoteError('knowledge/update', 'Timeline identity already belongs to different or ambiguous history',
      { path: id, reason: 'identity-conflict' })
  }
  return true
}

/** Prepare a complete append-only file or recognize a previously committed request.
 * @param id - existing Brain page path; root documents have no Timeline.
 * @param text - complete current file, including unknown metadata and historical fields.
 * @param version - content version observed by the writer.
 * @param request - retained entry, operation UUID and informing read version.
 * @param sessionId - Host-derived authoring conversation, independent of optional reference text.
 * @param now - publication time; an identical retry preserves the committed time.
 * @param maxBytes - inclusive UTF-8 allowance for the complete request and resulting file.
 * @returns next file or undefined for an identical durable receipt, even after later edits.
 * @throws for malformed inputs/files, root documents, conflicting identities, stale versions,
 * exact retained evidence across Sessions or exceeded bounds.
 */
export function prepareTimelineAppend(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeTimelineAppend, sessionId: SessionId, now: string, maxBytes: number): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  const checkSize = (value: string): void => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new RemoteError('knowledge/document',
      'Timeline entry and history exceed the document byte limit', { path: id, reason: 'too-large' })
  }
  const { input, digest } = validatedTimelineAppend(id, request, sessionId, maxBytes)
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') refuse('read-only', 'Root documents have no page Timeline')
  const source = knowledgeSource(text, true)
  const history = source.timeline.value as Record<string, unknown>[] | null
  const receipts = history?.filter(row => row.dsh_operation_id === input.operationId) ?? []
  if (receipts.length > 0) {
    if (receipts.length !== 1 || receipts[0]?.dsh_request_digest !== digest) {
      refuse('identity-conflict', 'Timeline identity already belongs to different or ambiguous history')
    }
    return undefined
  }
  if (version !== input.expectedVersion) refuse('conflict', 'Knowledge changed; read the page again before appending to its Timeline')
  const affects = input.affects ?? [prior.entry.slug]
  const duplicate = history?.find(row => typeof row.dsh_operation_id === 'string'
    && z.uuid().safeParse(row.dsh_operation_id).success
    && typeof row.dsh_request_digest === 'string' && /^[a-f0-9]{64}$/.test(row.dsh_request_digest)
    && row.kind === input.kind && row.summary === input.summary && row.source === input.source
    && row.evidence === input.evidence && JSON.stringify(row.affects) === JSON.stringify(affects))
  if (duplicate !== undefined) {
    const existingOperationId = duplicate.dsh_operation_id as KnowledgeUpdateId
    throw new RemoteError('knowledge/update',
      `Duplicate Timeline evidence: no write was made. Existing operation ${existingOperationId} retains this entry. `
      + 'Skip it or provide genuinely new evidence; do not retry with another operation UUID.',
      { path: id, reason: 'duplicate', existingOperationId })
  }
  const timeline = preparePageTimeline(source, prior.entry, now)
  timeline.add({ time: now, kind: input.kind, summary: input.summary,
    ...input.source === undefined ? {} : { source: input.source },
    affects, ...input.evidence === undefined ? {} : { evidence: input.evidence },
    dsh_session_id: sessionId, dsh_operation_id: input.operationId, dsh_request_digest: digest })
  const next = `---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(source.truth, timeline.toString({ lineWidth: 0 }))}`
  checkSize(next)
  parseKnowledgeDocument(id, next, version)
  return next
}
