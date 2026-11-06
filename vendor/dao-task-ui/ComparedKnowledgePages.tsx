/** Read-only page comparisons shared by Task and Goal discovery history. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectTaskKnowledgeComparedPage, ProjectTaskKnowledgeDocumentId } from '@deepseek-ai/dsh-api-task-controller/types'

type Props = PropsLocale<'tasks'> & { pages: readonly ProjectTaskKnowledgeComparedPage[] }

/** Render the original compact comparison history without publication controls.
 * @param props - source-owned inspected page versions and localized copy.
 * @returns page count and the nonempty version list.
 */
export function ComparedKnowledgePageHistory({ pages, t }: Props) {
  return <><p>{t('taskDiscovery.comparedPages', { count: pages.length })}</p>
    {pages.length > 0 && <ul>{pages.map(page =>
      <li key={`${page.path}/${page.version}`}><code>{page.path}</code> · <code>{page.version}</code></li>)}</ul>}</>
}

/** Show the source-owned semantic comparison and optional current-project navigation.
 * @param props - inspected page versions, optional navigation and localized copy.
 * @returns an expandable comparison with relation, evidence and explanation.
 */
export function ComparedKnowledgePages({ pages, openPage, t }: Props & {
  openPage: ((path: ProjectTaskKnowledgeDocumentId) => void) | undefined
}) {
  return <details><summary>{t('taskDiscovery.comparedPages', { count: pages.length })}</summary>
    {pages.length > 0 ? <ul>{pages.map(page =>
      <li key={`${page.path}/${page.version}`}><code>{page.path}</code> · <code>{page.version}</code>
        {' · '}{page.relation === undefined ? t('taskDiscovery.pageRelation.legacy') : t(`taskDiscovery.pageRelation.${page.relation}`)}
        {page.quote !== undefined && <p>{t('taskDiscovery.pageQuote')}: <q>{page.quote}</q></p>}
        {page.reason !== undefined && <p>{t('taskDiscovery.pageReason')}: {page.reason}</p>}
        {openPage !== undefined && <Button size="sm" variant="ghost" onClick={() => { openPage(page.path as ProjectTaskKnowledgeDocumentId) }}>
          {t('taskDiscovery.openPage')}</Button>}</li>)}</ul> : <p>{t('taskDiscovery.noComparedPages')}</p>}
  </details>
}
