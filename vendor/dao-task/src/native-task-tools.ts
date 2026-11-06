/** One native Task owns its acknowledged knowledge/review tools and an irreversible audit-failure latch. */
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ArtifactTaskFiles } from './artifact-task.ts'
import type { ResearchFiles } from './research.ts'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectTaskCodexEvent } from './types.ts'
import { randomUUID } from 'node:crypto'
import type { NativeTaskTools, NativeTaskToolResult } from '@deepseek-ai/dsh-subagent/native-tools'
import type { ProjectTaskKnowledgeTools } from './types.ts'
import type { TaskReviewScope } from './task-review.ts'
import { createTaskReviewNativeTools } from './task-review-tools.ts'
import { openNativeKnowledge } from './native-knowledge.ts'

/** Serialize all native Session writes before allocating their sequence; the first failure revokes inference.
 * @param write - allocate, append and flush one complete event inside this queue.
 * @param signal - parent Task execution lifetime.
 * @returns shared acknowledgement queue, combined cancellation and the retained first-error check.
 */
export function createNativeTaskAudit<T>(write: (value: T) => Promise<void>, signal: AbortSignal): {
  readonly signal: AbortSignal
  readonly append: (value: T) => Promise<void>
  readonly checkpoint: (action: () => Promise<void>) => Promise<void>
  readonly fail: (error: unknown) => void
  readonly assertHealthy: () => void
} {
  const failed = new AbortController()
  let first: { readonly error: unknown } | undefined
  let writes = Promise.resolve()
  const fail = (error: unknown): void => { first ??= { error }; failed.abort(first.error) }
  const assertHealthy = (): void => { if (first !== undefined) throw first.error }
  const checkpoint = async (action: () => Promise<void>): Promise<void> => {
    assertHealthy()
    try { await action() }
    catch (error) { fail(error); assertHealthy() }
  }
  return {
    signal: AbortSignal.any([signal, failed.signal]), assertHealthy, checkpoint, fail,
    append(value) {
      writes = writes.then(() => checkpoint(() => write(value)))
      // The caller receives this rejection; the latch also retains it when a native peer flattens errors.
      void writes.catch(() => undefined)
      return writes
    },
  }
}

/** Compose separately audited capabilities without granting authority beyond the supplied execution scope.
 * @param knowledge - optional original-project query owner.
 * @param reviewScope - optional explicitly authorized review owner; the executor disposes it after this adapter.
 * @param signal - execution lifetime, including irreversible audit failure.
 * @param maxBytes - complete UTF-8 notification allowance.
 * @param append - shared ordered Session append and flush; methods preserve knowledge's released envelope.
 * @param fail - irreversibly stop native inference after a callback rejects without an acknowledged result.
 * @param artifact - optional Host-owned documentation checkpoints.
 * @param research - optional Host-owned private research-output checkpoints.
 * @returns advertised tools and a disposer that revokes and joins all admitted calls.
 */
export async function openNativeTaskTools(knowledge: ReturnType<ProjectTaskKnowledgeTools> | undefined,
  reviewScope: TaskReviewScope | undefined, signal: AbortSignal, maxBytes: number,
  append: (method: 'task-knowledge' | 'task-review' | 'task-artifact' | 'task-research', json: string) => Promise<void>,
  fail: (error: unknown) => void, artifact?: NativeTaskTools, research?: NativeTaskTools):
Promise<{ tools?: NativeTaskTools; [Symbol.asyncDispose](): Promise<void> }> {
  const reviewer = reviewScope === undefined ? undefined : createTaskReviewNativeTools(reviewScope)
  const definitions = [...knowledge?.definitions ?? [], ...reviewer?.definitions ?? [], ...artifact?.definitions ?? [],
    ...research?.definitions ?? []]
  const names = new Set<string>()
  for (const tool of definitions) {
    if (names.has(tool.name)) throw new Error(`Native Task tool name is duplicated: ${tool.name}`)
    names.add(tool.name)
  }
  const lifetime = new AbortController(), live = AbortSignal.any([signal, lifetime.signal])
  const pending = new Set<Promise<NativeTaskToolResult>>()
  const queries = await openNativeKnowledge(knowledge, live, maxBytes, json => append('task-knowledge', json))
  const logReview = async (value: object): Promise<void> => {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('Complete native review audit exceeds the configured event allowance')
    await append('task-review', json)
  }
  const logArtifact = async (value: object): Promise<void> => {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('Complete native artifact audit exceeds the configured event allowance')
    await append('task-artifact', json)
  }
  try {
    live.throwIfAborted()
    if (reviewer !== undefined) await logReview({ type: 'task-review/definitions', tools: reviewer.definitions })
    if (artifact !== undefined) await logArtifact({ type: 'task-artifact/definitions', tools: artifact.definitions })
    if (research !== undefined) {
      const json = JSON.stringify({ type: 'task-research/definitions', tools: research.definitions })
      if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('Complete native research tool definitions exceed the event allowance')
      await append('task-research', json)
    }
  } catch (error) {
    lifetime.abort(error)
    await queries[Symbol.asyncDispose]()
    throw error
  }
  const routes = new Map<string, NativeTaskTools>()
  for (const owner of [queries.tools, reviewer, artifact, research]) {
    if (owner !== undefined) for (const definition of owner.definitions) routes.set(definition.name, owner)
  }
  return {
    ...definitions.length === 0 ? {} : { tools: { definitions, call(name, args, signal) {
      const run = async (): Promise<NativeTaskToolResult> => {
        const active = AbortSignal.any([live, signal])
        active.throwIfAborted()
        const owner = routes.get(name)
        if (owner === undefined) throw new Error('This Task permits only its advertised native tools')
        if (owner === queries.tools) return owner.call(name, args, active)
        if (owner === artifact || owner === research) return owner.call(name, args, active)
        const id = randomUUID()
        await logReview({ type: 'task-review/call', id, name, arguments: args })
        active.throwIfAborted()
        const result = await owner.call(name, args, active)
        active.throwIfAborted()
        await logReview({ type: 'task-review/result', id, name, result })
        active.throwIfAborted()
        return result
      }
      const result = run().catch((error: unknown) => {
        if (!live.aborted) fail(error)
        throw error
      })
      pending.add(result)
      void result.then(() => pending.delete(result), () => pending.delete(result))
      return result
    } } satisfies NativeTaskTools },
    async [Symbol.asyncDispose]() {
      lifetime.abort(new Error('Native Task tools are closed'))
      await Promise.allSettled([...pending])
      await queries[Symbol.asyncDispose]()
    },
  }
}

/** Open only the acknowledged Host documentation protocol committed by this Task.
 * @param record - exact committed native Task.
 * @param files - allocated Host checkpoint owner.
 * @param guard - current project and Task authorization.
 * @param append - native-specific durable checkpoint acknowledgement.
 * @returns an owned writer to dispose before Task settlement, or absence for ordinary Tasks.
 */
export function openNativeArtifact(record: ProjectTaskRecord, files: ArtifactTaskFiles | undefined,
  guard: (() => void) | undefined, append: Parameters<ArtifactTaskFiles['openNative']>[2]): ReturnType<ArtifactTaskFiles['openNative']> | undefined {
  if (record.artifactWriteProtocol === undefined) return undefined
  if (record.artifactWriteProtocol !== 'host-checkpoint-v2') {
    throw new Error('Legacy native artifact checkpoints cannot be acknowledged; start a new documentation Task')
  }
  if (files === undefined || guard === undefined) throw new Error('Native artifact checkpoint owner is missing')
  return files.openNative(record, guard, append)
}

/** Open the committed native research checkpoint owner.
 * @param record - exact committed native Task.
 * @param files - allocated private research output owner.
 * @param guard - current project and Task authorization.
 * @param append - native-specific durable checkpoint acknowledgement.
 * @returns an owned writer to dispose before Task settlement, or absence without the protocol.
 */
export function openNativeResearch(record: ProjectTaskRecord, files: ResearchFiles | undefined,
  guard: (() => void) | undefined, append: Parameters<ResearchFiles['openNative']>[2]): ReturnType<ResearchFiles['openNative']> | undefined {
  if (record.researchWriteProtocol === undefined) return undefined
  if (files === undefined || guard === undefined) throw new Error('Native research checkpoint owner is missing')
  return files.openNative(record, guard, append)
}

/** Project one native provider outcome without treating cancellation as provider failure.
 * @param run - owned provider process and its terminal result; disposal always joins it.
 * @param signal - original execution lifetime.
 * @param failure - existing executor-specific cancelled or failed status policy.
 * @returns terminal Task fields with the complete text and optional safe provider diagnosis.
 */
export async function settleNativeTaskOutcome(run: { readonly result: Promise<SubagentResult>; dispose(): Promise<void> },
  signal: AbortSignal,
  failure: () => Pick<Extract<ProjectTaskCodexEvent, { kind: 'result' }>, 'status' | 'reason'>):
Promise<Pick<Extract<ProjectTaskCodexEvent, { kind: 'result' }>, 'status' | 'reason' | 'nativeFailure' | 'output'>> {
  let outcome: SubagentResult
  try { outcome = await run.result } finally { await run.dispose() }
  return { ...(outcome.stopReason === 'completed' ? { status: 'closed-success' as const, reason: 'completed' } : failure()),
    ...(outcome.stopReason === 'completed' || signal.aborted ? {} : { nativeFailure: {
      stopReason: outcome.stopReason, ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    } }), output: outcome.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
}
