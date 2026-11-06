/** Logged capability recording and shared output fields for Goal status. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProjectGoalModelCapability, ProjectGoalRequestId, ProjectGoalRunId } from './types.ts'
import { goalCapabilitySchema } from './goal-capabilities.ts'

const claimProperties = {
  provider: { type: 'string', required: true, description: 'Exact provider id used to route this model.' },
  model: { type: 'string', required: true, description: 'Exact model id, kept separate across providers.' },
  tier: { type: 'string', required: true, enum: ['frontier', 'balanced', 'fast', 'unknown'] },
  summary: { type: 'string', required: true, description: 'Short evidence-based guidance about suitable work and limitations.' },
  source: { type: 'string', required: true, description: 'Public research source. Never include private project content or credentials.' },
  assumed: { type: 'boolean', required: true, description: 'True for an inference or inconclusive research, false only for a sourced research claim.' },
} as const

/** Complete capability receipt fields shared by recording and status; no hidden model input is added. */
export const goalCapabilityOutputSchema = { type: 'object', additionalProperties: false, properties: {
  ...claimProperties, recordedAt: { type: 'integer', required: true }, expiresAt: { type: 'integer', required: true },
} } as const

/** Register a source-owned tool whose result logs exactly the retained assessment.
 * @param ctx - controller lifetime, tool registry and source membership services.
 */
export function installGoalCapabilityTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'wud_record_model_capability',
    description: 'Save a sourced model capability assessment for reuse across local Goal runs. '
      + 'Research with available read-only tools first; mark inconclusive results assumed=true. '
      + 'This stores your assessment, not an independently verified benchmark. '
      + 'Assumptions expire sooner. Recording never approves a plan, selects a model or grants execution permissions.',
    parameters: { runId: { type: 'string', required: true }, ...claimProperties },
    output: { schema: goalCapabilityOutputSchema,
      render: (_args: unknown, value: ProjectGoalModelCapability) => [{ type: 'text' as const, text: JSON.stringify(value) }],
      presentationMeta: (_args: unknown, value: ProjectGoalModelCapability) => ({ ...value }) },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const parsed = goalCapabilitySchema.safeParse(result.meta)
      if (!parsed.success) return undefined
      return { card: 'generic', title: `${parsed.data.provider} · ${parsed.data.model}`,
        content: [{ type: 'text', text: parsed.data.summary }] }
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('Capability recording requires the Goal source conversation')
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(session.id))
      if (workspace === undefined) throw new Error('The conversation does not belong to a registered project')
      const { runId, ...claim } = args
      return ctx.taskController.recordGoalModelCapability(workspace.id, session.id, brandString<ProjectGoalRunId>(runId),
        { ...claim, requestId: brandString<ProjectGoalRequestId>(exec.callId) }, exec.signal)
    },
  }))
}
