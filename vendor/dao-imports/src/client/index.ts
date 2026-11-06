/** Install explicit, resumable knowledge-import submission without React or navigation ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-document-import-controller/client'
import type {} from '@deepseek-ai/dsh-api-knowledge-import-controller/remote'
import type { IKnowledgeImports } from './contract.ts'
import { ClientKnowledgeImports } from './model.ts'

export type * from './contract.ts'
export type { KnowledgeImportRemote } from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Explicit document submission with project-owned progress and durable Host receipts. */
    knowledgeImports: IKnowledgeImports
  }
}

/** Preparation and the generated submission namespace precede this Client model. */
export const inject = ['remote', 'remote.knowledgeImports', 'documentImportDrafts']

/**
 * Provide the Client model and await all its operations before releasing the service.
 * @param ctx - Client context carrying document drafts and the generated namespace.
 */
export function apply(ctx: Context): void {
  const model = new ClientKnowledgeImports(ctx.remote.knowledgeImports, ctx.documentImportDrafts)
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('knowledgeImports', model)
    return async () => { await model.dispose(); await unprovide() }
  }, 'knowledge-import-controller: submission lifetime')
}
