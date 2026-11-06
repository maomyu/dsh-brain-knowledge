/** Explicit, cancellable native catalog lookup; selection never grants task execution. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectTaskCodexModel } from '@deepseek-ai/dsh-api-task-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Inputs owned by the enclosing review form. */
export interface CodexModelCatalogProps {
  readonly loadModels: (signal: AbortSignal) => Promise<readonly ProjectTaskCodexModel[]>
  readonly selectModel: (model: ProjectTaskCodexModel) => void
  readonly disabled: boolean
}

/** Read native choices only after a user gesture and discard cancelled results.
 * @param props - scoped lookup, draft-only selection and localized copy.
 * @returns lookup status and a model selector; no automatic selection or retry.
 */
export function CodexModelCatalog({ loadModels, selectModel, disabled, t }: CodexModelCatalogProps & PropsLocale<'tasks'>) {
  const request = useRef<AbortController | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error' | 'cancelled'>('idle')
  const [models, setModels] = useState<readonly ProjectTaskCodexModel[]>([])
  useEffect(() => () => { request.current?.abort(); request.current = null }, [])
  const load = async (): Promise<void> => {
    request.current?.abort()
    const pending = new AbortController()
    request.current = pending
    setModels([])
    setPhase('loading')
    try {
      const choices = await loadModels(pending.signal)
      if (request.current !== pending || pending.signal.aborted) return
      setModels(choices)
      setPhase('ready')
    } catch {
      // Native diagnostics may contain provider configuration; show only localized recovery guidance.
      if (request.current === pending && !pending.signal.aborted) setPhase('error')
    } finally {
      if (request.current === pending) request.current = null
    }
  }
  return <div data-codex-model-catalog={phase}>
    <p>{t('catalog.hint')}</p>
    <Button size="sm" variant="outline" disabled={disabled || phase === 'loading'} onClick={() => { void load() }}>
      {t('catalog.load')}
    </Button>
    {phase === 'loading' && <><p role="status">{t('catalog.loading')}</p>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => {
        request.current?.abort(); request.current = null; setPhase('cancelled')
      }}>{t('catalog.cancel')}</Button></>}
    {phase === 'error' && <p role="alert">{t('catalog.error')}</p>}
    {phase === 'cancelled' && <p role="status">{t('catalog.cancelled')}</p>}
    {phase === 'ready' && (models.length === 0 ? <p role="status">{t('catalog.empty')}</p>
      : <label>{t('catalog.model')}<select value="" disabled={disabled} onChange={(event) => {
        const model = models.find(item => item.model === event.target.value)
        if (model !== undefined) selectModel(model)
      }}><option value="">{t('catalog.choose')}</option>
        {models.map(model => <option key={model.model} value={model.model} title={model.description}>
          {model.label} · {model.model}{model.isDefault ? ` · ${t('catalog.default')}` : ''}
        </option>)}
      </select></label>)}
  </div>
}
