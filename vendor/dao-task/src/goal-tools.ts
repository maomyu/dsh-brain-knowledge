/** Model Consumers bind goal mutations to an explicit run; status alone selects the latest run. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProjectGoalRequestId, ProjectGoalRunId, ProjectGoalState, ProjectSubGoalId, ProjectTaskId } from './types.ts'
import { goalPlanSchema } from './goal-plan.ts'
import { goalDispatchSchema, goalGatherDispatchSchema, goalProbeDispatchSchema } from './records.ts'
import { goalBudgetNoticeSchema, taskUsageSchema } from './goal-budget.ts'
import { goalCapabilitySchema } from './goal-capabilities.ts'
import { goalCapabilityOutputSchema, installGoalCapabilityTool } from './goal-capability-tool.ts'

const usageSchema = taskUsageSchema.safeExtend({ spawnsUsed: z.number(), unaccountedTasks: z.number(), noProgressStreak: z.number() })

const noticeSchema = z.object({ id: z.string().min(1), phase: z.enum(['GATHER', 'SIGNOFF', 'PLAN', 'RUNNING', 'PAUSED', 'DONE', 'ESCALATED', 'EXITED']), goal: z.string(),
  planRequestId: z.string().min(1).optional(), detachedTaskIds: z.array(z.string().min(1)).optional(),
  plan: goalPlanSchema.optional(), progress: z.array(z.object({ subGoalId: z.string(), taskId: z.string().nullable(), status: z.string(),
    criteria: z.array(z.object({ index: z.number(), passed: z.boolean(),
      verifiedBy: z.string().optional(), detail: z.string().optional() })),
  })).optional(), usage: usageSchema.optional(), budgetNotice: goalBudgetNoticeSchema.optional(),
  capabilities: z.array(goalCapabilitySchema).optional() }).strict()
  .refine(value => !['PAUSED', 'DONE', 'ESCALATED'].includes(value.phase) || value.plan !== undefined)

const runParameters = { runId: { type: 'string', required: true,
  description: 'Exact run id returned by wud_enter or wud_status. Retain this id when retrying; never substitute a later run.' } } as const

const probeProperties = { provider: { type: 'string', required: true }, model: { type: 'string', required: true } } as const

const planParameters = {
  knowledgeMaintenance: { type: 'string', enum: ['automatic', 'read-only'],
    description: 'Proposed independent result maintenance. Set read-only when the user prohibits knowledge writes. Signoff preserves this intent unless the person explicitly changes it; omission is not automatic write permission.' },
  goal: { type: 'string', description: 'Complete objective; omit to retain the entered goal.' },
  allowTaskDispatch: { type: 'boolean', description: 'Set false for a master-only review: the signed run cannot create child tasks, including capability research. Omission permits normal dispatch.' },
  brainProjectIds: { type: 'array', items: { type: 'string' }, description: 'Exact project IDs in this workspace whose Brains may receive the signed page and root writes. '
    + 'Omit to write only the conversation project. These IDs appear at signoff; they grant no code or artifact writing permission.' },
  brainRefs: { type: 'array', items: { type: 'string' }, description: 'Signed Brain write scope and task reading context. '
    + 'Use exact Brain-relative decision page paths for writes, such as pages/storage.md. Empty means no autonomous page writes; '
    + 'read-only aliases do not grant writes. The approved scope cannot be widened during execution.' },
  rootPageRefs: { type: 'array', items: { type: 'string', enum: ['background', 'architecture', 'flow', 'mindmap', 'stack', 'roadmap'] } },
  subGoals: { type: 'array', required: true, description: 'Nonempty acyclic sub-goal graph with unique IDs and known dependencies.',
    items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, title: { type: 'string', required: true },
      dependsOn: { type: 'array', items: { type: 'string' } },
      complexity: { type: 'string', enum: ['simple', 'medium', 'complex'], description: 'Defaults to medium when omitted.' },
      affectedFiles: { type: 'array', items: { type: 'string' } },
      criteria: { type: 'array', required: true, description: 'At least one condition; proposed checks are not executed on submission.',
        items: { type: 'object', additionalProperties: false, properties: {
          machine: { type: 'string', required: true }, plain: { type: 'string', required: true }, weak: { type: 'boolean' },
          check: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, enum: ['command'] },
              command: { type: 'string', required: true }, timeoutMs: { type: 'integer' } } },
            { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, enum: ['http'] },
              url: { type: 'string', required: true }, timeoutMs: { type: 'integer' } } },
          ] },
        } } },
    } } },
} as const

const budgetProperties = {
  usage: { type: 'object', additionalProperties: false, properties: {
    spawnsUsed: { type: 'integer', required: true }, turns: { type: 'integer', required: true }, totalTokens: { type: 'integer', required: true },
    unreportedSteps: { type: 'integer', required: true }, unaccountedTasks: { type: 'integer', required: true }, noProgressStreak: { type: 'integer', required: true },
  } },
  budgetNotice: { type: 'object', additionalProperties: false, properties: {
    dimension: { type: 'string', required: true, enum: ['no-progress', 'spawn', 'token', 'turn'] },
    used: { type: 'integer', required: true }, threshold: { type: 'integer', required: true }, advisory: { type: 'boolean', required: true, enum: [true] },
  } },
} as const

const outputSchema = { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
  ...budgetProperties,
  capabilities: { type: 'array', items: goalCapabilityOutputSchema },
  id: { type: 'string', required: true }, phase: { type: 'string', required: true, enum: ['GATHER', 'SIGNOFF', 'PLAN', 'RUNNING', 'PAUSED', 'DONE', 'ESCALATED', 'EXITED'] },
  planRequestId: { type: 'string' }, detachedTaskIds: { type: 'array', items: { type: 'string' } },
  goal: { type: 'string', required: true }, plan: { type: 'object', additionalProperties: false, properties: planParameters },
  progress: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    subGoalId: { type: 'string', required: true }, taskId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    status: { type: 'string', required: true }, criteria: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: { index: { type: 'integer', required: true },
        passed: { type: 'boolean', required: true }, verifiedBy: { type: 'string' }, detail: { type: 'string' } },
    } },
  } } },
} }] } as const
type GoalNotice = InferValue<typeof outputSchema>

const dispatchOutputSchema = { type: 'object', additionalProperties: false, properties: {
  ...budgetProperties,
  taskId: { type: 'string', required: true }, subGoalId: { type: 'string' }, title: { type: 'string' },
  probe: { type: 'object', additionalProperties: false, properties: probeProperties },
  status: { type: 'string', required: true }, sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
} } as const
type DispatchNotice = InferValue<typeof dispatchOutputSchema>
const dispatchNoticeSchema = z.object({ taskId: z.string().min(1), subGoalId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  probe: goalProbeDispatchSchema.shape.probe.optional(),
  status: z.string().min(1), sessionId: z.string().min(1).nullable(), usage: usageSchema.optional(),
  budgetNotice: goalBudgetNoticeSchema.optional() }).strict()

function notice(state: ProjectGoalState | null): GoalNotice {
  return state === null ? null : { id: state.id, phase: state.phase, goal: state.goal,
    ...(state.planHistory === undefined || state.plan === undefined ? {} : { planRequestId: state.plan.requestId,
      detachedTaskIds: state.planHistory.flatMap(item => item.taskIds) }),
    ...(state.capabilities === undefined ? {} : { capabilities: [...state.capabilities] }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.budgetNotice === undefined ? {} : { budgetNotice: state.budgetNotice }),
    ...(state.progress === undefined ? {} : { progress: state.progress.map(item => ({ subGoalId: item.subGoalId,
      taskId: item.taskId, status: item.status, criteria: item.criteria.map(mark => ({ index: mark.index, passed: mark.passed,
        ...(mark.verifiedBy === undefined ? {} : { verifiedBy: mark.verifiedBy }),
        ...(mark.detail === undefined ? {} : { detail: mark.detail }) })) })) }),
    ...state.plan === undefined ? {} : { plan: {
      goal: state.plan.input.goal, brainRefs: [...state.plan.input.brainRefs], rootPageRefs: [...state.plan.input.rootPageRefs],
      ...(state.plan.input.allowTaskDispatch === undefined ? {} : { allowTaskDispatch: state.plan.input.allowTaskDispatch }),
      ...(state.plan.input.knowledgeMaintenance === undefined ? {} : { knowledgeMaintenance: state.plan.input.knowledgeMaintenance }),
      ...(state.plan.input.brainProjectIds === undefined ? {} : { brainProjectIds: [...state.plan.input.brainProjectIds] }),
      subGoals: state.plan.input.subGoals.map(item => ({ id: item.id, title: item.title,
        dependsOn: [...item.dependsOn], complexity: item.complexity, affectedFiles: [...item.affectedFiles],
        criteria: item.criteria.map(condition => ({ machine: condition.machine, plain: condition.plain,
          ...condition.weak === undefined ? {} : { weak: condition.weak },
          ...condition.check === undefined ? {} : { check: {
            ...condition.check.kind === 'command' ? { kind: 'command' as const, command: condition.check.command }
              : { kind: 'http' as const, url: condition.check.url },
            ...condition.check.timeoutMs === undefined ? {} : { timeoutMs: condition.check.timeoutMs },
          } },
        })),
      })),
    } } }
}

/** Register source-scoped goal tools; the normal tool result records every model-visible state.
 * @param ctx - controller-owned registration lifetime and project/goal services.
 */
export function installGoalTools(ctx: Context): void {
  installGoalCapabilityTool(ctx)
  ctx.tools.register(defineTool({
    name: 'wud_dispatch_task',
    description: 'Dispatch Goal work without a proposal card. During GATHER or PLAN, omit subGoalId and supply taskType, title and description for unbound research or a coding spike. '
      + 'Gathering uses the current master model, consumes no signed-plan spawn budget and collects findings without acceptance checks. Research uses a temporary directory without requiring Git. '
      + 'During RUNNING, supply the exact runId and subGoalId; the approved plan supplies its title and acceptance criteria. '
      + 'A signed plan with allowTaskDispatch=false forbids every new child dispatch, including capability research; changing this requires a replacement plan and fresh approval. '
      + 'For inconclusive lightweight model research during RUNNING, instead omit subGoalId, set taskType=deep-research and probe={provider,model}, and supply title and description. '
      + 'Both the probe subject and the independent research runner must belong to the signed model pool. The default runner is the approved master. '
      + 'Capability research consumes no spawn budget, tracks tokens and grants no acceptance. Its report wakes the source to record an assessment with wud_record_model_capability. '
      + 'An approved sub-goal defaults to coding in a clean worktree from the integration branch’s committed tip. Select taskType=deep-research for a cited report, or taskType=documentation for a private complete documentation directory when the user signed documentationTasks. Neither route prepares or merges Git changes. '
      + 'Omit model to use the approved master route, or select an approved task-pool route. '
      + 'For a signed native Codex route use model={runtime:"codex",model:"the exact signed model"}; coding uses workspace-write in its isolated worktree and research is read-only. Native routes cannot be provider-qualified probe subjects. '
      + 'For signed Claude use model={runtime:"claude",model:"the exact signed model",permissionMode:"the exact signed coding policy"}; coding uses that policy in its worktree, while research enforces plan mode with read/search tools only. '
      + 'Dependencies must have recorded acceptance. Successful coding changes are collected into the Goal integration worktree. '
      + 'Bound research counts toward spawn usage and requires normal acceptance. Its signed command checks run in the original project only with researchProjectChecks approval; otherwise dispatch is refused until fresh approval. '
      + 'While this project is selected and the owning source is live, approved checks run and their results wake the source. '
      + 'End your turn after dispatch; do not poll. Record acceptance with wud_record_outcome before dispatching dependent work. '
      + 'Budget notices are advisories, not dispatch limits. Change approach on repeated lack of progress or use ESCALATE to request a user decision. '
      + 'Retain requestId for an identical retry after an interrupted dispatch.',
    parameters: { ...runParameters,
      requestId: { type: 'string', required: true, description: 'Unique dispatch request identity, retained unchanged on retry.' },
      subGoalId: { type: 'string', description: 'Exact approved sub-goal while RUNNING; omit for gathering or capability research.' },
      probe: { type: 'object', additionalProperties: false, properties: probeProperties,
        description: 'RUNNING-only capability research subject in the signed pool, not the execution model. Requires deep-research and no subGoalId.' },
      taskType: { type: 'string', enum: ['coding', 'deep-research', 'documentation'], description: 'Required for unbound work; probes require deep-research. Approved sub-goals default to coding; documentation requires separate signoff and has no Host checks.' },
      title: { type: 'string', description: 'Required for gathering or capability research; approved sub-goals use their signed title.' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' },
        description: 'Optional outcomes for gathering or capability research; these do not approve or verify a signed-plan criterion. Omit for approved sub-goals.' },
      verifySteps: { type: 'array', items: { type: 'string' },
        description: 'Optional manual checklist for gathering or capability research; not automatically executed. Omit for approved sub-goals.' },
      affectedFiles: { type: 'array', items: { type: 'string' },
        description: 'Optional file context for unbound work; listed paths grant no read or write permission. Omit for approved sub-goals.' },
      description: { type: 'string', required: true, description: 'Complete task instructions, constraints and any earlier failure evidence.' },
      brainRefs: { ...planParameters.brainRefs,
        description: 'For unbound work, Brain-relative pages to read as task context; this grants no source-project write permission. '
          + 'Omit for approved sub-goals, which use the signed plan references.' },
      rootPageRefs: { ...planParameters.rootPageRefs,
        description: 'For unbound work, root-page slugs to read as task context. Omit for approved sub-goals.' },
      model: { oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          provider: { type: 'string', required: true }, model: { type: 'string', required: true },
          reasoningEffort: { type: 'string', description: 'Must match the approved route; omit to inherit its effort.' },
        } },
        { type: 'object', additionalProperties: false, properties: {
          runtime: { type: 'string', enum: ['codex'], required: true }, model: { type: 'string', required: true },
          reasoningEffort: { type: 'string', description: 'Must match the approved route; omit to inherit its effort.' },
        } },
        { type: 'object', additionalProperties: false, properties: {
          runtime: { type: 'string', enum: ['claude'], required: true }, model: { type: 'string', required: true },
          permissionMode: { type: 'string', enum: ['dontAsk', 'acceptEdits', 'auto'], required: true,
            description: 'Exact signed coding policy. Research always enforces read-only plan mode.' },
          reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'],
            description: 'Must match the approved route; omit to inherit its effort.' },
        } },
      ] },
    },
    output: {
      schema: dispatchOutputSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value: DispatchNotice) => value,
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const parsed = dispatchNoticeSchema.safeParse(result.meta)
      if (!parsed.success) return undefined
      const title = parsed.data.subGoalId ?? parsed.data.title
      if (title === undefined) return undefined
      return { card: 'generic', title,
        content: [{ type: 'text', text: parsed.data.status }] }
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal dispatch requires a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      const requestId = brandString<ProjectGoalRequestId>(args.requestId)
      const guidance = {
        ...(args.probe === undefined ? {} : { probe: args.probe }),
        ...(args.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: args.acceptanceCriteria }),
        ...(args.verifySteps === undefined ? {} : { verifySteps: args.verifySteps }),
        ...(args.affectedFiles === undefined ? {} : { affectedFiles: args.affectedFiles }),
      }
      const input = args.subGoalId === undefined
        ? { requestId, ...guidance, description: args.description, taskType: args.taskType, title: args.title,
          ...(args.brainRefs === undefined ? {} : { brainRefs: args.brainRefs }),
          ...(args.rootPageRefs === undefined ? {} : { rootPageRefs: args.rootPageRefs }),
          ...(args.model === undefined ? {} : { model: args.model }) }
        : { requestId, ...guidance, description: args.description, subGoalId: brandString<ProjectSubGoalId>(args.subGoalId),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.taskType === undefined ? {} : { taskType: args.taskType }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.brainRefs === undefined ? {} : { brainRefs: args.brainRefs }),
          ...(args.rootPageRefs === undefined ? {} : { rootPageRefs: args.rootPageRefs }) }
      const parsed = (args.subGoalId !== undefined ? goalDispatchSchema
        : args.probe === undefined ? goalGatherDispatchSchema : goalProbeDispatchSchema).safeParse(input)
      if (!parsed.success) throw new Error('Goal dispatch requires complete phase-appropriate instructions')
      const task = await ctx.taskController.dispatchGoalTask(workspace.id, session.id,
        brandString<ProjectGoalRunId>(args.runId), parsed.data, exec.signal)
      const state = ctx.taskController.inspectGoal(workspace.id, session.id, brandString<ProjectGoalRunId>(args.runId))
      /* v8 ignore if -- Successful dispatch retains this exact run; synchronous inspection cannot lose its owned record. */
      if (state === null) throw new Error('Dispatched task has no retained Goal')
      return { taskId: task.id, ...(args.subGoalId === undefined ? { title: task.title } : { subGoalId: args.subGoalId }),
        ...(task.goal?.probe === undefined ? {} : { probe: task.goal.probe }),
        status: task.status, sessionId: task.sessionId,
        /* v8 ignore next -- The retained dispatched Task makes this run's same-table usage present. */
        ...(state.usage === undefined ? {} : { usage: state.usage }),
        ...(state.budgetNotice === undefined ? {} : { budgetNotice: state.budgetNotice }) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_read_task_coding',
    description: 'Read complete changed UTF-8 file bodies from one successful signed coding Task after its Goal result arrives. The Host binds every body to the fixed Task commit and a digest. An unavailable, unsupported or oversized file fails the entire read. This read does not accept Goal criteria or edit the project.',
    parameters: { ...runParameters,
      taskId: { type: 'string', required: true, description: 'Exact coding Task ID from the latest Goal result.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal coding read requires a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      const files = await ctx.taskController.readGoalTaskCoding(workspace.id, session.id,
        brandString<ProjectGoalRunId>(args.runId), brandString<ProjectTaskId>(args.taskId), exec.signal)
      return JSON.stringify(files)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_read_task_documentation',
    description: 'Read every file in one successful signed documentation Task after its Goal result arrives. The Host verifies Task ownership, the complete bounded directory and its digest. This read does not publish or edit the original project. A summary, artifact ID or prior read does not establish acceptance.',
    parameters: { ...runParameters,
      taskId: { type: 'string', required: true, description: 'Exact documentation Task ID from the latest Goal result.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal documentation read requires a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      const tree = await ctx.taskController.readGoalTaskDocumentation(workspace.id, session.id,
        brandString<ProjectGoalRunId>(args.runId), brandString<ProjectTaskId>(args.taskId), undefined, exec.signal)
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      return JSON.stringify({ format: 'goal-documentation-directory-v1', ...tree,
        files: tree.files.map((file) => {
          const { dataBase64, ...metadata } = file
          const bytes = Buffer.from(dataBase64, 'base64')
          let content: string | undefined
          try { content = decoder.decode(bytes) }
          catch { /* Invalid UTF-8 retains its complete base64 bytes below. */ }
          if (content !== undefined && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
            return { ...metadata, encoding: 'utf8', content }
          }
          return { ...metadata, encoding: 'base64', content: dataBase64 }
        }) })
    },
  }))
  const output = {
    schema: outputSchema,
    render: (_args: unknown, value: GoalNotice) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    presentationMeta: (_args: unknown, value: GoalNotice) => value,
  }
  const presentResult = (_args: unknown, result: { isError: boolean; meta?: unknown }) => {
    if (result.isError) return undefined
    const parsed = noticeSchema.safeParse(result.meta)
    if (!parsed.success) return undefined
    return { card: 'generic' as const, title: parsed.data.goal,
      content: [{ type: 'text' as const, text: parsed.data.phase }] }
  }
  ctx.tools.register(defineTool({
    name: 'wud_record_outcome',
    description: 'Record a collected Goal task outcome. Judge semantic criteria against the actual worker artifacts; '
      + 'For a signed plan with allowTaskDispatch=false, use taskId=master to record review evidence without creating a task. This marker is refused for ordinary plans. '
      + 'criteriaPassed may include only indices without a check. Deterministic marks are host-owned. '
      + 'A rejected request records no criterion marks. Correct invalid optional reasons without discarding criteria supported by actual evidence. '
      + 'NEXT continues with ready work; RETRY requires failureReason and a fresh task with a materially different approach. '
      + 'DONE succeeds only when every sub-goal is accepted and no integration conflict remains; otherwise the returned phase stays RUNNING. '
      + 'When the signed plan selects Brain decision pages, read one selected active page after this exact task result before DONE; write only a supported new conclusion. '
      + 'For a successful signed coding Task with selected Brain pages, read the complete fixed-commit changed files with wud_read_task_coding after its latest result before NEXT or DONE. '
      + 'ESCALATE ends autonomy for a genuine blocker. Neither DONE nor ESCALATE merges into the original checkout or pushes. '
      + 'Read the returned phase and progress, then dispatch ready work or report the terminal result.',
    parameters: { ...runParameters, taskId: { type: 'string', required: true }, subGoalId: { type: 'string', required: true },
      criteriaPassed: { type: 'array', required: true, items: { type: 'integer' } },
      verdict: { type: 'string', required: true, enum: ['passed', 'failed'] },
      decision: { type: 'string', required: true, enum: ['NEXT', 'RETRY', 'DONE', 'ESCALATE'] },
      failureReason: { type: 'string',
        description: 'Optional nonblank failure reason. Required for RETRY; omit when not applicable. Never send an empty or whitespace-only string.' },
      escalateReason: { type: 'string',
        description: 'Optional nonblank escalation reason; omit when not applicable. Never send an empty or whitespace-only string.' },
    }, output, presentResult,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal outcome requires its source conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      return notice(await ctx.taskController.recordGoalOutcome(workspace.id, session.id, brandString<ProjectGoalRunId>(args.runId), {
        requestId: brandString<ProjectGoalRequestId>(exec.callId), taskId: args.taskId === 'master' ? 'master' : brandString<ProjectTaskId>(args.taskId),
        subGoalId: brandString<ProjectSubGoalId>(args.subGoalId), criteriaPassed: args.criteriaPassed,
        verdict: args.verdict, decision: args.decision,
        ...(args.failureReason === undefined ? {} : { failureReason: args.failureReason }),
        ...(args.escalateReason === undefined ? {} : { escalateReason: args.escalateReason }),
      }, exec.signal))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_verify',
    description: 'Rerun approved deterministic checks for a collected task in a RUNNING Goal. '
      + 'Only use this when the checked environment may have changed. This returns before execution; end your turn and await the result wake. '
      + 'Omit criteria to check every criterion with a check. Semantic criteria require inline judgement through wud_record_outcome.',
    parameters: { ...runParameters, taskId: { type: 'string', required: true }, subGoalId: { type: 'string', required: true },
      criteria: { type: 'array', items: { type: 'integer' } } }, output, presentResult,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal verification requires its source conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      await ctx.taskController.verifyGoalTask(workspace.id, session.id, brandString<ProjectGoalRunId>(args.runId), {
        requestId: brandString<ProjectGoalRequestId>(exec.callId), taskId: brandString<ProjectTaskId>(args.taskId),
        subGoalId: brandString<ProjectSubGoalId>(args.subGoalId), ...(args.criteria === undefined ? {} : { criteria: args.criteria }),
      }, exec.signal)
      return notice(ctx.taskController.inspectGoal(workspace.id, session.id, brandString<ProjectGoalRunId>(args.runId)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_enter',
    description: 'Record a goal for gathering requirements in this project conversation. '
      + 'This does not dispatch tasks, approve a plan or grant additional permissions. '
      + 'Only one non-exited run can exist in this conversation; exit it before entering another goal.',
    parameters: { goal: { type: 'string', required: true, description: 'The complete objective to gather requirements for.' } },
    output, presentResult,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal entry requires a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      return notice(await ctx.taskController.enterGoal(workspace.id, {
        requestId: brandString<ProjectGoalRequestId>(exec.callId), sourceSessionId: session.id, goal: args.goal,
      }, exec.signal))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_submit_plan',
    description: 'Submit a complete goal plan for user signoff. Each sub-goal needs machine-verifiable and plain-language acceptance criteria. '
      + 'During RUNNING, resubmit when the objective, criteria or scope changes: prior approval is withdrawn, acceptance resets, existing tasks become unbound and cumulative usage is retained. '
      + 'Dependencies must reference unique sub-goal IDs and form an acyclic graph. Submission does not approve, dispatch, execute checks or claim completion. '
      + 'Await user review after submission; repeated calls cannot replace a pending plan. Supply the exact runId returned by wud_enter or wud_status.',
    parameters: { ...runParameters, ...planParameters }, output, presentResult,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Plan submission requires a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      const { runId, brainProjectIds, ...plan } = args
      return notice(await ctx.taskController.submitGoalPlan(workspace.id, session.id, brandString<ProjectGoalRunId>(runId),
        brandString<ProjectGoalRequestId>(exec.callId), {
          ...(brainProjectIds === undefined ? {} : { brainProjectIds: brainProjectIds.map(value => brandString<WorkspaceId>(value)) }),
          ...plan, subGoals: plan.subGoals.map(({ id, dependsOn, ...item }) => ({ ...item, id: brandString<ProjectSubGoalId>(id),
            ...(dependsOn === undefined ? {} : { dependsOn: dependsOn.map(value => brandString<ProjectSubGoalId>(value)) }) })),
        }, exec.signal))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_status',
    description: 'Read this conversation’s latest goal run, or null if none exists. Reading does not resume execution.',
    parameters: {}, output, presentResult,
    execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal operations require a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      return Promise.resolve(notice(ctx.taskController.currentGoal(workspace.id, session.id)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wud_exit',
    description: 'Exit the exact run identified by runId without claiming completion. '
      + 'An approved run cannot exit while its source is running. Retain the id returned by wud_enter or wud_status when retrying. '
      + 'This does not cancel ordinary tasks, remove worktrees or exit a newer run.',
    parameters: runParameters, output, presentResult,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Goal operations require a project conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      return notice(await ctx.taskController.exitGoal(workspace.id, session.id, brandString<ProjectGoalRunId>(args.runId), exec.signal))
    },
  }))
}
