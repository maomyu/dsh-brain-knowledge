/** Unconfirmed local coding choices; only the enclosing confirmation records execution guidance. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectTaskPostSteps, ProjectTaskReviewPolicy, ProjectTaskReviewSelection } from '@deepseek-ai/dsh-api-task-controller/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AutomaticReviewSettings.module.css'

type Runtime = ProjectTaskReviewSelection['runtime']
type Draft = { identity: string; enabled: boolean; reviewer?: Runtime; allowFallback: boolean; autoRunTests: boolean; autoFix: boolean }
type Translator = PropsLocale<'tasks'>['t']

/** Keep user-picked reviewer routes stable while untouched choices follow the executor.
 * @param identity - proposal or task identity; a new source starts unconfirmed choices.
 * @param executor - currently displayed execution runtime.
 * @returns local draft controls and the policy to send only on confirmation.
 */
export function useAutomaticReviewDraft(identity: string, executor: Runtime) {
  const [saved, setSaved] = useState<Draft | null>(null)
  const draft: Draft = saved?.identity === identity ? saved
    : { identity, enabled: true, allowFallback: true, autoRunTests: true, autoFix: true }
  const reviewer = draft.reviewer ?? (executor === 'codex' ? 'claude' : executor === 'claude' ? 'codex' : 'harness')
  const policy: ProjectTaskReviewPolicy = { selection: { runtime: reviewer }, allowFallback: draft.allowFallback }
  const postSteps: ProjectTaskPostSteps = { autoRunTests: draft.autoRunTests, autoFix: draft.enabled && draft.autoFix }
  return { enabled: draft.enabled, policy, postSteps, autoFixSelected: draft.autoFix,
    enable: (enabled: boolean) => { setSaved({ ...draft, enabled }) },
    select: (value: Runtime) => { setSaved({ ...draft, reviewer: value }) },
    fallback: (allowFallback: boolean) => { setSaved({ ...draft, allowFallback }) },
    tests: (autoRunTests: boolean) => { setSaved({ ...draft, autoRunTests }) },
    fix: (autoFix: boolean) => { setSaved({ ...draft, autoFix }) },
  }
}

/** Present review costs before the user confirms task execution.
 * @param props - local unconfirmed choices and the displayed executor.
 * @returns scoped review controls, never an automatic submission.
 */
export function AutomaticReviewSettings({ draft, executor, disabled, t }: {
  draft: ReturnType<typeof useAutomaticReviewDraft>
  executor: Runtime
  disabled: boolean
  t: Translator
}) {
  return <section className={css.root} aria-label={t('automaticReview.title')} data-automatic-review>
    <label className={css.check}><input type="checkbox" checked={draft.enabled} disabled={disabled}
      onChange={(event) => { draft.enable(event.target.checked) }} /><span>{t('automaticReview.enable')}</span></label>
    {draft.enabled ? <>
      <p>{t('automaticReview.authority')}</p>
      <div role="group" aria-label={t('automaticReview.reviewer')} className={css.choices}>
        <span>{t('automaticReview.reviewer')}</span>
        {(['harness', 'codex', 'claude'] as const).map(runtime => <Button key={runtime} size="sm" variant="outline"
          disabled={disabled} aria-pressed={draft.policy.selection.runtime === runtime}
          onClick={() => { draft.select(runtime) }}>{t(`runtime.${runtime}`)}</Button>)}
      </div>
      <p>{t('automaticReview.defaults')}</p>
      <p>{t('automaticReview.limits')}</p>
      <label className={css.check}><input type="checkbox" checked={draft.policy.allowFallback} disabled={disabled}
        onChange={(event) => { draft.fallback(event.target.checked) }} /><span>{t('automaticReview.allowFallback')}</span></label>
      <p>{t(draft.policy.allowFallback ? 'automaticReview.fallbackWarning' : 'automaticReview.noFallback', { executor: t(`runtime.${executor}`) })}</p>
      <p>{t('automaticReview.scope')}</p>
      <p>{t('automaticReview.gitRequired')}</p>
    </> : <p>{t('automaticReview.disabled')}</p>}
    <label className={css.check}><input type="checkbox" checked={draft.postSteps.autoRunTests} disabled={disabled}
      onChange={(event) => { draft.tests(event.target.checked) }} /><span>{t('postSteps.tests')}</span></label>
    <p>{t('postSteps.testsGuidance')}</p>
    <label className={css.check}><input type="checkbox" checked={draft.autoFixSelected} disabled={disabled || !draft.enabled}
      onChange={(event) => { draft.fix(event.target.checked) }} /><span>{t('postSteps.fix')}</span></label>
    <p>{t(draft.enabled ? 'postSteps.fixGuidance' : 'postSteps.fixRequiresReview')}</p>
    <p>{t('postSteps.authority')}</p>
  </section>
}

/** Display retained authority without creating editable defaults on accepted tasks.
 * @param props - persisted review policy, or absence of review authority.
 * @returns the immutable authorization summary.
 */
export function AutomaticReviewSummary({ policy, postSteps, t }: {
  policy: ProjectTaskReviewPolicy | undefined
  postSteps?: ProjectTaskPostSteps | undefined
  t: Translator
}) {
  return <div className={css.summary} role="status">
    <p>{policy === undefined ? t('automaticReview.savedDisabled')
      : t('automaticReview.saved', { reviewer: t(`runtime.${policy.selection.runtime}`),
        fallback: t(policy.allowFallback ? 'automaticReview.fallbackAllowed' : 'automaticReview.fallbackDenied') })}</p>
    <p>{postSteps === undefined ? t('postSteps.savedUnspecified') : t('postSteps.saved', {
      tests: t(postSteps.autoRunTests ? 'postSteps.requested' : 'postSteps.notRequested'),
      fixes: t(postSteps.autoFix ? 'postSteps.requested' : 'postSteps.notRequested'),
    })}</p>
  </div>
}
