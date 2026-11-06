/** Durable tool progress bounds automatic review without classifying facts from model prose. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Stable tool diagnostic also records why the following automatic continuation is blocked. */
export const AUTOMATIC_REVIEW_STOP = 'Automatic knowledge review stopped: '
/** A refused read may offer bounded recovery from an already retained successful complete result. */
export const AUTOMATIC_READ_RECOVERY = 'Automatic knowledge review read recovery: '
const callId = z.string().transform(value => brandString<ToolCallId>(value))
const call = z.object({ id: callId, name: z.string(), identity: z.string(), semantic: z.string(), page: z.string(),
  automatic: z.boolean(), result: z.enum(['pending', 'success', 'error']), completeVersion: z.string().nullable(),
  written: z.boolean(), versionConflict: z.boolean(), readRecovery: z.boolean(),
  rootCallId: callId.nullable(), parentCallId: callId.nullable() })
/** Reconstructed current-turn calls; private projection caches retain hashes rather than complete arguments or files. */
export const curationProgressSchema = z.object({ calls: z.array(call), stopReason: z.string().nullable(), started: z.boolean() })
/** Call progress belongs to one current automatic interval and its earlier ordinary informing reads. */
export type CurationProgress = z.infer<typeof curationProgressSchema>

/** Initialize one turn without inheriting a former review's allowance.
 * @returns an empty derived progress state.
 */
export function emptyCurationProgress(): CurationProgress { return { calls: [], stopReason: null, started: false } }

function argumentsRecord(value: unknown): Record<string, unknown> | undefined {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return undefined }
  }
  const record = z.record(z.string(), z.unknown()).safeParse(parsed)
  return record.success ? record.data : undefined
}

function identity(name: string, value: unknown) {
  const args = argumentsRecord(value) ?? {}
  const sorted = Object.fromEntries(Object.keys(args).sort().map(key => [key, args[key]]))
  const semantic = Object.fromEntries(Object.entries(sorted).filter(([key]) => key !== 'operation_id' && key !== 'expected_version'))
  const hash = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex')
  return { identity: hash([name, sorted]), semantic: hash([name, semantic]),
    page: JSON.stringify([args.target_project_id ?? null, args.path ?? null]) }
}

/** Fold actual native/PTC calls and matched settlements, never assistant claims about completed work.
 * @param state - current turn's retained progress.
 * @param event - next durable Session event.
 * @param automatic - whether this event belongs to the active canonical automatic interval.
 * @returns updated call identities, complete reads and any logged terminal diagnostic.
 */
export function applyCurationProgress(state: CurationProgress, event: SessionEvent, automatic: boolean): CurationProgress {
  if (event.type === 'user/message' && event.data.source.kind === 'project-brain-curation-check'
    && event.data.source.reviewKind === 'automatic') {
    return state.started ? state : { calls: state.calls.filter(item => !item.automatic), stopReason: null, started: true }
  }
  if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
    const id = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
    return { ...state, calls: [...state.calls, { id, name: event.data.name,
      ...identity(event.data.name, event.data.arguments), automatic, result: 'pending', completeVersion: null,
      written: false, versionConflict: false, readRecovery: false,
      rootCallId: event.type === 'tool/call' ? null : event.data.rootCallId,
      parentCallId: event.type === 'tool/call' ? null : event.data.parentCallId }] }
  }
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state
  const id = event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId
  const index = state.calls.findIndex(item => item.id === id && (event.type === 'tool/result'
    ? item.rootCallId === null : item.name === event.data.name && item.rootCallId === event.data.rootCallId
      && item.parentCallId === event.data.parentCallId))
  const prior = state.calls[index]
  if (prior === undefined) return state
  const content = event.type === 'tool/result' ? event.data.message.content : event.data.content
  const isError = event.type === 'tool/result' ? event.data.message.isError === true : event.data.isError
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  const full = z.object({ version: z.string(), markdown: z.string(), timeline: z.array(z.unknown()),
    partial: z.literal(undefined).optional(), format: z.literal(undefined).optional() }).safeParse(parsed)
  const receipt = z.object({ disposition: z.enum(['written', 'already-applied']) }).safeParse(parsed)
  const stop = isError && prior.automatic ? text.indexOf(AUTOMATIC_REVIEW_STOP) : -1
  return { ...state, stopReason: stop < 0 ? state.stopReason : text.slice(stop), calls: state.calls.map((item, ordinal) => ordinal !== index
    ? item : { ...item, result: isError ? 'error' : 'success',
      completeVersion: !isError && prior.name === 'brain_read' && full.success ? full.data.version : null,
      written: !isError && receipt.success,
      readRecovery: isError && prior.automatic && text.includes(AUTOMATIC_READ_RECOVERY),
      versionConflict: isError && /knowledge changed|Brain location changed/iu.test(text) }) }
}

function completeReadBefore(calls: CurationProgress['calls'], index: number) {
  const current = calls[index]
  /* v8 ignore if -- Both callers retain this same array's validated current index or its filter ordinal. */
  if (current === undefined) return undefined
  const preceding = calls.slice(0, index)
  const completed = preceding.findLastIndex(item => item.name === 'brain_read' && item.identity === current.identity
    && item.completeVersion !== null)
  return completed < 0 || preceding.slice(completed + 1).some(item => item.page === current.page && (item.written || item.versionConflict))
    ? undefined : preceding[completed]
}

/** Refuse already completed work and bound every tool attempt, including failures and parallel batches.
 * @param state - log-derived current-turn calls, including this already logged invocation.
 * @param id - exact registry call identity about to execute.
 * @param maxCalls - validated attempt allowance for one automatic interval.
 * @param maxReadRecoveries - validated interval allowance for using an existing successful complete result after refusal.
 * @returns a logged terminal or recoverable diagnostic, or undefined when this distinct work may proceed.
 */
export function curationProgressRefusal(state: CurationProgress, id: ToolCallId, maxCalls: number,
  maxReadRecoveries: number): string | undefined {
  const index = state.calls.findIndex(item => item.id === id)
  const current = state.calls[index]
  if (current === undefined || !current.automatic) return undefined
  const earlier = state.calls.slice(0, index)
  if (earlier.filter(item => item.automatic).length + 1 >= maxCalls) {
    return AUTOMATIC_REVIEW_STOP + 'the configured tool-attempt allowance was reached. The review remains unfinished; request a manual review.'
  }
  if (current.name === 'brain_read') {
    const complete = completeReadBefore(state.calls, index)
    if (complete !== undefined) {
      const recoveries = earlier.filter((item, ordinal) => item.readRecovery || item.automatic && item.name === 'brain_read'
        && item.result === 'pending' && completeReadBefore(earlier, ordinal) !== undefined).length
      if (recoveries < maxReadRecoveries) {
        return AUTOMATIC_READ_RECOVERY + `successful complete brain_read call ${complete.id}, version ${complete.completeVersion}, `
          + 'is already retained in this conversation. No new read was executed. This refused duplicate request is not a failure of '
          + 'the original read and does not invalidate its complete coverage. Reuse that exact recorded Markdown and Timeline '
          + 'to assess distinct uncovered facts, then end with the automatic review\'s short internal status. Do not read this unchanged document again.'
      }
      return AUTOMATIC_REVIEW_STOP + 'the configured complete-read recovery allowance was reached. No repeated read was executed; '
        + 'the review remains unfinished. Request a manual review.'
    }
    const read = earlier.findLastIndex(item => item.name === 'brain_read' && item.identity === current.identity
      && (item.completeVersion !== null || item.result === 'pending'))
    if (read >= 0 && !earlier.slice(read + 1).some(item => item.page === current.page && (item.written || item.versionConflict))) {
      return AUTOMATIC_REVIEW_STOP + 'this complete document read is already available or in flight. No repeated read was executed; the review remains unfinished.'
    }
  }
  if (current.name.startsWith('brain_') && !['brain_read', 'brain_search', 'brain_read_proposals', 'brain_read_health_report'].includes(current.name)
    && earlier.some(item => item.automatic && item.name === current.name && item.semantic === current.semantic
      && item.result !== 'error')) {
    return AUTOMATIC_REVIEW_STOP + 'this exact knowledge intent was already assessed or is in flight. No repeated write was executed; the review remains unfinished.'
  }
  return undefined
}
