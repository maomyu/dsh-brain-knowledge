/** Native documentation execution writes only its private directory, without ambient executable extensions. */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { resolveNativeTaskToolDefinition, type NativeTaskTools } from '@deepseek-ai/dsh-subagent/native-tools'
import { codexReviewerConfig, reviewerConfig } from './reviewer-isolation.ts'
import { codexTaskWriteConfig } from './task-sandbox.ts'

/** Source protection and bounded inspection of the effective native configuration. */
export interface CodexDocumentationIsolation {
  /** Existing source project; it must not overlap the private execution directory. */
  readonly projectDirectory: string
  /** Inclusive UTF-8 limit for the complete config/read response. */
  readonly maxConfigBytes: number
  /** Maximum configured ambient MCP servers; excess entries refuse execution. */
  readonly maxMcpServers: number
  /** Admit the task-owned complete-file checkpoint writer for this execution. */
  readonly artifactCheckpointWriter?: true
}

/** Fixed startup overrides exclude native extensions before a thread can execute. */
export const codexDocumentationConfig = {
  ...codexReviewerConfig,
  ...codexTaskWriteConfig,
  'sandbox_workspace_write.network_access': false,
} as const

/** Explicit turn policy; Codex adds the thread cwd as its only writable workspace. */
export const codexDocumentationSandbox = {
  type: 'workspaceWrite', writableRoots: [], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true,
} as const

/** Reject overlapping real directories and host tools that can change state before spawning.
 * @param cwd - existing private documentation directory.
 * @param isolation - source directory and configuration limits supplied by the owner.
 * @param tools - task-owned, durably acknowledged read-only reference tools.
 * @returns the canonical private directory used for native policy verification.
 */
export function resolveDocumentationDirectory(cwd: string, isolation: CodexDocumentationIsolation,
  tools: NativeTaskTools | undefined): string {
  const privateDirectory = realpathSync(cwd)
  const source = realpathSync(isolation.projectDirectory)
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }
  if (contains(privateDirectory, source) || contains(source, privateDirectory)) {
    throw new Error('Codex documentation requires a private directory outside the source project')
  }
  if (tools?.definitions.some(tool => !resolveNativeTaskToolDefinition(tool).readOnly
    && (tool.name !== 'write_artifact_file' || isolation.artifactCheckpointWriter !== true))) {
    throw new Error('Codex documentation accepts only read-only host tools and its artifact checkpoint writer')
  }
  return privateDirectory
}

/** Remove every effective native MCP entry while retaining only private workspace writes.
 * @param response - complete untrusted config/read response.
 * @param isolation - inclusive config response and MCP count limits.
 * @returns thread overrides; source configuration files are not modified.
 */
export function documentationConfig(response: unknown, isolation: CodexDocumentationIsolation): Record<string, unknown> {
  return { ...reviewerConfig(response, isolation), ...codexDocumentationConfig }
}

/** Verify the native peer acknowledged only private writes before any task input is submitted.
 * @param response - untrusted thread/start response.
 * @param cwd - canonical private directory.
 */
export function assertDocumentationPolicy(response: Record<string, unknown>, cwd: string): void {
  const sandbox = response.sandbox
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) throw new Error('Codex did not acknowledge documentation sandbox')
  const policy = sandbox as Record<string, unknown>
  if (typeof response.cwd !== 'string' || realpathSync(response.cwd) !== cwd
    || !Array.isArray(response.runtimeWorkspaceRoots)
    || response.runtimeWorkspaceRoots.some(root => typeof root !== 'string' || realpathSync(root) !== cwd)) {
    throw new Error('Codex did not acknowledge the private documentation directory')
  }
  if (response.approvalPolicy !== 'never' || policy.type !== 'workspaceWrite' || policy.networkAccess !== false
    || policy.excludeTmpdirEnvVar !== true || policy.excludeSlashTmp !== true || !Array.isArray(policy.writableRoots)
    || policy.writableRoots.some(root => typeof root !== 'string' || realpathSync(root) !== cwd)) {
    throw new Error('Codex did not acknowledge private documentation write authority')
  }
}
