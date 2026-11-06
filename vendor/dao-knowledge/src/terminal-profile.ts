/** Prepare an app-independent dsh profile for an explicitly accepted terminal task. */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProjectTaskTerminalKnowledge } from '@deepseek-ai/dsh-api-task-controller/types'
import type {} from '@deepseek-ai/dsh-api-task-controller'
import type {} from './index.ts'
import { TerminalKnowledgePolicy } from './terminal-policy.ts'
import { openTerminalKnowledgeGrant, publishTerminalKnowledgeGrant, type TerminalKnowledgeGrant } from './terminal-grant.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Registers task terminal knowledge preparation; it starts no process itself. */
export const name = 'task-terminal-knowledge-profile'
/** Task acceptance and current knowledge selection own all admission. */
export const inject = ['taskController', 'knowledgeController', 'workspaceRegistry']

/** Installed dsh entry and complete terminal policy; no ambient executable lookup. */
export interface Config {
  executable: string
  cliEntry: string
  /** Non-credential launcher variables, defaulting to none; home and telemetry settings remain profile-owned. */
  launchEnvironment: Record<string, string>
  policy: TerminalKnowledgePolicy
}

/** Deployment supplies its actual packaged runtime paths and read limits. */
export const Config: z<Config> = z.object({
  executable: z.string().min(1).required(), cliEntry: z.string().min(1).required(),
  launchEnvironment: z.dict(z.string()).default({}),
  policy: TerminalKnowledgePolicy.required(),
})

/** Mount scoped preparation and drain in-flight private-file creation on unload.
 * @param ctx - task and knowledge selection owners.
 * @param config - explicit installed launcher paths and complete query limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const key of Object.keys(config.launchEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /KEY|SECRET|TOKEN|PASSWORD/i.test(key)
      || key === 'DSH_HOME' || key === 'DSH_TELEMETRY_DISABLED') {
      throw new Error('Terminal knowledge launcher environment must contain only non-credential variables and cannot override profile settings')
    }
  }
  for (const path of [config.executable, config.cliEntry]) {
    if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('Terminal knowledge launcher paths must be normalized and absolute')
  }
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const grants = new Set<TerminalKnowledgeGrant>()
  const privateDirectory = (directory: string): boolean => {
    try {
      const info = lstatSync(directory)
      return isAbsolute(directory) && resolve(directory) === directory && realpathSync(directory) === directory
        && info.isDirectory() && !info.isSymbolicLink()
        && (process.platform === 'win32' || (info.mode & 0o077) === 0)
    } catch { return false }
  }
  const current = (taskId: Parameters<ProjectTaskTerminalKnowledge>[0], project: Parameters<ProjectTaskTerminalKnowledge>[1],
    directory: string, brainPath: string, locationRevision: string | null, restored: boolean): boolean => {
    if (lifetime.signal.aborted || !privateDirectory(directory)
      || !ctx.taskController.ownsTerminalKnowledge(taskId, project, directory)) return false
    if (restored && !ctx.taskController.terminalKnowledgeHandoffs().some(handoff => handoff.taskId === taskId
      && handoff.project.id === project.id && handoff.project.path === project.path && handoff.directory === directory)) return false
    const selected = ctx.knowledgeController.location(project.id)
    return selected.path === brainPath && selected.revision === locationRevision
  }
  const privateFile = async (path: string): Promise<boolean> => {
    try {
      const info = await lstat(path)
      return info.isFile() && !info.isSymbolicLink() && (process.platform === 'win32' || (info.mode & 0o077) === 0)
    } catch { return false }
  }
  const restore = async (): Promise<void> => {
    for (const handoff of ctx.taskController.terminalKnowledgeHandoffs()) {
      if (lifetime.signal.aborted) return
      const { taskId, project, directory } = handoff
      const home = join(directory, 'knowledge')
      const patch = join(home, 'profiles', 'task-knowledge', 'cordis.patch.yml')
      try {
        if (!privateDirectory(directory) || !privateDirectory(home)
          || !privateDirectory(join(home, 'profiles')) || !privateDirectory(join(home, 'profiles', 'task-knowledge'))
          || !(await privateFile(patch))) throw new Error('retained private profile is unavailable')
        const info = await lstat(patch)
        if (info.size > config.policy.maxEventBytes) throw new Error('retained private profile exceeds the configured event limit')
        const parsed: unknown = JSON.parse(await readFile(patch, 'utf8'))
        const row: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined
        const entries: unknown = isRecord(row) ? row.insert : undefined
        const knowledge: unknown = Array.isArray(entries) ? (entries as unknown[]).find(entry => isRecord(entry)
          && entry.name === '@deepseek-ai/dsh-api-knowledge-controller/terminal') : undefined
        const retained: unknown = isRecord(knowledge) ? knowledge.config : undefined
        if (!isRecord(retained)
          || retained.taskId !== taskId || retained.projectId !== project.id || retained.projectPath !== project.path
          || typeof retained.brainPath !== 'string'
          || (retained.locationRevision !== null && typeof retained.locationRevision !== 'string')
          || typeof retained.grantEndpoint !== 'string' || retained.grantEndpoint !== join(home, 'grant.json')) {
          throw new Error('retained terminal knowledge identity does not match the Task')
        }
        const brainPath = retained.brainPath
        const locationRevision = retained.locationRevision
        const endpoint = retained.grantEndpoint
        if (!current(taskId, project, directory, brainPath, locationRevision, true)) continue
        const grant = await openTerminalKnowledgeGrant(() => current(taskId, project, directory,
          brainPath, locationRevision, true))
        try {
          await publishTerminalKnowledgeGrant(endpoint, grant.path)
          grants.add(grant)
        } catch (error) { await grant.close(); throw error }
      } catch (error) { ctx.logger.warn('Retained terminal knowledge grant could not be restored', error) }
    }
  }
  const prepare: ProjectTaskTerminalKnowledge = async (taskId, project, directory, inputText, signal) => {
    const live = AbortSignal.any([signal, lifetime.signal])
    live.throwIfAborted()
    const location = ctx.knowledgeController.location(project.id)
    const assertCurrent = (): void => {
      if (ctx.workspaceRegistry.get(project.id)?.path !== project.path) throw new Error('Terminal task project changed before handoff')
      const selected = ctx.knowledgeController.location(project.id)
      if (selected.path !== location.path || selected.revision !== location.revision) throw new Error('Terminal task Brain changed before handoff')
    }
    const validate = (signal: AbortSignal): void => {
      signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
      assertCurrent()
    }
    const work = async () => {
      validate(live)
      if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Terminal task directory must be normalized and absolute')
      if (!privateDirectory(directory)) {
        throw new Error('Terminal task profile requires a private caller-owned directory')
      }
      for (const path of [config.executable, config.cliEntry]) {
        if (!(await lstat(path)).isFile()) throw new Error('Terminal knowledge launcher file is missing or linked')
      }
      const home = join(directory, 'knowledge')
      const profile = join(home, 'profiles', 'task-knowledge')
      await mkdir(home, { mode: 0o700 })
      await mkdir(profile, { mode: 0o700, recursive: true })
      const grant = await openTerminalKnowledgeGrant(() => current(taskId, project, directory,
        location.path, location.revision, false))
      try {
        const manifest = { name: 'dsh-profile-task-knowledge', private: true, dependencies: {
          '@deepseek-ai/dsh-fs-local': '*', '@deepseek-ai/dsh-session': '*',
          '@deepseek-ai/dsh-session-persistence-jsonl': '*', '@deepseek-ai/dsh-api-knowledge-controller': '*',
        }, dsh: { profile: { bundles: [], patchReload: 'startup' } } }
        const entries = [
          { id: 'fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: project.path } },
          { id: 'sessions', name: '@deepseek-ai/dsh-session' },
          { id: 'persistence', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(home, 'journal'), compression: 'none' } },
          { id: 'knowledge', name: '@deepseek-ai/dsh-api-knowledge-controller/terminal', config: {
            maxDocumentBytes: config.policy.maxDocumentBytes, maxIndexBytes: config.policy.maxIndexBytes,
            maxEntries: config.policy.maxEntries, maxDepth: config.policy.maxDepth, maxReadBytes: config.policy.maxReadBytes,
            maxSearchResults: config.policy.maxSearchResults, maxSearchMatches: config.policy.maxSearchMatches,
            maxEventBytes: config.policy.maxEventBytes, queryTimeoutMs: config.policy.queryTimeoutMs,
            taskId, initialInput: inputText, projectId: project.id, projectPath: project.path,
            brainPath: location.path, locationRevision: location.revision, grantEndpoint: join(home, 'grant.json'),
          } },
        ]
        await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx', signal: live })
        await writeFile(join(profile, 'cordis.patch.yml'), `${JSON.stringify([{ insert: entries }])}\n`, { mode: 0o600, flag: 'wx', signal: live })
        validate(live)
        await publishTerminalKnowledgeGrant(join(home, 'grant.json'), grant.path)
        grants.add(grant)
        return { command: config.executable, args: [config.cliEntry, '--profile', 'task-knowledge'],
          env: { ...config.launchEnvironment, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, validate,
          release: async () => { await grant.close(); grants.delete(grant) } }
      } catch (error) {
        await grant.close()
        throw error
      }
    }
    const result = work()
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  }
  ctx.effect(() => ctx.taskController.registerTerminalKnowledge(prepare), 'terminal knowledge: preparation')
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Terminal knowledge preparation disposed'))
    await Promise.allSettled([...pending])
    await Promise.allSettled([...grants].map(grant => grant.close()))
  }, 'terminal knowledge: preparation drain')
  await restore()
}
