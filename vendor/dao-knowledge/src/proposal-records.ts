/** Strict document-owned proposal receipts, separate from current understanding and model authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { hasKnowledgeStorageMarker, type knowledgeSource } from './source.ts'
import { ROOT_DOCUMENTS, readRootOperations, rootWriteDigest } from './root-records.ts'
import type { KnowledgeDocumentId, KnowledgeProposalResolution, KnowledgeTruthProposal, KnowledgeTruthUpdate, KnowledgeUpdateId } from './types.ts'

const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const text = z.string().refine(value => !value.includes('\0'))
const nonempty = text.refine(value => value.trim().length > 0)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const resolutionFields = { operationId: uuid, at: z.iso.datetime(), expectedVersion: nonempty, note: nonempty, digest }
const resolutionSchema = z.discriminatedUnion('action', [
  z.object({ ...resolutionFields, action: z.literal('keep'), truth: z.null() }).strict(),
  z.object({ ...resolutionFields, action: z.literal('replace'), truth: z.null(), publicationDigest: digest }).strict(),
  z.object({ ...resolutionFields, action: z.literal('merge'), truth: nonempty, publicationDigest: digest }).strict(),
])
const recordSchema = z.object({ operationId: uuid, at: z.iso.datetime(), expectedVersion: nonempty,
  before: text, proposed: nonempty, summary: nonempty, source: nonempty, evidence: nonempty, digest,
  resolution: resolutionSchema.nullable() }).strict()

/** Complete stored intent and optional decision; request digests identify retries, not authentic file authorship. */
export type TruthProposalRecord = z.infer<typeof recordSchema>

/** Bind one proposal UUID to every original request field, including unnormalized Markdown.
 * @param id - page path included in the retained identity.
 * @param request - original proposal input.
 * @returns the deterministic receipt digest.
 */
export function truthProposalDigest(id: KnowledgeDocumentId, request: KnowledgeTruthProposal): string {
  return createHash('sha256').update(JSON.stringify(['truth-proposal', id, request.expectedVersion,
    request.truth, request.summary, request.source, request.evidence])).digest('hex')
}

/** Bind a human decision to its original displayed version, target and complete input.
 * @param id - selected page.
 * @param request - complete human resolution.
 * @returns the retained decision digest, independent of its attempted time.
 */
export function proposalResolutionDigest(id: KnowledgeDocumentId, request: KnowledgeProposalResolution): string {
  return createHash('sha256').update(JSON.stringify(['truth-proposal-resolution', id, request.expectedVersion,
    request.proposalId, request.action, request.note, request.truth])).digest('hex')
}

/** Describe the ordinary evidence publication for an accepted or manually merged proposal.
 * @param proposal - retained unapproved input with its original attribution.
 * @param request - explicit human decision; keep never publishes understanding or Timeline evidence.
 * @returns the existing writer's complete input, or undefined for keep.
 */
export function proposalTruthUpdate(proposal: TruthProposalRecord, request: KnowledgeProposalResolution): KnowledgeTruthUpdate | undefined {
  if (request.action === 'keep') return undefined
  return { operationId: request.operationId, expectedVersion: request.expectedVersion,
    truth: request.action === 'merge' ? request.truth : proposal.proposed,
    kind: 'reversal', summary: proposal.summary, source: proposal.source,
    evidence: `${proposal.evidence}\n\nHuman resolution of proposal ${proposal.operationId}: ${request.action}.${request.note === '' ? '' : `\n${request.note}`}` }
}

/** Bind an accepted proposal to its page or exact-body root publication.
 * @param id - existing document identity.
 * @param update - complete accepted ordinary update.
 * @returns the publication receipt digest, separate from the human decision digest.
 */
export function proposalPublicationDigest(id: KnowledgeDocumentId, update: KnowledgeTruthUpdate): string {
  return ROOT_DOCUMENTS.some(path => path === id)
    ? rootWriteDigest(id, { operationId: update.operationId, expectedVersion: update.expectedVersion,
      body: update.truth, reason: update.summary, source: update.source, evidence: update.evidence }, true)
    : createHash('sha256').update(JSON.stringify([update.expectedVersion, update.truth,
      update.kind, update.summary, update.source, update.evidence])).digest('hex')
}

/** Validate persisted proposals and their cross-ledger operation identities without interpreting them as knowledge.
 * @param id - page or fixed root identity used to validate request digests and report corruption.
 * @param source - complete file-owned parsed sections, not a partial model projection.
 * @returns all proposals in retained order; legacy documents without this ledger return an empty list.
 * @throws for malformed records, duplicate IDs, changed request digests or disconnected decision publications.
 */
export function readProposalRecords(id: KnowledgeDocumentId, source: ReturnType<typeof knowledgeSource>): TruthProposalRecord[] {
  const fields = source.frontmatter.value as Record<string, unknown> | null
  if (fields?.dsh_truth_proposals === undefined) return []
  const invalid = (): never => {
    throw new RemoteError('knowledge/update', 'Knowledge proposal metadata is malformed or inconsistent',
      { path: id, reason: 'identity-conflict' })
  }
  const parsed = z.array(recordSchema).safeParse(fields.dsh_truth_proposals)
  const timeline = z.array(z.record(z.string(), z.unknown())).safeParse(source.timeline.value ?? [])
  if (!parsed.success || !timeline.success) return invalid()
  const roots = ROOT_DOCUMENTS.some(path => path === id) ? readRootOperations(id, source) : undefined
  const foreign = new Set<string>()
  for (const [field, key] of [['dsh_root_operations', 'id'], ['dsh_archive_operations', 'id'],
    ['dsh_goal_change_operations', 'operationId']] as const) {
    const value = fields[field]
    if (value === undefined) continue
    const rows = z.array(z.looseObject({ [key]: uuid })).safeParse(value)
    if (!rows.success) return invalid()
    const local = new Set<string>()
    for (const row of rows.data) {
      const operation = row[key]
      if (typeof operation !== 'string' || local.has(operation)) return invalid()
      local.add(operation)
      // A signed root rewrite owns both its root publication and Goal review receipt.
      // readRootOperations validates this overlap; page and archive collisions remain invalid.
      if (foreign.has(operation) && !(roots !== undefined && field === 'dsh_goal_change_operations'
        && roots.some(root => root.id === operation && root.publication === undefined))) return invalid()
      foreign.add(operation)
    }
  }
  const seen = new Set<string>()
  const claim = (operation: KnowledgeUpdateId, rootPublication = false): void => {
    if (seen.has(operation) || (foreign.has(operation) && !rootPublication)) invalid()
    seen.add(operation)
  }
  for (const proposal of parsed.data) {
    claim(proposal.operationId)
    if ((roots === undefined && hasKnowledgeStorageMarker(proposal.proposed))
      || proposal.digest !== truthProposalDigest(id, { ...proposal, truth: proposal.proposed })
      || timeline.data.some(row => row.dsh_operation_id === proposal.operationId)) invalid()
    const resolution = proposal.resolution
    if (resolution === null) continue
    claim(resolution.operationId, roots !== undefined && resolution.action !== 'keep'
      && roots.some(row => row.id === resolution.operationId && row.publication !== undefined))
    const request = { ...resolution, proposalId: proposal.operationId }
    if (resolution.digest !== proposalResolutionDigest(id, request)) invalid()
    const receipts = timeline.data.filter(row => row.dsh_operation_id === resolution.operationId)
    const update = proposalTruthUpdate(proposal, request)
    if (update === undefined) {
      if (receipts.length !== 0) invalid()
      continue
    }
    if (roots === undefined && hasKnowledgeStorageMarker(update.truth)) invalid()
    const expected = proposalPublicationDigest(id, update)
    const receipt = receipts[0]
    if (!('publicationDigest' in resolution) || resolution.publicationDigest !== expected) invalid()
    if (roots === undefined) {
      if (receipts.length !== 1 || receipt === undefined || receipt.dsh_request_digest !== expected || receipt.time !== resolution.at
        || receipt.kind !== update.kind || receipt.summary !== update.summary || receipt.source !== update.source
        || receipt.evidence !== update.evidence) invalid()
    } else {
      const root = roots.find(row => row.id === resolution.operationId)
      if (receipts.length !== 0 || root?.digest !== expected || root.publication?.at !== resolution.at
        || root.publication.summary !== update.summary || root.publication.source !== update.source
        || root.publication.evidence !== update.evidence) invalid()
    }
    const changes = fields.dsh_truth_changes
    if (changes !== undefined) {
      const rows = z.array(z.record(z.string(), z.unknown())).safeParse(changes)
      if (!rows.success) return invalid()
      const images = rows.data.filter(row => row.operationId === resolution.operationId)
      if (images.length > 1 || images.some(row => row.after !== (roots === undefined ? update.truth.replaceAll('\r\n', '\n').trim() : update.truth)
        || row.digest !== expected || row.restores !== undefined)) invalid()
    }
  }
  return parsed.data
}
