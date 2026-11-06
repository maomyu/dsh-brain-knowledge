/** Read and classify every active Brain page and root at its displayed version before held-draft publication. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskKnowledgeDocumentId, ProjectTaskKnowledgeDraftReview,
  ProjectTaskKnowledgePublishRequest, ProjectTaskId } from '@deepseek-ai/dsh-api-task-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'

/** A complete, project-qualified read of one document listed in the reviewed catalog. */
export type ActiveCatalogPageReader = (projectId: WorkspaceId, taskId: ProjectTaskId,
  draftVersion: string, activeIndexDigest: string, id: ProjectTaskKnowledgeDocumentId,
  expectedVersion: string, signal: AbortSignal) => Promise<{ readonly kind: 'changed' } | {
    readonly kind: 'page' | 'root'
    readonly id: ProjectTaskKnowledgeDocumentId
    readonly title: string
    readonly status: string
    readonly version: string
    readonly body: string
  }>

type Page = ProjectTaskKnowledgeDraftReview['activePages'][number]
type ReviewedPage = ProjectTaskKnowledgePublishRequest['reviewedPages'][number]
type ReadState = { readonly kind: 'loading' | 'changed' | 'error' }
  | { readonly kind: 'ready'; readonly body: string; readonly relation?: ReviewedPage['relation'] }

/** Version-bound full reads and explicit relations for one complete active catalog. */
export interface ActiveCatalogReviewResult {
  readonly key: string
  readonly reviewedPages: readonly ReviewedPage[]
}

const emptyReads: Record<string, ReadState> = {}

/** Identify only a complete catalog and the exact held draft it accompanies.
 * @param projectId - original project owning the held draft and catalog.
 * @param review - complete Host review, including an independently counted page list.
 * @returns stable review identity, or null when the catalog cannot support publication.
 */
export function activeCatalogReviewKey(projectId: WorkspaceId | null,
  review: ProjectTaskKnowledgeDraftReview | null): string | null {
  const rawPages: unknown = review?.activePages
  if (projectId === null || review === null
    || typeof review.document.id !== 'string' || review.document.id.trim() === ''
    || typeof review.document.version !== 'string' || review.document.version.trim() === ''
    || !/^[a-f0-9]{64}$/u.test(review.activeIndexDigest)
    || !Number.isInteger(review.activePageCount) || review.activePageCount < 0
    || !Array.isArray(rawPages) || review.activePageCount !== rawPages.length) return null
  const ids = new Set<string>()
  const pageKeys: string[][] = []
  for (const rawPage of rawPages) {
    const page: unknown = rawPage
    if (typeof page !== 'object' || page === null || !('id' in page)
      || !('title' in page) || !('version' in page)
      || typeof page.id !== 'string' || page.id.trim() === '' || ids.has(page.id)
      || typeof page.title !== 'string' || page.title.trim() === ''
      || typeof page.version !== 'string' || page.version.trim() === '') return null
    ids.add(page.id)
    pageKeys.push([page.id, page.title, page.version])
  }
  return JSON.stringify([projectId, review.document.id, review.document.version, review.activeIndexDigest,
    pageKeys])
}

/** Show version-bound full reads and require an explicit relation for every active page.
 * @param props - exact review, original project, read-only reader and parent publication admission setter.
 * @returns catalog rows with full Markdown, relation choices and explicit read/retry states.
 */
export function ActiveCatalogReview({ projectId, taskId, review, reader, onReviewed, t }: {
  projectId: WorkspaceId | null
  taskId: ProjectTaskId
  review: ProjectTaskKnowledgeDraftReview
  reader?: ActiveCatalogPageReader | undefined
  onReviewed: (result: ActiveCatalogReviewResult | null) => void
} & PropsLocale<'tasks'>) {
  const key = activeCatalogReviewKey(projectId, review)
  const [reads, setReads] = useState<{ key: string; pages: Record<string, ReadState> } | null>(null)
  const pending = useRef(new Map<string, AbortController>())
  const pages = reads?.key === key ? reads.pages : emptyReads
  const reviewed = useMemo((): ActiveCatalogReviewResult | null => {
    if (key === null || reader === undefined) return null
    const reviewedPages: ReviewedPage[] = []
    for (const page of review.activePages) {
      const state = pages[page.id]
      if (state?.kind !== 'ready' || state.relation === undefined) return null
      reviewedPages.push({ path: page.id, title: page.title, version: page.version, relation: state.relation })
    }
    return { key, reviewedPages }
  }, [key, reader, pages, review.activePages])
  const distinct = reviewed !== null && reviewed.reviewedPages.every(page => page.relation === 'distinct')
  useEffect(() => { onReviewed(reviewed) }, [reviewed, onReviewed])
  useEffect(() => () => {
    for (const request of pending.current.values()) request.abort()
    pending.current.clear()
  }, [key])
  const readPage = (page: Page): void => {
    if (key === null || reader === undefined || projectId === null) return
    onReviewed(null)
    pending.current.get(page.id)?.abort()
    const request = new AbortController()
    pending.current.set(page.id, request)
    setReads(previous => ({ key, pages: { ...(previous?.key === key ? previous.pages : {}),
      [page.id]: { kind: 'loading' } } }))
    void reader(projectId, taskId, review.document.version, review.activeIndexDigest,
      page.id, page.version, request.signal).then((result) => {
      if (request.signal.aborted) return
      const exact = (result.kind === 'page' || result.kind === 'root') && result.status === 'active' && result.id === page.id
        && result.title === page.title && result.version === page.version && typeof result.body === 'string'
      setReads(previous => ({ key, pages: { ...(previous?.key === key ? previous.pages : {}),
        [page.id]: exact ? { kind: 'ready', body: result.body } : { kind: 'changed' } } }))
    }).catch(() => {
      if (!request.signal.aborted) setReads(previous => ({ key, pages: {
        ...(previous?.key === key ? previous.pages : {}), [page.id]: { kind: 'error' },
      } }))
    }).finally(() => {
      if (pending.current.get(page.id) === request) pending.current.delete(page.id)
    })
  }
  const chooseRelation = (page: Page, relation: ReviewedPage['relation'] | ''): void => {
    const state = pages[page.id]
    if (key === null || state?.kind !== 'ready') return
    onReviewed(null)
    setReads(previous => ({ key, pages: { ...(previous?.key === key ? previous.pages : {}),
      [page.id]: { kind: 'ready', body: state.body,
        ...(relation === '' ? {} : { relation }) } } }))
  }
  return <section aria-label={t('brainCatalog.reviewTitle')}>
    {key === null || reader === undefined ? <p role="alert">{t('brainCatalog.incomplete')}</p>
      : review.activePages.length === 0 ? <p>{t('brainCatalog.empty')}</p>
        : <>
          <p>{t('brainCatalog.readAll', { count: review.activePages.length })}</p>
          <ul>{review.activePages.map((page) => {
            const state = pages[page.id]
            return <li key={`${page.id}/${page.version}`}>
              <p>{page.title} · <code>{page.id}</code> · <code>{page.version}</code></p>
              <Button size="sm" variant="outline" disabled={state?.kind === 'loading'}
                onClick={() => { readPage(page) }}>{t(state?.kind === 'ready'
                  || state?.kind === 'changed' || state?.kind === 'error'
                  ? 'brainCatalog.readAgain' : 'brainCatalog.readPage')}</Button>
              {state?.kind === 'loading' && <p role="status">{t('brainCatalog.loading')}</p>}
              {state?.kind === 'changed' && <p role="alert">{t('brainCatalog.changed')}</p>}
              {state?.kind === 'error' && <p role="alert">{t('brainCatalog.readFailed')}</p>}
              {state?.kind === 'ready' && <>
                <pre>{state.body}</pre>
                <label>{t('brainCatalog.relation')}<select value={state.relation ?? ''}
                  onChange={(event) => { chooseRelation(page, event.target.value as ReviewedPage['relation'] | '') }}>
                  <option value="">{t('brainCatalog.selectRelation')}</option>
                  {(['distinct', 'duplicate', 'conflict', 'unknown'] as const).map(relation =>
                    <option key={relation} value={relation}>{t(`brainCatalog.relation.${relation}`)}</option>)}</select></label>
                {state.relation !== undefined && state.relation !== 'distinct' &&
                  <p role="alert">{t(`brainCatalog.relationReason.${state.relation}`)}</p>}
              </>}
            </li>
          })}</ul>
        </>}
    {key !== null && reader !== undefined && <p role={distinct ? 'status' : 'alert'}>{t(distinct
      ? 'brainCatalog.complete' : reviewed !== null ? 'brainCatalog.overlap' : 'brainCatalog.pending')}</p>}
  </section>
}
