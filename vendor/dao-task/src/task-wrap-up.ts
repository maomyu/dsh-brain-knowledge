/** Task-authored structured reports remain evidence, not acceptance or Git instructions. */
import { z } from 'zod'

const reported = z.object({ whatChanged: z.array(z.string()), verificationDone: z.array(z.string()),
  suggestedCommit: z.object({ title: z.string(), body: z.string() }).strict() }).strict()

/** Validated durable summary; truncation applies to reported content, never to verification marks. */
export const taskWrapUpSchema = reported.extend({ truncated: z.boolean() })

/** Frozen task input includes this output instruction in the same logged message as its proposal. */
export const taskWrapUpInstruction = [
  'End your final response with one <wrap_up_summary> JSON block followed by </wrap_up_summary>. Put no text after the closing tag.',
  'Use this object: {"whatChanged":["logical changes"],"verificationDone":["checks actually performed and their results"],'
    + '"suggestedCommit":{"title":"suggested commit subject","body":"optional explanatory body"}}.',
  'Write the report in the task’s working language. Use empty arrays when no changes or checks were performed.',
  'Report failed or skipped checks honestly. The commit text is only a suggestion; this output format grants no permission to commit or push.',
].join('\n')

/** Parse one complete terminal sentinel, without consulting prompts, tools or earlier assistant messages.
 * @param text - final assistant text selected from the task input's own admitted turn.
 * @returns validated report, or undefined for absent, ambiguous, malformed or nonterminal blocks.
 */
export function readTaskWrapUp(text: string): z.infer<typeof reported> | undefined {
  const open = '<wrap_up_summary>'
  const close = '</wrap_up_summary>'
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start < 0 || end < start || text.lastIndexOf(open) !== start || text.lastIndexOf(close) !== end
    || text.slice(end + close.length).trim() !== '') return undefined
  let value: unknown
  try { value = JSON.parse(text.slice(start + open.length, end)) }
  catch { return undefined } // JSON.parse can only reject the selected string's syntax.
  const parsed = reported.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Bound raw evidence and the combined structured strings without cutting Unicode code points.
 * @param text - full final assistant text; parsing happens before truncation.
 * @param maxChars - inclusive code-point budget for raw text and separately for all structured strings combined.
 * @param wrapUp - validated report selected from this exact text, or null to retain only raw evidence.
 * @returns bounded raw evidence and an optional structured report with explicit truncation.
 */
export function taskSummaryEvidence(text: string, maxChars: number,
  wrapUp: ReturnType<typeof readTaskWrapUp> | null = readTaskWrapUp(text)):
{ summary: string; summaryTruncated: boolean; wrapUpSummary?: z.infer<typeof taskWrapUpSchema> } {
  const summary = Array.from(text).slice(0, maxChars).join('')
  const base = { summary, summaryTruncated: summary !== text }
  if (wrapUp == null) return base
  const strings = [...wrapUp.whatChanged, ...wrapUp.verificationDone, wrapUp.suggestedCommit.title, wrapUp.suggestedCommit.body]
    .map(value => Array.from(value))
  const count = (limit: number) => strings.reduce((total, value) => total + Math.min(value.length, limit), 0)
  let low = 0
  let high = strings.reduce((maximum, value) => Math.max(maximum, value.length), 0)
  const truncated = count(high) > maxChars
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (count(middle) <= maxChars) low = middle
    else high = middle - 1
  }
  const clip = (value: string) => Array.from(value).slice(0, low).join('')
  return { ...base, wrapUpSummary: {
    whatChanged: wrapUp.whatChanged.map(clip).filter(value => value.length > 0),
    verificationDone: wrapUp.verificationDone.map(clip).filter(value => value.length > 0),
    suggestedCommit: { title: clip(wrapUp.suggestedCommit.title), body: clip(wrapUp.suggestedCommit.body) }, truncated,
  } }
}
