/** Whole-body root documents retain bounded retry identities in metadata, not a page Timeline. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ROOT_DOCUMENTS, parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource } from './source.ts'
import { readTruthRecords } from './truth-records.ts'
import { readRootOperations, rootBody, rootWriteDigest, serializeRootBody } from './root-records.ts'
import { canonicalRootBody, canonicalRootTitle } from './root-text.ts'
import type { KnowledgeDocumentId, KnowledgeRootWrite } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const schema = z.object({ operationId: z.uuid(), expectedVersion: nonempty.nullable(), body: nonempty,
  reason: nonempty, source: nonempty, evidence: nonempty }).strict()

/** Inspect a current root's file-owned receipt for one exact canonical write request.
 * @param id - one of the six fixed root filenames.
 * @param text - complete current root file from an authorized bounded read.
 * @param version - location-qualified version observed for these bytes.
 * @param request - complete original canonical write, not a caller-supplied digest.
 * @param maxBytes - complete request byte limit.
 * @returns true only when the file retains the same operation ID and exact request digest; false when absent.
 * @throws for malformed files, invalid input, non-root paths or conflicting operation IDs.
 */
export function hasRootWriteReceipt(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeRootWrite, maxBytes: number): boolean {
  if (Buffer.byteLength(JSON.stringify(request)) > maxBytes) {
    throw new RemoteError('knowledge/document', 'root request exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  if (!schema.safeParse(request).success) {
    throw new RemoteError('knowledge/update', 'root receipt inspection requires the complete original request', { path: id, reason: 'invalid' })
  }
  if (parseKnowledgeDocument(id, text, version).entry.kind !== 'root') {
    throw new RemoteError('knowledge/update', 'root receipts require a fixed Brain root filename', { path: id, reason: 'read-only' })
  }
  const found = readRootOperations(id, knowledgeSource(text, false)).find(row => row.id === request.operationId)
  if (found === undefined) return false
  if (found.digest !== rootWriteDigest(id, request)) {
    throw new RemoteError('knowledge/update', 'root operation identity belongs to different input', { path: id, reason: 'identity-conflict' })
  }
  return true
}

/** Serialize a root initialization or replacement, preserving unknown metadata and prior retry identities.
 * @param id - one of the six fixed Brain root filenames.
 * @param current - complete current file and version, or null for an absent file.
 * @param request - retained whole-body intent; null expectedVersion never replaces an existing document.
 * @param now - publication timestamp, excluded from retry identity.
 * @param maxBytes - inclusive complete request and resulting file byte limit.
 * @param captureRecovery - false for signed Goal publication; ordinary initialization has no invented before-image.
 * @param verbatim - human decisions publish the displayed complete body without canonical title conversion.
 * @returns complete Markdown, or undefined when the same operation was already published.
 * @throws for invalid paths, malformed metadata, stale versions, conflicting identities or byte limits.
 */
export function prepareRootWrite(
  id: KnowledgeDocumentId, current: null, request: KnowledgeRootWrite, now: string, maxBytes: number,
  captureRecovery?: boolean, verbatim?: boolean,
): string
/** Prepare a root publication or recognize an operation already retained in the current file.
 * @param id - fixed root filename.
 * @param current - bounded existing text and version, or null when absent.
 * @param request - retained initialization or replacement intent.
 * @param now - attempted publication timestamp.
 * @param maxBytes - inclusive request and resulting file limit.
 * @param captureRecovery - false only for the signed Goal writer, which owns separate recovery images.
 * @param verbatim - true for human proposal decisions preserving their exact complete body.
 * @returns complete Markdown, or undefined for an identical recorded operation.
 */
export function prepareRootWrite(
  id: KnowledgeDocumentId, current: { text: string; version: string } | null,
  request: KnowledgeRootWrite, now: string, maxBytes: number, captureRecovery?: boolean, verbatim?: boolean,
): string | undefined
export function prepareRootWrite(
  id: KnowledgeDocumentId, current: { text: string; version: string } | null,
  request: KnowledgeRootWrite, now: string, maxBytes: number, captureRecovery = true, verbatim = false,
): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  const root = ROOT_DOCUMENTS.find(path => path === id)
  if (root === undefined) throw new RemoteError('knowledge/document', 'root writes require a fixed Brain root filename', { path: id, reason: 'unsafe-path' })
  const checkSize = (text: string): void => {
    if (Buffer.byteLength(text) > maxBytes) throw new RemoteError('knowledge/document', 'root write exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  checkSize(JSON.stringify(request))
  const parsed = schema.safeParse(request)
  if (!parsed.success) return refuse('invalid', 'root writes require a UUID, explicit version or null, body, reason and complete evidence')
  const input = parsed.data
  const body = input.body.replaceAll('\r\n', '\n').trim()
  if (/^(?:\uFEFF)?---(?:\n|$)/.test(body)) refuse('invalid', 'root body must not include frontmatter')
  const prior = current === null ? null : parseKnowledgeDocument(id, current.text, current.version)
  const source = knowledgeSource(current?.text ?? '', false)
  const receipts = readRootOperations(id, source)
  const digest = rootWriteDigest(id, request, verbatim)
  const receipt = receipts.find(receipt => receipt.id === input.operationId)
  if (receipt !== undefined) {
    if (receipt.digest !== digest) refuse('identity-conflict', 'root operation identity belongs to different input')
    return undefined
  }
  if ((current?.version ?? null) !== input.expectedVersion) refuse('conflict', 'root changed or already exists; read the current document before replacing it')
  if (captureRecovery && prior?.entry.status === 'archived') {
    throw new RemoteError('knowledge/update', 'Archived roots cannot publish ordinary understanding', { path: id, reason: 'read-only' })
  }
  const bodyAfter = canonicalRootBody(id, input.body)
  const title = canonicalRootTitle(id)
  /* v8 ignore if -- The fixed-root check above uses the same six filenames as canonicalRootTitle. */
  if (bodyAfter === null || title === null) return refuse('invalid', 'root writes require a fixed Brain root filename')
  const metadata = source.frontmatter.document
  metadata.set('slug', root.slice(0, -3))
  metadata.set('kind', 'root-page')
  metadata.set('title', title)
  metadata.set('updated', now)
  const after = verbatim ? input.body : `\n${bodyAfter}\n`
  const publication = { at: now, summary: input.reason, source: input.source, evidence: input.evidence }
  metadata.set('dsh_root_operations', [...receipts, { id: input.operationId, digest,
    ...captureRecovery && current !== null ? { publication } : {} }])
  if (captureRecovery && current !== null && rootBody(current.text) !== after) {
    metadata.set('dsh_truth_changes', [...readTruthRecords(id, source), { operationId: input.operationId,
      ...publication, before: rootBody(current.text), after, digest }])
  }
  const text = serializeRootBody(current?.text ?? '', metadata, after)
  checkSize(text)
  parseKnowledgeDocument(id, text, digest)
  return text
}
