/** Read-only metadata checks for an explicitly selected local Brain directory. */
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { KnowledgeLocationInspection } from './types.ts'

/**
 * Inspect directory components and fixed Brain markers without following links or reading file bodies.
 * @param fs - provider explicitly sharing each inspected Host path.
 * @param path - user-selected absolute Host directory, never a cwd-derived path.
 * @param signal - cancels metadata requests before their result is returned.
 * @param authorize - rechecks project registration and the operation lifetime around each request.
 * @returns structural observations only; callers must revalidate before initialization or binding writes.
 * @throws for relative paths, links, unsupported files, unavailable Host mapping or filesystem failures.
 */
export async function inspectLocalBrainLocation(fs: FileSystem, path: string, signal: AbortSignal, authorize: () => void):
Promise<Omit<KnowledgeLocationInspection, 'workspaceId'>> {
  if (path.includes('\0') || !isAbsolute(path)) {
    throw new RemoteError('knowledge/document', 'Brain location must be an absolute Host path without NUL', { path, reason: 'unsafe-path' })
  }
  const normalized = resolve(path)
  const root = parse(normalized).root
  const parts = normalized.slice(root.length).split(sep).filter(Boolean)
  const inspect = async (hostPath: string) => {
    authorize()
    signal.throwIfAborted()
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined) {
      throw new RemoteError('knowledge/document', 'Brain location inspection requires a Host-shared filesystem', { path, reason: 'unsafe-path' })
    }
    const info = await fs.lstat(mapped, undefined, signal)
    authorize()
    signal.throwIfAborted()
    if (info?.type === 'symlink' || info?.type === 'other') {
      throw new RemoteError('knowledge/document', 'Brain location contains a link or unsupported file', { path: hostPath, reason: 'unsafe-path' })
    }
    return info
  }
  let current = root
  for (const [index, part] of [root, ...parts].entries()) {
    current = index === 0 ? part : join(current, part)
    const info = await inspect(current)
    if (info === undefined) {
      return { path: normalized, state: index === parts.length ? 'needs-initialization' : 'missing-parent', markers: [] }
    }
    if (info.type !== 'directory') {
      throw new RemoteError('knowledge/document', 'Brain location and its parents must be directories', { path: current, reason: 'invalid' })
    }
  }
  const markers: string[] = []
  for (const marker of ['index.md', 'schema.md', 'pages', 'mindmux.json']) {
    if (await inspect(join(normalized, marker)) !== undefined) markers.push(marker)
  }
  return { path: normalized, state: markers.length > 0 ? 'existing-brain' : 'needs-initialization', markers }
}
