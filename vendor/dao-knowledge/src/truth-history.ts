/** Human-only restoration of ordinary page understanding or exact root body bytes through one file publication. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isSeq, type Document } from 'yaml'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { currentKnowledgeFile } from './current-file.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import { readTruthRecords, type TruthChangeRecord } from './truth-records.ts'
import { readRootOperations, rootBody, serializeRootBody } from './root-records.ts'
import type { KnowledgeDocumentId, KnowledgeTruthHistory, KnowledgeTruthRestore, KnowledgeUpdateId } from './types.ts'

const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const requestSchema = z.object({ operationId: uuid,
  expectedVersion: z.string().refine(value => value.trim().length > 0 && !value.includes('\0')), targetOperationId: uuid }).strict()

function bounded(id: KnowledgeDocumentId, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new RemoteError('knowledge/document',
    'Complete ordinary knowledge recovery exceeds the document byte limit', { path: id, reason: 'too-large' })
}

function currentFile(id: KnowledgeDocumentId, text: string, version: string) {
  const file = currentKnowledgeFile(id, text, version)
  return { ...file, changes: readTruthRecords(id, file.source) }
}

/** Read complete ordinary rewrite images without altering current knowledge or manufacturing old backups.
 * @param id - authorized page or fixed root identity.
 * @param text - complete bounded current file.
 * @param version - current location-qualified version.
 * @param maxBytes - inclusive complete serialized result allowance.
 * @returns all retained images; only the latest ordinary body change can offer restoration at this version.
 */
export function readTruthHistory(id: KnowledgeDocumentId, text: string, version: string, maxBytes: number): KnowledgeTruthHistory {
  const file = currentFile(id, text, version)
  const latestOperationId = file.changes.at(-1)?.operationId
  const result: KnowledgeTruthHistory = { documentId: id, version, changes: file.changes.map(change => ({
    operationId: change.operationId, at: change.at, summary: change.summary, source: change.source, evidence: change.evidence,
    before: change.before, after: change.after,
    canRestore: file.document.entry.status !== 'archived' && change.operationId === latestOperationId && file.truth === change.after,
  })) }
  bounded(id, JSON.stringify(result), maxBytes)
  return result
}

/** Restore one retained before-image while retaining all metadata, Timeline rows and a new reversible change.
 * @param id - authorized page or fixed root identity; Goal-only images are never selected.
 * @param text - complete current file read under the writer lock.
 * @param version - location-qualified content version from that read.
 * @param request - retained explicit human choice, displayed version and fresh operation identity.
 * @param now - attempted publication time; identical retries keep their original time.
 * @param maxBytes - inclusive complete request and resulting file allowance.
 * @returns the complete next file, or undefined for an identical already-retained restore even after later edits.
 * @throws for stale versions, superseded or changed understanding, archived pages, missing images or ambiguous receipts.
 */
export function prepareTruthRestore(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeTruthRestore, now: string, maxBytes: number): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  bounded(id, JSON.stringify(request), maxBytes)
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) return refuse('invalid', 'Restore requires an operation UUID, displayed version and retained target UUID')
  const input = parsed.data
  const file = currentFile(id, text, version)
  const digest = createHash('sha256').update(JSON.stringify(['truth-restore', id, input.expectedVersion, input.targetOperationId])).digest('hex')
  const existing = file.changes.find(change => change.operationId === input.operationId)
  if (existing !== undefined) {
    if (existing.restores !== input.targetOperationId || existing.digest !== digest) {
      refuse('identity-conflict', 'Restore operation identity belongs to different retained input')
    }
    return undefined
  }
  const rows = file.source.timeline.value as Record<string, unknown>[] | null
  if (rows?.some(row => row.dsh_operation_id === input.operationId)) refuse('identity-conflict', 'Another knowledge operation owns this restore identity')
  if (file.document.entry.status === 'archived') refuse('read-only', 'Archived knowledge cannot restore ordinary understanding')
  if (version !== input.expectedVersion) refuse('conflict', 'Knowledge changed since the recovery view was read; refresh it')
  const target = file.changes.find(change => change.operationId === input.targetOperationId)
  if (target === undefined) return refuse('invalid', 'This page has no retained ordinary rewrite with that identity')
  if (file.changes.at(-1)?.operationId !== target.operationId) {
    refuse('conflict', 'Later ordinary understanding changed after this rewrite; restoration would overwrite later knowledge')
  }
  if (file.truth !== target.after) refuse('conflict', 'Current understanding changed after this rewrite; restoration would overwrite later knowledge')
  const change: TruthChangeRecord = { operationId: input.operationId, at: now,
    summary: `Restored understanding before ordinary rewrite ${target.operationId}.`,
    source: 'user:knowledge-truth-restore', evidence: `Explicit restoration of retained change ${target.operationId} from ${target.at}.`,
    before: file.truth, after: target.before, digest, restores: target.operationId }
  const timeline: Document = file.source.timeline.document
  if (file.page) {
    /* v8 ignore if -- The retained target requires a unique receipt in this same successfully parsed YAML sequence. */
    if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
    timeline.add({ time: now, kind: 'reversal', summary: change.summary, source: change.source, evidence: change.evidence,
      dsh_operation_id: input.operationId, dsh_request_digest: digest })
  } else {
    const receipts = readRootOperations(id, file.source)
    if (receipts.some(row => row.id === input.operationId)) refuse('identity-conflict', 'Another root operation owns this restore identity')
    file.source.frontmatter.document.set('dsh_root_operations', [...receipts, { id: input.operationId, digest,
      publication: { at: now, summary: change.summary, source: change.source, evidence: change.evidence } }])
  }
  file.source.frontmatter.document.set('updated', now)
  file.source.frontmatter.document.set('dsh_truth_changes', [...file.changes, change])
  const next = file.page
    ? `---\n${file.source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(change.after, timeline.toString({ lineWidth: 0 }))}`
    : serializeRootBody(text, file.source.frontmatter.document, change.after)
  bounded(id, next, maxBytes)
  parseKnowledgeDocument(id, next, version)
  if ((file.page ? knowledgeSource(next, true).truth : rootBody(next)) !== change.after) {
    refuse('invalid', 'Retained before-image cannot be published as the same complete understanding')
  }
  return next
}
