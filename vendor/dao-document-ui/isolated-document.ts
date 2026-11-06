/** Private byte handoff and retained lifetime for offline document readers. */
import css from './DocumentToolCard.module.css'

/** Mount an opaque reader; completion retains the frame until cancellation.
 * @param container - component-owned frame location.
 * @param bytes - independently owned bytes transferred to the reader.
 * @param signal - removal or replacement destroys the frame, including after readiness.
 * @param title - localized accessible title.
 * @param script - application-owned bootstrap only; file content must use the private port.
 * @param payload - locally bundled modules and localized reader labels.
 * @returns the admitted page count; invalid replies, frame and transfer failures reject.
 */
export async function isolatedDocument(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal,
  title: string, script: string, payload: Record<string, unknown>): Promise<number> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    const channel = new MessageChannel()
    frame.className = css.frame as string
    frame.title = title
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; worker-src data:; style-src \'unsafe-inline\'; font-src blob: data:; img-src blob: data:; form-action \'none\'; base-uri \'none\'">'
      + `<script type="module">${script}</script>`
    const closePort = (): void => {
      frame.onload = null
      frame.onerror = null
      channel.port1.onmessage = null
      channel.port1.onmessageerror = null
      channel.port1.close()
      channel.port2.close()
    }
    const abort = (): void => { fail(new Error('Document preview cancelled', { cause: signal.reason })) }
    const fail = (reason: Error): void => {
      closePort()
      signal.removeEventListener('abort', abort)
      frame.remove()
      reject(reason)
    }
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data
      if (typeof value !== 'object' || value === null || !('pages' in value) || typeof value.pages !== 'number'
        || !Number.isSafeInteger(value.pages) || value.pages < 1 || value.pages > 100) {
        fail(new Error('Document preview rendering failed'))
        return
      }
      closePort()
      resolve(value.pages)
    }
    channel.port1.onmessageerror = () => { fail(new Error('Document preview response could not be decoded')) }
    frame.onerror = () => { fail(new Error('Document preview frame could not load')) }
    frame.onload = () => {
      try {
        if (frame.contentWindow === null) throw new Error('Document preview frame is unavailable')
        frame.contentWindow.postMessage({ ...payload, bytes }, '*', [channel.port2, bytes.buffer])
      } catch (cause) { fail(new Error('Document preview transfer failed', { cause })) }
    }
    signal.addEventListener('abort', abort, { once: true })
    container.append(frame)
  })
}
