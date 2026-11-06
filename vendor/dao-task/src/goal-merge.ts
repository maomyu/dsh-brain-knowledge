/** Write-ahead Git collection records for an approved Goal's successful coding task. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { gitWorkspaceSchema } from './git-workspace.ts'
import type { ProjectGitTreeId } from './types.ts'

const commit = gitWorkspaceSchema.shape.baseCommit
const base = z.object({ taskHead: commit, taskTree: commit.transform(value => brandString<ProjectGitTreeId>(value)),
  integrationHead: commit })

/** Each ref mutation follows a retained starting commit; terminal receipts retain the selected task tip. */
export const goalMergeSchema = z.discriminatedUnion('status', [
  base.extend({ status: z.literal('preparing') }).strict(),
  base.extend({ status: z.literal('merging'), taskCommit: commit }).strict(),
  base.extend({ status: z.enum(['merged', 'empty']), taskCommit: commit, commit }).strict(),
  base.extend({ status: z.literal('conflict'), taskCommit: commit, files: z.array(z.string().min(1)) }).strict(),
])

/** Private fixed Git inputs and recoverable stage; task ownership stays on the containing record. */
export type GoalMergeRecord = z.infer<typeof goalMergeSchema>
