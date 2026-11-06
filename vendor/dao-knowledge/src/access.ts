/** Durable access observations and daily totals, independent of document Timeline entries. */
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeAccess, KnowledgeCalls, KnowledgeDocumentId } from './types.ts'

/** Completed operation identity; document content and user prompts are never retained here. */
export type { KnowledgeAccess } from './types.ts'

/** Deployment-owned history bounds; the trend must fit in the retained daily history. */
export interface KnowledgeAccessPolicy {
  /** Maximum retained individual observations; daily totals are independent. */
  readonly recentLimit: number
  /** Inclusive number of Host-local calendar days retained at startup and on each increment. */
  readonly retentionDays: number
  /** Chronological days returned to Clients; must not exceed retentionDays. */
  readonly trendDays: number
}

const recordSchema = z.object({
  recent: z.array(z.object({
    projectId: z.string().min(1).transform(value => value as WorkspaceId),
    documentId: z.string().min(1).transform(value => value as KnowledgeDocumentId),
    kind: z.enum(['read', 'write', 'search']),
    at: z.number(),
  })),
  days: z.record(z.iso.date(), z.record(z.string().min(1), z.number().int().nonnegative())),
})
type AccessRecord = z.infer<typeof recordSchema>

/** One queued record makes event retention and daily increments one durable publication. */
export const knowledgeAccessDomain = defineDomain({
  name: 'knowledge_access', version: 1,
  tables: { history: domainTable<'current', AccessRecord>(recordSchema) },
})

/** Host calendar days use calendar arithmetic, including daylight-saving transitions. */
function localDay(at: number, offset = 0): string {
  const date = new Date(at)
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Serial durable accounting; a failed statistics write does not undo a completed knowledge operation. */
export class KnowledgeAccessStore {
  private failed = false

  /**
   * @param table - initialized history table owned by the controller's domain lifetime.
   * @param policy - validated retention and presentation bounds.
   * @param now - host clock sampled at operation completion and index reads.
   * @param warn - reports a failed durable publication without exposing it as an operation failure.
   */
  constructor(private readonly table: KvTable<'current', AccessRecord>, private readonly policy: KnowledgeAccessPolicy,
    private readonly now: () => number, private readonly warn: (error: unknown) => void) {}

  /**
   * Establish the single record; malformed persisted data is rejected by the domain before this call.
   * @returns after initial publication, or immediately when the record already exists.
   */
  async initialize(): Promise<void> {
    const previous = this.table.get('current')
    if (previous === undefined) { await this.table.put('current', { recent: [], days: {} }); return }
    const cutoff = localDay(this.now(), 1 - this.policy.retentionDays)
    if (previous.recent.length > this.policy.recentLimit || Object.keys(previous.days).some(day => day < cutoff)) {
      await this.table.update('current', record => ({ recent: record.recent.slice(0, this.policy.recentLimit),
        days: Object.fromEntries(Object.entries(record.days).filter(([day]) => day >= cutoff)) }))
    }
  }

  /**
   * Persist one completed access, including successful retries, without changing its result on disk failure.
   * @param access - project and document selected by the admitted operation.
   * @returns after the serialized publication settles; failure marks this process's counts incomplete.
   */
  async record(access: KnowledgeAccess): Promise<void> {
    const at = this.now()
    const day = localDay(at)
    const cutoff = localDay(at, 1 - this.policy.retentionDays)
    try {
      await this.table.update('current', (previous) => {
        const days = Object.fromEntries(Object.entries(previous.days).filter(([date]) => date >= cutoff))
        const row = days[day] ?? {}
        if (row[access.projectId] === Number.MAX_SAFE_INTEGER) throw new Error('Knowledge daily call count exceeds the safe integer limit')
        days[day] = { ...row, [access.projectId]: (row[access.projectId] ?? 0) + 1 }
        return { days, recent: [{ projectId: access.projectId, documentId: access.documentId, kind: access.kind, at },
          ...previous.recent].slice(0, this.policy.recentLimit) }
      })
    } catch (error) {
      this.failed = true
      this.warn(error)
    }
  }

  /**
   * Read one project's chronological, zero-filled trend without recording a new access.
   * @param projectId - registered project whose counts may be exposed to the caller.
   * @returns host-local calendar dates and durable counts; incomplete remains set after any write failure until restart.
   */
  snapshot(projectId: WorkspaceId): KnowledgeCalls {
    const at = this.now()
    const record = this.table.get('current')
    if (record === undefined) throw new Error('Knowledge access history must be initialized before reading')
    return {
      incomplete: this.failed,
      days: Array.from({ length: this.policy.trendDays }, (_, i) => {
        const day = localDay(at, i + 1 - this.policy.trendDays)
        return { day, count: record.days[day]?.[projectId] ?? 0 }
      }),
    }
  }
}
