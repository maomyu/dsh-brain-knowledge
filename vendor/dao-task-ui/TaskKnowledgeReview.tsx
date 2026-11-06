/** Task knowledge review is independent of execution, outcome delivery and human verification. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskState } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

type Review = NonNullable<ProjectTaskState['knowledgeReview']>

/** Offer a fresh review only for automatically authorized successful documentation with retained output.
 * @param authorization - immutable Task confirmation policy.
 * @param outcome - current execution completion, independent of knowledge review.
 * @param draft - accepted documentation trace and selected knowledge pages.
 * @returns whether the UI may offer recheck; the Host revalidates admission on the gesture.
 */
export function canRecheckTaskKnowledge(
  authorization: ProjectTaskState['knowledgeMaintenanceAuthorization'],
  outcome: Pick<ProjectTaskState, 'status' | 'artifactOutput'> | undefined,
  draft: Pick<ProjectTaskState, 'artifact' | 'brainRefs'>,
): boolean {
  return authorization?.mode === 'automatic' && outcome?.status === 'closed-success'
    && outcome.artifactOutput !== undefined && draft.artifact?.trace !== undefined
    && (draft.brainRefs?.length ?? 0) > 0
}

/** Present Host-owned review evidence and require a separate gesture for another review turn.
 * @param props - durable state, signed references and project-qualified actions.
 * @returns a knowledge review status with explicit recovery and stop controls.
 */
export function TaskKnowledgeReview({ review, refs, busy, allowRecheck = false, start, stop, t }: {
  review: Review
  refs: readonly string[]
  busy: boolean
  allowRecheck?: boolean
  start: () => void
  stop: () => void
} & PropsLocale<'tasks'>) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setConfirming(false) }, [review.status, allowRecheck])
  const settled = review.status === 'reviewed-no-change' || review.status === 'updated' ? review : undefined
  const canStart = review.status === 'needs-review' || review.status === 'blocked'
    || (allowRecheck && settled !== undefined)
  const reviewedAt = settled?.reviewedAt
  const date = reviewedAt === undefined ? null : new Intl.DateTimeFormat(t('date.locale'), {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(reviewedAt)
  return <section aria-label={t('taskKnowledge.title')} className={css.codeReview} aria-busy={busy || review.status === 'reviewing'}>
    <h2>{t('taskKnowledge.title')}</h2>
    <p role="status">{t(`taskKnowledge.status.${review.status}`)}</p>
    <p className={css.notice}>{t('taskKnowledge.independent')}</p>
    {refs.length > 0 && <details><summary>{t('taskKnowledge.refs', { count: refs.length })}</summary>
      <ul>{refs.map(path => <li key={path}><code>{path}</code></li>)}</ul>
    </details>}
    {settled !== undefined && <details><summary>{t('taskKnowledge.reviewedPages', { count: settled.pages.length })}</summary>
      <ul>{settled.pages.map(page => <li key={page}><code>{page}</code></li>)}</ul>
    </details>}
    {review.status === 'updated' && <details><summary>{t('taskKnowledge.writes', { count: review.operations.length })}</summary>
      <ul>{review.operations.map(operation => <li key={operation.operationId}>
        <code>{operation.page}</code> · <code>{operation.operationId}</code>
      </li>)}</ul>
    </details>}
    {date !== null && reviewedAt !== undefined && <p><time dateTime={new Date(reviewedAt).toISOString()}>{t('taskKnowledge.reviewedAt', { date })}</time></p>}
    {review.status === 'blocked' && <p role="alert">{t(`taskKnowledge.failure.${review.failure}`)}</p>}
    {canStart && !confirming && <Button size="sm" disabled={busy} onClick={() => { setConfirming(true) }}>
      {t(settled !== undefined ? 'taskKnowledge.recheck' : review.status === 'blocked' ? 'taskKnowledge.retry' : 'taskKnowledge.start')}
    </Button>}
    {canStart && confirming && <div role="group" aria-label={t('taskKnowledge.confirmTitle')} className={css.notice}>
      <p>{t('taskKnowledge.confirmation')}</p>
      <div className={css.reviewActions}>
        <Button size="sm" disabled={busy} onClick={() => { setConfirming(false); start() }}>{t('taskKnowledge.confirm')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirming(false) }}>{t('taskKnowledge.dismiss')}</Button>
      </div>
    </div>}
    {review.status === 'reviewing' && <Button variant="outline" size="sm" disabled={busy} onClick={stop}>
      {t('taskKnowledge.stop')}
    </Button>}
  </section>
}
