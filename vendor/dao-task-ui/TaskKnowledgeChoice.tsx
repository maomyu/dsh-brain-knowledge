/** A discovered Task candidate requires a separate, explicit human choice before any Brain write. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ProjectTaskKnowledgeDecisionRequest, ProjectTaskKnowledgeDiscovery,
  ProjectTaskKnowledgeDocumentId, ProjectTaskKnowledgeOperationId } from '@deepseek-ai/dsh-api-task-controller/types'
import { ArtifactCoverageReview } from './ArtifactCoverageReview.tsx'
import { CodingCoverageReview } from './CodingCoverageReview.tsx'
import { SourceDispositionReview, sourceMatrixReady } from './SourceDispositionReview.tsx'
import { SourceDispositionEditor, sourceMatrixChanged, sourceMatrixFieldsValid } from './SourceDispositionEditor.tsx'
import { useKnowledgeChoiceFields } from './knowledge-choice-fields.ts'
import css from './Tasks.module.css'

type Candidate = Extract<ProjectTaskKnowledgeDiscovery, { status: 'candidate' }>

/** Reserve one pending decision and retain its UUID until a confirmed Host response ends the attempt.
 * @param props - candidate, explicit command, and localized confirmation text.
 * @returns a human decision form without optimistic Brain success.
 */
export function TaskKnowledgeChoice({ candidate, busy, decide, openArtifactFile, t }: {
  candidate: Candidate
  busy: boolean
  decide: (request: ProjectTaskKnowledgeDecisionRequest) => Promise<boolean | 'source-identifiers-missing'>
  openArtifactFile?: ((path: string, directoryVersion: string) => void) | undefined
} & PropsLocale<'tasks'>) {
  const { choice, setChoice, reason, setReason, pageIndex, setPageIndex, path, setPath,
    title, setTitle, category, setCategory, kind, setKind, tags, setTags } = useKnowledgeChoiceFields()
  const [reviewedSummary, setReviewedSummary] = useState(candidate.summary)
  const [reviewedTruth, setReviewedTruth] = useState(candidate.proposedTruth)
  const [reviewedEvidence, setReviewedEvidence] = useState(candidate.evidence)
  const [reviewedSources, setReviewedSources] = useState(candidate.sourceDispositions)
  const [confirming, setConfirming] = useState(false)
  const [retained, setRetained] = useState<ProjectTaskKnowledgeDecisionRequest | null>(null)
  const [sending, setSending] = useState(false)
  const pendingCommand = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const selected = pageIndex === '' ? undefined : candidate.comparedPages[Number(pageIndex)]
  const sourceChanged = sourceMatrixChanged(candidate.sourceDispositions, reviewedSources)
  const sourceFieldsValid = !sourceChanged || sourceMatrixFieldsValid(reviewedSources)
  const sourceReady = sourceMatrixReady(reviewedSources) && sourceFieldsValid
  const reviewedTextValid = reviewedSummary.trim().length > 0 && reviewedTruth.trim().length > 0
    && reviewedEvidence.trim().length > 0
  const valid = choice === 'dismiss' ? reason.trim().length > 0 : choice === 'propose-existing'
    ? candidate.codingOmissions === undefined && sourceReady && selected !== undefined && reviewedTextValid
    : choice === 'save-draft' && path.trim().length > 0 && title.trim().length > 0 && title.trim().length <= 256
      && reviewedTextValid && sourceFieldsValid
  const target = choice === 'dismiss' ? reason.trim() : choice === 'propose-existing' ? selected?.path ?? '' : path.trim()
  const submit = (): void => {
    if (busy || sending || pendingCommand.current || !valid || choice === null) return
    pendingCommand.current = true
    const common = { decisionId: randomUUID() as ProjectTaskKnowledgeOperationId, candidateId: candidate.candidateId,
      resultSha256: candidate.resultSha256, candidateSha256: candidate.candidateSha256 }
    const truth = reviewedTruth.trim() === candidate.proposedTruth ? {}
      : { reviewedTruth: reviewedTruth.trim() }
    const summary = reviewedSummary.trim() === candidate.summary ? {}
      : { reviewedSummary: reviewedSummary.trim() }
    const evidence = reviewedEvidence.trim() === candidate.evidence ? {}
      : { reviewedEvidence: reviewedEvidence.trim() }
    const sources = sourceChanged ? { reviewedSourceDispositions: reviewedSources } : {}
    const request: ProjectTaskKnowledgeDecisionRequest = retained ?? (choice === 'dismiss'
      ? { ...common, action: 'dismiss', reason: reason.trim() }
      : choice === 'propose-existing' && selected !== undefined
        ? { ...common, action: 'propose-existing', path: selected.path as ProjectTaskKnowledgeDocumentId,
          expectedVersion: selected.version, ...summary, ...truth, ...evidence, ...sources }
        : { ...common, action: 'save-draft', path: path.trim() as ProjectTaskKnowledgeDocumentId,
          title: title.trim(), category, kind, tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))],
          ...summary, ...truth, ...evidence, ...sources })
    setRetained(request)
    setSending(true)
    setError(null)
    void decide(request).then((acknowledged) => {
      if (acknowledged === 'source-identifiers-missing') {
        setRetained(null)
        setConfirming(false)
        setError(t('taskDecision.sourceIdentifiersMissing'))
        return
      }
      setError(t(acknowledged ? 'taskDecision.awaitingCard' : 'taskDecision.uncertain'))
    }).catch(() => { setError(t('taskDecision.commandError')) }).finally(() => {
      pendingCommand.current = false
      setSending(false)
    })
  }
  if (candidate.comparisonFormat !== 'semantic-v1') {
    return <p role="alert">{t('taskDiscovery.legacyCandidate')}</p>
  }
  return <section aria-label={t('taskDecision.chooseTitle')} className={css.notice} data-task-knowledge-choice
    aria-busy={busy || sending}>
    <h3>{t('taskDecision.chooseTitle')}</h3>
    <p>{t('taskDecision.chooseWarning')}</p>
    <ArtifactCoverageReview files={candidate.artifactCoverage}
      directoryVersion={candidate.artifactDirectory === undefined ? undefined
        : `${candidate.artifactDirectory.version}:${candidate.artifactDirectory.digest}`}
      coverageSha256={candidate.artifactDirectory?.coverageSha256} onOpenFile={openArtifactFile} t={t} />
    <CodingCoverageReview files={candidate.codingOmissions} t={t} />
    <SourceDispositionReview sources={candidate.sourceDispositions}
      directoryVersion={candidate.artifactDirectory === undefined ? undefined
        : `${candidate.artifactDirectory.version}:${candidate.artifactDirectory.digest}`}
      onOpenFile={openArtifactFile} t={t} />
    <SourceDispositionEditor original={candidate.sourceDispositions} reviewed={reviewedSources}
      disabled={retained !== null || busy || sending} onChange={(sources) => {
        setReviewedSources(sources); setConfirming(false)
      }} t={t} />
    {!sourceReady && <p role="alert">{t('sourceMatrix.proposalBlocked')}</p>}
    {error !== null && <p role="alert">{error}</p>}
    {retained !== null && <p role="alert">{t('taskDecision.uncertain')}</p>}
    {choice === null && <div className={css.reviewActions}>
      <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { setChoice('dismiss') }}>
        {t('taskDecision.action.dismiss')}</Button>
      <Button size="sm" variant="outline" disabled={busy || sending || !sourceReady
        || candidate.comparedPages.length === 0 || candidate.codingOmissions !== undefined}
      onClick={() => { setChoice('propose-existing') }}>{t('taskDecision.action.propose-existing')}</Button>
      <Button size="sm" variant="outline" disabled={busy || sending} onClick={() => { setChoice('save-draft') }}>
        {t('taskDecision.action.save-draft')}</Button>
    </div>}
    {choice !== null && <div className={css.discoveryForm}>
      {choice === 'dismiss' && <label>{t('taskDecision.dismissReason')}
        <textarea value={reason} disabled={retained !== null || busy || sending}
          onChange={(event) => { setReason(event.target.value); setConfirming(false) }} /></label>}
      {choice === 'propose-existing' && <label>{t('taskDecision.existingPage')}
        <select value={pageIndex} disabled={retained !== null || busy || sending}
          onChange={(event) => { setPageIndex(event.target.value); setConfirming(false) }}>
          <option value="">{t('taskDecision.selectPage')}</option>
          {candidate.comparedPages.map((page, index) => <option key={`${page.path}/${page.version}`} value={index}>
            {page.path} · {page.version}</option>)}
        </select></label>}
      {choice === 'save-draft' && <>
        <p>{t('taskDecision.searchWarning')}</p>
        <label>{t('taskDecision.newPath')}<input value={path} placeholder={t('taskDecision.pathExample')}
          disabled={retained !== null || busy || sending}
          onChange={(event) => { setPath(event.target.value); setConfirming(false) }} /></label>
        <label>{t('taskDecision.newTitle')}<input value={title} maxLength={256} disabled={retained !== null || busy || sending}
          onChange={(event) => { setTitle(event.target.value); setConfirming(false) }} /></label>
        <label>{t('taskDecision.category')}<select value={category} disabled={retained !== null || busy || sending}
          onChange={(event) => { setCategory(event.target.value as typeof category); setConfirming(false) }}>
          {(['project', 'concept', 'decision', 'person', 'reference'] as const).map(value =>
            <option key={value} value={value}>{t(`taskDecision.category.${value}`)}</option>)}
        </select></label>
        <label>{t('taskDecision.kind')}<select value={kind} disabled={retained !== null || busy || sending}
          onChange={(event) => { setKind(event.target.value as typeof kind); setConfirming(false) }}>
          {(['decision', 'observation', 'source', 'reversal', 'evidence'] as const).map(value =>
            <option key={value} value={value}>{t(`taskDecision.kind.${value}`)}</option>)}
        </select></label>
        <label>{t('taskDecision.tags')}<input value={tags} disabled={retained !== null || busy || sending}
          onChange={(event) => { setTags(event.target.value); setConfirming(false) }} /></label>
      </>}
      {choice !== 'dismiss' && <>
        <p>{t('taskDecision.evidenceWarning')}</p>
        <p>{t('taskDecision.identifierWarning')}</p>
        <h4>{t('taskDecision.modelSummary')}</h4>
        <pre className={css.discoveryText}>{candidate.summary}</pre>
        <label>{t('taskDecision.reviewedSummary')}
          <textarea value={reviewedSummary} disabled={retained !== null || busy || sending}
            onChange={(event) => { setReviewedSummary(event.target.value); setConfirming(false) }} /></label>
        <h4>{t('taskDecision.modelTruth')}</h4>
        <pre className={css.discoveryText}>{candidate.proposedTruth}</pre>
        <label>{t('taskDecision.reviewedTruth')}
          <textarea value={reviewedTruth} disabled={retained !== null || busy || sending}
            onChange={(event) => { setReviewedTruth(event.target.value); setConfirming(false) }} /></label>
        <h4>{t('taskDecision.modelEvidence')}</h4>
        <pre className={css.discoveryText}>{candidate.evidence}</pre>
        <label>{t('taskDecision.reviewedEvidence')}
          <textarea value={reviewedEvidence} disabled={retained !== null || busy || sending}
            onChange={(event) => { setReviewedEvidence(event.target.value); setConfirming(false) }} /></label>
      </>}
      {confirming && <div role="group" aria-label={t('taskDecision.confirmTitle')} className={css.notice}>
        <p>{t(`taskDecision.confirm.${choice}`, { target })}</p>
        <p>{t('taskDecision.confirmWarning')}</p>
        {choice !== 'dismiss' && candidate.artifactCoverage?.some(file => file.kind === 'opaque') &&
          <p role="alert">{t('artifactCoverage.opaqueWarning', {
            count: candidate.artifactCoverage.filter(file => file.kind === 'opaque').length,
          })}</p>}
        {choice !== 'dismiss' && reviewedSummary.trim() !== candidate.summary &&
          <p>{t('taskDecision.correctedSummaryWarning')}</p>}
        {choice !== 'dismiss' && reviewedTruth.trim() !== candidate.proposedTruth &&
          <p>{t('taskDecision.correctedTruthWarning')}</p>}
        {choice !== 'dismiss' && reviewedEvidence.trim() !== candidate.evidence &&
          <p>{t('taskDecision.correctedEvidenceWarning')}</p>}
        {choice !== 'dismiss' && sourceChanged && <p role="alert">{t('sourceMatrix.confirmChanged')}</p>}
      </div>}
      <div className={css.reviewActions}>
        {!confirming && retained === null && <Button size="sm" disabled={!valid || busy || sending}
          onClick={() => { setConfirming(true) }}>{t('taskDecision.reviewChoice')}</Button>}
        {confirming && <Button size="sm" disabled={!valid || busy || sending} onClick={submit}>
          {t(retained === null ? 'taskDecision.confirmAction' : 'taskDecision.retrySame')}</Button>}
        {retained === null && <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => {
          if (confirming) setConfirming(false)
          else setChoice(null)
        }}>{t('taskDecision.cancel')}</Button>}
      </div>
    </div>}
  </section>
}
