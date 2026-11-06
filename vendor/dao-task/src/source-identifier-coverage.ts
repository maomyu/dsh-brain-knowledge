/** Conservative lexical coverage for explicitly paired Task-report source identifiers. */

/** A filename and identifier copied verbatim from one unambiguous Task-report entry. */
export interface TaskSourceIdentifier {
  readonly originalName: string
  readonly identifier: string
}

/** This result does not establish source authenticity, complete citation, or semantic correctness. */
export interface TaskSourceIdentifierCoverage {
  readonly status: 'unknown' | 'missing' | 'lexically-present'
  readonly checked: readonly TaskSourceIdentifier[]
  readonly missing: readonly TaskSourceIdentifier[]
}

const fileNamePattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}._+@()-])` +
  String.raw`([\p{L}\p{N}_+@()-]+(?:[.-][\p{L}\p{N}_+@()-]+)*` +
  String.raw`\.(?:docx?|pdf|md|txt|html?|csv|json|pptx?|xlsx?))(?![\p{L}\p{N}]|\.[\p{L}\p{N}])`, 'giu')
const labeledIdentifierPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:source[ -]+accession|accession|source[ -]+(?:identifier|id)|` +
  String.raw`(?:record|document|certificate)[ -]+(?:identifier|id|number|no)|identifier|id|` +
  String.raw`来源编号|证书编号|文档编号|记录编号|编号)\s*[:：=#]\s*[\x60'"“‘]?` +
  String.raw`([\p{L}\p{N}][\p{L}\p{N}._/-]{0,127})(?![\p{L}\p{N}._/-])`, 'giu')

function sourceNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(fileNamePattern)) {
    /* v8 ignore else -- the fixed filename expression has one required capture on every match. */
    if (match[1] !== undefined) names.add(match[1])
  }
  return [...names]
}

function labeledIdentifiers(text: string): { readonly found: boolean
  readonly identifiers: readonly string[] } {
  const matches = [...text.matchAll(labeledIdentifierPattern)]
  const identifiers = matches.flatMap((match) => {
    /* v8 ignore if -- the fixed labeled-identifier expression has one required capture on every match. */
    if (match[1] === undefined) return []
    return [match[1].replace(/[.,，。)）\]}]+$/u, '')]
  })
    .filter(value => value.length >= 4 && /\p{L}/u.test(value) && /\p{N}/u.test(value))
  return { found: matches.length > 0, identifiers: [...new Set(identifiers)] }
}

function hasExactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}._/-])${escaped}(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])`, 'u').test(text)
}

/** Compare a human-selected evidence text with source IDs explicitly paired in a complete Task report.
 * @param report - complete retained Task result; unsupported or ambiguous source notation remains unknown.
 * @param candidateEvidence - immutable model candidate checked against every unambiguous report pair.
 * @param reviewedEvidence - optional human replacement; absence uses the original model evidence.
 * @returns exact lexical omissions for recognized pairs, or unknown when a report or candidate source cannot be paired uniquely.
 */
export function assessTaskSourceIdentifierCoverage(report: string, candidateEvidence: string,
  reviewedEvidence?: string): TaskSourceIdentifierCoverage {
  const original = report.normalize('NFC')
  const candidate = candidateEvidence.normalize('NFC')
  const effective = (reviewedEvidence ?? candidateEvidence).normalize('NFC')
  const cited = sourceNames(candidate)
  const reportNames = sourceNames(original)
  if (reportNames.length === 0) return { status: 'unknown', checked: [], missing: [] }
  const reportNameSet = new Set(reportNames)
  const identifiers = new Map<string, Set<string>>()
  const ambiguous = new Set<string>()
  for (const entry of original.split(/\r?\n|[;；]|(?<=[.!?。！？])\s+/u)) {
    const names = sourceNames(entry)
    const labeled = labeledIdentifiers(entry)
    if (!labeled.found) continue
    const name = names[0]
    const identifier = labeled.identifiers[0]
    if (names.length !== 1 || labeled.identifiers.length !== 1 || name === undefined || identifier === undefined) {
      for (const name of names) ambiguous.add(name)
      continue
    }
    const values = identifiers.get(name) ?? new Set<string>()
    values.add(identifier)
    identifiers.set(name, values)
  }
  const checked: TaskSourceIdentifier[] = []
  let unknown = cited.some(name => !reportNameSet.has(name))
  for (const name of reportNames) {
    const values = identifiers.get(name)
    if (ambiguous.has(name) || values?.size !== 1) {
      unknown = true
      continue
    }
    const identifier = [...values][0]
    /* v8 ignore if -- the preceding size === 1 check establishes one string-valued Set entry. */
    if (identifier === undefined) {
      unknown = true
      continue
    }
    checked.push({ originalName: name, identifier })
  }
  const missing = checked.filter(source => !hasExactToken(effective, source.originalName)
    || !hasExactToken(effective, source.identifier))
  return { status: missing.length > 0 ? 'missing' : unknown ? 'unknown' : 'lexically-present', checked, missing }
}
