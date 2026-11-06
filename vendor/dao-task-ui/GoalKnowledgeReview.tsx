/** Terminal knowledge review is an explicit file-versioned gesture, independent of Git delivery. */
import { useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeDocumentId, KnowledgeGoalChangeView, KnowledgeGoalReview, KnowledgeGoalWriteHistory, KnowledgeUpdateId,
  ProjectGoalRunId, ProjectGoalState } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from './props.ts'
import css from './GoalKnowledgeReview.module.css'

/** Source-session-bound reads and human decisions; neither operation invokes a model. */
export interface GoalKnowledgeInjected {
  loadKnowledgeHistory: (runId: ProjectGoalRunId, signal: AbortSignal) => Promise<KnowledgeGoalWriteHistory>
  loadKnowledge: (runId: ProjectGoalRunId, path: KnowledgeDocumentId, signal: AbortSignal,
    projectId?: WorkspaceId) => Promise<KnowledgeGoalChangeView>
  reviewKnowledge: (runId: ProjectGoalRunId, path: KnowledgeDocumentId, request: KnowledgeGoalReview,
    signal: AbortSignal, projectId?: WorkspaceId) => Promise<void>
}

type ReviewProps = GoalKnowledgeInjected & PropsLocale<'tasks'> & { goal: ProjectGoalState }
type ChangeRead = { view: KnowledgeGoalChangeView; error?: never } | { error: string; view?: never }
type KnowledgeTarget = { path: KnowledgeDocumentId; projectId?: WorkspaceId }
const targetKey = (target: KnowledgeTarget): string => JSON.stringify([target.projectId ?? null, target.path])

function uniqueTargets(targets: KnowledgeTarget[]): KnowledgeTarget[] {
  return [...new Map(targets.map(target => [targetKey(target), target])).values()]
}

/** Show recorded rewrites without suppressing missing-file or recovery failures.
 * @param props - terminal Goal, source-qualified callbacks and locale-owned copy.
 * @returns a collapsible review with immediately visible, independently scrolling knowledge diffs.
 */
export function GoalKnowledgeReview({ goal, ...props }: ReviewProps) {
  const plans = [...goal.plan === undefined ? [] : [goal.plan], ...goal.planHistory
    ?.filter(item => item.review.input.decision === 'approve').map(item => item.plan) ?? []]
  const paths = uniqueTargets(plans.flatMap((plan) => {
    const files = [...plan.input.brainRefs, ...plan.input.rootPageRefs.map(slug => `${slug}.md`)] as KnowledgeDocumentId[]
    return files.flatMap(path => [{ path }, ...plan.input.brainProjectIds?.map(projectId => ({ path, projectId })) ?? []])
  }))
  const key = JSON.stringify([goal.sourceSessionId, goal.id, goal.plan?.requestId, goal.resumeRevision ?? 0, paths])
  return <KnowledgeReviewHistory key={key}
    {...props} goal={goal} paths={paths} />
}

function KnowledgeReviewHistory({ goal, paths, ...props }: ReviewProps & { paths: KnowledgeTarget[] }) {
  const [history, setHistory] = useState<KnowledgeGoalWriteHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const { loadKnowledgeHistory, t } = props
  useEffect(() => {
    const controller = new AbortController()
    setHistory(null)
    setError(null)
    void loadKnowledgeHistory(goal.id, controller.signal).then((value) => {
      if (!controller.signal.aborted) setHistory(value)
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('brainReview.unavailable'))
    })
    return () => { controller.abort() }
  }, [goal.id, loadKnowledgeHistory, t, revision])
  if (history === null) return <details className={css.panel} open data-goal-knowledge-review={goal.id}>
    <summary>{t('brainReview.title')}</summary>
    {error === null ? <p role="status">{t('brainReview.loading')}</p> : <div role="alert"><p>{error}</p>
      <Button size="sm" onClick={() => { setRevision(value => value + 1) }}>{t('brainReview.refresh')}</Button></div>}
  </details>
  const published = uniqueTargets([...history.publicationPaths.map(path => ({ path })), ...history.publicationTargets ?? []])
  if (history.trackedFromStart && published.length === 0 && history.rejected.length === 0) return null
  return <KnowledgeReviewFiles {...props} goal={goal} history={history}
    paths={history.trackedFromStart ? published : uniqueTargets([...paths, ...published])} />
}

function KnowledgeReviewFiles({ goal, paths: initialPaths, history, ...props }: ReviewProps
  & { paths: KnowledgeTarget[]; history: KnowledgeGoalWriteHistory }) {
  // The parent key binds these files to one source, run and resume interval.
  const [paths] = useState(initialPaths)
  const [reads, setReads] = useState<Partial<Record<string, ChangeRead>>>({})
  const { loadKnowledge, t } = props
  useEffect(() => {
    const controller = new AbortController()
    setReads({})
    for (const target of paths) {
      const key = targetKey(target)
      void loadKnowledge(goal.id, target.path, controller.signal, target.projectId).then((view) => {
        if (!controller.signal.aborted) setReads(previous => ({ ...previous, [key]: { view } }))
      }, (reason: unknown) => {
        if (!controller.signal.aborted) setReads(previous => ({ ...previous,
          [key]: { error: reason instanceof Error ? reason.message : t('brainReview.unavailable') } }))
      })
    }
    return () => { controller.abort() }
  }, [goal.id, paths, loadKnowledge, t])
  const complete = paths.every(target => reads[targetKey(target)]?.view !== undefined)
  const changes = paths.flatMap((path) => {
    const view = reads[targetKey(path)]?.view
    return view?.change == null ? [] : [view]
  })
  return <details className={css.panel} open data-goal-knowledge-review={goal.id}>
    <summary>{t('brainReview.title')}{complete && <span className={css.counts}>{t('brainReview.counts', {
      pages: changes.filter(view => view.kind === 'page').length,
      roots: changes.filter(view => view.kind === 'root').length,
      timeline: paths.reduce((total, path) => total + (reads[targetKey(path)]?.view?.timelineWrites ?? 0), 0),
      rejected: history.trackedFromStart ? history.rejected.length : t('brainReview.unknownCount'),
    })}</span>}</summary>
    <p className={css.hint}>{t('brainReview.hint')}</p>
    {!history.trackedFromStart && <p className={css.hint}>{t('brainReview.historyUnknown')}</p>}
    {complete && changes.length === 0 && <p className={css.hint}>{t('brainReview.noChanges')}</p>}
    <div className={css.pages}>{paths.map(target => <KnowledgeChange key={targetKey(target)}
      {...props} {...target} runId={goal.id} result={reads[targetKey(target)]}
      onRead={(result) => { setReads(previous => ({ ...previous, [targetKey(target)]: result })) }} />)}</div>
  </details>
}

function KnowledgeChange({ runId, path, projectId, loadKnowledge, reviewKnowledge, t, result, onRead }: GoalKnowledgeInjected & PropsLocale<'tasks'>
  & KnowledgeTarget
  & {
    runId: ProjectGoalRunId
    result: ChangeRead | undefined
    onRead: (result: ChangeRead | undefined) => void
  }) {
  const view = result?.view
  const [operationError, setError] = useState<string | null>(null)
  const error = operationError ?? result?.error ?? null
  const loading = result === undefined
  const [busy, setBusy] = useState(false)
  const [retained, setRetained] = useState<KnowledgeGoalReview | null>(null)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    setBusy(false)
    setError(null)
    setRetained(null)
    return () => { controller.abort() }
  }, [runId, path, projectId, loadKnowledge, t])
  const change = view?.change
  const refresh = async (): Promise<void> => {
    const controller = active.current
    if (busy || loading || controller === null) return
    setError(null)
    onRead(undefined)
    try {
      const refreshed = await loadKnowledge(runId, path, controller.signal, projectId)
      if (!controller.signal.aborted) { onRead({ view: refreshed }); setRetained(null) }
    } catch (reason) {
      if (!controller.signal.aborted) onRead({ error: reason instanceof Error ? reason.message : t('brainReview.unavailable') })
    }
  }
  const submit = async (resolution: KnowledgeGoalReview['resolution']): Promise<void> => {
    const controller = active.current
    if (busy || loading || view === undefined || change?.review !== undefined || controller === null) return
    const request = retained ?? { operationId: randomUUID() as KnowledgeUpdateId, expectedVersion: view.version,
      expectedResumeRevision: view.resumeRevision, resolution }
    setRetained(request)
    setBusy(true)
    setError(null)
    try {
      await reviewKnowledge(runId, path, request, controller.signal, projectId)
      const refreshed = await loadKnowledge(runId, path, controller.signal, projectId)
      if (!controller.signal.aborted) { onRead({ view: refreshed }); setRetained(null) }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('brainReview.unavailable'))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  if (view?.change === null && error === null) return null
  const label = view === undefined ? path : view.kind === 'root'
    ? t('brainReview.rootLabel', { slug: path.replace(/\.md$/, '') })
    : `[[${path.replace(/^pages\//, '').replace(/\.md$/, '')}]]`
  const qualifiedPath = projectId === undefined ? path : t('brainReview.target', { project: projectId, path })
  return <article className={css.card} aria-label={qualifiedPath} aria-busy={busy || loading}>
    <header><code title={qualifiedPath}>{projectId === undefined ? label : t('brainReview.target', { project: projectId, path: label })}</code>
      {change != null && <Tag>{t('brainReview.rewrites', { count: change.rewrites.length })}</Tag>}
      {change?.review !== undefined ? <Tag tone={change.review.resolution === 'confirmed' ? 'success' : 'warning'}>
        {t(`brainReview.${change.review.resolution}`)}</Tag>
        : change != null && <div className={css.actions}>{retained !== null && !busy
          ? <Button size="sm" variant="outline" disabled={loading} onClick={() => { void submit(retained.resolution) }}>{t('brainReview.retry')}</Button>
          : <><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { void submit('confirmed') }}>
            {t(busy && retained?.resolution === 'confirmed' ? 'brainReview.keeping' : 'brainReview.keep')}</Button>
          <Button size="sm" variant="outline" disabled={busy || loading} title={t('brainReview.revertHint')}
            onClick={() => { void submit('reverted') }}>
            {t(busy && retained?.resolution === 'reverted' ? 'brainReview.reverting' : 'brainReview.revert')}</Button></>}</div>}
    </header>
    {loading && <p role="status">{t('brainReview.loading')}</p>}
    {error !== null && <div role="alert"><p>{error}</p><Button size="sm" disabled={busy || loading}
      onClick={() => { void refresh() }}>{t('brainReview.refresh')}</Button></div>}
    {change != null && <>
      <ul className={css.reasons}>{change.rewrites.map(item => <li key={item.operationId}>
        <time className={css.time} dateTime={item.at} title={item.at}>{shortTime(item.at)}</time>
        <div className={css.step}>
          <span>{item.rationale}</span>
          <details><summary>{t('brainReview.step')}</summary>
            <p>{t('brainReview.stepSource', { session: change.sourceSessionId })}</p>
            {item.snapshot === undefined ? <p>{t('brainReview.stepUnavailable')}</p> : <>
              <p>{t('brainReview.stepEvidence')}</p><pre className={css.evidence}>{item.snapshot.evidence}</pre>
              <KnowledgeDiff label={t('brainReview.stepDiffFor', { path: qualifiedPath, operation: item.operationId })}
                before={item.snapshot.before} after={item.snapshot.after} />
            </>}
          </details>
        </div>
      </li>)}</ul>
      <KnowledgeDiff label={t('brainReview.diffFor', { path: qualifiedPath })} before={change.before} after={change.after} />
    </>}
  </article>
}

function KnowledgeDiff({ label, before, after }: { label: string; before: string; after: string }) {
  return <pre className={css.diff} aria-label={label}>{diffLines(before, after).map((part, index) =>
    <span key={index} data-kind={part.added ? 'add' : part.removed ? 'remove' : 'same'}>{part.value.split('\n').map((line, lineIndex, lines) =>
      lineIndex === lines.length - 1 && line === '' ? null : <span className={css.line} key={lineIndex}>
        <span className={css.sigil} aria-hidden="true">{part.added ? '+ ' : part.removed ? '− ' : '  '}</span>
        <span className={css.text}>{line}{'\n'}</span></span>)}</span>)}</pre>
}

function shortTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
