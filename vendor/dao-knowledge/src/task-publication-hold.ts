/** Validate the independent file-owned Task draft hold before readers or writers trust it. */
import { z } from 'zod'
import type { KnowledgeTaskPublicationHold } from './types.ts'

/** Reserved frontmatter key retained until the exact Task draft is explicitly published. */
export const TASK_PUBLICATION_HOLD_KEY = 'dsh_task_publication_hold'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const schema = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1).refine(value => !value.includes('\0')),
  taskId: z.string().min(1).refine(value => !value.includes('\0')),
  discoveryId: z.uuid(),
  resultSha256: digest,
  candidateSha256: digest,
  decisionId: z.uuid(),
  draftOperationId: z.uuid(),
}).strict()

/** Read the Task hold from a complete YAML frontmatter value.
 * @param metadata - parsed page frontmatter, never a caller assertion.
 * @returns the validated hold, or null if absent.
 * @throws when reserved hold metadata is malformed.
 */
export function readTaskPublicationHold(metadata: unknown): KnowledgeTaskPublicationHold | null {
  if (metadata === null || metadata === undefined) return null
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('knowledge frontmatter must be an object')
  const fields = metadata as Record<string, unknown>
  if (!(TASK_PUBLICATION_HOLD_KEY in fields)) return null
  const parsed = schema.safeParse(fields[TASK_PUBLICATION_HOLD_KEY])
  if (!parsed.success) throw new Error('knowledge Task publication hold is malformed')
  return parsed.data as KnowledgeTaskPublicationHold
}

/** Validate the Task owner's immutable draft identity before writing it to a Brain page.
 * @param hold - Task, discovery, candidate, decision and draft creation identity.
 * @returns serializable validated hold metadata.
 */
export function validateTaskPublicationHold(hold: KnowledgeTaskPublicationHold): KnowledgeTaskPublicationHold {
  const parsed = schema.safeParse(hold)
  if (!parsed.success) throw new Error('knowledge Task publication hold is malformed')
  return parsed.data as KnowledgeTaskPublicationHold
}

/** Compare every retained field, including the original draft creation UUID.
 * @param actual - hold read from the page.
 * @param expected - Task owner's exact retained hold.
 * @returns whether the two identities match.
 */
export function sameTaskPublicationHold(actual: KnowledgeTaskPublicationHold, expected: KnowledgeTaskPublicationHold): boolean {
  const observed = taskPublicationHoldIdentity(actual)
  const retained = taskPublicationHoldIdentity(expected)
  return observed.every((value, index) => value === retained[index])
}

/** Stable ordered identity for file receipts, independent of object key insertion order.
 * @param hold - validated Task hold.
 * @returns every retained field in fixed order.
 */
export function taskPublicationHoldIdentity(hold: KnowledgeTaskPublicationHold): readonly (string | number)[] {
  return [hold.version, hold.workspaceId, hold.taskId, hold.discoveryId, hold.resultSha256,
    hold.candidateSha256, hold.decisionId, hold.draftOperationId]
}
