/** Literal all-token matching over validated knowledge source, excluding internal metadata. */
import { isMap, isNode, isScalar } from 'yaml'
import { knowledgeSource } from './source.ts'
import type { KnowledgeEntry, KnowledgeSearchHit, KnowledgeSearchRequest } from './types.ts'

function searchableSource(source: string, page: boolean): string {
  const normalized = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const fields = knowledgeSource(normalized, page).frontmatter.document.contents
  if (!isMap(fields)) return normalized
  let searchable = normalized
  for (const pair of fields.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.key.value.startsWith('dsh_')) continue
    // These ranges belong to nodes parsed from the complete validated frontmatter, not constructed YAML.
    const start = pair.key.range[0]
    const end = isNode(pair.value) ? pair.value.range[2] : undefined
    if (end === undefined) throw new Error('Knowledge history metadata has no parsed source range')
    const offset = '---\n'.length
    searchable = searchable.slice(0, offset + start) + searchable.slice(offset + start, offset + end).replace(/[^\n]/g, ' ')
      + searchable.slice(offset + end)
  }
  return searchable
}

/** Retain the first matching source lines with one surrounding line on each side.
 * @param source - complete validated UTF-8 page or root source; CRLF keeps the same one-based line positions.
 * @param entry - metadata and content version from those same bytes.
 * @param request - explicit lifecycle scope, nonempty query and positive result limits.
 * @returns a document hit only when every token occurs outside internal metadata; source line numbers stay unchanged.
 */
export function matchKnowledgePage(source: string, entry: KnowledgeEntry, request: KnowledgeSearchRequest): KnowledgeSearchHit | undefined {
  if (!request.statuses.includes(entry.status)) return undefined
  const tokens = request.query.trim().split(/\s+/)
  const patterns = tokens.map(token => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  const seen = new Set<number>()
  const lines = searchableSource(source, entry.kind === 'page').split('\n')
  const matches: { line: number; snippet: string }[] = []
  let linesTruncated = false
  for (const [index, line] of lines.entries()) {
    let matched = false
    for (const [token, pattern] of patterns.entries()) if (pattern.test(line)) { seen.add(token); matched = true }
    if (!matched) continue
    if (matches.length >= request.maxMatches) { linesTruncated = true; continue }
    matches.push({ line: index + 1, snippet: lines.slice(Math.max(0, index - 1), index + 2).join(' ⏎ ') })
  }
  return seen.size === patterns.length ? { path: entry.id, title: entry.title, status: entry.status,
    version: entry.version, lines: matches, linesTruncated } : undefined
}

/** Retain a bounded, lexically ordered result set independently of filesystem scan order.
 * @param request - explicit query and positive document/match limits.
 * @returns a scan callback, retained hits and whether matching documents were omitted.
 */
export function collectKnowledgeMatches(request: KnowledgeSearchRequest): {
  hits: KnowledgeSearchHit[]
  omitted: () => boolean
  add: (source: string, entry: KnowledgeEntry) => void
} {
  const hits: KnowledgeSearchHit[] = []
  let omitted = false
  return { hits, omitted: () => omitted, add(source: string, entry: KnowledgeEntry): void {
    const hit = matchKnowledgePage(source, entry, request)
    if (hit === undefined) return
    hits.push(hit)
    hits.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    if (hits.length > request.maxResults) { hits.pop(); omitted = true }
  } }
}
