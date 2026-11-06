/** Retained tool output establishes which page content informed a conversation-owned write. */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PtcDispatchStartEventData } from '@deepseek-ai/dsh-tools/types'
import { z } from 'zod'
import type { KnowledgeLocation } from './types.ts'
import { hasCompleteBrainRead, parseBrainReadChunk, type BrainReadChunk } from './model-read.ts'

const readIdentity = z.object({ project: z.string(), path: z.string(), version: z.string() })
const locationIdentity = z.object({ project: z.string(), locationRevision: z.string() })

/** Refuse writes informed only by a prior Brain selection; explicit workspace reads also establish the current location.
 * @param session - retained executing conversation, absent when no Agent owns it.
 * @param location - currently selected Brain; untouched default projects retain their existing read requirements.
 * @throws unless a logged index or successful retained native or PTC Brain lookup identifies this project and selected revision.
 */
export function requireCurrentBrainContext(session: Session | undefined, location: KnowledgeLocation): void {
  if (location.revision === null) return
  const message = session?.deriveMessages().findLast(message => message.role === 'user'
    && (message.source.kind === 'project-brain' || message.source.kind === 'plugin:project-brain'))
  const block = message?.content[0]
  if (block?.type === 'text') {
    let data: unknown
    try { data = JSON.parse(block.text.slice(block.text.indexOf('\n') + 1)) } catch {
      // Only the renderer's complete JSON snapshot can establish a current Brain selection.
      data = undefined
    }
    const parsed = locationIdentity.safeParse(data)
    if (parsed.success && parsed.data.project === location.projectPath && parsed.data.locationRevision === location.revision) return
  }
  if (session !== undefined) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const result of successfulBrainLookups(session.snapshotEvents())) {
      for (const block of result.content) {
        if (block.type !== 'text') continue
        let data: unknown
        try { data = JSON.parse(block.text) } catch {
          // Non-JSON lookup output cannot establish the selected Brain location.
          continue
        }
        if (result.name === 'brain_read') {
          const read = readIdentity.safeParse(data)
          if (read.success && read.data.project === location.projectPath && read.data.version.startsWith(`${location.revision}:`)) return
        } else {
          const search = locationIdentity.safeParse(data)
          if (search.success && search.data.project === location.projectPath && search.data.locationRevision === location.revision) return
        }
      }
    }
  }
  throw new Error('Brain location changed; refresh the logged project context before writing')
}

/** Derive a source reference from one visible user-authored message; matching text does not prove a conclusion's truth.
 * @param session - executing conversation and its currently visible messages.
 * @param quote - exact supporting user text, not an assistant or tool claim.
 * @returns the actual Session and message reference to retain with a write.
 * @throws for empty, missing or ambiguous user evidence.
 */
export function requireUserEvidenceSource(session: Session, quote: string): string {
  if (quote.trim().length === 0) throw new Error('Brain updates require a nonempty user evidence quote')
  const sources = session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'user'
    && message.content.some(block => block.type === 'text' && block.text.includes(quote)))
  if (sources.length !== 1) throw new Error('Evidence must identify exactly one visible user message; use a longer exact quote')
  const source = sources[0] as (typeof sources)[number]
  return `session:${session.id}/message:${source.id}`
}

/** Require a successful complete native or PTC page read with the proposed project's path and version.
 * @param session - retained conversation, including pre-compaction tool history.
 * @param project - canonical registered project directory.
 * @param path - Brain-relative page selected for replacement.
 * @param version - content version that informed the replacement.
 * @throws when no matching complete brain_read is retained.
 */
export function requireInformedBrainRead(session: Session, project: string, path: string, version: string): void {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  if (hasInformedBrainRead(session.snapshotEvents(), project, path, version)) return
  throw new Error('Read this Brain page with brain_read before updating it; use the exact returned version')
}

/** Check paired successful native and PTC read output, including complete multi-packet reads, without a live Agent.
 * @param events - durable Session events from the same conversation as the proposed write.
 * @param project - canonical registered project directory.
 * @param path - Brain-relative page read by the model.
 * @param version - exact returned content version.
 * @returns whether successful matching read output includes complete Markdown and Timeline.
 */
export function hasInformedBrainRead(events: readonly SessionEvent[], project: string, path: string,
  version: string): boolean {
  const coverage = new Map<string, BrainReadChunk[]>()
  for (const result of successfulBrainLookups(events)) {
    if (result.name !== 'brain_read') continue
    for (const block of result.content) {
      if (block.type !== 'text') continue
      let data: unknown
      try { data = JSON.parse(block.text) } catch {
        // Non-JSON tool text cannot establish a complete Brain read.
        continue
      }
      const parsed = readIdentity.safeParse(data)
      if (!parsed.success || parsed.data.project !== project || parsed.data.path !== path || parsed.data.version !== version) continue
      // Legacy complete results have no partial field. A malformed fragment must never fall through to that format.
      if (typeof data === 'object' && data !== null
        && ('partial' in data || 'format' in data || 'fragment' in data || 'next_cursor' in data)) {
        const chunk = parseBrainReadChunk(data)
        if (chunk === undefined) continue
        const key = JSON.stringify([chunk.project_id, chunk.sha256, chunk.totalBytes])
        const chunks = coverage.get(key) ?? []
        chunks.push(chunk)
        coverage.set(key, chunks)
      } else {
        const full = readIdentity.extend({ markdown: z.string(), timeline: z.array(z.unknown()) }).safeParse(data)
        if (full.success) return true
      }
    }
  }
  return [...coverage.values()].some(hasCompleteBrainRead)
}

type BrainLookupName = 'brain_read' | 'brain_search'

function isBrainLookup(name: string): name is BrainLookupName {
  return name === 'brain_read' || name === 'brain_search'
}

/** PTC results establish the same read evidence only when their recorded dispatch identities match. */
function* successfulBrainLookups(events: readonly SessionEvent[]): Generator<{ name: BrainLookupName; content: readonly ContentBlock[] }> {
  const native = new Map<ToolCallId, BrainLookupName>()
  const ptc = new Map<ToolCallId, PtcDispatchStartEventData>()
  for (const event of events) {
    if (event.type === 'tool/call' && isBrainLookup(event.data.name)) native.set(event.data.callId, event.data.name)
    if (event.type === 'tool/ptc-dispatch-start' && isBrainLookup(event.data.name)) ptc.set(event.data.subCallId, event.data)
    if (event.type === 'tool/result') {
      const name = native.get(event.data.message.source.callId)
      if (name !== undefined && event.data.message.isError !== true) yield { name, content: event.data.message.content }
    } else if (event.type === 'tool/ptc-dispatch') {
      const started = ptc.get(event.data.subCallId)
      if (started !== undefined && isBrainLookup(event.data.name) && started.name === event.data.name
        && started.rootCallId === event.data.rootCallId && started.parentCallId === event.data.parentCallId && !event.data.isError) {
        yield { name: event.data.name, content: event.data.content }
      }
    }
  }
}
