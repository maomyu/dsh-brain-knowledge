/** Root-only publication receipts and exact body bytes, independent of page Timeline storage. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Document } from 'yaml'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { knowledgeSource } from './source.ts'
import type { KnowledgeDocumentId, KnowledgeRootWrite, KnowledgeUpdateId } from './types.ts'

/** Fixed root identities; arbitrary top-level Markdown does not acquire root write authority. */
export const ROOT_DOCUMENTS = ['background.md', 'architecture.md', 'flow.md', 'mindmap.md', 'stack.md', 'roadmap.md'] as const

const uuid = z.uuid().transform(value => value as KnowledgeUpdateId)
const nonempty = z.string().refine(value => value.trim().length > 0 && !value.includes('\0'))
const publication = z.object({ at: z.iso.datetime(), summary: nonempty, source: nonempty, evidence: nonempty }).strict()
const receipt = z.object({ id: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/), publication: publication.optional() }).strict()

/** Ordinary root receipts may retain publication attribution; historical and signed Goal receipts remain valid without it. */
export type RootOperationRecord = z.infer<typeof receipt>

/** Parse complete root receipts without inventing source references for legacy writes.
 * @param id - root identity used for diagnostics.
 * @param source - complete parsed document.
 * @returns unique validated operation receipts.
 */
export function readRootOperations(id: KnowledgeDocumentId, source: ReturnType<typeof knowledgeSource>): RootOperationRecord[] {
  const fields = source.frontmatter.value as Record<string, unknown> | null
  const parsed = z.array(receipt).safeParse(fields?.dsh_root_operations ?? [])
  if (!parsed.success) throw new RemoteError('knowledge/update', 'Root retry metadata is malformed', { path: id, reason: 'identity-conflict' })
  if (new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) {
    throw new RemoteError('knowledge/update', 'Root retry identities are ambiguous', { path: id, reason: 'identity-conflict' })
  }
  if (fields?.dsh_goal_change_operations !== undefined) {
    const goal = z.array(z.object({ operationId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .safeParse(fields.dsh_goal_change_operations)
    if (!goal.success || new Set(goal.data.map(row => row.operationId)).size !== goal.data.length) {
      throw new RemoteError('knowledge/update', 'Goal operation identities are malformed or ambiguous', { path: id, reason: 'identity-conflict' })
    }
    for (const row of parsed.data) {
      if (!goal.data.some(item => item.operationId === row.id)) continue
      const changes = z.array(z.looseObject({ rewrites: z.array(z.looseObject({ operationId: uuid })) })).safeParse(fields.dsh_goal_changes)
      if (row.publication !== undefined || !changes.success
        || changes.data.flatMap(change => change.rewrites).filter(rewrite => rewrite.operationId === row.id).length !== 1) {
        throw new RemoteError('knowledge/update', 'Root and Goal operation identities conflict', { path: id, reason: 'identity-conflict' })
      }
    }
  }
  return parsed.data
}

/** Bind the exact request and root publication mode to a retry receipt.
 * @param id - fixed root identity.
 * @param request - complete unmodified publication input.
 * @param verbatim - true for human proposal decisions that publish the displayed complete body without title normalization.
 * @returns deterministic request digest; canonical writes keep their existing digest format.
 */
export function rootWriteDigest(id: KnowledgeDocumentId, request: KnowledgeRootWrite, verbatim = false): string {
  return createHash('sha256').update(JSON.stringify([verbatim ? 'root-verbatim' : 'root', id, request.expectedVersion,
    request.body, request.reason, request.source, request.evidence])).digest('hex')
}

function header(text: string): string {
  return /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? (text.startsWith('\uFEFF') ? '\uFEFF' : '')
}

/** Separate the original root body without trimming, newline conversion or heading replacement.
 * @param text - complete validated root file.
 * @returns every byte after its optional frontmatter and document BOM.
 */
export function rootBody(text: string): string {
  return text.slice(header(text).length)
}

/** Replace root metadata and publish exactly the supplied body, including its whitespace and heading.
 * @param text - current file supplying BOM and metadata newline convention.
 * @param metadata - complete retained YAML document.
 * @param body - complete root body; never reparsed as a page Timeline.
 * @returns complete file with the unchanged body suffix.
 */
export function serializeRootBody(text: string, metadata: Document, body: string): string {
  const newline = header(text).includes('\r\n') ? '\r\n' : '\n'
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  return `${bom}---${newline}${metadata.toString({ lineWidth: 0 }).replaceAll('\n', newline)}---${newline}${body}`
}
