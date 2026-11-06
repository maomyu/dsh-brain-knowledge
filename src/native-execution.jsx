import React, { useState } from 'react'
import { CodexModelCatalog } from '../vendor/dao-task-ui/CodexModelCatalog.tsx'
import { CodexReasoningPicker } from '../vendor/dao-task-ui/CodexReasoningPicker.tsx'

const runtimeLabel = { harness: 'Harness', codex: 'Codex', claude: 'Claude Code' }

export function defaultExecution(runtime, research, artifact) {
  if (runtime === 'codex') return { runtime, selection: { sandbox: research ? 'read-only' : 'workspace-write' } }
  if (runtime === 'claude') return { runtime, selection: { runtime, permissionMode: research ? 'plan' : 'dontAsk' } }
  return { runtime }
}

export function NativeExecution({ value, change, disabled, research, artifact, loadModels, goal, t }) {
  const { runtime, selection } = value
  const [choice, setChoice] = useState(null)
  const adjust = changes => change({ runtime, selection: { ...selection, ...changes } })
  return <fieldset disabled={disabled}>
    <label>执行器<select value={runtime} onChange={event => {
      setChoice(null)
      change(defaultExecution(event.target.value, research, artifact))
    }}>
      {Object.entries(runtimeLabel).filter(([id]) => !goal || id !== 'harness').map(([id, label]) =>
        <option key={id} value={id}>{label}</option>)}
    </select></label>
    {runtime !== 'harness' && <>
      <p>{runtime === 'codex' ? '确认后使用本机 Codex 配置和账户，可能消耗额度。' : t('runtime.claudeWarning')}</p>
      {runtime === 'codex' && !goal && <label>Codex 沙箱<select disabled={research || artifact}
        value={selection.sandbox} onChange={event => adjust({ sandbox: event.target.value })}>
        <option value="read-only">只读</option><option value="workspace-write">工作区内写入</option>
      </select></label>}
      {runtime === 'claude' && <label>Claude 权限模式<select disabled={research || artifact}
        value={selection.permissionMode} onChange={event => adjust({ permissionMode: event.target.value })}>
        {(research ? ['plan'] : artifact ? ['dontAsk'] : ['dontAsk', 'acceptEdits', 'auto']).map(value =>
          <option key={value} value={value}>{value}</option>)}
      </select></label>}
      {runtime === 'codex' && <CodexModelCatalog loadModels={loadModels} disabled={disabled} t={t}
        selectModel={model => { setChoice(model); adjust({ model: model.model, reasoningEffort: undefined }) }}/>}
      <label>模型<input value={selection.model ?? ''} placeholder={goal ? '请输入模型 ID' : '使用原生配置的默认模型'}
        onChange={event => {
          setChoice(null)
          adjust({ model: event.target.value || undefined, reasoningEffort: undefined })
        }}/></label>
      {runtime === 'codex' && choice && <CodexReasoningPicker choice={choice} value={selection.reasoningEffort}
        disabled={disabled} change={reasoningEffort => adjust({ reasoningEffort })} t={t}/>}
      {runtime === 'claude' && <label>推理力度<select value={selection.effort ?? ''} onChange={event => adjust({ effort: event.target.value || undefined })}>
        <option value="">默认</option>{['low', 'medium', 'high', 'xhigh', 'max'].map(value =>
          <option key={value} value={value}>{value}</option>)}
      </select></label>}
    </>}
  </fieldset>
}

export function GoalNativePool({ value, change, disabled, loadModels, t }) {
  const [execution, setExecution] = useState(() => defaultExecution('codex', false, false))
  const add = () => {
    const { runtime, selection } = execution
    const model = selection.model?.trim()
    if (!model || value.some(route => route.runtime === runtime && route.model === model)) return
    const route = runtime === 'codex'
      ? { runtime, model, reasoningEffort: selection.reasoningEffort }
      : { runtime, model, permissionMode: selection.permissionMode, reasoningEffort: selection.effort }
    change([...value, route])
  }
  return <details>
    <summary>原生子任务模型</summary>
    <NativeExecution value={execution} change={setExecution} disabled={disabled} loadModels={loadModels} goal t={t}/>
    <button type="button" disabled={disabled || !execution.selection.model?.trim()} onClick={add}>加入可调度模型</button>
    {!!value.length && <ul>{value.map((route, index) => <li key={route.runtime + '/' + route.model}>
      {runtimeLabel[route.runtime]} · {route.model}
      <button type="button" disabled={disabled} onClick={() => change(value.filter((_, i) => i !== index))}>移除</button>
    </li>)}</ul>}
  </details>
}
