/** Project artifact catalog identities and bounded file responses, independent of live Sessions. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Catalog group identity scoped to its originating conversation. */
export type ArtifactId = Branded<'ArtifactId'>
/** Encoded conversation/type/filename identity; never an arbitrary Host path. */
export type ArtifactRenditionId = Branded<'ArtifactRenditionId'>
/** Encoded conversation/type/task/preview identity in private artifact metadata storage. */
export type ArtifactPreviewId = Branded<'ArtifactPreviewId'>
/** Conversation identity from the artifact directory, which may belong to an imported project. */
export type ArtifactOriginId = Branded<'ArtifactOriginId'>
/** Source task reference; listing an artifact does not create or execute that task. */
export type ArtifactTaskId = Branded<'ArtifactTaskId'>
/** Process-local site ownership; a stale client cannot stop a replacement preview. */
export type ArtifactSiteId = Branded<'ArtifactSiteId'>
/** Encoded Session/event/file identity; never a caller-supplied filesystem path. */
export type ArtifactDeliveryId = Branded<'ArtifactDeliveryId'>

/** A currently readable project file with durable ordinary-conversation evidence. */
export interface ArtifactDelivery {
  readonly id: ArtifactDeliveryId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly relativePath: string
  readonly fileName: string
  readonly description?: string
  /** Explicit presentation or a successful write/edit, not inferred from a reply link. */
  readonly evidence: 'presented' | 'written'
  readonly bytes: number
  readonly version: string
  /** Timestamp of the source Session event, not a filesystem creation estimate. */
  readonly observedAt: number
}

/** Bounded ordinary-conversation file observations, independent of catalog and Task entries. */
export interface ArtifactDeliveryIndex {
  readonly workspaceId: WorkspaceId
  readonly files: readonly ArtifactDelivery[]
  readonly issues: readonly ArtifactIssue[]
  readonly truncated: boolean
}

/** Version-matched, bounded file bytes after rechecking Project and Session ownership. */
export interface ArtifactDeliveryFile {
  readonly id: ArtifactDeliveryId
  readonly fileName: string
  readonly version: string
  readonly dataBase64: string
}
/** Observable site startup, serving and cleanup state. */
export interface ArtifactSiteStatus {
  readonly id: ArtifactSiteId
  readonly renditionId: ArtifactRenditionId
  readonly title: string
  readonly phase: 'preparing' | 'installing' | 'starting' | 'fallback' | 'ready' | 'stopping' | 'stopped' | 'failed'
  readonly mode: 'framework' | 'html' | 'static' | null
  readonly detail: string | null
}
/** Operate an already-owned site; opening does not start a replacement process. */
export type ArtifactSiteAction = 'open' | 'stop'
/** Published artifact directory classes. */
export type ArtifactType = 'images' | 'decks' | 'reports' | 'docs'
/** Logical document kinds independent of their concrete file formats. */
export type ArtifactKind = 'image' | 'deck' | 'report' | 'docs' | 'generic'

/** One concrete file or documentation-site directory in a logical artifact. */
export interface ArtifactRendition {
  readonly id: ArtifactRenditionId
  readonly originId: ArtifactOriginId
  readonly type: ArtifactType
  readonly fileName: string
  readonly format: string
  readonly directory: boolean
  readonly bytes: number | null
  readonly version: string
  readonly createdAt: number | null
  readonly updatedAt: number | null
  readonly canonical: boolean
  readonly primary: boolean
  readonly stale: boolean
  readonly sourceVersion: number | null
}

/** A source document and its preview/export renditions, shown as one catalog card. */
export interface ArtifactEntry {
  readonly id: ArtifactId
  readonly originId: ArtifactOriginId
  readonly kind: ArtifactKind
  readonly title: string
  readonly taskId: ArtifactTaskId | null
  readonly updatedAt: number | null
  /** Original YYYY-MM-DD metadata, interpreted as a local calendar day for display; timestamps use null. */
  readonly updatedDate: string | null
  readonly canonicalId: ArtifactRenditionId
  readonly primaryId: ArtifactRenditionId
  readonly renditions: readonly ArtifactRendition[]
}

/** One explicit file or metadata failure encountered while listing a project. */
export interface ArtifactIssue {
  readonly path: string
  readonly message: string
}

/** Complete bounded catalog scan; truncation and invalid metadata remain visible. */
export interface ArtifactIndex {
  readonly workspaceId: WorkspaceId
  readonly entries: readonly ArtifactEntry[]
  readonly issues: readonly ArtifactIssue[]
  readonly truncated: boolean
  readonly site?: ArtifactSiteStatus
}

/** Raw, bounded rendition bytes; consumers select a safe viewer without executing file content. */
export interface ArtifactFile {
  readonly id: ArtifactRenditionId
  readonly fileName: string
  readonly version: string
  readonly dataBase64: string
}

/** One complete retained file in a task-owned documentation directory. */
export interface ArtifactTaskDirectoryFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly dataBase64: string
}

/** Bounded, complete Host-only documentation evidence; a rejected read returns no partial tree. */
export interface ArtifactTaskDirectory {
  readonly workspaceId: WorkspaceId
  readonly taskId: ArtifactTaskId
  readonly id: ArtifactRenditionId
  readonly version: string
  readonly digest: string
  readonly directories: readonly string[]
  readonly files: readonly ArtifactTaskDirectoryFile[]
  readonly totalBytes: number
}

/** Complete metadata-only view of a bounded Task documentation directory. */
export interface ArtifactTaskDirectoryListing extends Omit<ArtifactTaskDirectory, 'files'> {
  readonly files: readonly Pick<ArtifactTaskDirectoryFile, 'path' | 'bytes' | 'sha256'>[]
}

/** Optional task preview, separate from the visible artifact catalog. */
export interface ArtifactPreviewRef {
  readonly id: ArtifactPreviewId
  readonly fileName: string
}

/** Bounded raster preview bytes; image decoding remains a viewer operation. */
export interface ArtifactPreviewFile extends ArtifactPreviewRef {
  readonly version: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly dataBase64: string
}

/** Native handoffs offered for one validated project rendition. */
export interface ArtifactFileActions {
  readonly canOpen: boolean
  readonly canReveal: boolean
  readonly canPreviewSite?: boolean
}

/** Explicit user intent; site execution uses a private copy and leaves source artifact bytes unchanged. */
export type ArtifactNativeAction = 'open' | 'reveal' | 'preview-site'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Invalid, absent, linked, changing or oversized artifact input. */
    'artifact/file': { readonly path: string; readonly reason: 'unsafe-path' | 'not-found' | 'invalid' | 'too-large' }
  }
}
