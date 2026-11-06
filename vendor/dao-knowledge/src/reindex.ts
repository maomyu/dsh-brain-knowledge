/** Render a portable page catalog; file admission and scan completeness belong to the controller. */
import type { KnowledgeDocument, KnowledgeDocumentId } from './types.ts'
import { normalizeKnowledgeTags } from './tag-values.ts'

/** Render all supplied page lifecycles without importing health reports or project roots.
 * @param pages - complete file snapshots; null documents produce an explicit parse-failure row.
 * @param now - ISO generation time.
 * @returns Markdown sorted by file identity, with first-sentence summaries bounded to 140 characters.
 */
export function renderBrainIndex(pages: readonly {
  id: KnowledgeDocumentId
  document: KnowledgeDocument | null
  truth: string
}[], now: string): string {
  const entries = [...pages].sort((a, b) => a.id < b.id ? -1 : 1).map(({ id, document, truth }) => {
    const slug = id.slice('pages/'.length, -3)
    if (document === null) return `- [${slug}](${id}) | ⚠️ failed to parse`
    const { status, category, tags, title } = document.entry
    const normalized = normalizeKnowledgeTags(tags)
    const metadata = [category === null ? undefined : `category: ${category}`,
      status === 'active' ? undefined : `status: ${status}`, normalized.length === 0 ? undefined : `tags: [${normalized.join(', ')}]`]
      .filter(value => value !== undefined)
    const text = truth.replace(/^(?:<!--\s*compiled_truth\s*-->|##[ \t]+compiled_truth)[ \t]*(?:\n|$)\s*/, '').trim()
    const summary = (/^[^.。\n]{0,140}[.。\n]/.exec(text)?.[0] ?? text.slice(0, 140)).replaceAll('\n', ' ').trim() || title
    return `- [${slug}](${id})${metadata.length === 0 ? '' : ` — ${metadata.join(' | ')}`} | ${summary}`
  })
  return `# Brain Index\n\n_Auto-generated. Last updated ${now}._\n\n${entries.join('\n') || '_(no Pages yet)_'}\n`
}
