/** Bind Task-owned human discovery decisions to narrow Brain Host writers. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectTaskKnowledgeDiscoveryWriter, ProjectTaskSessionProject } from '@deepseek-ai/dsh-api-task-controller/types'
import type {} from './index.ts'
import { automaticDiscoveryWriter, heldDiscoveryReader } from './discovery-writer.ts'

/** Register Brain proposal and held-draft operations without granting ordinary Task model writes.
 * @param ctx - plugin context owning both Task and Brain service lifetimes.
 */
export function registerTaskDiscoveryWriter(ctx: Context): void {
  ctx.inject(['taskController', 'workspaceRegistry', 'knowledgeController'], (scope) => {
    const requireOriginalProject = (project: ProjectTaskSessionProject): void => {
      const current = scope.workspaceRegistry.get(project.id)
      if (current === undefined || current.archivedAt !== undefined || current.path !== project.path) {
        throw new Error('Task discovery requires its original active project')
      }
    }
    const writer: ProjectTaskKnowledgeDiscoveryWriter = {
      ...automaticDiscoveryWriter(scope, requireOriginalProject, 'task'),
      async proposeExisting(project, documentId, taskId, request, signal, beforePublish) {
        requireOriginalProject(project)
        return scope.knowledgeController.proposeTaskTruth(project.id, documentId, taskId, request, signal, beforePublish)
      },
      async createDraft(project, documentId, request, hold, signal, beforePublish) {
        requireOriginalProject(project)
        return scope.knowledgeController.createHeldTaskDraft(project.id, documentId, request, hold, signal, beforePublish)
      },
      ...heldDiscoveryReader(scope, requireOriginalProject,
        scope.knowledgeController.reviewHeldTaskDraft.bind(scope.knowledgeController)),
      async publishDraft(project, documentId, request, hold, expectedActiveIndexDigest, signal, beforePublish) {
        requireOriginalProject(project)
        return scope.knowledgeController.publishHeldTaskDraft(project.id, documentId, request, hold,
          expectedActiveIndexDigest, signal, beforePublish)
      },
      async reviewPublication(project, documentId, request, hold, expectedActiveIndexDigest, signal) {
        try {
          requireOriginalProject(project)
          return await scope.knowledgeController.reviewTaskPublication(project.id, documentId, request, hold,
            expectedActiveIndexDigest, signal)
        } catch {
          return { status: 'unknown', reason: 'catalog-unavailable' }
        }
      },
      async inspectPublication(project, documentId, request, hold, expectedActiveIndexDigest, signal) {
        try {
          requireOriginalProject(project)
          return await scope.knowledgeController.inspectTaskPublication(project.id, documentId, request, hold,
            expectedActiveIndexDigest, signal)
        } catch {
          return { status: 'unknown', reason: 'catalog-unavailable' }
        }
      },
    }
    scope.effect(() => scope.taskController.registerKnowledgeDiscoveryWriter(writer), 'project-brain: task discovery writer')
  })
}
