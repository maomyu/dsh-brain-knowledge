/** Own one explicit submission per project and repair uncertain delivery through the Host receipt. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-import-controller/remote'
import type { IDocumentImportDrafts, PreparedDocumentImport } from '@deepseek-ai/dsh-api-document-import-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { KnowledgeImportComparedPageDecision, KnowledgeImportComparedPageRead,
  KnowledgeImportSourceDispositionDecision,
  KnowledgeImportComparedPageReadRequest, KnowledgeImportDocument,
  KnowledgeImportId, KnowledgeImportReviewDecision,
  KnowledgeImportReviewLookup, KnowledgeImportReviewSource, KnowledgeImportState,
  KnowledgeImportSaveDraftRequest, KnowledgeImportPublishDraftRequest } from '../types.ts'
import type { KnowledgeImportHeldCatalogPageReadRequest } from '../types.ts'
import type {
  IKnowledgeImports, KnowledgeImportIntent, KnowledgeImportReviewObservation, KnowledgeImportReviewSnapshot,
  KnowledgeImportSubmission, KnowledgeImportSubmissionFailure, KnowledgeImportSubmissionSnapshot,
} from './contract.ts'

/** Generated namespace consumed by this Client model. */
export type KnowledgeImportRemote = ClientRemote['knowledgeImports']

interface Project {
  value: KnowledgeImportSubmission
  operation?: { request: AbortController; done: Promise<KnowledgeImportState | null> }
}

class SubmissionFailure extends Error {
  readonly reason: KnowledgeImportSubmissionFailure
  constructor(reason: KnowledgeImportSubmissionFailure, readonly writerLockPath?: string) {
    super(reason)
    this.reason = reason
  }
}

function accepted<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  if (result.error.code === 'knowledge-import/rejected') {
    throw new SubmissionFailure(result.error.details.reason, result.error.details.writerLockPath)
  }
  throw new SubmissionFailure('remote-failed')
}

const reviewTools = new Set(['brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page',
  'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_normalize_page_format',
  'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex'])

function hasReviewChanges(proposal: KnowledgeImportReviewLookup['proposal']): boolean {
  const changes = proposal?.changes
  return changes !== undefined && changes !== null && changes.length > 0 && changes.every((change) => {
    const fields = change.arguments
    if (!reviewTools.has(change.tool) || !/^[a-f0-9]{64}$/u.test(change.sha256)
      || typeof fields.target_project_id !== 'string' || fields.target_project_id.trim() === '') return false
    if (change.tool === 'brain_reindex') return fields.path === undefined && fields.paths === undefined
      && fields.expected_version === undefined
    if (change.tool === 'brain_normalize_page_format') return fields.path === undefined
      && fields.expected_version === undefined && Array.isArray(fields.paths) && fields.paths.length > 0
      && fields.paths.every(path => typeof path === 'string' && path.trim() !== '')
    if (typeof fields.path !== 'string' || fields.path.trim() === '') return false
    const versionReady = change.tool === 'brain_create_page' ? fields.expected_version === undefined
      : change.tool === 'brain_write_root' ? fields.expected_version === null
        || typeof fields.expected_version === 'string' && fields.expected_version.trim() !== ''
        : typeof fields.expected_version === 'string' && fields.expected_version.trim() !== ''
    return versionReady
  })
}

async function describe(document: PreparedDocumentImport): Promise<KnowledgeImportDocument> {
  const binary = atob(document.source.dataBase64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    id: document.id, name: document.source.name, format: document.source.format, bytes: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
  }
}

/** Submission state is transient; the Host and the caller's saved intent survive Client replacement. */
export class ClientKnowledgeImports implements IKnowledgeImports {
  readonly state = createSnapshotStore<KnowledgeImportSubmissionSnapshot>({ projects: [] })
  readonly reviews = createSnapshotStore<KnowledgeImportReviewSnapshot>({ sessions: [] })
  private readonly projects = new Map<WorkspaceId, Project>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly reviewEntries = new Map<SessionId, KnowledgeImportReviewObservation>()
  private readonly reviewReads = new Set<Promise<void>>()
  private readonly reviewDecisionPending = new Set<Promise<boolean>>()
  private readonly sourceReads = new Set<{ request: AbortController; done: Promise<unknown> }>()
  private readonly reviewSequence = new Map<SessionId, number>()
  private readonly reviewDecisions = new Set<SessionId>()
  private reviewGeneration = 0
  private disposed = false
  private inspectionGeneration = 0

  /**
   * @param remote - generated Host namespace, including read-only receipt inspection.
   * @param drafts - owner of prepared original bytes, captured synchronously at submission.
   */
  constructor(private readonly remote: KnowledgeImportRemote, private readonly drafts: Pick<IDocumentImportDrafts, 'prepared'>) {}

  listPending(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly KnowledgeImportState[]> {
    const check = this.inspectionCheck(signal)
    const done = Promise.resolve().then(async () => {
      check()
      const pending = accepted(await this.remote.listPending(workspaceId))
      check()
      return pending
    }).finally(() => { this.pending.delete(done) })
    this.pending.add(done)
    return done
  }

  abandon(workspaceId: WorkspaceId, importId: KnowledgeImportId, signal: AbortSignal): Promise<KnowledgeImportState> {
    const check = this.inspectionCheck(signal, workspaceId)
    const done = Promise.resolve().then(async () => {
      check()
      const state = accepted(await this.remote.abandon(workspaceId, importId, signal))
      check()
      if (state.id !== importId || state.status !== 'abandoned') throw new SubmissionFailure('remote-failed')
      const project = this.projects.get(workspaceId)
      if (project !== undefined && project.value.intent.id === importId) this.update(project, { receipt: state, failure: null })
      return state
    }).finally(() => { this.pending.delete(done) })
    this.pending.add(done)
    return done
  }

  inspect(workspaceId: WorkspaceId, intent: KnowledgeImportIntent, signal: AbortSignal): Promise<KnowledgeImportState | null> {
    const check = this.inspectionCheck(signal)
    const done = Promise.resolve().then(async () => {
      check()
      const receipt = accepted(await this.remote.inspect(workspaceId, intent.id))
      check()
      if (receipt !== null && (receipt.id !== intent.id || receipt.locale !== intent.locale
        || receipt.scope?.spaceId !== intent.scope?.spaceId || receipt.maintenance !== intent.maintenance)) throw new SubmissionFailure('selection-changed')
      return receipt
    }).finally(() => { this.pending.delete(done) })
    this.pending.add(done)
    return done
  }

  private inspectionCheck(signal: AbortSignal, idleProject?: WorkspaceId): () => void {
    const generation = this.inspectionGeneration
    return () => {
      signal.throwIfAborted()
      if (this.disposed || generation !== this.inspectionGeneration) throw new SubmissionFailure('cancelled')
      if (idleProject !== undefined && this.projects.get(idleProject)?.operation !== undefined) throw new SubmissionFailure('busy')
    }
  }

  async inspectReview(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    if (this.disposed) return
    const generation = this.reviewGeneration
    const sequence = (this.reviewSequence.get(sessionId) ?? 0) + 1
    this.reviewSequence.set(sessionId, sequence)
    const previous = this.reviewEntries.get(sessionId)?.lookup ?? null
    this.setReview({ sessionId, phase: 'loading', lookup: previous, failure: null })
    const current = (): boolean => !this.disposed && !signal.aborted && generation === this.reviewGeneration
      && this.reviewSequence.get(sessionId) === sequence
    const read = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted()
        const lookup = accepted(await this.remote.inspectReview(sessionId, signal))
        if (current()) this.setReview({ sessionId, phase: 'ready', lookup, failure: null })
      } catch (error) {
        if (current()) this.setReview({ sessionId, phase: 'failed', lookup: previous, ...this.reviewFailure(error) })
      }
    }).finally(() => { this.reviewReads.delete(read) })
    this.reviewReads.add(read)
    await read
  }

  readReviewSource(sessionId: SessionId, documentId: DocumentImportSourceId,
    signal: AbortSignal): Promise<KnowledgeImportReviewSource> {
    return this.readSource(signal, lifetime => this.remote.readReviewSource(sessionId, documentId, lifetime),
      result => result.id === documentId && result.bytes >= 0 && result.bytes <= 25 * 1024 * 1024
        && result.dataBase64.length <= Math.ceil(result.bytes / 3) * 4)
  }

  readComparedPage(sessionId: SessionId, request: KnowledgeImportComparedPageReadRequest,
    signal: AbortSignal): Promise<KnowledgeImportComparedPageRead> {
    return this.readSource(signal, (lifetime) => {
      const lookup = this.reviewEntries.get(sessionId)?.lookup
      if (lookup?.proposal?.messageId !== request.proposalMessageId
        || lookup.proposal.sha256 !== request.expectedProposalSha256) throw new SubmissionFailure('proposal-changed')
      return this.remote.readComparedPage(lookup.workspaceId, lookup.importId, request, lifetime)
    }, result => result.path === request.path && result.version === request.version)
  }

  readHeldDraftCatalogPage(sessionId: SessionId, request: KnowledgeImportHeldCatalogPageReadRequest,
    signal: AbortSignal): Promise<KnowledgeImportComparedPageRead> {
    return this.readSource(signal, (lifetime) => {
      const lookup = this.reviewEntries.get(sessionId)?.lookup
      if (lookup?.zeroHitDraft?.operationId !== request.draftOperationId) throw new SubmissionFailure('proposal-changed')
      return this.remote.readHeldDraftCatalogPage(lookup.workspaceId, lookup.importId, request, lifetime)
    }, result => result.path === request.path && result.version === request.version)
  }

  private readSource<T>(signal: AbortSignal, read: (lifetime: AbortSignal) => Promise<RemoteResult<T>>,
    matches: (value: T) => boolean): Promise<T> {
    const request = new AbortController()
    const lifetime = AbortSignal.any([signal, request.signal])
    const done = Promise.resolve().then(async () => {
      lifetime.throwIfAborted()
      if (this.disposed) throw new SubmissionFailure('cancelled')
      const result = accepted(await read(lifetime))
      lifetime.throwIfAborted()
      if (!matches(result)) throw new SubmissionFailure('remote-failed')
      return result
    })
    const active = { request, done }
    this.sourceReads.add(active)
    void done.then(() => { this.sourceReads.delete(active) }, () => { this.sourceReads.delete(active) })
    return done
  }

  decideReview(sessionId: SessionId, request: KnowledgeImportReviewDecision, signal: AbortSignal): Promise<boolean> {
    const work = this.performDecision(sessionId, request, signal).finally(() => { this.reviewDecisionPending.delete(work) })
    this.reviewDecisionPending.add(work)
    return work
  }

  saveZeroHitDraft(sessionId: SessionId, request: KnowledgeImportSaveDraftRequest, signal: AbortSignal): Promise<boolean> {
    return this.performDraftAction(sessionId, signal, lookup =>
      this.remote.saveZeroHitDraft(lookup.workspaceId, lookup.importId, request, signal),
    lookup => lookup.zeroHitDraft?.operationId === request.operationId
      && (lookup.zeroHitDraft.phase === 'saved' || lookup.zeroHitDraft.phase === 'published'))
  }

  publishZeroHitDraft(sessionId: SessionId, request: KnowledgeImportPublishDraftRequest,
    signal: AbortSignal): Promise<boolean> {
    return this.performDraftAction(sessionId, signal, lookup =>
      this.remote.publishZeroHitDraft(lookup.workspaceId, lookup.importId, request, signal),
    lookup => lookup.zeroHitDraft?.publicationOperationId === request.operationId
      && lookup.zeroHitDraft.phase === 'published')
  }

  private performDraftAction(sessionId: SessionId, signal: AbortSignal,
    apply: (lookup: KnowledgeImportReviewLookup) => Promise<RemoteResult<KnowledgeImportState>>,
    completed: (lookup: KnowledgeImportReviewLookup) => boolean): Promise<boolean> {
    const observed = this.reviewEntries.get(sessionId)?.lookup
    if (observed === null || observed === undefined) return Promise.resolve(false)
    return this.performReviewAction(sessionId, signal, observed, () => apply(observed), completed,
      (state) =>{  this.setReview({ sessionId, phase: 'ready', lookup: { ...observed, state }, failure: null }) })
  }

  setComparedPageDecision(sessionId: SessionId, request: KnowledgeImportComparedPageDecision,
    signal: AbortSignal): Promise<boolean> {
    const work = this.performComparedPageDecision(sessionId, request, signal)
      .finally(() => { this.reviewDecisionPending.delete(work) })
    this.reviewDecisionPending.add(work)
    return work
  }

  setSourceDispositionDecision(sessionId: SessionId, request: KnowledgeImportSourceDispositionDecision,
    signal: AbortSignal): Promise<boolean> {
    const work = this.performSourceDispositionDecision(sessionId, request, signal)
      .finally(() => { this.reviewDecisionPending.delete(work) })
    this.reviewDecisionPending.add(work)
    return work
  }

  private performSourceDispositionDecision(sessionId: SessionId, request: KnowledgeImportSourceDispositionDecision,
    signal: AbortSignal): Promise<boolean> {
    return this.performChoiceDecision(sessionId, request, signal,
      proposal => proposal.sourceDispositionReview?.sha256,
      observed => this.remote.setSourceDispositionDecision(observed.workspaceId, observed.importId, request, signal),
      (lookup) => {
        const choice = lookup.proposal?.sourceDispositionReview?.choices
          .find(item => item.changeIndex === request.changeIndex && item.sourceIndex === request.sourceIndex)
        return choice?.judgment === request.judgment && choice.dispositionSha256 === request.dispositionSha256
      })
  }

  private performComparedPageDecision(sessionId: SessionId, request: KnowledgeImportComparedPageDecision,
    signal: AbortSignal): Promise<boolean> {
    return this.performChoiceDecision(sessionId, request, signal,
      proposal => proposal.comparedPageReview?.sha256,
      observed => this.remote.setComparedPageDecision(observed.workspaceId, observed.importId, request, signal),
      (lookup) => {
        const choice = lookup.proposal?.comparedPageReview?.choices
          .find(item => item.changeIndex === request.changeIndex && item.pageIndex === request.pageIndex)
        return choice?.relation === request.relation && choice.pageSha256 === request.pageSha256
      })
  }

  private performChoiceDecision(sessionId: SessionId,
    request: Pick<KnowledgeImportComparedPageDecision, 'proposalMessageId' | 'expectedProposalSha256' | 'expectedReviewSha256'>,
    signal: AbortSignal,
    reviewSha256: (proposal: NonNullable<KnowledgeImportReviewLookup['proposal']>) => string | undefined,
    apply: (lookup: KnowledgeImportReviewLookup) => Promise<RemoteResult<unknown>>,
    completed: (lookup: KnowledgeImportReviewLookup) => boolean): Promise<boolean> {
    const observed = this.reviewEntries.get(sessionId)?.lookup
    if (observed?.proposal?.messageId !== request.proposalMessageId
      || observed.proposal.sha256 !== request.expectedProposalSha256
      || observed.proposal.verification.status !== 'verified'
      || reviewSha256(observed.proposal) !== request.expectedReviewSha256) return Promise.resolve(false)
    return this.performReviewAction(sessionId, signal, observed, () => apply(observed), completed)
  }

  private async performReviewAction<T>(sessionId: SessionId, signal: AbortSignal, observed: KnowledgeImportReviewLookup,
    apply: () => Promise<RemoteResult<T>>, completed: (lookup: KnowledgeImportReviewLookup) => boolean,
    committed?: (value: T) => void): Promise<boolean> {
    if (this.disposed || this.reviewDecisions.has(sessionId)) return false
    const generation = this.reviewGeneration
    this.reviewDecisions.add(sessionId)
    this.setReview({ sessionId, phase: 'deciding', lookup: observed, failure: null })
    const current = (): boolean => !signal.aborted && !this.disposed && generation === this.reviewGeneration
    try {
      signal.throwIfAborted()
      const value = accepted(await apply())
      if (!current()) return false
      committed?.(value)
      await this.inspectReview(sessionId, signal)
      const refreshed = this.reviewEntries.get(sessionId)?.lookup
      return refreshed !== null && refreshed !== undefined && completed(refreshed)
    } catch (error) {
      if (!current()) return false
      await this.inspectReview(sessionId, signal)
      if (!current()) return false
      const recovered = this.reviewEntries.get(sessionId)?.lookup
      if (recovered !== null && recovered !== undefined && completed(recovered)) return true
      this.setReview({ sessionId, phase: 'failed', lookup: recovered ?? observed, ...this.reviewFailure(error) })
      return false
    } finally { this.reviewDecisions.delete(sessionId) }
  }

  private async performDecision(sessionId: SessionId, request: KnowledgeImportReviewDecision, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || this.reviewDecisions.has(sessionId)) return false
    const generation = this.reviewGeneration
    const observed = this.reviewEntries.get(sessionId)?.lookup
    if (observed === null || observed === undefined || observed.proposal?.messageId !== request.proposalMessageId
      || observed.proposal.sha256 !== request.expectedProposalSha256) {
      this.setReview({ sessionId, phase: 'failed', lookup: observed ?? null, failure: 'proposal-changed' })
      return false
    }
    if (request.decision === 'approve' && !hasReviewChanges(observed.proposal)) {
      this.setReview({ sessionId, phase: 'failed', lookup: observed, failure: 'review-not-ready' })
      return false
    }
    if ((observed.state.review?.revision ?? 0) !== request.expectedRevision) {
      this.setReview({ sessionId, phase: 'failed', lookup: observed, failure: 'review-revision-changed' })
      return false
    }
    this.reviewDecisions.add(sessionId)
    this.setReview({ sessionId, phase: 'deciding', lookup: observed, failure: null })
    const current = (): boolean => !signal.aborted && !this.disposed && generation === this.reviewGeneration
    try {
      signal.throwIfAborted()
      const state = accepted(await this.remote.decideReview(observed.workspaceId, observed.importId, request, signal))
      if (!current()) return false
      this.setReview({ sessionId, phase: 'ready', lookup: { ...observed, state }, failure: null })
      await this.inspectReview(sessionId, signal)
      return state.review?.operationId === request.operationId
    } catch (error) {
      if (!current()) return false
      await this.inspectReview(sessionId, signal)
      if (!current()) return false
      const recovered = this.reviewEntries.get(sessionId)
      if (recovered?.lookup?.state.review?.operationId === request.operationId) return true
      this.setReview({ sessionId, phase: 'failed', lookup: recovered?.lookup ?? observed, ...this.reviewFailure(error) })
      return false
    } finally {
      this.reviewDecisions.delete(sessionId)
    }
  }

  submit(workspaceId: WorkspaceId, intent: KnowledgeImportIntent, draftWorkspaceId: WorkspaceId): Promise<KnowledgeImportState | null> {
    if (this.disposed || this.projects.get(workspaceId)?.operation !== undefined
      || [...this.projects.values()].some(project => project.operation !== undefined
        && project.value.draftWorkspaceId === draftWorkspaceId)) return Promise.resolve(null)
    const sources = this.drafts.prepared(draftWorkspaceId)
    const project: Project = { value: { workspaceId, draftWorkspaceId, intent: { ...intent }, phase: 'checking', receipt: null, failure: null } }
    const request = new AbortController()
    this.projects.set(workspaceId, project)
    const done = Promise.resolve().then(async () => {
      try {
        request.signal.throwIfAborted()
        const receipt = await this.execute(project, sources, request.signal)
        request.signal.throwIfAborted()
        return receipt
      } catch (error) {
        if (!request.signal.aborted) {
          // Inspect does not execute the model; it may reveal a Session created before the failed response.
          try {
            const latest = await this.remote.inspect(workspaceId, project.value.intent.id)
            if (latest.ok) project.value = { ...project.value, receipt: latest.value }
          } catch { /* Only receipt recovery faults are ignored; the original submission failure remains visible. */ }
        }
        project.value = { ...project.value, failure: request.signal.aborted ? 'cancelled'
          : error instanceof SubmissionFailure ? error.reason : 'remote-failed' }
        return null
      }
    }).finally(() => {
      delete project.operation
      project.value = { ...project.value, phase: 'idle' }
      this.pending.delete(done)
      if (this.projects.get(workspaceId) === project) this.publish()
    })
    project.operation = { request, done }
    this.pending.add(done)
    this.publish()
    return done
  }

  async cancel(workspaceId: WorkspaceId): Promise<void> {
    const operation = this.projects.get(workspaceId)?.operation
    operation?.request.abort()
    await operation?.done
  }

  async forget(workspaceId: WorkspaceId): Promise<void> {
    const project = this.projects.get(workspaceId)
    if (project === undefined) return
    this.projects.delete(workspaceId)
    project.operation?.request.abort()
    this.publish()
    await project.operation?.done
  }

  async clear(): Promise<void> {
    this.inspectionGeneration++
    this.reviewGeneration++
    this.reviewSequence.clear()
    this.reviewEntries.clear()
    this.reviewDecisions.clear()
    this.reviews.set({ sessions: [] })
    const sourceReads = [...this.sourceReads]
    for (const read of sourceReads) read.request.abort()
    const submissions = [...this.projects.keys()].map(id => this.forget(id))
    await Promise.all([Promise.allSettled(sourceReads.map(read => read.done)), Promise.all(submissions)])
  }

  /**
   * Stop admission and publication, then join every outstanding submission.
   * @returns after all admitted operations, including removed projects, have settled.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.clear()
    await Promise.allSettled(this.pending)
    await Promise.allSettled(this.reviewReads)
    await Promise.allSettled(this.reviewDecisionPending)
  }

  private async execute(
    project: Project, sources: readonly PreparedDocumentImport[] | null, signal: AbortSignal,
  ): Promise<KnowledgeImportState> {
    const { workspaceId, intent } = project.value
    let sourcesToStage: readonly PreparedDocumentImport[] = []
    let receipt = accepted(await this.remote.inspect(workspaceId, intent.id))
    signal.throwIfAborted()
    if (receipt !== null && (receipt.locale !== intent.locale
      || receipt.scope?.spaceId !== intent.scope?.spaceId || receipt.maintenance !== intent.maintenance)) throw new SubmissionFailure('selection-changed')
    if (receipt?.status === 'abandoned') throw new SubmissionFailure('import-abandoned')
    this.update(project, { receipt })
    if (receipt === null || receipt.status === 'preparing') {
      if (sources === null || sources.length === 0) throw new SubmissionFailure('documents-required')
      sourcesToStage = sources
      this.update(project, { phase: 'hashing' })
      const documents: KnowledgeImportDocument[] = []
      for (const source of sources) {
        signal.throwIfAborted()
        documents.push(await describe(source))
      }
      signal.throwIfAborted()
      if (receipt === null) {
        const begun = accepted(await this.remote.begin(workspaceId, { ...intent, documents }, signal))
        signal.throwIfAborted()
        receipt = begun
        this.update(project, { receipt })
        sourcesToStage = sources.filter((_, index) => begun.documents[index]?.status !== 'stored')
      } else {
        const original = receipt.documents
        const pending = original.filter(document => document.status !== 'stored')
        const completeSelection = sources.length === original.length
        const selected = completeSelection ? original : pending
        if (selected.length !== documents.length || documents.some((document, index) => {
          const saved = selected[index]
          return saved === undefined || saved.name !== document.name || saved.format !== document.format
            || saved.bytes !== document.bytes || saved.sha256 !== document.sha256
        })) throw new SubmissionFailure('selection-changed')
        sourcesToStage = completeSelection
          ? sources.filter((_, index) => original[index]?.status !== 'stored') : sources
      }
      this.update(project, { phase: 'uploading' })
      let pendingIndex = 0
      for (const document of receipt.documents) {
        signal.throwIfAborted()
        if (document.status === 'stored') continue
        const source = sourcesToStage[pendingIndex++]
        if (source === undefined) throw new SubmissionFailure('selection-changed')
        receipt = accepted(await this.remote.stage(workspaceId, intent.id, document.id, source.source.dataBase64, signal))
        signal.throwIfAborted()
        this.update(project, { receipt })
      }
    }
    if (receipt.status !== 'accepted') {
      this.update(project, { phase: 'compiling' })
      signal.throwIfAborted()
      receipt = accepted(await this.remote.compile(workspaceId, intent.id, signal))
      signal.throwIfAborted()
      this.update(project, { receipt })
    }
    return receipt
  }

  private update(project: Project, patch: Partial<KnowledgeImportSubmission>): void {
    project.value = { ...project.value, ...patch }
    if (this.projects.get(project.value.workspaceId) === project) this.publish()
  }

  private publish(): void {
    this.state.set({ projects: [...this.projects.values()].map(project => project.value) })
  }

  private setReview(entry: KnowledgeImportReviewObservation): void {
    /* v8 ignore if -- Private callers check disposal or current generation synchronously before publication. */
    if (this.disposed) return
    this.reviewEntries.set(entry.sessionId, entry)
    this.reviews.set({ sessions: [...this.reviewEntries.values()] })
  }

  private reviewFailure(error: unknown): Pick<KnowledgeImportReviewObservation, 'failure' | 'writerLockPath'> {
    if (error instanceof SubmissionFailure && error.reason === 'writer-busy') return {
      failure: 'writer-busy', ...error.writerLockPath === undefined ? {} : { writerLockPath: error.writerLockPath },
    }
    if (error instanceof SubmissionFailure) {
      /* v8 ignore if -- Review replies cannot carry Client-only cancellation or missing-source failures. */
      if (error.reason === 'cancelled' || error.reason === 'documents-required') return { failure: 'remote-failed' }
      return { failure: error.reason }
    }
    return { failure: 'remote-failed' }
  }
}
