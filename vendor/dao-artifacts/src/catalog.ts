/** Decode artifact metadata and group concrete renditions without reading or executing their bodies. */
import { z } from 'zod'
import type { FsPathInfo } from '@deepseek-ai/dsh-fs'
import type { ArtifactEntry, ArtifactId, ArtifactIssue, ArtifactKind, ArtifactOriginId, ArtifactRendition, ArtifactRenditionId, ArtifactTaskId, ArtifactType } from './types.ts'

/** Directory names in the observed project artifact layout. */
export const artifactTypes = ['images', 'decks', 'reports', 'docs'] as const
/** Optional per-conversation metadata in the observed version-one file layout. */
export const manifestName = '.mindmux-artifacts.json'
const segment = z.string().min(1).refine(value => !value.startsWith('.') && !/[\\/\u0000-\u001f\u007f:]/u.test(value))
const date = z.string().refine(value => Number.isFinite(Date.parse(value)))
const record = z.object({
  id: z.string().min(1), sessionId: segment, type: z.enum(artifactTypes), fileName: segment,
  created: date, updated: date,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
    z.object({ kind: z.literal('chat'), messageId: z.string().optional(), toolCallId: z.string().optional() }),
    z.object({ kind: z.literal('legacy') }), z.object({ kind: z.literal('unknown') }),
  ]),
  semanticArtifactId: z.string().min(1).optional(),
  title: z.string().optional(), taskId: z.string().min(1).optional(),
  kind: z.enum(['image', 'deck', 'report', 'docs', 'generic']).optional(),
  format: z.string().min(1).optional(), sourceVersion: z.number().int().positive().optional(),
  canonical: z.boolean().optional(), primary: z.boolean().optional(), stale: z.boolean().optional(),
  role: z.string().optional(),
})
/** Parsed metadata only; file existence and ownership are checked by the catalog scanner. */
export type ArtifactRecord = z.infer<typeof record>

/**
 * Validate an unencoded filename or conversation directory without accepting traversal or hidden entries.
 * @param value - one path component.
 * @returns whether this component can participate in the artifact layout.
 */
export function safeSegment(value: string): boolean { return segment.safeParse(value).success }

/**
 * Name one concrete rendition without conflating encoded separators with directory separators.
 * @param origin - conversation directory.
 * @param type - artifact directory class.
 * @param fileName - one file or site-directory name.
 * @returns the opaque wire identity.
 */
export function renditionId(origin: string, type: ArtifactType, fileName: string): ArtifactRenditionId {
  return [origin, type, fileName].map(encodeURIComponent).join('/') as ArtifactRenditionId
}

/**
 * Decode a version-one manifest; malformed metadata is reported instead of silently inventing an empty catalog.
 * @param text - complete bounded UTF-8 manifest.
 * @param origin - conversation directory that owns the manifest.
 * @param maxRecords - maximum records admitted by the remaining scan budget.
 * @returns valid same-conversation records and diagnostics for rejected entries.
 */
export function readManifest(text: string, origin: string, maxRecords: number): {
  records: Map<string, ArtifactRecord>
  issues: ArtifactIssue[]
  examined: number
  truncated: boolean
} {
  const path = `${origin}/${manifestName}`
  const records = new Map<string, ArtifactRecord>()
  const issues: ArtifactIssue[] = []
  let input: unknown
  try { input = JSON.parse(text) } catch {
    // JSON.parse rejects malformed manifest text; no file operation is inside this try.
    return { records, issues: [{ path, message: 'Artifact manifest is not valid JSON' }], examined: 0, truncated: false }
  }
  const parsed = z.object({ version: z.literal(1), artifacts: z.array(z.unknown()) }).safeParse(input)
  if (!parsed.success) return { records, issues: [{ path, message: 'Artifact manifest requires version 1 and an artifacts array' }], examined: 0, truncated: false }
  const examined = Math.min(maxRecords, parsed.data.artifacts.length)
  const truncated = parsed.data.artifacts.length > maxRecords
  for (const [index, value] of parsed.data.artifacts.slice(0, examined).entries()) {
    const result = record.safeParse(value)
    if (!result.success || result.data.sessionId !== origin
      || result.data.id !== renditionId(origin, result.data.type, result.data.fileName)
      || records.has(result.data.id)) {
      issues.push({ path, message: `Invalid or duplicate artifact record at index ${index}` })
    } else records.set(result.data.id, result.data)
  }
  return { records, issues, examined, truncated }
}

/** Filesystem-derived rendition and its optional same-path manifest metadata. */
export interface ArtifactCandidate {
  readonly rendition: ArtifactRendition
  readonly metadata: ArtifactRecord | undefined
}

/**
 * Project one independently observed file into catalog metadata.
 * @param origin - owning conversation directory.
 * @param type - artifact directory class.
 * @param fileName - admitted direct child.
 * @param info - fresh non-following metadata supplied by the filesystem provider.
 * @param metadata - validated manifest record for this exact identity.
 * @returns an ungrouped rendition; no file bytes are read.
 */
export function artifactCandidate(
  origin: string, type: ArtifactType, fileName: string, info: FsPathInfo, metadata?: ArtifactRecord,
): ArtifactCandidate {
  const separator = fileName.lastIndexOf('.')
  const extension = separator < 0 ? '' : fileName.slice(separator + 1).toLowerCase()
  return { metadata, rendition: {
    id: renditionId(origin, type, fileName), originId: origin as ArtifactOriginId, type, fileName,
    format: metadata?.format ?? (info.type === 'directory' ? 'site-source' : extension === 'md' ? 'markdown' : extension || 'unknown'),
    directory: info.type === 'directory', bytes: info.size ?? null, version: info.version,
    createdAt: metadata === undefined ? null : Date.parse(metadata.created),
    updatedAt: metadata === undefined ? info.modifiedAt ?? null : Date.parse(metadata.updated),
    canonical: metadata?.canonical ?? metadata?.role === 'source', primary: metadata?.primary ?? false,
    stale: metadata?.stale ?? false, sourceVersion: metadata?.sourceVersion ?? null,
  } }
}

const kinds: Record<ArtifactType, ArtifactKind> = { images: 'image', decks: 'deck', reports: 'report', docs: 'docs' }

/**
 * Group source and exported formats within their originating conversation, newest first.
 * @param candidates - admitted physical entries and validated same-path metadata.
 * @returns cards with independent canonical/primary selection and derived stale flags.
 */
export function groupArtifacts(candidates: readonly ArtifactCandidate[]): ArtifactEntry[] {
  const groups = new Map<ArtifactId, [ArtifactCandidate, ...ArtifactCandidate[]]>()
  for (const candidate of candidates) {
    const identity = [candidate.rendition.originId, candidate.metadata?.semanticArtifactId ?? candidate.rendition.id]
    const id = JSON.stringify(identity) as ArtifactId
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [candidate])
    else group.push(candidate)
  }
  const entries: ArtifactEntry[] = []
  for (const [id, group] of groups) {
    group.sort((a, b) => (b.rendition.updatedAt ?? -Infinity) - (a.rendition.updatedAt ?? -Infinity)
      || a.rendition.id.localeCompare(b.rendition.id))
    const latest = group.reduce((version, item) => item.metadata?.canonical
      ? Math.max(version, item.rendition.sourceVersion ?? 1) : version, 0)
    const project = ({ rendition, metadata }: ArtifactCandidate): ArtifactRendition => ({ ...rendition,
      stale: metadata?.stale ?? (!rendition.canonical && latest > 0
        && (rendition.sourceVersion === null || rendition.sourceVersion < latest)),
    })
    const [first, ...rest] = group
    const firstRendition = project(first)
    const renditions = [firstRendition, ...rest.map(project)]
    const canonical = renditions.find(item => item.canonical) ?? renditions.find(item => item.primary) ?? firstRendition
    const primary = renditions.find(item => item.primary) ?? canonical
    entries.push({ id, originId: first.rendition.originId,
      kind: group.find(item => item.metadata?.kind)?.metadata?.kind ?? kinds[first.rendition.type],
      title: group.find(item => item.metadata?.title)?.metadata?.title || primary.fileName,
      taskId: (group.find(item => item.metadata?.taskId)?.metadata?.taskId ?? null) as ArtifactTaskId | null,
      updatedAt: first.rendition.updatedAt,
      updatedDate: first.metadata !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(first.metadata.updated) ? first.metadata.updated : null,
      canonicalId: canonical.id, primaryId: primary.id, renditions,
    })
  }
  return entries.sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || a.id.localeCompare(b.id))
}
