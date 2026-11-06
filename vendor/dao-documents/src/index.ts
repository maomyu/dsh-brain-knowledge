/** Project-scoped document preparation; no Session, model request or durable file is created. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as wire } from 'zod'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { runConversionWorker, runPdfRenderWorker, runDocxImagesWorker } from './run-worker.ts'
import type { WorkerInternals } from './run-worker.ts'
import type { DocumentImportInput, DocumentImportPdfRenderResult, DocumentImportResult, DocumentImportDocxImagesResult } from './types.ts'

export type * from './types.ts'

/** Deployment limits apply to direct service calls as well as Remote requests. */
export interface Config {
  /** Inclusive decoded source-byte cap per conversion. */
  readonly maxSourceBytes: number
  /** Inclusive UTF-8 byte cap for complete extracted text, including PDF page markers and separators. */
  readonly maxTextBytes: number
  /** Maximum DOCX ZIP entries inspected before any member is inflated. */
  readonly maxDocxEntries: number
  /** Maximum declared and actual inflated bytes in each DOCX ZIP member. */
  readonly maxDocxEntryBytes: number
  /** Maximum sum of declared and actual inflated DOCX ZIP member bytes. */
  readonly maxDocxArchiveBytes: number
  /** Maximum image elements emitted by Mammoth, including omitted or repeated pictures. */
  readonly maxDocxImageElements: number
  /** Maximum PDF page count before extraction; required deployment choice. */
  readonly maxPdfPages: number
  /** Maximum original PDF pages rasterized for one compilation. */
  readonly maxPdfRenderedPages: number
  /** Maximum decoded pixels allocated for one rendered page. */
  readonly maxPdfRenderPixels: number
  /** Maximum width or height in pixels for one rendered page. */
  readonly maxPdfRenderDimension: number
  /** Maximum encoded PNG bytes retained for one rendered page. */
  readonly maxPdfRenderPageBytes: number
  /** Maximum encoded PNG bytes returned from one rendering worker. */
  readonly maxPdfRenderTotalBytes: number
  /** Target page raster scale, reduced to fit pixel and dimension limits. */
  readonly pdfRenderScale: number
  /** Active conversion slots; excess requests return busy without queueing. */
  readonly maxConcurrent: number
  /** Wall deadline in milliseconds, followed by awaited worker termination. */
  readonly timeoutMs: number
  /** Worker old-generation heap cap in MiB; excludes native/external memory. */
  readonly maxOldGenerationSizeMb: number
}

const inputSchema = wire.object({
  name: wire.string().min(1).max(1024).refine(name => !/[/\\\0]/u.test(name) && name !== '.' && name !== '..'),
  format: wire.enum(['text', 'docx', 'pdf']),
  dataBase64: wire.string(),
}).strict()

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stateless project-document preparation Remote owner. */
    documentImportController: DocumentImportController
  }
}

/** Converts explicitly supplied documents without granting read access to Host file paths. */
export class DocumentImportController extends TypertRemoteService {
  static inject = ['workspaceRegistry']
  static Config: z<Partial<Config>, Config> = z.object({
    maxSourceBytes: z.number().step(1).min(1).default(25 * 1024 * 1024),
    maxTextBytes: z.number().step(1).min(1).default(25 * 1024 * 1024),
    maxDocxEntries: z.number().step(1).min(1).default(2048),
    maxDocxEntryBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
    maxDocxArchiveBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
    maxDocxImageElements: z.number().step(1).min(1).default(1000),
    maxPdfPages: z.number().step(1).min(1).required(),
    maxPdfRenderedPages: z.number().step(1).min(1).default(20),
    maxPdfRenderPixels: z.number().step(1).min(1).default(4_000_000),
    maxPdfRenderDimension: z.number().step(1).min(1).default(2048),
    maxPdfRenderPageBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxPdfRenderTotalBytes: z.number().step(1).min(1).default(10 * 1024 * 1024),
    pdfRenderScale: z.number().min(0.01).max(8).default(2),
    maxConcurrent: z.number().step(1).min(1).default(2),
    timeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
    maxOldGenerationSizeMb: z.number().step(1).min(16).default(256),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param ctx - Host context with the registered project directory.
   * @param config - validated conversion limits.
   * @param internals - test-only worker entry override.
   */
  constructor(ctx: Context, private readonly config: Config, private readonly internals: WorkerInternals = {}) {
    super(ctx, 'documentImportController', { namespace: 'documentImports' })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('document preparation service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /**
   * Prepare one caller-selected document as an ephemeral draft.
   * @param workspaceId - registered project; rechecked after asynchronous conversion.
   * @param input - leaf display name, explicit conversion and canonical base64 bytes; no Host path.
   * @param signal - caller/connection lifetime; abort waits for conversion shutdown.
   * @returns text or a stable candidate refusal; creates no Session, attachment or model input.
   */
  @Remote
  async prepare(workspaceId: WorkspaceId, input: DocumentImportInput, signal: AbortSignal): Promise<DocumentImportResult> {
    const { lifetime, assertCurrent } = this.operation(workspaceId, signal)
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid document import input', {})
    if (this.pending.size >= this.config.maxConcurrent) return { status: 'rejected', reason: 'busy' }
    const encoded = parsed.data.dataBase64
    if (encoded.length > 4 * Math.ceil(this.config.maxSourceBytes / 3)) return { status: 'rejected', reason: 'too-large' }
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
      return { status: 'rejected', reason: 'unreadable' }
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength > this.config.maxSourceBytes) return { status: 'rejected', reason: 'too-large' }
    if (bytes.toString('base64') !== encoded) return { status: 'rejected', reason: 'unreadable' }
    const work = Promise.resolve().then(async (): Promise<DocumentImportResult> => {
      const result = await runConversionWorker({
        data: bytes, format: parsed.data.format, maxTextBytes: this.config.maxTextBytes, maxPdfPages: this.config.maxPdfPages,
        ...this.docxLimits(),
      }, this.config, lifetime, this.internals)
      assertCurrent('preparation')
      return result.status === 'rejected' ? result : {
        status: 'ready', format: result.format, text: result.text, name: parsed.data.name,
        sourceBytes: bytes.byteLength, textBytes: Buffer.byteLength(result.text, 'utf8'),
        ...result.extraction === undefined ? {} : { extraction: result.extraction },
      }
    })
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  /**
   * Rasterize original PDF bytes for one retained Host import without exposing them through Remote.
   * @param workspaceId - registered project, rechecked after worker completion.
   * @param data - exact original PDF bytes already admitted by the import owner.
   * @param bounds - remaining image count and byte budget for the complete compilation message.
   * @param signal - caller lifetime; abort joins worker termination.
   * @returns bounded page PNGs with explicit omitted-page coverage, or a stable refusal.
   */
  async renderPdf(workspaceId: WorkspaceId, data: Uint8Array,
    bounds: {
      readonly maxPages: number
      readonly maxTotalBytes: number
      readonly maxPageBytes: number
      readonly maxPixels: number
      readonly maxDimension: number
    },
    signal: AbortSignal): Promise<DocumentImportPdfRenderResult> {
    const { lifetime, assertCurrent } = this.operation(workspaceId, signal)
    if (data.byteLength > this.config.maxSourceBytes) return { status: 'rejected', reason: 'too-large' }
    if (this.pending.size >= this.config.maxConcurrent) return { status: 'rejected', reason: 'busy' }
    const work = Promise.resolve().then(async (): Promise<DocumentImportPdfRenderResult> => {
      const result = await runPdfRenderWorker({
        data, format: 'pdf-render', maxPdfPages: this.config.maxPdfPages,
        maxRenderedPages: Math.min(bounds.maxPages, this.config.maxPdfRenderedPages),
        maxPagePixels: Math.min(bounds.maxPixels, this.config.maxPdfRenderPixels),
        maxPageDimension: Math.min(bounds.maxDimension, this.config.maxPdfRenderDimension),
        maxPageBytes: Math.min(bounds.maxPageBytes, this.config.maxPdfRenderPageBytes),
        maxTotalBytes: Math.min(bounds.maxTotalBytes, this.config.maxPdfRenderTotalBytes),
        scale: this.config.pdfRenderScale,
      }, this.config, lifetime, this.internals)
      assertCurrent('rendering')
      return result
    })
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  /**
   * Extract bounded embedded PNG/JPEG pictures separately from DOCX text conversion.
   * @param workspaceId - owning registered project, rechecked after processing.
   * @param data - complete original DOCX bytes; no Host path or network image access.
   * @param bounds - remaining message budgets and pre-decode raster admission limits.
   * @param signal - caller lifetime; cancellation joins worker termination.
   * @returns numbered embedded pictures and omissions, not Word pages or complete drawing coverage.
   */
  async extractDocxImages(workspaceId: WorkspaceId, data: Uint8Array,
    bounds: {
      readonly maxImages: number
      readonly maxImageBytes: number
      readonly maxTotalBytes: number
      readonly maxPixels: number
      readonly maxDimension: number
    }, signal: AbortSignal): Promise<DocumentImportDocxImagesResult> {
    const { lifetime, assertCurrent } = this.operation(workspaceId, signal)
    if (data.byteLength > this.config.maxSourceBytes) return { status: 'rejected', reason: 'too-large' }
    if (this.pending.size >= this.config.maxConcurrent) return { status: 'rejected', reason: 'busy' }
    const work = Promise.resolve().then(async (): Promise<DocumentImportDocxImagesResult> => {
      const result = await runDocxImagesWorker({ data, format: 'docx-images', ...bounds,
        ...this.docxLimits(),
      }, this.config, lifetime, this.internals)
      assertCurrent('image extraction')
      return result
    })
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  private operation(workspaceId: WorkspaceId, signal: AbortSignal) {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'document import project is unavailable', { workspaceId })
    return { lifetime, assertCurrent: (phase: 'preparation' | 'rendering' | 'image extraction'): void => {
      lifetime.throwIfAborted()
      if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace) {
        throw new RemoteError('workspace/not-found', `document import project changed during ${phase}`, { workspaceId })
      }
    } }
  }

  private docxLimits() {
    const { maxDocxEntries, maxDocxEntryBytes, maxDocxArchiveBytes, maxDocxImageElements } = this.config
    return { maxDocxEntries, maxDocxEntryBytes, maxDocxArchiveBytes, maxDocxImageElements }
  }
}

export default DocumentImportController
