/** Exact retained Goal knowledge identity shared by Host authority and Client retry admission. */
import type { ProjectGoalKnowledgeDecisionSubject } from './types.ts'

/** Compare the original Goal, result, candidate and evidence identities.
 * @param left - retained human decision subject.
 * @param right - current retry subject.
 * @returns whether every authority and content digest still matches.
 */
export function sameKnowledgeSubject(left: ProjectGoalKnowledgeDecisionSubject,
  right: ProjectGoalKnowledgeDecisionSubject): boolean {
  return left.workspaceId === right.workspaceId && left.goalRunId === right.goalRunId
    && left.planRequestId === right.planRequestId && left.reportMessageId === right.reportMessageId
    && left.reportSha256 === right.reportSha256 && left.discoveryId === right.discoveryId
    && left.candidateId === right.candidateId && left.resultSha256 === right.resultSha256
    && left.candidateSha256 === right.candidateSha256
}
