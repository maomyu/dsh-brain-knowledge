/** Durable human Task knowledge decisions stay distinct from model candidates and Brain publication. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProjectTaskKnowledgeDecision, ProjectTaskKnowledgeDocumentId,
  ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgeOperationId, ProjectTaskKnowledgePublicationInspection,
  ProjectTaskKnowledgePublishRequest, ProjectTaskKnowledgeAcknowledgeRequest,
  ProjectTaskKnowledgeDiscovery, ProjectTaskId } from '@deepseek-ai/dsh-api-task-controller/types'
import { ActiveCatalogReview, activeCatalogReviewKey, type ActiveCatalogPageReader,
  type ActiveCatalogReviewResult } from './ActiveCatalogReview.tsx'
import { sourceMatrixReady } from './SourceDispositionReview.tsx'
import { CodingCoverageReview } from './CodingCoverageReview.tsx'
import { SourceDispositionEditor, sourceMatrixChanged, sourceMatrixFieldsValid } from './SourceDispositionEditor.tsx'
import css from './Tasks.module.css'

/** Show recorded Brain receipts without inferring success from uncertain requests; reserve one pending command per mounted decision.
 * @param props - source-owned decision and localized copy.
 * @returns human decision and publication state.
 */
export function TaskKnowledgeDecision({ decision, candidate, current, projectId = null, taskId, busy = false, openPage, resume, reviewDraft,
  readCatalogPage,
  publishDraft, reviewPublication, inspectPublication, acknowledgePublication, t }: {
    decision: ProjectTaskKnowledgeDecision
    candidate?: Extract<ProjectTaskKnowledgeDiscovery, { status: 'candidate' }> | undefined
    current: boolean
    projectId?: WorkspaceId | null
    taskId: ProjectTaskId
    busy?: boolean
    openPage?: ((path: ProjectTaskKnowledgeDocumentId, proposalId?: ProjectTaskKnowledgeOperationId) => void) | undefined
    resume?: (() => Promise<boolean>) | undefined
    reviewDraft?: (() => Promise<ProjectTaskKnowledgeDraftReview>) | undefined
    readCatalogPage?: ActiveCatalogPageReader | undefined
    publishDraft?: ((request: ProjectTaskKnowledgePublishRequest) => Promise<boolean>) | undefined
    reviewPublication?: (() => Promise<boolean>) | undefined
    inspectPublication?: (() => Promise<ProjectTaskKnowledgePublicationInspection>) | undefined
    acknowledgePublication?: ((request: ProjectTaskKnowledgeAcknowledgeRequest) => Promise<boolean>) | undefined
  } & PropsLocale<'tasks'>) {
  const [review, setReview] = useState<ProjectTaskKnowledgeDraftReview | null>(null)
  const [reviewedSources, setReviewedSources] = useState(decision.status === 'dismissed' ? undefined
    : decision.reviewedSourceDispositions ?? candidate?.sourceDispositions)
  const [catalogReview, setCatalogReview] = useState<ActiveCatalogReviewResult | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [retainedPublish, setRetainedPublish] = useState<ProjectTaskKnowledgePublishRequest | null>(null)
  const [inspection, setInspection] = useState<ProjectTaskKnowledgePublicationInspection | null>(null)
  const [disposition, setDisposition] = useState<'keep-published' | 'revise-needed' | ''>('')
  const [note, setNote] = useState('')
  const [confirmAcknowledge, setConfirmAcknowledge] = useState(false)
  const [retainedAcknowledge, setRetainedAcknowledge] = useState<ProjectTaskKnowledgeAcknowledgeRequest | null>(null)
  const [sending, setSending] = useState(false)
  const pendingCommand = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [publicationMessage, setPublicationMessage] = useState<string | null>(null)
  const [acknowledgementMessage, setAcknowledgementMessage] = useState<string | null>(null)
  const draft = decision.status === 'draft-pending' || decision.status === 'draft-saved' ? decision : undefined
  const catalogKey = activeCatalogReviewKey(projectId, review)
  const catalogReady = catalogKey !== null && catalogReview?.key === catalogKey
    && catalogReview.reviewedPages.every(page => page.relation === 'distinct')
  const priorSources = decision.status === 'dismissed' ? undefined
    : decision.reviewedSourceDispositions ?? candidate?.sourceDispositions
  const sourceChanged = sourceMatrixChanged(priorSources, reviewedSources)
  const sourceReady = candidate?.sourceDispositions !== undefined && sourceMatrixReady(reviewedSources)
    && (!sourceChanged || sourceMatrixFieldsValid(reviewedSources))
  const draftOnly = candidate?.codingOmissions !== undefined
  const pendingPublication = draft?.publication?.status === 'pending'
  const published = draft?.publication?.status === 'published'
  const status = pendingPublication ? 'publication-pending' : published ? 'published' : decision.status
  const needsReview = draft?.publication?.status === 'published' && draft.publication.review?.status !== 'verified'
    && draft.publication.acknowledgement === undefined
  const pending = decision.status === 'proposal-pending' || decision.status === 'draft-pending' || pendingPublication
  const publicationOperationId = draft?.publication?.status === 'published' ? draft.publication.operationId : undefined
  const acknowledgementOperationId = draft?.publication?.status === 'published'
    ? draft.publication.acknowledgement?.operationId : undefined
  const matchedPublicationReceipt = retainedPublish !== null && publicationOperationId === retainedPublish.operationId
  const matchedAcknowledgementReceipt = retainedAcknowledge !== null
    && acknowledgementOperationId === retainedAcknowledge.operationId
  useEffect(() => {
    if (matchedPublicationReceipt) {
      setRetainedPublish(null)
      setPublicationMessage(null)
    }
  }, [matchedPublicationReceipt])
  useEffect(() => {
    if (matchedAcknowledgementReceipt) {
      setRetainedAcknowledge(null)
      setAcknowledgementMessage(null)
    }
  }, [matchedAcknowledgementReceipt])
  useEffect(() => { if (retainedPublish === null) setConfirmPublish(false) }, [catalogReview, retainedPublish])
  const run = (action: () => Promise<boolean>): void => {
    if (busy || sending || pendingCommand.current) return
    pendingCommand.current = true
    setSending(true)
    setError(null)
    void action().then((acknowledged) => {
      if (!acknowledged) setError(t('taskDecision.commandError'))
    }).catch(() => { setError(t('taskDecision.commandError')) }).finally(() => {
      pendingCommand.current = false
      setSending(false)
    })
  }
  const loadReview = (): void => {
    if (reviewDraft === undefined || busy || sending || pendingCommand.current) return
    pendingCommand.current = true
    setSending(true)
    setError(null)
    void reviewDraft().then((value) => { setReview(value); setCatalogReview(null)
      setConfirmPublish(false); setRetainedPublish(null) })
      .catch(() => { setError(t('taskDecision.commandError')) }).finally(() => {
        pendingCommand.current = false
        setSending(false)
      })
  }
  const submitPublication = (): void => {
    if (draft?.status !== 'draft-saved' || review === null || review.document.id !== draft.path
      || draftOnly
      || !confirmPublish || retainedPublish === null && (!catalogReady || !sourceReady)
      || publishDraft === undefined || busy || sending || pendingCommand.current) return
    pendingCommand.current = true
    const request: ProjectTaskKnowledgePublishRequest = retainedPublish ?? {
      operationId: randomUUID() as ProjectTaskKnowledgeOperationId, draftOperationId: draft.draftOperationId,
      expectedDraftVersion: review.document.version, expectedActiveIndexDigest: review.activeIndexDigest,
      reviewedPages: catalogReview?.reviewedPages ?? [],
      ...(sourceChanged ? { reviewedSourceDispositions: reviewedSources } : {}),
    }
    setRetainedPublish(request)
    setSending(true)
    setError(null)
    setPublicationMessage(null)
    void publishDraft(request).then((acknowledged) => {
      setPublicationMessage(t(acknowledged ? 'taskDecision.awaitingPublication' : 'taskDecision.uncertainPublication'))
    }).catch(() => { setPublicationMessage(t('taskDecision.commandError')) }).finally(() => {
      pendingCommand.current = false
      setSending(false)
    })
  }
  const loadPublication = (): void => {
    if (inspectPublication === undefined || busy || sending || pendingCommand.current) return
    pendingCommand.current = true
    setSending(true)
    setError(null)
    void inspectPublication().then((value) => {
      setInspection(value)
      setConfirmAcknowledge(false)
      setRetainedAcknowledge(null)
    }).catch(() => { setError(t('taskDecision.commandError')) }).finally(() => {
      pendingCommand.current = false
      setSending(false)
    })
  }
  const submitAcknowledge = (): void => {
    if (draft?.publication?.status !== 'published' || draft.publication.review?.status !== 'required'
      || draft.publication.acknowledgement !== undefined || inspection?.status !== 'ready'
      || disposition === '' || note.trim() === '' || acknowledgePublication === undefined || busy || sending
      || pendingCommand.current) return
    pendingCommand.current = true
    const request: ProjectTaskKnowledgeAcknowledgeRequest = retainedAcknowledge ?? {
      operationId: randomUUID() as ProjectTaskKnowledgeOperationId,
      publicationOperationId: draft.publication.operationId,
      expectedPageVersion: inspection.currentPage.version,
      observedActiveIndexDigest: inspection.review.observedActiveIndexDigest,
      disposition, note: note.trim(),
    }
    setRetainedAcknowledge(request)
    setSending(true)
    setError(null)
    setAcknowledgementMessage(null)
    void acknowledgePublication(request).then((acknowledged) => {
      setAcknowledgementMessage(t(acknowledged ? 'taskDecision.awaitingAcknowledgement'
        : 'taskDecision.uncertainAcknowledgement'))
    }).catch(() => { setAcknowledgementMessage(t('taskDecision.commandError')) })
      .finally(() => {
        pendingCommand.current = false
        setSending(false)
      })
  }
  return <section aria-label={t('taskDecision.title')}
    className={`${css.notice}${needsReview ? ` ${css.decisionNeedsReview}` : ''}`} data-task-knowledge-decision
    aria-busy={busy || sending}>
    <h3>{t('taskDecision.title')}</h3>
    <p role={status.endsWith('pending') ? 'alert' : 'status'}>{t(`taskDecision.status.${status}`)}</p>
    <CodingCoverageReview files={candidate?.codingOmissions} t={t} />
    {decision.status === 'dismissed' && <p>{t('taskDecision.reason')}: {decision.reason}</p>}
    {decision.status !== 'dismissed' && <p>{t('taskDecision.path')}: <code>{decision.path}</code></p>}
    {decision.status !== 'dismissed' && decision.reviewedSummary !== undefined && <details>
      <summary>{t('taskDecision.humanSummary')}</summary>
      <p>{t('taskDecision.humanSummaryWarning')}</p>
      <pre className={css.discoveryText}>{decision.reviewedSummary}</pre>
    </details>}
    {decision.status !== 'dismissed' && decision.reviewedTruth !== undefined && <details>
      <summary>{t('taskDecision.humanTruth')}</summary>
      <p>{t('taskDecision.humanTruthWarning')}</p>
      <pre className={css.discoveryText}>{decision.reviewedTruth}</pre>
    </details>}
    {decision.status !== 'dismissed' && decision.reviewedEvidence !== undefined && <details>
      <summary>{t('taskDecision.humanEvidence')}</summary>
      <p>{t('taskDecision.humanEvidenceWarning')}</p>
      <pre className={css.discoveryText}>{decision.reviewedEvidence}</pre>
    </details>}
    {decision.status !== 'dismissed' && decision.reviewedSourceDispositions !== undefined && <details>
      <summary>{t('sourceMatrix.savedHumanReview')}</summary>
      <SourceDispositionEditor original={candidate?.sourceDispositions}
        reviewed={decision.reviewedSourceDispositions} disabled onChange={() => {}} t={t} />
    </details>}
    {draft?.publication?.reviewedSourceDispositions !== undefined && <details>
      <summary>{t('sourceMatrix.savedPublicationReview')}</summary>
      <SourceDispositionEditor original={candidate?.sourceDispositions}
        reviewed={draft.publication.reviewedSourceDispositions} disabled onChange={() => {}} t={t} />
    </details>}
    {decision.status !== 'dismissed' && decision.receipt !== undefined &&
      <p>{t('taskDecision.receiptVersion')}: <code>{decision.receipt.version}</code></p>}
    {draft?.publication?.receipt !== undefined &&
      <p>{t('taskDecision.publishedVersion')}: <code>{draft.publication.receipt.version}</code></p>}
    {draft?.publication?.status === 'published' &&
      <p role={draft.publication.review?.status === 'verified' || draft.publication.acknowledgement !== undefined
        ? 'status' : 'alert'}>
        {t(draft.publication.review?.status === 'required' && draft.publication.acknowledgement !== undefined
          ? 'taskDecision.publication.requiredAcknowledged'
          : `taskDecision.publication.${draft.publication.review?.status ?? 'unknown'}`)}</p>}
    {draft?.publication?.status === 'published' && draft.publication.acknowledgement !== undefined &&
      <div className={css.notice} role="status">
        <p>{t(`taskDecision.acknowledgement.${draft.publication.acknowledgement.disposition}`)}</p>
        <p>{draft.publication.acknowledgement.note}</p>
        <p>{t('taskDecision.acknowledgedVersion', { version: draft.publication.acknowledgement.expectedPageVersion,
          digest: draft.publication.acknowledgement.observedActiveIndexDigest })}</p>
      </div>}
    {retainedPublish !== null && publicationOperationId !== undefined
      && publicationOperationId !== retainedPublish.operationId &&
      <p role="alert">{t('taskDecision.publicationMismatch')}</p>}
    {retainedAcknowledge !== null && acknowledgementOperationId !== undefined
      && acknowledgementOperationId !== retainedAcknowledge.operationId &&
      <p role="alert">{t('taskDecision.acknowledgementMismatch')}</p>}
    {error !== null && <p role="alert">{error}</p>}
    {publicationMessage !== null && !published && <p role="alert">{publicationMessage}</p>}
    {acknowledgementMessage !== null && draft?.publication?.status === 'published'
      && draft.publication.acknowledgement === undefined && <p role="alert">{acknowledgementMessage}</p>}
    {current && pending && resume !== undefined &&
      <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { run(resume) }}>
        {t('taskDecision.recover')}</Button>}
    {current && openPage !== undefined && decision.status === 'proposal-saved' &&
      <Button size="sm" variant="outline" onClick={() => { openPage(decision.path, decision.decisionId) }}>
        {t('taskDecision.openProposal')}</Button>}
    {current && draft?.status === 'draft-saved' && draft.publication === undefined && !draftOnly
      && reviewDraft !== undefined &&
      <Button size="sm" variant="outline" disabled={busy || sending || retainedPublish !== null}
        onClick={loadReview}>{t(review === null ? 'taskDecision.loadDraft' : 'taskDecision.refreshDraft')}</Button>}
    {current && draft?.status === 'draft-saved' && draft.publication === undefined && !sourceReady &&
      <p role="alert">{t('sourceMatrix.publishBlocked')}</p>}
    {current && draft?.status === 'draft-saved' && draft.publication === undefined && review !== null &&
      <div className={css.discoveryForm}>
        <h4>{t('taskDecision.draftPreview')}</h4>
        <p>{t('taskDecision.draftIdentity', { path: review.document.id, version: review.document.version })}</p>
        <p>{t('taskDecision.activeCatalog', { count: review.activePageCount })} <code>{review.activeIndexDigest}</code></p>
        <h4>{t('taskDecision.draftCatalogPages')}</h4>
        <ActiveCatalogReview projectId={projectId} taskId={taskId} review={review} reader={readCatalogPage}
          onReviewed={setCatalogReview} t={t} />
        <SourceDispositionEditor original={candidate?.sourceDispositions} reviewed={reviewedSources}
          disabled={busy || sending || retainedPublish !== null} onChange={(sources) => {
            setReviewedSources(sources); setConfirmPublish(false)
          }} t={t} />
        <p>{t('taskDecision.draftWarning')}</p>
        <pre className={css.discoveryText}>{review.document.markdown}</pre>
        {review.document.id !== draft.path && <p role="alert">{t('taskDecision.draftMismatch')}</p>}
        {confirmPublish && <div role="group" aria-label={t('taskDecision.publishConfirmTitle')} className={css.notice}>
          <p>{t('taskDecision.publishConfirm', { path: review.document.id, version: review.document.version })}</p>
          <p>{t('taskDecision.publishCatalog', { digest: review.activeIndexDigest })}</p>
          <p>{t('taskDecision.publishWarning')}</p>
          {sourceChanged && <p role="alert">{t('sourceMatrix.confirmChanged')}</p>}
        </div>}
        <div className={css.reviewActions}>
          {!confirmPublish && retainedPublish === null && <Button size="sm" disabled={busy || sending || !catalogReady
            || !sourceReady
            || review.document.id !== draft.path}
          onClick={() => { setConfirmPublish(true) }}>{t('taskDecision.preparePublish')}</Button>}
          {confirmPublish && publishDraft !== undefined && <Button size="sm" disabled={busy || sending
            || retainedPublish === null && (!catalogReady || !sourceReady) || review.document.id !== draft.path}
          onClick={submitPublication}>{t(retainedPublish === null ? 'taskDecision.confirmPublish' : 'taskDecision.retrySame')}</Button>}
          {retainedPublish === null && <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => {
            if (confirmPublish) setConfirmPublish(false)
            else setReview(null)
          }}>{t('taskDecision.cancel')}</Button>}
        </div>
        {retainedPublish !== null && <p role="alert">{t('taskDecision.uncertainPublication')}</p>}
      </div>}
    {current && openPage !== undefined && draft?.publication?.status === 'published' &&
      <Button size="sm" variant="outline" onClick={() => { openPage(draft.path) }}>
        {t(draft.publication.review?.status === 'required' || draft.publication.review?.status === 'unknown'
          ? 'taskDecision.reviewPublished' : 'taskDecision.openPage')}</Button>}
    {current && draft?.publication?.status === 'published' && draft.publication.review?.status === 'unknown'
      && reviewPublication !== undefined &&
      <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { run(reviewPublication) }}>
        {t('taskDecision.recheckCatalog')}</Button>}
    {current && draft?.publication?.status === 'published' && draft.publication.review?.status === 'required'
      && draft.publication.acknowledgement === undefined && inspectPublication !== undefined &&
      <Button size="sm" variant="outline" disabled={busy || sending || retainedAcknowledge !== null}
        onClick={loadPublication}>{t(inspection === null ? 'taskDecision.inspectPublication' : 'taskDecision.refreshPublication')}</Button>}
    {current && draft?.publication?.status === 'published' && draft.publication.review?.status === 'required'
      && draft.publication.acknowledgement === undefined && inspection?.status === 'unknown' &&
      <p role="alert">{t('taskDecision.inspectionUnknown')}</p>}
    {current && draft?.publication?.status === 'published' && draft.publication.review?.status === 'required'
      && draft.publication.acknowledgement === undefined && inspection?.status === 'ready' &&
      <div className={css.discoveryForm}>
        <h4>{t('taskDecision.currentPage')}</h4>
        <p>{inspection.currentPage.title} · <code>{inspection.currentPage.id}</code>
          {' '}· <code>{inspection.currentPage.version}</code></p>
        <pre className={css.discoveryText}>{inspection.currentPage.body}</pre>
        <h4>{t('taskDecision.currentCatalog', { count: inspection.activePages.length })}</h4>
        <ul>{inspection.activePages.map(page => <li key={`${page.id}/${page.version}`}>
          {page.title} · <code>{page.id}</code> · <code>{page.version}</code></li>)}</ul>
        <p>{t('taskDecision.currentDigest')}: <code>{inspection.review.observedActiveIndexDigest}</code></p>
        <label>{t('taskDecision.disposition')}<select value={disposition}
          disabled={busy || sending || retainedAcknowledge !== null}
          onChange={(event) => { setDisposition(event.target.value as typeof disposition); setConfirmAcknowledge(false) }}>
          <option value="">{t('taskDecision.selectDisposition')}</option>
          <option value="keep-published">{t('taskDecision.disposition.keep-published')}</option>
          <option value="revise-needed">{t('taskDecision.disposition.revise-needed')}</option>
        </select></label>
        <label>{t('taskDecision.acknowledgeNote')}<textarea value={note}
          disabled={busy || sending || retainedAcknowledge !== null}
          onChange={(event) => { setNote(event.target.value); setConfirmAcknowledge(false) }} /></label>
        {confirmAcknowledge && <div role="group" aria-label={t('taskDecision.acknowledgeConfirmTitle')} className={css.notice}>
          <p>{t('taskDecision.acknowledgeConfirm', { version: inspection.currentPage.version,
            digest: inspection.review.observedActiveIndexDigest })}</p>
          <p>{t('taskDecision.acknowledgeWarning')}</p>
        </div>}
        <div className={css.reviewActions}>
          {!confirmAcknowledge && retainedAcknowledge === null && <Button size="sm" disabled={busy || sending
            || disposition === '' || note.trim() === ''} onClick={() => { setConfirmAcknowledge(true) }}>
            {t('taskDecision.prepareAcknowledge')}</Button>}
          {confirmAcknowledge && acknowledgePublication !== undefined && <Button size="sm"
            disabled={busy || sending} onClick={submitAcknowledge}>
            {t(retainedAcknowledge === null ? 'taskDecision.confirmAcknowledge' : 'taskDecision.retrySame')}</Button>}
          {retainedAcknowledge === null && <Button size="sm" variant="ghost" disabled={busy || sending}
            onClick={() => { if (confirmAcknowledge) setConfirmAcknowledge(false); else setInspection(null) }}>
            {t('taskDecision.cancel')}</Button>}
        </div>
        {retainedAcknowledge !== null && <p role="alert">{t('taskDecision.uncertainAcknowledgement')}</p>}
      </div>}
  </section>
}
