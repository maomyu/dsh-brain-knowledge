/** Private confirmation records for ordinary draft publication; Brain files own the write receipt. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeDocumentId, KnowledgeEditorDraftPolicy, KnowledgeOrdinaryDraftPublishRequest,
  KnowledgeOrdinaryDraftReview, KnowledgeUpdateId } from './types.ts'

const nonempty = z.string().min(1).refine(value => !value.includes('\0'))
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const reviewedPage = z.object({ id: nonempty.transform(value => value as KnowledgeDocumentId), title: nonempty,
  version: nonempty, relation: z.enum(['distinct', 'duplicate', 'conflict', 'unknown']) }).strict()
const request = z.object({ operationId: z.uuid().transform(value => value as KnowledgeUpdateId), expectedDraftVersion: nonempty,
  expectedActiveIndexDigest: sha256, reviewDigest: sha256, topicQuery: nonempty,
  reason: nonempty.refine(value => value.trim().length > 0), evidence: nonempty.refine(value => value.trim().length > 0),
  reviewedPages: z.array(reviewedPage).readonly().optional() }).strict()
const search = z.object({ exists: z.boolean(), truncated: z.boolean(),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
  hits: z.array(z.object({ path: z.string().transform(value => value as KnowledgeDocumentId), title: z.string(),
    status: z.enum(['active', 'draft', 'archived']), version: z.string(), linesTruncated: z.boolean(),
    lines: z.array(z.object({ line: z.number().int().positive(), snippet: z.string() }).strict()) }).strict()) }).strict()
const page = z.object({ id: z.string().transform(value => value as KnowledgeDocumentId), title: z.string(), version: z.string() }).strict()
const review = z.object({ draftVersion: nonempty, bodySha256: sha256,
  draftOperationId: z.uuid().transform(value => value as KnowledgeUpdateId).nullable(),
  draftRequestDigest: sha256.nullable(), titleQuery: nonempty, titleSearch: search, topicQuery: nonempty, topicSearch: search,
  activeIndexDigest: sha256, activePages: z.array(page), reviewDigest: sha256 }).strict()
const recordBase = z.object({ workspaceId: nonempty.transform(value => value as WorkspaceId), projectPath: nonempty,
  brainDirectory: nonempty, locationRevision: nonempty.nullable(),
  documentId: nonempty.transform(value => value as KnowledgeDocumentId), request }).strict()
const record = z.discriminatedUnion('abandoned', [
  recordBase.extend({ review, abandoned: z.literal(false) }).strict(),
  recordBase.extend({ review: review.nullable(), abandoned: z.literal(true) }).strict(),
])

/** Complete Host review evidence retained before publication admission. */
export type OrdinaryPublicationReviewEvidence = z.infer<typeof review>
/** Acknowledged confirmation, including the original request required after a cold restart. */
export type OrdinaryPublicationRecord = z.infer<typeof record>

/** Private confirmations are not Brain pages, Session events, or model context. */
export const knowledgeOrdinaryPublicationDomain = defineDomain({ name: 'knowledge_ordinary_publications', version: 1,
  tables: { confirmations: domainTable<string, OrdinaryPublicationRecord>(record) } })

/** Parse a wire request before it can reserve an operation ID.
 * @param input - untrusted Remote request.
 * @returns complete validated confirmation.
 * @throws for malformed or incomplete human decisions.
 */
export function validateOrdinaryPublicationRequest(input: KnowledgeOrdinaryDraftPublishRequest): KnowledgeOrdinaryDraftPublishRequest {
  const parsed = request.safeParse(input)
  if (!parsed.success) fail('invalid', 'Ordinary publication needs a UUID, reviewed versions, topic, reason, evidence and valid page relations')
  return parsed.data
}

function key(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, documentId])).digest('hex')
}

function fail(reason: 'invalid' | 'identity-conflict', message: string): never {
  throw new RemoteError('knowledge/update', message, { path: 'pages', reason })
}

/** Strictly parsed private requests never overwrite an unresolved confirmation. */
export class KnowledgeOrdinaryPublicationStore {
  constructor(private readonly table: KvTable<string, OrdinaryPublicationRecord>, private readonly policy: KnowledgeEditorDraftPolicy) {
    if (table.size > policy.maxRecords) fail('invalid', 'Ordinary publication confirmation capacity exceeded')
    for (const [id, value] of table.entries()) {
      if (id !== key(value.workspaceId, value.documentId) || Buffer.byteLength(JSON.stringify(value)) > policy.maxRecordBytes) {
        fail('identity-conflict', 'Ordinary publication confirmation storage identity is invalid')
      }
    }
  }

  /** Return the detached exact request for one project page, including after process restart.
   * @param workspaceId - registered project identity.
   * @param documentId - Brain page identity.
   * @param projectPath - current canonical registered root, checked against the retained root.
   * @returns complete pending confirmation, or null when none was retained.
   */
  pending(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, projectPath: string): KnowledgeOrdinaryDraftPublishRequest | null {
    const saved = this.table.get(key(workspaceId, documentId))
    if (saved === undefined || saved.abandoned) return null
    if (saved.workspaceId !== workspaceId || saved.documentId !== documentId || saved.projectPath !== projectPath) {
      fail('identity-conflict', 'Ordinary publication confirmation belongs to a different project or page')
    }
    return structuredClone(saved.request)
  }

  /** Find the complete prior confirmation without making a write.
   * @param workspaceId - registered project identity.
   * @param documentId - Brain page identity.
   * @param projectPath - current canonical registered root.
   * @returns retained confirmation or null.
   */
  get(workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, projectPath: string): OrdinaryPublicationRecord | null {
    const saved = this.table.get(key(workspaceId, documentId))
    if (saved === undefined) return null
    if (saved.workspaceId !== workspaceId || saved.documentId !== documentId || saved.projectPath !== projectPath) {
      fail('identity-conflict', 'Ordinary publication confirmation belongs to a different project or page')
    }
    return structuredClone(saved)
  }

  /** Durably retain a complete decision before its page writer can start.
   * @param value - validated identity, exact request and complete review evidence.
   * @param replaceSettled - true only after the prior exact file receipt is independently verified.
   * @returns acknowledged original or replacement decision.
   */
  async retain(value: OrdinaryPublicationRecord, replaceSettled: boolean): Promise<OrdinaryPublicationRecord> {
    const parsed = record.safeParse(value)
    if (!parsed.success) fail('invalid', 'Ordinary publication confirmation is malformed')
    const candidate = parsed.data
    if (Buffer.byteLength(JSON.stringify(candidate)) > this.policy.maxRecordBytes) {
      fail('invalid', 'Ordinary publication confirmation exceeds its private record limit')
    }
    const id = key(candidate.workspaceId, candidate.documentId)
    const current = this.table.get(id)
    if (current !== undefined) {
      if (current.projectPath !== candidate.projectPath) fail('identity-conflict', 'Ordinary publication project path changed')
      if (!current.abandoned && JSON.stringify(current) === JSON.stringify(candidate)) return structuredClone(current)
      if (current.abandoned && current.request.operationId === candidate.request.operationId) {
        fail('identity-conflict', 'An abandoned ordinary publication UUID cannot be reused')
      }
      if (!current.abandoned && !replaceSettled) fail('identity-conflict', 'Another ordinary publication decision remains unresolved')
    } else if (this.table.size >= this.policy.maxRecords) {
      fail('invalid', 'Ordinary publication confirmation capacity exceeded')
    }
    await this.table.put(id, candidate)
    return structuredClone(candidate)
  }

  /** Retain a tombstone only after the caller proves the old file receipt absent under writer locks.
   * @param value - exact original confirmation, or a revocation before any confirmation was retained.
   * @returns whether the exact confirmation was tombstoned.
   */
  async abandon(value: Extract<OrdinaryPublicationRecord, { abandoned: true }>): Promise<boolean> {
    const parsed = record.safeParse(value)
    if (!parsed.success) fail('invalid', 'Ordinary publication revocation is malformed')
    const candidate = parsed.data
    if (!candidate.abandoned || Buffer.byteLength(JSON.stringify(candidate)) > this.policy.maxRecordBytes) {
      fail('invalid', 'Ordinary publication revocation exceeds its private record limit')
    }
    const current = this.get(candidate.workspaceId, candidate.documentId, candidate.projectPath)
    if (current !== null && JSON.stringify(current.request) !== JSON.stringify(candidate.request)) return false
    if (current?.abandoned) return true
    if (current === null && this.table.size >= this.policy.maxRecords) {
      fail('invalid', 'Ordinary publication confirmation capacity exceeded')
    }
    await this.table.put(key(candidate.workspaceId, candidate.documentId), current === null ? candidate : { ...current, abandoned: true })
    return true
  }
}

/** Bind a review to complete body, project, searches and active catalog without trusting caller summaries.
 * @param workspaceId - registered project identity.
 * @param projectPath - current registered project root.
 * @param directory - selected Brain directory and revision.
 * @param documentId - exact draft page.
 * @param value - complete review returned to the human.
 * @param draftOperationId - original file-owned creation UUID.
 * @param draftRequestDigest - original file-owned creation digest.
 * @returns fixed digest and bounded evidence for the Host confirmation record.
 */
export function ordinaryReviewEvidence(workspaceId: WorkspaceId, projectPath: string, directory: string,
  documentId: KnowledgeDocumentId, value: Omit<KnowledgeOrdinaryDraftReview, 'reviewDigest'>,
  draftOperationId: KnowledgeUpdateId | null, draftRequestDigest: string | null): OrdinaryPublicationReviewEvidence {
  const draftVersion = value.document.entry.version
  const bodySha256 = createHash('sha256').update(value.document.body).digest('hex')
  const basis = { workspaceId, projectPath, directory, documentId, draftVersion, bodySha256,
    draftOperationId, draftRequestDigest, titleQuery: value.titleQuery, titleSearch: value.titleSearch,
    topicQuery: value.topicQuery, topicSearch: value.topicSearch, activeIndexDigest: value.activeIndexDigest,
    activePages: value.activePages }
  const reviewDigest = createHash('sha256').update(JSON.stringify(basis)).digest('hex')
  return review.parse({ draftVersion, bodySha256, draftOperationId, draftRequestDigest,
    titleQuery: value.titleQuery, titleSearch: value.titleSearch, topicQuery: value.topicQuery,
    topicSearch: value.topicSearch, activeIndexDigest: value.activeIndexDigest, activePages: value.activePages, reviewDigest })
}
