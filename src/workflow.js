export function sourceProjects(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const scope = registry.conversationExecutionProjects(sessionId)
  const space = registry.spaces.find(item => item.spaceId === scope?.spaceId)
  const projects = (space?.projectIds ?? []).map(id => registry.get(id)).filter(project =>
    project && project.archivedAt === undefined)
  return { projects, direct: projects.find(project => project.sessionIds.includes(sessionId)) }
}

export class ConversationWorkflow {
  constructor(ctx) {
    this.ctx = ctx
  }

  async request(input, signal) {
    if (typeof input.sessionId !== 'string') throw new Error('对话无效。')
    const { projects, direct } = sourceProjects(this.ctx, input.sessionId)
    const tasks = this.ctx.taskController
    const cards = projects.flatMap(project => tasks.listCards(project.id, input.sessionId))
    const goal = direct ? tasks.currentGoal(direct.id, input.sessionId) : null
    if (input.op === 'workflow') {
      const taskIds = new Set([
        ...(goal?.progress ?? []).map(row => row.taskId).filter(Boolean),
        ...(goal?.planHistory ?? []).flatMap(row => row.taskIds),
      ])
      const goalTasks = [...taskIds].map(id => tasks.inspect(direct.id, id)).filter(Boolean)
      const taskDetails = cards.flatMap(card => {
        if (!card.taskId) return []
        const task = tasks.inspect(card.workspaceId, card.taskId)
        if (!task) return []
        return [{
          id: task.id, status: task.status, terminalPhase: task.terminal?.phase,
          canOpenTerminal: task.isolation === 'worktree' && task.status.startsWith('closed-'),
          canResumeTerminal: task.isolation === 'worktree' && task.status === 'closed-failed'
            && (task.codex?.threadId !== undefined || task.claude?.sessionId !== undefined),
        }]
      })
      return { cards, taskDetails, terminalAvailable: process.platform === 'darwin', goal, goalTasks, goalProjectId: direct?.id, projects: projects.map(({ id, title }) => ({ id, title })) }
    }
    if (input.op === 'workflow-goal-options') {
      if (!direct || goal?.phase !== 'SIGNOFF' || goal.id !== input.goalId) throw new Error('审批计划已变化。')
      return await tasks.goalReviewOptions(direct.id, input.sessionId)
    }
    if (input.op === 'workflow-goal-codex-models') {
      if (!direct || goal?.phase !== 'SIGNOFF' || goal.id !== input.goalId) throw new Error('审批计划已变化。')
      return { models: await tasks.codexModels(direct.id, signal) }
    }
    if (input.op === 'workflow-goal-review') {
      if (!direct || goal?.id !== input.goalId) throw new Error('审批计划已变化。')
      return await tasks.reviewGoalPlan(direct.id, input.sessionId, goal.id, input.request, signal)
    }
    if (input.op.startsWith('workflow-goal-')) {
      if (!direct || !goal || goal.id !== input.goalId) throw new Error('该目标不属于当前对话。')
      const brain = this.ctx.knowledgeController
      const target = input.projectId ? { path: input.path, projectId: input.projectId } : input.path
      const goalArgs = [input.sessionId, goal.id]
      switch (input.op) {
        case 'workflow-goal-history': return await brain.goalWriteHistory(...goalArgs, signal)
        case 'workflow-goal-change': return await brain.goalChange(...goalArgs, target, signal)
        case 'workflow-goal-change-review': return await brain.reviewGoalChange(...goalArgs, target, input.request, signal)
      }
      const task = tasks.inspect(direct.id, input.taskId)
      if (task?.goal?.runId !== goal.id) throw new Error('该任务不属于当前目标。')
      const args = [direct.id, task.id]
      switch (input.op) {
        case 'workflow-goal-coding': return await tasks.getGoalTaskCodingFiles(direct.id, ...goalArgs, task.id, signal)
        case 'workflow-goal-automatic': return await tasks.resumeGoalAutomaticKnowledge(...args, signal)
        case 'workflow-goal-retry': return await tasks.retryGoalKnowledgeDiscovery(...args, input.requestId, signal)
        case 'workflow-goal-refresh': return await tasks.refreshGoalKnowledgeDiscovery(...args, input.requestId, signal)
        case 'workflow-goal-recheck': return await tasks.recheckGoalNoChangeKnowledgeDiscovery(...args, input.requestId, signal)
        case 'workflow-goal-decide': return await tasks.decideGoalKnowledge(...args, input.request, signal)
        case 'workflow-goal-draft': return await tasks.reviewGoalKnowledgeDraft(...args, signal)
        case 'workflow-goal-read': return await tasks.readGoalKnowledgeCatalogPage(...args, input.request, signal)
        case 'workflow-goal-publish': return await tasks.publishGoalKnowledgeDraft(...args, input.request, signal)
        case 'workflow-goal-publication': return await tasks.reviewGoalKnowledgePublication(...args, signal)
        case 'workflow-goal-inspect': return await tasks.inspectGoalKnowledgePublication(...args, signal)
        case 'workflow-goal-ack': return await tasks.acknowledgeGoalKnowledgePublication(...args, input.request, signal)
        case 'workflow-goal-resume': return await tasks.resumeGoalKnowledgeDecision(...args, signal)
        case 'workflow-goal-artifact': return await this.artifact(...args, input, signal)
        default: throw new Error('无效的目标操作。')
      }
    }
    const card = cards.find(item => item.id === input.cardId && item.workspaceId === input.projectId)
    if (!card) throw new Error('该任务不属于当前对话。')
    const args = [card.workspaceId, card.id]
    if (input.op === 'workflow-task-codex-models') return { models: await tasks.codexModels(card.workspaceId, signal) }
    if (input.op === 'workflow-task-review-sources') return {
      groups: await this.ctx.knowledgeImportController.listTaskSources(card.workspaceId, signal),
    }
    if (input.op === 'workflow-task-terminal') {
      if (card.status === 'pending' && !input.selection) throw new Error('请选择原生终端执行器。')
      return await tasks.acceptTerminalCard(...args, input.selection ?? null, input.allowDirty === true, signal)
    }
    if (input.op === 'workflow-task-dismiss') return await tasks.dismissCard(...args, signal)
    if (input.op === 'workflow-task-accept') {
      if (!['automatic', 'read-only'].includes(input.mode)) throw new Error('请选择知识沉淀方式。')
      return await tasks.acceptCodingCard(...args, {
        execution: input.execution ?? { runtime: 'harness' }, knowledgeMaintenance: input.mode,
        ...(input.review ? { review: input.review } : {}),
        ...(input.postSteps ? { postSteps: input.postSteps } : {}),
        ...(input.reviewSources?.length ? { reviewSources: input.reviewSources } : {}),
      }, input.allowDirty === true, signal)
    }
    if (input.op === 'workflow-task-delivery') {
      if (!['followup', 'view', 'ignore'].includes(input.action)) throw new Error('无效的结果处理方式。')
      return await tasks.completeCard(...args, input.action, signal)
    }
    if (!card.taskId) throw new Error('任务尚未执行。')
    const taskArgs = [card.workspaceId, card.taskId]
    switch (input.op) {
      case 'workflow-task-open-terminal': {
        if (!['open', 'resume'].includes(input.action)) throw new Error('无效的终端操作。')
        return await tasks.openTerminal(...taskArgs, input.action, signal)
      }
      case 'workflow-task-review': return await tasks.reviewTaskKnowledge(...taskArgs, signal)
      case 'workflow-task-automatic': return await tasks.resumeTaskAutomaticKnowledge(...taskArgs, signal)
      case 'workflow-task-stop': return await tasks.cancelTaskKnowledgeReview(...taskArgs, signal)
      case 'workflow-task-resume': return await tasks.resumeTaskKnowledgeDecision(...taskArgs, signal)
      case 'workflow-task-refresh': return await tasks.refreshTaskKnowledgeDiscovery(...taskArgs, input.requestId, signal)
      case 'workflow-task-recheck': return await tasks.recheckTaskNoChangeKnowledgeDiscovery(...taskArgs, input.requestId, signal)
      case 'workflow-task-retry': return await tasks.retryTaskKnowledgeDiscovery(...taskArgs, input.requestId, signal)
      case 'workflow-task-decide': return await tasks.decideTaskKnowledge(...taskArgs, input.request, signal)
      case 'workflow-task-draft': return await tasks.reviewTaskKnowledgeDraft(...taskArgs, signal)
      case 'workflow-task-read': return await tasks.readTaskKnowledgeCatalogPage(...taskArgs, input.request, signal)
      case 'workflow-task-publish': return await tasks.publishTaskKnowledgeDraft(...taskArgs, input.request, signal)
      case 'workflow-task-publication': return await tasks.reviewTaskKnowledgePublication(...taskArgs, signal)
      case 'workflow-task-inspect': return await tasks.inspectTaskKnowledgePublication(...taskArgs, signal)
      case 'workflow-task-ack': return await tasks.acknowledgeTaskKnowledgePublication(...taskArgs, input.request, signal)
      case 'workflow-task-artifact': return await this.artifact(...taskArgs, input, signal)
      default: throw new Error('无效的任务操作。')
    }
  }

  async artifact(projectId, taskId, input, signal) {
    const tasks = this.ctx.taskController
    const listed = await tasks.listDocumentationFiles(projectId, taskId, signal)
    const file = listed?.files.find(item => item.path === input.path)
    if (!file || listed.directoryVersion !== input.version) throw new Error('该任务文件已变化。')
    return await tasks.readDocumentationFile(projectId, taskId, file.id, input.version, signal)
  }

  async *follow(input, signal) {
    const { projects, direct } = sourceProjects(this.ctx, input.sessionId)
    const anchor = direct ?? projects[0]
    if (!anchor) return
    const life = new AbortController()
    const active = AbortSignal.any([signal, life.signal])
    const tasks = this.ctx.taskController
    const source = tasks.followActiveSource(anchor.id, input.sessionId, active)[Symbol.asyncIterator]()
    const goal = direct && tasks.followGoalProject(direct.id, active)[Symbol.asyncIterator]()
    try {
      const registrations = await Promise.all([source.next(), goal?.next()])
      if (registrations[0].done || registrations[1]?.done) return
      yield { active: true }
      await Promise.race([source.next(), goal?.next() ?? new Promise(() => {})])
    } finally {
      life.abort()
      await Promise.allSettled([source.return?.(), goal?.return?.()])
    }
  }
}
