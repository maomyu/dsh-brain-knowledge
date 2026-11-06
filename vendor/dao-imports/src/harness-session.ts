/** Adapt the Dao import's fresh, claimed Session to the stock Harness agent registry. */
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

interface ImportSessionRequest {
  sessionId: SessionId
  workspaceId?: WorkspaceId
  spaceId?: ProjectSpaceId
  agentPreset?: string
}

export async function importSession(ctx: Context, directory: string, request: ImportSessionRequest, seed?: readonly SessionEvent[]) {
  const { sessionId, workspaceId, spaceId } = request
  const registry = ctx.workspaceRegistry
  const project = workspaceId === undefined ? undefined : registry.get(workspaceId)
  if (workspaceId !== undefined && (!project || project.archivedAt !== undefined)) throw new Error('Import project is unavailable')
  if (spaceId !== undefined && !registry.spaces.some(space => space.spaceId === spaceId)) throw new Error('Import workspace is unavailable')
  if (!isAbsolute(directory) || !/^session-[a-f0-9-]{36}$/u.test(sessionId)) throw new Error('Invalid import Session location')

  const saved = await ctx.sessionPersistence.stat(sessionId)
  if (seed !== undefined) {
    if (saved || ctx.sessions.get(sessionId) || ctx.agents.get(sessionId)) throw new Error('Import Session already exists')
    const path = project?.path ?? join(directory, sessionId)
    if (!project) await mkdir(path, { recursive: true, mode: 0o700 })
    const cwd = await realpath(path)
    if (project && cwd !== project.path) throw new Error('Import project path changed')
    const presets = ctx.get('agentPresets')
    const preset = presets ? (await presets.resolve(request.agentPreset)).id : undefined
    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    await ctx.agents.create({
      sessionId, seed, meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset }) },
      agentOptions: { provider, model },
      setup: async agentCtx => {
        installModelSelection(agentCtx)
        if (presets && preset !== undefined) await presets.mount(agentCtx, preset)
      },
    })
  } else {
    if (!saved) throw new Error('Claimed import Session is unavailable')
    const restored = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in restored) throw restored.error
  }
  if (project) await project.attachSession(sessionId)
  if (spaceId !== undefined) await registry.attachSpaceSession(spaceId, sessionId)
}
