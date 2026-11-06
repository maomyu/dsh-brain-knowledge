/** User-only pause, resume and exit receipts, independent of model outcome decisions. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectGoalRequestId, ProjectTaskId } from './types.ts'
import { goalBudgetSchema } from './goal-review.ts'

/** Retry identity plus the exact observed control revision. */
export const goalControlSchema = z.object({
  requestId: z.string().min(1).transform(value => brandString<ProjectGoalRequestId>(value)),
  action: z.enum(['pause', 'resume', 'exit']), revision: z.number().int().nonnegative(),
  budgetOverride: goalBudgetSchema.omit({ noProgressPauseThreshold: true }).partial().optional(),
}).strict().refine(value => value.action === 'resume' || value.budgetOverride === undefined)

/** Pause and exit join cancellation; resume retains one source input before admission. */
export const goalControlRecordSchema = z.object({
  input: goalControlSchema, from: z.enum(['GATHER', 'SIGNOFF', 'PLAN', 'RUNNING', 'PAUSED', 'ESCALATED']),
  delivery: z.enum(['pending', 'sent']),
  cancelledTaskIds: z.array(z.uuid().transform(value => brandString<ProjectTaskId>(value))),
  /** Missing observations never authorize cancelling a running source. Null records an idle source. */
  sourceTurnStartSeq: z.number().int().nonnegative().transform(SessionSeq).nullable().optional(),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)).optional(),
  inputText: z.string().min(1).optional(),
}).strict().refine(value => new Set(value.cancelledTaskIds).size === value.cancelledTaskIds.length
  && (value.input.action === 'resume'
    ? (value.from === 'PAUSED' || value.from === 'ESCALATED') && value.messageId !== undefined
      && value.sourceTurnStartSeq === undefined && (value.delivery !== 'sent' || value.inputText !== undefined)
    : (value.input.action === 'exit' || value.from === 'RUNNING') && value.messageId === undefined && value.inputText === undefined))
