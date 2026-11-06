/** DOCX extraction and supplied-image coverage come from retained Host receipts. */
import type { DocxTextExtraction } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { KnowledgeImportDocxVisualCoverage } from '@deepseek-ai/dsh-api-knowledge-import-controller/types'
import type { KnowledgeText } from './props.ts'
import css from './ImportDialog.module.css'

/** Distinguish embedded images supplied for review from unverified descriptions and layout.
 * @param props - original file label, preparation state and retained extraction/visual receipts.
 * @returns supplied and omitted image numbers, or a pending, unknown or text-only notice.
 */
export function DocxExtractionNotice({ name, prepared, extraction, visual, t }: {
  name: string
  prepared: boolean
  extraction: DocxTextExtraction | undefined
  visual?: KnowledgeImportDocxVisualCoverage | undefined
  t: KnowledgeText
}) {
  return <div className={css.coverage} role="note" aria-label={t('import.docx.coverage', { name })}>
    {!prepared ? <p>{t('import.docx.pending')}</p>
      : visual !== undefined ? <>
        <p>{t('import.docx.imageCount', { count: visual.imageCount })}</p>
        <p>{visual.suppliedImages.length === 0 ? t('import.docx.visualNone')
          : t('import.docx.visualSupplied', { images: visual.suppliedImages.join(', ') })}</p>
        {visual.omittedImages.length > 0 && <ul>{visual.omittedImages.map(item => <li key={item.image}>{t(
          'import.docx.visualOmitted', { image: item.image, reason: t(`import.docx.visualReason.${item.reason}`) },
        )}</li>)}</ul>}
        <p>{t('import.docx.visualCaution')}</p>
        <p>{t('import.docx.layoutUnreviewed')}</p>
      </> : extraction === undefined ? <p>{t('import.docx.unknown')}</p>
        : <>
          <p>{t('import.docx.imageCount', { count: extraction.imageCount })}</p>
          <p>{t('import.docx.visuals')}</p>
          <p>{extraction.imageCount === 0 ? t('import.docx.noImages')
            : extraction.imagesWithoutDescription > 0
              ? t('import.docx.withoutDescription', { count: extraction.imagesWithoutDescription })
              : t('import.docx.allDescribed')}</p>
        </>}
  </div>
}
