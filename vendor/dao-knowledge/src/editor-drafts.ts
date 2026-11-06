/** Private human editor inputs and deletion revisions, independent from knowledge files and publication receipts. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ROOT_DOCUMENTS } from './root-records.ts'
import type { KnowledgeDocumentId, KnowledgeDraft, KnowledgeDraftIdentity, KnowledgeDraftRevision, KnowledgeUpdateId,
  KnowledgeEditorDraftList, KnowledgeEditorDraftPolicy, KnowledgeEditorDraftRemoval, KnowledgeEditorDraftRow,
  KnowledgeEditorDraftSave } from './types.ts'

const nonempty = z.string().min(1).refine(value => !value.includes('\0'))
const workspace = nonempty.transform(value => value as WorkspaceId)
const updateId = z.uuid().transform(value => value as KnowledgeUpdateId)
const revision = z.uuid().transform(value => value as KnowledgeDraftRevision)
const page = nonempty.refine(value => value.startsWith('pages/') && value.endsWith('.md')
  && !/[\\:]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
  .transform(value => value as KnowledgeDocumentId)
const documentId = nonempty.refine(value => ROOT_DOCUMENTS.some(root => root === value) || page.safeParse(value).success)
  .transform(value => value as KnowledgeDocumentId)
const root = nonempty.refine(value => ROOT_DOCUMENTS.some(path => path === value))
  .transform(value => value as KnowledgeDocumentId)
const hostPath = nonempty.refine(isAbsolute)
const action = z.enum(['keep', 'replace', 'merge'])
const identity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proposal'), documentId, proposalId: updateId }).strict(),
  z.object({ kind: z.literal('merge'), documentId: page }).strict(),
  z.object({ kind: z.literal('direct'), documentId: page }).strict(),
  z.object({ kind: z.literal('root'), documentId: root }).strict(),
])
const disposition = z.object({ operationId: updateId, at: z.string(), action, note: z.string() }).strict()
const proposal = z.object({ operationId: updateId, at: z.string(), before: z.string(), proposed: z.string(),
  summary: z.string(), source: z.string(), evidence: z.string(), resolution: disposition.nullable() }).strict()
const review = z.object({ documentId, version: nonempty, current: z.string(),
  archived: z.boolean(), proposals: z.array(proposal) }).strict()
  .refine(value => new Set(value.proposals.map(item => item.operationId)).size === value.proposals.length)
const resolutionInput = z.object({ operationId: updateId, expectedVersion: nonempty, proposalId: updateId, note: z.string() })
const resolution = z.discriminatedUnion('action', [
  resolutionInput.extend({ action: z.enum(['keep', 'replace']), truth: z.null() }).strict(),
  resolutionInput.extend({ action: z.literal('merge'), truth: z.string() }).strict(),
])
const timeline = z.object({ time: z.string(), kind: z.string(), summary: z.string(), source: z.string().nullable(),
  affects: z.array(z.string()), evidence: z.string().nullable(), author: z.string().optional(),
  sourceSessionId: nonempty.transform(value => value as SessionId).optional() }).strict().transform((value) => {
  const { sourceSessionId, ...rest } = value
  return sourceSessionId === undefined ? rest : { ...rest, sourceSessionId }
})
const document = z.object({
  entry: z.object({ id: documentId, slug: z.string(), title: z.string(), kind: z.enum(['root', 'page']),
    status: z.enum(['active', 'draft', 'archived']), category: z.string().nullable(), tags: z.array(z.string()),
    createdAt: z.string().nullable(), updatedAt: z.string().nullable(), version: nonempty,
    pendingProposalCount: z.number().int().nonnegative(), references: z.array(z.string()),
    summary: z.string(), searchText: z.string() }).strict(),
  body: z.string(), markdown: z.string(), timeline: z.array(timeline),
  // The read Remote supplies native-file metadata in addition to the editor's KnowledgeDocument fields.
  file: z.object({ path: hostPath, canReveal: z.boolean() }).strict().optional(),
}).strict().transform((value) => {
  const { file, ...rest } = value
  return file === undefined ? rest : { ...rest, file }
})
const mergePage = z.object({ documentId: page, expectedVersion: nonempty }).strict()
const merge = z.object({ operationId: updateId, target: mergePage, source: mergePage,
  truth: z.string(), summary: z.string(), evidence: z.string(), note: z.string() }).strict()
  .refine(value => value.target.documentId !== value.source.documentId)
const changeKind = z.enum(['decision', 'observation', 'source', 'reversal', 'evidence'])
const truthUpdate = z.object({ operationId: updateId, expectedVersion: nonempty, truth: z.string(),
  kind: changeKind, summary: z.string(), source: z.string(), evidence: z.string() }).strict()
const rootWrite = z.object({ operationId: updateId, expectedVersion: nonempty, body: z.string(),
  reason: z.string(), source: z.string(), evidence: z.string() }).strict()
const draftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proposal'), workspaceId: workspace, documentId, proposalId: updateId,
    baseline: review, proposal, action: action.nullable(), truth: z.string(), note: z.string(),
    confirmation: resolution.nullable(), attempted: z.boolean() }).strict().refine(value =>
    value.baseline.documentId === value.documentId && value.proposal.operationId === value.proposalId
    && (value.confirmation === null ? !value.attempted : value.confirmation.proposalId === value.proposalId)),
  z.object({ kind: z.literal('merge'), workspaceId: workspace, documentId: page,
    baseline: z.object({ target: document, source: document.nullable() }).strict(), sourceId: page.nullable(),
    truth: z.string(), summary: z.string(), evidence: z.string(), note: z.string(),
    confirmation: merge.nullable(), attempted: z.boolean() }).strict().refine(value =>
    value.baseline.target.entry.id === value.documentId && value.baseline.target.entry.kind === 'page'
    && value.sourceId !== value.documentId
    && (value.baseline.source === null || value.baseline.source.entry.kind === 'page')
    && (!value.attempted || value.baseline.source?.entry.id === value.sourceId)
    && (value.confirmation === null ? !value.attempted
      : value.confirmation.target.documentId === value.documentId && value.confirmation.source.documentId === value.sourceId)),
  z.object({ kind: z.literal('direct'), workspaceId: workspace, documentId: page,
    baseline: document, truth: z.string(), kindOfChange: changeKind, summary: z.string(), evidence: z.string(),
    confirmation: truthUpdate.nullable(), attempted: z.boolean() }).strict().refine(value =>
    value.baseline.entry.id === value.documentId && value.baseline.entry.kind === 'page'
    && value.baseline.entry.status !== 'archived'
    && (value.confirmation === null ? !value.attempted
      : value.confirmation.expectedVersion === value.baseline.entry.version
        && value.confirmation.truth === value.truth.replaceAll('\r\n', '\n').trim()
        && value.confirmation.kind === value.kindOfChange
        && value.confirmation.summary === value.summary.trim()
        && value.confirmation.evidence === value.evidence.trim())),
  z.object({ kind: z.literal('root'), workspaceId: workspace, documentId: root,
    baseline: document, body: z.string(), reason: z.string(), evidence: z.string(),
    confirmation: rootWrite.nullable(), attempted: z.boolean() }).strict().refine(value =>
    value.baseline.entry.id === value.documentId && value.baseline.entry.kind === 'root'
    && value.baseline.entry.status !== 'archived'
    && (value.confirmation === null ? !value.attempted
      : value.confirmation.expectedVersion === value.baseline.entry.version
        && value.confirmation.body === value.body.replaceAll('\r\n', '\n').trim()
        && value.confirmation.reason === value.reason.trim()
        && value.confirmation.evidence === value.evidence.trim()
        && value.confirmation.source === 'user:root-editor')),
])
const recordSchema = z.object({ workspaceId: workspace, projectPath: hostPath, identity, revision, draft: draftSchema.nullable() }).strict()
  .refine(value => value.draft === null || (value.draft.workspaceId === value.workspaceId
    && identityKey(value.identity) === identityKey(value.draft)))

/** Full durable row; a null draft retains the identity's deletion revision. */
export type KnowledgeEditorDraftRecord = z.infer<typeof recordSchema>

/** Human-only draft retention has no Brain, model, or browser-settings publication. */
export const knowledgeEditorDraftDomain = defineDomain({ name: 'knowledge_editor_drafts', version: 1,
  tables: { drafts: domainTable<string, KnowledgeEditorDraftRecord>(recordSchema) } })

function identityKey(value: KnowledgeDraftIdentity): string {
  return JSON.stringify([value.kind, value.documentId, value.kind === 'proposal' ? value.proposalId : null])
}

function key(workspaceId: WorkspaceId, value: KnowledgeDraftIdentity): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, identityKey(value)])).digest('hex')
}

function selectedIdentity(draft: KnowledgeDraft): KnowledgeDraftIdentity {
  return draft.kind === 'proposal'
    ? { kind: draft.kind, documentId: draft.documentId, proposalId: draft.proposalId }
    : { kind: draft.kind, documentId: draft.documentId }
}

function fail(reason: 'invalid' | 'conflict' | 'identity-conflict' | 'capacity' | 'disabled', message: string): never {
  throw new RemoteError('knowledge/draft', message, { reason })
}

function bounded(value: unknown, limit: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) fail('capacity', 'Complete knowledge editor draft data exceeds its configured byte limit')
}

function row(record: KnowledgeEditorDraftRecord): KnowledgeEditorDraftRow {
  return structuredClone({ identity: record.identity, revision: record.revision, draft: record.draft })
}

/** Host-wide compare-and-set admission; controller disposal drains calls before closing the domain. */
export class KnowledgeEditorDraftStore {
  private pending: Promise<unknown> = Promise.resolve()

  /** @param table - initialized and strictly parsed private draft records.
   * @param policy - complete record, complete project list, and retained identity limits.
   */
  constructor(private readonly table: KvTable<string, KnowledgeEditorDraftRecord>, private readonly policy: KnowledgeEditorDraftPolicy) {
    if (table.size > policy.maxRecords) fail('capacity', 'Retained knowledge editor drafts exceed the configured identity limit')
    const projects = new Map<WorkspaceId, string>()
    for (const [id, record] of table.entries()) {
      bounded(record, policy.maxRecordBytes)
      if (id !== key(record.workspaceId, record.identity)) fail('identity-conflict', 'Knowledge editor draft storage identity is inconsistent')
      const previous = projects.get(record.workspaceId)
      if (previous !== undefined && previous !== record.projectPath) fail('identity-conflict', 'Knowledge editor drafts contain conflicting project paths')
      projects.set(record.workspaceId, record.projectPath)
    }
    for (const [workspaceId, projectPath] of projects) this.snapshot(workspaceId, projectPath)
  }

  /** Read every retained row, including deletion revisions; disabled saving does not hide recovery data.
   * @param workspaceId - exact registered project identity.
   * @param projectPath - captured registered path, not a Brain selection.
   * @param authorize - rechecks caller, registration and lifetime before the queued read.
   * @returns a complete detached project list, or an explicit failure without a partial list.
   */
  list(workspaceId: WorkspaceId, projectPath: string, authorize: () => void): Promise<KnowledgeEditorDraftList> {
    return this.run(() => { authorize(); return this.snapshot(workspaceId, projectPath) })
  }

  /** Save a complete editor input only at the observed revision; equal content does not bypass stale revisions.
   * @param workspaceId - project owning the editor.
   * @param projectPath - captured current registered path.
   * @param request - complete editor input and null only for a never-retained identity.
   * @param authorize - rechecks permission and cancellation immediately before storage admission.
   * @returns the acknowledged durable row; an admitted write may finish after cancellation.
   */
  save(workspaceId: WorkspaceId, projectPath: string, request: KnowledgeEditorDraftSave,
    authorize: () => void): Promise<KnowledgeEditorDraftRow> {
    bounded(request, this.policy.maxRecordBytes)
    const parsed = draftSchema.safeParse(request.draft)
    if (!parsed.success || parsed.data.workspaceId !== workspaceId) fail('invalid', 'Knowledge editor draft identity or complete input is invalid')
    const draft = parsed.data, expectedRevision = request.expectedRevision
    return this.run(async () => {
      authorize()
      if (!this.policy.enabled) fail('disabled', 'Saving knowledge editor drafts is disabled in this deployment')
      const selected = selectedIdentity(draft), id = key(workspaceId, selected), current = this.table.get(id)
      this.assertRevision(current, projectPath, expectedRevision)
      if (current === undefined && this.table.size >= this.policy.maxRecords) fail('capacity', 'Knowledge editor draft identity limit reached; retained drafts were not removed')
      const next: KnowledgeEditorDraftRecord = { workspaceId, projectPath, identity: selected,
        revision: randomUUID() as KnowledgeDraftRevision, draft }
      bounded(next, this.policy.maxRecordBytes)
      this.snapshot(workspaceId, projectPath, [id, next])
      authorize()
      await this.table.put(id, next)
      return row(next)
    })
  }

  /** Retain a deletion revision instead of deleting identity history, preventing stale-window resurrection.
   * @param workspaceId - project owning the saved editor.
   * @param projectPath - captured registered path.
   * @param request - exact editor identity and observed revision; null reserves a never-retained identity against delayed saves.
   * @param authorize - rechecks caller and cancellation immediately before storage admission.
   * @returns the acknowledged tombstone; it does not cancel any knowledge publication.
   */
  remove(workspaceId: WorkspaceId, projectPath: string, request: KnowledgeEditorDraftRemoval,
    authorize: () => void): Promise<KnowledgeEditorDraftRow> {
    const parsed = identity.safeParse(request.identity)
    if (!parsed.success) fail('invalid', 'Knowledge editor draft identity is invalid')
    const selected = parsed.data, expectedRevision = request.expectedRevision
    return this.run(async () => {
      authorize()
      const id = key(workspaceId, selected), current = this.table.get(id)
      this.assertRevision(current, projectPath, expectedRevision)
      if (current === undefined && this.table.size >= this.policy.maxRecords) fail('capacity', 'Knowledge editor draft identity limit reached; retained drafts were not removed')
      const next: KnowledgeEditorDraftRecord = { workspaceId, projectPath, identity: selected,
        revision: randomUUID() as KnowledgeDraftRevision, draft: null }
      bounded(next, this.policy.maxRecordBytes)
      this.snapshot(workspaceId, projectPath, [id, next])
      authorize()
      await this.table.put(id, next)
      return row(next)
    })
  }

  private assertRevision(current: KnowledgeEditorDraftRecord | undefined, projectPath: string,
    expected: KnowledgeDraftRevision | null): void {
    if (current !== undefined && current.projectPath !== projectPath) fail('identity-conflict', 'Knowledge editor draft belongs to a different registered project path')
    if ((current?.revision ?? null) !== expected) fail('conflict', 'Knowledge editor draft changed; read the saved draft before choosing which input to retain')
  }

  private snapshot(workspaceId: WorkspaceId, projectPath: string,
    replacement?: readonly [string, KnowledgeEditorDraftRecord]): KnowledgeEditorDraftList {
    const records = new Map(this.table.entries())
    if (replacement !== undefined) records.set(...replacement)
    const rows: KnowledgeEditorDraftRow[] = []
    for (const record of records.values()) {
      if (record.workspaceId !== workspaceId) continue
      if (record.projectPath !== projectPath) fail('identity-conflict', 'Knowledge editor draft belongs to a different registered project path')
      rows.push(row(record))
    }
    rows.sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)))
    const result = { rows, policy: { ...this.policy } }
    bounded(result, this.policy.maxListBytes)
    return result
  }

  private run<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation)
    this.pending = next
    return next
  }
}
