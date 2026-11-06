/** Deterministic source references for a human-selected Goal research proposal. */
import { z } from 'zod'
import type { KnowledgeGoalTruthProposalIdentity } from './types.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const reference = z.string().min(1).refine(value => !value.includes('\0'))
const identitySchema = z.object({
  workspaceId: reference,
  goalRunId: z.uuid(), planRequestId: reference, taskId: z.uuid(), reportMessageId: reference,
  reportSha256: digest, discoveryId: z.uuid(), resultSha256: digest,
  candidateId: z.uuid(), candidateSha256: digest, decisionId: z.uuid(),
}).strict()

/** Derive the exact file-retained source for one signed Goal report candidate and human decision.
 * @param identity - original project, signed report, reviewed candidate and first human UUID.
 * @returns canonical source string retained with an unapproved proposal.
 */
export function goalProposalSource(identity: KnowledgeGoalTruthProposalIdentity): string {
  const parsed = identitySchema.safeParse(identity)
  if (!parsed.success) throw new Error('knowledge Goal proposal identity is malformed')
  const value = parsed.data
  return `goal:${value.goalRunId}:project:${encodeURIComponent(value.workspaceId)}:plan:${encodeURIComponent(value.planRequestId)}:task:${value.taskId}:report:${encodeURIComponent(value.reportMessageId)}:${value.reportSha256}:discovery:${value.discoveryId}:result:${value.resultSha256}:candidate:${value.candidateId}:${value.candidateSha256}:decision:${value.decisionId}`
}
