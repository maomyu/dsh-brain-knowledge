/** Durable review receipts and strict model-result parsing; Git or runtime failure is never a pass. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectTaskReviewResult, ProjectTaskReviewSelection, ProjectTaskReviewState, ProjectTaskReviewTicket } from './types.ts'

const text = z.string().trim().min(1)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Wire and persisted route syntax; Harness defaults resolve before admission. */
export const reviewSelectionSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('harness'), model: z.object({ provider: text, model: text,
    reasoningEffort: text.optional() }).strict().optional() }).strict(),
  z.object({ runtime: z.literal('codex'), model: text.optional(), reasoningEffort: text.optional() }).strict(),
  z.object({ runtime: z.literal('claude'), model: text.optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict(),
]).transform((value): ProjectTaskReviewSelection => value.runtime !== 'harness' ? value
  : { runtime: 'harness', ...(value.model === undefined ? {} : { model: { provider: value.model.provider, model: value.model.model,
    ...(value.model.reasoningEffort === undefined ? {} : { reasoningEffort: value.model.reasoningEffort }) } }) })

/** Explicit user-selected reviewer and fallback authority, never part of a model proposal. */
export const reviewPolicySchema = z.object({ selection: reviewSelectionSchema, allowFallback: z.boolean() }).strict()

/** Complete result; issue paths are project-relative and a pass cannot contain findings. */
export const reviewResultSchema = z.object({ status: z.enum(['passed', 'issues']), summary: text,
  issues: z.array(z.object({ severity: z.enum(['critical', 'warning', 'nit']),
    file: text.refine(value => !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
      && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.' || part === '')
      && !/[\u0000-\u001f]/.test(value), 'review file must be a project-relative path'),
    line: positive.optional(), message: text }).strict()),
}).strict().refine(value => (value.status === 'passed') === (value.issues.length === 0),
  'review status must agree with its findings')

/** Retained call history never drops failed primary attempts when a fallback succeeds. */
export const reviewStateSchema = z.object({ maxCalls: positive, calls: z.array(z.object({
  id: z.uuid().transform(value => brandString<ProjectTaskReviewTicket>(value)), number: positive,
  status: z.enum(['pending', 'passed', 'issues', 'no-diff', 'failed', 'interrupted', 'cancelled']),
  selection: reviewSelectionSchema, startedAt: time, finishedAt: time.optional(),
  origin: z.object({ kind: z.literal('execution'), sessionId: text.transform(value => brandString<SessionId>(value)) }).strict().optional(),
  allowFallback: z.boolean().optional(),
  result: reviewResultSchema.optional(), failure: text.optional(), fallbackUsed: z.boolean().optional(),
  attempts: z.array(z.object({ sessionId: text.transform(value => brandString<SessionId>(value)),
    selection: reviewSelectionSchema, status: z.enum(['pending', 'completed', 'failed']), failure: text.optional(),
  }).strict()),
}).strict().refine(value => (value.status === 'pending') === (value.finishedAt === undefined)
  && (value.origin === undefined || value.allowFallback !== undefined)
  && (value.allowFallback !== false || value.fallbackUsed !== true)
  && (value.finishedAt === undefined || value.finishedAt >= value.startedAt)
  && ((value.status === 'passed' || value.status === 'issues') === (value.result !== undefined))
  && (value.result === undefined || value.result.status === value.status)
  && (value.status === 'pending' || value.attempts.every(attempt => attempt.status !== 'pending')))),
}).strict().refine(value => value.calls.length <= value.maxCalls
  && value.calls.every((call, index) => call.number === index + 1)
  && new Set(value.calls.map(call => call.id)).size === value.calls.length
  && value.calls.filter(call => call.status === 'pending').length <= 1
  && value.calls.every((call, index) => call.status !== 'pending' || index === value.calls.length - 1)
  && new Set(value.calls.flatMap(call => call.attempts.map(attempt => attempt.sessionId))).size
    === value.calls.reduce((count, call) => count + call.attempts.length, 0))
  .transform((value): ProjectTaskReviewState => value)

/** Parse a complete JSON result without repairing contradictory verdicts or truncating findings.
 * @param output - full reviewer output; an enclosing JSON Markdown fence is accepted.
 * @param maxBytes - configured inclusive UTF-8 output limit.
 * @param maxIssues - configured inclusive finding count.
 * @returns validated assessment; malformed, contradictory or oversized output rejects.
 */
export function parseReviewResult(output: string, maxBytes: number, maxIssues: number): ProjectTaskReviewResult {
  if (Buffer.byteLength(output, 'utf8') > maxBytes) throw new Error('Review output exceeds the configured byte limit')
  const raw = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1')
  const result = reviewResultSchema.parse(JSON.parse(raw))
  if (result.issues.length > maxIssues) throw new Error('Review output exceeds the configured issue limit')
  return result
}
