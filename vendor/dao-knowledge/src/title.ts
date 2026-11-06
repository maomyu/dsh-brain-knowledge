/** Version-checked page display names do not rename files or rewrite knowledge. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource, replaceKnowledgeFrontmatter } from './source.ts'
import { setKnowledgeTags } from './tag-values.ts'
import type { KnowledgeDocumentId, KnowledgePageTitleUpdate } from './types.ts'

const requestSchema = z.object({ expectedVersion: z.string().min(1), title: z.string().trim().min(1) }).strict()

/** Update a page title and metadata time without changing its body or Timeline.
 * @param id - existing page identity; roots are refused.
 * @param text - complete validated file read under the writer lock.
 * @param version - current location-qualified file version.
 * @param request - display name and informing read version.
 * @param now - timestamp used only for a changed title.
 * @param maxBytes - inclusive complete request and resulting file byte cap.
 * @returns replacement bytes, or undefined when the exact trimmed title is already stored.
 * @throws for invalid input, stale differing titles, roots or oversized output.
 */
export function preparePageTitle(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgePageTitleUpdate, now: string, maxBytes: number): string | undefined {
  const bounded = (value: string): void => {
    if (Buffer.byteLength(value) > maxBytes) {
      throw new RemoteError('knowledge/document', 'knowledge title exceeds the document byte limit', { path: id, reason: 'too-large' })
    }
  }
  bounded(JSON.stringify(request))
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success || parsed.data.title.includes('\0')) {
    throw new RemoteError('knowledge/update', 'title updates require a version and non-empty title without NUL bytes', { path: id, reason: 'invalid' })
  }
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') {
    throw new RemoteError('knowledge/update', 'root documents do not have page titles', { path: id, reason: 'read-only' })
  }
  const frontmatter = knowledgeSource(text, true).frontmatter.document
  if (frontmatter.get('title') === parsed.data.title) return undefined
  if (version !== parsed.data.expectedVersion) {
    throw new RemoteError('knowledge/update', 'knowledge changed; read the page before changing its title', { path: id, reason: 'conflict' })
  }
  frontmatter.set('title', parsed.data.title)
  frontmatter.set('updated', now)
  setKnowledgeTags(frontmatter, prior.entry.tags)
  const next = replaceKnowledgeFrontmatter(text, frontmatter)
  bounded(next)
  parseKnowledgeDocument(id, next, version)
  return next
}
