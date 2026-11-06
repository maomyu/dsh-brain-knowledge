/** Bind Goal-human research decisions to Brain Host writers without exposing a Goal agent tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectGoalKnowledgeDiscoveryWriter, ProjectTaskSessionProject } from '@deepseek-ai/dsh-api-task-controller/types'
import { goalProposalSource } from './goal-proposal.ts'
import type { KnowledgeGoalOperation, KnowledgeGoalTruthProposalIdentity } from './types.ts'
import type {} from './index.ts'
import { automaticDiscoveryWriter, heldDiscoveryReader } from './discovery-writer.ts'

/** Register original-project Goal proposal and held-draft operations separately from ordinary Task cards.
 * @param ctx - plugin context owning both Task and Brain service lifetimes.
 */
export function registerGoalDiscoveryWriter(ctx: Context): void {
  ctx.inject(['taskController', 'workspaceRegistry', 'knowledgeController'], (scope) => {
    const requireOriginalProject = (project: ProjectTaskSessionProject): void => {
      const current = scope.workspaceRegistry.get(project.id)
      if (current === undefined || current.archivedAt !== undefined || current.path !== project.path) {
        throw new Error('Goal knowledge decision requires its original active project')
      }
    }
    const writer: ProjectGoalKnowledgeDiscoveryWriter = {
      ...automaticDiscoveryWriter(scope, requireOriginalProject, 'goal'),
      async proposeExisting(project, documentId, taskId, request, subject, signal, beforePublish) {
        requireOriginalProject(project)
        if (subject.workspaceId !== project.id) throw new Error('Goal knowledge decision requires its original active project')
        const identity: KnowledgeGoalTruthProposalIdentity = { ...subject, taskId, decisionId: request.operationId }
        const source = goalProposalSource(identity)
        return scope.knowledgeController.proposeGoalTruth(project.id, documentId, identity,
          { ...request, source }, signal, async (retry) => {
            requireOriginalProject(project)
            await beforePublish(retry)
            requireOriginalProject(project)
          })
      },
      async createDraft(project, documentId, request, hold, signal, beforePublish) {
        requireOriginalProject(project)
        return scope.knowledgeController.createHeldGoalDraft(project.id, documentId, request, hold, signal,
          async (retry) => {
            requireOriginalProject(project)
            await beforePublish(retry)
            requireOriginalProject(project)
          })
      },
      ...heldDiscoveryReader(scope, requireOriginalProject,
        scope.knowledgeController.reviewHeldGoalDraft.bind(scope.knowledgeController)),
      async publishDraft(project, documentId, request, hold, expectedActiveIndexDigest, signal, beforePublish) {
        requireOriginalProject(project)
        return scope.knowledgeController.publishHeldGoalDraft(project.id, documentId, request, hold,
          expectedActiveIndexDigest, signal, async (retry) => {
            requireOriginalProject(project)
            await beforePublish(retry)
            requireOriginalProject(project)
          })
      },
      async reviewPublication(project, documentId, request, hold, expectedActiveIndexDigest, signal) {
        try {
          requireOriginalProject(project)
          return await scope.knowledgeController.reviewGoalPublication(project.id, documentId, request, hold,
            expectedActiveIndexDigest, signal)
        } catch {
          return { status: 'unknown', reason: 'catalog-unavailable' }
        }
      },
      async inspectPublication(project, documentId, request, hold, expectedActiveIndexDigest, signal) {
        try {
          requireOriginalProject(project)
          return await scope.knowledgeController.inspectGoalPublication(project.id, documentId, request, hold,
            expectedActiveIndexDigest, signal)
        } catch {
          return { status: 'unknown', reason: 'catalog-unavailable' }
        }
      },
      async inspectOperation(project, documentId, operation, failure, signal) {
        try {
          requireOriginalProject(project)
          let brainOperation: KnowledgeGoalOperation
          if (operation.kind === 'proposal') {
            const identity: KnowledgeGoalTruthProposalIdentity = { ...operation.subject, taskId: operation.taskId,
              decisionId: operation.request.operationId }
            brainOperation = { kind: 'proposal', identity,
              request: { ...operation.request, source: goalProposalSource(identity) } }
          } else brainOperation = operation
          const inspected = await scope.knowledgeController.inspectGoalOperation(project.id, documentId,
            brainOperation, failure, signal)
          requireOriginalProject(project)
          return inspected
        } catch { return { status: 'unknown' } }
      },
    }
    scope.effect(() => scope.taskController.registerGoalKnowledgeDiscoveryWriter(writer), 'project-brain: Goal discovery writer')
  })
}
