import { pdfDocument } from '../vendor/dao-document-ui/pdf-document.ts'
import { docxDocument } from '../vendor/dao-document-ui/docx-document.ts'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './primitives.jsx'
import { KnowledgeImportReview } from '../vendor/dao-import-ui/KnowledgeImportReview.tsx'
import { PdfExtractionNotice } from '../vendor/dao-import-ui/PdfExtractionNotice.tsx'
import { DocxExtractionNotice } from '../vendor/dao-import-ui/DocxExtractionNotice.tsx'
import { zh } from '../vendor/dao-import-ui/locales.ts'

const t = (key, args) => (zh[key] ?? key).replace(/\{([^{}]+)\}/gu, (_, name) => String(args?.[name] ?? ''))
const formatOf = name => /\.pdf$/iu.test(name) ? 'pdf' : /\.docx$/iu.test(name) ? 'docx'
  : /\.(?:txt|md|markdown|csv|tsv|json|log)$/iu.test(name) ? 'text' : undefined

function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    reader.readAsDataURL(file)
  })
}

async function fingerprint(file) {
  const format = formatOf(file.name)
  if (!format) throw new Error('请选择 PDF、Word（.docx）或文本文件。')
  if (file.size > 25 * 1024 * 1024) throw new Error('每份文件最多 25 MB。')
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return { name: file.name, format, bytes: file.size,
    sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') }
}

export function ImportAction({ api, project }) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [mode, setMode] = useState('automatic')
  const [scope, setScope] = useState('project')
  const [imports, setImports] = useState([])
  const [selected, setSelected] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const intent = useRef(null)
  const pending = useRef(false)
  const reload = async () => setImports((await api.call({ op: 'import-list', projectId: project.id })).imports)
  useEffect(() => {
    if (open) void reload().catch(error => setError(error.message))
  }, [open, project.id])
  const call = (op, fields) => api.call({ op: 'import-' + op, projectId: project.id, ...fields })
  const clear = () => { setFiles([]); setSelected(null); setReceipt(null); setError(''); intent.current = null }
  const choose = list => {
    if (pending.current) return
    setFiles(Array.from(list))
    if (!selected) intent.current = null
  }
  const submit = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      if (files.length > 20) throw new Error('每次最多导入 20 份文件。')
      const candidates = []
      for (const file of files) candidates.push({ file, metadata: await fingerprint(file) })
      if (!selected && !intent.current) {
        if (!candidates.length) throw new Error('请先选择文件。')
        intent.current = {
          id: crypto.randomUUID(), locale: 'zh-CN', maintenance: mode,
          ...(scope === 'workspace' ? { scope: { kind: 'workspace', spaceId: project.spaceId } } : {}),
          documents: candidates.map(({ metadata }) => ({ id: crypto.randomUUID(), ...metadata })),
        }
      }
      let current = selected ?? await call('begin', { manifest: intent.current })
      setReceipt(current)
      for (const doc of current.documents.filter(doc => doc.status === 'pending')) {
        const match = candidates.find(({ metadata }) => metadata.sha256 === doc.sha256 && metadata.bytes === doc.bytes
          && metadata.name === doc.name && metadata.format === doc.format)
        if (!match) throw new Error('请重新选择原始文件 ' + doc.name)
        current = await call('stage', { importId: current.id, documentId: doc.id, dataBase64: await base64(match.file) })
        setReceipt(current)
      }
      current = await call('compile', { importId: current.id })
      if (current.status !== 'accepted') throw new Error('导入尚未收到会话回执。')
      clear()
      setOpen(false)
      api.sessionOpen(current.sessionId)
    } catch (error) {
      setError(error.message)
      void reload().catch(() => {})
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const abandon = async row => {
    if (!window.confirm('放弃这次尚未提交的导入？')) return
    try { await call('abandon', { importId: row.id }); clear(); await reload() }
    catch (error) { setError(error.message) }
  }
  return <>
    <button type="button" onClick={() => { clear(); setOpen(true) }}>导入文档审查</button>
    <Modal open={open} title="导入文档审查" onClose={() => { if (!busy) setOpen(false) }} className="bk-import-dialog">
      <p>资料归属 · {project.title}</p>
      <fieldset disabled={busy || !!selected || !!intent.current}>
        <label>审查范围<select value={scope} onChange={event => setScope(event.target.value)}>
          <option value="project">当前项目</option>
          {project.spaceId && <option value="workspace">所属工作区</option>}
        </select></label>
        <label>知识沉淀<select value={mode} onChange={event => setMode(event.target.value)}>
          <option value="automatic">允许独立审查并沉淀</option><option value="read-only">只读审查</option>
        </select></label>
      </fieldset>
      <div className="bk-import-drop" onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault(); choose(event.dataTransfer.files)
      }}>
        <label>选择或拖入 PDF、Word 和文本文件
          <input type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.log"
            disabled={busy} onChange={event => choose(event.target.files)}/>
        </label>
      </div>
      {!!files.length && <ul>{files.map((file, index) => <li key={index}>{file.name}</li>)}</ul>}
      {(receipt ?? selected)?.documents.map(doc => <div key={doc.id}>
        {doc.name} · {doc.status === 'stored' ? '已保留原件' : '等待上传'}
        {doc.format === 'pdf' && <PdfExtractionNotice name={doc.name} prepared={doc.status === 'stored'}
          extraction={doc.extraction} visual={doc.visual} t={t}/>}
        {doc.format === 'docx' && <DocxExtractionNotice name={doc.name} prepared={doc.status === 'stored'}
          extraction={doc.extraction} visual={doc.docxVisual} t={t}/>}
      </div>)}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || (!files.length && !selected && !receipt)} onClick={() => void submit()}>
        {busy ? '正在保留并检查资料…' : '提交并打开审查对话'}
      </button>
      {!!imports.length && <details><summary>恢复未完成的导入</summary><ul>{imports.map(row => <li key={row.id}>
        {row.documents.map(doc => doc.name).join('、')}
        <button type="button" disabled={busy} onClick={() => { clear(); setSelected(row) }}>继续准备</button>
        <button type="button" disabled={busy} onClick={() => void abandon(row)}>放弃</button>
      </li>)}</ul></details>}
    </Modal>
  </>
}

function readReviewState(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') }
  catch { return {} }
}

export function ImportReviewAction({ api, sessionId, useInput, inputActions }) {
  const [observation, setObservation] = useState(null)
  const [source, setSource] = useState(null)
  const sourceRequest = useRef(null)
  const storageKey = 'dsh-brain.import-review.' + sessionId
  const [saved, setSaved] = useState(() => readReviewState(storageKey))
  const inspect = useCallback(async (id, signal) => {
    try {
      const { lookup } = await api.call({ op: 'import-review', sessionId: id }, signal)
      if (!signal?.aborted) setObservation({ sessionId: id, lookup, phase: 'ready' })
    } catch (error) {
      if (!signal?.aborted) setObservation(previous => ({ ...previous, sessionId: id, phase: 'failed', failure: error.code }))
    }
  }, [api])
  const actions = useMemo(() => {
    const write = (key, value) => setSaved(previous => {
      const next = { ...previous, [key]: value }
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Host retains committed receipts. */ }
      return next
    })
    const attempt = key => setSaved(previous => {
      if (!previous[key]) return previous
      const next = { ...previous, [key]: { ...previous[key], attempted: true } }
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Host retains committed receipts. */ }
      return next
    })
    return {
      markReviewSession: () => write('known', true),
      rememberReview: (_id, request, changeHashes, executionSignature, stopRemaining, discoverySignature) =>
        write('review', { request, changeHashes, executionSignature, stopRemaining, discoverySignature, attempted: false }),
      attemptReview: () => attempt('review'),
      forgetReview: () => write('review', undefined),
      rememberZeroHitDraft: (_id, action) => write('draft', { ...action, attempted: false }),
      attemptZeroHitDraft: () => attempt('draft'),
      forgetZeroHitDraft: () => write('draft', undefined),
    }
  }, [storageKey])
  useEffect(() => {
    const lifetime = new AbortController()
    void inspect(sessionId, lifetime.signal)
    const events = api.events(sessionId)
    const stop = events?.subscribe(() => {
      if (events.getSnapshot().change.entries?.some(row => row.event.type === 'turn/end')) void inspect(sessionId, lifetime.signal)
    })
    return () => { lifetime.abort(); sourceRequest.current?.abort(); stop?.() }
  }, [api, sessionId, inspect])
  const command = async (op, id, request, signal) => {
    try {
      await api.call({ op: 'import-' + op, sessionId: id, request }, signal)
      await inspect(id, signal)
      return true
    } catch (error) {
      if (!signal?.aborted) setObservation(previous => ({ ...previous, sessionId: id, phase: 'failed', failure: error.code }))
      return false
    }
  }
  const read = (op, id, request, signal) => api.call({ op: 'import-' + op, sessionId: id, request }, signal)
  const openSource = async (id, documentId) => {
    sourceRequest.current?.abort()
    const request = new AbortController()
    sourceRequest.current = request
    setSource({ phase: 'loading' })
    try {
      const data = await api.call({ op: 'import-source', sessionId: id, documentId }, request.signal)
      if (!request.signal.aborted) setSource({ phase: 'ready', data })
    } catch (error) {
      if (!request.signal.aborted) setSource({ phase: 'error', message: error.message })
    }
  }
  if (!observation?.lookup && !saved.known) return null
  return <>
    <KnowledgeImportReview sessionId={sessionId} t={t} actions={actions} useInput={useInput} inputActions={inputActions}
      useReviews={select => select({ sessions: observation ? [observation] : [] })}
      useStore={select => select({ reviewDecisions: { [sessionId]: saved.review },
        zeroHitDraftActions: { [sessionId]: saved.draft }, reviewSessions: { [sessionId]: saved.known } })}
      knownFromSubmission={() => !!observation?.lookup} inspectReview={inspect}
      resumeAutomaticMaintenance={(id, signal) => command('resume', id, undefined, signal).then(ok => {
        if (!ok) throw new Error('恢复文档审查失败。')
      })}
      decideReview={(id, request, signal) => command('decide', id, request, signal)}
      saveZeroHitDraft={(id, request, signal) => command('save-draft', id, request, signal)}
      publishZeroHitDraft={(id, request, signal) => command('publish-draft', id, request, signal)}
      setComparedPageDecision={(id, request, signal) => command('page-decision', id, request, signal)}
      setSourceDispositionDecision={(id, request, signal) => command('source-decision', id, request, signal)}
      readReviewComparedPage={(id, request, signal) => read('read-compared', id, request, signal)}
      readHeldDraftCatalogPage={(id, request, signal) => read('read-catalog', id, request, signal)}
      readComparedPage={async (projectId, path, signal) => (await api.call({ op: 'import-brain-page', projectId, path }, signal)).document}
      openSource={(id, documentId) => void openSource(id, documentId)}
      newReviewId={() => crypto.randomUUID()} newDraftActionId={() => crypto.randomUUID()}/>
    {source && <Modal open title={source.data?.name ?? '导入原件'} onClose={() => { sourceRequest.current?.abort(); setSource(null) }} className="bk-import-dialog">
      {source.phase === 'loading' && <p role="status">正在核对原件…</p>}
      {source.phase === 'error' && <p role="alert">{source.message}</p>}
      {source.data && <OriginalDocument data={source.data}/>}
    </Modal>}
  </>
}

function OriginalDocument({ data }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const container = useRef(null)
  useEffect(() => {
    const lifetime = new AbortController()
    const bytes = Uint8Array.from(atob(data.dataBase64), char => char.charCodeAt(0))
    if (bytes.length !== data.bytes) { setError('原件的字节数与回执不符。'); return }
    const mime = data.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const created = URL.createObjectURL(new Blob([bytes], { type: mime }))
    setUrl(created)
    setError('')
    const page = t('import.sourcePreview.page', { page: '{page}' })
    const text = {
      notice: '页面图像暂不可用，显示原页提取文字。', page, first: '第一页', previous: '上一页',
      next: '下一页', last: '最后一页', jump: '页码', go: '跳转', invalid: '页码无效',
      empty: '此页没有可提取文字。', unreadable: '此页文字无法读取。',
    }
    const render = data.format === 'pdf' ? pdfDocument : docxDocument
    void render(container.current, bytes, lifetime.signal, { title: data.name, page, text }).catch(() => {
      if (!lifetime.signal.aborted) setError('预览暂不可用，可以下载原件核对。')
    })
    return () => { lifetime.abort(); URL.revokeObjectURL(created) }
  }, [data, attempt])
  return <>
    {url && <a href={url} download={data.name}>下载核对原件</a>}
    {error && <p role="alert">{error}<button type="button" onClick={() => setAttempt(attempt + 1)}>重试预览</button></p>}
    <div className="bk-import-preview" ref={container}/>
  </>
}
