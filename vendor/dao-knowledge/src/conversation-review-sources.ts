/** Human discussion, logged external web evidence and non-authoritative assistant context. */
import { Buffer } from 'node:buffer'
import { lastAssistantStreamChunk, type Message, type MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { KnowledgeAutomaticMaintenanceRequest } from './types.ts'

type Sources = KnowledgeAutomaticMaintenanceRequest['sources']
type WebEvent = SessionEvent<'tool/result'> | SessionEvent<'tool/ptc-dispatch'>
type SourceEvent = SessionEvent<'user/message'> | SessionEvent<'assistant/message'> | WebEvent
interface DiscussionTurn {
  number: number
  ownHuman: boolean
  workflow: boolean
  maintenance: boolean
  answer?: SessionEvent<'assistant/message'>
  web: WebEvent[]
}

function sourceText(event: SourceEvent, events: readonly SessionEvent[]): string | undefined {
  if (event.type === 'tool/ptc-dispatch') {
    const data = event.data
    if (data.isError || (data.name !== 'web_search' && data.name !== 'web_fetch')) return undefined
    const starts = events.filter(item => item.type === 'tool/ptc-dispatch-start' && item.seq < event.seq
      && item.data.subCallId === data.subCallId)
    const start = starts[0]
    if (starts.length !== 1 || start?.type !== 'tool/ptc-dispatch-start'
      || start.data.rootCallId !== data.rootCallId || start.data.parentCallId !== data.parentCallId
      || start.data.name !== data.name || JSON.stringify(start.data.arguments) !== JSON.stringify(data.arguments)) return undefined
    const text = discussionMessageText({ role: 'tool', content: data.content })
    return text === undefined ? undefined : JSON.stringify({ tool: data.name, arguments: JSON.stringify(data.arguments), content: text })
  }
  if (event.type !== 'tool/result') return discussionMessageText(event.type === 'user/message' ? event.data : event.data.message)
  if (event.data.message.isError) return undefined
  const calls = events.filter((item): item is SessionEvent<'tool/call'> => item.type === 'tool/call'
    && item.data.callId === event.data.message.source.callId && item.seq < event.seq
    && item.data.turn === event.data.turn && item.data.step === event.data.step)
  const call = calls[0]
  if (calls.length !== 1 || call === undefined || (call.data.name !== 'web_fetch' && call.data.name !== 'web_search')) return undefined
  const text = discussionMessageText(event.data.message)
  return text === undefined ? undefined : JSON.stringify({ tool: call.data.name, arguments: call.data.arguments, content: text })
}

/** Human originals are text-only; assistant context may also contain private reasoning that is excluded. */
function discussionMessageText(message: Pick<Message, 'role' | 'content'>): string | undefined {
  const content = message.content
  if (content.some(block => block.type !== 'text' && (message.role !== 'assistant' || block.type !== 'reasoning'))) return undefined
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  return text.trim() === '' ? undefined : text
}

function sourceId(sessionId: Session['id'], event: SourceEvent): string {
  return event.type === 'user/message' ? `session:${sessionId}/message:${event.data.id}`
    : event.type === 'tool/result' ? `session:${sessionId}/web:${event.data.message.source.callId}`
      : event.type === 'tool/ptc-dispatch' ? `session:${sessionId}/web:${event.data.subCallId}`
        : `session:${sessionId}/assistant:${event.data.message.id}`
}

function workflow(kind: string): boolean {
  return kind === 'knowledge-import' || kind === 'goal' || kind === 'tool-goal' || kind === 'brain-maintenance'
    || kind.startsWith('project-task') || kind.startsWith('project-goal')
    || kind.startsWith('plugin:project-task-') || kind.startsWith('plugin:project-goal-')
}

/** Collect admitted discussion without replacing missing originals with summaries or attachment placeholders.
 * @param session - current identity, inherited prefix and visible inherited human evidence.
 * @param events - complete asynchronously read durable log, including pre-compaction originals.
 * @param anchor - actual human evidence message; cancelled replies supply no assistant context and do not erase admitted human text.
 * @param maxBytes - deployed limit for the complete serialized source array; no prefix is returned when exceeded.
 * @returns ordered human, external web and assistant-context sources, or undefined for missing originals,
 * unsupported content, ambiguous identities or oversized discussion.
 */
export function collectConversationReviewSources(session: Pick<Session, 'id' | 'inheritedEventCount' | 'deriveMessages'>,
  events: readonly SessionEvent[], anchor: MessageId, maxBytes: number): Sources | undefined {
  const visible = session.deriveMessages()
  const humans = events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'user')
  const lastHuman = humans.at(-1)
  if (lastHuman === undefined || !humans.some(event => event.data.id === anchor)) return undefined
  const selected: SourceEvent[] = [...humans]
  let incomplete = false
  let turn: DiscussionTurn | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = { number: event.data.turn, ownHuman: false, workflow: false, maintenance: false, web: [] }
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') {
        if (sourceText(event, events) === undefined) incomplete = true
        if (event.seq < session.inheritedEventCount) {
          const inherited = visible.find(message => message.role === 'user' && message.source.kind === 'user'
            && message.id === event.data.id)
          if (inherited === undefined || discussionMessageText(inherited) !== sourceText(event, events)) incomplete = true
        } else if (turn === undefined) incomplete = true
        if (turn !== undefined) {
          if (event.seq >= session.inheritedEventCount) turn.ownHuman = true
          turn.maintenance = false
        }
      } else if (turn !== undefined) {
        if (event.data.source.kind === 'project-brain-curation-check'
          || event.data.source.kind === 'plugin:project-brain-curation-check') turn.maintenance = true
        else if (workflow(event.data.source.kind)) turn.workflow = true
      }
    } else if (event.type === 'assistant/message' && turn !== undefined && !turn.maintenance) {
      turn.answer = event
    } else if ((event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') && turn !== undefined && !turn.maintenance
      && event.seq >= session.inheritedEventCount && sourceText(event, events) !== undefined) {
      turn.web.push(event)
    } else if (event.type === 'turn/end' && turn !== undefined) {
      /* v8 ignore if -- The durable reader validates paired turn IDs; AgentLoop writes both from the same turn variable. */
      if (turn.ownHuman && event.data.turn !== turn.number) incomplete = true
      const answer = turn.answer
      if (event.data.reason.kind === 'completed' && turn.ownHuman && !turn.workflow && answer !== undefined
        && answer.seq >= session.inheritedEventCount && answer.seq < lastHuman.seq) {
        const finish = lastAssistantStreamChunk(answer.data.stream, 'finish')
        if (finish?.reason.kind !== 'stop'
          || sourceText(answer, events) === undefined) incomplete = true
        else selected.push(answer)
      }
      if (event.data.reason.kind === 'completed' && turn.ownHuman && !turn.workflow) selected.push(...turn.web)
      turn = undefined
    }
  }
  if (turn?.ownHuman && !turn.workflow) selected.push(...turn.web)
  if (incomplete) return undefined
  const sources: Array<Sources[number]> = []
  for (const event of selected.sort((left, right) => left.seq - right.seq)) {
    const text = sourceText(event, events)
    /* v8 ignore if -- Each selected human and assistant passed sourceText above; this captured log remains unchanged. */
    if (text === undefined) return undefined
    sources.push({ sourceId: sourceId(session.id, event), text })
  }
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length
    || Buffer.byteLength(JSON.stringify(sources), 'utf8') > maxBytes) return undefined
  return sources
}

/** Revalidate the exact retained sources without collecting later conversation rounds or upgrading old single-source records.
 * @param sessionId - actual source Session identity.
 * @param events - complete asynchronous durable observation.
 * @param sources - previously captured source IDs and complete bytes.
 * @returns whether every frozen human, external web or context result still exists unchanged.
 */
export function frozenConversationSourcesMatch(sessionId: Session['id'], events: readonly SessionEvent[], sources: Sources): boolean {
  return sources.every((source) => {
    const matches = events.filter((event): event is SourceEvent => (event.type === 'user/message' && event.data.source.kind === 'user'
      || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') && sourceId(sessionId, event) === source.sourceId)
    const first = matches[0]
    return matches.length === 1 && first !== undefined && sourceText(first, events) === source.text
  })
}

/** Prevent labelled assistant discussion from becoming factual evidence or write authority.
 * @param sessionId - source Session used by the collector.
 * @param sources - captured human messages and explicitly labelled assistant context.
 * @param dispositions - independently parsed classifications matched to those sources.
 * @returns true only when every assistant-context entry is classified not-relevant.
 */
export function conversationContextDispositionsAllowed(sessionId: Session['id'], sources: Sources,
  dispositions: KnowledgeAutomaticMaintenanceRequest['sourceDispositions']): boolean {
  return sources.every(source => !source.sourceId.startsWith(`session:${sessionId}/assistant:`)
    || dispositions.find(disposition => disposition.sourceId === source.sourceId)?.disposition === 'not-relevant')
}
