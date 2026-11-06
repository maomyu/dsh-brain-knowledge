import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'

export const roots = {
  'background.md': '背景',
  'architecture.md': '架构',
  'flow.md': '关键流程',
  'mindmap.md': '功能脑图',
  'stack.md': '技术栈',
  'roadmap.md': '路线图',
}
const states = new Set(['active', 'draft', 'archived'])
const maxBody = 128 * 1024
const maxProject = 12 * 1024 * 1024
const maxDocuments = 350
const pathKey = /^(?:pages\/[^/\\\u0000-\u001f]{1,200}\.md|[a-z]+\.md)$/u
const safeId = /^[a-f0-9-]{36}$/i
const digest = (s) => createHash('sha256').update(s).digest('hex')
const fail = (message) => { throw new Error(message) }

async function readBounded(path, limit) {
  const stat = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('文件超出读取范围或不可读取。')
  const bytes = await readFile(path)
  if (bytes.length > limit) fail('文件超出读取范围。')
  return bytes.toString('utf8')
}

async function isDirectory(path) {
  try {
    const stat = await lstat(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function markdownPage(path, markdown) {
  const normalized = markdown.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n')
  const metadata = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)
  const body = normalized.slice(metadata?.[0].length ?? 0)
  const state = metadata?.[1].match(/^(?:status|lifecycle):\s*["']?(draft|archived|active)\b/mu)?.[1]
  return {
    path, title: roots[path] ?? body.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? posix.basename(path, '.md'),
    body, status: state ?? 'active', revision: digest(normalized), source: { kind: 'legacy', name: 'brain/' + path },
    versions: [], updatedAt: null,
  }
}

function summary(page) {
  const { body, versions, lastOperation, ...meta } = page
  return { ...meta, excerpt: body.split('\n').find(line => line.trim() && !line.startsWith('#'))?.slice(0, 180) ?? '' }
}

function locateLink(path, link) {
  const target = link.trim().split('#')[0]
  if (!target || target.includes(':') || target.startsWith('/')) return null
  const cleaned = posix.normalize(posix.join(posix.dirname(path), target))
  return pathKey.test(cleaned) ? cleaned : null
}

function linksOf(page, pages) {
  const found = new Set()
  for (const match of page.body.matchAll(/\[\[([^\]\n]+)\]\]|\[[^\]\n]*\]\(([^()\n]+)\)/gu)) {
    const wiki = match[1]?.split('|')[0].trim()
    const mapped = wiki
      ? pages.filter(item => item.path === wiki || item.path === wiki + '.md' || item.title === wiki || posix.basename(item.path, '.md') === wiki)
      : []
    const target = wiki ? (mapped.length === 1 ? mapped[0].path : null) : locateLink(page.path, match[2])
    if (target && target !== page.path) found.add(target)
    if (!target && wiki) found.add(wiki)
    if (found.size >= 30) break
  }
  return [...found]
}

export class BrainStore {
  #tail = Promise.resolve()

  constructor(directory, workspaces) {
    this.directory = directory
    this.workspaces = workspaces
  }

  request(input) {
    const next = this.#tail.then(() => this.#dispatch(input)).catch(error => ({ error: error.message }))
    this.#tail = next
    return next
  }

  async #dispatch(input) {
    const workspaces = this.workspaces()
    if (input.op === 'projects') {
      return { projects: workspaces.map(({ id, title, sessionIds }) => ({ id, title, sessionIds })) }
    }
    if (input.op === 'search' && !input.projectId) {
      const results = []
      const warnings = []
      for (const project of workspaces) {
        try {
          const snapshot = await this.#snapshot(project)
          results.push(...this.#search(snapshot, input).slice(0, 60))
          warnings.push(...snapshot.warnings)
        } catch {
          warnings.push(project.title + ' 的知识库暂时无法读取。')
        }
        if (results.length >= 100) break
      }
      return { pages: results.slice(0, 100), warnings }
    }
    const workspace = workspaces.find(project => project.id === input.projectId)
    if (!workspace || !safeId.test(workspace.id)) fail('请选择有效的 Harness 工作区。')
    const snapshot = await this.#snapshot(workspace)
    if (input.op === 'index') {
      return {
        pages: snapshot.pages.map(summary),
        warnings: snapshot.warnings,
        edges: snapshot.pages.filter(page => page.status === 'active').flatMap(page => linksOf(page, snapshot.pages).map(target => ({ from: page.path, to: target }))),
      }
    }
    if (input.op === 'search') return { pages: this.#search(snapshot, input).slice(0, 100), warnings: snapshot.warnings }
    if (input.op === 'read') return { page: this.#get(snapshot, input.path) }
    if (input.op === 'save') return await this.#save(workspace, snapshot, input)
    if (input.op === 'status') {
      const page = this.#get(snapshot, input.path)
      if (roots[page.path]) fail('项目根文档一直保留在目录中。')
      if (input.status === 'active' && page.lastOperation?.id !== input.operationId
        && (page.status !== 'archived' || page.versions[0]?.status === 'draft'))
        fail('草稿需要在项目对话中由 Agent 复核。')
      return await this.#save(workspace, snapshot, { ...input, title: page.title, body: page.body, source: page.source }, true)
    }
    fail('不支持的知识库操作。')
  }

  #search(snapshot, input) {
    if (typeof input.query !== 'string' || input.query.length > 200) fail('搜索词最多 200 个字符。')
    const terms = input.query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    if (!terms.length) return []
    return snapshot.pages
      .filter(page => page.status === 'active' || (page.status === 'draft' && input.drafts === true) || (page.status === 'archived' && input.archived === true))
      .filter(page => {
        const text = [page.title, page.body, page.projectTitle, page.source?.name].join('\n').toLocaleLowerCase()
        return terms.every(term => text.includes(term))
      }).map(summary)
  }

  #get(snapshot, path) {
    if (typeof path !== 'string' || !pathKey.test(path)) fail('无效的知识页。')
    const page = snapshot.pages.find(page => page.path === path)
    if (!page) fail('知识页已不存在。请刷新后重试。')
    return page
  }

  async #snapshot(workspace) {
    const storedText = await readBounded(join(this.directory, workspace.id + '.json'), maxProject)
    const stored = storedText === null ? { version: 1, pages: {} } : JSON.parse(storedText)
    if (stored.version !== 1 || !stored.pages || Array.isArray(stored.pages) || typeof stored.pages !== 'object') fail('知识库存储格式不受支持。')
    const records = new Map()
    const warnings = []
    const brain = join(workspace.path, 'brain')
    const legacyPages = join(brain, 'pages')
    if (await isDirectory(brain)) {
      const entries = await isDirectory(legacyPages) ? await readdir(legacyPages, { withFileTypes: true }) : []
      const files = entries.filter(entry => entry.isFile() && pathKey.test('pages/' + entry.name)).map(entry => 'pages/' + entry.name)
      if (files.length > maxDocuments) warnings.push(workspace.title + ' 的旧知识页超过单次读取上限。')
      for (const path of [...Object.keys(roots), ...files.sort().slice(0, maxDocuments)]) {
        try {
          const text = await readBounded(join(brain, path), maxBody)
          if (text !== null) records.set(path, markdownPage(path, text))
        } catch {
          warnings.push(workspace.title + ' / ' + path + ' 无法读取。')
        }
      }
    }
    for (const [path, title] of Object.entries(roots)) {
      if (!records.has(path)) records.set(path, { path, title, body: '', status: 'active', revision: null, source: null, versions: [], updatedAt: null })
    }
    for (const [path, page] of Object.entries(stored.pages)) records.set(path, page)
    const pages = [...records.values()].map(page => ({ ...page, projectId: workspace.id, projectTitle: workspace.title }))
    return { pages, warnings, stored }
  }

  async #save(workspace, snapshot, input, lifecycle = false) {
    const { path, title, body, revision, status, operationId } = input
    if (typeof path !== 'string' || !pathKey.test(path) || (!path.startsWith('pages/') && !roots[path])) fail('无效的知识页。')
    if (!safeId.test(operationId) || typeof operationId !== 'string') fail('无效的保存编号。')
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\r\n]/u.test(title)) fail('请填写 1 至 160 个字符的单行标题。')
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > maxBody) fail('请填写正文，单页最多 128 KB。')
    if (!states.has(status)) fail('无效的知识状态。')
    const previous = snapshot.pages.find(page => page.path === path)
    const signature = digest(JSON.stringify([path, title, body, revision, status, input.source ?? null, lifecycle]))
    const current = snapshot.stored.pages[path]
    if (current?.lastOperation?.id === operationId && current.lastOperation.signature === signature) return { page: previous }
    if (current?.lastOperation?.id === operationId) fail('保存编号与请求不一致。')
    if ((previous?.revision ?? null) !== revision) return { conflict: true, page: previous ?? null }
    if (previous?.status === 'archived' && !lifecycle) fail('请先恢复归档页，再编辑正文。')
    if (roots[path] && status !== 'active') fail('项目根文档一直保留在目录中。')
    if (!current && Object.keys(snapshot.stored.pages).length >= maxDocuments) fail('当前项目已达到知识页上限。')
    const source = this.#source(workspace, input.source ?? previous?.source ?? null)
    const versions = previous?.revision ? [
      {
        id: previous.revision, title: previous.title, body: previous.body, status: previous.status,
        updatedAt: previous.updatedAt, source: previous.source,
      }, ...previous.versions,
    ].slice(0, 12) : []
    const page = {
      path, title: roots[path] ?? title.trim(), body, status, source, versions,
      revision: randomUUID(), updatedAt: new Date().toISOString(), lastOperation: { id: operationId, signature },
    }
    const next = JSON.stringify({ ...snapshot.stored, pages: { ...snapshot.stored.pages, [path]: page } })
    if (Buffer.byteLength(next) > maxProject) fail('当前项目已达到知识存储上限。')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const destination = join(this.directory, workspace.id + '.json')
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(next); await handle.sync() } finally { await handle.close() }
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
    return { page: { ...page, projectId: workspace.id, projectTitle: workspace.title } }
  }

  #source(workspace, source) {
    if (source === null) return null
    if (!source || !['file', 'chat', 'legacy', 'agent'].includes(source.kind) || typeof source.name !== 'string' || !source.name || source.name.length > 250) fail('无效的知识来源。')
    if (source.sessionId && !workspace.sessionIds.includes(source.sessionId)) fail('只能在会话所属的工作区保存此来源。')
    const base = { kind: source.kind, name: source.name, ...(source.sessionId ? { sessionId: source.sessionId } : {}) }
    if (source.kind !== 'agent') return base
    if (!source.sessionId || typeof source.messageId !== 'string' || source.messageId.length > 160 ||
      typeof source.quote !== 'string' || !source.quote.trim() || source.quote.length > 1000 ||
      !Number.isSafeInteger(source.turn) || source.turn < 0) fail('Agent 沉淀需要当前会话中的真实依据。')
    return { ...base, messageId: source.messageId, quote: source.quote, turn: source.turn }
  }
}
