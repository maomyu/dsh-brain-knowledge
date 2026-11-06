/** Retained Goal result evidence for the signed page review that precedes completion. */
import { createHash } from 'node:crypto'
import { readEvidenceObject as object, readEvidenceJson as json, readBrainFragment, type BrainReadFragment } from './knowledge-review-evidence.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArtifactTaskDirectory } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { ProjectGoalCodingFiles, ProjectGoalRunId, ProjectTaskId } from './types.ts'

interface ReviewScope {
  readonly runId: ProjectGoalRunId
  readonly taskId: ProjectTaskId
  readonly reportMessageId: MessageId
  readonly sourceProjectId: WorkspaceId
  readonly projects: ReadonlyMap<WorkspaceId, string>
  readonly pages: ReadonlySet<string>
}

type ReadChunk = BrainReadFragment

function projectFor(args: Record<string, unknown>, scope: ReviewScope): string | undefined {
  const id = args.target_project_id === undefined ? scope.sourceProjectId : args.target_project_id
  return typeof id === 'string' ? scope.projects.get(id as WorkspaceId) : undefined
}

function completeRead(value: Record<string, unknown>, project: string, path: string): boolean {
  return value.partial === undefined && value.format === undefined
    && value.project === project && value.path === path && typeof value.version === 'string'
    && value.status === 'active' && typeof value.markdown === 'string' && Array.isArray(value.timeline)
}

function completeChunks(chunks: readonly ReadChunk[], project: string, path: string, projectId: WorkspaceId): boolean {
  const first = chunks[0]
  /* v8 ignore if -- The only caller pushes a validated fragment into its owned array immediately before this call. */
  if (first === undefined) return false
  const bytes: Uint8Array[] = []
  let end = 0
  for (const current of chunks.toSorted((left, right) => left.startByte - right.startByte || right.endByte - left.endByte)) {
    if (current.startByte > end) return false
    if (current.endByte <= end) continue
    bytes.push(Buffer.from(current.fragment, 'utf8').subarray(end - current.startByte))
    end = current.endByte
  }
  if (end !== first.totalBytes) return false
  const complete = Buffer.concat(bytes)
  if (createHash('sha256').update(complete).digest('hex') !== first.sha256) return false
  let value: Record<string, unknown> | undefined
  try { value = json(new TextDecoder('utf-8', { fatal: true }).decode(complete)) } catch { return false }
  return value !== undefined && completeRead(value, project, path)
    && value.version === first.version && value.project_id === projectId
}

/** Require a successful signed-page read after this exact delivered Task result.
 * @param events - original source Session log; earlier or other-task calls do not count.
 * @param scope - retained report identity, approved projects and exact signed decision pages.
 * @returns whether the source reviewed a complete active page; a write alone does not prove post-result review.
 */
export function hasPostReportGoalKnowledgeEvidence(events: readonly SessionEvent[], scope: ReviewScope): boolean {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === scope.reportMessageId
    && event.data.source.kind === 'project-goal-result' && event.data.source.runId === scope.runId
    && event.data.source.taskId === scope.taskId)
  if (start < 0) return false
  const calls = new Map<string, { kind: 'native' | 'ptc'; name: string; args: Record<string, unknown> }>()
  const fragments = new Map<string, ReadChunk[]>()
  for (const event of events.slice(start + 1)) {
    if (event.type === 'user/message' && event.data.source.kind === 'project-goal-result') break
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const args = event.type === 'tool/call' ? json(event.data.arguments) : object(event.data.arguments)
      if (args !== undefined) calls.set(event.type === 'tool/call' ? event.data.callId : event.data.subCallId,
        { kind: event.type === 'tool/call' ? 'native' : 'ptc', name: event.data.name, args })
      continue
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') continue
    const call = calls.get(event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId)
    const kind = event.type === 'tool/result' ? 'native' : 'ptc'
    if (call === undefined || call.kind !== kind) continue
    if (event.type === 'tool/ptc-dispatch' && (event.data.name !== call.name
      || JSON.stringify(event.data.arguments) !== JSON.stringify(call.args))) continue
    const result = event.type === 'tool/result' ? event.data.message : event.data
    if (result.isError === true) continue
    const path = call.args.path
    const project = projectFor(call.args, scope)
    if (typeof path !== 'string' || project === undefined || !scope.pages.has(path)) continue
    const projectId = (call.args.target_project_id ?? scope.sourceProjectId) as WorkspaceId
    for (const block of result.content) {
      if (block.type !== 'text') continue
      const value = json(block.text)
      if (value === undefined) continue
      if (call.name === 'brain_read') {
        if (completeRead(value, project, path)
          && (value.project_id === undefined || value.project_id === projectId)) return true
        const part = readBrainFragment(value, projectId, project, path)
        if (part === undefined) continue
        const key = JSON.stringify([projectId, project, path, part.version, part.sha256, part.totalBytes])
        const collected = fragments.get(key) ?? []
        collected.push(part)
        fragments.set(key, collected)
        if (completeChunks(collected, project, path, projectId)) return true
      }
    }
  }
  return false
}

/** Require the complete retained research report as a successful tool result after its exact Goal result input.
 * @param events - original source Session log, including the full settled report result.
 * @param scope - retained Goal result, Task and original project identities.
 * @param reportSha256 - completion-time digest; older reports without it cannot prove a complete read.
 * @returns whether one unique native or PTC call delivered the exact report bytes before the next Goal result.
 */
export function hasPostReportResearchRead(events: readonly SessionEvent[], scope: ReviewScope,
  reportSha256: string | undefined): boolean {
  if (reportSha256 === undefined) return false
  return hasSuccessfulResultRead(events, scope, 'read_research_report',
    args => args.taskId === scope.taskId
      && (args.target_project_id === undefined || args.target_project_id === scope.sourceProjectId),
    text => createHash('sha256').update(text, 'utf8').digest('hex') === reportSha256)
}

function completeDocumentation(value: Record<string, unknown>, expected: ArtifactTaskDirectory): boolean {
  if (value.format !== 'goal-documentation-directory-v1' || value.workspaceId !== expected.workspaceId
    || value.taskId !== expected.taskId || value.id !== expected.id || value.version !== expected.version
    || value.digest !== expected.digest || !Array.isArray(value.directories) || !Array.isArray(value.files)
    || typeof value.totalBytes !== 'number' || value.files.length === 0) return false
  const directories = value.directories
  if (!directories.every(item => typeof item === 'string')
    || JSON.stringify(directories) !== JSON.stringify(expected.directories)) return false
  let total = 0
  const files: { path: string; bytes: number; sha256: string }[] = []
  for (const item of value.files) {
    const file = object(item)
    if (file === undefined || typeof file.path !== 'string' || typeof file.bytes !== 'number'
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string'
      || typeof file.content !== 'string' || (file.encoding !== 'utf8' && file.encoding !== 'base64')) return false
    const bytes = Buffer.from(file.content, file.encoding === 'utf8' ? 'utf8' : 'base64')
    if (file.encoding === 'base64' && bytes.toString('base64') !== file.content) return false
    if (bytes.byteLength !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return false
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 })
    total += file.bytes
  }
  return total === value.totalBytes && total === expected.totalBytes
    && JSON.stringify(files) === JSON.stringify(expected.files.map(file => ({
      path: file.path, bytes: file.bytes, sha256: file.sha256 })))
    && createHash('sha256').update(JSON.stringify({ directories, files })).digest('hex') === expected.digest
}

/** Require the exact complete documentation tree to have reached the Goal source after its latest Task result.
 * @param events - durable source log containing native or PTC tool outcomes.
 * @param scope - exact delivered result and Task identities.
 * @param expected - fresh Host read of the successful Task's retained directory.
 * @returns whether one unique successful tool call supplied every file byte at the expected version and digest.
 */
export function hasPostReportDocumentationRead(events: readonly SessionEvent[], scope: ReviewScope,
  expected: ArtifactTaskDirectory): boolean {
  return hasSuccessfulResultRead(events, scope, 'wud_read_task_documentation',
    args => args.runId === scope.runId && args.taskId === scope.taskId,
    (text) => {
      const value = json(text)
      return value !== undefined && completeDocumentation(value, expected)
    })
}

/** Require a complete fixed-commit coding file read after its exact Goal result.
 * @param events - durable source log with settled native or PTC tool results.
 * @param scope - delivered Goal result and Task identities.
 * @param expected - fresh Host read of every changed regular file and blob digest.
 * @returns whether one unique successful tool call supplied the exact complete manifest.
 */
export function hasPostReportCodingRead(events: readonly SessionEvent[], scope: ReviewScope,
  expected: ProjectGoalCodingFiles): boolean {
  return hasSuccessfulResultRead(events, scope, 'wud_read_task_coding',
    args => args.runId === scope.runId && args.taskId === scope.taskId,
    (text) => {
      const value = json(text)
      return value !== undefined && JSON.stringify(value) === JSON.stringify(expected)
    })
}

/** Match one unique successful tool result after the exact Goal report input. */
function hasSuccessfulResultRead(events: readonly SessionEvent[], scope: ReviewScope, name: string,
  matchesArgs: (args: Record<string, unknown>) => boolean, matchesText: (text: string) => boolean): boolean {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === scope.reportMessageId
    && event.data.source.kind === 'project-goal-result' && event.data.source.runId === scope.runId
    && event.data.source.taskId === scope.taskId)
  if (start < 0) return false
  const calls = new Map<string, { kind: 'native' | 'ptc'; args: Record<string, unknown> }>()
  const seenCalls = new Set<string>()
  const seenResults = new Set<string>()
  const duplicates = new Set<string>()
  const successful = new Set<string>()
  for (const event of events.slice(start + 1)) {
    if (event.type === 'user/message' && event.data.source.kind === 'project-goal-result') break
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const id = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
      if (seenCalls.has(id)) { duplicates.add(id); continue }
      seenCalls.add(id)
      if (event.data.name !== name) continue
      const args = event.type === 'tool/call' ? json(event.data.arguments) : object(event.data.arguments)
      if (args !== undefined && matchesArgs(args)) {
        calls.set(id, { kind: event.type === 'tool/call' ? 'native' : 'ptc', args })
      }
      continue
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') continue
    const id = event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId
    if (seenResults.has(id)) { duplicates.add(id); continue }
    seenResults.add(id)
    const call = calls.get(id)
    if (call === undefined || call.kind !== (event.type === 'tool/result' ? 'native' : 'ptc')) continue
    if (event.type === 'tool/ptc-dispatch' && (event.data.name !== name
      || JSON.stringify(event.data.arguments) !== JSON.stringify(call.args))) continue
    const result = event.type === 'tool/result' ? event.data.message : event.data
    if (result.isError === true || result.content.length !== 1 || result.content[0]?.type !== 'text') continue
    if (matchesText(result.content[0].text)) successful.add(id)
  }
  return [...successful].some(id => !duplicates.has(id))
}
