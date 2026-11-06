/** Durable Goal write attempts; successful content and recovery images remain file-owned. */
import { z } from 'zod'
import { Buffer } from 'node:buffer'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectGoalRunId } from '@deepseek-ai/dsh-api-task-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeDocumentId, KnowledgeGoalWriteHistory, KnowledgeUpdateId } from './types.ts'

/** Deployment bounds for retained refusals and the complete per-run record. */
export interface KnowledgeGoalHistoryPolicy {
  /** Maximum retained refusal records; oldest entries are evicted. */
  readonly maxRejected: number
  /** Maximum retained characters per refusal reason; rejected content is never stored. */
  readonly maxReasonChars: number
  /** Inclusive UTF-8 byte limit for the complete durable run record. */
  readonly maxRecordBytes: number
}

/** Authority captured from a registered source and its exact Goal run. */
export interface KnowledgeGoalHistoryOwner {
  readonly runId: ProjectGoalRunId
  readonly sourceSessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly projectPath: string
}

const nonempty = z.string().min(1)
const path = nonempty.transform(value => value as KnowledgeDocumentId)
const recordSchema = z.object({
  sourceSessionId: nonempty.transform(value => value as SessionId),
  workspaceId: nonempty.transform(value => value as WorkspaceId),
  projectPath: nonempty,
  trackedFromStart: z.boolean(),
  publicationPaths: z.array(path).refine(values => new Set(values).size === values.length),
  publicationTargets: z.array(z.object({ projectId: nonempty.transform(value => value as WorkspaceId), path }).strict())
    .refine(values => new Set(values.map(value => JSON.stringify([value.projectId, value.path]))).size === values.length).optional(),
  rejected: z.array(z.object({
    operationId: z.uuid().transform(value => value as KnowledgeUpdateId),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['timeline', 'truth', 'root-page']),
    path,
    targetProjectId: nonempty.transform(value => value as WorkspaceId).optional(),
    at: z.iso.datetime(),
    reason: nonempty,
  }).strict()).refine(values => new Set(values.map(value => value.operationId)).size === values.length),
}).strict()
type Record = z.infer<typeof recordSchema>
type Refusal = Record['rejected'][number]

/** Missing records mean unknown historical coverage, never a known zero. */
export const knowledgeGoalHistoryDomain = defineDomain({
  name: 'knowledge_goal_writes', version: 1,
  tables: { runs: domainTable<ProjectGoalRunId, Record>(recordSchema) },
})

/** Serial per-run updates use the storage domain's durable write queue. */
export class KnowledgeGoalHistoryStore {
  private readonly initializing = new Map<ProjectGoalRunId, Promise<void>>()

  /**
   * @param table - domain-owned run records, closed after controller operations settle.
   * @param policy - validated retention and complete-record limits.
   */
  constructor(private readonly table: KvTable<ProjectGoalRunId, Record>, private readonly policy: KnowledgeGoalHistoryPolicy) {}

  private owned(owner: KnowledgeGoalHistoryOwner): Record | undefined {
    const record = this.table.get(owner.runId)
    if (record !== undefined && (record.sourceSessionId !== owner.sourceSessionId || record.workspaceId !== owner.workspaceId
      || record.projectPath !== owner.projectPath)) throw new Error('Knowledge write history belongs to a different Goal source or project')
    return record
  }

  private bounded(record: Record): Record {
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > this.policy.maxRecordBytes) {
      throw new Error('Complete Goal knowledge write history exceeds its configured byte limit')
    }
    return record
  }

  /** Persist a known-empty baseline before a new Goal becomes visible; existing histories never upgrade coverage.
   * @param owner - source and project captured before committing the Goal.
   * @param trackedFromStart - true only at creation, false for the first observation of an older run.
   * @returns after the baseline is durable; concurrent callers share initialization.
   */
  async initialize(owner: KnowledgeGoalHistoryOwner, trackedFromStart: boolean): Promise<void> {
    const pending = this.initializing.get(owner.runId)
    if (pending !== undefined) { await pending; this.owned(owner); return }
    const previous = this.owned(owner)
    if (previous !== undefined) {
      const next = this.bounded({ ...previous, rejected: previous.rejected.slice(-this.policy.maxRejected)
        .map(row => ({ ...row, reason: row.reason.slice(0, this.policy.maxReasonChars) })) })
      if (JSON.stringify(next) !== JSON.stringify(previous)) await this.table.update(owner.runId,
        current => this.bounded({ ...current, rejected: current.rejected.slice(-this.policy.maxRejected)
          .map(row => ({ ...row, reason: row.reason.slice(0, this.policy.maxReasonChars) })) }))
      return
    }
    const operation = this.table.put(owner.runId, this.bounded({ sourceSessionId: owner.sourceSessionId,
      workspaceId: owner.workspaceId, projectPath: owner.projectPath, trackedFromStart, publicationPaths: [], rejected: [] }))
    this.initializing.set(owner.runId, operation)
    try { await operation } finally { this.initializing.delete(owner.runId) }
  }

  /** Mark a validated publication before touching its file; interruption must not become a false no-attempt result.
   * @param owner - revalidated exact run authority.
   * @param documentId - signed file prepared for publication, or an identical retained receipt.
   * @param targetProjectId - explicit signed destination; omitted records the source project's path.
   * @returns after durable intent; this does not claim a successful file write.
   */
  async publication(owner: KnowledgeGoalHistoryOwner, documentId: KnowledgeDocumentId, targetProjectId?: WorkspaceId): Promise<void> {
    await this.initialize(owner, false)
    await this.table.update(owner.runId, (previous) => {
      if (targetProjectId === undefined || targetProjectId === owner.workspaceId) return this.bounded({ ...previous,
        publicationPaths: [...new Set([...previous.publicationPaths, documentId])] })
      const targets = previous.publicationTargets ?? []
      return targets.some(target => target.projectId === targetProjectId && target.path === documentId) ? previous
        : this.bounded({ ...previous, publicationTargets: [...targets, { projectId: targetProjectId, path: documentId }] })
    })
  }

  /** Retain a bounded refusal without storing the rejected knowledge content.
   * @param owner - revalidated source of a RUNNING approved Goal.
   * @param refusal - operation identity, digest, target and guardrail failure.
   * @returns after durable refusal; identical retained retries do not inflate the count.
   */
  async reject(owner: KnowledgeGoalHistoryOwner, refusal: Refusal): Promise<void> {
    await this.initialize(owner, false)
    await this.table.update(owner.runId, (previous) => {
      const prior = previous.rejected.find(row => row.operationId === refusal.operationId)
      if (prior !== undefined) {
        if (prior.digest !== refusal.digest || prior.path !== refusal.path || prior.kind !== refusal.kind
          || prior.targetProjectId !== refusal.targetProjectId) {
          throw new Error('Rejected knowledge write identity already belongs to a different request')
        }
        return previous
      }
      return this.bounded({ ...previous, rejected: [...previous.rejected,
        { ...refusal, reason: refusal.reason.slice(0, this.policy.maxReasonChars) }].slice(-this.policy.maxRejected) })
    })
  }

  /** Read retained attempts without writing or replacing absent historical data.
   * @param owner - source and project authorized by the caller's Goal lookup.
   * @returns coverage, candidate file paths and retained refusals; successful counts require file receipts.
   */
  snapshot(owner: KnowledgeGoalHistoryOwner): KnowledgeGoalWriteHistory {
    const record = this.owned(owner)
    return record === undefined ? { trackedFromStart: false, publicationPaths: [], rejected: [] }
      : { trackedFromStart: record.trackedFromStart, publicationPaths: [...record.publicationPaths],
        ...(record.publicationTargets === undefined ? {}
          : { publicationTargets: record.publicationTargets.map(target => ({ ...target })) }),
        rejected: record.rejected.map(({ digest: _digest, ...refusal }) => refusal) }
  }
}
