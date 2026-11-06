/** Shared Task/Goal discovery transport with owner-specific authority and project checks. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectTaskKnowledgeDiscoveryWriter, ProjectTaskSessionProject, ProjectTaskKnowledgeCatalogReadRequest,
  ProjectTaskKnowledgeDraftReview, ProjectTaskKnowledgeCatalogRead } from '@deepseek-ai/dsh-api-task-controller/types'
import { automaticTaskRequest, automaticTaskResult } from './automatic-task-request.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { readHeldCatalogPage } from './held-catalog-read.ts'
import type { KnowledgeDocumentId, KnowledgeTaskDraftReview } from './types.ts'
import type {} from './index.ts'

/** Bind automatic maintenance while keeping the caller's exact authority kind and active project.
 * @param ctx - Host Brain service context.
 * @param requireOriginalProject - owner's active-project identity check.
 * @param kind - authority accepted by this registered writer.
 * @returns apply and inspect operations shared by Task and Goal writers.
 */
export function automaticDiscoveryWriter(ctx: Context,
  requireOriginalProject: (project: ProjectTaskSessionProject) => void,
  kind: 'task' | 'goal'): Pick<ProjectTaskKnowledgeDiscoveryWriter, 'applyAutomatic' | 'inspectAutomatic'> {
  return {
    async applyAutomatic(project, request, signal, beforePublish) {
      requireOriginalProject(project)
      if (request.authority.kind !== kind) throw new Error(kind === 'task'
        ? 'Task automatic maintenance requires its original Task permission' : 'Goal automatic maintenance requires its exact signed permission')
      return automaticTaskResult(await ctx.knowledgeController.maintainAutomatically(project.id,
        automaticTaskRequest(request), signal, async (retry) => {
          requireOriginalProject(project)
          await beforePublish(retry)
          requireOriginalProject(project)
        }))
    },
    async inspectAutomatic(project, request, signal) {
      requireOriginalProject(project)
      const inspection = await ctx.knowledgeController.inspectAutomaticMaintenance(project.id,
        automaticTaskRequest(request), signal)
      requireOriginalProject(project)
      return inspection.status === 'applied' || inspection.status === 'deferred' ? automaticTaskResult(inspection) : inspection
    },
  }
}

/** Project the full held document and active catalog into the discovery consumer's public fields.
 * @param review - stable draft and catalog read by the Brain owner.
 * @returns complete displayed understanding and Timeline, without internal receipt metadata.
 */
export function discoveryDraftReview(review: KnowledgeTaskDraftReview): ProjectTaskKnowledgeDraftReview {
  const { entry, body, markdown, timeline } = review.document
  return { document: { id: entry.id, version: entry.version, title: entry.title, category: entry.category,
    tags: entry.tags, body, markdown, timeline: timeline.map(({ time, kind, summary, source, affects, evidence, author }) =>
      ({ time, kind, summary, source, affects, evidence, ...(author === undefined ? {} : { author }) })) },
  activeIndexDigest: review.activeIndexDigest, activePageCount: review.activePageCount, activePages: review.activePages }
}

/** Keep an original-project read bound to the same active project across asynchronous work.
 * @param project - retained Task or Goal project identity.
 * @param requireOriginalProject - owner's active-project validation.
 * @param read - read operation admitted after the first validation.
 * @returns the result only after the same project passes validation again.
 */
export async function readDiscoveryProject<T>(project: ProjectTaskSessionProject,
  requireOriginalProject: (project: ProjectTaskSessionProject) => void, read: () => Promise<T>): Promise<T> {
  requireOriginalProject(project)
  const result = await read()
  requireOriginalProject(project)
  return result
}

/** Bind held-draft and catalog readers to the same original-project validation.
 * @param ctx - Host Brain document reader.
 * @param requireOriginalProject - consumer's original active-project check.
 * @param readDraft - bound Task or Goal held-draft method with its own identity validation.
 * @returns complete review and old-page read operations for that hold type.
 */
export function heldDiscoveryReader<Hold>(ctx: Context,
  requireOriginalProject: (project: ProjectTaskSessionProject) => void,
  readDraft: (workspaceId: WorkspaceId, documentId: KnowledgeDocumentId, hold: Hold,
    signal: AbortSignal) => Promise<KnowledgeTaskDraftReview>): {
  reviewDraft: (project: ProjectTaskSessionProject, documentId: KnowledgeDocumentId, hold: Hold,
    signal: AbortSignal) => Promise<ProjectTaskKnowledgeDraftReview>
  readCatalogPage: (project: ProjectTaskSessionProject, documentId: KnowledgeDocumentId, hold: Hold,
    request: ProjectTaskKnowledgeCatalogReadRequest, signal: AbortSignal) => Promise<ProjectTaskKnowledgeCatalogRead>
} {
  const reviewDraft = async (project: ProjectTaskSessionProject, documentId: KnowledgeDocumentId, hold: Hold, signal: AbortSignal) =>
    discoveryDraftReview(await readDiscoveryProject(project, requireOriginalProject,
      () => readDraft(project.id, documentId, hold, signal)))
  return { reviewDraft, readCatalogPage(project: ProjectTaskSessionProject, documentId: KnowledgeDocumentId, hold: Hold,
    request: ProjectTaskKnowledgeCatalogReadRequest, signal: AbortSignal) {
    return readDiscoveryProject(project, requireOriginalProject, () => readHeldCatalogPage(
      () => reviewDraft(project, documentId, hold, signal), () => ctx.knowledgeController.read(project.id, request.path, signal), request))
  } }
}
