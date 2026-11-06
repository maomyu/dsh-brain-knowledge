/** Durable last assessment outcomes, qualified by the captured project and Brain selection. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KnowledgeHealthCheckState, KnowledgeHealthCheckFailureReason, KnowledgeHealthCheckResult,
  KnowledgeHealthReportId, KnowledgeLocation, KnowledgeLocationRevision } from './types.ts'

const hostPath = z.string().refine(value => isAbsolute(value) && !value.includes('\0'))
const timestamp = z.iso.datetime()
type HealthCheckAttemptId = Branded<'KnowledgeHealthCheckAttemptId'>
const identity = { workspaceId: z.string().min(1).transform(value => value as WorkspaceId),
  projectPath: hostPath, brainPath: hostPath,
  locationRevision: z.string().min(1).transform(value => value as KnowledgeLocationRevision).nullable(),
  attemptId: z.uuid().transform(value => value as HealthCheckAttemptId), startedAt: timestamp }
const runningRecord = z.object({ ...identity, status: z.literal('running') }).strict()
const record = z.discriminatedUnion('status', [
  runningRecord,
  z.object({ ...identity, status: z.literal('failed'), finishedAt: timestamp,
    reason: z.enum(['max-tokens', 'incomplete', 'timeout', 'cancelled', 'interrupted', 'error']) }).strict(),
  z.object({ ...identity, status: z.literal('completed'), finishedAt: timestamp,
    reportId: z.string().min(1).transform(value => value as KnowledgeHealthReportId),
    sessionId: z.string().min(1).transform(value => value as SessionId) }).strict(),
])

/** One bounded-metadata outcome per project; report contents remain in their existing files. */
export type KnowledgeHealthCheckRecord = z.infer<typeof record>

/** Separate records leave released page, report and Session formats unchanged. */
export const knowledgeHealthCheckDomain = defineDomain({ name: 'knowledge_health_checks', version: 1,
  tables: { projects: domainTable<WorkspaceId, KnowledgeHealthCheckRecord>(record) } })

/** Persist before model admission and after settlement; a cold running record becomes interrupted without retry. */
export class KnowledgeHealthCheckStore {
  /** @param table - controller-owned last attempts, keyed by registered project identity.
   * @param now - controller clock used for durable admission and settlement timestamps.
   */
  constructor(private readonly table: KvTable<WorkspaceId, KnowledgeHealthCheckRecord>, private readonly now: () => number) {}

  /** Recover abandoned attempts without starting Agents or altering successful report files.
   * @returns after every previously running record is durably marked interrupted.
   */
  async initialize(): Promise<void> {
    for (const [id, value] of this.table.entries()) {
      if (id !== value.workspaceId) throw new Error('Brain Health check storage identity is invalid')
      if (value.status === 'running') await this.table.put(id, { ...value, status: 'failed',
        finishedAt: new Date(this.now()).toISOString(), reason: 'interrupted' })
    }
  }

  /** Read only the current project's exact captured Brain selection.
   * @param location - currently registered project and committed Brain location.
   * @returns unchecked after a path or selection change; never expose another location's outcome.
   */
  read(location: KnowledgeLocation): KnowledgeHealthCheckState {
    const value = this.table.get(location.workspaceId)
    if (value === undefined || value.projectPath !== location.projectPath || value.brainPath !== location.path
      || value.locationRevision !== location.revision) return { status: 'unchecked' }
    switch (value.status) {
      case 'running': return { status: 'running', startedAt: value.startedAt }
      case 'failed': return { status: 'failed', startedAt: value.startedAt, finishedAt: value.finishedAt, reason: value.reason }
      case 'completed': return { status: 'completed', startedAt: value.startedAt, finishedAt: value.finishedAt,
        reportId: value.reportId, sessionId: value.sessionId }
    }
  }

  /** Retain admission before the first capture or model request.
   * @param location - immutable target of this attempt.
   * @returns the exact record used to qualify settlement.
   */
  async begin(location: KnowledgeLocation): Promise<KnowledgeHealthCheckRecord & { status: 'running' }> {
    const value = runningRecord.parse({ workspaceId: location.workspaceId, projectPath: location.projectPath,
      brainPath: location.path, locationRevision: location.revision, attemptId: randomUUID(),
      startedAt: new Date(this.now()).toISOString(), status: 'running' })
    await this.table.put(location.workspaceId, value)
    return value
  }

  /** Publish one settled outcome only for the still-retained attempt.
   * @param attempt - durable admission returned by begin.
   * @param result - published report identity or a safe finite failure reason.
   * @returns after settlement is durable; a newer attempt is never overwritten.
   */
  async finish(attempt: KnowledgeHealthCheckRecord & { status: 'running' },
    result: KnowledgeHealthCheckResult | KnowledgeHealthCheckFailureReason): Promise<void> {
    const finishedAt = new Date(this.now()).toISOString()
    await this.table.update(attempt.workspaceId, current => current.attemptId !== attempt.attemptId ? current
      : typeof result === 'string' ? { ...attempt, status: 'failed', finishedAt, reason: result }
        : { ...attempt, status: 'completed', finishedAt, reportId: result.reportId, sessionId: result.sessionId })
  }
}
