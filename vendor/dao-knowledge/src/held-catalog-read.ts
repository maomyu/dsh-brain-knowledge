/** Full old-document delivery for a Task or Goal human-held draft. */
import type { ProjectTaskKnowledgeCatalogRead, ProjectTaskKnowledgeCatalogReadRequest,
  ProjectTaskKnowledgeDraftReview } from '@deepseek-ai/dsh-api-task-controller/types'
import type { KnowledgeFileDocument } from './types.ts'

/** Return a body only when the held draft, complete catalog and selected document stay unchanged across the read.
 * @param reviewDraft - original-project held-draft review with a complete active catalog.
 * @param readPage - full Brain read of the selected old document.
 * @param request - draft, catalog and old-document versions displayed to the human.
 * @returns exact active body or an explicit changed result; no relation is inferred.
 */
export async function readHeldCatalogPage(reviewDraft: () => Promise<ProjectTaskKnowledgeDraftReview>,
  readPage: () => Promise<KnowledgeFileDocument>,
  request: ProjectTaskKnowledgeCatalogReadRequest): Promise<ProjectTaskKnowledgeCatalogRead> {
  const first = await reviewDraft()
  const matching = first.activePages.find(page => page.id === request.path)
  if (first.document.version !== request.expectedDraftVersion
    || first.activeIndexDigest !== request.expectedActiveIndexDigest
    || matching?.version !== request.expectedPageVersion) return { kind: 'changed' }
  const page = await readPage()
  const second = await reviewDraft()
  if (page.entry.status !== 'active' || page.entry.id !== matching.id
    || page.entry.title !== matching.title || page.entry.version !== matching.version
    || second.document.version !== first.document.version
    || second.activeIndexDigest !== first.activeIndexDigest
    || second.activePages.find(item => item.id === matching.id)?.version !== matching.version) {
    return { kind: 'changed' }
  }
  return { kind: page.entry.kind, id: page.entry.id, title: page.entry.title, status: 'active',
    version: page.entry.version, body: page.body }
}
