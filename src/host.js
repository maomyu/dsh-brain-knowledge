import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SERVICE } from './typert.js'
import { BrainStore, roots } from './store.js'
import { ConversationWorkflow } from './workflow.js'
import { requestImport } from './imports.js'

let markRequest
let markFollow
const sessionSource = /^session:([^\s/:\\]+)(?:\/message:([^\s/:\\]+))?$/u

function attribution(source, evidence) {
  if (!source && !evidence) return null
  return { name: source ?? '来源依据', ref: source, quote: evidence ?? undefined, navigable: sessionSource.test(source ?? '') }
}

function summary(project, entry) {
  return {
    projectId: project.id, projectTitle: project.title, path: entry.id, title: entry.title,
    status: entry.status, revision: entry.version, excerpt: entry.summary, updatedAt: entry.updatedAt,
    references: entry.references, slug: entry.slug, native: true,
  }
}

class BrainKnowledge extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'knowledgeController', 'taskController', 'knowledgeImportController']

  constructor(ctx, config) {
    super(ctx, SERVICE)
    markRequest.call(this)
    markFollow.call(this)
    if (!config?.directory || !isAbsolute(config.directory)) throw new Error('大脑需要绝对存储目录')
    this.legacy = new BrainStore(config.directory, () => ctx.workspaceRegistry.list())
    this.brain = ctx.knowledgeController
    this.workflow = new ConversationWorkflow(ctx)
    this.spaces = config.spaces ?? []
  }

  async [Service.init]() {
    const registry = this.ctx.workspaceRegistry
    for (const { id, title, projects = [], conversations = [] } of this.spaces) {
      await registry.createSpace(id, title)
      for (const project of projects) await registry.create(project.path, project.title, undefined, id)
      for (const sessionId of conversations) await registry.attachSpaceSession(id, sessionId)
    }
  }

  async *followWorkflow(input, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return
    yield* this.workflow.follow(input, signal)
  }

  async request(input, signal = AbortSignal.timeout(180_000)) {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') return { error: '仅当前应用所有者可以访问大脑。' }
    try {
      if (input.op.startsWith('import-')) return await requestImport(this.ctx, input, signal)
      if (input.op === 'workflow' || input.op.startsWith('workflow-')) return await this.workflow.request(input, signal)
      if (input.op === 'projects') {
        const { projects } = await this.legacy.request(input)
        const spaces = this.ctx.workspaceRegistry.spaces
        return { projects: projects.map(project => {
          const space = spaces.find(item => item.projectIds.includes(project.id))
          return { ...project, spaceId: space?.spaceId, spaceTitle: space?.title || '个人工作区' }
        }) }
      }
      if (input.op === 'search' && !input.projectId) {
        const projects = this.ctx.workspaceRegistry.list()
        const results = await Promise.allSettled(projects.map(project => this.search(project, input, signal)))
        const pages = []
        const warnings = []
        for (const [index, result] of results.entries()) {
          if (result.status === 'fulfilled') {
            pages.push(...result.value.pages)
            warnings.push(...result.value.warnings)
          } else warnings.push(projects[index].title + ' 的知识库暂时无法读取。')
        }
        return { pages: pages.slice(0, 100), warnings }
      }
      const project = this.ctx.workspaceRegistry.get(input.projectId)
      if (!project) throw new Error('请选择有效的 Harness 工作区。')
      if (input.op === 'index') return await this.index(project, signal)
      if (input.op === 'search') return await this.search(project, input, signal)
      if (input.op === 'read') return { page: await this.read(project, input.path, signal) }
      if (input.op === 'source') return await this.brain.resolveSource(project.id, input.path, input.source, signal)
      if (input.op === 'status') return await this.status(project, input, signal)
      if (input.op === 'proposal') {
        const { operationId, revision, proposalId, action, note, truth } = input
        if (!['keep', 'replace', 'merge'].includes(action)) throw new Error('无效的提案处理方式。')
        await this.brain.resolveProposal(project.id, input.path, {
          operationId, expectedVersion: revision, proposalId, action, note, truth: action === 'merge' ? truth : null,
        }, signal)
        return { page: await this.read(project, input.path, signal) }
      }
      if (input.op === 'restore-version') {
        await this.brain.restoreTruth(project.id, input.path, {
          operationId: input.operationId, expectedVersion: input.revision, targetOperationId: input.targetOperationId,
        }, signal)
        return { page: await this.read(project, input.path, signal) }
      }
      throw new Error('知识正文由项目对话中的 Agent 沉淀。')
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error),
        reason: typeof error?.details?.reason === 'string' ? error.details.reason : undefined }
    }
  }

  async index(project, signal) {
    const [index, legacy] = await Promise.all([
      this.brain.index(project.id, signal),
      this.legacy.request({ op: 'index', projectId: project.id }),
    ])
    const pages = index.entries.map(entry => summary(project, entry))
    const nativePaths = new Set(pages.map(page => page.path))
    const old = (legacy.pages ?? []).filter(page => !nativePaths.has(page.path) && page.source?.kind !== 'legacy')
    const targets = new Map(pages.map(page => [page.slug, page.path]))
    const edges = pages.filter(page => page.status === 'active').flatMap(page => page.references.map(ref =>
      ({ from: page.path, to: targets.get(ref) ?? ref })))
    return {
      pages: [...pages, ...old],
      edges: [...edges, ...(legacy.edges ?? []).filter(edge => old.some(page => page.path === edge.from))],
      warnings: [
        ...index.issues.map(issue => issue.path + ' · ' + issue.message),
        ...(index.truncated ? ['大脑索引超过读取上限。'] : []),
        ...(legacy.error ? [legacy.error] : []),
      ],
    }
  }

  async search(project, input, signal) {
    if (typeof input.query !== 'string' || input.query.length > 200) throw new Error('搜索词最多 200 个字符。')
    const query = input.query.trim()
    if (!query) return { pages: [], warnings: [] }
    const statuses = ['active']
    if (input.drafts) statuses.push('draft')
    if (input.archived) statuses.push('archived')
    const [native, legacy] = await Promise.all([
      this.brain.search(project.id, { query, statuses, maxResults: 100, maxMatches: 1 }, signal),
      this.legacy.request({ ...input, projectId: project.id }),
    ])
    const pages = native.hits.map(hit => ({
      projectId: project.id, projectTitle: project.title, path: hit.path, title: hit.title,
      status: hit.status, revision: hit.version, excerpt: hit.lines[0]?.snippet ?? '', native: true,
    }))
    const paths = new Set(pages.map(page => page.path))
    const old = (legacy.pages ?? []).filter(page => !paths.has(page.path) && page.source?.kind !== 'legacy')
    return {
      pages: [...pages, ...old].slice(0, 100),
      warnings: [
        ...native.issues.map(issue => issue.path + ' · ' + issue.message),
        ...(native.truncated ? ['部分搜索结果超过读取上限。'] : []),
      ],
    }
  }

  async read(project, path, signal) {
    const index = await this.brain.index(project.id, signal)
    if (!index.entries.some(entry => entry.id === path)) {
      if (index.truncated || index.issues.some(issue => issue.path === path)) throw new Error('该知识页暂时无法完整读取。')
      const result = await this.legacy.request({ op: 'read', projectId: project.id, path })
      if (result.error) throw new Error(result.error)
      return result.page
    }
    const [doc, history, proposals] = await Promise.all([
      this.brain.read(project.id, path, signal),
      this.brain.truthHistory(project.id, path, signal),
      this.brain.proposals(project.id, path, signal),
    ])
    if (doc.entry.version !== history.version || doc.entry.version !== proposals.version)
      throw new Error('知识在读取时发生变化，请重新打开。')
    const timeline = doc.timeline.map(item => ({ ...item, attribution: attribution(item.source, item.evidence) }))
    return {
      ...summary(project, doc.entry), body: doc.markdown, timeline,
      source: timeline.find(item => item.attribution?.navigable)?.attribution ?? null,
      proposals: proposals.proposals,
      versions: history.changes.map(change => ({
        id: change.operationId, body: change.before, updatedAt: change.at, status: doc.entry.status,
        source: attribution(change.source, change.evidence), canRestore: change.canRestore,
      })),
    }
  }

  async status(project, input, signal) {
    const { status, path, revision, operationId } = input
    if (!['active', 'archived'].includes(status) || roots[path]) throw new Error('无效的知识状态。')
    const current = await this.read(project, path, signal)
    if (!current.native) return await this.legacy.request(input)
    const request = { operationId, expectedVersion: revision, source: 'human:brain-workspace', evidence: '用户在大脑页面确认' }
    if (status === 'archived') await this.brain.archivePage(project.id, path, { ...request, supersededBy: null }, signal)
    else await this.brain.setPageStatus(project.id, path, { ...request, status, reason: '用户恢复归档知识' }, signal)
    return { page: await this.read(project, path, signal) }
  }
}
Remote(BrainKnowledge.prototype.request, {
  name: 'request', private: false, static: false,
  addInitializer(initializer) { markRequest = initializer },
})
Remote({ mode: 'stream' })(BrainKnowledge.prototype.followWorkflow, {
  name: 'followWorkflow', private: false, static: false,
  addInitializer(initializer) { markFollow = initializer },
})
export default BrainKnowledge
