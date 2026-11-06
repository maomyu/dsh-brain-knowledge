/** Markdown health reports keep their findings and history outside the ordinary Brain page index. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { knowledgeSource } from './source.ts'
import { healthHistoryReferences } from './health-history.ts'
import type {
  KnowledgeDocumentId, KnowledgeHealthReportId, KnowledgeHealthReport, KnowledgeHealthFinding, KnowledgeHealthFindingUpdate,
  KnowledgeHealthFindingStatus,
} from './types.ts'

const statuses = { open: '未处理', fixed: '已修复', snoozed: '已暂缓', 'not-an-issue': '不是问题' } as const
const updateSchema = z.object({ expectedVersion: z.string().min(1), findingNumber: z.number().int().positive(),
  status: z.enum(['open', 'fixed', 'snoozed', 'not-an-issue']), note: z.string().refine(value => !/[\r\n\0]/.test(value)).optional() }).strict()

type Block = ReturnType<typeof fromMarkdown>['children'][number]

/** Resolve a canonical report ID without accepting an arbitrary file path.
 * @param id - dated report identity supplied by the caller.
 * @returns the fixed Brain-relative report filename.
 * @throws when the ID contains a path or is not a real calendar date.
 */
export function healthReportPath(id: KnowledgeHealthReportId): KnowledgeDocumentId {
  const date = /^brain-health-(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1]
  const time = date === undefined ? NaN : Date.parse(`${date}T00:00:00Z`)
  const parsed = new Date(time)
  if (!Number.isFinite(time) || parsed.getUTCFullYear() !== Number(date?.slice(0, 4))
    || parsed.getUTCMonth() + 1 !== Number(date?.slice(5, 7)) || parsed.getUTCDate() !== Number(date?.slice(8, 10))) {
    throw new RemoteError('knowledge/document', 'health report id must be brain-health-YYYY-MM-DD', { path: id, reason: 'unsafe-path' })
  }
  return `reports/${id}.md` as KnowledgeDocumentId
}

function offsets(node: Block | Extract<Block, { type: 'list' }>['children'][number]): { start: number; end: number } {
  // Parsed MDAST has offsets; its public type also accepts positionless synthetic nodes.
  const position = node.position as { start: { offset: number }; end: { offset: number } }
  return { start: position.start.offset, end: position.end.offset }
}

function heading(node: Block): string | undefined {
  return node.type === 'heading' && node.children.length === 1 && node.children[0]?.type === 'text' ? node.children[0].value : undefined
}

function reportSource(text: string) {
  const source = knowledgeSource(text, false)
  const value = source.frontmatter.value
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('health report frontmatter must be a mapping')
  const fields = (value ?? {}) as Record<string, unknown>
  const nodes = fromMarkdown(source.body).children
  const timelines = nodes.filter(node => node.type === 'heading' && node.depth === 2 && /^(Timeline|时间线)$/i.test(heading(node) ?? ''))
  if (timelines.length > 1) throw new Error('health report contains multiple timelines')
  const timeline = timelines[0] === undefined ? undefined : offsets(timelines[0])
  const body = timeline === undefined ? source.body : source.body.slice(0, timeline.start).trimEnd()
  return { ...source, fields, body, timeline: timeline === undefined ? '' : source.body.slice(timeline.end).trim(),
    timelineHeading: timelines[0] === undefined ? 'Timeline' : heading(timelines[0]) as string }
}

function findingStatus(text: string): KnowledgeHealthFindingStatus {
  const lower = text.trim().toLowerCase()
  for (const status of ['open', 'fixed', 'snoozed', 'not-an-issue'] as const) if (lower === status || lower === statuses[status]) return status
  if (lower === '稍后处理') return 'snoozed'
  throw new Error('health finding has an unrecognized status')
}

function reportFindings(body: string): { finding: KnowledgeHealthFinding; start: number; end: number }[] {
  const rows: { finding: KnowledgeHealthFinding; start: number; end: number }[] = []
  let severity: KnowledgeHealthFinding['severity'] = 'medium'
  for (const node of fromMarkdown(body).children) {
    if (node.type === 'heading' && node.depth === 2) severity = /could mislead|可能误导/i.test(heading(node) ?? '') ? 'high' : 'medium'
    if (node.type !== 'list' || node.ordered) continue
    for (const item of node.children) {
      const range = offsets(item)
      const [first = '', ...lines] = body.slice(range.start, range.end).split('\n')
      const match = /^- \[([ xX])\]\s+#(\d+)\s+(.+)$/.exec(first)
      if (match === null) continue
      const number = Number(match[2])
      if (!Number.isSafeInteger(number) || number < 1 || rows.some(row => row.finding.number === number)) {
        throw new Error('health finding numbers must be unique positive integers')
      }
      let status: KnowledgeHealthFindingStatus = match[1] === ' ' ? 'open' : 'fixed'
      let explicitStatus = false
      const description: string[] = [], evidence: string[] = [], related: string[] = []
      for (const line of lines.map(line => line.trim()).filter(Boolean)) {
        const state = /^(?:Status:|状态：)\s*(.*)$/i.exec(line)
        const refs = /^(?:Related:|相关：)\s*(.*)$/i.exec(line)
        if (state !== null) {
          if (explicitStatus) throw new Error('health finding contains multiple status lines')
          status = findingStatus(state[1] as string)
          explicitStatus = true
        } else if (refs !== null) related.push(...(refs[1] as string).split(',').map(value => value.trim()).filter(Boolean))
        else if (line.startsWith('>')) evidence.push(line.replace(/^>\s?/, ''))
        else description.push(line)
      }
      rows.push({ ...range, finding: { number, severity, title: (match[3] as string).trim(), status,
        description: description.join(' '), evidence: evidence.join('\n'), related } })
    }
  }
  return rows
}

/** Read a report without interpreting its findings as active project knowledge.
 * @param id - canonical dated report identity.
 * @param text - complete bounded UTF-8 Markdown file.
 * @param version - content hash supplied by the reader.
 * @returns findings, derived counters, report body and report-only history.
 * @throws for malformed YAML, ambiguous findings or unsupported status labels.
 */
export function parseHealthReport(id: KnowledgeHealthReportId, text: string, version: string): KnowledgeHealthReport {
  const path = healthReportPath(id)
  try {
    const source = reportSource(text)
    healthHistoryReferences(id, source.fields)
    const findings = reportFindings(source.body).map(row => row.finding)
    const string = (key: string): string => typeof source.fields[key] === 'string' ? source.fields[key] : ''
    const count = (key: string): number => typeof source.fields[key] === 'number' && Number.isFinite(source.fields[key]) ? source.fields[key] : 0
    return { id, version, title: string('title') || `Brain Health check - ${id.slice('brain-health-'.length)}`,
      checkedAt: string('checked_at') || id.slice('brain-health-'.length), updatedAt: string('updated') || string('checked_at'),
      activePageCount: count('active_page_count'), findingCount: findings.length || count('finding_count'),
      openHighRiskCount: findings.length ? findings.filter(row => row.severity === 'high' && row.status === 'open').length : count('open_high_risk_count'),
      handledCount: findings.length ? findings.filter(row => row.status === 'fixed' || row.status === 'not-an-issue').length : count('handled_count'),
      snoozedCount: findings.length ? findings.filter(row => row.status === 'snoozed').length : count('snoozed_count'),
      body: source.body.replace(/^#\s+(?:Brain Health check|Brain 健康检查)[^\n]*\n+/i, '').trim(), timeline: source.timeline, findings }
  } catch (error) {
    let message: string
    /* v8 ignore else -- This text-only parser and its fixed YAML/MDAST parsers throw Error instances. */
    if (error instanceof Error) message = error.message
    else message = String(error)
    throw new RemoteError('knowledge/document', `invalid health report: ${message}`, { path, reason: 'invalid' })
  }
}

/** Change report disposition, counters and history together; this never edits the referenced pages.
 * @param id - existing report identity.
 * @param text - complete report held under its writer lock.
 * @param version - hash of the current bytes.
 * @param request - observed version, finding number, new status and optional single-line note.
 * @param now - publication timestamp.
 * @param maxBytes - inclusive complete request and resulting file byte allowance.
 * @returns the complete replacement report.
 * @throws for invalid input, missing or ambiguous findings, stale reads or an oversized result.
 */
export function prepareHealthFindingUpdate(id: KnowledgeHealthReportId, text: string, version: string,
  request: KnowledgeHealthFindingUpdate, now: string, maxBytes: number): string {
  const path = healthReportPath(id)
  const tooLarge = (): never => { throw new RemoteError('knowledge/document', 'health report update exceeds the document byte limit', { path, reason: 'too-large' }) }
  if (Buffer.byteLength(JSON.stringify(request)) > maxBytes) tooLarge()
  const input = updateSchema.safeParse(request)
  if (!input.success) throw new RemoteError('knowledge/update', 'health report updates require a version, positive finding number, status and single-line note', { path, reason: 'invalid' })
  const before = parseHealthReport(id, text, version)
  if (version !== input.data.expectedVersion) throw new RemoteError('knowledge/update', 'health report changed; read it again before marking a finding', { path, reason: 'conflict' })
  const source = reportSource(text)
  const row = reportFindings(source.body).find(row => row.finding.number === input.data.findingNumber)
  if (row === undefined) throw new RemoteError('knowledge/update', 'health report finding does not exist', { path, reason: 'invalid' })
  const zh = /^# Brain 健康检查/m.test(source.body)
  const status = input.data.status
  const statusLine = zh ? `状态：${statuses[status]}` : `Status: ${status}`
  let item = source.body.slice(row.start, row.end).replace(/^- \[[ xX]\]/, status === 'open' || status === 'snoozed' ? '- [ ]' : '- [x]')
  if (/^\s*(?:Status:|状态：)/mi.test(item)) item = item.replace(/^(\s*)(?:Status:|状态：)[^\n]*/mi, (_match, indent: string) => `${indent}${statusLine}`)
  else item = item.replace('\n', `\n  ${statusLine}\n`)
  if (!item.includes(statusLine)) item += `\n  ${statusLine}`
  let body = source.body.slice(0, row.start) + item + source.body.slice(row.end)
  const findings = reportFindings(body).map(row => row.finding)
  const high = findings.filter(row => row.severity === 'high')
  const handled = findings.filter(row => row.status === 'fixed' || row.status === 'not-an-issue').length
  const snoozed = findings.filter(row => row.status === 'snoozed').length
  const summary = zh
    ? `已检查 ${before.activePageCount} 个 active 页面。发现 ${findings.length} 个问题，其中 ${high.length} 个可能误导 AI；已处理 ${handled} 个，已暂缓 ${snoozed} 个。`
    : `Checked ${before.activePageCount} active pages. ${findings.length} findings - ${high.length} could mislead AI; ${handled} handled, ${snoozed} snoozed.`
  const summaryLine = /^(?:Checked \d+ active pages\.|已检查 \d+ 个 active 页面。)[^\n]*/m
  if (summaryLine.test(body)) body = body.replace(summaryLine, () => summary)
  const metadata = source.frontmatter.document
  for (const [key, value] of Object.entries({ updated: now, finding_count: findings.length,
    open_high_risk_count: high.filter(row => row.status === 'open').length, handled_count: handled, snoozed_count: snoozed })) metadata.set(key, value)
  const note = input.data.note?.trim()
  const history = `${now} - #${input.data.findingNumber}: ${zh ? statuses[status] : status}${note ? ` — ${note}` : ''}`
  const timeline = `${source.timeline}${source.timeline ? '\n' : ''}- ${history}`
  const result = `---\n${metadata.toString({ lineWidth: 0 })}---\n\n${body.trim()}\n\n## ${source.timelineHeading}\n\n${timeline}\n`
  if (Buffer.byteLength(result) > maxBytes) tooLarge()
  parseHealthReport(id, result, version)
  return result
}
