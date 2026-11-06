/** Final local Git delivery under the controller's project mutation reservation. */
import { join } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { gitWorkspaceSchema } from './git-workspace.ts'
import type { GoalDeliveryRecord } from './goal-delivery.ts'
import type { ProjectGitWorkspace } from './types.ts'

type Git = (cwd: string, args: readonly string[], allowed?: readonly number[]) => Promise<{ code: number; text: string }>

/** Deliver only the retained commits; no fetch, push, stash, forced checkout or worktree deletion occurs.
 * @param root - verified original repository directory.
 * @param integration - exact registered integration checkout and baseline.
 * @param receipt - durable user gesture and any previously selected commits.
 * @param git - bounded managed process runner, checking run ownership before and after each operation.
 * @param save - durable acknowledgement before each mutation stage.
 * @param identity - deployment-configured author arguments for local merge commits.
 * @param generatedReports - revalidated exact report paths; no other untracked file is exempt.
 * @returns a terminal receipt; an interrupted operation remains pending for an explicit retry.
 */
export async function deliverGoalGit(root: string, integration: ProjectGitWorkspace, receipt: GoalDeliveryRecord,
  git: Git, save: (value: GoalDeliveryRecord) => Promise<GoalDeliveryRecord>, identity: readonly string[],
  generatedReports: () => Promise<readonly string[]> = () => Promise.resolve([])): Promise<GoalDeliveryRecord> {
  const refuse = (message: string): never => { throw new RemoteError('project-task/rejected', message, { reason: 'goal-git-conflict' }) }
  const head = async (cwd: string) => gitWorkspaceSchema.shape.baseCommit.parse((await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim())
  const branch = async (cwd: string) => {
    const value = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1])
    return value.code === 0 ? value.text.trim() : null
  }
  const clean = async (cwd: string): Promise<void> => {
    const allowed = cwd === root ? new Set(await generatedReports()) : new Set<string>()
    const entries = (await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).text.split('\0').filter(Boolean)
    if (entries.some(entry => !entry.startsWith('?? ') || !allowed.has(entry.slice(3)))) {
      refuse('Commit or stash local changes before delivery.')
    }
    if ((await git(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], [1])).code === 0) refuse('An existing merge must be resolved before delivery.')
  }
  const target = join(root, integration.relativePath)
  const worktrees = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).text.split('\0\0').map(block => block.split('\0'))
  const listed = worktrees.find(fields => fields.includes(`worktree ${target}`))
  if (listed === undefined || listed.some(field => field.startsWith('prunable'))) refuse('The retained integration worktree is unavailable.')
  await clean(root)
  await clean(target)
  let current = receipt
  if (current.reservation === undefined) {
    if (await branch(target) !== integration.branch) refuse('The integration checkout changed branches.')
    const targetBranch = (current.input.action === 'merge' ? integration.baseBranch : integration.branch)
      ?? refuse('The original baseline has no branch. Choose checkout instead.')
    const base = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}^{commit}`], [1])
    if (base.code !== 0) refuse('The delivery target branch no longer exists.')
    current = await save({ ...current, reservation: { integrationCommit: await head(target),
      baseCommit: gitWorkspaceSchema.shape.baseCommit.parse(base.text.trim()), originalCommit: await head(root),
      originalBranch: await branch(root), targetBranch } })
  }
  const selected = current.reservation
  if (selected === undefined) throw new Error('Delivery must retain its Git inputs')
  if (selected.targetBranch !== (current.input.action === 'merge' ? integration.baseBranch : integration.branch)) {
    refuse('The retained delivery target does not match the approved run.')
  }
  const runTip = (await git(root, ['rev-parse', '--verify', `refs/heads/${integration.branch}^{commit}`])).text.trim()
  if (runTip !== selected.integrationCommit || await head(target) !== selected.integrationCommit) refuse('The reviewed integration commit changed.')
  const currentBranch = await branch(root)
  const currentHead = await head(root)
  const mergeTitle = `Goal deliver ${integration.branch}`
  if (current.input.action === 'checkout' && currentBranch === integration.branch && currentHead === selected.integrationCommit) {
    return save({ ...current, status: 'checked-out', commit: currentHead })
  }
  if (current.input.action === 'merge' && currentBranch === selected.targetBranch && currentHead !== selected.baseCommit) {
    const expected = `${selected.baseCommit} ${selected.integrationCommit}\n${mergeTitle}`
    if ((await git(root, ['show', '-s', '--format=%P%n%s', 'HEAD'])).text.trim() !== expected) refuse('The baseline changed during delivery.')
    return save({ ...current, status: 'merged', commit: currentHead })
  }
  const onOriginal = currentBranch === selected.originalBranch && currentHead === selected.originalCommit
  const onBase = current.input.action === 'merge' && currentBranch === selected.targetBranch && currentHead === selected.baseCommit
  if (!onOriginal && !onBase) refuse('The original checkout changed during delivery.')
  const baseTip = (await git(root, ['rev-parse', '--verify', `refs/heads/${selected.targetBranch}^{commit}`])).text.trim()
  if (baseTip !== selected.baseCommit) refuse('The selected target branch advanced during delivery.')
  if (current.input.action === 'checkout') {
    const integrationBranch = await branch(target)
    if (integrationBranch !== null && integrationBranch !== integration.branch) refuse('The integration checkout changed branches.')
    // Detaching the clean retained checkout frees its branch without removing any worktree or files.
    if (integrationBranch !== null) await git(target, ['checkout', '--detach', selected.integrationCommit])
    await git(root, ['checkout', integration.branch])
    const delivered = await head(root)
    if (delivered !== selected.integrationCommit || await branch(root) !== integration.branch) refuse('The result branch changed during checkout.')
    return save({ ...current, status: 'checked-out', commit: delivered })
  }
  if (await branch(target) !== integration.branch) refuse('The integration checkout changed branches.')
  if (!onBase) await git(root, ['checkout', selected.targetBranch])
  if ((await git(root, ['merge-base', '--is-ancestor', selected.integrationCommit, selected.baseCommit], [1])).code === 0) {
    return save({ ...current, status: 'merged', commit: selected.baseCommit })
  }
  const result = await git(root, [...identity, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', mergeTitle, selected.integrationCommit], [1])
  if (result.code === 0) return save({ ...current, status: 'merged', commit: await head(root) })
  const mergeHead = await git(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [1])
  if (mergeHead.code !== 0 || mergeHead.text.trim() !== selected.integrationCommit || await head(root) !== selected.baseCommit) {
    refuse('Delivery did not produce a recognized merge result. The repository has been left for inspection.')
  }
  const files = (await git(root, ['diff', '--name-only', '--diff-filter=U', '-z'])).text.split('\0').filter(Boolean).sort()
  if (files.length === 0) refuse('Delivery failed without a recognized conflict. The repository has been left for inspection.')
  await git(root, ['merge', '--abort'])
  await clean(root)
  if (await head(root) !== selected.baseCommit) refuse('The baseline moved while aborting this delivery.')
  await git(root, selected.originalBranch === null ? ['checkout', '--detach', selected.originalCommit] : ['checkout', selected.originalBranch])
  if (await head(root) !== selected.originalCommit) refuse('The original branch moved while restoring the checkout.')
  return save({ ...current, status: 'conflict', files })
}
