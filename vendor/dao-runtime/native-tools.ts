/** Host-owned tools supplied to one native execution, without ambient server configuration. */

/** Complete model-facing definition; the owner retains it before starting native inference. */
export interface NativeTaskToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>> & { readonly type: 'object' }
  /** Whether execution only reads reference data; omission resolves to true.
   * False may start work or change state, and grants no authority by itself.
   */
  readonly readOnly?: boolean
}

/** Resolve omitted effect metadata before exposing a definition to a native transport.
 * @param definition - complete owner-supplied definition.
 * @returns explicit read-only metadata; execution authorization remains with the owner.
 */
export function resolveNativeTaskToolDefinition(definition: NativeTaskToolDefinition):
  NativeTaskToolDefinition & { readonly readOnly: boolean } {
  return { ...definition, readOnly: definition.readOnly ?? true }
}

/** Acknowledged model-visible result; errors never grant permission or certify that side effects did not occur. */
export interface NativeTaskToolResult {
  readonly text: string
  readonly isError: boolean
}

/** Execution-owned tools. Callbacks validate untrusted arguments, enforce authority and bounds, and acknowledge durable output. */
export interface NativeTaskTools {
  readonly definitions: readonly NativeTaskToolDefinition[]
  /** Execute one advertised tool; cancellation or failed audit persistence rejects instead of releasing unlogged output.
   * @param name - native model's tool name, which must be in definitions.
   * @param args - untrusted model JSON, validated by the query owner.
   * @param signal - native call cancellation, combined with the execution lifetime by the owner.
   * @returns complete, durably acknowledged text and explicit error status.
   */
  call(name: string, args: unknown, signal: AbortSignal): Promise<NativeTaskToolResult>
}
