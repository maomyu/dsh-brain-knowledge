/** Complete-finding deduplication preserves independent Brain Health evidence. */
import type { KnowledgeHealthReportWrite } from './types.ts'

type Finding = KnowledgeHealthReportWrite['findings'][number]

/** Remove only completely identical findings; distinct evidence and ordered references remain independent.
 * @param staticFindings - scoped deterministic findings, retained before model findings.
 * @param modelFindings - normalized findings from the completed model response.
 * @returns the first occurrence of each complete finding in input order, without clipping or aggregation.
 */
export function mergeHealthFindings(staticFindings: readonly Finding[], modelFindings: readonly Finding[]): readonly Finding[] {
  const retained = new Set<string>()
  return [...staticFindings, ...modelFindings].filter((finding) => {
    const key = JSON.stringify([finding.severity, finding.title, finding.description, finding.evidence, finding.related])
    if (retained.has(key)) return false
    retained.add(key)
    return true
  })
}
