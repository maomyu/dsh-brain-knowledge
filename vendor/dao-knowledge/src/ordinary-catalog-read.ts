/** Private full-body delivery receipts for ordinary draft publication. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeDocumentId, KnowledgeEditorDraftPolicy, KnowledgeOrdinaryDraftReview,
  KnowledgeOrdinaryPageRelation } from './types.ts'

const nonempty = z.string().min(1).refine(value => !value.includes('\0'))
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const receipt = z.object({ workspaceId: nonempty.transform(value => value as WorkspaceId), projectPath: nonempty,
  brainDirectory: nonempty, locationRevision: nonempty.nullable(),
  draftId: nonempty.transform(value => value as KnowledgeDocumentId), draftVersion: nonempty,
  activeIndexDigest: sha256, reviewDigest: sha256, topicQuery: nonempty,
  pageId: nonempty.transform(value => value as KnowledgeDocumentId), pageTitle: nonempty,
  pageVersion: nonempty, bodySha256: sha256 }).strict()

/** Host-only proof that an exact complete active body was returned for one review. */
export type OrdinaryCatalogReadReceipt = z.infer<typeof receipt>

/** Independent domain preserves historic ordinary publication confirmations without a format migration. */
export const knowledgeOrdinaryCatalogReadDomain = defineDomain({ name: 'knowledge_ordinary_catalog_reads', version: 1,
  tables: { receipts: domainTable<string, OrdinaryCatalogReadReceipt>(receipt) } })

function key(workspaceId: WorkspaceId, draftId: KnowledgeDocumentId, pageId: KnowledgeDocumentId): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, draftId, pageId])).digest('hex')
}

function fail(message: string): never {
  throw new RemoteError('knowledge/update', message, { path: 'pages', reason: 'conflict' })
}

/** Retain only Host-returned full-document reads; stale receipts are never treated as current. */
export class KnowledgeOrdinaryCatalogReadStore {
  constructor(private readonly table: KvTable<string, OrdinaryCatalogReadReceipt>,
    private readonly policy: KnowledgeEditorDraftPolicy) {
    if (table.size > policy.maxRecords) fail('Ordinary catalog read capacity exceeded')
    for (const [id, value] of table.entries()) {
      if (id !== key(value.workspaceId, value.draftId, value.pageId)
        || Buffer.byteLength(JSON.stringify(value)) > policy.maxRecordBytes) fail('Ordinary catalog read storage identity is invalid')
    }
  }

  /** Save one stable Host delivery before it can support publication.
   * @param value - draft, review and complete old-document identity plus body hash.
   * @returns when the receipt is durable.
   */
  async retain(value: OrdinaryCatalogReadReceipt): Promise<void> {
    const parsed = receipt.parse(value)
    if (Buffer.byteLength(JSON.stringify(parsed)) > this.policy.maxRecordBytes) fail('Ordinary catalog read exceeds its private record limit')
    const id = key(parsed.workspaceId, parsed.draftId, parsed.pageId)
    if (this.table.get(id) === undefined && this.table.size >= this.policy.maxRecords) fail('Ordinary catalog read capacity exceeded')
    await this.table.put(id, parsed)
  }

  /** Require each catalog document's exact receipt for the current review and an explicit distinct decision.
   * @param identity - current project, Brain location and draft.
   * @param review - fresh Host review and complete active catalog.
   * @param pages - human relations submitted with the independent publication decision.
   * @returns when every old document was delivered in full and marked distinct.
   */
  requireDistinct(identity: Pick<OrdinaryCatalogReadReceipt, 'workspaceId' | 'projectPath' | 'brainDirectory'
    | 'locationRevision' | 'draftId'>, review: KnowledgeOrdinaryDraftReview,
  pages: readonly KnowledgeOrdinaryPageRelation[] | undefined): void {
    if (pages === undefined || pages.length !== review.activePages.length) fail('Every active document requires a full read and explicit relation')
    for (let index = 0; index < review.activePages.length; index++) {
      const expected = review.activePages[index]
      /* v8 ignore if -- The Host's dense filter/map catalog is unchanged during this synchronous bounded loop. */
      if (expected === undefined) fail('Active catalog changed during relation review')
      const decision = pages[index]
      if (decision?.id !== expected.id || decision.title !== expected.title || decision.version !== expected.version
        || decision.relation !== 'distinct') fail('Every active document must be explicitly classified as distinct')
      const saved = this.table.get(key(identity.workspaceId, identity.draftId, expected.id))
      if (saved === undefined || saved.workspaceId !== identity.workspaceId || saved.projectPath !== identity.projectPath
        || saved.brainDirectory !== identity.brainDirectory || saved.locationRevision !== identity.locationRevision
        || saved.draftId !== identity.draftId || saved.draftVersion !== review.document.entry.version
        || saved.activeIndexDigest !== review.activeIndexDigest || saved.reviewDigest !== review.reviewDigest
        || saved.topicQuery !== review.topicQuery || saved.pageId !== expected.id
        || saved.pageTitle !== expected.title || saved.pageVersion !== expected.version) {
        fail('Full-page read receipt is missing or stale; review the active catalog again')
      }
    }
  }
}
