/** Fixed root display names and canonical whole-body Markdown shared by Host writes and human review. */
import type { KnowledgeDocumentId } from './types.ts'

const titles = {
  'background.md': 'Background', 'architecture.md': 'Architecture', 'flow.md': 'Key Flows',
  'mindmap.md': 'Feature Mindmap', 'stack.md': 'Tech Stack', 'roadmap.md': 'Roadmap',
} as const

/** Return the fixed title of one recognized Brain root.
 * @param id - root document identity.
 * @returns canonical title, or null for an ordinary page or other file.
 */
export function canonicalRootTitle(id: KnowledgeDocumentId): string | null {
  if (!Object.hasOwn(titles, id)) return null
  return titles[id as keyof typeof titles]
}

/** Project a canonical root write to the exact body displayed by an ordinary read.
 * @param id - recognized root identity.
 * @param input - full authored Markdown sent to the existing canonical root writer.
 * @returns normalized fixed-heading Markdown, or null for a non-root path.
 */
export function canonicalRootBody(id: KnowledgeDocumentId, input: string): string | null {
  const title = canonicalRootTitle(id)
  if (title === null) return null
  const body = input.replaceAll('\r\n', '\n').trim()
  const content = body.replace(/^#[\t ]+[^\n]*(?:\n|$)/, '').trim()
  return `# ${title}\n\n${content}`
}
