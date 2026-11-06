/** Format-only page repair preserves every byte outside recognized top-level storage markers. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSections } from './source.ts'
import type { KnowledgeDocumentId } from './types.ts'

function knowledgePageFormatEdits(body: string, newline: string) {
  const edits: { start: number; end: number; replacement: string }[] = []
  const { compiled, timeline } = knowledgeSections(body)
  if (compiled !== undefined && body.slice(compiled.start, compiled.end).startsWith('##')) {
    edits.push({ ...compiled, replacement: '<!-- compiled_truth -->' })
  }
  if (timeline !== undefined) {
    if (!timeline.hasComment || timeline.heading === undefined) {
      edits.push({ start: timeline.start, end: timeline.end, replacement: `<!-- timeline -->${newline}${newline}## Timeline` })
    } else if (body.slice(timeline.heading.start, timeline.heading.end) !== '## Timeline') {
      edits.push({ ...timeline.heading, replacement: '## Timeline' })
    }
  }
  return edits
}

/** Inspect recognized top-level page markers without parsing metadata or modifying bytes.
 * @param body - complete stored Markdown body without frontmatter.
 * @returns whether format-only repair would change a legacy marker.
 */
export function hasLegacyKnowledgePageFormat(body: string): boolean {
  return knowledgePageFormatEdits(body, '\n').length > 0
}

/** Replace legacy section markers without rewriting metadata, understanding or timeline evidence.
 * @param id - existing Brain page path; root documents are refused.
 * @param text - complete current file, read while holding its writer lock.
 * @param version - content version for validation.
 * @param maxBytes - inclusive complete output byte limit.
 * @returns repaired file bytes, or undefined when no legacy marker exists.
 * @throws for malformed pages, root documents and oversized replacements.
 */
export function normalizeKnowledgePage(id: KnowledgeDocumentId, text: string, version: string, maxBytes: number): string | undefined {
  const page = parseKnowledgeDocument(id, text, version)
  if (page.entry.kind !== 'page') {
    throw new RemoteError('knowledge/update', 'format normalization accepts pages, not root documents', { path: id, reason: 'read-only' })
  }
  const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
  const prefix = header?.[0] ?? (text.startsWith('\uFEFF') ? '\uFEFF' : '')
  const body = text.slice(prefix.length)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const edits = knowledgePageFormatEdits(body, newline)
  if (edits.length === 0) return undefined
  let result = body
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  result = prefix + result
  if (Buffer.byteLength(result) > maxBytes) {
    throw new RemoteError('knowledge/document', 'normalized page exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  parseKnowledgeDocument(id, result, version)
  return result
}
