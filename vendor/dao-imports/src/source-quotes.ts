/** Exact source-quote matching excludes converter-generated labels and DOCX hyperlink destinations. */

const generatedDocxLines = [
  '> [Unverified DOCX image description; image not inspected] ',
  '⟦DOCX structure, not source text: ',
] as const
const generatedPdfLines = ['## Page '] as const

/** A new conversion needs at least one non-metadata line before it can supply review evidence.
 * @param text - complete converted text before attachment storage.
 * @param format - original document format that determines generated line markers.
 * @returns whether any line can contribute non-whitespace source text to an exact quote.
 */
export function hasCitableConvertedText(text: string, format: 'text' | 'docx' | 'pdf'): boolean {
  const generatedLines: readonly string[] = format === 'docx' ? generatedDocxLines
    : format === 'pdf' ? generatedPdfLines : []
  return text.split('\n').some(line => line.trim().length > 0
    && !generatedLines.some(prefix => line.startsWith(prefix)))
}

/**
 * Match quotes against one immutable converted attachment without treating converter labels as source facts.
 * @param chunks - attachment bytes in storage order.
 * @param quotes - nonempty exact quotes from one review proposal.
 * @param format - original document format; DOCX and PDF have generated lines.
 * @param signal - review lifetime.
 * @returns whether every quote occurs outside generated metadata, DOCX link targets and PDF page headings.
 */
export async function containsExactSourceQuotes(chunks: AsyncIterable<Uint8Array>, quotes: ReadonlySet<string>,
  format: 'text' | 'docx' | 'pdf', signal: AbortSignal): Promise<boolean> {
  const missing = new Set(quotes)
  if (missing.size === 0) return true
  const overlap = Math.max(...[...quotes].map(quote => quote.length)) - 1
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let tail = ''
  const match = (part: string): void => {
    const window = tail + part
    for (const quote of missing) if (window.includes(quote)) missing.delete(quote)
    tail = overlap === 0 ? '' : window.slice(-overlap)
  }
  if (format === 'text') {
    for await (const bytes of chunks) {
      signal.throwIfAborted()
      match(decoder.decode(bytes, { stream: true }))
    }
    match(decoder.decode())
    return missing.size === 0
  }

  const generatedLines: readonly string[] = format === 'docx' ? generatedDocxLines : generatedPdfLines
  const linkLabel = { pendingEnd: false }
  let inLinkDestination = false
  let linkDepth = 0
  let escaped = false
  const matchDocxBody = (part: string): void => {
    let visible = ''
    for (const character of part) {
      if (inLinkDestination) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '(') linkDepth++
        else if (character === ')' && --linkDepth === 0) {
          inLinkDestination = false
          tail = ''
        }
        continue
      }
      if (linkLabel.pendingEnd) {
        linkLabel.pendingEnd = false
        if (character === '(') {
          match(visible)
          visible = ''
          tail = ''
          inLinkDestination = true
          linkDepth = 1
          escaped = false
          continue
        }
        visible += ']'
      }
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === ']') {
        linkLabel.pendingEnd = true
        continue
      }
      visible += character
    }
    match(visible)
  }
  const matchSource = format === 'docx' ? matchDocxBody : match
  let linePrefix = ''
  let atLineStart = true
  let skipLine = false
  const scan = (decoded: string): void => {
    let cursor = 0
    while (cursor < decoded.length) {
      const end = decoded.indexOf('\n', cursor)
      const part = decoded.slice(cursor, end < 0 ? undefined : end)
      if (!skipLine) {
        if (atLineStart) {
          const candidate = linePrefix + part
          if (generatedLines.some(prefix => candidate.startsWith(prefix))) {
            skipLine = true
            tail = ''
            linkLabel.pendingEnd = false
            inLinkDestination = false
            escaped = false
            linePrefix = ''
          } else if (generatedLines.some(prefix => prefix.startsWith(candidate))) {
            linePrefix = candidate
          } else {
            matchSource(candidate)
            linePrefix = ''
            atLineStart = false
          }
        } else {
          matchSource(part)
        }
      }
      if (end < 0) break
      if (!skipLine) {
        if (linePrefix !== '') matchSource(linePrefix)
        matchSource('\n')
      }
      linePrefix = ''
      atLineStart = true
      skipLine = false
      cursor = end + 1
    }
  }
  for await (const bytes of chunks) {
    signal.throwIfAborted()
    scan(decoder.decode(bytes, { stream: true }))
  }
  scan(decoder.decode())
  if (linePrefix !== '') matchSource(linePrefix)
  if (linkLabel.pendingEnd) match(']')
  return missing.size === 0
}
