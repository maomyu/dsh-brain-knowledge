/** Human source corrections stay separate from the immutable model classification. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskKnowledgeSourceDisposition } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

type Source = ProjectTaskKnowledgeSourceDisposition

/** Compare an editable complete matrix with the retained model or earlier human review.
 * @param original - classifications used to initialize the editor.
 * @param reviewed - current editor values.
 * @returns whether any classification field differs.
 */
export function sourceMatrixChanged(original: readonly Source[] | undefined,
  reviewed: readonly Source[] | undefined): boolean {
  return original !== undefined && reviewed !== undefined && JSON.stringify(original) !== JSON.stringify(reviewed)
}

/** Require useful fields before an edited matrix can be submitted; the Host verifies source text.
 * @param sources - edited source classifications.
 * @returns whether each item has the fields required by its selected status.
 */
export function sourceMatrixFieldsValid(sources: readonly Source[] | undefined): boolean {
  return sources !== undefined && sources.length > 0 && sources.every(source => source.rationale.trim().length > 0
    && (source.disposition !== 'current' && source.disposition !== 'superseded'
      || source.quote !== undefined && source.quote.trim().length > 0))
}

/** Edit one retained source set without changing the model candidate.
 * @param props - immutable model assessment and the human's current draft.
 * @returns labeled status, quote and reason controls for each known source.
 */
export function SourceDispositionEditor({ original, reviewed, disabled, onChange, t }: {
  readonly original: readonly Source[] | undefined
  readonly reviewed: readonly Source[] | undefined
  readonly disabled: boolean
  readonly onChange: (reviewed: readonly Source[]) => void
} & PropsLocale<'tasks'>) {
  if (reviewed === undefined || original === undefined && !disabled) {
    return <p role="alert">{t('sourceMatrix.legacyUneditable')}</p>
  }
  const update = (index: number, change: Partial<Source>): void => {
    onChange(reviewed.map((source, position) => position === index ? { ...source, ...change } : source))
  }
  return <section className={css.notice} data-source-matrix-editor aria-label={t('sourceMatrix.editTitle')}>
    <h4>{t('sourceMatrix.editTitle')}</h4>
    <p>{t('sourceMatrix.editHint')}</p>
    <ul>{reviewed.map((source, index) => {
      const model = original?.[index]
      const changed = model !== undefined && JSON.stringify(model) !== JSON.stringify(source)
      return <li key={source.sourceId} data-source-id={source.sourceId} data-human-changed={changed}>
        <p><code>{source.sourceId}</code></p>
        {model !== undefined && <>
          <p>{t('sourceMatrix.originalStatus')}: {t(`sourceMatrix.disposition.${model.disposition}`)}</p>
          <p>{t('sourceMatrix.originalQuote')}: {model.quote ?? t('sourceMatrix.noQuote')}</p>
          <p>{t('sourceMatrix.originalRationale')}: {model.rationale}</p>
        </>}
        <label>{t('sourceMatrix.humanStatus', { source: source.sourceId })}
          <select value={source.disposition} disabled={disabled} onChange={(event) => {
            update(index, { disposition: event.target.value as Source['disposition'] })
          }}>
            {(['current', 'superseded', 'unresolved', 'not-relevant'] as const).map(value =>
              <option key={value} value={value}>{t(`sourceMatrix.disposition.${value}`)}</option>)}
          </select></label>
        <label>{t('sourceMatrix.humanQuote', { source: source.sourceId })}
          <textarea value={source.quote ?? ''} disabled={disabled} onChange={(event) => {
            update(index, { quote: event.target.value === '' ? undefined : event.target.value })
          }} /></label>
        <label>{t('sourceMatrix.humanRationale', { source: source.sourceId })}
          <textarea value={source.rationale} disabled={disabled} onChange={(event) => {
            update(index, { rationale: event.target.value })
          }} /></label>
        {changed && <p role="status">{t('sourceMatrix.changed')}</p>}
      </li>
    })}</ul>
    {!sourceMatrixFieldsValid(reviewed) && <p role="alert">{t('sourceMatrix.fieldsMissing')}</p>}
    <p>{t('sourceMatrix.hostValidation')}</p>
  </section>
}
