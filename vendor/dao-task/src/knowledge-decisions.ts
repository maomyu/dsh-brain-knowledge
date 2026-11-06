/** Shared human-choice identities and complete source-review admission. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { matchesKnowledgeSourceDispositions, canPublishKnowledgeSources, hasIndependentKnowledgeTerm } from './knowledge-discovery.ts'
import type { KnowledgeDiscoverySource } from './knowledge-discovery.ts'
import type { ProjectTaskKnowledgeDecision, ProjectTaskKnowledgeDecisionRequest,
  ProjectTaskKnowledgeSourceDisposition } from './types.ts'

/** Compare a repeated gesture with the complete original choice.
 * @param decision - durable decision and its immutable request fields.
 * @param request - repeated human choice.
 * @returns whether the identity, destination and complete reviewed fields match.
 */
export function matchingKnowledgeDecision(decision: ProjectTaskKnowledgeDecision,
  request: ProjectTaskKnowledgeDecisionRequest): boolean {
  if (decision.decisionId !== request.decisionId || decision.candidateId !== request.candidateId
    || decision.resultSha256 !== request.resultSha256 || decision.candidateSha256 !== request.candidateSha256) return false
  switch (request.action) {
    case 'dismiss': return decision.status === 'dismissed' && decision.reason === request.reason
    case 'propose-existing': return (decision.status === 'proposal-pending' || decision.status === 'proposal-saved')
      && decision.path === request.path && decision.expectedVersion === request.expectedVersion
      && decision.reviewedTruth === request.reviewedTruth
      && decision.reviewedSummary === request.reviewedSummary
      && decision.reviewedEvidence === request.reviewedEvidence
      && JSON.stringify(decision.reviewedSourceDispositions) === JSON.stringify(request.reviewedSourceDispositions)
    case 'save-draft': return (decision.status === 'draft-pending' || decision.status === 'draft-saved')
      && decision.path === request.path && decision.title === request.title && decision.category === request.category
      && JSON.stringify(decision.tags) === JSON.stringify(request.tags) && decision.kind === request.kind
      && decision.reviewedTruth === request.reviewedTruth
      && decision.reviewedSummary === request.reviewedSummary
      && decision.reviewedEvidence === request.reviewedEvidence
      && JSON.stringify(decision.reviewedSourceDispositions) === JSON.stringify(request.reviewedSourceDispositions)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(request)
  }
}

/** Check the exact source matrix, including publication eligibility when required.
 * @param retained - source dispositions saved in the candidate.
 * @param reviewed - optional human replacement dispositions.
 * @param sources - complete original readable sources.
 * @param resolved - whether active publication requires every source resolved.
 * @returns whether the chosen dispositions cover and, when required, resolve the sources.
 */
export function knowledgeSourcesReviewed(retained: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined,
  reviewed: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined,
  sources: readonly KnowledgeDiscoverySource[], resolved: boolean): boolean {
  const effective = reviewed ?? retained
  return effective !== undefined && matchesKnowledgeSourceDispositions(effective, sources)
    && (!resolved || canPublishKnowledgeSources(effective))
}

/** Copy only explicitly retained human source corrections into a resumed request.
 * @param decision - durable human correction fields.
 * @returns those fields in their original request order, omitting absent values.
 */
export function reviewedKnowledgeFields(decision: {
  readonly reviewedTruth?: string | undefined
  readonly reviewedSummary?: string | undefined
  readonly reviewedEvidence?: string | undefined
  readonly reviewedSourceDispositions?: readonly ProjectTaskKnowledgeSourceDisposition[] | undefined
}): Pick<Extract<ProjectTaskKnowledgeDecision, { status: 'proposal-pending' | 'proposal-saved' }>,
  'reviewedTruth' | 'reviewedSummary' | 'reviewedEvidence' | 'reviewedSourceDispositions'> {
  return { ...(decision.reviewedTruth === undefined ? {} : { reviewedTruth: decision.reviewedTruth }),
    ...(decision.reviewedSummary === undefined ? {} : { reviewedSummary: decision.reviewedSummary }),
    ...(decision.reviewedEvidence === undefined ? {} : { reviewedEvidence: decision.reviewedEvidence }),
    ...(decision.reviewedSourceDispositions === undefined ? {} : {
      reviewedSourceDispositions: decision.reviewedSourceDispositions }) }
}

/** Compare complete page/version sets without making capture order authoritative.
 * @param actual - current complete catalog pages.
 * @param expected - reviewed candidate page identities.
 * @returns whether both sorted identities and versions match exactly.
 */
export function sameCatalogPageVersions(actual: readonly { readonly path: string
  readonly version: string }[],
expected: readonly { readonly path: string
  readonly version: string }[]): boolean {
  const versions = (pages: typeof actual) => pages.map(page => [page.path, page.version] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify(versions(actual)) === JSON.stringify(versions(expected))
}

/** Select a retained or evidence-derived independent query for a proposed new page.
 * @param candidate - retained candidate text and optional original topic search.
 * @param title - human-selected draft title.
 * @returns the independent bounded query, or absence when the choice cannot proceed.
 */
export function independentDraftTopic(candidate: { readonly kind: string
  readonly proposedTruth: string
  readonly evidence: string
  readonly topicSearch?: { readonly query: string } | undefined }, title: string): string | undefined {
  const query = (candidate.topicSearch?.query ?? [candidate.proposedTruth.slice(0, 256), candidate.evidence.slice(0, 256)]
    .find(value => hasIndependentKnowledgeTerm(value, title)))?.trim()
  return candidate.kind === 'new-page' && title.length <= 256 && query !== undefined
    && hasIndependentKnowledgeTerm(query, title) ? query : undefined
}
