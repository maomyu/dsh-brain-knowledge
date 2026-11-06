/** Metadata-only automatic-maintenance receipt and exact recovery, independent from legacy human decisions. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskKnowledgeAutomaticState } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './TaskProposalCard.module.css'

/** Present actual saved state without exposing retained sources or claiming the model completed a write.
 * @param props - current automatic state, owner-bound recovery and localized messages.
 * @returns status, safe pending reasons, file receipt and optional exact-operation recovery.
 */
export function AutomaticKnowledgeStatus({ state, busy = false, resume, t }: {
  readonly state: ProjectTaskKnowledgeAutomaticState
  readonly busy?: boolean
  readonly resume?: (() => Promise<boolean>) | undefined
} & PropsLocale<'tasks'>) {
  return <section className={css.modelSection} data-automatic-knowledge={state.status} aria-label={t('maintenance.statusTitle')}>
    <p role="status">{t(`maintenance.status.${state.status}`)}</p>
    {state.status === 'deferred' && <p>{t(`maintenance.reason.${state.reason}`)}</p>}
    {state.status === 'applied' && <p><code>{state.receipt.documentId}</code> · <code>{state.receipt.version}</code></p>}
    <p className={css.hint}>{t('maintenance.history')}</p>
    {(state.status === 'pending' || state.status === 'unknown') && resume !== undefined
      && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void resume() }}>{t('maintenance.resume')}</Button>}
  </section>
}
