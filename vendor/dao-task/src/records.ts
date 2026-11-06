/** Validated task intent and execution receipts over the existing storage-domain provider. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { reviewStateSchema, reviewPolicySchema } from './review-records.ts'
import type { ProjectTaskCodingConfirmation } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectGoalRequestId, ProjectGoalRunId, ProjectSubGoalId, ProjectTaskCardId, ProjectTaskId,
  ProjectTaskState, ProjectTaskCodexThreadId, ProjectTaskKnowledgeOperationId,
  ProjectTaskKnowledgeCandidateId, ProjectTaskKnowledgeDiscoveryRequestId,
  ProjectTaskKnowledgeDocumentId } from './types.ts'
import { goalPlanSchema } from './goal-plan.ts'
import { goalBudgetSchema, goalModelsSchema, goalReviewSchema, goalTaskModelSchema } from './goal-review.ts'
import { isNativeGoalModel } from './goal-model.ts'
import { gitWorkspaceSchema } from './git-workspace.ts'
import { goalMergeSchema } from './goal-merge.ts'
import { goalOutcomeSchema, goalReportSchema } from './goal-results.ts'
import { goalControlRecordSchema } from './goal-control.ts'
import { goalCreditsSchema, taskUsageSchema } from './goal-budget.ts'
import { goalDeliveryRecordSchema } from './goal-delivery.ts'
import { taskWrapUpSchema } from './task-wrap-up.ts'
import { goalCapabilityRecordSchema } from './goal-capabilities.ts'
import { researchDirectorySchema, researchReportSchema } from './research.ts'
import { taskArtifactSchema } from './artifact-task.ts'
import type { ArtifactRenditionId } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { ProjectTaskClaudeSessionId } from './types.ts'
import { automaticKnowledgeState } from './knowledge-maintenance.ts'

/** New confirmation permission; released records may omit it but cannot acquire it during recovery. */
export const knowledgeMaintenanceAuthorizationSchema = z.object({
  mode: z.enum(['automatic', 'read-only']),
  authorizationId: z.uuid().transform(value => brandString<import('./types.ts').ProjectTaskKnowledgeAuthorizationId>(value)),
}).strict()

/** Goal entry validation at remote, tool and durable reads. */
export const goalRequestSchema = z.object({
  requestId: z.string().min(1).transform(value => brandString<ProjectGoalRequestId>(value)),
  sourceSessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  goal: z.string().trim().min(1),
}).strict()

const planSubmissionSchema = z.object({ requestId: goalRequestSchema.shape.requestId, input: goalPlanSchema,
  submittedAt: z.number().int().nonnegative() }).strict()
const planReviewSchema = z.object({ input: goalReviewSchema, delivery: z.enum(['pending', 'sent']),
  knowledgeMaintenanceAuthorization: knowledgeMaintenanceAuthorizationSchema.optional(),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  models: goalModelsSchema.optional(), preparation: gitWorkspaceSchema.optional(),
  inputText: z.string().min(1).optional() }).strict().refine(value => value.knowledgeMaintenanceAuthorization === undefined
    || value.input.decision === 'approve' && value.input.knowledgeMaintenance === value.knowledgeMaintenanceAuthorization.mode,
'Goal maintenance permission must match its exact explicit approval')
const planHistorySchema = z.object({ plan: planSubmissionSchema, review: planReviewSchema,
  taskIds: z.array(z.uuid().transform(value => brandString<ProjectTaskId>(value))),
  outcomes: z.array(goalOutcomeSchema).optional(), budgetCredits: goalCreditsSchema.optional(),
  budget: goalBudgetSchema.optional(), controlCount: z.number().int().nonnegative(),
  retiredAt: z.number().int().nonnegative(),
}).strict().refine(item => item.review.delivery === 'sent' && item.review.inputText !== undefined
  && item.review.input.planRequestId === item.plan.requestId && item.retiredAt >= item.plan.submittedAt
  && (item.review.input.decision === 'approve' ? item.review.models !== undefined && item.budget !== undefined
    : item.taskIds.length === 0 && item.outcomes === undefined && item.budgetCredits === undefined && item.budget === undefined)
  && item.budgetCredits?.passed.every(mark => item.plan.input.subGoals
    .find(subGoal => subGoal.id === mark.subGoalId)?.criteria[mark.index] !== undefined) !== false,
'retired plans retain their delivered approval and original criteria')

const goalRecordSchema = goalRequestSchema.extend({
  id: z.uuid().transform(value => brandString<ProjectGoalRunId>(value)),
  workspaceId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  workspacePath: z.string().min(1),
  phase: z.enum(['GATHER', 'SIGNOFF', 'PLAN', 'RUNNING', 'PAUSED', 'DONE', 'ESCALATED', 'EXITED']),
  controls: z.array(goalControlRecordSchema).optional(),
  deliveries: z.array(goalDeliveryRecordSchema).optional(),
  budgetCredits: goalCreditsSchema.optional(),
  outcomes: z.array(goalOutcomeSchema).optional(),
  modelCapabilities: z.array(goalCapabilityRecordSchema).optional(),
  entryGoal: z.string().min(1).optional(),
  plan: planSubmissionSchema.optional(),
  review: planReviewSchema.optional(),
  planHistory: z.array(planHistorySchema).min(1).optional(),
  integration: gitWorkspaceSchema.optional(),
  sequence: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).refine((record) => {
  const plan = record.plan
  const outcomes = [...record.planHistory?.flatMap(item => item.outcomes ?? []) ?? [], ...record.outcomes ?? []]
  return record.updatedAt >= record.createdAt
  && new Set(outcomes.map(item => item.requestId)).size === outcomes.length
  && (record.planHistory === undefined || (plan !== undefined && record.phase !== 'GATHER'
    && new Set([...record.planHistory.map(item => item.plan.requestId), plan.requestId]).size === record.planHistory.length + 1
    && new Set(record.planHistory.flatMap(item => item.taskIds)).size
      === record.planHistory.reduce((count, item) => count + item.taskIds.length, 0)
    && new Set([...record.planHistory.map(item => item.review.input.requestId),
      ...record.review === undefined ? [] : [record.review.input.requestId]]).size
      === record.planHistory.length + (record.review === undefined ? 0 : 1)
    && record.planHistory.every((item, index, history) => item.plan.submittedAt >= record.createdAt
      && item.retiredAt <= (history[index + 1]?.plan.submittedAt ?? plan.submittedAt)
      && item.controlCount <= (history[index + 1]?.controlCount ?? record.controls?.length ?? 0))))
  && (record.modelCapabilities === undefined || (new Set(record.modelCapabilities.map(item => item.input.requestId)).size
    === record.modelCapabilities.length
    && record.modelCapabilities.every(item => item.value.recordedAt >= record.createdAt && item.value.recordedAt <= record.updatedAt)))
  && (record.deliveries === undefined || ((record.integration !== undefined
      || record.deliveries.every(item => item.status === 'kept'))
    && (['DONE', 'ESCALATED', 'EXITED'].includes(record.phase)
      || record.deliveries.every(item => item.status === 'kept' || item.status === 'conflict'))
    && new Set(record.deliveries.map(item => item.input.requestId)).size === record.deliveries.length
    && record.deliveries.every((item, index) => !['pending', 'merged', 'checked-out'].includes(item.status)
      || index + 1 === record.deliveries?.length)))
  && (record.budgetCredits === undefined || (record.review?.input.decision === 'approve'
    && record.budgetCredits.passed.every(mark => record.plan?.input.subGoals
      .find(item => item.id === mark.subGoalId)?.criteria[mark.index] !== undefined)))
  && (!['SIGNOFF', 'PLAN', 'RUNNING', 'PAUSED', 'DONE', 'ESCALATED'].includes(record.phase) || record.plan !== undefined)
  && (record.controls === undefined || ((record.review?.input.decision === 'approve'
    || record.planHistory?.some(item => item.review.input.decision === 'approve') || record.controls.every(item => item.input.action === 'exit'))
    && new Set(record.controls.map(item => item.input.requestId)).size === record.controls.length
    && record.controls.every((item, index) => item.input.revision === index
      && (item.input.action !== 'exit' || (index + 1 === record.controls?.length && record.phase === 'EXITED'))
      && (item.delivery === 'sent' || (index + 1 === record.controls?.length
        && record.phase === (item.input.action === 'exit' ? 'EXITED' : item.input.action === 'pause' ? 'PAUSED' : 'RUNNING'))))))
  && (record.phase !== 'PAUSED' || record.controls?.at(-1)?.input.action === 'pause')
  && (record.outcomes === undefined || (record.review?.input.decision === 'approve'
    && new Set(record.outcomes.map(item => item.requestId)).size === record.outcomes.length))
  && (record.phase !== 'GATHER' || (record.plan === undefined && record.review === undefined))
  && (record.review === undefined || (record.plan?.requestId === record.review.input.planRequestId
    && (record.review.delivery !== 'sent' || record.review.inputText !== undefined)
    && (record.review.input.decision !== 'approve' || record.review.models !== undefined)))
  && (!['RUNNING', 'PAUSED', 'DONE', 'ESCALATED'].includes(record.phase)
    || record.review?.input.decision === 'approve')
  && (record.phase !== 'PLAN' || record.review?.input.decision === 'reject')
  && (record.plan === undefined || (record.plan.submittedAt >= record.createdAt
    && record.plan.submittedAt <= record.updatedAt && record.plan.input.goal === record.goal && record.entryGoal !== undefined))
},
'goal phase, submitted plan and timestamps must agree')

/** Private project ownership retained independently of Session generations. */
export type ProjectGoalRecord = z.infer<typeof goalRecordSchema>

/** Goal identities and terminal history survive without activating a goal-round driver. */
export const projectGoalDomain = defineDomain({
  name: 'project_goals', version: 1,
  tables: { runs: domainTable<ProjectGoalRunId, ProjectGoalRecord>(goalRecordSchema) },
})

/** Wire and durable validation; deployment byte and count limits belong to the controller. */
export const proposalSchema = z.object({
  id: z.uuid().transform(value => brandString<ProjectTaskId>(value)),
  title: z.string().trim().min(1), description: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)),
  verifySteps: z.array(z.string().trim().min(1)),
  affectedFiles: z.array(z.string().trim().min(1)).optional(),
  isolation: z.enum(['direct', 'worktree', 'tempdir']),
  model: goalModelsSchema.shape.master.optional(),
  knowledgeMaintenance: z.enum(['automatic', 'read-only']).optional(),
  research: z.object({ sourceSessionId: goalRequestSchema.shape.sourceSessionId }).strict().optional(),
  artifact: z.object({ sourceSessionId: goalRequestSchema.shape.sourceSessionId, type: z.literal('docs'),
    trace: z.object({ page: z.string().trim().min(1), framework: z.string().trim().min(1) }).strict().optional(),
  }).strict().optional(),
  brainRefs: goalPlanSchema.shape.brainRefs.optional(),
  rootPageRefs: goalPlanSchema.shape.rootPageRefs.optional(),
}).strict()

/** Exact-run dispatch input; the approved plan supplies title and acceptance criteria. */
export const goalDispatchSchema = z.object({
  requestId: goalRequestSchema.shape.requestId,
  subGoalId: z.string().trim().min(1).transform(value => brandString<ProjectSubGoalId>(value)),
  taskType: z.enum(['coding', 'deep-research', 'documentation']).optional(),
  description: z.string().trim().min(1), model: goalTaskModelSchema.optional(),
}).strict()

/** Pre-plan instructions own their title and knowledge selection, not signed criteria. */
export const goalGatherDispatchSchema = z.object({
  requestId: goalRequestSchema.shape.requestId,
  subGoalId: z.undefined().optional(),
  probe: z.undefined().optional(), model: z.undefined().optional(),
  taskType: z.enum(['coding', 'deep-research']),
  title: proposalSchema.shape.title, description: proposalSchema.shape.description,
  acceptanceCriteria: proposalSchema.shape.acceptanceCriteria.optional(),
  verifySteps: proposalSchema.shape.verifySteps.optional(), affectedFiles: proposalSchema.shape.affectedFiles,
  brainRefs: proposalSchema.shape.brainRefs, rootPageRefs: proposalSchema.shape.rootPageRefs,
}).strict()

/** Unbound research subject and runner validated independently against the signed model pool. */
export const goalProbeDispatchSchema = goalGatherDispatchSchema.extend({
  taskType: z.literal('deep-research'),
  probe: z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) }).strict(),
  model: goalTaskModelSchema.optional(),
})

const boundGoalTaskSchema = z.object({
  runId: z.uuid().transform(value => brandString<ProjectGoalRunId>(value)),
  sourceSessionId: goalRequestSchema.shape.sourceSessionId,
  gather: z.undefined().optional(),
  probe: z.undefined().optional(),
  request: goalDispatchSchema,
  model: goalTaskModelSchema,
  integration: gitWorkspaceSchema.optional(),
}).strict()

const goalTaskBindingSchema = z.union([boundGoalTaskSchema, boundGoalTaskSchema.extend({
  gather: z.literal(true), request: goalGatherDispatchSchema, model: goalModelsSchema.shape.master, integration: z.undefined().optional(),
}), boundGoalTaskSchema.extend({
  probe: z.literal(true), request: goalProbeDispatchSchema, integration: z.undefined().optional(),
})]).refine(binding => binding.gather === true || binding.probe === true
  || (binding.request.taskType === 'coding' || binding.request.taskType === undefined
    ? binding.integration !== undefined : binding.integration === undefined),
'Only coding dispatches retain Goal Git integration')

/** Durable dispatch authority committed atomically with the Task proposal. */
export type ProjectGoalTaskBinding = z.infer<typeof goalTaskBindingSchema>

/** Explicit native Task selection validated at confirmation and durable reads. */
export const codexSelectionSchema = z.object({
  sandbox: z.enum(['read-only', 'workspace-write']), model: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict()

/** Native Task policy validated at remote and durable reads; research requires plan, also available for interactive coding handoffs. */
export const claudeSelectionSchema = z.object({
  runtime: z.literal('claude'), permissionMode: z.enum(['dontAsk', 'acceptEdits', 'auto', 'plan']),
  model: z.string().trim().min(1).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).strict()

/** Explicit executor guidance validated independently of review authority. */
export const taskPostStepsSchema = z.object({ autoRunTests: z.boolean(), autoFix: z.boolean() }).strict()

/** Exact human selection, separate from model-authored Task proposals and filesystem paths. */
export const taskReviewSourceSelectionSchema = z.object({
  importId: z.uuid().transform(value => brandString<import('./types.ts').ProjectTaskReviewImportId>(value)),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  documentId: z.string().min(1).max(1024).transform(value => brandString<import('@deepseek-ai/dsh-api-document-import-controller/types').DocumentImportSourceId>(value)),
}).strict()

const taskReviewSourceReceiptSchema = taskReviewSourceSelectionSchema.extend({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  textBytes: z.number().int().nonnegative(),
}).strict()

const distinctTaskReviewSources = (sources: readonly { importId: string; documentId: string }[]): boolean =>
  new Set(sources.map(source => JSON.stringify([source.importId, source.documentId]))).size === sources.length

/** Wire confirmation syntax separates user execution choices from model-generated proposals. */
export const codingConfirmationSchema = z.object({
  execution: z.discriminatedUnion('runtime', [
    z.object({ runtime: z.literal('harness'), model: goalModelsSchema.shape.master.optional(), agentPreset: z.string().min(1).optional() }).strict(),
    z.object({ runtime: z.literal('codex'), selection: codexSelectionSchema }).strict(),
    z.object({ runtime: z.literal('claude'), selection: claudeSelectionSchema }).strict(),
  ]), review: reviewPolicySchema.optional(), postSteps: taskPostStepsSchema.optional(),
  knowledgeMaintenance: z.enum(['automatic', 'read-only']).optional(),
  reviewSources: z.array(taskReviewSourceSelectionSchema).min(1).refine(distinctTaskReviewSources).optional(),
}).strict().refine(value => value.review !== undefined || value.postSteps !== undefined || value.reviewSources !== undefined
  || value.knowledgeMaintenance !== undefined
  || value.execution.runtime === 'harness' && value.execution.agentPreset !== undefined,
'confirmation requires an explicit preset, review, post-steps or source choice').transform((value): ProjectTaskCodingConfirmation => ({
  ...(value.review === undefined ? {} : { review: value.review }),
  ...(value.postSteps === undefined ? {} : { postSteps: value.postSteps }),
  ...(value.reviewSources === undefined ? {} : { reviewSources: value.reviewSources }),
  ...(value.knowledgeMaintenance === undefined ? {} : { knowledgeMaintenance: value.knowledgeMaintenance }),
  execution: value.execution.runtime !== 'harness' ? value.execution : { runtime: 'harness',
    ...(value.execution.agentPreset === undefined ? {} : { agentPreset: value.execution.agentPreset }),
    ...(value.execution.model === undefined ? {} : { model: { provider: value.execution.model.provider,
      model: value.execution.model.model, ...(value.execution.model.reasoningEffort === undefined ? {}
        : { reasoningEffort: value.execution.model.reasoningEffort }) } }) } }))

/** Interactive handoff selections exclude Harness routes and retain native permission choices. */
export const terminalSelectionSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('codex'), selection: codexSelectionSchema }).strict(),
  z.object({ runtime: z.literal('claude'), selection: claudeSelectionSchema }).strict(),
])

const terminalRecordSchema = z.object({ phase: z.enum(['prepared', 'opened', 'unconfirmed']),
  selection: terminalSelectionSchema, inputText: z.string().min(1),
  directory: z.string().min(1), cwd: z.string().min(1), argv: z.array(z.string()).min(1),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  nativeSessionId: z.uuid().transform(value => brandString<ProjectTaskClaudeSessionId>(value)).optional(),
}).strict()

const executionBase = z.object({
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  inputText: z.string().min(1),
}).strict()

const harnessExecutionSchema = executionBase.extend({
  runtime: z.literal('harness').optional(),
  provider: z.string().min(1), model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(), agentPreset: z.string().min(1).optional(),
}).strict()

const executionSchema = z.union([harnessExecutionSchema, executionBase.extend({
  runtime: z.literal('codex'), selection: codexSelectionSchema,
  threadId: z.string().min(1).transform(value => brandString<ProjectTaskCodexThreadId>(value)).optional(),
}).strict(), executionBase.extend({
  runtime: z.literal('claude'), selection: claudeSelectionSchema,
  nativeSessionId: z.uuid().transform(value => brandString<ProjectTaskClaudeSessionId>(value)),
  initialized: z.boolean(),
}).strict()])

const goalDiscoveryBase = z.object({
  reportMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
})
const goalDiscoverySha = z.string().regex(/^[a-f0-9]{64}$/)
const comparedPageRecord = z.object({ path: z.string().min(1), version: z.string().min(1),
  relation: z.enum(['unrelated', 'unknown', 'duplicate', 'conflict', 'supports', 'supersedes']).optional(),
  quote: z.string().trim().min(1).max(240).optional(), reason: z.string().trim().min(1).max(240).optional(),
}).strict().refine(page => page.relation === undefined ? page.quote === undefined && page.reason === undefined
  : page.relation === 'unrelated' ? page.quote === undefined && page.reason === undefined
    : page.relation === 'unknown' ? page.quote === undefined && page.reason !== undefined
      : page.quote !== undefined && page.reason !== undefined,
'Semantic page relations require exact quoted old text and a short reason')
const goalDiscoveryPages = z.array(comparedPageRecord)
const knowledgeDiscoveryDiagnosticSchema = z.enum(['source-incomplete', 'source-read-failed', 'unsupported-result', 'input-limit',
  'model-route-failed', 'review-attempt-failed', 'output-limit', 'invalid-result', 'evidence-changed',
  'retention-limit', 'image-required', 'visual-unreadable', 'unknown'])
const importedPdfCoverageSchema = z.array(z.object({ sourceId: z.string().min(1), name: z.string().min(1),
  pageCount: z.number().int().positive(), renderedPages: z.array(z.number().int().positive()).readonly(),
  omittedReason: z.enum(['text-only-route', 'page-limit', 'byte-limit', 'render-failed']).optional(),
}).strict().refine(item => item.renderedPages.every((page, index) => {
  const previous = item.renderedPages[index - 1]
  return page <= item.pageCount && (index === 0 || previous !== undefined && page > previous)
})
  && (item.renderedPages.length === item.pageCount ? item.omittedReason === undefined : item.omittedReason !== undefined),
'PDF coverage identifies ordered supplied pages and a reason for omitted pages')).min(1).readonly()
const importedDocxCoverageSchema = z.array(z.object({ sourceId: z.string().min(1), name: z.string().min(1),
  imageCount: z.number().int().nonnegative(), suppliedImages: z.array(z.number().int().positive()).readonly(),
  omittedImages: z.array(z.object({ image: z.number().int().positive(),
    reason: z.enum(['text-only-route', 'image-limit', 'byte-limit', 'unsupported-format', 'unreadable-image']),
  }).strict()).readonly(), layoutReviewed: z.literal(false),
}).strict().refine((item) => {
  const all = [...item.suppliedImages, ...item.omittedImages.map(image => image.image)].sort((left, right) => left - right)
  return all.length === item.imageCount && all.every((image, index) => image === index + 1)
    && item.suppliedImages.every((image, index) => index === 0 || image > (item.suppliedImages[index - 1] as typeof image))
    && item.omittedImages.every((image, index) => index === 0 || image.image > (item.omittedImages[index - 1] as typeof image).image)
}, 'DOCX coverage partitions original embedded-image numbers without claiming Word layout review')).min(1).readonly()
const taskKnowledgeReviewFailureSchema = z.enum(['turn-incomplete', 'max-tokens', 'empty-final-text',
  'result-persistence-failed', 'unknown-execution-error'])
const taskKnowledgeInvalidResultSchema = z.enum(['json-syntax', 'schema', 'compared-page-set',
  'compared-page-quote', 'compared-page-relation',
  'new-page-topic-query', 'unexpected-topic-query', 'source-dispositions'])
const taskKnowledgeSchemaIssueSchema = z.object({
  field: z.enum(['result', 'decision', 'kind', 'reason', 'summary', 'proposedTruth', 'evidence',
    'comparedPages', 'comparedPages[].path', 'comparedPages[].version', 'comparedPages[].relation',
    'comparedPages[].quote', 'comparedPages[].reason', 'topicQuery', 'sourceDispositions']),
  rule: z.enum(['missing', 'type', 'empty', 'invalid-value', 'too-long', 'unexpected-field']),
}).strict()
const artifactCoverageSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: goalDiscoverySha,
    kind: z.literal('opaque'), reason: z.enum(['unsupported-format', 'unreadable-text', 'too-large',
      'unreadable', 'too-many-pages', 'no-readable-text']) }).strict(),
  z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: goalDiscoverySha,
    kind: z.literal('converted-text'), format: z.enum(['pdf', 'docx']),
    extraction: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pdf-text'), pageCount: z.number().int().nonnegative(),
        pagesWithoutText: z.array(z.number().int().positive()).readonly(),
        pagesWithTextAndPaintedImages: z.array(z.number().int().positive()).readonly().optional() }).strict(),
      z.object({ kind: z.literal('docx-text'), imageCount: z.number().int().nonnegative(),
        imagesWithoutDescription: z.number().int().nonnegative() }).strict(),
    ]) }).strict(),
])).readonly()
const sourceDispositionsSchema = z.array(z.object({
  sourceId: z.string().min(1), disposition: z.enum(['current', 'superseded', 'unresolved', 'not-relevant']),
  quote: z.string().min(1).optional(), rationale: z.string().trim().min(1),
}).strict().refine(item => item.disposition !== 'current' && item.disposition !== 'superseded'
  || item.quote !== undefined, 'Current or superseded source requires an exact quote')).readonly()
const taskKnowledgeBatchReceiptSchema = z.object({
  offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  sessionId: goalRequestSchema.shape.sourceSessionId,
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  inputSha256: goalDiscoverySha, outputSha256: goalDiscoverySha,
  finding: z.string().trim().min(1), comparedPages: goalDiscoveryPages.readonly(),
}).strict()
function contiguousKnowledgeBatches(progress: { readonly totalPages: number
  readonly nextOffset: number | null
  readonly batches: readonly { readonly offset: number
    readonly nextOffset: number | null
    readonly comparedPages: readonly unknown[] }[] }): boolean {
  let offset = 0
  for (const batch of progress.batches) {
    if (batch.offset !== offset || batch.comparedPages.length === 0 && progress.totalPages !== 0) return false
    const next = batch.offset + batch.comparedPages.length
    if (batch.nextOffset !== (next === progress.totalPages ? null : next)) return false
    offset = next
  }
  return progress.nextOffset === (offset === progress.totalPages ? null : offset)
}
const taskKnowledgeBatchProgressSchema = z.object({
  catalogSha256: goalDiscoverySha, locationRevision: z.string().nullable(),
  totalPages: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  resultSha256: goalDiscoverySha, taskEvidenceSha256: goalDiscoverySha,
  reviewEvidenceSha256: goalDiscoverySha.optional(),
  titleSearch: z.object({ query: z.string().max(256),
    hits: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()) }).strict(),
  batches: z.array(taskKnowledgeBatchReceiptSchema).min(1).readonly(),
}).strict().refine(contiguousKnowledgeBatches, 'Batch progress must cover a contiguous prefix of one catalog')
const goalKnowledgeBatchProgressSchema = z.object({
  catalogSha256: goalDiscoverySha, locationRevision: z.string().nullable(),
  totalPages: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  reportSha256: goalDiscoverySha, resultSha256: goalDiscoverySha,
  titleSearch: z.object({ query: z.string().max(256),
    hits: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()) }).strict(),
  batches: z.array(taskKnowledgeBatchReceiptSchema).min(1),
}).strict().refine(contiguousKnowledgeBatches, 'Goal batch progress must cover a contiguous prefix of one catalog')
const noChangeSourceDispositionsSchema = sourceDispositionsSchema.refine(dispositions => dispositions.length > 0
  && dispositions.every(item => item.quote !== undefined && item.disposition !== 'unresolved'),
'A no-change source review requires a quote for every resolved source').optional()
const noChangeSha256 = (discovery: unknown): string => createHash('sha256')
  .update(JSON.stringify(discovery)).digest('hex')
const goalKnowledgeCandidateSchema = goalDiscoveryBase.extend({ status: z.literal('candidate'),
  candidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)),
  discoveryId: goalRequestSchema.shape.sourceSessionId,
  goalRunId: z.uuid().transform(value => brandString<ProjectGoalRunId>(value)),
  planRequestId: goalRequestSchema.shape.requestId,
  reportSha256: goalDiscoverySha, resultSha256: goalDiscoverySha,
  catalogSha256: goalDiscoverySha.optional(), candidateSha256: goalDiscoverySha,
  artifactDirectory: z.object({ id: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
    version: z.string().min(1), digest: goalDiscoverySha,
    coverageSha256: goalDiscoverySha.optional() }).strict().optional(),
  artifactCoverage: artifactCoverageSchema.optional(),
  sourceDispositions: sourceDispositionsSchema.optional(),
  kind: z.enum(['existing-page', 'new-page', 'conflict']), summary: z.string().trim().min(1),
  proposedTruth: z.string().trim().min(1), evidence: z.string().trim().min(1),
  topicSearch: z.object({ query: z.string().trim().min(1).max(256), hits: goalDiscoveryPages }).strict().optional(),
  comparisonFormat: z.literal('semantic-v1').optional(),
  comparedPages: goalDiscoveryPages, reviewedAt: z.number().int().nonnegative(),
  batchReviews: z.array(taskKnowledgeBatchReceiptSchema).min(1).readonly().optional() }).strict()
const goalKnowledgeNoChangeSchema = goalDiscoveryBase.extend({ status: z.literal('no-change'),
  discoveryId: goalRequestSchema.shape.sourceSessionId.optional(),
  catalogSha256: goalDiscoverySha.optional(),
  reportSha256: goalDiscoverySha, resultSha256: goalDiscoverySha, reason: z.string().trim().min(1),
  comparisonFormat: z.literal('semantic-v1').optional(),
  comparedPages: goalDiscoveryPages, sourceDispositions: noChangeSourceDispositionsSchema,
  reviewedAt: z.number().int().nonnegative(),
  batchReviews: z.array(taskKnowledgeBatchReceiptSchema).min(1).readonly().optional() }).strict()
/** Parse durable Goal discovery states and their state-specific review and source receipts. */
export const goalKnowledgeDiscoverySchema = z.discriminatedUnion('status', [
  goalDiscoveryBase.extend({ status: z.literal('queued'),
    batchProgress: goalKnowledgeBatchProgressSchema.optional() }).strict(),
  goalDiscoveryBase.extend({ status: z.literal('reviewing'),
    requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
    attemptSessionId: goalRequestSchema.shape.sourceSessionId,
    attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
    batchProgress: goalKnowledgeBatchProgressSchema.optional() }).strict(),
  goalDiscoveryBase.extend({ status: z.literal('blocked'),
    failure: z.enum(['unavailable', 'interrupted', 'missing-evidence']),
    diagnostic: knowledgeDiscoveryDiagnosticSchema.optional(),
    reviewFailure: taskKnowledgeReviewFailureSchema.optional(),
    requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)).optional(),
    attemptSessionId: goalRequestSchema.shape.sourceSessionId.optional(),
    attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)).optional(),
    batchProgress: goalKnowledgeBatchProgressSchema.optional() }).strict()
    .refine(record => record.reviewFailure === undefined || record.diagnostic === 'review-attempt-failed',
      'Reviewer failure category requires a failed reviewer attempt'),
  goalKnowledgeNoChangeSchema,
  goalKnowledgeCandidateSchema,
])

/** One Goal-human decision is retained beside, not inside, ordinary Task card completion. */
export const goalKnowledgeSubjectSchema = z.object({
  workspaceId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  goalRunId: z.uuid().transform(value => brandString<ProjectGoalRunId>(value)),
  planRequestId: goalRequestSchema.shape.requestId,
  reportMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  reportSha256: goalDiscoverySha,
  discoveryId: goalRequestSchema.shape.sourceSessionId,
  candidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)),
  resultSha256: goalDiscoverySha,
  candidateSha256: goalDiscoverySha,
}).strict()

/** Wire and durable Goal-human requests reuse strict action validation without borrowing card authority. */
export const goalKnowledgeDecisionRequestSchema = z.object({
  subject: goalKnowledgeSubjectSchema, choice: z.lazy(() => taskKnowledgeDecisionRequestSchema),
}).strict()
/** Strict separate human Goal draft-publication request. */
export const goalKnowledgePublishRequestSchema = z.object({
  subject: goalKnowledgeSubjectSchema, publication: z.lazy(() => taskKnowledgePublishRequestSchema),
}).strict()
/** Strict separate human Goal publication-disposition request. */
export const goalKnowledgeAcknowledgeRequestSchema = z.object({
  subject: goalKnowledgeSubjectSchema, acknowledgement: z.lazy(() => taskKnowledgeAcknowledgeRequestSchema),
}).strict()

const goalKnowledgePrewriteConflictSchema = z.object({
  kind: z.enum(['decision', 'publication']),
  operationId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeOperationId>(value)),
  observedAt: z.number().int().nonnegative(),
}).strict()

const goalKnowledgeDecisionSchema = z.object({
  subject: goalKnowledgeSubjectSchema, decision: z.lazy(() => taskKnowledgeDecisionSchema),
  prewriteConflict: goalKnowledgePrewriteConflictSchema.optional(),
  abandonedOperations: z.array(goalKnowledgePrewriteConflictSchema).max(32).optional(),
}).strict().refine(value => value.subject.candidateId === value.decision.candidateId
  && value.subject.resultSha256 === value.decision.resultSha256
  && value.subject.candidateSha256 === value.decision.candidateSha256,
'Goal decision must retain the exact reviewed candidate').refine((value) => {
  const recovery = value.prewriteConflict
  if (recovery === undefined) return true
  if (recovery.kind === 'decision') return (value.decision.status === 'proposal-pending'
    || value.decision.status === 'draft-pending') && value.decision.decisionId === recovery.operationId
  return (value.decision.status === 'draft-saved' && value.decision.publication?.status === 'pending'
    && value.decision.publication.operationId === recovery.operationId)
}, 'A Goal pre-write finding must name the retained pending operation')

const automaticSearchSchema = z.object({ query: z.string().trim().min(1).max(256),
  hits: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()) }).strict()
const automaticRequestSchema = z.object({
  operationId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeOperationId>(value)),
  authority: z.object({ kind: z.enum(['task', 'goal']), sourceSessionId: goalRequestSchema.shape.sourceSessionId,
    taskSessionId: goalRequestSchema.shape.sourceSessionId, taskId: proposalSchema.shape.id,
    authorizationId: knowledgeMaintenanceAuthorizationSchema.shape.authorizationId,
    goalRunId: z.uuid().transform(value => brandString<ProjectGoalRunId>(value)).optional(),
    planRequestId: goalRequestSchema.shape.requestId.optional() }).strict().refine(value => value.kind === 'goal'
    ? value.goalRunId !== undefined && value.planRequestId !== undefined
    : value.goalRunId === undefined && value.planRequestId === undefined),
  reviewerSessionId: goalRequestSchema.shape.sourceSessionId, resultSha256: goalDiscoverySha,
  candidateSha256: goalDiscoverySha, candidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)),
  locationRevision: z.string().nullable(), catalogSha256: goalDiscoverySha,
  sourceCoverage: z.enum(['complete', 'incomplete']),
  sources: z.array(z.object({ sourceId: z.string().min(1), text: z.string() }).strict()).min(1),
  sourceDispositions: sourceDispositionsSchema, comparedPages: goalDiscoveryPages,
  titleSearch: automaticSearchSchema, topicSearch: automaticSearchSchema.optional(),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('update'), documentId: z.string().min(1).transform(value => brandString<ProjectTaskKnowledgeDocumentId>(value)),
      expectedVersion: z.string().min(1), truth: z.string().min(1), summary: z.string().min(1), evidence: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('create'), documentId: z.string().min(1).transform(value => brandString<ProjectTaskKnowledgeDocumentId>(value)),
      title: z.string().min(1), category: z.literal('decision'), tags: z.array(z.string().min(1)),
      truth: z.string().min(1), summary: z.string().min(1), evidence: z.string().min(1) }).strict(),
  ]),
}).strict()
const automaticIdentitySchema = z.object({ candidateId: automaticRequestSchema.shape.candidateId,
  resultSha256: goalDiscoverySha, candidateSha256: goalDiscoverySha }).strict()
const automaticFrozenSchema = automaticIdentitySchema.extend({ project: z.object({
  id: z.string().min(1).transform(value => brandString<WorkspaceId>(value)), path: z.string().min(1) }).strict(),
request: automaticRequestSchema }).strict()
/** Durable UUID request and certain receipt; unknown requires read-only inspection before any replay. */
export const knowledgeAutomaticSchema = z.discriminatedUnion('status', [
  automaticIdentitySchema.extend({ status: z.literal('deferred'),
    reason: z.enum(['conflict', 'source-incomplete', 'catalog-changed', 'unavailable']) }).strict(),
  automaticFrozenSchema.extend({ status: z.enum(['pending', 'unknown']) }).strict(),
  automaticFrozenSchema.extend({ status: z.literal('applied'), receipt: z.object({
    documentId: z.string().min(1).transform(value => brandString<ProjectTaskKnowledgeDocumentId>(value)),
    version: z.string().min(1), operationId: automaticRequestSchema.shape.operationId,
    disposition: z.enum(['written', 'already-applied']) }).strict() }).strict(),
]).refine(value => value.status === 'deferred' || value.candidateId === value.request.candidateId
  && value.resultSha256 === value.request.resultSha256 && value.candidateSha256 === value.request.candidateSha256
  && (value.status !== 'applied' || value.receipt.operationId === value.request.operationId
    && value.receipt.documentId === value.request.change.documentId), 'Automatic receipts retain their exact candidate and UUID')

const recordBase = z.object({
  knowledgeMaintenanceAuthorization: knowledgeMaintenanceAuthorizationSchema.optional(),
  proposal: proposalSchema,
  sourceSessionId: goalRequestSchema.shape.sourceSessionId.optional(),
  workspaceId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  workspacePath: z.string().min(1),
  preparation: gitWorkspaceSchema.optional(),
  reviewBaseCommit: z.string().regex(/^[0-9a-f]{40,64}$/).transform(value => brandString<import('./types.ts').ProjectGitCommitId>(value)).nullable().optional(),
  review: reviewStateSchema.optional(),
  automaticReview: reviewPolicySchema.optional(),
  postSteps: taskPostStepsSchema.optional(),
  reviewSources: z.array(taskReviewSourceReceiptSchema).min(1).refine(distinctTaskReviewSources).optional(),
  goal: goalTaskBindingSchema.optional(),
  researchDirectory: researchDirectorySchema.optional(),
  researchReport: researchReportSchema.optional(),
  researchWriteProtocol: z.literal('host-checkpoint-v1').optional(),
  artifactDirectory: researchDirectorySchema.optional(),
  // Released native Task records without this marker use their original directory collection path.
  artifactWriteProtocol: z.enum(['host-checkpoint-v1', 'host-checkpoint-v2']).optional(),
  artifactOutput: taskArtifactSchema.optional(),
  // Absence on released Task records forbids startup publication into historical projects.
  completionReportOnSuccess: z.literal(true).optional(),
  // Older Tasks have no output observation authority, including after a cold start.
  outputInventoryOnSuccess: z.literal(true).optional(),
  outputInventory: z.object({
    status: z.enum(['available', 'unavailable']), observedAt: z.number().int().nonnegative().nullable(),
    files: z.array(z.object({
      id: z.string().regex(/^[0-9a-f]{64}$/).transform(value => brandString<import('./types.ts').ProjectTaskOutputFileId>(value)),
      path: z.string().min(1), change: z.enum(['added', 'modified', 'deleted']),
      bytes: z.number().int().nonnegative().nullable(), version: z.string().min(1).nullable(), readable: z.boolean(),
    }).strict()), truncated: z.boolean(),
    reason: z.enum(['unsupported-isolation', 'interrupted', 'inspection-failed']).optional(),
  }).strict().refine(value => value.status === 'available'
    ? value.observedAt !== null && value.reason === undefined
      && new Set(value.files.map(file => file.id)).size === value.files.length
      && new Set(value.files.map(file => file.path)).size === value.files.length
      && value.files.every(file => file.readable
        ? file.change !== 'deleted' && file.version !== null
        : file.version === null && file.bytes === null)
    : value.observedAt === null && value.files.length === 0 && !value.truncated && value.reason !== undefined).optional(),
  completionReport: z.object({ artifactId: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
    fileName: z.string().min(1), contentSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    projectRelativePath: z.string().min(1).optional() }).strict().optional(),
  goalMerge: goalMergeSchema.optional(),
  goalReports: z.array(goalReportSchema).optional(),
  goalKnowledgeDiscovery: goalKnowledgeDiscoverySchema.optional(),
  goalKnowledgeAutomatic: z.lazy(() => knowledgeAutomaticSchema).optional(),
  goalKnowledgeDecision: goalKnowledgeDecisionSchema.optional(),
  goalKnowledgeHistory: z.array(z.union([
    z.object({ discovery: goalKnowledgeCandidateSchema, decision: goalKnowledgeDecisionSchema }).strict(),
    z.object({ kind: z.literal('no-change'), discovery: goalKnowledgeNoChangeSchema,
      refreshRequestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)) }).strict(),
  ])).max(16).optional(),
  goalKnowledgeRefresh: z.union([
    z.object({ requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
      sourceCandidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)) }).strict(),
    z.object({ requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
      sourceNoChangeSha256: goalDiscoverySha }).strict(),
  ]).optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  verifyCheckedIndices: z.array(z.number().int().nonnegative()),
  closedReason: z.string().min(1).nullable(),
  nativeFailure: z.object({ stopReason: z.string().min(1).max(64)
    ,
    diagnostic: z.string().max(4096).refine(value => Buffer.byteLength(value, 'utf8') <= 4096).optional(),
  }).strict().optional(),
  usage: taskUsageSchema.optional(),
  terminal: terminalRecordSchema.optional(),
}).strict()

const recordSchema = z.discriminatedUnion('status', [
  recordBase.extend({ status: z.literal('draft'), execution: z.undefined().optional() }),
  recordBase.extend({ status: z.literal('opened-terminal'), terminal: terminalRecordSchema, execution: z.undefined().optional() }),
  recordBase.extend({ status: z.literal('closed-cancelled'), execution: executionSchema.optional() }),
  recordBase.extend({ status: z.enum(['dispatched', 'running', 'closed-success', 'closed-failed']), execution: executionSchema }),
]).refine(record =>
  record.updatedAt >= record.createdAt
  && (record.postSteps === undefined || (record.execution !== undefined
    && record.terminal === undefined && record.proposal.research === undefined && record.proposal.artifact === undefined))
  && (record.automaticReview === undefined || (record.execution !== undefined
    && record.terminal === undefined && record.proposal.research === undefined && record.proposal.artifact === undefined
    && (record.preparation !== undefined || record.reviewBaseCommit != null)))
  && (record.review?.calls.every(call => call.origin === undefined || (record.automaticReview !== undefined
    && call.origin.sessionId === record.execution?.sessionId
    && call.selection.runtime === record.automaticReview.selection.runtime
    && call.allowFallback === record.automaticReview.allowFallback)) !== false)
  && (record.terminal === undefined || (record.status === 'opened-terminal' && record.goal === undefined
    && record.proposal.research === undefined && record.proposal.artifact === undefined
    && (record.terminal.selection.runtime === 'claude') === (record.terminal.nativeSessionId !== undefined)
    && (record.proposal.isolation !== 'worktree' || record.preparation !== undefined)))
  && (record.sourceSessionId === undefined || record.proposal.research === undefined
    || record.sourceSessionId === record.proposal.research.sourceSessionId)
  && (record.sourceSessionId === undefined || record.proposal.artifact === undefined
    || record.sourceSessionId === record.proposal.artifact.sourceSessionId)
  && (record.proposal.artifact === undefined || ((record.goal === undefined
      || record.goal.gather !== true && record.goal.probe !== true
        && record.goal.request.taskType === 'documentation')
    && (record.execution?.runtime !== 'codex' || record.execution.selection.sandbox === 'workspace-write')
    && (record.execution?.runtime !== 'claude' || record.execution.selection.permissionMode === 'dontAsk')))
  && (record.artifactDirectory === undefined || record.proposal.artifact !== undefined)
  && (record.artifactWriteProtocol === undefined || (record.proposal.artifact !== undefined
    && (record.execution?.runtime === 'codex' || record.execution?.runtime === 'claude')))
  && (record.researchWriteProtocol === undefined || (record.proposal.research !== undefined
    && (record.execution?.runtime === 'codex' || record.execution?.runtime === 'claude')
    && record.researchDirectory !== undefined))
  && (record.proposal.artifact === undefined || record.execution === undefined || record.artifactDirectory !== undefined)
  && (record.artifactOutput === undefined || (record.proposal.artifact !== undefined && record.status === 'closed-success'))
  && (record.completionReportOnSuccess === undefined || (record.execution !== undefined
    && record.proposal.research === undefined && record.proposal.artifact === undefined))
  && (record.outputInventoryOnSuccess === undefined || (record.execution !== undefined
    && record.proposal.research === undefined && record.proposal.artifact === undefined))
  && (record.outputInventory === undefined || (record.outputInventoryOnSuccess === true
    && record.status === 'closed-success'))
  && (record.completionReport === undefined || (record.proposal.research === undefined && record.proposal.artifact === undefined
    && record.status === 'closed-success'))
  && (record.proposal.artifact === undefined || record.status !== 'closed-success' || record.artifactOutput !== undefined)
  && validTaskIsolation(record.proposal)
  && (record.execution?.runtime !== 'claude'
    || (record.proposal.research === undefined ? record.execution.selection.permissionMode !== 'plan' : record.execution.selection.permissionMode === 'plan'))
  && (record.execution?.runtime !== 'codex' || record.proposal.research === undefined || record.execution.selection.sandbox === 'read-only')
  && (record.researchDirectory === undefined || record.proposal.research !== undefined)
  && (record.proposal.research === undefined || record.execution === undefined || record.researchDirectory !== undefined)
  && (record.researchReport === undefined || (record.proposal.research !== undefined && record.status === 'closed-success'))
  && (record.proposal.research === undefined || record.status !== 'closed-success' || record.researchReport !== undefined)
  && (record.usage === undefined || (record.status.startsWith('closed-') && record.execution !== undefined))
  && (record.nativeFailure === undefined || (record.status === 'closed-failed'
    && (record.execution.runtime === 'codex' || record.execution.runtime === 'claude')
    && record.nativeFailure.stopReason !== 'completed'))
  && (record.goalReports === undefined || (record.status.startsWith('closed-') && record.goal !== undefined
    && new Set(record.goalReports.map(item => item.requestId)).size === record.goalReports.length))
  && (record.goalKnowledgeDiscovery === undefined || (record.status === 'closed-success' && record.goal !== undefined
    && record.goal.gather !== true && record.goal.probe !== true
    && (record.proposal.research !== undefined ? record.researchReport?.contentSha256 !== undefined
      : record.proposal.artifact !== undefined ? record.artifactOutput?.type === 'docs'
        : record.preparation !== undefined && (record.goalMerge?.status === 'merged' || record.goalMerge?.status === 'empty'))
    && record.goalReports?.some(report => report.delivery === 'sent'
      && report.messageId === record.goalKnowledgeDiscovery?.reportMessageId) === true))
  && (record.goalKnowledgeDecision === undefined || (record.goalKnowledgeDiscovery?.status === 'candidate'
    && record.goalKnowledgeDecision.subject.workspaceId === record.workspaceId
    && record.goalKnowledgeDecision.subject.goalRunId === record.goal?.runId
    && record.goalKnowledgeDecision.subject.reportMessageId === record.goalKnowledgeDiscovery.reportMessageId
    && record.goalKnowledgeDecision.subject.planRequestId === record.goalKnowledgeDiscovery.planRequestId
    && record.goalKnowledgeDecision.subject.reportSha256 === record.goalKnowledgeDiscovery.reportSha256
    && record.goalKnowledgeDecision.subject.discoveryId === record.goalKnowledgeDiscovery.discoveryId
    && record.goalKnowledgeDecision.subject.candidateId === record.goalKnowledgeDiscovery.candidateId
    && record.goalKnowledgeDecision.subject.resultSha256 === record.goalKnowledgeDiscovery.resultSha256
    && record.goalKnowledgeDecision.subject.candidateSha256 === record.goalKnowledgeDiscovery.candidateSha256))
  && (record.goalKnowledgeAutomatic === undefined || (record.knowledgeMaintenanceAuthorization?.mode === 'automatic'
    && record.goalKnowledgeDiscovery?.status === 'candidate'
    && record.goalKnowledgeAutomatic.candidateId === record.goalKnowledgeDiscovery.candidateId
    && record.goalKnowledgeAutomatic.resultSha256 === record.goalKnowledgeDiscovery.resultSha256
    && record.goalKnowledgeAutomatic.candidateSha256 === record.goalKnowledgeDiscovery.candidateSha256
    && (record.goalKnowledgeAutomatic.status === 'deferred' || (record.goalKnowledgeAutomatic.project.id === record.workspaceId
      && record.goalKnowledgeAutomatic.project.path === record.workspacePath
      && record.goalKnowledgeAutomatic.request.authority.kind === 'goal'
      && record.goalKnowledgeAutomatic.request.authority.taskId === record.proposal.id
      && record.goalKnowledgeAutomatic.request.authority.taskSessionId === record.execution?.sessionId
      && record.goalKnowledgeAutomatic.request.authority.sourceSessionId === record.goal?.sourceSessionId
      && record.goalKnowledgeAutomatic.request.authority.goalRunId === record.goal.runId
      && record.goalKnowledgeAutomatic.request.authority.planRequestId === record.goalKnowledgeDiscovery.planRequestId
      && record.goalKnowledgeAutomatic.request.authority.authorizationId === record.knowledgeMaintenanceAuthorization.authorizationId))))
  && (record.goalKnowledgeHistory?.every(entry => 'kind' in entry
    ? z.uuid().safeParse(entry.refreshRequestId).success
    : entry.decision.subject.candidateId === entry.discovery.candidateId
      && entry.decision.subject.discoveryId === entry.discovery.discoveryId
      && entry.decision.subject.reportSha256 === entry.discovery.reportSha256
      && entry.decision.prewriteConflict?.kind === 'decision') !== false)
  && (record.goalKnowledgeRefresh === undefined || (() => {
    const refresh = record.goalKnowledgeRefresh
    return record.goalKnowledgeHistory?.some(entry => 'sourceCandidateId' in refresh
      ? !('kind' in entry) && entry.discovery.candidateId === refresh.sourceCandidateId
      : 'kind' in entry && entry.refreshRequestId === refresh.requestId
        && noChangeSha256(entry.discovery) === refresh.sourceNoChangeSha256) === true
  })())
  && (record.goalMerge === undefined || (record.status === 'closed-success' && record.goal !== undefined && record.preparation !== undefined))
  && (record.goal === undefined || ((record.goal.gather === true || record.goal.probe === true
    ? record.proposal.title === record.goal.request.title && record.proposal.description === record.goal.request.description
      && JSON.stringify(record.proposal.acceptanceCriteria) === JSON.stringify(record.goal.request.acceptanceCriteria ?? [])
      && JSON.stringify(record.proposal.verifySteps) === JSON.stringify(record.goal.request.verifySteps ?? [])
      && JSON.stringify(record.proposal.affectedFiles) === JSON.stringify(record.goal.request.affectedFiles)
      && JSON.stringify(record.proposal.brainRefs) === JSON.stringify(record.goal.request.brainRefs)
      && JSON.stringify(record.proposal.rootPageRefs) === JSON.stringify(record.goal.request.rootPageRefs)
      && (record.goal.request.taskType === 'deep-research'
        ? record.proposal.research?.sourceSessionId === record.goal.sourceSessionId
        : record.proposal.isolation === 'worktree' && record.proposal.research === undefined)
      && record.goalMerge === undefined && record.goalReports?.every(report => report.indices.length === 0) !== false
    : record.goal.request.taskType === 'documentation'
      ? record.proposal.artifact?.sourceSessionId === record.goal.sourceSessionId
        && record.goalMerge === undefined
        && record.preparation === undefined && record.goal.integration === undefined
      : record.goal.request.taskType === 'deep-research'
        ? record.proposal.research?.sourceSessionId === record.goal.sourceSessionId && record.goalMerge === undefined
        : record.goal.integration !== undefined && record.proposal.isolation === 'worktree'
        && record.proposal.research === undefined && record.proposal.artifact === undefined
        && (record.preparation === undefined || record.preparation.baseBranch === record.goal.integration.branch))
    && (record.execution === undefined || (record.execution.runtime === 'claude'
      ? isNativeGoalModel(record.goal.model) && record.goal.model.runtime === 'claude'
        && record.execution.selection.model === record.goal.model.model
        && record.execution.selection.effort === record.goal.model.reasoningEffort
        && record.execution.selection.permissionMode === (record.proposal.research === undefined ? record.goal.model.permissionMode : 'plan')
      : record.execution.runtime === 'codex'
        ? isNativeGoalModel(record.goal.model) && record.goal.model.runtime === 'codex' && record.execution.selection.model === record.goal.model.model
        && record.execution.selection.reasoningEffort === record.goal.model.reasoningEffort
        && record.execution.selection.sandbox === (record.proposal.research === undefined ? 'workspace-write' : 'read-only')
        : !isNativeGoalModel(record.goal.model) && record.execution.provider === record.goal.model.provider
        && record.execution.model === record.goal.model.model && record.execution.reasoningEffort === record.goal.model.reasoningEffort))))
  && (record.proposal.isolation === 'worktree' ? record.execution === undefined || record.preparation !== undefined
    : record.preparation === undefined)
  && new Set(record.verifyCheckedIndices).size === record.verifyCheckedIndices.length
  && record.verifyCheckedIndices.every(index => index < record.proposal.verifySteps.length)
  && (record.status.startsWith('closed-') === (record.closedReason !== null)),
'task status, execution receipt and verification indices must agree')

/** One immutable proposal, execution identity and independently maintained verification checklist. */
export type ProjectTaskRecord = z.infer<typeof recordSchema>

/** Task records survive restarts without changing released Session generations. */
export const projectTaskDomain = defineDomain({
  name: 'project_tasks', version: 1,
  tables: { tasks: domainTable<ProjectTaskId, ProjectTaskRecord>(recordSchema) },
})

/** Complete immutable conversation proposal validated at wire and durable reads. */
export const taskCardRequestSchema = z.object({
  id: z.uuid().transform(value => brandString<ProjectTaskCardId>(value)),
  sourceSessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  sourceCallId: z.string().min(1).transform(value => brandString<ToolCallId>(value)).optional(),
  draft: proposalSchema.omit({ id: true }),
}).strict()

const cardRecordBase = taskCardRequestSchema.extend({
  workspaceId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  workspacePath: z.string().min(1),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  decisions: z.array(z.object({
    outcome: z.enum(['dispatch-unconfirmed', 'dispatched', 'dismissed', 'terminal-unconfirmed', 'opened-terminal']),
    delivery: z.enum(['pending', 'sent']),
    messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
    inputText: z.string().min(1),
  }).strict()).max(2).optional(),
})

/** Source-owned knowledge verdicts are optional on released cards and closed only from logged evidence. */
export const taskKnowledgeReviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('needs-review') }).strict(),
  z.object({ status: z.literal('reviewing'), attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)) }).strict(),
  z.object({ status: z.literal('blocked'), failure: z.enum(['missing-evidence', 'interrupted', 'unavailable', 'input-unconfirmed']),
    attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)).optional() }).strict(),
  z.object({ status: z.literal('reviewed-no-change'), pages: z.array(z.string().min(1)).min(1),
    reviewedAt: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('updated'), pages: z.array(z.string().min(1)).min(1),
    operations: z.array(z.object({ page: z.string().min(1),
      operationId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeOperationId>(value)) }).strict()).min(1),
    reviewedAt: z.number().int().nonnegative() }).strict(),
])

const taskKnowledgeCandidateSchema = z.object({ status: z.literal('candidate'),
  candidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)),
  discoveryId: goalRequestSchema.shape.sourceSessionId,
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  taskEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  codingEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  codingOmissions: z.array(z.object({ path: z.string().min(1), change: z.enum(['added', 'modified', 'deleted']),
    bytes: z.number().int().nonnegative().nullable(), version: z.string().min(1).nullable(),
    reason: z.enum(['deleted', 'unreadable', 'non-text', 'empty']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).min(1).optional(),
  artifactDirectory: z.object({ id: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
    version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
    coverageSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
  artifactCoverage: artifactCoverageSchema.optional(),
  importedCoverage: importedPdfCoverageSchema.optional(),
  importedDocxCoverage: importedDocxCoverageSchema.optional(),
  sourceDispositions: sourceDispositionsSchema.optional(),
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['existing-page', 'new-page', 'conflict']),
  summary: z.string().trim().min(1), proposedTruth: z.string().trim().min(1), evidence: z.string().trim().min(1),
  topicSearch: z.object({ query: z.string().trim().min(1).max(256),
    hits: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()) }).strict().optional(),
  comparisonFormat: z.literal('semantic-v1').optional(),
  comparedPages: goalDiscoveryPages,
  batchReviews: z.array(taskKnowledgeBatchReceiptSchema).min(1).readonly().optional(),
  reviewedAt: z.number().int().nonnegative() }).strict()

/** Optional v1 card extension for a bounded, read-only post-Task discovery. */
const taskKnowledgeNoChangeSchema = z.object({ status: z.literal('no-change'),
  discoveryId: goalRequestSchema.shape.sourceSessionId.optional(), reason: z.string().trim().min(1),
  pages: z.array(z.string().min(1)),
  resultSha256: goalDiscoverySha.optional(), taskEvidenceSha256: goalDiscoverySha.optional(),
  codingEvidenceSha256: goalDiscoverySha.optional(),
  importedCoverage: importedPdfCoverageSchema.optional(),
  importedDocxCoverage: importedDocxCoverageSchema.optional(),
  artifactDirectory: z.object({ id: z.string().min(1).transform(value => brandString<ArtifactRenditionId>(value)),
    version: z.string().min(1), digest: goalDiscoverySha, coverageSha256: goalDiscoverySha.optional() }).strict().optional(),
  comparisonFormat: z.literal('semantic-v1').optional(),
  comparedPages: goalDiscoveryPages,
  batchReviews: z.array(taskKnowledgeBatchReceiptSchema).min(1).readonly().optional(),
  sourceDispositions: noChangeSourceDispositionsSchema,
  reviewedAt: z.number().int().nonnegative() }).strict().refine(record => (record.importedCoverage === undefined
    || record.importedCoverage.every(source => source.renderedPages.length === source.pageCount
      && source.omittedReason === undefined || source.omittedReason === 'text-only-route'))
    && (record.importedDocxCoverage === undefined || record.importedDocxCoverage.every(source => source.imageCount === 0)),
'A no-change verdict cannot claim incomplete PDF or unknown DOCX visual content')
/** Durable Task discovery receipts, including legacy read-only comparisons and semantic-v1 page evidence. */
export const taskKnowledgeDiscoverySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued') }).strict(),
  z.object({ status: z.literal('reviewing'),
    requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
    attemptSessionId: goalRequestSchema.shape.sourceSessionId,
    attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
    batchProgress: taskKnowledgeBatchProgressSchema.optional() }).strict(),
  z.object({ status: z.literal('blocked'),
    failure: z.enum(['unavailable', 'interrupted', 'missing-evidence', 'input-unconfirmed']),
    diagnostic: knowledgeDiscoveryDiagnosticSchema.optional(),
    invalidResult: taskKnowledgeInvalidResultSchema.optional(),
    schemaIssue: taskKnowledgeSchemaIssueSchema.optional(),
    reviewFailure: taskKnowledgeReviewFailureSchema.optional(),
    requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)).optional(),
    attemptSessionId: goalRequestSchema.shape.sourceSessionId.optional(),
    attemptMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)).optional(),
    batchProgress: taskKnowledgeBatchProgressSchema.optional() }).strict()
    .refine(record => record.reviewFailure === undefined || record.diagnostic === 'review-attempt-failed',
      'Reviewer failure category requires a failed reviewer attempt')
    .refine(record => record.invalidResult === undefined || record.diagnostic === 'invalid-result',
      'Invalid result category requires an invalid reviewer result')
    .refine(record => record.schemaIssue === undefined || record.diagnostic === 'invalid-result'
      && (record.invalidResult === 'schema' || record.invalidResult === 'new-page-topic-query'
        || record.invalidResult === 'unexpected-topic-query'), 'Field detail requires a field rejection')
    .refine(record => record.schemaIssue === undefined || record.invalidResult === 'schema'
      || record.schemaIssue.field === 'topicQuery' && (record.invalidResult === 'unexpected-topic-query'
        ? record.schemaIssue.rule === 'unexpected-field' : record.schemaIssue.rule !== 'unexpected-field'),
    'Topic query detail must identify its matching rule'),
  taskKnowledgeNoChangeSchema,
  taskKnowledgeCandidateSchema,
])

const knowledgeDecisionIdSchema = z.uuid().transform(value => brandString<ProjectTaskKnowledgeOperationId>(value))
const knowledgeDecisionPathSchema = z.string().min(1).transform(value => brandString<ProjectTaskKnowledgeDocumentId>(value))
const knowledgeDecisionShaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const knowledgeDecisionBaseSchema = z.object({
  decisionId: knowledgeDecisionIdSchema,
  candidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)),
  resultSha256: knowledgeDecisionShaSchema,
  candidateSha256: knowledgeDecisionShaSchema,
})
const knowledgeDecisionReceiptSchema = z.object({
  documentId: knowledgeDecisionPathSchema, version: z.string().min(1), operationId: knowledgeDecisionIdSchema,
  disposition: z.enum(['written', 'already-applied']),
}).strict()
const knowledgeDraftFields = {
  path: knowledgeDecisionPathSchema, title: z.string().trim().min(1),
  category: z.enum(['project', 'concept', 'decision', 'person', 'reference']), tags: z.array(z.string().trim().min(1)),
  kind: z.enum(['decision', 'observation', 'source', 'reversal', 'evidence']),
  reviewedSummary: z.string().trim().min(1).optional(),
  reviewedTruth: z.string().trim().min(1).optional(),
  reviewedEvidence: z.string().trim().min(1).optional(),
  reviewedSourceDispositions: sourceDispositionsSchema.optional(),
}
const knowledgeDecisionDraftBaseSchema = knowledgeDecisionBaseSchema.extend({
  ...knowledgeDraftFields,
  draftOperationId: knowledgeDecisionIdSchema,
  catalogPageReads: z.array(z.object({
    draftVersion: z.string().min(1), activeIndexDigest: knowledgeDecisionShaSchema,
    path: knowledgeDecisionPathSchema, title: z.string().trim().min(1), version: z.string().min(1),
    bodySha256: knowledgeDecisionShaSchema,
  }).strict()).optional(),
})
const knowledgePageJudgmentSchema = z.object({ path: knowledgeDecisionPathSchema,
  title: z.string().trim().min(1), version: z.string().min(1),
  relation: z.enum(['distinct', 'duplicate', 'conflict', 'unknown']) }).strict()
/** Validate wire input before any Task or Goal catalog read or receipt write. */
export const taskKnowledgeCatalogReadRequestSchema = z.object({
  expectedDraftVersion: z.string().min(1), expectedActiveIndexDigest: knowledgeDecisionShaSchema,
  path: knowledgeDecisionPathSchema, expectedPageVersion: z.string().min(1),
}).strict()
const knowledgeDecisionPublicationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), operationId: knowledgeDecisionIdSchema,
    expectedDraftVersion: z.string().min(1), expectedActiveIndexDigest: knowledgeDecisionShaSchema,
    reviewedPages: z.array(knowledgePageJudgmentSchema).optional(),
    reviewedSourceDispositions: sourceDispositionsSchema.optional() }).strict(),
  z.object({ status: z.literal('published'), operationId: knowledgeDecisionIdSchema,
    expectedDraftVersion: z.string().min(1), expectedActiveIndexDigest: knowledgeDecisionShaSchema,
    reviewedPages: z.array(knowledgePageJudgmentSchema).optional(),
    reviewedSourceDispositions: sourceDispositionsSchema.optional(),
    receipt: knowledgeDecisionReceiptSchema,
    review: z.discriminatedUnion('status', [
      z.object({ status: z.literal('verified'), observedActiveIndexDigest: knowledgeDecisionShaSchema,
        currentPageVersion: z.string().min(1) }).strict(),
      z.object({ status: z.literal('required'), reason: z.literal('active-catalog-changed'),
        observedActiveIndexDigest: knowledgeDecisionShaSchema, currentPageVersion: z.string().min(1) }).strict(),
      z.object({ status: z.literal('unknown'),
        reason: z.enum(['catalog-unavailable', 'receipt-recovered', 'receipt-unconfirmed']) }).strict(),
    ]), acknowledgement: z.object({ operationId: knowledgeDecisionIdSchema,
      publicationOperationId: knowledgeDecisionIdSchema,
      expectedPageVersion: z.string().min(1), observedActiveIndexDigest: knowledgeDecisionShaSchema,
      disposition: z.enum(['keep-published', 'revise-needed']), note: z.string().trim().min(1),
      acknowledgedAt: z.number().int().nonnegative() }).strict().optional() }).strict(),
]).refine(publication => publication.status !== 'published'
  || (publication.receipt.operationId === publication.operationId
    && (publication.acknowledgement === undefined || (publication.review.status === 'required'
      && publication.acknowledgement.publicationOperationId === publication.operationId
      && publication.acknowledgement.operationId !== publication.operationId))),
'Task publication receipt and acknowledgement must match their durable write identities')

/** Retained human decision and exact write UUIDs; pending entries are never treated as Brain receipts. */
export const taskKnowledgeDecisionSchema = z.discriminatedUnion('status', [
  knowledgeDecisionBaseSchema.extend({ status: z.literal('dismissed'), reason: z.string().trim().min(1),
    decidedAt: z.number().int().nonnegative() }).strict(),
  knowledgeDecisionBaseSchema.extend({ status: z.literal('proposal-pending'), path: knowledgeDecisionPathSchema,
    expectedVersion: z.string().min(1), reviewedSummary: z.string().trim().min(1).optional(),
    reviewedTruth: z.string().trim().min(1).optional(),
    reviewedEvidence: z.string().trim().min(1).optional(),
    reviewedSourceDispositions: sourceDispositionsSchema.optional() }).strict(),
  knowledgeDecisionBaseSchema.extend({ status: z.literal('proposal-saved'), path: knowledgeDecisionPathSchema,
    expectedVersion: z.string().min(1), reviewedSummary: z.string().trim().min(1).optional(),
    reviewedTruth: z.string().trim().min(1).optional(),
    reviewedEvidence: z.string().trim().min(1).optional(),
    reviewedSourceDispositions: sourceDispositionsSchema.optional(),
    receipt: knowledgeDecisionReceiptSchema }).strict(),
  knowledgeDecisionDraftBaseSchema.extend({ status: z.literal('draft-pending') }).strict(),
  knowledgeDecisionDraftBaseSchema.extend({ status: z.literal('draft-saved'), receipt: knowledgeDecisionReceiptSchema,
    publication: knowledgeDecisionPublicationSchema.optional() }).strict(),
]).refine((decision) => {
  if (decision.status === 'proposal-saved') {
    return decision.receipt.operationId === decision.decisionId && decision.receipt.documentId === decision.path
  }
  if (decision.status !== 'draft-pending' && decision.status !== 'draft-saved') return true
  if (decision.draftOperationId === decision.decisionId) return false
  if (decision.status === 'draft-pending') return true
  if (decision.receipt.operationId !== decision.draftOperationId || decision.receipt.documentId !== decision.path) return false
  const publication = decision.publication
  if (publication === undefined) return true
  if (publication.operationId === decision.decisionId || publication.operationId === decision.draftOperationId) return false
  if (publication.status === 'pending') return true
  if (publication.receipt.documentId !== decision.path) return false
  const acknowledgement = publication.acknowledgement
  return acknowledgement === undefined || (acknowledgement.operationId !== decision.decisionId
    && acknowledgement.operationId !== decision.draftOperationId)
},
'Task decision and publication receipts must match their durable write identities and target')

/** Boundary validation for one explicit human candidate disposition. */
export const taskKnowledgeDecisionRequestSchema = z.discriminatedUnion('action', [
  knowledgeDecisionBaseSchema.extend({ action: z.literal('dismiss'), reason: z.string().trim().min(1) }).strict(),
  knowledgeDecisionBaseSchema.extend({ action: z.literal('propose-existing'), path: knowledgeDecisionPathSchema,
    expectedVersion: z.string().min(1), reviewedSummary: z.string().trim().min(1).optional(),
    reviewedTruth: z.string().trim().min(1).optional(),
    reviewedEvidence: z.string().trim().min(1).optional(),
    reviewedSourceDispositions: sourceDispositionsSchema.optional() }).strict(),
  knowledgeDecisionBaseSchema.extend({ action: z.literal('save-draft'), ...knowledgeDraftFields }).strict(),
])

/** Boundary validation for a separate held-draft publication gesture. */
export const taskKnowledgePublishRequestSchema = z.object({
  operationId: knowledgeDecisionIdSchema, draftOperationId: knowledgeDecisionIdSchema,
  expectedDraftVersion: z.string().min(1), expectedActiveIndexDigest: knowledgeDecisionShaSchema,
  reviewedPages: z.array(knowledgePageJudgmentSchema),
  reviewedSourceDispositions: sourceDispositionsSchema.optional(),
}).strict()

/** Boundary validation for a separate human acknowledgement of a changed post-publication catalog. */
export const taskKnowledgeAcknowledgeRequestSchema = z.object({
  operationId: knowledgeDecisionIdSchema, publicationOperationId: knowledgeDecisionIdSchema,
  expectedPageVersion: z.string().min(1),
  observedActiveIndexDigest: knowledgeDecisionShaSchema,
  disposition: z.enum(['keep-published', 'revise-needed']), note: z.string().trim().min(1),
}).strict()

const taskKnowledgeHistorySchema = z.array(z.union([
  z.object({ discovery: taskKnowledgeCandidateSchema, decision: taskKnowledgeDecisionSchema.optional(),
    refreshRequestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)) }).strict(),
  z.object({ kind: z.literal('no-change'), discovery: taskKnowledgeNoChangeSchema,
    refreshRequestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)) }).strict(),
])).max(16)
const taskKnowledgeRefreshSchema = z.union([
  z.object({ requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
    sourceCandidateId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeCandidateId>(value)) }).strict(),
  z.object({ requestId: z.uuid().transform(value => brandString<ProjectTaskKnowledgeDiscoveryRequestId>(value)),
    sourceNoChangeSha256: goalDiscoverySha }).strict(),
])

/** A frozen notification input shares the lifecycle of its accepted conversation card. */
export const completionSchema = z.object({
  taskId: proposalSchema.shape.id,
  status: z.enum(['closed-success', 'closed-failed', 'closed-cancelled']),
  completedAt: z.number().int().nonnegative().nullable(),
  summary: z.string(), summaryTruncated: z.boolean(),
  wrapUpSummary: taskWrapUpSchema.optional(),
  researchReport: researchReportSchema.pick({ artifactId: true, fileName: true, summary: true }).optional(),
  artifactOutput: taskArtifactSchema.optional(),
  completionReport: recordBase.shape.completionReport,
  delivery: z.enum(['pending', 'queued', 'followed', 'viewed', 'ignored']),
  knowledgeReview: taskKnowledgeReviewSchema.optional(),
  knowledgeDiscovery: taskKnowledgeDiscoverySchema.optional(),
  knowledgeAutomatic: z.lazy(() => knowledgeAutomaticSchema).optional(),
  knowledgeDecision: taskKnowledgeDecisionSchema.optional(),
  knowledgeDiscoveryHistory: taskKnowledgeHistorySchema.optional(),
  knowledgeDiscoveryRefresh: taskKnowledgeRefreshSchema.optional(),
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  inputText: z.string().min(1),
}).strict().refine(record => (record.researchReport === undefined && record.artifactOutput === undefined
  && record.completionReport === undefined) || record.status === 'closed-success',
'retained task output requires a successful task').refine(record => record.knowledgeDiscoveryHistory === undefined
    || (record.knowledgeDiscoveryHistory.every(entry => 'kind' in entry
      || entry.decision === undefined
      || (entry.decision.candidateId === entry.discovery.candidateId
        && entry.decision.resultSha256 === entry.discovery.resultSha256
        && entry.decision.candidateSha256 === entry.discovery.candidateSha256))
      && new Set(record.knowledgeDiscoveryHistory.map(entry => entry.refreshRequestId)).size
        === record.knowledgeDiscoveryHistory.length
      && new Set(record.knowledgeDiscoveryHistory.flatMap(entry => 'kind' in entry
        ? [] : [entry.discovery.candidateId])).size
        === record.knowledgeDiscoveryHistory.filter(entry => !('kind' in entry)).length),
'Task knowledge history must retain unique candidate and refresh identities with their decisions').refine(record =>
  record.knowledgeDiscoveryRefresh === undefined
      || (() => {
        const refresh = record.knowledgeDiscoveryRefresh
        const last = record.knowledgeDiscoveryHistory?.at(-1)
        if (last === undefined || last.refreshRequestId !== refresh.requestId) return false
        return 'sourceCandidateId' in refresh
          ? !('kind' in last) && last.discovery.candidateId === refresh.sourceCandidateId
          : 'kind' in last && noChangeSha256(last.discovery) === refresh.sourceNoChangeSha256
      })(),
'Task knowledge refresh must name the last archived verdict').refine(record => record.knowledgeDecision === undefined
    || (record.knowledgeDiscovery?.status === 'candidate'
      && record.knowledgeDecision.candidateId === record.knowledgeDiscovery.candidateId
      && record.knowledgeDecision.resultSha256 === record.knowledgeDiscovery.resultSha256
      && record.knowledgeDecision.candidateSha256 === record.knowledgeDiscovery.candidateSha256),
'Task decision must retain its candidate and result identity')

/** Private frozen prompt and message identity never reach the card feed. */
export type ProjectTaskCompletionRecord = z.infer<typeof completionSchema>

const cardRecordSchema = z.discriminatedUnion('status', [
  cardRecordBase.extend({ status: z.literal('pending'), taskId: z.null() }),
  cardRecordBase.extend({ status: z.literal('dismissed'), taskId: z.null() }),
  cardRecordBase.extend({ status: z.literal('accepted'), taskId: proposalSchema.shape.id, completion: completionSchema.optional(),
    knowledgeMaintenanceAuthorization: knowledgeMaintenanceAuthorizationSchema.optional(),
    automaticReview: reviewPolicySchema.optional(),
    postSteps: taskPostStepsSchema.optional(),
    reviewSources: z.array(taskReviewSourceSelectionSchema).min(1).refine(distinctTaskReviewSources).optional(),
    agentPreset: z.string().min(1).optional(),
    terminal: z.literal(true).optional(),
    codex: codexSelectionSchema.optional(),
    claude: claudeSelectionSchema.optional(),
    selection: z.object({ input: goalModelsSchema.shape.master, resolved: goalModelsSchema.shape.master }).strict().optional() }),
]).refine(record => record.updatedAt >= record.createdAt && validTaskIsolation(record.draft)
  && (record.status !== 'accepted' || record.agentPreset === undefined
    || (record.terminal === undefined && record.codex === undefined && record.claude === undefined))
  && (record.status !== 'accepted' || record.postSteps === undefined || (record.terminal === undefined
    && record.draft.research === undefined && record.draft.artifact === undefined))
  && (record.status !== 'accepted' || record.automaticReview === undefined || (record.terminal === undefined
    && record.draft.research === undefined && record.draft.artifact === undefined))
  && (record.status !== 'accepted' || record.terminal === undefined || (record.draft.research === undefined
    && record.draft.artifact === undefined && (record.codex !== undefined || record.claude !== undefined)))
  && (record.draft.artifact === undefined || (record.draft.artifact.sourceSessionId === record.sourceSessionId
    && (record.status !== 'accepted' || ((record.codex === undefined || record.codex.sandbox === 'workspace-write')
      && (record.claude === undefined || record.claude.permissionMode === 'dontAsk')))))
  && (record.status !== 'accepted' || record.claude === undefined
    || (record.codex === undefined && record.selection === undefined
      && (record.draft.research === undefined ? record.terminal === true || record.claude.permissionMode !== 'plan' : record.claude.permissionMode === 'plan')))
  && (record.status !== 'accepted' || record.codex === undefined || (record.selection === undefined
    && (record.draft.research === undefined || record.codex.sandbox === 'read-only')))
  && (record.decisions === undefined || (record.status !== 'pending'
    && record.decisions.length > 0
    && new Set(record.decisions.map(item => item.outcome)).size === record.decisions.length
    && new Set(record.decisions.map(item => item.messageId)).size === record.decisions.length
    && record.decisions.every((item, index) => record.status === 'dismissed' ? item.outcome === 'dismissed'
      : item.outcome !== 'dismissed' && (item.outcome !== 'dispatch-unconfirmed' || index === 0))
    && (record.decisions.length < 2 || record.decisions[0]?.delivery === 'sent')))
  && (record.draft.research === undefined || record.draft.research.sourceSessionId === record.sourceSessionId)
  && (record.status !== 'accepted' || record.completion === undefined || (record.completion.taskId === record.taskId
    && (record.completion.researchReport === undefined || record.draft.research !== undefined)
    && (record.completion.artifactOutput === undefined || record.draft.artifact !== undefined)
    && (record.completion.completionReport === undefined || (record.draft.research === undefined
      && record.draft.artifact === undefined))
    && (record.completion.knowledgeReview === undefined || (record.draft.brainRefs?.length ?? 0) > 0)
    && (record.completion.knowledgeDiscovery === undefined || ((record.draft.brainRefs?.length ?? 0) === 0
      && record.completion.status === 'closed-success'))
    && (record.completion.knowledgeDecision === undefined || record.completion.knowledgeDiscovery?.status === 'candidate')
    && (record.completion.knowledgeAutomatic === undefined || (record.knowledgeMaintenanceAuthorization?.mode === 'automatic'
      && record.completion.knowledgeDiscovery?.status === 'candidate'
      && record.completion.knowledgeAutomatic.candidateId === record.completion.knowledgeDiscovery.candidateId
      && record.completion.knowledgeAutomatic.resultSha256 === record.completion.knowledgeDiscovery.resultSha256
      && record.completion.knowledgeAutomatic.candidateSha256 === record.completion.knowledgeDiscovery.candidateSha256
      && (record.completion.knowledgeAutomatic.status === 'deferred'
        || record.completion.knowledgeAutomatic.project.id === record.workspaceId
          && record.completion.knowledgeAutomatic.project.path === record.workspacePath
          && record.completion.knowledgeAutomatic.request.authority.kind === 'task'
          && record.completion.knowledgeAutomatic.request.authority.taskId === record.taskId
          && record.completion.knowledgeAutomatic.request.authority.sourceSessionId === record.sourceSessionId
          && record.completion.knowledgeAutomatic.request.authority.authorizationId
            === record.knowledgeMaintenanceAuthorization.authorizationId))))),
'card timestamps and completion identity must agree')

/** Committed card intent, owning conversation and irrevocable decision. */
export type ProjectTaskCardRecord = z.infer<typeof cardRecordSchema>

/**
 * Card decisions survive independently of task records and released Session logs;
 * optional review and preset data preserve v1 card reads.
 */
export const projectTaskCardDomain = defineDomain({
  name: 'project_task_cards', version: 1,
  tables: { cards: domainTable<ProjectTaskCardId, ProjectTaskCardRecord>(cardRecordSchema) },
})

/** Require exactly one temporary task purpose and a trace destination among the selected pages.
 * @param proposal - validated proposal fields or a conversation draft.
 * @returns whether its source ownership and execution isolation agree.
 */
export function validTaskIsolation(proposal: Pick<z.infer<typeof proposalSchema>, 'isolation' | 'research' | 'artifact' | 'brainRefs'>): boolean {
  const purposes = Number(proposal.research !== undefined) + Number(proposal.artifact !== undefined)
  return (proposal.isolation === 'tempdir' ? purposes === 1 : purposes === 0)
    && (proposal.artifact?.trace === undefined || proposal.brainRefs?.includes(proposal.artifact.trace.page) === true)
}

/** Project committed metadata without leaking Host paths or stored prompt text.
 * @param record - validated durable task record.
 * @returns Client-visible task and execution identity.
 */
export function taskState(record: ProjectTaskRecord): ProjectTaskState {
  return { ...record.proposal, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    reviewConfigurable: record.status === 'draft' && record.sourceSessionId === undefined
      && record.goal === undefined && record.terminal === undefined
      && record.proposal.research === undefined && record.proposal.artifact === undefined,
    ...(record.automaticReview === undefined ? {} : { automaticReview: record.automaticReview }),
    ...(record.knowledgeMaintenanceAuthorization === undefined
      ? {} : { knowledgeMaintenanceAuthorization: record.knowledgeMaintenanceAuthorization }),
    ...(record.postSteps === undefined ? {} : { postSteps: record.postSteps }),
    ...(record.reviewSources === undefined ? {} : { reviewSources: record.reviewSources }),
    reviewAvailable: record.execution !== undefined && record.goal === undefined
      && record.proposal.research === undefined && record.proposal.artifact === undefined
      && (record.preparation !== undefined || record.reviewBaseCommit != null),
    ...(record.review === undefined ? {} : { review: record.review }),
    ...(record.terminal === undefined ? {} : { terminal: { phase: record.terminal.phase, selection: record.terminal.selection } }),
    ...(record.execution?.runtime === 'claude' ? { claude: { ...record.execution.selection,
      ...(record.execution.initialized ? { sessionId: record.execution.nativeSessionId } : {}) } } : {}),
    ...(record.execution?.runtime === 'codex' ? { codex: { ...record.execution.selection,
      ...(record.execution.threadId === undefined ? {} : { threadId: record.execution.threadId }) } } : {}),
    verifyCheckedIndices: record.verifyCheckedIndices, sessionId: record.execution?.sessionId ?? null,
    closedReason: record.closedReason,
    ...(record.nativeFailure === undefined ? {} : { nativeFailure: record.nativeFailure }),
    ...(record.usage === undefined ? {} : { usage: record.usage }),
    ...(record.researchReport === undefined ? {} : { researchReport: record.researchReport }),
    ...(record.artifactOutput === undefined ? {} : { artifactOutput: record.artifactOutput }),
    ...(record.completionReport === undefined ? {} : { completionReport: record.completionReport }),
    ...(record.outputInventory === undefined ? {} : { outputInventory: record.outputInventory }),
    ...(record.goal === undefined ? {} : { goal: { runId: record.goal.runId,
      ...(record.goal.gather === true ? { gather: true as const }
        : record.goal.probe === true ? { probe: record.goal.request.probe } : { subGoalId: record.goal.request.subGoalId }) } }),
    ...(record.goalReports === undefined ? {} : {
      goalReports: record.goalReports.map(({ requestId, checks, delivery, summary, summaryTruncated }) =>
        ({ requestId, checks, delivery, summary, summaryTruncated })),
    }),
    ...(record.goalKnowledgeDiscovery === undefined ? {} : { goalKnowledgeDiscovery: record.goalKnowledgeDiscovery }),
    ...(record.goalKnowledgeAutomatic === undefined
      ? {} : { goalKnowledgeAutomatic: automaticKnowledgeState(record.goalKnowledgeAutomatic) }),
    ...(record.goalKnowledgeDecision === undefined ? {} : { goalKnowledgeDecision: record.goalKnowledgeDecision }),
    ...(record.goalKnowledgeHistory === undefined ? {} : { goalKnowledgeHistory: record.goalKnowledgeHistory }),
    ...(record.goalKnowledgeRefresh === undefined ? {} : { goalKnowledgeRefresh: record.goalKnowledgeRefresh }),
    ...(record.goalMerge === undefined ? {} : { goalMerge: record.goalMerge.status === 'merged' || record.goalMerge.status === 'empty'
      ? { status: record.goalMerge.status, commit: record.goalMerge.commit }
      : record.goalMerge.status === 'conflict' ? { status: 'conflict', files: record.goalMerge.files }
        : { status: record.goalMerge.status } }),
    ...((record.execution === undefined && record.terminal === undefined) || record.preparation === undefined
      ? {} : { executionWorkspace: record.preparation }) }
}
