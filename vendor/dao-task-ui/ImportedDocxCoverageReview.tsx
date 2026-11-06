/** Display the actual DOCX embedded-image supply without claiming Word page or layout coverage. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskImportedDocxCoverage } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

/** Show retained image numbers and omissions for the current or historical independent review.
 * @param props - Host-recorded source coverage and complete typed locale seat.
 * @returns exact image supply plus layout and quote warnings, or no notice for absent metadata.
 */
export function ImportedDocxCoverageReview({ sources, t }: {
  sources: readonly ProjectTaskImportedDocxCoverage[] | undefined
} & PropsLocale<'tasks'>) {
  if (sources === undefined || sources.length === 0) return null
  return <section className={css.notice} aria-label={t('importedDocx.title')} data-task-imported-docx-coverage>
    <h4>{t('importedDocx.title')}</h4>
    <p>{t('importedDocx.layoutWarning')}</p>
    <p>{t('importedDocx.quoteWarning')}</p>
    <ul>{sources.map(source => <li key={source.sourceId}>
      <p>{source.name} · {t('importedDocx.imageCount', { count: source.imageCount })}</p>
      <code>{source.sourceId}</code>
      <p>{t('importedDocx.supplied', { images: source.suppliedImages.join(', ') || t('importedDocx.none') })}</p>
      {source.omittedImages.length === 0 ? <p>{t('importedDocx.noOmissions')}</p>
        : <ul>{source.omittedImages.map(image => <li key={image.image} role="alert">
          {t('importedDocx.omitted', { image: image.image })}{' · '}{t(`importedDocx.reason.${image.reason}`)}
        </li>)}</ul>}
    </li>)}</ul>
  </section>
}
