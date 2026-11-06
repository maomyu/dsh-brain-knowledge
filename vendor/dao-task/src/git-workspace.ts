/** Durable Git reservation parsing shared by Goal integration and Task execution. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectGitCommitId } from './types.ts'

/** Fixed branch and checkout reservation; preparation verifies paths against their owning identity. */
export const gitWorkspaceSchema = z.object({
  branch: z.string().trim().min(1), baseBranch: z.string().trim().min(1).nullable(),
  baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).transform(value => brandString<ProjectGitCommitId>(value)),
  relativePath: z.string().trim().min(1),
}).strict()
