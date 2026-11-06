/** Process-local evidence for Goal-human writes refused before filesystem publication. */
import { createHash } from 'node:crypto'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { KnowledgeDocumentId, KnowledgeGoalOperation, KnowledgeLocationRevision } from './types.ts'

/** File observation made under the Brain and page writer locks. */
export interface GoalWriteObservation {
  snapshot?: { readonly locationRevision: KnowledgeLocationRevision | null
    readonly targetKey: string
    readonly version: string | null }
  writeStarted: boolean
}

interface GoalPrewriteProof {
  readonly workspaceId: string
  readonly documentId: KnowledgeDocumentId
  readonly operationDigest: string
  readonly snapshot: NonNullable<GoalWriteObservation['snapshot']>
}

const proofs = new WeakMap<object, GoalPrewriteProof>()

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  return value
}

/** Typed only for a joined Goal-human operation rejected before its file write began. */
export class GoalPrewriteRefusal extends Error {
  /** @param cause - deterministic Brain or Goal-owner catalog refusal before filesystem publication. */
  constructor(cause: Error) { super(cause.message, { cause }); this.name = 'GoalPrewriteRefusal' }
}

/** Bind a Goal operation to its full original request and human evidence.
 * @param workspaceId - original project of the signed Goal Task.
 * @param documentId - exact selected Brain page.
 * @param operation - complete Goal-human operation, including its UUID and retained identity.
 * @returns stable digest used only for same-process refusal inspection.
 */
export function goalOperationDigest(workspaceId: string, documentId: KnowledgeDocumentId,
  operation: KnowledgeGoalOperation): string {
  return createHash('sha256').update(JSON.stringify(canonical([workspaceId, documentId, operation]))).digest('hex')
}

/** Preserve a deterministic refusal only when a locked file snapshot precedes every write.
 * @param error - exact Brain or Goal-owner catalog refusal, not a transport failure.
 * @param observation - the original joined attempt's file snapshot and write phase.
 * @param workspaceId - original project.
 * @param documentId - exact page.
 * @param operation - complete original operation.
 * @param origin - Brain's deterministic refusal or Task owner's exact catalog refusal.
 * @returns an in-process typed refusal, or the unchanged error when proof is unavailable.
 */
export function goalPrewriteRefusal(error: unknown, observation: GoalWriteObservation | undefined,
  workspaceId: string, documentId: KnowledgeDocumentId, operation: KnowledgeGoalOperation,
  origin: 'brain' | 'task-catalog' = 'brain'): unknown {
  const failure = remoteErrorOf(error)
  const brainRefusal = failure?.code === 'knowledge/update'
    && (failure.details.reason === 'conflict' || failure.details.reason === 'read-only'
      || failure.details.reason === 'duplicate')
  const taskCatalogRefusal = failure?.code === 'project-task/rejected'
    && failure.details.reason === 'knowledge-review-conflict'
  if (!(error instanceof Error) || observation?.snapshot === undefined || observation.writeStarted
    || !(origin === 'brain' ? brainRefusal : taskCatalogRefusal)) return error
  const refusal = new GoalPrewriteRefusal(error)
  proofs.set(refusal, { workspaceId, documentId, operationDigest: goalOperationDigest(workspaceId, documentId, operation),
    snapshot: observation.snapshot })
  return refusal
}

/** Recover only evidence owned by this Host process and exact caught error object.
 * @param failure - same error object caught from the joined Goal writer call.
 * @returns locked pre-write evidence, or undefined after restart, serialization, or another failure.
 */
export function goalPrewriteProof(failure: unknown): GoalPrewriteProof | undefined {
  return typeof failure === 'object' && failure !== null ? proofs.get(failure) : undefined
}
