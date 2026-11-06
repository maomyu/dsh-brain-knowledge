/** Append attributed Goal decisions while preserving current understanding and prior history. */
import { createHash } from 'node:crypto'
import { type Document, isSeq } from 'yaml'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import type { KnowledgeDocumentId, KnowledgeGoalDecision } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const decisionSchema = z.object({ operationId: z.uuid(), expectedVersion: nonempty, summary: nonempty, evidence: nonempty }).strict()

/** Validate intent before a guardrail failure can become a durable refusal.
 * @param id - requested knowledge path.
 * @param request - untrusted write intent.
 * @returns after validating the retained identity and required content.
 */
export function validateGoalDecision(id: KnowledgeDocumentId, request: KnowledgeGoalDecision): void {
  if (!decisionSchema.safeParse(request).success) throw new RemoteError('knowledge/update',
    'Goal decisions require an operation UUID, read version, summary and supporting evidence', { path: id, reason: 'invalid' })
}

/** Prepare one append-only decision or recognize its durable retry receipt.
 * @param id - authorized existing page path.
 * @param text - complete current file, including unknown metadata and historical fields.
 * @param version - content version observed by the writer.
 * @param request - retained decision and informing read version.
 * @param attribution - Host-derived run source and approved master route; never model-supplied identities.
 * @param now - publication attempt time, retained by committed retries.
 * @param maxBytes - inclusive request and complete resulting file allowance.
 * @returns the next file, or undefined for an identical retained operation.
 */
export function prepareGoalDecision(
  id: KnowledgeDocumentId, text: string, version: string, request: KnowledgeGoalDecision,
  attribution: { source: string; author: string }, now: string, maxBytes: number,
): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  const checkSize = (value: string): void => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new RemoteError('knowledge/document', 'Goal decision exceeds the document byte limit', { path: id, reason: 'too-large' })
    }
  }
  checkSize(JSON.stringify({ request, attribution }))
  validateGoalDecision(id, request)
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') refuse('read-only', 'Goal decisions require an existing decision page, not a root document')
  const source = knowledgeSource(text, true)
  const digest = createHash('sha256').update(JSON.stringify([
    'goal-decision', request.expectedVersion, request.summary, request.evidence, attribution.source, attribution.author,
  ])).digest('hex')
  const history = source.timeline.value as Record<string, unknown>[] | null
  const receipts = history?.filter(row => row.dsh_operation_id === request.operationId) ?? []
  if (receipts.length > 0) {
    if (receipts.length !== 1 || receipts[0]?.dsh_request_digest !== digest) {
      refuse('identity-conflict', 'Goal decision identity already belongs to different or ambiguous history')
    }
    return undefined
  }
  if (prior.entry.status !== 'active' || prior.entry.category !== 'decision') {
    refuse('read-only', 'Goal decisions can only be appended to active decision pages')
  }
  if (version !== request.expectedVersion) refuse('conflict', 'knowledge changed; read the page again before recording a decision')
  source.frontmatter.document.set('title', prior.entry.title)
  if (!source.frontmatter.document.has('id')) source.frontmatter.document.set('id', prior.entry.slug)
  source.frontmatter.document.set('updated', now)
  const timeline: Document = source.timeline.document
  if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
  timeline.add({ time: now, kind: 'decision', summary: request.summary, ...attribution, affects: [prior.entry.slug],
    evidence: request.evidence, dsh_operation_id: request.operationId, dsh_request_digest: digest })
  const next = `---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(source.truth, timeline.toString({ lineWidth: 0 }))}`
  checkSize(next)
  parseKnowledgeDocument(id, next, version)
  return next
}
