/** Show coding paths whose contents cannot support a complete Task knowledge conclusion. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskCodingOmission } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

/** @param props - Host-bound omissions from one retained coding output inventory.
 * @returns file-level limitations and draft-only status, or no element for a complete review.
 */
export function CodingCoverageReview({ files, t }: PropsLocale<'tasks'> & {
  readonly files: readonly ProjectTaskCodingOmission[] | undefined
}) {
  if (files === undefined || files.length === 0) return null
  return <section className={css.notice} aria-label={t('codingCoverage.title')} data-coding-coverage>
    <h4>{t('codingCoverage.title')}</h4>
    <p role="alert">{t('codingCoverage.warning', { count: files.length })}</p>
    <ul>{files.map(file => <li key={`${file.path}/${file.change}`}>
      <code>{file.path}</code> · {t(`codingCoverage.reason.${file.reason}`)}
    </li>)}</ul>
  </section>
}
