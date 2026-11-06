/** One isolated conversion owns its deadline and awaits worker termination before settling. */
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { conversionResult, pdfRenderResult, docxImagesResult } from './protocol.ts'
import type { ConversionInput, ConversionResult, PdfRenderInput, PdfRenderResult, DocxImagesInput, DocxImagesResult } from './protocol.ts'

/** Host-controlled processing limits; the wire caller cannot raise them. */
export interface WorkerLimits {
  readonly timeoutMs: number
  readonly maxOldGenerationSizeMb: number
}

/** Internal entry replacement for real-worker failure, timeout and teardown tests. */
export interface WorkerInternals {
  readonly entry?: URL
}

/** A conversion attempt may also fail before a valid worker response. */
export type WorkerResult = ConversionResult | { readonly status: 'rejected'; readonly reason: 'timed-out' | 'processor-failed' }
/** Rendering can fail without exposing parser-controlled diagnostics. */
export type PdfRenderWorkerResult = PdfRenderResult | { readonly status: 'rejected'; readonly reason: 'timed-out' | 'processor-failed' }

function workerEntry(): URL {
  /* v8 ignore next -- the built worker entry is exercised by the published-artifact smoke. */
  if (!import.meta.url.endsWith('.ts')) return new URL('./worker.js', import.meta.url)
  const loader = import.meta.resolve('tsx/esm/api')
  const entry = new URL('./worker.ts', import.meta.url)
  return new URL(`data:text/javascript,${encodeURIComponent(
    `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(entry.href)});`,
  )}`)
}

/**
 * Convert with an empty environment, bounded JS heap and no inherited loader/inspector flags.
 * This isolates lifecycle and CPU work, not operating-system access or external-memory allocation.
 * @param input - source bytes and conversion policy, structured-cloned into the worker.
 * @param limits - deployment-owned wall deadline and old-generation heap cap.
 * @param signal - caller lifetime; cancellation rejects only after the worker stops.
 * @param internals - test-only worker entry replacement.
 * @returns a validated conversion result after the worker exits.
 */
async function runWorker<T>(input: ConversionInput | PdfRenderInput | DocxImagesInput, limits: WorkerLimits, signal: AbortSignal,
  validate: (value: unknown) => T | undefined, internals: WorkerInternals): Promise<T | {
    readonly status: 'rejected'
    readonly reason: 'timed-out' | 'processor-failed'
  }> {
  signal.throwIfAborted()
  const options: WorkerOptions = {
    workerData: input, execArgv: [],
    env: process.platform === 'win32' ? { TMP: tmpdir(), TEMP: tmpdir() } : {},
    resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb },
    stdout: true, stderr: true,
  }
  const worker = new Worker(internals.entry ?? workerEntry(), options)
  // Parser diagnostics may include source text; drain without forwarding or retaining them.
  worker.stdout.resume()
  worker.stderr.resume()
  const done = Promise.withResolvers<T | { readonly status: 'rejected'; readonly reason: 'timed-out' | 'processor-failed' }>()
  const fail = (): void => { done.resolve({ status: 'rejected', reason: 'processor-failed' }) }
  const abort = (): void => { done.reject(signal.reason) }
  const timer = setTimeout(() => { done.resolve({ status: 'rejected', reason: 'timed-out' }) }, limits.timeoutMs)
  worker.once('error', fail)
  worker.once('exit', fail)
  worker.once('message', (value: unknown) => {
    const result = validate(value)
    if (result === undefined) { fail(); return }
    done.resolve(result)
  })
  signal.addEventListener('abort', abort, { once: true })
  try {
    const result = await done.promise
    signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await worker.terminate()
    worker.removeAllListeners()
  }
}

/**
 * Convert text with strict worker-response and complete-output validation.
 * @param input - bounded source and selected text conversion.
 * @param limits - worker deadline and heap cap.
 * @param signal - cancellation joined with worker termination.
 * @param internals - test-only worker entry replacement.
 * @returns validated conversion or stable refusal.
 */
export function runConversionWorker(
  input: ConversionInput, limits: WorkerLimits, signal: AbortSignal, internals: WorkerInternals = {},
): Promise<WorkerResult> {
  return runWorker(input, limits, signal, (value): WorkerResult | undefined => {
    const result = conversionResult.safeParse(value)
    if (!result.success) return undefined
    if (result.data.status === 'ready') {
      const extraction = result.data.extraction
      if (input.format === 'pdf'
        ? extraction?.kind !== 'pdf-text' || extraction.pageCount > input.maxPdfPages
        : input.format === 'docx' ? extraction?.kind !== 'docx-text' : extraction !== undefined) return undefined
      if (Buffer.byteLength(result.data.text, 'utf8') > input.maxTextBytes) {
        return { status: 'rejected', reason: 'too-large' }
      }
    }
    return result.data
  }, internals)
}

/**
 * Render one bounded PDF page prefix inside the disposable worker.
 * @param input - original bytes and image/pixel/page limits.
 * @param limits - worker deadline and heap cap.
 * @param signal - cancellation joined with worker termination.
 * @param internals - test-only worker entry replacement.
 * @returns validated PNG page bytes or stable refusal.
 */
export function runPdfRenderWorker(
  input: PdfRenderInput, limits: WorkerLimits, signal: AbortSignal, internals: WorkerInternals = {},
): Promise<PdfRenderWorkerResult> {
  return runWorker(input, limits, signal, (value): PdfRenderWorkerResult | undefined => {
    const result = pdfRenderResult.safeParse(value)
    if (!result.success) return undefined
    if (result.data.status === 'ready') {
      if (result.data.pageCount > input.maxPdfPages || result.data.pages.length > input.maxRenderedPages) return undefined
      let bytes = 0
      for (const page of result.data.pages) {
        if (page.data.byteLength > input.maxPageBytes || page.data.byteLength > input.maxTotalBytes - bytes) return undefined
        bytes += page.data.byteLength
      }
    }
    return result.data
  }, internals)
}

/**
 * Extract original DOCX embedded rasters inside one disposable, bounded worker.
 * @param input - exact original archive bytes and resolved extraction limits.
 * @param limits - worker wall deadline and old-generation heap cap.
 * @param signal - cancellation joined with worker termination.
 * @param internals - test-only worker entry replacement.
 * @returns validated ordered image bytes and omissions, or a stable processing refusal.
 */
export function runDocxImagesWorker(input: DocxImagesInput, limits: WorkerLimits, signal: AbortSignal,
  internals: WorkerInternals = {}): Promise<DocxImagesResult | { readonly status: 'rejected'; readonly reason: 'timed-out' | 'processor-failed' }> {
  return runWorker(input, limits, signal, (value) => {
    const parsed = docxImagesResult.safeParse(value)
    if (!parsed.success) return undefined
    if (parsed.data.status === 'ready') {
      if (parsed.data.imageCount > input.maxDocxImageElements || parsed.data.images.length > input.maxImages) return undefined
      let bytes = 0
      for (const image of parsed.data.images) {
        if (image.data.byteLength === 0 || image.data.byteLength > input.maxImageBytes
          || image.data.byteLength > input.maxTotalBytes - bytes) return undefined
        bytes += image.data.byteLength
      }
    }
    return parsed.data
  }, internals)
}
