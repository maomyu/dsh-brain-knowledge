/** Client installation of the Session-independent knowledge read model. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller/remote'
import { ClientKnowledgeModel, type IKnowledgeDocuments } from './model.ts'
import { ClientKnowledgePreviews, type IKnowledgePreviews } from './previews.ts'
import { ClientKnowledgeCollection, ClientProjectCollection, type IKnowledgeProjects, type IKnowledgeHealthProjects } from './collection.ts'
import { ClientKnowledgeHealth, type IKnowledgeHealth } from './health.ts'
import { ClientKnowledgeLocations, type IKnowledgeLocations } from './location.ts'
import { ClientKnowledgeSources, type IKnowledgeSources } from './sources.ts'
import type { KnowledgeHealthClientId } from '../types.ts'

/** Registration stream whose generation owns all automatic-health context notifications. */
export type KnowledgeHealthClientStream = Pick<RemoteStream<KnowledgeHealthClientId>, 'dispose' | 'signal' | typeof Symbol.asyncIterator>

export type { IKnowledgeDocuments, KnowledgeFollowFactory, KnowledgeReadStatus, KnowledgeRemote, KnowledgeSnapshot } from './model.ts'
export type * from '../types.ts'
export type { IKnowledgeProjects, IKnowledgeHealthProjects } from './collection.ts'
export type { IKnowledgePreviews, KnowledgePreviewTarget } from './previews.ts'
export type { IKnowledgeHealth, KnowledgeHealthSnapshot, KnowledgeHealthHistorySnapshot, KnowledgeHealthHistoryTarget } from './health.ts'
export type { IKnowledgeLocations, KnowledgeLocationSnapshot } from './location.ts'
export type { IKnowledgeSources, KnowledgeSourceSnapshot } from './sources.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free knowledge documents for the selected project. */
    knowledgeDocuments: IKnowledgeDocuments
    /** Independently followed indexes for the visible logical workspace's projects. */
    knowledgeProjects: IKnowledgeProjects
    /** Independent project-qualified documents currently visible in chat previews. */
    knowledgePreviews: IKnowledgePreviews
    /** Reports and disposition writes for the visible project's Brain. */
    knowledgeHealth: IKnowledgeHealth
    /** Independent read-only report listings for workspace health aggregation. */
    knowledgeHealthProjects: IKnowledgeHealthProjects
    /** Allocate independent directory metadata; the consuming view must dispose its client. */
    knowledgeLocationClients: () => IKnowledgeLocations
    /** Local source-folder references for the selected project. */
    knowledgeSources: IKnowledgeSources
    /** Open one reconnecting automatic-health registration owned by the consuming Client plugin. */
    knowledgeHealthClients: () => KnowledgeHealthClientStream
  }
}

/** The Client model uses only its generated namespace. */
export const inject = ['remote', 'remote.knowledge']

/**
 * Install the project read model and await its cancellation on unload.
 * @param ctx - Client root carrying the generated namespace.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.reflect.provide('knowledgeHealthClients', () => ctx.remote.$stream({
    name: 'Brain Health Client registration',
    open: signal => ctx.remote.knowledge.registerHealthClient(signal),
    ended: () => new RemoteStreamCarrierError('Brain Health Client registration ended without cancellation'),
  })), 'knowledge-controller: health Client factory')
  const create = (): ClientKnowledgeModel => new ClientKnowledgeModel(ctx.remote.knowledge, workspaceId => ctx.remote.$stream({
    name: 'Knowledge index stream',
    open: signal => ctx.remote.knowledge.follow(workspaceId, signal),
    ended: () => new RemoteStreamCarrierError('Knowledge index stream ended without cancellation'),
  }))
  const model = create()
  const projects = new ClientKnowledgeCollection(create)
  const previews = new ClientKnowledgePreviews(create)
  const releasePreviews = ctx.reflect.provide('knowledgePreviews', previews)
  const createHealth = (): ClientKnowledgeHealth => new ClientKnowledgeHealth(ctx.remote.knowledge, workspaceId => ctx.remote.$stream({
    name: 'Knowledge health reports stream',
    open: signal => ctx.remote.knowledge.followHealthReports(workspaceId, signal),
    ended: () => new RemoteStreamCarrierError('Knowledge health reports stream ended without cancellation'),
  }))
  const health = createHealth()
  const healthProjects = new ClientProjectCollection(createHealth)
  const locations = new Set<ClientKnowledgeLocations>()
  const releaseLocations = ctx.reflect.provide('knowledgeLocationClients', () => {
    const client = new ClientKnowledgeLocations(ctx.remote.knowledge)
    locations.add(client)
    const dispose = client.dispose.bind(client)
    client.dispose = async () => { await dispose(); locations.delete(client) }
    const select = client.select.bind(client)
    client.select = async (...args) => {
      const result = await select(...args)
      if (result.ok) {
        for (const other of locations) {
          if (other !== client && other.state.getSnapshot().workspaceId === args[0]) void other.load(args[0])
        }
      }
      return result
    }
    return client
  })
  const sources = new ClientKnowledgeSources(ctx.remote.knowledge)
  const releaseSources = ctx.reflect.provide('knowledgeSources', sources)
  const unprovide = ctx.reflect.provide('knowledgeDocuments', model)
  const releaseProjects = ctx.reflect.provide('knowledgeProjects', projects)
  const releaseHealth = ctx.reflect.provide('knowledgeHealth', health)
  const releaseHealthProjects = ctx.reflect.provide('knowledgeHealthProjects', healthProjects)
  ctx.effect(() => async () => {
    await Promise.all([
      model.dispose(), projects.dispose(), previews.dispose(), health.dispose(), healthProjects.dispose(), sources.dispose(),
      ...[...locations].map(client => client.dispose()),
    ])
    await releaseSources()
    await releaseLocations()
    await unprovide()
    await releaseProjects()
    await releasePreviews()
    await releaseHealth()
    await releaseHealthProjects()
  }, 'knowledge-controller: read lifetime')
}
