/** CommonMark section boundaries and non-executing YAML documents shared by Brain reads and writes. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parseDocument, type Document } from 'yaml'

/** Parse YAML without aliases, duplicate keys or custom tags.
 * @param text - bounded YAML source.
 * @returns the editable syntax tree and its validated plain value.
 */
function yamlSource(text: string) {
  const document = parseDocument(text, { uniqueKeys: true })
  const errors = [...document.errors, ...document.warnings]
  if (errors.length > 0) throw new Error(errors.map(error => error.message).join('; '))
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  return { document, value }
}

function sectionMarkers(body: string) {
  return fromMarkdown(body).children.flatMap((node) => {
    let kind: 'compiled' | 'comment' | 'heading' | undefined
    if (node.type === 'heading' && node.depth === 2 && node.children.length === 1 && node.children[0]?.type === 'text') {
      if (node.children[0].value === 'compiled_truth') kind = 'compiled'
      else if (node.children[0].value.toLowerCase() === 'timeline') kind = 'heading'
    } else if (node.type === 'html') {
      if (/^<!--\s*compiled_truth\s*-->$/.test(node.value.trim())) kind = 'compiled'
      else if (/^<!--\s*timeline\s*-->$/.test(node.value.trim())) kind = 'comment'
    }
    if (kind === undefined) return []
    // MDAST parsed from text has offsets; its type also permits manually constructed nodes.
    const position = node.position as { start: { offset: number }; end: { offset: number } }
    return [{ kind, start: position.start.offset, end: position.end.offset }]
  })
}

/** Locate file-owned sections, excluding fenced and quoted examples.
 * @param body - Markdown without frontmatter, with its original line endings.
 * @returns the first compiled marker and selected history range; an adjacent history heading belongs to storage.
 */
export function knowledgeSections(body: string): {
  compiled: { start: number; end: number } | undefined
  timeline: { start: number; end: number; hasComment: boolean; heading: { start: number; end: number } | undefined } | undefined
} {
  const markers = sectionMarkers(body)
  const compiled = markers.find(marker => marker.kind === 'compiled')
  const candidates = markers.filter(marker => marker.start >= (compiled?.end ?? 0))
  const comment = candidates.find(marker => marker.kind === 'comment')
  const heading = candidates.filter(marker => marker.kind === 'heading').at(-1)
  const selected = compiled === undefined ? comment ?? heading : heading ?? comment
  if (selected === undefined) return { compiled, timeline: undefined }
  let start = selected.start
  let end = selected.end
  let hasComment = selected.kind === 'comment'
  let headingRange = selected.kind === 'heading' ? { start, end } : undefined
  const index = markers.indexOf(selected)
  const adjacent = markers[index + (hasComment ? 1 : -1)]
  if (adjacent !== undefined && (hasComment ? adjacent.kind === 'heading' : adjacent.kind === 'comment')
    && body.slice(Math.min(end, adjacent.end), Math.max(start, adjacent.start)).trim() === '') {
    start = Math.min(start, adjacent.start)
    end = Math.max(end, adjacent.end)
    hasComment = true
    headingRange ??= { start: adjacent.start, end: adjacent.end }
  }
  return { compiled, timeline: { start, end, hasComment, heading: headingRange } }
}

/** Select history by explicit comment for unmarked pages, or the final heading for compiled-marker pages.
 * @param body - Markdown without frontmatter.
 * @returns storage offsets, including its optional visible heading, or undefined for ordinary Markdown.
 */
export function timelineRange(body: string): { start: number; end: number } | undefined {
  return knowledgeSections(body).timeline
}

/** Detect reserved storage markers in caller-supplied understanding; ordinary Timeline headings are allowed.
 * @param truth - authored Markdown only, without page metadata or historical storage.
 * @returns whether a top-level compiled marker or timeline comment is present.
 */
export function hasKnowledgeStorageMarker(truth: string): boolean {
  return sectionMarkers(truth).some(marker => marker.kind !== 'heading')
}

/** Serialize understanding and YAML history with an explicit storage comment.
 * @param truth - retained or validated understanding, including any existing compiled marker.
 * @param timeline - complete serialized YAML, including historical comments and unknown fields.
 * @returns page body; the caller owns frontmatter, byte limits and publication.
 */
export function serializeKnowledgeBody(truth: string, timeline: string): string {
  return `${truth}\n\n<!-- timeline -->\n\n## Timeline\n\n${timeline}`
}

/** Parse a complete bounded Brain file without discarding unknown YAML fields or comments.
 * @param text - complete UTF-8 document.
 * @param page - whether the document has a structured timeline rather than root-only Markdown.
 * @returns syntax trees and separate current-understanding text.
 */
export function knowledgeSource(text: string, page: boolean): {
  frontmatter: ReturnType<typeof yamlSource>
  body: string
  truth: string
  timeline: ReturnType<typeof yamlSource>
} {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  if (normalized.includes('\0')) throw new Error('document contains NUL bytes')
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (normalized.startsWith('---\n') && header === null) throw new Error('frontmatter is not closed')
  const frontmatter = yamlSource(header?.[1] ?? '')
  const body = normalized.slice(header?.[0].length ?? 0).trim()
  const range = page ? timelineRange(body) : undefined
  const timeline = yamlSource(range === undefined ? '' : body.slice(range.end).trim())
  const truth = range === undefined ? body : body.slice(0, range.start).trim()
  return { frontmatter, body, truth, timeline }
}

/** Replace frontmatter while retaining the original BOM, line endings and every body byte.
 * @param text - complete validated document, optionally without frontmatter.
 * @param document - edited YAML syntax tree.
 * @returns complete Markdown with only the frontmatter serialized again.
 */
export function replaceKnowledgeFrontmatter(text: string, document: Document): string {
  const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const newline = header?.[0].includes('\r\n') === true ? '\r\n' : '\n'
  const metadata = document.toString({ lineWidth: 0 }).replaceAll('\n', newline)
  return `${bom}---${newline}${metadata}---${newline}${text.slice(header?.[0].length ?? bom.length)}`
}
