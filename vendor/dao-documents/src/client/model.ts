/** Own project preparation generations and retain accepted bytes outside metadata snapshots. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-document-import-controller/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DocumentImportFormat } from '../types.ts'
import type {
  DocumentImportDraftEntry, DocumentImportDraftFailure, DocumentImportDraftSnapshot, DocumentImportSelectionLimits,
  DocumentImportSource, DocumentImportSourceId, IDocumentImportDrafts, PreparedDocumentImport,
} from './contract.ts'

/** Generated namespace used by the preparation model. */
export type DocumentImportRemote = Pick<ClientRemote['documentImports'], 'prepare'>

interface Candidate {
  row: DocumentImportDraftEntry & { readonly sourceFormat: DocumentImportFormat | null }
  readonly request: AbortController
  prepared?: PreparedDocumentImport
}
interface Batch { readonly request: AbortController; readonly done: Promise<void> }
interface Project { readonly entries: Map<DocumentImportSourceId, Candidate>; batch?: Batch }

/** Per-project preparation remains valid when navigation changes, and ends on explicit release or unload. */
export class ClientDocumentImportDrafts implements IDocumentImportDrafts {
  readonly state = createSnapshotStore<DocumentImportDraftSnapshot>({ projects: [] })
  private readonly projects = new Map<WorkspaceId, Project>()
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  /** @param remote - generated, cancellable document preparation namespace. */
  constructor(private readonly remote: DocumentImportRemote) {}

  prepare(workspaceId: WorkspaceId, sources: readonly DocumentImportSource[], limits: DocumentImportSelectionLimits): Promise<boolean> {
    if (this.disposed || this.projects.get(workspaceId)?.batch !== undefined) return Promise.resolve(false)
    if (sources.length === 0) return Promise.resolve(true)
    const project = this.projects.get(workspaceId) ?? { entries: new Map<DocumentImportSourceId, Candidate>() }
    this.projects.set(workspaceId, project)
    const selection = new Map(sources.map(source => [source.id, { ...source }]))
    const candidates = [...selection.values()].map((source) => {
      const candidate: Candidate = { row: { id: source.id, name: source.name, size: source.size, sourceFormat: source.format, status: 'queued' }, request: new AbortController() }
      project.entries.set(source.id, candidate)
      return { source, candidate }
    })
    const request = new AbortController()
    const resolvedLimits = { ...limits }
    const done = Promise.resolve().then(async () => {
      let readyCount = resolvedLimits.readyScope === 'project'
        ? [...project.entries.values()].filter(entry => entry.row.status === 'ready').length : 0
      for (const { source, candidate } of candidates) {
        if (project.entries.get(source.id) !== candidate) continue
        const signal = AbortSignal.any([request.signal, candidate.request.signal])
        if (signal.aborted) this.reject(candidate, 'cancelled')
        else if (source.size > resolvedLimits.maxSourceBytes) this.reject(candidate, 'too-large')
        else if (readyCount >= resolvedLimits.maxReady) this.reject(candidate, 'too-many')
        else if (source.format === null) this.reject(candidate, 'unsupported')
        else {
          await this.convert(workspaceId, { ...source, format: source.format }, candidate, signal)
          if (candidate.row.status === 'ready' && project.entries.get(source.id) === candidate) readyCount++
        }
        if (this.projects.get(workspaceId) === project) this.publish()
      }
    }).finally(() => {
      delete project.batch
      this.pending.delete(done)
      if (this.projects.get(workspaceId) === project) this.publish()
    })
    project.batch = { request, done }
    this.pending.add(done)
    this.publish()
    return done.then(() => true)
  }

  remove(workspaceId: WorkspaceId, sourceId: DocumentImportSourceId): void {
    const entries = this.projects.get(workspaceId)?.entries
    const candidate = entries?.get(sourceId)
    if (candidate === undefined) return
    entries?.delete(sourceId)
    candidate.request.abort()
    this.publish()
  }

  async cancel(workspaceId: WorkspaceId): Promise<void> {
    const batch = this.projects.get(workspaceId)?.batch
    batch?.request.abort()
    await batch?.done
  }

  prepared(workspaceId: WorkspaceId): readonly PreparedDocumentImport[] | null {
    const project = this.projects.get(workspaceId)
    if (project?.batch !== undefined) return null
    return [...(project?.entries.values() ?? [])].flatMap(candidate => candidate.prepared === undefined ? []
      : [{ id: candidate.prepared.id, source: { ...candidate.prepared.source }, output: structuredClone(candidate.prepared.output) }])
  }

  async forget(workspaceId: WorkspaceId): Promise<void> {
    const project = this.projects.get(workspaceId)
    if (project === undefined) return
    this.projects.delete(workspaceId)
    project.batch?.request.abort()
    this.publish()
    await project.batch?.done
    project.entries.clear()
  }

  /**
   * Stop publishing before cancelling, release retained bytes, and join all outstanding work.
   * @returns after readers and Host conversions settle; captured submission values remain caller-owned.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const project of this.projects.values()) project.batch?.request.abort()
    this.projects.clear()
    this.state.set({ projects: [] })
    await Promise.allSettled(this.pending)
  }

  private async convert(
    workspaceId: WorkspaceId, source: DocumentImportSource & { format: DocumentImportFormat }, candidate: Candidate, signal: AbortSignal,
  ): Promise<void> {
    const isCancelled = (): boolean => signal.aborted
    candidate.row = { ...candidate.row, status: 'reading' }
    this.publish()
    if (isCancelled()) { this.reject(candidate, 'cancelled'); return }
    let dataBase64: string
    try { dataBase64 = await source.read(signal) } catch {
      this.reject(candidate, isCancelled() ? 'cancelled' : 'read-failed')
      return
    }
    if (isCancelled()) { this.reject(candidate, 'cancelled'); return }
    candidate.row = { ...candidate.row, status: 'preparing' }
    this.publish()
    if (isCancelled()) { this.reject(candidate, 'cancelled'); return }
    const input = { name: source.name, format: source.format, dataBase64 }
    try {
      const result = await this.remote.prepare(workspaceId, input, signal)
      if (isCancelled()) { this.reject(candidate, 'cancelled'); return }
      if (!result.ok) { this.reject(candidate, 'remote-failed'); return }
      if (result.value.status === 'rejected') { this.reject(candidate, result.value.reason); return }
      candidate.prepared = { id: source.id, source: input, output: structuredClone(result.value) }
      candidate.row = { id: source.id, name: source.name, size: source.size, sourceFormat: source.format, status: 'ready',
        outputName: result.value.name, textBytes: result.value.textBytes,
        ...result.value.extraction === undefined ? {} : { extraction: structuredClone(result.value.extraction) } }
    } catch { this.reject(candidate, isCancelled() ? 'cancelled' : 'remote-failed') }
  }

  private reject(candidate: Candidate, reason: DocumentImportDraftFailure): void {
    candidate.row = { id: candidate.row.id, name: candidate.row.name, size: candidate.row.size,
      sourceFormat: candidate.row.sourceFormat, status: 'rejected', reason }
  }

  private publish(): void {
    this.state.set({ projects: [...this.projects].map(([workspaceId, project]) => ({
      workspaceId, busy: project.batch !== undefined, entries: [...project.entries.values()].map(candidate => candidate.row),
    })) })
  }
}
