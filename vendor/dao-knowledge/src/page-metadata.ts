/** Shared canonical metadata and Timeline receipt handling for existing Brain pages. */
import { isSeq, type Document } from 'yaml'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { setKnowledgeTags } from './tag-values.ts'
import type { knowledgeSource } from './source.ts'
import type { KnowledgeDocumentId, KnowledgeEntry } from './types.ts'

/** Preserve canonical page metadata before adding an owned Timeline entry.
 * @param source - editable source parsed from the current complete page.
 * @param entry - validated metadata from those same bytes.
 * @param now - timestamp for the admitted update.
 * @returns the editable sequence, retaining existing rows and unknown fields.
 */
export function preparePageTimeline(source: ReturnType<typeof knowledgeSource>, entry: KnowledgeEntry, now: string): Document {
  source.frontmatter.document.set('title', entry.title)
  if (!source.frontmatter.document.has('id')) source.frontmatter.document.set('id', entry.slug)
  source.frontmatter.document.set('updated', now)
  setKnowledgeTags(source.frontmatter.document, entry.tags)
  const timeline: Document = source.timeline.document
  if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
  return timeline
}

/** Distinguish an exact retained operation from conflicting or ambiguous history.
 * @param id - page whose Timeline is inspected.
 * @param history - complete parsed Timeline records.
 * @param operationId - incoming retained operation identity.
 * @param digest - digest of the complete incoming request.
 * @returns true only for one matching receipt; false when the identity is absent.
 * @throws when another request or multiple rows own the identity.
 */
export function hasPageOperationReceipt(id: KnowledgeDocumentId, history: Record<string, unknown>[] | null,
  operationId: string, digest: string): boolean {
  const receipts = history?.filter(row => row.dsh_operation_id === operationId) ?? []
  if (receipts.length === 0) return false
  if (receipts.length !== 1 || receipts[0]?.dsh_request_digest !== digest) {
    throw new RemoteError('knowledge/update', 'knowledge operation identity already belongs to different or ambiguous history',
      { path: id, reason: 'identity-conflict' })
  }
  return true
}
