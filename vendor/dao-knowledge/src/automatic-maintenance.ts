/** AI-maintenance intents retain their own permission and exact requests; Brain files own successful receipts. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { hasIndependentKnowledgeTerm } from '@deepseek-ai/dsh-api-task-controller'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ProjectGoalRequestId, ProjectGoalRunId, ProjectTaskId, ProjectTaskKnowledgeCandidateId } from '@deepseek-ai/dsh-api-task-controller/types'
import type { KnowledgeAutomaticAuthorizationId, KnowledgeAutomaticImportId, KnowledgeAutomaticMaintenancePolicy,
  KnowledgeAutomaticMaintenanceRequest, KnowledgeAutomaticMaintenanceResult, KnowledgeDiscoveryPageBatch,
  KnowledgeDocumentId, KnowledgeUpdateId } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const sessionId = nonempty.transform(value => value as SessionId)
const taskId = nonempty.transform(value => value as ProjectTaskId)
const candidateId = z.uuid().transform(value => value as ProjectTaskKnowledgeCandidateId)
const permission = { authorizationId: z.uuid().transform(value => value as KnowledgeAutomaticAuthorizationId),
  sourceSessionId: sessionId }
const authority = z.discriminatedUnion('kind', [
  z.object({ ...permission, kind: z.literal('conversation'), messageId: nonempty.transform(value => value as MessageId) }).strict(),
  z.object({ ...permission, kind: z.literal('task'), taskId, taskSessionId: sessionId, candidateId }).strict(),
  z.object({ ...permission, kind: z.literal('goal'), taskId, taskSessionId: sessionId,
    goalRunId: nonempty.transform(value => value as ProjectGoalRunId),
    planRequestId: nonempty.transform(value => value as ProjectGoalRequestId), candidateId }).strict(),
  z.object({ ...permission, kind: z.literal('import'),
    importId: nonempty.transform(value => value as KnowledgeAutomaticImportId) }).strict(),
])
const search = z.object({ query: nonempty, hits: z.array(z.object({ path: nonempty, version: nonempty }).strict()).readonly() }).strict()
const changeFields = { documentId: nonempty.transform(value => value as KnowledgeDocumentId), truth: nonempty,
  summary: nonempty, evidence: nonempty }
const change = z.discriminatedUnion('kind', [
  z.object({ ...changeFields, kind: z.literal('update'), expectedVersion: nonempty,
    entryKind: z.enum(['decision', 'observation', 'source', 'reversal', 'evidence']).optional() }).strict(),
  z.object({ ...changeFields, kind: z.literal('create'), title: nonempty,
    category: z.enum(['project', 'concept', 'decision', 'person', 'reference']), tags: z.array(z.string()).readonly() }).strict(),
  z.object({ ...changeFields, kind: z.literal('merge'), expectedVersion: nonempty,
    sourceDocumentId: nonempty.transform(value => value as KnowledgeDocumentId),
    sourceExpectedVersion: nonempty, reason: nonempty }).strict(),
])
const disposition = z.object({ sourceId: nonempty,
  disposition: z.enum(['current', 'superseded', 'unresolved', 'not-relevant']), quote: nonempty.optional(), rationale: nonempty }).strict()
  .refine(value => value.disposition !== 'current' && value.disposition !== 'superseded' || value.quote !== undefined)
const compared = z.object({ path: nonempty, version: nonempty,
  relation: z.enum(['unrelated', 'unknown', 'duplicate', 'conflict', 'supports', 'supersedes']),
  quote: nonempty.optional(), reason: nonempty.optional() }).strict()
  .refine(value => value.relation === 'unrelated' || value.relation === 'unknown'
    ? value.relation === 'unrelated' || value.reason !== undefined : value.quote !== undefined && value.reason !== undefined)
const requestSchema = z.object({ operationId: z.uuid().transform(value => value as KnowledgeUpdateId), authority,
  reviewerSessionId: sessionId, resultSha256: sha, candidateSha256: sha,
  locationRevision: nonempty.nullable(), catalogSha256: sha, sourceCoverage: z.enum(['complete', 'incomplete']),
  sources: z.array(z.object({ sourceId: nonempty, text: nonempty }).strict()).readonly(),
  sourceDispositions: z.array(disposition).readonly(), comparedPages: z.array(compared).readonly(),
  titleSearch: search, topicSearch: search.optional(), change }).strict()
const reviewChange = z.discriminatedUnion('kind', [
  z.object({ ...changeFields, kind: z.literal('update'), expectedVersion: nonempty }).strict(),
  z.object({ kind: z.literal('create'), title: nonempty,
    category: z.enum(['project', 'concept', 'decision', 'person', 'reference']), tags: z.array(z.string()).readonly(),
    truth: nonempty, summary: nonempty, evidence: nonempty }).strict(),
  z.object({ ...changeFields, kind: z.literal('merge'), expectedVersion: nonempty,
    sourceDocumentId: nonempty.transform(value => value as KnowledgeDocumentId),
    sourceExpectedVersion: nonempty, reason: nonempty }).strict(),
])
const reviewFields = { version: z.literal('brain-maintenance-json-v1'),
  sourceDispositions: z.array(disposition).readonly(), comparedPages: z.array(compared).readonly(),
  visualReviews: z.array(z.object({ sourceId: nonempty, format: z.enum(['pdf', 'docx']),
    findings: z.array(z.object({ ordinal: z.number().int().positive(),
      assessment: z.enum(['supports-text', 'conflict', 'unreadable']), finding: nonempty }).strict()).readonly(),
    omittedOrdinals: z.array(z.number().int().positive()).readonly(),
    unresolvedContent: z.array(nonempty).readonly() }).strict()).readonly().optional() }
const reviewSchema = z.discriminatedUnion('decision', [
  z.object({ ...reviewFields, decision: z.literal('change'), titleQuery: nonempty, topicQuery: nonempty.optional(),
    change: reviewChange }).strict().refine(value => value.change.kind !== 'create' || value.topicQuery !== undefined),
  z.object({ ...reviewFields, decision: z.literal('no-change'), reason: nonempty }).strict(),
  z.object({ ...reviewFields, decision: z.literal('deferred'), reason: nonempty }).strict(),
])
const receipt = z.object({ documentId: nonempty.transform(value => value as KnowledgeDocumentId), version: nonempty,
  operationId: z.uuid().transform(value => value as KnowledgeUpdateId), disposition: z.enum(['written', 'already-applied']) }).strict()
const result = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), receipt }).strict(),
  z.object({ status: z.literal('deferred'), reason: z.enum(['conflict', 'source-incomplete', 'catalog-changed', 'disabled']),
    review: z.object({ reviewerSessionId: sessionId, resultSha256: sha, reason: nonempty.optional() }).strict().optional() }).strict(),
])
const record = z.object({ workspaceId: nonempty.transform(value => value as WorkspaceId), projectPath: nonempty,
  brainDirectory: nonempty, locationRevision: nonempty.nullable(), request: requestSchema, requestSha256: sha,
  result: result.nullable() }).strict()

/** A private AI intent, not a human review, visible message or permission for generic file tools. */
export type KnowledgeAutomaticMaintenanceRecord = z.infer<typeof record>

/** Strict independent AI review; all permissions, UUIDs, file paths for creation and digests remain Host-owned. */
export type KnowledgeAutomaticMaintenanceReview = z.infer<typeof reviewSchema>

/** Parse one complete AI-only maintenance envelope, without a partial-input or legacy-human fallback.
 * @param text - durably settled complete model answer, optionally one whole-response JSON fence.
 * @returns the strict AI change, no-change or deferred review.
 * @throws for non-JSON, extra fields, missing source/page evidence or creation without an independent topic query.
 */
export function parseAutomaticMaintenanceReview(text: string): KnowledgeAutomaticMaintenanceReview {
  const raw = text.trim().replace(/^```(?:json|brain-maintenance-json-v1)?\s*/iu, '').replace(/\s*```$/u, '')
  return reviewSchema.parse(JSON.parse(raw))
}

/** Hash the normalized complete AI review, distinct from the hash of its original settled text.
 * @param review - strict parsed model review.
 * @returns SHA-256 of its complete normalized JSON.
 */
export function automaticMaintenanceReviewDigest(review: KnowledgeAutomaticMaintenanceReview): string {
  return createHash('sha256').update(JSON.stringify(review)).digest('hex')
}

/** Generate a stable Brain-relative path without allowing model text to choose a native location.
 * @param operationId - Host-issued UUID retained before creation admission.
 * @returns direct page identity; the display title remains independently authored.
 */
export function automaticMaintenancePageId(operationId: KnowledgeUpdateId): KnowledgeDocumentId {
  return `pages/ai-${operationId.replaceAll('-', '')}.md` as KnowledgeDocumentId
}

/** Each automatic UUID owns one immutable request independently from legacy human publication records. */
export const knowledgeAutomaticMaintenanceDomain = defineDomain({ name: 'knowledge_automatic_maintenance', version: 1,
  tables: { operations: domainTable<KnowledgeUpdateId, KnowledgeAutomaticMaintenanceRecord>(record) } })

function fail(message: string): never {
  throw new RemoteError('knowledge/update', message, { path: 'pages', reason: 'identity-conflict' })
}

/** Validate a complete Host intent before retention or file inspection.
 * @param request - original AI intent and evidence from the owning admission.
 * @param maxBytes - inclusive full serialized request cap, including sources and comparisons.
 * @returns parsed complete request with branded identities.
 * @throws for malformed, oversized or unquoted source and page classifications.
 */
export function validateAutomaticMaintenanceRequest(request: unknown,
  maxBytes: number): KnowledgeAutomaticMaintenanceRequest {
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maxBytes) fail('Complete AI maintenance request exceeds maxRecordBytes')
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) fail('AI maintenance needs a complete original permission, source review, catalog comparison and change')
  return parsed.data
}

/** Name the actual source owner and independent AI reviewer without claiming a human decision.
 * @param request - validated automatic-maintenance intent.
 * @returns canonical historical source reference for the Brain writer.
 */
export function automaticMaintenanceSource(request: KnowledgeAutomaticMaintenanceRequest): string {
  const value = request.authority
  switch (value.kind) {
    case 'conversation': return `session:${value.sourceSessionId}/message:${value.messageId}`
    case 'task': return `task:${value.taskId}:ai-review:${request.reviewerSessionId}`
    case 'goal': return `goal:${value.goalRunId}:plan:${value.planRequestId}:task:${value.taskId}:ai-review:${request.reviewerSessionId}`
    case 'import': return `knowledge-import:${value.importId}:ai-review:${request.reviewerSessionId}`
  }
  /* v8 ignore next -- All four validated authority kinds return in this closed union. */
  return assertNever(value)
}

/** Validate complete source and page classifications against actual Host-captured text, without authorizing a write.
 * @param review - parsed model classifications, including no-change or deferred answers.
 * @param sources - complete original sources in their retained order.
 * @param catalog - complete current catalog and full page bodies.
 * @returns a refusal reason, or null when every classification cites the correct actual source and body.
 */
export function automaticMaintenanceReviewEvidenceFailure(
  review: Pick<KnowledgeAutomaticMaintenanceRequest, 'sourceDispositions' | 'comparedPages'>,
  sources: KnowledgeAutomaticMaintenanceRequest['sources'], catalog: KnowledgeDiscoveryPageBatch,
): 'source-incomplete' | 'catalog-changed' | null {
  if (catalog.nextOffset !== null || catalog.offset !== 0 || catalog.pages.length !== catalog.totalPages) return 'catalog-changed'
  if (sources.length === 0 || new Set(sources.map(source => source.sourceId)).size !== sources.length
    || review.sourceDispositions.length !== sources.length || sources.some((source, index) => {
    const item = review.sourceDispositions[index]
    return item?.sourceId !== source.sourceId || item.disposition === 'unresolved'
      || item.quote !== undefined && !source.text.includes(item.quote)
  })) return 'source-incomplete'
  if (review.comparedPages.length !== catalog.pages.length || catalog.pages.some((page, index) => {
    const item = review.comparedPages[index]
    return item?.path !== page.path || item.version !== page.version
      || item.quote !== undefined && !page.body.includes(item.quote)
  })) return 'catalog-changed'
  return null
}

/** Require exact full-source coverage and one unambiguous destination against Host-read page bodies.
 * @param request - original model review with its complete sources and page relations.
 * @param catalog - current complete original-project catalog and full documents.
 * @returns a safe deferred reason, or null when the evidence can admit the requested active write.
 */
export function automaticMaintenanceEvidenceFailure(request: KnowledgeAutomaticMaintenanceRequest,
  catalog: KnowledgeDiscoveryPageBatch): Extract<KnowledgeAutomaticMaintenanceResult, { status: 'deferred' }>['reason'] | null {
  if (request.locationRevision !== catalog.locationRevision || request.catalogSha256 !== catalog.catalogSha256
    || catalog.nextOffset !== null || catalog.offset !== 0 || catalog.pages.length !== catalog.totalPages) return 'catalog-changed'
  if (request.sourceCoverage !== 'complete'
    || !request.sourceDispositions.some(item => item.disposition === 'current')) return 'source-incomplete'
  const failure = automaticMaintenanceReviewEvidenceFailure(request, request.sources, catalog)
  if (failure !== null) return failure
  if (request.change.kind === 'create') {
    return request.topicSearch === undefined || !hasIndependentKnowledgeTerm(request.topicSearch.query, request.titleSearch.query)
      || request.comparedPages.some(page => page.relation !== 'unrelated'
        && !(request.authority.kind === 'conversation' && page.relation === 'supports'))
      || catalog.pages.some(page => page.path === request.change.documentId) ? 'conflict' : null
  }
  const target = catalog.pages.find(page => page.path === request.change.documentId)
  const relation = request.comparedPages.find(page => page.path === request.change.documentId)
  if (request.change.kind === 'merge') {
    const change = request.change
    const source = catalog.pages.find(page => page.path === change.sourceDocumentId)
    const sourceRelation = request.comparedPages.find(page => page.path === change.sourceDocumentId)
    return request.authority.kind !== 'conversation' || change.documentId === change.sourceDocumentId
      || !change.documentId.startsWith('pages/') || !change.sourceDocumentId.startsWith('pages/')
      || target?.status !== 'active' || target.version !== change.expectedVersion
      || source?.status !== 'active' || source.version !== change.sourceExpectedVersion
      || relation === undefined || !['supports', 'supersedes', 'duplicate'].includes(relation.relation)
      || sourceRelation?.relation !== 'duplicate'
      || request.comparedPages.some(page => page.path !== change.documentId && page.path !== change.sourceDocumentId
        && page.relation !== 'unrelated') ? 'conflict' : null
  }
  if (target?.status !== 'active' || target.version !== request.change.expectedVersion
    || !request.change.documentId.startsWith('pages/') || relation === undefined
    || relation.relation !== 'supports' && relation.relation !== 'supersedes'
    || catalog.pages.some((page, index) => {
      if (page.path === request.change.documentId) return false
      const relation = request.comparedPages[index]?.relation
      return relation !== 'unrelated' && !(request.authority.kind === 'conversation'
        && (relation === 'supports' || page.status !== 'active' && relation === 'duplicate'))
    })) return 'conflict'
  return null
}

/** Persist exact AI intents before admission; retries never replace a different request or upgrade historical human data. */
export class KnowledgeAutomaticMaintenanceStore {
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly table: KvTable<KnowledgeUpdateId, KnowledgeAutomaticMaintenanceRecord>,
    private readonly policy: KnowledgeAutomaticMaintenancePolicy) {
    if (table.size > policy.maxRecords) fail('AI maintenance operation capacity exceeded')
    for (const [id, value] of table.entries()) {
      if (id !== value.request.operationId || value.requestSha256 !== this.digest(value.request)
        || Buffer.byteLength(JSON.stringify(value), 'utf8') > policy.maxRecordBytes) fail('AI maintenance storage identity is invalid')
    }
  }

  private digest(request: KnowledgeAutomaticMaintenanceRequest): string {
    return createHash('sha256').update(JSON.stringify(request)).digest('hex')
  }

  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.pending
    let release!: () => void
    this.pending = new Promise<void>((resolve) => { release = resolve })
    await prior
    try { return await work() } finally { release() }
  }

  /** Retrieve one retained original operation without publishing or replaying it.
   * @param workspaceId - currently registered original project.
   * @param projectPath - canonical project path retained at the first admission.
   * @param request - complete original input; a changed request cannot inspect another operation.
   * @returns the detached retained intent, or null.
   */
  get(workspaceId: WorkspaceId, projectPath: string,
    request: KnowledgeAutomaticMaintenanceRequest): KnowledgeAutomaticMaintenanceRecord | null {
    const value = this.table.get(request.operationId)
    if (value === undefined) return null
    if (value.workspaceId !== workspaceId || value.projectPath !== projectPath
      || value.requestSha256 !== this.digest(request)) fail('AI maintenance UUID belongs to a different project or request')
    return structuredClone(value)
  }

  /** Read an AI conversation's retained request after an uncertain tool result; this lookup admits no write.
   * @param workspaceId - original registered project.
   * @param projectPath - current canonical project path.
   * @param operationId - original creation UUID.
   * @returns exact retained intent, or null; the caller must validate its source and original tool fields.
   */
  conversation(workspaceId: WorkspaceId, projectPath: string,
    operationId: KnowledgeUpdateId): KnowledgeAutomaticMaintenanceRecord | null {
    const value = this.table.get(operationId)
    if (value === undefined) return null
    if (value.workspaceId !== workspaceId || value.projectPath !== projectPath
      || value.request.authority.kind !== 'conversation') fail('AI conversation operation belongs to another source or project')
    return structuredClone(value)
  }

  /** Durably freeze the permission and complete AI evidence before any atomic file write.
   * @param value - original project, Brain location and exact request, with no result yet.
   * @returns the first acknowledged immutable record or its identical retry.
   */
  async retain(value: KnowledgeAutomaticMaintenanceRecord): Promise<KnowledgeAutomaticMaintenanceRecord> {
    return this.mutate(async () => {
      const candidate = record.parse({ ...value, requestSha256: this.digest(value.request) })
      const prior = this.get(candidate.workspaceId, candidate.projectPath, candidate.request)
      if (prior !== null) return prior
      if (this.table.size >= this.policy.maxRecords
        || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.policy.maxRecordBytes) fail('AI maintenance retention limit exceeded')
      await this.table.put(candidate.request.operationId, candidate)
      return structuredClone(candidate)
    })
  }

  /** Record only a derived file receipt or a proven pre-write deferral; unknown writes stay pending.
   * @param value - acknowledged original immutable intent.
   * @param outcome - exact receipt or evidence refusal with no active publication.
   * @returns the durably acknowledged result.
   */
  async settle(value: KnowledgeAutomaticMaintenanceRecord,
    outcome: KnowledgeAutomaticMaintenanceResult): Promise<KnowledgeAutomaticMaintenanceResult> {
    return this.mutate(async () => {
      const prior = this.get(value.workspaceId, value.projectPath, value.request)
      if (prior === null) fail('AI maintenance intent was not retained before settlement')
      const candidate = record.parse({ ...prior, result: outcome })
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.policy.maxRecordBytes) fail('AI maintenance receipt exceeds maxRecordBytes')
      await this.table.put(candidate.request.operationId, candidate)
      return structuredClone(outcome)
    })
  }
}
