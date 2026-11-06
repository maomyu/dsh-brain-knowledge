/** Temporary report execution and source-conversation publication; Brain files are never written. */
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FsDirEntry } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ArtifactPreviewId, ArtifactRenditionId, ArtifactTaskId, ArtifactType } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type {} from '@deepseek-ai/dsh-api-artifact-controller'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectTaskRecord } from './records.ts'
import type { ProjectResearchReport, ProjectTaskId, ProjectTaskLiveOutput, ProjectTaskOutputFileContent,
  ProjectTaskOutputFileId, ProjectTaskResearchCheckpoint } from './types.ts'
import type { NativeTaskTools } from '@deepseek-ai/dsh-subagent/native-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TaskOutputConfig } from './task-output-files.ts'
import { observeTaskOutputCheckpoints, readTaskOutputCheckpoint, retainTaskOutputCheckpoint,
  type TaskOutputCheckpoint } from './task-output-checkpoints.ts'
import { installResearchWaves, type ResearchWorkersConfig } from './research-waves.ts'

const misplacedDeliverableExtensions = new Set(['.pptx', '.ppt', '.key', '.docx', '.doc', '.xlsx', '.xls', '.pdf', '.md', '.markdown', '.html', '.htm'])

function researchArtifactType(fileName: string): ArtifactType {
  const extension = extname(fileName).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension) ? 'images'
    : ['.ppt', '.pptx', '.key'].includes(extension) ? 'decks' : 'reports'
}

/** Host-owned temporary allocation, verified before use or removal. */
export const researchDirectorySchema = z.object({ path: z.string().min(1), device: z.number().int(), inode: z.number().int() }).strict()
/** Retained artifact identity, completion-time content digest and bounded summary; report bytes stay in project files. */
export const researchReportSchema = z.object({
  artifactId: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
  fileName: z.string().min(1), recovered: z.boolean(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  preview: z.object({ id: z.string().min(1).transform(value => brandString<ArtifactPreviewId>(value)),
    fileName: z.string().min(1) }).strict().optional(),
  outputs: z.array(z.object({
    artifactId: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
    fileName: z.string().min(1),
  }).strict()).readonly().optional(),
  summary: z.object({ title: z.string().optional(), confidence: z.enum(['high', 'medium', 'low']).optional(),
    sourceCount: z.number().int().nonnegative().nullable(), gapCount: z.number().int().nonnegative().nullable() }).strict(),
}).strict()

/** Deployment limits for the research supervisor and its permitted read capabilities. */
export interface ResearchConfig {
  /** Inclusive UTF-8 limit for a complete written or recovered report. */
  readonly maxReportBytes: number
  /** Maximum model steps admitted for one research supervisor. */
  readonly maxSteps: number
  /** Maximum entries admitted from the temporary output directory. */
  readonly maxOutputFiles: number
  /** Inclusive byte limit for all collected output content together. */
  readonly maxOutputBytes: number
  /** Inclusive serialized Host checkpoint data across all native writes, including revisions. */
  readonly maxCheckpointAuditBytes: number
  /** Tool names permitted alongside report writing; installed access policies still apply. */
  readonly readTools: string[]
}

/** Logged supervisor instructions; producing a report is distinct from publishing knowledge. */
export const researchInstruction = [
  'Conduct the requested deep research. Read the selected project knowledge before researching.',
  'Investigate the brief as orthogonal questions, reconcile conflicting evidence and distinguish facts from inference.',
  'Use research_wave for independent sub-questions. Reassess findings after each wave; stop when answered, no new evidence appears, or the wave budget is exhausted.',
  'If delegation is unavailable, research serially. Reserve enough model steps to synthesize and write the report.',
  'Produce one Markdown report: an H1 title, brief recap, findings for each question, source evidence with numbered inline citations,',
  'a numbered Sources section containing titles and URLs, Overall confidence (high, medium or low), and a Gaps section.',
  'Use write_research_report to retain the complete report. Use write_research_file for complete supplemental Markdown, HTML, Office, PDF or other output files; paths are safe filenames under private out, and binary bytes require canonical base64.',
  'Use read_research_file to inspect acknowledged UTF-8 output before revision. If report writing fails, return the complete Markdown report as assistant text.',
  'The report is an artifact, not Brain knowledge. Do not modify project files, write Brain pages, create coding tasks, branches or commits.',
].join('\n')

/** Native research uses task-owned private output checkpoints without source-file or command write permission. */
export const nativeResearchInstruction = [
  'Conduct the requested research using the supplied project knowledge and your available read-only tools.',
  'Reconcile conflicting evidence, cite sources, distinguish facts from inference and disclose missing evidence.',
  'Return the complete Markdown report as your final answer: an H1 title, brief recap, findings with numbered inline citations,',
  'a numbered Sources section containing titles and URLs, Overall confidence (high, medium or low), and a Gaps section.',
  'Use write_research_report for the complete report and write_research_file for complete supplemental output files. Use safe filenames under private out, UTF-8 text or canonical base64 bytes, and read_research_file to inspect acknowledged UTF-8 output.',
  'Only these task-owned Host tools may write private research output. Do not use native file tools, commands or external services to write files; original project and Brain files remain read-only.',
  'The application saves the acknowledged files after successful completion. If no report was acknowledged, return the complete report as your final answer for Host recovery.',
  'Do not create coding tasks, branches or commits. Do not claim tools or sources were used when they were unavailable.',
].join('\n')

function qualifyingReport(text: string): boolean {
  return text.trimStart().length >= 500 && /^#[ \t]+\S/.test(text.trimStart())
    && /^#{1,6}[ \t]+(?:(?:sources|references)\b|来源|参考资料)/im.test(text) && /https?:\/\//i.test(text)
}

/** Recover qualifying report text from the admitted Harness turn or successful native final result.
 * @param events - validated durable task Session events.
 * @param record - exact admitted execution receipt.
 * @returns complete report text, excluding tool results, reasoning, attempts and other turns.
 */
export function recoverResearchText(events: readonly SessionEvent[], record: ProjectTaskRecord): string | undefined {
  if (record.execution?.runtime === 'codex' || record.execution?.runtime === 'claude') {
    for (const event of events) {
      if ((event.type !== 'project-task/codex' && event.type !== 'project-task/claude')
        || event.type !== `project-task/${record.execution.runtime}`
        || event.data.messageId !== record.execution.messageId || event.data.kind !== 'result') continue
      return event.data.status === 'closed-success' && qualifyingReport(event.data.output) ? event.data.output : undefined
    }
    return undefined
  }
  let entered = false
  let result: string | undefined
  for (const event of events) {
    if (entered && (event.type === 'turn/start' || event.type === 'turn/end')) break
    if (event.type === 'user/message' && event.data.id === record.execution?.messageId) entered = true
    if (!entered || event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type !== 'text') continue
      if (qualifyingReport(block.text)) result = block.text
    }
  }
  return result
}

type ReportBlock = ReturnType<typeof fromMarkdown>['children'][number]
type ReportNode = { readonly type: string
  readonly value?: string
  readonly children?: readonly ReportNode[] }

function reportText(node: ReportNode): string {
  return node.value ?? node.children?.map(reportText).join('') ?? ''
}

function reportSection(nodes: readonly ReportBlock[], name: RegExp) {
  const matches = nodes.flatMap((node, index) => node.type === 'heading' && name.test(reportText(node).trim()) ? [{ node, index }] : [])
  const [match] = matches
  if (matches.length !== 1 || match === undefined) return undefined
  const { node: heading, index: start } = match
  const end = nodes.findIndex((node, index) => index > start && node.type === 'heading' && node.depth <= heading.depth)
  return { heading: reportText(heading).trim(), body: nodes.slice(start + 1, end === -1 ? undefined : end) }
}

function reportSectionCount(section: ReturnType<typeof reportSection>): number | null {
  if (section === undefined || section.body.length === 0) return null
  const [first] = section.body
  if (section.body.length === 1 && first?.type === 'paragraph'
    && /^(?:none[.!]?|无[。！]?)$/i.test(reportText(first).trim())) return 0
  let total = 0
  for (const node of section.body) {
    if (node.type === 'list') total += node.children.length
    else if (node.type === 'paragraph') {
      const lines = reportText(node).trim().split(/\r?\n/)
      if (!lines.every(line => /^\[\d+\][ \t]+\S/.test(line))) return null
      total += lines.length
    } else return null
  }
  return total
}

/** Extract reported metadata without inferring evidence quality or counting prose as individual findings.
 * @param markdown - complete report text; code and quoted headings do not define report sections.
 * @returns title, declared confidence and top-level list counts; null means absent, ambiguous or unstructured counts.
 */
export function researchSummary(markdown: string): ProjectResearchReport['summary'] {
  const nodes = fromMarkdown(markdown).children
  const titleNode = nodes.find(node => node.type === 'heading' && node.depth === 1)
  const title = titleNode === undefined ? undefined : reportText(titleNode).trim()
  const section = reportSection(nodes, /^overall confidence\b/i)
  const declaration = section === undefined ? '' : section.heading.replace(/^overall confidence\s*[:：]?\s*/i, '')
    || (section.body[0]?.type === 'paragraph' ? reportText(section.body[0]).trim() : '')
  const confidence = declaration.match(/^(high|medium|low)(?![-\w])/i)?.[1]?.toLowerCase() as 'high' | 'medium' | 'low' | undefined
  return { ...(title === undefined ? {} : { title }), ...(confidence === undefined ? {} : { confidence }),
    sourceCount: reportSectionCount(reportSection(nodes, /^(?:sources|references)\b|^(?:来源|参考资料)$/i)),
    gapCount: reportSectionCount(reportSection(nodes, /^gaps\b|^(?:缺口|未解决问题)$/i)) }
}

/** Owns temporary files until the task's terminal record has been committed. */
type ActiveResearchFiles = { readonly sessionId: NonNullable<ProjectTaskRecord['execution']>['sessionId']
  readonly directory: z.infer<typeof researchDirectorySchema>
  readonly kind: 'harness' | 'native'
  readonly files: Map<string, TaskOutputCheckpoint> }

const researchFileInput = z.object({ fileName: z.string(), content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional() }).strict()
const researchReportInput = z.object({ markdown: z.string() }).strict()

/** Own bounded report and file publication for the currently admitted research execution. */
export class ResearchFiles {
  private readonly active = new Map<ProjectTaskId, ActiveResearchFiles>()
  /** @param ctx - matching Host filesystem and artifact publication services.
   * @param config - explicit report byte, model-step and read-tool limits.
   * @param outputConfig - bounded provisional metadata and selected-byte reads.
   */
  constructor(private readonly ctx: Context, private readonly config: ResearchConfig,
    private readonly outputConfig: TaskOutputConfig) {}

  /** Check whether this exact active research execution owns complete-file checkpoints.
   * @param record - retained Task allocation and execution identity.
   * @returns false after settlement, restart, or allocation replacement.
   */
  hasExecution(record: ProjectTaskRecord): boolean {
    const active = this.active.get(record.proposal.id), directory = record.researchDirectory
    return active !== undefined && directory !== undefined && record.execution !== undefined
      && active.sessionId === record.execution.sessionId && active.directory.path === directory.path
      && active.directory.device === directory.device && active.directory.inode === directory.inode
  }

  /** Observe only acknowledged complete files from the exact running research execution.
   * @param record - retained Task and original-project membership.
   * @param guard - repeated current execution and source authorization.
   * @param signal - observation lifetime.
   * @returns bounded provisional metadata, not publication or verified research.
   */
  async observe(record: ProjectTaskRecord, guard: () => void, signal: AbortSignal): Promise<Pick<ProjectTaskLiveOutput,
    'observedAt' | 'files' | 'truncated'>> {
    const active = this.current(record)
    guard(); await this.validate(active.directory)
    const observed = await observeTaskOutputCheckpoints(active.files, this.outputConfig,
      (fileName, checkpoint) => this.verifyCheckpoint(record, active, fileName, checkpoint, signal), guard, signal)
    await this.validate(active.directory); guard()
    return observed
  }

  /** Read the complete version selected from this research execution's provisional inventory.
   * @param record - active research Task with its private allocation.
   * @param id - opaque file identity, never a caller-supplied path.
   * @param version - exact observed version.
   * @param guard - current execution and source authorization around I/O.
   * @param signal - selected-read lifetime.
   * @returns complete acknowledged bytes, or a stale/unavailable refusal.
   */
  read(record: ProjectTaskRecord, id: ProjectTaskOutputFileId, version: string, guard: () => void,
    signal: AbortSignal): Promise<ProjectTaskOutputFileContent> {
    const active = this.current(record)
    return readTaskOutputCheckpoint(active.files, id, version,
      (fileName, checkpoint) => this.verifyCheckpoint(record, active, fileName, checkpoint, signal), guard, signal)
  }

  private current(record: ProjectTaskRecord): ActiveResearchFiles {
    const active = this.active.get(record.proposal.id)
    if (active === undefined || !this.hasExecution(record)) {
      throw new RemoteError('project-task/output-file', 'Task research output is unavailable.', { reason: 'unavailable' })
    }
    return active
  }

  private async verifyCheckpoint(record: ProjectTaskRecord, active: ActiveResearchFiles, fileName: string,
    checkpoint: TaskOutputCheckpoint, signal: AbortSignal): Promise<boolean> {
    await this.validate(active.directory)
    if (active.kind === 'native') return true
    const info = await this.ctx.fs.stat(await this.output(record, signal, fileName), signal)
    await this.validate(active.directory)
    return info?.type === 'file' && info.version === checkpoint.file.version && info.size === checkpoint.file.bytes
  }

  private fileBytes(input: z.infer<typeof researchFileInput>): Buffer {
    const fileName = input.fileName
    if (!fileName || fileName === '.' || fileName === '..' || fileName.startsWith('.')
      || /[\\/:\u0000-\u001f\u007f]/u.test(fileName)
      || Buffer.byteLength(fileName, 'utf8') > this.outputConfig.maxPathBytes) {
      throw new Error('Research output requires a safe, non-hidden filename within its path limit')
    }
    const limit = /\.(?:md|markdown)$/iu.test(fileName) ? Math.min(this.config.maxReportBytes, this.config.maxOutputBytes)
      : this.config.maxOutputBytes
    if (input.encoding === 'base64' ? input.content.length > Math.ceil(limit / 3) * 4
      : Buffer.byteLength(input.content, 'utf8') > limit) throw new Error('Research output file exceeds its byte limit')
    const bytes = Buffer.from(input.content, input.encoding ?? 'utf8')
    if (bytes.byteLength > limit || input.encoding === 'base64' && bytes.toString('base64') !== input.content) {
      throw new Error('Research output requires bounded complete bytes and canonical base64')
    }
    return bytes
  }

  private admitCheckpoint(files: Map<string, TaskOutputCheckpoint>, fileName: string, bytes: Buffer): void {
    if (files.size + (files.has(fileName) ? 0 : 1) > this.config.maxOutputFiles) throw new Error('Research output exceeds its file-count limit')
    let total = bytes.byteLength
    for (const [name, checkpoint] of files) if (name !== fileName) total += checkpoint.bytes.byteLength
    if (total > this.config.maxOutputBytes) throw new Error('Research output exceeds its total byte limit')
  }

  /** Allocate a private Host directory without copying the user's project.
   * @param signal - confirmation lifetime.
   * @returns canonical directory and its retained filesystem identity.
   */
  async prepare(signal: AbortSignal): Promise<z.infer<typeof researchDirectorySchema>> {
    signal.throwIfAborted()
    const path = await realpath(await mkdtemp(join(tmpdir(), 'dsh-research-')))
    const stat = await lstat(path)
    const directory = { path, device: stat.dev, inode: stat.ino }
    try {
      signal.throwIfAborted()
      if (this.ctx.fs.processPathFromHostPath(path) === undefined) throw new Error('Research requires a filesystem that can use its Host temporary directory')
      return directory
    } catch (error) { await this.remove(directory); throw error }
  }

  /** Verify a retained allocation before execution, collection or cleanup.
   * @param directory - committed allocation identity.
   * @returns after proving the path still names the owned real temporary directory.
   */
  async validate(directory: z.infer<typeof researchDirectorySchema>): Promise<void> {
    const parent = await realpath(tmpdir())
    const stat = await lstat(directory.path)
    if (dirname(directory.path) !== parent || !basename(directory.path).startsWith('dsh-research-')
      || !stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory.path) !== directory.path
      || stat.dev !== directory.device || stat.ino !== directory.inode) throw new Error('Research temporary directory identity changed')
  }

  /** Remove only the retained private directory after execution has quiesced.
   * @param directory - previously validated Host allocation.
   * @returns after removal; changed or linked paths remain untouched.
   */
  async remove(directory: z.infer<typeof researchDirectorySchema>): Promise<void> {
    await this.validate(directory)
    await rm(directory.path, { recursive: true, force: false })
  }

  /** Install complete private-output writes and a model-step cap in the research Agent scope.
   * @param agent - confirmed research supervisor, before input admission.
   * @param record - retained task, project and temporary allocation.
   * @param guard - recheck current project ownership at every write.
   * @param workers - independent researcher provider and execution limits.
   * @returns disposer for this installation; already admitted operations remain Agent-owned.
   */
  install(agent: Agent, record: ProjectTaskRecord, guard: () => void, workers: ResearchWorkersConfig): () => void {
    if (record.execution === undefined || record.researchDirectory === undefined) throw new Error('Research checkpoint execution is missing')
    const active: ActiveResearchFiles = { sessionId: record.execution.sessionId, directory: record.researchDirectory,
      kind: 'harness', files: new Map() }
    const allow = new Set([...this.config.readTools, 'write_research_report', 'write_research_file', 'read_research_file', 'research_wave'])
    const access = agent.ctx.tools.restrictAccess(name => allow.has(name))
    const off = agent.ctx.on('agent/pre-step', (request, next) => {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      if (request.agent.id === agent.id && agent.session.snapshotEvents().filter(event => event.type === 'step/start').length >= this.config.maxSteps) {
        throw new Error('Research model-step limit reached before a complete report was collected')
      }
      return next()
    })
    const releases: Array<() => void> = []
    let writes: Promise<unknown> = Promise.resolve()
    const write = (input: z.infer<typeof researchFileInput>, signal: AbortSignal): Promise<void> => {
      const save = async (): Promise<void> => {
        signal.throwIfAborted(); guard(); await this.validate(active.directory)
        const bytes = this.fileBytes(input)
        this.admitCheckpoint(active.files, input.fileName, bytes)
        const target = await this.output(record, signal, input.fileName)
        guard()
        const revised = active.files.has(input.fileName)
        active.files.delete(input.fileName)
        const policy = { mode: 'workspace-write' as const, workspaceRoot: active.directory.path }
        const version = input.encoding === 'base64'
          ? await this.ctx.fs.createBytes(target, bytes, signal, policy)
          : (await this.ctx.fs.writeText(target, input.content, undefined, signal, policy)).version
        await this.validate(active.directory); guard(); signal.throwIfAborted()
        retainTaskOutputCheckpoint(record.proposal.id, active.files, input.fileName, version, bytes,
          this.outputConfig.maxReadBytes, revised)
      }
      const pending = writes.then(save, save)
      writes = pending
      return pending
    }
    try {
      const tool = agent.ctx.tools.register(defineTool({
        name: 'write_research_report',
        description: 'Save the complete Markdown research report in this task’s temporary output. This does not publish Brain knowledge.',
        parameters: { markdown: { type: 'string', required: true, description: 'Complete Markdown report with findings, citations, Sources, confidence and Gaps.' } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'boolean', required: true } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async ({ markdown }, exec) => {
          if (exec.agent?.id !== agent.id) throw new Error('Only the research supervisor can write its report')
          await write({ fileName: 'report.md', content: markdown }, exec.signal)
          return { saved: true }
        },
      }))
      releases.push(tool)
      releases.push(agent.ctx.tools.register(defineTool({ name: 'write_research_file',
        description: 'Save one complete supplemental file in this research Task’s private out directory. Text can be revised; binary bytes use canonical base64 and exclusive creation. Original project and Brain files remain read-only.',
        parameters: { fileName: { type: 'string', required: true, description: 'Safe non-hidden filename under private out, without directory components.' },
          content: { type: 'string', required: true, description: 'Complete UTF-8 text or canonical base64 bytes.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Omission means UTF-8 text.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (input, exec) => {
          if (exec.agent?.id !== agent.id) throw new Error('Only the research supervisor can write output')
          await write(input, exec.signal)
          return `Saved out/${input.fileName}`
        },
      })))
      releases.push(agent.ctx.tools.register(defineTool({ name: 'read_research_file',
        description: 'Read an acknowledged complete UTF-8 research output file for revision.',
        parameters: { fileName: { type: 'string', required: true, description: 'Exact filename of an acknowledged private output.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async ({ fileName }, exec) => {
          if (exec.agent?.id !== agent.id) throw new Error('Only the research supervisor can read private output')
          const checkpoint = active.files.get(fileName)
          if (checkpoint === undefined) throw new Error('Research file has no acknowledged complete checkpoint')
          const content = await this.read(record, checkpoint.file.id, checkpoint.file.version, guard, exec.signal)
          return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content.dataBase64, 'base64'))
        },
      })))
      const waves = installResearchWaves(this.ctx, agent, record, workers, this.config.readTools, guard)
      this.active.set(record.proposal.id, active)
      return () => {
        if (this.active.get(record.proposal.id) === active) this.active.delete(record.proposal.id)
        waves(); for (const release of releases.reverse()) release(); off(); access()
      }
    } catch (error) { for (const release of releases.reverse()) release(); off(); access(); throw error }
  }

  /** Acknowledge native private-output files only after their dedicated Host audit events flush.
   * @param record - newly confirmed native research execution and protocol marker.
   * @param guard - original source and current Task authorization.
   * @param append - execution-owned ordered append and flush, never a worker notification.
   * @returns task-owned tools and a disposer used after admitted calls and the native child join.
   */
  openNative(record: ProjectTaskRecord, guard: () => void,
    append: (checkpoint: ProjectTaskResearchCheckpoint) => Promise<void>): {
    tools: NativeTaskTools
    [Symbol.asyncDispose](): Promise<void>
  } {
    const directory = record.researchDirectory, execution = record.execution
    if (directory === undefined || execution === undefined || (execution.runtime !== 'codex' && execution.runtime !== 'claude')
      || record.researchWriteProtocol !== 'host-checkpoint-v1') throw new Error('Native research checkpoint execution is missing')
    const active: ActiveResearchFiles = { sessionId: execution.sessionId, directory, kind: 'native', files: new Map() }
    this.active.set(record.proposal.id, active)
    let writes: Promise<unknown> = Promise.resolve(), auditBytes = 0
    const authorize = async (signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted(); guard(); await this.validate(directory); guard(); signal.throwIfAborted()
    }
    const write = (input: z.infer<typeof researchFileInput>, signal: AbortSignal) => {
      const save = async () => {
        await authorize(signal)
        const bytes = this.fileBytes(input)
        this.admitCheckpoint(active.files, input.fileName, bytes)
        const checkpoint: ProjectTaskResearchCheckpoint = { fileName: input.fileName, dataBase64: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex') }
        const size = Buffer.byteLength(JSON.stringify({ messageId: execution.messageId,
          kind: 'research-output-checkpoint-v1', ...checkpoint }), 'utf8')
        if (size > this.config.maxCheckpointAuditBytes - auditBytes) throw new Error('Research checkpoint audit exceeds its byte limit')
        await append(checkpoint)
        auditBytes += size
        await authorize(signal)
        retainTaskOutputCheckpoint(record.proposal.id, active.files, input.fileName, checkpoint.sha256, bytes,
          this.outputConfig.maxReadBytes)
        return { text: `Saved out/${input.fileName}`, isError: false as const }
      }
      const pending = writes.then(save, save)
      writes = pending
      return pending
    }
    return { tools: { definitions: [
      { name: 'write_research_report', readOnly: false,
        description: 'Save the complete Markdown report in this Task’s private research output; original project and Brain files remain read-only.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['markdown'],
          properties: { markdown: { type: 'string', description: 'Complete Markdown research report.' } } } },
      { name: 'write_research_file', readOnly: false,
        description: 'Save one complete supplemental file in this Task’s private research output. Text can be revised; binary content requires canonical base64.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['fileName', 'content'], properties: {
          fileName: { type: 'string', description: 'Safe non-hidden filename below private out, without directory components.' },
          content: { type: 'string', description: 'Complete UTF-8 text or canonical base64 bytes.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
        } } },
      { name: 'read_research_file', description: 'Read an acknowledged complete UTF-8 research file for revision.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['fileName'],
          properties: { fileName: { type: 'string', description: 'Exact acknowledged private-output filename.' } } } },
    ], call: async (name, args, signal) => {
      if (name === 'write_research_report') {
        const input = researchReportInput.parse(args)
        return write({ fileName: 'report.md', content: input.markdown }, signal)
      }
      if (name === 'write_research_file') return write(researchFileInput.parse(args), signal)
      if (name !== 'read_research_file') throw new Error('This Task permits only its advertised research-output tools')
      const input = z.object({ fileName: z.string() }).strict().parse(args)
      await authorize(signal)
      const known = active.files.get(input.fileName)
      if (known === undefined) throw new Error('Research file has no acknowledged complete checkpoint')
      const content = await this.read(record, known.file.id, known.file.version, guard, signal)
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content.dataBase64, 'base64')), isError: false }
    } }, [Symbol.asyncDispose]: () => {
      if (this.active.get(record.proposal.id) === active) this.active.delete(record.proposal.id)
      return Promise.resolve()
    } }
  }

  private async collectNative(record: ProjectTaskRecord, events: readonly SessionEvent[],
    signal: AbortSignal): Promise<ProjectResearchReport> {
    const execution = record.execution
    /* v8 ignore if -- retained host-checkpoint-v1 records require native execution. */
    if (execution === undefined || (execution.runtime !== 'codex' && execution.runtime !== 'claude')) throw new Error('Native research execution is missing')
    const files = new Map<string, TaskOutputCheckpoint>()
    let successful = false, auditBytes = 0
    for (const event of events) {
      signal.throwIfAborted()
      if ((event.type !== 'project-task/codex' && event.type !== 'project-task/claude')
        || event.type !== `project-task/${execution.runtime}` || event.data.messageId !== execution.messageId) continue
      if (event.data.kind === 'result') { successful = event.data.status === 'closed-success'; break }
      if (event.data.kind !== 'research-output-checkpoint-v1') continue
      const checkpoint = z.object({ messageId: z.string().min(1), kind: z.literal('research-output-checkpoint-v1'),
        fileName: z.string(), dataBase64: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict().parse(event.data)
      auditBytes += Buffer.byteLength(JSON.stringify(checkpoint), 'utf8')
      if (auditBytes > this.config.maxCheckpointAuditBytes) throw new Error('Research checkpoint audit exceeds its byte limit')
      const bytes = this.fileBytes({ fileName: checkpoint.fileName, content: checkpoint.dataBase64, encoding: 'base64' })
      if (createHash('sha256').update(bytes).digest('hex') !== checkpoint.sha256) throw new Error('Research checkpoint digest changed')
      this.admitCheckpoint(files, checkpoint.fileName, bytes)
      retainTaskOutputCheckpoint(record.proposal.id, files, checkpoint.fileName, checkpoint.sha256, bytes,
        this.outputConfig.maxReadBytes)
    }
    if (!successful) throw new Error('Native research has no successful terminal receipt')
    let recovered = false
    if (![...files.keys()].some(fileName => fileName.toLowerCase().endsWith('.md'))) {
      const report = recoverResearchText(events, record)
      if (report === undefined) throw new Error('Native research produced no complete Markdown report')
      const bytes = this.fileBytes({ fileName: 'report.md', content: report })
      this.admitCheckpoint(files, 'report.md', bytes)
      retainTaskOutputCheckpoint(record.proposal.id, files, 'report.md', createHash('sha256').update(bytes).digest('hex'), bytes,
        this.outputConfig.maxReadBytes)
      recovered = true
    }
    const staging = await this.prepare(signal)
    const staged = { ...record, researchDirectory: staging, researchWriteProtocol: undefined }
    try {
      for (const [fileName, checkpoint] of files) {
        const target = await this.output(staged, signal, fileName)
        await this.ctx.fs.createBytes(target, checkpoint.bytes, signal, { mode: 'workspace-write', workspaceRoot: staging.path })
      }
      return { ...await this.collect(staged, events, signal), recovered }
    } finally { await this.remove(staging) }
  }

  /** Collect flat and known misplaced deliverables; recover assistant text only when no output exists.
   * @param record - original source and execution ownership.
   * @param events - the task's validated durable Session events.
   * @param signal - controller collection lifetime.
   * @returns the report and every flat output identity; publication is file-atomic, not batch-atomic.
   */
  async collect(record: ProjectTaskRecord, events: readonly SessionEvent[], signal: AbortSignal): Promise<ProjectResearchReport> {
    if (record.researchWriteProtocol === 'host-checkpoint-v1') return this.collectNative(record, events, signal)
    const source = record.proposal.research
    if (source === undefined || record.researchDirectory === undefined) throw new Error('Research ownership is missing')
    await this.validate(record.researchDirectory)
    const standard = await this.output(record, signal)
    const out = await this.ctx.fs.resolve('out', { cwd: record.researchDirectory.path, signal })
    const directory = await this.ctx.fs.stat(out, signal)
    let files = directory === undefined ? [] : await this.ctx.fs.listDir(out, signal)
    if (files.length > this.config.maxOutputFiles) throw new Error('Research output exceeds its file-count limit')
    await this.salvage(record, files, signal)
    files = await this.ctx.fs.stat(out, signal) === undefined ? [] : await this.ctx.fs.listDir(out, signal)
    if (files.length > this.config.maxOutputFiles) throw new Error('Research output exceeds its file-count limit')
    const regular = files.filter(file => file.type === 'file')
    const selected = regular.find(file => file.name.toLowerCase() === 'report.md')
      ?? regular.find(file => file.name.toLowerCase().endsWith('.md'))
    const target = selected === undefined ? standard : await this.output(record, signal, selected.name)
    const info = await this.ctx.fs.stat(target, signal)
    let markdown: string | undefined
    let recovered = false
    if (info === undefined && files.length === 0) { markdown = recoverResearchText(events, record); recovered = markdown !== undefined }
    else if (info === undefined) throw new Error('Research output contains no Markdown report')
    else {
      if (info.type !== 'file') throw new Error('Research report is not a regular file')
      const bytes = await this.ctx.fs.readBytes(target, signal, this.config.maxReportBytes)
      if ((await this.ctx.fs.stat(target, signal))?.version !== info.version) throw new Error('Research report changed during collection')
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
    if (markdown === undefined) throw new Error('Research produced no report')
    if (Buffer.byteLength(markdown, 'utf8') > this.config.maxReportBytes) throw new Error('Research report exceeds its byte limit')
    let total = Buffer.byteLength(markdown, 'utf8')
    if (total > this.config.maxOutputBytes) throw new Error('Research output exceeds its total byte limit')
    const additional: Array<{ name: string; bytes: Uint8Array }> = []
    for (const file of regular) {
      if (file === selected) continue
      const output = await this.output(record, signal, file.name)
      const before = await this.ctx.fs.stat(output, signal)
      const bytes = await this.ctx.fs.readBytes(output, signal, this.config.maxOutputBytes)
      if (before === undefined || (await this.ctx.fs.stat(output, signal))?.version !== before.version) {
        throw new Error('Research output changed during collection')
      }
      total += bytes.byteLength
      if (total > this.config.maxOutputBytes) throw new Error('Research output exceeds its total byte limit')
      additional.push({ name: file.name, bytes })
    }
    const preview = await this.preview(record, signal)
    if (total + (preview?.bytes.byteLength ?? 0) > this.config.maxOutputBytes) throw new Error('Research output exceeds its total byte limit')
    const summary = researchSummary(markdown)
    const slug = record.proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'report'
    const fileName = selected !== undefined && selected.name.toLowerCase() !== 'report.md'
      ? selected.name : `${slug}-${record.proposal.id.slice(0, 8)}.md`
    const artifactId = await this.ctx.artifactController.publishReport(record.workspaceId, record.workspacePath,
      source.sourceSessionId, fileName, markdown, signal)
    const outputs = [{ artifactId, fileName }]
    for (const file of additional) {
      const id = await this.ctx.artifactController.publishFile(record.workspaceId, record.workspacePath,
        source.sourceSessionId, researchArtifactType(file.name), file.name, file.bytes, signal)
      outputs.push({ artifactId: id, fileName: file.name })
    }
    const retainedPreview = preview === undefined ? undefined : await this.ctx.artifactController.publishPreview(
      record.workspaceId, record.workspacePath, source.sourceSessionId, brandString<ArtifactTaskId>(record.proposal.id),
      additional.some(file => researchArtifactType(file.name) === 'decks') ? 'decks' : 'reports', preview.fileName, preview.bytes, signal)
    outputs.sort((left, right) => left.fileName.localeCompare(right.fileName))
    return { artifactId, fileName, recovered, contentSha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
      summary, outputs, ...(retainedPreview === undefined ? {} : { preview: retainedPreview }) }
  }

  private async preview(record: ProjectTaskRecord, signal: AbortSignal) {
    const directory = record.researchDirectory
    /* v8 ignore if -- collect checked the same captured record's research directory before I/O. */
    if (directory === undefined) throw new Error('Research temporary directory is missing')
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      const fileName = `preview.${extension}`
      if ((await this.ctx.fs.lstat(fileName, { cwd: directory.path }, signal))?.type !== 'file') continue
      const target = await this.output(record, signal, fileName, [])
      const before = await this.ctx.fs.stat(target, signal)
      const bytes = await this.ctx.fs.readBytes(target, signal, this.config.maxOutputBytes)
      if (before === undefined || (await this.ctx.fs.stat(target, signal))?.version !== before.version) {
        throw new Error('Research preview changed during collection')
      }
      return { fileName, bytes }
    }
    return undefined
  }

  private async salvage(record: ProjectTaskRecord, existing: readonly FsDirEntry[], signal: AbortSignal) {
    const directory = record.researchDirectory
    /* v8 ignore if -- collect checked the same captured record's research directory before I/O. */
    if (directory === undefined) throw new Error('Research temporary directory is missing')
    let count = existing.length
    let total = 0
    const admitBytes = (size: number) => {
      total += size
      if (total > this.config.maxOutputBytes) throw new Error('Research output exceeds its total byte limit')
    }
    for (const file of existing) {
      if (file.type !== 'file') continue
      const target = await this.output(record, signal, file.name)
      admitBytes((await this.ctx.fs.readBytes(target, signal, this.config.maxOutputBytes)).byteLength)
    }
    for (const parents of [[], ['templates', 'out'], ['slides', 'out'], ['work', 'out']]) {
      const root = await this.ctx.fs.resolve(directory.path, { signal })
      let folder = root
      let present = true
      for (const segment of parents) {
        const cwd = this.ctx.fs.processPath(folder)
        if ((await this.ctx.fs.lstat(segment, { cwd }, signal))?.type !== 'directory') { present = false; break }
        folder = await this.ctx.fs.resolve(segment, { cwd, signal })
        if (!this.ctx.fs.contains(root, folder)) throw new Error('Research output leaves its temporary directory')
      }
      if (!present) continue
      for (const file of await this.ctx.fs.listDir(folder, signal)) {
        if (file.type !== 'file' || !misplacedDeliverableExtensions.has(extname(file.name).toLowerCase())) continue
        if (parents.length === 0 && (file.name.startsWith('.') || file.name === 'README.md' || file.name === 'README.seed.md')) continue
        if ((await this.ctx.fs.lstat(file.name, { cwd: this.ctx.fs.processPath(folder) }, signal))?.type !== 'file') continue
        const destination = await this.output(record, signal, file.name)
        if (await this.ctx.fs.stat(destination, signal) !== undefined) continue
        if (count >= this.config.maxOutputFiles) throw new Error('Research output exceeds its file-count limit')
        const source = await this.output(record, signal, file.name, parents)
        const before = await this.ctx.fs.stat(source, signal)
        const bytes = await this.ctx.fs.readBytes(source, signal, this.config.maxOutputBytes)
        if (before === undefined || (await this.ctx.fs.stat(source, signal))?.version !== before.version) {
          throw new Error('Research output changed during collection')
        }
        admitBytes(bytes.byteLength)
        // Keep private source files until terminal cleanup; exclusive creation preserves earlier outputs.
        await this.ctx.fs.createBytes(destination, bytes, signal, { mode: 'workspace-write', workspaceRoot: directory.path })
        count++
      }
    }
  }

  private async output(record: ProjectTaskRecord, signal: AbortSignal, fileName = 'report.md', parents: readonly string[] = ['out']) {
    const directory = record.researchDirectory
    /* v8 ignore if -- callers check this captured directory (including current/hasExecution) or supply fresh staging. */
    if (directory === undefined) throw new Error('Research temporary directory is missing')
    let target = await this.ctx.fs.resolve(directory.path, { signal })
    const root = target
    if (fileName === '.' || fileName === '..' || /[\\/\u0000]/.test(fileName)) throw new Error('Research output filename is unsafe')
    for (const [index, segment] of [...parents, fileName].entries()) {
      const cwd = this.ctx.fs.processPath(target)
      const info = await this.ctx.fs.lstat(segment, { cwd }, signal)
      if (info !== undefined && info.type !== (index === parents.length ? 'file' : 'directory')) throw new Error('Research output contains a link or unsupported file')
      target = await this.ctx.fs.resolve(segment, { cwd, signal })
      if (!this.ctx.fs.contains(root, target)) throw new Error('Research output leaves its temporary directory')
    }
    return target
  }
}
