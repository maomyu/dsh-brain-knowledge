/** Serialize reviewed findings and recognize publication retries independently of model transport. */
import { createHash } from 'node:crypto'
import { stringify } from 'yaml'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { healthReportPath, parseHealthReport } from './health-report.ts'
import { knowledgeSource } from './source.ts'
import type { KnowledgeHealthReportId, KnowledgeHealthReportWrite } from './types.ts'

const line = z.string().refine(value => value.trim().length > 0 && !/[\r\n\0]/.test(value))
const inputSchema = z.object({
  operationId: z.uuid(), expectedVersion: z.string().min(1).nullable(), locale: z.enum(['en', 'zh-CN']),
  activePageCount: z.number().int().nonnegative(), summary: z.string().refine(value => value.trim().length > 0 && !/[\r\0]/.test(value)),
  findings: z.array(z.object({ severity: z.enum(['high', 'medium']), title: line, description: line,
    evidence: z.string().refine(value => !/[\r\0]/.test(value)),
    related: z.array(line.refine(value => !value.includes(','))),
  }).strict()),
}).strict()

/** Build a complete daily report, with high-risk findings numbered before medium-risk findings.
 * @param id - validated dated report identity.
 * @param request - complete generated assessment; this function does not perform the assessment.
 * @param now - actual publication timestamp, excluded from retry identity.
 * @param maxBytes - inclusive complete request and serialized-file byte allowance.
 * @returns independently serialized Markdown and its stable request digest.
 * @throws for invalid input, ambiguous Markdown fields or an oversized result.
 */
export function prepareHealthReportWrite(id: KnowledgeHealthReportId, request: KnowledgeHealthReportWrite,
  now: string, maxBytes: number): { text: string; digest: string } {
  const path = healthReportPath(id)
  const bounded = (text: string): void => {
    if (Buffer.byteLength(text) > maxBytes) throw new RemoteError('knowledge/document',
      'health report generation exceeds the document byte limit', { path, reason: 'too-large' })
  }
  bounded(JSON.stringify(request))
  const parsed = inputSchema.safeParse(request)
  if (!parsed.success) throw new RemoteError('knowledge/update',
    'health report generation requires an operation UUID, observed version, language, page count, summary and structured findings', { path, reason: 'invalid' })
  const input = parsed.data
  const digest = createHash('sha256').update(JSON.stringify([id, input])).digest('hex')
  const zh = input.locale === 'zh-CN'
  const high = input.findings.filter(finding => finding.severity === 'high')
  const medium = input.findings.filter(finding => finding.severity === 'medium')
  const findings = [...high, ...medium]
  const title = `${zh ? 'Brain 健康检查' : 'Brain Health check'} - ${id.slice('brain-health-'.length)}`
  const metadata = stringify({ id, type: 'brain-health', title, checked_at: now, updated: now,
    active_page_count: input.activePageCount, finding_count: findings.length, open_high_risk_count: high.length,
    handled_count: 0, snoozed_count: 0, dsh_generation: { operation_id: input.operationId, request_digest: digest } }, { lineWidth: 0 })
  const rows = (severity: 'high' | 'medium'): string => findings.flatMap((finding, index) => finding.severity !== severity ? [] : [
    `- [ ] #${index + 1} ${finding.title}`,
    zh ? '  状态：未处理' : '  Status: open',
    ...(finding.related.length === 0 ? [] : [`  ${zh ? '相关：' : 'Related:'} ${finding.related.join(', ')}`]),
    `  ${finding.description}`,
    ...(finding.evidence === '' ? [] : finding.evidence.split('\n').map(value => `  > ${value}`)),
    '',
  ]).join('\n') || (zh ? '无。\n' : 'None.\n')
  const counts = zh
    ? `已检查 ${input.activePageCount} 个 active 页面。发现 ${findings.length} 个问题，其中 ${high.length} 个可能误导 AI；已处理 0 个，已暂缓 0 个。`
    : `Checked ${input.activePageCount} active pages. ${findings.length} findings - ${high.length} could mislead AI; 0 handled, 0 snoozed.`
  const text = `---\n${metadata}---\n\n# ${title}\n\n${counts}\n\n${zh ? '检查摘要：' : 'Check summary:'} ${input.summary}\n\n`
    + `## ${zh ? '可能误导 AI' : 'Could mislead AI'}\n\n${rows('high')}\n## ${zh ? '值得检查' : 'Worth checking'}\n\n${rows('medium')}`
    + `\n## ${zh ? '时间线' : 'Timeline'}\n\n- ${now} - ${zh ? '检查完成。' : 'Check completed.'}\n`
  bounded(text)
  const report = parseHealthReport(id, text, digest)
  // Markdown delimiters in model text must not change finding identity, severity, evidence or disposition.
  if (JSON.stringify(report.findings.map(({ number: _number, status: _status, ...finding }) => finding)) !== JSON.stringify(findings)) {
    throw new RemoteError('knowledge/update', 'health finding text changes the report structure', { path, reason: 'invalid' })
  }
  return { text, digest }
}

/** Recognize a committed generation before checking an old expected version, without restoring its old findings.
 * @param id - existing daily report identity.
 * @param text - complete current file, including any later disposition updates.
 * @param operationId - retained generation UUID.
 * @param digest - digest of the complete generation request.
 * @returns true only for the same committed generation; false for a different generation.
 * @throws for malformed files or reuse of a generation UUID with different input.
 */
export function healthGenerationApplied(id: KnowledgeHealthReportId, text: string, operationId: string, digest: string): boolean {
  parseHealthReport(id, text, digest)
  const fields = knowledgeSource(text, false).frontmatter.value as Record<string, unknown> | null
  const receipt = fields?.dsh_generation
  if (receipt === undefined) return false
  const parsed = z.object({ operation_id: z.uuid(), request_digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(receipt)
  if (!parsed.success) throw new RemoteError('knowledge/update', 'health report generation receipt is invalid', { path: healthReportPath(id), reason: 'invalid' })
  if (parsed.data.operation_id !== operationId) return false
  if (parsed.data.request_digest !== digest) throw new RemoteError('knowledge/update',
    'health report generation identity belongs to different input', { path: healthReportPath(id), reason: 'identity-conflict' })
  return true
}
