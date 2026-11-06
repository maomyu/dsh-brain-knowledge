/** Validate the file-owned Goal human-review hold before readers or writers trust it. */
import { z } from 'zod'
import type { KnowledgeGoalPublicationHold } from './types.ts'

/** Reserved metadata key retained until a separately confirmed Goal draft publication. */
export const GOAL_PUBLICATION_HOLD_KEY = 'dsh_goal_publication_hold'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const reference = z.string().min(1).refine(value => !value.includes('\0'))
const schema = z.object({
  version: z.literal(1),
  workspaceId: reference,
  goalRunId: z.uuid(),
  planRequestId: reference,
  taskId: z.uuid(),
  reportSha256: digest,
  candidateSha256: digest,
  decisionId: z.uuid(),
  draftOperationId: z.uuid(),
}).strict()

/** Read a Goal hold from complete YAML frontmatter.
 * @param metadata - parsed page frontmatter, never a caller assertion.
 * @returns the validated hold, or null when absent.
 * @throws when reserved Goal hold metadata is malformed.
 */
export function readGoalPublicationHold(metadata: unknown): KnowledgeGoalPublicationHold | null {
  if (metadata === null || metadata === undefined) return null
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('knowledge frontmatter must be an object')
  const fields = metadata as Record<string, unknown>
  if (!(GOAL_PUBLICATION_HOLD_KEY in fields)) return null
  const parsed = schema.safeParse(fields[GOAL_PUBLICATION_HOLD_KEY])
  if (!parsed.success) throw new Error('knowledge Goal publication hold is malformed')
  return parsed.data as KnowledgeGoalPublicationHold
}

/** Validate the Goal owner's immutable draft identity before writing it to a Brain page.
 * @param hold - signed plan, Task report, candidate, decision and creation identity.
 * @returns serializable validated hold metadata.
 */
export function validateGoalPublicationHold(hold: KnowledgeGoalPublicationHold): KnowledgeGoalPublicationHold {
  const parsed = schema.safeParse(hold)
  if (!parsed.success) throw new Error('knowledge Goal publication hold is malformed')
  return parsed.data as KnowledgeGoalPublicationHold
}

/** Compare all retained Goal fields, including the signed plan and creation UUID.
 * @param actual - hold read from the page.
 * @param expected - Goal owner's exact retained hold.
 * @returns whether the two identities match.
 */
export function sameGoalPublicationHold(actual: KnowledgeGoalPublicationHold, expected: KnowledgeGoalPublicationHold): boolean {
  const observed = goalPublicationHoldIdentity(actual)
  const retained = goalPublicationHoldIdentity(expected)
  return observed.every((value, index) => value === retained[index])
}

/** Stable Goal hold identity for file receipts, independent of object key insertion order.
 * @param hold - validated Goal hold.
 * @returns every retained field in fixed order.
 */
export function goalPublicationHoldIdentity(hold: KnowledgeGoalPublicationHold): readonly (string | number)[] {
  return [hold.version, hold.workspaceId, hold.goalRunId, hold.planRequestId, hold.taskId,
    hold.reportSha256, hold.candidateSha256, hold.decisionId, hold.draftOperationId]
}
