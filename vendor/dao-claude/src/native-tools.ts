/** Host tools over the SDK's in-process MCP transport; no listener, credential or subprocess. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { resolveNativeTaskToolDefinition, type NativeTaskTools } from '@deepseek-ai/dsh-subagent/native-tools'

/** Bind one SDK server to the native execution's cancellation owner.
 * @param tools - acknowledged host tools with exact advertised definitions and effect metadata.
 * @param controller - native run cancellation owner; closing this server revokes its callbacks.
 * @param stopChild - terminates and joins the native process before an unacknowledged callback rejection reaches its SDK.
 * @returns SDK config and a disposer joining every admitted handler.
 */
export function nativeToolServer(tools: NativeTaskTools, controller: AbortController, stopChild: () => Promise<void>): {
  config: McpSdkServerConfigWithInstance
  close(): Promise<void>
} {
  const instance = new McpServer({ name: 'brain', version: '1.0.0' }, { capabilities: { tools: {} } })
  const definitions = tools.definitions.map(resolveNativeTaskToolDefinition)
  const pending = new Set<Promise<unknown>>()
  instance.server.setRequestHandler(ListToolsRequestSchema, () => {
    controller.signal.throwIfAborted()
    return { tools: definitions.map(({ readOnly, ...tool }) => ({ ...tool,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
      _meta: { 'anthropic/alwaysLoad': true } })) }
  })
  instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const run = async () => {
      const signal = AbortSignal.any([controller.signal, extra.signal])
      signal.throwIfAborted()
      const result = await tools.call(request.params.name, request.params.arguments ?? {}, signal)
      signal.throwIfAborted()
      return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError }
    }
    const result = run().catch(async (error: unknown) => {
      controller.abort(error)
      try { await stopChild() }
      catch (stopError: unknown) { throw new AggregateError([error, stopError], 'Native tool failure and Claude termination failure') }
      throw error
    })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  })
  return { config: { type: 'sdk', name: 'brain', instance }, async close() {
    controller.abort(new Error('Native tool server closed'))
    try { await instance.close() }
    finally { await Promise.allSettled([...pending]) }
  } }
}
