/** Immutable catalog report over one successful coding Task's durable final answer. */
import type { ProjectTaskRecord } from './records.ts'

const introduction = [
  '# Task outcome',
  '',
  'Execution completed. The result below is the task worker’s unverified report, not proof that acceptance criteria passed.',
  'Original project files remain at their execution location; this report does not copy or enumerate them.',
  '',
  '## Reported result',
  '',
].join('\n')
const truncated = '\n\n[Task report truncated to the configured completion-byte limit.]\n'

/** Render a bounded, stable report without treating task prose or proposal paths as verified file changes.
 * @param record - successful coding Task with a durable execution identity.
 * @param summary - final assistant text from that Task's admitted execution turn.
 * @param maxBytes - complete UTF-8 report allowance, including framing and truncation marker.
 * @returns report bytes as Markdown; missing evidence remains an empty self-report.
 */
export function completionReportMarkdown(record: ProjectTaskRecord, summary: string, maxBytes: number): string {
  if (record.status !== 'closed-success' || record.proposal.research !== undefined
    || record.proposal.artifact !== undefined) throw new Error('Only a successful coding Task has a completion report')
  const heading = `${introduction}Task: ${record.proposal.title}\n\n`
  const full = `${heading}${summary}\n`
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full
  const characters = Array.from(summary)
  if (Buffer.byteLength(heading + truncated, 'utf8') > maxBytes) {
    throw new Error('Task completion report framing exceeds its configured byte limit')
  }
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(heading + characters.slice(0, middle).join('') + truncated, 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return heading + characters.slice(0, low).join('') + truncated
}
