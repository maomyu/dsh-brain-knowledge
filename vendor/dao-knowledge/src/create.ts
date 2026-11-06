/** Complete page creation bytes and durable retry recognition; filesystem publication belongs to the controller. */
import { createHash } from 'node:crypto'
import { stringify } from 'yaml'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument } from './documents.ts'
import { hasKnowledgeStorageMarker, knowledgeSource, serializeKnowledgeBody } from './source.ts'
import { IMPORT_PUBLICATION_HOLD_KEY, importPublicationHoldIdentity, validateImportPublicationHold } from './import-publication-hold.ts'
import { TASK_PUBLICATION_HOLD_KEY, taskPublicationHoldIdentity, validateTaskPublicationHold } from './task-publication-hold.ts'
import { GOAL_PUBLICATION_HOLD_KEY, goalPublicationHoldIdentity, validateGoalPublicationHold } from './goal-publication-hold.ts'
import { normalizeKnowledgeTags } from './tag-values.ts'
import type { KnowledgeDocumentId, KnowledgeGoalPublicationHold, KnowledgeImportPublicationHold, KnowledgePageCreate,
  KnowledgeTaskPublicationHold } from './types.ts'

const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const schema = z.object({
  operationId: z.uuid(), title: nonempty, status: z.enum(['draft', 'active', 'archived']),
  category: z.enum(['project', 'concept', 'decision', 'person', 'reference']), tags: z.array(z.string()), truth: nonempty,
  kind: z.enum(['decision', 'observation', 'source', 'reversal', 'evidence']), summary: nonempty, source: nonempty, evidence: nonempty,
}).strict()

/** Validate a new page and serialize its complete metadata, understanding and initial evidence.
 * @param id - direct page path using a lowercase hyphenated slug.
 * @param request - complete retained creation intent; status has no implicit default.
 * @param now - creation attempt time, excluded from retry identity.
 * @param maxBytes - inclusive request and resulting document byte cap.
 * @param hold - trusted import, Task or Goal-human intent retained only on an explicitly saved draft.
 * @returns complete publication text and the stable creation digest.
 * @throws for invalid page identities, input, embedded storage markers or oversized documents.
 */
export function preparePageCreation(
  id: KnowledgeDocumentId, request: KnowledgePageCreate, now: string, maxBytes: number,
  hold?: KnowledgeImportPublicationHold | KnowledgeTaskPublicationHold | KnowledgeGoalPublicationHold,
): { text: string; digest: string } {
  const match = /^pages\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(id)
  if (match === null) throw new RemoteError('knowledge/document', 'new pages require pages/<lowercase-hyphenated-id>.md', { path: id, reason: 'unsafe-path' })
  const checkSize = (value: string): void => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new RemoteError('knowledge/document', 'knowledge creation exceeds the document byte limit', { path: id, reason: 'too-large' })
    }
  }
  checkSize(JSON.stringify(hold === undefined ? request : { request, hold }))
  const parsed = schema.safeParse(request)
  if (!parsed.success) {
    throw new RemoteError('knowledge/update', 'page creation requires an operation UUID, explicit metadata, truth and complete evidence', { path: id, reason: 'invalid' })
  }
  const input = parsed.data
  const importHold = hold === undefined || !('importId' in hold) ? undefined : validateImportPublicationHold(hold)
  const goalHold = hold === undefined || !('goalRunId' in hold) ? undefined : validateGoalPublicationHold(hold)
  const taskHold = hold === undefined || !('taskId' in hold) || 'goalRunId' in hold
    ? undefined : validateTaskPublicationHold(hold)
  if ((importHold !== undefined || taskHold !== undefined || goalHold !== undefined)
    && (input.status !== 'draft' || input.operationId !== (importHold ?? taskHold ?? goalHold)?.draftOperationId)) {
    throw new RemoteError('knowledge/update', 'a publication hold requires its original draft creation identity',
      { path: id, reason: 'invalid' })
  }
  const truth = input.truth.replaceAll('\r\n', '\n').trim()
  if (hasKnowledgeStorageMarker(truth)) {
    throw new RemoteError('knowledge/update', 'current understanding cannot contain Brain storage markers', { path: id, reason: 'invalid' })
  }
  const digest = createHash('sha256').update(JSON.stringify([
    'create', id, input.title, input.status, input.category, input.tags, input.truth, input.kind, input.summary, input.source, input.evidence,
    ...importHold === undefined ? [] : importPublicationHoldIdentity(importHold),
    ...taskHold === undefined ? [] : ['task', ...taskPublicationHoldIdentity(taskHold)],
    ...goalHold === undefined ? [] : ['goal', ...goalPublicationHoldIdentity(goalHold)],
  ])).digest('hex')
  const tags = normalizeKnowledgeTags(input.tags)
  const frontmatter = stringify({ id: match[1], title: input.title.trim(), status: input.status,
    category: input.category, ...tags.length === 0 ? {} : { tags }, created: now, updated: now,
    ...importHold === undefined ? {} : { [IMPORT_PUBLICATION_HOLD_KEY]: importHold },
    ...taskHold === undefined ? {} : { [TASK_PUBLICATION_HOLD_KEY]: taskHold },
    ...goalHold === undefined ? {} : { [GOAL_PUBLICATION_HOLD_KEY]: goalHold } }, { lineWidth: 0 })
  const timeline = stringify([{ time: now, kind: input.kind, summary: input.summary, source: input.source,
    evidence: input.evidence, dsh_operation_id: input.operationId, dsh_request_digest: digest }], { lineWidth: 0 })
  const text = `---\n${frontmatter}---\n\n${serializeKnowledgeBody(truth, timeline)}`
  checkSize(text)
  parseKnowledgeDocument(id, text, digest)
  return { text, digest }
}

/** Recognize an identical creation without rolling back subsequent edits or lifecycle changes.
 * @param id - existing page identity.
 * @param text - complete bounded current file, already validated by the reader.
 * @param operationId - caller-retained creation UUID.
 * @param digest - digest from the complete original creation request.
 * @throws when the page belongs to another creation or its operation receipt differs or is ambiguous.
 */
export function requireCreationReceipt(id: KnowledgeDocumentId, text: string, operationId: string, digest: string): void {
  const history = knowledgeSource(text, true).timeline.value as Record<string, unknown>[] | null
  const receipts = history?.filter(row => row.dsh_operation_id === operationId) ?? []
  if (receipts.length === 0) {
    throw new RemoteError('knowledge/update', 'knowledge page already exists; read and update it instead', { path: id, reason: 'conflict' })
  }
  if (receipts.length !== 1 || receipts[0]?.dsh_request_digest !== digest) {
    throw new RemoteError('knowledge/update', 'knowledge creation identity belongs to different or ambiguous history', { path: id, reason: 'identity-conflict' })
  }
}
