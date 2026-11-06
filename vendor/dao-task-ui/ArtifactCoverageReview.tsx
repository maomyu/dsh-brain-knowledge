/** Host-recorded documentation coverage stays separate from editable model evidence. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskArtifactCoverage } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

type Coverage = PropsLocale<'tasks'> & {
  readonly files: ProjectTaskArtifactCoverage | undefined
  readonly directoryVersion: string | undefined
  readonly coverageSha256: string | undefined
  readonly onOpenFile?: ((path: string, directoryVersion: string) => void) | undefined
}

/** Show immutable Host coverage and the exact retained file paths before a knowledge choice.
 * @param props - candidate coverage and a source-qualified artifact navigation action.
 * @returns file-level limitations without changing model evidence or making a Brain decision.
 */
export function ArtifactCoverageReview({ files, directoryVersion, coverageSha256, onOpenFile, t }: Coverage) {
  if (directoryVersion === undefined && files === undefined) return null
  if (files === undefined && coverageSha256 !== undefined) return null
  if (files === undefined) return <p role="alert" data-artifact-coverage-unknown>
    {t('artifactCoverage.unknown')}</p>
  if (files.length === 0) return null
  const opaque = files.filter(file => file.kind === 'opaque')
  return <section className={css.notice} aria-label={t('artifactCoverage.title')} data-artifact-coverage>
    <h4>{t('artifactCoverage.title')}</h4>
    {opaque.length > 0 && <p role="alert">{t('artifactCoverage.opaqueWarning', { count: opaque.length })}</p>}
    {files.some(file => file.kind === 'converted-text') &&
      <p>{t('artifactCoverage.convertedWarning')}</p>}
    <ul>{files.map(file => <li key={`${file.path}/${file.sha256}`}>
      <code>{file.path}</code> · {file.kind === 'opaque'
        ? t(`artifactCoverage.reason.${file.reason}`)
        : file.extraction.kind === 'pdf-text' ? <>
          {t('artifactCoverage.pdf', { count: file.extraction.pageCount })}
          {' · '}{t('artifactCoverage.pdfWithoutText', { pages: file.extraction.pagesWithoutText.join(', ') || '—' })}
          {' · '}{file.extraction.pagesWithTextAndPaintedImages === undefined
            ? t('artifactCoverage.pdfImagesUnknown')
            : t('artifactCoverage.pdfPaintedImages', {
              pages: file.extraction.pagesWithTextAndPaintedImages.join(', ') || '—',
            })}
        </> : <>{t('artifactCoverage.docx', { count: file.extraction.imageCount })}
          {' · '}{t('artifactCoverage.docxUndescribed', { count: file.extraction.imagesWithoutDescription })}</>}
      {onOpenFile !== undefined && directoryVersion !== undefined && <Button size="sm" variant="ghost"
        onClick={() => { onOpenFile(file.path, directoryVersion) }}>
        {t('artifactCoverage.findFile')}</Button>}
    </li>)}</ul>
  </section>
}
