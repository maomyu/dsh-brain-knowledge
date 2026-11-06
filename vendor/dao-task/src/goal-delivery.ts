/** User-only final delivery receipts; retained Git inputs survive acknowledgement loss. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectGoalRequestId } from './types.ts'
import { gitWorkspaceSchema } from './git-workspace.ts'

/** Explicit delivery gesture, independently identified from approval and acceptance. */
export const goalDeliveryInputSchema = z.object({
  requestId: z.string().min(1).transform(value => brandString<ProjectGoalRequestId>(value)),
  action: z.enum(['keep', 'merge', 'checkout']),
}).strict()

const commit = gitWorkspaceSchema.shape.baseCommit
const reservation = z.object({ integrationCommit: commit, baseCommit: commit,
  originalCommit: commit, originalBranch: z.string().min(1).nullable(), targetBranch: z.string().min(1) }).strict()

/** Terminal refusals permit a fresh gesture; pending mutations require the same retained inputs. */
export const goalDeliveryRecordSchema = z.object({
  input: goalDeliveryInputSchema,
  status: z.enum(['pending', 'kept', 'merged', 'checked-out', 'conflict']),
  reservation: reservation.optional(), commit: commit.optional(), files: z.array(z.string().min(1)).optional(),
}).strict().refine(value => (value.status !== 'kept' || value.input.action === 'keep')
  && (value.input.action !== 'keep' || value.status === 'kept')
  && (!['merged', 'checked-out', 'conflict'].includes(value.status) || value.reservation !== undefined)
  && (value.status !== 'merged' || (value.input.action === 'merge' && value.commit !== undefined))
  && (value.status !== 'checked-out' || (value.input.action === 'checkout' && value.commit !== undefined))
  && (value.status !== 'conflict' || (value.input.action === 'merge' && (value.files?.length ?? 0) > 0)),
'delivery action, stage and retained Git inputs must agree')

/** Private write-ahead receipt; the Goal record owns project and run identity. */
export type GoalDeliveryRecord = z.infer<typeof goalDeliveryRecordSchema>
