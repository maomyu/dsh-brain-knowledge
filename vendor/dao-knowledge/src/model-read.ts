/** Version-bound UTF-8 fragments of complete model-visible Brain JSON, without storage-only ledgers. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { renderJsonReadChunk } from './model-json-read.ts'

export { utf8Boundary } from './model-json-read.ts'

const identity = z.object({ project_id: z.string(), project: z.string(), path: z.string(), version: z.string() })
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const chunkSchema = identity.extend({ format: z.literal('brain-read-json-v1'), partial: z.literal(true),
  sha256: digest, startByte: offset, endByte: offset, totalBytes: offset.positive(), fragment: z.string(),
  next_cursor: z.string().nullable() }).strict().refine(value => value.startByte < value.endByte
    && value.endByte <= value.totalBytes && Buffer.byteLength(value.fragment, 'utf8') === value.endByte - value.startByte
    && (value.next_cursor === null) === (value.endByte === value.totalBytes))

/** Retained wire packet; a final fragment alone is still an incomplete read. */
export type BrainReadChunk = z.infer<typeof chunkSchema>

/** Parse a retained result without treating malformed or unfamiliar partial output as a complete read.
 * @param value - untrusted JSON decoded from a retained tool result.
 * @returns a validated fragment, or undefined when it cannot establish read coverage.
 */
export function parseBrainReadChunk(value: unknown): BrainReadChunk | undefined {
  const parsed = chunkSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** Render one bounded fragment of an already projected complete Brain document.
 * @param text - complete JSON including the canonical project id, Markdown and public Timeline.
 * @param selected - identity from the current authorized read, not from the cursor.
 * @param cursor - optional continuation supplied by the model; it grants no access.
 * @param maxBytes - inclusive UTF-8 cap for the entire serialized response, including its cursor.
 * @returns one packet with a continuation, or a final packet still marked partial.
 * @throws for stale/mismatched cursors or an allowance too small for metadata and one code point.
 */
export function renderBrainReadChunk(text: string, selected: z.infer<typeof identity>,
  cursor: string | undefined, maxBytes: number): string {
  return renderJsonReadChunk(text, { ...selected, format: 'brain-read-json-v1' }, cursor, maxBytes)
}

/** Verify a continuous complete byte sequence retained by successful reads of one identity.
 * @param chunks - fragments for the same project, page, version, digest and total byte count.
 * @returns true only when a zero-based chain reaches the total, hashes correctly and decodes to that identity.
 */
export function hasCompleteBrainRead(chunks: readonly BrainReadChunk[]): boolean {
  const first = chunks[0]
  if (first === undefined) return false
  const parts: Uint8Array[] = []
  let end = 0
  for (const chunk of chunks.toSorted((left, right) => left.startByte - right.startByte || right.endByte - left.endByte)) {
    if (chunk.startByte > end) return false
    if (chunk.endByte <= end) continue
    parts.push(Buffer.from(chunk.fragment, 'utf8').subarray(end - chunk.startByte))
    end = chunk.endByte
  }
  if (end !== first.totalBytes) return false
  const bytes = Buffer.concat(parts)
  if (hash(bytes) !== first.sha256) return false
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return false }
  const parsed = identity.extend({ markdown: z.string(), timeline: z.array(z.unknown()) }).safeParse(value)
  return parsed.success && parsed.data.project_id === first.project_id && parsed.data.project === first.project
    && parsed.data.path === first.path && parsed.data.version === first.version
}
