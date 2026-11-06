/** Metadata-only Brain tag normalization and version-checked publication bytes. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource, replaceKnowledgeFrontmatter } from './source.ts'
import { normalizeKnowledgeTags, setKnowledgeTags } from './tag-values.ts'
import type { KnowledgeDocumentId, KnowledgePageTagsUpdate } from './types.ts'

const requestSchema = z.object({ expectedVersion: z.string().min(1), tags: z.array(z.string()) }).strict()

/** Replace only tags and update time while preserving every byte after the frontmatter.
 * @param id - existing page identity; root documents are refused.
 * @param text - complete bounded document read under the writer lock.
 * @param version - current selected-location-qualified content version.
 * @param request - replacement list and version observed by the caller.
 * @param now - timestamp used only when metadata changes.
 * @param maxBytes - inclusive serialized request and resulting file byte cap.
 * @returns replacement bytes, or undefined when the exact normalized tags are already present.
 * @throws for invalid requests/pages, stale differing tags, roots or oversized output.
 */
export function preparePageTags(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgePageTagsUpdate, now: string, maxBytes: number): string | undefined {
  const bounded = (value: string): void => {
    if (Buffer.byteLength(value) > maxBytes) {
      throw new RemoteError('knowledge/document', 'knowledge tags exceed the document byte limit', { path: id, reason: 'too-large' })
    }
  }
  bounded(JSON.stringify(request))
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) {
    throw new RemoteError('knowledge/update', 'tag updates require a version and complete string list', { path: id, reason: 'invalid' })
  }
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') {
    throw new RemoteError('knowledge/update', 'root documents do not have page tags', { path: id, reason: 'read-only' })
  }
  const tags = normalizeKnowledgeTags(parsed.data.tags)
  const source = knowledgeSource(text, true)
  const frontmatter = source.frontmatter.document
  const rawTags = (source.frontmatter.value as Record<string, unknown> | null)?.tags
  if (tags.length === 0 ? !frontmatter.has('tags') : JSON.stringify(rawTags) === JSON.stringify(tags)) return undefined
  if (version !== parsed.data.expectedVersion) {
    throw new RemoteError('knowledge/update', 'knowledge changed; read the page before changing tags', { path: id, reason: 'conflict' })
  }
  setKnowledgeTags(frontmatter, tags)
  frontmatter.set('updated', now)
  const next = replaceKnowledgeFrontmatter(text, frontmatter)
  bounded(next)
  parseKnowledgeDocument(id, next, version)
  return next
}
