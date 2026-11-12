import { ImportAction, ImportReviewAction } from './import-client.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import { PACKAGE, SERVICE, descriptors } from './typert.js'
import css from './styles.css'
import { ConversationWorkflowView } from './workflow-client.jsx'

const PANEL = 'brain-knowledge'
const roots = ['background.md', 'architecture.md', 'flow.md', 'mindmap.md', 'stack.md', 'roadmap.md']
const statuses = { active: '已发布', draft: '草稿', archived: '已归档' }
const displays = { activity: '工作区动态', search: '搜索知识', graph: '图谱视图', health: '健康检查' }
const groupProjects = projects => Map.groupBy(projects ?? [], item => item.spaceId ?? '')
const keyOf = page => page.projectId + '/' + page.path
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''
const message = error => error instanceof Error ? error.message : String(error)

export const inject = ['slots', 'layout', 'remote', 'sessions', 'uiWorkspace']

export async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount({ package: PACKAGE, descriptors })
  const ui = ctx.inject(['remote.' + SERVICE], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}

function registerUi(ctx) {
  const style = document.createElement('style')
  style.textContent = css + workflowStyles
  document.head.append(style)
  ctx.effect(() => () => style.remove())

  let route = { view: 'activity', projectId: '', path: '' }
  const call = async (input, signal) => {
    const result = await ctx.remote[SERVICE].request(input, signal)
    if (!result.ok) throw new Error(result.error?.message ?? '知识服务暂时不可用。')
    if (result.value.error) {
      throw Object.assign(new Error(result.value.error), { code: result.value.reason })
    }
    return result.value
  }
  const api = {
    call,
    route: () => route,
    remember: value => { route = value },
    openPage: (projectId, path, proposalId) => {
      route = { view: 'doc', projectId, path, proposalId }
      ctx.layout.selectPanel(PANEL)
    },
    follow: async (sessionId, signal) => {
      const remote = ctx.remote.$stream({
        name: 'Brain task and goal source',
        open: connection => ctx.remote[SERVICE].followWorkflow({ sessionId }, AbortSignal.any([signal, connection])),
        ended: () => new Error('对话已离开当前工作区。'),
      })
      const stop = () => { void remote.dispose() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        for await (const item of remote) item.accept()
      } finally {
        signal.removeEventListener('abort', stop)
        await remote.dispose()
      }
    },
    sessionOpen: id => ctx.uiWorkspace.openSession(id),
    canInspectSources: typeof ctx.uiWorkspace.openInspection === 'function',
    sourceOpen: async source => {
      if (typeof ctx.uiWorkspace.openInspection === 'function') {
        return ctx.uiWorkspace.openInspection({ sessionId: source.sessionId, workspaceId: source.workspaceId,
          spaceId: source.spaceId, message: source.message })
      }
      if (source.archived) return false
      ctx.uiWorkspace.openSession(source.sessionId)
      const id = source.sessionId
      await ctx.sessions.using(id, { source: 'brainSource' }, async reference => {
        const { session } = await reference.ready
        await session.loadThrough(source.message.seq)
      })
      const kind = 'input-message'
      const selector = '[data-brain-source="' + CSS.escape(id + '/' + source.message.id) + '"],'
        + '[data-chat-node-key="' + CSS.escape(kind.length + ':' + kind + source.message.id) + '"]'
      const deadline = performance.now() + 2000
      do {
        const target = document.querySelector(selector)
        if (target) {
          target.scrollIntoView({ block: 'center' })
          target.animate([{ backgroundColor: 'var(--dsw-alias-state-business-secondary, #e0eaff)' }, { backgroundColor: 'transparent' }], 1400)
          return true
        }
        await new Promise(resolve => requestAnimationFrame(resolve))
      } while (performance.now() < deadline)
      return false
    },
    sessionSelection: {
      subscribe: listener => ctx.sessions.list.subscribe(listener),
      getSnapshot: () => ctx.sessions.list.getSnapshot(),
    },
    events: id => ctx.sessions.binding(id)?.eventSource,
  }
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, label: '大脑', order: 30,
  }, Icon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL,
  }, () => <Panel api={api}/>))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'brain-import-review', order: 45,
  }, props => <ImportReviewAction key={props.sessionId} api={api} {...props}/>))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: PANEL, order: 30,
  }, ({ sessionId }) => <React.Fragment key={sessionId}>
    <ReviewPresentation api={api} sessionId={sessionId}/>
    <ConversationWorkflowView api={api} sessionId={sessionId}/>
  </React.Fragment>))
}

function Icon({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 16.5c-1.3 1.3-4 1-4.6-1.1-2.3-.3-3.3-2.9-2-4.7-1.1-2 .2-4.4 2.3-4.7.2-2.6 3.2-3.6 4.3-1.4 1.1-2.2 4.1-1.2 4.3 1.4 2.1.3 3.4 2.7 2.3 4.7 1.3 1.8.3 4.4-2 4.7-.6 2.1-3.3 2.4-4.6 1.1ZM10 4.6v11.9M5.7 6c.3 1.4 1 2.1 2.1 2.3m6.5-2.3c-.3 1.4-1 2.1-2.1 2.3M5.4 15.4c.4-1.1 1-1.7 2.2-1.9m7 1.9c-.4-1.1-1-1.7-2.2-1.9"/>
  </svg>
}

function useLoad(loader, dependencies, keepPrevious = false) {
  const [state, setState] = useState({ loading: true, value: null, error: '' })
  useEffect(() => {
    let current = true
    setState(previous => ({ loading: true, value: keepPrevious ? previous.value : null, error: '' }))
    Promise.resolve().then(loader).then(
      value => { if (current) setState({ loading: false, value, error: '' }) },
      error => { if (current) setState({ loading: false, value: null, error: message(error) }) },
    )
    return () => { current = false }
  }, dependencies)
  return state
}

function Failure({ text }) {
  return text ? <p className="bk-error" role="alert">{text}</p> : null
}

function Notices({ notices }) {
  return notices?.length ? <details className="bk-notice"><summary>部分知识暂时无法读取</summary>
    <ul>{notices.map(note => <li key={note}>{note}</li>)}</ul>
  </details> : null
}

function Panel({ api }) {
  const [navigationSeat, setNavigationSeat] = useState(null)
  useEffect(() => {
    const sync = () => setNavigationSeat(document.querySelector('[data-dsh-workbench-sidebar]'))
    sync()
    window.addEventListener('dsh-workbench-sidebar-change', sync)
    return () => window.removeEventListener('dsh-workbench-sidebar-change', sync)
  }, [])
  const [route, setRoute] = useState(api.route)
  const [tick, refresh] = useState(0)
  const [query, setQuery] = useState('')
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const { view, projectId, path } = route
  const projects = useLoad(() => api.call({ op: 'projects' }).then(value => value.projects), [api, tick], true)
  const groups = groupProjects(projects.value)
  const project = projects.value?.find(item => item.id === projectId)
  const data = useLoad(async () => {
    if (!projects.value) return []
    const targets = project ? [project] : projects.value
    const settled = await Promise.allSettled(targets.map(async item => ({
      ...await api.call({ op: 'index', projectId: item.id }), project: item,
    })))
    return settled.map((result, index) => result.status === 'fulfilled' ? result.value : {
      project: targets[index], pages: [], edges: [], warnings: [targets[index].title + '：' + message(result.reason)],
    })
  }, [api, projects.value, projectId, tick])
  const selectedIndex = data.value?.find(item => item.project.id === projectId)
  const doc = useLoad(() => view === 'doc' ? api.call({ op: 'read', projectId, path }).then(value => value.page) : null, [api, view, projectId, path, tick])
  const search = useLoad(async () => {
    if (view !== 'search' || !query.trim()) return null
    await new Promise(resolve => setTimeout(resolve, 160))
    return await api.call({ op: 'search', projectId, query, drafts: includeDrafts, archived: includeArchived })
  }, [api, view, query, projectId, includeDrafts, includeArchived, tick])
  const navigate = value => {
    api.remember(value)
    setRoute(value)
  }
  const showPage = page => navigate({ view: 'doc', projectId: page.projectId, path: page.path })
  const finished = page => {
    const next = { view: 'doc', projectId: page.projectId, path: page.path }
    api.remember(next)
    setRoute(next)
    refresh(tick => tick + 1)
  }
  const working = data.value?.flatMap(item => item.pages) ?? []
  const activity = working.filter(page => !roots.includes(page.path) || page.revision)
    .filter(page => page.status !== 'archived')
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
  const title = view === 'doc' ? doc.value?.title : displays[view]
  const navigation = (
    <aside className="bk-sidebar" aria-label="大脑导航">
      <div className="bk-brand"><Icon/>大脑</div>
      <div className="bk-subnav">
        {Object.entries(displays).map(([id, label]) => <button key={id} type="button"
          aria-current={view === id ? 'page' : undefined}
          onClick={() => navigate({ view: id, projectId: id === 'activity' ? '' : projectId, path: '' })}>{label}</button>)}
      </div>
      <p className="bk-overline">项目知识库</p>
      {[...groups].map(([id, items]) => <div key={id}>
        {groups.size > 1 && <p className="bk-overline">{items[0].spaceTitle}</p>}
        {items.map(item => <div key={item.id} className="bk-project">
        <button type="button" aria-expanded={item.id === projectId} onClick={() =>
          navigate({ view: 'activity', projectId: item.id === projectId ? '' : item.id, path: '' })}>▤ <span>{item.title}</span></button>
        {item.id === projectId && <div className="bk-tree">
          <details open><summary>知识页</summary>
            {selectedIndex?.pages.filter(page => page.path.startsWith('pages/')).map(page => <TreePage key={page.path} page={page} path={path} open={showPage}/>)}
          </details>
          {selectedIndex?.pages.filter(page => roots.includes(page.path)).map(page => <TreePage key={page.path} page={page} path={path} open={showPage}/>)}
        </div>}
      </div>)}
      </div>)}
    </aside>
  )
  return <div className="bk-panel"><div className="bk-shell" data-docked={navigationSeat ? '' : undefined}>
    {navigationSeat ? createPortal(navigation, navigationSeat) : navigation}
    <main className="bk-main">
      <header className="bk-header">
        <div className="bk-crumb">大脑 {project ? ' / ' + project.title : ''} {view === 'doc' && path ? ' / ' + path : ''}</div>
        <div className="bk-actions">
          {project && <ImportAction key={project.id} api={api} project={project}/>}
          <button type="button" onClick={() => refresh(tick => tick + 1)}>刷新</button>
        </div>
      </header>
      <div className="bk-content">
        <Failure text={projects.error}/>
        {projects.loading && !projects.value && <p role="status">正在加载工作区…</p>}
        {projects.value?.length === 0 && <p className="bk-empty">在 Harness 左侧添加工作区并开启项目对话。Agent 会从已确认的讨论中沉淀可复用知识。</p>}
        {projects.value?.length > 0 && <>
            <div className="bk-title"><h1>{title ?? '知识页'}</h1>
              {view === 'activity' && <span>{activity.length} 条知识</span>}</div>
            {view !== 'doc' && <label className="bk-scope">查看范围 <select value={projectId} onChange={event =>
              navigate({ view, projectId: event.target.value, path: '' })}>
              <option value="">全部工作区</option>
              {[...groups].map(([id, items]) => <optgroup key={id} label={items[0].spaceTitle}>
                {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </optgroup>)}
            </select></label>}
            <Failure text={data.error || doc.error || search.error}/>
            {data.loading && view !== 'doc' && <p role="status">正在读取项目知识…</p>}
            {view !== 'doc' && <Notices notices={data.value?.flatMap(item => item.warnings)}/>}
            {view === 'activity' && !data.loading && <PageList pages={activity} open={showPage} empty="暂无知识。项目对话中形成可复用的决定、规则或偏好时，Agent 会主动沉淀。"/>}
            {view === 'search' && <section>
              <label className="bk-field">关键词<input type="search" value={query} maxLength={200} placeholder="搜索标题、正文或项目名" onChange={event => setQuery(event.target.value)}/></label>
              <div className="bk-filters">
                <label><input type="checkbox" checked={includeDrafts} onChange={event => setIncludeDrafts(event.target.checked)}/>包含草稿</label>
                <label><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)}/>包含归档</label>
              </div>
              {query.trim() && search.loading && <p role="status">正在搜索…</p>}
              {!search.loading && search.value && <>
                <Notices notices={search.value.warnings}/>
                <PageList pages={search.value.pages} open={showPage} empty="没有找到匹配的知识。"/>
              </>}
            </section>}
            {view === 'graph' && <Graph indexes={data.value ?? []} open={showPage}/>}
            {view === 'health' && <Health indexes={data.value ?? []} open={showPage} refresh={() => refresh(tick => tick + 1)}/>}
            {view === 'doc' && (doc.loading ? <p role="status">正在读取知识页…</p>
              : doc.value && <Reader key={keyOf(doc.value) + doc.value.revision} api={api} page={doc.value} proposalId={route.proposalId} done={finished}/>)}
          </>}
      </div>
    </main>
  </div></div>
}

function TreePage({ page, path, open }) {
  return <button type="button" aria-current={page.path === path ? 'page' : undefined} onClick={() => open(page)}>
    <span>{page.title}</span>{page.status !== 'active' && <small>{statuses[page.status]}</small>}
  </button>
}

function PageList({ pages, open, empty }) {
  if (!pages.length) return <p className="bk-empty">{empty}</p>
  return <ul className="bk-list">{pages.map(page => <li key={keyOf(page)}>
    <button type="button" onClick={() => open(page)}>
      <span className="bk-row-title"><strong>{page.title}</strong><small>{page.projectTitle} · {statuses[page.status]}</small></span>
      {page.excerpt && <span className="bk-excerpt">{page.excerpt}</span>}
      <small>{[page.path, date(page.updatedAt)].filter(Boolean).join(' · ')}</small>
    </button>
  </li>)}</ul>
}

function Graph({ indexes, open }) {
  if (!indexes.length) return <p className="bk-empty">等待项目索引。</p>
  return <div className="bk-graph">{indexes.map(index => {
    const pages = new Map(index.pages.map(page => [page.path, page]))
    const edges = index.edges.filter(edge => pages.has(edge.from) && pages.has(edge.to))
    return <section key={index.project.id} className="bk-card">
      <h2>{index.project.title}</h2>
      {edges.length === 0 && <p className="bk-empty">暂无知识关联。用 [[知识页标题]] 或 Markdown 相对链接关联页面。</p>}
      {edges.length > 0 && <LinkGraph edges={edges} pages={pages} open={open}/>}
    </section>
  })}</div>
}

function LinkGraph({ edges, pages, open }) {
  const first = edges.slice(0, 18)
  const paths = [...new Set(first.flatMap(edge => [edge.from, edge.to]))].slice(0, 18)
  const rows = Math.ceil(paths.length / 3)
  const points = new Map(paths.map((path, i) => [path, {
    x: 16 + (i % 3) * 34,
    y: (Math.floor(i / 3) + 0.5) * 100 / rows,
  }]))
  return <>
    <div className="bk-link-map" style={{ height: Math.max(124, rows * 66) }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {first.filter(edge => points.has(edge.from) && points.has(edge.to)).map(edge => {
          const from = points.get(edge.from)
          const to = points.get(edge.to)
          return <line key={edge.from + '→' + edge.to} x1={from.x} y1={from.y} x2={to.x} y2={to.y} vectorEffect="non-scaling-stroke"/>
        })}
      </svg>
      {[...points].map(([path, position]) => <button type="button" key={path}
        style={{ left: position.x + '%', top: position.y + '%' }} title={pages.get(path).title}
        onClick={() => open(pages.get(path))}>{pages.get(path).title}</button>)}
    </div>
    <details className="bk-history"><summary>引用关系列表 · {edges.length}</summary>
      {edges.slice(0, 100).map(edge => <div className="bk-edge" key={edge.from + '→' + edge.to}>
        <button type="button" onClick={() => open(pages.get(edge.from))}>{pages.get(edge.from).title}</button>
        <span aria-hidden="true">→</span>
        <button type="button" onClick={() => open(pages.get(edge.to))}>{pages.get(edge.to).title}</button>
      </div>)}
      {edges.length > 100 && <p className="bk-muted">此处显示前 100 条关联。</p>}
    </details>
  </>
}

function Health({ indexes, open, refresh }) {
  return <div className="bk-graph">
    <button type="button" className="bk-outline" onClick={refresh}>重新检查</button>
    {indexes.map(index => {
      const paths = new Set(index.pages.map(page => page.path))
      const missingSources = index.pages.filter(page => !page.native && page.revision && page.status === 'active' && !page.source)
      const brokenLinks = index.edges.filter(edge => !paths.has(edge.to))
      const drafts = index.pages.filter(page => page.status === 'draft')
      return <section key={index.project.id} className="bk-card">
        <h2>{index.project.title}</h2>
        <p>{missingSources.length} 条待补来源 · {brokenLinks.length} 条失效链接 · {drafts.length} 份草稿</p>
        {[...missingSources.map(page => ({ page, text: '待补来源' })),
          ...brokenLinks.map(edge => ({ page: index.pages.find(page => page.path === edge.from), text: '未找到 ' + edge.to })),
          ...drafts.map(page => ({ page, text: '待审草稿' }))].slice(0, 100).map(({ page, text }, i) =>
          <button type="button" className="bk-health-row" key={i} onClick={() => open(page)}>{page.title} <small>{text}</small></button>)}
      </section>
    })}
  </div>
}

function Reader({ api, page, proposalId, done }) {
  const [failure, setFailure] = useState('')
  const [source, setSource] = useState(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const selected = page.versions.find(item => item.id === version)
  const operation = useRef(null)
  const openSource = async source => {
    setFailure('')
    try {
      if (source.sessionId) return api.sessionOpen(source.sessionId)
      const result = await api.call({ op: 'source', projectId: page.projectId, path: page.path, source: source.ref })
      if (result.status !== 'available') throw new Error('该来源对话暂时无法打开。')
      if (result.original) setSource(result)
      else api.sessionOpen(result.sessionId)
    } catch (error) { setFailure(message(error)) }
  }
  const revise = async (op, input) => {
    if (busy) return
    setBusy(true)
    setFailure('')
    const signature = JSON.stringify([op, input])
    if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() }
    try {
      const result = await api.call({ op, projectId: page.projectId, path: page.path,
        revision: page.revision, operationId: operation.current.id, ...input })
      done(result.page)
    } catch (error) { setFailure(message(error)) }
    finally { setBusy(false) }
  }
  const change = async status => {
    if (busy) return
    if (status === 'archived' && !window.confirm('将此页移到归档？之后可以恢复。')) return
    setBusy(true)
    setFailure('')
    if (operation.current?.status !== status) operation.current = { status, id: crypto.randomUUID() }
    try {
      const result = await api.call({ op: 'status', projectId: page.projectId, path: page.path,
        revision: page.revision, operationId: operation.current.id, status })
      if (result.conflict) throw new Error('知识页已更新，请刷新后重试。')
      done(result.page)
    } catch (error) { setFailure(message(error)) }
    finally { setBusy(false) }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([page.body], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = page.title.replace(/[\\/]/gu, '_') + '.md'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <article className="bk-reader">
    <div className="bk-reader-bar">
      <span className="bk-muted">{statuses[page.status]}{page.updatedAt ? ' · ' + date(page.updatedAt) : ''}</span>
      <div className="bk-actions">
        {page.status === 'archived' ? page.versions[0]?.status !== 'draft' && <button type="button" onClick={() => void change('active')} disabled={busy}>恢复知识</button>
          : !roots.includes(page.path) && <button type="button" onClick={() => void change('archived')} disabled={busy}>归档</button>}
        {!!page.body && <button type="button" onClick={download}>导出 Markdown</button>}
      </div>
    </div>
    <Failure text={failure}/>
    {source && <OriginalMessage source={source} close={() => setSource(null)}
      open={source.archived && !api.canInspectSources ? undefined : () => api.sourceOpen(source)}/>}
    {page.source && <div className="bk-notice">来源 · {page.source.navigable ? '项目对话' : page.source.name}
      {(page.source.sessionId || page.source.navigable) &&
        <button type="button" onClick={() => void openSource(page.source)}>查看来源原文</button>}
      {page.source.quote && <blockquote>{page.source.quote}</blockquote>}
    </div>}
    {page.body ? <div className="bk-markdown"><Markdown skipHtml components={{
      img: ({ alt }) => <span>{alt ? '［图片：' + alt + '］' : '［图片］'}</span>,
      a: ({ href, children }) => /^https?:\/\//iu.test(href ?? '') ?
        <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    }}>{page.body}</Markdown></div> : <p className="bk-empty">此项目根文档尚未填写。</p>}
    {!!page.timeline?.length && <details className="bk-history" open>
      <summary>时间线 · {page.timeline.length}</summary>
      <ol>{page.timeline.map((item, index) => <li key={item.time + '/' + index}>
        <p>{date(item.time)} · {item.summary}</p>
        {item.evidence && <blockquote>{item.evidence}</blockquote>}
        {item.attribution?.navigable && <button type="button" onClick={() => void openSource(item.attribution)}>查看来源原文</button>}
      </li>)}</ol>
    </details>}
    {!!page.proposals?.length && <details className="bk-history" open>
      <summary>提案 · {page.proposals.length}</summary>
      {page.proposals.map(proposal => <Proposal key={proposal.operationId} proposal={proposal}
        open={proposal.operationId === proposalId} disabled={busy || page.status === 'archived'} resolve={input => revise('proposal', input)}/>)}
    </details>}
    <details className="bk-history">
      <summary>版本记录 {page.versions.length ? '· ' + page.versions.length : ''}</summary>
      {page.versions.length ? <>
        <label className="bk-field">选择旧版本<select value={version} onChange={event => setVersion(event.target.value)}>
          <option value="">请选择</option>{page.versions.map(item => <option value={item.id} key={item.id}>
            {date(item.updatedAt) || '导入前'} · {statuses[item.status]}
          </option>)}</select></label>
        {selected && <><pre>{selected.body}</pre>
          {selected.source?.quote && <blockquote>{selected.source.quote}</blockquote>}
          {selected.canRestore && <button type="button" disabled={busy} onClick={() => {
            if (window.confirm('将此旧版本恢复为当前正文？')) void revise('restore-version', { targetOperationId: selected.id })
          }}>恢复这个版本</button>}
        </>}
      </> : <p>暂无旧版本。</p>}
    </details>
  </article>
}

function OriginalMessage({ source, close, open }) {
  const ref = useRef(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="bk-source-dialog" aria-label="来源原消息" onClose={close}>
    <h2>来源原消息</h2>
    <p className="bk-muted">{source.original.role === 'assistant' ? '助手' : '用户'} · {date(source.original.time)}</p>
    <blockquote>{source.original.text}</blockquote>
    <div className="bk-actions">
      <button type="button" onClick={close}>关闭</button>
      {open && <button type="button" onClick={() => void open()}>在对话中定位</button>}
    </div>
  </dialog>
}

const proposalActions = { keep: '保留现有正文', replace: '采用提案', merge: '合并正文' }
function Proposal({ proposal, open, disabled, resolve }) {
  const [action, setAction] = useState('keep')
  const [note, setNote] = useState('')
  const [truth, setTruth] = useState(proposal.proposed)
  return <details className="bk-history" open={open || undefined}>
    <summary>{proposal.summary} · {proposal.resolution ? proposalActions[proposal.resolution.action] : '待处理'}</summary>
    <pre>{proposal.proposed}</pre>
    {proposal.evidence && <blockquote>{proposal.evidence}</blockquote>}
    {proposal.resolution ? <p>{proposal.resolution.note}</p> : <form onSubmit={event => {
      event.preventDefault()
      if (window.confirm('确认处理这条提案？')) void resolve({
        proposalId: proposal.operationId, action, note: note.trim(), truth: action === 'merge' ? truth : null,
      })
    }}>
      <label className="bk-field">处理方式<select value={action} onChange={event => setAction(event.target.value)}>
        {Object.entries(proposalActions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {action === 'merge' && <label className="bk-field">合并后的完整正文<textarea required rows={8} value={truth}
        onChange={event => setTruth(event.target.value)}/></label>}
      <label className="bk-field">处理依据<input required value={note} onChange={event => setNote(event.target.value)}/></label>
      <button type="submit" disabled={disabled || !note.trim()}>确认处理</button>
    </form>}
  </details>
}

function ReviewPresentation({ api, sessionId }) {
  const [reviewCss, setReviewCss] = useState('')
  useEffect(() => {
    const events = api.events(sessionId)
    if (!events || !sessionId) return
    const refresh = (initial = false) => {
      const { entries, change } = events.getSnapshot()
      if (!initial && change.kind === 'append' && !change.entries.some(({ event }) =>
        ['step/start', 'user/message', 'turn/end'].includes(event.type))) return
      if (!initial && change.kind === 'settle-assistant') return
      const keys = new Set()
      let active = false
      let step
      let ordinary
      for (const { event } of entries) {
        if (event.type === 'turn/end' || event.type === 'turn/start') { active = false; step = undefined }
        if (event.type === 'step/start') {
          step = event.data.turn + ':' + event.data.step
          ordinary = false
          if (active) keys.add('14:assistant-step' + step)
        }
        if (event.type !== 'user/message' || !step) continue
        const { source, id } = event.data
        if (source.kind === 'project-brain-curation-check' && source.reviewKind === 'automatic') {
          keys.add('13:input-message' + id)
          if (!ordinary) {
            active = true
            keys.add('14:assistant-step' + step)
          }
        } else if (source.kind === 'user' || source.kind === 'project-brain-curation-check' ||
          /^(?:goal|tool-goal|knowledge-import|brain-maintenance|task|job|(?:plugin:)?project-(?:task|goal))/u.test(source.kind)) {
          ordinary = true
          active = false
          keys.delete('14:assistant-step' + step)
        }
      }
      const root = '[data-conversation-session=' + CSS.escape(sessionId) + ']'
      setReviewCss([...keys].map(key => root + ' [data-chat-node-key=' + CSS.escape(key) + ']{display:none!important}').join('\n'))
    }
    refresh(true)
    return events.subscribe(() => refresh())
  }, [api, sessionId])
  return reviewCss ? <style>{reviewCss}</style> : null
}
