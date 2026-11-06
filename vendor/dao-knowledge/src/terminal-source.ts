/** Filesystem-backed task queries with no application registry, database or model dependency. */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { KnowledgeFiles, documentVersion, relativeSegments, type KnowledgeFilePolicy } from './files.ts'
import { ROOT_DOCUMENTS, parseKnowledgeDocument } from './documents.ts'
import { collectKnowledgeMatches } from './search.ts'
import type { NativeKnowledgeSource } from './native-task.ts'
import type { KnowledgeAccess, KnowledgeEntry, KnowledgeLocation } from './types.ts'

/** Bind an independently owned terminal to its explicitly accepted Brain location.
 * @param fs - provider with access to the accepted local directory.
 * @param location - retained original project and Brain identity, not the terminal cwd.
 * @param config - complete-file and scan limits.
 * @param current - caller-owned cancellation validation; the terminal consumer checks its live Host grant around each query.
 * @param recordAccess - durable access acknowledgement owned by the terminal audit.
 * @returns read-only source operations; no directory creation, knowledge update or application database access.
 */
export function terminalKnowledgeSource(fs: FileSystem, location: KnowledgeLocation, config: KnowledgeFilePolicy,
  current: (signal: AbortSignal) => void, recordAccess: (access: KnowledgeAccess) => Promise<void>): NativeKnowledgeSource {
  const files = new KnowledgeFiles(fs, config, () => {})
  return { project: { id: location.workspaceId, path: location.projectPath }, location, current, recordAccess,
    async index(signal) {
      current(signal)
      const entries: KnowledgeEntry[] = []
      const scan = await files.scan(location, ['index.md', ...ROOT_DOCUMENTS, 'pages'], signal,
        (document) => { entries.push(document.entry) }, undefined, () => {})
      current(signal)
      return { ...scan, entries }
    },
    async read(path, signal) {
      current(signal)
      relativeSegments(path)
      if (!ROOT_DOCUMENTS.some(root => root === path) && !(path.startsWith('pages/') && path.endsWith('.md'))) {
        throw new RemoteError('knowledge/document', 'path is not a knowledge root or page', { path, reason: 'unsafe-path' })
      }
      const base = await files.base(location, signal)
      const found = base === undefined ? undefined : await files.locate(base, path, signal)
      if (found?.kind === 'file') {
        const content = await files.readLocated(path, found.target, config.maxDocumentBytes, signal)
        const document = parseKnowledgeDocument(path, files.decodeText(path, content.bytes), documentVersion(content.bytes, location))
        current(signal)
        return document
      }
      throw new RemoteError('knowledge/document', 'knowledge document does not exist', { path, reason: 'not-found' })
    },
    async search(request, signal) {
      current(signal)
      const matches = collectKnowledgeMatches(request)
      const scan = await files.scan(location, ['pages'], signal, (document, source) => { matches.add(source, document.entry) })
      current(signal)
      return { ...scan, hits: matches.hits, truncated: scan.truncated || matches.omitted() }
    },
  }
}
