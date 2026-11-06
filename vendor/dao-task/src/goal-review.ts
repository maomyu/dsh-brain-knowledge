/** Review input validation and independently authored, durable source-wake text. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProjectGoalCodingPostSteps, ProjectGoalRequestId, ProjectGoalState, ProjectGoalReviewInput,
  ProjectTaskCodingConfirmation } from './types.ts'
import { goalModelKey, isNativeGoalModel } from './goal-model.ts'

const text = z.string().trim().min(1)
const identity = text.transform(value => brandString<ProjectGoalRequestId>(value))
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const model = z.object({ provider: text, model: text, reasoningEffort: text.optional() }).strict()
  .transform((value): ModelSelection => ({ provider: value.provider, model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }))

/** Complete user-editable thresholds; omitted or fractional values are rejected. */
export const goalBudgetSchema = z.object({ noProgressPauseThreshold: positive, runSpawnCap: positive,
  runTokenWarnThreshold: positive, runTurnWarnThreshold: positive }).strict()

/** Native routes require a concrete model; Harness routes resolve through their provider. */
export const goalTaskModelSchema = z.union([model,
  z.object({ runtime: z.literal('codex'), model: text, reasoningEffort: text.optional() }).strict(),
  z.object({ runtime: z.literal('claude'), model: text, permissionMode: z.enum(['dontAsk', 'acceptEdits', 'auto']),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict()])

/** Selection syntax; Harness adapter capabilities are resolved before retaining approval. */
export const goalModelsSchema = z.object({ master: model, tasks: z.array(goalTaskModelSchema) }).strict()
  .refine((value) => {
    const routes = value.tasks.map(goalModelKey)
    return new Set(routes).size === routes.length && !routes.includes(goalModelKey(value.master))
  }, 'task routes must be unique and separate from the master model')

/** A signed Goal cannot authorize review-driven repair without review. */
export const goalCodingPostStepsSchema = z.object({ autoReview: z.boolean(), autoRunTests: z.boolean(),
  autoFix: z.boolean() }).strict().refine(value => !value.autoFix || value.autoReview,
  'automatic repair requires automatic review')

/** Exact-plan review command, validated at both Remote admission and durable reads. */
export const goalReviewSchema = z.discriminatedUnion('decision', [
  z.object({ requestId: identity, planRequestId: identity, decision: z.literal('approve'),
    models: goalModelsSchema, budget: goalBudgetSchema, researchProjectChecks: z.boolean().optional(),
    documentationTasks: z.boolean().optional(), codingPostSteps: goalCodingPostStepsSchema.optional(),
    agentPreset: z.string().min(1).optional(), knowledgeMaintenance: z.enum(['automatic', 'read-only']).optional() }).strict(),
  z.object({ requestId: identity, planRequestId: identity, decision: z.literal('reject'), feedback: text.optional() }).strict(),
]).transform((value): ProjectGoalReviewInput => value.decision === 'approve' ? value : {
  requestId: value.requestId, planRequestId: value.planRequestId, decision: value.decision,
  ...(value.feedback === undefined ? {} : { feedback: value.feedback }),
})

/** Derive execution authority only from one retained approval and its resolved master route.
 * @param choices - explicit coding choices; absence keeps legacy approvals unprivileged.
 * @param master - the resolved route frozen in that same approval, not a mutable default.
 * @returns coding-only review authority and test/fix guidance, or no additional authority.
 */
export function goalCodingTaskConfirmation(choices: ProjectGoalCodingPostSteps | undefined,
  master: ModelSelection): Pick<ProjectTaskCodingConfirmation, 'review' | 'postSteps'> {
  if (choices === undefined) return {}
  if (!goalCodingPostStepsSchema.safeParse(choices).success) throw new Error('Goal coding follow-up choices are invalid')
  return { postSteps: { autoRunTests: choices.autoRunTests, autoFix: choices.autoFix },
    ...(choices.autoReview ? { review: { selection: { runtime: 'harness' as const, model: master }, allowFallback: false } } : {}) }
}

/** Freeze the reviewed plan as application input; no task result is inferred from approval.
 * @param state - retained run and complete plan.
 * @param input - exact user decision and any explicitly approved routes and budgets.
 * @returns text stored before source delivery, containing no private Host storage paths.
 */
export function goalReviewText(state: ProjectGoalState, input: ProjectGoalReviewInput): string {
  return [
    'This is an application-generated record of the user’s plan review, not a new independent objective.',
    input.decision === 'approve'
      ? 'The user approved this plan and its model and budget selections. Approval does not prove that any sub-goal ran or passed verification. Code execution must use isolated goal tasks. Documentation tasks require separate documentationTasks approval and publish a private artifact, never project files. Only dedicated Goal knowledge tools may update the original project Brain, within the exact signed brainRefs and rootPageRefs after an informing read. Do not modify other original project files. Do not claim completion without recorded execution and verification evidence.'
      : 'The user requested plan revision. No execution is approved. Review the feedback and submit a complete revised plan with wud_submit_plan using this exact runId, then await another user decision.',
    JSON.stringify({ runId: state.id, goal: state.goal, decision: input.decision, plan: state.plan?.input,
      ...(input.decision === 'approve' ? { models: input.models, budget: input.budget, integration: state.integration,
        capabilities: state.capabilities ?? [],
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
        ...(input.knowledgeMaintenance === undefined ? {} : { knowledgeMaintenance: input.knowledgeMaintenance }),
        ...(input.researchProjectChecks === undefined ? {} : { researchProjectChecks: input.researchProjectChecks }),
        ...(input.documentationTasks === undefined ? {} : { documentationTasks: input.documentationTasks }),
        ...(input.codingPostSteps === undefined ? {} : { codingPostSteps: input.codingPostSteps }) }
        : { feedback: input.feedback ?? '' }) }),
    ...(input.decision === 'approve' && (state.plan?.input.brainProjectIds?.length ?? 0) > 0 ? [
      'The signed brainProjectIds also authorize the listed knowledge paths in those exact active projects of this workspace. Use target_project_id with that exact ID and first read the destination file. Omission selects the source project. Approval never grants code edits, artifact writes or task execution in these additional projects. Retain Goal and review ownership in this source conversation.',
    ] : []),
    ...(input.decision === 'approve' && input.models.tasks.some(model => isNativeGoalModel(model) && model.runtime === 'codex') ? [
      'Native Codex task routes use model={runtime:"codex",model:"the exact signed model",reasoningEffort:"the exact signed effort, when present"}. Omitting reasoningEffort inherits the signed choice; specifying a different effort is not allowed. A signed choice without an effort preserves native configuration. They use the configured Codex account, not a Harness provider. Coding runs in an isolated worktree with workspace-write permission; deep research is read-only; approved documentation uses private checkpointed artifact writes. The Harness master remains responsible for evidence, acceptance and knowledge review. Native model capability assessments are not available through provider-qualified probes. Missing native token usage is unknown, not zero.',
    ] : []),
    ...(input.decision === 'approve' && input.models.tasks.some(model => isNativeGoalModel(model) && model.runtime === 'claude') ? [
      'Native Claude task routes use model={runtime:"claude",model:"the exact signed model",permissionMode:"the exact signed coding policy",reasoningEffort:"the exact signed effort, when present"}. Omitting reasoningEffort inherits approval; a different model, coding policy or effort is not allowed. Coding uses the signed permission policy in its isolated worktree. Deep research enforces plan mode and read/search tools only; approved documentation uses private checkpointed artifact writes. Native account quota and history are separate from Harness; tool permissions are not OS filesystem confinement. The Harness master reviews collected evidence, acceptance and signed-scope knowledge updates. Native routes cannot be provider-qualified probe subjects. Missing native usage remains unknown.',
    ] : []),
    ...(input.decision === 'approve' && state.plan?.input.allowTaskDispatch === false ? [
      'The user approved a master-only review. Do not create child tasks, including capability research. Read the evidence and use wud_record_outcome with taskId=master for semantic criteria. Dedicated Goal knowledge tools retain their exact signed scope. This approval does not allow direct project-code edits or self-claimed deterministic checks.',
    ] : input.decision === 'approve' ? [
      'Capability entries are source-authored assessments, not verified benchmarks or additional permissions. Resolve unfamiliar approved models before routing difficult work to them: start with a lightweight read-only lookup. Only when that is inconclusive, use wud_dispatch_task with taskType=deep-research, probe={provider,model}, title and description, and no subGoalId. Both the subject and the independent runner must be in the signed pool; omit model to use the approved master. The retained report wakes this conversation; end your turn rather than polling. Record findings with wud_record_model_capability and cite the task and public sources. Mark inconclusive results assumed=true; absence of a fresh entry means unresolved, not incapable. Reuse fresh entries from wud_status rather than repeating research. Continue ready work on already assessed models while other assessments are pending. Only the approved model pool may execute Goal tasks.',
    ] : []),
  ].join('\n\n')
}
