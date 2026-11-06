/** Goal research proposals require a source-bound human choice and a separate publication confirmation. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ProjectGoalKnowledgeAcknowledgeRequest, ProjectGoalKnowledgeDecision,
  ProjectGoalKnowledgeDecisionRequest, ProjectGoalKnowledgeDecisionSubject, ProjectGoalKnowledgeDiscovery,
  ProjectGoalKnowledgePublishRequest, GoalReviewSnapshot, ProjectTaskKnowledgeAcknowledgeRequest, ProjectTaskKnowledgeDecisionRequest,
  ProjectTaskKnowledgeDocumentId, ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgeOperationId,
  ProjectTaskKnowledgePublicationInspection, ProjectTaskKnowledgePublishRequest, ProjectTaskId } from '@deepseek-ai/dsh-api-task-controller/client'
import { ActiveCatalogReview, activeCatalogReviewKey, type ActiveCatalogPageReader,
  type ActiveCatalogReviewResult } from './ActiveCatalogReview.tsx'
import { ArtifactCoverageReview } from './ArtifactCoverageReview.tsx'
import { SourceDispositionReview, sourceMatrixReady } from './SourceDispositionReview.tsx'
import { SourceDispositionEditor, sourceMatrixChanged, sourceMatrixFieldsValid } from './SourceDispositionEditor.tsx'
import { GoalCodingFilesReview, type GoalCodingFilesReader } from './GoalCodingFilesReview.tsx'
import { useKnowledgeChoiceFields } from './knowledge-choice-fields.ts'
import css from './GoalDashboard.module.css'

type Candidate = Extract<ProjectGoalKnowledgeDiscovery, { status: 'candidate' }>

/** Human-only Goal commands; their boolean return acknowledges transport, not a Brain write. */
export interface GoalKnowledgeCommands {
  decide: (request: ProjectGoalKnowledgeDecisionRequest) => Promise<boolean | 'source-identifiers-missing'>
  reviewDraft: () => Promise<ProjectTaskKnowledgeDraftReview>
  readCatalogPage?: ActiveCatalogPageReader | undefined
  publishDraft: (request: ProjectGoalKnowledgePublishRequest) => Promise<boolean>
  resume: () => Promise<boolean>
  reviewPublication: () => Promise<boolean>
  inspectPublication: () => Promise<ProjectTaskKnowledgePublicationInspection>
  acknowledgePublication: (request: ProjectGoalKnowledgeAcknowledgeRequest) => Promise<boolean>
  retryCommand: () => Promise<boolean>
  refreshCandidate: () => Promise<boolean>
  openTask?: (() => void) | undefined
  readCodingFiles?: GoalCodingFilesReader | undefined
  openArtifactFile?: ((path: string, directoryVersion: string) => void) | undefined
  openPage: (path: ProjectTaskKnowledgeDocumentId, proposalId?: ProjectTaskKnowledgeOperationId) => void
}

type Props = PropsLocale<'tasks'> & GoalKnowledgeCommands & {
  candidate: Candidate
  taskId: ProjectTaskId
  subject: ProjectGoalKnowledgeDecisionSubject
  recorded?: ProjectGoalKnowledgeDecision | undefined
  retry: GoalReviewSnapshot['goalKnowledgeCommandRetry']
  preAdmission: GoalReviewSnapshot['goalKnowledgePreAdmissionConflict']
  refreshRetry: GoalReviewSnapshot['goalKnowledgeRefreshRetry']
  canDecide: boolean
  canRefresh: boolean
  canRecover: boolean
  busy: boolean
}

/** Read complete untrusted proposal text as escaped content before offering a durable human decision.
 * @param props - exact signed report identity, retained decision and human-only commands.
 * @returns a review, choice and recovery panel with one pending command and no automatic Brain write on render.
 */
export function GoalKnowledgeDecision({ candidate, taskId, subject, recorded, retry, preAdmission, refreshRetry,
  canDecide, canRefresh, canRecover, busy, t, decide, reviewDraft, readCatalogPage, publishDraft, resume,
  reviewPublication, inspectPublication,
  acknowledgePublication, retryCommand, refreshCandidate,
  openTask, readCodingFiles, openPage, openArtifactFile }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [codingReady, setCodingReady] = useState(false)
  const { choice, setChoice, reason, setReason, pageIndex, setPageIndex, path, setPath,
    title, setTitle, category, setCategory, kind, setKind, tags, setTags } = useKnowledgeChoiceFields()
  const [reviewedTruth, setReviewedTruth] = useState('')
  const [reviewedEvidence, setReviewedEvidence] = useState('')
  const [reviewedSources, setReviewedSources] = useState(candidate.sourceDispositions)
  const [publicationSources, setPublicationSources] = useState(candidate.sourceDispositions)
  const [confirmChoice, setConfirmChoice] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const [retainedChoice, setRetainedChoice] = useState<ProjectGoalKnowledgeDecisionRequest | null>(null)
  const [draft, setDraft] = useState<ProjectTaskKnowledgeDraftReview | null>(null)
  const [catalogReview, setCatalogReview] = useState<ActiveCatalogReviewResult | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [retainedPublish, setRetainedPublish] = useState<ProjectGoalKnowledgePublishRequest | null>(null)
  const canStartDecision = canDecide && candidate.comparisonFormat === 'semantic-v1'
    && (readCodingFiles === undefined || codingReady)
  const [inspection, setInspection] = useState<ProjectTaskKnowledgePublicationInspection | null>(null)
  const [disposition, setDisposition] = useState<'keep-published' | 'revise-needed' | ''>('')
  const [note, setNote] = useState('')
  const [confirmAcknowledge, setConfirmAcknowledge] = useState(false)
  const [retainedAcknowledge, setRetainedAcknowledge] = useState<ProjectGoalKnowledgeAcknowledgeRequest | null>(null)
  const [sending, setSending] = useState(false)
  const pendingCommand = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const decision = recorded !== undefined && sameSubject(recorded.subject, subject) ? recorded.decision : undefined
  const retryHere = retry !== null && retry.workspaceId === subject.workspaceId && retry.goalRunId === subject.goalRunId
    && retry.taskId === taskId
    && sameSubject(retry.request.subject, subject) ? retry : null
  const preAdmissionHere = preAdmission?.kind === 'publication' && preAdmission.taskId === taskId
    ? preAdmission : null
  const refreshHere = refreshRetry !== null && refreshRetry.workspaceId === subject.workspaceId
    && refreshRetry.goalRunId === subject.goalRunId && refreshRetry.taskId === taskId ? refreshRetry : null
  const sourceChanged = sourceMatrixChanged(candidate.sourceDispositions, reviewedSources)
  const sourceFieldsValid = !sourceChanged || sourceMatrixFieldsValid(reviewedSources)
  const sourceReady = sourceMatrixReady(reviewedSources) && sourceFieldsValid
  const selected = pageIndex === '' ? undefined : candidate.comparedPages[Number(pageIndex)]
  const valid = choice === 'dismiss' ? reason.trim().length > 0 : choice === 'propose-existing'
    ? sourceReady && selected !== undefined
    : choice === 'save-draft' && path.trim().length > 0 && title.trim().length > 0 && sourceFieldsValid
  const target = choice === 'dismiss' ? reason.trim() : choice === 'propose-existing' ? selected?.path ?? '' : path.trim()
  const draftDecision = decision?.status === 'draft-pending' || decision?.status === 'draft-saved' ? decision : undefined
  useEffect(() => {
    if (draftDecision !== undefined) {
      setPublicationSources(draftDecision.reviewedSourceDispositions ?? candidate.sourceDispositions)
    }
  }, [draftDecision?.decisionId])
  const priorPublicationSources = draftDecision?.reviewedSourceDispositions ?? candidate.sourceDispositions
  const publicationSourceChanged = sourceMatrixChanged(priorPublicationSources, publicationSources)
  const publicationSourceReady = candidate.sourceDispositions !== undefined && sourceMatrixReady(publicationSources)
    && (!publicationSourceChanged || sourceMatrixFieldsValid(publicationSources))
  const catalogKey = activeCatalogReviewKey(subject.workspaceId, draft)
  const catalogReady = catalogKey !== null && catalogReview?.key === catalogKey
    && catalogReview.reviewedPages.every(page => page.relation === 'distinct')
  const publication = draftDecision?.publication
  const publicationConflict = recorded?.prewriteConflict?.kind === 'publication'
    && publication?.operationId === recorded.prewriteConflict.operationId
  const decisionConflict = recorded?.prewriteConflict?.kind === 'decision'
    && decision?.decisionId === recorded.prewriteConflict.operationId
  const pending = decision?.status === 'proposal-pending' || decision?.status === 'draft-pending'
    || publication?.status === 'pending'
  const published = publication?.status === 'published' ? publication : undefined
  const presentationStatus = publicationConflict ? 'publication-conflict'
    : publication?.status === 'pending' ? 'publication-pending'
      : publication?.status === 'published' ? 'published' : decision?.status ?? 'dismissed'
  const needsPostPublishReview = published !== undefined && published.review?.status !== 'verified'
    && published.acknowledgement === undefined
  const choiceReceipt = decision !== undefined && retainedChoice !== null
    && decision.decisionId === retainedChoice.choice.decisionId
    && decision.status !== 'proposal-pending' && decision.status !== 'draft-pending'
  const publishReceipt = retainedPublish !== null && published?.operationId === retainedPublish.publication.operationId
  const acknowledgementReceipt = retainedAcknowledge !== null
    && published?.acknowledgement?.operationId === retainedAcknowledge.acknowledgement.operationId
  useEffect(() => { if (choiceReceipt) { setRetainedChoice(null); setMessage(null) } }, [choiceReceipt, message])
  useEffect(() => { if (publishReceipt) { setRetainedPublish(null); setMessage(null) } }, [publishReceipt, message])
  useEffect(() => { if (acknowledgementReceipt) { setRetainedAcknowledge(null); setMessage(null) } }, [acknowledgementReceipt, message])
  useEffect(() => { if (retainedPublish === null) setConfirmPublish(false) }, [catalogReview, retainedPublish])
  useEffect(() => {
    if (publicationConflict && retainedPublish?.publication.operationId === publication.operationId) {
      setRetainedPublish(null); setDraft(null); setConfirmPublish(false); setMessage(null)
    }
  }, [publicationConflict, recorded?.prewriteConflict?.operationId, retainedPublish?.publication.operationId])
  useEffect(() => {
    if (preAdmissionHere !== null && retainedPublish?.publication.operationId === preAdmissionHere.operationId) {
      setRetainedPublish(null); setDraft(null); setConfirmPublish(false); setMessage(null)
    }
  }, [preAdmissionHere, retainedPublish?.publication.operationId])

  const run = (action: () => Promise<boolean | 'source-identifiers-missing'>): void => {
    if (busy || pendingCommand.current) return
    pendingCommand.current = true
    setSending(true); setError(null); setMessage(null)
    void action().then((acknowledged) => {
      if (acknowledged === 'source-identifiers-missing') {
        setRetainedChoice(null); setConfirmChoice(false)
        setError(t('goalDecision.sourceIdentifiersMissing'))
      } else setMessage(acknowledged ? null : t('goalDecision.uncertain'))
    })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : t('goalDecision.commandError')) })
      .finally(() => { pendingCommand.current = false; setSending(false) })
  }
  const submitChoice = (): void => {
    if (!canStartDecision || busy || pendingCommand.current || !valid || choice === null || decision !== undefined) return
    const common = { decisionId: randomUUID() as ProjectTaskKnowledgeOperationId, candidateId: candidate.candidateId,
      resultSha256: candidate.resultSha256, candidateSha256: candidate.candidateSha256 }
    const reviewed = { ...(reviewedTruth.trim() === '' ? {} : { reviewedTruth: reviewedTruth.trim() }),
      ...(reviewedEvidence.trim() === '' ? {} : { reviewedEvidence: reviewedEvidence.trim() }) }
    const reviewedMatrix = sourceChanged ? { reviewedSourceDispositions: reviewedSources } : {}
    const selectedChoice: ProjectTaskKnowledgeDecisionRequest = choice === 'dismiss'
      ? { ...common, action: 'dismiss', reason: reason.trim() }
      : choice === 'propose-existing' && selected !== undefined
        ? { ...common, action: 'propose-existing', path: selected.path as ProjectTaskKnowledgeDocumentId,
          expectedVersion: selected.version, ...reviewed, ...reviewedMatrix }
        : { ...common, action: 'save-draft', path: path.trim() as ProjectTaskKnowledgeDocumentId,
          title: title.trim(), category, kind,
          tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))], ...reviewed, ...reviewedMatrix }
    const request = retainedChoice ?? { subject, choice: selectedChoice }
    setRetainedChoice(request)
    run(() => decide(request))
  }
  const loadDraft = (): void => {
    if (!canRecover || busy || pendingCommand.current || draftDecision?.status !== 'draft-saved'
      || publication !== undefined && !publicationConflict) return
    pendingCommand.current = true
    setSending(true); setError(null)
    void reviewDraft().then((value) => { setDraft(value); setCatalogReview(null); setConfirmPublish(false) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : t('goalDecision.commandError')) })
      .finally(() => { pendingCommand.current = false; setSending(false) })
  }
  const submitPublish = (): void => {
    if (!canDecide || busy || pendingCommand.current || !confirmPublish || draft === null || draftDecision?.status !== 'draft-saved'
      || retainedPublish === null && (!catalogReady || !publicationSourceReady)
      || publication !== undefined && !publicationConflict || draft.document.id !== draftDecision.path) return
    const publicationRequest: ProjectTaskKnowledgePublishRequest = retainedPublish?.publication ?? {
      operationId: randomUUID() as ProjectTaskKnowledgeOperationId, draftOperationId: draftDecision.draftOperationId,
      expectedDraftVersion: draft.document.version, expectedActiveIndexDigest: draft.activeIndexDigest,
      reviewedPages: catalogReview?.reviewedPages ?? [],
      ...(publicationSourceChanged ? { reviewedSourceDispositions: publicationSources } : {}),
    }
    const request: ProjectGoalKnowledgePublishRequest = retainedPublish ?? { subject, publication: publicationRequest }
    setRetainedPublish(request)
    run(() => publishDraft(request))
  }
  const loadPublication = (): void => {
    if (!canRecover || busy || pendingCommand.current || published === undefined) return
    pendingCommand.current = true
    setSending(true); setError(null)
    void inspectPublication().then((value) => { setInspection(value); setConfirmAcknowledge(false) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : t('goalDecision.commandError')) })
      .finally(() => { pendingCommand.current = false; setSending(false) })
  }
  const submitAcknowledge = (): void => {
    if (!canRecover || retry !== null || busy || pendingCommand.current || !confirmAcknowledge || published?.review?.status !== 'required'
      || published.acknowledgement !== undefined || inspection?.status !== 'ready'
      || disposition === '' || note.trim() === '') return
    const acknowledgement: ProjectTaskKnowledgeAcknowledgeRequest = retainedAcknowledge?.acknowledgement ?? {
      operationId: randomUUID() as ProjectTaskKnowledgeOperationId, publicationOperationId: published.operationId,
      expectedPageVersion: inspection.currentPage.version,
      observedActiveIndexDigest: inspection.review.observedActiveIndexDigest, disposition, note: note.trim(),
    }
    const request: ProjectGoalKnowledgeAcknowledgeRequest = retainedAcknowledge ?? { subject, acknowledgement }
    setRetainedAcknowledge(request)
    run(() => acknowledgePublication(request))
  }
  return <div className={css.decision} data-goal-knowledge-candidate={candidate.candidateId} aria-busy={busy || sending}>
    <div className={css.discoveryActions}>
      <Button size="sm" variant="outline" onClick={() => { setExpanded(value => !value) }}>
        {t(expanded ? 'goalDecision.hideCandidate' : 'goalDecision.reviewCandidate')}</Button>
      {openTask !== undefined && <Button size="sm" variant="outline" onClick={openTask}>
        {t('goalDecision.openReport')}</Button>}
    </div>
    {expanded && <div className={css.discoveryDetail}>
      <p role="alert">{t('goalDecision.candidateWarning')}</p>
      <h5>{t('goalDecision.proposedTruth')}</h5>
      <pre>{candidate.proposedTruth}</pre>
      <h5>{t('goalDecision.evidence')}</h5>
      <pre>{candidate.evidence}</pre>
      {readCodingFiles !== undefined && <GoalCodingFilesReview read={readCodingFiles}
        onReadyChange={setCodingReady} t={t} />}
      <ArtifactCoverageReview files={candidate.artifactCoverage}
        directoryVersion={candidate.artifactDirectory === undefined ? undefined
          : `${candidate.artifactDirectory.version}:${candidate.artifactDirectory.digest}`}
        coverageSha256={candidate.artifactDirectory?.coverageSha256} onOpenFile={openArtifactFile} t={t} />
      <SourceDispositionReview sources={candidate.sourceDispositions}
        directoryVersion={candidate.artifactDirectory === undefined ? undefined
          : `${candidate.artifactDirectory.version}:${candidate.artifactDirectory.digest}`}
        onOpenFile={openArtifactFile} t={t} />
      {decision === undefined && <SourceDispositionEditor original={candidate.sourceDispositions}
        reviewed={reviewedSources} disabled={!canStartDecision || retainedChoice !== null || busy || sending}
        onChange={(sources) => { setReviewedSources(sources); setConfirmChoice(false) }} t={t} />}
      {!sourceReady && <p role="alert">{t('sourceMatrix.proposalBlocked')}</p>}
      <h5>{t('goalDecision.comparedPages', { count: candidate.comparedPages.length })}</h5>
      {candidate.comparedPages.length === 0 ? <p>{t('goalDecision.zeroHits')}</p>
        : <ul>{candidate.comparedPages.map(page => <li key={`${page.path}/${page.version}`}>
          <code>{page.path}</code> · <code>{page.version}</code>
          {' · '}{page.relation === undefined ? t('taskDiscovery.pageRelation.legacy')
            : t(`taskDiscovery.pageRelation.${page.relation}`)}
          {page.quote !== undefined && <p>{t('taskDiscovery.pageQuote')}: <q>{page.quote}</q></p>}
          {page.reason !== undefined && <p>{t('taskDiscovery.pageReason')}: {page.reason}</p>}
          <Button size="sm" variant="ghost" onClick={() => { openPage(page.path as ProjectTaskKnowledgeDocumentId) }}>
            {t('goalDecision.openPage')}</Button></li>)}</ul>}
      {candidate.topicSearch !== undefined && <>
        <h5>{t('goalDecision.topicSearch', { count: candidate.topicSearch.hits.length })}</h5>
        <p>{t('goalDecision.topicQuery')}: <code>{candidate.topicSearch.query}</code></p>
        {candidate.topicSearch.hits.length > 0 ? <>
          <p role="alert">{t('goalDecision.topicHitWarning')}</p>
          <ul>{candidate.topicSearch.hits.map(hit => <li key={`${hit.path}/${hit.version}`}>
            <code>{hit.path}</code> · <code>{hit.version}</code>
            <Button size="sm" variant="ghost" onClick={() => { openPage(hit.path as ProjectTaskKnowledgeDocumentId) }}>
              {t('goalDecision.openPage')}</Button></li>)}</ul>
        </> : <p>{t('goalDecision.topicZeroHits')}</p>}
        <p>{t('goalDecision.topicSearchLimit')}</p>
      </>}
      <dl className={css.discoverySource}>
        <dt>{t('goalDecision.plan')}</dt><dd><code>{subject.planRequestId}</code></dd>
        <dt>{t('goalDecision.reportDigest')}</dt><dd><code>{subject.reportSha256}</code></dd>
        <dt>{t('goalDecision.discoveryId')}</dt><dd><code>{subject.discoveryId}</code></dd>
        <dt>{t('goalDecision.resultDigest')}</dt><dd><code>{subject.resultSha256}</code></dd>
        <dt>{t('goalDecision.candidateDigest')}</dt><dd><code>{subject.candidateSha256}</code></dd>
      </dl>
    </div>}
    {recorded !== undefined && decision === undefined && <p role="alert">{t('goalDecision.subjectMismatch')}</p>}
    {error !== null && <p role="alert">{error}</p>}
    {message !== null && <p role="status">{message}</p>}
    {retryHere?.status === 'pending' && <p role="status">{t('goalDecision.retryPending')}</p>}
    {retryHere?.status === 'unconfirmed' && <div className={css.discoveryActions}>
      <p role="alert">{t('goalDecision.retryUnconfirmed')}</p>
      <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { run(retryCommand) }}>
        {t('goalDecision.retrySame')}</Button></div>}
    {retry !== null && retryHere === null && <p role="status">{t('goalDecision.retryOther')}</p>}
    {decisionConflict && <p role="alert">{t('goalDecision.decisionConflict')}</p>}
    {publicationConflict && <p role="alert">{t('goalDecision.publicationConflict')}</p>}
    {preAdmissionHere !== null && <p role="alert">{t('goalDecision.preAdmissionConflict')}</p>}
    {retainedChoice !== null && decision !== undefined && decision.decisionId !== retainedChoice.choice.decisionId
      && <p role="alert">{t('goalDecision.receiptMismatch')}</p>}
    {retainedPublish !== null && published !== undefined && published.operationId !== retainedPublish.publication.operationId
      && <p role="alert">{t('goalDecision.receiptMismatch')}</p>}
    {retainedAcknowledge !== null && published?.acknowledgement !== undefined
      && published.acknowledgement.operationId !== retainedAcknowledge.acknowledgement.operationId
      && <p role="alert">{t('goalDecision.receiptMismatch')}</p>}
    {decision === undefined && recorded === undefined && candidate.comparisonFormat !== 'semantic-v1'
      && <p role="alert">{t('taskDiscovery.legacyCandidate')}</p>}
    {decision === undefined && recorded === undefined && expanded && readCodingFiles !== undefined && !codingReady
      && <p role="status">{t('goalCoding.decisionRequiresRead')}</p>}
    {decision === undefined && recorded === undefined && expanded && canStartDecision && <div className={css.discoveryDetail}>
      <h5>{t('goalDecision.chooseTitle')}</h5>
      {choice === null ? <div className={css.discoveryActions}>
        <Button size="sm" variant="outline" onClick={() => { setChoice('dismiss') }}>{t('goalDecision.dismiss')}</Button>
        <Button size="sm" variant="outline" disabled={!sourceReady || candidate.comparedPages.length === 0}
          onClick={() => { setChoice('propose-existing') }}>{t('goalDecision.proposeExisting')}</Button>
        <Button size="sm" variant="outline" onClick={() => { setChoice('save-draft') }}>{t('goalDecision.saveDraft')}</Button>
      </div> : <div className={css.decisionForm}>
        {choice === 'dismiss' && <label>{t('goalDecision.reason')}
          <textarea value={reason} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setReason(event.target.value); setConfirmChoice(false) }} /></label>}
        {choice === 'propose-existing' && <label>{t('goalDecision.existingPage')}
          <select value={pageIndex} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setPageIndex(event.target.value); setConfirmChoice(false) }}>
            <option value="">{t('goalDecision.selectPage')}</option>
            {candidate.comparedPages.map((page, index) => <option key={`${page.path}/${page.version}`} value={index}>
              {page.path} · {page.version}</option>)}</select></label>}
        {choice === 'save-draft' && <>
          <label>{t('goalDecision.newPath')}<input value={path} placeholder={t('goalDecision.pathExample')}
            disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setPath(event.target.value); setConfirmChoice(false) }} /></label>
          <label>{t('goalDecision.newTitle')}<input value={title} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setTitle(event.target.value); setConfirmChoice(false) }} /></label>
          <label>{t('goalDecision.category')}<select value={category} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setCategory(event.target.value as typeof category); setConfirmChoice(false) }}>
            {(['project', 'concept', 'decision', 'person', 'reference'] as const).map(value => <option key={value} value={value}>
              {t(`taskDecision.category.${value}`)}</option>)}</select></label>
          <label>{t('goalDecision.kind')}<select value={kind} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setKind(event.target.value as typeof kind); setConfirmChoice(false) }}>
            {(['decision', 'observation', 'source', 'reversal', 'evidence'] as const).map(value => <option key={value} value={value}>
              {t(`taskDecision.kind.${value}`)}</option>)}</select></label>
          <label>{t('goalDecision.tags')}<input value={tags} disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setTags(event.target.value); setConfirmChoice(false) }} /></label>
        </>}
        {choice !== 'dismiss' && <>
          <p>{t('goalDecision.correctionHint')}</p>
          <p>{t('goalDecision.identifierWarning')}</p>
          <label>{t('goalDecision.reviewedTruth')}<textarea value={reviewedTruth}
            disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setReviewedTruth(event.target.value); setConfirmChoice(false) }} /></label>
          <label>{t('goalDecision.reviewedEvidence')}<textarea value={reviewedEvidence}
            disabled={retainedChoice !== null || busy || sending}
            onChange={(event) => { setReviewedEvidence(event.target.value); setConfirmChoice(false) }} /></label>
        </>}
        {confirmChoice && <div role="group" aria-label={t('goalDecision.confirmTitle')}>
          <p>{t(`goalDecision.confirm.${choice}`, { target })}</p>
          {choice !== 'dismiss' && (reviewedTruth.trim() !== '' || reviewedEvidence.trim() !== '') && <>
            <p>{t('goalDecision.correctionWarning')}</p>
            {reviewedTruth.trim() !== '' && <><h5>{t('goalDecision.reviewedTruth')}</h5><pre>{reviewedTruth.trim()}</pre></>}
            {reviewedEvidence.trim() !== '' && <><h5>{t('goalDecision.reviewedEvidence')}</h5><pre>{reviewedEvidence.trim()}</pre></>}
          </>}
          {choice !== 'dismiss' && sourceChanged && <p role="alert">{t('sourceMatrix.confirmChanged')}</p>}
          <p>{t('goalDecision.choiceWarning')}</p></div>}
        {confirmChoice && choice !== 'dismiss' && candidate.artifactCoverage?.some(file => file.kind === 'opaque') &&
          <p role="alert">{t('artifactCoverage.opaqueWarning', {
            count: candidate.artifactCoverage.filter(file => file.kind === 'opaque').length,
          })}</p>}
        <div className={css.discoveryActions}>
          {!confirmChoice && retainedChoice === null && <Button size="sm" disabled={!valid || busy || sending}
            onClick={() => { setConfirmChoice(true) }}>{t('goalDecision.reviewChoice')}</Button>}
          {confirmChoice && <Button size="sm" disabled={!valid || busy || sending} onClick={submitChoice}>
            {t(retainedChoice === null ? 'goalDecision.confirmAction' : 'goalDecision.retrySame')}</Button>}
          {retainedChoice === null && <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => {
            if (confirmChoice) setConfirmChoice(false)
            else setChoice(null)
          }}>{t('goalDecision.cancel')}</Button>}
        </div>
        {retainedChoice !== null && <p role="alert">{t('goalDecision.uncertain')}</p>}
      </div>}
    </div>}
    {decision !== undefined && <section className={css.discoveryDetail} data-goal-knowledge-decision={decision.status}>
      <h5>{t('goalDecision.savedTitle')}</h5>
      <p role={pending && !publicationConflict ? 'alert' : 'status'}>{t(`goalDecision.status.${presentationStatus}`)}</p>
      {decision.status === 'dismissed' ? <p>{t('goalDecision.reason')}: {decision.reason}</p>
        : <p>{t('goalDecision.path')}: <code>{decision.path}</code></p>}
      {decision.status !== 'dismissed' && decision.receipt !== undefined
        && <p>{t('goalDecision.receiptVersion')}: <code>{decision.receipt.version}</code></p>}
      {decision.status !== 'dismissed' && decision.reviewedTruth !== undefined
        && <><h5>{t('goalDecision.reviewedTruth')}</h5><pre>{decision.reviewedTruth}</pre></>}
      {decision.status !== 'dismissed' && decision.reviewedEvidence !== undefined
        && <><h5>{t('goalDecision.reviewedEvidence')}</h5><pre>{decision.reviewedEvidence}</pre></>}
      {decision.status !== 'dismissed' && decision.reviewedSourceDispositions !== undefined && <details>
        <summary>{t('sourceMatrix.savedHumanReview')}</summary>
        <SourceDispositionEditor original={candidate.sourceDispositions}
          reviewed={decision.reviewedSourceDispositions} disabled onChange={() => {}} t={t} />
      </details>}
      {draftDecision?.publication?.reviewedSourceDispositions !== undefined && <details>
        <summary>{t('sourceMatrix.savedPublicationReview')}</summary>
        <SourceDispositionEditor original={candidate.sourceDispositions}
          reviewed={draftDecision.publication.reviewedSourceDispositions} disabled onChange={() => {}} t={t} />
      </details>}
      {decisionConflict && (canRefresh || refreshHere !== null) && <div className={css.discoveryActions}>
        {refreshHere?.status === 'pending' && <p role="status">{t('goalDecision.refreshPending')}</p>}
        {refreshHere?.status === 'unconfirmed' && <p role="alert">{t('goalDecision.refreshUnconfirmed')}</p>}
        {confirmRefresh && <p>{t('goalDecision.refreshConfirm')}</p>}
        {refreshHere?.status === 'unconfirmed' ? <Button size="sm" variant="outline" disabled={busy || sending}
          onClick={() => { run(refreshCandidate) }}>{t('goalDecision.retrySame')}</Button>
          : refreshHere === null && (confirmRefresh ? <>
            <Button size="sm" disabled={busy || sending} onClick={() => { setConfirmRefresh(false); run(refreshCandidate) }}>
              {t('goalDecision.confirmRefresh')}</Button>
            <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => { setConfirmRefresh(false) }}>
              {t('goalDecision.cancel')}</Button>
          </> : <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { setConfirmRefresh(true) }}>
            {t('goalDecision.refreshCandidate')}</Button>)}
      </div>}
      {decisionConflict && !canRefresh && refreshHere === null
        && <p role="alert">{t('goalDecision.refreshUnavailable')}</p>}
      {pending && !publicationConflict && !decisionConflict && canRecover && retry === null
        && <Button size="sm" variant="outline" disabled={busy || sending}
          onClick={() => { run(resume) }}>{t('goalDecision.recover')}</Button>}
      {decision.status === 'proposal-saved' && <>
        <p>{t('goalDecision.proposalWarning')}</p>
        <Button size="sm" variant="outline" onClick={() => { openPage(decision.path, decision.decisionId) }}>
          {t('goalDecision.openProposal')}</Button></>}
      {draftDecision?.status === 'draft-saved' && (publication === undefined || publicationConflict) && <>
        <p>{t('goalDecision.draftHeld')}</p>
        {!publicationSourceReady && <p role="alert">{t('sourceMatrix.publishBlocked')}</p>}
        <Button size="sm" variant="outline" disabled={busy || sending || retainedPublish !== null || !canRecover}
          onClick={loadDraft}>{t(draft === null ? 'goalDecision.loadDraft' : 'goalDecision.refreshDraft')}</Button>
        {draft !== null && <div className={css.decisionForm}>
          <h5>{t('goalDecision.draftPreview')}</h5>
          <p>{draft.document.title} · <code>{draft.document.id}</code> · <code>{draft.document.version}</code></p>
          <pre>{draft.document.markdown}</pre>
          <h5>{t('goalDecision.activeCatalog', { count: draft.activePageCount })}</h5>
          <p>{t('goalDecision.catalogDigest')}: <code>{draft.activeIndexDigest}</code></p>
          <ActiveCatalogReview projectId={subject.workspaceId} taskId={taskId} review={draft} reader={readCatalogPage}
            onReviewed={setCatalogReview} t={t} />
          <SourceDispositionEditor original={candidate.sourceDispositions} reviewed={publicationSources}
            disabled={busy || sending || retainedPublish !== null} onChange={(sources) => {
              setPublicationSources(sources); setConfirmPublish(false)
            }} t={t} />
          {draft.document.id !== draftDecision.path && <p role="alert">{t('goalDecision.draftMismatch')}</p>}
          {confirmPublish && <div role="group" aria-label={t('goalDecision.publishConfirmTitle')}>
            <p>{t('goalDecision.publishConfirm', { path: draft.document.id, version: draft.document.version })}</p>
            <p>{t('goalDecision.publishWarning')}</p></div>}
          {confirmPublish && publicationSourceChanged &&
            <p role="alert">{t('sourceMatrix.confirmChanged')}</p>}
          <div className={css.discoveryActions}>
            {!confirmPublish && retainedPublish === null && <Button size="sm" disabled={!canDecide || busy || sending
              || !catalogReady || !publicationSourceReady
              || draft.document.id !== draftDecision.path} onClick={() => { setConfirmPublish(true) }}>
              {t('goalDecision.preparePublish')}</Button>}
            {confirmPublish && <Button size="sm" disabled={!canDecide || busy || sending
              || retainedPublish === null && (!catalogReady || !publicationSourceReady)
              || draft.document.id !== draftDecision.path} onClick={submitPublish}>
              {t(retainedPublish === null ? 'goalDecision.confirmPublish' : 'goalDecision.retrySame')}</Button>}
            {retainedPublish === null && <Button size="sm" variant="ghost" disabled={busy || sending}
              onClick={() => { if (confirmPublish) setConfirmPublish(false); else setDraft(null) }}>
              {t('goalDecision.cancel')}</Button>}
          </div>
          {retainedPublish !== null && <p role="alert">{t('goalDecision.uncertain')}</p>}
        </div>}
      </>}
      {published !== undefined && <>
        <p role={published.review?.status === 'verified' || published.acknowledgement !== undefined ? 'status' : 'alert'}>
          {t(published.review?.status === 'required' && published.acknowledgement !== undefined
            ? 'goalDecision.publication.requiredAcknowledged'
            : `goalDecision.publication.${published.review?.status ?? 'unknown'}`)}</p>
        {published.receipt !== undefined && <p>{t('goalDecision.publishedVersion')}: <code>{published.receipt.version}</code></p>}
        {draftDecision !== undefined && <Button size="sm" variant="outline" onClick={() => { openPage(draftDecision.path) }}>
          {t('goalDecision.openPage')}</Button>}
        {needsPostPublishReview && published.review?.status === 'unknown' && canRecover && <Button size="sm" variant="outline"
          disabled={busy || sending} onClick={() => { run(reviewPublication) }}>{t('goalDecision.recheckCatalog')}</Button>}
        {needsPostPublishReview && published.review?.status === 'required' && canRecover && <>
          <Button size="sm" variant="outline" disabled={busy || sending || retainedAcknowledge !== null}
            onClick={loadPublication}>{t(inspection === null ? 'goalDecision.inspectPublication' : 'goalDecision.refreshPublication')}</Button>
          {inspection?.status === 'unknown' && <p role="alert">{t('goalDecision.inspectionUnknown')}</p>}
          {inspection?.status === 'ready' && <div className={css.decisionForm}>
            <h5>{t('goalDecision.currentPage')}</h5>
            <p>{inspection.currentPage.title} · <code>{inspection.currentPage.id}</code> · <code>{inspection.currentPage.version}</code></p>
            <pre>{inspection.currentPage.body}</pre>
            <h5>{t('goalDecision.currentCatalog', { count: inspection.activePages.length })}</h5>
            <p>{t('goalDecision.catalogDigest')}: <code>{inspection.review.observedActiveIndexDigest}</code></p>
            <ul>{inspection.activePages.map(page => <li key={`${page.id}/${page.version}`}>
              {page.title} · <code>{page.id}</code> · <code>{page.version}</code></li>)}</ul>
            <label>{t('goalDecision.disposition')}<select value={disposition}
              disabled={busy || sending || retainedAcknowledge !== null}
              onChange={(event) => { setDisposition(event.target.value as typeof disposition); setConfirmAcknowledge(false) }}>
              <option value="">{t('goalDecision.selectDisposition')}</option>
              <option value="keep-published">{t('goalDecision.keepPublished')}</option>
              <option value="revise-needed">{t('goalDecision.reviseNeeded')}</option></select></label>
            <label>{t('goalDecision.acknowledgeNote')}<textarea value={note}
              disabled={busy || sending || retainedAcknowledge !== null}
              onChange={(event) => { setNote(event.target.value); setConfirmAcknowledge(false) }} /></label>
            {confirmAcknowledge && <div role="group" aria-label={t('goalDecision.acknowledgeConfirmTitle')}>
              <p>{t('goalDecision.acknowledgeConfirm', { version: inspection.currentPage.version,
                digest: inspection.review.observedActiveIndexDigest })}</p>
              <p>{t('goalDecision.acknowledgeWarning')}</p></div>}
            <div className={css.discoveryActions}>
              {!confirmAcknowledge && retainedAcknowledge === null && <Button size="sm"
                disabled={busy || sending || retry !== null || disposition === '' || note.trim() === ''}
                onClick={() => { setConfirmAcknowledge(true) }}>{t('goalDecision.prepareAcknowledge')}</Button>}
              {confirmAcknowledge && <Button size="sm" disabled={busy || sending || retry !== null} onClick={submitAcknowledge}>
                {t(retainedAcknowledge === null ? 'goalDecision.confirmAcknowledge' : 'goalDecision.retrySame')}</Button>}
              {retainedAcknowledge === null && <Button size="sm" variant="ghost" disabled={busy || sending}
                onClick={() => { if (confirmAcknowledge) setConfirmAcknowledge(false); else setInspection(null) }}>
                {t('goalDecision.cancel')}</Button>}
            </div>
            {retainedAcknowledge !== null && <p role="alert">{t('goalDecision.uncertain')}</p>}
          </div>}
        </>}
        {published.acknowledgement !== undefined && <p role="status">
          {t('goalDecision.acknowledged', { disposition: t(`taskDecision.disposition.${published.acknowledgement.disposition}`),
            version: published.acknowledgement.expectedPageVersion })}</p>}
      </>}
    </section>}
  </div>
}

function sameSubject(left: ProjectGoalKnowledgeDecisionSubject, right: ProjectGoalKnowledgeDecisionSubject): boolean {
  return left.workspaceId === right.workspaceId && left.goalRunId === right.goalRunId
    && left.planRequestId === right.planRequestId && left.reportMessageId === right.reportMessageId
    && left.reportSha256 === right.reportSha256 && left.discoveryId === right.discoveryId
    && left.candidateId === right.candidateId && left.resultSha256 === right.resultSha256
    && left.candidateSha256 === right.candidateSha256
}
