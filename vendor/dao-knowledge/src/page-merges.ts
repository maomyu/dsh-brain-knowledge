/** Durable attributed merge intent; successful publication remains evidenced by the two Markdown files. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parseKnowledgeDocument } from './documents.ts'
import { documentVersion } from './files.ts'
import { knowledgeSource } from './source.ts'
import { prepareTruthUpdate } from './update.ts'
import { preparePageArchive } from './archive.ts'
import { readImportPublicationHold } from './import-publication-hold.ts'
import { readTaskPublicationHold } from './task-publication-hold.ts'
import { readGoalPublicationHold } from './goal-publication-hold.ts'
import type { KnowledgeDocument, KnowledgeDocumentId, KnowledgeLocation, KnowledgeLocationRevision, KnowledgeUpdateId,
  KnowledgePageMergeRequest, KnowledgePageMergeReview, KnowledgePageMergeStage, KnowledgePageMergeList,
  KnowledgePageMergeCurrent, KnowledgeTruthUpdate, KnowledgePageArchive, KnowledgePageMergeAbandon,
  KnowledgePageMergeSummary } from './types.ts'

/** Storage and complete human-result bounds; reaching capacity never evicts prior recovery intent. */
export interface KnowledgePageMergePolicy {
  /** Maximum retained operations across this Host, including completed records. */
  readonly maxRecords: number
  /** Inclusive bytes for each complete durable record, approval or detail response. */
  readonly maxRecordBytes: number
  /** Inclusive complete listing bytes; omitted summaries remain retained and counted. */
  readonly maxListBytes: number
}

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const text = z.string().refine(value => !value.includes('\0'))
const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const path = nonempty.refine(value => value.startsWith('pages/') && value.endsWith('.md')
  && !/[\\:\0]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
  .transform(value => value as KnowledgeDocumentId)
const pageInput = z.object({ documentId: path, expectedVersion: nonempty }).strict()
const requestSchema = z.object({ operationId: uuid, target: pageInput, source: pageInput,
  truth: nonempty, summary: nonempty, evidence: nonempty, note: nonempty }).strict()
  .refine(value => value.target.documentId !== value.source.documentId)
const stageSchema = z.enum(['prepared', 'target-written', 'source-archived', 'complete'])
const abandonSchema = z.object({ operationId: uuid, note: nonempty }).strict()
const abandonmentSchema = abandonSchema.extend({ at: z.iso.datetime() }).strict()
const hostPath = nonempty.refine(isAbsolute)
const initiatorSchema = z.object({ sessionId: nonempty.transform(value => value as SessionId), source: nonempty }).strict()
  .refine(value => value.source.startsWith(`session:${value.sessionId}/message:`))
const recordSchema = z.object({
  workspaceId: nonempty.transform(value => value as WorkspaceId), projectPath: hostPath, brainPath: hostPath,
  locationRevision: z.uuid().transform(value => value as KnowledgeLocationRevision).nullable(),
  request: requestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(),
  targetOperationId: uuid, sourceOperationId: uuid,
  before: z.object({ target: text, source: text }).strict(),
  after: z.object({ target: text, source: text }).strict(),
  lastConfirmedStage: stageSchema, lastError: nonempty.nullable(),
  // Absent in original v1 rows; reads project null without rewriting their saved data.
  abandonment: abandonmentSchema.nullable().optional(),
  // Original v1 records remain human-owned; model callers cannot supply this Host-derived field.
  initiator: initiatorSchema.optional(),
}).strict().refine(value => new Set([value.request.operationId, value.targetOperationId, value.sourceOperationId,
  ...value.abandonment == null ? [] : [value.abandonment.operationId]]).size === (value.abandonment == null ? 3 : 4)
    && (value.abandonment == null || value.lastConfirmedStage !== 'complete'))

/** Complete immutable approval inputs plus acknowledged progress; schema corruption fails at domain open. */
export type PageMergeRecord = z.infer<typeof recordSchema>

/** Host-derived model owner, distinct from the request's authored rationale and evidence. */
export type PageMergeInitiator = z.infer<typeof initiatorSchema>

/** Independent operation ownership survives missing pages without treating the journal as current knowledge. */
export const knowledgePageMergeDomain = defineDomain({ name: 'knowledge_page_merges', version: 1,
  tables: { operations: domainTable<KnowledgeUpdateId, PageMergeRecord>(recordSchema) } })

/** One complete, version-checked current file observation. */
export interface PageMergeFile {
  readonly text: string
  readonly version: string
  readonly document: KnowledgeDocument
}

/** Controller closures retain the current project/Brain authority and own filesystem publication. */
export interface PageMergeOperations {
  readonly location: KnowledgeLocation
  readonly initiator?: PageMergeInitiator
  /** Recheck project, selected Brain and initiating caller before an admitted action. */
  authorize(): void
  /** Read a complete current page.
   * @param id - one of the selected Brain-relative identities.
   * @returns complete text and its validated document/version.
   */
  read(id: KnowledgeDocumentId): Promise<PageMergeFile>
  /** Publish a single guarded file while preserving another writer's changes.
   * @param id - exact selected identity.
   * @param before - complete expected file.
   * @param after - complete previously approved result.
   * @param kind - distinguishes truth accounting from archival.
   * @returns after the atomic writer and its accounting settle.
   */
  publish(id: KnowledgeDocumentId, before: string, after: string, kind: 'truth' | 'archive'): Promise<void>
  /** Refresh the derived index after both file receipts exist.
   * @returns after guarded catalog publication.
   */
  reindex(): Promise<void>
}

function fail(reason: 'invalid' | 'identity-conflict' | 'not-found' | 'capacity', message: string): never {
  throw new RemoteError('knowledge/merge', message, { reason })
}

function digest(request: KnowledgePageMergeRequest): string {
  return createHash('sha256').update(JSON.stringify(requestSchema.parse(request))).digest('hex')
}

function bounded<T>(value: T, limit: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) fail('capacity', 'Complete page merge data exceeds its configured byte limit')
  return value
}

function publication(record: PageMergeRecord): { target: KnowledgeTruthUpdate; source: KnowledgePageArchive } {
  const request = record.request
  const sourceReference = record.initiator?.source ?? `user:knowledge-page-merge/${request.operationId}`
  const rationale = record.initiator === undefined ? 'Human confirmation' : 'AI consolidation rationale'
  const evidence = `${request.evidence}\n\n${rationale}: ${request.note}\nPages: ${request.source.documentId} -> ${request.target.documentId}`
  return {
    target: { operationId: record.targetOperationId, expectedVersion: request.target.expectedVersion,
      truth: request.truth, kind: 'reversal', summary: request.summary, source: sourceReference, evidence },
    source: { operationId: record.sourceOperationId, expectedVersion: request.source.expectedVersion,
      supersededBy: request.target.documentId, source: sourceReference, evidence },
  }
}

function assertInitiator(record: PageMergeRecord, operations: PageMergeOperations): void {
  if (!sameInitiator(record, operations)) {
    fail('identity-conflict', 'Page merge belongs to another initiating conversation or caller')
  }
}

function sameInitiator(record: PageMergeRecord, operations: PageMergeOperations): boolean {
  return record.initiator?.sessionId === operations.initiator?.sessionId && record.initiator?.source === operations.initiator?.source
}

/** Refuse routing unreviewed draft or conflict content into an active retained page.
 * @param page - complete file captured before publication.
 */
export function requireMergeableActivePage(page: PageMergeFile): void {
  const metadata = knowledgeSource(page.text, true).frontmatter.value
  if (page.document.entry.kind !== 'page' || page.document.entry.status !== 'active'
    || page.document.entry.pendingProposalCount !== 0 || readImportPublicationHold(metadata) !== null
    || readTaskPublicationHold(metadata) !== null || readGoalPublicationHold(metadata) !== null) {
    fail('invalid', 'AI consolidation requires active pages without publication holds or unresolved proposals')
  }
}

function sameLocation(record: PageMergeRecord, location: KnowledgeLocation): boolean {
  return record.projectPath === location.projectPath && record.brainPath === location.path && record.locationRevision === location.revision
}

function pages(record: PageMergeRecord): { target: KnowledgeDocument; source: KnowledgeDocument } {
  return { target: parseKnowledgeDocument(record.request.target.documentId, record.before.target, record.request.target.expectedVersion),
    source: parseKnowledgeDocument(record.request.source.documentId, record.before.source, record.request.source.expectedVersion) }
}

function summary(record: PageMergeRecord): KnowledgePageMergeSummary {
  const baseline = pages(record)
  return { operationId: record.request.operationId, at: record.at,
    target: { documentId: record.request.target.documentId, title: baseline.target.entry.title },
    source: { documentId: record.request.source.documentId, title: baseline.source.entry.title },
    summary: record.request.summary, lastConfirmedStage: record.lastConfirmedStage,
    abandonment: record.abandonment ?? null, previewOmitted: false }
}

function compact(entry: KnowledgePageMergeSummary): KnowledgePageMergeSummary {
  return { ...entry, target: { ...entry.target, title: '' }, source: { ...entry.source, title: '' }, summary: '', previewOmitted: true }
}

/** File-verified state, distinct from a possibly lagging acknowledgement in the durable journal. */
interface Observation {
  readonly current: KnowledgePageMergeReview['current']
  readonly stage: KnowledgePageMergeStage | null
  readonly blockedReason: string | null
}

/** Host-owned record admission, bounded discovery and explicit continuation; it starts no background work. */
export class KnowledgePageMergeStore {
  private reservation: Promise<unknown> = Promise.resolve()

  /** @param table - domain table closed only after all controller operations have settled.
   * @param policy - complete record/list bytes and retained record count.
   * @param maxDocumentBytes - existing knowledge file/request bound, applied before every planned publication.
   */
  constructor(private readonly table: KvTable<KnowledgeUpdateId, PageMergeRecord>, private readonly policy: KnowledgePageMergePolicy,
    private readonly maxDocumentBytes: number) {
    const entries = [...table.entries()]
    if (entries.length > policy.maxRecords) fail('capacity', 'Retained page merges exceed the configured operation count')
    for (const [id, record] of entries) {
      bounded(record, policy.maxRecordBytes)
      if (id !== record.request.operationId || record.digest !== digest(record.request)) fail('identity-conflict', 'Page merge identity is inconsistent')
    }
  }

  /** Validate retained planned files against their immutable approval before serving any operation.
   * @returns after all stored before-images, versions and prepared publications have been checked.
   */
  async initialize(): Promise<void> {
    for (const [, record] of this.table.entries()) {
      const location: KnowledgeLocation = { workspaceId: record.workspaceId, projectPath: record.projectPath, path: record.brainPath,
        revision: record.locationRevision, directory: record.brainPath, isDefault: false }
      const baseline = pages(record), prepared = publication(record)
      if (record.initiator !== undefined) {
        requireMergeableActivePage({ text: record.before.target, version: record.request.target.expectedVersion,
          document: baseline.target })
        requireMergeableActivePage({ text: record.before.source, version: record.request.source.expectedVersion,
          document: baseline.source })
      }
      if (baseline.target.entry.kind !== 'page' || baseline.source.entry.kind !== 'page'
        || baseline.target.entry.status === 'archived' || baseline.source.entry.status === 'archived'
        || documentVersion(record.before.target, location) !== record.request.target.expectedVersion
        || documentVersion(record.before.source, location) !== record.request.source.expectedVersion
        || prepareTruthUpdate(record.request.target.documentId, record.before.target, record.request.target.expectedVersion,
          prepared.target, record.at, this.maxDocumentBytes) !== record.after.target
        || await preparePageArchive(record.request.source.documentId, record.before.source, record.request.source.expectedVersion,
          prepared.source, record.at, this.maxDocumentBytes, () => Promise.resolve(baseline.target.entry.slug)) !== record.after.source) {
        fail('identity-conflict', 'Retained page merge files do not match their approval')
      }
    }
  }

  /** Read an owned operation without accepting another project's identity.
   * @param workspaceId - current registered project.
   * @param operationId - original merge UUID.
   * @returns retained record; no absent default is published.
   */
  get(workspaceId: WorkspaceId, operationId: KnowledgeUpdateId): PageMergeRecord {
    const record = this.table.get(operationId)
    if (record === undefined) fail('not-found', 'No page merge intent is retained under this operation identity')
    if (record.workspaceId !== workspaceId) fail('identity-conflict', 'Page merge belongs to another project')
    return record
  }

  /** List complete retained summaries without reading pages or resuming writes.
   * @param workspaceId - current registered project.
   * @returns every count and a byte-bounded summary prefix; stage is the last durable acknowledgement only.
   */
  list(workspaceId: WorkspaceId): KnowledgePageMergeList {
    const records = [...this.table.entries()].map(([, record]) => record).filter(record => record.workspaceId === workspaceId)
      .sort((a, b) => Number(a.lastConfirmedStage === 'complete' || a.abandonment != null)
        - Number(b.lastConfirmedStage === 'complete' || b.abandonment != null)
        || b.at.localeCompare(a.at) || a.request.operationId.localeCompare(b.request.operationId))
    const result: {
      workspaceId: WorkspaceId
      count: number
      entries: KnowledgePageMergeList['entries'][number][]
      omitted: number
      countComplete: boolean
    } = { workspaceId, count: records.length, entries: [], omitted: records.length, countComplete: true }
    bounded(result, this.policy.maxListBytes)
    for (const record of records) {
      let entry = summary(record)
      let candidate = { ...result, entries: [...result.entries, entry], omitted: result.omitted - 1 }
      if (Buffer.byteLength(JSON.stringify(candidate)) > this.policy.maxListBytes) {
        entry = compact(entry)
        bounded({ ...result, entries: [entry] }, this.policy.maxListBytes)
        candidate = { ...result, entries: [...result.entries, entry], omitted: result.omitted - 1 }
      }
      if (Buffer.byteLength(JSON.stringify(candidate)) > this.policy.maxListBytes) continue
      result.entries.push(entry)
      result.omitted--
    }
    return result
  }

  /** Freeze validated full input and both before/after files before the first knowledge publication.
   * @param request - explicit human request, validated as wire data.
   * @param operations - current authority and real filesystem callbacks.
   * @param signal - cancels before journal publication or file work.
   * @returns retained operation, recognizing exact retries before validating later file versions.
   */
  async prepare(request: KnowledgePageMergeRequest, operations: PageMergeOperations, signal: AbortSignal): Promise<PageMergeRecord> {
    const parsed = requestSchema.safeParse(bounded(request, this.policy.maxRecordBytes))
    if (!parsed.success) fail('invalid', 'Page merge requires distinct ordinary pages, versions, complete understanding and human evidence')
    const input = parsed.data
    const task = this.reservation.catch(() => undefined).then(async () => {
      signal.throwIfAborted()
      const prior = this.table.get(input.operationId)
      if (prior !== undefined) {
        assertInitiator(prior, operations)
        if (prior.workspaceId !== operations.location.workspaceId || prior.digest !== digest(input)) {
          fail('identity-conflict', 'Page merge identity belongs to different retained input')
        }
        return prior
      }
      for (const [, saved] of this.table.entries()) {
        if ([saved.targetOperationId, saved.sourceOperationId, saved.abandonment?.operationId].includes(input.operationId)) {
          fail('identity-conflict', 'Page merge UUID already belongs to a retained child operation or terminal decision')
        }
      }
      if ([...this.table.keys()].length >= this.policy.maxRecords) fail('capacity', 'Page merge operation capacity is full; no history was discarded')
      const target = await operations.read(input.target.documentId), source = await operations.read(input.source.documentId)
      for (const [page, selected] of [[target, input.target], [source, input.source]] as const) {
        if (operations.initiator !== undefined) requireMergeableActivePage(page)
        if (page.document.entry.kind !== 'page' || page.document.entry.status === 'archived') fail('invalid', 'Merge requires two non-archived ordinary pages')
        if (page.version !== selected.expectedVersion) throw new RemoteError('knowledge/update', 'Page changed; review both pages before confirming a merge',
          { path: selected.documentId, reason: 'conflict' })
      }
      const location = operations.location
      const record: PageMergeRecord = { workspaceId: location.workspaceId, projectPath: location.projectPath,
        brainPath: location.path, locationRevision: location.revision, request: input, digest: digest(input), at: new Date().toISOString(),
        targetOperationId: randomUUID() as KnowledgeUpdateId, sourceOperationId: randomUUID() as KnowledgeUpdateId,
        before: { target: target.text, source: source.text }, after: { target: '', source: '' }, lastConfirmedStage: 'prepared',
        lastError: null, abandonment: null, ...operations.initiator === undefined ? {} : { initiator: operations.initiator } }
      const prepared = publication(record)
      const targetAfter = prepareTruthUpdate(input.target.documentId, target.text, target.version,
        prepared.target, record.at, this.maxDocumentBytes)
      const sourceAfter = await preparePageArchive(input.source.documentId, source.text, source.version, prepared.source,
        record.at, this.maxDocumentBytes, () => Promise.resolve(target.document.entry.slug))
      /* v8 ignore if -- A prior receipt's digest contains its before-version, not this current content version. */
      if (targetAfter === undefined || sourceAfter === undefined) fail('identity-conflict', 'A generated merge child UUID already exists in page history')
      record.after = { target: targetAfter, source: sourceAfter }
      bounded(record, this.policy.maxRecordBytes)
      // Both complete detail projections must remain readable before any durable intent is admitted.
      const before = pages(record)
      bounded({ workspaceId: record.workspaceId, operationId: input.operationId, at: record.at, request: input, baseline: before,
        current: { target: { status: 'available', document: parseKnowledgeDocument(input.target.documentId, record.after.target, target.version) },
          source: { status: 'available', document: parseKnowledgeDocument(input.source.documentId, record.after.source, source.version) } },
        stage: 'prepared', lastConfirmedStage: 'prepared', abandonment: null,
        canContinue: true, blockedReason: null, lastError: null }, this.policy.maxRecordBytes)
      signal.throwIfAborted()
      operations.authorize()
      await this.table.put(input.operationId, record)
      return record
    })
    this.reservation = task
    return task
  }

  private async observe(record: PageMergeRecord, operations: PageMergeOperations, signal: AbortSignal): Promise<Observation> {
    const unavailable = (reason: string): KnowledgePageMergeCurrent => ({ status: 'unavailable', reason })
    if (!sameLocation(record, operations.location)) return { stage: null, blockedReason: 'Project or Brain location changed; this intent cannot be retargeted',
      current: { target: unavailable('Retained Brain location is no longer selected'), source: unavailable('Retained Brain location is no longer selected') } }
    const read = async (id: KnowledgeDocumentId): Promise<PageMergeFile | string> => {
      try { return await operations.read(id) } catch (error) { signal.throwIfAborted(); return String(error) }
    }
    const target = await read(record.request.target.documentId), source = await read(record.request.source.documentId)
    const current = { target: typeof target === 'string' ? unavailable(target) : { status: 'available' as const, document: target.document },
      source: typeof source === 'string' ? unavailable(source) : { status: 'available' as const, document: source.document } }
    if (typeof target === 'string' || typeof source === 'string') return { current, stage: null, blockedReason: 'A retained page is unavailable; no publication is permitted' }
    const prepared = publication(record)
    let targetApplied = false, sourceApplied = false
    try {
      const timeline = knowledgeSource(target.text, true).timeline.value as Record<string, unknown>[] | null
      if (timeline?.some(row => row.dsh_operation_id === record.targetOperationId)) {
        targetApplied = prepareTruthUpdate(record.request.target.documentId, target.text, target.version,
          prepared.target, record.at, this.maxDocumentBytes) === undefined
      }
      const fields = knowledgeSource(source.text, true).frontmatter.value as Record<string, unknown> | null
      const receipts: unknown[] = Array.isArray(fields?.dsh_archive_operations) ? fields.dsh_archive_operations : []
      if (receipts.some(row => typeof row === 'object' && row !== null && 'id' in row && row.id === record.sourceOperationId)) {
        sourceApplied = await preparePageArchive(record.request.source.documentId, source.text, source.version,
          prepared.source, record.at, this.maxDocumentBytes,
          /* v8 ignore next -- The retained receipt returns before replacement lookup, or throws when its digest conflicts. */
          () => Promise.resolve(target.document.entry.slug)) === undefined
      }
    } catch (error) { signal.throwIfAborted(); return { current, stage: null, blockedReason: `Page merge receipts are inconsistent: ${String(error)}` } }
    if (sourceApplied && targetApplied) return { current,
      stage: record.lastConfirmedStage === 'complete' ? 'complete' : 'source-archived', blockedReason: null }
    if (sourceApplied || (record.lastConfirmedStage !== 'prepared' && !targetApplied)
      || record.lastConfirmedStage === 'source-archived' || record.lastConfirmedStage === 'complete') {
      return { current, stage: null, blockedReason: 'Previously confirmed page merge receipts are missing or inconsistent' }
    }
    const stage = targetApplied ? 'target-written' : 'prepared'
    const targetExpected = targetApplied ? documentVersion(record.after.target, operations.location) : record.request.target.expectedVersion
    if (target.version !== targetExpected || source.version !== record.request.source.expectedVersion) {
      return { current, stage, blockedReason: 'A page changed after the retained approval; review it separately instead of overwriting it' }
    }
    /* v8 ignore if -- These complete versions already match the retained non-archived before-images or the known target after-image. */
    if (target.document.entry.status === 'archived' || source.document.entry.status === 'archived') {
      return { current, stage, blockedReason: 'An involved page is archived outside this merge' }
    }
    return { current, stage, blockedReason: null }
  }

  /** Inspect original approval and current receipts without saving progress or continuing work.
   * @param record - owned durable record.
   * @param operations - current read authority; publication callbacks are not invoked.
   * @param signal - cancels reads.
   * @returns full human-only comparison and file-verified continuation eligibility.
   */
  async review(record: PageMergeRecord, operations: PageMergeOperations, signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    const current = this.get(record.workspaceId, record.request.operationId)
    const observed = await this.observe(current, operations, signal)
    signal.throwIfAborted()
    operations.authorize()
    return bounded({ workspaceId: current.workspaceId, operationId: current.request.operationId, at: current.at, request: current.request,
      baseline: pages(current), current: observed.current, stage: observed.stage, lastConfirmedStage: current.lastConfirmedStage,
      abandonment: current.abandonment ?? null,
      canContinue: sameInitiator(current, operations) && current.abandonment == null
        && observed.blockedReason === null && observed.stage !== null && observed.stage !== 'complete',
      blockedReason: observed.blockedReason, lastError: current.lastError }, this.policy.maxRecordBytes)
  }

  /** End a retained attempt without changing either file or its publication acknowledgements.
   * @param record - project-owned merge; the latest durable value is reread before deciding.
   * @param decision - new UUID and nonempty human note, fixed across uncertain retries.
   * @param operations - current caller and project authority; missing or changed pages do not prevent the decision.
   * @param signal - cancels before domain publication; the controller joins admitted storage work.
   * @returns current observations and the retained terminal decision; no rollback or automatic continuation occurs.
   * @throws for completed operations, conflicting decisions, malformed input or capacity failures.
   */
  async abandon(record: PageMergeRecord, decision: KnowledgePageMergeAbandon, operations: PageMergeOperations,
    signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    const task = this.reservation.catch(() => undefined).then(() => this.abandonCurrent(record, decision, operations, signal))
    this.reservation = task
    return task
  }

  private async abandonCurrent(record: PageMergeRecord, decision: KnowledgePageMergeAbandon, operations: PageMergeOperations,
    signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    const parsed = abandonSchema.safeParse(bounded(decision, this.policy.maxRecordBytes))
    if (!parsed.success) fail('invalid', 'Ending a page merge requires a decision UUID and nonempty note')
    const input = parsed.data
    const current = this.get(record.workspaceId, record.request.operationId)
    signal.throwIfAborted()
    operations.authorize()
    if (current.abandonment != null) {
      if (current.abandonment.operationId !== input.operationId || current.abandonment.note !== input.note) {
        fail('identity-conflict', 'This page merge already has a different terminal decision')
      }
      return this.review(current, operations, signal)
    }
    if (current.lastConfirmedStage === 'complete') fail('invalid', 'A completed page merge cannot be abandoned')
    for (const [, saved] of this.table.entries()) {
      const ownedIds = [saved.request.operationId, saved.targetOperationId, saved.sourceOperationId, saved.abandonment?.operationId]
      if (ownedIds.includes(input.operationId)) {
        fail('identity-conflict', 'The decision UUID already belongs to a retained page merge operation')
      }
    }
    const abandonment = { ...input, at: new Date().toISOString() }
    const next = bounded({ ...current, abandonment }, this.policy.maxRecordBytes)
    const review = bounded({ ...await this.review(current, operations, signal), abandonment, canContinue: false },
      this.policy.maxRecordBytes)
    bounded({ workspaceId: current.workspaceId, count: this.policy.maxRecords, entries: [compact(summary(next))],
      omitted: this.policy.maxRecords, countComplete: true }, this.policy.maxListBytes)
    signal.throwIfAborted()
    operations.authorize()
    await this.table.update(current.request.operationId, (latest) => {
      if (latest.abandonment != null || latest.lastConfirmedStage !== current.lastConfirmedStage) {
        fail('identity-conflict', 'Page merge changed before its terminal decision was saved')
      }
      return bounded({ ...latest, abandonment }, this.policy.maxRecordBytes)
    })
    return review
  }

  private async acknowledge(record: PageMergeRecord, stage: KnowledgePageMergeStage,
    error: string | null = null): Promise<PageMergeRecord> {
    return this.table.update(record.request.operationId,
      current => current.abandonment != null ? current
        : bounded({ ...current, lastConfirmedStage: stage, lastError: error }, this.policy.maxRecordBytes))
  }

  /** Continue only the original approved intent; uncertain file writes are reconciled from receipts before another step.
   * @param record - owned complete approval, including both child UUIDs.
   * @param operations - current project admission and guarded file publishers.
   * @param signal - cancellation stops before the next stage and joins admitted work.
   * @returns actual complete, blocked or partially completed state; no automatic rollback or retry is performed.
   */
  async continue(record: PageMergeRecord, operations: PageMergeOperations, signal: AbortSignal): Promise<KnowledgePageMergeReview> {
    assertInitiator(record, operations)
    let current = this.get(record.workspaceId, record.request.operationId)
    try {
      for (;;) {
        const review = await this.review(current, operations, signal)
        if (!review.canContinue || review.stage === null) return review
        if (review.stage !== current.lastConfirmedStage) current = await this.acknowledge(current, review.stage)
        signal.throwIfAborted()
        operations.authorize()
        switch (review.stage) {
          case 'prepared':
            await operations.publish(current.request.target.documentId, current.before.target, current.after.target, 'truth')
            break
          case 'target-written':
            await operations.publish(current.request.source.documentId, current.before.source, current.after.source, 'archive')
            break
          case 'source-archived':
            await operations.reindex()
            current = await this.acknowledge(current, 'complete')
            return await this.review(current, operations, signal)
          /* v8 ignore next -- This same review's canContinue excludes the complete stage. */
          case 'complete': return review
        }
      }
    } catch (error) {
      // An admitted publication can outlive cancellation; preserve the original intent and let the next read reconcile receipts.
      if (signal.aborted) throw error
      try { current = await this.acknowledge(current, current.lastConfirmedStage, String(error)) } catch (storageError) {
        throw new AggregateError([error, storageError], 'Page merge stopped and its failure acknowledgement could not be retained')
      }
      return this.review(current, operations, signal)
    }
  }
}
