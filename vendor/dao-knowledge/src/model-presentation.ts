/** Pure text output and cards shared by Brain tool definitions. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/** Preserve an acknowledgement as the complete model-visible text value. */
export const brainTextOutput = {
  schema: { type: 'string' as const },
  render(_args: unknown, value: string): ContentBlock[] { return [{ type: 'text', text: value }] },
}

/** Present the final content under its validated Brain document path.
 * @param args - document selection already validated by the tool definition.
 * @param result - final model-facing content, including a normalized failure.
 * @returns the path-qualified generic result card.
 */
export function presentBrainPathResult(args: { path: string }, result: ToolResult): ToolResultView {
  return { card: 'generic', title: args.path, content: result.content }
}

/** Present the final content under its validated health-report identity.
 * @param args - report selection already validated by the tool definition.
 * @param result - final model-facing content, including a normalized failure.
 * @returns the report-qualified generic result card.
 */
export function presentBrainReportResult(args: { report_id: string }, result: ToolResult): ToolResultView {
  return { card: 'generic', title: args.report_id, content: result.content }
}
