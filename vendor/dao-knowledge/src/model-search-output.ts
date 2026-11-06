/** Model-only search excerpts retain source coordinates without changing the human search view. */
import type { KnowledgeSearchResult } from './types.ts'
import { utf8Boundary } from './model-read.ts'

function excerpt(snippet: string, query: string, cap: number) {
  const bytes = Buffer.from(snippet, 'utf8')
  if (bytes.length <= cap) return { snippet }
  const tokens = query.trim().split(/\s+/)
  let character = -1
  for (const token of tokens) {
    const match = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(snippet)
    if (match !== null && (character < 0 || match.index < character)) character = match.index
  }
  const anchor = Buffer.byteLength(snippet.slice(0, Math.max(0, character)), 'utf8')
  const start = utf8Boundary(bytes, Math.max(0, Math.min(anchor - Math.floor(cap / 4), bytes.length - cap)))
  const end = utf8Boundary(bytes, Math.min(bytes.length, start + cap))
  return { snippet: bytes.subarray(start, end).toString('utf8'), snippetTruncated: true,
    snippetStartByte: start, snippetTotalBytes: bytes.length }
}

/** Fit complete search JSON by shortening only snippets, with explicit per-snippet omission metadata.
 * @param results - Host search results; their path, version, line, issues and completeness flags remain intact.
 * @param query - literal search tokens used to center an excerpt near a match.
 * @param render - caller-owned single-project or workspace envelope.
 * @param maxBytes - inclusive complete JSON UTF-8 allowance.
 * @returns unchanged complete output when it fits, otherwise clearly partial snippets.
 * @throws when metadata and minimal excerpts still exceed the allowance; search never proves a full read.
 */
export function renderBrainSearch(results: readonly (KnowledgeSearchResult | null)[], query: string,
  render: (results: readonly (KnowledgeSearchResult | null)[]) => string, maxBytes: number): string {
  const complete = render(results)
  if (Buffer.byteLength(complete, 'utf8') <= maxBytes) return complete
  const largest = Math.max(0, ...results.flatMap(result => result?.hits.flatMap(hit =>
    hit.lines.map(line => Buffer.byteLength(line.snippet, 'utf8'))) ?? []))
  let cap = largest
  while (cap >= 4) {
    const projected = results.map(result => result === null ? null : { ...result,
      hits: result.hits.map(hit => ({ ...hit,
        lines: hit.lines.map(line => ({ line: line.line, ...excerpt(line.snippet, query, cap) })) })) })
    const text = render(projected)
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
    if (cap === 4) break
    cap = Math.max(4, Math.floor(cap / 2))
  }
  throw new Error('Brain search output exceeds maxReadBytes even with partial snippets; narrow the query, lower the result limit or increase the configured allowance')
}
