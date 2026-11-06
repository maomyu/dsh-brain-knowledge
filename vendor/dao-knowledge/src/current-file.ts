/** Parse the same complete Brain file for ordinary proposal and recovery readers. */
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource } from './source.ts'
import { rootBody } from './root-records.ts'
import type { KnowledgeDocumentId } from './types.ts'

/** Read current understanding without merging pending proposals or recovery images.
 * @param id - authorized page or fixed root identity.
 * @param text - complete file bytes decoded as UTF-8.
 * @param version - location-qualified version of those bytes.
 * @returns parsed metadata, editable YAML and current page understanding or exact root body.
 */
export function currentKnowledgeFile(id: KnowledgeDocumentId, text: string, version: string): {
  document: ReturnType<typeof parseKnowledgeDocument>
  source: ReturnType<typeof knowledgeSource>
  page: boolean
  truth: string
} {
  const document = parseKnowledgeDocument(id, text, version)
  const page = document.entry.kind === 'page'
  const source = knowledgeSource(text, page)
  return { document, source, page, truth: page ? source.truth : rootBody(text) }
}
