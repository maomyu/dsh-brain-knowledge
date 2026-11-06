/** Scrollable PDF pages in an opaque, offline renderer with a disposable private worker. */
import moduleSource from 'pdfjs-dist/build/pdf.min.mjs?raw'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { thumbnailHandoff } from './thumbnail-handoff.ts'
import { isolatedDocument } from './isolated-document.ts'
import { renderPdfTextFallback, type PdfTextLabels } from './pdf-text-fallback.ts'

/** Mount a document until the caller aborts, including after rendering has completed.
 * @param container - component-owned frame location.
 * @param bytes - independently owned document bytes, transferred out of the parent.
 * @param signal - unmount or replacement removes the document and its workers.
 * @param labels - localized frame title and page-number template.
 * @returns the physical page count after canvas or text readiness; unreadable files and worker/transfer failures reject.
 */
export async function pdfDocument(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal,
  labels: { title: string; page: string; text: PdfTextLabels }): Promise<number> {
  return isolatedDocument(container, bytes, signal, labels.title,
    `(${pdfDocumentFrame.toString()})(${renderDocumentPages.toString()}, url => import(url), ${thumbnailHandoff.toString()}, ${renderPdfTextFallback.toString()})`,
    { moduleSource, workerSource, pageLabel: labels.page, textLabels: labels.text })
}

/** Bootstrap only application-owned code inside the renderer document.
 * @param render - separately serialized PDF page renderer.
 * @param load - native module import in the isolated document.
 * @param admit - parent-port handoff validator.
 * @param recover - bounded physical-page text reader.
 */
export function pdfDocumentFrame(render: typeof renderDocumentPages,
  load: (url: string) => Promise<typeof import('pdfjs-dist')>, admit: typeof thumbnailHandoff,
  recover: typeof renderPdfTextFallback): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const handoff = admit(event)
    if (handoff === undefined) return
    const { port, bytes } = handoff
    const value = event.data
    const run = async (): Promise<void> => {
      let url: string | undefined
      let worker: Worker | undefined
      try {
        if (typeof handoff.workerSource !== 'string' || typeof value !== 'object' || value === null
          || !('pageLabel' in value) || typeof value.pageLabel !== 'string') throw new Error('Incomplete PDF renderer handoff')
        if (!('textLabels' in value) || typeof value.textLabels !== 'object' || value.textLabels === null
          || !['notice', 'page', 'first', 'previous', 'next', 'last', 'jump', 'go', 'invalid', 'empty', 'unreadable']
            .every(key => typeof (value.textLabels as Record<string, unknown>)[key] === 'string')) throw new Error('Incomplete PDF text labels')
        const labels = value.textLabels as PdfTextLabels
        url = URL.createObjectURL(new Blob([handoff.moduleSource], { type: 'text/javascript' }))
        const pdf = await load(url)
        const activeWorker = new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(handoff.workerSource)}`, { type: 'module' })
        worker = activeWorker
        const failed = new Promise<never>((_resolve, reject) => {
          activeWorker.addEventListener('error', () => { reject(new Error('PDF worker failed')) }, { once: true })
        })
        port.postMessage({ pages: await Promise.race([render(pdf, bytes, worker, value.pageLabel,
          document => recover(document, labels)), failed]) })
      } catch {
        // This document has no application logger; the private reply selects the localized failure view.
        port.postMessage({ error: true })
      } finally {
        worker?.terminate()
        if (url !== undefined) URL.revokeObjectURL(url)
        port.close()
      }
    }
    void run()
  }, { once: true })
}

/** Render admitted pages at their capped display scale and the opening display's pixel density.
 * CSS fits retained pixels to the available width without another file read or a persistent worker.
 * PDF actions, annotations and embedded scripts never execute.
 * @param pdf - locally bundled PDF.js module, with no application or network access.
 * @param bytes - PDF input, transferred to the supplied worker.
 * @param worker - private worker owned by the enclosing document.
 * @param pageLabel - localized accessible page-number template.
 * @param recover - optional text reader, entered only for a canvas failure, never a page/pixel limit rejection.
 * @returns the page count; over 100 pages or 67,108,864 total canvas pixels reject; each bitmap axis is capped at 4096 pixels.
 */
export async function renderDocumentPages(pdf: typeof import('pdfjs-dist'), bytes: Uint8Array, worker: Worker, pageLabel: string,
  recover?: (document: import('pdfjs-dist').PDFDocumentProxy) => Promise<void>): Promise<number> {
  const loading = pdf.getDocument({ data: bytes, worker: pdf.PDFWorker.create({ port: worker }),
    useWorkerFetch: false, useWasm: false, enableXfa: false, stopAtErrors: true,
    maxImageSize: 16_777_216, canvasMaxAreaInBytes: 16_777_216, verbosity: 0 })
  try {
    const document = await loading.promise
    if (document.numPages < 1 || document.numPages > 100) throw new Error('PDF exceeds page limit')
    const body = window.document.body
    body.style.margin = '0'
    const pages = window.document.createElement('main')
    pages.dataset.pdfMode = 'canvas'
    pages.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:8px;box-sizing:border-box'
    body.append(pages)
    let pixels = 0
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      let failed = false
      try {
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(1.25 * window.devicePixelRatio, 4096 / base.width, 4096 / base.height) })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        pixels += canvas.width * canvas.height
        if (pixels > 67_108_864) throw new Error('PDF exceeds pixel limit')
        canvas.style.cssText = 'display:block;height:auto;flex:none;max-width:100%;margin-inline:auto'
        canvas.style.width = `clamp(${Math.floor(base.width * 0.2)}px, calc(100% - 16px), ${Math.floor(base.width * 1.25)}px)`
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', pageLabel.replace('{page}', String(number)))
        pages.append(canvas)
        try { await page.render({ canvas, viewport }).promise } catch (error) {
          if (recover === undefined) throw error
          failed = true
        }
      } finally { page.cleanup() }
      if (failed && recover !== undefined) {
        pages.remove()
        await recover(document)
        return document.numPages
      }
    }
    return document.numPages
  } finally { await loading.destroy() }
}
