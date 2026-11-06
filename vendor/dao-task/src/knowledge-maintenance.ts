/** Automatic maintenance selects only a complete independent candidate, never a human decision. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canPublishKnowledgeSources, hasUnreviewedArtifactContent, matchesKnowledgeSourceDispositions,
  type KnowledgeDiscoverySource } from './knowledge-discovery.ts'
import type { ProjectTaskKnowledgeAutomatic, ProjectTaskKnowledgeAutomaticRequest,
  ProjectTaskKnowledgeDiscoveryBatch, ProjectTaskKnowledgeDiscovery, ProjectGoalKnowledgeDiscovery,
  ProjectTaskKnowledgeDocumentId, ProjectTaskKnowledgeOperationId, ProjectTaskKnowledgeDiscoveryWriter,
  ProjectTaskKnowledgeDiscoveryBatchReader, ProjectTaskSessionProject, ProjectTaskKnowledgeAutomaticState } from './types.ts'

type Candidate = Extract<ProjectTaskKnowledgeDiscovery | ProjectGoalKnowledgeDiscovery, { status: 'candidate' }>

/** Project an automatic outcome without exposing the Host request or original project directory.
 * @param state - validated durable operation.
 * @returns safe Client status and exact file receipt when applied.
 */
export function automaticKnowledgeState(state: ProjectTaskKnowledgeAutomatic): ProjectTaskKnowledgeAutomaticState {
  const identity = { candidateId: state.candidateId, resultSha256: state.resultSha256, candidateSha256: state.candidateSha256 }
  return state.status === 'deferred' ? { ...identity, status: state.status, reason: state.reason }
    : state.status === 'applied' ? { ...identity, status: state.status, receipt: state.receipt }
      : { ...identity, status: state.status }
}

/** Read a complete catalog using the existing bounded, version-bound provider slices.
 * @param capture - Brain-owned slice reader.
 * @param project - frozen original project.
 * @param query - real Task-title query whose search receipt is retained.
 * @param limits - deployed per-slice count and byte limits.
 * @param signal - caller lifetime.
 * @returns complete catalog with the first search receipt and unchanged catalog identity.
 */
export async function captureAutomaticKnowledgeCatalog(capture: ProjectTaskKnowledgeDiscoveryBatchReader,
  project: ProjectTaskSessionProject, query: string, limits: { readonly maxPages: number
    readonly maxBytes: number },
  signal: AbortSignal): Promise<ProjectTaskKnowledgeDiscoveryBatch> {
  const first = await capture(project, query, { offset: 0, ...limits }, signal)
  let catalog = first
  while (catalog.nextOffset !== null) {
    signal.throwIfAborted()
    const next = await capture(project, query, { offset: catalog.nextOffset,
      expectedCatalogSha256: first.catalogSha256, ...limits }, signal)
    if (next.offset !== catalog.nextOffset || next.catalogSha256 !== first.catalogSha256
      || next.locationRevision !== first.locationRevision || next.totalPages !== first.totalPages
      || next.nextOffset !== null && next.nextOffset <= next.offset) throw new Error('Automatic catalog changed between slices')
    catalog = { ...first, pages: [...catalog.pages, ...next.pages], nextOffset: next.nextOffset }
    if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') > limits.maxBytes) {
      throw new Error('Automatic catalog exceeds the aggregate evidence byte limit')
    }
  }
  if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') > limits.maxBytes) throw new Error('Automatic catalog exceeds the aggregate evidence byte limit')
  return catalog
}

/** Select one destination from the complete semantic comparison and real catalog search receipts.
 * @param candidate - immutable independent reviewer result.
 * @param authority - frozen confirmation identity and actual execution/source Sessions.
 * @param title - original Task title, never a model-selected file path.
 * @param sources - source bodies re-read against completion receipts.
 * @param catalog - complete, version-bound Brain observation.
 * @returns exact operation or a retained AI-deferred finding without a Brain write.
 */
export function prepareAutomaticKnowledge(candidate: Candidate, authority: ProjectTaskKnowledgeAutomaticRequest['authority'],
  title: string, sources: readonly KnowledgeDiscoverySource[], catalog: ProjectTaskKnowledgeDiscoveryBatch):
  ProjectTaskKnowledgeAutomaticRequest | Extract<ProjectTaskKnowledgeAutomatic, { status: 'deferred' }> {
  const identity = { candidateId: candidate.candidateId, resultSha256: candidate.resultSha256,
    candidateSha256: candidate.candidateSha256 }
  const deferred = (reason: Extract<ProjectTaskKnowledgeAutomatic, { status: 'deferred' }>['reason']):
  Extract<ProjectTaskKnowledgeAutomatic, { status: 'deferred' }> => ({ ...identity, status: 'deferred', reason })
  const dispositions = candidate.sourceDispositions
  if (candidate.comparisonFormat !== 'semantic-v1' || dispositions === undefined
    || !matchesKnowledgeSourceDispositions(dispositions, sources) || !canPublishKnowledgeSources(dispositions)
    || hasUnreviewedArtifactContent(candidate.artifactCoverage ?? [])
    || 'codingOmissions' in candidate && (candidate.codingOmissions?.length ?? 0) > 0
    || 'importedCoverage' in candidate && candidate.importedCoverage?.some(coverage => coverage.omittedReason !== undefined)
    || 'importedDocxCoverage' in candidate && candidate.importedDocxCoverage?.some(coverage => coverage.omittedImages.length > 0)) return deferred('source-incomplete')
  if (catalog.offset !== 0 || catalog.nextOffset !== null || catalog.totalPages !== catalog.pages.length
    || JSON.stringify(catalog.pages.map(page => [page.path, page.version]).sort())
      !== JSON.stringify(candidate.comparedPages.map(page => [page.path, page.version]).sort())
    || 'catalogSha256' in candidate && candidate.catalogSha256 !== undefined
      && candidate.catalogSha256 !== catalog.catalogSha256) return deferred('catalog-changed')
  const titleSearch = catalog.searches.find(search => search.query === title)
  if (titleSearch === undefined) return deferred('catalog-changed')
  if (candidate.kind === 'conflict' || candidate.comparedPages.some(page => page.relation === undefined
    || page.relation === 'unknown' || page.relation === 'duplicate' || page.relation === 'conflict')) return deferred('conflict')
  const related = candidate.comparedPages.filter(page => page.relation !== 'unrelated')
  const text = { truth: candidate.proposedTruth, summary: candidate.summary, evidence: candidate.evidence }
  let change: ProjectTaskKnowledgeAutomaticRequest['change']
  if (candidate.kind === 'existing-page') {
    const target = related[0]
    if (related.length !== 1 || target === undefined || (target.relation !== 'supports' && target.relation !== 'supersedes')) {
      return deferred('conflict')
    }
    change = { kind: 'update', documentId: brandString<ProjectTaskKnowledgeDocumentId>(target.path),
      expectedVersion: target.version, ...text }
  } else {
    if (related.length !== 0 || candidate.topicSearch === undefined) return deferred('conflict')
    change = { kind: 'create', documentId: brandString<ProjectTaskKnowledgeDocumentId>(`pages/task-${candidate.candidateId}.md`),
      title, category: 'decision', tags: [], ...text }
  }
  return { operationId: brandString<ProjectTaskKnowledgeOperationId>(randomUUID()), authority,
    reviewerSessionId: candidate.discoveryId, ...identity, locationRevision: catalog.locationRevision,
    catalogSha256: catalog.catalogSha256, sourceCoverage: 'complete', sources, sourceDispositions: dispositions,
    comparedPages: candidate.comparedPages, titleSearch,
    ...(candidate.topicSearch === undefined ? {} : { topicSearch: candidate.topicSearch }), change }
}

/** Settle a frozen UUID; a crash recovery inspects before it can repeat the identical operation.
 * @param pending - request committed before the first provider call.
 * @param writer - independent Brain owner; missing methods keep the operation pending.
 * @param signal - consumer lifetime, not permission to retract an admitted Brain write.
 * @param beforePublish - revalidate the current original project, permission, result and candidate inside the writer lock.
 * @param retain - durable state writer whose receipt checks run before acknowledgement.
 * @param recovering - true for retained operations or a cold restart.
 */
export async function settleAutomaticKnowledge(pending: Extract<ProjectTaskKnowledgeAutomatic, { status: 'pending' | 'unknown' }>,
  writer: Pick<ProjectTaskKnowledgeDiscoveryWriter, 'applyAutomatic' | 'inspectAutomatic'>,
  signal: AbortSignal, beforePublish: (retry: boolean) => Promise<void>, retain: (state: ProjectTaskKnowledgeAutomatic) => Promise<void>,
  recovering: boolean): Promise<void> {
  if (writer.applyAutomatic === undefined || writer.inspectAutomatic === undefined) return
  const apply = writer.applyAutomatic.bind(writer)
  const inspect = writer.inspectAutomatic.bind(writer)
  const identity = { candidateId: pending.candidateId, resultSha256: pending.resultSha256,
    candidateSha256: pending.candidateSha256 }
  let repairAttempted = false
  const accept = async (result: Awaited<ReturnType<typeof inspect>>, repair = false): Promise<boolean> => {
    switch (result.status) {
      case 'absent': return false
      case 'unknown': await retain({ ...pending, status: 'unknown' }); break
      case 'deferred': await retain({ ...identity, status: 'deferred', reason: result.reason }); break
      case 'applied':
        if (repair) {
          if (repairAttempted) { await retain({ ...pending, status: 'unknown' }); return true }
          repairAttempted = true
          // Repair rechecks the saved page UUID and original permission; it cannot write another page.
          const repaired = await apply(pending.project, pending.request, signal, beforePublish)
          return accept(repaired)
        }
        await retain({ ...pending, status: 'applied', receipt: result.receipt })
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: return assertNever(result)
    }
    return true
  }
  try {
    if (recovering && await accept(await inspect(pending.project, pending.request, signal), true)) return
    await beforePublish(false)
    await accept(await apply(pending.project, pending.request, signal, beforePublish))
  } catch (error) {
    if (signal.aborted) throw error
    // A provider failure is not evidence that the UUID was never written.
    try { if (await accept(await inspect(pending.project, pending.request, signal), true)) return }
    catch (_inspectionFailure: unknown) { /* The frozen request remains available for a later receipt inspection. */ }
    await retain({ ...pending, status: 'unknown' })
  }
}

/** Retain one prepared request or an honest incomplete-source refusal.
 * @param identity - original candidate and evidence digests.
 * @param signal - original operation lifetime; cancellation is never converted to a refusal.
 * @param retain - owner-specific durable state acknowledgement.
 * @param prepare - original-project source capture and pending-request retention.
 * @returns retained pending request, or undefined when preparation records a refusal.
 */
export async function prepareAutomaticKnowledgeState(identity: Pick<Candidate, 'candidateId' | 'resultSha256' | 'candidateSha256'>,
  signal: AbortSignal, retain: (state: ProjectTaskKnowledgeAutomatic) => Promise<void>,
  prepare: () => Promise<(Extract<ProjectTaskKnowledgeAutomatic, { status: 'pending' | 'unknown' }> & { status: 'pending' }) | undefined>):
Promise<(Extract<ProjectTaskKnowledgeAutomatic, { status: 'pending' | 'unknown' }> & { status: 'pending' }) | undefined> {
  try { return await prepare() } catch (error) {
    if (signal.aborted) throw error
    await retain({ ...identity, status: 'deferred', reason: 'source-incomplete' })
    return undefined
  }
}
