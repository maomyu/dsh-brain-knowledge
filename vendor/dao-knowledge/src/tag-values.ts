/** Ordered topic tags shared by Brain file readers and writers. */
import type { Document } from 'yaml'

/** Normalize the Brain interchange format's ordered, eight-item ASCII tag list.
 * @param values - parsed tags; non-arrays and non-string entries have no tag meaning.
 * @returns unique lowercase hyphenated tags, dropping empty and over-50-character values.
 */
export function normalizeKnowledgeTags(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const tags = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const tag = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (tag.length === 0 || tag.length > 50) continue
    tags.add(tag)
    if (tags.size === 8) break
  }
  return [...tags]
}

/** Store normalized tags in an already parsed page header; empty lists remove the field.
 * @param document - editable frontmatter owned by the admitted page writer.
 * @param tags - normalized tags from the page reader or creation request.
 */
export function setKnowledgeTags(document: Document, tags: readonly string[]): void {
  const fields = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null
  if (tags.length > 0 && JSON.stringify(fields?.tags) === JSON.stringify(tags)) return
  if (tags.length === 0) document.delete('tags')
  else document.set('tags', tags)
}
