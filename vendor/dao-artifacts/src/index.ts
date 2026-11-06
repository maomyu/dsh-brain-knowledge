/** Read project artifacts and publish source-owned reports without creating or executing a Session. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { canOpenNativePath, canRevealNativePath, openNativePath, revealNativePath, openNativeWebUrl } from '@deepseek-ai/dsh-native-command'
import { ArtifactSiteManager } from './site-manager.ts'
import { publishDocumentationDirectory, type DirectoryPublicationConfig } from './directory-publication.ts'
import { siteConfig } from './site-config.ts'
import type { ArtifactSiteConfig } from './site-run.ts'
import { readTaskDirectoryTree, TaskDirectoryReadError, type TaskDirectoryReadLimits } from './task-directory-read.ts'
import { artifactCandidate, artifactTypes, groupArtifacts, manifestName, readManifest, renditionId, safeSegment } from './catalog.ts'
import type { ArtifactCandidate, ArtifactRecord } from './catalog.ts'
import type { ArtifactFile, ArtifactFileActions, ArtifactIndex, ArtifactIssue, ArtifactNativeAction, ArtifactRenditionId, ArtifactType } from './types.ts'
import type { ArtifactPreviewId, ArtifactPreviewRef, ArtifactPreviewFile, ArtifactTaskId, ArtifactTaskDirectory,
  ArtifactTaskDirectoryFile, ArtifactTaskDirectoryListing, ArtifactSiteAction, ArtifactSiteId } from './types.ts'
import type { ArtifactDelivery, ArtifactDeliveryFile, ArtifactDeliveryId, ArtifactDeliveryIndex } from './types.ts'
import { deliveryIdentity, deliverySources, type DeliverySource } from './delivery-source.ts'

export type * from './types.ts'

/** Inclusive durable Session read limits for ordinary-conversation files. */
export interface DeliveryReadLimits {
  /** Maximum registered Project Sessions examined in one observation. */
  readonly maxSessions: number
  /** Maximum durable events examined per Session. */
  readonly maxEvents: number
  /** Inclusive stored size, when available, and decoded event byte cap per Session. */
  readonly maxSessionBytes: number
  /** Inclusive decoded event byte budget per observation; failed reads consume their allowance. */
  readonly maxLogBytes: number
}

/** Project-relative artifact storage and read/scan bounds. */
export interface Config {
  /** Permit native application handoffs; false disables them for remote deployments. */
  readonly nativeActions?: boolean
  /** Explicit documentation execution limits; direct embedders may omit the site consumer. */
  readonly site?: ArtifactSiteConfig
  /** Host-local whole-directory publication limits; direct embedders must configure this operation explicitly. */
  readonly directoryPublication?: DirectoryPublicationConfig
  /** Host-local complete Task documentation read limits; direct embedders must configure this operation explicitly. */
  readonly directoryRead?: Omit<TaskDirectoryReadLimits, 'maxFileBytes'>
  /** Durable Session evidence limits; direct embedders must configure these operations explicitly. */
  readonly deliveryRead?: DeliveryReadLimits
  /** Relative artifact root; absolute paths and traversal are refused at load. */
  readonly directory: string
  /** Maximum directory candidates and manifest records examined in one scan. */
  readonly maxEntries: number
  /** Inclusive UTF-8 manifest byte limit. */
  readonly maxManifestBytes: number
  /** Inclusive total manifest read budget per scan. */
  readonly maxIndexBytes: number
  /** Inclusive raw file byte limit per explicit read. */
  readonly maxFileBytes: number
  /** Delay between completed scans while following a catalog. */
  readonly refreshIntervalMs: number
}

/** Replace only desktop integration in deterministic adapter tests. */
export interface ArtifactControllerInternals {
  readonly canOpen?: () => boolean
  readonly canReveal?: () => boolean
  readonly open?: (path: string, signal: AbortSignal) => Promise<void>
  readonly reveal?: (path: string, signal: AbortSignal) => Promise<void>
  readonly openWeb?: (url: string, signal: AbortSignal) => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of project artifact reads and their generated Remote namespace. */
    artifactController: ArtifactController
  }
}

function failure(path: string, reason: 'unsafe-path' | 'not-found' | 'invalid' | 'too-large', message: string): RemoteError<'artifact/file'> {
  return new RemoteError('artifact/file', message, { path, reason })
}

const directoryPublicationConfig = z.object({
  maxEntries: z.number().step(1).min(1).default(10000),
  maxDepth: z.number().step(1).min(1).default(32),
  maxTotalBytes: z.number().step(1).min(1).default(128 * 1024 * 1024),
  lockWaitMs: z.number().step(1).min(1).max(2147483647).default(10000),
}) satisfies z<DirectoryPublicationConfig>

const directoryReadConfig = z.object({
  maxEntries: z.number().step(1).min(1).default(1000),
  maxFiles: z.number().step(1).min(1).default(256),
  maxDepth: z.number().step(1).min(1).default(32),
  maxTotalBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
  maxResponseBytes: z.number().step(1).min(1).default(24 * 1024 * 1024),
}) satisfies z<Omit<TaskDirectoryReadLimits, 'maxFileBytes'>>

const deliveryReadConfig = z.object({
  maxSessions: z.number().step(1).min(1).default(100),
  maxEvents: z.number().step(1).min(1).default(20000),
  maxSessionBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
  maxLogBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
}) satisfies z<DeliveryReadLimits>

function pathSegments(path: string): string[] {
  const parts = path.split('/')
  if (!parts.every(part => part === manifestName || safeSegment(part))) throw failure(path, 'unsafe-path', 'Artifact path must contain safe relative components')
  return parts
}

function ioFailure(error: unknown): { code: string; message: string } | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) return undefined
  return typeof error.code === 'string' && error.code.startsWith('FS_') && typeof error.message === 'string'
    ? { code: error.code, message: error.message } : undefined
}

function renditionPath(id: ArtifactRenditionId): { path: string; fileName: string; type: ArtifactType } {
  let parts: string[]
  try { parts = id.split('/').map(decodeURIComponent) } catch {
    // decodeURIComponent rejects malformed percent escapes in wire identities.
    throw failure(id, 'unsafe-path', 'Artifact identity has invalid encoding')
  }
  const [origin, type, fileName, ...rest] = parts
  if (origin === undefined || type === undefined || fileName === undefined || rest.length !== 0
    || !parts.every(safeSegment) || !artifactTypes.includes(type as ArtifactType)) {
    throw failure(id, 'unsafe-path', 'Artifact identity must name one conversation, type and file')
  }
  return { path: parts.join('/'), fileName, type: type as ArtifactType }
}

function previewSpec(id: ArtifactPreviewId) {
  let parts: string[]
  try { parts = id.split('/').map(decodeURIComponent) } catch {
    // Wire and stored identities may contain malformed percent escapes.
    throw failure(id, 'unsafe-path', 'Preview identity has invalid encoding')
  }
  const [origin, type, task, fileName] = parts
  if (parts.length !== 4 || !parts.every(safeSegment) || !artifactTypes.includes(type as ArtifactType)
    || fileName === undefined || !/^preview\.(png|jpe?g|webp|gif)$/.test(fileName)) {
    throw failure(id, 'unsafe-path', 'Preview identity must name a conversation, type, task and raster preview')
  }
  const mediaType: ArtifactPreviewFile['mediaType'] = fileName.endsWith('.png') ? 'image/png'
    : fileName.endsWith('.webp') ? 'image/webp' : fileName.endsWith('.gif') ? 'image/gif' : 'image/jpeg'
  return { origin, task, fileName, mediaType, segments: ['.mindmux', 'artifacts', ...parts] }
}

/** Bounded artifact reads and exclusive report publication; existing files are never replaced. */
export class ArtifactController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'fs', 'subprocess', 'sandbox']
  static Config: z<Config> = z.object({
    nativeActions: z.boolean(),
    site: siteConfig.default(siteConfig({})),
    directoryPublication: directoryPublicationConfig.default(directoryPublicationConfig({})),
    directoryRead: directoryReadConfig.default(directoryReadConfig({})),
    deliveryRead: deliveryReadConfig.default(deliveryReadConfig({})),
    directory: z.string().default('artifacts'),
    maxEntries: z.number().step(1).min(1).default(1000),
    maxManifestBytes: z.number().step(1).min(1).default(1024 * 1024),
    maxIndexBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
    maxFileBytes: z.number().step(1).min(1).default(25 * 1024 * 1024),
    refreshIntervalMs: z.number().step(1).min(1).max(2147483647).default(2000),
  })

  private readonly native: Required<ArtifactControllerInternals>
  private readonly sites: ArtifactSiteManager | undefined

  /**
   * @param ctx - Host with a registered project directory and composed filesystem.
   * @param config - validated storage directory and finite read bounds.
   * @param internals - replaceable native handoffs and platform availability checks.
   */
  constructor(ctx: Context, private readonly config: Config, internals: ArtifactControllerInternals = {}) {
    pathSegments(config.directory)
    super(ctx, 'artifactController', { namespace: 'artifacts' })
    this.native = { canOpen: internals.canOpen ?? canOpenNativePath, canReveal: internals.canReveal ?? canRevealNativePath,
      open: internals.open ?? openNativePath, reveal: internals.reveal ?? revealNativePath,
      openWeb: internals.openWeb ?? openNativeWebUrl }
    if (config.site !== undefined) {
      const sites = new ArtifactSiteManager({ subprocess: ctx.subprocess, sandbox: ctx.sandbox }, config.site, this.native.openWeb)
      this.sites = sites
      ctx.effect(() => () => sites.dispose(), 'artifact-controller: documentation site lifetime')
    }
  }

  /** Publish a UTF-8 report under its original conversation without replacing existing files.
   * @param workspaceId - target project selected for source-conversation execution.
   * @param workspacePath - retained project path; rebinding refuses publication.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @param fileName - one safe Markdown filename.
   * @param markdown - complete report within the configured file byte limit.
   * @param signal - cancels before atomic publication.
   * @returns encoded report identity; identical retries return the existing file, changed bytes fail.
   */
  async publishReport(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId,
    fileName: string, markdown: string, signal: AbortSignal): Promise<ArtifactRenditionId> {
    if (!fileName.toLowerCase().endsWith('.md')) {
      throw failure(fileName, 'unsafe-path', 'A report requires a Markdown filename')
    }
    return this.publishFile(workspaceId, workspacePath, sourceSessionId, 'reports', fileName, Buffer.from(markdown, 'utf8'), signal)
  }

  /** Publish one immutable successful coding-task receipt without copying its project files.
   * @param workspaceId - registered project that ran the confirmed task.
   * @param workspacePath - retained project path; rebinding refuses publication.
   * @param taskId - durable task identity used for the report name.
   * @param sourceSessionId - originating conversation, when the task has one.
   * @param markdown - task outcome distinguished from independently verified changes.
   * @param signal - cancellation before publication.
   * @returns project-catalog report identity; an identical retry reuses the existing bytes.
   */
  async publishTaskReport(workspaceId: WorkspaceId, workspacePath: string, taskId: ArtifactTaskId,
    sourceSessionId: SessionId | undefined, markdown: string, signal: AbortSignal): Promise<ArtifactRenditionId> {
    if (!safeSegment(taskId)) throw failure(taskId, 'unsafe-path', 'Task report requires a safe task identity')
    const fileName = `task-${taskId}.md`
    if (sourceSessionId !== undefined) return this.publishReport(workspaceId, workspacePath, sourceSessionId, fileName, markdown, signal)
    const origin = `task-${taskId}`
    await this.publishOwned(workspaceId, workspacePath, undefined,
      pathSegments(`${this.config.directory}/${origin}/reports/${fileName}`), Buffer.from(markdown, 'utf8'), signal)
    return renditionId(origin, 'reports', fileName)
  }

  /** Locate only this controller's deterministic task report beneath its configured artifact directory.
   * @param taskId - retained Task identity.
   * @param sourceSessionId - original conversation, when present.
   * @returns project-relative path used by exclusive publication.
   */
  taskReportRelativePath(taskId: ArtifactTaskId, sourceSessionId: SessionId | undefined): string {
    if (!safeSegment(taskId) || sourceSessionId !== undefined && !safeSegment(sourceSessionId)) {
      throw failure(taskId, 'unsafe-path', 'Task report identity is unsafe')
    }
    return `${this.config.directory}/${sourceSessionId ?? `task-${taskId}`}/reports/task-${taskId}.md`
  }

  /** Exclusively publish complete bytes under their original conversation.
   * @param workspaceId - target project selected for source-conversation execution.
   * @param workspacePath - retained project path; rebinding refuses publication.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @param type - destination artifact class.
   * @param fileName - one safe filename, not a path.
   * @param content - complete bytes within the configured file limit.
   * @param signal - cancels before atomic publication.
   * @returns encoded identity; identical retries reuse the file, different bytes fail without replacement.
   */
  async publishFile(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId,
    type: ArtifactType, fileName: string, content: Uint8Array, signal: AbortSignal): Promise<ArtifactRenditionId> {
    if (!safeSegment(sourceSessionId) || !safeSegment(fileName)) {
      throw failure(fileName, 'unsafe-path', 'Artifact publication requires a conversation identity and a safe filename')
    }
    await this.publishOwned(workspaceId, workspacePath, sourceSessionId,
      pathSegments(`${this.config.directory}/${sourceSessionId}/${type}/${fileName}`), content, signal)
    return renditionId(sourceSessionId, type, fileName)
  }

  /** Publish a complete task-owned documentation source tree under its original conversation.
   * @param workspaceId - currently writable destination project in the source conversation's logical workspace.
   * @param workspacePath - retained Host project path; rebinding refuses publication.
   * @param sourceSessionId - original conversation identity, not the worker Session.
   * @param directoryName - one safe output name assigned to the task.
   * @param sourceDirectory - complete, quiescent task-owned Host output; never a client-supplied path.
   * @param signal - cancels preparation before commit; committed output remains available.
   * @returns documentation rendition identity; identical retries reuse it and conflicting content fails.
   * Project writes use the composed filesystem's workspace-write policy, including private destination staging.
   * Package dependencies, repository internals and credential configuration are excluded as in site preparation.
   */
  async publishDirectory(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId,
    directoryName: string, sourceDirectory: string, signal: AbortSignal): Promise<ArtifactRenditionId> {
    if (!safeSegment(sourceSessionId) || !safeSegment(directoryName)) {
      throw failure(directoryName, 'unsafe-path', 'Documentation publication requires safe conversation and output identities')
    }
    const limits = this.config.directoryPublication
    if (limits === undefined) throw failure(directoryName, 'invalid', 'Documentation publication is not configured')
    const guard = this.sourceGuard(workspaceId, workspacePath, sourceSessionId, directoryName, signal, true)
    const admit = async (): Promise<void> => {
      guard()
      for (const host of [workspacePath, sourceDirectory]) {
        const mapped = this.ctx.fs.processPathFromHostPath(host)
        if (mapped === undefined) throw failure(directoryName, 'unsafe-path', 'Documentation publication requires a matching Host filesystem')
        const target = await this.ctx.fs.resolve(mapped, { signal })
        const local = await this.ctx.fs.resolve(host, { signal })
        if (local.targetKey !== target.targetKey || this.ctx.fs.processPath(target) !== host) {
          throw failure(directoryName, 'unsafe-path', 'Documentation publication Host and filesystem paths do not match')
        }
      }
      guard()
    }
    await publishDocumentationDirectory(this.ctx.fs, { projectRoot: workspacePath, source: sourceDirectory,
      segments: pathSegments(`${this.config.directory}/${sourceSessionId}/docs/${directoryName}`) },
    { ...limits, maxFileBytes: this.config.maxFileBytes }, admit, signal,
    (error) => { this.ctx.logger.warn('Documentation was published but private staging cleanup failed', error) })
    return renditionId(sourceSessionId, 'docs', directoryName)
  }

  /** Save a task preview outside the visible catalog without replacing conflicting bytes.
   * @param workspaceId - target project selected for source-conversation execution.
   * @param workspacePath - retained project path.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @param taskId - original task that owns the preview.
   * @param type - primary output class.
   * @param fileName - preview.png, preview.jpg, preview.jpeg, preview.webp or preview.gif.
   * @param content - complete bytes within the configured file limit.
   * @param signal - cancellation before publication.
   * @returns retained private identity; no image decoder or model is started.
   */
  async publishPreview(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId, taskId: ArtifactTaskId,
    type: ArtifactType, fileName: string, content: Uint8Array, signal: AbortSignal): Promise<ArtifactPreviewRef> {
    const id = brandString<ArtifactPreviewId>([sourceSessionId, type, taskId, fileName].map(encodeURIComponent).join('/'))
    const spec = previewSpec(id)
    await this.publishOwned(workspaceId, workspacePath, sourceSessionId, spec.segments, content, signal)
    return { id, fileName }
  }

  /** Read one retained task preview after checking exact project, conversation and task ownership.
   * @param workspaceId - original target project; execution selection may be withdrawn.
   * @param workspacePath - retained project path; rebinding refuses the read.
   * @param sourceSessionId - original conversation still bound to the target's logical workspace.
   * @param taskId - original task whose preview may be read.
   * @param id - retained private preview identity, never a Host path.
   * @param signal - cancels bounded filesystem work.
   * @returns complete raster bytes without opening an application or starting inference.
   */
  async readPreview(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId, taskId: ArtifactTaskId,
    id: ArtifactPreviewId, signal: AbortSignal): Promise<ArtifactPreviewFile> {
    const spec = previewSpec(id)
    if (spec.origin !== sourceSessionId || spec.task !== taskId) throw failure(id, 'unsafe-path', 'Preview ownership does not match its task')
    const guard = this.sourceGuard(workspaceId, workspacePath, sourceSessionId, id, signal, false)
    guard()
    const mapped = this.ctx.fs.processPathFromHostPath(workspacePath)
    if (mapped === undefined) throw failure(id, 'unsafe-path', 'Preview project is unavailable in this filesystem')
    const root = await this.ctx.fs.resolve(mapped, { signal })
    const located = await this.locateSegments(root, spec.segments, signal)
    if (located === undefined) throw failure(id, 'not-found', 'Preview file is missing')
    if (located.info.type !== 'file') throw failure(id, 'invalid', 'Preview must be a regular file')
    const content = await this.bytes(id, located.target, this.config.maxFileBytes, signal)
    guard()
    return { id, fileName: spec.fileName, mediaType: spec.mediaType, version: content.version,
      dataBase64: Buffer.from(content.bytes).toString('base64') }
  }

  private sourceGuard(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId | undefined,
    fileName: string, signal: AbortSignal, writable: boolean) {
    return (): void => {
      signal.throwIfAborted()
      const project = this.ctx.workspaceRegistry.get(workspaceId)
      if (sourceSessionId === undefined) {
        if (project?.path !== workspacePath || project.archivedAt !== undefined) {
          throw failure(fileName, 'unsafe-path', 'Task report project is unavailable or changed')
        }
        return
      }
      const scope = this.ctx.workspaceRegistry.conversationExecutionProjects(sourceSessionId)
      const space = this.ctx.workspaceRegistry.spaces.find(item => item.spaceId === scope?.spaceId)
      if (project?.path !== workspacePath || scope === undefined || !space?.projectIds.includes(workspaceId)
        || (writable && !scope.writableProjectIds.includes(workspaceId))) {
        throw failure(fileName, 'unsafe-path', 'Report source no longer permits its original target project')
      }
    }
  }

  private async publishOwned(workspaceId: WorkspaceId, workspacePath: string, sourceSessionId: SessionId | undefined,
    segments: readonly string[], content: Uint8Array, signal: AbortSignal) {
    const path = segments.join('/')
    const guard = this.sourceGuard(workspaceId, workspacePath, sourceSessionId, path, signal, true)
    guard()
    if (content.byteLength > this.config.maxFileBytes) throw failure(path, 'too-large', 'Output exceeds the artifact file byte limit')
    const mapped = this.ctx.fs.processPathFromHostPath(workspacePath)
    if (mapped === undefined) throw failure(path, 'unsafe-path', 'Report project is unavailable in this filesystem')
    const root = await this.ctx.fs.resolve(mapped, { signal })
    let target = root
    for (const [index, segment] of segments.entries()) {
      const cwd = this.ctx.fs.processPath(target)
      const info = await this.ctx.fs.lstat(segment, { cwd }, signal)
      const last = index === segments.length - 1
      if (info !== undefined && info.type !== (last ? 'file' : 'directory')) {
        throw failure(path, 'unsafe-path', 'Report path contains a link or unsupported file')
      }
      target = await this.ctx.fs.resolve(segment, { cwd, signal })
      if (!this.ctx.fs.contains(root, target)) throw failure(path, 'unsafe-path', 'Report path leaves its project')
    }
    guard()
    const existing = await this.ctx.fs.stat(target, signal)
    if (existing === undefined) {
      guard()
      await this.ctx.fs.createBytes(target, content, signal,
        { mode: 'workspace-write', workspaceRoot: this.ctx.fs.processPath(root) })
    } else {
      const retained = await this.bytes(path, target, this.config.maxFileBytes, signal)
      if (!Buffer.from(retained.bytes).equals(content)) {
        throw failure(path, 'invalid', 'Report already exists with different content; it was not replaced')
      }
    }
    guard()
  }

  /**
   * Scan conversation/type directories and group source/export renditions.
   * @param workspaceId - registered logical project, independent of Session selection.
   * @param signal - cancels filesystem work.
   * @returns metadata, explicit rejected-file diagnostics and scan truncation.
   */
  @Remote
  async index(workspaceId: WorkspaceId, signal: AbortSignal): Promise<ArtifactIndex> {
    const root = await this.root(workspaceId, signal)
    const site = this.sites?.status(workspaceId)
    const preview = site === undefined ? {} : { site }
    if (root === undefined) return { workspaceId, entries: [], issues: [], truncated: false, ...preview }
    const issues: ArtifactIssue[] = []
    const candidates: ArtifactCandidate[] = []
    let remaining = this.config.maxIndexBytes
    let examined = 0
    const scan = { truncated: false }
    const admit = (): boolean => {
      if (examined >= this.config.maxEntries) { scan.truncated = true; return false }
      examined++
      return true
    }
    const inspect = async (path: string, action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) {
        signal.throwIfAborted()
        const known = remoteErrorOf(error) ?? ioFailure(error)
        if (known === undefined) throw error
        issues.push({ path, message: known.message })
      }
    }
    for (const origin of await this.ctx.fs.listDir(root, signal)) {
      if (!admit()) break
      if (!safeSegment(origin.name)) continue
      await inspect(origin.name, async () => {
        const directory = await this.locate(root, origin.name, signal)
        if (directory === undefined || directory.info.type !== 'directory') return
        let records = new Map<string, ArtifactRecord>()
        const manifestPath = `${origin.name}/${manifestName}`
        await inspect(manifestPath, async () => {
          const manifest = await this.locate(root, manifestPath, signal)
          if (manifest === undefined) return
          if (manifest.info.type !== 'file') throw failure(manifestPath, 'invalid', 'Artifact manifest must be a regular file')
          if (remaining === 0) { scan.truncated = true; return }
          const limit = Math.min(remaining, this.config.maxManifestBytes)
          remaining -= limit
          const read = await this.bytes(manifestPath, manifest.target, limit, signal)
          remaining += limit - read.bytes.byteLength
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
            // Fatal decoding rejects invalid UTF-8; file I/O has already settled.
            throw failure(manifestPath, 'invalid', 'Artifact manifest must be UTF-8 text')
          }
          const parsed = readManifest(text, origin.name, this.config.maxEntries - examined)
          examined += parsed.examined
          scan.truncated ||= parsed.truncated
          records = parsed.records
          issues.push(...parsed.issues)
        })
        for (const type of artifactTypes) {
          if (!admit()) break
          const typePath = `${origin.name}/${type}`
          await inspect(typePath, async () => {
            const folder = await this.locate(root, typePath, signal)
            if (folder === undefined) return
            if (folder.info.type !== 'directory') throw failure(typePath, 'invalid', 'Artifact type path must be a directory')
            for (const file of await this.ctx.fs.listDir(folder.target, signal)) {
              if (!admit()) break
              if (!safeSegment(file.name)) continue
              const path = `${typePath}/${file.name}`
              await inspect(path, async () => {
                const located = await this.locate(root, path, signal)
                if (located === undefined) return
                if (located.info.type !== 'file' && !(type === 'docs' && located.info.type === 'directory')) {
                  throw failure(path, 'invalid', 'Only documentation artifacts can be directories')
                }
                const record = records.get(renditionId(origin.name, type, file.name))
                candidates.push(artifactCandidate(origin.name, type, file.name, located.info, record))
              })
            }
          })
        }
      })
      if (scan.truncated) break
    }
    return { workspaceId, entries: groupArtifacts(candidates), issues, truncated: scan.truncated, ...preview }
  }

  /**
   * Read one regular rendition without accepting an arbitrary absolute path.
   * @param workspaceId - registered project.
   * @param id - encoded conversation/type/filename identity from the index.
   * @param signal - cancels the bounded read.
   * @returns raw bytes and the unchanged file version; linked or changing files fail.
   */
  @Remote
  async read(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFile> {
    const { path, fileName } = renditionPath(id)
    const root = await this.root(workspaceId, signal)
    const located = root === undefined ? undefined : await this.locate(root, path, signal)
    if (located === undefined) throw failure(id, 'not-found', 'Artifact file does not exist')
    if (located.info.type !== 'file') throw failure(id, 'invalid', 'Artifact byte reads require a regular file')
    const content = await this.bytes(path, located.target, this.config.maxFileBytes, signal)
    return { id, fileName, version: content.version, dataBase64: Buffer.from(content.bytes).toString('base64') }
  }

  /** Read every file in one completed Task's retained documentation directory without a model request.
   * @param workspaceId - original registered project from the successful Task record.
   * @param workspacePath - retained project path; rebinding refuses the read.
   * @param taskId - successful Task identity; the caller must also match the Task's retained artifact ID.
   * @param id - Task receipt's documentation rendition identity, never an arbitrary Host path.
   * @param expectedDirectoryVersion - frozen catalog version, or undefined only for first capture.
   * @param signal - cancels the complete read without returning partial evidence.
   * @returns sorted full file bytes and a process-independent path/content digest within configured bounds.
   * This Host-only operation validates the deterministic Task directory name; it cannot establish success or
   * ownership from the directory alone because published directories carry no Task manifest.
   */
  async readTaskDirectory(workspaceId: WorkspaceId, workspacePath: string, taskId: ArtifactTaskId,
    id: ArtifactRenditionId, expectedDirectoryVersion: string | undefined,
    signal: AbortSignal): Promise<ArtifactTaskDirectory> {
    signal.throwIfAborted()
    if (!safeSegment(taskId)) throw failure(taskId, 'unsafe-path', 'Task identity is unsafe')
    const { path, type, fileName } = renditionPath(id)
    if (type !== 'docs' || fileName !== `documentation-${taskId}`) {
      throw failure(id, 'unsafe-path', 'Artifact identity does not name this Task documentation directory')
    }
    const limits = this.config.directoryRead
    if (limits === undefined) throw failure(id, 'invalid', 'Complete Task directory reads are not configured')
    const project = this.ctx.workspaceRegistry.get(workspaceId)
    if (project === undefined) throw new RemoteError('workspace/not-found', 'Project is not registered', { workspaceId })
    if (project.path !== workspacePath) throw failure(id, 'unsafe-path', 'Task project path changed')
    const root = await this.root(workspaceId, signal)
    const located = root === undefined ? undefined : await this.locate(root, path, signal)
    if (located === undefined) throw failure(id, 'not-found', 'Task documentation directory does not exist')
    if (located.info.type !== 'directory') throw failure(id, 'invalid', 'Task documentation must be a directory')
    const version = located.info.version
    if (expectedDirectoryVersion !== undefined && version !== expectedDirectoryVersion) {
      throw failure(id, 'invalid', 'Task documentation directory version changed')
    }
    const host = join(workspacePath, this.config.directory, path)
    const mapped = this.ctx.fs.processPathFromHostPath(host)
    if (mapped === undefined) throw failure(id, 'unsafe-path', 'Task documentation requires a matching Host filesystem')
    const target = await this.ctx.fs.resolve(mapped, { signal })
    if (target.targetKey !== located.target.targetKey || this.ctx.fs.processPath(target) !== host) {
      throw failure(id, 'unsafe-path', 'Task documentation Host and filesystem paths do not match')
    }
    let tree: Awaited<ReturnType<typeof readTaskDirectoryTree>>
    try { tree = await readTaskDirectoryTree(host, { ...limits, maxFileBytes: this.config.maxFileBytes }, signal) } catch (error) {
      if (error instanceof TaskDirectoryReadError) throw failure(id, error.reason, error.message)
      throw error
    }
    signal.throwIfAborted()
    const current = this.ctx.workspaceRegistry.get(workspaceId)
    const freshRoot = await this.root(workspaceId, signal)
    const fresh = freshRoot === undefined ? undefined : await this.locate(freshRoot, path, signal)
    if (current?.path !== workspacePath || fresh?.info.type !== 'directory'
      || fresh.info.version !== version || fresh.target.targetKey !== located.target.targetKey) {
      throw failure(id, 'invalid', 'Task documentation project or directory changed during reading')
    }
    const result: ArtifactTaskDirectory = { workspaceId, taskId, id, version, ...tree }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxResponseBytes) {
      throw failure(id, 'too-large', 'Complete Task documentation response exceeds its byte limit')
    }
    return result
  }

  /** List every published child file without exposing its bytes or starting a Task.
   * @param workspaceId - original registered project.
   * @param workspacePath - retained Task project path.
   * @param taskId - Task owning the exact documentation rendition.
   * @param id - retained directory rendition ID, checked against the Task identity.
   * @param signal - cancels the complete bounded scan.
   * @returns path, size and content hash for every file, plus stable directory evidence.
   */
  async listTaskDirectoryFiles(workspaceId: WorkspaceId, workspacePath: string, taskId: ArtifactTaskId,
    id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactTaskDirectoryListing> {
    const tree = await this.readTaskDirectory(workspaceId, workspacePath, taskId, id, undefined, signal)
    return { ...tree, files: tree.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }
  }

  /** Read one selected file only when the whole published tree still matches its listing.
   * @param workspaceId - original registered project.
   * @param workspacePath - retained Task project path.
   * @param taskId - Task owning the exact documentation rendition.
   * @param id - retained directory rendition ID.
   * @param path - a path selected from an earlier Host listing, never a client filesystem path.
   * @param version - exact listed root directory version.
   * @param digest - exact complete listed path/content digest.
   * @param sha256 - exact selected file content hash.
   * @param signal - cancels the bounded, symlink-rejecting read.
   * @returns only the requested file bytes; changed siblings or files reject before return.
   */
  async readTaskDirectoryFile(workspaceId: WorkspaceId, workspacePath: string, taskId: ArtifactTaskId,
    id: ArtifactRenditionId, path: string, version: string, digest: string, sha256: string,
    signal: AbortSignal): Promise<ArtifactTaskDirectoryFile> {
    const tree = await this.readTaskDirectory(workspaceId, workspacePath, taskId, id, version, signal)
    if (tree.digest !== digest) throw failure(id, 'invalid', 'Task documentation changed after listing')
    const file = tree.files.find(item => item.path === path && item.sha256 === sha256)
    if (file === undefined) throw failure(id, 'invalid', 'Task documentation file changed after listing')
    return file
  }

  /**
   * Inspect native handoff availability without opening an application.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity; links, absent files and invalid directories fail.
   * @param signal - cancels target validation.
   * @returns platform/configuration availability after proving a matching Host path.
   */
  @Remote
  async fileActions(workspaceId: WorkspaceId, id: ArtifactRenditionId, signal: AbortSignal): Promise<ArtifactFileActions> {
    const target = await this.nativeTarget(workspaceId, id, signal)
    return { ...this.availableActions(), ...(target.directory
      ? { canPreviewSite: this.sites !== undefined && this.availableActions().canOpen } : {}) }
  }

  /**
   * Open or reveal a rendition, or prepare an explicitly confirmed documentation site.
   * @param workspaceId - registered project.
   * @param id - concrete rendition identity, never a client-supplied absolute path.
   * @param action - explicit user-selected handoff or site startup.
   * @param signal - cancels validation, site preparation and browser handoff; a ready site remains Host-owned.
   * @returns after handoff or site readiness; execution rechecks ownership and configuration.
   */
  @Remote
  async nativeAction(workspaceId: WorkspaceId, id: ArtifactRenditionId, action: ArtifactNativeAction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (action === 'preview-site') {
      if (this.sites === undefined || !this.availableActions().canOpen) {
        throw new RemoteError('gateway/internal', 'Documentation preview is unavailable on this host', {})
      }
      const target = await this.nativeTarget(workspaceId, id, signal)
      if (!target.directory) throw failure(id, 'invalid', 'Documentation preview requires a documentation directory')
      const admit = async (owner: AbortSignal): Promise<void> => {
        const current = await this.nativeTarget(workspaceId, id, owner)
        if (!current.directory || current.path !== target.path) throw failure(id, 'unsafe-path', 'Documentation project was removed or rebound')
      }
      await this.sites.start(workspaceId, id, target.path, renditionPath(id).fileName, admit, signal)
      return
    }
    const available = this.availableActions()
    if (!(action === 'open' ? available.canOpen : available.canReveal)) {
      throw new RemoteError('gateway/internal', 'Native artifact action is unavailable on this host', {})
    }
    const { path } = await this.nativeTarget(workspaceId, id, signal)
    signal.throwIfAborted()
    try { await this.native[action](path, signal) } catch (error) {
      signal.throwIfAborted()
      throw new RemoteError('gateway/internal', `Native artifact action failed: ${error instanceof Error ? error.message : String(error)}`, {})
    }
    signal.throwIfAborted()
  }

  /** Reopen or stop an owned preview without accepting renderer-supplied URLs.
   * @param workspaceId - project associated with the retained preview.
   * @param id - exact run identity returned in catalog progress.
   * @param action - reopen the ready browser URL or await cleanup; stop remains available after source removal.
   * @param signal - requesting view cancellation; admitted cleanup is always joined.
   * @returns after browser handoff or complete site shutdown.
   */
  @Remote
  async siteAction(workspaceId: WorkspaceId, id: ArtifactSiteId, action: ArtifactSiteAction, signal: AbortSignal): Promise<void> {
    if (this.sites === undefined || (action === 'open' && !this.availableActions().canOpen)) {
      throw new RemoteError('gateway/internal', 'Documentation preview is unavailable on this host', {})
    }
    await this.sites.action(workspaceId, id, action, signal)
  }

  private availableActions(): ArtifactFileActions {
    return { canOpen: this.config.nativeActions !== false && this.native.canOpen(),
      canReveal: this.config.nativeActions !== false && this.native.canReveal() }
  }

  private async nativeTarget(workspaceId: WorkspaceId, id: ArtifactRenditionId,
    signal: AbortSignal): Promise<{ path: string; directory: boolean }> {
    const { path, type } = renditionPath(id)
    const root = await this.root(workspaceId, signal)
    const located = root === undefined ? undefined : await this.locate(root, path, signal)
    if (located === undefined) throw failure(id, 'not-found', 'Artifact file does not exist')
    if (located.info.type !== 'file' && !(type === 'docs' && located.info.type === 'directory')) {
      throw failure(id, 'invalid', 'Only documentation artifacts can be directories')
    }
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'Project is not registered', { workspaceId })
    const host = join(workspace.path, this.config.directory, path)
    const mapped = this.ctx.fs.processPathFromHostPath(host)
    if (mapped === undefined || (await this.ctx.fs.resolve(mapped, { signal })).targetKey !== located.target.targetKey) {
      throw failure(id, 'unsafe-path', 'Artifact has no matching Host path')
    }
    return { path: host, directory: located.info.type === 'directory' }
  }

  /**
   * Follow external artifact and manifest changes with bounded complete scans.
   * @param workspaceId - registered project.
   * @param signal - cancels scans and delay; callers join the iterator before releasing their project.
   * @returns an opening catalog, then changed catalogs only.
   */
  @Remote({ mode: 'stream' })
  async *follow(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<ArtifactIndex> {
    let previous: string | undefined
    while (true) {
      const index = await this.index(workspaceId, signal)
      const serialized = JSON.stringify(index)
      if (serialized !== previous) { previous = serialized; yield index }
      await delay(this.config.refreshIntervalMs, undefined, { signal })
    }
  }

  /**
   * Follow bounded durable file evidence from the registered Project's ordinary Sessions.
   * @param workspaceId - registered Project; read-focus references do not add Session membership.
   * @param signal - cancels evidence reads and polling; callers join the iterator on disposal.
   * @returns opening and changed indexes with explicit issues and truncation; no Session or file is created.
   */
  @Remote({ mode: 'stream' })
  async *followDeliveries(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<ArtifactDeliveryIndex> {
    let previous: string | undefined
    for (;;) {
      const index = await this.deliveries(workspaceId, signal)
      const serialized = JSON.stringify(index)
      if (serialized !== previous) { previous = serialized; yield index }
      await delay(this.config.refreshIntervalMs, undefined, { signal })
    }
  }

  /**
   * Read one current file only after re-extracting its exact durable source event.
   * @param workspaceId - current registered Project owning the source Session and file.
   * @param id - source identity returned by followDeliveries, never an arbitrary path.
   * @param version - exact filesystem version from that index; replacements require a fresh index.
   * @param signal - cancels source validation and bounded byte transfer.
   * @returns raw bytes with matching version; removed membership, links and changed files fail.
   */
  @Remote
  async readDelivery(workspaceId: WorkspaceId, id: ArtifactDeliveryId, version: string,
    signal: AbortSignal): Promise<ArtifactDeliveryFile> {
    const identity = deliveryIdentity(id)
    if (identity === undefined) throw failure(id, 'unsafe-path', 'Delivery identity must name one Session event and file')
    const limits = this.deliveryLimits()
    const workspace = this.deliveryWorkspace(workspaceId, identity.sessionId)
    const root = await this.deliveryRoot(workspace, signal)
    const read = await this.deliveryLog(identity.sessionId, limits, limits.maxSessionBytes, signal)
    const source = read.sources.find(candidate => candidate.id === id)
    if (source === undefined) throw failure(id, 'not-found', 'Delivery source event is unavailable within the read limits')
    const located = await this.deliveryLocation(root, source, signal)
    if (located === undefined) throw failure(id, 'not-found', 'Delivery file no longer exists')
    if (located.info.version !== version) throw failure(id, 'invalid', 'Delivery file changed; refresh before reading')
    const result = await this.bytes(located.path, located.target, this.config.maxFileBytes, signal)
    if (result.version !== version) throw failure(id, 'invalid', 'Delivery file changed while reading; refresh before reading')
    this.deliveryWorkspace(workspaceId, identity.sessionId, workspace.path)
    return { id, fileName: located.fileName, version: result.version, dataBase64: Buffer.from(result.bytes).toString('base64') }
  }

  private deliveryLimits(): DeliveryReadLimits {
    if (this.config.deliveryRead === undefined) throw failure('deliveries', 'invalid', 'Conversation delivery reads are not configured')
    this.deliveryPersistence()
    return this.config.deliveryRead
  }

  private deliveryPersistence() {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw failure('deliveries', 'invalid', 'Conversation delivery reads require Session persistence')
    return persistence
  }

  private deliveryWorkspace(id: WorkspaceId, sessionId?: SessionId, path?: string): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(id)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'Project is not registered', { workspaceId: id })
    if (path !== undefined && workspace.path !== path) throw failure(id, 'unsafe-path', 'Delivery Project path changed')
    if (sessionId !== undefined && !workspace.sessionIds.includes(sessionId)) {
      throw failure(sessionId, 'not-found', 'Delivery Session no longer belongs to this Project')
    }
    return workspace
  }

  private async deliveryRoot(workspace: Workspace, signal: AbortSignal): Promise<FsTarget> {
    signal.throwIfAborted()
    const path = this.ctx.fs.processPathFromHostPath(workspace.path)
    if (path === undefined) throw failure(workspace.id, 'unsafe-path', 'Project is unavailable in this filesystem')
    const info = await this.ctx.fs.lstat(path, undefined, signal)
    if (info?.type !== 'directory') throw failure(workspace.id, 'unsafe-path', 'Delivery Project must remain an unlinked directory')
    return this.ctx.fs.resolve(path, { signal })
  }

  private async deliveryLog(sessionId: SessionId, limits: DeliveryReadLimits, remaining: number, signal: AbortSignal) {
    const persistence = this.deliveryPersistence()
    const snapshot = await persistence.stat(sessionId, { signal })
    if (snapshot === undefined) throw failure(sessionId, 'not-found', 'Delivery Session is no longer stored')
    if (snapshot.header.origin === 'subagent') return { sources: [], truncated: false, bytes: 0 }
    const limit = Math.min(limits.maxSessionBytes, remaining)
    if (snapshot.sizeBytes !== undefined && snapshot.sizeBytes > limit) {
      throw failure(sessionId, 'too-large', 'Delivery Session exceeds the log byte limit')
    }
    await using handle = await persistence.open(sessionId, 'read', { signal })
    if (handle.header.id !== sessionId) throw failure(sessionId, 'invalid', 'Delivery Session identity changed')
    if (handle.header.origin === 'subagent') return { sources: [], truncated: false, bytes: 0 }
    if (snapshot.eventCount !== undefined && snapshot.eventCount - handle.inheritedEventCount > limits.maxEvents) {
      throw failure(sessionId, 'too-large', 'Delivery Session exceeds the event limit')
    }
    const read = await handle.read(handle.inheritedEventCount, limits.maxEvents + 1, { signal })
    if (read.events.length > limits.maxEvents) throw failure(sessionId, 'too-large', 'Delivery Session exceeds the event limit')
    const bytes = Buffer.byteLength(JSON.stringify(read.events))
    if (bytes > limit) throw failure(sessionId, 'too-large', 'Delivery Session exceeds the decoded log byte limit')
    return { ...deliverySources(handle.header, read.events, this.config.maxEntries), bytes }
  }

  private async deliveryLocation(root: FsTarget, source: DeliverySource, signal: AbortSignal) {
    const rootPath = this.ctx.fs.processPath(root)
    if (!isAbsolute(source.path) && source.cwd === undefined) throw failure(source.id, 'unsafe-path', 'Relative delivery file has no recorded working directory')
    const absolute = resolve(source.cwd ?? rootPath, source.path)
    const path = relative(rootPath, absolute).split(sep).join('/')
    const segments = pathSegments(path)
    const located = await this.locateSegments(root, segments, signal)
    if (located === undefined) return undefined
    if (located.info.type !== 'file') throw failure(path, 'invalid', 'Delivery must remain a regular file')
    const size = located.info.size
    if (size === undefined) throw failure(path, 'invalid', 'Delivery filesystem must report the file byte size')
    if (size > this.config.maxFileBytes) throw failure(path, 'too-large', 'Delivery file exceeds the byte limit')
    const fileName = segments.at(-1)
    if (fileName === undefined) throw failure(path, 'unsafe-path', 'Delivery file has no filename')
    return { ...located, path, fileName, size }
  }

  private async deliveries(workspaceId: WorkspaceId, signal: AbortSignal): Promise<ArtifactDeliveryIndex> {
    const limits = this.deliveryLimits()
    const workspace = this.deliveryWorkspace(workspaceId)
    const root = await this.deliveryRoot(workspace, signal)
    const files: ArtifactDelivery[] = [], issues: ArtifactIssue[] = []
    const index = { workspaceId, files, issues, truncated: false }
    let remaining = limits.maxLogBytes
    let examined = 0
    const fits = () => Buffer.byteLength(JSON.stringify(index)) <= this.config.maxIndexBytes
    if (!fits()) throw failure(workspaceId, 'too-large', 'Delivery index exceeds the response byte limit')
    const issue = (path: string, message: string) => {
      issues.push({ path, message })
      if (!fits()) { issues.pop(); index.truncated = true }
    }
    for (const sessionId of workspace.sessionIds.slice(0, limits.maxSessions)) {
      signal.throwIfAborted()
      this.deliveryWorkspace(workspaceId, sessionId, workspace.path)
      if (remaining <= 0 || examined >= this.config.maxEntries) { index.truncated = true; break }
      const allowance = Math.min(limits.maxSessionBytes, remaining)
      remaining -= allowance
      try {
        const read = await this.deliveryLog(sessionId, limits, allowance, signal)
        remaining += allowance - read.bytes
        index.truncated ||= read.truncated
        for (const source of read.sources) {
          if (examined++ >= this.config.maxEntries) { index.truncated = true; break }
          try {
            const located = await this.deliveryLocation(root, source, signal)
            if (located === undefined) { issue(source.id, 'Delivery file no longer exists'); continue }
            const previous = files.findIndex(file => file.relativePath === located.path)
            if (previous !== -1 && files[previous]?.sessionId !== sessionId
              && (files[previous]?.observedAt ?? 0) > source.observedAt) continue
            const file: ArtifactDelivery = { id: source.id, workspaceId, sessionId, relativePath: located.path,
              fileName: located.fileName, evidence: source.evidence, observedAt: source.observedAt,
              bytes: located.size, version: located.info.version,
              ...source.description === undefined ? {} : { description: source.description } }
            const old = previous === -1 ? undefined : files[previous]
            if (previous === -1) files.push(file)
            else files[previous] = file
            if (!fits()) {
              if (old === undefined) files.pop()
              else files[previous] = old
              index.truncated = true
              break
            }
          } catch (error) {
            signal.throwIfAborted()
            const remote = remoteErrorOf(error)
            const known = remote?.code === 'artifact/file' ? remote : ioFailure(error)
            issue(source.id, known?.message ?? 'Delivery file could not be inspected')
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        const remote = remoteErrorOf(error)
        const known = remote?.code === 'artifact/file' ? remote : undefined
        issue(sessionId, known?.message ?? ioFailure(error)?.message ?? 'Delivery Session could not be read')
        if (known?.code === 'artifact/file' && known.details.reason === 'too-large') index.truncated = true
      }
      this.deliveryWorkspace(workspaceId, sessionId, workspace.path)
    }
    index.truncated ||= workspace.sessionIds.length > limits.maxSessions
    const current = this.deliveryWorkspace(workspaceId, undefined, workspace.path)
    for (let index = files.length - 1; index >= 0; index--) {
      const file = files[index]
      if (file !== undefined && !current.sessionIds.includes(file.sessionId)) files.splice(index, 1)
    }
    files.sort((left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id))
    return index
  }

  private async root(workspaceId: WorkspaceId, signal: AbortSignal): Promise<FsTarget | undefined> {
    signal.throwIfAborted()
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'Project is not registered', { workspaceId })
    const mapped = this.ctx.fs.processPathFromHostPath(workspace.path)
    if (mapped === undefined) throw failure(this.config.directory, 'unsafe-path', 'Project is unavailable in this filesystem')
    const root = await this.ctx.fs.resolve(mapped, { signal })
    const artifact = await this.locate(root, this.config.directory, signal)
    if (artifact === undefined) return undefined
    if (artifact.info.type !== 'directory') throw failure(this.config.directory, 'invalid', 'Artifact root must be a directory')
    return artifact.target
  }

  private async locate(root: FsTarget, path: string, signal: AbortSignal): Promise<{ target: FsTarget; info: FsPathInfo } | undefined> {
    return this.locateSegments(root, pathSegments(path), signal)
  }

  private async locateSegments(root: FsTarget, segments: readonly string[], signal: AbortSignal):
  Promise<{ target: FsTarget; info: FsPathInfo } | undefined> {
    const path = segments.join('/')
    let parent = root
    let last: { target: FsTarget; info: FsPathInfo } | undefined
    for (const [index, segment] of segments.entries()) {
      const cwd = this.ctx.fs.processPath(parent)
      const info = await this.ctx.fs.lstat(segment, { cwd }, signal)
      if (info === undefined) return undefined
      if (info.type === 'symlink' || info.type === 'other' || (index < segments.length - 1 && info.type !== 'directory')) {
        throw failure(path, 'unsafe-path', 'Artifact path contains a link or unsupported file')
      }
      const target = await this.ctx.fs.resolve(segment, { cwd, signal })
      if (!this.ctx.fs.contains(root, target)) throw failure(path, 'unsafe-path', 'Artifact path leaves its project directory')
      last = { target, info }
      parent = target
    }
    return last
  }

  private async bytes(path: string, target: FsTarget, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; version: string }> {
    try {
      const before = await this.ctx.fs.stat(target, signal)
      const bytes = await this.ctx.fs.readBytes(target, signal, limit)
      const after = await this.ctx.fs.stat(target, signal)
      if (before === undefined || after === undefined || before.version !== after.version) throw failure(path, 'invalid', 'Artifact changed while reading; retry')
      return { bytes, version: after.version }
    } catch (error) {
      signal.throwIfAborted()
      const known = ioFailure(error)
      if (known !== undefined) throw failure(path, known.code === 'FS_TOO_LARGE' ? 'too-large' : 'invalid', known.message)
      throw error
    }
  }
}

export default ArtifactController
