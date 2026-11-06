/** Explicit imported-document selection for a Task's later independent knowledge review. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectTaskReviewSourceSelection } from '@deepseek-ai/dsh-api-task-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskProps } from './props.ts'

type SourceGroup = {
  readonly importId: ProjectTaskReviewSourceSelection['importId']
  readonly sessionId: ProjectTaskReviewSourceSelection['sessionId']
  readonly documents: readonly {
    readonly id: ProjectTaskReviewSourceSelection['documentId']
    readonly name: string
    readonly format: string
    readonly bytes: number
  }[]
}

/** Metadata-only source listing; source bytes are read only after explicit Task confirmation. */
export type LoadTaskReviewSources = (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<readonly SourceGroup[]>

/** Let a person bind exact imported documents to one ordinary Task, or leave the set empty.
 * @param props - project-owned listing and local uncommitted selection.
 * @returns checkboxes with explicit scope and a recoverable listing failure.
 */
export function TaskReviewSourcePicker({ workspaceId, loadSources, selected, onChange, disabled, t }: {
  workspaceId: WorkspaceId
  loadSources: LoadTaskReviewSources
  selected: readonly ProjectTaskReviewSourceSelection[]
  onChange: (selected: readonly ProjectTaskReviewSourceSelection[]) => void
  disabled: boolean
  t: TaskProps['t']
}) {
  const [listing, setListing] = useState<{ status: 'loading' | 'ready' | 'error'; groups: readonly SourceGroup[] }>(
    { status: 'loading', groups: [] })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setListing({ status: 'loading', groups: [] })
    void loadSources(workspaceId, controller.signal).then((groups) => {
      if (!controller.signal.aborted) setListing({ status: 'ready', groups })
    }, () => { if (!controller.signal.aborted) setListing({ status: 'error', groups: [] }) })
    return () => { controller.abort() }
  }, [workspaceId, loadSources, revision])
  const options = listing.groups.flatMap(group => group.documents.map(document => ({
    importId: group.importId, sessionId: group.sessionId, documentId: document.id,
    name: document.name, format: document.format, bytes: document.bytes,
  })))
  return <fieldset disabled={disabled} aria-label={t('reviewSources.title')}>
    <legend>{t('reviewSources.title')}</legend>
    <p>{t('reviewSources.explanation')}</p>
    {options.some(option => option.format === 'pdf') && <p data-task-pdf-source-notice>{t('reviewSources.pdfNotice')}</p>}
    {listing.status === 'loading' && <p role="status">{t('reviewSources.loading')}</p>}
    {listing.status === 'error' && <p role="alert">{t('reviewSources.error')}{' '}
      <Button size="sm" variant="outline" onClick={() => { setRevision(value => value + 1) }}>
        {t('reviewSources.retry')}</Button></p>}
    {listing.status === 'ready' && options.length === 0 && <p>{t('reviewSources.empty')}</p>}
    {options.map((option) => {
      const selection = { importId: option.importId, sessionId: option.sessionId, documentId: option.documentId }
      const key = `${option.importId}/${option.documentId}`
      const checked = selected.some(item => item.importId === option.importId && item.documentId === option.documentId)
      return <label key={key}><input type="checkbox" checked={checked} onChange={(event) => {
        onChange(event.target.checked ? [...selected, selection]
          : selected.filter(item => item.importId !== option.importId || item.documentId !== option.documentId))
      }} /> {t('reviewSources.documentMetadata', { name: option.name, format: option.format,
        bytes: option.bytes, importId: String(option.importId).slice(0, 8) })}</label>
    })}
  </fieldset>
}
