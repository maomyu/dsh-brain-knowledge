/** Bounded, read-only implementation evidence for a project knowledge assessment. */
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-fs'

/** Deployment limits for code discovery, matching and Git collection. */
export interface HealthCodePolicy {
  /** Git executable in the subprocess provider's execution world. */
  readonly gitExecutable: string
  /** Maximum recent commits included from the selected repository. */
  readonly maxCommits: number
  /** Maximum directory entries examined, including excluded candidates. */
  readonly maxEntries: number
  /** Maximum source files read for literal term matching. */
  readonly maxFiles: number
  /** Maximum nested directory depth below the project root. */
  readonly maxDepth: number
  /** Inclusive bytes per complete source file; larger files are skipped explicitly. */
  readonly maxFileBytes: number
  /** Inclusive UTF-8 allowance for complete implementation evidence JSON. */
  readonly maxEvidenceBytes: number
  /** Maximum distinct knowledge terms used for literal source matching. */
  readonly maxTerms: number
  /** Maximum matching source lines retained in the sample. */
  readonly maxMatches: number
  /** In-memory bytes collected separately from each Git output stream. */
  readonly commandBytes: number
  /** Subprocess termination and pipe-draining grace in milliseconds. */
  readonly graceMs: number
}

const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.go', '.py', '.java', '.kt', '.swift', '.css', '.scss', '.html', '.md', '.json', '.toml', '.yaml', '.yml'])
const excluded = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor'])
const sensitive = /(?:credential|secret|private[-_]?key|token|\.pem$|\.key$)/i

/** Collect a labeled, possibly partial sample without following project links or reading hidden/credential files.
 * @param ctx - filesystem and optional subprocess providers in the same execution world.
 * @param projectPath - registered project directory, never the process cwd fallback.
 * @param knowledgeDirectory - project-relative Brain directory excluded from implementation scanning.
 * @param knowledgeText - selected knowledge used only to choose literal search terms.
 * @param since - prior report timestamp for Git history, when available.
 * @param policy - complete scan and output bounds.
 * @param signal - cancels filesystem reads and drains any admitted Git command.
 * @returns JSON evidence with explicit sampling limits; absence of matches does not prove consistency.
 */
export async function collectHealthCodeEvidence(ctx: Context, projectPath: string, knowledgeDirectory: string,
  knowledgeText: string, since: string | undefined, policy: HealthCodePolicy, signal: AbortSignal): Promise<string> {
  const root = await ctx.fs.resolve(projectPath, { signal })
  const cwd = ctx.fs.processPath(root)
  const terms = [...new Set(knowledgeText.match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, policy.maxTerms)
  const evidence = { terms, git: [] as { command: string; exitCode: number | null; output: string; truncated: boolean }[],
    matches: [] as string[], scannedFiles: 0, scannedEntries: 0, partial: false, notes: [] as string[] }
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(evidence)) <= policy.maxEvidenceBytes
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('Implementation checking requires the subprocess provider')
  // Disable optional locks and executable Git diff/fsmonitor integrations for these read-only commands.
  const commands = [
    ['rev-parse', '--show-toplevel'],
    ['status', '--short', '--untracked-files=no'],
    ['log', `--max-count=${policy.maxCommits}`, ...(since === undefined ? [] : [`--since=${since}`]), '--format=%h %cI %s'],
    ['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD', '--'],
  ]
  for (const args of commands) {
    signal.throwIfAborted()
    const handle = subprocess.spawn({ argv: [policy.gitExecutable, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: policy.commandBytes }, stderr: { maxBytes: policy.commandBytes } },
      env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_CONFIG_COUNT: undefined,
        GIT_CONFIG_PARAMETERS: undefined, GIT_PAGER: '', GIT_TERMINAL_PROMPT: '0' }, graceMs: policy.graceMs, signal })
    try {
      const result = await handle.done
      signal.throwIfAborted()
      // Both requested collect-mode streams retain their readers after command settlement.
      const stdout = (handle.collected.stdout as SubprocessOutputReader).readFrom(0)
      const stderr = (handle.collected.stderr as SubprocessOutputReader).readFrom(0)
      if (args[0] === 'rev-parse') {
        if (result.exitCode !== 0 || stdout.lossy || stdout.text.trim() !== cwd) {
          evidence.notes.push('Git history omitted: the selected folder is not the root of an available Git repository.')
          break
        }
        continue
      }
      evidence.git.push({ command: args.join(' '), exitCode: result.exitCode,
        output: stdout.text + stderr.text, truncated: stdout.lossy || stderr.lossy })
      if (!fits()) throw new Error('Git evidence exceeds maxEvidenceBytes; increase the allowance or disable implementation checking')
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
  const scan = async (relative: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (depth > policy.maxDepth) { evidence.partial = true; return }
    const target = await ctx.fs.resolve(relative || '.', { cwd, signal })
    if (!ctx.fs.contains(root, target)) throw new Error('Code directory escaped the registered project')
    for (const entry of (await ctx.fs.listDir(target, signal)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (evidence.scannedEntries >= policy.maxEntries || evidence.scannedFiles >= policy.maxFiles
        || evidence.matches.length >= policy.maxMatches) {
        evidence.partial = true
        return
      }
      evidence.scannedEntries++
      if (entry.name.startsWith('.') || sensitive.test(entry.name) || excluded.has(entry.name)) continue
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (path === knowledgeDirectory) continue
      const info = await ctx.fs.lstat(path, { cwd }, signal)
      if (info === undefined || info.type === 'symlink' || info.type === 'other') continue
      const file = await ctx.fs.resolve(path, { cwd, signal })
      if (!ctx.fs.contains(root, file)) throw new Error('Code path escaped the registered project')
      if (info.type === 'directory') { await scan(path, depth + 1); continue }
      if (!extensions.has(extname(path))) continue
      if (info.size === undefined || info.size > policy.maxFileBytes) { evidence.partial = true; continue }
      let text = ''
      for await (const chunk of await ctx.fs.streamText(file, signal)) {
        text += chunk
        if (Buffer.byteLength(text) > policy.maxFileBytes) throw new Error('Code file grew beyond maxFileBytes during capture')
      }
      if ((await ctx.fs.stat(file, signal))?.version !== info.version) throw new Error('Code file changed during capture; run the check again')
      evidence.scannedFiles++
      for (const [line, value] of text.split('\n').entries()) {
        if (!terms.some(term => value.includes(term))) continue
        evidence.matches.push(`${path}:${line + 1}: ${value}`)
        if (!fits()) { evidence.matches.pop(); evidence.partial = true; return }
        if (evidence.matches.length >= policy.maxMatches) { evidence.partial = true; return }
      }
    }
  }
  await scan('', 0)
  evidence.notes.push('Code matches are a bounded sample, not a complete repository audit. Hidden files, credential-like names, dependencies, build outputs and Brain are excluded.')
  if (!fits()) throw new Error('Code evidence metadata exceeds maxEvidenceBytes')
  return JSON.stringify(evidence)
}
