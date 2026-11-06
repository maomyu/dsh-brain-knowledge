/** Plan parsing and graph validation; authored verification operations remain inert data. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectSubGoalId } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

const text = z.string().trim().min(1)
const subGoalId = text.transform(value => brandString<ProjectSubGoalId>(value))
const brainProjects = z.array(text.transform(value => brandString<WorkspaceId>(value)))
  .refine(values => new Set(values).size === values.length, 'Brain project identities must be unique')
const timeoutMs = z.number().int().min(1000).max(Number.MAX_SAFE_INTEGER).optional()
const check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: text, timeoutMs }).strict(),
  z.object({ kind: z.literal('http'), url: z.url({ protocol: /^https?$/ }), timeoutMs }).strict(),
])
const criterion = z.object({ machine: text, plain: text, weak: z.boolean().optional(), check: check.optional() }).strict()
const subGoal = z.object({ id: subGoalId, title: text, criteria: z.array(criterion).min(1),
  dependsOn: z.array(subGoalId), complexity: z.enum(['simple', 'medium', 'complex']), affectedFiles: z.array(text) }).strict()

/** Complete resolved plan validation for durable and remote reads, including graph relationships. */
export const goalPlanSchema = z.object({ goal: text, allowTaskDispatch: z.boolean().optional(), subGoals: z.array(subGoal).min(1),
  knowledgeMaintenance: z.enum(['automatic', 'read-only']).optional(),
  brainProjectIds: brainProjects.optional(),
  brainRefs: z.array(text), rootPageRefs: z.array(z.enum(['background', 'architecture', 'flow', 'mindmap', 'stack', 'roadmap'])) }).strict()
  .superRefine((plan, context) => {
    const remaining = new Map(plan.subGoals.map(item => [item.id, new Set(item.dependsOn)]))
    if (remaining.size !== plan.subGoals.length) {
      context.addIssue({ code: 'custom', message: 'sub-goal identities must be unique', path: ['subGoals'] })
      return
    }
    for (const [id, dependencies] of remaining) {
      for (const dependency of dependencies) {
        if (!remaining.has(dependency)) {
          context.addIssue({ code: 'custom', message: `sub-goal ${id} refers to unknown dependency ${dependency}`, path: ['subGoals'] })
          return
        }
      }
    }
    while (remaining.size > 0) {
      const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id)
      if (ready.length === 0) {
        context.addIssue({ code: 'custom', message: 'sub-goal dependencies must be acyclic', path: ['subGoals'] })
        return
      }
      for (const id of ready) remaining.delete(id)
      for (const dependencies of remaining.values()) for (const id of ready) dependencies.delete(id)
    }
  })

const inputSchema = z.object({ goal: text.optional(), allowTaskDispatch: z.boolean().optional(), subGoals: z.array(subGoal.partial({
  dependsOn: true, complexity: true, affectedFiles: true,
})).min(1), knowledgeMaintenance: z.enum(['automatic', 'read-only']).optional(), brainRefs: z.array(text).optional(), brainProjectIds: z.array(text).optional(),
rootPageRefs: z.array(text).optional() }).strict()

/** Resolve an authored plan before committing; invalid or cyclic plans throw without side effects.
 * @param input - untrusted remote or model-authored fields.
 * @param fallbackGoal - retained objective when the plan omits one.
 * @returns validated, normalized plan with explicit collections and complexity.
 */
export function resolveGoalPlan(input: unknown, fallbackGoal: string): z.infer<typeof goalPlanSchema> {
  const parsed = inputSchema.parse(input)
  return goalPlanSchema.parse({ goal: parsed.goal ?? fallbackGoal,
    ...(parsed.knowledgeMaintenance === undefined ? {} : { knowledgeMaintenance: parsed.knowledgeMaintenance }),
    ...(parsed.allowTaskDispatch === undefined ? {} : { allowTaskDispatch: parsed.allowTaskDispatch }),
    ...(parsed.brainProjectIds === undefined ? {} : { brainProjectIds: [...new Set(parsed.brainProjectIds)] }),
    subGoals: parsed.subGoals.map(item => ({ ...item, complexity: item.complexity ?? 'medium',
      dependsOn: [...new Set(item.dependsOn ?? [])], affectedFiles: [...new Set(item.affectedFiles ?? [])] })),
    brainRefs: [...new Set(parsed.brainRefs ?? [])], rootPageRefs: [...new Set(parsed.rootPageRefs ?? [])] })
}
