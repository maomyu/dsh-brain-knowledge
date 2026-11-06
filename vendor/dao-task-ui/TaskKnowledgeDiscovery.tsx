/** Completed Tasks without selected Brain pages expose discovery evidence without publishing it. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ProjectTaskKnowledgeDiscovery as Discovery,
  ProjectTaskProposal } from '@deepseek-ai/dsh-api-task-controller/types'
import type { ProjectTaskKnowledgeDiscoveryRequestId, ProjectTaskKnowledgeDocumentId,
  ProjectTaskKnowledgeHistoryEntry } from '@deepseek-ai/dsh-api-task-controller/types'
import { ArtifactCoverageReview } from './ArtifactCoverageReview.tsx'
import { CodingCoverageReview } from './CodingCoverageReview.tsx'
import { ImportedPdfCoverageReview } from './ImportedPdfCoverageReview.tsx'
import { ImportedDocxCoverageReview } from './ImportedDocxCoverageReview.tsx'
import { SourceDispositionReview } from './SourceDispositionReview.tsx'
import { ComparedKnowledgePages, ComparedKnowledgePageHistory } from './ComparedKnowledgePages.tsx'
import css from './Tasks.module.css'

/** Show source-owned discovery status and separately confirmed queued or blocked recovery.
 * @param props - durable result, current-project page navigation, retry availability and localized copy.
 * @returns a read-only candidate or explicit recovery control; no knowledge writer action.
 */
export function TaskKnowledgeDiscovery({ discovery, current, decided = false, busy = false, history = [],
  refreshRequestId, recheckRequestId, refreshBlocked, hasArtifact = false, codingIsolation,
  openPage, openArtifactFile, retry, refreshCandidate,
  recheckNoChange, t }: {
    discovery: Discovery
    current: boolean
    decided?: boolean
    busy?: boolean
    history?: readonly ProjectTaskKnowledgeHistoryEntry[] | undefined
    refreshRequestId?: ProjectTaskKnowledgeDiscoveryRequestId | undefined
    recheckRequestId?: ProjectTaskKnowledgeDiscoveryRequestId | undefined
    refreshBlocked?: 'pending-write' | 'history-limit' | undefined
    hasArtifact?: boolean
    codingIsolation?: ProjectTaskProposal['isolation'] | undefined
    openPage?: ((path: ProjectTaskKnowledgeDocumentId) => void) | undefined
    openArtifactFile?: ((path: string, directoryVersion: string) => void) | undefined
    retry?: ((requestId: ProjectTaskKnowledgeDiscoveryRequestId) => Promise<boolean>) | undefined
    refreshCandidate?: ((requestId: ProjectTaskKnowledgeDiscoveryRequestId) => Promise<boolean>) | undefined
    recheckNoChange?: ((requestId: ProjectTaskKnowledgeDiscoveryRequestId) => Promise<boolean>) | undefined
  } & PropsLocale<'tasks'>) {
  const [confirming, setConfirming] = useState(false)
  const [retainedRequestId, setRetainedRequestId] = useState<ProjectTaskKnowledgeDiscoveryRequestId | null>(null)
  const [sending, setSending] = useState(false)
  const [confirmingRefresh, setConfirmingRefresh] = useState(false)
  const [retainedRefreshId, setRetainedRefreshId] = useState<ProjectTaskKnowledgeDiscoveryRequestId | null>(null)
  const [sendingRefresh, setSendingRefresh] = useState(false)
  const [confirmingNoChange, setConfirmingNoChange] = useState(false)
  const [retainedNoChangeId, setRetainedNoChangeId] = useState<ProjectTaskKnowledgeDiscoveryRequestId | null>(null)
  const [sendingNoChange, setSendingNoChange] = useState(false)
  useEffect(() => {
    if (discovery.status !== 'blocked' && !(discovery.status === 'queued' && recheckRequestId === undefined)) {
      setConfirming(false)
      setRetainedRequestId(null)
    }
  }, [discovery.status, recheckRequestId])
  useEffect(() => { setConfirmingRefresh(false); setRetainedRefreshId(null) },
    [discovery.status === 'candidate' ? discovery.candidateId : null])
  useEffect(() => { setConfirmingNoChange(false); setRetainedNoChangeId(null) },
    [discovery.status === 'no-change' ? discovery.reviewedAt : recheckRequestId])
  const settled = discovery.status === 'no-change' || discovery.status === 'candidate' ? discovery : undefined
  const noChangeRecheckable = discovery.status === 'no-change' && discovery.resultSha256 !== undefined
    && discovery.taskEvidenceSha256 !== undefined && (!hasArtifact
      || discovery.artifactDirectory?.coverageSha256 !== undefined)
    && (codingIsolation === undefined || codingIsolation === 'worktree'
      && discovery.codingEvidenceSha256 !== undefined)
  const queuedNoChangeRecheck = discovery.status === 'queued' && recheckRequestId !== undefined
  const codingEvidence = settled?.status === 'candidate' && settled.codingOmissions !== undefined ? 'partial'
    : settled?.codingEvidenceSha256 !== undefined ? 'retained'
      : settled === undefined || codingIsolation === undefined ? undefined
        : codingIsolation === 'direct' ? 'direct' : 'missing'
  const reviewedAt = settled?.reviewedAt
  const date = reviewedAt === undefined ? null : new Intl.DateTimeFormat(t('date.locale'), {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(reviewedAt)
  const submitRetry = (): void => {
    if (retry === undefined || sending || busy) return
    const requestId = retainedRequestId ?? (discovery.status === 'queued' ? refreshRequestId : undefined)
      ?? (randomUUID() as ProjectTaskKnowledgeDiscoveryRequestId)
    setRetainedRequestId(requestId)
    setConfirming(false)
    setSending(true)
    void retry(requestId).then((acknowledged) => {
      if (acknowledged) setRetainedRequestId(null)
    }).catch(() => {
      // The card command owner reports transport errors; retain this UUID for the same-operation retry.
    }).finally(() => { setSending(false) })
  }
  const submitRefresh = (): void => {
    if (refreshCandidate === undefined || sendingRefresh || busy || discovery.status !== 'candidate') return
    const requestId = retainedRefreshId ?? (randomUUID() as ProjectTaskKnowledgeDiscoveryRequestId)
    setRetainedRefreshId(requestId)
    setConfirmingRefresh(false)
    setSendingRefresh(true)
    void refreshCandidate(requestId).then((acknowledged) => {
      if (acknowledged) setRetainedRefreshId(null)
    }).catch(() => {
      // The card command owner reports transport errors; retain this UUID for the same-operation retry.
    }).finally(() => { setSendingRefresh(false) })
  }
  const submitNoChange = (): void => {
    if (recheckNoChange === undefined || sendingNoChange || busy || !noChangeRecheckable && !queuedNoChangeRecheck) return
    const requestId = retainedNoChangeId ?? (discovery.status === 'queued' ? recheckRequestId : undefined)
      ?? (randomUUID() as ProjectTaskKnowledgeDiscoveryRequestId)
    setRetainedNoChangeId(requestId)
    setConfirmingNoChange(false)
    setSendingNoChange(true)
    void recheckNoChange(requestId).then((acknowledged) => {
      if (acknowledged) setRetainedNoChangeId(null)
    }).catch(() => {
      // The command owner reports errors; the next confirmed attempt keeps this request identity.
    }).finally(() => { setSendingNoChange(false) })
  }
  return <section aria-label={t('taskDiscovery.title')} className={css.codeReview}
    data-task-knowledge-discovery aria-busy={busy || sending || sendingRefresh || sendingNoChange
      || discovery.status === 'reviewing'}>
    <h2>{t('taskDiscovery.title')}</h2>
    {!current && <p className={css.notice}>{t('taskDiscovery.historical')}</p>}
    <p role="status">{t(discovery.status === 'queued' && recheckRequestId !== undefined
      ? 'taskDiscovery.status.recheck-queued' : discovery.status === 'queued' && refreshRequestId !== undefined
        ? 'taskDiscovery.status.refresh-queued' : discovery.status === 'reviewing' && history.at(-1)?.discovery.status === 'no-change'
          ? 'taskDiscovery.status.recheck-reviewing' : discovery.status === 'reviewing' && history.length > 0
            ? 'taskDiscovery.status.refresh-reviewing' : `taskDiscovery.status.${discovery.status}`)}</p>
    {discovery.status === 'blocked' && <p role="alert">{t(`taskDiscovery.failure.${discovery.failure}`)}</p>}
    {discovery.status === 'blocked' && discovery.diagnostic !== undefined &&
      <p data-task-discovery-diagnostic={discovery.diagnostic}>{t(`taskDiscovery.diagnostic.${discovery.diagnostic}`)}</p>}
    {discovery.status === 'blocked' && discovery.diagnostic === 'invalid-result'
      && discovery.invalidResult !== undefined && <p role="alert"
      data-task-discovery-invalid-result={discovery.invalidResult}>
      {t(`taskDiscovery.invalidResult.${discovery.invalidResult}`)}</p>}
    {discovery.status === 'blocked' && discovery.diagnostic === 'invalid-result'
      && discovery.schemaIssue !== undefined && <p role="alert" data-task-discovery-schema-issue>
      {t('taskDiscovery.schemaIssue', {
        field: t(`taskDiscovery.schemaField.${discovery.schemaIssue.field}`),
        rule: t(`taskDiscovery.schemaRule.${discovery.schemaIssue.rule}`),
      })}</p>}
    {discovery.status === 'blocked' && discovery.diagnostic === 'review-attempt-failed'
      && discovery.reviewFailure !== undefined && <p role="alert"
      data-task-discovery-review-failure={discovery.reviewFailure}>
      {t(`taskDiscovery.reviewFailure.${discovery.reviewFailure}`)}</p>}
    {discovery.status === 'blocked' && discovery.diagnostic === undefined && discovery.failure === 'missing-evidence' &&
      <p>{t('taskDiscovery.diagnostic.unrecorded')}</p>}
    {codingEvidence !== undefined && <p className={css.notice} data-task-discovery-coding-evidence={codingEvidence}>
      {t(`taskDiscovery.codingEvidence.${codingEvidence}`)}</p>}
    <ImportedPdfCoverageReview sources={settled?.importedCoverage} t={t} />
    <ImportedDocxCoverageReview sources={settled?.importedDocxCoverage} t={t} />
    {discovery.status === 'no-change' && <>
      <p>{t('taskDiscovery.noChangeReason')}: {discovery.reason}</p>
      {discovery.codingEvidenceSha256 !== undefined && <p>
        {t('taskDiscovery.codingEvidenceSha256')}: <code>{discovery.codingEvidenceSha256}</code></p>}
      {discovery.sourceDispositions === undefined || discovery.sourceDispositions.length === 0
        ? <p className={css.notice}>{t('sourceMatrix.noChangeMissing')}</p>
        : <SourceDispositionReview sources={discovery.sourceDispositions} directoryVersion={undefined} t={t} />}
      <ComparedKnowledgePages pages={discovery.comparedPages} openPage={openPage} t={t} />
    </>}
    {discovery.status === 'candidate' && <>
      <p role="alert">{t(decided ? 'taskDiscovery.candidateWarning' : history.length > 0
        ? 'taskDiscovery.unsavedCurrent' : 'taskDiscovery.unsaved')}</p>
      <p>{t(`taskDiscovery.kind.${discovery.kind}`)}</p>
      <p>{discovery.summary}</p>
      <h3>{t('taskDiscovery.proposedTruth')}</h3>
      <pre className={css.discoveryText}>{discovery.proposedTruth}</pre>
      <h3>{t('taskDiscovery.evidence')}</h3>
      <pre className={css.discoveryText}>{discovery.evidence}</pre>
      <ArtifactCoverageReview files={discovery.artifactCoverage}
        directoryVersion={discovery.artifactDirectory === undefined ? undefined
          : `${discovery.artifactDirectory.version}:${discovery.artifactDirectory.digest}`}
        coverageSha256={discovery.artifactDirectory?.coverageSha256} onOpenFile={openArtifactFile} t={t} />
      <CodingCoverageReview files={discovery.codingOmissions} t={t} />
      <SourceDispositionReview sources={discovery.sourceDispositions}
        directoryVersion={discovery.artifactDirectory === undefined ? undefined
          : `${discovery.artifactDirectory.version}:${discovery.artifactDirectory.digest}`}
        onOpenFile={openArtifactFile} t={t} />
      {discovery.topicSearch !== undefined && <details>
        <summary>{t('taskDiscovery.topicSearch', { count: discovery.topicSearch.hits.length })}</summary>
        <p>{t('taskDiscovery.topicQuery')}: <code>{discovery.topicSearch.query}</code></p>
        {discovery.topicSearch.hits.length > 0 && <ul>{discovery.topicSearch.hits.map(hit =>
          <li key={`${hit.path}/${hit.version}`}><code>{hit.path}</code> · <code>{hit.version}</code>
            {openPage !== undefined && <Button size="sm" variant="ghost"
              onClick={() => { openPage(hit.path as ProjectTaskKnowledgeDocumentId) }}>
              {t('taskDiscovery.openPage')}</Button>}</li>)}</ul>}
        <p>{t('taskDiscovery.searchLimit')}</p>
      </details>}
      <ComparedKnowledgePages pages={discovery.comparedPages} openPage={openPage} t={t} />
      <details><summary>{t('taskDiscovery.candidateIdentity')}</summary>
        <p>{t('taskDiscovery.candidateIdentityLimit')}</p>
        <dl className={css.discoveryIdentity}>
          <dt>{t('taskDiscovery.discoveryId')}</dt><dd><code>{discovery.discoveryId}</code></dd>
          <dt>{t('taskDiscovery.resultSha256')}</dt><dd><code>{discovery.resultSha256}</code></dd>
          {discovery.codingEvidenceSha256 !== undefined && <>
            <dt>{t('taskDiscovery.codingEvidenceSha256')}</dt>
            <dd><code>{discovery.codingEvidenceSha256}</code></dd></>}
          <dt>{t('taskDiscovery.candidateSha256')}</dt><dd><code>{discovery.candidateSha256}</code></dd>
        </dl>
      </details>
    </>}
    {date !== null && reviewedAt !== undefined && <p><time dateTime={new Date(reviewedAt).toISOString()}>
      {t('taskDiscovery.reviewedAt', { date })}</time></p>}
    {history.length > 0 && <details data-task-discovery-history><summary>{t('taskDiscovery.history', { count: history.length })}</summary>
      <p>{t('taskDiscovery.historyWarning')}</p>
      <ol>{history.map(entry => <li key={entry.refreshRequestId}>
        <ImportedPdfCoverageReview sources={entry.discovery.importedCoverage} t={t} />
        <ImportedDocxCoverageReview sources={entry.discovery.importedDocxCoverage} t={t} />
        {'kind' in entry ? <>
          <p>{t('taskDiscovery.historyNoChange')}: {entry.discovery.reason}</p>
          {entry.discovery.sourceDispositions === undefined || entry.discovery.sourceDispositions.length === 0
            ? <p className={css.notice}>{t('sourceMatrix.noChangeMissing')}</p>
            : <SourceDispositionReview sources={entry.discovery.sourceDispositions} directoryVersion={undefined} t={t} />}
          <ComparedKnowledgePageHistory pages={entry.discovery.comparedPages} t={t} />
        </> : <>
          <p>{t('taskDiscovery.historyCandidate')}: {entry.discovery.summary}</p>
          <p>{t(`taskDiscovery.kind.${entry.discovery.kind}`)}</p>
          <pre className={css.discoveryText}>{entry.discovery.proposedTruth}</pre>
          <p>{t('taskDiscovery.evidence')}</p><pre className={css.discoveryText}>{entry.discovery.evidence}</pre>
          <SourceDispositionReview sources={entry.discovery.sourceDispositions}
            directoryVersion={entry.discovery.artifactDirectory?.version} t={t} />
          <p><code>{entry.discovery.candidateId}</code></p>
          {entry.decision !== undefined && <>
            <p>{t('taskDiscovery.historyDecision')}: {t(entry.decision.status === 'draft-saved'
            && entry.decision.publication?.status === 'published'
              ? 'taskDecision.status.published' : `taskDecision.status.${entry.decision.status}`)}</p>
            {entry.decision.status !== 'dismissed' && <p><code>{entry.decision.path}</code>
              {entry.decision.receipt === undefined ? '' : ` · ${entry.decision.receipt.version}`}</p>}
            {entry.decision.status === 'draft-saved' && entry.decision.publication?.status === 'published' &&
            entry.decision.publication.receipt !== undefined &&
            <p>{t('taskDecision.publishedVersion')}: <code>{entry.decision.publication.receipt.version}</code></p>}
            {current && openPage !== undefined && entry.decision.status === 'draft-saved' &&
            <Button size="sm" variant="outline" onClick={() => {
              if (entry.decision?.status === 'draft-saved') openPage(entry.decision.path)
            }}>
              {t('taskDiscovery.openHistoricalPage')}</Button>}
          </>}
        </>}
      </li>)}</ol>
    </details>}
    {current && discovery.status === 'no-change' && !noChangeRecheckable &&
      <p className={css.notice}>{t(discovery.resultSha256 === undefined || discovery.taskEvidenceSha256 === undefined
        ? 'taskDiscovery.noChangeRecheckUnavailable.legacy'
        : codingIsolation !== undefined ? 'taskDiscovery.noChangeRecheckUnavailable.coding'
          : 'taskDiscovery.noChangeRecheckUnavailable.artifact')}</p>}
    {discovery.status === 'no-change' && current && refreshBlocked !== undefined &&
      <p role="alert">{t(`taskDiscovery.refreshBlocked.${refreshBlocked}`)}</p>}
    {(noChangeRecheckable || queuedNoChangeRecheck)
      && current && recheckNoChange !== undefined && (refreshBlocked === undefined || discovery.status === 'queued')
      && !confirmingNoChange &&
      <Button size="sm" variant="outline" disabled={busy || sendingNoChange}
        onClick={() => { setConfirmingNoChange(true) }}>{t(discovery.status === 'queued'
          ? 'taskDiscovery.resumeNoChangeRecheck' : 'taskDiscovery.recheckNoChange')}</Button>}
    {retainedNoChangeId !== null && !sendingNoChange &&
      (discovery.status === 'no-change' || discovery.status === 'queued') &&
      <p className={css.notice}>{t('taskDiscovery.uncertainNoChangeRecheck')}</p>}
    {(noChangeRecheckable || queuedNoChangeRecheck)
      && current && recheckNoChange !== undefined && (refreshBlocked === undefined || discovery.status === 'queued')
      && confirmingNoChange &&
      <div role="group" aria-label={t('taskDiscovery.recheckNoChangeConfirmTitle')} className={css.notice}>
        <p>{t('taskDiscovery.recheckNoChangeConfirmation')}</p>
        <div className={css.reviewActions}>
          <Button size="sm" disabled={busy || sendingNoChange} onClick={submitNoChange}>
            {t('taskDiscovery.confirmNoChangeRecheck')}</Button>
          <Button variant="ghost" size="sm" disabled={busy || sendingNoChange}
            onClick={() => { setConfirmingNoChange(false) }}>{t('taskDiscovery.dismiss')}</Button>
        </div>
      </div>}
    {discovery.status === 'candidate' && current && refreshBlocked !== undefined &&
      <p role="alert">{t(`taskDiscovery.refreshBlocked.${refreshBlocked}`)}</p>}
    {discovery.status === 'candidate' && current && refreshCandidate !== undefined && refreshBlocked === undefined &&
      !confirmingRefresh && <Button size="sm" variant="outline" disabled={busy || sendingRefresh}
      onClick={() => { setConfirmingRefresh(true) }}>{t('taskDiscovery.refresh')}</Button>}
    {retainedRefreshId !== null && !sendingRefresh && discovery.status === 'candidate' &&
      <p className={css.notice}>{t('taskDiscovery.uncertainRefresh')}</p>}
    {discovery.status === 'candidate' && current && refreshCandidate !== undefined && refreshBlocked === undefined &&
      confirmingRefresh && <div role="group" aria-label={t('taskDiscovery.refreshConfirmTitle')} className={css.notice}>
      <p>{t('taskDiscovery.refreshConfirmation')}</p>
      <div className={css.reviewActions}>
        <Button size="sm" disabled={busy || sendingRefresh} onClick={submitRefresh}>{t('taskDiscovery.confirmRefresh')}</Button>
        <Button variant="ghost" size="sm" disabled={busy || sendingRefresh}
          onClick={() => { setConfirmingRefresh(false) }}>{t('taskDiscovery.dismiss')}</Button>
      </div>
    </div>}
    {(discovery.status === 'blocked' || discovery.status === 'queued' && recheckRequestId === undefined)
      && current && retry !== undefined && !confirming &&
      <Button size="sm" disabled={busy || sending} onClick={() => { setConfirming(true) }}>
        {t(discovery.status !== 'queued' ? 'taskDiscovery.retry' : refreshRequestId !== undefined
          ? 'taskDiscovery.resumeRefresh' : 'taskDiscovery.resume')}</Button>}
    {retainedRequestId !== null && !sending && (discovery.status === 'blocked' || discovery.status === 'queued') &&
      <p className={css.notice}>{t('taskDiscovery.uncertainRetry')}</p>}
    {(discovery.status === 'blocked' || discovery.status === 'queued' && recheckRequestId === undefined)
      && current && retry !== undefined && confirming &&
      <div role="group" aria-label={t('taskDiscovery.confirmTitle')} className={css.notice}>
        <p>{t('taskDiscovery.confirmation')}</p>
        <div className={css.reviewActions}>
          <Button size="sm" disabled={busy || sending} onClick={submitRetry}>
            {t('taskDiscovery.confirm')}</Button>
          <Button variant="ghost" size="sm" disabled={busy || sending} onClick={() => { setConfirming(false) }}>
            {t('taskDiscovery.dismiss')}</Button>
        </div>
      </div>}
  </section>
}
