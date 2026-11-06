/** Runtime-qualified Goal routes for approval, dispatch and durable validation. */
import type { ProjectGoalClaudeModel, ProjectGoalCodexModel, ProjectGoalTaskModel } from './types.ts'

/** Distinguish native execution from provider-qualified Harness execution.
 * @param model - signed or requested task route.
 * @returns whether execution belongs to a native runtime rather than a Harness provider.
 */
export function isNativeGoalModel(model: ProjectGoalTaskModel): model is ProjectGoalCodexModel | ProjectGoalClaudeModel {
  return 'runtime' in model
}

/** Derive the identity used to reject duplicate pool selections.
 * @param model - signed or requested task route.
 * @returns identity independent of reasoning settings, suitable for pool uniqueness.
 */
export function goalModelKey(model: ProjectGoalTaskModel): string {
  return JSON.stringify(isNativeGoalModel(model) ? ['native', model.runtime, model.model] : [model.provider, model.model])
}

/** Check a requested or retained route against signed execution authority.
 * @param approved - resolved route retained by approval.
 * @param selected - requested route or durable task binding.
 * @param exactEffort - require the retained effort; dispatch may omit it to inherit approval.
 * @returns whether runtime, model, coding policy and any required effort match approval.
 */
export function matchesGoalModel(approved: ProjectGoalTaskModel, selected: ProjectGoalTaskModel, exactEffort: boolean): boolean {
  if (isNativeGoalModel(approved) || isNativeGoalModel(selected)) {
    return isNativeGoalModel(approved) && isNativeGoalModel(selected) && approved.runtime === selected.runtime
      && approved.model === selected.model
      && (approved.runtime !== 'claude' || (selected.runtime === 'claude' && approved.permissionMode === selected.permissionMode))
      && ((!exactEffort && selected.reasoningEffort === undefined) || approved.reasoningEffort === selected.reasoningEffort)
  }
  return approved.provider === selected.provider && approved.model === selected.model
    && ((!exactEffort && selected.reasoningEffort === undefined) || approved.reasoningEffort === selected.reasoningEffort)
}
