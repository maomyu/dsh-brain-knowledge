import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AutomaticKnowledgeStatus } from '../vendor/dao-task-ui/AutomaticKnowledgeStatus.tsx'
import { TaskKnowledgeChoice } from '../vendor/dao-task-ui/TaskKnowledgeChoice.tsx'
import { TaskKnowledgeDecision } from '../vendor/dao-task-ui/TaskKnowledgeDecision.tsx'
import { TaskKnowledgeDiscovery } from '../vendor/dao-task-ui/TaskKnowledgeDiscovery.tsx'
import { TaskKnowledgeReview, canRecheckTaskKnowledge } from '../vendor/dao-task-ui/TaskKnowledgeReview.tsx'
import { GoalKnowledgeDecision } from '../vendor/dao-task-ui/GoalKnowledgeDecision.tsx'
import { GoalKnowledgeReview } from '../vendor/dao-task-ui/GoalKnowledgeReview.tsx'
import { zh } from '../vendor/dao-task-ui/locales.ts'

const t = (key, args) => (zh[key] ?? key).replace(/\{([^{}]+)\}/gu, (_, name) => String(args?.[name] ?? ''))
const knowledgeModes = { automatic: '允许独立审查并沉淀', 'read-only': '只读，不写入知识' }
const taskStatuses = { 'closed-success': '已完成', 'closed-failed': '执行失败', 'closed-cancelled': '已取消' }
const goalPhases = {
  GATHER: '收集需求', SIGNOFF: '待审批', PLAN: '修订计划', RUNNING: '执行中', PAUSED: '已暂停',
  DONE: '已完成', ESCALATED: '待人工处理', EXITED: '已结束',
}
const errorText = error => error instanceof Error ? error.message : String(error)
const newRequest = () => crypto.randomUUID()

function KnowledgeMode({ value, change, disabled }) {
  return <label>知识沉淀
    <select value={value} disabled={disabled} onChange={event => change(event.target.value)}>
      <option value="">请选择</option>
      {Object.entries(knowledgeModes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select>
  </label>
}

export function ConversationWorkflowView({ api, sessionId }) {
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState('')
  const requestNumber = useRef(0)
  const active = useSyncExternalStore(api.sessionSelection.subscribe,
    () => (api.sessionSelection.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0)
  const inWorkspace = (snapshot?.projects.length ?? 0) > 0
  const refresh = async signal => {
    const sequence = ++requestNumber.current
    try {
      const value = await api.call({ op: 'workflow', sessionId }, signal)
      if (!signal?.aborted && sequence === requestNumber.current) {
        setSnapshot(value)
        setError('')
      }
    } catch (error) {
      if (!signal?.aborted && sequence === requestNumber.current) setError(errorText(error))
    }
  }
  useEffect(() => {
    if (!sessionId || !active) return
    const lifetime = new AbortController()
    let timeout
    const poll = async () => {
      await refresh(lifetime.signal)
      if (!lifetime.signal.aborted) timeout = setTimeout(poll, 2500)
    }
    void poll()
    return () => { lifetime.abort(); clearTimeout(timeout) }
  }, [api, sessionId, active])

  useEffect(() => {
    if (!sessionId || !active || !inWorkspace) return
    const lifetime = new AbortController()
    void api.follow(sessionId, lifetime.signal).catch(error => {
      if (!lifetime.signal.aborted) setError(errorText(error))
    })
    return () => lifetime.abort()
  }, [api, sessionId, active, inWorkspace])

  const call = async (op, fields = {}, signal) => {
    const result = await api.call({ op: 'workflow-' + op, sessionId, ...fields }, signal)
    if (!['goal-options', 'goal-history', 'goal-change', 'task-read', 'goal-read', 'goal-coding'].includes(op)) {
      void refresh(signal)
    }
    return result
  }
  if (!active || !snapshot || (!snapshot.goal && !snapshot.cards.some(card => card.status !== 'dismissed'))) return null
  return <section className="bk-workflow" aria-label="对话任务与目标">
    {error && <p role="alert">{error}</p>}
    {snapshot.goal && <GoalView key={snapshot.goal.id} api={api} goal={snapshot.goal}
      tasks={snapshot.goalTasks} call={call} projectId={snapshot.goalProjectId}/>}
    {snapshot.cards.filter(card => card.status !== 'dismissed').map(card => <TaskView key={card.id} card={card}
      project={snapshot.projects.find(project => project.id === card.workspaceId)} api={api} call={call}/>)}
  </section>
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const run = async action => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      return true
    } catch (error) {
      setError(errorText(error))
      return error?.code === 'knowledge-source-identifiers-missing' ? 'source-identifiers-missing' : false
    } finally {
      setBusy(false)
      pending.current = false
    }
  }
  return { busy, error, run }
}

function readCatalog(call) {
  return (_projectId, _taskId, expectedDraftVersion, expectedActiveIndexDigest, path, expectedPageVersion, signal) =>
    call('read', { request: { expectedDraftVersion, expectedActiveIndexDigest, path, expectedPageVersion } }, signal)
}

function saveArtifact(file) {
  const bytes = Uint8Array.from(atob(file.dataBase64), char => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes]))
  const link = document.createElement('a')
  link.href = url
  link.download = file.fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function TaskView({ card, project, api, call }) {
  const [mode, setMode] = useState(card.draft.knowledgeMaintenance ?? 'automatic')
  const [allowDirty, setAllowDirty] = useState(false)
  const { busy, error, run } = useAction()
  const invoke = (action, fields, signal) => call('task-' + action,
    { cardId: card.id, projectId: card.workspaceId, ...fields }, signal)
  const completion = card.completion
  const discovery = completion?.knowledgeDiscovery
  const decision = completion?.knowledgeDecision
  const candidate = discovery?.status === 'candidate' ? discovery : undefined
  const openPage = (path, proposalId) => api.openPage(card.workspaceId, path, proposalId)
  const openArtifactFile = (path, version) => { void run(async () => saveArtifact(await invoke('artifact', { path, version }))) }
  const commit = (action, fields) => run(() => invoke(action, fields))
  return <details className="bk-workflow-item" open={card.status === 'pending' ? true : undefined}>
    <summary>{card.draft.title} · {project?.title} · {completion ? taskStatuses[completion.status] ?? completion.status
      : card.status === 'pending' ? '待确认' : '已确认执行'}</summary>
    <div className="bk-workflow-body">
      {error && <p role="alert">{error}</p>}
      {card.status === 'pending' && <>
        <pre>{card.draft.description}</pre>
        {!!card.draft.acceptanceCriteria.length && <ul>{card.draft.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {!!card.draft.verifySteps.length && <ol>{card.draft.verifySteps.map((item, i) => <li key={i}>{item}</li>)}</ol>}
        <p>执行位置 {card.draft.isolation === 'direct' ? '现有项目目录' : card.draft.isolation === 'worktree' ? '独立工作树' : '独立临时目录'}</p>
        {card.draft.brainRefs?.length > 0 && <p>计划读取 {card.draft.brainRefs.join('、')}</p>}
        <KnowledgeMode value={mode} change={setMode} disabled={busy}/>
        {card.draft.isolation === 'direct' && <label>
          <input type="checkbox" checked={allowDirty} onChange={event => setAllowDirty(event.target.checked)}/>允许这次在有未提交改动的项目执行
        </label>}
        <div className="bk-workflow-actions">
          <button type="button" disabled={!mode || busy} onClick={() => void commit('accept', { mode, allowDirty })}>确认执行</button>
          <button type="button" disabled={busy} onClick={() => void commit('dismiss')}>拒绝任务</button>
        </div>
      </>}
      {completion && <>
        <pre>{completion.summary}</pre>
        {['pending', 'queued'].includes(completion.delivery) && <div className="bk-workflow-actions">
          {Object.entries({ followup: '在原对话继续', view: '标记已读', ignore: '忽略结果' }).map(([action, label]) =>
            <button type="button" key={action} disabled={busy} onClick={() => void commit('delivery', { action })}>{label}</button>)}
        </div>}
      </>}
      {completion?.knowledgeAutomatic && <AutomaticKnowledgeStatus state={completion.knowledgeAutomatic} busy={busy}
        resume={() => commit('automatic')} t={t}/>}
      {discovery && <TaskKnowledgeDiscovery discovery={discovery} current decided={!!decision} busy={busy}
        history={completion.knowledgeDiscoveryHistory} hasArtifact={!!completion.artifactOutput} codingIsolation={card.draft.isolation}
        openPage={openPage} openArtifactFile={openArtifactFile} retry={requestId => commit('retry', { requestId })}
        refreshCandidate={requestId => commit('refresh', { requestId })} recheckNoChange={requestId => commit('recheck', { requestId })} t={t}/>}
      {candidate && !decision && !card.knowledgeMaintenanceAuthorization && <TaskKnowledgeChoice key={candidate.candidateId}
        candidate={candidate} busy={busy} decide={request => commit('decide', { request })} openArtifactFile={openArtifactFile} t={t}/>}
      {decision && <TaskKnowledgeDecision decision={decision} candidate={candidate} current projectId={card.workspaceId}
        taskId={card.taskId} busy={busy} openPage={openPage} resume={() => commit('resume')}
        reviewDraft={() => invoke('draft')} readCatalogPage={readCatalog(invoke)}
        publishDraft={request => commit('publish', { request })} reviewPublication={() => commit('publication')}
        inspectPublication={() => invoke('inspect')} acknowledgePublication={request => commit('ack', { request })} t={t}/>}
      {completion?.knowledgeReview && <TaskKnowledgeReview review={completion.knowledgeReview} refs={card.draft.brainRefs ?? []}
        busy={busy} allowRecheck={canRecheckTaskKnowledge(card.knowledgeMaintenanceAuthorization, completion, card.draft)}
        start={() => void commit('review')} stop={() => void commit('stop')} t={t}/>}
    </div>
  </details>
}

function GoalSignoff({ goal, invoke }) {
  const [options, setOptions] = useState(null)
  const [taskRoutes, setTaskRoutes] = useState([])
  const [mode, setMode] = useState(goal.plan.input.knowledgeMaintenance ?? 'automatic')
  const [documentationTasks, setDocumentationTasks] = useState(false)
  const [researchProjectChecks, setResearchProjectChecks] = useState(false)
  const [feedback, setFeedback] = useState('')
  const retained = useRef(null)
  const { busy, error, run } = useAction()
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void invoke('options', {}, controller.signal).then(value => {
      if (!controller.signal.aborted) setOptions(value)
    }, error => {
      if (!controller.signal.aborted) setLoadError(errorText(error))
    })
    return () => controller.abort()
  }, [goal.id, goal.plan.requestId])

  const master = options?.catalog.default
  const available = options?.catalog.groups
    .filter(group => options.catalog.routableProviders.includes(group.id))
    .flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, label: group.name + ' · ' + model.name })))
    .filter(route => route.provider !== master?.provider || route.model !== master?.model) ?? []
  const review = decision => {
    if (retained.current && retained.current.decision !== decision) return
    if (!retained.current) {
      const common = { requestId: newRequest(), planRequestId: goal.plan.requestId, decision }
      if (decision === 'approve') {
        if (!master || !mode) return
        const tasks = taskRoutes.map(index => available[index]).filter(Boolean).map(({ provider, model }) => ({ provider, model }))
        retained.current = { ...common, models: { master, tasks },
          budget: options.budget, knowledgeMaintenance: mode,
          documentationTasks, researchProjectChecks }
      } else retained.current = { ...common, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }
    }
    void run(() => invoke('review', { request: retained.current }))
  }
  const plan = goal.plan.input
  return <>
    <p>{plan.goal ?? goal.goal}</p>
    <ol>{plan.subGoals.map(item => <li key={item.id}>{item.title}
      {item.dependsOn?.length > 0 && <small> · 依赖 {item.dependsOn.join('、')}</small>}
      <ul>{item.criteria.map((item, i) => <li key={i}>{item.plain}
        {item.check && <pre>{item.check.command ?? item.check.url}</pre>}
      </li>)}</ul></li>)}</ol>
    <p>签署的知识范围 {[...plan.brainRefs, ...plan.rootPageRefs].join('、') || '无指定页面'}</p>
    {plan.brainProjectIds?.length > 0 && <p>允许写入的项目 {plan.brainProjectIds.join('、')}</p>}
    <p>当前模型 {options?.catalog.default?.model ?? '读取中'}</p>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    <KnowledgeMode value={mode} change={setMode} disabled={busy || !!retained.current}/>
    {plan.allowTaskDispatch !== false && <>
      {available.length > 0 && <label>可调度模型
        <select multiple value={taskRoutes} disabled={busy || !!retained.current}
          onChange={event => setTaskRoutes([...event.target.selectedOptions].map(option => option.value))}>
          {available.map((route, index) => <option key={route.provider + '/' + route.model} value={index}>{route.label}</option>)}
        </select>
      </label>}
      <label><input type="checkbox" checked={documentationTasks} disabled={busy || !!retained.current}
        onChange={event => setDocumentationTasks(event.target.checked)}/>允许子任务生成文档产物</label>
      <label><input type="checkbox" checked={researchProjectChecks} disabled={busy || !!retained.current}
        onChange={event => setResearchProjectChecks(event.target.checked)}/>允许已签署的研究检查在项目内执行</label>
    </>}
    <label>修订意见<input value={feedback} disabled={busy || !!retained.current} onChange={event => setFeedback(event.target.value)}/></label>
    <div className="bk-workflow-actions">
      <button type="button" disabled={!mode || !options || busy || retained.current?.decision === 'reject'} onClick={() => review('approve')}>审批此版本</button>
      <button type="button" disabled={busy || retained.current?.decision === 'approve'} onClick={() => review('reject')}>退回修订</button>
    </div>
  </>
}

function GoalView({ goal, projectId, tasks, api, call }) {
  const invoke = (action, fields, signal) => call('goal-' + action, { goalId: goal.id, ...fields }, signal)
  return <details className="bk-workflow-item" open={goal.phase === 'SIGNOFF' ? true : undefined}>
    <summary>{goal.goal} · {goalPhases[goal.phase]}</summary>
    <div className="bk-workflow-body">
      {goal.phase === 'SIGNOFF' && goal.plan && <GoalSignoff key={goal.plan.requestId} goal={goal} invoke={invoke}/>}
      {tasks.map(task => <GoalTask key={task.id} goal={goal} projectId={projectId} task={task} invoke={invoke} api={api}/>)}
      {['DONE', 'ESCALATED'].includes(goal.phase) && <GoalKnowledgeReview goal={goal} t={t}
        loadKnowledgeHistory={(_runId, signal) => invoke('history', {}, signal)}
        loadKnowledge={(_runId, path, signal, projectId) => invoke('change', { path, projectId }, signal)}
        reviewKnowledge={(_runId, path, request, signal, projectId) => invoke('change-review', { path, request, projectId }, signal)}/>}
    </div>
  </details>
}

function GoalTask({ goal, projectId, task, invoke, api }) {
  const { busy, error, run } = useAction()
  const call = (action, fields, signal) => invoke(action, { taskId: task.id, ...fields }, signal)
  const commit = (action, fields) => run(() => call(action, fields))
  const candidate = task.goalKnowledgeDiscovery
  if (!candidate && !task.goalKnowledgeAutomatic) return null
  const selected = candidate?.status === 'candidate' && candidate.planRequestId === goal.plan?.requestId
    && ['RUNNING', 'DONE', 'ESCALATED'].includes(goal.phase)
  const showDecision = candidate?.status === 'candidate' && (!task.knowledgeMaintenanceAuthorization || task.goalKnowledgeDecision)
  const subject = showDecision && {
    workspaceId: projectId, goalRunId: goal.id, planRequestId: candidate.planRequestId,
    reportMessageId: candidate.reportMessageId, reportSha256: candidate.reportSha256,
    discoveryId: candidate.discoveryId, candidateId: candidate.candidateId,
    resultSha256: candidate.resultSha256, candidateSha256: candidate.candidateSha256,
  }
  return <section>
    <strong>{task.title}</strong>
    {error && <p role="alert">{error}</p>}
    {task.goalKnowledgeAutomatic && <AutomaticKnowledgeStatus state={task.goalKnowledgeAutomatic} busy={busy}
      resume={() => commit('automatic')} t={t}/>}
    {candidate && candidate.status !== 'candidate' && <p>{{
      queued: '等待知识审查', reviewing: '正在审查知识证据', blocked: '知识审查待重试', 'no-change': '现有知识无需更新',
    }[candidate.status]}</p>}
    {['queued', 'blocked', 'no-change'].includes(candidate?.status) && <button type="button" disabled={busy}
      onClick={() => {
        if (window.confirm('重新核对这个目标任务的知识证据？'))
          void commit(candidate.status === 'no-change' ? 'recheck' : 'retry', { requestId: newRequest() })
      }}>核对知识证据</button>}
    {showDecision && <GoalKnowledgeDecision key={candidate.candidateId} candidate={candidate} taskId={task.id}
      subject={subject} recorded={task.goalKnowledgeDecision} canDecide={selected} canRefresh={selected} canRecover={selected}
      busy={busy} t={t} decide={request => commit('decide', { request })}
      readCodingFiles={signal => call('coding', {}, signal)} reviewDraft={() => call('draft')} readCatalogPage={readCatalog(call)}
      publishDraft={request => commit('publish', { request })} resume={() => commit('resume')} retryCommand={() => commit('resume')}
      reviewPublication={() => commit('publication')} inspectPublication={() => call('inspect')}
      acknowledgePublication={request => commit('ack', { request })} refreshCandidate={() => commit('refresh', { requestId: newRequest() })}
      openPage={(path, proposalId) => api.openPage(projectId, path, proposalId)}
      openArtifactFile={(path, version) => void run(async () => saveArtifact(await call('artifact', { path, version })))}/>}
  </section>
}
