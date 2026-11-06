/** Validate an exact human relation for every active Brain page before a Task or Goal draft publishes. */
import { createHash } from 'node:crypto'
import type { ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgePageJudgment,
  ProjectTaskKnowledgeCatalogReadReceipt,
  ProjectTaskKnowledgeCatalogReadRequest, ProjectTaskKnowledgeDecision,
  ProjectTaskFailure } from './types.ts'

/** A publication cannot rely on client-supplied relations without Host-retained full reads.
 * @param draftVersion - exact held draft version shown at review.
 * @param catalogDigest - complete active catalog shown at review.
 * @param pages - versioned human relations supplied for publication.
 * @param reads - durable full-body delivery receipts stored under the same Task or Goal decision.
 * @returns refusal for absent or stale reads, otherwise undefined.
 */
export function pageReadFailure(draftVersion: string, catalogDigest: string,
  pages: readonly ProjectTaskKnowledgePageJudgment[],
  reads: readonly ProjectTaskKnowledgeCatalogReadReceipt[] | undefined): ProjectTaskFailure | undefined {
  if (pages.length === 0) return undefined
  if (reads === undefined || reads.length !== pages.length) return 'knowledge-page-review-required'
  for (const page of pages) {
    const read = reads.find(item => item.path === page.path)
    if (read === undefined || read.path !== page.path || read.title !== page.title
      || read.version !== page.version || read.draftVersion !== draftVersion
      || read.activeIndexDigest !== catalogDigest || !/^[a-f0-9]{64}$/u.test(read.bodySha256)) {
      return 'knowledge-page-review-stale'
    }
  }
  return undefined
}

/** Compare the retained human choices with one complete, current Brain catalog.
 * @param review - held draft and complete active catalog served by the Brain writer.
 * @param draftVersion - version shown in the human publication request.
 * @param catalogDigest - active catalog digest shown in that request.
 * @param pages - human relations bound to the displayed page identities.
 * @param reads - durable full-body delivery receipts for those active pages.
 * @returns the precise refusal reason, or undefined when publication may proceed.
 */
export function pageReviewFailure(review: ProjectTaskKnowledgeDraftReview, draftVersion: string,
  catalogDigest: string, pages: readonly ProjectTaskKnowledgePageJudgment[],
  reads: readonly ProjectTaskKnowledgeCatalogReadReceipt[] | undefined): ProjectTaskFailure | undefined {
  if (review.document.version !== draftVersion || review.activeIndexDigest !== catalogDigest) {
    return 'knowledge-page-review-stale'
  }
  if (review.activePageCount !== review.activePages.length || pages.length !== review.activePages.length) {
    return 'knowledge-page-review-required'
  }
  for (const [index, current] of review.activePages.entries()) {
    const chosen = pages.at(index)
    if (chosen === undefined || chosen.path !== current.id) return 'knowledge-page-review-required'
    if (chosen.title !== current.title || chosen.version !== current.version) return 'knowledge-page-review-stale'
  }
  if (pages.some(page => page.relation !== 'distinct')) return 'knowledge-page-overlap-unresolved'
  return pageReadFailure(draftVersion, catalogDigest, pages, reads)
}

/** Exact same-UUID retries cannot replace previously retained human relations.
 * @param retained - choices persisted before the first Brain write attempt.
 * @param requested - choices sent by the current retry.
 * @returns whether both lists contain the same identities and relations in the same catalog order.
 */
export function samePageReview(retained: readonly ProjectTaskKnowledgePageJudgment[] | undefined,
  requested: readonly ProjectTaskKnowledgePageJudgment[]): boolean {
  return retained !== undefined && retained.length === requested.length
    && retained.every((page, index) => {
      const current = requested.at(index)
      return current !== undefined && page.path === current.path && page.title === current.title
        && page.version === current.version && page.relation === current.relation
    })
}

/** Require complete retained reads and distinct human relations before publishing a draft.
 * @param publication - pending publication with its original review versions.
 * @param reads - complete body-read receipts retained by this decision.
 * @param refuse - owner-specific refusal that preserves the original Task/Goal error.
 * @returns the exact reviewed pages after every read requirement passes.
 */
export function requirePublicationPages(publication: NonNullable<Extract<ProjectTaskKnowledgeDecision, { status: 'draft-pending' | 'draft-saved' }>['publication']>,
  reads: readonly ProjectTaskKnowledgeCatalogReadReceipt[] | undefined,
  refuse: (reason: ProjectTaskFailure) => never): readonly ProjectTaskKnowledgePageJudgment[] {
  if (publication.reviewedPages === undefined) refuse('knowledge-page-review-required')
  if (publication.reviewedPages.some(page => page.relation !== 'distinct')) refuse('knowledge-page-overlap-unresolved')
  const failure = pageReadFailure(publication.expectedDraftVersion,
    publication.expectedActiveIndexDigest, publication.reviewedPages, reads)
  if (failure !== undefined) refuse(failure)
  return publication.reviewedPages
}

/** Bind a complete delivered catalog page to the exact human review versions.
 * @param page - complete page returned by the registered Brain reader.
 * @param request - original draft and active-catalog versions.
 * @returns a full-body read receipt for the owning Task or Goal decision.
 */
export function knowledgeCatalogReadReceipt(page: { readonly id: ProjectTaskKnowledgeCatalogReadReceipt['path']
  readonly title: string
  readonly version: string
  readonly body: string }, request: ProjectTaskKnowledgeCatalogReadRequest): ProjectTaskKnowledgeCatalogReadReceipt {
  return { draftVersion: request.expectedDraftVersion, activeIndexDigest: request.expectedActiveIndexDigest,
    path: page.id, title: page.title, version: page.version, bodySha256: createHash('sha256').update(page.body).digest('hex') }
}
