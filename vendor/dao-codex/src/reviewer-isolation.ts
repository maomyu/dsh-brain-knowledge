/** Explicit reviewer policy layered over the effective native configuration without changing its files. */

/** Bounds for reading the native configuration before admitting a reviewer thread. */
export interface CodexReviewerIsolation {
  /** Inclusive UTF-8 limit for the complete native config/read response. */
  readonly maxConfigBytes: number
  /** Maximum configured MCP servers; exceeding it refuses review instead of disabling a partial list. */
  readonly maxMcpServers: number
}

/** Fixed safety overrides applied before app-server startup and again to the reviewer thread. */
export const codexReviewerConfig = {
  'agents.enabled': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.codex_hooks': false,
  'features.hooks': false,
  'features.plugin_hooks': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.in_app_browser': false,
  'features.skill_mcp_dependency_install': false,
  'orchestrator.mcp.enabled': false,
  'orchestrator.skills.enabled': false,
  web_search: 'disabled',
  notify: [],
} as const

/** Disable every effective MCP entry; empty tables alone do not remove merged native entries.
 * @param response - untrusted complete config/read result for the review directory.
 * @param limits - inclusive native response and configured-server bounds.
 * @returns per-thread safety overrides with exact literal server names.
 */
export function reviewerConfig(response: unknown, limits: CodexReviewerIsolation): Record<string, unknown> {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(response) || !object(response.config)) throw new Error('Reviewer requires a complete native configuration')
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > limits.maxConfigBytes) throw new Error('Reviewer native configuration exceeds maxConfigBytes')
  const servers = response.config.mcp_servers
  if (servers !== undefined && !object(servers)) throw new Error('Reviewer MCP configuration must be a server table')
  const names = Object.keys(servers ?? {})
  if (names.length > limits.maxMcpServers) throw new Error('Reviewer MCP configuration exceeds maxMcpServers')
  return { ...codexReviewerConfig, mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: false }])) }
}
