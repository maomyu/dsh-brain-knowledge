/** Stateless UTF-8 pagination shared by projected Brain pages and health reports. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Return the nearest preceding UTF-8 code point boundary.
 * @param bytes - valid UTF-8 text.
 * @param end - proposed exclusive byte position within those bytes.
 * @returns a byte position that never splits a multi-byte character.
 */
export function utf8Boundary(bytes: Uint8Array, end: number): number {
  while (end > 0 && end < bytes.length) {
    const byte = bytes[end]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    end--
  }
  return end
}

/** Paginate complete projected JSON with an exact current identity and format.
 * @param text - complete caller-owned JSON; no storage data is added or removed here.
 * @param selected - authorized identity and format, excluding computed digest, length and offset fields.
 * @param cursor - untrusted continuation; every field must match the current projection.
 * @param maxBytes - inclusive UTF-8 allowance for the complete response and its continuation.
 * @returns one packet, always partial even when its continuation is null.
 * @throws for invalid or stale cursors, or metadata that leaves no room for a code point.
 */
export function renderJsonReadChunk(text: string, selected: Readonly<Record<string, string | null>>,
  cursor: string | undefined, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  const common = { ...selected, sha256: createHash('sha256').update(bytes).digest('hex'), totalBytes: bytes.length }
  let start = 0
  if (cursor !== undefined) {
    let value: unknown
    try {
      if (cursor.length > maxBytes || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid cursor encoding')
      const decoded = Buffer.from(cursor, 'base64url')
      if (decoded.toString('base64url') !== cursor) throw new Error('Noncanonical cursor encoding')
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
    } catch { throw new Error('Invalid Brain read cursor; restart this read without a cursor') }
    const schema = z.object({
      ...Object.fromEntries(Object.entries(common).map(([key, expected]) => [key, z.literal(expected)])),
      startByte: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict()
    const parsed = schema.safeParse(value)
    if (!parsed.success || parsed.data.startByte >= bytes.length
      || utf8Boundary(bytes, parsed.data.startByte) !== parsed.data.startByte) {
      throw new Error('Brain read cursor does not match the current project, document or version; restart this read without a cursor')
    }
    start = parsed.data.startByte
  }
  const render = (end: number) => JSON.stringify({ ...common, partial: true, startByte: start, endByte: end,
    fragment: bytes.subarray(start, end).toString('utf8'),
    next_cursor: end === bytes.length ? null : Buffer.from(JSON.stringify({ ...common, startByte: end })).toString('base64url') })
  const final = render(bytes.length)
  if (Buffer.byteLength(final, 'utf8') <= maxBytes) return final
  let low = start + 1
  let high = bytes.length - 1
  let best = start
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const end = utf8Boundary(bytes, middle)
    if (Buffer.byteLength(render(end), 'utf8') <= maxBytes) { best = end; low = middle + 1 } else high = middle - 1
  }
  if (best === start) throw new Error('Brain read metadata and one character exceed maxReadBytes; increase the configured allowance')
  return render(best)
}
