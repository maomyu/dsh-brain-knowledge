/** Display the original PDF pages supplied to a settled independent Task review. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskImportedPdfCoverage } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

/** Show Host-recorded page coverage without certifying model interpretation or source quotes.
 * @param props - settled PDF metadata and localized copy.
 * @returns exact supplied and omitted page numbers, or no notice for absent legacy metadata.
 */
export function ImportedPdfCoverageReview({ sources, t }: {
  sources: readonly ProjectTaskImportedPdfCoverage[] | undefined
} & PropsLocale<'tasks'>) {
  if (sources === undefined || sources.length === 0) return null
  return <section className={css.notice} aria-label={t('importedPdf.title')} data-task-imported-pdf-coverage>
    <h4>{t('importedPdf.title')}</h4>
    <p>{t('importedPdf.interpretationWarning')}</p>
    <p>{t('importedPdf.quoteWarning')}</p>
    <ul>{sources.map((source) => {
      const supplied = new Set(source.renderedPages)
      const omitted = Array.from({ length: source.pageCount }, (_, index) => index + 1)
        .filter(page => !supplied.has(page))
      return <li key={source.sourceId}>
        <p>{source.name} · {t('importedPdf.pageCount', { count: source.pageCount })}</p>
        <code>{source.sourceId}</code>
        <p>{t('importedPdf.supplied', { pages: source.renderedPages.join(', ') || t('importedPdf.none') })}</p>
        {omitted.length === 0 ? <p>{t('importedPdf.complete')}</p> : <>
          <p role="alert">{t('importedPdf.omitted', { pages: omitted.join(', ') })}</p>
          {source.omittedReason !== undefined && <p>{t(`importedPdf.reason.${source.omittedReason}`)}</p>}
        </>}
      </li>
    })}</ul>
  </section>
}
