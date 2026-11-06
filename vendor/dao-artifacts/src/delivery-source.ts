/** Projectable evidence from bounded durable Session slices; no filesystem discovery. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { ArtifactDeliveryId } from './types.ts'

/** One source event whose path still requires Project and filesystem validation. */
export interface DeliverySource {
  readonly id: ArtifactDeliveryId
  readonly sessionId: SessionId
  readonly path: string
  readonly cwd: string | undefined
  readonly description?: string
  readonly evidence: 'presented' | 'written'
  readonly observedAt: number
}

/**
 * Decode the source identity without accepting a path from the caller.
 * @param id - encoded Session/event/file identity from a delivery index.
 * @returns source Session and numeric event/file positions, or undefined for malformed input.
 */
export function deliveryIdentity(id: ArtifactDeliveryId): { sessionId: SessionId; seq: number; index: number } | undefined {
  const parts = id.split('/')
  if (parts.length !== 3) return undefined
  const [encoded, seqText, indexText] = parts
  if (encoded === undefined || seqText === undefined || indexText === undefined
    || !/^(0|[1-9]\d*)$/.test(seqText) || !/^(0|[1-9]\d*)$/.test(indexText)) return undefined
  let sessionId: string
  try { sessionId = decodeURIComponent(encoded) } catch (_error) {
    // Wire identities may carry malformed percent escapes.
    return undefined
  }
  if (sessionId.length === 0 || encodeURIComponent(sessionId) !== encoded) return undefined
  const seq = Number(seqText), index = Number(indexText)
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) return undefined
  return { sessionId: brandString<SessionId>(sessionId), seq, index }
}

function filePath(argumentsJson: string): string | undefined {
  let args: unknown
  try { args = JSON.parse(argumentsJson) } catch (_error) {
    // Failed argument parsing cannot establish a successful file mutation.
    return undefined
  }
  return typeof args === 'object' && args !== null && 'file_path' in args && typeof args.file_path === 'string'
    ? args.file_path : undefined
}

/**
 * Extract child-owned presentations and successful root write/edit calls.
 * @param header - immutable source identity and original cwd.
 * @param events - bounded child-owned slice, excluding the fork-inherited prefix.
 * @param maxEntries - inclusive number of source files admitted.
 * @returns source evidence and explicit truncation; no reply or shell text is interpreted.
 */
export function deliverySources(header: SessionHeader, events: readonly SessionEvent[], maxEntries: number):
{ sources: DeliverySource[]; truncated: boolean } {
  const sources: DeliverySource[] = []
  if (header.origin === 'subagent') return { sources, truncated: false }
  const calls = new Map<string, { path: string; cwd: string | undefined }>()
  let cwd = header.cwd
  const append = (event: SessionEvent, index: number, path: string, evidence: DeliverySource['evidence'],
    base: string | undefined, description?: string): boolean => {
    if (sources.length === maxEntries) return false
    sources.push({ id: brandString<ArtifactDeliveryId>(`${encodeURIComponent(header.id)}/${event.seq}/${index}`),
      sessionId: header.id, path, cwd: base, evidence, observedAt: event.time,
      ...description === undefined ? {} : { description } })
    return true
  }
  for (const event of events) {
    switch (event.type) {
      case 'session/working-directory':
      case 'working-directory/change': cwd = event.data.cwd; break
      case 'tool/call': {
        if (event.data.name !== 'write' && event.data.name !== 'edit') break
        const path = filePath(event.data.arguments)
        if (path !== undefined) calls.set(event.data.callId, { path, cwd })
        break
      }
      case 'tool/result': {
        if (event.surfaceOp !== 'append') break
        const call = calls.get(event.data.message.toolCallId)
        calls.delete(event.data.message.toolCallId)
        if (call !== undefined && event.data.message.isError !== true
          && !append(event, 0, call.path, 'written', call.cwd)) return { sources, truncated: true }
        break
      }
      case 'deliverables/presented': {
        // The present producer resolves relative files against the immutable header cwd.
        for (const [index, file] of event.data.files.entries()) {
          if (!append(event, index, file.path, 'presented', header.cwd, file.description)) return { sources, truncated: true }
        }
        break
      }
      default: break // Other merge-extensible Session events are not file-production evidence.
    }
  }
  return { sources, truncated: false }
}
