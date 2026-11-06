/** Native effort IDs come from the selected model, not the Harness effort vocabulary. */
import type { ProjectTaskCodexModel } from '@deepseek-ai/dsh-api-task-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './props.ts'

/** Render an optional effort override without silently adopting the catalog default.
 * @param props - selected native model, explicit draft value, callback and localized labels.
 * @returns the available choices, or nothing when the model advertises none.
 */
export function CodexReasoningPicker({ choice, value, disabled, change, t }: PropsLocale<'tasks'> & {
  choice: ProjectTaskCodexModel
  value: string | undefined
  disabled: boolean
  change: (effort: string | undefined) => void
}) {
  if (choice.reasoningEfforts.length === 0) return null
  return <label>{t('runtime.effort')} <select aria-label={t('runtime.effort')} disabled={disabled} value={value ?? ''}
    onChange={(event) => { change(event.target.value === '' ? undefined : event.target.value) }}>
    <option value="">{t('runtime.effortDefault')}</option>
    {choice.reasoningEfforts.map(effort => <option key={effort.id} value={effort.id} title={effort.description}>
      {effort.id}{effort.id === choice.defaultReasoningEffort ? ` · ${t('catalog.default')}` : ''}
    </option>)}
  </select></label>
}
