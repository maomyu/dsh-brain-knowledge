/** Bounded physical-page text recovery inside the existing opaque PDF reader. */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ArtifactText } from './props.ts'

/** Complete localized chrome transferred to the isolated reader. */
export interface PdfTextLabels {
  readonly notice: string
  readonly page: string
  readonly first: string
  readonly previous: string
  readonly next: string
  readonly last: string
  readonly jump: string
  readonly go: string
  readonly invalid: string
  readonly empty: string
  readonly unreadable: string
}

/** Bind text recovery labels without sending file data through executable bootstrap code.
 * @param t - artifact locale dictionary.
 * @returns complete reader chrome with literal page placeholders.
 */
export function pdfTextLabels(t: ArtifactText): PdfTextLabels {
  return { notice: t('pdf.fallback'), page: t('pdf.position', { page: '{page}', total: '{total}' }),
    first: t('pdf.first'), previous: t('pdf.previous'), next: t('pdf.next'), last: t('pdf.last'),
    jump: t('pdf.jump'), go: t('pdf.go'), invalid: t('pdf.invalid'), empty: t('pdf.empty'), unreadable: t('pdf.unreadable') }
}

/** Extract and display all admitted physical pages after canvas rendering fails.
 * This function is serialized with application code; it has no imports at runtime.
 * @param pdf - parsed PDF in the private worker; actions and file content never execute.
 * @param labels - validated localized controls.
 * @returns after bounded text extraction and first-page display; textless or oversized results reject.
 */
export async function renderPdfTextFallback(pdf: PDFDocumentProxy, labels: PdfTextLabels): Promise<void> {
  if (pdf.numPages < 1 || pdf.numPages > 100) throw new Error('PDF exceeds page limit')
  const pages: Array<{ text: string; unreadable: boolean }> = []
  let hasText = false
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number)
    try {
      let text = ''
      let unreadable = false
      try {
        const content = await page.getTextContent()
        text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
      } catch {
        // Text decoding errors may contain document content; retain only the physical page's refusal.
        unreadable = true
      }
      unreadable ||= Array.from(text).some((character) => {
        const code = character.charCodeAt(0)
        return code === 0xfffd || code < 32 && code !== 9 && code !== 10 && code !== 13
      })
      pages.push({ text: unreadable ? '' : text, unreadable })
      hasText ||= !unreadable && text.length > 0
      if (new TextEncoder().encode(JSON.stringify(pages)).byteLength > 2_097_152) throw new Error('PDF text exceeds byte limit')
    } finally { page.cleanup() }
  }
  if (!hasText) throw new Error('PDF has no readable text')
  const root = document.createElement('main')
  root.dataset.pdfMode = 'text'
  root.style.cssText = 'padding:12px;font:14px/1.6 system-ui;overflow-wrap:anywhere;color-scheme:light dark'
  const notice = document.createElement('p')
  notice.setAttribute('role', 'status')
  notice.textContent = labels.notice
  const nav = document.createElement('nav')
  nav.setAttribute('aria-label', labels.jump)
  nav.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center'
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  const body = document.createElement('pre')
  body.style.cssText = 'white-space:pre-wrap;font:inherit'
  const warning = document.createElement('p')
  warning.setAttribute('role', 'status')
  let selected = 0
  const select = (index: number): void => { selected = index; update() }
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = label
    element.onclick = action
    nav.append(element)
    return element
  }
  const first = button(labels.first, () => { select(0) })
  const previous = button(labels.previous, () => { select(selected - 1) })
  nav.append(status)
  const next = button(labels.next, () => { select(selected + 1) })
  const last = button(labels.last, () => { select(pages.length - 1) })
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.max = String(pages.length)
  input.step = '1'
  input.setAttribute('aria-label', labels.jump)
  input.style.width = '5em'
  nav.append(input)
  const jump = (): void => {
    const number = input.valueAsNumber
    if (!Number.isSafeInteger(number) || number < 1 || number > pages.length) {
      input.setAttribute('aria-invalid', 'true')
      warning.textContent = labels.invalid
      return
    }
    select(number - 1)
  }
  button(labels.go, jump)
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); jump() } }
  const update = (): void => {
    const page = pages[selected] as { text: string; unreadable: boolean }
    first.disabled = previous.disabled = selected === 0
    next.disabled = last.disabled = selected === pages.length - 1
    input.value = String(selected + 1)
    input.removeAttribute('aria-invalid')
    status.textContent = labels.page.replace('{page}', String(selected + 1)).replace('{total}', String(pages.length))
    body.textContent = page.text
    warning.textContent = page.unreadable ? labels.unreadable : page.text === '' ? labels.empty : ''
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }
  root.append(notice, nav, warning, body)
  document.body.replaceChildren(root)
  update()
}
