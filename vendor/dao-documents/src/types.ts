/** Wire-safe document preparation, independent of Session and attachment identities. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Selection-provider identity; a display name alone does not identify a document. */
export type DocumentImportSourceId = string & Branded<'DocumentImportSourceId'>

/** Ephemeral native selection grant, scoped to one renderer document. */
export type DocumentImportSelectionId = string & Branded<'DocumentImportSelectionId'>

/** Explicit text conversion selected by the import coordinator; visual rendering is a separate Host operation. */
export type DocumentImportFormat = 'text' | 'docx' | 'pdf'

/** Source bytes supplied by an explicit file selection; names never authorize Host paths. */
export interface DocumentImportInput {
  readonly name: string
  readonly format: DocumentImportFormat
  readonly dataBase64: string
}

/** Candidate failure, distinct from transport failure and caller cancellation. */
export type DocumentImportFailure = 'too-large' | 'unreadable' | 'too-many-pages' | 'timed-out' | 'busy' | 'processor-failed'

/** PDF text extraction coverage, not a claim that layout, images or all visible content were read. */
export interface PdfTextExtraction {
  readonly kind: 'pdf-text'
  readonly pageCount: number
  /** Strictly increasing one-based pages with no extracted text; these may be blank or contain unread visual content. */
  readonly pagesWithoutText: readonly number[]
  /** Strictly increasing one-based text-bearing pages with PDF.js image-paint operations; omission on retained receipts means unknown. */
  readonly pagesWithTextAndPaintedImages?: readonly number[] | undefined
}

/** Images emitted by Mammoth during DOCX text conversion, without image content or layout analysis. */
export interface DocxTextExtraction {
  readonly kind: 'docx-text'
  readonly imageCount: number
  /** Images with absent, empty or whitespace-only descriptions. */
  readonly imagesWithoutDescription: number
}

/** Format-specific coverage for prepared document text. */
export type DocumentTextExtraction = PdfTextExtraction | DocxTextExtraction

/** Prepared text remains an ephemeral draft; this result neither stores bytes nor starts a model. */
export type DocumentImportResult =
  | {
    readonly status: 'ready'
    readonly name: string
    readonly format: 'text' | 'markdown'
    readonly text: string
    readonly sourceBytes: number
    readonly textBytes: number
    /** PDF or DOCX text coverage; absence on older retained results means coverage is unknown. */
    readonly extraction?: DocumentTextExtraction
  }
  | { readonly status: 'rejected'; readonly reason: DocumentImportFailure }

/** Host-only rendering result; page bytes become durable only when the caller saves each PNG. */
export type DocumentImportPdfRenderResult =
  | {
    readonly status: 'ready'
    readonly pageCount: number
    readonly pages: readonly { readonly page: number; readonly data: Uint8Array }[]
    readonly omittedReason?: 'page-limit' | 'byte-limit' | 'render-failed' | undefined
  }
  | { readonly status: 'rejected'; readonly reason: DocumentImportFailure }

/** Why one Mammoth-emitted DOCX image was not supplied; numbering does not describe Word pages. */
export type DocumentImportDocxImageOmission = 'text-only-route' | 'image-limit' | 'byte-limit'
  | 'unsupported-format' | 'unreadable-image'

/** Bounded embedded raster bytes, independent of Word page layout or unextracted drawings. */
export type DocumentImportDocxImagesResult =
  | {
    readonly status: 'ready'
    readonly imageCount: number
    readonly images: readonly {
      readonly image: number
      readonly mediaType: 'image/png' | 'image/jpeg'
      readonly data: Uint8Array
    }[]
    readonly omittedImages: readonly { readonly image: number; readonly reason: DocumentImportDocxImageOmission }[]
  }
  | { readonly status: 'rejected'; readonly reason: DocumentImportFailure }

/** OS picker inputs; defaultPath selects the initial directory, never grants read access. */
export interface NativeDocumentImportRequest {
  readonly kind: 'files' | 'folder'
  readonly defaultPath: string
  readonly locale: 'en' | 'zh-CN'
}

/** Selected file metadata without a filesystem path or eagerly read bytes. */
export interface NativeDocumentImportSource {
  readonly id: DocumentImportSourceId
  readonly name: string
  readonly size: number
  readonly format: DocumentImportFormat | null
}

/** A bounded selection; truncated means more candidates or directory entries may exist. */
export type NativeDocumentImportSelection =
  | {
    readonly status: 'selected'
    readonly id: DocumentImportSelectionId
    readonly sources: readonly NativeDocumentImportSource[]
    readonly truncated: boolean
  }
  | { readonly status: 'cancelled' | 'busy' | 'failed' }

/** Read failures expose no OS error text or filesystem paths. */
export type NativeDocumentImportRead =
  | { readonly status: 'ready'; readonly dataBase64: string }
  | { readonly status: 'rejected'; readonly reason: 'unavailable' | 'changed' | 'too-large' | 'read-failed' | 'busy' }

/** Desktop-only bridge; callers release each selection after preparation or cancellation. */
export interface NativeDocumentImportBridge {
  /**
   * Ask the OS to select files or one folder; selection alone never starts a model.
   * @param request - explicit picker kind, locale and initial directory.
   * @returns bounded metadata or a cancelled/busy/failed result.
   */
  select(request: NativeDocumentImportRequest): Promise<NativeDocumentImportSelection>
  /**
   * Read an unchanged selected file within the desktop byte cap; no arbitrary path input is accepted.
   * @param selectionId - live selection grant from this renderer document.
   * @param sourceId - file identity returned with that selection.
   * @returns canonical base64 or a stable rejection reason.
   */
  read(selectionId: DocumentImportSelectionId, sourceId: DocumentImportSourceId): Promise<NativeDocumentImportRead>
  /**
   * Revoke selected files immediately, cancel their reads and wait for file handles to close.
   * @param selectionId - selection to release; unknown or previously released ids are harmless.
   * @returns after this selection's reads settle.
   */
  release(selectionId: DocumentImportSelectionId): Promise<void>
}
