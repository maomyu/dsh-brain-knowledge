/** Durable capability claims and current views; learned ratings never authorize a model route. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectGoalModelCapability, ProjectGoalRequestId } from './types.ts'

const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative().max(8640000000000000)

/** Source-owned assessment input, parsed before any durable write. */
export const goalCapabilityInputSchema = z.object({
  requestId: text.transform(value => brandString<ProjectGoalRequestId>(value)),
  provider: text, model: text, tier: z.enum(['frontier', 'balanced', 'fast', 'unknown']),
  summary: text, source: text, assumed: z.boolean(),
}).strict()

/** Source-visible receipt; researched and assumed entries retain the same explicit research source. */
export const goalCapabilitySchema = goalCapabilityInputSchema.omit({ requestId: true }).extend({
  recordedAt: timestamp, expiresAt: timestamp,
}).refine(value => value.expiresAt > value.recordedAt, 'capability expiry must follow recording')

/** Append-only receipt inside its owning Goal; sequence orders simultaneous cross-run admissions. */
export const goalCapabilityRecordSchema = z.object({ input: goalCapabilityInputSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), value: goalCapabilitySchema }).strict()
  .refine(({ input, value }) => {
    const { requestId: _requestId, ...claim } = input
    const { recordedAt: _recordedAt, expiresAt: _expiresAt, ...retained } = value
    return JSON.stringify(claim) === JSON.stringify(retained)
  }, 'capability receipt must retain the exact accepted claim')

/** Current projection includes only the newest claim per exact provider/model identity.
 * @param records - committed receipts across retained local Goals.
 * @param now - current wall-clock time; future-dated receipts remain unresolved.
 * @returns fresh claims in admission order; an expired replacement never revives its predecessor.
 */
export function currentGoalCapabilities(records: Iterable<z.infer<typeof goalCapabilityRecordSchema>>,
  now: number): ProjectGoalModelCapability[] {
  const newest = new Map<string, z.infer<typeof goalCapabilityRecordSchema>>()
  for (const record of records) {
    const key = JSON.stringify([record.value.provider, record.value.model])
    if ((newest.get(key)?.sequence ?? 0) < record.sequence) newest.set(key, record)
  }
  return [...newest.values()].sort((a, b) => a.sequence - b.sequence).map(record => record.value)
    .filter(value => value.recordedAt <= now && now < value.expiresAt)
}
