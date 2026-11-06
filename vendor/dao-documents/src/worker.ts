/** Private, single-document worker entry. It receives no Host paths, credentials or model access. */
import { parentPort, workerData } from 'node:worker_threads'
import { conversionInput, pdfRenderInput, docxImagesInput } from './protocol.ts'
import { convertDocument, renderPdfPages } from './conversion.ts'
import { extractDocxImages } from './docx-images.ts'

const port = parentPort
if (port === null) throw new Error('document conversion requires its owning worker')
const rendering = pdfRenderInput.safeParse(workerData)
const docxImages = docxImagesInput.safeParse(workerData)
const result = rendering.success ? renderPdfPages(rendering.data)
  : docxImages.success ? extractDocxImages(docxImages.data) : convertDocument(conversionInput.parse(workerData))
void result.then((value) => {
  port.postMessage(value)
  port.close()
}, () => {
  // An unexpected converter rejection ends without a payload; the owner reports processor-failed on exit.
  port.close()
})
