import { detachedAuditSession } from '../../dao-runtime/audit-session.ts'
/** Private interactive inputs and a fresh MCP server identity; native user server settings remain unchanged. */
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectTaskClaudeSessionId, ProjectTaskTerminalKnowledge, ProjectTaskTerminalSelection } from './types.ts'
import type { ProjectTaskRecord } from './records.ts'

/** Allocate a private child under an explicitly configured local data directory.
 * @param root - absolute deployment-owned root; links and non-directory components are refused.
 * @param signal - preparation lifetime; allocated directories are retained for recovery.
 * @returns canonical owner-only directory, never a user project or process-global temp path.
 */
export async function terminalDirectory(root: string, signal: AbortSignal): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root || root === parse(root).root || root.includes('\0')) {
    throw new Error('Task Terminal directory must be an absolute non-root path')
  }
  let cursor = parse(root).root
  for (const segment of relative(cursor, root).split('/')) {
    cursor = join(cursor, segment)
    signal.throwIfAborted()
    try { await mkdir(cursor, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    const metadata = await lstat(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Task Terminal directory contains a link or non-directory')
  }
  const directory = await mkdtemp(join(root, 'handoff-'))
  if (await realpath(directory) !== directory) throw new Error('Task Terminal directory changed during allocation')
  signal.throwIfAborted()
  return directory
}

/** Write complete private inputs and return the selected interactive CLI invocation.
 * @param directory - private directory allocated for this handoff attempt.
 * @param cwd - retained execution directory, not the knowledge owner project.
 * @param selection - explicit native model and permission choices.
 * @param prompt - complete retained task input.
 * @param knowledge - standalone named-profile command; credentials are not accepted in overrides.
 * @param signal - preparation lifetime.
 * @param nativeSessionId - fresh Claude identity fixed before its input audit is persisted.
 * @returns argv for the OS handoff; does not spawn the CLI or claim it initialized.
 */
export async function terminalInvocation(directory: string, cwd: string, selection: ProjectTaskTerminalSelection,
  prompt: string, knowledge: Awaited<ReturnType<ProjectTaskTerminalKnowledge>>, signal: AbortSignal,
  nativeSessionId?: ProjectTaskClaudeSessionId): Promise<readonly string[]> {
  for (const key of Object.keys(knowledge.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /KEY|SECRET|TOKEN|PASSWORD/i.test(key)) {
      throw new Error('Task knowledge launch environment cannot contain credential overrides')
    }
  }
  signal.throwIfAborted()
  await writeFile(join(directory, 'prompt.txt'), prompt, { flag: 'wx', mode: 0o600 })
  const config = join(directory, 'mcp.json')
  const serverName = `dsh_task_${randomUUID().replaceAll('-', '_')}`
  await writeFile(config, JSON.stringify({ mcpServers: { [serverName]: { type: 'stdio', command: knowledge.command,
    args: knowledge.args, env: knowledge.env } } }), { flag: 'wx', mode: 0o600 })
  signal.throwIfAborted()
  if (selection.runtime === 'claude') {
    if (nativeSessionId === undefined) throw new Error('Claude Terminal handoff requires its retained native session identity')
    const selected = selection.selection
    return ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))}`,
      'claude', '--session-id', nativeSessionId, '--permission-mode', selected.permissionMode,
      ...selected.model === undefined ? [] : ['--model', selected.model],
      ...selected.effort === undefined ? [] : ['--effort', selected.effort],
      '--allowedTools', ['list_pages', 'read_page', 'search_pages', 'list_root_pages', 'read_root_page']
        .map(name => `mcp__${serverName}__${name}`).join(','),
      '--mcp-config', config, '--', prompt]
  }
  const selected = selection.selection
  const environment = Object.entries(knowledge.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')
  const server = `{enabled=true,command=${JSON.stringify(knowledge.command)},args=${JSON.stringify(knowledge.args)},env={${environment}}}`
  return ['/usr/bin/env', `CODEX_HOME=${resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))}`,
    'codex', '--cd', cwd, '--sandbox', selected.sandbox, '--ask-for-approval', 'on-request',
    ...selected.model === undefined ? [] : ['--model', selected.model],
    ...selected.reasoningEffort === undefined ? [] : ['--config', `model_reasoning_effort=${JSON.stringify(selected.reasoningEffort)}`],
    '--config', `mcp_servers.${serverName}=${server}`,
    '--', prompt]
}

/** Persist the complete selected native input before the operating system receives any command.
 * @param ctx - controller-owned Session and persistence services.
 * @param terminal - retained handoff input and independent native audit identity.
 * @param maxBytes - inclusive complete-event byte limit, including Session envelope.
 * @returns after the input is flushed and its writer is closed; no completion is appended.
 */
export async function retainTerminalInput(ctx: Context, terminal: NonNullable<ProjectTaskRecord['terminal']>, maxBytes: number): Promise<void> {
  const session = detachedAuditSession(ctx.sessions, terminal.sessionId, { meta: { cwd: terminal.cwd } })
  let event: SessionEvent
  if (terminal.selection.runtime === 'codex') {
    event = session.append('project-task/codex', { messageId: terminal.messageId, kind: 'input', text: terminal.inputText,
      selection: terminal.selection.selection })
  } else {
    assert(terminal.nativeSessionId !== undefined, 'Claude terminal input requires a retained native identity')
    event = session.append('project-task/claude', { messageId: terminal.messageId, kind: 'input', text: terminal.inputText,
      selection: terminal.selection.selection, nativeSessionId: terminal.nativeSessionId })
  }
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > maxBytes) throw new Error('Task Terminal input exceeds the complete-event byte limit')
  await using handle = await ctx.sessionPersistence.create(session.header)
  await handle.append([{ ...event, ignorable: true }])
  await handle.flush()
}
