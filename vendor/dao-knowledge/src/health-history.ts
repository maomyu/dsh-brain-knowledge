/** Portable references expose a retained report only after the daily report publishes them. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { knowledgeSource, replaceKnowledgeFrontmatter } from './source.ts'
import type { KnowledgeHealthHistoryId, KnowledgeHealthReportId } from './types.ts'

const referenceSchema = z.object({ revisionId: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.iso.datetime() }).strict()
const manifestSchema = z.object({ version: z.literal(1), entries: z.array(referenceSchema) }).strict()

/** An ordered reference to an immutable complete report file. */
export interface HealthHistoryReference {
  readonly revisionId: KnowledgeHealthHistoryId
  readonly capturedAt: string
}

/** Validate persisted references without treating their presence as proof that files exist.
 * @param id - validated daily report identity.
 * @param fields - decoded report frontmatter, not model input.
 * @returns oldest-to-newest references; a legacy report without the field has no retained history.
 * @throws for malformed, unsupported or duplicate references.
 */
export function healthHistoryReferences(id: KnowledgeHealthReportId, fields: Record<string, unknown>): readonly HealthHistoryReference[] {
  if (fields.dsh_health_history === undefined) return []
  const parsed = manifestSchema.safeParse(fields.dsh_health_history)
  if (!parsed.success || new Set(parsed.data.entries.map(entry => entry.revisionId)).size !== parsed.data.entries.length) {
    throw new RemoteError('knowledge/document', 'health report history references are invalid', { path: `reports/${id}.md`, reason: 'invalid' })
  }
  return parsed.data.entries.map(entry => ({ ...entry, revisionId: entry.revisionId as KnowledgeHealthHistoryId }))
}

/** Hash the complete retained file rather than its normalized Markdown projection.
 * @param bytes - original report bytes, including a possible UTF-8 BOM.
 * @returns the content-addressed history identity.
 */
export function healthHistoryId(bytes: Uint8Array): KnowledgeHealthHistoryId {
  return createHash('sha256').update(bytes).digest('hex') as KnowledgeHealthHistoryId
}

/** Append a complete old-report reference without retaining old dispositions in the new assessment.
 * @param id - validated daily report identity.
 * @param oldText - validated previous daily report used to inherit its references.
 * @param nextText - complete newly generated daily report.
 * @param reference - hash and capture time for the old complete file.
 * @param maxEntries - maximum references permitted in one daily report; old entries are never pruned.
 * @param maxBytes - complete resulting report byte allowance, including the manifest.
 * @returns complete replacement with an ordered versioned manifest.
 * @throws when history is malformed or either bound would be exceeded.
 */
export function appendHealthHistory(id: KnowledgeHealthReportId, oldText: string, nextText: string,
  reference: HealthHistoryReference, maxEntries: number, maxBytes: number): string {
  const fields = knowledgeSource(oldText, false).frontmatter.value as Record<string, unknown> | null
  const entries = [...healthHistoryReferences(id, fields ?? {}), reference]
  const path = `reports/${id}.md`
  if (entries.length > maxEntries) throw new RemoteError('knowledge/document',
    'health report history reached maxEntries; existing generations were not removed', { path, reason: 'too-large' })
  const source = knowledgeSource(nextText, false)
  source.frontmatter.document.set('dsh_health_history', { version: 1, entries })
  const result = replaceKnowledgeFrontmatter(nextText, source.frontmatter.document)
  healthHistoryReferences(id, { dsh_health_history: { version: 1, entries } })
  if (Buffer.byteLength(result) > maxBytes) throw new RemoteError('knowledge/document',
    'complete health report with history exceeds maxDocumentBytes', { path, reason: 'too-large' })
  return result
}
