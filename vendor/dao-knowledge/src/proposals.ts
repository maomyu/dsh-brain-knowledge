/** Retain unapproved knowledge proposals and publish explicit human decisions through one document writer. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { currentKnowledgeFile } from './current-file.ts'
import { hasKnowledgeStorageMarker, knowledgeSource } from './source.ts'
import { prepareTruthUpdate } from './update.ts'
import { prepareRootWrite } from './root.ts'
import { serializeRootBody } from './root-records.ts'
import { readProposalRecords, truthProposalDigest, proposalResolutionDigest, proposalTruthUpdate, proposalPublicationDigest, type TruthProposalRecord } from './proposal-records.ts'
import type { KnowledgeDocumentId, KnowledgeProposalResolution, KnowledgeProposalReview, KnowledgeTruthProposal, KnowledgeUpdateId } from './types.ts'

const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const textValue = z.string().refine(value => !value.includes('\0'))
const nonempty = textValue.refine(value => value.trim().length > 0)
const proposalSchema = z.object({ operationId: uuid, expectedVersion: nonempty, truth: nonempty,
  summary: nonempty, source: nonempty, evidence: nonempty }).strict()
const resolutionFields = { operationId: uuid, expectedVersion: nonempty, proposalId: uuid, note: nonempty }
const resolutionSchema = z.discriminatedUnion('action', [
  z.object({ ...resolutionFields, action: z.literal('keep'), truth: z.null() }).strict(),
  z.object({ ...resolutionFields, action: z.literal('replace'), truth: z.null() }).strict(),
  z.object({ ...resolutionFields, action: z.literal('merge'), truth: nonempty }).strict(),
])

function refuse(id: KnowledgeDocumentId, reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never {
  throw new RemoteError('knowledge/update', message, { path: id, reason })
}

function bounded(id: KnowledgeDocumentId, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new RemoteError('knowledge/document',
    'Complete knowledge proposals, decisions and history exceed the document byte limit', { path: id, reason: 'too-large' })
}

function currentFile(id: KnowledgeDocumentId, text: string, version: string) {
  const file = currentKnowledgeFile(id, text, version)
  return { ...file, proposals: readProposalRecords(id, file.source) }
}

function available(id: KnowledgeDocumentId, source: ReturnType<typeof knowledgeSource>, operationId: KnowledgeUpdateId,
  proposals: readonly TruthProposalRecord[]): void {
  const fields = source.frontmatter.value as Record<string, unknown> | null
  const timeline = source.timeline.value as Record<string, unknown>[] | null
  if (proposals.some(proposal => proposal.operationId === operationId || proposal.resolution?.operationId === operationId)
    || timeline?.some(row => row.dsh_operation_id === operationId)) {
    refuse(id, 'identity-conflict', 'Another knowledge operation owns this proposal or resolution identity')
  }
  for (const [field, key] of [['dsh_root_operations', 'id'], ['dsh_archive_operations', 'id'],
    ['dsh_goal_change_operations', 'operationId']] as const) {
    const value = fields?.[field]
    if (value === undefined) continue
    const rows = z.array(z.looseObject({ [key]: uuid })).safeParse(value)
    if (!rows.success) refuse(id, 'identity-conflict', 'Knowledge operation metadata is malformed')
    if (rows.data.some(row => row[key] === operationId)) refuse(id, 'identity-conflict', 'Another knowledge operation owns this proposal or resolution identity')
  }
}

function publish(id: KnowledgeDocumentId, text: string, version: string,
  proposals: readonly TruthProposalRecord[], maxBytes: number): string {
  const file = currentFile(id, text, version)
  const { source } = file
  source.frontmatter.document.set('dsh_truth_proposals', proposals)
  // Replace only the original header. Pending and kept proposals preserve every body byte, including CRLF and final whitespace.
  const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const next = file.page
    ? `${bom}---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n${header === null ? '\n' : ''}${text.slice(header?.[0].length ?? bom.length)}`
    : serializeRootBody(text, source.frontmatter.document, file.truth)
  bounded(id, next, maxBytes)
  const current = currentFile(id, next, version)
  /* v8 ignore if -- Only the validated YAML header changes; both serializers retain the same body bytes. */
  if (current.truth !== file.truth || current.source.body !== source.body) {
    refuse(id, 'invalid', 'Proposal metadata cannot change the current understanding or Timeline')
  }
  return next
}

/** Read complete proposal and resolution history without exposing pending claims as current knowledge.
 * @param id - authorized existing page or fixed root identity.
 * @param text - complete current file.
 * @param version - current location-qualified page version.
 * @param maxBytes - inclusive complete response limit, without truncation.
 * @returns current understanding and every retained proposal with its optional human disposition.
 */
export function readProposalReview(id: KnowledgeDocumentId, text: string, version: string, maxBytes: number): KnowledgeProposalReview {
  bounded(id, text, maxBytes)
  const file = currentFile(id, text, version)
  const result: KnowledgeProposalReview = { documentId: id, version, current: file.truth,
    archived: file.document.entry.status === 'archived', proposals: file.proposals.map(proposal => ({
      operationId: proposal.operationId, at: proposal.at, before: proposal.before, proposed: proposal.proposed,
      summary: proposal.summary, source: proposal.source, evidence: proposal.evidence,
      resolution: proposal.resolution === null ? null : { operationId: proposal.resolution.operationId,
        at: proposal.resolution.at, action: proposal.resolution.action, note: proposal.resolution.note },
    })) }
  bounded(id, JSON.stringify(result), maxBytes)
  return result
}

/** Store a version-informed proposal in document metadata without changing its understanding, Timeline or updated date.
 * @param id - authorized existing ordinary page or one of the six roots; absent documents cannot be proposed.
 * @param text - complete file read under the caller's publication lock.
 * @param version - observed location-qualified content version.
 * @param request - retained UUID, proposed full understanding and its attributed evidence.
 * @param now - attempted timestamp; a committed retry retains its original time.
 * @param maxBytes - inclusive complete request, current-file and resulting-file allowance.
 * @returns complete next file, or undefined for the same already-retained input even after later changes.
 * @throws for stale or archived pages, malformed input or metadata, reused identities and oversized results.
 */
export function prepareTruthProposal(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeTruthProposal, now: string, maxBytes: number): string | undefined {
  bounded(id, JSON.stringify(request), maxBytes)
  bounded(id, text, maxBytes)
  const parsed = proposalSchema.safeParse(request)
  if (!parsed.success) refuse(id, 'invalid', 'A proposal requires a UUID, read version, complete understanding and attributed evidence')
  const input = parsed.data
  const file = currentFile(id, text, version)
  if (file.page && hasKnowledgeStorageMarker(input.truth)) refuse(id, 'invalid', 'Proposed understanding cannot contain Brain storage markers')
  if (!file.page && /^(?:\uFEFF)?---(?:\r?\n|$)/.test(input.truth.trim())) refuse(id, 'invalid', 'Proposed root body must not include frontmatter')
  const digest = truthProposalDigest(id, input)
  const existing = file.proposals.find(proposal => proposal.operationId === input.operationId)
  if (existing !== undefined) {
    if (existing.digest !== digest) refuse(id, 'identity-conflict', 'Proposal identity belongs to different retained input')
    return undefined
  }
  available(id, file.source, input.operationId, file.proposals)
  if (file.document.entry.status === 'archived') refuse(id, 'read-only', 'Archived knowledge cannot accept new proposals')
  if (version !== input.expectedVersion) refuse(id, 'conflict', 'Knowledge changed; read it again before proposing a replacement')
  const normalized = input.truth.replaceAll('\r\n', '\n').trim()
  if (normalized === file.truth.replaceAll('\r\n', '\n').trim()) refuse(id, 'invalid', 'Proposed understanding is unchanged; no conflict proposal is needed')
  const duplicate = file.proposals.find(proposal => proposal.resolution === null && proposal.before === file.truth
    && proposal.proposed.replaceAll('\r\n', '\n').trim() === normalized && proposal.source === input.source
    && proposal.evidence === input.evidence && proposal.summary === input.summary)
  if (duplicate !== undefined) throw new RemoteError('knowledge/update',
    `Duplicate pending knowledge proposal: no write was made. Review existing proposal ${duplicate.operationId}; do not retry with another operation UUID.`,
    { path: id, reason: 'duplicate', existingOperationId: duplicate.operationId })
  return publish(id, text, version, [...file.proposals, { operationId: input.operationId, at: now,
    expectedVersion: input.expectedVersion, before: file.truth, proposed: input.truth, summary: input.summary,
    source: input.source, evidence: input.evidence, digest, resolution: null }], maxBytes)
}

/** Co-publish one human disposition and any accepted understanding with complete ordinary recovery history.
 * @param id - authorized existing ordinary page or fixed root.
 * @param text - complete current file held under the caller's writer lock.
 * @param version - current location-qualified file version.
 * @param request - explicit keep, replace or complete manual merge at the displayed version.
 * @param now - attempted decision time; identical retries retain the committed timestamp.
 * @param maxBytes - inclusive complete request, current-file and resulting-file limit.
 * @returns complete next file or undefined for an identical committed decision; keep never changes body bytes.
 * @throws for changed versions, replacement over later understanding, archived pages, missing proposals or identity conflicts.
 */
export function prepareProposalResolution(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgeProposalResolution, now: string, maxBytes: number): string | undefined {
  bounded(id, JSON.stringify(request), maxBytes)
  bounded(id, text, maxBytes)
  const parsed = resolutionSchema.safeParse(request)
  if (!parsed.success) refuse(id, 'invalid', 'Proposal resolution requires a UUID, displayed version, target, note and explicit decision')
  const input = parsed.data
  const file = currentFile(id, text, version)
  const digest = proposalResolutionDigest(id, input)
  const existing = file.proposals.find(proposal => proposal.resolution?.operationId === input.operationId)
  if (existing !== undefined) {
    if (existing.operationId !== input.proposalId || existing.resolution?.digest !== digest) {
      refuse(id, 'identity-conflict', 'Resolution identity belongs to different retained input')
    }
    return undefined
  }
  available(id, file.source, input.operationId, file.proposals)
  if (file.document.entry.status === 'archived') refuse(id, 'read-only', 'Archived knowledge cannot resolve proposals')
  if (version !== input.expectedVersion) refuse(id, 'conflict', 'Knowledge changed since the proposal review; read it again')
  const proposal = file.proposals.find(item => item.operationId === input.proposalId)
  if (proposal === undefined) return refuse(id, 'invalid', 'This page has no retained proposal with that identity')
  if (proposal.resolution !== null) refuse(id, 'conflict', 'This proposal already has a human disposition')
  if (input.action === 'replace' && file.truth !== proposal.before) {
    refuse(id, 'conflict', 'Current understanding changed after this proposal; read it and submit a manual merge instead')
  }
  const update = proposalTruthUpdate(proposal, input)
  const next = update === undefined ? text : file.page ? prepareTruthUpdate(id, text, version, update, now, maxBytes)
    : prepareRootWrite(id, { text, version }, { operationId: update.operationId, expectedVersion: update.expectedVersion,
      body: update.truth, reason: update.summary, source: update.source, evidence: update.evidence }, now, maxBytes, true, true)
  /* v8 ignore if -- available rejected this UUID in the same captured Timeline and root receipts before either synchronous writer. */
  if (next === undefined) return refuse(id, 'identity-conflict', 'Another knowledge operation owns this resolution identity')
  const fields = { operationId: input.operationId, expectedVersion: input.expectedVersion, note: input.note, at: now, digest }
  let resolution: NonNullable<TruthProposalRecord['resolution']>
  if (update === undefined) resolution = { ...fields, action: 'keep', truth: null }
  else {
    const publicationDigest = proposalPublicationDigest(id, update)
    resolution = input.action === 'merge' ? { ...fields, action: 'merge', truth: input.truth, publicationDigest }
      : { ...fields, action: 'replace', truth: null, publicationDigest }
  }
  return publish(id, next, version, file.proposals.map(item => item.operationId === proposal.operationId
    ? { ...item, resolution } : item), maxBytes)
}
