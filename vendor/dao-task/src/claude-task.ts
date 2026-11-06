import { detachedAuditSession } from '../../dao-runtime/audit-session.ts'
/** Native Claude execution with acknowledged SDK events and a separate local audit Session. */
import type { Context } from '@deepseek-ai/cordis'
import { startClaudeCodeRun } from '@deepseek-ai/dsh-subagent-claude-code'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskClaudeEvent, ProjectTaskClaudeSessionId, ProjectTaskKnowledgeTools } from './types.ts'
import { createNativeTaskAudit, openNativeTaskTools, openNativeArtifact, openNativeResearch, settleNativeTaskOutcome } from './native-task-tools.ts'
import type { ArtifactTaskFiles } from './artifact-task.ts'
import type { TaskReviewScope } from './task-review.ts'
import type { ResearchFiles } from './research.ts'

/** Deployment-owned process cleanup and complete event limits. */
export interface TaskClaudeConfig {
  /** Milliseconds before escalating termination of the owned native process range. */
  readonly graceMs: number
  /** Inclusive UTF-8 allowance for each complete serialized SDK event. */
  readonly maxEventBytes: number
}

/** Persist input before spawning and join the native child before committing the outcome.
 * @param ctx - Task storage and subprocess owner.
 * @param record - fresh, committed Claude execution receipt; never resumed implicitly.
 * @param cwd - prepared worktree, project directory or private research/documentation directory.
 * @param config - resolved deployment limits.
 * @param maxSteps - configured research/documentation model-turn cap, unused for coding Tasks.
 * @param signal - Task execution lifetime, independent of the confirmation request.
 * @param changed - acknowledge durable native progress before reading the next event.
 * @param knowledge - optional original-project query provider, independent of selected references.
 * @param reviewScope - optional durably authorized execution-bound review owner, disposed on every exit.
 * @param artifactFiles - checkpoint owner for newly confirmed documentation Tasks.
 * @param artifactGuard - current source and Task authorization, checked before checkpoint acknowledgement.
 * @param researchFiles - checkpoint owner for newly confirmed native research Tasks.
 * @returns after child quiescence and terminal persistence; rejects if audit persistence fails.
 */
export async function executeClaudeTask(ctx: Context, record: ProjectTaskRecord, cwd: string,
  config: TaskClaudeConfig, maxSteps: number, signal: AbortSignal,
  changed: (sessionId?: ProjectTaskClaudeSessionId) => Promise<void>, knowledge?: ReturnType<ProjectTaskKnowledgeTools>,
  reviewScope?: TaskReviewScope, artifactFiles?: ArtifactTaskFiles, artifactGuard?: () => void,
  researchFiles?: ResearchFiles): Promise<void> {
  await using reviewOwner = reviewScope
  const execution = record.execution
  if (execution?.runtime !== 'claude') throw new Error('Claude Task requires a committed native execution receipt')
  const session = detachedAuditSession(ctx.sessions, execution.sessionId, { meta: { cwd } })
  await using handle = await ctx.sessionPersistence.create(session.header)
  const audit = createNativeTaskAudit(async (data: ProjectTaskClaudeEvent): Promise<void> => {
    await handle.append([{ ...session.append('project-task/claude', data), ignorable: true }])
    await handle.flush()
  }, signal)
  const append = audit.append
  await append({ messageId: execution.messageId, kind: 'input', text: execution.inputText,
    selection: execution.selection, nativeSessionId: execution.nativeSessionId })
  await using artifact = openNativeArtifact(record, artifactFiles, artifactGuard,
    checkpoint => append({ messageId: execution.messageId, kind: 'artifact-checkpoint-v2', ...checkpoint }))
  await using research = openNativeResearch(record, researchFiles, artifactGuard,
    checkpoint => append({ messageId: execution.messageId, kind: 'research-output-checkpoint-v1', ...checkpoint }))
  let result: Extract<ProjectTaskClaudeEvent, { kind: 'result' }>
  const failure = (): Pick<typeof result, 'status' | 'reason'> => signal.aborted
    ? signal.reason === 'user' ? { status: 'closed-cancelled', reason: 'cancelled' }
      : { status: 'closed-failed', reason: signal.reason === 'project-changed' ? 'project-changed' : 'interrupted' }
    : { status: 'closed-failed', reason: 'execution-error' }
  try {
    signal.throwIfAborted()
    await using queries = await openNativeTaskTools(knowledge, reviewOwner, audit.signal, config.maxEventBytes,
      (_method, json) => append({ messageId: execution.messageId, kind: 'notification', json }),
      audit.fail, artifact?.tools, research?.tools)
    const run = await startClaudeCodeRun({ prompt: [{ type: 'text', text: execution.inputText }], signal: audit.signal }, {
      ...(queries.tools === undefined ? {} : { nativeTools: queries.tools }),
      cwd, env: {}, permissionMode: execution.selection.permissionMode, disposeGraceMs: config.graceMs,
      ...(record.proposal.research === undefined ? {}
        : { readOnly: { projectDirectory: record.workspacePath, maxTurns: maxSteps,
          ...(record.researchWriteProtocol === 'host-checkpoint-v1' ? { privateOutputCheckpoints: true as const } : {}) } }),
      ...(record.proposal.artifact === undefined ? {}
        : { documentation: { projectDirectory: record.workspacePath, maxTurns: maxSteps } }),
      ...(execution.selection.model === undefined ? {} : { model: execution.selection.model }),
      spawn: spec => ctx.subprocess.spawn(spec),
      journal: {
        sessionId: execution.nativeSessionId, maxEventBytes: config.maxEventBytes,
        ...(execution.selection.effort === undefined ? {} : { effort: execution.selection.effort }),
        started: async (sessionId) => {
          await append({ messageId: execution.messageId, kind: 'session', sessionId })
          await audit.checkpoint(() => changed(sessionId))
        },
        event: async (json) => {
          await append({ messageId: execution.messageId, kind: 'notification', json })
          await audit.checkpoint(() => changed())
        },
      },
    })
    result = { messageId: execution.messageId, kind: 'result', ...await settleNativeTaskOutcome(run, signal, failure) }
  } catch (error) {
    audit.assertHealthy()
    ctx.logger.warn('Claude Task did not complete', error)
    result = { messageId: execution.messageId, kind: 'result', ...failure(), output: '' }
  }
  audit.assertHealthy()
  await append(result)
  await audit.checkpoint(() => changed())
}
