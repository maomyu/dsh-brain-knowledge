/** Human-triggered read of complete Goal coding files from retained Git commits. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectGoalCodingFiles } from '@deepseek-ai/dsh-api-task-controller/client'
import css from './GoalDashboard.module.css'

/** Read authority remains bound to the source conversation and exact Goal Task. */
export type GoalCodingFilesReader = (signal: AbortSignal) => Promise<ProjectGoalCodingFiles>

type State = { readonly status: 'idle' | 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly files: ProjectGoalCodingFiles }

type Props = PropsLocale<'tasks'> & {
  read: GoalCodingFilesReader
  onReadyChange?: ((ready: boolean) => void) | undefined
}

/** Display untrusted code only as escaped text, without reading it on mount.
 * @param props - authorized fixed-commit reader and optional decision-read notification.
 * @returns a retryable complete-file review with commit and blob identities.
 */
export function GoalCodingFilesReview({ read, onReadyChange, t }: Props) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [])
  const load = (): void => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    onReadyChange?.(false)
    setState({ status: 'loading' })
    void read(controller.signal).then((files) => {
      if (controller.signal.aborted) return
      setState({ status: 'ready', files })
      onReadyChange?.(true)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState({ status: 'error', message: error instanceof Error ? error.message : t('goalCoding.readError') })
    }).finally(() => { if (pending.current === controller) pending.current = null })
  }
  return <section className={css.codingFiles} data-goal-coding-files data-status={state.status}>
    <h5>{t('goalCoding.title')}</h5>
    <p>{t('goalCoding.explanation')}</p>
    <Button size="sm" variant="outline" disabled={state.status === 'loading'} onClick={load}>
      {t(state.status === 'ready' || state.status === 'error' ? 'goalCoding.retry' : 'goalCoding.read')}
    </Button>
    {state.status === 'loading' && <p role="status">{t('goalCoding.loading')}</p>}
    {state.status === 'error' && <p role="alert">{t('goalCoding.readError')}: {state.message}</p>}
    {state.status === 'ready' && <>
      <dl className={css.discoverySource}>
        <dt>{t('goalCoding.baseCommit')}</dt><dd><code>{state.files.baseCommit}</code></dd>
        <dt>{t('goalCoding.taskCommit')}</dt><dd><code>{state.files.taskCommit}</code></dd>
        <dt>{t('goalCoding.manifestDigest')}</dt><dd><code>{state.files.sha256}</code></dd>
      </dl>
      {state.files.files.length === 0 ? <p>{t('goalCoding.empty')}</p>
        : <ol>{state.files.files.map(file => <li key={`${file.path}/${file.version}`}>
          <h6>{file.path}</h6>
          <p>{t(`goalCoding.change.${file.change}`)} · {t('goalCoding.bytes', { count: file.bytes })}</p>
          <p>{t(file.change === 'deleted' ? 'goalCoding.baseBlob' : 'goalCoding.taskBlob')}: <code>{file.version}</code></p>
          <p>{t('goalCoding.fileDigest')}: <code>{file.sha256}</code></p>
          <pre>{file.text}</pre>
        </li>)}</ol>}
    </>}
  </section>
}
