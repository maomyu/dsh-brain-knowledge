/** Conversation-owned workspace Brain access shares the knowledge views' controller. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-api-task-controller'
import type { ProjectGoalRunId, ProjectTaskKnowledgeDiscoveryEvidence } from '@deepseek-ai/dsh-api-task-controller/types'
import type { KnowledgeDocumentId, KnowledgeUpdateId, KnowledgeTruthReceipt, KnowledgeHealthReportId,
  KnowledgeSearchResult, KnowledgeAutomaticTimelineResult, KnowledgeAutomaticConversationResult } from './types.ts'
import { renderBrainContext, renderProjectFocus } from './model-context.ts'
import { modelKnowledgeTimeline } from './documents.ts'
import { renderBrainReadChunk } from './model-read.ts'
import { renderHealthReportRead } from './model-health-read.ts'
import { renderBrainSearch } from './model-search-output.ts'
import { createBrainReadTool, createBrainUpdateTool, createBrainPageTool, createBrainStatusTool, createBrainRootTool } from './model-tool.ts'
import { requireInformedBrainRead, requireUserEvidenceSource } from './model-write-evidence.ts'
import { hasGoalApproval, hasTaskInput, taskKnowledgeReader } from './model-task.ts'
import { createGoalDecisionTool } from './model-decision.ts'
import { createBrainTimelineTool, renderReviewedTimelineResult } from './model-timeline.ts'
import { createGoalRewriteTool } from './model-rewrite.ts'
import { createBrainArchiveTool } from './model-archive.ts'
import { createBrainMergeTool, type BrainMergeResult } from './model-merge.ts'
import { createBrainFormatTool } from './model-format.ts'
import { createBrainTagsTool } from './model-tags.ts'
import { createBrainTitleTool } from './model-title.ts'
import { createBrainProposalTool } from './model-proposal.ts'
import { createBrainProposalReadTool, renderBrainProposalsRead } from './model-proposal-read.ts'
import { createBrainReindexTool } from './model-reindex.ts'
import { normalizeKnowledgeTags } from './tag-values.ts'
import { createBrainHealthReadTool, createBrainHealthMarkTool } from './model-health.ts'
import { createBrainSearchTool, resolveBrainSearch } from './model-search.ts'
import { captureBrainScope, selectBrainProjects, revalidateBrainScope } from './model-scope.ts'
import { registerPageProtocol, hasPageProtocolContext, PAGE_PROTOCOL_REMINDER } from './model-protocol.ts'
import { SourcePolicy } from './source-policy.ts'
import { registerSourceTools, sourceToolNames } from './model-sources.ts'
import { knowledgeSessionWritable } from './write-policy.ts'
import { nativeTaskKnowledge } from './native-task.ts'
import { withBrainModelWrite } from './model-write-context.ts'
import { registerTaskDiscoveryWriter } from './task-discovery-writer.ts'
import { registerGoalDiscoveryWriter } from './goal-discovery-writer.ts'

/** Source attribution retained in ordinary user/message events. */
export const name = 'project-brain'
/** Model operations require explicit project membership and the shared knowledge controller. */
export const inject = ['agents', 'tools', 'workspaceRegistry', 'knowledgeController', 'fs', 'skills']

/** Complete serialized model-input allowances; index omissions remain visible. */
export interface Config {
  /** Inclusive UTF-8 cap for each index, project-focus or selected-task contribution, including explanatory text. */
  maxContextBytes: number
  /** Complete response UTF-8 cap; long page/report/proposal reads use version-bound continuations and search snippets disclose omissions.
   * Metadata and acknowledgements cannot exceed this allowance. Task/Goal discovery uses it for ordinary Host batches,
   * retrying an oversized page only within that workflow's complete evidence allowance.
   */
  maxReadBytes: number
  /** Default and maximum number of page hits returned by one keyword search. */
  maxSearchResults: number
  /** Maximum matching source lines retained per page, each with one adjacent line on either side. */
  maxSearchMatches: number
  /** Read-only source-file, directory and search limits; independent of Brain-page lookup. */
  sources: SourcePolicy
}

/** Deployment-owned context and read allowances. */
export const Config: z<Config> = z.object({
  maxContextBytes: z.number().step(1).min(1).required(),
  maxReadBytes: z.number().step(1).min(1).required(),
  maxSearchResults: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(20),
  maxSearchMatches: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  sources: SourcePolicy.default(SourcePolicy({})),
})

/** Install project-scoped index refresh, page reading and traceable updates without a separate knowledge store.
 * @param ctx - scoped contribution lifetime and required knowledge/model services.
 * @param config - complete model-visible byte allowances.
 */
export function apply(ctx: Context, config: Config): void {
  registerPageProtocol(ctx)
  registerTaskDiscoveryWriter(ctx)
  registerGoalDiscoveryWriter(ctx)
  const brainWriteTools = new Set(['brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page',
    'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_merge_pages', 'brain_normalize_page_format',
    'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex', 'brain_mark_health_finding'])
  ctx.on('tools/execute', (exec, next) => {
    if (exec.agent === undefined || !brainWriteTools.has(exec.name)) return next()
    return withBrainModelWrite({ owner: ctx.root, sessionId: exec.agent.id, callId: exec.callId,
      name: exec.name, arguments: exec.arguments }, next)
  })
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  async function run<T>(signal: AbortSignal, operation: (live: AbortSignal) => Promise<T>): Promise<T> {
    const live = AbortSignal.any([signal, lifetime.signal])
    live.throwIfAborted()
    const result = operation(live)
    pending.add(result)
    try { return await result } finally { pending.delete(result) }
  }
  const projectFor = (id: SessionId) => {
    const task = ctx.get('taskController')?.projectForSession(id)
    if (task !== undefined) return { ...task, readOnly: true }
    const agent = ctx.agents.get(id)
    const parentId = agent?.session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if ((agent !== undefined && hasTaskInput(agent.session)) || (parent !== undefined && hasTaskInput(parent.session))) return undefined
    const project = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(id))
    return project === undefined ? undefined : { id: project.id, path: project.path, readOnly: false }
  }
  const readScopeFor = (id: SessionId) => {
    const agent = ctx.agents.get(id)
    return agent === undefined ? undefined : captureBrainScope(ctx, agent.session, projectFor(id))
  }
  ctx.inject(['taskController'], (scope) => {
    const captureBatch = async (project: { id: WorkspaceId; path: string }, query: string,
      request: { offset: number; expectedCatalogSha256?: string | undefined; maxPages: number; maxBytes: number },
      signal: AbortSignal) => run(signal, async (live) => {
      const current = ctx.workspaceRegistry.get(project.id)
      if (current?.path !== project.path || current.archivedAt !== undefined) {
        throw new Error('Task discovery project changed before Brain batch read')
      }
      const index = await ctx.knowledgeController.index(project.id, live)
      if (index.truncated || index.issues.length > 0) throw new Error('Task discovery Brain index is incomplete')
      if (query !== query.trim() || query.length === 0 || query.length > 256) {
        throw new RemoteError('project-task/discovery-input-limit', 'Task discovery search query exceeds its limit', {})
      }
      const search = request.offset !== 0 ? undefined : await ctx.knowledgeController.search(project.id, {
        query, statuses: ['active', 'draft', 'archived'], maxResults: Math.max(1, index.entries.length),
        maxMatches: 1,
      }, live)
      if (search?.truncated || (search?.issues.length ?? 0) > 0 || search !== undefined && search.exists !== index.exists) {
        throw new Error('Task discovery Brain search is incomplete')
      }
      if (search?.hits.some(hit => !index.entries.some(entry => entry.id === hit.path && entry.version === hit.version))) {
        throw new Error('Task discovery Brain search differs from its complete index')
      }
      const batch = await ctx.knowledgeController.captureDiscoveryPageBatch(project, request, live)
      if (batch.totalPages !== index.entries.length || batch.locationRevision !== index.locationRevision
        || batch.pages.some((page, indexInBatch) => {
          const entry = index.entries[request.offset + indexInBatch]
          return entry === undefined || page.path !== entry.id || page.version !== entry.version
            || page.title !== entry.title || page.status !== entry.status
        })) throw new Error('Task discovery Brain batch differs from its complete index')
      const fresh = await ctx.knowledgeController.index(project.id, live)
      const identity = (value: typeof index) => JSON.stringify([value.locationRevision, value.exists,
        value.truncated, value.issues, value.entries])
      if (identity(fresh) !== identity(index)) throw new Error('Task discovery Brain changed during batch capture')
      return { catalogSha256: batch.catalogSha256, locationRevision: batch.locationRevision,
        offset: batch.offset, totalPages: batch.totalPages, pages: batch.pages, nextOffset: batch.nextOffset,
        searches: search === undefined ? [] : [{ query,
          hits: search.hits.map(hit => ({ path: hit.path, version: hit.version })) }] }
    })
    scope.effect(() => scope.taskController.registerKnowledgeDiscoveryReader(async (project, query, limits, signal) =>
      run(signal, async (live) => {
        const current = ctx.workspaceRegistry.get(project.id)
        if (current?.path !== project.path || current.archivedAt !== undefined) {
          throw new Error('Task discovery project changed before Brain read')
        }
        const index = await ctx.knowledgeController.index(project.id, live)
        if (index.truncated || index.issues.length > 0) throw new Error('Task discovery Brain index is incomplete')
        if (index.entries.length > limits.maxPages) {
          throw new RemoteError('project-task/discovery-input-limit', 'Task discovery Brain index exceeds its page limit', {})
        }
        const queryText = query.trim().slice(0, 256)
        const search = queryText === '' ? undefined : await ctx.knowledgeController.search(project.id, {
          query: queryText, statuses: ['active', 'draft', 'archived'], maxResults: limits.maxPages, maxMatches: 1,
        }, live)
        if (search?.truncated || (search?.issues.length ?? 0) > 0) throw new Error('Task discovery Brain search is incomplete')
        if (search !== undefined && search.exists !== index.exists) {
          throw new Error('Task discovery Brain search existence differs from its complete index')
        }
        if (search?.hits.some(hit => !index.entries.some(entry => entry.id === hit.path && entry.version === hit.version))) {
          throw new Error('Task discovery Brain search differs from its complete index')
        }
        const pages: ProjectTaskKnowledgeDiscoveryEvidence['pages'][number][] = []
        const evidence: ProjectTaskKnowledgeDiscoveryEvidence = { locationRevision: index.locationRevision, pages,
          searches: search === undefined ? [] : [{ query: queryText,
            hits: search.hits.map(hit => ({ path: hit.path, version: hit.version })) }] }
        const inputLimit = (): never => {
          throw new RemoteError('project-task/discovery-input-limit',
            'Task discovery complete Brain evidence exceeds its input limit', {})
        }
        const withinInputLimit = (): void => {
          if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > limits.maxInputBytes) inputLimit()
        }
        withinInputLimit()
        let offset = 0
        let catalogSha256: string | undefined
        while (true) {
          live.throwIfAborted()
          const request = { offset, maxPages: limits.maxPages,
            maxBytes: Math.min(config.maxReadBytes, limits.maxInputBytes),
            ...(catalogSha256 === undefined ? {} : { expectedCatalogSha256: catalogSha256 }) }
          let batch: Awaited<ReturnType<typeof ctx.knowledgeController.captureDiscoveryPageBatch>>
          try {
            batch = await ctx.knowledgeController.captureDiscoveryPageBatch(project, request, live)
          } catch (error) {
            const failure = remoteErrorOf(error)
            if (failure?.code !== 'knowledge/discovery-batch' || failure.details.reason !== 'input-limit') throw error
            if (request.maxBytes === limits.maxInputBytes) inputLimit()
            try {
              batch = await ctx.knowledgeController.captureDiscoveryPageBatch(project,
                { ...request, maxBytes: limits.maxInputBytes }, live)
            } catch (retryError) {
              const retryFailure = remoteErrorOf(retryError)
              if (retryFailure?.code === 'knowledge/discovery-batch' && retryFailure.details.reason === 'input-limit') inputLimit()
              throw retryError
            }
          }
          if (batch.offset !== offset || batch.totalPages !== index.entries.length
            || batch.locationRevision !== index.locationRevision
            || catalogSha256 !== undefined && batch.catalogSha256 !== catalogSha256) {
            throw new Error('Task discovery Brain catalog changed between page batches')
          }
          for (const [indexInBatch, page] of batch.pages.entries()) {
            const entry = index.entries[offset + indexInBatch]
            if (entry === undefined || page.path !== entry.id || page.version !== entry.version
              || page.title !== entry.title || page.status !== entry.status) {
              throw new Error('Task discovery Brain batch differs from its indexed document')
            }
          }
          pages.push(...batch.pages)
          withinInputLimit()
          if (batch.nextOffset === null) {
            if (pages.length !== index.entries.length) {
              throw new Error('Task discovery Brain capture did not include every indexed document')
            }
            break
          }
          if (batch.pages.length === 0 || batch.nextOffset !== offset + batch.pages.length) {
            throw new Error('Task discovery Brain batch did not advance to its next indexed document')
          }
          offset = batch.nextOffset
          catalogSha256 = batch.catalogSha256
        }
        const fresh = await ctx.knowledgeController.index(project.id, live)
        const identity = (value: typeof index) => JSON.stringify([value.locationRevision, value.exists,
          value.truncated, value.issues, value.entries])
        const latestProject = ctx.workspaceRegistry.get(project.id)
        if (identity(fresh) !== identity(index) || latestProject?.path !== project.path
          || latestProject.archivedAt !== undefined) {
          throw new Error('Task discovery Brain changed during evidence capture')
        }
        withinInputLimit()
        return evidence
      }), captureBatch), 'project-brain: read-only task discovery')
    scope.effect(() => scope.taskController.registerKnowledgeReviewPages(async (project, refs, signal) => run(signal, async (live) => {
      const current = ctx.workspaceRegistry.get(project.id)
      if (current?.path !== project.path) throw new Error('Task knowledge project changed before review')
      const index = await ctx.knowledgeController.index(project.id, live)
      if (index.truncated || index.issues.length > 0) throw new Error('Task knowledge index is incomplete; review needs repair')
      if (ctx.workspaceRegistry.get(project.id)?.path !== project.path) throw new Error('Task knowledge project changed during review')
      const pages = new Map<string, { path: string; version: string }>()
      for (const ref of refs) {
        const matches = index.entries.filter(entry => entry.kind === 'page' && (entry.id === ref || entry.slug === ref))
        if (matches.length !== 1) throw new Error(`Task knowledge reference is missing or ambiguous: ${ref}`)
        const [entry] = matches
        if (entry?.status === 'active' && entry.category === 'decision') pages.set(entry.id, { path: entry.id, version: entry.version })
      }
      if (pages.size === 0) throw new Error('Task knowledge review has no selected active decision page')
      return [...pages.values()].sort((left, right) => left.path.localeCompare(right.path))
    })), 'project-brain: task review pages')
    scope.effect(() => scope.taskController.registerKnowledgeTimelineReceipt(async (project, sessionId, append, signal) =>
      run(signal, async (live) => {
        if (ctx.workspaceRegistry.get(project.id)?.path !== project.path) {
          throw new Error('Task knowledge project changed before Timeline receipt inspection')
        }
        const found = await ctx.knowledgeController.timelineAppendReceipt(project.id, append.path as KnowledgeDocumentId, {
          operationId: brandString<KnowledgeUpdateId>(append.operationId), expectedVersion: append.expectedVersion,
          kind: append.kind, summary: append.summary,
          ...(append.source === undefined ? {} : { source: append.source }),
          ...(append.affects === undefined ? {} : { affects: append.affects }),
          ...(append.evidence === undefined ? {} : { evidence: append.evidence }),
        }, sessionId, live)
        if (ctx.workspaceRegistry.get(project.id)?.path !== project.path) {
          throw new Error('Task knowledge project changed during Timeline receipt inspection')
        }
        return found
      })), 'project-brain: task review Timeline receipts')
    const capture = taskKnowledgeReader(ctx, config.maxContextBytes)
    scope.effect(() => scope.taskController.registerKnowledgeReader((project, selection, signal) =>
      run(signal, live => capture(project, selection, live))), 'project-brain: task handoff')
    const native = nativeTaskKnowledge(ctx, config)
    scope.effect(() => scope.taskController.registerKnowledgeTools((project) => {
      const reader = native(project)
      return { definitions: reader.definitions, read: (name, args, signal) => run(signal, async (live) => {
        const result = await reader.read(name, args, live)
        return { ...result, recordAccess: () => run(signal, () => result.recordAccess()) }
      }) }
    }), 'project-brain: native task queries')
  })
  const revalidate = (sessionId: SessionId, project: { id: WorkspaceId; path: string }): void => {
    const current = projectFor(sessionId)
    if (current?.id !== project.id || current.path !== project.path || ctx.workspaceRegistry.get(project.id)?.path !== project.path) {
      throw new Error('Project identity changed while reading Brain; retry from the current project')
    }
  }
  function observed<T extends { path: string; target_project_id?: string }>(kind: 'read' | 'write',
    execute: (args: T, exec: ToolRunContext) => Promise<string>): (args: T, exec: ToolRunContext) => Promise<string> {
    return (args, exec) => run(exec.signal, async () => {
      const project = args.target_project_id === undefined
        ? exec.agent === undefined ? undefined : projectFor(exec.agent.id)
        : ctx.workspaceRegistry.get(args.target_project_id as WorkspaceId)
      const result = await execute(args, exec)
      if (project !== undefined) await ctx.knowledgeController.recordAccess({
        projectId: project.id, documentId: args.path as KnowledgeDocumentId, kind,
        ...kind === 'write' && exec.agent !== undefined ? { writerSessionId: exec.agent.id } : {},
      })
      return result
    })
  }
  const automaticAcknowledgement = (path: string, outcome: KnowledgeAutomaticConversationResult,
    render: (disposition: KnowledgeTruthReceipt['disposition']) => string) => {
    if (outcome.status !== 'applied') {
      const review = outcome.review
      const encode = (includeReason: boolean): string => JSON.stringify({
        status: outcome.status, reason: outcome.reason, knowledge_changed: false, path,
        ...review === undefined ? {} : { review: { reviewerSessionId: review.reviewerSessionId, resultSha256: review.resultSha256,
          ...review.reason === undefined ? {} : includeReason ? { reason: review.reason } : { reason_omitted: true } } },
      })
      const complete = encode(true)
      const acknowledgement = Buffer.byteLength(complete, 'utf8') <= config.maxReadBytes ? complete : encode(false)
      if (Buffer.byteLength(acknowledgement, 'utf8') > config.maxReadBytes) {
        throw new Error('Brain acknowledgement exceeds maxReadBytes; increase the configured allowance')
      }
      return { nonWriting: true as const, acknowledgement }
    }
    return { acknowledgement: render(outcome.receipt.disposition), receipt: outcome.receipt }
  }
  const acknowledgement = (args: { path: string; operation_id: string }, targetProjectId?: string) => {
    const render = (disposition: KnowledgeTruthReceipt['disposition']): string => JSON.stringify({
      operation_id: args.operation_id, path: args.path, disposition,
      ...(targetProjectId === undefined ? {} : { project_id: targetProjectId }),
    })
    if (Buffer.byteLength(render('already-applied'), 'utf8') > config.maxReadBytes) throw new Error('Brain acknowledgement exceeds maxReadBytes; increase the configured allowance')
    return render
  }
  ctx.tools.restrictAccess((tool, scope) => {
    if (sourceToolNames.some(name => name === tool)) {
      const agent = ctx.agents.list().find(item => item === scope)
      const sourceScope = agent === undefined ? undefined : readScopeFor(agent.id)
      return sourceScope !== undefined && (sourceScope.kind !== 'task' || sourceScope.research === true)
    }
    if (!['brain_read', 'brain_read_proposals', 'brain_search', 'brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page', 'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_merge_pages', 'brain_normalize_page_format',
      'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex', 'brain_read_health_report', 'brain_mark_health_finding',
      'wud_write_decision', 'wud_rewrite_truth', 'wud_update_root_page'].includes(tool)) return true
    const agent = ctx.agents.list().find(item => item === scope)
    if (agent === undefined) return false
    if (tool === 'brain_read' || tool === 'brain_search') return readScopeFor(agent.id) !== undefined
    if (tool === 'brain_read_proposals') {
      const scope = readScopeFor(agent.id)
      return scope !== undefined && scope.kind !== 'task'
    }
    if (tool !== 'brain_read_health_report' && !knowledgeSessionWritable(ctx, agent.session)) return false
    const project = projectFor(agent.id)
    if (['brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page', 'brain_set_page_status', 'brain_write_root',
      'brain_archive_page', 'brain_merge_pages', 'brain_normalize_page_format', 'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex'].includes(tool) && project === undefined) {
      const scope = readScopeFor(agent.id)
      return scope !== undefined && scope.kind !== 'task' && !hasGoalApproval(agent.session)
    }
    if (project === undefined) return false
    if (tool === 'brain_read_health_report') return true
    if (project.readOnly) return false
    const tasks = ctx.get('taskController')
    if (tasks === undefined && hasGoalApproval(agent.session)) return false
    const goal = tasks?.currentGoal(project.id, agent.id)
    const approved = goal?.review?.input.decision === 'approve' && goal.phase !== 'EXITED'
    if (['wud_write_decision', 'wud_rewrite_truth', 'wud_update_root_page'].includes(tool)) {
      return approved && goal.phase === 'RUNNING' && goal.review.delivery === 'sent'
    }
    return !approved
  })
  registerSourceTools(ctx, config.sources, config.maxReadBytes, readScopeFor, run)
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    const source = 'conversation-project-focus'
    const previous = agent.session.deriveMessages().findLast(message => message.role === 'user'
      && (message.source.kind === source || message.source.kind === 'plugin:conversation-project-focus'))
    const scope = readScopeFor(agent.id)
    const selected = scope === undefined || scope.kind === 'task' ? undefined : ctx.workspaceRegistry.conversationProjectContext(agent.id)
    const projects = selected?.projectIds.flatMap((id) => {
      const project = ctx.workspaceRegistry.get(id)
      return project === undefined ? [] : [project]
    }) ?? []
    if (projects.length === 0 && previous === undefined) return decision
    const text = renderProjectFocus(projects, config.maxContextBytes)
    if (previous?.role === 'user' && previous.content.length === 1
      && previous.content[0]?.type === 'text' && previous.content[0].text === text) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: source, form: 'snapshot', sections: [{ name: source, text }] },
    })] }
  })
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    return run(signal, async (live) => {
      const previous = agent.session.deriveMessages().findLast(message => message.role === 'user'
        && (message.source.kind === name || message.source.kind === 'plugin:project-brain'))
      const scope = readScopeFor(agent.session.id)
      const project = scope?.projects.find(project => project.id === scope.defaultProjectId)
      if (project === undefined && previous === undefined) return decision
      if (project !== undefined && ctx.tools.get('brain_read', agent) === undefined) return decision
      const index = project === undefined ? undefined : await ctx.knowledgeController.index(project.id, live)
      if (scope !== undefined) revalidateBrainScope(scope, readScopeFor(agent.session.id), project === undefined ? [] : [project])
      live.throwIfAborted()
      if (index?.exists === false && previous === undefined) return decision
      const text = renderBrainContext(project ?? null, index, config.maxContextBytes)
      if (previous?.role === 'user' && previous.content.length === 1
        && previous.content[0]?.type === 'text' && previous.content[0].text === text) return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
      })] }
    })
  })
  ctx.tools.register(createBrainSearchTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined) throw new Error('brain_search requires a registered project or workspace conversation')
    const projects = selectBrainProjects(scope, args.target_project_id, true)
    const request = resolveBrainSearch(args, config.maxSearchResults, config.maxSearchMatches)
    const aggregate = scope.defaultProjectId === null && args.target_project_id === undefined
    const results: {
      project_id: WorkspaceId
      title: string
      project: string
      result: KnowledgeSearchResult | null
      error: string | null
      locationRevision?: string
    }[] = []
    for (const project of projects) {
      revalidateBrainScope(scope, readScopeFor(session.id), projects)
      try {
        const mapped = ctx.fs.processPathFromHostPath(project.path)
        if (mapped === undefined) throw new Error('Registered project directory is unavailable in this filesystem')
        const root = await ctx.fs.resolve(mapped, { signal: live })
        if ((await ctx.fs.stat(root, live))?.type !== 'directory') throw new Error('Registered project directory is unavailable')
        const location = ctx.knowledgeController.location(project.id)
        const result = await ctx.knowledgeController.search(project.id, request, live)
        if (ctx.knowledgeController.location(project.id).revision !== location.revision) throw new Error('Brain location changed during search; retry')
        results.push({ project_id: project.id, title: project.title, project: project.path, result, error: null,
          ...(!aggregate && location.revision !== null ? { locationRevision: location.revision } : {}) })
      } catch (error) {
        live.throwIfAborted()
        if (!aggregate) throw error
        results.push({ project_id: project.id, title: project.title, project: project.path,
          result: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    revalidateBrainScope(scope, readScopeFor(session.id), projects)
    live.throwIfAborted()
    const text = renderBrainSearch(results.map(item => item.result), request.query, (projected) => {
      if (aggregate) return JSON.stringify({ workspace: scope.spaceId, query: request.query,
        projects: results.map((item, index) => ({ ...item, result: projected[index] })),
        truncated: results.some(item => item.error !== null || item.result?.truncated || item.result?.issues.length) })
      const first = results[0]
      if (first === undefined || first.result === null) throw new Error('Choose an available Brain project')
      return JSON.stringify({ ...args.target_project_id === undefined ? {} : { project_id: first.project_id },
        project: first.project, query: request.query, ...projected[0],
        ...(first.locationRevision === undefined ? {} : { locationRevision: first.locationRevision }) })
    }, config.maxReadBytes)
    await Promise.all(results.flatMap(item => item.result?.hits.map(hit => ctx.knowledgeController.recordAccess({
      projectId: item.project_id, documentId: hit.path, kind: 'search',
    })) ?? []))
    return text
  })))
  ctx.tools.register(createBrainReindexTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_reindex requires a registered conversation')
    const render = (count: number) => JSON.stringify({ path: 'index.md', count })
    if (Buffer.byteLength(render(Number.MAX_SAFE_INTEGER)) > config.maxReadBytes) throw new Error('Brain acknowledgement exceeds maxReadBytes')
    const receipt = await ctx.knowledgeController.reindexSession(session.id, live, args.target_project_id)
    return render(receipt.count)
  })))
  ctx.tools.register(createBrainReadTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined) throw new Error('brain_read requires a registered project or workspace conversation')
    const projects = selectBrainProjects(scope, args.target_project_id, false)
    const project = projects[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const document = await ctx.knowledgeController.read(project.id, args.path as KnowledgeDocumentId, live)
    revalidateBrainScope(scope, readScopeFor(session.id), projects)
    live.throwIfAborted()
    if (document.entry.status !== 'active' && args.include_inactive !== true) {
      throw new Error('This page is not active; set include_inactive=true only for explicit historical inspection')
    }
    const identity = { project_id: project.id, project: project.path, path: document.entry.id, version: document.entry.version }
    const content = { project: project.path, path: document.entry.id, version: document.entry.version,
      title: document.entry.title, status: document.entry.status, tags: document.entry.tags,
      markdown: document.body, timeline: modelKnowledgeTimeline(document.timeline) }
    const complete = JSON.stringify({ ...args.target_project_id === undefined ? {} : { project_id: project.id }, ...content })
    const text = args.cursor === undefined && Buffer.byteLength(complete, 'utf8') <= config.maxReadBytes ? complete
      : renderBrainReadChunk(JSON.stringify({ project_id: project.id, ...content }), identity, args.cursor, config.maxReadBytes)
    await ctx.knowledgeController.recordAccess({ projectId: project.id, documentId: document.entry.id, kind: 'read' })
    return text
  })))
  ctx.tools.register(createBrainProposalReadTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined || scope.kind === 'task') {
      throw new Error('brain_read_proposals requires a registered project or workspace conversation; execution Tasks are excluded')
    }
    const projects = selectBrainProjects(scope, args.target_project_id, false)
    const project = projects[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const location = ctx.knowledgeController.location(project.id)
    const review = await ctx.knowledgeController.proposals(project.id, args.path as KnowledgeDocumentId, live)
    revalidateBrainScope(scope, readScopeFor(session.id), projects)
    const currentLocation = ctx.knowledgeController.location(project.id)
    if (currentLocation.revision !== location.revision || currentLocation.path !== location.path) {
      throw new Error('Brain location changed while reading proposals; retry from the current location')
    }
    live.throwIfAborted()
    const proposals = args.operation_id === undefined ? review.proposals
      : review.proposals.filter(proposal => proposal.operationId === args.operation_id)
    if (args.operation_id !== undefined && proposals.length === 0) {
      throw new Error('Proposal not found in this document; omit operation_id to inspect its retained proposals')
    }
    const text = renderBrainProposalsRead({ project_id: project.id, project: project.path,
      path: review.documentId, version: review.version, archived: review.archived, proposals },
    args.operation_id === undefined ? null : args.operation_id as KnowledgeUpdateId, args.cursor, config.maxReadBytes)
    await ctx.knowledgeController.recordAccess({ projectId: project.id, documentId: review.documentId, kind: 'read' })
    return text
  })))
  ctx.tools.register(createBrainUpdateTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_update_truth requires a registered conversation')
    const source = requireUserEvidenceSource(session, args.evidence_quote)
    const render = acknowledgement(args)
    const request = {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version, truth: args.truth,
      kind: args.kind, summary: args.summary, source, evidence: args.evidence_quote,
    }
    if (ctx.knowledgeController.automaticConversationEnabled(session.id)) {
      const outcome = await ctx.knowledgeController.updateAutomaticSessionTruth(session.id,
        args.path as KnowledgeDocumentId, request, live, args.target_project_id)
      return automaticAcknowledgement(args.path, outcome, render)
    }
    const receipt = await ctx.knowledgeController.updateSessionTruth(session.id,
      args.path as KnowledgeDocumentId, request, live, args.target_project_id)
    return { acknowledgement: render(receipt.disposition), receipt }
  })))
  ctx.tools.register(createBrainProposalTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined || scope.kind === 'task') {
      throw new Error('brain_propose_truth requires an ordinary registered conversation')
    }
    const project = selectBrainProjects(scope, args.target_project_id, false)[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const render = (disposition: KnowledgeTruthReceipt['disposition']) => JSON.stringify({
      status: disposition === 'written' ? 'pending-review' : 'proposal-retained',
      knowledge_changed: false, path: args.path, project_id: project.id,
      operation_id: args.operation_id, disposition,
    })
    if (Buffer.byteLength(render('already-applied'), 'utf8') > config.maxReadBytes) {
      throw new Error('Complete proposal acknowledgement exceeds maxReadBytes; increase the configured allowance')
    }
    const receipt = await ctx.knowledgeController.proposeSessionTruth(session.id, args.path as KnowledgeDocumentId, {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version,
      truth: args.truth, summary: args.summary, source: `session:${session.id}`, evidence: args.evidence,
    }, live, project.id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createBrainTimelineTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_append_timeline requires a registered conversation')
    const render = acknowledgement(args)
    const request = {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version,
      kind: args.kind, summary: args.summary, ...args.source === undefined ? {} : { source: args.source },
      ...args.affects === undefined ? {} : { affects: args.affects }, ...args.evidence === undefined ? {} : { evidence: args.evidence },
    }
    if (ctx.knowledgeController.automaticConversationEnabled(session.id)) {
      const reviewed = (disposition: KnowledgeTruthReceipt['disposition'], review: KnowledgeAutomaticTimelineResult['review']): string =>
        renderReviewedTimelineResult(args, { status: 'applied', disposition, review }, config.maxReadBytes)
      const outcome = await ctx.knowledgeController.appendAutomaticSessionTimeline(session.id,
        args.path as KnowledgeDocumentId, request, live, args.target_project_id,
        (review) => { reviewed('written', review); reviewed('already-applied', review) })
      if (outcome.status !== 'applied') return renderReviewedTimelineResult(args, outcome, config.maxReadBytes)
      return reviewed(outcome.receipt.disposition, outcome.review)
    }
    const receipt = await ctx.knowledgeController.appendSessionTimeline(session.id, args.path as KnowledgeDocumentId,
      request, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createGoalDecisionTool(observed('write', async (args, exec) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('wud_write_decision requires the source Goal conversation')
    const project = projectFor(session.id)
    if (project === undefined || project.readOnly) throw new Error('Execution Tasks cannot record Goal decisions')
    const target = args.target_project_id === undefined ? project : ctx.workspaceRegistry.get(args.target_project_id as WorkspaceId)
    if (target === undefined) throw new Error('Goal knowledge requires an exact registered target_project_id')
    requireInformedBrainRead(session, target.path, args.path, args.expected_version)
    const render = acknowledgement(args, args.target_project_id)
    return run(exec.signal, async (live) => {
      const receipt = await ctx.knowledgeController.appendGoalDecision(session.id, args.run_id as ProjectGoalRunId,
        args.path as KnowledgeDocumentId, { operationId: args.operation_id as KnowledgeUpdateId,
          expectedVersion: args.expected_version, summary: args.summary, evidence: args.evidence }, live,
        args.target_project_id as WorkspaceId | undefined)
      return render(receipt.disposition)
    })
  })))
  for (const kind of ['page', 'root'] as const) ctx.tools.register(createGoalRewriteTool(kind, observed('write', async (args, exec) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('Goal knowledge replacement requires its source conversation')
    const project = projectFor(session.id)
    if (project === undefined || project.readOnly) throw new Error('Execution Tasks cannot replace Goal knowledge')
    if (args.path.startsWith('pages/') !== (kind === 'page')) throw new Error('Use the Goal tool matching the signed document kind')
    const target = args.target_project_id === undefined ? project : ctx.workspaceRegistry.get(args.target_project_id as WorkspaceId)
    if (target === undefined) throw new Error('Goal knowledge requires an exact registered target_project_id')
    if (args.expected_version !== null) requireInformedBrainRead(session, target.path, args.path, args.expected_version)
    const render = acknowledgement(args, args.target_project_id)
    return run(exec.signal, async (live) => {
      const receipt = await ctx.knowledgeController.rewriteGoalKnowledge(session.id, args.run_id as ProjectGoalRunId,
        args.path as KnowledgeDocumentId, { operationId: args.operation_id as KnowledgeUpdateId,
          expectedVersion: args.expected_version, markdown: args.markdown, rationale: args.rationale, evidence: args.evidence }, live,
        args.target_project_id as WorkspaceId | undefined)
      return render(receipt.disposition)
    })
  })))
  ctx.tools.register(createBrainPageTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_create_page requires a registered conversation')
    const source = requireUserEvidenceSource(session, args.evidence_quote)
    const render = acknowledgement(args)
    if (!hasPageProtocolContext(session)) {
      if (Buffer.byteLength(PAGE_PROTOCOL_REMINDER, 'utf8') > config.maxReadBytes) throw new Error('Brain protocol reminder exceeds maxReadBytes; increase the configured allowance')
      return { acknowledgement: PAGE_PROTOCOL_REMINDER, nonWriting: true }
    }
    const request = {
      operationId: args.operation_id as KnowledgeUpdateId, title: args.title, status: args.status, category: args.category,
      tags: args.tags, truth: args.truth, kind: args.kind, summary: args.summary, source, evidence: args.evidence_quote,
    }
    if (args.status === 'active' && ctx.knowledgeController.automaticConversationEnabled(session.id)) {
      const outcome = await ctx.knowledgeController.createAutomaticSessionPage(session.id,
        args.path as KnowledgeDocumentId, request, live, args.target_project_id)
      return automaticAcknowledgement(args.path, outcome, render)
    }
    const receipt = await ctx.knowledgeController.createSessionPage(session.id, args.path as KnowledgeDocumentId,
      request, live, args.target_project_id)
    return { acknowledgement: render(receipt.disposition), receipt }
  })))
  ctx.tools.register(createBrainStatusTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_set_page_status requires a registered conversation')
    const source = requireUserEvidenceSource(session, args.evidence_quote)
    const render = acknowledgement(args)
    const receipt = await ctx.knowledgeController.setSessionPageStatus(session.id, args.path as KnowledgeDocumentId, {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version,
      status: args.status, reason: args.reason, source, evidence: args.evidence_quote,
    }, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createBrainArchiveTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_archive_page requires a registered conversation')
    const source = requireUserEvidenceSource(session, args.evidence_quote)
    const render = acknowledgement(args)
    const receipt = await ctx.knowledgeController.archiveSessionPage(session.id, args.path as KnowledgeDocumentId, {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version,
      supersededBy: args.superseded_by as KnowledgeDocumentId | null, source, evidence: args.evidence_quote,
    }, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createBrainMergeTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined || scope.kind === 'task') throw new Error('AI consolidation requires an ordinary registered conversation')
    const project = selectBrainProjects(scope, args.target_project_id, false)[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const result = (stage: BrainMergeResult['stage'], canContinue: boolean, blocked: boolean,
      publicationError: boolean, ended: boolean): BrainMergeResult => ({ project_id: project.id,
      operation_id: args.operation_id, target_path: args.target_path, source_path: args.source_path,
      stage, can_continue: canContinue, blocked, publication_error: publicationError, ended })
    if (Buffer.byteLength(JSON.stringify(result('source-archived', false, false, false, false)), 'utf8') > config.maxReadBytes) {
      throw new Error('Complete merge acknowledgement exceeds maxReadBytes; increase the configured allowance')
    }
    const review = await ctx.knowledgeController.mergeSessionPages(session.id, {
      operationId: args.operation_id as KnowledgeUpdateId,
      target: { documentId: args.target_path as KnowledgeDocumentId, expectedVersion: args.target_version },
      source: { documentId: args.source_path as KnowledgeDocumentId, expectedVersion: args.source_version },
      truth: args.truth, summary: args.summary, evidence: args.evidence_quote, note: args.reason,
    }, live, project.id)
    return result(review.stage, review.canContinue, review.blockedReason !== null, review.lastError !== null, review.abandonment !== null)
  })))
  ctx.tools.register(createBrainTagsTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_set_page_tags requires a registered conversation')
    const tags = normalizeKnowledgeTags(args.tags)
    const render = (disposition: 'written' | 'already-applied') => JSON.stringify({ path: args.path, tags, disposition })
    if (Buffer.byteLength(render('already-applied')) > config.maxReadBytes) {
      throw new Error('Complete tag acknowledgement exceeds maxReadBytes; increase the configured allowance')
    }
    const receipt = await ctx.knowledgeController.setSessionPageTags(session.id, args.path as KnowledgeDocumentId,
      { expectedVersion: args.expected_version, tags: args.tags }, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createBrainTitleTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_update_page_title requires a registered conversation')
    const title = args.title.trim()
    const render = (disposition: 'written' | 'already-applied') => JSON.stringify({ path: args.path, title, disposition })
    if (Buffer.byteLength(render('already-applied')) > config.maxReadBytes) {
      throw new Error('Complete title acknowledgement exceeds maxReadBytes; increase the configured allowance')
    }
    const receipt = await ctx.knowledgeController.updateSessionPageTitle(session.id, args.path as KnowledgeDocumentId,
      { expectedVersion: args.expected_version, title: args.title }, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.tools.register(createBrainFormatTool(async (args, exec) => {
    const session = exec.agent?.session
    const scope = session === undefined ? undefined : readScopeFor(session.id)
    if (session === undefined || scope === undefined || scope.kind === 'task') throw new Error('Format repair requires an ordinary registered conversation')
    const projects = selectBrainProjects(scope, args.target_project_id, false)
    const project = projects[0]
    if (project === undefined) throw new Error('Choose an available Brain project')
    const authorize = (): void => {
      revalidateBrainScope(scope, readScopeFor(session.id), projects)
      if (ctx.tools.get('brain_normalize_page_format', exec.agent) === undefined) throw new Error('Brain format repair authority changed')
      if (ctx.knowledgeController.location(project.id).revision !== location.revision) throw new Error('Brain location changed during format repair; retry')
    }
    const location = ctx.knowledgeController.location(project.id)
    return run(exec.signal, async (live) => {
      let paths = args.paths
      if (paths === undefined || paths.length === 0) {
        const index = await ctx.knowledgeController.index(project.id, live)
        authorize()
        if (index.truncated || index.issues.some(issue => !issue.path.startsWith('pages/') || !issue.path.endsWith('.md'))) {
          throw new Error('Brain page listing is incomplete; select explicit paths or resolve scan limits and directory errors')
        }
        paths = [...index.entries.filter(entry => entry.kind === 'page').map(entry => entry.id), ...index.issues.map(issue => issue.path)]
      }
      const targets = paths
      const result: { changed: string[]; skipped: string[]; errors: string[] } = { changed: [], skipped: [], errors: [] }
      if (Buffer.byteLength(JSON.stringify({ ...result, errors: targets })) > config.maxReadBytes) {
        throw new Error('Complete format repair result exceeds maxReadBytes; select fewer paths or increase the allowance')
      }
      for (const path of targets) {
        live.throwIfAborted()
        authorize()
        try {
          const changed = await ctx.knowledgeController.normalizeSessionPageFormat(
            session.id, path as KnowledgeDocumentId, live, project.id)
          result[changed ? 'changed' : 'skipped'].push(path)
        } catch {
          // A page failure is isolated to its path; cancellation and revoked membership stop the batch.
          live.throwIfAborted()
          authorize()
          result.errors.push(path)
        }
      }
      return JSON.stringify(result)
    })
  }))
  ctx.tools.register(createBrainHealthReadTool(async (args, exec) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('Health reports require a registered project conversation')
    const project = projectFor(session.id)
    if (project === undefined) throw new Error('This conversation does not belong to a registered project')
    return run(exec.signal, async (live) => {
      const location = ctx.knowledgeController.location(project.id)
      const report = await ctx.knowledgeController.readHealthReport(project.id, args.report_id as KnowledgeHealthReportId, live)
      revalidate(session.id, project)
      const currentLocation = ctx.knowledgeController.location(project.id)
      if (currentLocation.revision !== location.revision || currentLocation.path !== location.path) {
        throw new Error('Brain location changed during health report reading; retry from the current location')
      }
      live.throwIfAborted()
      const text = JSON.stringify({ project: project.path, ...report })
      if (args.cursor === undefined && Buffer.byteLength(text, 'utf8') <= config.maxReadBytes) return text
      return renderHealthReportRead(text, { project_id: project.id, project: project.path,
        report_id: report.id, locationRevision: location.revision, version: report.version }, args.cursor, config.maxReadBytes)
    })
  }))
  ctx.tools.register(createBrainHealthMarkTool(async (args, exec) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('Marking a health finding requires an ordinary project conversation')
    const acknowledgement = JSON.stringify({ report_id: args.report_id, finding_number: args.finding_number, status: args.status })
    if (Buffer.byteLength(acknowledgement) > config.maxReadBytes) throw new Error('Health acknowledgement exceeds maxReadBytes; increase the configured allowance')
    return run(exec.signal, async (live) => {
      await ctx.knowledgeController.markSessionHealthFinding(session.id, args.report_id as KnowledgeHealthReportId, {
        expectedVersion: args.expected_version, findingNumber: args.finding_number, status: args.status,
        ...(args.note === undefined ? {} : { note: args.note }),
      }, live)
      return acknowledgement
    })
  }))
  ctx.tools.register(createBrainRootTool((args, exec) => run(exec.signal, async (live) => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('brain_write_root requires a registered conversation')
    const source = requireUserEvidenceSource(session, args.evidence_quote)
    const render = acknowledgement(args)
    const receipt = await ctx.knowledgeController.writeSessionRoot(session.id, args.path as KnowledgeDocumentId, {
      operationId: args.operation_id as KnowledgeUpdateId, expectedVersion: args.expected_version,
      body: args.body, reason: args.reason, source, evidence: args.evidence_quote,
    }, live, args.target_project_id)
    return render(receipt.disposition)
  })))
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'project-brain: model operations')
}
