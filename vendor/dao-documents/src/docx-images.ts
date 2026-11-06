/** Extract real embedded raster bytes in converter order, without OCR or Word page rendering. */
import mammoth from 'mammoth'
import sharp from 'sharp'
import { boundedDocxArchive, DocxArchiveError } from './docx-archive.ts'
import type { DocxImagesInput, DocxImagesResult } from './protocol.ts'

/**
 * Extract only supported pictures while disclosing every emitted picture not supplied.
 * @param input - original DOCX, archive limits, message budgets and pre-decode raster limits.
 * @returns original PNG/JPEG encoded bytes and image-order omissions; no persistent files or page claims.
 */
export async function extractDocxImages(input: DocxImagesInput): Promise<DocxImagesResult> {
  try {
    const buffer = await boundedDocxArchive(input.data, input)
    const images: Extract<DocxImagesResult, { status: 'ready' }>['images'] = []
    const omittedImages: Extract<DocxImagesResult, { status: 'ready' }>['omittedImages'] = []
    let imageCount = 0
    let bytes = 0
    let queue = Promise.resolve()
    await mammoth.convertToHtml({ buffer }, { externalFileAccess: false, includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement((image) => {
        const number = ++imageCount
        if (number > input.maxDocxImageElements) return Promise.resolve({ src: '' })
        queue = queue.then(async () => {
          const omit = (reason: typeof omittedImages[number]['reason']): void => { omittedImages.push({ image: number, reason }) }
          if (image.contentType !== 'image/png' && image.contentType !== 'image/jpeg') { omit('unsupported-format'); return }
          if (images.length >= input.maxImages) { omit('image-limit'); return }
          let data: Buffer
          try { data = await image.readAsBuffer() }
          catch { omit('unreadable-image'); return }
          if (data.byteLength === 0) { omit('unreadable-image'); return }
          if (data.byteLength > input.maxImageBytes || data.byteLength > input.maxTotalBytes - bytes) { omit('byte-limit'); return }
          try {
            const metadata = await sharp(data, { failOn: 'error', limitInputPixels: input.maxPixels }).metadata()
            if (metadata.format !== (image.contentType === 'image/png' ? 'png' : 'jpeg')
              || (metadata.pages ?? 1) !== 1 || metadata.width > input.maxDimension || metadata.height > input.maxDimension
              || metadata.width * metadata.height > input.maxPixels) { omit('unreadable-image'); return }
          } catch { omit('unreadable-image'); return }
          images.push({ image: number, mediaType: image.contentType, data })
          bytes += data.byteLength
        })
        return queue.then(() => ({ src: '' }))
      }),
    })
    await queue
    return imageCount > input.maxDocxImageElements ? { status: 'rejected', reason: 'too-large' } : { status: 'ready', imageCount, images, omittedImages }
  } catch (error) {
    return { status: 'rejected', reason: error instanceof DocxArchiveError ? error.reason : 'unreadable' }
  }
}
