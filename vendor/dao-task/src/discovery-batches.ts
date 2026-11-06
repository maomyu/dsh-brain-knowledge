/** Shared bounded discovery receipt checks; Task and Goal own prompts and checkpoint identities. */
import { createHash } from 'node:crypto'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { KnowledgeDiscoveryInvalidResultError, parseKnowledgeDiscoveryWithTopic, parseKnowledgePageBatch,
  type KnowledgeDiscoverySource } from './knowledge-discovery.ts'
import type { ProjectTaskKnowledgeBatchProgress, ProjectTaskKnowledgeBatchReceipt,
  ProjectTaskKnowledgeDiscoveryBatch } from './types.ts'

/** Capture bounds shared by a first slice, a retry audit and a final catalog check. */
export interface DiscoveryBatchRequest {
  readonly offset: number
  readonly expectedCatalogSha256?: string | undefined
  readonly maxPages: number
  readonly maxBytes: number
}

/** Durable reviewer operations parameterized by the owning Task or Goal progress record. */
export interface DiscoveryBatchOperations<P> {
  readonly capture: (query: string, request: DiscoveryBatchRequest, signal: AbortSignal) => Promise<ProjectTaskKnowledgeDiscoveryBatch>
  readonly checkpoint: (sessionId: SessionId, messageId: MessageId, progress: P | undefined) => Promise<void>
  readonly review: (sessionId: SessionId, messageId: MessageId, inputText: string, signal: AbortSignal) => Promise<string>
  readonly audit: (receipt: ProjectTaskKnowledgeBatchReceipt) => Promise<{ readonly inputText: string
    readonly outputText: string }>
}

/** Final decision with the exact owner-specific progress and logged synthesis Session. */
export interface DiscoveryBatchResult<P> {
  readonly parsed: ReturnType<typeof parseKnowledgeDiscoveryWithTopic>
  readonly progress: P
  readonly finalSessionId: SessionId
  readonly topicSearch?: { readonly query: string
    readonly hits: readonly { readonly path: string
      readonly version: string }[] } | undefined
}

type Progress = Pick<ProjectTaskKnowledgeBatchProgress, 'catalogSha256' | 'titleSearch' | 'batches' | 'nextOffset' | 'totalPages'>
type Failure = new (kind: 'input-limit' | 'output-limit' | 'evidence-changed' | 'retention-limit', message: string) => Error

/** Verify slice identity and complete contiguous advancement.
 * @param batch - newly captured slice.
 * @param first - catalog identity captured before any reviewer call.
 * @param offset - required starting page.
 * @param location - whether this check includes the captured location revision.
 * @returns whether the slice belongs to the unchanged catalog and advances exactly.
 */
export function matchingDiscoveryBatch(batch: ProjectTaskKnowledgeDiscoveryBatch,
  first: ProjectTaskKnowledgeDiscoveryBatch, offset: number, location = true): boolean {
  return batch.offset === offset && batch.catalogSha256 === first.catalogSha256
    && batch.totalPages === first.totalPages && (!location || batch.locationRevision === first.locationRevision)
    && (batch.nextOffset === null ? offset + batch.pages.length === first.totalPages
      : batch.nextOffset === offset + batch.pages.length)
}

/** Persist call admission, review complete input, and retain its audited output identity.
 * @param operations - owner-specific durable reviewer operations.
 * @param input - bounded input and exact slice/call identities.
 * @param progress - retained prefix before this call.
 * @param signal - call lifetime.
 * @param ErrorType - owner-specific error class and diagnostic prefix.
 * @param owner - diagnostic prefix retained by the existing caller.
 * @returns a completed receipt; no checkpoint is published for a failed reviewer.
 */
export async function reviewDiscoverySlice<P>(operations: DiscoveryBatchOperations<P>, input: {
  readonly batch: ProjectTaskKnowledgeDiscoveryBatch
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly inputText: string
  readonly maxOutputBytes: number
}, progress: P | undefined, signal: AbortSignal, ErrorType: Failure, owner: 'Task' | 'Goal'): Promise<ProjectTaskKnowledgeBatchReceipt> {
  const output = await reviewDiscoveryOutput(operations, input, progress, signal, ErrorType, owner)
  const parsed = parseKnowledgePageBatch(output, input.batch)
  return { offset: input.batch.offset, nextOffset: input.batch.nextOffset, sessionId: input.sessionId, messageId: input.messageId,
    inputSha256: createHash('sha256').update(input.inputText).digest('hex'),
    outputSha256: createHash('sha256').update(output).digest('hex'), finding: parsed.finding, comparedPages: parsed.comparedPages }
}

/** Require one fully reviewed catalog before synthesis.
 * @param progress - retained page-review prefix.
 * @param ErrorType - owner-specific discovery error.
 * @param owner - existing diagnostic prefix.
 * @returns complete page relations in catalog order.
 */
export function completeDiscoveryPages(progress: Progress, ErrorType: Failure, owner: 'Task' | 'Goal'): ProjectTaskKnowledgeBatchReceipt['comparedPages'][number][] {
  const pages = progress.batches.flatMap(item => item.comparedPages)
  if (progress.nextOffset !== null || pages.length !== progress.totalPages) {
    throw new ErrorType('evidence-changed', `${owner} discovery did not review every Brain page`)
  }
  return pages
}

/** Project audited page findings without copying unrelated page text into synthesis.
 * @param batches - completed page receipts in catalog order.
 * @returns synthesis findings retaining every related page relation.
 */
export function discoveryFindings(batches: readonly ProjectTaskKnowledgeBatchReceipt[]): { readonly offset: number
  readonly count: number
  readonly finding: string
  readonly related: ProjectTaskKnowledgeBatchReceipt['comparedPages'][number][] }[] {
  return batches.map(item => ({ offset: item.offset, count: item.comparedPages.length, finding: item.finding,
    related: item.comparedPages.filter(page => page.relation !== 'unrelated') }))
}

/** Parse the synthesis and reject no-change when an audited page still needs a change or resolution.
 * @param output - final reviewer output.
 * @param first - original catalog location.
 * @param query - original title query.
 * @param sources - complete readable source matrix.
 * @param comparedPages - relations verified before synthesis.
 * @returns parsed final verdict before owner-specific catalog revalidation.
 */
export function parseDiscoverySynthesis(output: string, first: ProjectTaskKnowledgeDiscoveryBatch,
  query: string, sources: readonly KnowledgeDiscoverySource[], comparedPages: ProjectTaskKnowledgeBatchReceipt['comparedPages']): ReturnType<typeof parseKnowledgeDiscoveryWithTopic> {
  const final = parseKnowledgeDiscoveryWithTopic(output,
    { locationRevision: first.locationRevision, pages: [], searches: [] }, query, sources)
  if (final.decision === 'no-change' && comparedPages.some(page => page.relation === 'unknown'
    || page.relation === 'conflict' || page.relation === 'supersedes')) {
    throw new KnowledgeDiscoveryInvalidResultError('compared-page-relation')
  }
  return final
}

/** Recheck the catalog after synthesis and perform the independent new-page topic search.
 * @param capture - original-project catalog reader.
 * @param input - original query, unchanged catalog and existing capture bounds.
 * @param final - parsed synthesis.
 * @param signal - read lifetime.
 * @param ErrorType - owner-specific discovery error.
 * @param owner - existing diagnostic prefix.
 * @returns the topic search only for a new-page candidate.
 */
export async function discoveryTopicSearch(capture: DiscoveryBatchOperations<never>['capture'], input: {
  readonly query: string
  readonly progress: Progress
  readonly maxPages: number
  readonly maxInputBytes: number
}, final: ReturnType<typeof parseKnowledgeDiscoveryWithTopic>, signal: AbortSignal, ErrorType: Failure,
owner: 'Task' | 'Goal'): Promise<DiscoveryBatchResult<never>['topicSearch']> {
  const request = { offset: 0, expectedCatalogSha256: input.progress.catalogSha256,
    maxPages: input.maxPages, maxBytes: input.maxInputBytes }
  const fresh = await capture(input.query, request, signal)
  if (fresh.catalogSha256 !== input.progress.catalogSha256
    || JSON.stringify(fresh.searches[0]) !== JSON.stringify(input.progress.titleSearch)) {
    throw new ErrorType('evidence-changed', `${owner} discovery Brain changed after final decision`)
  }
  const query = final.decision === 'candidate' && final.kind === 'new-page' ? final.topicQuery : undefined
  const topic = query === undefined ? undefined : await capture(query, request, signal)
  if (topic !== undefined && (topic.catalogSha256 !== input.progress.catalogSha256
    || topic.searches.length !== 1 || topic.searches[0]?.query !== query)) {
    throw new ErrorType('evidence-changed', `${owner} discovery topic search changed its Brain catalog`)
  }
  return topic?.searches[0]
}

/** Audit a retained slice against its complete catalog capture and original reviewer Session.
 * @param operations - owner-specific catalog and Session readers.
 * @param input - original query, bounds, retained prefix and optional exact input renderer.
 * @param receipt - one completed retained slice.
 * @param signal - capture lifetime.
 * @param ErrorType - original owner-specific discovery failure.
 * @param goal - whether Goal's original exact-input audit and diagnostic wording apply.
 * @returns complete captured slice and audited Session text for further Task-specific source checks.
 */
export async function auditDiscoverySlice<P>(operations: DiscoveryBatchOperations<P>, input: {
  readonly query: string
  readonly maxInputBytes: number
  readonly first: ProjectTaskKnowledgeDiscoveryBatch
  readonly progress: Progress
  readonly renderInput?: ((batch: ProjectTaskKnowledgeDiscoveryBatch) => string) | undefined
}, receipt: ProjectTaskKnowledgeBatchReceipt, signal: AbortSignal, ErrorType: Failure, goal: boolean): Promise<{
  readonly captured: ProjectTaskKnowledgeDiscoveryBatch
  readonly audit: Awaited<ReturnType<DiscoveryBatchOperations<P>['audit']>> }> {
  const noun = goal ? 'Goal Brain' : 'Brain'
  const captured = receipt.offset === 0 && receipt.comparedPages.length === input.first.pages.length ? input.first
    : await operations.capture(input.query, { offset: receipt.offset, expectedCatalogSha256: input.progress.catalogSha256,
      maxPages: Math.max(1, receipt.comparedPages.length), maxBytes: input.maxInputBytes }, signal)
  let audit: Awaited<ReturnType<typeof operations.audit>>
  try { audit = await operations.audit(receipt) }
  catch (_unavailableSession) {
    throw new ErrorType('evidence-changed', goal ? 'Stored Goal Brain batch Session is unavailable'
      : 'Stored Brain batch review Session is unavailable')
  }
  if (captured.nextOffset !== receipt.nextOffset || captured.pages.length !== receipt.comparedPages.length
    || input.renderInput !== undefined && audit.inputText !== input.renderInput(captured)
    || createHash('sha256').update(audit.inputText).digest('hex') !== receipt.inputSha256
    || createHash('sha256').update(audit.outputText).digest('hex') !== receipt.outputSha256) {
    throw new ErrorType('evidence-changed', `Stored ${noun} batch differs from its review Session`)
  }
  let parsed: ReturnType<typeof parseKnowledgePageBatch>
  try { parsed = parseKnowledgePageBatch(audit.outputText, captured) }
  catch (_invalidBatchResult) {
    throw new ErrorType('evidence-changed', goal ? 'Stored Goal Brain batch result is invalid'
      : 'Stored Brain batch result is no longer valid')
  }
  if (parsed.finding !== receipt.finding || JSON.stringify(parsed.comparedPages) !== JSON.stringify(receipt.comparedPages)) {
    throw new ErrorType('evidence-changed', `Stored ${noun} batch result differs from its Session`)
  }
  return { captured, audit }
}

/** Persist the complete completed prefix before allowing the next slice.
 * @param operations - owner-specific checkpoint acknowledgement.
 * @param next - complete next prefix.
 * @param sessionId - just-completed reviewer Session.
 * @param messageId - original reviewer input.
 * @param limit - full serialized prefix byte limit.
 * @param ErrorType - existing owner-specific discovery error.
 * @param owner - existing diagnostic prefix.
 * @returns the acknowledged prefix.
 */
export async function retainDiscoveryProgress<P>(operations: DiscoveryBatchOperations<P>, next: P,
  sessionId: SessionId, messageId: MessageId, limit: number, ErrorType: Failure, owner: 'Task' | 'Goal'): Promise<P> {
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > limit) throw new ErrorType('retention-limit', `${owner} discovery retention-limit`)
  await operations.checkpoint(sessionId, messageId, next)
  return next
}

/** Capture one exact slice and reject a changed or non-advancing catalog.
 * @param capture - original-project page reader.
 * @param first - original catalog and first slice.
 * @param input - current offset and per-capture limits.
 * @param signal - capture lifetime.
 * @param ErrorType - owner-specific discovery error.
 * @param owner - existing diagnostic prefix.
 * @returns the validated complete slice.
 */
export async function captureDiscoverySlice(capture: DiscoveryBatchOperations<never>['capture'],
  first: ProjectTaskKnowledgeDiscoveryBatch, input: { readonly query: string
    readonly offset: number
    readonly maxPages: number
    readonly maxInputBytes: number }, signal: AbortSignal, ErrorType: Failure,
  owner: 'Task' | 'Goal'): Promise<ProjectTaskKnowledgeDiscoveryBatch> {
  signal.throwIfAborted()
  const batch = input.offset === 0 ? first : await capture(input.query, { offset: input.offset,
    expectedCatalogSha256: first.catalogSha256, maxPages: input.maxPages, maxBytes: input.maxInputBytes }, signal)
  if (!matchingDiscoveryBatch(batch, first, input.offset)) {
    throw new ErrorType('evidence-changed', `${owner} discovery Brain batch changed or did not advance`)
  }
  return batch
}

/** Acknowledge reviewer admission and bound its complete output before parsing.
 * @param operations - owner-specific reviewer and durable checkpoint.
 * @param input - exact reviewer identity, complete input and output allowance.
 * @param progress - prior acknowledged page prefix.
 * @param signal - reviewer lifetime.
 * @param ErrorType - owner-specific discovery error.
 * @param owner - existing diagnostic prefix.
 * @returns complete reviewer output; failed calls produce no completed receipt.
 */
export async function reviewDiscoveryOutput<P>(operations: DiscoveryBatchOperations<P>, input: {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly inputText: string
  readonly maxOutputBytes: number
}, progress: P | undefined, signal: AbortSignal, ErrorType: Failure, owner: 'Task' | 'Goal'): Promise<string> {
  await operations.checkpoint(input.sessionId, input.messageId, progress)
  const output = await operations.review(input.sessionId, input.messageId, input.inputText, signal)
  if (Buffer.byteLength(output, 'utf8') > input.maxOutputBytes) throw new ErrorType('output-limit', `${owner} discovery output-limit`)
  return output
}
