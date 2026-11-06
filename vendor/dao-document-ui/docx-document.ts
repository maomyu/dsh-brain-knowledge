/** Paged Word documents render in the same offline, Session-authorized frame as other Office content. */
import moduleSource from 'docx-preview?raw'
import zipSource from '@aiden0z/pptx-renderer/browser?raw'
import { isolatedDocument } from './isolated-document.ts'
import { thumbnailHandoff } from './thumbnail-handoff.ts'

type WordEngine = Pick<typeof import('docx-preview'), 'renderAsync'>
type ZipEngine = Pick<typeof import('@aiden0z/pptx-renderer'), 'parseZip'>
/** Localized frame title and page label template. */
export type DocxLabels = { title: string; page: string }

/** Read a complete Word file without granting its renderer application or network access.
 * @param container - component-owned frame location.
 * @param bytes - original independent bytes transferred to the reader.
 * @param signal - cancels loading or destroys a retained, ready document.
 * @param labels - localized frame title and page label template.
 * @returns the rendered page count; damaged, oversized or unrenderable input rejects.
 */
export async function docxDocument(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal,
  labels: DocxLabels): Promise<number> {
  return isolatedDocument(container, bytes, signal, labels.title,
    `(${docxDocumentFrame.toString()})(${renderWord.toString()}, url => import(url), url => import(url), ${thumbnailHandoff.toString()})`,
    { moduleSource, zipSource, labels })
}

/** Bootstrap privately bundled code without interpolating file contents into executable text.
 * @param render - serialized document renderer.
 * @param loadWord - native import of the bundled Word engine.
 * @param loadZip - native import of the bounded ZIP validator.
 * @param admit - parent-owned byte and port admission.
 */
export function docxDocumentFrame(render: typeof renderWord, loadWord: (url: string) => Promise<WordEngine>,
  loadZip: (url: string) => Promise<ZipEngine>, admit: typeof thumbnailHandoff): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const handoff = admit(event)
    if (handoff === undefined) return
    const run = async (): Promise<void> => {
      const urls: string[] = []
      try {
        const data = event.data
        if (typeof data !== 'object' || data === null || !('zipSource' in data) || typeof data.zipSource !== 'string'
          || !('labels' in data) || typeof data.labels !== 'object' || data.labels === null
          || !('title' in data.labels) || typeof data.labels.title !== 'string'
          || !('page' in data.labels) || typeof data.labels.page !== 'string') throw new Error('Invalid Word reader input')
        const wordUrl = URL.createObjectURL(new Blob([handoff.moduleSource], { type: 'text/javascript' }))
        urls.push(wordUrl)
        const zipUrl = URL.createObjectURL(new Blob([data.zipSource], { type: 'text/javascript' }))
        urls.push(zipUrl)
        const [word, zip] = await Promise.all([loadWord(wordUrl), loadZip(zipUrl)])
        handoff.port.postMessage({ pages: await render(word, zip, handoff.bytes, { title: data.labels.title, page: data.labels.page }) })
      } catch {
        // The parent owns the localized failure, original download and retry controls.
        handoff.port.postMessage({ error: true })
      } finally {
        for (const url of urls) URL.revokeObjectURL(url)
        handoff.port.close()
      }
    }
    void run()
  }, { once: true })
}

/** Render paginated Word content at its original page width and fit complete pages to the reader.
 * @param word - the locally bundled Word renderer.
 * @param zip - the existing bounded archive parser; Office entries are validated before DOM rendering.
 * @param bytes - original authorized archive.
 * @param labels - localized page region labels.
 * @returns 1–100 rendered pages; unsafe archives, invalid documents and image decode failures reject.
 */
export async function renderWord(word: WordEngine, zip: ZipEngine, bytes: Uint8Array, labels: DocxLabels): Promise<number> {
  await zip.parseZip(new Uint8Array(bytes).buffer, {
    maxEntries: 4000, maxEntryUncompressedBytes: 8 * 1024 ** 2, maxTotalUncompressedBytes: 32 * 1024 ** 2, maxConcurrency: 4,
  })
  document.body.style.cssText = 'margin:0;color:CanvasText;color-scheme:light dark;font:13px system-ui'
  const host = document.createElement('main')
  host.style.cssText = 'overflow:auto;min-width:0'
  host.setAttribute('aria-label', labels.title)
  // Document links are readable content, not permission to navigate or open another origin.
  host.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation() }, true)
  document.body.append(host)
  await word.renderAsync(bytes, host, undefined, {
    className: 'dsh-word', inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
    renderAltChunks: false, useBase64URL: true,
  })
  const pages = host.querySelectorAll<HTMLElement>('section.dsh-word')
  if (pages.length < 1 || pages.length > 100) throw new Error('Word document exceeds preview page limits')
  pages.forEach((page, index) => {
    page.style.boxSizing = 'border-box'
    page.setAttribute('role', 'region')
    page.setAttribute('aria-label', labels.page.replace('{page}', String(index + 1)))
  })
  await Promise.all(Array.from(host.querySelectorAll('img'), image => image.decode()))
  const wrapper = host.querySelector<HTMLElement>('.dsh-word-wrapper') ?? host
  const fit = (): void => {
    const style = getComputedStyle(wrapper)
    const width = wrapper.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
    if (width <= 0) return
    for (const page of pages) {
      if (page.offsetWidth > 0) page.style.zoom = String(Math.min(1, width / page.offsetWidth))
    }
  }
  fit()
  const observer = new ResizeObserver(fit)
  observer.observe(wrapper)
  window.addEventListener('pagehide', () => { observer.disconnect() }, { once: true })
  return pages.length
}
