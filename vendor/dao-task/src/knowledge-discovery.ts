/** Strict model result parsing for a complete, read-only post-Task Brain comparison. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactTaskDirectory } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type {} from '@deepseek-ai/dsh-api-document-import-controller'
import type { DocumentImportInput, DocumentImportResult } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectTaskCompletion, ProjectTaskId, ProjectTaskState, ProjectTaskKnowledgeDiscovery,
  ProjectTaskKnowledgeDiscoveryEvidence, ProjectTaskKnowledgeInvalidResult, ProjectTaskKnowledgeSchemaIssue,
  ProjectTaskArtifactCoverage, ProjectTaskCodingOmission, ProjectTaskOutputFileContent, ProjectTaskOutputFileId,
  ProjectTaskOutputInventory } from './types.ts'

const comparedPageIdentity = { path: z.string().min(1), version: z.string().min(1) }
const comparedPage = z.discriminatedUnion('relation', [
  z.object({ ...comparedPageIdentity, relation: z.literal('unrelated') }).strict(),
  z.object({ ...comparedPageIdentity, relation: z.literal('unknown'), reason: z.string().trim().min(1).max(240) }).strict(),
  ...(['duplicate', 'conflict', 'supports', 'supersedes'] as const).map(relation =>
    z.object({ ...comparedPageIdentity, relation: z.literal(relation),
      quote: z.string().trim().min(1).max(240), reason: z.string().trim().min(1).max(240) }).strict()),
])
const sourceDisposition = z.object({ sourceId: z.string().min(1),
  disposition: z.enum(['current', 'superseded', 'unresolved', 'not-relevant']),
  quote: z.string().min(1).optional(), rationale: z.string().trim().min(1) }).strict()
  .refine(item => item.disposition !== 'current' && item.disposition !== 'superseded'
    || item.quote !== undefined, 'Current or superseded source requires an exact quote')
const noChange = z.object({ decision: z.literal('no-change'), reason: z.string().trim().min(1),
  comparedPages: z.array(comparedPage), sourceDispositions: z.array(sourceDisposition).optional() }).strict()
const candidate = z.object({ decision: z.literal('candidate'),
  kind: z.enum(['existing-page', 'new-page', 'conflict']), summary: z.string().trim().min(1),
  proposedTruth: z.string().trim().min(1), evidence: z.string().trim().min(1),
  comparedPages: z.array(comparedPage), sourceDispositions: z.array(sourceDisposition).optional() }).strict()
const resultSchema = z.discriminatedUnion('decision', [noChange, candidate])
const topicResultSchema = z.discriminatedUnion('decision', [noChange, candidate.extend({
  topicQuery: z.string().trim().min(1).max(256).optional(),
})])
const pageBatchResultSchema = z.object({ finding: z.string().trim().min(1),
  comparedPages: z.array(comparedPage) }).strict()

const textExtensions = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'html', 'htm', 'css', 'scss',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'svg'])
const textNames = new Set(['readme', 'license', 'notice', 'changelog', '.gitignore', '.npmignore',
  '.editorconfig', '.prettierignore'])

/** A full directory that cannot safely become model-visible textual evidence. */
export class TaskArtifactEvidenceError extends Error {
  constructor(readonly kind: 'unsupported-result' | 'source-incomplete' | 'source-read-failed') {
    super(`Task documentation evidence ${kind}`)
    this.name = 'TaskArtifactEvidenceError'
  }
}

/** A conversion is scoped to the original project and uses only already verified artifact bytes. */
export type TaskDocumentConverter = (workspaceId: WorkspaceId, input: DocumentImportInput,
  signal: AbortSignal) => Promise<DocumentImportResult>

/** Resolve the installed project-scoped converter only when a PDF or DOCX needs it.
 * @param ctx - active Host service registry.
 * @returns bounded converter or undefined; callers reject conversion without an installed service.
 */
export function taskArtifactDocumentConverter(ctx: Context): TaskDocumentConverter | undefined {
  const service = ctx.get('documentImportController')
  return service === undefined ? undefined : (workspaceId, input, signal) => service.prepare(workspaceId, input, signal)
}

/** Original directory identity plus the exact textual/opaque coverage admitted to the reviewer. */
export type TaskArtifactEvidenceReceipt = Pick<ArtifactTaskDirectory, 'id' | 'version' | 'digest'> & {
  readonly coverageSha256: string
}

type TaskArtifactEvidenceFile = { readonly path: string
  readonly bytes: number
  readonly sha256: string } & (
  | { readonly text: string
    readonly coverage?: undefined }
  | { readonly text: string
    readonly coverage: { readonly kind: 'converted-text'
      readonly format: 'pdf' | 'docx'
      readonly extraction: NonNullable<Extract<DocumentImportResult,
        { status: 'ready' }>['extraction']> } }
  | { readonly coverage: { readonly kind: 'opaque'
    readonly reason: 'unsupported-format' | 'unreadable-text'
    | 'too-large' | 'unreadable' | 'too-many-pages' | 'no-readable-text' } }
)

type TaskArtifactDirectoryEvidence = { readonly receipt: TaskArtifactEvidenceReceipt
  readonly manifest: { readonly directories: readonly string[]
    readonly files: readonly TaskArtifactEvidenceFile[]
    readonly totalBytes: number } }

/** Exact text admitted to a reviewer; source IDs are stable within the signed result and file receipt. */
export interface KnowledgeDiscoverySource {
  readonly sourceId: string
  readonly text: string
}

/** A readable source's exact text location in a Task reviewer input; source bodies occur only once. */
export interface TaskKnowledgeSourceTextLocation {
  readonly sourceId: string
  readonly kind: 'task-summary' | 'research-report' | 'artifact' | 'coding-output' | 'imported-document'
  readonly textPath: readonly (string | number)[]
}

/** Exact source attribution shared by single-call and final batched Task reviewers. */
export const taskKnowledgeSourceTextInstruction = 'sourceTextLocations binds every readable sourceId to its kind and exact textPath in this JSON input. Follow the textPath segments from this input root and copy each quote as one contiguous, unchanged fragment of that string only. task-summary means result.summary only, not the Task description, goals, instructions, acceptance criteria or verification steps. Never attribute text from task, Brain pages, batch findings or another source to task-summary or any other sourceId. The sourceIds order and exact source quotes remain required; do not invent missing source text.'

/** Resolve source IDs to the existing reviewer fields without repeating their full text.
 * @param result - complete Task result evidence already included in the reviewer input.
 * @returns source locations in the same order as the readable Task source matrix.
 */
export function taskKnowledgeSourceTextLocations(result: {
  readonly summary: string
  readonly researchReport?: string | undefined
  readonly artifactDirectory?: { readonly files: readonly { readonly path: string
    readonly text?: string | undefined }[] } | undefined
  readonly codingFiles?: { readonly files: readonly { readonly sourceId: string
    readonly text: string }[] }
    | { readonly status: 'unavailable' } | undefined
  readonly importedSources?: readonly { readonly importId: string
    readonly documentId: string
    readonly text: string }[] | undefined
}): TaskKnowledgeSourceTextLocation[] {
  const locations: TaskKnowledgeSourceTextLocation[] = [
    { sourceId: 'task-summary', kind: 'task-summary', textPath: ['result', 'summary'] },
  ]
  if (result.researchReport !== undefined) locations.push({ sourceId: 'research-report', kind: 'research-report',
    textPath: ['result', 'researchReport'] })
  for (const [index, file] of (result.artifactDirectory?.files ?? []).entries()) {
    if (file.text !== undefined) locations.push({ sourceId: `artifact:${file.path}`, kind: 'artifact',
      textPath: ['result', 'artifactDirectory', 'files', index, 'text'] })
  }
  if (result.codingFiles !== undefined && 'files' in result.codingFiles) {
    for (const [index, file] of result.codingFiles.files.entries()) {
      locations.push({ sourceId: file.sourceId, kind: 'coding-output',
        textPath: ['result', 'codingFiles', 'files', index, 'text'] })
    }
  }
  for (const [index, source] of (result.importedSources ?? []).entries()) {
    locations.push({ sourceId: `import:${source.importId}:${source.documentId}`, kind: 'imported-document',
      textPath: ['result', 'importedSources', index, 'text'] })
  }
  return locations
}

/** Citable coding files and explicit omissions from the same completion-time inventory. */
export interface TaskCodingKnowledgeEvidence {
  readonly format: 'task-coding-files-v1'
  readonly files: readonly { readonly sourceId: string
    readonly path: string
    readonly change: 'added' | 'modified'
    readonly bytes: number
    readonly version: string
    readonly sha256: string
    readonly text: string }[]
  /** Absent for complete historical-compatible reads; listed content cannot support no-change or publication. */
  readonly opaqueFiles?: readonly ProjectTaskCodingOmission[] | undefined
  readonly sha256: string
}

/** Fixed diagnostic for a coding source that cannot support a complete comparison. */
export class TaskCodingEvidenceError extends Error {
  constructor(readonly kind: 'source-incomplete' | 'source-read-failed' | 'unsupported-result'
    | 'input-limit' | 'evidence-changed') {
    super(`Task coding evidence ${kind}`)
    this.name = 'TaskCodingEvidenceError'
  }
}

/** Read each available observed file body without substituting later checkout bytes or guessing omitted content.
 * @param inventory - completion-time path/version observation, never reconstructed after a restart.
 * @param maxBytes - complete text-byte allowance; the caller also bounds the serialized reviewer input.
 * @param read - Task owner's exact-ID and version-checked read of one retained output.
 * @param signal - reviewer or human-decision lifetime.
 * @returns complete readable bodies plus bounded omissions; an all-opaque result rejects.
 */
export async function taskCodingKnowledgeEvidence(inventory: ProjectTaskOutputInventory | undefined,
  maxBytes: number, read: (id: ProjectTaskOutputFileId, signal: AbortSignal) => Promise<ProjectTaskOutputFileContent>,
  signal: AbortSignal): Promise<TaskCodingKnowledgeEvidence> {
  if (inventory?.status !== 'available' || inventory.truncated) throw new TaskCodingEvidenceError('source-incomplete')
  if (inventory.files.reduce((total, file) => total + (file.readable && file.change !== 'deleted' ? file.bytes ?? 0 : 0), 0) > maxBytes) {
    throw new TaskCodingEvidenceError('input-limit')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const files: TaskCodingKnowledgeEvidence['files'][number][] = []
  const opaqueFiles: ProjectTaskCodingOmission[] = []
  for (const file of inventory.files) {
    signal.throwIfAborted()
    if (file.change === 'deleted' || !file.readable || file.version === null || file.bytes === null) {
      opaqueFiles.push({ path: file.path, change: file.change, bytes: file.bytes, version: file.version,
        reason: file.change === 'deleted' ? 'deleted' : 'unreadable' })
      continue
    }
    let content: ProjectTaskOutputFileContent
    try { content = await read(file.id, signal) }
    catch { signal.throwIfAborted(); throw new TaskCodingEvidenceError('source-read-failed') }
    if (content.id !== file.id || content.version !== file.version) throw new TaskCodingEvidenceError('evidence-changed')
    const bytes = Buffer.from(content.dataBase64, 'base64')
    if (bytes.byteLength !== file.bytes || bytes.toString('base64') !== content.dataBase64) {
      throw new TaskCodingEvidenceError('evidence-changed')
    }
    let text: string
    try { text = decoder.decode(bytes) }
    catch {
      opaqueFiles.push({ path: file.path, change: file.change, bytes: file.bytes, version: file.version,
        reason: 'non-text', sha256: createHash('sha256').update(bytes).digest('hex') })
      continue
    }
    if (text.trim() === '' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      opaqueFiles.push({ path: file.path, change: file.change, bytes: file.bytes, version: file.version,
        reason: text.trim() === '' ? 'empty' : 'non-text', sha256: createHash('sha256').update(bytes).digest('hex') })
      continue
    }
    files.push({ sourceId: `output:${file.path}`, path: file.path, change: file.change,
      bytes: bytes.byteLength, version: file.version, sha256: createHash('sha256').update(bytes).digest('hex'), text })
  }
  if (files.length === 0 && opaqueFiles.length > 0) throw new TaskCodingEvidenceError('unsupported-result')
  const manifest = { format: 'task-coding-files-v1' as const, files,
    ...(opaqueFiles.length === 0 ? {} : { opaqueFiles }) }
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  return { ...manifest, sha256 }
}

/** Name each readable artifact file without treating opaque bytes as citable text.
 * @param files - complete Host-verified directory manifest.
 * @returns sources in manifest order, with IDs bound by the directory digest.
 */
export function artifactKnowledgeSources(files: readonly { readonly path: string
  readonly text?: string
  readonly coverage?: unknown }[]): KnowledgeDiscoverySource[] {
  return files.flatMap(file => file.text === undefined ? [] : [{ sourceId: `artifact:${file.path}`, text: file.text }])
}

/** Validate a supplied matrix against every readable source and its exact cited text.
 * @param dispositions - supplied model assessments in the Host's source order; callers retain absence as draft-only.
 * @param sources - complete readable sources supplied to the reviewer.
 * @returns no value; an invalid supplied matrix retains no candidate.
 */
export function requireKnowledgeSourceDispositions(dispositions: readonly z.infer<typeof sourceDisposition>[],
  sources: readonly KnowledgeDiscoverySource[]): void {
  if (!matchesKnowledgeSourceDispositions(dispositions, sources)) {
    throw new KnowledgeDiscoveryInvalidResultError('source-dispositions')
  }
}

/** A new no-change verdict must account for every readable source with an exact source quote.
 * @param dispositions - model assessments of the complete source set.
 * @param sources - exact readable sources supplied to the reviewer.
 * @returns no value; unresolved, missing or unquoted source assessments cannot close discovery.
 */
export function requireNoChangeSourceDispositions(dispositions: readonly z.infer<typeof sourceDisposition>[] | undefined,
  sources: readonly KnowledgeDiscoverySource[]): void {
  if (dispositions === undefined || !matchesKnowledgeSourceDispositions(dispositions, sources)
    || dispositions.some(item => item.disposition === 'unresolved' || item.quote === undefined)) {
    throw new KnowledgeDiscoveryInvalidResultError('source-dispositions')
  }
}

/** Compare one complete matrix with a verified readback of the original source text.
 * @param dispositions - candidate or human classifications in Host source order.
 * @param sources - exact readable sources bound to the retained result.
 * @returns whether identities, cardinality, and every quoted substring match.
 */
export function matchesKnowledgeSourceDispositions(dispositions: readonly z.infer<typeof sourceDisposition>[],
  sources: readonly KnowledgeDiscoverySource[]): boolean {
  return sources.length > 0 && dispositions.length === sources.length
    && sources.every((source, index) => {
      const item = dispositions[index]
      return item?.sourceId === source.sourceId
        && (item.quote === undefined || source.text.includes(item.quote))
    })
}

/** A new existing-page proposal or held draft publication requires resolved readable sources.
 * @param dispositions - retained reviewer assessments, absent on released candidates.
 * @returns whether the reviewer supplied a nonempty complete, resolved matrix.
 */
export function canPublishKnowledgeSources(dispositions: readonly z.infer<typeof sourceDisposition>[] | undefined): boolean {
  return dispositions !== undefined && dispositions.length > 0
    && dispositions.every(item => item.disposition !== 'unresolved')
}

/** Decode every supported file and retain the Host's complete path/content manifest.
 * @param directory - bounded, stable Host read of the exact retained documentation rendition.
 * @param convert - installed, bounded PDF/DOCX converter; absent conversion service blocks those formats.
 * @param signal - conversion and caller lifetime.
 * @returns verified original manifest and complete readable text with explicit opaque-file coverage.
 */
export async function taskArtifactDirectoryEvidence(directory: ArtifactTaskDirectory,
  convert: TaskDocumentConverter | undefined, signal: AbortSignal): Promise<TaskArtifactDirectoryEvidence> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  if (directory.files.length === 0) throw new TaskArtifactEvidenceError('source-incomplete')
  let totalBytes = 0
  const verified = directory.files.map((file) => {
    const bytes = Buffer.from(file.dataBase64, 'base64')
    if (bytes.toString('base64') !== file.dataBase64 || bytes.byteLength !== file.bytes
      || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new TaskArtifactEvidenceError('source-incomplete')
    }
    totalBytes += file.bytes
    return { path: file.path, bytes: file.bytes, sha256: file.sha256, dataBase64: file.dataBase64, data: bytes }
  })
  const digest = createHash('sha256').update(JSON.stringify({ directories: directory.directories,
    files: verified.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) })).digest('hex')
  if (totalBytes !== directory.totalBytes || digest !== directory.digest) {
    throw new TaskArtifactEvidenceError('source-incomplete')
  }
  const files: TaskArtifactEvidenceFile[] = []
  for (const file of verified) {
    signal.throwIfAborted()
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    const lower = name.toLowerCase()
    const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
    const base = { path: file.path, bytes: file.bytes, sha256: file.sha256 }
    if (textNames.has(lower) || textExtensions.has(extension)) {
      try {
        const text = decoder.decode(file.data)
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new TypeError('non-text controls')
        files.push({ ...base, text })
      } catch { files.push({ ...base, coverage: { kind: 'opaque', reason: 'unreadable-text' } }) }
      continue
    }
    if (extension !== 'pdf' && extension !== 'docx') {
      files.push({ ...base, coverage: { kind: 'opaque', reason: 'unsupported-format' } })
      continue
    }
    if (convert === undefined) throw new TaskArtifactEvidenceError('source-read-failed')
    let result: DocumentImportResult
    try {
      result = await convert(directory.workspaceId, { name, format: extension, dataBase64: file.dataBase64 }, signal)
    } catch {
      signal.throwIfAborted()
      throw new TaskArtifactEvidenceError('source-read-failed')
    }
    signal.throwIfAborted()
    if (result.status === 'rejected') {
      if (result.reason === 'busy' || result.reason === 'timed-out' || result.reason === 'processor-failed') {
        throw new TaskArtifactEvidenceError('source-read-failed')
      }
      files.push({ ...base, coverage: { kind: 'opaque', reason: result.reason } })
      continue
    }
    const extraction = result.extraction
    if (result.sourceBytes !== file.bytes || result.textBytes !== Buffer.byteLength(result.text, 'utf8')
      || extraction?.kind !== (extension === 'pdf' ? 'pdf-text' : 'docx-text')) {
      throw new TaskArtifactEvidenceError('source-read-failed')
    }
    if (result.text.trim() === '') {
      files.push({ ...base, coverage: { kind: 'opaque', reason: 'no-readable-text' } })
      continue
    }
    files.push({ ...base, text: result.text, coverage: { kind: 'converted-text', format: extension,
      extraction } })
  }
  if (!files.some(file => 'text' in file && file.text.trim() !== '')) {
    throw new TaskArtifactEvidenceError('unsupported-result')
  }
  const manifest = { directories: directory.directories, files, totalBytes }
  const coverageSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { receipt: { id: directory.id, version: directory.version, digest: directory.digest, coverageSha256 }, manifest }
}

/** A text conversion with unread visual or page content cannot establish complete no-change.
 * @param files - non-plain-text coverage retained with the exact directory interpretation.
 * @returns whether the model has only partial information about any retained file.
 */
export function hasUnreviewedArtifactContent(files: ProjectTaskArtifactCoverage): boolean {
  return files.some((file) => {
    if (file.kind === 'opaque') return true
    const extraction = file.extraction
    return extraction.kind === 'pdf-text'
      ? extraction.pagesWithoutText.length > 0 || extraction.pagesWithTextAndPaintedImages === undefined
        || extraction.pagesWithTextAndPaintedImages.length > 0
      : extraction.imageCount > 0
  })
}

/** Closed diagnosis for a rejected reviewer response; never includes model text. */
export type KnowledgeDiscoveryInvalidResult = ProjectTaskKnowledgeInvalidResult

/** Safe parsing failure that carries only fixed categories. */
export class KnowledgeDiscoveryInvalidResultError extends Error {
  constructor(readonly kind: KnowledgeDiscoveryInvalidResult,
    readonly schemaIssue?: ProjectTaskKnowledgeSchemaIssue) {
    super(`Knowledge discovery invalid result: ${kind}`)
    this.name = 'KnowledgeDiscoveryInvalidResultError'
  }
}

function schemaField(path: readonly PropertyKey[]): ProjectTaskKnowledgeSchemaIssue['field'] {
  const [head, second, third] = path
  if (head === 'comparedPages') {
    if (typeof second === 'number' && third === 'path') return 'comparedPages[].path'
    if (typeof second === 'number' && third === 'version') return 'comparedPages[].version'
    if (typeof second === 'number' && third === 'relation') return 'comparedPages[].relation'
    if (typeof second === 'number' && third === 'quote') return 'comparedPages[].quote'
    if (typeof second === 'number' && third === 'reason') return 'comparedPages[].reason'
    return 'comparedPages'
  }
  switch (head) {
    case 'decision': case 'kind': case 'reason': case 'summary': case 'proposedTruth':
    case 'evidence': case 'topicQuery': case 'sourceDispositions': return head
    default: return 'result'
  }
}

function missingAtPath(raw: unknown, path: readonly PropertyKey[]): boolean {
  let parent = raw
  for (const key of path.slice(0, -1)) {
    /* v8 ignore if -- These same-schema Zod issues descend only through existing parents in freshly parsed JSON. */
    if (typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, key)) return false
    parent = (parent as Record<PropertyKey, unknown>)[key]
  }
  const key = path.at(-1)
  return key !== undefined && typeof parent === 'object' && parent !== null && !Object.hasOwn(parent, key)
}

function schemaIssue(raw: unknown, issue: z.core.$ZodIssue): ProjectTaskKnowledgeSchemaIssue {
  let rule: ProjectTaskKnowledgeSchemaIssue['rule']
  switch (issue.code) {
    case 'invalid_type': rule = missingAtPath(raw, issue.path) ? 'missing' : 'type'; break
    case 'invalid_value': case 'invalid_union': rule = missingAtPath(raw, issue.path) ? 'missing' : 'invalid-value'; break
    case 'too_small': rule = 'empty'; break
    case 'too_big': rule = 'too-long'; break
    case 'unrecognized_keys': rule = 'unexpected-field'; break
    default: rule = 'invalid-value'
  }
  return { field: schemaField(issue.path), rule }
}

function rejectSchema(raw: unknown, issues: readonly z.core.$ZodIssue[]): never {
  const first = issues[0]
  throw new KnowledgeDiscoveryInvalidResultError('schema', first === undefined
    ? /* v8 ignore next -- A failed safeParse always supplies at least one issue. */ { field: 'result', rule: 'invalid-value' }
    : schemaIssue(raw, first))
}

function parseReviewerJson(text: string): unknown {
  const complete = text.trim()
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(complete)
  try { return JSON.parse((fence?.[1] ?? complete).trim()) }
  catch { throw new KnowledgeDiscoveryInvalidResultError('json-syntax') }
}

/** Require a content-term query that is not only the proposed title's words.
 * @param query - source-subject terms supplied by the reviewer.
 * @param title - Task or human page title that must not be the whole query.
 * @returns whether the query adds a distinct letter-or-number token.
 */
export function hasIndependentKnowledgeTerm(query: string, title: string): boolean {
  const tokens = (value: string) => value.trim().normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const titleTokens = new Set(tokens(title))
  return tokens(query).some(token => !titleTokens.has(token))
}

function requireComparedPages(comparedPages: readonly z.infer<typeof comparedPage>[],
  evidence: ProjectTaskKnowledgeDiscoveryEvidence): void {
  const expected = evidence.pages.map(page => [page.path, page.version] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))
  const actual = comparedPages.map(page => [page.path, page.version] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new KnowledgeDiscoveryInvalidResultError('compared-page-set')
  }
  for (const page of comparedPages) {
    if (page.relation === 'unrelated' || page.relation === 'unknown') continue
    const body = evidence.pages.find(item => item.path === page.path && item.version === page.version)?.body
    if (body === undefined || !body.includes(page.quote)) {
      throw new KnowledgeDiscoveryInvalidResultError('compared-page-quote')
    }
  }
}

function requireNoChangeRelations(comparedPages: readonly z.infer<typeof comparedPage>[]): void {
  if (comparedPages.some(page => page.relation === 'unknown' || page.relation === 'conflict'
    || page.relation === 'supersedes')) throw new KnowledgeDiscoveryInvalidResultError('compared-page-relation')
}

/** Serialize complete Task evidence without treating object field order as a content change.
 * @param evidence - complete evidence object; JSON values and array order remain unchanged.
 * @returns deterministic JSON shared by evidence digests and audited batch-source comparison.
 */
export function taskKnowledgeEvidenceJson(evidence: object): string {
  return JSON.stringify(evidence, (_key, value: unknown) => value !== null
    && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value)
}

/** Hash the immutable Task completion and full report without mutable verification or delivery fields.
 * @param workspaceId - original project identity.
 * @param taskId - completed Task identity.
 * @param completion - frozen terminal receipt; discovery and delivery are excluded.
 * @param researchReport - complete retained report when the Task produced one.
 * @param artifactDirectory - complete documentation version and digest, when the Task produced text files.
 * @param codingEvidenceSha256 - digest of complete version-checked coding output bodies, when available.
 * @param importedEvidenceSha256 - digest of explicitly selected, original-verified imported text.
 * @returns stable SHA-256 for later human decisions and writer revalidation.
 */
export function taskKnowledgeResultSha256(workspaceId: WorkspaceId, taskId: ProjectTaskId,
  completion: ProjectTaskCompletion, researchReport: string | undefined,
  artifactDirectory?: Pick<ArtifactTaskDirectory, 'id' | 'version' | 'digest'> & { readonly coverageSha256?: string | undefined },
  codingEvidenceSha256?: string, importedEvidenceSha256?: string): string {
  const input = { workspaceId, taskId,
    status: completion.status, completedAt: completion.completedAt, summary: completion.summary,
    summaryTruncated: completion.summaryTruncated, wrapUpSummary: completion.wrapUpSummary,
    researchReport: completion.researchReport, researchReportText: researchReport,
    artifactOutput: completion.artifactOutput,
    ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
    ...(codingEvidenceSha256 === undefined ? {} : { codingEvidenceSha256 }),
    ...(importedEvidenceSha256 === undefined ? {} : { importedEvidenceSha256 }),
  }
  const stable = artifactDirectory?.coverageSha256 === undefined ? JSON.stringify(input)
    : taskKnowledgeEvidenceJson(input)
  return createHash('sha256').update(stable).digest('hex')
}

/** Hash the complete Task state supplied to the discovery reviewer, including later review and verification evidence.
 * @param task - exact original-project Task snapshot sent to the reviewer.
 * @returns key-order-independent SHA-256 used to refuse a decision when that evidence changes.
 */
export function taskKnowledgeEvidenceSha256(task: ProjectTaskState): string {
  return createHash('sha256').update(taskKnowledgeEvidenceJson(task)).digest('hex')
}

/** Accept a retained Task digest only for identical values, including the former research-report field order.
 * @param task - current decoded Task state.
 * @param expected - digest retained with the immutable model candidate.
 * @returns whether current values match a current or known prior serialization.
 */
export function matchesTaskKnowledgeEvidenceSha256(task: ProjectTaskState, expected: string): boolean {
  if (taskKnowledgeEvidenceSha256(task) === expected) return true
  const report = task.researchReport
  if (report === undefined) return false
  const formerReport = { artifactId: report.artifactId, fileName: report.fileName, recovered: report.recovered,
    ...(report.contentSha256 === undefined ? {} : { contentSha256: report.contentSha256 }),
    summary: report.summary,
    ...(report.outputs === undefined ? {} : { outputs: report.outputs }),
    ...(report.preview === undefined ? {} : { preview: report.preview }) }
  return createHash('sha256').update(JSON.stringify({ ...task, researchReport: formerReport })).digest('hex') === expected
}

/** Hash the complete retained model candidate before any human destination is selected.
 * @param candidate - strict model result persisted by the Task owner.
 * @returns SHA-256 of the unchanged candidate text and page comparison.
 */
export function taskKnowledgeCandidateSha256(candidate: Extract<ProjectTaskKnowledgeDiscovery, { status: 'candidate' }>): string {
  return createHash('sha256').update(JSON.stringify({ kind: candidate.kind, summary: candidate.summary,
    proposedTruth: candidate.proposedTruth, evidence: candidate.evidence,
    comparedPages: candidate.comparedPages,
    ...(candidate.comparisonFormat === undefined ? {} : { comparisonFormat: candidate.comparisonFormat }),
    ...(candidate.taskEvidenceSha256 === undefined ? {} : { taskEvidenceSha256: candidate.taskEvidenceSha256 }),
    ...(candidate.codingEvidenceSha256 === undefined ? {} : { codingEvidenceSha256: candidate.codingEvidenceSha256 }),
    ...(candidate.codingOmissions === undefined ? {} : { codingOmissions: candidate.codingOmissions }),
    ...(candidate.artifactDirectory === undefined ? {} : { artifactDirectory: candidate.artifactDirectory }),
    ...(candidate.artifactCoverage === undefined ? {} : { artifactCoverage: candidate.artifactCoverage }),
    ...(candidate.importedCoverage === undefined ? {} : { importedCoverage: candidate.importedCoverage }),
    ...(candidate.importedDocxCoverage === undefined ? {} : { importedDocxCoverage: candidate.importedDocxCoverage }),
    ...(candidate.topicSearch === undefined ? {} : { topicSearch: candidate.topicSearch }),
    ...(candidate.sourceDispositions === undefined ? {} : { sourceDispositions: candidate.sourceDispositions }),
    ...(candidate.batchReviews === undefined ? {} : { batchReviews: candidate.batchReviews }) })).digest('hex')
}

/** Parse one logged page-slice response against exactly the full bodies admitted to that call.
 * @param text - complete reviewer output.
 * @param evidence - exact captured page slice.
 * @returns a bounded-by-caller finding and one verified relation per supplied page.
 */
export function parseKnowledgePageBatch(text: string,
  evidence: ProjectTaskKnowledgeDiscoveryEvidence): z.infer<typeof pageBatchResultSchema> {
  const raw = parseReviewerJson(text)
  const result = pageBatchResultSchema.safeParse(raw)
  if (!result.success) rejectSchema(raw, result.error.issues)
  requireComparedPages(result.data.comparedPages, evidence)
  return result.data
}

/** Parse a complete JSON decision, optionally enclosed by one whole-response JSON Markdown fence.
 * @param text - one completed tool-free assistant response; surrounding prose is rejected.
 * @param evidence - Host-captured original-project Brain evidence.
 * @returns validated candidate or no-change; model page claims cannot expand the captured set.
 */
export function parseTaskKnowledgeDiscovery(text: string,
  evidence: ProjectTaskKnowledgeDiscoveryEvidence): z.infer<typeof resultSchema> {
  const raw = parseReviewerJson(text)
  const result = resultSchema.safeParse(raw)
  if (!result.success) rejectSchema(raw, result.error.issues)
  const parsed = result.data
  requireComparedPages(parsed.comparedPages, evidence)
  if (parsed.decision === 'no-change') requireNoChangeRelations(parsed.comparedPages)
  return parsed
}

/** Parse a reviewer verdict; a new page must name independent source-subject search terms.
 * @param text - complete tool-free reviewer output, optionally enclosed by one JSON Markdown fence.
 * @param evidence - complete original-project Brain evidence supplied to that reviewer.
 * @param initialQuery - initial Task-title search, never the proposed page-title search.
 * @param sources - exact Host-readable sources, when the caller requires per-source review.
 * @returns a compared-page verdict with a required topic query for new pages.
 */
export function parseKnowledgeDiscoveryWithTopic(text: string, evidence: ProjectTaskKnowledgeDiscoveryEvidence,
  initialQuery: string, sources?: readonly KnowledgeDiscoverySource[]): z.infer<typeof topicResultSchema> {
  const raw = parseReviewerJson(text)
  const result = topicResultSchema.safeParse(raw)
  if (!result.success) {
    if (typeof raw === 'object' && raw !== null && 'decision' in raw && 'topicQuery' in raw) {
      if (raw.decision === 'no-change' || raw.decision === 'candidate'
        && 'kind' in raw && (raw.kind === 'existing-page' || raw.kind === 'conflict')) {
        throw new KnowledgeDiscoveryInvalidResultError('unexpected-topic-query',
          { field: 'topicQuery', rule: 'unexpected-field' })
      }
      if (raw.decision === 'candidate' && 'kind' in raw && raw.kind === 'new-page'
        && (typeof raw.topicQuery !== 'string' || raw.topicQuery.trim().length === 0
          || raw.topicQuery.trim().length > 256)) {
        const rule = typeof raw.topicQuery !== 'string' ? 'type'
          : raw.topicQuery.trim().length === 0 ? 'empty' : 'too-long'
        throw new KnowledgeDiscoveryInvalidResultError('new-page-topic-query', { field: 'topicQuery', rule })
      }
    }
    rejectSchema(raw, result.error.issues)
  }
  const parsed = result.data
  requireComparedPages(parsed.comparedPages, evidence)
  if (parsed.decision === 'no-change' && sources !== undefined) {
    requireNoChangeSourceDispositions(parsed.sourceDispositions, sources)
  }
  if (parsed.decision === 'no-change') requireNoChangeRelations(parsed.comparedPages)
  if (parsed.decision === 'candidate') {
    if (sources !== undefined && parsed.sourceDispositions !== undefined) {
      requireKnowledgeSourceDispositions(parsed.sourceDispositions, sources)
    }
    if (parsed.kind === 'new-page') {
      if (parsed.topicQuery === undefined || !hasIndependentKnowledgeTerm(parsed.topicQuery, initialQuery)) {
        throw new KnowledgeDiscoveryInvalidResultError('new-page-topic-query', { field: 'topicQuery',
          rule: parsed.topicQuery === undefined ? 'missing' : 'invalid-value' })
      }
    } else if (parsed.topicQuery !== undefined) {
      throw new KnowledgeDiscoveryInvalidResultError('unexpected-topic-query',
        { field: 'topicQuery', rule: 'unexpected-field' })
    }
  }
  return parsed
}
