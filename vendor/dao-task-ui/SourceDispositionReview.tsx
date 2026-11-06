/** Candidate source classifications are model reports, not independently verified facts. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskKnowledgeDecision, ProjectTaskKnowledgeDiscovery,
  ProjectTaskKnowledgeHistoryEntry } from '@deepseek-ai/dsh-api-task-controller/types'
import css from './Tasks.module.css'

type SourceDisposition = {
  readonly sourceId: string
  readonly disposition: 'current' | 'superseded' | 'unresolved' | 'not-relevant'
  readonly quote?: string | undefined
  readonly rationale: string
}

type Candidate = Extract<ProjectTaskKnowledgeDiscovery, { status: 'candidate' }>

/** Resolve a decision against its exact retained candidate, including a prior comparison.
 * @param discovery - currently displayed discovery.
 * @param history - earlier candidates retained with their original receipts.
 * @param decision - durable Brain decision to match.
 * @returns the bound candidate or undefined when the source record is unavailable.
 */
export function sourceCandidateForDecision(discovery: ProjectTaskKnowledgeDiscovery | undefined,
  history: readonly ProjectTaskKnowledgeHistoryEntry[] | undefined,
  decision: ProjectTaskKnowledgeDecision): Candidate | undefined {
  const matches = (candidate: Candidate): boolean => candidate.candidateId === decision.candidateId
    && candidate.resultSha256 === decision.resultSha256 && candidate.candidateSha256 === decision.candidateSha256
  if (discovery?.status === 'candidate' && matches(discovery)) return discovery
  for (const entry of history ?? []) {
    if (!('kind' in entry) && matches(entry.discovery)) return entry.discovery
  }
  return undefined
}

/** Missing or unresolved classifications never authorize active knowledge publication.
 * @param sources - immutable reviewer classifications on the bound candidate.
 * @returns whether this candidate has an explicitly resolved source matrix.
 */
export function sourceMatrixReady(sources: readonly SourceDisposition[] | undefined): boolean {
  return sources !== undefined && sources.length > 0 && sources.every(source => source.disposition !== 'unresolved')
}

type Props = PropsLocale<'tasks'> & {
  readonly sources: readonly SourceDisposition[] | undefined
  readonly directoryVersion: string | undefined
  readonly onOpenFile?: ((path: string, directoryVersion: string) => void) | undefined
}

/** Present each retained source verdict and its exact quote without inferring opaque file contents.
 * @param props - source classifications and navigation to the retained result or exact artifact version.
 * @returns an optional read-only review; historical candidates without a matrix remain readable.
 */
export function SourceDispositionReview({ sources, directoryVersion, onOpenFile, t }: Props) {
  if (sources === undefined) return null
  const unresolved = sources.some(source => source.disposition === 'unresolved')
  return <section className={css.notice} aria-label={t('sourceMatrix.title', { count: sources.length })}
    data-source-dispositions>
    <h4>{t('sourceMatrix.title', { count: sources.length })}</h4>
    <p>{t('sourceMatrix.modelWarning')}</p>
    {unresolved && <p role="alert">{t('sourceMatrix.unresolvedWarning')}</p>}
    <ul>{sources.map((source) => {
      const artifactPath = source.sourceId.startsWith('artifact:') ? source.sourceId.slice('artifact:'.length) : undefined
      const openFile = artifactPath !== undefined && directoryVersion !== undefined && onOpenFile !== undefined
        ? () => { onOpenFile(artifactPath, directoryVersion) } : undefined
      return <li key={source.sourceId}>
        <p><code>{source.sourceId}</code> · {t(`sourceMatrix.disposition.${source.disposition}`)}</p>
        <p>{t('sourceMatrix.quote')}</p>
        {source.quote === undefined ? <p>{t('sourceMatrix.noQuote')}</p>
          : <pre className={css.discoveryText}>{source.quote}</pre>}
        <p>{t('sourceMatrix.rationale')}</p>
        <p>{source.rationale}</p>
        {openFile !== undefined && <Button size="sm" variant="ghost" onClick={openFile}>
          {t('sourceMatrix.openFile')}</Button>}
      </li>
    })}</ul>
  </section>
}
