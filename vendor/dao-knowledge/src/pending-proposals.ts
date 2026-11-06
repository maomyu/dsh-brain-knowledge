/** Bounded human discovery of document-owned proposals without projecting their unapproved understanding. */
import { readProposalRecords } from './proposal-records.ts'
import { knowledgeSource } from './source.ts'
import type { KnowledgeDocument, KnowledgePendingProposals, KnowledgePendingProposalSummary } from './types.ts'

function compare(left: KnowledgePendingProposalSummary, right: KnowledgePendingProposalSummary): number {
  const time = Date.parse(right.at) - Date.parse(left.at)
  if (time) return time
  if (left.documentId !== right.documentId) return left.documentId < right.documentId ? -1 : 1
  return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
}

/** Retains complete newest summaries while counting every observed unresolved proposal. */
export class KnowledgePendingProposalCollector {
  private readonly entries: KnowledgePendingProposalSummary[] = []
  private count = 0

  /** @param limit - maximum retained summary entries.
   * @param maxBytes - inclusive UTF-8 allowance for the complete pendingProposals result.
   */
  constructor(private readonly limit: number, private readonly maxBytes: number) {}

  /** Include the already-scanned page or root; archived proposals remain discoverable but confer no write permission.
   * @param document - decoded document with its current file version.
   * @param text - complete source from the same file read; no second filesystem scan is performed.
   */
  add(document: KnowledgeDocument, text: string): void {
    if (document.entry.pendingProposalCount === 0) return
    const proposals = readProposalRecords(document.entry.id, knowledgeSource(text, document.entry.kind === 'page'))
      .filter(proposal => proposal.resolution === null)
    this.count += proposals.length
    for (const proposal of proposals) {
      const entry: KnowledgePendingProposalSummary = { documentId: document.entry.id,
        operationId: proposal.operationId, at: proposal.at, summary: proposal.summary }
      // An oversized summary cannot evict a complete earlier summary that fits.
      if (this.bytes([entry], true) > this.maxBytes) continue
      this.entries.push(entry)
      this.entries.sort(compare)
      while (this.entries.length > this.limit || this.bytes(this.entries, true) > this.maxBytes) this.entries.pop()
    }
  }

  /** Copy the bounded summaries and observed count, preserving incomplete-scan information.
   * @param countComplete - false if the owning scan omitted candidates or reported any read/parse issue.
   * @returns full summaries with explicit omissions; no summary string is shortened.
   * @throws when the configured byte allowance cannot contain even the count envelope.
   */
  result(countComplete: boolean): KnowledgePendingProposals {
    const entries = [...this.entries]
    while (entries.length > 0 && this.bytes(entries, countComplete) > this.maxBytes) entries.pop()
    if (this.bytes(entries, countComplete) > this.maxBytes) {
      throw new Error('Pending proposal counts exceed maxPendingProposalBytes; increase the configured allowance')
    }
    return this.value(entries, countComplete)
  }

  private value(entries: readonly KnowledgePendingProposalSummary[], countComplete: boolean): KnowledgePendingProposals {
    return { count: this.count, entries, omitted: this.count - entries.length, countComplete }
  }

  private bytes(entries: readonly KnowledgePendingProposalSummary[], countComplete: boolean): number {
    return Buffer.byteLength(JSON.stringify(this.value(entries, countComplete)), 'utf8')
  }
}
