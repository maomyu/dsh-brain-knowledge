/** Co-publish knowledge and its complete recovery ledger in one versioned file operation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type Document, isSeq } from 'yaml'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectGoalRunId } from '@deepseek-ai/dsh-api-task-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import { prepareTruthUpdate } from './update.ts'
import { prepareRootWrite } from './root.ts'
import type { KnowledgeDocumentId, KnowledgeGoalChange, KnowledgeGoalChangeView, KnowledgeGoalReview, KnowledgeGoalRewrite, KnowledgeUpdateId } from './types.ts'

const text = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const rewriteSchema = z.object({ operationId: uuid, expectedVersion: text.nullable(),
  markdown: text, rationale: text, evidence: text }).strict()
const revision = z.number().int().nonnegative()
const reviewSchema = z.object({ operationId: uuid, expectedVersion: text, resolution: z.enum(['confirmed', 'reverted']),
  expectedResumeRevision: revision.optional() }).strict()
const reviewRecord = z.object({ operationId: uuid, at: z.iso.datetime(), resolution: z.enum(['confirmed', 'reverted']),
  resumeRevision: revision.optional(), truthDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
const ledgerSchema = z.array(z.object({
  runId: z.uuid().transform(value => value as ProjectGoalRunId),
  sourceSessionId: text.transform(value => value as SessionId), author: text,
  before: z.string(), after: z.string(),
  rewrites: z.array(z.object({ operationId: uuid, at: z.iso.datetime(), rationale: text,
    snapshot: z.object({ before: z.string(), after: z.string(), evidence: text }).strict().optional() }).strict()).min(1),
  review: reviewRecord.optional(), reviewHistory: z.array(reviewRecord).optional(),
}).strict())
const receiptSchema = z.array(z.object({ operationId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict())

/** Host-verified source ownership; file metadata cannot grant these permissions. */
export interface GoalChangeOwner {
  readonly runId: ProjectGoalRunId
  readonly sourceSessionId: SessionId
  readonly author: string
  readonly resumeRevision: number
}

function refuse(id: KnowledgeDocumentId, reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never {
  throw new RemoteError('knowledge/update', message, { path: id, reason })
}

function bounded(id: KnowledgeDocumentId, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new RemoteError('knowledge/document', 'Complete Goal change, recovery images and history exceed the document byte limit',
      { path: id, reason: 'too-large' })
  }
}

function parsedFile(id: KnowledgeDocumentId, value: string, version: string) {
  const document = parseKnowledgeDocument(id, value, version)
  const page = document.entry.kind === 'page'
  const source = knowledgeSource(value, page)
  const fields = source.frontmatter.value as Record<string, unknown> | null
  const ledger = ledgerSchema.safeParse(fields?.dsh_goal_changes ?? [])
  const receipts = receiptSchema.safeParse(fields?.dsh_goal_change_operations ?? [])
  if (!ledger.success || !receipts.success) return refuse(id, 'identity-conflict', 'Goal knowledge recovery metadata is malformed')
  if (new Set(ledger.data.map(item => item.runId)).size !== ledger.data.length
    || new Set(receipts.data.map(item => item.operationId)).size !== receipts.data.length) {
    refuse(id, 'identity-conflict', 'Goal knowledge recovery identities are ambiguous')
  }
  const recorded = ledger.data.flatMap(item => [...item.rewrites.map(row => row.operationId),
    ...(item.reviewHistory ?? []).map(row => row.operationId), ...(item.review ? [item.review.operationId] : [])])
  if (new Set(recorded).size !== recorded.length || recorded.length !== receipts.data.length
    || recorded.some(operation => !receipts.data.some(receipt => receipt.operationId === operation))) {
    refuse(id, 'identity-conflict', 'Goal knowledge recovery history does not match its operation receipts')
  }
  return { document, source, page, ledger: ledger.data, receipts: receipts.data,
    truth: page ? source.truth.replace(/^<!--\s*compiled_truth\s*-->\s*/, '').trim() : source.truth }
}

function retry(id: KnowledgeDocumentId, receipts: z.infer<typeof receiptSchema>, operationId: KnowledgeUpdateId, digest: string): boolean {
  const receipt = receipts.find(item => item.operationId === operationId)
  if (receipt === undefined) return false
  if (receipt.digest !== digest) refuse(id, 'identity-conflict', 'Goal change operation belongs to different retained input')
  return true
}

function rewriteDigest(id: KnowledgeDocumentId, request: KnowledgeGoalRewrite, owner: GoalChangeOwner): string {
  return createHash('sha256').update(JSON.stringify(['rewrite', id, owner.runId, owner.sourceSessionId, owner.author,
    request.expectedVersion, request.markdown, request.rationale, request.evidence])).digest('hex')
}

function checkRewrite(id: KnowledgeDocumentId, request: KnowledgeGoalRewrite, owner: GoalChangeOwner, maxBytes: number): void {
  bounded(id, JSON.stringify({ request, owner }), maxBytes)
  validateGoalRewrite(id, request)
}

/** Validate intent before a guardrail failure can become a durable refusal.
 * @param id - requested knowledge path.
 * @param request - untrusted replacement intent.
 * @returns after validating the retained identity, version and required content.
 */
export function validateGoalRewrite(id: KnowledgeDocumentId, request: KnowledgeGoalRewrite): void {
  if (!rewriteSchema.safeParse(request).success) refuse(id, 'invalid', 'Goal rewrite requires a UUID, explicit read version or null, complete Markdown, rationale and evidence')
}

function publishMetadata(id: KnowledgeDocumentId, value: string, version: string, changes: readonly KnowledgeGoalChange[],
  receipts: z.infer<typeof receiptSchema>, maxBytes: number): string {
  const page = parseKnowledgeDocument(id, value, version).entry.kind === 'page'
  const source = knowledgeSource(value, page)
  source.frontmatter.document.set('dsh_goal_changes', changes)
  source.frontmatter.document.set('dsh_goal_change_operations', receipts)
  const result = `---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${source.body}\n`
  bounded(id, result, maxBytes)
  parsedFile(id, result, version)
  return result
}

/** Read one run's exact before/after images from the same file as the knowledge body.
 * @param id - authorized knowledge file.
 * @param value - complete bounded file.
 * @param version - observed file version.
 * @param owner - independently authorized Goal source.
 * @returns the accumulated change, or null when this run did not rewrite the file.
 * @throws when recovery metadata is malformed, ambiguous or attributed to another source.
 */
export function readGoalChange(id: KnowledgeDocumentId, value: string, version: string,
  owner: GoalChangeOwner): KnowledgeGoalChange | null {
  return ownedChange(id, parsedFile(id, value, version).ledger, owner)
}

function ownedChange(id: KnowledgeDocumentId, ledger: z.infer<typeof ledgerSchema>, owner: GoalChangeOwner): KnowledgeGoalChange | null {
  const change = ledger.find(item => item.runId === owner.runId)
  if (change === undefined) return null
  if (change.sourceSessionId !== owner.sourceSessionId || change.author !== owner.author) {
    refuse(id, 'identity-conflict', 'Goal change metadata does not match its approved source and master')
  }
  if (change.review !== undefined && (change.review.resumeRevision ?? 0) !== owner.resumeRevision) {
    if ((change.review.resumeRevision ?? 0) > owner.resumeRevision) refuse(id, 'identity-conflict', 'Goal review belongs to a later resume revision')
    return { ...change, review: undefined, reviewHistory: [...change.reviewHistory ?? [], change.review] }
  }
  return change
}

/** Read recovery images and successful autonomous Timeline writes from atomic file receipts.
 * @param id - independently authorized signed file.
 * @param value - complete bounded file, including its retained Timeline and rewrite metadata.
 * @param version - observed file version.
 * @param owner - approved source, master and displayed resume interval.
 * @returns one version-qualified review; root writes, user reversals and other runs never add Timeline counts.
 * @throws when this run's receipt identities or decision attribution are malformed or ambiguous.
 */
export function readGoalFileReview(id: KnowledgeDocumentId, value: string, version: string,
  owner: GoalChangeOwner): KnowledgeGoalChangeView {
  const file = parsedFile(id, value, version)
  const change = ownedChange(id, file.ledger, owner)
  const operations = new Set(change?.rewrites.map(item => item.operationId) ?? [])
  if (file.page) {
    const rows = z.array(z.record(z.string(), z.unknown())).nullable().parse(file.source.timeline.value) ?? []
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.source !== `goal:${owner.runId}` || row.dsh_operation_id === undefined) continue
      const receipt = z.object({ dsh_operation_id: uuid, dsh_request_digest: z.string().regex(/^[a-f0-9]{64}$/),
        kind: z.literal('decision') }).safeParse(row)
      if (!receipt.success || seen.has(receipt.data.dsh_operation_id)) {
        refuse(id, 'identity-conflict', 'Goal Timeline operation receipts are malformed or ambiguous')
      }
      const operationId = receipt.data.dsh_operation_id
      seen.add(operationId)
      if (!operations.has(operationId) && row.author !== owner.author) {
        refuse(id, 'identity-conflict', 'Goal Timeline decision does not match its approved master')
      }
      operations.add(operationId)
    }
  }
  return { documentId: id, version, resumeRevision: owner.resumeRevision, kind: file.page ? 'page' : 'root',
    change, timelineWrites: file.page ? operations.size : 0 }
}

/** Initialize one signed root with its complete body and first-before recovery ledger.
 * @param id - fixed signed root filename; knowledge pages cannot be created here.
 * @param request - retained create-only intent with a null expected version.
 * @param owner - independently authorized RUNNING Goal source and master.
 * @param now - attempted publication timestamp.
 * @param maxBytes - inclusive complete request and resulting file allowance.
 * @returns complete file bytes for exclusive no-replace publication; the first before-image is empty.
 */
export function prepareGoalRootCreation(id: KnowledgeDocumentId, request: KnowledgeGoalRewrite, owner: GoalChangeOwner,
  now: string, maxBytes: number): string {
  checkRewrite(id, request, owner, maxBytes)
  const next = prepareRootWrite(id, null, { operationId: request.operationId, expectedVersion: request.expectedVersion,
    body: request.markdown, reason: request.rationale, source: `goal:${owner.runId}`, evidence: request.evidence }, now, maxBytes, false)
  const version = createHash('sha256').update(next).digest('hex')
  const change: KnowledgeGoalChange = { runId: owner.runId, sourceSessionId: owner.sourceSessionId, author: owner.author,
    before: '', after: parsedFile(id, next, version).truth,
    rewrites: [{ operationId: request.operationId, at: now, rationale: request.rationale,
      snapshot: { before: '', after: parsedFile(id, next, version).truth, evidence: request.evidence } }] }
  return publishMetadata(id, next, version, [change],
    [{ operationId: request.operationId, digest: rewriteDigest(id, request, owner) }], maxBytes)
}

/** Replace authorized knowledge immediately and preserve the first before-image and latest after-image.
 * @param id - signed existing decision page or root path.
 * @param value - complete current file.
 * @param version - exact observed version.
 * @param request - retained intent and supporting rationale.
 * @param owner - Host-derived approved Goal identity and master.
 * @param now - attempted publication time.
 * @param maxBytes - inclusive complete request and file allowance; recovery images are never truncated.
 * @returns one complete replacement file, or undefined for an identical committed retry.
 */
export function prepareGoalRewrite(id: KnowledgeDocumentId, value: string, version: string, request: KnowledgeGoalRewrite,
  owner: GoalChangeOwner, now: string, maxBytes: number): string | undefined {
  checkRewrite(id, request, owner, maxBytes)
  const file = parsedFile(id, value, version)
  const digest = rewriteDigest(id, request, owner)
  if (retry(id, file.receipts, request.operationId, digest)) return undefined
  if (version !== request.expectedVersion) refuse(id, 'conflict', 'Knowledge changed; read it again before rewriting')
  if (file.page && (file.document.entry.status !== 'active' || file.document.entry.category !== 'decision')) {
    refuse(id, 'read-only', 'Goal rewrites require an active decision page or fixed root document')
  }
  const prior = readGoalChange(id, value, version, owner)
  if (prior?.review !== undefined) refuse(id, 'read-only', 'Resume this Goal before rewriting its reviewed knowledge')
  const last = file.ledger.find(item => item.runId === owner.runId)
  const expected = last?.review?.resolution === 'reverted' ? last.before : prior?.after
  const matches = last?.review?.truthDigest === undefined ? expected === file.truth
    : last.review.truthDigest === createHash('sha256').update(file.truth).digest('hex')
  if (prior !== null && !matches) {
    refuse(id, 'conflict', 'Knowledge changed outside this run; preserve the edit and resolve the accumulated change before rewriting')
  }
  const source = `goal:${owner.runId}`
  const next = file.page
    ? prepareTruthUpdate(id, value, version, { operationId: request.operationId, expectedVersion: version,
      truth: request.markdown, kind: 'decision', summary: `Current understanding updated: ${request.rationale}`,
      source, evidence: request.evidence }, now, maxBytes, false)
    : prepareRootWrite(id, { text: value, version }, { operationId: request.operationId, expectedVersion: version,
      body: request.markdown, reason: request.rationale, source, evidence: request.evidence }, now, maxBytes, false)
  /* v8 ignore if -- Expected version already equals this file's content hash; an ordinary retry receipt retains its pre-write version. */
  if (next === undefined) return refuse(id, 'identity-conflict', 'An ordinary knowledge operation already owns this identity')
  const after = parsedFile(id, next, version).truth
  if (after === file.truth) refuse(id, 'invalid', 'Goal knowledge rewrite has no change; record only a supported knowledge increment')
  const change: KnowledgeGoalChange = { runId: owner.runId, sourceSessionId: owner.sourceSessionId, author: owner.author,
    before: prior?.before ?? file.truth, after,
    ...(prior?.reviewHistory === undefined ? {} : { reviewHistory: prior.reviewHistory }),
    rewrites: [...(prior?.rewrites ?? []), { operationId: request.operationId, at: now, rationale: request.rationale,
      snapshot: { before: file.truth, after, evidence: request.evidence } }] }
  return publishMetadata(id, next, version, [...file.ledger.filter(item => item.runId !== owner.runId), change],
    [...file.receipts, { operationId: request.operationId, digest }], maxBytes)
}

/** Keep a displayed change or restore its complete before-image without deleting later Timeline entries.
 * @param id - authorized changed knowledge file.
 * @param value - complete current file.
 * @param version - observed file version.
 * @param request - explicit user resolution and displayed version.
 * @param owner - independently verified terminal Goal source.
 * @param now - attempted review time.
 * @param maxBytes - inclusive complete request and resulting file allowance.
 * @returns one atomic review/body replacement, or undefined for an identical committed retry.
 * @throws if the displayed file is stale or a revert would overwrite a later understanding edit.
 */
export function prepareGoalReview(id: KnowledgeDocumentId, value: string, version: string, request: KnowledgeGoalReview,
  owner: GoalChangeOwner, now: string, maxBytes: number): string | undefined {
  bounded(id, JSON.stringify({ request, owner }), maxBytes)
  if (!reviewSchema.safeParse(request).success) refuse(id, 'invalid', 'Goal review requires a UUID, displayed version and explicit resolution')
  const file = parsedFile(id, value, version)
  const expectedRevision = request.expectedResumeRevision ?? 0
  const digest = createHash('sha256').update(JSON.stringify(['review', id, owner.runId, owner.sourceSessionId, owner.author,
    request.expectedVersion, request.resolution, ...(expectedRevision === 0 ? [] : [expectedRevision])])).digest('hex')
  if (retry(id, file.receipts, request.operationId, digest)) return undefined
  if (expectedRevision !== owner.resumeRevision) refuse(id, 'conflict', 'Goal resumed since this review was displayed; refresh it')
  const change = readGoalChange(id, value, version, owner)
  if (change === null) return refuse(id, 'invalid', 'This run has no accumulated change for the file')
  if (change.review !== undefined) refuse(id, 'read-only', 'This run already reviewed the accumulated change')
  if (version !== request.expectedVersion) refuse(id, 'conflict', 'Knowledge changed since the review was displayed; refresh it')
  let next = value
  if (request.resolution === 'reverted') {
    if (file.truth !== change.after) refuse(id, 'conflict', 'Knowledge changed after this run; reverting would overwrite that edit')
    const explanation = 'User reverted this Goal’s accumulated knowledge rewrite to its pre-run understanding.'
    file.source.frontmatter.document.set('updated', now)
    if (file.page) {
      const timeline: Document = file.source.timeline.document
      if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
      timeline.add({ time: now, kind: 'reversal', summary: explanation, source: `goal:${owner.runId}`,
        author: owner.author, evidence: explanation, affects: [file.document.entry.slug] })
      next = `---\n${file.source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(change.before, timeline.toString({ lineWidth: 0 }))}`
    } else next = `---\n${file.source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${change.before}\n`
  }
  const reviewed = { ...change, review: { operationId: request.operationId, at: now, resolution: request.resolution,
    truthDigest: createHash('sha256').update(request.resolution === 'reverted' ? change.before : file.truth).digest('hex'),
    ...(owner.resumeRevision === 0 ? {} : { resumeRevision: owner.resumeRevision }) } }
  return publishMetadata(id, next, version, file.ledger.map(item => item.runId === owner.runId ? reviewed : item),
    [...file.receipts, { operationId: request.operationId, digest }], maxBytes)
}
