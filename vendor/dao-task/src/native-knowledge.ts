/** Task-owned native query admission, durable acknowledgement and quiescent cancellation. */
import { randomUUID } from 'node:crypto'
import type { NativeTaskTools, NativeTaskToolResult } from '@deepseek-ai/dsh-subagent/native-tools'
import type { ProjectTaskKnowledgeTools } from './types.ts'

/** Retain definitions before inference and every complete result before the native caller receives it.
 * @param reader - project/location-bound knowledge provider, absent when the plugin is not mounted.
 * @param signal - Task execution lifetime.
 * @param maxBytes - inclusive UTF-8 bound for a complete audit record.
 * @param append - durable ordered notification acknowledgement; rejection fails the call.
 * @returns optional native tools and an async disposer that revokes and joins all admitted calls.
 */
export async function openNativeKnowledge(reader: ReturnType<ProjectTaskKnowledgeTools> | undefined, signal: AbortSignal,
  maxBytes: number, append: (json: string) => Promise<void>): Promise<{ tools?: NativeTaskTools; [Symbol.asyncDispose](): Promise<void> }> {
  if (reader === undefined) return { async [Symbol.asyncDispose]() {} }
  const lifetime = new AbortController()
  const live = AbortSignal.any([signal, lifetime.signal])
  const pending = new Set<Promise<NativeTaskToolResult>>()
  let writes = Promise.resolve()
  const log = (value: object): Promise<void> => {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('Complete native knowledge audit exceeds the configured event allowance')
    writes = writes.then(() => append(json))
    return writes
  }
  live.throwIfAborted()
  await log({ type: 'task-knowledge/definitions', tools: reader.definitions })
  return {
    tools: { definitions: reader.definitions, call(name, args, signal) {
      const call = async (): Promise<NativeTaskToolResult> => {
        const active = AbortSignal.any([live, signal])
        active.throwIfAborted()
        const id = randomUUID()
        await log({ type: 'task-knowledge/call', id, name, arguments: args })
        active.throwIfAborted()
        let result: NativeTaskToolResult
        let read: Awaited<ReturnType<ReturnType<ProjectTaskKnowledgeTools>['read']>> | undefined
        try {
          if (!reader.definitions.some(tool => tool.name === name)) throw new Error('This task permits only its advertised knowledge queries')
          read = await reader.read(name, args, active)
          result = { text: read.text, isError: false }
        } catch (error) {
          active.throwIfAborted()
          result = { text: error instanceof Error ? error.message : 'Knowledge query failed', isError: true }
        }
        active.throwIfAborted()
        const record = { type: 'task-knowledge/result', id, name, result }
        if (Buffer.byteLength(JSON.stringify(record), 'utf8') > maxBytes) {
          record.result = { text: 'Complete native knowledge result exceeds the configured event allowance', isError: true }
        }
        await log(record)
        active.throwIfAborted()
        if (!record.result.isError) await read?.recordAccess()
        active.throwIfAborted()
        return record.result
      }
      const result = call()
      pending.add(result)
      void result.then(() => pending.delete(result), () => pending.delete(result))
      return result
    } },
    async [Symbol.asyncDispose]() {
      lifetime.abort(new Error('Native task knowledge queries are closed'))
      await Promise.allSettled([...pending])
      await writes
    },
  }
}
