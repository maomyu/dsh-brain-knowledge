/** Validate ordinary rewrite images against page Timeline or root publication receipts. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { knowledgeSource } from './source.ts'
import { ROOT_DOCUMENTS, readRootOperations } from './root-records.ts'
import type { KnowledgeDocumentId, KnowledgeUpdateId } from './types.ts'

const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const body = z.string().refine(value => !value.includes('\0'))
const nonempty = body.refine(value => value.trim().length > 0)
const record = z.object({
  operationId: uuid, at: z.iso.datetime(), summary: nonempty, source: nonempty, evidence: nonempty,
  before: body, after: body, digest: z.string().regex(/^[a-f0-9]{64}$/), restores: uuid.optional(),
}).strict()
const records = z.array(record)

/** File-owned recovery data; digests bind retained operation requests, not permission to restore. */
export type TruthChangeRecord = z.infer<typeof record>

/** Parse the complete optional ledger and require every stored image to have one matching historical receipt.
 * @param id - file identity used in refusals.
 * @param source - complete parsed frontmatter and Timeline, never a model-provided partial projection.
 * @returns validated records in publication order; absent metadata is a legacy document with no invented images.
 * @throws for malformed, duplicated, disconnected or ambiguous recovery metadata.
 */
export function readTruthRecords(id: KnowledgeDocumentId, source: ReturnType<typeof knowledgeSource>): TruthChangeRecord[] {
  const fields = source.frontmatter.value as Record<string, unknown> | null
  const value = fields?.dsh_truth_changes
  if (value === undefined) return []
  const parsed = records.safeParse(value)
  const invalid = (): never => {
    throw new RemoteError('knowledge/update', 'Ordinary knowledge recovery metadata is malformed or inconsistent',
      { path: id, reason: 'identity-conflict' })
  }
  if (!parsed.success) return invalid()
  const timeline = z.array(z.record(z.string(), z.unknown())).safeParse(source.timeline.value ?? [])
  if (!timeline.success) return invalid()
  const roots = ROOT_DOCUMENTS.some(path => path === id) ? readRootOperations(id, source) : undefined
  const seen = new Map<KnowledgeUpdateId, TruthChangeRecord>()
  for (const change of parsed.data) {
    if (seen.has(change.operationId) || change.before === change.after) return invalid()
    if (roots === undefined) {
      const receipts = timeline.data.filter(row => row.dsh_operation_id === change.operationId)
      const receipt = receipts[0]
      if (receipts.length !== 1 || receipt === undefined || receipt.dsh_request_digest !== change.digest || receipt.time !== change.at
        || receipt.summary !== change.summary || receipt.source !== change.source || receipt.evidence !== change.evidence) return invalid()
    } else {
      const receipt = roots.find(row => row.id === change.operationId)
      if (receipt?.digest !== change.digest || receipt.publication?.at !== change.at
        || receipt.publication.summary !== change.summary || receipt.publication.source !== change.source
        || receipt.publication.evidence !== change.evidence) return invalid()
    }
    if (change.restores !== undefined) {
      const prior = seen.get(change.restores)
      if (prior === undefined || change.before !== prior.after || change.after !== prior.before) return invalid()
    }
    seen.set(change.operationId, change)
  }
  return parsed.data
}
