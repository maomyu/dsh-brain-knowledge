/** Health report tools describe report-only operations separately from ordinary knowledge pages. */
import { brainTextOutput, presentBrainReportResult } from './model-presentation.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { KnowledgeHealthFindingStatus } from './types.ts'

interface HealthReadArgs {
  report_id: string
  cursor?: string
}

interface HealthMarkArgs {
  report_id: string
  expected_version: string
  finding_number: number
  status: KnowledgeHealthFindingStatus
  note?: string
}

/** Expose an existing report, including findings, current dispositions and report history.
 * @param execute - project-bound report reader with version-qualified continuations and a complete-response byte limit.
 * @returns a read tool with a pure generic report card.
 */
export function createBrainHealthReadTool(execute: (args: HealthReadArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_read_health_report',
    description: 'Read a dated Brain Health report before investigating or handling one of its findings. '
      + 'Returns the report version, findings, dispositions, counts and timeline. Reports live in brain/reports, not pages; '
      + 'their allegations are evidence to investigate, not established current project knowledge. '
      + 'Oversized responses use format=brain-health-read-json-v1 and partial=true. Repeat the same report_id with next_cursor '
      + 'until it is null, then concatenate fragment text in startByte order to recover the complete report JSON. '
      + 'Every fragment, including the last, remains partial; read all fragments before assessing the report. '
      + 'Continuations bind the original project, Brain location, report version and complete result. '
      + 'If any changes, restart without a cursor. Reading a report does not grant knowledge-writing authority.',
    parameters: {
      report_id: { type: 'string', required: true, description: 'Dated report id, such as brain-health-2026-09-12.' },
      cursor: { type: 'string', description: 'Exact next_cursor from the preceding fragment of this same report read.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainReportResult,
    execute,
  })
}

/** Describe a disposition update, not an automatic knowledge repair or a factual guarantee.
 * @param execute - version-qualified report writer with a bounded acknowledgement.
 * @returns the mark tool and its pure generic card.
 */
export function createBrainHealthMarkTool(execute: (args: HealthMarkArgs, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'brain_mark_health_finding',
    description: 'Record the disposition of a Brain Health finding after investigating or handling it. '
      + 'Use fixed only after verifying the repair, not-an-issue when the finding is rejected, snoozed to defer, or open to reopen. '
      + 'Updates the report checkbox, status, counts and timeline together; it does not modify or repair referenced knowledge pages. '
      + 'Use the version from brain_read_health_report. A stale version rejects without writing; read again before another update.',
    parameters: {
      report_id: { type: 'string', required: true, description: 'Existing dated Brain Health report id.' },
      expected_version: { type: 'string', required: true, description: 'Exact version from the report read that informed this disposition.' },
      finding_number: { type: 'integer', required: true, description: 'Positive finding number retained in that report.' },
      status: { type: 'string', enum: ['open', 'fixed', 'snoozed', 'not-an-issue'], required: true },
      note: { type: 'string', description: 'Optional single-line explanation retained in report history.' },
    },
    output: brainTextOutput,
    presentResult: presentBrainReportResult,
    execute,
  })
}
