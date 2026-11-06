/** Bounded activity projection from the same documents that supply the project index. */
import type { KnowledgeActivity, KnowledgeActivityEntry, KnowledgeDocument } from './types.ts'

function compare(left: KnowledgeActivityEntry, right: KnowledgeActivityEntry): number {
  const leftTime = Date.parse(left.time)
  const rightTime = Date.parse(right.time)
  const time = (Number.isNaN(rightTime) ? -Infinity : rightTime) - (Number.isNaN(leftTime) ? -Infinity : leftTime)
  if (time) return time
  return left.documentId < right.documentId ? -1 : left.documentId > right.documentId ? 1 : left.ordinal - right.ordinal
}

/** Retains newest observations without copying full document bodies into the activity feed. */
export class KnowledgeActivityCollector {
  private readonly entries: KnowledgeActivityEntry[] = []
  private truncated = false

  /** @param limit - maximum retained observations.
   * @param maxBytes - complete activity JSON allowance, including its envelope.
   */
  constructor(private readonly limit: number, private readonly maxBytes: number) {}

  /** Include eligible Timeline observations within the configured result limits.
   * @param document - successfully decoded index document; roots and archived pages contribute nothing.
   */
  add(document: KnowledgeDocument): void {
    if (document.entry.kind !== 'page' || document.entry.status === 'archived') return
    for (const [ordinal, row] of document.timeline.entries()) {
      const entry: KnowledgeActivityEntry = { documentId: document.entry.id, ordinal, title: document.entry.title,
        time: row.time, kind: row.kind, summary: row.summary, author: row.author ?? null }
      // An oversized new observation must not evict older observations that fit.
      if (this.bytes([entry]) > this.maxBytes) { this.truncated = true; continue }
      this.entries.push(entry)
      this.entries.sort(compare)
      while (this.entries.length > this.limit || this.bytes(this.entries) > this.maxBytes) {
        this.entries.pop()
        this.truncated = true
      }
    }
  }

  /** Copy the retained observations and omission status.
   * @returns the bounded projection; index scan failures are reported separately by the index.
   */
  result(): KnowledgeActivity {
    return { entries: [...this.entries], limit: this.limit, truncated: this.truncated }
  }

  private bytes(entries: readonly KnowledgeActivityEntry[]): number {
    return Buffer.byteLength(JSON.stringify({ entries, limit: this.limit, truncated: false }), 'utf8')
  }
}
