/** Install the project artifact catalog over the generated Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-artifact-controller/remote'
import { ClientArtifactCatalog, type IArtifactCatalog } from './model.ts'
import { ClientArtifactFiles, type IArtifactFiles } from './files.ts'
import { ArtifactReadFailure, ClientArtifactActions, type IArtifactActions } from './actions.ts'
import { ClientArtifactCollection, type IArtifactProjects } from './collection.ts'

export type { IArtifactCatalog, ArtifactSnapshot } from './model.ts'
export type { IArtifactFiles, ArtifactFileSnapshot } from './files.ts'
export { ArtifactReadFailure } from './actions.ts'
export type { IArtifactActions, ArtifactReadFailureReason } from './actions.ts'
export type { IArtifactProjects } from './collection.ts'
export type * from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Current project artifact metadata, independent of the selected Session. */
    artifactCatalog: IArtifactCatalog
    /** Independently followed project catalogs for the logical workspace gallery. */
    artifactProjects: IArtifactProjects
    /** One cancellable artifact file read, separate from gallery navigation. */
    artifactFiles: IArtifactFiles
    /** Independent rendition reads and explicitly requested native handoffs. */
    artifactActions: IArtifactActions
  }
}

/** The catalog reads only its generated namespace. */
export const inject = ['remote', 'remote.artifacts']

/**
 * Install the project catalog and await stream teardown before releasing the service.
 * @param ctx - Client root carrying the generated artifact Remote namespace.
 */
export function apply(ctx: Context): void {
  const read: IArtifactActions['read'] = async (workspaceId, id, signal) => {
    const result = await ctx.remote.artifacts.read(workspaceId, id, signal)
    if (!result.ok) {
      if (result.error.code === 'artifact/file') throw new ArtifactReadFailure(result.error.details.reason, result.error.message)
      throw new Error(result.error.message)
    }
    return result.value
  }
  const actions = new ClientArtifactActions({
    read,
    inspect: async (workspaceId, id, signal) => {
      const result = await ctx.remote.artifacts.fileActions(workspaceId, id, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    run: async (workspaceId, id, action, signal) => {
      const result = await ctx.remote.artifacts.nativeAction(workspaceId, id, action, signal)
      if (!result.ok) throw new Error(result.error.message)
    },
    site: async (workspaceId, id, action, signal) => {
      const result = await ctx.remote.artifacts.siteAction(workspaceId, id, action, signal)
      if (!result.ok) throw new Error(result.error.message)
    },
  })
  const releaseActions = ctx.reflect.provide('artifactActions', actions)
  ctx.effect(() => async () => {
    try { await actions.dispose() } finally { await releaseActions() }
  }, 'artifact-controller: independent file request lifetime')
  const files = new ClientArtifactFiles(read)
  const releaseFiles = ctx.reflect.provide('artifactFiles', files)
  ctx.effect(() => async () => {
    try { await files.dispose() } finally { await releaseFiles() }
  }, 'artifact-controller: file lifetime')
  const createCatalog = (): ClientArtifactCatalog => new ClientArtifactCatalog(workspaceId => ctx.remote.$stream({
    name: 'Artifact catalog stream',
    open: signal => ctx.remote.artifacts.follow(workspaceId, signal),
    ended: () => new RemoteStreamCarrierError('Artifact catalog stream ended without cancellation'),
  }))
  const projects = new ClientArtifactCollection(createCatalog)
  const releaseProjects = ctx.reflect.provide('artifactProjects', projects)
  ctx.effect(() => async () => {
    try { await projects.dispose() } finally { await releaseProjects() }
  }, 'artifact-controller: workspace catalog lifetimes')
  const model = createCatalog()
  const unprovide = ctx.reflect.provide('artifactCatalog', model)
  ctx.effect(() => async () => {
    try { await model.dispose() } finally { await unprovide() }
  }, 'artifact-controller: catalog lifetime')
}
