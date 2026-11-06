/** Decode file-owned knowledge metadata without executing YAML tags or expanding aliases. */
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectKnowledgeLinks } from './links.ts'
import { knowledgeSource } from './source.ts'
import { readImportPublicationHold } from './import-publication-hold.ts'
import { readTaskPublicationHold } from './task-publication-hold.ts'
import { readGoalPublicationHold } from './goal-publication-hold.ts'
import { normalizeKnowledgeTags } from './tag-values.ts'
import { readTruthRecords } from './truth-records.ts'
import { readProposalRecords } from './proposal-records.ts'
import { ROOT_DOCUMENTS, readRootOperations } from './root-records.ts'
import type { KnowledgeDocument, KnowledgeDocumentId, KnowledgeTimelineEntry } from './types.ts'

export { ROOT_DOCUMENTS } from './root-records.ts'

const metadata = z.object({
  id: z.string().optional(), title: z.string().optional(), category: z.string().optional(),
  tags: z.unknown().optional().transform(normalizeKnowledgeTags), status: z.enum(['active', 'draft', 'archived']).default('active'),
  created: z.string().optional(), updated: z.string().optional(),
})
const timelineSchema = z.array(z.object({
  time: z.string(), kind: z.string(), summary: z.string(),
  source: z.string().nullable().default(null), affects: z.array(z.string()).default([]),
  evidence: z.string().nullable().default(null),
  author: z.string().optional(),
  dsh_session_id: z.string().min(1).refine(value => !value.includes('\0')).optional(),
}))

/**
 * Parse one bounded UTF-8 Markdown document and its optional YAML metadata.
 * @param id - validated Brain-relative path.
 * @param text - complete file content.
 * @param version - version observed around the read.
 * @returns metadata with the first trimmed body line as its summary, unprojected body, display Markdown, and structured Timeline rows.
 */
export function parseKnowledgeDocument(id: KnowledgeDocumentId, text: string, version: string): KnowledgeDocument {
  try {
    const kind = ROOT_DOCUMENTS.some(path => path === id) ? 'root' : 'page'
    const source = knowledgeSource(text, kind === 'page')
    if (kind === 'root') readRootOperations(id, source)
    readTruthRecords(id, source)
    const proposals = readProposalRecords(id, source)
    const fields = metadata.parse(source.frontmatter.value ?? {})
    const importHold = readImportPublicationHold(source.frontmatter.value)
    const taskHold = readTaskPublicationHold(source.frontmatter.value)
    const goalHold = readGoalPublicationHold(source.frontmatter.value)
    if (Number(importHold !== null) + Number(taskHold !== null) + Number(goalHold !== null) > 1) {
      throw new Error('knowledge page cannot have two publication holds')
    }
    if (importHold !== null && (kind !== 'page' || fields.status === 'active')) {
      throw new Error('knowledge import publication hold requires a non-active page')
    }
    if (taskHold !== null && (kind !== 'page' || fields.status === 'active')) {
      throw new Error('knowledge Task publication hold requires a non-active page')
    }
    if (goalHold !== null && (kind !== 'page' || fields.status === 'active')) {
      throw new Error('knowledge Goal publication hold requires a non-active page')
    }
    const body = source.body
    const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
    const title = fields.title?.trim() || firstHeading || id.replace(/\.md$/i, '').split('/').at(-1) || id
    const timeline: KnowledgeTimelineEntry[] = timelineSchema.parse(source.timeline.value ?? []).map(({ dsh_session_id, ...entry }) => ({
      ...entry, ...dsh_session_id === undefined ? {} : { sourceSessionId: dsh_session_id as SessionId },
    }))
    const display = kind === 'page'
      ? source.truth.replace(/^(?:<!--\s*compiled_truth\s*-->|##[ \t]+compiled_truth)[ \t]*(?:\n|$)\s*/, '') : source.truth
    const firstLine = display.trim().split('\n', 1).join('')
    const summary = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
    const heading = /^#\s+(.+)\n*/.exec(display)
    const markdown = heading?.[1]?.trim() === title ? display.slice(heading[0].length) : display
    const linked = projectKnowledgeLinks(markdown)
    return {
      entry: {
        id, slug: fields.id ?? id.replace(/^pages\//, '').replace(/\.md$/i, ''), title,
        kind,
        status: fields.status, category: fields.category ?? null, tags: fields.tags,
        createdAt: fields.created ?? null, updatedAt: fields.updated ?? null, version, references: linked.references,
        pendingProposalCount: proposals.filter(proposal => proposal.resolution === null).length,
        summary, searchText: [title, body].join('\n'),
      },
      body: display, markdown: linked.markdown, timeline,
    }
  } catch (error) {
    throw new RemoteError('knowledge/document', String(error), { path: id, reason: 'invalid' })
  }
}

/** Keep human-only navigation metadata outside ordinary and native model reads.
 * @param timeline - parsed display observations.
 * @returns the existing model-visible Timeline fields, without changing their values or order.
 */
export function modelKnowledgeTimeline(timeline: readonly KnowledgeTimelineEntry[]): readonly Omit<KnowledgeTimelineEntry, 'sourceSessionId'>[] {
  return timeline.map(({ time, kind, summary, source, affects, evidence, author }) => ({ time, kind, summary, source, affects, evidence,
    ...author === undefined ? {} : { author } }))
}
