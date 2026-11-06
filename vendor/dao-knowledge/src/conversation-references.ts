/** Bounded whole-log knowledge references; presentation never restores or executes an Agent. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { KnowledgeConversationReference, KnowledgeDocumentId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { projectKnowledgeLinks } from './links.ts'
import { hasCompleteBrainRead, parseBrainReadChunk } from './model-read.ts'

const path = z.string().regex(/^(?:(?:background|architecture|flow|mindmap|stack|roadmap)\.md|pages\/(?!.*(?:^|\/)\.\.?\/)[^\\:\0]+\.md)$/)
  .refine(value => value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
  .transform(value => value as KnowledgeDocumentId)
const project = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), value: z.string().min(1).transform(value => value as WorkspaceId) }),
  z.object({ kind: z.literal('path'), value: z.string().min(1) }),
  z.object({ kind: z.literal('selector'), value: z.string().min(1) }),
  z.object({ kind: z.literal('unqualified') }),
])
const reference = z.object({
  project, resource: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('document'), path }),
    z.object({ kind: z.literal('slug'), slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }),
  ]), source: z.enum(['user', 'assistant', 'read-request', 'read']), callId: z.string().transform(value => value as ToolCallId).nullable(),
})
const readRequest = z.object({ path, target_project_id: z.string().min(1).optional() })
const readResult = z.object({ path, project: z.string().min(1), project_id: z.string().min(1).optional(),
  version: z.string(), markdown: z.string(), timeline: z.array(z.unknown()) })
const userReferences = z.array(z.object({ kind: z.enum(['page', 'root', 'task']), target_project_id: z.string().min(1),
  path: path.optional(), intent: z.enum(['both', 'read']) }))

interface ReferenceState { readonly limit: number; readonly entries: readonly KnowledgeConversationReference[] }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Metadata only, rebuilt from committed conversation events after cache loss. */
    knowledgeReferences: ReferenceState
  }
}

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return null } // Malformed model/user text is not reference metadata.
}

function identity(value: KnowledgeConversationReference): string {
  return JSON.stringify([value.project, value.resource])
}

function retain(state: ReferenceState, entry: KnowledgeConversationReference): ReferenceState {
  return { ...state, entries: [entry, ...state.entries.filter(previous => identity(previous) !== identity(entry))].slice(0, state.limit) }
}

/** Registerable incremental projection with cache invalidation when its retention setting or read semantics change.
 * @param limit - maximum retained distinct reference identities, newest first.
 * @returns pure fold and metadata-only Client view; incomplete result fragments remain read requests.
 */
export function knowledgeReferencesProjection(limit: number): Required<ProjectionDefinition<'knowledgeReferences'>> {
  const entries: z.ZodType<readonly KnowledgeConversationReference[]> = z.array(reference).max(limit)
  const stateSchema: z.ZodType<ReferenceState> = z.object({ limit: z.literal(limit), entries })
  return {
    key: 'knowledgeReferences', stateVersion: 2,
    stateSchema,
    init: () => ({ limit, entries: [] }),
    apply(state, event) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        let next = state
        for (const block of event.data.content) {
          if (block.type !== 'text') continue
          const match = /^<knowledge-references>\n([^\n]+)\n<\/knowledge-references>\n/.exec(block.text)
          if (!match?.[1]) continue
          const parsed = userReferences.safeParse(json(match[1]))
          if (!parsed.success) continue
          for (const item of parsed.data) if (item.kind !== 'task' && item.path !== undefined && item.intent === 'both') {
            next = retain(next, { project: { kind: 'id', value: item.target_project_id as WorkspaceId },
              resource: { kind: 'document', path: item.path }, source: 'user', callId: null })
          }
        }
        return next
      }
      if (event.type === 'assistant/message') {
        let next = state
        for (const block of event.data.message.content) if (block.type === 'text') {
          for (const slug of projectKnowledgeLinks(block.text).references) if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
            next = retain(next, { project: { kind: 'unqualified' }, resource: { kind: 'slug', slug }, source: 'assistant', callId: null })
          }
        }
        return next
      }
      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
        if (event.data.name !== 'brain_read') return state
        const parsed = readRequest.safeParse(event.type === 'tool/call' ? json(event.data.arguments) : event.data.arguments)
        if (!parsed.success) return state
        return retain(state, { project: parsed.data.target_project_id === undefined ? { kind: 'unqualified' }
          : { kind: 'selector', value: parsed.data.target_project_id }, resource: { kind: 'document', path: parsed.data.path },
        source: 'read-request', callId: event.type === 'tool/call' ? event.data.callId : event.data.subCallId })
      }
      if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
        const callId = String(event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId)
        const existing = state.entries.find(entry => entry.callId === callId)
        if (existing === undefined) return state
        const result = event.type === 'tool/result' ? event.data.message : event.data
        if (result.isError) return state
        for (const block of result.content) if (block.type === 'text') {
          const value = json(block.text)
          const chunk = parseBrainReadChunk(value)
          if (chunk === undefined && typeof value === 'object' && value !== null
            && ('partial' in value || 'format' in value || 'fragment' in value || 'next_cursor' in value)) continue
          if (chunk !== undefined && !hasCompleteBrainRead([chunk])) continue
          const parsed = readResult.safeParse(chunk === undefined ? value : json(chunk.fragment))
          if (!parsed.success) continue
          const entry: KnowledgeConversationReference = { ...existing, source: 'read', resource: { kind: 'document', path: parsed.data.path },
            project: parsed.data.project_id === undefined ? { kind: 'path', value: parsed.data.project }
              : { kind: 'id', value: parsed.data.project_id as WorkspaceId } }
          return { ...state, entries: state.entries.flatMap(previous => previous === existing ? [entry]
            : identity(previous) === identity(entry) ? [] : [previous]) }
        }
      }
      // Other event families, failed attempts and live token chunks do not add references.
      return state
    },
    wire: { viewSchema: entries, view: state => state.entries },
  } satisfies ProjectionDefinition<'knowledgeReferences'>
}
