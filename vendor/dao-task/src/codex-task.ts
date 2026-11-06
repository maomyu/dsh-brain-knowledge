/** Native Codex Task execution with a separately owned, append-only local audit Session. */
import type { Context } from '@deepseek-ai/cordis'
import { startCodexRun } from '@deepseek-ai/dsh-subagent-codex'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskCodexEvent, ProjectTaskCodexThreadId, ProjectTaskKnowledgeTools } from './types.ts'
import { createNativeTaskAudit, openNativeTaskTools, openNativeArtifact, openNativeResearch, settleNativeTaskOutcome } from './native-task-tools.ts'
import type { ArtifactTaskFiles } from './artifact-task.ts'
import type { TaskReviewScope } from './task-review.ts'
import type { ResearchFiles } from './research.ts'

/** Process and buffered-journal limits, resolved before accepting a native Task. */
export interface TaskCodexConfig {
  /** Native child termination grace in milliseconds. */
  readonly graceMs: number
  /** Inclusive serialized byte limit for notifications awaiting journal acknowledgement. */
  readonly maxPendingBytes: number
  /** Inclusive complete native configuration response bytes for documentation isolation. */
  readonly maxConfigBytes: number
  /** Maximum ambient MCP entries inspected before documentation execution. */
  readonly maxMcpServers: number
}

/** Persist native input before execution and join the child before retaining its terminal result.
 * @param ctx - Task owner's Session storage and subprocess services.
 * @param record - committed native dispatch receipt; never an existing thread to retry.
 * @param cwd - validated project, allocated checkout, or private documentation directory.
 * @param config - resolved deployment limits.
 * @param signal - execution cancellation, independent of the confirmation request.
 * @param changed - acknowledge durable progress; a native thread id is committed before turn submission.
 * @param knowledge - optional original-project queries, independent of selected references.
 * @param reviewScope - optional durably authorized execution-bound review owner, disposed on every exit.
 * @param artifactFiles - checkpoint owner for newly confirmed documentation Tasks.
 * @param artifactGuard - current source and Task authorization, checked before checkpoint acknowledgement.
 * @param researchFiles - checkpoint owner for newly confirmed native research Tasks.
 * @returns after the terminal receipt and child-process quiescence, or rejects on durability failure.
 */
export async function executeCodexTask(ctx: Context, record: ProjectTaskRecord, cwd: string,
  config: TaskCodexConfig, signal: AbortSignal, changed: (threadId?: ProjectTaskCodexThreadId) => Promise<void>,
  knowledge?: ReturnType<ProjectTaskKnowledgeTools>, reviewScope?: TaskReviewScope,
  artifactFiles?: ArtifactTaskFiles, artifactGuard?: () => void, researchFiles?: ResearchFiles): Promise<void> {
  await using reviewOwner = reviewScope
  const execution = record.execution
  if (execution?.runtime !== 'codex') throw new Error('Native Task requires a committed Codex execution receipt')
  const session = ctx.sessions.prepare(execution.sessionId, { meta: { cwd } })
  await using handle = await ctx.sessionPersistence.create(session.header)
  const audit = createNativeTaskAudit(async (data: ProjectTaskCodexEvent): Promise<void> => {
    const event = session.append('project-task/codex', data)
    await handle.append([event])
    await handle.flush()
  }, signal)
  const append = audit.append
  await append({ messageId: execution.messageId, kind: 'input', text: execution.inputText, selection: execution.selection })
  await using artifact = openNativeArtifact(record, artifactFiles, artifactGuard,
    checkpoint => append({ messageId: execution.messageId, kind: 'artifact-checkpoint-v2', ...checkpoint }))
  await using research = openNativeResearch(record, researchFiles, artifactGuard,
    checkpoint => append({ messageId: execution.messageId, kind: 'research-output-checkpoint-v1', ...checkpoint }))
  const cancellation = (): Pick<Extract<ProjectTaskCodexEvent, { kind: 'result' }>, 'status' | 'reason'> =>
    signal.reason === 'user' ? { status: 'closed-cancelled', reason: 'cancelled' }
      : { status: 'closed-failed', reason: signal.reason === 'project-changed' ? 'project-changed' : 'interrupted' }
  let result: Extract<ProjectTaskCodexEvent, { kind: 'result' }>
  try {
    signal.throwIfAborted()
    await using queries = await openNativeTaskTools(knowledge, reviewOwner, audit.signal, config.maxPendingBytes,
      (method, params) => append({ messageId: execution.messageId, kind: 'notification', method, params }),
      audit.fail, artifact?.tools, research?.tools)
    const run = await startCodexRun({ prompt: [{ type: 'text', text: execution.inputText }], signal: audit.signal }, {
      ...(queries.tools === undefined ? {} : { nativeTools: queries.tools }),
      ...(record.proposal.artifact === undefined ? {} : { documentationIsolation: {
        projectDirectory: record.workspacePath, maxConfigBytes: config.maxConfigBytes, maxMcpServers: config.maxMcpServers,
        ...(record.artifactWriteProtocol === 'host-checkpoint-v2' ? { artifactCheckpointWriter: true as const } : {}),
      } }),
      cwd, ...(execution.selection.model === undefined ? {} : { model: execution.selection.model }),
      env: {}, permissionMode: 'never', disposeGraceMs: config.graceMs,
      spawn: spec => ctx.subprocess.spawn(spec),
      journal: {
        sandbox: execution.selection.sandbox, maxPendingBytes: config.maxPendingBytes,
        ...(execution.selection.reasoningEffort === undefined ? {} : { reasoningEffort: execution.selection.reasoningEffort }),
        started: async (threadId) => {
          await append({ messageId: execution.messageId, kind: 'thread', threadId })
          await audit.checkpoint(() => changed(threadId))
        },
        event: async (method, params) => {
          await append({ messageId: execution.messageId, kind: 'notification', method, params: JSON.stringify(params) })
          await audit.checkpoint(() => changed())
        },
      },
    })
    result = { messageId: execution.messageId, kind: 'result', ...await settleNativeTaskOutcome(run, signal, () => signal.aborted ? cancellation() : { status: 'closed-failed', reason: 'execution-error' }) }
  } catch (error) {
    audit.assertHealthy()
    ctx.logger.warn('Native Task did not complete', error)
    result = { messageId: execution.messageId, kind: 'result',
      ...(signal.aborted ? cancellation() : { status: 'closed-failed' as const, reason: 'execution-error' }), output: '' }
  }
  audit.assertHealthy()
  await append(result)
  await audit.checkpoint(() => changed())
}
