/** Prepare traceable page replacement; the caller owns file authorization, locking and atomic publication. */
import { createHash } from 'node:crypto'
import { preparePageTimeline, hasPageOperationReceipt } from './page-metadata.ts'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { hasKnowledgeStorageMarker, knowledgeSource, serializeKnowledgeBody } from './source.ts'
import { readTruthRecords } from './truth-records.ts'
import type { KnowledgeDocumentId, KnowledgeTruthUpdate } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const updateSchema = z.object({
  operationId: z.uuid(), expectedVersion: nonempty, truth: nonempty,
  kind: z.enum(['decision', 'observation', 'source', 'reversal', 'evidence']),
  summary: nonempty, source: nonempty, evidence: nonempty,
}).strict()

function validatedTruthUpdate(id: KnowledgeDocumentId, request: KnowledgeTruthUpdate, maxBytes: number) {
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maxBytes) {
    throw new RemoteError('knowledge/document', 'knowledge update exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  const parsed = updateSchema.safeParse(request)
  if (!parsed.success) {
    throw new RemoteError('knowledge/update', 'knowledge updates require an operation UUID, version, truth and complete evidence',
      { path: id, reason: 'invalid' })
  }
  const input = parsed.data
  const truth = input.truth.replaceAll('\r\n', '\n').trim()
  if (hasKnowledgeStorageMarker(truth)) {
    throw new RemoteError('knowledge/update', 'current understanding cannot contain Brain storage markers', { path: id, reason: 'invalid' })
  }
  const digest = createHash('sha256').update(JSON.stringify([
    input.expectedVersion, input.truth, input.kind, input.summary, input.source, input.evidence,
  ])).digest('hex')
  return { input, truth, digest }
}

/** Check one current file's exact ordinary update receipt without constructing a replacement.
 * @param id - validated page identity.
 * @param text - complete current file from the selected project's controlled read.
 * @param version - location-qualified version of those file bytes.
 * @param request - complete original update, not a caller-supplied digest.
 * @param maxBytes - current complete request limit.
 * @returns true only for exactly one Timeline row with matching identity, digest and authored fields; false when absent.
 * @throws for malformed files, invalid requests, roots or conflicting and ambiguous receipts.
 */
export function hasTruthUpdateReceipt(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeTruthUpdate, maxBytes: number): boolean {
  const { input, digest } = validatedTruthUpdate(id, request, maxBytes)
  if (parseKnowledgeDocument(id, text, version).entry.kind !== 'page') {
    throw new RemoteError('knowledge/update', 'root documents do not support page timeline updates', { path: id, reason: 'read-only' })
  }
  const rows = knowledgeSource(text, true).timeline.value as Record<string, unknown>[] | null
  const receipts = rows?.filter(row => row.dsh_operation_id === input.operationId) ?? []
  if (receipts.length === 0) return false
  const row = receipts[0]
  if (receipts.length !== 1 || row?.dsh_request_digest !== digest || row.kind !== input.kind
    || row.summary !== input.summary || row.source !== input.source || row.evidence !== input.evidence) {
    throw new RemoteError('knowledge/update', 'knowledge operation identity already belongs to different or ambiguous history',
      { path: id, reason: 'identity-conflict' })
  }
  return true
}

/** Prepare an existing page's complete next file or recognize an already committed operation.
 * @param id - validated page identity.
 * @param text - complete current file.
 * @param version - file version observed around the read.
 * @param request - caller-retained complete update, including its original version.
 * @param now - publication attempt time; retries retain the committed timeline time.
 * @param maxBytes - inclusive complete request and resulting file byte limit.
 * @param captureRecovery - false only for the signed Goal writer; disables ordinary recovery capture and evidence deduplication.
 * @returns replacement text, or undefined when the identical operation is already in history.
 * @throws for invalid input, stale versions, conflicting identities, archived pages, oversized output or retained duplicate evidence.
 */
export function prepareTruthUpdate(
  id: KnowledgeDocumentId, text: string, version: string, request: KnowledgeTruthUpdate, now: string, maxBytes: number,
  captureRecovery = true,
): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  const { input, truth, digest } = validatedTruthUpdate(id, request, maxBytes)
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') refuse('read-only', 'root documents do not support page timeline updates')
  const source = knowledgeSource(text, true)
  const changes = readTruthRecords(id, source)
  const history = source.timeline.value as Record<string, unknown>[] | null
  if (hasPageOperationReceipt(id, history, input.operationId, digest)) return undefined
  if (prior.entry.status === 'archived') refuse('read-only', 'archived knowledge must be restored before updating its understanding')
  if (version !== input.expectedVersion) refuse('conflict', 'knowledge changed; read the current document before preparing another update')
  if (captureRecovery && source.truth === truth && /^session:[^\s/:]+\/message:[^\s/:]+$/.test(input.source)) {
    const duplicate = changes.at(-1)
    if (duplicate !== undefined && duplicate.restores === undefined && duplicate.after === truth
      && duplicate.summary === input.summary && duplicate.source === input.source && duplicate.evidence === input.evidence
      && history?.some(row => row.dsh_operation_id === duplicate.operationId && row.kind === input.kind)) throw new RemoteError('knowledge/update',
      `Duplicate ordinary knowledge evidence: no write was made. Existing operation ${duplicate.operationId} already retains this unchanged understanding and evidence. `
      + 'Skip this update or reconsider genuinely new evidence; do not retry with another operation UUID.',
      { path: id, reason: 'duplicate', existingOperationId: duplicate.operationId })
  }
  const timeline = preparePageTimeline(source, prior.entry, now)
  timeline.add({ time: now, kind: input.kind, summary: input.summary, source: input.source,
    evidence: input.evidence, dsh_operation_id: input.operationId, dsh_request_digest: digest })
  if (captureRecovery && source.truth !== truth) {
    source.frontmatter.document.set('dsh_truth_changes', [...changes, { operationId: input.operationId,
      at: now, summary: input.summary, source: input.source, evidence: input.evidence,
      before: source.truth, after: truth, digest }])
  }
  const result = `---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(truth, timeline.toString({ lineWidth: 0 }))}`
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    throw new RemoteError('knowledge/document', 'knowledge history and replacement exceed the document byte limit', { path: id, reason: 'too-large' })
  }
  parseKnowledgeDocument(id, result, version)
  return result
}
