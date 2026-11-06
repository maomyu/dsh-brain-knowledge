/** Logged, project-specific Brain search evidence for a proposed active page. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

const call = z.object({ target_project_id: z.string(), query: z.string(),
  statuses: z.unknown().optional(), non_active_opt_in: z.unknown().optional() })
const result = z.object({ project_id: z.string(), project: z.string(), query: z.string(),
  exists: z.boolean(), issues: z.array(z.unknown()), truncated: z.boolean(),
  hits: z.array(z.object({ path: z.string(), title: z.string(), version: z.string(), status: z.literal('active') })) })

/** Complete literal-title search observed before the final proposal, with no workspace-aggregate ambiguity. */
export interface CandidateSearch {
  readonly query: string
  readonly exists: boolean
  readonly hits: readonly { readonly path: string; readonly title: string; readonly version: string }[]
}

/** Detect an already active page with the proposed title without interpreting the model's relation label.
 * @param observed - complete logged title-search result for the destination.
 * @param title - title proposed for a new active page.
 * @returns whether an active hit has the same trimmed, case-insensitive title.
 */
export function hasExactActiveTitle(observed: CandidateSearch, title: string): boolean {
  const proposed = title.trim().normalize('NFC').toLowerCase()
  return observed.hits.some(hit => hit.title.trim().normalize('NFC').toLowerCase() === proposed)
}

/** Find the last exact-title search for one registered destination in the retained tool log.
 * @param events - events preceding the settled proposal, including actual tool results.
 * @param projectId - exact registered destination, never a display name.
 * @param projectPath - current canonical project root recorded in the result.
 * @param title - proposed active page title, used as a literal all-token query.
 * @returns complete candidate identities or the reason they cannot support review.
 */
function observedSearch(events: readonly SessionEvent[], projectId: WorkspaceId, projectPath: string,
  query: string): CandidateSearch | 'missing' | 'incomplete' {
  let selected: ToolCallId | undefined
  let observed: CandidateSearch | 'incomplete' | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'brain_search') {
      let args: unknown
      try { args = JSON.parse(event.data.arguments) } catch {
        // Malformed model arguments cannot identify a successful search.
        continue
      }
      const parsed = call.safeParse(args)
      if (!parsed.success || parsed.data.target_project_id !== projectId || parsed.data.query.trim() !== query
        || parsed.data.statuses !== undefined || parsed.data.non_active_opt_in !== undefined) continue
      selected = event.data.callId
      observed = undefined
    }
    if (event.type !== 'tool/result' || event.data.message.source.callId !== selected) continue
    const output = event.data.message
    observed = 'incomplete'
    if (output.isError === true) continue
    for (const block of output.content) {
      if (block.type !== 'text') continue
      let value: unknown
      try { value = JSON.parse(block.text) } catch { continue }
      const parsed = result.safeParse(value)
      if (!parsed.success || parsed.data.project_id !== projectId || parsed.data.project !== projectPath
        || parsed.data.query !== query || parsed.data.issues.length > 0 || parsed.data.truncated
        || !parsed.data.exists && parsed.data.hits.length > 0) continue
      observed = { query, exists: parsed.data.exists,
        hits: parsed.data.hits.map(hit => ({ path: hit.path, title: hit.title, version: hit.version })) }
      break
    }
  }
  return selected === undefined ? 'missing' : observed ?? 'incomplete'
}

/** Find the last complete exact-title search without changing the historical candidate rule.
 * @param events - events preceding the settled proposal.
 * @param projectId - registered destination.
 * @param projectPath - registered canonical project root.
 * @param title - proposed active page title.
 * @returns observed hits or the missing/incomplete reason.
 */
export function candidateSearch(events: readonly SessionEvent[], projectId: WorkspaceId, projectPath: string,
  title: string): CandidateSearch | 'missing-candidate-search' | 'candidate-search-incomplete' {
  const observed = observedSearch(events, projectId, projectPath, title.trim())
  return observed === 'missing' ? 'missing-candidate-search'
    : observed === 'incomplete' ? 'candidate-search-incomplete' : observed
}

/** Check only that a topic query contains a letter-or-number token outside the proposed title.
 * @param query - model-declared content-term search.
 * @param title - proposed new page title.
 * @returns false when the query only repeats title tokens; semantic relevance remains human-reviewed.
 */
export function hasNonTitleToken(query: string, title: string): boolean {
  const tokens = (text: string) => text.trim().normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const words = new Set(tokens(title))
  return tokens(query).some(word => !words.has(word))
}

/** Find a complete default-active search for model-declared non-title content terms.
 * @param events - events preceding the settled proposal.
 * @param projectId - exact registered destination.
 * @param projectPath - registered canonical project root.
 * @param query - declared content-term query, matched to an actual tool call and result.
 * @param title - proposed title used only for a mechanical non-title-token check.
 * @returns observed hits or a bounded, displayable verification reason.
 */
export function topicSearch(events: readonly SessionEvent[], projectId: WorkspaceId, projectPath: string,
  query: string, title: string): CandidateSearch | 'discovery-query-is-title'
  | 'missing-discovery-search' | 'discovery-search-incomplete' {
  if (!hasNonTitleToken(query, title)) return 'discovery-query-is-title'
  const observed = observedSearch(events, projectId, projectPath, query.trim())
  return observed === 'missing' ? 'missing-discovery-search'
    : observed === 'incomplete' ? 'discovery-search-incomplete' : observed
}
