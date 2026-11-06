/** Read retained import evidence and recover only previously submitted operations. */
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { IKnowledgeImports } from '@deepseek-ai/dsh-api-knowledge-import-controller/client'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeImportAppliedStep, KnowledgeImportDiscovery, KnowledgeImportReviewChange,
  KnowledgeImportComparedPageReview, KnowledgeImportSourceDispositionReview,
  KnowledgeImportReviewExecution, KnowledgeImportReviewId, KnowledgeImportDraftActionId, KnowledgeImportHeldDraft,
  KnowledgeImportReviewLookup,
} from '@deepseek-ai/dsh-api-knowledge-import-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createKnowledgeImportReviewStore } from './import-store.ts'
import { PdfExtractionNotice } from './PdfExtractionNotice.tsx'
import { DocxExtractionNotice } from './DocxExtractionNotice.tsx'
import css from './KnowledgeImportReview.module.css'

/** Review operations belong to the Client model; only confirmation state is retained by the UI. */
export interface KnowledgeImportReviewInjected {
  hooks: { reviews: IKnowledgeImports['reviews'] }
  inspectReview: IKnowledgeImports['inspectReview']
  resumeAutomaticMaintenance: (sessionId: SessionId, signal: AbortSignal) => Promise<void>
  decideReview: IKnowledgeImports['decideReview']
  saveZeroHitDraft: IKnowledgeImports['saveZeroHitDraft']
  publishZeroHitDraft: IKnowledgeImports['publishZeroHitDraft']
  setComparedPageDecision: IKnowledgeImports['setComparedPageDecision']
  setSourceDispositionDecision: IKnowledgeImports['setSourceDispositionDecision']
  readReviewComparedPage: IKnowledgeImports['readComparedPage']
  readHeldDraftCatalogPage: IKnowledgeImports['readHeldDraftCatalogPage']
  openSource: (sessionId: SessionId, documentId: DocumentImportSourceId) => void
  /** Read one Brain document and its version; the view checks both before displaying its body. */
  readComparedPage: (projectId: WorkspaceId, path: string,
    signal: AbortSignal) => Promise<{ kind: string; path: string; version: string; body: string }>
  newReviewId: () => KnowledgeImportReviewId
  newDraftActionId: () => KnowledgeImportDraftActionId
  knownFromSubmission: (sessionId: SessionId) => boolean
}

/** Session header action; Stop revokes an incomplete approved plan only when no write receipt is missing. */
export type KnowledgeImportReviewProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'knowledge'>
  & PropsStore<ReturnType<typeof createKnowledgeImportReviewStore>> & InjectFace<KnowledgeImportReviewInjected>

const reviewTools = new Set(['brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page',
  'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_normalize_page_format',
  'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex'])

function reviewableChanges(
  changes: readonly KnowledgeImportReviewChange[] | null | undefined,
): changes is readonly KnowledgeImportReviewChange[] {
  return changes != null && changes.length > 0 && changes.every((change) => {
    if (!reviewTools.has(change.tool) || !/^[a-f0-9]{64}$/u.test(change.sha256)) return false
    const args = change.arguments
    if (typeof args.target_project_id !== 'string' || args.target_project_id.trim() === '') return false
    if (change.tool === 'brain_reindex') return args.path === undefined && args.paths === undefined && args.expected_version === undefined
    if (change.tool === 'brain_normalize_page_format') return args.path === undefined && args.expected_version === undefined
      && Array.isArray(args.paths) && args.paths.length > 0
      && args.paths.every((path: unknown) => typeof path === 'string' && path.trim() !== '')
    if (typeof args.path !== 'string' || args.path.trim() === '') return false
    if (change.tool === 'brain_create_page') return args.expected_version === undefined
    if (change.tool === 'brain_write_root') return args.expected_version === null
      || typeof args.expected_version === 'string' && args.expected_version.trim() !== ''
    return typeof args.expected_version === 'string' && args.expected_version.trim() !== ''
  })
}

function safeList<T>(items: readonly T[] | undefined): readonly T[] {
  return items ?? []
}

function reviewableEvidence(changes: readonly KnowledgeImportReviewChange[], requireComparedQuote: boolean): boolean {
  return changes.every((change) => {
    const evidence = change.evidence
    const sources = safeList(evidence?.sources)
    const comparedPages = safeList(evidence?.compared_pages)
    if (sources.length === 0 || sources.some(source => source.document_id.trim() === '' || source.quote.trim() === '')
      || comparedPages.some(page => page.target_project_id.trim() === '' || page.path.trim() === '' || page.version.trim() === ''
        || requireComparedQuote && (!('quote' in page) || typeof page.quote !== 'string' || page.quote.trim() === ''))) return false
    const { target_project_id: projectId, path, expected_version: version } = change.arguments
    return typeof path !== 'string' || typeof version !== 'string'
      || comparedPages.some(page => page.target_project_id === projectId && page.path === path && page.version === version)
  })
}

function reviewableMixedPlan(changes: readonly KnowledgeImportReviewChange[]): boolean {
  if (changes.length !== 2) return false
  const [update, create] = changes
  return update?.tool === 'brain_update_truth' && create?.tool === 'brain_create_page'
    && update.arguments.target_project_id === create.arguments.target_project_id
    && create.arguments.status === 'active'
    && typeof update.arguments.path === 'string' && typeof create.arguments.path === 'string'
    && update.arguments.path !== create.arguments.path
}

function reviewableSingleCreation(changes: readonly KnowledgeImportReviewChange[]): boolean {
  return changes.length === 1 && changes[0]?.tool === 'brain_create_page'
    && changes[0].arguments.status === 'active'
}

function reviewableDiscovery(changes: readonly KnowledgeImportReviewChange[],
  discovery: readonly KnowledgeImportDiscovery[] | undefined): boolean {
  if (!Array.isArray(discovery)) return false
  const creations = changes.flatMap((change, index) => change.tool === 'brain_create_page'
    && change.arguments.status === 'active' ? [index] : [])
  if (creations.length > 1 || discovery.length !== creations.length) return false
  const receipts: readonly KnowledgeImportDiscovery[] = discovery
  return receipts.every((receipt) => {
    if (!Number.isInteger(receipt.changeIndex) || !creations.includes(receipt.changeIndex)
      || receipt.targetProjectId !== changes[receipt.changeIndex]?.arguments.target_project_id
      || typeof receipt.exists !== 'boolean' || !Array.isArray(receipt.hits)) return false
    if (receipt.mode === 'empty-index') return receipt.query === undefined && receipt.hits.length === 0
    if (typeof receipt.query !== 'string' || receipt.query.trim() === '') return false
    const change = changes[receipt.changeIndex]
    if (change === undefined) return false
    if (typeof change.arguments.title === 'string'
      && receipt.query.trim().toLocaleLowerCase() === change.arguments.title.trim().toLocaleLowerCase()
      || !receipt.exists && receipt.hits.length > 0) return false
    const comparedPages = safeList(change.evidence?.compared_pages)
    return receipt.hits.every((hit: KnowledgeImportDiscovery['hits'][number]) => typeof hit.path === 'string' && hit.path.trim() !== ''
      && typeof hit.title === 'string' && hit.title.trim() !== ''
      && typeof hit.version === 'string' && hit.version.trim() !== ''
      && comparedPages.some(page => page.target_project_id === receipt.targetProjectId
        && page.path === hit.path && page.version === hit.version
        && typeof page.quote === 'string' && page.quote.trim() !== ''))
  })
}

function reviewedRelations(changes: readonly KnowledgeImportReviewChange[],
  review: KnowledgeImportComparedPageReview | undefined): boolean {
  const expected = changes.flatMap((change, changeIndex) => change.tool === 'brain_create_page'
    && change.arguments.status === 'active'
    ? safeList(change.evidence?.compared_pages).map((page, pageIndex) => ({ changeIndex, pageIndex, page })) : [])
  if (expected.length === 0) return true
  return review !== undefined && /^[a-f0-9]{64}$/u.test(review.sha256)
    && review.choices.length === expected.length && expected.every(({ changeIndex, pageIndex, page }, index) => {
    const choice = review.choices[index]
    return choice?.relation === 'distinct' && choice.changeIndex === changeIndex && choice.pageIndex === pageIndex
        && choice.changeSha256 === changes[changeIndex]?.sha256
        && choice.targetProjectId === page.target_project_id && choice.path === page.path
        && choice.version === page.version && /^[a-f0-9]{64}$/u.test(choice.pageSha256)
  })
}

function reviewedSources(changes: readonly KnowledgeImportReviewChange[],
  review: KnowledgeImportSourceDispositionReview | undefined): boolean {
  const expected = changes.flatMap((change, changeIndex) => {
    const active = change.tool === 'brain_update_truth' || change.tool === 'brain_write_root'
      || change.tool === 'brain_append_timeline'
      || change.tool === 'brain_create_page' && change.arguments.status === 'active'
      || change.tool === 'brain_set_page_status' && change.arguments.status === 'active'
    return active ? safeList(change.evidence?.source_dispositions).map((source, sourceIndex) => ({
      changeIndex, sourceIndex, source,
    })) : []
  })
  if (expected.length === 0) return true
  return review !== undefined && /^[a-f0-9]{64}$/u.test(review.sha256)
    && review.choices.length === expected.length && expected.every(({ changeIndex, sourceIndex, source }, index) => {
    const choice = review.choices[index]
    return choice?.judgment === 'confirmed' && choice.changeIndex === changeIndex
        && choice.sourceIndex === sourceIndex && choice.changeSha256 === changes[changeIndex]?.sha256
        && choice.documentId === source.document_id && /^[a-f0-9]{64}$/u.test(choice.dispositionSha256)
  })
}

function reviewableHeldCatalog(current: KnowledgeImportHeldDraft['current']): boolean {
  if (current === undefined || !/^[a-f0-9]{64}$/u.test(current.activeIndexDigest)
    || !Number.isInteger(current.activePageCount)
    || current.activePages.length !== current.activePageCount) return false
  const paths = new Set<string>()
  for (const { path, title, version } of current.activePages) {
    if (path.trim() === '' || title.trim() === '' || version.trim() === '' || paths.has(path)) return false
    paths.add(path)
  }
  return true
}

function reviewableZeroHitTitleSearch(proposal: NonNullable<KnowledgeImportReviewLookup['proposal']>,
  change: KnowledgeImportReviewChange | undefined): boolean {
  const receipt = proposal.zeroHitTitleSearch
  return change?.tool === 'brain_create_page' && receipt !== undefined
    && receipt.targetProjectId === change.arguments.target_project_id
    && typeof change.arguments.title === 'string' && receipt.query === change.arguments.title.trim()
    && (receipt.exists || receipt.hits.length === 0)
    && receipt.hits.every(hit => hit.path.trim() !== '' && hit.title.trim() !== '' && hit.version.trim() !== '')
}

function reviewableExecution(execution: KnowledgeImportReviewExecution | undefined,
  changes: readonly KnowledgeImportReviewChange[]): execution is KnowledgeImportReviewExecution {
  if (execution === undefined || !reviewableMixedPlan(changes) && !reviewableSingleCreation(changes)
    || !Array.isArray(execution.appliedSteps) || execution.nextChangeIndex !== execution.appliedSteps.length
    || execution.nextChangeIndex < 0 || execution.nextChangeIndex > changes.length) return false
  const steps: readonly KnowledgeImportAppliedStep[] = execution.appliedSteps
  if (!steps.every((step, index) => {
    const change = changes[index]
    return change !== undefined && step.index === index
      && step.changeSha256 === change.sha256
      && step.targetProjectId === change.arguments.target_project_id
      && step.path === change.arguments.path
      && typeof step.operationId === 'string' && step.operationId.trim() !== ''
      && typeof step.postVersion === 'string' && step.postVersion.trim() !== ''
      && typeof step.postActiveIndexDigest === 'string' && /^[a-f0-9]{64}$/u.test(step.postActiveIndexDigest)
  })) return false
  switch (execution.status) {
    case 'awaiting-approval':
    case 'ready': return execution.nextChangeIndex === 0 && execution.reason === undefined
    case 'partially-applied': return changes.length === 2 && execution.nextChangeIndex === 1
      && execution.reason === undefined
    case 'complete': return execution.nextChangeIndex === changes.length && execution.reason === undefined
    case 'blocked': return execution.reason !== undefined
    default: return false
  }
}

function executionSignature(execution: KnowledgeImportReviewExecution): string {
  return JSON.stringify([execution.status, execution.nextChangeIndex, execution.reason ?? null,
    execution.appliedSteps.map(step => [step.index, step.changeSha256, step.operationId, step.targetProjectId,
      step.path, step.postVersion, step.postActiveIndexDigest])])
}

function relationKey(relation: unknown) {
  switch (relation) {
    case 'duplicate': return 'import.review.relation.duplicate' as const
    case 'conflict': return 'import.review.relation.conflict' as const
    case 'supports': return 'import.review.relation.supports' as const
    case 'supersedes': return 'import.review.relation.supersedes' as const
    default: return 'import.review.relation.unknown' as const
  }
}

function ComparedPageBody({ path, version, read, t, context }: {
  path: string
  version: string
  read: (signal: AbortSignal) => Promise<{ kind: string; path: string; version: string; body: string }>
  t: KnowledgeImportReviewProps['t']
  context: 'proposal' | 'held-draft-catalog'
}) {
  const [view, setView] = useState<{ kind: 'idle' | 'loading' | 'changed' | 'error' }
    | { kind: 'ready'; body: string }>({ kind: 'idle' })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort(); pending.current = null }, [])
  const load = async (): Promise<void> => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    setView({ kind: 'loading' })
    try {
      const result = await read(request.signal)
      if (!request.signal.aborted) {
        const ready = (result.kind === 'page' || result.kind === 'root')
          && result.path === path && result.version === version
        setView(ready ? { kind: 'ready', body: result.body } : { kind: 'changed' })
      }
    } catch {
      if (!request.signal.aborted) setView({ kind: 'error' })
    } finally {
      if (pending.current === request) pending.current = null
    }
  }
  return <div>
    <Button size="sm" variant="outline" aria-label={t('import.review.comparedReadFor', { path })}
      disabled={view.kind === 'loading'} onClick={() => { void load() }}>
      {t(view.kind === 'ready' || view.kind === 'changed' || view.kind === 'error'
        ? 'import.review.comparedReadAgain' : 'import.review.comparedRead')}
    </Button>
    {view.kind === 'loading' && <p role="status">{t('import.review.comparedLoading')}</p>}
    {view.kind === 'ready' && <>
      <p className={css.metadata}>{t(context === 'proposal'
        ? 'import.review.comparedBody' : 'import.review.zeroHitCatalogBody')}</p>
      <pre className={css.quote}>{view.body}</pre>
    </>}
    {view.kind === 'changed' && <p role="alert">{t(context === 'proposal'
      ? 'import.review.comparedChanged' : 'import.review.zeroHitCatalogChanged')}</p>}
    {view.kind === 'error' && <p role="alert">{t('import.review.comparedReadError')}</p>}
  </div>
}

/** Read retained import evidence and recover original submitted operations without preparing a new decision.
 * @param props - Session identity, durable review model, retained decision intent and localized controls.
 * @returns an import-only status action and review dialog; opening it never starts a model turn.
 */
export function KnowledgeImportReview(props: KnowledgeImportReviewProps) {
  const observation = props.useReviews(state => state.sessions.find(entry => entry.sessionId === props.sessionId))
  return observation?.lookup?.state.maintenance !== undefined
    ? <AutomaticImportStatus {...props} lookup={observation.lookup} /> : <LegacyKnowledgeImportReview {...props} />
}

function AutomaticImportStatus(props: KnowledgeImportReviewProps & { lookup: KnowledgeImportReviewLookup }) {
  const { lookup, sessionId, t } = props
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  const observations = useRef(new Set<AbortController>())
  const progress = lookup.state.automatic
  const busy = progress?.status === 'reviewing' || progress?.status === 'applying'
  useEffect(() => {
    if (!busy) return
    const caller = new AbortController()
    const timer = setInterval(() => { void props.inspectReview(sessionId, caller.signal).catch((error: unknown) => {
      if (!caller.signal.aborted) setFailed(true)
      void error
    }) }, 1500)
    return () => { clearInterval(timer); caller.abort() }
  }, [busy, sessionId, props.inspectReview])
  useEffect(() => () => {
    request.current?.abort()
    for (const caller of observations.current) caller.abort()
    observations.current.clear()
  }, [])
  const reload = (): void => {
    const caller = new AbortController()
    observations.current.add(caller)
    void props.inspectReview(sessionId, caller.signal).catch((error: unknown) => {
      if (!caller.signal.aborted) setFailed(true)
      void error
    }).finally(() => { observations.current.delete(caller) })
  }
  const status = progress?.status ?? 'read-only'
  return <>
    <Button variant="outline" size="sm" className={css.trigger} onClick={() => { setOpen(true) }}>
      {t(`import.automatic.${status}`)}</Button>
    <Modal open={open} title={t('import.automatic.title')} closeLabel={t('import.review.close')}
      onClose={() => { if (!pending) setOpen(false) }} className={clsx(css.dialog)} contentClassName={clsx(css.content)}>
      <div className={css.body} aria-busy={busy || pending}>
        <p role="status">{t(`import.automatic.${status}`)}</p>
        <p>{t('import.automatic.scope')}</p>
        {progress !== undefined && <p>{t('import.automatic.progress', { rounds: progress.rounds, count: progress.writes.length })}</p>}
        {progress?.reason !== undefined && <p>{t(`import.automatic.reason.${progress.reason}`)}</p>}
        {progress !== undefined && progress.writes.length > 0 && <ul>{progress.writes.map(write =>
          <li key={write.operationId}><code>{write.documentId}</code> · <code>{write.version}</code></li>)}</ul>}
        <p>{t('import.automatic.history')}</p>
        {failed && <p role="alert">{t('import.automatic.retryFailed')}</p>}
        {progress?.recoverable && <Button variant="primary" disabled={pending} onClick={() => {
          const caller = new AbortController(); request.current = caller
          setPending(true); setFailed(false)
          void props.resumeAutomaticMaintenance(sessionId, caller.signal).catch((error: unknown) => {
            if (!caller.signal.aborted) setFailed(true)
            void error
          }).finally(() => { if (!caller.signal.aborted) setPending(false); if (request.current === caller) request.current = null })
        }}>{t('import.automatic.resume')}</Button>}
        <Button variant="outline" disabled={pending} onClick={reload}>{t('import.review.reload')}</Button>
      </div>
    </Modal>
  </>
}

function LegacyKnowledgeImportReview(props: KnowledgeImportReviewProps) {
  const { sessionId, t, actions } = props
  const observation = props.useReviews(state => state.sessions.find(entry => entry.sessionId === sessionId))
  const saved = props.useStore(state => state.reviewDecisions?.[sessionId])
  const draftAction = props.useStore(state => state.zeroHitDraftActions?.[sessionId])
  const acceptedSource = useMemo(() => props.knownFromSubmission(sessionId), [sessionId, props.knownFromSubmission])
  const known = props.useStore(state => state.reviewSessions?.[sessionId] === true) || acceptedSource
  const draft = props.useInput(state => state.draft)
  const inputPhase = props.useInput(state => state.phase)
  const [open, setOpen] = useState(false)
  const request = useRef<AbortController | null>(null)
  const lookup = observation?.lookup ?? null
  const proposal = lookup?.proposal ?? null
  const heldDraft = lookup?.zeroHitDraft
  const heldDraftCurrent = heldDraft?.current
  const catalogKey = heldDraft?.current === undefined ? '' : JSON.stringify([
    heldDraft.operationId, heldDraft.current.version, heldDraft.current.activeIndexDigest,
    heldDraft.current.activePages.map(page => [page.path, page.title, page.version]),
  ])
  const changes = proposal?.changes
  const validChanges = reviewableChanges(changes)
  const v4 = proposal?.format === 'brain-review-json-v4'
  const discoveryFormat = proposal?.format === 'brain-review-json-v5' || proposal?.format === 'brain-review-json-v6'
  const singleCreation = discoveryFormat && validChanges && reviewableSingleCreation(changes)
  const trackedExecution = v4 || discoveryFormat && validChanges && (reviewableMixedPlan(changes) || singleCreation)
  const execution = trackedExecution ? proposal.execution : undefined
  const validExecution = trackedExecution && validChanges && reviewableExecution(execution, changes)
  const validDiscovery = discoveryFormat && validChanges && reviewableDiscovery(changes, proposal.discovery)
  const relationsReady = !discoveryFormat || validChanges && reviewedRelations(changes, proposal.comparedPageReview)
  const relationDigest = proposal?.comparedPageReview?.choices.length ? proposal.comparedPageReview.sha256 : undefined
  const sourcesReady = proposal?.format !== 'brain-review-json-v6' || validChanges
    && reviewedSources(changes, proposal.sourceDispositionReview)
  const sourceDigest = proposal?.sourceDispositionReview?.choices.length
    ? proposal.sourceDispositionReview.sha256 : undefined
  const sourcesDisputed = proposal?.sourceDispositionReview?.choices.some(choice => choice.judgment === 'disputed') ?? false
  const zeroHitChangeIndex = validChanges ? changes.findIndex(change => change.tool === 'brain_create_page'
    && change.arguments.status === 'active') : -1
  const heldReason = proposal?.verification.reason
  const zeroHitProposal = (heldReason === 'zero-hit-draft-required'
    || heldReason === 'source-conflict-draft-required'
    || heldReason === 'discovery-coverage-draft-required')
    && validChanges && validDiscovery && zeroHitChangeIndex >= 0
    && (singleCreation || reviewableMixedPlan(changes))
  const rejectedZeroHitProposal = lookup?.state.review?.decision === 'rejected'
    && lookup.state.review.proposalMessageId === proposal?.messageId
    && lookup.state.review.proposalSha256 === proposal.sha256
  const titleSearchReady = proposal !== null && reviewableZeroHitTitleSearch(proposal,
    zeroHitChangeIndex < 0 ? undefined : changes?.[zeroHitChangeIndex])
  const titleSearch = proposal?.zeroHitTitleSearch
  const canSaveZeroHit = zeroHitProposal && titleSearchReady && heldDraft === undefined && !rejectedZeroHitProposal
  const canPublishZeroHit = heldDraft?.reason !== 'source-conflict-draft-required'
    && (heldDraft?.phase === 'saved' || heldDraft?.phase === 'edited')
    && reviewableHeldCatalog(heldDraft.current)
  const discoverySignature = discoveryFormat ? JSON.stringify(proposal.discovery ?? null) : null
  const executionIdentity = validExecution ? executionSignature(execution) : null
  const review = lookup?.state.review
  const trackedAlreadyApproved = trackedExecution && review?.decision === 'approved'
    && review.proposalMessageId === proposal.messageId && review.proposalSha256 === proposal.sha256
  const evidenceAndOrderReady = validChanges && proposal?.verification.status === 'verified'
    && (proposal.format === 'brain-review-json-v1'
      || reviewableEvidence(changes, proposal.format === 'brain-review-json-v3' || trackedExecution || discoveryFormat))
    && (!discoveryFormat || validDiscovery && (trackedExecution || proposal.execution === undefined))
    && (!trackedExecution || validExecution && execution.status === 'awaiting-approval' && !trackedAlreadyApproved)
  const canApprove = evidenceAndOrderReady && relationsReady && sourcesReady
  const changeHashes = validChanges && (canApprove || validExecution) ? changes.map(change => change.sha256) : null
  const sameApprovedChanges = validChanges && review?.changesSha256 !== undefined
    && review.changes?.length === changes.length
    && review.changes.every((change, index) => change.sha256 === changes[index]?.sha256)
  const approvedTracked = trackedExecution && validExecution && (!discoveryFormat || validDiscovery)
    && proposal.verification.status === 'verified'
    && (execution.status === 'ready' || execution.status === 'partially-applied' || execution.status === 'complete')
    && trackedAlreadyApproved && sameApprovedChanges && !proposal.approvalNeedsRenewal
  const blockedApproved = trackedExecution && validExecution && trackedAlreadyApproved && sameApprovedChanges
    && execution.status === 'blocked' && execution.reason !== 'step-receipt-missing'
    && execution.reason !== 'review-rejected'
  const exactDecision = proposal !== null && review?.proposalMessageId === proposal.messageId
    && review.proposalSha256 === proposal.sha256
    && (review.decision === 'rejected' || sameApprovedChanges && !proposal.approvalNeedsRenewal
      && (trackedExecution ? approvedTracked : canApprove)) ? review.decision : null
  const canReject = !trackedExecution || validExecution && (execution.status === 'awaiting-approval' && !trackedAlreadyApproved
    || approvedTracked && (execution.status === 'ready' || execution.status === 'partially-applied')
    || blockedApproved)
  const stopRemaining = trackedExecution && validExecution && approvedTracked
    && (execution.status === 'ready' || execution.status === 'partially-applied') || blockedApproved
  const active = observation?.phase === 'loading' || observation?.phase === 'deciding'
  const retainedDraftRequest = draftAction !== undefined && (draftAction.kind === 'save'
    ? heldDraft?.phase === 'saving' && heldDraft.operationId === draftAction.request.operationId
      && heldDraft.proposalMessageId === draftAction.request.proposalMessageId
      && heldDraft.proposalSha256 === draftAction.request.expectedProposalSha256
      && heldDraft.changeIndex === draftAction.request.changeIndex
      && heldDraft.changeSha256 === draftAction.request.expectedChangeSha256
    : heldDraft?.operationId === draftAction.request.draftOperationId
      && heldDraft.pendingPublication?.operationId === draftAction.request.operationId
      && heldDraft.pendingPublication.expectedDraftVersion === draftAction.request.expectedDraftVersion
      && heldDraft.pendingPublication.expectedActiveIndexDigest === draftAction.request.expectedActiveIndexDigest
      && heldDraft.pendingPublication.reviewedPages !== undefined
      && JSON.stringify(heldDraft.pendingPublication.reviewedPages) === JSON.stringify(draftAction.request.reviewedPages))
  const draftActionRecoverable = draftAction !== undefined && (draftAction.attempted || retainedDraftRequest)
  const draftActionMatches = draftAction === undefined ? true : draftAction.kind === 'save'
    ? retainedDraftRequest
      || canSaveZeroHit
        && draftAction.request.proposalMessageId === proposal.messageId
        && draftAction.request.expectedProposalSha256 === proposal.sha256
        && draftAction.request.changeIndex === zeroHitChangeIndex
        && draftAction.request.expectedChangeSha256 === changes[zeroHitChangeIndex]?.sha256
    : retainedDraftRequest || heldDraft?.pendingPublication === undefined
      && heldDraft?.operationId === draftAction.request.draftOperationId
      && (heldDraft.publicationOperationId === draftAction.request.operationId
        || canPublishZeroHit && heldDraft.current?.version === draftAction.request.expectedDraftVersion
          && heldDraft.current.activeIndexDigest === draftAction.request.expectedActiveIndexDigest
          && JSON.stringify(draftAction.request.reviewedPages.map(({ path, title, version }) =>
            ({ path, title, version }))) === JSON.stringify(heldDraft.current.activePages)
          && draftAction.request.reviewedPages.every(page => page.relation === 'distinct'))
  const savedMatches = saved !== undefined && proposal !== null
    && saved.request.proposalMessageId === proposal.messageId
    && saved.request.expectedProposalSha256 === proposal.sha256
    && saved.request.expectedRevision === (review?.revision ?? 0)
    && (!trackedExecution || executionIdentity !== null && saved.executionSignature === executionIdentity)
    && (!discoveryFormat || discoverySignature !== null && saved.discoverySignature === discoverySignature)
    && (saved.request.decision !== 'approve' || saved.request.expectedComparedPageReviewSha256 === relationDigest)
    && (saved.request.decision !== 'approve' || saved.request.expectedSourceDispositionReviewSha256 === sourceDigest)
    && (saved.request.decision === 'reject' && !trackedExecution || changeHashes !== null
      && saved.changeHashes.length === changeHashes.length
      && saved.changeHashes.every((hash, index) => hash === changeHashes[index]))
    && (saved.request.decision === 'approve' ? canApprove : canReject)

  const reload = async (): Promise<void> => {
    request.current?.abort()
    const next = new AbortController()
    request.current = next
    await props.inspectReview(sessionId, next.signal)
    if (request.current === next) request.current = null
  }
  useEffect(() => {
    void reload()
    return () => { request.current?.abort(); request.current = null }
  }, [sessionId])
  useEffect(() => {
    if (lookup !== null && !known) actions.markReviewSession(sessionId)
  }, [lookup, known, sessionId, actions])
  useEffect(() => {
    if (saved !== undefined && review?.operationId === saved.request.operationId
      && review.proposalMessageId === saved.request.proposalMessageId
      && review.proposalSha256 === saved.request.expectedProposalSha256
      && (saved.request.decision === 'approve' ? review.decision === 'approved' : review.decision === 'rejected')) {
      actions.forgetReview(sessionId)
    }
  }, [saved, review, sessionId, actions])
  useEffect(() => {
    if (draftAction === undefined) return
    if (draftAction.kind === 'save' && heldDraft?.operationId === draftAction.request.operationId
      && (heldDraft.phase === 'saved' || heldDraft.phase === 'published')
      || draftAction.kind === 'publish' && heldDraft?.publicationOperationId === draftAction.request.operationId
        && heldDraft.phase === 'published') actions.forgetZeroHitDraft(sessionId)
  }, [draftAction, heldDraft, sessionId, actions])

  if (!known && lookup === null) return null
  const status = (() => {
    if (observation?.phase === 'failed') return 'import.review.status.error' as const
    if (heldDraft?.phase === 'published') return 'import.review.status.zeroHitPublished' as const
    if (heldDraft?.reason === 'source-conflict-draft-required'
      && (heldDraft.phase === 'saved' || heldDraft.phase === 'edited')) {
      return 'import.review.status.sourceConflictHeld' as const
    }
    if (heldDraft?.phase === 'saved') return 'import.review.status.zeroHitSaved' as const
    if (heldDraft?.phase === 'edited') return 'import.review.status.zeroHitEdited' as const
    if (heldDraft?.phase === 'saving') return 'import.review.status.zeroHitSaving' as const
    if (heldDraft?.phase === 'conflict') return 'import.review.status.zeroHitConflict' as const
    if (proposal === null) return review?.decision === 'approved'
      ? 'import.review.status.approvalRecorded' as const : review?.decision === 'rejected'
        ? 'import.review.status.rejectionRecorded' as const : 'import.review.status.waiting' as const
    if (zeroHitProposal) return heldReason === 'source-conflict-draft-required'
      ? 'import.review.status.sourceConflictRequired' as const
      : heldReason === 'discovery-coverage-draft-required'
        ? 'import.review.status.discoveryCoverageRequired' as const : 'import.review.status.zeroHitRequired' as const
    if (trackedExecution) {
      if (!validExecution) return 'import.review.status.error' as const
      switch (execution.status) {
        case 'ready': return singleCreation ? 'import.review.status.singleReady' as const
          : 'import.review.status.ready' as const
        case 'partially-applied': return 'import.review.status.partiallyApplied' as const
        case 'complete': return singleCreation ? 'import.review.status.singleComplete' as const
          : 'import.review.status.complete' as const
        case 'blocked': return singleCreation ? 'import.review.status.singleBlocked' as const
          : 'import.review.status.blocked' as const
        case 'awaiting-approval': break
      }
    }
    if (exactDecision === 'approved') return 'import.review.status.approved' as const
    if (exactDecision === 'rejected') return 'import.review.status.rejected' as const
    return 'import.review.status.pending' as const
  })()
  const failureKey = (() => {
    const failure = observation?.failure
    if (failure === 'proposal-changed' || failure === 'review-revision-changed'
      || failure === 'review-operation-changed') return 'import.review.conflict' as const
    if (failure === 'compared-page-review-required') return 'import.review.userRelationRequired' as const
    if (failure === 'source-review-required') return 'import.review.sourceReviewRequired' as const
    if (failure === 'review-not-ready') return 'import.review.notReady' as const
    if (failure === 'draft-publication-changed' || failure === 'draft-operation-changed') {
      return 'import.review.zeroHitConflict' as const
    }
    if (failure === 'writer-busy') return 'import.review.writerBusy' as const
    return 'import.review.error' as const
  })()
  const writerLockPath = observation?.phase === 'failed' && observation.failure === 'writer-busy'
    ? observation.writerLockPath : undefined
  const prepare = (decision: 'reject'): void => {
    if (proposal === null || active || saved !== undefined || lookup === null
      || !canReject) return
    actions.rememberReview(sessionId, { operationId: props.newReviewId(), decision,
      proposalMessageId: proposal.messageId, expectedProposalSha256: proposal.sha256,
      expectedRevision: review?.revision ?? 0,
    }, changeHashes ?? [], executionIdentity ?? undefined,
    stopRemaining, discoverySignature ?? undefined)
  }
  const recoverZeroHitDraft = (): void => {
    if (heldDraft?.phase !== 'saving' || active || draftAction !== undefined || saved !== undefined) return
    actions.rememberZeroHitDraft(sessionId, { kind: 'save', request: {
      operationId: heldDraft.operationId, proposalMessageId: heldDraft.proposalMessageId,
      expectedProposalSha256: heldDraft.proposalSha256, changeIndex: heldDraft.changeIndex,
      expectedChangeSha256: heldDraft.changeSha256,
    } })
  }
  const recoverZeroHitPublication = (): void => {
    if (heldDraft?.pendingPublication?.reviewedPages === undefined || active
      || draftAction !== undefined || saved !== undefined) return
    actions.rememberZeroHitDraft(sessionId, { kind: 'publish', request: {
      operationId: heldDraft.pendingPublication.operationId, draftOperationId: heldDraft.operationId,
      expectedDraftVersion: heldDraft.pendingPublication.expectedDraftVersion,
      expectedActiveIndexDigest: heldDraft.pendingPublication.expectedActiveIndexDigest,
      reviewedPages: heldDraft.pendingPublication.reviewedPages,
    } })
  }
  const applyZeroHitAction = async (): Promise<void> => {
    if (draftAction === undefined || !draftActionRecoverable || !draftActionMatches || active) return
    actions.attemptZeroHitDraft(sessionId)
    const next = new AbortController()
    request.current = next
    const completed = draftAction.kind === 'save'
      ? await props.saveZeroHitDraft(sessionId, draftAction.request, next.signal)
      : await props.publishZeroHitDraft(sessionId, draftAction.request, next.signal)
    if (completed) actions.forgetZeroHitDraft(sessionId)
    if (request.current === next) request.current = null
  }
  const decide = async (): Promise<void> => {
    if (saved === undefined || !savedMatches || active
      || saved.request.decision === 'approve' && !saved.attempted) return
    actions.attemptReview(sessionId)
    const next = new AbortController()
    request.current = next
    const completed = await props.decideReview(sessionId, saved.request, next.signal)
    if (completed) actions.forgetReview(sessionId)
    if (request.current === next) request.current = null
  }
  const prepareFollowUp = (): void => {
    if (proposal === null || exactDecision !== 'approved' || draft.trim() !== '' || inputPhase !== 'plain'
      || trackedExecution && (!approvedTracked || execution.status === 'complete')
      || !trackedExecution && !canApprove) return
    props.inputActions.setDraft(t(trackedExecution && execution?.status === 'partially-applied'
      ? 'import.review.followupDraftRemaining' : singleCreation ? 'import.review.followupDraftSingle'
        : discoveryFormat && trackedExecution ? 'import.review.followupDraftOrderedV5'
          : trackedExecution ? 'import.review.followupDraftOrdered' : 'import.review.followupDraft',
    { id: proposal.messageId }))
    setOpen(false)
  }

  return <>
    <Button size="sm" variant={status === 'import.review.status.pending' || status === 'import.review.status.partiallyApplied'
      || status === 'import.review.status.blocked' ? 'primary' : 'outline'}
    className={css.trigger} onClick={() => { setOpen(true); void reload() }} aria-label={t(status)}>{t(status)}</Button>
    <Modal open={open} title={t('import.review.title')} closeLabel={t('import.review.close')}
      onClose={() => { if (observation?.phase !== 'deciding') setOpen(false) }} className={clsx(css.dialog)}
      contentClassName={clsx(css.content)}>
      <div className={css.body} aria-busy={active}>
        <p>{t('import.review.scope')}</p>
        <p>{t('import.review.legacyReadOnly')}</p>
        {lookup !== null && <p className={css.metadata}>{t('import.review.project', { id: lookup.workspaceId })}</p>}
        {lookup !== null && lookup.state.documents.some(document => document.status === 'stored'
          && (document.format === 'pdf' || document.format === 'docx')) && <section className={css.evidence}
          aria-label={t('import.sourcePreview.title')}>
          <h3>{t('import.sourcePreview.title')}</h3>
          <p>{t('import.sourcePreview.scope')}</p>
          <div className={css.sourceRows}>{lookup.state.documents.filter(document => document.status === 'stored'
            && (document.format === 'pdf' || document.format === 'docx')).map(document =>
            <div key={document.id} className={css.sourceRow}>
              <Button size="sm" variant="outline" onClick={() => {
                props.openSource(sessionId, document.id)
                setOpen(false)
              }}>{t('import.sourcePreview.open', { name: document.name })}</Button>
              {document.format === 'pdf' && <PdfExtractionNotice name={document.name} prepared
                extraction={document.extraction?.kind === 'pdf-text' ? document.extraction : undefined}
                visual={document.visual} t={t} />}
              {document.format === 'docx' && <DocxExtractionNotice name={document.name} prepared
                extraction={document.extraction?.kind === 'docx-text' ? document.extraction : undefined}
                visual={document.docxVisual} t={t} />}
            </div>)}</div>
        </section>}
        {observation?.phase === 'loading' && <p role="status">{t('import.review.loading')}</p>}
        {observation?.phase === 'deciding' && <p role="status">{t('import.review.deciding')}</p>}
        {observation?.phase === 'failed' && <p role="alert">{t(failureKey)}</p>}
        {writerLockPath !== undefined && <p className={css.metadata}>{t('import.review.writerLockPath', {
          path: writerLockPath,
        })}</p>}
        <Button size="sm" variant="outline" disabled={active} onClick={() => { void reload() }}>{t('import.review.reload')}</Button>
        {lookup !== null && proposal === null && (review === undefined
          ? <p role="status">{t('import.review.noProposal')}</p>
          : <section aria-label={t('import.review.recordedDecision')}>
            <h3>{t('import.review.recordedDecision')}</h3>
            <p role="status">{t(review.decision === 'approved'
              ? 'import.review.status.approvalRecorded' : 'import.review.status.rejectionRecorded')}</p>
            <p>{t(review.decision === 'approved' ? 'import.review.verifyExecution' : 'import.review.rejected')}</p>
            <p className={css.metadata}>{t('import.review.decisionIdentity', {
              revision: review.revision, operation: review.operationId,
              id: review.proposalMessageId, sha256: review.proposalSha256,
            })}</p>
          </section>)}
        {zeroHitProposal && heldDraft === undefined && <section className={css.evidence}
          aria-label={t(heldReason === 'source-conflict-draft-required'
            ? 'import.review.sourceConflictTitle' : heldReason === 'discovery-coverage-draft-required'
              ? 'import.review.discoveryCoverageTitle' : 'import.review.zeroHitTitle')}>
          <h3>{t(heldReason === 'source-conflict-draft-required'
            ? 'import.review.sourceConflictTitle' : heldReason === 'discovery-coverage-draft-required'
              ? 'import.review.discoveryCoverageTitle' : 'import.review.zeroHitTitle')}</h3>
          <p>{t(heldReason === 'source-conflict-draft-required'
            ? 'import.review.sourceConflictPolicy' : heldReason === 'discovery-coverage-draft-required'
              ? 'import.review.discoveryCoveragePolicy' : 'import.review.zeroHitPolicy')}</p>
          <section className={css.evidence} aria-label={t('import.review.zeroHitTitleSearchTitle')}>
            <h4>{t('import.review.zeroHitTitleSearchTitle')}</h4>
            {!titleSearchReady || titleSearch === undefined
              ? <p role="alert">{t('import.review.zeroHitTitleSearchUnavailable')}</p> : <>
                <p className={css.metadata}>{t('import.review.zeroHitTitleSearchQuery', {
                  query: titleSearch.query,
                })}</p>
                {titleSearch.hits.length === 0
                  ? <p>{t('import.review.zeroHitTitleSearchNoHits')}</p>
                  : <ul className={css.comparedPages}>{titleSearch.hits.map(hit =>
                    <li key={hit.path}>{t('import.review.discovery.hit', {
                      title: hit.title, id: titleSearch.targetProjectId,
                      path: hit.path, version: hit.version,
                    })}</li>)}</ul>}
              </>}
          </section>
          <p>{t('import.review.zeroHitMixedScope')}</p>
          <p>{t('import.review.zeroHitLegacyOnly')}</p>
        </section>}
        {heldDraft !== undefined && <section className={css.evidence} aria-label={t('import.review.zeroHitDraftTitle')}>
          <h3>{t('import.review.zeroHitDraftTitle')}</h3>
          <p className={css.metadata}>{t('import.review.zeroHitDraftPath', {
            id: heldDraft.targetProjectId, path: heldDraft.path,
          })}</p>
          <p className={css.metadata}>{t('import.review.zeroHitSource', { id: heldDraft.sourceDocumentId })}</p>
          <pre className={css.quote}>{heldDraft.sourceQuote}</pre>
          {heldDraft.reason === 'source-conflict-draft-required' && <p role="alert">
            {t('import.review.sourceConflictHeld')}</p>}
          <p role={heldDraft.phase === 'conflict' ? 'alert' : 'status'}>{t(heldDraft.phase === 'conflict'
            && heldDraft.publicationReview?.status === 'unknown'
            && heldDraft.publicationReview.reason === 'receipt-unconfirmed'
            ? 'import.review.zeroHitReceiptUnconfirmed' : `import.review.zeroHitPhase.${heldDraft.phase}`)}</p>
          {heldDraft.phase === 'published' && heldDraft.publicationReview?.status === 'required'
            && <p role="alert">{t('import.review.zeroHitPublishedReviewRequired')}</p>}
          {heldDraft.phase === 'published' && heldDraft.publicationReview?.status === 'unknown'
            && <p role="alert">{t('import.review.zeroHitPublishedReviewUnknown')}</p>}
          {heldDraft.publishedVersion !== undefined && <p className={css.metadata}>{t('import.review.zeroHitPublishedVersion', {
            version: heldDraft.publishedVersion,
          })}</p>}
          {heldDraft.phase === 'saving' && <Button variant="outline"
            disabled={active || draftAction !== undefined || saved !== undefined}
            onClick={recoverZeroHitDraft}>{t('import.review.zeroHitRecoverSave')}</Button>}
          {heldDraft.pendingPublication?.reviewedPages !== undefined && <Button variant="outline"
            disabled={active || draftAction !== undefined || saved !== undefined}
            onClick={recoverZeroHitPublication}>{t('import.review.zeroHitRecoverPublish')}</Button>}
          {heldDraft.pendingPublication !== undefined && heldDraft.pendingPublication.reviewedPages === undefined
            && <p role="alert">{t('import.review.zeroHitOldPublication')}</p>}
          {heldDraft.reason === 'source-conflict-draft-required' && heldDraftCurrent !== undefined && <>
            <p className={css.metadata}>{t('import.review.zeroHitDraftVersion', {
              version: heldDraftCurrent.version,
            })}</p>
            <pre className={css.quote}>{heldDraftCurrent.body}</pre>
          </>}
          {(heldDraft.phase === 'saved' || heldDraft.phase === 'edited') && heldDraftCurrent !== undefined
            && heldDraft.reason !== 'source-conflict-draft-required' && <>
            <p className={css.metadata}>{t('import.review.zeroHitDraftVersion', {
              version: heldDraftCurrent.version,
            })}</p>
            <p>{t('import.review.zeroHitActiveCatalog', {
              count: heldDraftCurrent.activePageCount,
            })}</p>
            {!canPublishZeroHit ? <p role="alert">{t('import.review.zeroHitCatalogIncomplete')}</p>
              : <section className={css.evidence} aria-label={t('import.review.zeroHitCatalogTitle')}>
                <h4>{t('import.review.zeroHitCatalogTitle')}</h4>
                {heldDraftCurrent.activePages.length === 0
                  ? <p>{t('import.review.zeroHitNoActivePages')}</p>
                  : <ul className={css.comparedPages}>{heldDraftCurrent.activePages.map(page => <li key={page.path}>
                    <p className={css.metadata}>{t('import.review.zeroHitCatalogPage', {
                      title: page.title, path: page.path, version: page.version,
                    })}</p>
                    <ComparedPageBody key={JSON.stringify([catalogKey, heldDraft.targetProjectId, page.path, page.version])}
                      path={page.path} version={page.version}
                      read={signal => props.readHeldDraftCatalogPage(sessionId, {
                        draftOperationId: heldDraft.operationId, expectedDraftVersion: heldDraftCurrent.version,
                        expectedActiveIndexDigest: heldDraftCurrent.activeIndexDigest,
                        path: page.path, title: page.title, version: page.version,
                      }, signal)}
                      t={t} context="held-draft-catalog" />
                  </li>)}</ul>}
              </section>}
            <p>{t('import.review.zeroHitLegacyOnly')}</p>
            {heldDraft.phase === 'edited' && <p role="alert">{t('import.review.zeroHitEditedWarning')}</p>}
            <pre className={css.quote}>{heldDraftCurrent.body}</pre>
          </>}
        </section>}
        {draftAction !== undefined && <section className={css.confirmation} role="group"
          aria-label={t('import.review.zeroHitConfirmTitle')}>
          <h3>{t('import.review.zeroHitConfirmTitle')}</h3>
          <p>{t(draftAction.kind === 'save' ? 'import.review.zeroHitConfirmSave'
            : 'import.review.zeroHitConfirmPublish')}</p>
          {!draftActionMatches && <p role="alert">{t('import.review.zeroHitConflict')}</p>}
          {!draftActionRecoverable && <p role="status">{t('import.review.legacyUnattempted')}</p>}
          {draftAction.attempted && <p>{t('import.review.uncertain')}</p>}
          {!draftAction.attempted && <Button variant="outline" disabled={active}
            onClick={() => { actions.forgetZeroHitDraft(sessionId) }}>{t('import.review.cancel')}</Button>}
          {draftActionRecoverable && <Button variant="primary" disabled={active || !draftActionMatches || observation?.phase !== 'ready'}
            onClick={() => { void applyZeroHitAction() }}>{t('import.review.retry')}</Button>}
          {!draftActionMatches && <Button variant="outline" disabled={active}
            onClick={() => { actions.forgetZeroHitDraft(sessionId) }}>{t('import.review.discardStale')}</Button>}
        </section>}
        {proposal !== null && <>
          <section aria-label={t('import.review.proposal')}>
            <h3>{t('import.review.proposal')}</h3>
            <p className={css.metadata}>{t('import.review.messageId', { id: proposal.messageId })}</p>
            <p className={css.metadata}>{t(proposal.format === 'brain-review-json-v1'
              ? 'import.review.legacyFormat' : discoveryFormat ? 'import.review.evidenceFormatV5'
                : v4 ? 'import.review.evidenceFormatV4' : proposal.format === 'brain-review-json-v3'
                  ? 'import.review.evidenceFormatV3' : 'import.review.evidenceFormat')}</p>
            {proposal.format !== 'brain-review-json-v1' && <p className={css.metadata}>{t('import.review.semanticWarning')}</p>}
            <p role={proposal.verification.status === 'invalid' ? 'alert' : 'status'}>{t(proposal.verification.status === 'verified'
              ? discoveryFormat ? 'import.review.evidenceVerifiedV5'
                : proposal.format !== 'brain-review-json-v1' ? 'import.review.evidenceVerified' : 'import.review.legacyVerified'
              : trackedExecution ? 'import.review.evidenceInvalidV4' : 'import.review.evidenceInvalid')}</p>
            {proposal.verification.status === 'invalid' && proposal.verification.reason !== undefined
              && <p role="alert">{t(`import.review.failure.${proposal.verification.reason}`)}</p>}
            {(proposal.verification.reason === 'self-declared-overlap-unresolved'
              || proposal.verification.reason === 'self-declared-update-overlap-unresolved'
              || proposal.verification.reason === 'self-declared-root-overlap-unresolved'
              || proposal.verification.reason === 'self-declared-status-overlap-unresolved')
              && !(trackedExecution && validExecution && execution.status === 'blocked') && <>
              <p>{t('import.review.legacyReadOnly')}</p>
            </>}
            {proposal.approvalNeedsRenewal && <p role="alert">{t('import.review.approvalNeedsRenewal')}</p>}
            <pre className={css.proposal}>{proposal.text}</pre>
          </section>
          {trackedExecution && <section aria-label={t(singleCreation
            ? 'import.review.execution.singleTitle' : 'import.review.execution.title')}>
            <h3>{t(singleCreation ? 'import.review.execution.singleTitle' : 'import.review.execution.title')}</h3>
            <p>{t(singleCreation ? 'import.review.execution.singleScope' : 'import.review.execution.scope')}</p>
            {validExecution ? <>
              <p role={execution.status === 'blocked' ? 'alert' : 'status'}>{t(singleCreation
                ? `import.review.execution.singleStatus.${execution.status}`
                : `import.review.execution.status.${execution.status}`)}</p>
              {execution.status === 'blocked' && execution.reason !== undefined
                && <p role="alert">{t(`import.review.execution.reason.${execution.reason}`)}</p>}
              <p className={css.metadata}>{t('import.review.execution.progress', {
                applied: execution.appliedSteps.length, total: changes.length,
              })}</p>
              {execution.status === 'blocked' && execution.reason !== 'zero-hit-draft-required' && <>
                <p>{t('import.review.legacyReadOnly')}</p>
              </>}
            </> : <p role="alert">{t(discoveryFormat ? 'import.review.execution.unavailableV5'
              : 'import.review.execution.unavailable')}</p>}
          </section>}
          {validChanges && lookup !== null ? <section aria-label={t(singleCreation
            ? 'import.review.execution.singleChanges' : trackedExecution
              ? 'import.review.execution.changes' : 'import.review.changes')}>
            <h3>{t(singleCreation ? 'import.review.execution.singleChanges' : trackedExecution
              ? 'import.review.execution.changes' : 'import.review.changes')}</h3>
            <ol className={css.changes}>
              {changes.map((change, index) => {
                const receipt = validExecution ? execution.appliedSteps[index] : undefined
                const discovery = discoveryFormat && change.tool === 'brain_create_page' && change.arguments.status === 'active'
                  ? safeList(proposal.discovery).find(entry => entry.changeIndex === index) : undefined
                const discoveryHits: readonly KnowledgeImportDiscovery['hits'][number][] | null = discovery !== undefined
                  && Array.isArray(discovery.hits) ? discovery.hits : null
                return <li key={index} className={css.change}>
                  <h4>{t('import.review.change', { number: index + 1, tool: change.tool })}</h4>
                  {trackedExecution && validExecution && <>
                    <p>{t(index < execution.appliedSteps.length ? 'import.review.execution.stepApplied'
                      : execution.status === 'blocked' ? 'import.review.execution.stepBlocked'
                        : execution.status === 'awaiting-approval' ? 'import.review.execution.stepAwaitingApproval'
                          : index === execution.nextChangeIndex ? 'import.review.execution.stepNext'
                            : 'import.review.execution.stepWaiting')}</p>
                    {receipt !== undefined && <p className={css.metadata}>{t('import.review.execution.receipt', {
                      operation: receipt.operationId,
                      version: receipt.postVersion,
                      digest: receipt.postActiveIndexDigest,
                    })}</p>}
                  </>}
                  <p className={css.metadata}>{t('import.review.targetProject', {
                    id: typeof change.arguments.target_project_id === 'string' ? change.arguments.target_project_id : '',
                  })}</p>
                  <p className={css.metadata}>{t('import.review.targetPaths', {
                    paths: typeof change.arguments.path === 'string' ? change.arguments.path
                      : Array.isArray(change.arguments.paths) ? JSON.stringify(change.arguments.paths)
                        : t('import.review.projectIndex'),
                  })}</p>
                  <p className={css.metadata}>{t('import.review.expectedVersion', {
                    version: change.arguments.expected_version === null || change.tool === 'brain_create_page'
                      ? t('import.review.absentVersion') : typeof change.arguments.expected_version === 'string'
                        ? change.arguments.expected_version : t('import.review.unversioned'),
                  })}</p>
                  {proposal.format !== 'brain-review-json-v1' && <div className={css.evidence}>
                    <p>{t('import.review.sourceEvidence')}</p>
                    {safeList(change.evidence?.sources).length > 0
                      ? safeList(change.evidence?.sources).map((source, sourceIndex) => <div key={sourceIndex}>
                        <p className={css.metadata}>{t('import.review.sourceIdentity', {
                          id: source.document_id,
                          name: lookup.state.documents.find(document => document.id === source.document_id)?.name
                          ?? t('import.review.unknownSource'),
                        })}</p>
                        <pre className={css.quote}>{source.quote}</pre>
                      </div>) : <p role="alert">{t('import.review.noSourceEvidence')}</p>}
                    {proposal.format === 'brain-review-json-v6' && <section aria-label={t('import.review.sourceDispositions')}>
                      <h5>{t('import.review.sourceDispositions')}</h5>
                      <p>{t('import.review.sourceDispositionsScope')}</p>
                      {safeList(change.evidence?.source_dispositions).map((item, sourceIndex) => {
                        const choice = proposal.sourceDispositionReview?.choices.find(entry => entry.changeIndex === index
                          && entry.sourceIndex === sourceIndex && entry.changeSha256 === change.sha256
                          && entry.documentId === item.document_id)
                        return <div key={`${item.document_id}:${sourceIndex}`}>
                          <p className={css.metadata}>{t('import.review.sourceDisposition', {
                            name: lookup.state.documents.find(document => document.id === item.document_id)?.name
                              ?? t('import.review.unknownSource'),
                            disposition: t(`import.review.sourceDisposition.${item.disposition}`),
                          })}</p>
                          <pre className={css.quote}>{item.quote}</pre>
                          <p>{item.rationale}</p>
                          {choice !== undefined && <p>{t(`import.review.sourceJudgment.${choice.judgment}`)}</p>}
                        </div>
                      })}
                    </section>}
                    <p>{t('import.review.relatedEvidence')}</p>
                    {safeList(change.evidence?.compared_pages).length > 0
                      ? <ul className={css.comparedPages}>
                        {safeList(change.evidence?.compared_pages).map((page, pageIndex) => {
                          const choice = discoveryFormat && change.tool === 'brain_create_page'
                            && change.arguments.status === 'active'
                            ? proposal.comparedPageReview?.choices.find(item => item.changeIndex === index
                              && item.pageIndex === pageIndex && item.changeSha256 === change.sha256
                              && item.targetProjectId === page.target_project_id && item.path === page.path
                              && item.version === page.version) : undefined
                          return <li key={pageIndex}>
                            <p className={css.metadata}>{t('import.review.comparedPage', {
                              id: page.target_project_id, path: page.path, version: page.version,
                            })}</p>
                            <p>{t('import.review.modelRelation', { relation: t(relationKey(page.relation)) })}</p>
                            {'quote' in page && typeof page.quote === 'string' && page.quote.trim() !== '' && <>
                              <p className={css.metadata}>{t('import.review.comparedQuote')}</p>
                              <pre className={css.quote}>{page.quote}</pre>
                            </>}
                            {(proposal.verification.status === 'verified'
                            || proposal.verification.reason === 'self-declared-update-overlap-unresolved'
                            || proposal.verification.reason === 'self-declared-root-overlap-unresolved'
                            || proposal.verification.reason === 'self-declared-status-overlap-unresolved')
                            && <ComparedPageBody key={JSON.stringify([proposal.messageId, proposal.sha256, page.target_project_id,
                              page.path, page.version])} path={page.path}
                            version={page.version} read={signal => choice === undefined
                              || proposal.comparedPageReview === undefined || saved !== undefined || trackedAlreadyApproved
                              ? props.readComparedPage(page.target_project_id, page.path, signal)
                              : props.readReviewComparedPage(sessionId, {
                                proposalMessageId: proposal.messageId, expectedProposalSha256: proposal.sha256,
                                expectedReviewSha256: proposal.comparedPageReview.sha256,
                                changeIndex: choice.changeIndex, pageIndex: choice.pageIndex,
                                changeSha256: choice.changeSha256, targetProjectId: choice.targetProjectId,
                                path: choice.path, version: choice.version, pageSha256: choice.pageSha256,
                              }, signal)} t={t} context="proposal"
                            />}
                            {choice !== undefined && <p>{t(`import.review.userRelation.${choice.relation}`)}</p>}
                          </li>
                        })}
                      </ul> : <p className={css.metadata}>{t('import.review.noComparedPages')}</p>}
                    {discoveryFormat && change.tool === 'brain_create_page' && change.arguments.status === 'active'
                      && proposal.verification.status === 'verified' && !relationsReady
                      && <p role="alert">{t('import.review.userRelationRequired')}</p>}
                    {proposal.format === 'brain-review-json-v6' && proposal.verification.status === 'verified'
                      && !sourcesReady && <p role={sourcesDisputed ? 'alert' : 'status'}>
                      {t('import.review.sourceReviewRequired')}</p>}
                    {discoveryFormat && change.tool === 'brain_create_page' && change.arguments.status === 'active'
                    && <section className={css.evidence} aria-label={t('import.review.discovery.title')}>
                      <h4>{t('import.review.discovery.title')}</h4>
                      <p>{t(discovery?.mode === 'empty-index'
                        ? 'import.review.discovery.emptyLimit' : 'import.review.discovery.limit')}</p>
                      {discovery === undefined ? <p role="alert">{t('import.review.discovery.unavailable')}</p> : <>
                        <p className={css.metadata}>{t('import.review.discovery.project', { id: discovery.targetProjectId })}</p>
                        {discovery.mode === 'search' ? <>
                          <p className={css.metadata}>{t('import.review.discovery.query', {
                            query: typeof discovery.query === 'string' && discovery.query.trim() !== ''
                              ? discovery.query : t('import.review.discovery.missingQuery'),
                          })}</p>
                          {discoveryHits === null ? <p role="alert">{t('import.review.discovery.unavailable')}</p>
                            : discoveryHits.length > 0
                              ? <ul className={css.comparedPages} aria-label={t('import.review.discovery.hits')}>
                                {discoveryHits.map((hit, hitIndex) => <li key={hitIndex}>{t('import.review.discovery.hit', {
                                  title: hit.title, id: discovery.targetProjectId, path: hit.path, version: hit.version,
                                })}</li>)}
                              </ul> : <p>{t('import.review.discovery.noHits')}</p>}
                          {!discovery.exists && <p>{t('import.review.discovery.indexAbsent')}</p>}
                        </> : validDiscovery ? <p>{t(discovery.exists
                          ? 'import.review.discovery.emptyExisting' : 'import.review.discovery.emptyAbsent')}</p>
                          : <p role="alert">{t('import.review.discovery.unavailable')}</p>}
                      </>}
                    </section>}
                    <p className={css.metadata}>{t(proposal.verification.status === 'verified'
                      ? 'import.review.changeEvidenceVerified' : 'import.review.changeEvidenceUnverified')}</p>
                  </div>}
                  <p className={css.metadata}>{t('import.review.arguments')}</p>
                  <pre className={css.proposal}>{JSON.stringify(change.arguments, null, 2)}</pre>
                </li>
              })}
            </ol>
          </section> : <p role="alert">{t(v4 ? 'import.review.execution.noChanges' : 'import.review.noChanges')}</p>}
          {discoveryFormat && !validDiscovery && <p role="alert">{t('import.review.discovery.unavailable')}</p>}
          {validChanges && !evidenceAndOrderReady && !zeroHitProposal && relationsReady
            && (!trackedExecution || validExecution && execution.status === 'awaiting-approval')
            && <p role="alert">{t('import.review.evidenceBlocksApproval')}</p>}
          {review !== undefined && review.proposalMessageId !== proposal.messageId
            && <p role="alert">{t(review.decision === 'approved'
              ? 'import.review.newProposalGranted' : 'import.review.newProposal')}</p>}
          {exactDecision === 'approved' && (!trackedExecution || validExecution && execution.status !== 'complete') && <>
            {!trackedExecution && <p role="status">{t('import.review.approved')}</p>}
            {review?.confirmationBoundaryReady === false ? <p role="alert">{t('import.review.confirmationBoundaryMissing')}</p> : <>
              <p>{t(trackedExecution && execution?.status === 'partially-applied'
                ? 'import.review.execution.followupRemaining' : singleCreation
                  ? 'import.review.execution.followupSingle' : trackedExecution
                    ? 'import.review.execution.followupOrdered' : 'import.review.followup')}</p>
              <Button variant="primary" disabled={draft.trim() !== '' || inputPhase !== 'plain'} onClick={prepareFollowUp}>
                {t(trackedExecution && execution?.status === 'partially-applied'
                  ? 'import.review.execution.prepareRemaining' : 'import.review.prepareFollowup')}
              </Button>
              {draft.trim() !== '' && <p>{t('import.review.existingDraft')}</p>}
            </>}
          </>}
          {exactDecision === 'rejected' && <p role="status">{t('import.review.rejected')}</p>}
          {saved !== undefined && <section className={css.confirmation} role="group" aria-label={t('import.review.confirmTitle')}>
            <h3>{t('import.review.confirmTitle')}</h3>
            <p>{t(saved.request.decision === 'approve' ? singleCreation ? 'import.review.execution.confirmSingle'
              : trackedExecution ? 'import.review.execution.confirmApprove' : 'import.review.confirmApprove'
              : saved.stopRemaining === true
                ? singleCreation ? 'import.review.execution.confirmStopSingle'
                  : 'import.review.execution.confirmStop' : 'import.review.confirmReject')}</p>
            {!savedMatches && <p role="alert">{t('import.review.staleIntent')}</p>}
            {saved.attempted && <p>{t('import.review.uncertain')}</p>}
            {saved.request.decision === 'approve' && !saved.attempted
              && <p role="status">{t('import.review.legacyUnattempted')}</p>}
            {!saved.attempted && <Button variant="outline" disabled={active} onClick={() => { actions.forgetReview(sessionId) }}>
              {t(saved.stopRemaining === true
                ? singleCreation ? 'import.review.execution.cancelStopSingle'
                  : 'import.review.execution.cancelStop' : 'import.review.cancel')}
            </Button>}
            {(saved.request.decision === 'reject' || saved.attempted) && <Button variant="primary" disabled={active || !savedMatches || observation?.phase !== 'ready'
              || saved.request.decision === 'approve' && !canApprove} onClick={() => { void decide() }}>
              {t(saved.attempted ? 'import.review.retry' : saved.stopRemaining === true
                ? singleCreation ? 'import.review.execution.confirmStopSingleButton'
                  : 'import.review.execution.confirmStopButton' : 'import.review.confirm')}
            </Button>}
            {!savedMatches && <Button variant="outline" disabled={active || observation?.phase !== 'ready'} onClick={() => { actions.forgetReview(sessionId) }}>
              {t('import.review.discardStale')}
            </Button>}
          </section>}
          {saved === undefined && observation?.phase === 'ready' && <div className={css.actions}>
            {stopRemaining && <Button variant="outline" onClick={() => { prepare('reject') }}>
              {t(singleCreation ? 'import.review.execution.stopSingle' : 'import.review.execution.stopRemaining')}
            </Button>}
            {(!trackedExecution || validExecution && execution.status === 'awaiting-approval') && exactDecision !== 'rejected'
              && <Button variant="outline" onClick={() => { prepare('reject') }}>
                {t(exactDecision === 'approved' ? 'import.review.revoke' : 'import.review.reject')}
              </Button>}
          </div>}
        </>}
      </div>
    </Modal>
  </>
}
