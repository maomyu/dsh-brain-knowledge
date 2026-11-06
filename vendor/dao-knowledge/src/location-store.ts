/** Durable project Brain selections and ordered file-operation admission. */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { inspectLocalBrainLocation } from './location.ts'
import { ensureLocalBrain } from './local-brain.ts'
import type { KnowledgeLocation, KnowledgeLocationRevision, KnowledgeLocationSelection, KnowledgeSourceDirectories, KnowledgeSourceRevision } from './types.ts'

interface LocationRecord {
  projectPath: string
  selected: { path: string | null; revision: KnowledgeLocationRevision } | null
  pending: { path: string | null; updatedAt: string } | null
}

const hostPath = z.string().refine(path => isAbsolute(path) && !path.includes('\0'))

interface SourceRecord {
  projectPath: string
  paths: string[]
  revision: KnowledgeSourceRevision
}

/** Source registrations remain separate from released Brain-location records. */
export const knowledgeSourceDomain = defineDomain({ name: 'knowledge_sources', version: 1, tables: {
  projects: domainTable<WorkspaceId, SourceRecord>(z.object({
    projectPath: hostPath,
    paths: z.array(hostPath),
    revision: z.uuid().transform(value => value as KnowledgeSourceRevision),
  })),
} })

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Selection and unfinished initialization publish together in one project record. */
export const knowledgeLocationDomain = defineDomain({ name: 'knowledge_locations', version: 1, tables: {
  projects: domainTable<WorkspaceId, LocationRecord>(z.object({
    projectPath: hostPath,
    selected: z.object({ path: hostPath.nullable(), revision: z.uuid().transform(value => value as KnowledgeLocationRevision) }).nullable(),
    pending: z.object({ path: hostPath.nullable(), updatedAt: z.iso.datetime() }).nullable(),
  })),
} })

/** Controller-owned selections; callers supply their lifecycle signal and own domain disposal. */
export class KnowledgeLocationStore {
  private readonly pending = new Map<WorkspaceId, Promise<unknown>>()

  /**
   * @param table - initialized durable project records.
   * @param fs - Host-shared filesystem for metadata and guarded file publication.
   * @param directory - validated project-relative default Brain directory.
   * @param projectPath - current registered project path; rejects missing registrations.
   * @param sources - durable reference-folder registrations, sharing this store's operation admission.
   * @param maxSourceDirectories - configured number of unique folders allowed per project.
   * @param reserveQuiescentWindow - optional Host process fence held across a changed Brain selection.
   */
  constructor(private readonly table: KvTable<WorkspaceId, LocationRecord>, private readonly fs: FileSystem,
    private readonly directory: string, private readonly projectPath: (id: WorkspaceId) => string,
    private readonly sources: KvTable<WorkspaceId, SourceRecord>, private readonly maxSourceDirectories: number,
    private readonly reserveQuiescentWindow?: () => (() => void) | undefined) {}

  /** Read registered reference paths without probing their contents or granting write access.
   * @param workspaceId - currently registered project.
   * @returns a detached copy with its own committed revision; no record means an empty list.
   * @throws when saved source folders belong to a different project path.
   */
  getSources(workspaceId: WorkspaceId): KnowledgeSourceDirectories {
    const projectPath = this.projectPath(workspaceId)
    const record = this.sources.get(workspaceId)
    if (record !== undefined && record.projectPath !== projectPath) throw new Error('Source folders belong to a different project path')
    return { workspaceId, projectPath, paths: [...record?.paths ?? []], revision: record?.revision ?? null }
  }

  /** Register or remove one source folder without reading, creating, moving or deleting its files.
   * @param workspaceId - registered project owning the references.
   * @param path - absolute Host folder; lexical normalization determines duplicate identity.
   * @param present - true to register, false to remove; repeating the current state performs no write.
   * @param signal - cancels queued operations before storage admission; accepted persistence can finish.
   * @returns the committed project-specific reference paths and their revision.
   * @throws for unsafe paths, capacity, changed project/Brain registration or storage failure.
   */
  async setSource(workspaceId: WorkspaceId, path: string, present: boolean, signal: AbortSignal): Promise<KnowledgeSourceDirectories> {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Source folder must be an absolute Host path without NUL')
    const normalized = resolve(path)
    return this.run(workspaceId, signal, async (location) => {
      const current = this.getSources(workspaceId)
      if (current.paths.includes(normalized) === present) return current
      if (present && current.paths.length >= this.maxSourceDirectories) throw new Error(`Cannot store more than ${this.maxSourceDirectories} extra folders`)
      const paths = present ? [...current.paths, normalized] : current.paths.filter(candidate => candidate !== normalized)
      signal.throwIfAborted()
      this.assertCurrent(location)
      await this.sources.put(workspaceId, { projectPath: current.projectPath, paths, revision: randomUUID() as KnowledgeSourceRevision })
      return this.getSources(workspaceId)
    })
  }

  /** Resolve the committed selection without creating files or persisting default values.
   * @param workspaceId - currently registered project.
   * @returns effective directory and its committed revision; pending initialization remains invisible.
   * @throws when the persisted record belongs to another project path.
   */
  get(workspaceId: WorkspaceId): KnowledgeLocation {
    const projectPath = this.projectPath(workspaceId)
    const record = this.table.get(workspaceId)
    if (record !== undefined && record.projectPath !== projectPath) throw new Error('Brain selection belongs to a different project path')
    const selected = record?.selected
    const directory = selected?.path ?? this.directory
    return { workspaceId, projectPath, directory, path: selected?.path ?? join(projectPath, directory),
      revision: selected?.revision ?? null, isDefault: selected?.path == null }
  }

  /** Refuse a result or write whose project or committed selection changed.
   * @param location - selection captured by this operation.
   * @throws when project registration or its selection no longer matches.
   */
  assertCurrent(location: KnowledgeLocation): void {
    const current = this.get(location.workspaceId)
    if (current.projectPath !== location.projectPath) throw new Error('Project path changed during Brain operation')
    if (current.revision !== location.revision || current.path !== location.path) {
      throw new RemoteError('knowledge/update', 'Brain location changed; refresh before continuing', { path: location.path, reason: 'conflict' })
    }
  }

  /** Serialize file publication and location changes for one project, rejecting stale queued operations.
   * @param workspaceId - project owning the operation.
   * @param signal - cancels before admission; the caller drains admitted work.
   * @param operation - receives the still-current selection after prior operations settle.
   * @returns the admitted operation's result.
   */
  async run<T>(workspaceId: WorkspaceId, signal: AbortSignal, operation: (location: KnowledgeLocation) => Promise<T>): Promise<T> {
    const location = this.get(workspaceId)
    const previous = this.pending.get(workspaceId)
    const pending = (async () => {
      if (previous !== undefined) { try { await previous } catch { /* A failed publication releases admission for the next request. */ } }
      signal.throwIfAborted()
      this.assertCurrent(location)
      return operation(location)
    })()
    this.pending.set(workspaceId, pending)
    try { return await pending } finally { if (this.pending.get(workspaceId) === pending) this.pending.delete(workspaceId) }
  }

  /** Commit a selected local directory after explicit missing-Brain confirmation and non-overwriting initialization.
   * @param workspaceId - registered project whose working directory remains unchanged.
   * @param path - absolute selected path, or null to restore the configured default.
   * @param expectedRevision - revision read by the initiating UI, including null before the first selection.
   * @param initIfEmpty - explicit confirmation permitting initialization of an unrecognized selected directory.
   * @param signal - cancels before final storage admission; admitted persistence can still commit.
   * @returns the committed location or a non-writing confirmation/missing-parent response.
   * @throws for stale selection, source-folder overlap, unsafe paths, changed registration or I/O failure;
   * partial files and retry time are retained.
   */
  async select(workspaceId: WorkspaceId, path: string | null, expectedRevision: KnowledgeLocationRevision | null,
    initIfEmpty: boolean, signal: AbortSignal): Promise<KnowledgeLocationSelection> {
    return this.run(workspaceId, signal, async (current) => {
      if (current.revision !== expectedRevision) throw new RemoteError('knowledge/update', 'Brain selection changed; read its current revision',
        { path: current.path, reason: 'conflict' })
      const authorize = (): void => { signal.throwIfAborted(); this.assertCurrent(current) }
      const requested = path ?? join(current.projectPath, this.directory)
      if (path !== null && isAbsolute(path) && resolve(path) !== current.path) {
        const selectedPath = resolve(path)
        const conflict = this.getSources(workspaceId).paths.find(source =>
          containsPath(source, selectedPath) || containsPath(selectedPath, source))
        if (conflict !== undefined) throw new RemoteError('knowledge/source-overlap', 'Brain directory overlaps a registered extra folder', { path, source: conflict })
      }
      const inspection = await inspectLocalBrainLocation(this.fs, requested, signal, authorize)
      if (dirname(inspection.path) === inspection.path) throw new Error('A filesystem root cannot be a project Brain directory')
      if (path !== null && inspection.state !== 'existing-brain') {
        if (inspection.state === 'missing-parent' || !initIfEmpty) return { ok: false, path: inspection.path, reason: inspection.state }
      }
      const normalized = path === null ? null : inspection.path
      const prior = this.table.get(workspaceId)
      const unchanged = current.revision !== null && current.path === inspection.path && current.isDefault === (normalized === null)
      const release = current.path === inspection.path ? undefined : this.reserveQuiescentWindow?.()
      try {
        const attempt = prior?.pending?.path === normalized ? prior.pending : { path: normalized, updatedAt: new Date().toISOString() }
        authorize()
        await this.table.put(workspaceId, { projectPath: current.projectPath, selected: prior?.selected ?? null, pending: attempt })
        const parent = path === null ? current.projectPath : dirname(inspection.path)
        const parts = path === null ? this.directory.split('/') : [basename(inspection.path)]
        const permission = async (): Promise<void> => {
          authorize()
          if (await realpath(parent) !== parent) throw new Error('Brain parent changed before initialization')
          authorize()
        }
        await ensureLocalBrain(this.fs, parent, parts, attempt.updatedAt, signal, permission)
        authorize()
        const revision = unchanged ? current.revision : randomUUID() as KnowledgeLocationRevision
        await this.table.put(workspaceId, { projectPath: current.projectPath, selected: { path: normalized, revision }, pending: null })
        return { ok: true, location: this.get(workspaceId) }
      } finally {
        release?.()
      }
    })
  }
}
