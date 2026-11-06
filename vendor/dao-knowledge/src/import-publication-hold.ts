/** Validate the file-owned import publication hold before any Brain reader or writer trusts it. */
import { z } from 'zod'
import type { KnowledgeImportPublicationHold } from './types.ts'

/** Reserved frontmatter key retained until the reviewed draft is explicitly published. */
export const IMPORT_PUBLICATION_HOLD_KEY = 'dsh_import_publication_hold'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const schema = z.object({
  version: z.literal(1),
  importId: z.uuid(),
  proposalMessageId: z.string().min(1).refine(value => !value.includes('\0')),
  proposalSha256: digest,
  changeSha256: digest,
  draftOperationId: z.uuid(),
}).strict()

/** Parse an optional hold from a page's complete YAML frontmatter.
 * @param metadata - parsed frontmatter value, not an untrusted caller assertion.
 * @returns the validated hold or null when no hold is present.
 * @throws for malformed or non-object frontmatter and malformed reserved metadata.
 */
export function readImportPublicationHold(metadata: unknown): KnowledgeImportPublicationHold | null {
  if (metadata === null || metadata === undefined) return null
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('knowledge frontmatter must be an object')
  const fields = metadata as Record<string, unknown>
  if (!(IMPORT_PUBLICATION_HOLD_KEY in fields)) return null
  const parsed = schema.safeParse(fields[IMPORT_PUBLICATION_HOLD_KEY])
  if (!parsed.success) throw new Error('knowledge import publication hold is malformed')
  return parsed.data as KnowledgeImportPublicationHold
}

/** Validate trusted import intent before writing it to a Brain page.
 * @param hold - import identity and exact proposal/change digest.
 * @returns serializable hold metadata with validated field values.
 */
export function validateImportPublicationHold(hold: KnowledgeImportPublicationHold): KnowledgeImportPublicationHold {
  const parsed = schema.safeParse(hold)
  if (!parsed.success) throw new Error('knowledge import publication hold is malformed')
  return parsed.data as KnowledgeImportPublicationHold
}

/** Compare all retained hold fields, including the original draft operation.
 * @param actual - hold read from the page.
 * @param expected - import owner's exact retained hold.
 * @returns whether the identities match.
 */
export function sameImportPublicationHold(actual: KnowledgeImportPublicationHold, expected: KnowledgeImportPublicationHold): boolean {
  return actual.importId === expected.importId
    && actual.proposalMessageId === expected.proposalMessageId && actual.proposalSha256 === expected.proposalSha256
    && actual.changeSha256 === expected.changeSha256 && actual.draftOperationId === expected.draftOperationId
}

/** Stable ordered identity for writer receipts, independent of object key insertion order.
 * @param hold - validated import publication hold.
 * @returns every retained field in its fixed digest order.
 */
export function importPublicationHoldIdentity(hold: KnowledgeImportPublicationHold): readonly (string | number)[] {
  return [hold.version, hold.importId, hold.proposalMessageId, hold.proposalSha256, hold.changeSha256, hold.draftOperationId]
}
