/** Existing-page lifecycle changes retain current understanding and append their governance evidence. */
import { createHash } from 'node:crypto'
import { hasPageOperationReceipt } from './page-metadata.ts'
import { type Document, isSeq } from 'yaml'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { setKnowledgeTags } from './tag-values.ts'
import { knowledgeSource, serializeKnowledgeBody } from './source.ts'
import { IMPORT_PUBLICATION_HOLD_KEY, importPublicationHoldIdentity, readImportPublicationHold, sameImportPublicationHold,
  validateImportPublicationHold } from './import-publication-hold.ts'
import { TASK_PUBLICATION_HOLD_KEY, readTaskPublicationHold, sameTaskPublicationHold,
  taskPublicationHoldIdentity, validateTaskPublicationHold } from './task-publication-hold.ts'
import { GOAL_PUBLICATION_HOLD_KEY, goalPublicationHoldIdentity, readGoalPublicationHold, sameGoalPublicationHold,
  validateGoalPublicationHold } from './goal-publication-hold.ts'
import type { KnowledgeDocumentId, KnowledgeGoalPublicationHold, KnowledgeImportPublicationHold,
  KnowledgeOrdinaryPublicationRelease, KnowledgePageStatusUpdate, KnowledgeTaskPublicationHold } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const statusSchema = z.object({
  operationId: z.uuid(), expectedVersion: nonempty, status: z.enum(['draft', 'active']),
  reason: nonempty, source: nonempty, evidence: nonempty,
}).strict()
const ordinaryReleaseSchema = z.object({ kind: z.literal('ordinary'), workspaceId: nonempty, documentId: nonempty,
  draftOperationId: z.uuid().nullable(), draftRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/u), activeIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
  .refine(value => (value.draftOperationId === null) === (value.draftRequestDigest === null))

function statusDigest(id: KnowledgeDocumentId, input: z.infer<typeof statusSchema>,
  importRelease?: KnowledgeImportPublicationHold, taskRelease?: KnowledgeTaskPublicationHold,
  goalRelease?: KnowledgeGoalPublicationHold, ordinaryRelease?: KnowledgeOrdinaryPublicationRelease): string {
  return createHash('sha256').update(JSON.stringify([
    'status', id, input.expectedVersion, input.status, input.reason, input.source, input.evidence,
    ...importRelease === undefined ? [] : importPublicationHoldIdentity(importRelease),
    ...taskRelease === undefined ? [] : ['task', ...taskPublicationHoldIdentity(taskRelease)],
    ...goalRelease === undefined ? [] : ['goal', ...goalPublicationHoldIdentity(goalRelease)],
    ...ordinaryRelease === undefined ? [] : ['ordinary', ordinaryRelease.workspaceId, ordinaryRelease.documentId,
      ordinaryRelease.draftOperationId, ordinaryRelease.draftRequestDigest, ordinaryRelease.reviewDigest,
      ordinaryRelease.activeIndexDigest],
  ])).digest('hex')
}

/** Inspect a direct lifecycle write's exact file-owned receipt without changing the page.
 * @param id - existing page path.
 * @param text - complete current page file.
 * @param version - current location-qualified file version.
 * @param request - original status request with its UUID and user evidence.
 * @returns whether exactly one Timeline row retains the complete direct request.
 * @throws for malformed files, requests or ambiguous operation identities.
 */
export function hasStatusUpdateReceipt(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgePageStatusUpdate): boolean {
  const input = statusSchema.parse(request)
  parseKnowledgeDocument(id, text, version)
  const digest = statusDigest(id, input)
  const rows = knowledgeSource(text, true).timeline.value as Record<string, unknown>[] | null
  const matches = rows?.filter(row => row.dsh_operation_id === input.operationId) ?? []
  if (matches.length === 0) return false
  if (matches.length !== 1 || matches[0]?.dsh_request_digest !== digest) {
    throw new RemoteError('knowledge/update', 'Knowledge status UUID belongs to different or ambiguous history',
      { path: id, reason: 'identity-conflict' })
  }
  return true
}

/** Inspect one complete ordinary publication receipt without creating a replacement.
 * @param id - exact existing page path.
 * @param text - complete current file from the selected Brain.
 * @param version - location-qualified version of the current file.
 * @param request - original status request, including UUID and human evidence.
 * @param release - Host-retained original draft, review and catalog identity.
 * @returns true only for one matching Timeline row; false when no such UUID exists.
 * @throws for malformed files, invalid requests or a reused UUID with different inputs.
 */
export function hasOrdinaryPublicationReceipt(id: KnowledgeDocumentId, text: string, version: string,
  request: KnowledgePageStatusUpdate, release: KnowledgeOrdinaryPublicationRelease): boolean {
  const input = statusSchema.parse(request)
  if (!ordinaryReleaseSchema.safeParse(release).success || release.documentId !== id || input.status !== 'active') {
    throw new RemoteError('knowledge/update', 'Ordinary publication receipt input is invalid', { path: id, reason: 'invalid' })
  }
  parseKnowledgeDocument(id, text, version)
  const digest = statusDigest(id, input, undefined, undefined, undefined, release)
  const rows = knowledgeSource(text, true).timeline.value as Record<string, unknown>[] | null
  const matches = rows?.filter(row => row.dsh_operation_id === input.operationId) ?? []
  if (matches.length === 0) return false
  if (matches.length !== 1 || matches[0]?.dsh_request_digest !== digest) {
    throw new RemoteError('knowledge/update', 'Ordinary publication UUID belongs to different or ambiguous history',
      { path: id, reason: 'identity-conflict' })
  }
  return true
}

/** Prepare a lifecycle-only replacement or recognize an identical durable retry.
 * @param id - validated existing page path; roots cannot change lifecycle.
 * @param text - complete current file, including metadata and history.
 * @param version - version of the complete current file.
 * @param request - retained status change and its original evidence and version.
 * @param now - timestamp of this publication attempt.
 * @param maxBytes - inclusive complete request and file byte limit.
 * @param release - trusted import, Task or Goal-human identity; ordinary status writers cannot release a held draft.
 * @returns replacement text, or undefined for a retry already recorded in history.
 * @throws for stale versions, invalid input, ambiguous identities or a target status already in effect.
 */
export function prepareStatusUpdate(
  id: KnowledgeDocumentId, text: string, version: string, request: KnowledgePageStatusUpdate, now: string, maxBytes: number,
  release?: KnowledgeImportPublicationHold | KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold
    | KnowledgeOrdinaryPublicationRelease,
): string | undefined {
  const refuse = (reason: 'invalid' | 'conflict' | 'identity-conflict' | 'read-only', message: string): never => {
    throw new RemoteError('knowledge/update', message, { path: id, reason })
  }
  if (Buffer.byteLength(JSON.stringify(request)) > maxBytes) {
    throw new RemoteError('knowledge/document', 'knowledge status request exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  const parsed = statusSchema.safeParse(request)
  if (!parsed.success) return refuse('invalid', 'status changes require a UUID, version, draft or active status, reason and complete evidence')
  const input = parsed.data
  const prior = parseKnowledgeDocument(id, text, version)
  if (prior.entry.kind !== 'page') refuse('read-only', 'root documents do not have a page lifecycle')
  const source = knowledgeSource(text, true)
  const heldImport = readImportPublicationHold(source.frontmatter.value)
  const heldTask = readTaskPublicationHold(source.frontmatter.value)
  const heldGoal = readGoalPublicationHold(source.frontmatter.value)
  const importRelease = release === undefined || !('importId' in release) ? undefined : validateImportPublicationHold(release)
  const goalRelease = release === undefined || !('goalRunId' in release) ? undefined : validateGoalPublicationHold(release)
  const taskRelease = release === undefined || !('taskId' in release) || 'goalRunId' in release
    ? undefined : validateTaskPublicationHold(release)
  const ordinaryRelease = release === undefined || !('kind' in release)
    ? undefined : ordinaryReleaseSchema.parse(release) as KnowledgeOrdinaryPublicationRelease
  if (heldImport !== null && input.status === 'active' && importRelease === undefined) {
    refuse('read-only', 'knowledge import draft requires explicit publication confirmation')
  }
  if (heldTask !== null && input.status === 'active' && taskRelease === undefined) {
    refuse('read-only', 'knowledge Task draft requires explicit publication confirmation')
  }
  if (heldGoal !== null && input.status === 'active' && goalRelease === undefined) {
    refuse('read-only', 'knowledge Goal draft requires explicit publication confirmation')
  }
  if ((importRelease !== undefined || taskRelease !== undefined || goalRelease !== undefined || ordinaryRelease !== undefined)
    && input.status !== 'active') {
    refuse('invalid', 'knowledge draft release requires active publication')
  }
  const digest = statusDigest(id, input, importRelease, taskRelease, goalRelease, ordinaryRelease)
  const history = source.timeline.value as Record<string, unknown>[] | null
  if (hasPageOperationReceipt(id, history, input.operationId, digest)) return undefined
  if (prior.entry.status === 'draft' && input.status === 'active'
    && importRelease === undefined && taskRelease === undefined && goalRelease === undefined && ordinaryRelease === undefined) {
    refuse('read-only', 'draft publication requires a separate reviewed release')
  }
  if (importRelease !== undefined && (heldImport === null || !sameImportPublicationHold(heldImport, importRelease))) {
    refuse('identity-conflict', 'knowledge import publication hold differs from the reviewed draft')
  }
  if (taskRelease !== undefined && (heldTask === null || !sameTaskPublicationHold(heldTask, taskRelease))) {
    refuse('identity-conflict', 'knowledge Task publication hold differs from the reviewed draft')
  }
  if (goalRelease !== undefined && (heldGoal === null || !sameGoalPublicationHold(heldGoal, goalRelease))) {
    refuse('identity-conflict', 'knowledge Goal publication hold differs from the reviewed draft')
  }
  if (ordinaryRelease !== undefined && (heldImport !== null || heldTask !== null || heldGoal !== null
    || ordinaryRelease.documentId !== id || input.expectedVersion !== version)) {
    refuse('identity-conflict', 'ordinary publication does not match the current unheld draft')
  }
  if (ordinaryRelease !== undefined && ordinaryRelease.draftOperationId !== null
    && ((history ?? [])[0]?.dsh_operation_id !== ordinaryRelease.draftOperationId
      || (history ?? [])[0]?.dsh_request_digest !== ordinaryRelease.draftRequestDigest)) {
    refuse('identity-conflict', 'ordinary publication draft creation receipt changed')
  }
  if ((importRelease !== undefined || taskRelease !== undefined || goalRelease !== undefined || ordinaryRelease !== undefined)
    && prior.entry.status !== 'draft') {
    refuse('read-only', 'knowledge publication requires a current draft page')
  }
  if (version !== input.expectedVersion) refuse('conflict', 'knowledge changed; read the current document before changing its status')
  if (prior.entry.status === input.status) refuse('invalid', 'knowledge already has the requested status; no lifecycle change is needed')
  source.frontmatter.document.set('title', prior.entry.title)
  if (!source.frontmatter.document.has('id')) source.frontmatter.document.set('id', prior.entry.slug)
  source.frontmatter.document.set('status', input.status)
  if (importRelease !== undefined) source.frontmatter.document.delete(IMPORT_PUBLICATION_HOLD_KEY)
  if (taskRelease !== undefined) source.frontmatter.document.delete(TASK_PUBLICATION_HOLD_KEY)
  if (goalRelease !== undefined) source.frontmatter.document.delete(GOAL_PUBLICATION_HOLD_KEY)
  source.frontmatter.document.set('updated', now)
  setKnowledgeTags(source.frontmatter.document, prior.entry.tags)
  const timeline: Document = source.timeline.document
  if (!isSeq(timeline.contents)) timeline.contents = timeline.createNode([])
  timeline.add({ time: now, kind: 'decision',
    summary: `Page status changed from ${prior.entry.status} to ${input.status}: ${input.reason}`,
    source: input.source, evidence: input.evidence, affects: [prior.entry.slug],
    dsh_operation_id: input.operationId, dsh_request_digest: digest })
  const result = `---\n${source.frontmatter.document.toString({ lineWidth: 0 })}---\n\n${serializeKnowledgeBody(source.truth, timeline.toString({ lineWidth: 0 }))}`
  if (Buffer.byteLength(result) > maxBytes) {
    throw new RemoteError('knowledge/document', 'knowledge status history exceeds the document byte limit', { path: id, reason: 'too-large' })
  }
  parseKnowledgeDocument(id, result, version)
  return result
}
