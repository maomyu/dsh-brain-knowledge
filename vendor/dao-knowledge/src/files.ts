/** Bounded Brain filesystem reads shared by application and independently owned query lifetimes. */
import { createHash } from 'node:crypto'
import { parse, relative } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { parseKnowledgeDocument, ROOT_DOCUMENTS } from './documents.ts'
import type { KnowledgeDocument, KnowledgeDocumentId, KnowledgeIssue, KnowledgeLocation, KnowledgeSearchResult } from './types.ts'

/** Complete-file and scan limits supplied by the owning deployment. */
export interface KnowledgeFilePolicy {
  readonly maxDocumentBytes: number
  readonly maxIndexBytes: number
  readonly maxEntries: number
  readonly maxDepth: number
}

/** Reject empty, linked-path syntax and traversal components.
 * @param path - relative Brain path.
 * @returns path components or an unsafe-path error.
 */
export function relativeSegments(path: string): string[] {
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..') || /[\\:\0]/.test(path)) {
    throw new RemoteError('knowledge/document', 'knowledge path must be relative and contain no links or traversal', { path, reason: 'unsafe-path' })
  }
  return segments
}

/** Recognize provider failures without relying on cross-bundle constructor identity.
 * @param error - failure crossing the filesystem provider.
 * @returns stable filesystem fields, or undefined for another failure.
 */
export function filesystemFailure(error: unknown): { code: string; message: string } | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) return undefined
  if (typeof error.code !== 'string' || !error.code.startsWith('FS_') || typeof error.message !== 'string') return undefined
  return { code: error.code, message: error.message }
}

/** Qualify content hashes with the admitted Brain revision.
 * @param bytes - exact persisted bytes.
 * @param location - current directory selection.
 * @returns the document version used for informed reads and guarded writes.
 */
export function documentVersion(bytes: Uint8Array | string, location: KnowledgeLocation): string {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return location.revision === null ? hash : `${location.revision}:${hash}`
}

/** Read-only filesystem operations; callers own project authorization and publication. */
export class KnowledgeFiles {
  /** @param fs - filesystem provider, shared with the caller's execution world.
   * @param config - complete-file and scan limits.
   * @param authorize - checks the retained project and Brain selection before accepting a scan.
   */
  constructor(private readonly fs: FileSystem, private readonly config: KnowledgeFilePolicy,
    private readonly authorize: (location: KnowledgeLocation) => void) {}

  /** Scan an explicitly admitted location, with bounded bytes, entries and depth.
   * @param location - retained project and Brain selection.
   * @param paths - Brain-relative roots to visit.
   * @param signal - cancels filesystem reads.
   * @param consume - receives complete parsed documents and their exact source.
   * @param malformed - optional parse-warning collector for index rebuilding.
   * @param catalog - optional handler for the authored index source.
   * @returns existence, individual file failures and explicit truncation; authority is rechecked before return.
   */
  async scan(location: KnowledgeLocation, paths: readonly string[], signal: AbortSignal,
    consume: (document: KnowledgeDocument, source: string) => void,
    malformed?: (id: KnowledgeDocumentId, version: string) => void,
    catalog?: (source: string) => void): Promise<Pick<KnowledgeSearchResult, 'exists' | 'issues' | 'truncated'>> {
    const base = await this.base(location, signal)
    this.authorize(location)
    if (base === undefined) return { exists: false, issues: [], truncated: false }
    const issues: KnowledgeIssue[] = []
    let remaining = this.config.maxIndexBytes
    let examined = 0
    let truncated = false
    const visit = async (path: string, depth: number): Promise<void> => {
      signal.throwIfAborted()
      if (examined >= this.config.maxEntries || remaining <= 0 || depth > this.config.maxDepth) {
        truncated = true
        return
      }
      examined++
      try {
        const located = await this.locate(base, path, signal)
        if (located === undefined) return
        if (located.kind === 'directory') {
          if (path === 'index.md' || ROOT_DOCUMENTS.some(root => root === path)) throw new RemoteError('knowledge/document', 'knowledge root is not a file', { path, reason: 'invalid' })
          for (const entry of await this.fs.listDir(located.target, signal)) {
            if (truncated) break
            if (entry.name.endsWith('.md') || entry.type === 'directory') await visit(`${path}/${entry.name}`, depth + 1)
          }
          return
        }
        if (path === 'pages') throw new RemoteError('knowledge/document', 'knowledge pages path is not a directory', { path, reason: 'invalid' })
        const limit = Math.min(remaining, this.config.maxDocumentBytes)
        remaining -= limit
        const result = await this.readLocated(path as KnowledgeDocumentId, located.target, limit, signal)
        remaining += limit - result.bytes.byteLength
        const source = this.decodeText(path as KnowledgeDocumentId, result.bytes)
        if (path === 'index.md' && catalog !== undefined) { catalog(source); return }
        const id = path as KnowledgeDocumentId
        const version = documentVersion(result.bytes, location)
        let document: KnowledgeDocument
        try { document = parseKnowledgeDocument(id, source, version) } catch (error) {
          if (malformed === undefined || remoteErrorOf(error)?.code !== 'knowledge/document') throw error
          malformed(id, version)
          return
        }
        consume(document, source)
      } catch (error) {
        signal.throwIfAborted()
        const failure = remoteErrorOf(error) ?? filesystemFailure(error)
        if (failure === undefined) throw error
        issues.push({ path, message: failure.message })
      }
    }
    for (const path of paths) await visit(path, 0)
    signal.throwIfAborted()
    this.authorize(location)
    return { exists: true, issues, truncated }
  }

  /** Resolve a Brain directory without creating it.
   * @param location - admitted default or explicit Brain path.
   * @param signal - read cancellation.
   * @returns a non-linked directory target, or undefined when absent.
   */
  async base(location: KnowledgeLocation, signal: AbortSignal): Promise<FsTarget | undefined> {
    signal.throwIfAborted()
    const parent = location.isDefault ? location.projectPath : parse(location.path).root
    const mapped = this.fs.processPathFromHostPath(parent)
    if (mapped === undefined) throw new RemoteError('knowledge/document', 'Brain is unavailable in this filesystem', { path: location.directory, reason: 'unsafe-path' })
    const root = await this.fs.resolve(mapped, { signal })
    const located = await this.locate(root, relative(parent, location.path).split('\\').join('/'), signal)
    if (located === undefined) return undefined
    if (located.kind !== 'directory') throw new RemoteError('knowledge/document', 'Brain path is not a directory', { path: location.directory, reason: 'invalid' })
    return located.target
  }

  /** Resolve only regular files/directories below one target.
   * @param root - resolved containing directory.
   * @param path - relative path, without links or traversal.
   * @param signal - metadata-read cancellation.
   * @returns the located target and kind, or undefined for an absent component.
   */
  async locate(root: FsTarget, path: string, signal: AbortSignal): Promise<{ target: FsTarget; kind: 'file' | 'directory' } | undefined> {
    let parent = root
    let kind: 'file' | 'directory' = 'directory'
    const segments = relativeSegments(path)
    for (const [index, segment] of segments.entries()) {
      const cwd = this.fs.processPath(parent)
      const info = await this.fs.lstat(segment, { cwd }, signal)
      if (info === undefined) return undefined
      if (info.type === 'symlink' || info.type === 'other' || (index < segments.length - 1 && info.type !== 'directory')) {
        throw new RemoteError('knowledge/document', 'knowledge path contains a link or unsupported file', { path, reason: 'unsafe-path' })
      }
      const target = await this.fs.resolve(segment, { cwd, signal })
      if (!this.fs.contains(root, target)) throw new RemoteError('knowledge/document', 'knowledge path leaves its project directory', { path, reason: 'unsafe-path' })
      parent = target
      kind = info.type
    }
    return { target: parent, kind }
  }

  /** Read complete bytes while requiring stable filesystem versions.
   * @param id - diagnostic document identity.
   * @param target - resolved file target.
   * @param limit - inclusive complete-file byte allowance.
   * @param signal - read cancellation.
   * @returns bytes and their filesystem version; changed or oversized files reject.
   */
  async readLocated(
    id: KnowledgeDocumentId, target: FsTarget, limit: number, signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; version: FsVersion }> {
    const fs = this.fs
    try {
      const before = await fs.stat(target, signal)
      const bytes = await fs.readBytes(target, signal, limit)
      const after = await fs.stat(target, signal)
      if (before === undefined || after === undefined || before.version !== after.version) {
        throw new RemoteError('knowledge/document', 'knowledge document changed during reading; refresh to retry', { path: id, reason: 'invalid' })
      }
      return { bytes, version: after.version }
    } catch (error) {
      signal.throwIfAborted()
      const failure = filesystemFailure(error)
      if (failure !== undefined) {
        throw new RemoteError('knowledge/document', failure.message, { path: id, reason: failure.code === 'FS_TOO_LARGE' ? 'too-large' : 'invalid' })
      }
      throw error
    }
  }

  /** Decode a complete document without replacing invalid UTF-8.
   * @param id - diagnostic document identity.
   * @param bytes - complete file bytes.
   * @returns decoded text, or rejects invalid byte sequences.
   */
  decodeText(id: KnowledgeDocumentId, bytes: Uint8Array): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
      // Fatal UTF-8 decoding throws only for invalid byte sequences.
      throw new RemoteError('knowledge/document', 'knowledge document is not UTF-8 text', { path: id, reason: 'invalid' })
    }
  }
}
