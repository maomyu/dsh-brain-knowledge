/** Translate Task-owned automatic permissions without admitting historical human candidates. */
import type { ProjectTaskKnowledgeAutomaticRequest, ProjectTaskKnowledgeAutomaticResult } from '@deepseek-ai/dsh-api-task-controller/types'
import type { KnowledgeAutomaticAuthority, KnowledgeAutomaticMaintenanceRequest, KnowledgeAutomaticMaintenanceResult } from './types.ts'

/** Project the exact consumer-owned AI intent into the Brain writer's independent permission record.
 * @param request - immutable Task or signed Goal request, never a human decision.
 * @returns complete Brain request with no new permissions or defaulted legacy evidence.
 * @throws when a Goal identity or page relation is absent.
 */
export function automaticTaskRequest(request: ProjectTaskKnowledgeAutomaticRequest): KnowledgeAutomaticMaintenanceRequest {
  const { kind, goalRunId, planRequestId, ...identity } = request.authority
  let authority: KnowledgeAutomaticAuthority
  if (kind === 'task') authority = { ...identity, kind, candidateId: request.candidateId }
  else {
    if (goalRunId === undefined || planRequestId === undefined) throw new Error('Automatic Goal knowledge requires its exact signed run and plan')
    authority = { ...identity, kind, goalRunId, planRequestId, candidateId: request.candidateId }
  }
  return { operationId: request.operationId, authority, reviewerSessionId: request.reviewerSessionId,
    resultSha256: request.resultSha256, candidateSha256: request.candidateSha256,
    locationRevision: request.locationRevision, catalogSha256: request.catalogSha256, sourceCoverage: request.sourceCoverage,
    sources: request.sources, sourceDispositions: request.sourceDispositions,
    comparedPages: request.comparedPages.map((page) => {
      if (page.relation === undefined) throw new Error('Historical page comparisons grant no automatic write permission')
      return { ...page, relation: page.relation }
    }), titleSearch: request.titleSearch, ...(request.topicSearch === undefined ? {} : { topicSearch: request.topicSearch }),
    change: request.change }
}

/** Keep the Task consumer's bounded states without misreporting disabled maintenance as source failure.
 * @param result - exact Brain file receipt or evidence deferral.
 * @returns the corresponding Task state.
 * @throws when the deployment has not enabled automatic maintenance.
 */
export function automaticTaskResult(result: KnowledgeAutomaticMaintenanceResult): ProjectTaskKnowledgeAutomaticResult {
  if (result.status === 'applied') return result
  if (result.reason === 'disabled') throw new Error('Automatic Brain maintenance is disabled in this deployment')
  return { status: result.status, reason: result.reason }
}
