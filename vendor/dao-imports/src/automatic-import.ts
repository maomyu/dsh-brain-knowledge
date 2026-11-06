/** New-import AI evidence reads and real Session tool receipts; legacy human reviews are not interpreted here. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { hasInformedBrainRead } from '@deepseek-ai/dsh-api-knowledge-controller'
import type { KnowledgeAutomaticMaintenanceReview } from '@deepseek-ai/dsh-api-knowledge-controller'
import type { KnowledgeAutomaticMaintenanceRequest } from '@deepseek-ai/dsh-api-knowledge-controller/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import type { KnowledgeImportRecord } from './records.ts'
import { containsExactSourceQuotes } from './source-quotes.ts'

const searchCall = z.object({ target_project_id: z.string(), query: z.string(),
  statuses: z.array(z.enum(['active', 'draft', 'archived'])), non_active_opt_in: z.literal('explicitly_requested') })
const searchResult = z.object({ project_id: z.string(), project: z.string(), query: z.string(),
  truncated: z.literal(false), issues: z.array(z.unknown()).length(0),
  hits: z.array(z.object({ path: z.string(), version: z.string() })) })

/** Read the full converted source set within the inclusive automatic-review budget.
 * @param ctx - actual attachment provider; no native source path is exposed to the model.
 * @param record - immutable selection with every attachment pair stored.
 * @param maxBytes - complete serialized evidence cap, including JSON escaping and source identities.
 * @param signal - cancellable source-read lifetime.
 * @returns complete ordered sources; omissions and invalid UTF-8 reject rather than truncating.
 */
export async function automaticImportSources(ctx: Context, record: KnowledgeImportRecord, maxBytes: number,
  signal: AbortSignal): Promise<KnowledgeAutomaticMaintenanceRequest['sources']> {
  const sources: Array<{ sourceId: string; text: string }> = []
  let bytes = 0
  for (const document of record.manifest.documents) {
    const receipt = record.receipts.find(item => item.id === document.id)
    if (receipt === undefined) throw new Error('AI import needs every frozen source attachment')
    const chunks: Buffer[] = []
    for await (const chunk of ctx.attachments.readFileStream(receipt.text, signal)) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > maxBytes) throw new Error('Complete AI import source set exceeds automatic maxReviewBytes')
      chunks.push(Buffer.from(chunk))
    }
    sources.push({ sourceId: document.id, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) })
  }
  if (Buffer.byteLength(JSON.stringify(sources), 'utf8') > maxBytes) throw new Error('Serialized complete AI import source set exceeds automatic maxReviewBytes')
  return sources
}

/** Check each review's real raster delivery and AI ordinal findings without certifying their meaning.
 * @param ctx - attachment owner and canonical Session message projections.
 * @param record - immutable extraction and supplied visual coverage.
 * @param review - strict AI source, page and optional visual assessments.
 * @param events - complete contiguous Session prefix through this review's settled answer.
 * @param signal - cancellation for independent attachment reads.
 * @returns complete only for citable full text, observed model input and no known visual omissions.
 * @throws when the attachment provider cannot verify a retained image reference and its bytes.
 */
export async function automaticImportCoverage(ctx: Context, record: KnowledgeImportRecord,
  review: KnowledgeAutomaticMaintenanceReview, events: readonly SessionEvent[],
  signal: AbortSignal): Promise<'complete' | 'incomplete'> {
  const continued = record.automatic?.continuation
  const visual = continued === undefined ? record.execution : continued.visual
  const expected = [...visual?.pdfVisual?.flatMap(item => item.images) ?? [],
    ...visual?.docxVisual?.flatMap(item => item.images) ?? []]
  if (expected.length > 0) {
    const inputId = continued?.id ?? record.execution?.message.id
    const input = events.findLast(event => event.type === 'user/message' && event.data.id === inputId)
    const answerIndex = events.findLastIndex(event => event.type === 'assistant/message')
    if (input?.type !== 'user/message' || input.data.source.kind !== 'knowledge-import'
      || input.data.source.importId !== record.manifest.id || answerIndex <= events.indexOf(input)) return 'incomplete'
    const surface = foldSurface(events.slice(0, answerIndex), ctx.sessions.messageProjections)
    if (!surface.nodes.includes(input.seq)) return 'incomplete'
    const message = deriveEventMessage(input, surface.projectedMessages)
    if (message?.role !== 'user' || !('requiredInputModalities' in message)
      || !message.requiredInputModalities.includes('image')) return 'incomplete'
    const served = message.content.flatMap(block => block.type === 'image' && block.offloaded !== true ? [block] : [])
    if (served.length !== expected.length || served.some((block, index) => JSON.stringify(block.attachment) !== JSON.stringify(expected[index]))) return 'incomplete'
    for (const attachment of expected) {
      signal.throwIfAborted()
      await ctx.attachments.readImage(attachment, signal)
    }
  }
  const visualSources = [...visual?.pdfVisual ?? [], ...visual?.docxVisual ?? []]
  const assessed = review.visualReviews ?? []
  if (assessed.length !== visualSources.length || assessed.some((item, index) => item.sourceId !== visualSources[index]?.documentId)) {
    return 'incomplete'
  }
  for (const document of record.manifest.documents) {
    if (document.format === 'text') continue
    const receipt = record.receipts.find(item => item.id === document.id)
    const assessment = assessed.find(item => item.sourceId === document.id)
    if (assessment !== undefined && (assessment.format !== document.format || assessment.omittedOrdinals.length > 0
      || assessment.unresolvedContent.length > 0 || assessment.findings.some(item => item.assessment !== 'supports-text'))) return 'incomplete'
    if (document.format === 'docx') {
      // Raster extraction does not inspect Word page layout or unextracted drawings.
      if (receipt?.extraction?.kind !== 'docx-text' || receipt.extraction.imageCount > 0) return 'incomplete'
      continue
    }
    if (receipt?.extraction?.kind !== 'pdf-text' || receipt.extraction.pagesWithoutText.length > 0
      || receipt.extraction.pagesWithTextAndPaintedImages === undefined) return 'incomplete'
    const supplied = visual?.pdfVisual?.find(item => item.documentId === document.id)
    const needsVisual = receipt.extraction.pagesWithTextAndPaintedImages.length > 0 || (supplied?.images.length ?? 0) > 0
    if (!needsVisual) continue
    if (supplied === undefined || supplied.coverage.omittedReason !== undefined
      || supplied.coverage.pageCount !== receipt.extraction.pageCount
      || supplied.images.length !== receipt.extraction.pageCount || assessment === undefined
      || assessment.findings.length !== supplied.coverage.renderedPages.length
      || assessment.findings.some((item, index) => item.ordinal !== supplied.coverage.renderedPages[index])) return 'incomplete'
  }
  return 'complete'
}

/** Extract actual whole-status search hits from one import review's logged calls and results.
 * @param events - only the current review input through its settled answer.
 * @param record - exact import project and canonical project path.
 * @param query - query authored by the strict AI envelope.
 * @returns actual complete hit identities, or null when missing, malformed or truncated.
 */
export function automaticImportSearch(events: readonly SessionEvent[], record: KnowledgeImportRecord,
  query: string): KnowledgeAutomaticMaintenanceRequest['titleSearch'] | null {
  const call = events.findLast((event) => {
    if (event.type !== 'tool/call' || event.data.name !== 'brain_search') return false
    let args: unknown
    try { args = JSON.parse(event.data.arguments) } catch (error) { void error; return false }
    const parsed = searchCall.safeParse(args)
    return parsed.success && parsed.data.target_project_id === record.workspaceId && parsed.data.query === query
      && parsed.data.statuses.length === 3 && new Set(parsed.data.statuses).size === 3
  })
  if (call?.type !== 'tool/call') return null
  const result = events.findLast(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId)
  if (result?.type !== 'tool/result' || result.data.message.isError === true) return null
  for (const block of result.data.message.content) {
    if (block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch (error) { void error; continue }
    const parsed = searchResult.safeParse(value)
    if (parsed.success && parsed.data.project_id === record.workspaceId && parsed.data.project === record.workspacePath
      && parsed.data.query === query) return { query, hits: parsed.data.hits }
  }
  return null
}

/** Check genuine current-page read receipts and converted-body quotes before automatic publication.
 * @param ctx - actual attachment source owner.
 * @param record - original import identity and attachment selection.
 * @param request - exact independently retained AI request.
 * @param events - current review's real model and tool log.
 * @param signal - cancellable quote validation.
 * @returns whether involved pages were completely read and all source quotes avoid generated converter metadata.
 */
export async function automaticImportEvidence(ctx: Context, record: KnowledgeImportRecord,
  request: Pick<KnowledgeAutomaticMaintenanceRequest, 'sourceDispositions' | 'comparedPages'>,
  events: readonly SessionEvent[], signal: AbortSignal): Promise<boolean> {
  if (request.comparedPages.some(page => page.relation !== 'unrelated' && page.relation !== 'unknown'
    && !hasInformedBrainRead(events, record.workspacePath, page.path, page.version))) return false
  for (const [index, document] of record.manifest.documents.entries()) {
    const disposition = request.sourceDispositions[index]
    const receipt = record.receipts.find(item => item.id === document.id)
    if (disposition?.sourceId !== document.id || receipt === undefined) return false
    if (disposition.quote !== undefined && !await containsExactSourceQuotes(
      ctx.attachments.readFileStream(receipt.text, signal), new Set([disposition.quote]), document.format, signal)) return false
  }
  return true
}
