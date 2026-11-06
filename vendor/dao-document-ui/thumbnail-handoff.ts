/** Shared validation for a file and locally bundled modules entering an isolated thumbnail document. */

/** Admit exactly one parent-owned private port; reject incomplete renderer input on that port.
 * @param event - cross-document handoff; unrelated messages receive no response.
 * @returns validated bytes and main module plus the optional, format-owned worker value.
 */
export function thumbnailHandoff(event: MessageEvent<unknown>): {
  port: MessagePort
  bytes: Uint8Array
  moduleSource: string
  workerSource: unknown
} | undefined {
  const [port] = event.ports
  if (event.source !== parent || port === undefined || event.ports.length !== 1) return
  const value = event.data
  if (typeof value !== 'object' || value === null || !('bytes' in value) || !(value.bytes instanceof Uint8Array)
    || !('moduleSource' in value) || typeof value.moduleSource !== 'string') {
    port.postMessage({ error: true })
    port.close()
    return
  }
  return { port, bytes: value.bytes, moduleSource: value.moduleSource, workerSource: 'workerSource' in value ? value.workerSource : undefined }
}
