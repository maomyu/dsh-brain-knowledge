/** Bounded ZIP members are repackaged only for Mammoth; retained original DOCX bytes remain unchanged. */
import { fromBuffer } from 'yauzl'
import type { Entry } from 'yauzl'
import { zipSync } from 'fflate'
import type { ConversionInput } from './protocol.ts'

/** Stable archive refusal without document-controlled parser diagnostics. */
export class DocxArchiveError extends Error {
  /** @param reason - stable size or parsing refusal retained by the worker protocol. */
  constructor(readonly reason: 'too-large' | 'unreadable') { super('DOCX archive refused') }
}

/**
 * Validate declared budgets before inflation; yauzl validates each binary stream's exact declared size.
 * @param data - complete original archive bytes.
 * @param limits - entry, per-member and aggregate inflated-byte budgets.
 * @returns a bounded parser-only archive with exact decoded member bytes; does not verify ZIP CRC values.
 */
export function boundedDocxArchive(data: Uint8Array,
  limits: Pick<ConversionInput, 'maxDocxEntries' | 'maxDocxEntryBytes' | 'maxDocxArchiveBytes'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const source = Buffer.from(data)
    fromBuffer(source, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error !== null) { reject(new DocxArchiveError('unreadable')); return }
      const members: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
      let declaredBytes = 0
      let settled = false
      const fail = (reason: 'too-large' | 'unreadable'): void => {
        if (settled) return
        settled = true
        zip.close()
        reject(new DocxArchiveError(reason))
      }
      zip.on('error', () => { fail('unreadable') })
      if (zip.entryCount > limits.maxDocxEntries) { fail('too-large'); return }
      zip.on('entry', (entry: Entry) => {
        if (entry.isEncrypted() || entry.compressionMethod !== 0 && entry.compressionMethod !== 8
          || Object.hasOwn(members, entry.fileName)) { fail('unreadable'); return }
        if (!Number.isSafeInteger(entry.uncompressedSize)
          || entry.uncompressedSize > limits.maxDocxEntryBytes
          || entry.uncompressedSize > limits.maxDocxArchiveBytes - declaredBytes) { fail('too-large'); return }
        declaredBytes += entry.uncompressedSize
        zip.openReadStream(entry, (readError, stream) => {
          if (readError !== null) { fail('unreadable'); return }
          void (async () => {
            const chunks: Buffer[] = []
            try {
              // yauzl returns binary streams and rejects short or oversized entries before successful completion.
              const binary: AsyncIterable<Buffer> = stream
              for await (const chunk of binary) chunks.push(chunk)
              members[entry.fileName] = Buffer.concat(chunks, entry.uncompressedSize)
              if (!settled) zip.readEntry()
            } catch {
              fail('unreadable')
            } finally { stream.destroy() }
          })()
        })
      })
      zip.on('end', () => {
        settled = true
        zip.close()
        try { resolve(Buffer.from(zipSync(members, { level: 0 }))) }
        catch { reject(new DocxArchiveError('unreadable')) }
      })
      zip.readEntry()
    })
  })
}
