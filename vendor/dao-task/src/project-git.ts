/** Local Git preparation and Goal integration through managed filesystem and subprocess providers. */
import { dirname, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-api-artifact-controller'
import type { ArtifactRenditionId } from '@deepseek-ai/dsh-api-artifact-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { gitWorkspaceSchema } from './git-workspace.ts'
import { goalMergeSchema, type GoalMergeRecord } from './goal-merge.ts'
import type { Config } from './index.ts'
import type { ProjectGitWorkspace, ProjectGoalRunId, ProjectTaskId, ProjectGitCommitId, ProjectGoalTaskDiff, ProjectGoalCodingFiles, ProjectTaskFileStat, ProjectTaskDirectWorkspaceState } from './types.ts'
import { parseTaskFileStats } from './task-file-stats.ts'
import { TaskCommandPool } from './commands.ts'
import { deliverGoalGit } from './goal-delivery-git.ts'
import type { GoalDeliveryRecord } from './goal-delivery.ts'

/** Serializes Git mutations per project; a reservation is durable before branch allocation. */
export class ProjectGit {
  private readonly commands: TaskCommandPool<WorkspaceId,
    ProjectGitWorkspace | GoalMergeRecord | GoalDeliveryRecord | ProjectGoalTaskDiff | ProjectGoalCodingFiles
    | readonly ProjectTaskFileStat[]
    | readonly { path: string; change: 'added' | 'modified' | 'deleted' }[] | string | null>

  /** @param ctx - matching filesystem and subprocess execution world.
   * @param config - explicit Git executable, resource bounds and baseline identity.
   * @param lifetime - controller cancellation, joined before storage closes.
   */
  constructor(private readonly ctx: Context, private readonly config: Config, lifetime: AbortSignal) {
    this.commands = new TaskCommandPool(lifetime, config.maxConcurrent)
  }

  /** Prepare one integration worktree without changing an existing checkout, index or branch.
   * @param workspaceId - project-level mutation reservation.
   * @param workspacePath - original registered project directory.
   * @param runId - retained Goal run used for collision-resistant local names.
   * @param reserved - earlier durable reservation, if preparation was interrupted.
   * @param save - persist the chosen base before allocating the branch or worktree.
   * @param signal - operation lifetime; every child is terminated and joined on cancellation.
   * @returns verified integration metadata; a removed checkout reuses its unchanged reserved branch, while collisions reject.
   */
  prepareGoal(workspaceId: WorkspaceId, workspacePath: string, runId: ProjectGoalRunId,
    reserved: ProjectGitWorkspace | undefined, save: (value: ProjectGitWorkspace) => Promise<void>,
    signal: AbortSignal): Promise<ProjectGitWorkspace> {
    return this.prepare(workspaceId, workspacePath, 'goal', `.dsh/goals/${runId}/integration`, `codex/goal-${runId}`, reserved, save, signal, undefined)
  }

  /** Allocate a task checkout from committed HEAD; gathering can establish an absent Git baseline.
   * @param workspaceId - project-level mutation reservation shared with Goal preparation.
   * @param workspacePath - original registered repository root.
   * @param taskId - immutable task identity used for the branch and checkout path.
   * @param reserved - durable starting commit retained before any allocation.
   * @param save - persist the starting commit before branch or checkout creation.
   * @param signal - caller and controller lifetime, including managed child teardown.
   * @param authority - gathering permits initial Git setup; an approved run selects its integration tip.
   * @returns a clean checkout, reattaching an unchanged reserved branch when needed; existing source edits remain intact.
   */
  prepareTask(workspaceId: WorkspaceId, workspacePath: string, taskId: ProjectTaskId,
    reserved: ProjectGitWorkspace | undefined, save: (value: ProjectGitWorkspace) => Promise<void>,
    signal: AbortSignal, authority: { kind: 'ordinary' | 'gather' } | { kind: 'approved'; integration: ProjectGitWorkspace }): Promise<ProjectGitWorkspace> {
    return this.prepare(workspaceId, workspacePath, authority.kind === 'gather' ? 'gather' : 'task',
      `.dsh/tasks/${taskId}/worktree`, `codex/task-${taskId}`, reserved, save, signal,
      authority.kind === 'approved' ? authority.integration : undefined)
  }

  /** Commit a completed task's edits and merge its fixed tip into its approved integration checkout.
   * @param workspaceId - project mutation reservation shared with checkout preparation.
   * @param workspacePath - original repository, whose HEAD, index and files remain unchanged.
   * @param runId - approved Goal identity owning the integration checkout.
   * @param taskId - completed coding task owning the task checkout.
   * @param integration - retained Goal checkout.
   * @param task - retained task checkout and starting commit.
   * @param reserved - earlier write-ahead record, including an interrupted commit or merge.
   * @param save - durable acknowledgement required before each ref mutation.
   * @param guard - recheck exact live source and approved run around every asynchronous operation.
   * @param signal - operation lifetime; interrupted Git state is reconciled only on an authorized retry.
   * @returns local merge receipt, never an acceptance verdict; conflicts leave the integration tip unchanged.
   */
  mergeTask(workspaceId: WorkspaceId, workspacePath: string, runId: ProjectGoalRunId, taskId: ProjectTaskId,
    integration: ProjectGitWorkspace, task: ProjectGitWorkspace, reserved: GoalMergeRecord | undefined,
    save: (value: GoalMergeRecord) => Promise<void>, guard: () => void, signal: AbortSignal): Promise<GoalMergeRecord> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const check = (): void => { live.throwIfAborted(); guard() }
      const conflict = (): never => { throw new RemoteError('project-task/rejected',
        'Goal collection no longer matches its retained worktrees or Git inputs.', { reason: 'goal-git-conflict' }) }
      const run = async (cwd: string, args: readonly string[], allowed: readonly number[] = []) => {
        check()
        const result = await this.git(cwd, args, live, allowed)
        check()
        return result
      }
      const retain = async (value: GoalMergeRecord): Promise<GoalMergeRecord> => {
        check(); await save(value); check(); return value
      }
      check()
      if (reserved !== undefined && reserved.status !== 'preparing' && reserved.status !== 'merging') return reserved
      if (integration.branch !== `codex/goal-${runId}` || integration.relativePath !== `.dsh/goals/${runId}/integration`
        || task.branch !== `codex/task-${taskId}` || task.relativePath !== `.dsh/tasks/${taskId}/worktree`
        || task.baseBranch !== integration.branch) conflict()
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      const listing = (await run(root, ['worktree', 'list', '--porcelain', '-z'])).text
      for (const checkout of [integration, task]) {
        await this.safeDestination(root, checkout.relativePath, live, conflict)
        const directory = join(root, checkout.relativePath)
        if (!listing.split('\0\0').some((block) => {
          const fields = block.split('\0')
          return fields.includes(`worktree ${directory}`) && fields.includes(`branch refs/heads/${checkout.branch}`)
            && !fields.some(field => field.startsWith('prunable'))
        })) conflict()
        if ((await run(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1])).text.trim() !== checkout.branch) conflict()
      }
      const worker = join(root, task.relativePath)
      const target = join(root, integration.relativePath)
      const head = async (cwd: string) => gitWorkspaceSchema.shape.baseCommit.parse((await run(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim())
      const clean = async (cwd: string): Promise<void> => {
        if ((await run(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).text !== '') conflict()
      }
      let current: GoalMergeRecord | undefined = reserved
      const mergeHead = await run(target, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [1])
      // A retained in-progress merge may contain later manual resolution; retry must not discard it.
      if (mergeHead.code === 0) conflict()
      await clean(target)
      if (current === undefined) {
        const taskHead = await head(worker)
        if ((await run(worker, ['merge-base', '--is-ancestor', task.baseCommit, taskHead], [1])).code !== 0) conflict()
        const integrationHead = await head(target)
        await run(worker, ['add', '-A', '--', '.'])
        const taskTree = (await run(worker, ['write-tree'])).text.trim()
        current = await retain(goalMergeSchema.parse({ status: 'preparing', taskHead, taskTree, integrationHead }))
      }
      const title = `Goal task ${taskId}`
      const identity = ['-c', `user.name=${this.config.goalGit.baselineName}`, '-c', `user.email=${this.config.goalGit.baselineEmail}`]
      if (current.status === 'preparing') {
        let taskCommit = await head(worker)
        if (taskCommit === current.taskHead) {
          if ((await run(worker, ['write-tree'])).text.trim() !== current.taskTree
            || (await run(worker, ['diff', '--quiet'], [1])).code !== 0
            || (await run(worker, ['ls-files', '--others', '--exclude-standard', '-z'])).text !== '') conflict()
          const oldTree = (await run(worker, ['rev-parse', 'HEAD^{tree}'])).text.trim()
          if (oldTree !== current.taskTree) await run(worker, [...identity, 'commit', '--no-verify', '-m', title])
          taskCommit = await head(worker)
        }
        if (taskCommit !== current.taskHead) {
          const expected = `${current.taskTree}\n${current.taskHead}\n${title}`
          if ((await run(worker, ['show', '-s', '--format=%T%n%P%n%s', 'HEAD'])).text.trim() !== expected) conflict()
        }
        await clean(worker)
        current = await retain({ ...current, status: 'merging', taskCommit })
      }
      /* v8 ignore if -- retain returns the same persisted merging checkpoint; stored records must not be mutated in place. */
      if (current.status !== 'merging') throw new Error('Goal merge must retain its selected task commit')
      if (await head(worker) !== current.taskCommit) conflict()
      await clean(worker)
      const targetHead = await head(target)
      const mergeTitle = `Goal integrate task ${taskId}`
      if (targetHead !== current.integrationHead) {
        const expected = `${current.integrationHead} ${current.taskCommit}\n${mergeTitle}`
        if ((await run(target, ['show', '-s', '--format=%P%n%s', 'HEAD'])).text.trim() !== expected) conflict()
        return retain({ ...current, status: 'merged', commit: targetHead })
      }
      if ((await run(target, ['merge-base', '--is-ancestor', current.taskCommit, targetHead], [1])).code === 0) {
        return retain({ ...current, status: 'empty', commit: targetHead })
      }
      const merged = await run(target, [...identity, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', mergeTitle, current.taskCommit], [1])
      if (merged.code === 0) return retain({ ...current, status: 'merged', commit: await head(target) })
      const owned = await run(target, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [1])
      if (owned.code !== 0 || owned.text.trim() !== current.taskCommit || await head(target) !== current.integrationHead) conflict()
      const files = (await run(target, ['diff', '--name-only', '--diff-filter=U', '-z'])).text.split('\0').filter(Boolean).sort()
      await run(target, ['merge', '--abort'])
      await clean(target)
      if (await head(target) !== current.integrationHead || files.length === 0) conflict()
      return retain({ ...current, status: 'conflict', files })
    })
  }

  /** Deliver one terminal run after explicit user authorization.
   * @param workspaceId - shared project mutation reservation.
   * @param workspacePath - original registered checkout.
   * @param runId - exact run owning the integration branch.
   * @param integration - retained integration checkout and baseline.
   * @param receipt - durable user choice and retry inputs.
   * @param save - persist each write-ahead stage and final outcome.
   * @param guard - recheck project, source and terminal run ownership.
   * @param signal - controller lifetime after gesture admission.
   * @param generatedReports - exact immutable Goal report files that may remain untracked in the original checkout.
   * @returns retained local delivery result; no remote repository is contacted.
   */
  deliverGoal(workspaceId: WorkspaceId, workspacePath: string, runId: ProjectGoalRunId, integration: ProjectGitWorkspace,
    receipt: GoalDeliveryRecord, save: (value: GoalDeliveryRecord) => Promise<GoalDeliveryRecord>,
    guard: () => void, signal: AbortSignal, generatedReports: readonly {
      artifactId: ArtifactRenditionId
      contentSha256: string
      projectRelativePath: string
    }[] = []): Promise<GoalDeliveryRecord> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const check = (): void => { live.throwIfAborted(); guard() }
      const conflict = (): never => {
        throw new RemoteError('project-task/rejected', 'Goal delivery worktree changed.', { reason: 'goal-git-conflict' })
      }
      check()
      if (integration.branch !== `codex/goal-${runId}` || integration.relativePath !== `.dsh/goals/${runId}/integration`) conflict()
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      await this.safeDestination(root, integration.relativePath, live, conflict)
      const run = async (cwd: string, args: readonly string[], allowed?: readonly number[]) => {
        check(); const result = await this.git(cwd, args, live, allowed); check(); return result
      }
      const top = (await run(root, ['rev-parse', '--show-toplevel'])).text.trim()
      if ((await this.ctx.fs.resolve(top, { signal: live })).targetKey
        !== (await this.ctx.fs.resolve(root, { signal: live })).targetKey) conflict()
      return deliverGoalGit(root, integration, receipt, run, async (value) => {
        check(); const saved = await save(value); check(); return saved
      }, ['-c', `user.name=${this.config.goalGit.baselineName}`, '-c', `user.email=${this.config.goalGit.baselineEmail}`],
      async () => {
        const paths: string[] = []
        for (const report of generatedReports) {
          check()
          const content = await this.ctx.artifactController.read(workspaceId, report.artifactId, live)
            .catch(() => conflict())
          if (createHash('sha256').update(Buffer.from(content.dataBase64, 'base64')).digest('hex') !== report.contentSha256) conflict()
          paths.push(report.projectRelativePath)
        }
        return paths
      })
    })
  }

  /** Read fixed-commit file statistics before admitting a result notice.
   * @param workspaceId - project reservation shared with Git delivery.
   * @param workspacePath - registered original repository root.
   * @param base - task's retained starting commit.
   * @param result - collected task commit.
   * @param guard - recheck project and source ownership around reads.
   * @param signal - collection lifetime.
   * @returns changed paths and textual counts, or null counts for binary files.
   */
  taskFiles(workspaceId: WorkspaceId, workspacePath: string, base: ProjectGitCommitId, result: ProjectGitCommitId,
    guard: () => void, signal: AbortSignal): Promise<readonly ProjectTaskFileStat[]> {
    return this.readTaskCommits(workspaceId, workspacePath, base, result, guard, signal,
      async run => parseTaskFileStats(await run(['--numstat', '-z'])))
  }

  /** Compare retained commits without reading a later working tree or invoking external diff drivers.
   * @param workspaceId - project reservation shared with Git delivery.
   * @param workspacePath - registered original repository root.
   * @param base - task's retained starting commit.
   * @param result - collected task commit, never a moving branch name.
   * @param guard - recheck exact project and source membership around reads.
   * @param signal - caller lifetime; cancellation joins the subprocess.
   * @returns complete changed paths and unified patch under the configured Git output limits.
   */
  taskDiff(workspaceId: WorkspaceId, workspacePath: string, base: ProjectGitCommitId, result: ProjectGitCommitId,
    guard: () => void, signal: AbortSignal): Promise<ProjectGoalTaskDiff> {
    return this.readTaskCommits(workspaceId, workspacePath, base, result, guard, signal, async (run) => {
      const value = { files: parseTaskFileStats(await run(['--numstat', '-z'])),
        patch: await run(['--src-prefix=a/', '--dst-prefix=b/']) }
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.config.goalGit.maxOutputBytes) {
        throw new Error('Task diff exceeds the configured output limit')
      }
      return value
    })
  }

  /** Read every changed regular file from retained commits, with complete content and blob identity.
   * @param workspaceId - project reservation shared with Goal delivery.
   * @param workspacePath - original repository root.
   * @param base - Task starting commit.
   * @param result - collected Task commit.
   * @param guard - exact project and source ownership check around each Git read.
   * @param signal - caller lifetime; cancellation joins subprocesses.
   * @returns bounded complete UTF-8 bodies; unsafe, missing and unsupported files reject the whole read.
   */
  taskCodingFiles(workspaceId: WorkspaceId, workspacePath: string, base: ProjectGitCommitId,
    result: ProjectGitCommitId, guard: () => void, signal: AbortSignal): Promise<ProjectGoalCodingFiles> {
    return this.readTaskCommits(workspaceId, workspacePath, base, result, guard, signal, async (diff, run) => {
      const changed = parseTaskFileStats(await diff(['--numstat', '-z']))
      if (changed.length > this.config.outputFiles.maxEntries || changed.some(file => file.added === null
        || file.removed === null)) throw new Error('Goal coding files exceed the supported text inventory')
      const files: ProjectGoalCodingFiles['files'][number][] = []
      for (const file of changed) {
        const path = file.path
        const parts = path.split('/')
        if (Buffer.byteLength(path, 'utf8') > this.config.outputFiles.maxPathBytes
          || path.includes('�') || /[\\:\u0000-\u001f\u007f]/u.test(path)
          || parts.some(part => part === '' || part === '.' || part === '..')
          || parts[0] === '.git' || parts[0] === '.dsh') {
          throw new Error('Goal coding file has an unsafe path')
        }
        const entry = async (commit: ProjectGitCommitId) => {
          const tree = await run(['ls-tree', '-z', commit, '--', `:(literal)${path}`])
          if (tree === '') return undefined
          const parsed = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(tree)
          if (parsed === null || parsed[3] !== path) throw new Error('Goal coding file is not a regular blob')
          return parsed[2]
        }
        const before = await entry(base)
        const after = await entry(result)
        if (before === undefined && after === undefined) throw new Error('Goal coding file is absent from both commits')
        const version = after ?? before
        /* v8 ignore if -- the preceding check rejects both absent local blob IDs; neither local changes here. */
        if (version === undefined) throw new Error('Goal coding file has no retained blob')
        const change = before === undefined ? 'added' as const : after === undefined ? 'deleted' as const : 'modified' as const
        const sizeText = await run(['cat-file', '-s', version])
        const bytes = Number(sizeText.trim())
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.config.goalGit.maxOutputBytes) {
          throw new Error('Goal coding file exceeds the configured output limit')
        }
        const text = await run(['cat-file', 'blob', version])
        const body = Buffer.from(text, 'utf8')
        const objectId = createHash(version.length === 40 ? 'sha1' : 'sha256')
          .update(`blob ${body.byteLength}\0`).update(body).digest('hex')
        if (body.byteLength !== bytes || objectId !== version
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
          throw new Error('Goal coding file is not complete supported UTF-8 text')
        }
        files.push({ path, change, version, bytes, sha256: createHash('sha256').update(body).digest('hex'), text })
        if (Buffer.byteLength(JSON.stringify(files), 'utf8') > this.config.goalGit.maxOutputBytes) {
          throw new Error('Goal coding files exceed the configured output limit')
        }
      }
      const manifest = { format: 'goal-coding-files-v1' as const, baseCommit: base, taskCommit: result, files }
      return { ...manifest, sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }
    })
  }

  /** Verify the retained checkout before a Task file observation or read.
   * @param workspaceId - original project reservation.
   * @param workspacePath - unchanged registered Git root.
   * @param taskId - Task owning the branch and checkout path.
   * @param checkout - durable worktree reservation made before execution.
   * @param guard - current Task and project ownership check.
   * @param signal - bounded operation lifetime.
   * @returns exact Host checkout path; a moved, rebound or unrelated worktree rejects.
   */
  verifyTaskWorktree(workspaceId: WorkspaceId, workspacePath: string, taskId: ProjectTaskId,
    checkout: ProjectGitWorkspace, guard: () => void, signal: AbortSignal): Promise<string> {
    return this.commands.run(workspaceId, signal, async live => this.verifiedTaskWorktree(
      workspacePath, taskId, checkout, guard, live))
  }

  /** Observe tracked and unignored untracked paths without reading file bodies.
   * @param workspaceId - original project reservation.
   * @param workspacePath - unchanged registered Git root.
   * @param taskId - Task owning the retained checkout.
   * @param checkout - fixed pre-execution commit and branch reservation.
   * @param guard - current Task and project ownership check.
   * @param signal - bounded observation lifetime.
   * @returns complete NUL-delimited Git path observation; ignored files are not inferred.
   */
  taskOutputPaths(workspaceId: WorkspaceId, workspacePath: string, taskId: ProjectTaskId,
    checkout: ProjectGitWorkspace, guard: () => void, signal: AbortSignal): Promise<readonly {
    path: string
    change: 'added' | 'modified' | 'deleted'
  }[]> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const worker = await this.verifiedTaskWorktree(workspacePath, taskId, checkout, guard, live)
      const run = async (args: readonly string[]) => {
        live.throwIfAborted(); guard()
        const result = await this.git(worker, args, live)
        guard(); return result.text
      }
      const tracked = await run(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
        '--submodule=short', '--ignore-submodules=none', '--name-status', '-z', checkout.baseCommit, '--'])
      const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z'])
      const paths: { path: string; change: 'added' | 'modified' | 'deleted' }[] = []
      const fields = tracked === '' ? [] : tracked.split('\0')
      if (fields.length > 0 && fields.pop() !== '') throw new Error('Incomplete Task Git change listing')
      if (fields.length % 2 !== 0) throw new Error('Invalid Task Git change listing')
      for (let index = 0; index < fields.length; index += 2) {
        const status = fields[index]
        const path = fields[index + 1]
        /* v8 ignore if -- split creates dense fields and the preceding check requires an even field count. */
        if (status === undefined || path === undefined) throw new Error('Invalid Task Git change listing')
        if (!/^[AMDT]$/.test(status) || path.length === 0) throw new Error('Unsupported Task Git change')
        paths.push({ path, change: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' })
      }
      const others = untracked === '' ? [] : untracked.split('\0')
      if (others.length > 0 && others.pop() !== '') throw new Error('Incomplete Task Git untracked listing')
      for (const path of others) paths.push({ path, change: 'added' })
      if (new Set(paths.map(item => item.path)).size !== paths.length) {
        throw new Error('Duplicate Task Git output path')
      }
      return paths.sort((left, right) => left.path.localeCompare(right.path))
    })
  }

  private async verifiedTaskWorktree(workspacePath: string, taskId: ProjectTaskId,
    checkout: ProjectGitWorkspace, guard: () => void, signal: AbortSignal): Promise<string> {
    const check = (): void => { signal.throwIfAborted(); guard() }
    const conflict = (): never => { throw new RemoteError('project-task/output-file',
      'Task output checkout no longer matches its retained Git identity.', { reason: 'stale' }) }
    check()
    if (checkout.branch !== `codex/task-${taskId}` || checkout.relativePath !== `.dsh/tasks/${taskId}/worktree`) conflict()
    const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal }))
    await this.safeDestination(root, checkout.relativePath, signal, conflict)
    const worker = join(root, checkout.relativePath)
    const run = async (cwd: string, args: readonly string[], allowed: readonly number[] = []) => {
      check(); const result = await this.git(cwd, args, signal, allowed); check(); return result
    }
    const top = (await run(root, ['rev-parse', '--show-toplevel'])).text.trim()
    const workerTop = (await run(worker, ['rev-parse', '--show-toplevel'])).text.trim()
    if ((await this.ctx.fs.resolve(top, { signal })).targetKey !== (await this.ctx.fs.resolve(root, { signal })).targetKey
      || (await this.ctx.fs.resolve(workerTop, { signal })).targetKey
        !== (await this.ctx.fs.resolve(worker, { signal })).targetKey) conflict()
    const original = (await run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim()
    const actual = (await run(worker, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim()
    if ((await this.ctx.fs.resolve(original, { signal })).targetKey
      !== (await this.ctx.fs.resolve(actual, { signal })).targetKey) conflict()
    const listing = (await run(root, ['worktree', 'list', '--porcelain', '-z'])).text
    if (!listing.split('\0\0').some((block) => {
      const fields = block.split('\0')
      return fields.includes(`worktree ${worker}`) && fields.includes(`branch refs/heads/${checkout.branch}`)
        && !fields.some(field => field.startsWith('prunable'))
    })) conflict()
    if ((await run(worker, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1])).text.trim() !== checkout.branch) conflict()
    if ((await run(worker, ['merge-base', '--is-ancestor', checkout.baseCommit, 'HEAD'], [1])).code !== 0) conflict()
    check()
    return worker
  }

  /** Inspect the current checkout without changing files, index, branches or Git exclusions.
   * @param workspaceId - registered execution project and Git-operation reservation.
   * @param workspacePath - exact project path; ancestor repositories and worktree pointer files are recognized.
   * @param guard - verify the original project and source around asynchronous reads.
   * @param signal - bounded operation lifetime; cancellation joins the Git child.
   * @returns current clean/dirty status, or not-git only when no repository metadata exists; Git errors reject.
   */
  inspectDirectWorkspace(workspaceId: WorkspaceId, workspacePath: string, guard: () => void,
    signal: AbortSignal): Promise<ProjectTaskDirectWorkspaceState> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const check = (): void => { live.throwIfAborted(); guard() }
      check()
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      check()
      let directory = root
      while (true) {
        const marker = await this.ctx.fs.lstat(join(directory, '.git'), {}, live)
        check()
        // Bare repositories have no .git entry but still must not be accepted as ordinary non-Git folders.
        const bare = marker === undefined && await this.ctx.fs.lstat(join(directory, 'HEAD'), {}, live) !== undefined
          && await this.ctx.fs.lstat(join(directory, 'objects'), {}, live) !== undefined
          && await this.ctx.fs.lstat(join(directory, 'refs'), {}, live) !== undefined
        check()
        if (marker !== undefined || bare) {
          const result = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], live)
          check()
          return result.text.length === 0 ? 'clean' : 'dirty'
        }
        const parent = dirname(directory)
        if (parent === directory) return 'not-git'
        directory = parent
      }
    })
  }

  /** Capture committed HEAD before direct execution without initializing Git or changing user files.
   * @param workspaceId - original project reservation.
   * @param workspacePath - exact registered project directory.
   * @param guard - recheck project and source ownership around reads.
   * @param signal - bounded preparation lifetime.
   * @returns retained commit, or null for a non-root/unborn/non-Git project; other Git failures reject.
   */
  reviewBaseline(workspaceId: WorkspaceId, workspacePath: string, guard: () => void,
    signal: AbortSignal): Promise<ProjectGitCommitId | null> {
    return this.commands.run(workspaceId, signal, async (live) => {
      guard()
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      const marker = await this.ctx.fs.lstat(join(root, '.git'), {}, live)
      guard()
      if (marker === undefined) return null
      const top = (await this.git(root, ['rev-parse', '--show-toplevel'], live)).text.trim()
      if ((await this.ctx.fs.resolve(top, { signal: live })).targetKey
        !== (await this.ctx.fs.resolve(root, { signal: live })).targetKey) return null
      const head = await this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], live, [1])
      live.throwIfAborted(); guard()
      if (head.code === 1) return null
      const commit = head.text.trim()
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Git returned an invalid review baseline')
      return brandString<ProjectGitCommitId>(commit)
    })
  }

  /** Read all tracked changes against the retained task baseline, including pre-existing direct edits.
   * @param workspaceId - original project reservation shared with Git delivery.
   * @param workspacePath - registered original repository.
   * @param cwd - retained task checkout, never a model-selected path.
   * @param base - immutable pre-execution commit.
   * @param guard - recheck exact project and task ownership.
   * @param signal - read lifetime; cancellation joins every Git process.
   * @returns complete patch; untracked files are excluded, and Git errors never become an empty patch.
   */
  reviewDiff(workspaceId: WorkspaceId, workspacePath: string, cwd: string, base: ProjectGitCommitId,
    guard: () => void, signal: AbortSignal): Promise<string> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const run = async (path: string, args: readonly string[]) => {
        live.throwIfAborted(); guard()
        const value = await this.git(path, args, live)
        live.throwIfAborted(); guard(); return value.text
      }
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      const execution = this.ctx.fs.processPath(await this.ctx.fs.resolve(cwd, { signal: live }))
      const top = (await run(execution, ['rev-parse', '--show-toplevel'])).trim()
      if ((await this.ctx.fs.resolve(top, { signal: live })).targetKey
        !== (await this.ctx.fs.resolve(execution, { signal: live })).targetKey) throw new Error('Review checkout changed')
      const original = (await run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
      const actual = (await run(execution, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
      if ((await this.ctx.fs.resolve(original, { signal: live })).targetKey
        !== (await this.ctx.fs.resolve(actual, { signal: live })).targetKey) throw new Error('Review repository changed')
      return run(execution, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
        '--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', base, '--'])
    })
  }

  private readTaskCommits<T extends ProjectGoalTaskDiff | ProjectGoalCodingFiles | readonly ProjectTaskFileStat[]>(
    workspaceId: WorkspaceId,
    workspacePath: string, base: ProjectGitCommitId, result: ProjectGitCommitId, guard: () => void, signal: AbortSignal,
    read: (diff: (args: readonly string[]) => Promise<string>, run: (args: readonly string[]) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    return this.commands.run(workspaceId, signal, async (live) => {
      guard()
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      const run = async (args: readonly string[]) => {
        live.throwIfAborted(); guard()
        const value = await this.git(root, args, live)
        guard(); return value.text
      }
      const top = await run(['rev-parse', '--show-toplevel'])
      if ((await this.ctx.fs.resolve(top.trim(), { signal: live })).targetKey
        !== (await this.ctx.fs.resolve(workspacePath, { signal: live })).targetKey) {
        throw new RemoteError('project-task/rejected', 'Task diff repository changed.', { reason: 'task-git-conflict' })
      }
      const options = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short', '--ignore-submodules=none']
      return read(args => run([...options, ...args, base, result, '--']), run)
    })
  }

  private prepare(workspaceId: WorkspaceId, workspacePath: string, kind: 'goal' | 'task' | 'gather', relativePath: string, branch: string,
    reserved: ProjectGitWorkspace | undefined, save: (value: ProjectGitWorkspace) => Promise<void>,
    signal: AbortSignal, integration: ProjectGitWorkspace | undefined): Promise<ProjectGitWorkspace> {
    return this.commands.run(workspaceId, signal, async (live) => {
      const conflict = (): never => { throw new RemoteError('project-task/rejected',
        'Worktree path, branch or repository state conflicts with its retained reservation.', { reason: `${kind === 'goal' ? 'goal' : 'task'}-git-conflict` }) }
      const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(workspacePath, { signal: live }))
      if (reserved !== undefined && (reserved.branch !== branch || reserved.relativePath !== relativePath)) conflict()
      await this.safeDestination(root, relativePath, live, conflict)
      const inside = await this.git(root, ['rev-parse', '--is-inside-work-tree'], live, [128])
      if (inside.code === 128) {
        if (kind === 'task' || reserved !== undefined || await this.ctx.fs.lstat(join(root, '.git'), {}, live) !== undefined) conflict()
        await this.git(root, ['init', '--template='], live)
      } else if (inside.text.trim() !== 'true') conflict()
      const top = (await this.git(root, ['rev-parse', '--show-toplevel'], live)).text.trim()
      if ((await this.ctx.fs.resolve(top, { signal: live })).targetKey !== (await this.ctx.fs.resolve(root, { signal: live })).targetKey) {
        conflict()
      }
      let reservation = reserved
      if (reservation === undefined) {
        const existing = await this.git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], live, [1])
        if (existing.code === 0 || await this.ctx.fs.lstat(join(root, relativePath), {}, live) !== undefined) conflict()
        const head = await this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], live, [1])
        if (kind === 'task' && head.code !== 0) conflict()
        await this.excludeBookkeeping(root, kind === 'goal' ? '/.dsh/goals/' : '/.dsh/tasks/', live, conflict)
        if (head.code !== 0) {
          await this.git(root, ['add', '-A', '--', '.', ':(top,exclude).dsh'], live)
          await this.git(root, ['-c', `user.name=${this.config.goalGit.baselineName}`,
            '-c', `user.email=${this.config.goalGit.baselineEmail}`, 'commit', '--allow-empty', '--no-verify',
            '-m', 'chore: establish goal baseline'], live)
        }
        let baseRoot = root
        if (integration !== undefined) {
          await this.safeDestination(root, integration.relativePath, live, conflict)
          baseRoot = join(root, integration.relativePath)
          const listing = (await this.git(root, ['worktree', 'list', '--porcelain', '-z'], live)).text
          if (!listing.split('\0\0').some((block) => {
            const fields = block.split('\0')
            return fields.includes(`worktree ${baseRoot}`) && fields.includes(`branch refs/heads/${integration.branch}`)
              && !fields.some(field => field.startsWith('prunable'))
          })) conflict()
          if ((await this.git(baseRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], live, [1])).text.trim() !== integration.branch) conflict()
          if ((await this.git(baseRoot, ['status', '--porcelain=v1', '--untracked-files=all'], live)).text !== '') conflict()
        }
        const baseCommit = (await this.git(baseRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], live)).text.trim()
        const base = await this.git(baseRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], live, [1])
        reservation = gitWorkspaceSchema.parse({ branch, relativePath, baseCommit,
          baseBranch: base.code === 0 ? base.text.trim() : null })
        await save(reservation)
        live.throwIfAborted()
      }
      const worktreePath = join(root, relativePath)
      const listed = (await this.git(root, ['worktree', 'list', '--porcelain', '-z'], live)).text
      const blocks = listed.split('\0\0').filter(Boolean).map(block => block.split('\0'))
      const existing = blocks.find(block => block.includes(`branch refs/heads/${branch}`) || block.includes(`worktree ${worktreePath}`))
      if (existing !== undefined) {
        if (!existing.includes(`worktree ${worktreePath}`) || !existing.includes(`branch refs/heads/${branch}`)
          || !existing.includes(`HEAD ${reservation.baseCommit}`) || existing.some(item => item.startsWith('prunable'))) conflict()
      } else {
        await this.safeDestination(root, relativePath, live, conflict)
        if (await this.ctx.fs.lstat(worktreePath, {}, live) !== undefined) conflict()
        const ref = await this.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], live, [1])
        if (ref.code === 0 && ref.text.trim() !== reservation.baseCommit) conflict()
        await this.git(root, ref.code === 0
          ? ['worktree', 'add', worktreePath, branch]
          : ['worktree', 'add', '--no-track', '-b', branch, worktreePath, reservation.baseCommit], live)
      }
      await this.safeDestination(root, relativePath, live, conflict)
      const actual = (await this.git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'], live)).text.trim()
      const actualBranch = (await this.git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], live)).text.trim()
      if (actual !== reservation.baseCommit || actualBranch !== branch) conflict()
      if (kind === 'task' && (await this.git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], live)).text !== '') conflict()
      return reservation
    })
  }

  /** Join managed Git preparation across projects.
   * @returns after all project Git operations and their child processes settle.
   */
  drain(): Promise<void> { return this.commands.drain() }

  private async safeDestination(root: string, relativePath: string, signal: AbortSignal, conflict: () => never): Promise<void> {
    let path = root
    for (const part of relativePath.split('/')) {
      path = join(path, part)
      const info = await this.ctx.fs.lstat(path, {}, signal)
      if (info !== undefined && info.type !== 'directory') conflict()
    }
  }

  private async excludeBookkeeping(root: string, pattern: string, signal: AbortSignal, conflict: () => never): Promise<void> {
    const name = (await this.git(root, ['rev-parse', '--git-path', 'info/exclude'], signal)).text.trim()
    const path = isAbsolute(name) ? name : join(root, name)
    const pathInfo = await this.ctx.fs.lstat(path, {}, signal)
    if (pathInfo !== undefined && pathInfo.type !== 'file') conflict()
    const target = await this.ctx.fs.resolve(path, { signal })
    const info = await this.ctx.fs.stat(target, signal)
    let content = ''
    if (info !== undefined) {
      const bytes = await this.ctx.fs.readBytes(target, signal, this.config.goalGit.maxOutputBytes)
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
    if (content.split(/\r?\n/).some(line => line.trim() === pattern)) return
    const text = `${content}${content.length > 0 && !content.endsWith('\n') ? '\n' : ''}${pattern}\n`
    if (Buffer.byteLength(text) > this.config.goalGit.maxOutputBytes) throw new Error('Git exclude file exceeds the configured byte limit')
    await this.ctx.fs.writeText(target, text, info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, signal)
  }

  private async git(cwd: string, args: readonly string[], signal: AbortSignal,
    allowed: readonly number[] = []): Promise<{ code: number; text: string }> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.goalGit.executable, undefined, signal)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('Git operation timed out')) }, this.config.goalGit.timeoutMs)
    const live = AbortSignal.any([signal, timeout.signal])
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('GIT_')).map(key => [key, undefined]))
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    env.GIT_OPTIONAL_LOCKS = '0'
    try {
      const handle = this.ctx.subprocess.spawn({ argv: [executable, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'commit.gpgsign=false', '-c', 'protocol.allow=never', ...args], cwd, env, signal: live,
      graceMs: this.config.goalGit.graceMs, stdio: { stdin: 'ignore',
        stdout: { maxBytes: this.config.goalGit.maxOutputBytes }, stderr: { maxBytes: this.config.goalGit.maxOutputBytes } } })
      let outcome
      try { outcome = await handle.done }
      finally { handle.terminate(); await handle.waitForExit() }
      live.throwIfAborted()
      const output = handle.collected.stdout?.readFrom(0)
      const error = handle.collected.stderr?.readFrom(0)
      /* v8 ignore if -- the subprocess Service Definition supplies readers iff the requested streams use collect mode. */
      if (output === undefined || error === undefined) throw new Error('Git subprocess did not collect its configured output streams')
      if (outcome.signal !== null || outcome.exitCode === null || output.lossy || error.lossy) throw new Error('Git operation did not produce a complete result')
      if (outcome.exitCode !== 0 && !allowed.includes(outcome.exitCode)) throw new Error(`Git operation failed (${outcome.exitCode}): ${error.text.trim()}`)
      return { code: outcome.exitCode, text: output.text }
    } finally { clearTimeout(timer) }
  }

}
