/** Archival preserves file-owned understanding and records an optional replacement without deleting either page. */
import { createHash } from 'node:crypto'
import { type Document, isSeq } from 'yaml'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { setKnowledgeTags } from './tag-values.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import type { KnowledgeDocumentId, KnowledgePageArchive } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const schema = z.object({ operationId: z.uuid(), expectedVersion: nonempty,
  supersededBy: nonempty.nullable(), source: nonempty, evidence: nonempty }).strict()
const receiptsSchema = z.array(z.object({ id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  at: nonempty, source: nonempty, evidence: nonempty }).strict())

/** Prepare archival, resolving an optional replacement only for a new operation.
 * @param id - existing Brain page identity; roots are refused.
 * @param text - complete bounded current file.
 * @param version - content version observed while holding the page writer lock.
 * @param request - retained UUID, informing version, replacement selection, user source and evidence.
 * @param now - publication timestamp, excluded from retry identity.
 * @param maxBytes - inclusive complete request and output limit.
 * @param replacementSlug - resolves a readable page in the same project without modifying it.
 * @returns replacement text, or undefined for an identical receipt even after restoration or replacement removal.
 * @throws for malformed receipts, stale input, invalid requests or an unavailable replacement.
 */
export async function preparePageArchive(
  id: KnowledgeDocumentId, text: string, version: string, request: KnowledgePageArchive, now: string, maxBytes: number,
  replacementSlug: (path: KnowledgeDocumentId) => Promise<string>,
): Promise<string | undefined> {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  const checkSize = (value: string): void => {
    if (Buffer.byteLength(value) > maxBytes) {
      throw new RemoteError('knowledge/document', 'knowledge archival exceeds the document byte limit', { path: id, reason: 'too-large' })
    }
  }
  checkSize(JSON.stringify(request))
  const parsed = schema.safeParse(request)
  if (!parsed.success) return refuse('invalid', 'archival requires a UUID, version, explicit replacement or null, and complete evidence')
  const input = parsed.data
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') refuse('read-only', 'root documents do not have a page lifecycle')
  const source = knowledgeSource(text, true)
  const fields = source.frontmatter.value as Record<string, unknown> | null
  const checked = receiptsSchema.safeParse(fields?.dsh_archive_operations ?? [])
  if (!checked.success) return refuse('identity-conflict', 'archive retry metadata is malformed')
  const receipts = checked.data
  if (new Set(receipts.map(row => row.id)).size !== receipts.length) refuse('identity-conflict', 'archive retry identities are ambiguous')
  const digest = createHash('sha256').update(JSON.stringify([
    'archive', id, input.expectedVersion, input.supersededBy, input.source, input.evidence,
  ])).digest('hex')
  const receipt = receipts.find(row => row.id === input.operationId)
  if (receipt !== undefined) {
    if (receipt.digest !== digest) refuse('identity-conflict', 'archive operation identity belongs to different input')
    return undefined
  }
  if (version !== input.expectedVersion) refuse('conflict', 'knowledge changed; read the current page before archiving it')
  let body = source.body
  if (input.supersededBy !== null) {
    const slug = await replacementSlug(input.supersededBy as KnowledgeDocumentId)
    const timeline: Document = source.timeline.document
    if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
    timeline.add({ time: now, kind: 'reversal', summary: `Superseded by [[${slug}]]`,
      source: input.source, evidence: input.evidence, affects: [prior.entry.slug, slug] })
    body = serializeKnowledgeBody(source.truth, timeline.toString({ lineWidth: 0 }).trimEnd())
  }
  const metadata = source.frontmatter.document
  metadata.set('status', 'archived')
  metadata.set('updated', now)
  setKnowledgeTags(metadata, prior.entry.tags)
  metadata.set('dsh_archive_operations', [...receipts, {
    id: input.operationId, digest, at: now, source: input.source, evidence: input.evidence,
  }])
  const result = `---\n${metadata.toString({ lineWidth: 0 })}---\n\n${body}\n`
  checkSize(result)
  parseKnowledgeDocument(id, result, version)
  return result
}
