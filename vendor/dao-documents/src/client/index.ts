/** Install ephemeral preparation drafts without creating Sessions or opening file pickers. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-document-import-controller/remote'
import type { IDocumentImportDrafts } from './contract.ts'
import { ClientDocumentImportDrafts } from './model.ts'

export type * from './contract.ts'
export type { DocumentImportRemote } from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project-owned document drafts retained only for this Client plugin lifetime. */
    documentImportDrafts: IDocumentImportDrafts
  }
}

/** Only the generated preparation namespace is needed before a conversation exists. */
export const inject = ['remote', 'remote.documentImports']

/**
 * Provide the React-free draft model and await its cancellation when the plugin unloads.
 * @param ctx - Client context carrying the generated preparation namespace.
 */
export function apply(ctx: Context): void {
  const model = new ClientDocumentImportDrafts(ctx.remote.documentImports)
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('documentImportDrafts', model)
    return async () => { await model.dispose(); await unprovide() }
  }, 'document-import-controller: draft lifetime')
}
