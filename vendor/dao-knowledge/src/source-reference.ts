/** Resolve retained knowledge attribution without publishing or resuming its Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { parseKnowledgeDocument } from './documents.ts'
import { knowledgeSource } from './source.ts'
import { readTruthRecords } from './truth-records.ts'
import { readProposalRecords } from './proposal-records.ts'
import type { KnowledgeDocumentId, KnowledgeSourceResolution } from './types.ts'

/** Collect only retained attribution fields; neither evidence text nor unapproved prose grants navigation.
 * @param id - current validated Brain path.
 * @param text - complete bounded file read.
 * @param version - observed page version.
 * @returns exact supported and unsupported source literals, plus explicit Timeline Session fallback links.
 */
export function knowledgeSourceReferences(id: KnowledgeDocumentId, text: string, version: string): ReadonlySet<string> {
  const document = parseKnowledgeDocument(id, text, version)
  const source = knowledgeSource(text, document.entry.kind === 'page')
  const references = new Set<string>()
  for (const row of document.timeline) {
    if (row.source !== null) references.add(row.source)
    if (row.sourceSessionId !== undefined) references.add(`session:${row.sourceSessionId}`)
  }
  for (const row of [...readTruthRecords(id, source), ...readProposalRecords(id, source)]) references.add(row.source)
  return references
}

/** Locate an exact saved or live message within current logical-workspace membership.
 * @param ctx - registered workspace and optional read-only Session query service, required for a retained Session target.
 * @param workspaceId - project whose Brain supplied the source.
 * @param source - exact retained source literal; only explicit Session/message links are interpreted.
 * @param references - attribution fields from the current complete document.
 * @param signal - cancels the single-Session observation without activating an Agent.
 * @param current - rechecks the complete page and Brain location after the Session read.
 * @returns an inspection address or an explicit reason navigation is unavailable.
 */
export async function resolveKnowledgeSource(ctx: Context, workspaceId: WorkspaceId, source: string,
  references: ReadonlySet<string>, signal: AbortSignal, current: () => Promise<boolean>): Promise<KnowledgeSourceResolution> {
  signal.throwIfAborted()
  const parsed = /^session:([^\s/:\\]+)(?:\/message:([^\s/:\\]+))?$/.exec(source)
  if (/[\x00-\x1f\x7f]/.test(source)) return { status: 'unavailable', reason: 'unsupported-source' }
  if (parsed === null) return { status: 'unavailable', reason: 'unsupported-source' }
  if (!references.has(source)) return { status: 'unavailable', reason: 'source-changed' }
  const sessionId = parsed[1] as SessionId
  const messageId = parsed[2] as MessageId | undefined
  const membership = () => {
    const spaces = ctx.workspaceRegistry.spaces
    const space = spaces.find(item => item.projectIds.includes(workspaceId))
    const project = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(sessionId))
    const sessionSpace = project === undefined
      ? spaces.find(item => item.looseSessionIds?.includes(sessionId))
      : spaces.find(item => item.projectIds.includes(project.id))
    return { space, sessionSpace, project }
  }
  const selected = membership()
  if (selected.sessionSpace === undefined) return { status: 'unavailable', reason: 'session-unavailable' }
  if (selected.space === undefined || selected.sessionSpace.spaceId !== selected.space.spaceId) {
    return { status: 'unavailable', reason: 'outside-workspace' }
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('Knowledge source navigation requires the sessionQuery service.')
  try {
    using observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
    if (!await current()) return { status: 'unavailable', reason: 'source-changed' }
    signal.throwIfAborted()
    const retained = membership()
    if (retained.space?.spaceId !== selected.space.spaceId || retained.sessionSpace?.spaceId !== selected.space.spaceId
      || retained.project?.id !== selected.project?.id) return { status: 'unavailable', reason: 'outside-workspace' }
    if (observation.header.cwd === undefined || observation.header.origin === 'subagent') {
      return { status: 'unavailable', reason: 'unsupported-session' }
    }
    const message = messageId === undefined ? undefined : observation.events.find(event => isAppendSurfaceEvent(event)
      && (event.type === 'user/message' ? event.data.id === messageId
        : event.type === 'assistant/message' && event.data.message.content.length > 0 && event.data.message.id === messageId))
    if (messageId !== undefined && message === undefined) return { status: 'unavailable', reason: 'message-missing' }
    return { status: 'available', sessionId, workspaceId: retained.project?.id ?? null, spaceId: selected.space.spaceId,
      archived: ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
      ...messageId === undefined || message === undefined ? {} : { message: { id: messageId, seq: message.seq } } }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return { status: 'unavailable', reason: 'session-unavailable' }
    }
    throw error
  }
}
