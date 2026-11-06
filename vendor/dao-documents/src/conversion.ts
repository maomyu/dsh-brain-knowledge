/** Local document parsing uses supplied bytes only; returned Markdown is never executed or rendered here. */
import mammoth from 'mammoth'
import { boundedDocxArchive, DocxArchiveError } from './docx-archive.ts'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from 'unpdf'
import type { ConversionInput, ConversionResult, PdfRenderInput, PdfRenderResult } from './protocol.ts'

const pdfOptions = {
  useSystemFonts: true, disableFontFace: true,
  useWorkerFetch: false, disableAutoFetch: true, enableXfa: false, stopAtErrors: true,
} as const

/**
 * Join PDF.js text items while omitting structural marked-content records.
 * @param items - page text/structure records; explicit line ends remain line breaks.
 * @returns trimmed page text, without adding labels for non-text records.
 */
export function pdfPageText(items: readonly ({ str: string; hasEOL: boolean } | { type: string })[]): string {
  return items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
}

async function pdfText(input: ConversionInput): Promise<ConversionResult> {
  const pdf = await getDocumentProxy(new Uint8Array(input.data), pdfOptions)
  try {
    if (pdf.numPages > input.maxPdfPages) return { status: 'rejected', reason: 'too-many-pages' }
    const { OPS } = await getResolvedPDFJS()
    const imagePaintOps = new Set([
      OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageXObject,
      OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask,
    ])
    const pages: string[] = []
    const pagesWithoutText: number[] = []
    const pagesWithTextAndPaintedImages: number[] = []
    let imageCoverageKnown = true
    let bytes = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index)
      try {
        const content = await page.getTextContent()
        const text = pdfPageText(content.items)
        if (text === '') { pagesWithoutText.push(index); continue }
        const section = `## Page ${index}\n\n${text}`
        bytes += Buffer.byteLength(section, 'utf8') + (pages.length === 0 ? 0 : 2)
        if (bytes > input.maxTextBytes) return { status: 'rejected', reason: 'too-large' }
        if (imageCoverageKnown) {
          try {
            if ((await page.getOperatorList()).fnArray.some(operation => imagePaintOps.has(operation))) {
              pagesWithTextAndPaintedImages.push(index)
            }
          } catch {
            // A failed visual scan must not discard text already extracted from this document.
            imageCoverageKnown = false
          }
        }
        pages.push(section)
      } finally { page.cleanup() }
    }
    return { status: 'ready', format: 'text', text: pages.join('\n\n'),
      extraction: { kind: 'pdf-text', pageCount: pdf.numPages, pagesWithoutText,
        ...imageCoverageKnown ? { pagesWithTextAndPaintedImages } : {} } }
  } finally { await pdf.loadingTask.destroy() }
}

/**
 * Rasterize a bounded prefix of physical PDF pages; omitted pages remain explicit in the result.
 * @param input - original bytes and worker-owned page, pixel and PNG byte limits.
 * @returns exact one-based page PNGs or a stable unreadable-document refusal.
 */
export async function renderPdfPages(input: PdfRenderInput): Promise<PdfRenderResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try { pdf = await getDocumentProxy(new Uint8Array(input.data), pdfOptions) }
  catch { return { status: 'rejected', reason: 'unreadable' } }
  try {
    if (pdf.numPages > input.maxPdfPages) return { status: 'rejected', reason: 'too-many-pages' }
    const pages: { page: number; data: Uint8Array }[] = []
    let totalBytes = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      if (index > input.maxRenderedPages) return { status: 'ready', pageCount: pdf.numPages,
        pages, omittedReason: 'page-limit' }
      const page = await pdf.getPage(index)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const width = viewport.width
        const height = viewport.height
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return { status: 'ready', pageCount: pdf.numPages, pages, omittedReason: 'render-failed' }
        }
        const scale = Math.min(input.scale, input.maxPageDimension / width,
          input.maxPageDimension / height, Math.sqrt(input.maxPagePixels / (width * height)))
        let renderWidth = Math.floor(width * scale)
        let renderHeight = Math.ceil(height * renderWidth / width)
        while (renderWidth > 0 && (renderHeight > input.maxPageDimension
          || renderWidth * renderHeight > input.maxPagePixels)) {
          renderWidth--
          renderHeight = Math.ceil(height * renderWidth / width)
        }
        if (renderWidth < 1 || renderHeight < 1) {
          return { status: 'ready', pageCount: pdf.numPages, pages, omittedReason: 'render-failed' }
        }
        let data: Uint8Array
        try {
          data = new Uint8Array(await renderPageAsImage(pdf, index, {
            width: renderWidth, canvasImport: () => import('@napi-rs/canvas'),
          }))
        } catch {
          // A malformed graphic or missing renderer cannot turn earlier pages into complete coverage.
          return { status: 'ready', pageCount: pdf.numPages, pages, omittedReason: 'render-failed' }
        }
        if (data.byteLength > input.maxPageBytes || data.byteLength > input.maxTotalBytes - totalBytes) {
          return { status: 'ready', pageCount: pdf.numPages, pages, omittedReason: 'byte-limit' }
        }
        pages.push({ page: index, data })
        totalBytes += data.byteLength
      } finally { page.cleanup() }
    }
    return { status: 'ready', pageCount: pdf.numPages, pages }
  } catch {
    return { status: 'rejected', reason: 'unreadable' }
  } finally { await pdf.loadingTask.destroy() }
}

async function docxText(data: Uint8Array): Promise<{ text: string; imageCount: number; imagesWithoutDescription: number }> {
  const html = await mammoth.convertToHtml({ buffer: Buffer.from(data) }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
  })
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  markdown.use(gfm)
  markdown.remove(['script', 'style', 'iframe', 'object', 'embed'])
  const marker = (label: string): string => `⟦DOCX structure, not source text: ${label}⟧`
  const noteLink = (node: HTMLElement): { type: 'Footnote' | 'Endnote'; number: string; id: string } | null => {
    if (node.tagName !== 'SUP' || node.children.length !== 1) return null
    const anchor = node.children[0]
    if (anchor?.tagName !== 'A') return null
    const target = /^#(footnote|endnote)-[a-z0-9-]+$/u.exec(anchor.getAttribute('href') ?? '')
    const number = /^\[(\d+)\]$/u.exec(anchor.textContent.trim())?.[1]
    const referenceId = anchor.getAttribute('id')
    if (target === null || number === undefined || referenceId === null) return null
    const id = target[0].slice(1)
    const note = node.ownerDocument.getElementById(id)
    if (note?.tagName !== 'LI' || !Array.from(note.getElementsByTagName('a')).some(link =>
      link.getAttribute('href') === `#${referenceId}` && link.textContent.trim() === '↑')) return null
    return { type: target[1] === 'footnote' ? 'Footnote' : 'Endnote', number, id }
  }
  const tableRows = (table: HTMLElement): Element[][] | null => {
    const children = Array.from(table.children)
    const rows = children.flatMap(child => ['TBODY', 'THEAD', 'TFOOT'].includes(child.tagName)
      ? Array.from(child.children) : [child])
    if (rows.length === 0 || rows.some(row => row.tagName !== 'TR')) return null
    const cells = rows.map(row => Array.from(row.children))
    if (cells.some(row => row.length === 0 || row.some(cell => !['TD', 'TH'].includes(cell.tagName)
      || cell.hasAttribute('colspan') && cell.getAttribute('colspan') !== '1'
      || cell.hasAttribute('rowspan') && cell.getAttribute('rowspan') !== '1'
      || cell.children.length > 1 || (cell.children.length === 1 && cell.children[0]?.tagName !== 'P')
      || cell.querySelector('table, ul, ol, br, img, sup') != null))) return null
    return cells
  }
  let tableNumber = 0
  markdown.addRule('locatedTableCells', {
    filter: 'table',
    replacement(content, node) {
      const table = node
      if (table.parentElement?.closest('table') != null) return content
      const number = ++tableNumber
      const rows = tableRows(table)
      if (rows === null) return `\n\n${marker(`Table ${number}: merged, nested or complex layout not preserved`)}\n\n${content}\n\n`
      const cells = rows.flatMap((row, rowIndex) => row.map((cell, cellIndex) => {
        const value = markdown.turndown(cell.innerHTML).trim()
        return `${marker(`Table ${number}, row ${rowIndex + 1}, cell ${cellIndex + 1}`)}${value === '' ? '' : `\n${value}`}`
      }))
      return `\n\n${cells.join('\n\n')}\n\n`
    },
  })
  markdown.addRule('noteBacklink', {
    filter(node) {
      return node.nodeName === 'A' && /^#(?:footnote|endnote)-ref-[a-z0-9-]+$/u.test(node.getAttribute('href') ?? '')
        && node.textContent.trim() === '↑'
    },
    replacement: () => '',
  })
  markdown.addRule('noteReferenceNumber', {
    filter(node) {
      return node.nodeName === 'SUP' && node.children.length === 1
        && /^#(?:footnote|endnote)-[a-z0-9-]+$/u.test(node.children[0]?.getAttribute('href') ?? '')
    },
    replacement: () => '',
  })
  markdown.addRule('noteReferenceLocation', {
    filter(node) {
      return node.nodeName === 'P' && Array.from(node.getElementsByTagName('sup')).some(sup =>
        /^#(?:footnote|endnote)-[a-z0-9-]+$/u.test(sup.children[0]?.getAttribute('href') ?? ''))
    },
    replacement(content, node) {
      const labels = Array.from(node.getElementsByTagName('sup')).filter(sup =>
        /^#(?:footnote|endnote)-[a-z0-9-]+$/u.test(sup.children[0]?.getAttribute('href') ?? ''))
        .map((sup) => {
          const note = noteLink(sup)
          return marker(note === null ? 'Note reference relation not preserved'
            : `${note.type} ${note.number} reference in preceding paragraph`)
        })
      return `\n\n${content}\n\n${labels.join('\n')}\n\n`
    },
  })
  markdown.addRule('locatedNotes', {
    filter(node) {
      return node.nodeName === 'OL' && node.children.length > 0 && Array.from(node.children).every(child =>
        child.tagName === 'LI' && /^(?:footnote|endnote)-[a-z0-9-]+$/u.test(child.id))
    },
    replacement(_content, node) {
      const notes = Array.from(node.children).map((item) => {
        const reference = Array.from(node.ownerDocument.getElementsByTagName('sup'))
          .map(sup => noteLink(sup)).find(note => note?.id === item.id)
        const label = reference == null ? 'Note relation not preserved'
          : `${reference.type} ${reference.number}`
        const body = markdown.turndown(item.innerHTML).trim()
        return `${marker(label)}${body === '' ? '' : `\n${body}`}`
      })
      return `\n\n${notes.join('\n\n')}\n\n`
    },
  })
  let imageCount = 0
  let imagesWithoutDescription = 0
  markdown.addRule('imageDescription', {
    filter: 'img',
    replacement(_content, node) {
      imageCount++
      const alt = node.getAttribute('alt')
      if (alt === null || alt.trim() === '') imagesWithoutDescription++
      if (alt === null || alt.trim() === '') return ''
      const description = markdown.escape(alt.replace(/\s+/gu, ' ').trim())
      return `\n\n> [Unverified DOCX image description; image not inspected] ${description}\n\n`
    },
  })
  return { text: markdown.turndown(html.value).trim(), imageCount, imagesWithoutDescription }
}

/**
 * Extract document content inside the disposable conversion worker.
 * @param input - validated byte source, selected format and complete-text/page limits.
 * @returns a bounded result; malformed or encrypted documents are unreadable, while textless PDFs retain page coverage.
 */
export async function convertDocument(input: ConversionInput): Promise<ConversionResult> {
  try {
    if (input.format === 'pdf') return await pdfText(input)
    const docx = input.format === 'docx' ? await docxText(await boundedDocxArchive(input.data, input)) : null
    const text = docx?.text ?? new TextDecoder('utf-8', { fatal: true }).decode(input.data)
    if (input.format === 'docx' && text === '' && docx?.imageCount === 0 || text.includes('\0')) return { status: 'rejected', reason: 'unreadable' }
    if (docx !== null && docx.imageCount > input.maxDocxImageElements) return { status: 'rejected', reason: 'too-large' }
    if (Buffer.byteLength(text, 'utf8') > input.maxTextBytes) return { status: 'rejected', reason: 'too-large' }
    return { status: 'ready', format: input.format === 'docx' ? 'markdown' : 'text', text,
      ...docx === null ? {} : { extraction: { kind: 'docx-text' as const,
        imageCount: docx.imageCount, imagesWithoutDescription: docx.imagesWithoutDescription } } }
  } catch (error) {
    // Parser failures contain document-controlled strings; only the stable refusal crosses the worker port.
    return { status: 'rejected', reason: error instanceof DocxArchiveError ? error.reason : 'unreadable' }
  }
}
