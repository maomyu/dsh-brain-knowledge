/** Health report fragments retain complete report JSON without becoming ordinary page read authority. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { KnowledgeHealthReportId, KnowledgeLocationRevision } from './types.ts'
import { renderJsonReadChunk } from './model-json-read.ts'

/** Render a bounded fragment of one currently authorized health report projection.
 * @param text - complete model-visible JSON including body, structured findings, dispositions and Timeline.
 * @param selected - current project, report, Brain location and file version; never derived from a cursor.
 * @param cursor - optional continuation bound to that identity and the complete projection digest.
 * @param maxBytes - inclusive complete response allowance, including metadata and continuation.
 * @returns a brain-health-read-json-v1 packet; even the final packet remains partial.
 * @throws for invalid/stale continuations or insufficient allowance; reading grants no mutation authority.
 */
export function renderHealthReportRead(text: string, selected: {
  readonly project_id: WorkspaceId
  readonly project: string
  readonly report_id: KnowledgeHealthReportId
  readonly locationRevision: KnowledgeLocationRevision | null
  readonly version: string
}, cursor: string | undefined, maxBytes: number): string {
  return renderJsonReadChunk(text, { ...selected, format: 'brain-health-read-json-v1' }, cursor, maxBytes)
}
