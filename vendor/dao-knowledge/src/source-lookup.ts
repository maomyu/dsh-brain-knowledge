/** Read-only source operations over Host-shared filesystem targets and captured project registrations. */
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Script } from 'node:vm'
import type { FileSystem, FsTarget, FsInfo } from '@deepseek-ai/dsh-fs'
import type { SourcePolicy } from './source-policy.ts'

/** Captured authority; the caller owns lifetime, registration revision and final result admission. */
export interface SourceLookupOptions {
  fs: FileSystem
  projectPath: string
  brainPath: string
  paths: readonly string[]
  policy: SourcePolicy
  signal: AbortSignal
  /** Recheck the current conversation and registered project/source identities; throws on withdrawal. */
  authorize(this: void): void
}

interface LocatedSource { path: string; target: FsTarget }
interface SourceMount extends LocatedSource { alias: string }
interface WalkState { files: number; entries: number; truncated: boolean }
interface SourceLookup {
  read(path: string, range?: { start: number; end: number }): Promise<string>
  list(path: string, glob?: string): Promise<string>
  search(path: string, pattern: string, regex: boolean, caseSensitive: boolean): Promise<string>
}

const regexLines = new Script('const expression = new RegExp(pattern, flags); lines.map(line => expression.test(line))')
const contains = (parent: string, path: string): boolean => {
  const part = relative(parent, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
const slash = (path: string): string => path.split(sep).join('/')

// This glob language requires the slash in **/ and treats brackets, braces and parentheses literally.
// Dynamic programming preserves that language without recursive wildcard backtracking.
const sourceGlob = (pattern: string): ((path: string) => boolean) => {
  // list calls this only with a nonempty glob, and the second arm matches every UTF-16 unit.
  const tokens = pattern.match(/\*\*|[\s\S]/g) as RegExpMatchArray
  return (path) => {
    let previous = new Uint8Array(path.length + 1)
    previous[0] = 1
    for (const token of tokens) {
      const star = token === '*' || token === '**'
      const next = new Uint8Array(path.length + 1)
      next[0] = Number(star && previous[0] === 1)
      for (let index = 1; index <= path.length; index++) {
        const character = path.charAt(index - 1)
        const matches = token === '**' ? !/[\r\n\u2028\u2029]/.test(character)
          : star || token === '?' ? character !== '/' : character === token
        next[index] = Number(star ? previous[index] === 1 || (matches && next[index - 1] === 1) : matches && previous[index - 1] === 1)
      }
      previous = next
    }
    return previous[path.length] === 1
  }
}
const sourceSize = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

/** Resolve currently available source mounts without changing source files or write policy.
 * @param options - captured project paths, read provider, limits and caller-owned authorization.
 * @returns source operations that reject observed escapes, changed targets and cancellation.
 */
export async function createSourceLookup(options: SourceLookupOptions): Promise<SourceLookup> {
  const { fs, projectPath, brainPath, policy, signal, authorize } = options
  const checkpoint = (): void => { signal.throwIfAborted(); authorize() }
  const hostTarget = async (path: string): Promise<FsTarget> => {
    checkpoint()
    const mapped = fs.processPathFromHostPath(path)
    if (mapped === undefined) throw new Error('Source folder is unavailable in this filesystem')
    const target = await fs.resolve(mapped, { signal })
    checkpoint()
    return target
  }
  const project = await hostTarget(projectPath)
  if ((await fs.stat(project, signal))?.type !== 'directory') throw new Error('Registered project directory is unavailable')
  const brain = await hostTarget(brainPath)
  const conventionalBrain = await hostTarget(join(projectPath, 'brain'))
  const application = await hostTarget(join(projectPath, '.mindmux'))
  const skillData = await hostTarget(join(projectPath, '.mindmux/skill-data'))
  const mounts: SourceMount[] = []
  for (const path of options.paths) {
    const target = await hostTarget(path)
    if ((await fs.stat(target, signal))?.type === 'directory') mounts.push({ path, target, alias: `@${basename(path)}` })
  }
  const protectedPath = (path: string, target: FsTarget, recursive = false): boolean => {
    if (contains(brainPath, path) || contains(join(projectPath, 'brain'), path)
      || fs.contains(brain, target) || fs.contains(conventionalBrain, target)) return true
    const inApplication = contains(join(projectPath, '.mindmux'), path) || fs.contains(application, target)
    return inApplication && (recursive || !contains(join(projectPath, '.mindmux/skill-data'), path) || !fs.contains(skillData, target))
  }
  const permitted = (path: string, target: FsTarget): boolean => !protectedPath(path, target)
    && (contains(projectPath, path) || mounts.some(mount => contains(mount.path, path)))
    && (fs.contains(project, target) || mounts.some(mount => fs.contains(mount.target, target)))
  const locate = async (request: string): Promise<LocatedSource> => {
    const input = request.trim()
    if (!input || input.includes('\0')) throw new Error('Source path must be nonempty and contain no NUL')
    let path: string
    let mount: SourceMount | undefined
    if (input.startsWith('@')) {
      const [alias, ...parts] = input.split(/[\\/]/)
      mount = mounts.find(candidate => candidate.alias === alias)
      if (mount === undefined) throw new Error(`Unknown or unavailable source mount: ${alias}`)
      path = resolve(mount.path, ...parts)
      if (!contains(mount.path, path)) throw new Error('Source path leaves its mount')
    } else {
      const expanded = input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
      path = resolve(projectPath, expanded)
    }
    const target = await hostTarget(path)
    if (!permitted(path, target) || (mount !== undefined && !fs.contains(mount.target, target))) {
      throw new Error('Source path is outside permitted folders or inside protected Brain/application data')
    }
    return { path, target }
  }
  const unchanged = async (source: LocatedSource, before?: FsInfo): Promise<void> => {
    if ((await hostTarget(source.path)).targetKey !== source.target.targetKey) throw new Error('Source path changed during lookup; retry')
    if (before !== undefined && (await fs.stat(source.target, signal))?.version !== before.version) {
      throw new Error('Source file changed during lookup; retry')
    }
    checkpoint()
  }
  const finish = async (source: LocatedSource, text: string): Promise<string> => {
    for (const root of [{ path: projectPath, target: project }, { path: brainPath, target: brain },
      { path: join(projectPath, 'brain'), target: conventionalBrain }, { path: join(projectPath, '.mindmux'), target: application },
      { path: join(projectPath, '.mindmux/skill-data'), target: skillData }, ...mounts]) {
      if ((await hostTarget(root.path)).targetKey !== root.target.targetKey) throw new Error('Source root changed during lookup; retry')
    }
    await unchanged(source)
    return text
  }
  const fileInfo = async (source: LocatedSource): Promise<FsInfo> => {
    checkpoint()
    const info = await fs.stat(source.target, signal)
    if (info?.type !== 'file') throw new Error('Source path is not an available regular file')
    return info
  }
  const label = (source: LocatedSource): string => slash(relative(projectPath, source.path)) || source.path
  const numbered = (source: LocatedSource, lines: string[], start: number, end: number, total: string): string =>
    `# ${label(source)}  (lines ${start}-${end} of ${total})\n`
    + lines.map((line, index) => `${String(start + index).padStart(String(end).length, ' ')}  | ${line}`).join('\n')

  async function* streamLines(source: LocatedSource): AsyncGenerator<string> {
    const decoder = new TextDecoder('utf-8')
    let offset = 0, pending = ''
    while (true) {
      checkpoint()
      const length = Math.min(policy.chunkBytes, policy.maxFileBytes - offset + 1)
      const bytes = await fs.readByteRange(source.target, { offset, length }, signal)
      offset += bytes.length
      if (offset > policy.maxFileBytes) throw new Error('Source file exceeds maxFileBytes')
      pending += decoder.decode(bytes, { stream: bytes.length > 0 })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        yield line.endsWith('\r') ? line.slice(0, -1) : line
      }
      if (bytes.length === 0) break
    }
    if (pending) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending
  }

  const read = async (path: string, range?: { start: number; end: number }): Promise<string> => {
    const source = await locate(path)
    const info = await fileInfo(source)
    if (range !== undefined && range.end < range.start) throw new Error('range.end must be >= range.start')
    if (info.size !== undefined && info.size > policy.maxFileBytes) throw new Error('Source file exceeds maxFileBytes')
    let text: string
    if (info.size === undefined || info.size > policy.streamThresholdBytes) {
      if (range === undefined) throw new Error('Large source file requires an explicit line range')
      if (range.end - range.start + 1 > policy.maxReadLines) throw new Error('Source range exceeds maxReadLines')
      const lines: string[] = []
      let lineNumber = 0, more = false
      for await (const line of streamLines(source)) {
        lineNumber++
        if (lineNumber > range.end) { more = true; break }
        if (lineNumber >= range.start) lines.push(line)
      }
      if (!lines.length) throw new Error(`Range starts past EOF: file has ${lineNumber} lines`)
      const end = range.start + lines.length - 1
      text = numbered(source, lines, range.start, end, more ? `${end}+` : String(lineNumber))
    } else {
      const raw = await fs.readBytes(source.target, signal, policy.maxFileBytes)
      const lines = new TextDecoder('utf-8').decode(raw).split('\n')
      if (range === undefined && lines.length > policy.maxReadLines) throw new Error('Source file requires an explicit line range')
      const start = range?.start ?? 1, end = Math.min(range?.end ?? lines.length, lines.length)
      text = numbered(source, lines.slice(start - 1, end), start, end, String(lines.length))
    }
    await unchanged(source, info)
    return finish(source, text)
  }

  async function* walk(root: LocatedSource, state: WalkState): AsyncGenerator<LocatedSource> {
    const pending = [{ source: root, depth: 0 }]
    for (const current of pending) {
      checkpoint()
      await unchanged(current.source)
      for (const entry of await fs.listDir(current.source.target, signal)) {
        checkpoint()
        if (state.files >= policy.maxWalkFiles || state.entries >= policy.maxWalkEntries) { state.truncated = true; return }
        state.entries++
        const path = join(current.source.path, entry.name)
        const mapped = fs.processPathFromHostPath(path)
        if (mapped === undefined) throw new Error('Source path is unavailable in this filesystem')
        const info = await fs.lstat(mapped, {}, signal)
        if (info === undefined || info.type === 'symlink' || info.type === 'other') continue
        const target = await hostTarget(path)
        if (protectedPath(path, target, true)) continue
        if (!permitted(path, target) || !fs.contains(root.target, target)) throw new Error('Source traversal escaped its selected folder')
        if (info.type === 'directory') {
          if (current.depth >= policy.maxDepth) state.truncated = true
          else pending.push({ source: { path, target }, depth: current.depth + 1 })
        } else { state.files++; yield { path, target } }
      }
      await unchanged(current.source)
    }
  }

  const list = async (path: string, glob?: string): Promise<string> => {
    const source = await locate(path)
    const entries: { name: string; display: string; directory: boolean }[] = []
    let truncated = false
    let walked = 0
    if (glob) {
      const match = sourceGlob(glob)
      const state: WalkState = { files: 0, entries: 0, truncated: false }
      for await (const file of walk(source, state)) {
        const name = slash(relative(source.path, file.path))
        if (!match(name)) continue
        const info = await fileInfo(file)
        entries.push({ name, display: `${name}  ${sourceSize(info.size ?? 0)}`, directory: false })
        if (entries.length >= policy.maxEntries) { truncated = true; break }
      }
      walked = state.files
      truncated ||= state.truncated
    } else {
      for (const entry of await fs.listDir(source.target, signal)) {
        checkpoint()
        if (entries.length >= policy.maxEntries) { truncated = true; break }
        const mapped = fs.processPathFromHostPath(join(source.path, entry.name))
        if (mapped === undefined) throw new Error('Source path is unavailable in this filesystem')
        const info = await fs.lstat(mapped, {}, signal)
        const directory = info?.type === 'directory'
        const display = directory ? `[D] ${entry.name}/` : info?.type === 'file'
          ? `[F] ${entry.name}  ${sourceSize(info.size ?? 0)}` : `[?] ${entry.name}`
        entries.push({ name: entry.name, display, directory })
      }
      if (source.target.targetKey === project.targetKey) {
        entries.push(...mounts.map(mount => ({ name: mount.alias,
          display: `[E] ${mount.alias}/  (extra folder → ${mount.path})`, directory: true })))
      }
    }
    checkpoint()
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    const count = `${entries.length}${truncated ? '+' : ''}`
    const heading = glob ? `# glob "${glob}" under ${label(source)}/  (${count} match${entries.length === 1 ? '' : 'es'}, ${walked} files walked)`
      : `# ${label(source)}/  (${count} entries)`
    const body = entries.slice(0, policy.maxEntries).map(entry => entry.display).join('\n') || (glob ? '(no matches)' : '')
    const text = `${heading}\n${body}`
      + (truncated ? '\n[truncated: narrow the path or glob]' : '')
    return finish(source, text)
  }

  const search = async (path: string, pattern: string, regex: boolean, caseSensitive: boolean): Promise<string> => {
    const source = await locate(path)
    const info = await fs.stat(source.target, signal)
    if (info === undefined || info.type === 'other') throw new Error('Search path must be an available file or directory')
    const state: WalkState = { files: 0, entries: 0, truncated: false }
    const hits: string[] = []
    let scanned = 0, skipped = 0, limited = false
    const flags = caseSensitive ? '' : 'i'
    const literal = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    // Compile before traversal, including empty directories; only data enters the timed script.
    if (regex) regexLines.runInNewContext({ pattern, flags, lines: [] }, { timeout: policy.regexTimeoutMs })
    const files = info.type === 'file' ? [source] : walk(source, state)
    for await (const file of files) {
      checkpoint()
      const before = await fileInfo(file)
      if (before.size !== undefined && before.size > policy.maxSearchFileBytes) { skipped++; continue }
      const bytes = await fs.readBytes(file.target, signal, policy.maxSearchFileBytes)
      await unchanged(file, before)
      const raw = new TextDecoder('utf-8').decode(bytes)
      if (raw.slice(0, 4096).includes('\0')) { skipped++; continue }
      scanned++
      const lines = raw.split('\n')
      const matches = regex ? regexLines.runInNewContext({ pattern, flags, lines },
        { timeout: policy.regexTimeoutMs, contextCodeGeneration: { strings: false, wasm: false } }) as boolean[]
        : lines.map(line => literal.test(line))
      let perFile = 0
      for (const [index, line] of lines.entries()) {
        if (!matches[index]) continue
        if (perFile >= policy.maxMatchesPerFile) { limited = true; break }
        if (hits.length >= policy.maxMatches) { limited = true; break }
        const display = line.length > policy.maxLineCharacters ? `${line.slice(0, policy.maxLineCharacters - 3)}…` : line
        const pathLabel = info.type === 'file' ? label(file) : slash(relative(source.path, file.path))
        hits.push(`${pathLabel}:${index + 1}:${display}`)
        perFile++
      }
      if (hits.length >= policy.maxMatches) { limited = true; break }
    }
    checkpoint()
    const scope = info.type === 'file' ? `in ${label(source)}` : `under ${label(source)}/`
    const count = `${hits.length}${limited || state.truncated ? '+' : ''} hit${hits.length === 1 ? '' : 's'}`
    const text = `# search ${regex ? 'regex ' : ''}"${pattern}" ${scope}  (${count} in ${scanned} file${scanned === 1 ? '' : 's'}, `
      + `${info.type === 'file' ? 1 : state.files} walked)\n${hits.join('\n') || '(no matches)'}`
      + (!regex && !hits.length && /[|()[\]{}+?*^$\\]/.test(pattern)
        ? '\nhint: pattern contains regex metacharacters but regex:false — did you mean regex:true?' : '')
      + (limited || state.truncated || skipped > 0 ? `\n[partial results: search limits or skipped files; skipped ${skipped}]` : '')
    return finish(source, text)
  }
  checkpoint()
  return { read, list, search }
}
