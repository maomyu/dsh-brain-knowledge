/** Strict messages crossing the document-conversion worker boundary. */
import { z } from 'zod'
import type { DocxTextExtraction, PdfTextExtraction, DocumentImportDocxImagesResult } from './types.ts'

/** DOCX limits are checked before archive inflation or image decode. */
const docxLimits = {
  maxDocxEntries: z.number().int().positive(),
  maxDocxEntryBytes: z.number().int().positive(),
  maxDocxArchiveBytes: z.number().int().positive(),
  maxDocxImageElements: z.number().int().positive(),
}

/** Worker input owns a structured-cloned byte array and explicit output limits. */
export const conversionInput = z.object({
  data: z.custom<Uint8Array>((value): value is Uint8Array => value instanceof Uint8Array),
  format: z.enum(['text', 'docx', 'pdf']),
  maxTextBytes: z.number().int().positive(),
  maxPdfPages: z.number().int().positive(),
  ...docxLimits,
}).strict()

/** Private DOCX raster extraction applies shared message budgets without changing text conversion. */
export const docxImagesInput = z.object({
  data: z.custom<Uint8Array>((value): value is Uint8Array => value instanceof Uint8Array),
  format: z.literal('docx-images'),
  ...docxLimits,
  maxImages: z.number().int().positive(),
  maxImageBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  maxPixels: z.number().int().positive(),
  maxDimension: z.number().int().positive(),
}).strict()

/** Rendered PDF pages stay inside the private worker/Host channel until attachment storage commits them. */
export const pdfRenderInput = z.object({
  data: z.custom<Uint8Array>((value): value is Uint8Array => value instanceof Uint8Array),
  format: z.literal('pdf-render'),
  maxPdfPages: z.number().int().positive(),
  maxRenderedPages: z.number().int().positive(),
  maxPagePixels: z.number().int().positive(),
  maxPageDimension: z.number().int().positive(),
  maxPageBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  scale: z.number().positive(),
}).strict()

const pdfTextExtraction = z.object({
  kind: z.literal('pdf-text'),
  pageCount: z.number().int().positive(),
  pagesWithoutText: z.array(z.number().int().positive()),
  pagesWithTextAndPaintedImages: z.array(z.number().int().positive()).optional(),
}).strict().refine(value => value.pagesWithoutText.length <= value.pageCount
  && value.pagesWithoutText.every((page, index) => {
    const previous = value.pagesWithoutText[index - 1]
    return page <= value.pageCount && (previous === undefined || page > previous)
  }) && (value.pagesWithTextAndPaintedImages === undefined
  || value.pagesWithTextAndPaintedImages.length <= value.pageCount - value.pagesWithoutText.length
  && value.pagesWithTextAndPaintedImages.every((page, index, pages) => {
    const previous = pages[index - 1]
    return page <= value.pageCount && (previous === undefined || page > previous)
      && !value.pagesWithoutText.includes(page)
  }))) satisfies z.ZodType<PdfTextExtraction>

const docxTextExtraction = z.object({
  kind: z.literal('docx-text'),
  imageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  imagesWithoutDescription: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.imagesWithoutDescription <= value.imageCount) satisfies z.ZodType<DocxTextExtraction>

const textExtraction = z.discriminatedUnion('kind', [pdfTextExtraction, docxTextExtraction])

/** Conversion responses contain no library errors, paths, HTML or original binary bytes. */
export const conversionResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), format: z.enum(['text', 'markdown']), text: z.string(),
    extraction: textExtraction.optional() }).strict().refine(value => value.extraction === undefined
      || (value.extraction.kind === 'pdf-text'
        ? value.format === 'text' && (value.text.trim().length > 0
          || value.extraction.pagesWithoutText.length === value.extraction.pageCount)
        : value.format === 'markdown' && (value.text.trim().length > 0 || value.extraction.imageCount > 0))),
  z.object({ status: z.literal('rejected'), reason: z.enum(['too-large', 'unreadable', 'too-many-pages']) }).strict(),
])

/** A short prefix can be rendered; `omittedReason` names why later pages have no visual evidence. */
export const pdfRenderResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), pageCount: z.number().int().positive(),
    pages: z.array(z.object({ page: z.number().int().positive(), data: z.custom<Uint8Array>(
      (value): value is Uint8Array => value instanceof Uint8Array) }).strict()),
    omittedReason: z.enum(['page-limit', 'byte-limit', 'render-failed']).optional(),
  }).strict().refine(value => value.pages.length <= value.pageCount
    && value.pages.every((page, index) => page.page === index + 1)
    && (value.pages.length === value.pageCount) === (value.omittedReason === undefined)),
  z.object({ status: z.literal('rejected'), reason: z.enum(['unreadable', 'too-many-pages']) }).strict(),
])

/** Validated worker input. */
export type ConversionInput = z.infer<typeof conversionInput>
/** Validated worker result. */
export type ConversionResult = z.infer<typeof conversionResult>
/** Validated private PDF page rendering request. */
export type PdfRenderInput = z.infer<typeof pdfRenderInput>
/** Validated private PDF page rendering result. */
export type PdfRenderResult = z.infer<typeof pdfRenderResult>

/** Each emitted image occurs exactly once as supplied pixels or an explicit omission. */
export const docxImagesResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), imageCount: z.number().int().nonnegative(),
    images: z.array(z.object({ image: z.number().int().positive(), mediaType: z.enum(['image/png', 'image/jpeg']),
      data: z.custom<Uint8Array>((value): value is Uint8Array => value instanceof Uint8Array) }).strict()),
    omittedImages: z.array(z.object({ image: z.number().int().positive(),
      reason: z.enum(['image-limit', 'byte-limit', 'unsupported-format', 'unreadable-image']),
    }).strict()),
  }).strict().refine((value) => {
    const numbers = [...value.images.map(item => item.image), ...value.omittedImages.map(item => item.image)].sort((a, b) => a - b)
    return numbers.length === value.imageCount && numbers.every((image, index) => image === index + 1)
      && value.images.every((item, index) => item.image > (value.images[index - 1]?.image ?? 0))
      && value.omittedImages.every((item, index) => item.image > (value.omittedImages[index - 1]?.image ?? 0))
  }),
  z.object({ status: z.literal('rejected'), reason: z.enum(['too-large', 'unreadable']) }).strict(),
]) satisfies z.ZodType<DocumentImportDocxImagesResult>

/** Validated DOCX embedded-image extraction request. */
export type DocxImagesInput = z.infer<typeof docxImagesInput>
/** Validated DOCX raster extraction response. */
export type DocxImagesResult = z.infer<typeof docxImagesResult>
