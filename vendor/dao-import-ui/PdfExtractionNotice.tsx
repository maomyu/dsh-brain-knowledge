/** PDF text and page-image coverage come from retained Host receipts, never model claims. */
import type { PdfTextExtraction } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { KnowledgeImportPdfVisualCoverage } from '@deepseek-ai/dsh-api-knowledge-import-controller/types'
import type { KnowledgeText } from './props.ts'
import css from './ImportDialog.module.css'

/** Explain exact observed PDF coverage without treating omitted or textless pages as blank.
 * @param props - original file label, preparation state and retained extraction/visual receipts.
 * @returns supplied and omitted original page numbers, or an explicit pending/unknown coverage notice.
 */
export function PdfExtractionNotice({ name, prepared, extraction, visual, t }: {
  name: string
  prepared: boolean
  extraction: PdfTextExtraction | undefined
  visual?: KnowledgeImportPdfVisualCoverage | undefined
  t: KnowledgeText
}) {
  const omittedPages = visual === undefined ? [] : Array.from({ length: visual.pageCount }, (_, index) => index + 1)
    .filter(page => !visual.renderedPages.includes(page))
  return <div className={css.coverage} role="note" aria-label={t('import.pdf.coverage', { name })}>
    {!prepared ? <p>{t('import.pdf.pending')}</p>
      : extraction === undefined ? <p>{t('import.pdf.unknown')}</p>
        : <>
          <p>{t(visual === undefined ? 'import.pdf.textOnly' : 'import.pdf.extraction', { count: extraction.pageCount })}</p>
          {visual === undefined ? <p>{t('import.pdf.visuals')}</p> : <>
            <p>{visual.renderedPages.length === 0 ? t('import.pdf.visualNone')
              : t('import.pdf.visualSupplied', { pages: visual.renderedPages.join(', ') })}</p>
            <p>{omittedPages.length === 0 ? t('import.pdf.visualComplete')
              : t('import.pdf.visualOmitted', { pages: omittedPages.join(', ') })}</p>
            {visual.omittedReason !== undefined && <p>{t(`import.pdf.visualReason.${visual.omittedReason}`)}</p>}
            <p>{t('import.pdf.visualCaution')}</p>
          </>}
          <p>{extraction.pagesWithoutText.length > 0
            ? t('import.pdf.withoutText', { pages: extraction.pagesWithoutText.join(', ') }) : t('import.pdf.allText')}</p>
          <p>{extraction.pagesWithTextAndPaintedImages === undefined
            ? t('import.pdf.paintUnknown')
            : extraction.pagesWithTextAndPaintedImages.length > 0
              ? t('import.pdf.paintPages', { pages: extraction.pagesWithTextAndPaintedImages.join(', ') })
              : t('import.pdf.noPaintRecorded')}</p>
        </>}
  </div>
}
