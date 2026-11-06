import { appendPluginRecord } from '@deepseek-ai/dsh-session'
/** Resumable project imports and durably acknowledged compilation over immutable attachments. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-document-import-controller'
import type {} from '@deepseek-ai/dsh-api-knowledge-controller'
import type {} from '@deepseek-ai/dsh-api-task-controller'
import { hasInformedBrainRead, requireUserEvidenceSource, parseAutomaticMaintenanceReview,
  automaticMaintenanceReviewDigest, automaticMaintenancePageId, validateAutomaticMaintenanceRequest } from '@deepseek-ai/dsh-api-knowledge-controller'
import type { KnowledgeDocumentId, KnowledgeImportPublicationHold, KnowledgePageCreate,
  KnowledgePageStatusUpdate, KnowledgeRootWrite, KnowledgeTruthUpdate, KnowledgeUpdateId,
  KnowledgeAutomaticAuthorizationId, KnowledgeAutomaticMaintenanceRequest } from '@deepseek-ai/dsh-api-knowledge-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, freezeMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type {} from '@deepseek-ai/dsh-attachment'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { importState, knowledgeImportDomain, manifestSchema, publicationReviewOf } from './records.ts'
import type { KnowledgeImportRecord } from './records.ts'
import type { KnowledgeImportCreationClaim, KnowledgeImportFailure, KnowledgeImportId, KnowledgeImportManifest, KnowledgeImportReviewChange,
  KnowledgeImportReviewDecision, KnowledgeImportReviewLookup, KnowledgeImportState,
  KnowledgeImportReviewExecution, KnowledgeImportDiscovery, KnowledgeImportReviewSource,
  KnowledgeImportComparedPageChoice, KnowledgeImportComparedPageDecision,
  KnowledgeImportComparedPageRead, KnowledgeImportComparedPageReadRequest,
  KnowledgeImportComparedPageReview, KnowledgeImportDraftActionId, KnowledgeImportSaveDraftRequest,
  KnowledgeImportSourceDispositionChoice, KnowledgeImportSourceDispositionDecision,
  KnowledgeImportSourceDispositionReview,
  KnowledgeImportPublishDraftRequest, KnowledgeImportHeldCatalogPageReadRequest,
  KnowledgeImportPublicationReview, KnowledgeImportHeldDraft,
  KnowledgeImportHeldDraftReason, KnowledgeImportTaskSource, KnowledgeImportTaskSourceGroup,
  KnowledgeImportTaskSourceSelection, KnowledgeImportTaskSourceReadOptions,
  KnowledgeImportTaskDocxVisualEvidence } from './types.ts'
import { compilationMessage, compilationVisualContent } from './kickoff.ts'
import { approvedChange, canonicalReviewJson, comparedPageChoices, comparedPageReviewSha256,
  hasSelfDeclaredActiveOverlap, hasSelfDeclaredRootOverlap, hasSelfDeclaredStatusOverlap, hasSelfDeclaredUpdateOverlap,
  needsSourceDisposition, parseReviewDiscovery,
  parseReviewManifest, reviewChangeSha256,
  reviewChangesSha256, reviewExecutionArguments, requiresLaterUserQuote, sameComparedPageChoices,
  sameSourceDispositionChoices, sourceDispositionChoices, sourceDispositionReviewSha256 } from './review-manifest.ts'
import { candidateSearch, hasExactActiveTitle, topicSearch, type CandidateSearch } from './review-search.ts'
import { containsExactSourceQuotes, hasCitableConvertedText } from './source-quotes.ts'
import { automaticImportSources, automaticImportCoverage, automaticImportSearch, automaticImportEvidence } from './automatic-import.ts'
import { importSession } from './harness-session.ts'
import { automaticImportInstructions } from './automatic-kickoff.ts'

export type * from './types.ts'

const reviewReadTools = new Set(['read', 'read_image', 'skill', 'brain_read', 'brain_search', 'brain_read_proposals',
  'brain_read_health_report', 'read_research_report'])
const reviewWriteTools = new Set(['brain_append_timeline', 'brain_update_truth', 'brain_propose_truth', 'brain_create_page',
  'brain_set_page_status', 'brain_write_root', 'brain_archive_page', 'brain_normalize_page_format',
  'brain_set_page_tags', 'brain_update_page_title', 'brain_reindex', 'brain_mark_health_finding'])
const usesTopicDiscovery = (format: KnowledgeImportRecord['reviewFormat']): boolean =>
  format === 'brain-review-json-v5' || format === 'brain-review-json-v6'
const heldDraftReasons = new Set<KnowledgeImportHeldDraftReason>(['zero-hit-draft-required',
  'source-conflict-draft-required', 'discovery-coverage-draft-required'])
function heldDraftReason(reason: string | undefined): KnowledgeImportHeldDraftReason | undefined {
  return reason !== undefined && heldDraftReasons.has(reason as KnowledgeImportHeldDraftReason)
    ? reason as KnowledgeImportHeldDraftReason : undefined
}
function sourceDispositionFailure(record: KnowledgeImportRecord,
  changes: readonly KnowledgeImportReviewChange[]): 'missing-source-dispositions' | 'invalid-source-dispositions'
  | 'source-conflict-draft-required' | undefined {
  if (record.reviewFormat !== 'brain-review-json-v6') return undefined
  const documents = new Set(record.manifest.documents.map(document => document.id))
  let unresolved = false
  for (const change of changes) {
    if (!needsSourceDisposition(change)) continue
    const dispositions = change.evidence?.source_dispositions
    if (dispositions === undefined || dispositions.length !== documents.size) return 'missing-source-dispositions'
    const assessed = new Set<DocumentImportSourceId>()
    for (const item of dispositions) {
      if (!documents.has(item.document_id) || assessed.has(item.document_id)) return 'invalid-source-dispositions'
      assessed.add(item.document_id)
      if (item.disposition === 'unresolved') unresolved = true
    }
  }
  return unresolved ? 'source-conflict-draft-required' : undefined
}
const reviewDecisionInput = zod.object({
  operationId: zod.uuid().transform(value => brandString<KnowledgeImportReviewDecision['operationId']>(value)),
  decision: zod.enum(['approve', 'reject']),
  proposalMessageId: zod.string().min(1).transform(value => brandString<MessageId>(value)),
  expectedProposalSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  expectedRevision: zod.number().int().min(0),
  expectedComparedPageReviewSha256: zod.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedSourceDispositionReviewSha256: zod.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()

const sourceDispositionDecisionInput = zod.object({
  proposalMessageId: zod.string().min(1).transform(value => brandString<MessageId>(value)),
  expectedProposalSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  expectedReviewSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  changeIndex: zod.number().int().min(0), sourceIndex: zod.number().int().min(0),
  changeSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  documentId: zod.string().min(1).transform(value => brandString<DocumentImportSourceId>(value)),
  dispositionSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  judgment: zod.enum(['unknown', 'confirmed', 'disputed']),
}).strict()

const comparedPageDecisionInput = zod.object({
  proposalMessageId: zod.string().min(1).transform(value => brandString<MessageId>(value)),
  expectedProposalSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  expectedReviewSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  changeIndex: zod.number().int().min(0), pageIndex: zod.number().int().min(0),
  changeSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  targetProjectId: zod.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  path: zod.string().min(1), version: zod.string().min(1),
  pageSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  relation: zod.enum(['distinct', 'duplicate', 'conflict', 'unknown']),
}).strict()
const comparedPageReadInput = comparedPageDecisionInput.omit({ relation: true })

function matchesComparedPageRead(read: NonNullable<KnowledgeImportRecord['comparedPageReads']>[number],
  request: KnowledgeImportComparedPageReadRequest): boolean {
  return read.proposalMessageId === request.proposalMessageId
    && read.proposalSha256 === request.expectedProposalSha256
    && read.changeIndex === request.changeIndex && read.pageIndex === request.pageIndex
    && read.changeSha256 === request.changeSha256 && read.targetProjectId === request.targetProjectId
    && read.path === request.path && read.version === request.version && read.pageSha256 === request.pageSha256
}

const saveDraftInput = zod.object({
  operationId: zod.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
  proposalMessageId: zod.string().min(1).transform(value => brandString<MessageId>(value)),
  expectedProposalSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  changeIndex: zod.number().int().min(0).max(1),
  expectedChangeSha256: zod.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

const publishDraftInput = zod.object({
  operationId: zod.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
  draftOperationId: zod.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
  expectedDraftVersion: zod.string().min(1),
  expectedActiveIndexDigest: zod.string().regex(/^[a-f0-9]{64}$/u),
  reviewedPages: zod.array(zod.object({ path: zod.string().min(1), title: zod.string().min(1),
    version: zod.string().min(1), relation: zod.enum(['distinct', 'duplicate', 'conflict', 'unknown']),
  }).strict()),
}).strict()

const heldCatalogPageReadInput = zod.object({
  draftOperationId: zod.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
  expectedDraftVersion: zod.string().min(1),
  expectedActiveIndexDigest: zod.string().regex(/^[a-f0-9]{64}$/u),
  path: zod.string().min(1), title: zod.string().min(1), version: zod.string().min(1),
}).strict()

interface RootReviewGate {
  current: {
    controller: KnowledgeImportController
    allowTool(name: string, agent: Agent): boolean
    ownsSession(sessionId: SessionId): boolean
  } | undefined
}
const rootReviewGates = new WeakMap<Context, RootReviewGate>()

function carriesImportSource(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().some(event => (event.type === 'user/message'
    && event.data.source.kind === 'knowledge-import')
    || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'knowledge-import')))
}

/** Keep one fail-closed tool gate for the Host lifetime, including controller reload intervals. */
function rootReviewGate(root: Context): RootReviewGate {
  const existing = rootReviewGates.get(root)
  if (existing !== undefined) return existing
  const gate: RootReviewGate = { current: undefined }
  rootReviewGates.set(root, gate)
  root.inject(['tools', 'agents'], (scope: Context) => {
    scope.tools.restrictAccess((name, caller) => {
      const agent = scope.agents.list().find(item => item === caller)
      if (agent === undefined) return true
      return gate.current?.allowTool(name, agent) ?? !carriesImportSource(agent.session)
    })
    scope.tools.guard(exec => exec.name === 'run_code' && exec.agent !== undefined
      && (carriesImportSource(exec.agent.session) || gate.current?.ownsSession(exec.agent.id) === true)
      ? 'Knowledge import does not allow code execution.' : undefined)
  })
  return gate
}

/** Latest completed turn's final assistant text, excluding tool-only and interrupted output. */
function settledProposal(events: readonly SessionEvent[]): { messageId: MessageId; text: string } | null {
  const settled = events.findLast(event => event.type === 'turn/end')
  if (settled?.type !== 'turn/end' || settled.data.reason.kind !== 'completed') return null
  const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === settled.data.turn
    && event.data.interrupted !== true && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0))
  if (message?.type !== 'assistant/message') return null
  const text = message.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  return { messageId: message.data.message.id, text }
}

function retainedProposal(events: readonly SessionEvent[], messageId: MessageId): string | null {
  const event = events.find(item => item.type === 'assistant/message' && item.data.message.id === messageId)
  if (event?.type !== 'assistant/message') return null
  const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  return text.length === 0 ? null : text
}

function sortedPageVersions(pages: readonly { readonly path: string; readonly version: string }[]): readonly (readonly [string, string])[] {
  return pages.map(page => [page.path, page.version] as const)
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}

/** Admit only the unchanged registered directory; unexpected filesystem failures still propagate. */
function currentRegisteredDirectory(path: string): boolean {
  try {
    return realpathSync.native(path) === path && statSync(path).isDirectory()
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))) return false
    throw error
  }
}

function approvedComparedPages(changes: readonly KnowledgeImportReviewChange[],
  choices: readonly KnowledgeImportComparedPageChoice[] | undefined, digest: string | undefined): boolean {
  if (comparedPageChoices(changes).length === 0) return true
  return choices !== undefined && digest === comparedPageReviewSha256(choices)
    && sameComparedPageChoices(changes, choices) && choices.every(choice => choice.relation === 'distinct')
}

function approvedSourceDispositions(changes: readonly KnowledgeImportReviewChange[],
  choices: readonly KnowledgeImportSourceDispositionChoice[] | undefined, digest: string | undefined): boolean {
  if (sourceDispositionChoices(changes).length === 0) return true
  return choices !== undefined && digest === sourceDispositionReviewSha256(choices)
    && sameSourceDispositionChoices(changes, choices)
    && choices.every(choice => choice.judgment === 'confirmed')
}

interface V4MixedPlan {
  readonly kind: 'mixed'
  readonly update: KnowledgeImportReviewChange
  readonly create: KnowledgeImportReviewChange
  readonly projectId: WorkspaceId
  readonly existingPath: string
  readonly newPath: string
}

interface V5SingleCreatePlan {
  readonly kind: 'single-create'
  readonly create: KnowledgeImportReviewChange
  readonly projectId: WorkspaceId
  readonly newPath: string
}

type OrderedPlan = V4MixedPlan | V5SingleCreatePlan

interface ActiveIndexPage {
  readonly path: string
  readonly title: string
  readonly version: string
}

interface ActiveIndexState {
  readonly digest: string
  readonly exists: boolean
  readonly pages: readonly (readonly [string, string])[]
  readonly activePages: readonly ActiveIndexPage[]
  readonly directory: string
  readonly locationRevision: string | null
  readonly occupiedPaths: ReadonlySet<string>
  readonly authoredDocumentCount: number
  readonly hasActiveRoot: boolean
}

const brainWriteReceipt = zod.object({ acknowledgement: zod.string(), receipt: zod.object({
  operationId: zod.uuid(), documentId: zod.string().min(1), version: zod.string().min(1),
  disposition: zod.enum(['written', 'already-applied']),
}).strict().optional(), nonWriting: zod.literal(true).optional() }).strict()
  .refine(value => value.nonWriting === undefined || value.receipt === undefined)

/** Complete-selection and active-upload limits, enforced before bytes are decoded or retained. */
export interface Config {
  readonly sessionDirectory: string
  /** Maximum documents in one frozen selection. */
  readonly maxDocuments: number
  /** Inclusive original-byte cap for one selected document. */
  readonly maxSourceBytes: number
  /** Inclusive sum of original bytes in the complete selection. */
  readonly maxBatchSourceBytes: number
  /** Inclusive sum of converted UTF-8 bytes published by one import. */
  readonly maxBatchTextBytes: number
  /** Maximum original PDF pages included as images in one frozen review. */
  readonly maxPdfReviewPages: number
  /** Maximum total encoded PDF page-image bytes in one frozen review. */
  readonly maxPdfReviewImageBytes: number
  /** Maximum encoded bytes in one retained PDF page image. */
  readonly maxPdfReviewPageBytes: number
  /** Maximum DOCX embedded image elements supplied across one frozen review. */
  readonly maxDocxReviewImages: number
  /** Maximum total encoded DOCX embedded image bytes across one frozen review. */
  readonly maxDocxReviewTotalBytes: number
  /** Maximum encoded bytes in one supplied DOCX embedded image. */
  readonly maxDocxReviewImageBytes: number
  /** Maximum exact extracted PDF text bytes copied into the initial review message. */
  readonly maxInlinePdfTextBytes: number
  /** Active import operations across selections; excess requests fail busy. */
  readonly maxConcurrent: number
  /** Maximum exact Brain changes in one proposal review. */
  readonly maxReviewChanges: number
  /** Maximum UTF-8 bytes in the final structured review JSON block. */
  readonly maxReviewJsonBytes: number
  /** Maximum UTF-8 bytes in one exact converted-source quote. */
  readonly maxEvidenceQuoteBytes: number
  /** Maximum source quotes listed for one reviewed change. */
  readonly maxEvidenceSourcesPerChange: number
  /** Maximum previously read Brain pages compared for one reviewed change. */
  readonly maxComparedPagesPerChange: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable knowledge-import preparation and compilation delivery. */
    knowledgeImportController: KnowledgeImportController
  }
}

/** Stores imports before Session creation and deduplicates compilation through durable inbox receipts. */
export class KnowledgeImportController extends TypertRemoteService {
  static inject = [
    'agents', 'attachments', 'documentImportController', 'knowledgeController', 'sessionController', 'tools',
    'agentDefaultModel', 'llm', 'sessions', 'sessionPersistence', 'storageDomain', 'workspaceRegistry',
  ]
  static Config: z<Partial<Config>, Config> = z.object({
    sessionDirectory: z.string().min(1).required(),
    maxDocuments: z.number().step(1).min(1).default(20),
    maxSourceBytes: z.number().step(1).min(1).max(25 * 1024 * 1024).default(25 * 1024 * 1024),
    maxBatchSourceBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(500 * 1024 * 1024),
    maxBatchTextBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(500 * 1024 * 1024),
    maxPdfReviewPages: z.number().step(1).min(1).max(20).default(20),
    maxPdfReviewImageBytes: z.number().step(1).min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
    maxPdfReviewPageBytes: z.number().step(1).min(1).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
    maxDocxReviewImages: z.number().step(1).min(1).max(20).default(20),
    maxDocxReviewTotalBytes: z.number().step(1).min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
    maxDocxReviewImageBytes: z.number().step(1).min(1).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
    maxInlinePdfTextBytes: z.number().step(1).min(1).max(256 * 1024).default(64 * 1024),
    maxConcurrent: z.number().step(1).min(1).default(2),
    maxReviewChanges: z.number().step(1).min(1).default(20),
    maxReviewJsonBytes: z.number().step(1).min(1).default(512 * 1024),
    maxEvidenceQuoteBytes: z.number().step(1).min(1).default(1024),
    maxEvidenceSourcesPerChange: z.number().step(1).min(1).default(8),
    maxComparedPagesPerChange: z.number().step(1).min(1).default(20),
  })

  private readonly lifetime = new AbortController()
  private readonly operations = new Map<KnowledgeImportId, Promise<unknown>>()
  private readonly writeChecks = new Set<Promise<boolean>>()
  private readonly automaticOperations = new Map<KnowledgeImportId, Promise<void>>()
  private readonly automaticReschedules = new Set<KnowledgeImportId>()
  private table!: KvTable<KnowledgeImportId, KnowledgeImportRecord>

  /**
   * @param ctx - Host services owning projects, conversion and durable storage.
   * @param config - validated complete-selection and concurrency limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'knowledgeImportController', { namespace: 'knowledgeImports' })
  }

  /** Observe admitted imports, write checks and automatic settlement in this Host process.
   * @returns true until live work settles; retained failed, pending or unknown records alone are not active work.
   */
  hasActiveOperations(): boolean {
    return this.operations.size > 0 || this.writeChecks.size > 0 || this.automaticOperations.size > 0
  }

  protected async [Service.init](): Promise<void> {
    const gate = rootReviewGate(this.ctx.root)
    const domain = await this.ctx.storageDomain.open(knowledgeImportDomain)
    this.table = domain.table('imports')
    this.ctx.effect(() => async () => {
      this.lifetime.abort(new Error('knowledge import service disposed'))
      await Promise.allSettled([...this.operations.values(), ...this.writeChecks, ...this.automaticOperations.values()])
      await domain.close()
    }, 'knowledge-import.shutdown')
    this.ctx.inject(['taskController'], (scope) => {
      scope.effect(() => scope.taskController.registerTaskReviewSourceReader((workspaceId, selection, signal, options) =>
        this.readTaskSource(workspaceId, selection, signal, options)), 'knowledge-import: Task original-source reader')
    })
    for (const [id, record] of this.table.entries()) {
      if (id !== record.manifest.id) throw new Error('knowledge import key does not match its manifest identity')
    }
    this.ctx.effect(() => this.ctx.knowledgeController.registerSessionWriteAdmission((session: Session, execution) => {
      const record = this.forSession(session.id)
      const args = execution?.arguments
      if (record === undefined || execution?.sessionId !== session.id || args === null || typeof args !== 'object'
        || Array.isArray(args) || !this.reviewAllowsTool(session, execution.name,
        args as Record<string, unknown>, execution.callId)) {
        throw new Error('knowledge import review approval is required for this exact Brain change')
      }
    }), 'knowledge-import.write-admission')
    this.ctx.effect(() => this.ctx.knowledgeController.registerSessionCreateAdmission(async (
      session, execution, projectId, documentId, signal,
    ) => {
      const record = this.forSession(session.id)
      if (record === undefined || record.reviewFormat !== 'brain-review-json-v4'
        && !usesTopicDiscovery(record.reviewFormat)) return
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const proposal = settledProposal(session.snapshotEvents())
      if (proposal === null) return
      const changes = this.proposalChanges(record, proposal.text)
      if (changes === null) return
      const plan = this.orderedPlan(record, changes)
      if (plan === null) return
      const decisions = record.reviewDecisions ?? []
      const approval = decisions.at(-1)
      const intent = approval?.inFlight
      const expectedIndex = plan.kind === 'mixed' ? 1 : 0
      if (approval === undefined || execution?.sessionId !== session.id || execution.name !== 'brain_create_page'
        || intent?.index !== expectedIndex || intent.changeSha256 !== plan.create.sha256
        || intent.callId !== execution.callId || projectId !== plan.projectId
        || documentId !== plan.newPath || !this.reviewApproved(record, session)
        || execution.arguments === null || typeof execution.arguments !== 'object'
        || Array.isArray(execution.arguments)
        || this.reviewedChangeIndex(changes, execution.name,
          execution.arguments as Record<string, unknown>) !== expectedIndex) {
        throw new Error('Knowledge import mixed creation has no matching in-flight review step')
      }
      const checked = { ...approval }
      delete checked.inFlight
      const prior: KnowledgeImportRecord = { ...record, reviewDecisions: [...decisions.slice(0, -1), checked] }
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const progress = await this.orderedProgress(prior, plan, changes, session.snapshotEvents(), proposal.messageId,
        createHash('sha256').update(proposal.text).digest('hex'), signal)
      if (progress.status !== (plan.kind === 'mixed' ? 'partially-applied' : 'ready')
        || progress.nextChangeIndex !== expectedIndex) {
        throw new Error(`Knowledge import mixed creation changed before Brain publication: ${progress.reason ?? progress.status}`)
      }
    }), 'knowledge-import.create-admission')
    this.ctx.effect(() => this.ctx.knowledgeController.registerSessionUpdateAdmission(async (
      session, execution, projectId, documentId, signal,
    ) => {
      const record = this.forSession(session.id)
      if (record === undefined || record.reviewFormat !== 'brain-review-json-v4'
        && !usesTopicDiscovery(record.reviewFormat)) return
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const events = session.snapshotEvents()
      const proposal = settledProposal(events)
      if (proposal === null) return
      const changes = this.proposalChanges(record, proposal.text)
      if (changes === null) return
      const plan = this.v4MixedPlan(record, changes)
      if (plan === null) {
        if (!usesTopicDiscovery(record.reviewFormat)
          || changes.length === 0 || !changes.every(change => change.tool === 'brain_update_truth')) return
        const args = execution?.arguments
        const reviewedArgs = args !== null && typeof args === 'object' && !Array.isArray(args)
          ? args as Record<string, unknown> : null
        if (execution?.sessionId !== session.id || execution.name !== 'brain_update_truth'
          || reviewedArgs === null || reviewedArgs.target_project_id !== projectId || reviewedArgs.path !== documentId
          || !this.reviewAllowsTool(session, execution.name, reviewedArgs, execution.callId)
          || this.reviewedChangeIndex(changes, execution.name, reviewedArgs) < 0) {
          throw new Error('Knowledge import update has no matching approved Brain call before publication')
        }
        const ownUpdate = await this.v5TruthUpdateReceipt(record, changes, session, execution.name, reviewedArgs, signal)
        if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredUpdateOverlap(changes)
          && ownUpdate === undefined) {
          throw new Error('Knowledge import truth update reports unresolved overlap with another Brain document')
        }
        await this.reviewSourcesCurrent(changes, record.reviewDecisions?.at(-1)?.activeIndexDigests, signal, true, ownUpdate)
        if (!this.reviewAllowsTool(session, execution.name, reviewedArgs, execution.callId)) {
          throw new Error('Knowledge import update approval changed before Brain publication')
        }
        return
      }
      const decisions = record.reviewDecisions ?? []
      const approval = decisions.at(-1)
      const intent = approval?.inFlight
      if (approval === undefined || execution?.sessionId !== session.id || execution.name !== 'brain_update_truth'
        || intent?.index !== 0 || intent.changeSha256 !== plan.update.sha256
        || intent.callId !== execution.callId || projectId !== plan.projectId
        || documentId !== plan.existingPath || !this.reviewApproved(record, session)
        || execution.arguments === null || typeof execution.arguments !== 'object'
        || Array.isArray(execution.arguments)
        || this.reviewedChangeIndex(changes, execution.name,
          execution.arguments as Record<string, unknown>) !== 0) {
        throw new Error('Knowledge import mixed update has no matching in-flight review step')
      }
      const checked = { ...approval }
      delete checked.inFlight
      const prior: KnowledgeImportRecord = { ...record, reviewDecisions: [...decisions.slice(0, -1), checked] }
      const progress = await this.orderedProgress(prior, plan, changes, events, proposal.messageId,
        createHash('sha256').update(proposal.text).digest('hex'), signal)
      if (progress.status !== 'ready' || progress.nextChangeIndex !== 0) {
        throw new Error(`Knowledge import mixed update changed before Brain publication: ${progress.reason ?? progress.status}`)
      }
    }), 'knowledge-import.update-admission')
    this.ctx.on('tools/execute', async (execution, next) => {
      const session = execution.agent?.session
      const args = execution.arguments
      if (session === undefined || !reviewWriteTools.has(execution.name) || args === null || typeof args !== 'object'
        || Array.isArray(args)) return next()
      const record = this.forSession(session.id)
      if (record?.reviewFormat === undefined) return next()
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const proposal = settledProposal(session.snapshotEvents())
      if (proposal === null) return next()
      const changes = this.proposalChanges(record, proposal.text)
      if (changes === null) return next()
      const plan = this.orderedPlan(record, changes)
      if (plan !== null && this.reviewApproved(record, session)) {
        const index = this.reviewedChangeIndex(changes, execution.name, args as Record<string, unknown>)
        if (index >= 0) return this.executeOrderedTool(record, plan, changes, session,
          proposal.messageId, createHash('sha256').update(proposal.text).digest('hex'), index, execution, next)
      }
      if (!this.reviewAllowsTool(session, execution.name, args as Record<string, unknown>)) return next()
      const signal = AbortSignal.any([execution.signal, this.lifetime.signal])
      const check = (async () => {
        const ownUpdate = await this.v5TruthUpdateReceipt(record, changes, session, execution.name,
          args as Record<string, unknown>, signal)
        const ownRootWrite = record.reviewFormat === 'brain-review-json-v6'
          && hasSelfDeclaredRootOverlap(changes)
          ? await this.v6RootWriteReceipt(changes, session, execution.name,
            args as Record<string, unknown>, signal) : false
        const ownStatusUpdate = record.reviewFormat === 'brain-review-json-v6'
          && hasSelfDeclaredStatusOverlap(changes)
          ? await this.v6StatusUpdateReceipt(changes, session, execution.name,
            args as Record<string, unknown>, signal) : false
        if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredUpdateOverlap(changes)
          && ownUpdate === undefined) {
          throw new Error('Knowledge import truth update reports unresolved overlap with another Brain document')
        }
        if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredRootOverlap(changes)) {
          if (!ownRootWrite) throw new Error('Knowledge import root write reports unresolved overlap with another Brain document')
          return true
        }
        if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredStatusOverlap(changes)) {
          if (!ownStatusUpdate) throw new Error('Knowledge import active status reports unresolved overlap with another Brain document')
          return true
        }
        return this.reviewSourcesCurrent(changes, record.reviewDecisions?.at(-1)?.activeIndexDigests, signal,
          record.reviewFormat === 'brain-review-json-v3' || record.reviewFormat === 'brain-review-json-v4'
            || usesTopicDiscovery(record.reviewFormat), ownUpdate)
      })()
      this.writeChecks.add(check)
      try {
        await check
      } finally { this.writeChecks.delete(check) }
      signal.throwIfAborted()
      return next()
    })
    this.ctx.inject(['sandboxPolicy'], (scope: Context) => {
      scope.sandboxPolicy.registerWritableRoots(session => this.writableRoots(session))
    })
    gate.current = { controller: this, allowTool: (name, agent) => this.allowTool(name, agent),
      ownsSession: sessionId => this.forSession(sessionId) !== undefined }
    this.ctx.effect(() => () => { if (gate.current?.controller === this) gate.current = undefined }, 'knowledge-import.tool-admission')
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.scheduleAutomaticImport(session.id)
    })
    for (const [, record] of this.table.entries()) {
      if (record.execution?.status === 'accepted' && record.automatic !== undefined
        && ['reviewing', 'applying'].includes(record.automatic.status)) this.scheduleAutomaticImport(record.sessionId)
    }
  }

  /**
   * Persist one complete selection or return its existing receipt after an identical retry.
   * @param workspaceId - registered project to which the import remains bound.
   * @param manifest - ordered source identities, exact digests and localized kickoff choice.
   * @param signal - caller lifetime; cancellation does not erase a write that already committed.
   * @returns durable metadata; reserving a Session identity alone does not create that Session.
   */
  @Remote
  begin(workspaceId: WorkspaceId, manifest: KnowledgeImportManifest, signal: AbortSignal): Promise<KnowledgeImportState> {
    const parsed = manifestSchema.safeParse(manifest)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid knowledge import manifest', {})
    const accepted = parsed.data
    this.assertLimits(accepted)
    return this.run(accepted.id, signal, async (lifetime) => {
      const workspace = this.workspace(workspaceId)
      this.assertScope(workspaceId, accepted)
      const existing = this.table.get(accepted.id)
      if (existing !== undefined) {
        this.assertOwner(existing, workspaceId)
        if (existing.abandonedAt !== undefined) this.refuse('import-abandoned')
        if (JSON.stringify(existing.manifest) !== JSON.stringify(accepted)) this.refuse('selection-changed')
        return this.state(existing)
      }
      lifetime.throwIfAborted()
      const record: KnowledgeImportRecord = {
        workspaceId,
        workspacePath: workspace.path,
        sessionId: brandString<SessionId>(`session-${randomUUID()}`),
        reviewFormat: 'brain-review-json-v6',
        manifest: accepted,
        receipts: [],
        ...accepted.maintenance !== 'automatic' ? {} : { automatic: {
          authorizationId: brandString<KnowledgeAutomaticAuthorizationId>(randomUUID()), status: 'reviewing' as const,
          rounds: 0, budgetStart: 0, writes: [], processedMessages: [], candidateDigests: [],
        } },
      }
      await this.table.put(accepted.id, record)
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      return this.state(record)
    })
  }

  /**
   * Convert and save one frozen source; publish a receipt only after both files are durable.
   * @param workspaceId - original registered project.
   * @param importId - receipt identity returned by begin.
   * @param documentId - source identity from the frozen manifest.
   * @param dataBase64 - canonical base64 of the exact original bytes; no Host paths are accepted.
   * @param signal - caller lifetime; aborted writes may leave unreferenced immutable attachments.
   * @returns updated committed metadata; identical retries do not reconvert stored documents.
   * @throws unreadable when text has no citable body, or DOCX has neither citable body nor emitted images;
   * image-only DOCX and textless PDF retain receipts.
   */
  @Remote
  stage(
    workspaceId: WorkspaceId,
    importId: KnowledgeImportId,
    documentId: DocumentImportSourceId,
    dataBase64: string,
    signal: AbortSignal,
  ): Promise<KnowledgeImportState> {
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      this.assertLimits(record.manifest)
      const document = record.manifest.documents.find(item => item.id === documentId)
      if (document === undefined) this.refuse('document-not-in-selection')
      if (dataBase64.length > 4 * Math.ceil(document.bytes / 3)) this.refuse('source-changed')
      if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)) this.refuse('invalid-base64')
      const bytes = Buffer.from(dataBase64, 'base64')
      if (bytes.toString('base64') !== dataBase64) this.refuse('invalid-base64')
      if (bytes.byteLength !== document.bytes || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
        this.refuse('source-changed')
      }
      if (record.receipts.some(receipt => receipt.id === documentId)) return this.state(record)
      const output = await this.ctx.documentImportController.prepare(workspaceId, {
        name: document.name, format: document.format, dataBase64,
      }, lifetime)
      if (output.status === 'rejected') this.refuse(output.reason)
      if (!hasCitableConvertedText(output.text, document.format)
        && !(document.format === 'pdf' && output.extraction?.kind === 'pdf-text'
          && output.extraction.pagesWithoutText.length === output.extraction.pageCount)
        && !(document.format === 'docx' && output.extraction?.kind === 'docx-text'
          && output.extraction.imageCount > 0)) this.refuse('unreadable')
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const retainedTextBytes = record.receipts.reduce((sum, receipt) => sum + receipt.text.bytes, 0)
      if (output.textBytes > this.config.maxBatchTextBytes - retainedTextBytes) this.refuse('converted-batch-too-large')
      const source = await this.ctx.attachments.saveFile({ name: document.name, data: bytes })
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const text = await this.ctx.attachments.saveFile({
        name: document.format === 'docx' ? `${document.name}.md` : document.format === 'pdf' ? `${document.name}.txt` : document.name,
        data: Buffer.from(output.text, 'utf8'),
      })
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const next: KnowledgeImportRecord = { ...record, receipts: [...record.receipts, {
        id: documentId, source, text,
        ...output.extraction === undefined ? {} : { extraction: output.extraction.kind === 'pdf-text'
          ? { kind: 'pdf-text', pageCount: output.extraction.pageCount,
            pagesWithoutText: [...output.extraction.pagesWithoutText],
            ...output.extraction.pagesWithTextAndPaintedImages === undefined ? {} : {
              pagesWithTextAndPaintedImages: [...output.extraction.pagesWithTextAndPaintedImages],
            } }
          : { ...output.extraction } },
      }] }
      await this.table.put(importId, next)
      lifetime.throwIfAborted()
      this.assertOwner(next, workspaceId)
      return this.state(next)
    })
  }

  private async docxVisualEvidence(workspaceId: WorkspaceId, document: KnowledgeImportManifest['documents'][number],
    source: Uint8Array, imageCount: number, options: KnowledgeImportTaskSourceReadOptions,
    signal: AbortSignal): Promise<KnowledgeImportTaskDocxVisualEvidence> {
    if (source.byteLength !== document.bytes || createHash('sha256').update(source).digest('hex') !== document.sha256) {
      this.refuse('source-changed')
    }
    const limits = this.ctx.attachments.imageLimits
    const maxImages = Math.min(options.maxImages, this.config.maxDocxReviewImages, limits.maxImagesPerMessage)
    let remainingBytes = Math.min(options.maxTotalBytes, this.config.maxDocxReviewTotalBytes, limits.maxMessageImageBytes)
    const coverage: KnowledgeImportTaskDocxVisualEvidence['coverage'] = { imageCount, suppliedImages: [], layoutReviewed: false,
      omittedImages: Array.from({ length: imageCount }, (_, index) => ({ image: index + 1, reason: 'text-only-route' })) }
    if (!options.imageCapable || imageCount === 0) return { coverage, images: [] }
    if (maxImages <= 0 || remainingBytes <= 0) return { coverage: { ...coverage,
      omittedImages: coverage.omittedImages.map(item => ({ ...item, reason: maxImages <= 0 ? 'image-limit' : 'byte-limit' })) }, images: [] }
    const extracted = await this.ctx.documentImportController.extractDocxImages(workspaceId, source, {
      maxImages, maxTotalBytes: remainingBytes, maxImageBytes: Math.min(this.config.maxDocxReviewImageBytes, limits.maxImageBytes),
      maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension,
    }, signal)
    signal.throwIfAborted()
    if (extracted.status === 'rejected') return { coverage: { ...coverage,
      omittedImages: coverage.omittedImages.map(item => ({ ...item,
        reason: extracted.reason === 'too-large' ? 'byte-limit' : 'unreadable-image' })) }, images: [] }
    if (extracted.imageCount !== imageCount) this.refuse('source-changed')
    const suppliedImages: number[] = []
    const omittedImages = [...extracted.omittedImages]
    const images: ImageAttachmentRef[] = []
    for (const image of extracted.images) {
      if (!limits.mediaTypes.includes(image.mediaType)) {
        omittedImages.push({ image: image.image, reason: 'unsupported-format' }); continue
      }
      let saved: readonly ImageAttachmentRef[]
      try {
        saved = await this.ctx.attachments.saveImages([{ data: image.data, mediaType: image.mediaType,
          name: `${document.name}.image-${image.image}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}` }])
      } catch (error) {
        if (!isImageAdmissionError(error)) throw error
        omittedImages.push({ image: image.image, reason: 'unreadable-image' }); continue
      }
      const attachment = saved[0]
      /* v8 ignore if -- The concrete AttachmentStore.saveImages returns one reference for its one input. */
      if (attachment === undefined) throw new Error('DOCX embedded image requires its saved attachment')
      if (attachment.bytes > this.config.maxDocxReviewImageBytes || attachment.bytes > remainingBytes) {
        omittedImages.push({ image: image.image, reason: 'byte-limit' }); continue
      }
      suppliedImages.push(image.image)
      images.push(attachment)
      remainingBytes -= attachment.bytes
      signal.throwIfAborted()
    }
    return { coverage: { imageCount, suppliedImages, omittedImages: omittedImages.sort((a, b) => a.image - b.image),
      layoutReviewed: false }, images }
  }

  private async compileVisualEvidence(record: KnowledgeImportRecord, imageCapable: boolean,
    signal: AbortSignal): Promise<{
    pdfVisual: NonNullable<NonNullable<KnowledgeImportRecord['execution']>['pdfVisual']>
    docxVisual: NonNullable<NonNullable<KnowledgeImportRecord['execution']>['docxVisual']>
    inlinePdfText: { documentId: DocumentImportSourceId; text: string }[]
  }> {
    const limits = this.ctx.attachments.imageLimits
    let remainingPages = Math.min(this.config.maxPdfReviewPages, limits.maxImagesPerMessage)
    let remainingBytes = Math.min(this.config.maxPdfReviewImageBytes, limits.maxMessageImageBytes)
    let remainingText = this.config.maxInlinePdfTextBytes
    const pdfVisual: NonNullable<NonNullable<KnowledgeImportRecord['execution']>['pdfVisual']> = []
    const inlinePdfText: { documentId: DocumentImportSourceId; text: string }[] = []
    const images: SaveImageAttachment[] = []
    const read = async (file: KnowledgeImportRecord['receipts'][number]['source'], maxBytes: number): Promise<Buffer> => {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of this.ctx.attachments.readFileStream(file, signal)) {
        signal.throwIfAborted()
        if (chunk.byteLength > file.bytes - bytes || chunk.byteLength > maxBytes - bytes) this.refuse('source-changed')
        chunks.push(Buffer.from(chunk))
        bytes += chunk.byteLength
      }
      return Buffer.concat(chunks, bytes)
    }
    for (const document of record.manifest.documents) {
      if (document.format !== 'pdf') continue
      const receipt = record.receipts.find(item => item.id === document.id)
      /* v8 ignore if -- Validated unique receipt IDs cover the complete selection before compilation. */
      if (receipt === undefined) throw new Error('knowledge compilation requires every stored document')
      const extraction = receipt.extraction
      if (extraction?.kind !== 'pdf-text') continue
      const textless = extraction.pagesWithoutText.length === extraction.pageCount
      if (textless && !imageCapable) this.refuse('image-required')
      if (receipt.text.bytes > 0 && receipt.text.bytes <= remainingText) {
        const data = await read(receipt.text, remainingText)
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
        catch { this.refuse('source-changed') }
        inlinePdfText.push({ documentId: document.id, text })
        remainingText -= data.byteLength
      }
      const entry: typeof pdfVisual[number] = { documentId: document.id,
        coverage: { pageCount: extraction.pageCount, renderedPages: [], omittedReason: 'text-only-route' }, images: [] }
      pdfVisual.push(entry)
      if (!imageCapable) continue
      if (!limits.mediaTypes.includes('image/png')) entry.coverage.omittedReason = 'render-failed'
      else if (remainingPages === 0) entry.coverage.omittedReason = 'page-limit'
      else if (remainingBytes === 0) entry.coverage.omittedReason = 'byte-limit'
      else {
        const source = await read(receipt.source, this.config.maxSourceBytes)
        if (receipt.source.bytes !== document.bytes || createHash('sha256').update(source).digest('hex') !== document.sha256) {
          this.refuse('source-changed')
        }
        signal.throwIfAborted()
        this.assertOwner(record, record.workspaceId)
        const rendered = await this.ctx.documentImportController.renderPdf(record.workspaceId, source, {
          maxPages: remainingPages, maxTotalBytes: remainingBytes,
          maxPageBytes: Math.min(this.config.maxPdfReviewPageBytes, limits.maxImageBytes),
          maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension,
        }, signal)
        if (rendered.status === 'rejected') entry.coverage.omittedReason = 'render-failed'
        else {
          if (rendered.pageCount !== extraction.pageCount) this.refuse('source-changed')
          entry.coverage = { pageCount: rendered.pageCount, renderedPages: rendered.pages.map(page => page.page),
            ...rendered.omittedReason === undefined ? {} : { omittedReason: rendered.omittedReason } }
          for (const page of rendered.pages) {
            images.push({ data: page.data, mediaType: 'image/png', name: `${document.name}.page-${page.page}.png` })
            remainingPages--
            remainingBytes -= page.data.byteLength
          }
        }
      }
      if (textless && entry.coverage.renderedPages.length === 0) this.refuse('visual-unreadable')
      signal.throwIfAborted()
      this.assertOwner(record, record.workspaceId)
    }
    const refs = images.length === 0 ? [] : await this.ctx.attachments.saveImages(images)
    signal.throwIfAborted()
    this.assertOwner(record, record.workspaceId)
    let next = 0
    for (const entry of pdfVisual) {
      entry.images = [...refs.slice(next, next + entry.coverage.renderedPages.length)]
      next += entry.images.length
    }
    let remainingDocxImages = Math.min(this.config.maxDocxReviewImages, limits.maxImagesPerMessage - refs.length)
    let remainingDocxBytes = Math.min(this.config.maxDocxReviewTotalBytes,
      limits.maxMessageImageBytes - refs.reduce((bytes, ref) => bytes + ref.bytes, 0))
    const docxVisual: NonNullable<NonNullable<KnowledgeImportRecord['execution']>['docxVisual']> = []
    for (const document of record.manifest.documents) {
      if (document.format !== 'docx') continue
      const receipt = record.receipts.find(item => item.id === document.id)
      /* v8 ignore if -- Initial compilation and accepted continuations retain the complete validated receipt selection. */
      if (receipt === undefined) throw new Error('DOCX compilation requires every stored document')
      const extraction = receipt.extraction
      if (extraction?.kind !== 'docx-text') continue
      const textBytes = await read(receipt.text, this.config.maxBatchTextBytes)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(textBytes) }
      catch { this.refuse('source-changed') }
      const citable = hasCitableConvertedText(text, 'docx')
      if (!citable && !imageCapable) this.refuse('image-required')
      const source = await read(receipt.source, this.config.maxSourceBytes)
      signal.throwIfAborted()
      this.assertOwner(record, record.workspaceId)
      const entry = await this.docxVisualEvidence(record.workspaceId, document, source, extraction.imageCount,
        { imageCapable, maxImages: remainingDocxImages, maxTotalBytes: remainingDocxBytes }, signal)
      docxVisual.push({ documentId: document.id, sourceSha256: document.sha256,
        coverage: { ...entry.coverage, suppliedImages: [...entry.coverage.suppliedImages],
          omittedImages: [...entry.coverage.omittedImages] },
        images: [...entry.images] })
      remainingDocxImages -= entry.images.length
      remainingDocxBytes -= entry.images.reduce((bytes, image) => bytes + image.bytes, 0)
      if (!citable && entry.images.length === 0) this.refuse('visual-unreadable')
      signal.throwIfAborted()
      this.assertOwner(record, record.workspaceId)
    }
    return { pdfVisual, docxVisual, inlinePdfText }
  }

  /**
   * Queue compilation once using the frozen import's reserved Session and current default model.
   * @param workspaceId - original registered project; ownership is rechecked before delivery.
   * @param importId - complete stored selection; retries reuse the same message and model.
   * @param signal - caller lifetime; cancellation after delivery cannot retract accepted input.
   * @returns a durable inbox acknowledgement, not a model result. Inspect after failure to locate any created Session.
   * @throws `session-unverified` if Session identity or owning membership changes before binding or input admission.
   */
  @Remote
  compile(workspaceId: WorkspaceId, importId: KnowledgeImportId, signal: AbortSignal): Promise<KnowledgeImportState> {
    return this.run(importId, signal, async (lifetime) => {
      let record = this.record(workspaceId, importId)
      let execution = record.execution
      if (execution?.status === 'accepted') return this.state(record)
      if (record.manifest.scope !== undefined && this.ctx.get('sandboxPolicy') === undefined) {
        throw new RemoteError('gateway/bad-request', 'workspace imports require a Session sandbox policy and managed projectless directories', {})
      }
      if (record.receipts.length !== record.manifest.documents.length) this.refuse('documents-not-ready')
      if (execution === undefined) {
        const selected = await this.ctx.llm.resolveCallConfig(this.ctx.agentDefaultModel.currentSelection(), lifetime)
        const prepared = await this.ctx.llm.prepareCall(selected, lifetime)
        const visual = await this.compileVisualEvidence(record, prepared.inputModalities?.includes('image') === true, lifetime)
        const index = await this.ctx.knowledgeController.index(workspaceId, lifetime)
        const automaticCatalog = record.manifest.maintenance === undefined ? undefined
          : await this.ctx.knowledgeController.automaticMaintenanceCatalog(workspaceId, lifetime)
        const automaticSources = automaticCatalog === undefined ? undefined : await automaticImportSources(
          this.ctx, record, this.ctx.knowledgeController.automaticMaintenancePolicy().maxReviewBytes, lifetime)
        if (record.automatic !== undefined && automaticCatalog !== undefined) {
          record = { ...record, automatic: { ...record.automatic, catalog: {
            sha256: automaticCatalog.catalogSha256, revision: automaticCatalog.locationRevision,
            pages: automaticCatalog.pages.map(page => ({ path: page.path, version: page.version })),
          } } }
        }
        const presets = this.ctx.get('agentPresets')
        const agentPreset = presets === undefined ? undefined : (await presets.resolve()).id
        lifetime.throwIfAborted()
        this.assertOwner(record, workspaceId)
        execution = {
          creationClaim: brandString<KnowledgeImportCreationClaim>(randomUUID()),
          selection: {
            provider: selected.provider, model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          },
          ...(agentPreset === undefined ? {} : { agentPreset }),
          pdfVisual: visual.pdfVisual,
          docxVisual: visual.docxVisual,
          message: compilationMessage(record, index.directory, this.availableImportProjects(record), visual,
            automaticCatalog, automaticSources),
          status: 'prepared',
        }
        if (automaticCatalog !== undefined && Buffer.byteLength(JSON.stringify(execution.message), 'utf8')
          > this.ctx.knowledgeController.automaticMaintenancePolicy().maxReviewBytes) throw new Error('Complete AI import input exceeds maxReviewBytes')
        record = { ...record, execution }
        if (record.automatic === undefined) await this.table.put(importId, record)
        else await this.persistAutomaticImport(importId, record)
      }
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const existingSession = await this.ctx.sessionPersistence.stat(record.sessionId)
      if (existingSession !== undefined && !await this.ownsInterruptedSession(record, existingSession.header, lifetime)) {
        this.refuse('session-unverified')
      }
      const creationRequest = {
        ...record.manifest.scope === undefined ? { workspaceId } : { spaceId: record.manifest.scope.spaceId },
        sessionId: record.sessionId,
        ...(execution.agentPreset === undefined ? {} : { agentPreset: execution.agentPreset }),
      }
      if (existingSession === undefined && execution.creationClaim !== undefined) {
        const creationEvent: SessionEvent<'knowledge-import/creation-claim'> = {
          type: 'knowledge-import/creation-claim', ignorable: true, seq: SessionSeq(0), time: Date.now(),
          data: { importId, workspaceId, spaceId: record.manifest.scope?.spaceId ?? null,
            claim: execution.creationClaim },
        }
        await importSession(this.ctx, this.config.sessionDirectory, creationRequest, [creationEvent])
      } else {
        await importSession(this.ctx, this.config.sessionDirectory, creationRequest)
      }
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const createdAgent = this.ctx.agents.get(record.sessionId)
      if (createdAgent === undefined || !await this.ctx.sessions.flush(createdAgent.session)) {
        throw new RemoteError('gateway/internal', 'knowledge import Session has no durable creation checkpoint', {})
      }
      lifetime.throwIfAborted()
      const createdSession = await this.ctx.sessionPersistence.stat(record.sessionId)
      if (createdSession === undefined || !this.sessionOwnerMatches(record, createdSession.header)) {
        this.refuse('session-unverified')
      }
      const ownsCreated = await this.ownsInterruptedSession(record, createdSession.header, lifetime)
      if (!ownsCreated && (existingSession !== undefined || execution.creationClaim !== undefined)
        || !this.sessionOwnerMatches(record, createdSession.header)) {
        this.refuse('session-unverified')
      }
      if (record.sessionBinding === undefined) {
        /* v8 ignore if -- No binding or claim makes ownsInterruptedSession false; the prior guard rejects existing Sessions. */
        if (existingSession !== undefined && execution.creationClaim === undefined) this.refuse('session-unverified')
        record = { ...record, sessionBinding: {
          createdAt: createdSession.header.createdAt,
          ...createdSession.header.cwd === undefined ? {} : { cwd: createdSession.header.cwd },
        } }
        if (record.automatic === undefined) await this.table.put(importId, record)
        else await this.persistAutomaticImport(importId, record)
        lifetime.throwIfAborted()
        this.assertOwner(record, workspaceId)
      } else if (!ownsCreated) this.refuse('session-unverified')
      const found = await this.ctx.sessionController.resolveAgent(record.sessionId)
      if ('error' in found) throw found.error
      const { agent } = found
      if (record.manifest.scope !== undefined) {
        const { createdAt, cwd } = agent.session.header
        const binding = record.sessionBinding
        if (binding === undefined || binding.createdAt !== createdAt || binding.cwd !== cwd) {
          this.refuse('session-unverified')
        }
        await this.ctx.workspaceRegistry.setConversationExecutionScope(record.sessionId, { kind: 'all' }, null)
        lifetime.throwIfAborted()
        this.assertOwner(record, workspaceId)
      }
      const matches = (message: UserMessage): boolean => message.source.kind === 'knowledge-import'
        && message.source.importId === importId
      // Claimed or cancelled inbox entries remain receipts; retries must not revive them.
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const delivered = agent.session.snapshotEvents().some(event =>
        event.type === 'agent/inbox/spliced' && event.data.inserted.some(matches))
      const acceptedRecord: KnowledgeImportRecord = { ...record, execution: { ...execution, status: 'accepted' } }
      if (record.automatic !== undefined) this.ensureAutomaticRecordCapacity(acceptedRecord)
      if (!delivered) {
        await this.ctx.sessionController.selectModel({
          sessionId: record.sessionId, provider: execution.selection.provider, model: execution.selection.model,
          ...(execution.selection.reasoningEffort === undefined ? {} : { reasoningEffort: execution.selection.reasoningEffort }),
          persistDefault: false,
        })
        lifetime.throwIfAborted()
        this.assertOwner(record, workspaceId)
        if (!this.matchesSessionHeader(record, agent.session.header)
          || !this.sessionOwnerMatches(record, agent.session.header)) this.refuse('session-unverified')
        agent.followup(freezeMessage(execution.message))
      }
      if (!await this.ctx.sessions.flush(agent.session)) {
        throw new RemoteError('gateway/internal', 'knowledge compilation has no Session durability listener', {})
      }
      record = acceptedRecord
      if (record.automatic === undefined) await this.table.put(importId, record)
      else await this.persistAutomaticImport(importId, record)
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      return this.state(record)
    })
  }

  /**
   * Inspect committed metadata without converting, creating a Session or starting a model.
   * @param workspaceId - original registered project.
   * @param importId - durable retry identity; unknown imports return null.
   * @returns committed preparation/delivery state and independently observed durable Session existence.
   */
  @Remote
  async inspect(workspaceId: WorkspaceId, importId: KnowledgeImportId): Promise<KnowledgeImportState | null> {
    this.lifetime.signal.throwIfAborted()
    this.workspace(workspaceId)
    const record = this.table.get(importId)
    if (record === undefined) return null
    this.assertOwner(record, workspaceId)
    return this.state(record)
  }

  /**
   * List this project's unaccepted imports without an active Host operation.
   * @param workspaceId - registered project owning the retained selections.
   * @returns metadata-only receipts; a creation-only Session can be explicitly abandoned after a fresh Host check.
   */
  @Remote
  async listPending(workspaceId: WorkspaceId): Promise<readonly KnowledgeImportState[]> {
    this.lifetime.signal.throwIfAborted()
    this.workspace(workspaceId)
    const pending: KnowledgeImportState[] = []
    for (const [id, record] of this.table.entries()) {
      if (record.workspaceId !== workspaceId || record.abandonedAt !== undefined
        || record.execution?.status === 'accepted' || this.operations.has(id) || !this.ownerCurrent(record)) continue
      const created = await this.ctx.sessionPersistence.stat(record.sessionId)
      this.lifetime.signal.throwIfAborted()
      if (!this.operations.has(id) && this.table.get(id) === record && this.ownerCurrent(record)) {
        pending.push({ ...importState(record, created !== undefined, false), ...created === undefined ? {} : {
          ...await this.canAbandonCreated(record, created.header, this.lifetime.signal)
            ? { createdAbandonable: true as const } : {},
          sessionRecovery: await this.ownsInterruptedSession(record, created.header, this.lifetime.signal)
            ? 'delivery-unconfirmed' as const : 'identity-unconfirmed' as const,
        } })
      }
    }
    return pending.sort((left, right) => left.id.localeCompare(right.id))
  }

  /** List complete same-project imports eligible for a person's Task-review source selection.
   * @param workspaceId - registered project that owns the original imports.
   * @param signal - selection-list lifetime.
   * @returns metadata only; source and converted bytes require a separate exact Task read.
   */
  @Remote
  async listTaskSources(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly KnowledgeImportTaskSourceGroup[]> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    this.workspace(workspaceId)
    const groups: KnowledgeImportTaskSourceGroup[] = []
    for (const [, record] of this.table.entries()) {
      lifetime.throwIfAborted()
      if (record.workspaceId !== workspaceId || record.abandonedAt !== undefined
        || record.receipts.length !== record.manifest.documents.length || !this.ownerCurrent(record)) continue
      groups.push({ importId: record.manifest.id, sessionId: record.sessionId,
        documents: record.manifest.documents.map((document) => {
          const extraction = record.receipts.find(receipt => receipt.id === document.id)?.extraction
          return { ...document, ...(extraction === undefined ? {} : { extraction }) }
        }) })
    }
    return Promise.resolve(groups.sort((left, right) => left.importId.localeCompare(right.importId)))
  }

  /** Verify the original and converted retained bytes for one explicitly selected Task reviewer source.
   * @param workspaceId - Task project; neither an import Session nor a path grants cross-project access.
   * @param selection - exact import, reserved Session, and frozen document identity selected by a person.
   * @param signal - cancels complete attachment reads and any PDF render worker.
   * @param options - actual reviewer route and remaining aggregate image limits; omission verifies bytes without rendering.
   * @returns complete conversion digests and optional durable PDF page images, never original binary bytes.
   * Empty PDF text is legitimate evidence metadata, not a source-change failure.
   * @throws image-required when an explicit text-only PDF/DOCX review has no citable text;
   * visual-unreadable when its requested visual evidence yields no images.
   */
  async readTaskSource(workspaceId: WorkspaceId, selection: KnowledgeImportTaskSourceSelection,
    signal: AbortSignal, options?: KnowledgeImportTaskSourceReadOptions): Promise<KnowledgeImportTaskSource> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    const record = this.record(workspaceId, selection.importId)
    if (record.sessionId !== selection.sessionId || record.abandonedAt !== undefined
      || record.receipts.length !== record.manifest.documents.length) this.refuse('review-not-ready')
    const document = record.manifest.documents.find(item => item.id === selection.documentId)
    const receipt = record.receipts.find(item => item.id === selection.documentId)
    if (document === undefined || receipt === undefined) this.refuse('document-not-in-selection')
    if (receipt.source.name !== document.name || receipt.source.bytes !== document.bytes
      || document.bytes > this.config.maxSourceBytes || receipt.text.bytes > this.config.maxBatchTextBytes) {
      this.refuse('source-changed')
    }
    const read = async (file: typeof receipt.source, maxBytes: number): Promise<{ bytes: Buffer; sha256: string }> => {
      const chunks: Buffer[] = []
      const digest = createHash('sha256')
      let size = 0
      try {
        for await (const chunk of this.ctx.attachments.readFileStream(file, lifetime)) {
          lifetime.throwIfAborted()
          if (chunk.byteLength > file.bytes - size || chunk.byteLength > maxBytes - size) this.refuse('source-changed')
          const bytes = Buffer.from(chunk)
          chunks.push(bytes)
          digest.update(bytes)
          size += bytes.byteLength
        }
      } catch (error) {
        if (this.ctx.attachments.isAttachmentError(error)
          && (error.code === 'ATTACHMENT_CORRUPT' || error.code === 'ATTACHMENT_NOT_FOUND')) {
          this.refuse('source-changed')
        }
        throw error
      }
      return { bytes: Buffer.concat(chunks, size), sha256: digest.digest('hex') }
    }
    const source = await read(receipt.source, this.config.maxSourceBytes)
    if (source.sha256 !== document.sha256) this.refuse('source-changed')
    const converted = await read(receipt.text, this.config.maxBatchTextBytes)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(converted.bytes) }
    catch { this.refuse('source-changed') }
    const citable = hasCitableConvertedText(text, document.format)
    const textlessPdf = document.format === 'pdf' && receipt.extraction?.kind === 'pdf-text'
      && receipt.extraction.pagesWithoutText.length === receipt.extraction.pageCount
    const textlessDocx = document.format === 'docx' && receipt.extraction?.kind === 'docx-text'
      && receipt.extraction.imageCount > 0
    if (!citable && !textlessPdf && !textlessDocx) this.refuse('source-changed')
    let pdfVisual: KnowledgeImportTaskSource['pdfVisual']
    let docxVisual: KnowledgeImportTaskSource['docxVisual']
    if (document.format === 'pdf' && options !== undefined) {
      const extraction = receipt.extraction?.kind === 'pdf-text' ? receipt.extraction : undefined
      if (!options.imageCapable) {
        if (!citable) this.refuse('image-required')
        if (extraction !== undefined) pdfVisual = { coverage: { pageCount: extraction.pageCount,
          renderedPages: [], omittedReason: 'text-only-route' }, images: [] }
      } else {
        const limits = this.ctx.attachments.imageLimits
        const maxPages = Math.min(options.maxImages, this.config.maxPdfReviewPages, limits.maxImagesPerMessage)
        const maxTotalBytes = Math.min(options.maxTotalBytes, this.config.maxPdfReviewImageBytes, limits.maxMessageImageBytes)
        const omittedReason = !limits.mediaTypes.includes('image/png') ? 'render-failed'
          : maxPages <= 0 ? 'page-limit' : maxTotalBytes <= 0 ? 'byte-limit' : undefined
        if (omittedReason !== undefined) {
          if (extraction !== undefined) pdfVisual = { coverage: { pageCount: extraction.pageCount,
            renderedPages: [], omittedReason }, images: [] }
        } else {
          const rendered = await this.ctx.documentImportController.renderPdf(workspaceId, source.bytes, {
            maxPages, maxTotalBytes,
            maxPageBytes: Math.min(this.config.maxPdfReviewPageBytes, limits.maxImageBytes),
            maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension,
          }, lifetime)
          lifetime.throwIfAborted()
          this.assertOwner(record, workspaceId)
          if (rendered.status === 'rejected') {
            if (extraction !== undefined) pdfVisual = { coverage: { pageCount: extraction.pageCount,
              renderedPages: [], omittedReason: 'render-failed' }, images: [] }
          } else {
            if (extraction !== undefined && rendered.pageCount !== extraction.pageCount) this.refuse('source-changed')
            const attachments = rendered.pages.length === 0 ? [] : await this.ctx.attachments.saveImages(
              rendered.pages.map(page => ({ data: page.data, mediaType: 'image/png',
                name: `${document.name}.page-${page.page}.png` })))
            pdfVisual = { coverage: { pageCount: rendered.pageCount,
              renderedPages: rendered.pages.map(page => page.page),
              ...(rendered.omittedReason === undefined ? {} : { omittedReason: rendered.omittedReason }) },
            images: rendered.pages.map((page, index) => {
              const attachment = attachments[index]
              /* v8 ignore if -- AttachmentStore.saveImages retains every rendered page in the same input order. */
              if (attachment === undefined) throw new Error('rendered PDF page has no saved image attachment')
              return { page: page.page, attachment }
            }) }
          }
        }
        if (!citable && (pdfVisual?.images.length ?? 0) === 0) this.refuse('visual-unreadable')
      }
    }
    if (document.format === 'docx' && options !== undefined) {
      if (!citable && !options.imageCapable) this.refuse('image-required')
      const extraction = receipt.extraction?.kind === 'docx-text' ? receipt.extraction : undefined
      if (extraction !== undefined) docxVisual = await this.docxVisualEvidence(workspaceId, document, source.bytes,
        extraction.imageCount, options, lifetime)
      if (!citable && (docxVisual?.images.length ?? 0) === 0) this.refuse('visual-unreadable')
    }
    lifetime.throwIfAborted()
    this.assertOwner(record, workspaceId)
    if (this.table.get(selection.importId) !== record) this.refuse('source-changed')
    return { ...selection, name: document.name, format: document.format, bytes: document.bytes,
      sourceSha256: document.sha256, text, textBytes: converted.bytes.byteLength, textSha256: converted.sha256,
      ...(receipt.extraction === undefined ? {} : { extraction: receipt.extraction }),
      ...(pdfVisual === undefined ? {} : { pdfVisual }), ...(docxVisual === undefined ? {} : { docxVisual }) }
  }

  /**
   * Retire a staged import without deleting its selection, attachments or any Session.
   * @param workspaceId - original registered project.
   * @param importId - retained selection identity; repeated abandon calls are idempotent.
   * @param signal - caller cancellation; an already committed decision remains durable.
   * @returns the tombstone receipt. A bound Session or accepted input requires Session recovery instead.
   */
  @Remote
  abandon(workspaceId: WorkspaceId, importId: KnowledgeImportId, signal: AbortSignal): Promise<KnowledgeImportState> {
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId, true)
      if (record.abandonedAt !== undefined) return this.state(record)
      if (record.execution?.status === 'accepted') this.refuse('import-already-started')
      const created = await this.ctx.sessionPersistence.stat(record.sessionId)
      if (created !== undefined) {
        if (!await this.canAbandonCreated(record, created.header, lifetime)) this.refuse('import-already-started')
        await importSession(this.ctx, this.config.sessionDirectory, {
          ...record.manifest.scope === undefined ? { workspaceId } : { spaceId: record.manifest.scope.spaceId },
          sessionId: record.sessionId,
          ...record.execution?.agentPreset === undefined ? {} : { agentPreset: record.execution.agentPreset },
        })
        const agent = this.ctx.agents.get(record.sessionId)
        if (agent === undefined || agent.status !== 'idle') this.refuse('import-already-started')
        let maintenance: Promise<KnowledgeImportState>
        try { maintenance = agent.runMaintenance(async (activity) => {
          const active = AbortSignal.any([lifetime, activity])
          active.throwIfAborted()
          this.assertOwner(record, workspaceId)
          if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
            || !await this.canAbandonCreated(record, agent.session.header, active)) {
            this.refuse('import-already-started')
          }
          const next: KnowledgeImportRecord = { ...record, abandonedAt: Date.now() }
          await this.table.put(importId, next)
          active.throwIfAborted()
          return this.state(next)
        }) } catch { this.refuse('import-already-started') }
        return maintenance
      }
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const next: KnowledgeImportRecord = { ...record, abandonedAt: Date.now() }
      await this.table.put(importId, next)
      lifetime.throwIfAborted()
      return this.state(next)
    })
  }

  /**
   * Recover an import and its latest settled review proposal from a Session identity.
   * @param sessionId - import Session shown in the conversation UI.
   * @param signal - caller cancellation while reading a cold Session log.
   * @returns null for an unrelated Session, otherwise review context with current compared-page verification;
   * ordinary replies after a recorded decision retain that decision without presenting a new proposal.
   */
  @Remote
  async inspectReview(sessionId: SessionId, signal: AbortSignal): Promise<KnowledgeImportReviewLookup | null> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    const record = this.forSession(sessionId)
    if (record === undefined) return null
    this.assertOwner(record, record.workspaceId)
    if (record.manifest.maintenance !== undefined) return {
      importId: record.manifest.id, workspaceId: record.workspaceId, state: await this.state(record), proposal: null,
    }
    const evidence = await this.sessionEvidence(record, lifetime)
    let proposal: KnowledgeImportReviewLookup['proposal'] = null
    if (evidence !== null && this.matchesEvidence(record, evidence)) {
      const settledMessage = settledProposal(evidence.events)
      const latest = record.reviewDecisions?.at(-1)
      // Opening markers retain malformed and historical review blocks for diagnostics, not authorization.
      const reviewMessage = latest !== undefined && settledMessage !== null
        && settledMessage.messageId !== latest.proposalMessageId
        && !/^[ \t]*```brain-review-json(?:-[^\r\n]*)?[ \t]*\r?$/mu.test(settledMessage.text)
        ? null : settledMessage
      if (reviewMessage !== null) {
        const settled = {
          ...reviewMessage, sha256: createHash('sha256').update(reviewMessage.text).digest('hex'),
        }
        const proposalSha256 = settled.sha256
        const parsedChanges = this.proposalChanges(record, settled.text)
        const plan = parsedChanges === null ? null : this.orderedPlan(record, parsedChanges)
        const execution = plan === null || parsedChanges === null ? undefined
          : await this.orderedProgress(record, plan, parsedChanges, evidence.events, settled.messageId, proposalSha256, lifetime)
        const reviewed = execution !== undefined && execution.status !== 'awaiting-approval'
          ? { changes: parsedChanges, verification: execution.status === 'blocked'
            ? { status: 'invalid' as const, ...execution.reason === undefined ? {} : { reason: execution.reason } }
            : { status: 'verified' as const } }
          : await this.verifyProposal(record, settled.text, evidence.events, settled.messageId, lifetime)
        const retainedDiscovery = usesTopicDiscovery(record.reviewFormat) && latest?.decision === 'approve'
          && latest.proposalMessageId === settled.messageId && latest.proposalSha256 === proposalSha256
          ? latest.discovery : undefined
        const approvalNeedsRenewal = record.reviewFormat !== undefined && latest?.decision === 'approve'
          && reviewed.changes !== null
          && latest.proposalMessageId === settled.messageId
          && latest.proposalSha256 === proposalSha256
          && [...this.activeCreationPaths(reviewed.changes).keys()].some(projectId => latest.activeIndexDigests?.[projectId] === undefined)
        const comparedPageReview = usesTopicDiscovery(record.reviewFormat) && reviewed.changes !== null
          ? this.comparedPageReview(record, reviewed.changes, settled.messageId, proposalSha256) : undefined
        const sourceDispositionReview = record.reviewFormat === 'brain-review-json-v6'
          && reviewed.changes !== null
          ? this.sourceDispositionReview(record, reviewed.changes, settled.messageId, proposalSha256) : undefined
        const zeroHitTitleSearch = (() => {
          if (reviewed.changes === null
            || heldDraftReason(reviewed.verification.reason) === undefined) return undefined
          const creation = reviewed.changes.find(change => change.tool === 'brain_create_page'
            && change.arguments.status === 'active')
          if (creation === undefined || typeof creation.arguments.title !== 'string') return undefined
          const projectId = brandString<WorkspaceId>(creation.arguments.target_project_id as string)
          const project = this.ctx.workspaceRegistry.get(projectId)
          const proposalIndex = evidence.events.findIndex(event => event.type === 'assistant/message'
            && event.data.message.id === settled.messageId)
          if (project === undefined || proposalIndex < 0) return undefined
          const observed = candidateSearch(evidence.events.slice(0, proposalIndex), projectId, project.path,
            creation.arguments.title)
          return typeof observed === 'string' ? undefined : { targetProjectId: projectId, ...observed }
        })()
        proposal = {
          ...settled,
          changes: reviewed.changes,
          format: record.reviewFormat ?? 'brain-review-json-v1',
          ...!usesTopicDiscovery(record.reviewFormat) ? {} : {
            discovery: reviewed.discovery ?? retainedDiscovery ?? [],
          },
          ...zeroHitTitleSearch === undefined ? {} : { zeroHitTitleSearch },
          ...comparedPageReview === undefined ? {} : { comparedPageReview },
          ...sourceDispositionReview === undefined ? {} : { sourceDispositionReview },
          verification: reviewed.verification,
          ...execution === undefined ? {} : { execution },
          ...approvalNeedsRenewal ? { approvalNeedsRenewal: true } : {},
        }
      }
    }
    return { importId: record.manifest.id, workspaceId: record.workspaceId,
      state: await this.state(record, evidence),
      ...record.zeroHitDraft === undefined ? {} : { zeroHitDraft: await this.inspectZeroHitDraft(record.zeroHitDraft, lifetime) },
      proposal }
  }

  private async inspectZeroHitDraft(draft: NonNullable<KnowledgeImportRecord['zeroHitDraft']>,
    signal: AbortSignal): Promise<KnowledgeImportHeldDraft> {
    const publicationReview = publicationReviewOf(draft)
    const base = { operationId: draft.operationId, proposalMessageId: draft.proposalMessageId,
      proposalSha256: draft.proposalSha256, changeIndex: draft.changeIndex, changeSha256: draft.changeSha256,
      targetProjectId: draft.targetProjectId, path: draft.path,
      sourceDocumentId: draft.sourceDocumentId, sourceQuote: draft.sourceQuote,
      ...draft.reason === undefined ? {} : { reason: draft.reason },
      ...draft.savedVersion === undefined ? {} : { savedVersion: draft.savedVersion },
      ...publicationReview === undefined ? {} : { publicationReview },
      ...draft.publication === undefined ? {} : { publicationOperationId: draft.publication.operationId,
        ...draft.publication.publishedVersion === undefined ? {} : {
          publishedVersion: draft.publication.publishedVersion,
        },
        ...draft.publication.publishedVersion === undefined ? { pendingPublication: {
          operationId: draft.publication.operationId,
          expectedDraftVersion: draft.publication.expectedDraftVersion,
          expectedActiveIndexDigest: draft.publication.expectedActiveIndexDigest,
          ...draft.publication.reviewedPages === undefined
            || draft.publication.reviewedPageBodies === undefined ? {} : {
              reviewedPages: draft.publication.reviewedPages,
            },
        } } : {},
      } }
    if (draft.publication?.publishedVersion !== undefined) return { ...base, phase: 'published' }
    if (draft.savedVersion === undefined) return { ...base, phase: 'saving' }
    try {
      const page = await this.ctx.knowledgeController.read(draft.targetProjectId,
        brandString<KnowledgeDocumentId>(draft.path), signal)
      if (page.entry.kind === 'page' && page.entry.status === 'active' && draft.publication !== undefined) {
        return { ...base, phase: 'conflict', publicationReview: { status: 'unknown', reason: 'receipt-unconfirmed' } }
      }
      const index = await this.activeIndexState(draft.targetProjectId, new Set([draft.path]), signal)
      if (page.entry.kind !== 'page' || page.entry.status !== 'draft' || index === null || !index.exists) {
        return { ...base, phase: 'conflict' }
      }
      const edited = page.entry.version !== draft.savedVersion || page.entry.title !== draft.originalTitle
        || createHash('sha256').update(page.body.trim()).digest('hex') !== draft.originalBodySha256
      return { ...base, phase: edited ? 'edited' : 'saved', current: { version: page.entry.version, body: page.body,
        title: page.entry.title, activeIndexDigest: index.digest, activePageCount: index.activePages.length,
        activePages: index.activePages } }
    } catch (error) {
      signal.throwIfAborted()
      if (remoteErrorOf(error)?.code === 'knowledge/document') return { ...base, phase: 'conflict' }
      throw error
    }
  }

  /** Read one active page or root under the retained draft's current catalog and save its complete-body receipt before returning it.
   * @param workspaceId - original import owner; the request cannot select another project.
   * @param importId - retained import identity.
   * @param request - exact draft version, catalog digest, and page identity shown for review.
   * @param signal - cancels the read before receipt publication.
   * @returns the full body at the receipted page version, without approving its semantic relation.
   */
  @Remote
  readHeldDraftCatalogPage(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportHeldCatalogPageReadRequest, signal: AbortSignal): Promise<KnowledgeImportComparedPageRead> {
    const parsed = heldCatalogPageReadInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid held-draft catalog page read', {})
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      const draft = record.zeroHitDraft
      if (draft?.operationId !== parsed.data.draftOperationId
        || draft.publication?.publishedVersion !== undefined) this.refuse('draft-not-ready')
      const observed = await this.inspectZeroHitDraft(draft, lifetime)
      if (observed.phase !== 'saved' && observed.phase !== 'edited'
        || observed.current?.version !== parsed.data.expectedDraftVersion
        || observed.current.activeIndexDigest !== parsed.data.expectedActiveIndexDigest
        || !observed.current.activePages.some(page => page.path === parsed.data.path
          && page.title === parsed.data.title && page.version === parsed.data.version)) {
        this.refuse('draft-publication-changed')
      }
      const page = await this.ctx.knowledgeController.read(draft.targetProjectId,
        brandString<KnowledgeDocumentId>(parsed.data.path), lifetime)
      const index = await this.activeIndexState(draft.targetProjectId, new Set([draft.path]), lifetime)
      if (page.entry.status !== 'active' || page.entry.title !== parsed.data.title
        || page.entry.version !== parsed.data.version || index?.digest !== parsed.data.expectedActiveIndexDigest) {
        this.refuse('draft-publication-changed')
      }
      const receipt = { draftVersion: parsed.data.expectedDraftVersion,
        activeIndexDigest: parsed.data.expectedActiveIndexDigest, path: parsed.data.path,
        title: parsed.data.title, version: parsed.data.version,
        bodySha256: createHash('sha256').update(page.body).digest('hex') }
      const reads = (draft.catalogPageReads ?? []).filter(read => read.draftVersion === receipt.draftVersion
        && read.activeIndexDigest === receipt.activeIndexDigest && read.path !== receipt.path)
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      await this.table.put(importId, { ...record, zeroHitDraft: { ...draft, catalogPageReads: [...reads, receipt] } })
      return { kind: page.entry.kind, path: page.entry.id, version: page.entry.version, body: page.body }
    })
  }

  /** Require fresh full-body reads for every active page and root before admitting held-draft publication. */
  private async assertHeldCatalogPageReads(draft: NonNullable<KnowledgeImportRecord['zeroHitDraft']>,
    reviewedPages: readonly { path: string; title: string; version: string }[], draftVersion: string,
    activeIndexDigest: string, signal: AbortSignal,
    frozenBodies?: readonly { path: string; bodySha256: string }[]): Promise<{ path: string; bodySha256: string }[]> {
    const verified: { path: string; bodySha256: string }[] = []
    for (const page of reviewedPages) {
      const receipt = draft.catalogPageReads?.find(read => read.draftVersion === draftVersion
        && read.activeIndexDigest === activeIndexDigest && read.path === page.path
        && read.title === page.title && read.version === page.version)
      if (receipt === undefined) this.refuse('compared-page-not-read')
      if (frozenBodies !== undefined && frozenBodies.find(item => item.path === page.path)?.bodySha256
        !== receipt.bodySha256) this.refuse('draft-operation-changed')
      let current: Awaited<ReturnType<typeof this.ctx.knowledgeController.read>>
      try {
        current = await this.ctx.knowledgeController.read(draft.targetProjectId,
          brandString<KnowledgeDocumentId>(page.path), signal)
      } catch (error) {
        if (remoteErrorOf(error)?.code === 'knowledge/document') this.refuse('draft-publication-changed')
        throw error
      }
      if (current.entry.status !== 'active'
        || current.entry.title !== page.title || current.entry.version !== page.version
        || createHash('sha256').update(current.body).digest('hex') !== receipt.bodySha256) {
        this.refuse('draft-publication-changed')
      }
      verified.push({ path: page.path, bodySha256: receipt.bodySha256 })
    }
    if (frozenBodies !== undefined && frozenBodies.length !== verified.length) this.refuse('draft-operation-changed')
    return verified
  }

  private comparedPageReview(record: KnowledgeImportRecord, changes: readonly KnowledgeImportReviewChange[],
    proposalMessageId: MessageId, proposalSha256: string): KnowledgeImportComparedPageReview {
    const expected = comparedPageChoices(changes)
    const retained = record.comparedPageReview
    const choices = retained?.proposalMessageId === proposalMessageId && retained.proposalSha256 === proposalSha256
      && sameComparedPageChoices(changes, retained.choices) ? retained.choices : expected
    return { choices, sha256: comparedPageReviewSha256(choices) }
  }

  private sourceDispositionReview(record: KnowledgeImportRecord, changes: readonly KnowledgeImportReviewChange[],
    proposalMessageId: MessageId, proposalSha256: string): KnowledgeImportSourceDispositionReview {
    const expected = sourceDispositionChoices(changes)
    const retained = record.sourceDispositionReview
    const choices = retained?.proposalMessageId === proposalMessageId && retained.proposalSha256 === proposalSha256
      && sameSourceDispositionChoices(changes, retained.choices) ? retained.choices : expected
    return { choices, sha256: sourceDispositionReviewSha256(choices) }
  }

  private async exactComparedPage(record: KnowledgeImportRecord, request: KnowledgeImportComparedPageReadRequest,
    signal: AbortSignal): Promise<{ review: KnowledgeImportComparedPageReview; target: KnowledgeImportComparedPageChoice }> {
    if (record.execution?.status !== 'accepted' || !usesTopicDiscovery(record.reviewFormat)) this.refuse('review-not-ready')
    const evidence = await this.sessionEvidence(record, signal)
    if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('review-not-ready')
    const proposal = settledProposal(evidence.events)
    const sha256 = proposal === null ? null : createHash('sha256').update(proposal.text).digest('hex')
    if (proposal === null || proposal.messageId !== request.proposalMessageId
      || sha256 !== request.expectedProposalSha256) this.refuse('proposal-changed')
    if (record.reviewDecisions?.some(decision => decision.proposalMessageId === proposal.messageId
      && decision.proposalSha256 === sha256)) this.refuse('review-not-ready')
    const verified = await this.verifyProposal(record, proposal.text, evidence.events, proposal.messageId, signal)
    if (verified.verification.status !== 'verified' || verified.changes === null) this.refuse('review-not-ready')
    const review = this.comparedPageReview(record, verified.changes, proposal.messageId, sha256)
    const target = review.choices.find(choice => choice.changeIndex === request.changeIndex
      && choice.pageIndex === request.pageIndex)
    if (target === undefined || target.changeSha256 !== request.changeSha256
      || target.targetProjectId !== request.targetProjectId || target.path !== request.path
      || target.version !== request.version || target.pageSha256 !== request.pageSha256) this.refuse('proposal-changed')
    return { review, target }
  }

  /** Serve one complete, version-matched compared page or fixed root and retain a bounded read receipt for this proposal.
   * @param workspaceId - original registered import project.
   * @param importId - frozen import identity.
   * @param request - exact Host-projected proposal and compared-page identity.
   * @param signal - cancels the read before its receipt is committed.
   * @returns full current body; a committed receipt can support a later human relation after restart.
   */
  @Remote
  readComparedPage(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportComparedPageReadRequest, signal: AbortSignal): Promise<KnowledgeImportComparedPageRead> {
    const parsed = comparedPageReadInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid compared-page read', {})
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      const { review, target } = await this.exactComparedPage(record, parsed.data, lifetime)
      if (review.sha256 !== parsed.data.expectedReviewSha256) this.refuse('review-revision-changed')
      const page = await this.ctx.knowledgeController.read(target.targetProjectId,
        brandString<KnowledgeDocumentId>(target.path), lifetime)
      if (page.entry.version !== target.version) this.refuse('compared-page-changed')
      const receipt = { changeIndex: target.changeIndex, pageIndex: target.pageIndex,
        changeSha256: target.changeSha256, targetProjectId: target.targetProjectId,
        path: target.path, version: target.version, pageSha256: target.pageSha256,
        proposalMessageId: parsed.data.proposalMessageId,
        proposalSha256: parsed.data.expectedProposalSha256,
        bodySha256: createHash('sha256').update(page.body).digest('hex') }
      const reads = (record.comparedPageReads ?? []).filter(read =>
        read.proposalMessageId === receipt.proposalMessageId && read.proposalSha256 === receipt.proposalSha256
        && (read.changeIndex !== target.changeIndex || read.pageIndex !== target.pageIndex))
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      await this.table.put(importId, { ...record, comparedPageReads: [...reads, receipt] })
      return { kind: page.entry.kind, path: page.entry.id, version: page.entry.version, body: page.body }
    })
  }

  /** Save one human relationship judgment for a current Host-verified active creation without approving a write.
   * @param workspaceId - original registered import project.
   * @param importId - frozen import identity.
   * @param request - exact proposal, compared page and previously displayed choice digest.
   * @param signal - cancels verification before persistence; committed choices survive cancellation.
   * @returns durable complete choice set, with all unselected pages remaining unknown.
   */
  @Remote
  setComparedPageDecision(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportComparedPageDecision, signal: AbortSignal): Promise<KnowledgeImportComparedPageReview> {
    const parsed = comparedPageDecisionInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid compared-page decision', {})
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      const { review, target } = await this.exactComparedPage(record, parsed.data, lifetime)
      if (review.sha256 !== parsed.data.expectedReviewSha256) this.refuse('review-revision-changed')
      if (parsed.data.relation !== 'unknown') {
        const receipt = record.comparedPageReads?.find(read => matchesComparedPageRead(read, parsed.data))
        if (receipt === undefined) this.refuse('compared-page-not-read')
        const current = await this.ctx.knowledgeController.read(target.targetProjectId,
          brandString<KnowledgeDocumentId>(target.path), lifetime)
        if (current.entry.version !== target.version
          || createHash('sha256').update(current.body).digest('hex') !== receipt.bodySha256) {
          this.refuse('compared-page-changed')
        }
      }
      const choices = review.choices.map(choice => choice.changeIndex === target.changeIndex
        && choice.pageIndex === target.pageIndex ? { ...choice, relation: parsed.data.relation } : choice)
      const next: KnowledgeImportRecord = { ...record, comparedPageReview: {
        proposalMessageId: parsed.data.proposalMessageId,
        proposalSha256: parsed.data.expectedProposalSha256, choices,
      } }
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      await this.table.put(importId, next)
      return { choices, sha256: comparedPageReviewSha256(choices) }
    })
  }

  /** Save one explicit human assessment of a model-labelled source without approving publication.
   * @param workspaceId - original registered import project.
   * @param importId - frozen import identity.
   * @param request - exact proposal, source assessment and previous choice digest.
   * @param signal - cancels verification before persistence; committed choices survive cancellation.
   * @returns durable complete source-choice set, with other sources left unknown.
   */
  @Remote
  setSourceDispositionDecision(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportSourceDispositionDecision, signal: AbortSignal): Promise<KnowledgeImportSourceDispositionReview> {
    const parsed = sourceDispositionDecisionInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid source disposition decision', {})
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      if (record.execution?.status !== 'accepted' || record.reviewFormat !== 'brain-review-json-v6') {
        this.refuse('review-not-ready')
      }
      const evidence = await this.sessionEvidence(record, lifetime)
      if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('review-not-ready')
      const proposal = settledProposal(evidence.events)
      const sha256 = proposal === null ? null : createHash('sha256').update(proposal.text).digest('hex')
      if (proposal === null || proposal.messageId !== parsed.data.proposalMessageId
        || sha256 !== parsed.data.expectedProposalSha256) this.refuse('proposal-changed')
      if (record.reviewDecisions?.some(decision => decision.proposalMessageId === proposal.messageId
        && decision.proposalSha256 === sha256)) this.refuse('review-not-ready')
      const verified = await this.verifyProposal(record, proposal.text, evidence.events, proposal.messageId, lifetime)
      if (verified.verification.status !== 'verified' || verified.changes === null) this.refuse('review-not-ready')
      const review = this.sourceDispositionReview(record, verified.changes, proposal.messageId, sha256)
      if (review.sha256 !== parsed.data.expectedReviewSha256) this.refuse('review-revision-changed')
      const target = review.choices.find(choice => choice.changeIndex === parsed.data.changeIndex
        && choice.sourceIndex === parsed.data.sourceIndex)
      if (target === undefined || target.changeSha256 !== parsed.data.changeSha256
        || target.documentId !== parsed.data.documentId
        || target.dispositionSha256 !== parsed.data.dispositionSha256) this.refuse('proposal-changed')
      const choices = review.choices.map(choice => choice.changeIndex === target.changeIndex
        && choice.sourceIndex === target.sourceIndex ? { ...choice, judgment: parsed.data.judgment } : choice)
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      await this.table.put(importId, { ...record, sourceDispositionReview: {
        proposalMessageId: proposal.messageId, proposalSha256: sha256, choices,
      } })
      return { choices, sha256: sourceDispositionReviewSha256(choices) }
    })
  }

  /**
   * Read the complete original PDF or DOCX behind one selected review source, without granting a general attachment read.
   * @param sessionId - retained import Session carrying the exact selection and admitted input.
   * @param documentId - document identity from that import's frozen manifest, not an attachment id or path.
   * @param signal - cancels Session and attachment reads before any bytes are returned.
   * @returns original bytes only after the complete stored file matches its frozen size and digest.
   */
  @Remote
  async readReviewSource(sessionId: SessionId, documentId: DocumentImportSourceId,
    signal: AbortSignal): Promise<KnowledgeImportReviewSource> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    const record = this.forSession(sessionId)
    if (record === undefined) this.refuse('import-not-found')
    this.assertOwner(record, record.workspaceId)
    if (record.execution?.status !== 'accepted') this.refuse('review-not-ready')
    const evidence = await this.sessionEvidence(record, lifetime)
    if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('review-not-ready')
    const document = record.manifest.documents.find(item => item.id === documentId)
    if (document === undefined || document.format === 'text') this.refuse('document-not-in-selection')
    const receipt = record.receipts.find(item => item.id === documentId)
    /* v8 ignore if -- Accepted execution validation requires a retained receipt for each selected document. */
    if (receipt === undefined) this.refuse('documents-not-ready')
    if (document.bytes > this.config.maxSourceBytes || receipt.source.bytes !== document.bytes
      || receipt.source.name !== document.name) this.refuse('source-changed')
    const digest = createHash('sha256')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of this.ctx.attachments.readFileStream(receipt.source, lifetime)) {
      lifetime.throwIfAborted()
      if (chunk.byteLength > document.bytes - size || chunk.byteLength > this.config.maxSourceBytes - size) {
        this.refuse('source-changed')
      }
      const bytes = Buffer.from(chunk)
      digest.update(bytes)
      chunks.push(bytes)
      size += bytes.byteLength
    }
    lifetime.throwIfAborted()
    if (digest.digest('hex') !== document.sha256) this.refuse('source-changed')
    return { id: document.id, name: document.name, format: document.format, bytes: size,
      sha256: document.sha256, dataBase64: Buffer.concat(chunks, size).toString('base64') }
  }

  /**
   * Persist one explicit decision over the currently settled proposal; a later rejection revokes approval.
   * @param workspaceId - original registered project.
   * @param importId - frozen import identity.
   * @param request - idempotent decision with optimistic review revision and exact proposal message identity.
   * @param signal - caller cancellation; an already durable decision remains committed.
   * @returns current durable state after the decision; approval rechecks compared pages, while rejection checks ordered-step receipts.
   */
  @Remote
  decideReview(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportReviewDecision, signal: AbortSignal): Promise<KnowledgeImportState> {
    const parsed = reviewDecisionInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid knowledge import review decision', {})
    return this.run(importId, signal, async (lifetime) => {
      const record = this.record(workspaceId, importId)
      if (record.manifest.maintenance !== undefined) this.refuse('review-not-ready')
      const prior = record.reviewDecisions?.find(decision => decision.operationId === parsed.data.operationId)
      if (prior !== undefined) {
        if (prior.decision !== parsed.data.decision || prior.proposalMessageId !== parsed.data.proposalMessageId
          || prior.proposalSha256 !== parsed.data.expectedProposalSha256
          || prior.comparedPageReviewSha256 !== parsed.data.expectedComparedPageReviewSha256
          || prior.sourceDispositionReviewSha256 !== parsed.data.expectedSourceDispositionReviewSha256) {
          this.refuse('review-operation-changed')
        }
        return this.state(prior.approvedThroughSeq === null && record.reviewDecisions?.at(-1) === prior
          ? await this.finalizeApprovalBoundary(record, lifetime) : record)
      }
      if (record.execution?.status !== 'accepted') this.refuse('review-not-ready')
      if ((record.reviewDecisions?.length ?? 0) !== parsed.data.expectedRevision) this.refuse('review-revision-changed')
      const evidence = await this.sessionEvidence(record, lifetime)
      if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('review-not-ready')
      const proposal = settledProposal(evidence.events)
      if (proposal === null) this.refuse('review-not-ready')
      if (proposal.messageId !== parsed.data.proposalMessageId) this.refuse('proposal-changed')
      const proposalSha256 = createHash('sha256').update(proposal.text).digest('hex')
      if (proposalSha256 !== parsed.data.expectedProposalSha256) this.refuse('proposal-changed')
      const proposalChanges = this.proposalChanges(record, proposal.text)
      const plan = proposalChanges === null ? null : this.orderedPlan(record, proposalChanges)
      if (parsed.data.decision === 'reject' && plan !== null && proposalChanges !== null
        && record.reviewDecisions?.some(decision => decision.decision === 'approve'
          && decision.proposalMessageId === proposal.messageId && decision.proposalSha256 === proposalSha256)) {
        const progress = await this.orderedProgress(record, plan, proposalChanges, evidence.events,
          proposal.messageId, proposalSha256, lifetime)
        if (progress.nextChangeIndex >= (plan.kind === 'mixed' ? 2 : 1)
          || progress.status !== 'ready' && progress.status !== 'partially-applied'
            && !(progress.status === 'blocked' && progress.reason !== 'step-receipt-missing'
              && progress.reason !== 'review-rejected')) {
          this.refuse('review-not-ready')
        }
      }
      const review = parsed.data.decision === 'approve'
        ? await this.verifyProposal(record, proposal.text, evidence.events, proposal.messageId, lifetime) : null
      const changes = review?.verification.status === 'verified' ? review.changes : null
      if (parsed.data.decision === 'approve' && changes === null) this.refuse('review-not-ready')
      const comparedReview = parsed.data.decision === 'approve' && usesTopicDiscovery(record.reviewFormat)
        && changes !== null ? this.comparedPageReview(record, changes, proposal.messageId, proposalSha256) : undefined
      if (comparedReview !== undefined && comparedReview.choices.length > 0
        && (parsed.data.expectedComparedPageReviewSha256 !== comparedReview.sha256
          || comparedReview.choices.some(choice => choice.relation !== 'distinct'))) {
        this.refuse('compared-page-review-required')
      }
      const sourceReview = parsed.data.decision === 'approve' && record.reviewFormat === 'brain-review-json-v6'
        && changes !== null ? this.sourceDispositionReview(record, changes, proposal.messageId, proposalSha256) : undefined
      if (sourceReview !== undefined && sourceReview.choices.length > 0
        && (parsed.data.expectedSourceDispositionReviewSha256 !== sourceReview.sha256
          || sourceReview.choices.some(choice => choice.judgment !== 'confirmed'))) {
        this.refuse('source-review-required')
      }
      const activeIndexDigests: Record<string, string> = {}
      for (const [projectId, paths] of record.reviewFormat === undefined ? [] : this.activeCreationPaths(changes ?? [])) {
        const digest = await this.activeIndexDigest(projectId, paths, lifetime)
        if (digest === null) this.refuse('review-not-ready')
        activeIndexDigests[projectId] = digest
      }
      const latestTurn = evidence.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
      if (latestTurn?.type !== 'turn/end') this.refuse('review-not-ready')
      lifetime.throwIfAborted()
      this.assertOwner(record, workspaceId)
      const next: KnowledgeImportRecord = { ...record,
        ...record.sessionBinding === undefined ? { sessionBinding: {
          createdAt: evidence.header.createdAt, ...evidence.header.cwd === undefined ? {} : { cwd: evidence.header.cwd },
        } } : {},
        reviewDecisions: [...record.reviewDecisions ?? [], {
          operationId: parsed.data.operationId, decision: parsed.data.decision,
          proposalMessageId: proposal.messageId, proposalSha256,
          ...changes === null ? {} : { changes: changes.map(approvedChange), changesSha256: reviewChangesSha256(changes) },
          ...changes === null || record.reviewFormat === undefined ? {} : { receiptsSha256: this.receiptsSha256(record) },
          ...!usesTopicDiscovery(record.reviewFormat) || review?.discovery === undefined ? {} : {
            discovery: review.discovery.map(item => ({ ...item, hits: item.hits.map(hit => ({ ...hit })) })),
            discoverySha256: this.discoverySha256(review.discovery),
          },
          ...comparedReview === undefined || comparedReview.choices.length === 0 ? {} : {
            comparedPageChoices: comparedReview.choices.map(choice => ({ ...choice })),
            comparedPageReviewSha256: comparedReview.sha256,
          },
          ...sourceReview === undefined || sourceReview.choices.length === 0 ? {} : {
            sourceDispositionChoices: sourceReview.choices.map(choice => ({ ...choice })),
            sourceDispositionReviewSha256: sourceReview.sha256,
          },
          ...Object.keys(activeIndexDigests).length === 0 ? {} : { activeIndexDigests },
          ...changes === null || this.orderedPlan(record, changes) === null ? {} : { appliedSteps: [] },
          ...record.reviewFormat === 'brain-review-json-v6' && parsed.data.decision === 'approve'
            ? { approvedThroughSeq: null } : {},
          decidedAt: Date.now(),
        }],
      }
      await this.table.put(importId, next)
      lifetime.throwIfAborted()
      return this.state(await this.finalizeApprovalBoundary(next, lifetime))
    })
  }

  /** Save one held active-creation proposal as a real Brain draft, without approving another plan step.
   * @param workspaceId - original import owner.
   * @param importId - retained source selection.
   * @param request - separately retained human save operation and exact proposal change.
   * @param signal - cancellation before writer admission; an existing receipt survives it.
   * @returns durable import state with the draft save receipt when the draft write succeeds.
   * @throws `proposal-changed` when the latest settled Session proposal differs before a first save intent is retained.
   */
  @Remote
  saveZeroHitDraft(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportSaveDraftRequest, signal: AbortSignal): Promise<KnowledgeImportState> {
    const parsed = saveDraftInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid zero-hit draft save', {})
    return this.run(importId, signal, async (lifetime) => {
      let record = this.record(workspaceId, importId)
      if (record.manifest.maintenance !== undefined) this.refuse('draft-not-ready')
      if (record.execution?.status !== 'accepted' || !usesTopicDiscovery(record.reviewFormat)) this.refuse('draft-not-ready')
      const prior = record.zeroHitDraft
      if (prior !== undefined && (prior.operationId !== parsed.data.operationId
        || prior.proposalMessageId !== parsed.data.proposalMessageId
        || prior.proposalSha256 !== parsed.data.expectedProposalSha256
        || prior.changeIndex !== parsed.data.changeIndex
        || prior.changeSha256 !== parsed.data.expectedChangeSha256)) this.refuse('draft-operation-changed')
      if (prior?.savedVersion !== undefined) return this.state(record)
      const evidence = await this.sessionEvidence(record, lifetime)
      if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('draft-not-ready')
      const proposalText = retainedProposal(evidence.events, parsed.data.proposalMessageId)
      if (proposalText === null || createHash('sha256').update(proposalText).digest('hex')
        !== parsed.data.expectedProposalSha256) this.refuse('proposal-changed')
      if (prior === undefined && settledProposal(evidence.events)?.messageId !== parsed.data.proposalMessageId) {
        this.refuse('proposal-changed')
      }
      const latestDecision = record.reviewDecisions?.at(-1)
      if (prior === undefined && latestDecision?.decision === 'reject'
        && latestDecision.proposalMessageId === parsed.data.proposalMessageId
        && latestDecision.proposalSha256 === parsed.data.expectedProposalSha256) this.refuse('draft-not-ready')
      const changes = this.proposalChanges(record, proposalText)
      const plan = changes === null ? null : this.orderedPlan(record, changes)
      if (changes === null || plan === null || plan.create.sha256 !== parsed.data.expectedChangeSha256
        || (plan.kind === 'mixed' ? 1 : 0) !== parsed.data.changeIndex) this.refuse('draft-not-ready')
      const source = plan.create.evidence?.sources[0]
      if (source === undefined || source.quote.trim() === '') this.refuse('draft-not-ready')
      if (prior === undefined) {
        const verified = await this.verifyProposal(record, proposalText, evidence.events,
          parsed.data.proposalMessageId, lifetime)
        let holdReason = heldDraftReason(verified.verification.reason)
        if (holdReason === undefined && record.reviewDecisions?.at(-1)?.decision === 'approve') {
          const progress = await this.orderedProgress(record, plan, changes, evidence.events,
            parsed.data.proposalMessageId, parsed.data.expectedProposalSha256, lifetime)
          holdReason = progress.status === 'blocked' ? heldDraftReason(progress.reason) : undefined
        }
        if (holdReason === undefined) this.refuse('draft-not-ready')
        const index = await this.activeIndexState(plan.projectId, new Set(), lifetime)
        if (index === null || (holdReason !== 'source-conflict-draft-required' && index.authoredDocumentCount === 0)
          || index.occupiedPaths.has(plan.newPath)) {
          this.refuse('draft-not-ready')
        }
        const currentEvidence = await this.sessionEvidence(record, lifetime)
        const currentProposal = currentEvidence !== null && this.matchesEvidence(record, currentEvidence)
          ? settledProposal(currentEvidence.events) : null
        if (currentProposal?.messageId !== parsed.data.proposalMessageId
          || createHash('sha256').update(currentProposal.text).digest('hex')
            !== parsed.data.expectedProposalSha256) this.refuse('proposal-changed')
        record = { ...record, zeroHitDraft: {
          operationId: parsed.data.operationId, proposalMessageId: parsed.data.proposalMessageId,
          proposalSha256: parsed.data.expectedProposalSha256, changeIndex: parsed.data.changeIndex,
          changeSha256: parsed.data.expectedChangeSha256, targetProjectId: plan.projectId,
          path: plan.newPath, sourceDocumentId: source.document_id, sourceQuote: source.quote,
          reason: holdReason,
          originalTitle: plan.create.arguments.title as string,
          originalBodySha256: createHash('sha256').update((plan.create.arguments.truth as string)
            .replaceAll('\r\n', '\n').trim()).digest('hex'),
          baselineActiveIndexDigest: index.digest,
        } }
        lifetime.throwIfAborted()
        await this.table.put(importId, record)
      }
      const intent = record.zeroHitDraft
      assert(intent !== undefined, 'Held import draft must retain its durable write intent')
      if (intent.sourceDocumentId !== source.document_id || intent.sourceQuote !== source.quote) {
        this.refuse('draft-operation-changed')
      }
      const args = plan.create.arguments
      const createRequest: KnowledgePageCreate = {
        operationId: brandString<KnowledgeUpdateId>(intent.operationId),
        title: args.title as string, status: 'draft', category: args.category as KnowledgePageCreate['category'],
        tags: args.tags as string[], truth: args.truth as string, kind: args.kind as KnowledgePageCreate['kind'],
        summary: args.summary as string, source: `knowledge-import:${importId}`, evidence: intent.sourceQuote,
      }
      const hold: KnowledgeImportPublicationHold = {
        version: 1, importId, proposalMessageId: intent.proposalMessageId,
        proposalSha256: intent.proposalSha256, changeSha256: intent.changeSha256,
        draftOperationId: createRequest.operationId,
      }
      const receipt = await this.withBrainWriter(() => this.ctx.knowledgeController.createHeldImportDraft(intent.targetProjectId,
        brandString<KnowledgeDocumentId>(intent.path), createRequest, hold, lifetime, async (retry) => {
          const current = this.record(workspaceId, importId)
          if (current.zeroHitDraft?.operationId !== intent.operationId
            || current.zeroHitDraft.proposalSha256 !== intent.proposalSha256
            || this.proposalChanges(current, proposalText) === null) this.refuse('draft-operation-changed')
          if (retry) return
          const index = await this.activeIndexState(intent.targetProjectId, new Set(), lifetime)
          if (index === null || index.digest !== intent.baselineActiveIndexDigest
            || index.occupiedPaths.has(intent.path)) this.refuse('draft-publication-changed')
        }))
      const saved = await this.ctx.knowledgeController.read(intent.targetProjectId,
        brandString<KnowledgeDocumentId>(intent.path), lifetime)
      if (saved.entry.kind !== 'page' || saved.entry.status !== 'draft' || saved.entry.version !== receipt.version) {
        this.refuse('draft-publication-changed')
      }
      record = { ...record, zeroHitDraft: { ...intent, savedVersion: receipt.version } }
      await this.table.put(importId, record)
      return this.state(record)
    })
  }

  /** Publish a held draft only after a new explicit human operation confirms its exact saved version and active catalog.
   * @param workspaceId - original import owner.
   * @param importId - retained source selection.
   * @param request - separate publication UUID and the reviewer-observed Brain versions.
   * @param signal - cancellation before writer admission; committed status receipts remain recoverable.
   * @returns durable import state with the exact status writer receipt.
   */
  @Remote
  publishZeroHitDraft(workspaceId: WorkspaceId, importId: KnowledgeImportId,
    request: KnowledgeImportPublishDraftRequest, signal: AbortSignal): Promise<KnowledgeImportState> {
    const parsed = publishDraftInput.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid zero-hit draft publication', {})
    return this.run(importId, signal, async (lifetime) => {
      let record = this.record(workspaceId, importId)
      if (record.manifest.maintenance !== undefined) this.refuse('draft-not-ready')
      const draft = record.zeroHitDraft
      if (draft?.reason === 'source-conflict-draft-required') this.refuse('draft-not-ready')
      if (draft?.operationId !== parsed.data.draftOperationId || draft.savedVersion === undefined
        || parsed.data.operationId === draft.operationId) this.refuse('draft-not-ready')
      const prior = draft.publication
      const reviewedPages = parsed.data.reviewedPages
      const sameReviewedPages = (pages: readonly { path: string; title: string; version: string }[]): boolean =>
        canonicalReviewJson(reviewedPages.map(({ path, title, version }) => ({ path, title, version })))
          === canonicalReviewJson(pages)
          && reviewedPages.every(page => page.relation === 'distinct')
      if (prior?.operationId === parsed.data.operationId
        && (prior.expectedDraftVersion !== parsed.data.expectedDraftVersion
          || prior.expectedActiveIndexDigest !== parsed.data.expectedActiveIndexDigest
          || (prior.reviewedPages === undefined ? prior.publishedVersion === undefined
            : canonicalReviewJson(prior.reviewedPages) !== canonicalReviewJson(reviewedPages)))) {
        this.refuse('draft-operation-changed')
      }
      if (prior !== undefined && (prior.operationId !== parsed.data.operationId
        || prior.expectedDraftVersion !== parsed.data.expectedDraftVersion
        || prior.expectedActiveIndexDigest !== parsed.data.expectedActiveIndexDigest)) {
        const observed = await this.inspectZeroHitDraft(draft, lifetime)
        if (prior.publishedVersion !== undefined || observed.phase !== 'saved' && observed.phase !== 'edited'
          || observed.current?.version !== parsed.data.expectedDraftVersion
          || observed.current.activeIndexDigest !== parsed.data.expectedActiveIndexDigest) {
          this.refuse('draft-operation-changed')
        }
      }
      if (prior?.publishedVersion !== undefined) return this.state(record)
      if (!reviewedPages.every(page => page.relation === 'distinct')) this.refuse('draft-publication-changed')
      if (prior?.operationId === parsed.data.operationId && prior.reviewedPageBodies === undefined) {
        this.refuse('draft-operation-changed')
      }
      if (prior === undefined || prior.operationId !== parsed.data.operationId) {
        const observed = await this.inspectZeroHitDraft(draft, lifetime)
        if (observed.phase !== 'saved' && observed.phase !== 'edited'
          || observed.current?.version !== parsed.data.expectedDraftVersion
          || observed.current.activeIndexDigest !== parsed.data.expectedActiveIndexDigest) {
          this.refuse('draft-publication-changed')
        }
        if (!sameReviewedPages(observed.current.activePages)) this.refuse('draft-publication-changed')
        const reviewedPageBodies = await this.assertHeldCatalogPageReads(draft, reviewedPages, parsed.data.expectedDraftVersion,
          parsed.data.expectedActiveIndexDigest, lifetime)
        record = { ...record, zeroHitDraft: { ...draft, publication: {
          operationId: parsed.data.operationId, expectedDraftVersion: parsed.data.expectedDraftVersion,
          expectedActiveIndexDigest: parsed.data.expectedActiveIndexDigest, reviewedPages, reviewedPageBodies,
        } } }
        lifetime.throwIfAborted()
        await this.table.put(importId, record)
      }
      const currentDraft = record.zeroHitDraft
      /* v8 ignore if -- The captured record retains its prior publication or the intent just constructed above. */
      if (currentDraft?.publication === undefined) this.refuse('draft-not-ready')
      const publication = currentDraft.publication
      const hold: KnowledgeImportPublicationHold = {
        version: 1, importId, proposalMessageId: currentDraft.proposalMessageId,
        proposalSha256: currentDraft.proposalSha256, changeSha256: currentDraft.changeSha256,
        draftOperationId: brandString<KnowledgeUpdateId>(currentDraft.operationId),
      }
      const statusRequest: KnowledgePageStatusUpdate = {
        operationId: brandString<KnowledgeUpdateId>(parsed.data.operationId),
        expectedVersion: parsed.data.expectedDraftVersion, status: 'active',
        reason: 'Explicit publication of the reviewed import draft.',
        source: 'human:knowledge-import-review',
        evidence: `Confirmed draft ${currentDraft.path} from import ${importId} at ${parsed.data.expectedDraftVersion}.`,
      }
      const receipt = await this.withBrainWriter(() => this.ctx.knowledgeController.publishHeldImportDraft(currentDraft.targetProjectId,
        brandString<KnowledgeDocumentId>(currentDraft.path), statusRequest, hold, lifetime, async (retry) => {
          const latest = this.record(workspaceId, importId).zeroHitDraft
          if (latest?.operationId !== currentDraft.operationId
            || latest.publication?.operationId !== parsed.data.operationId) this.refuse('draft-operation-changed')
          if (retry) return
          const index = await this.activeIndexState(currentDraft.targetProjectId, new Set([currentDraft.path]), lifetime)
          if (index === null || index.digest !== parsed.data.expectedActiveIndexDigest) {
            this.refuse('draft-publication-changed')
          }
          if (!sameReviewedPages(index.activePages)) this.refuse('draft-publication-changed')
          await this.assertHeldCatalogPageReads(currentDraft, reviewedPages, parsed.data.expectedDraftVersion,
            parsed.data.expectedActiveIndexDigest, lifetime, publication.reviewedPageBodies)
        }))
      const committedDraft = { ...currentDraft, publication: { ...publication, publishedVersion: receipt.version } }
      record = { ...record, zeroHitDraft: committedDraft }
      let receiptSaved = true
      try {
        await this.table.put(importId, record)
      } catch {
        receiptSaved = false
      }
      if (!receiptSaved) return this.state(record)
      let publicationReview: KnowledgeImportPublicationReview
      if (receipt.disposition === 'already-applied') {
        publicationReview = { status: 'unknown', reason: 'receipt-recovered' }
      } else {
        try {
          const observed = await this.activeIndexState(currentDraft.targetProjectId,
            new Set([currentDraft.path]), new AbortController().signal)
          publicationReview = observed === null ? { status: 'unknown', reason: 'catalog-unavailable' }
            : observed.digest === parsed.data.expectedActiveIndexDigest
              ? { status: 'verified', observedActiveIndexDigest: observed.digest }
              : { status: 'required', reason: 'active-catalog-changed', observedActiveIndexDigest: observed.digest }
        } catch {
          publicationReview = { status: 'unknown', reason: 'catalog-unavailable' }
        }
      }
      record = { ...record, zeroHitDraft: { ...committedDraft, publication: {
        ...committedDraft.publication, review: publicationReview,
      } } }
      let reviewSaved = true
      try {
        await this.table.put(importId, record)
      } catch {
        reviewSaved = false
      }
      return this.state(reviewSaved ? record : { ...record, zeroHitDraft: committedDraft })
    })
  }

  private async finalizeApprovalBoundary(record: KnowledgeImportRecord, signal: AbortSignal): Promise<KnowledgeImportRecord> {
    const latest = record.reviewDecisions?.at(-1)
    if (record.reviewFormat !== 'brain-review-json-v6' || latest?.decision !== 'approve'
      || latest.approvedThroughSeq !== null) return record
    const resolved = await this.ctx.sessionController.resolveAgent(record.sessionId)
    if ('error' in resolved) this.refuse('review-not-ready')
    const session = resolved.agent.session
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    if (!this.matchesEvidence(record, { header: session.header, events })) this.refuse('review-not-ready')
    let marker = events.find(event => event.type === 'plugin:dsh-brain/knowledge-import-review-approved'
      && event.data.importId === record.manifest.id && event.data.operationId === latest.operationId
      && event.data.proposalMessageId === latest.proposalMessageId)
    const preceding = marker === undefined ? events : events.slice(0, marker.seq)
    const proposal = settledProposal(preceding)
    const latestTurn = preceding.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (proposal?.messageId !== latest.proposalMessageId
      || createHash('sha256').update(proposal.text).digest('hex') !== latest.proposalSha256
      || latestTurn?.type !== 'turn/end') this.refuse('proposal-changed')
    signal.throwIfAborted()
    if (marker === undefined) {
      const seq = appendPluginRecord(session, 'plugin:dsh-brain/knowledge-import-review-approved', {
        importId: record.manifest.id, operationId: latest.operationId,
        proposalMessageId: latest.proposalMessageId,
      })
      marker = session.eventAt(seq)
      if (marker === undefined) throw new Error('Import approval boundary was not retained')
    }
    if (!await this.ctx.sessions.flush(session)) {
      throw new RemoteError('gateway/internal', 'knowledge import approval Session is not durable', {})
    }
    const decided = { ...record, reviewDecisions: [...(record.reviewDecisions?.slice(0, -1) ?? []), {
      ...latest, approvedThroughSeq: marker.seq, approvedAt: marker.time,
    }] }
    signal.throwIfAborted()
    await this.table.put(record.manifest.id, decided)
    return decided
  }

  private async state(record: KnowledgeImportRecord,
    evidence?: { header: SessionHeader; events: readonly SessionEvent[] } | null): Promise<KnowledgeImportState> {
    const created = await this.ctx.sessionPersistence.stat(record.sessionId)
    const latest = record.reviewDecisions?.at(-1)
    const needsMarker = record.reviewFormat === 'brain-review-json-v6' && latest?.decision === 'approve'
      && typeof latest.approvedThroughSeq === 'number'
    const observed = needsMarker && created !== undefined
      ? evidence === undefined ? await this.sessionEvidence(record, this.lifetime.signal) : evidence : null
    const markerReady = observed !== null && this.matchesEvidence(record, observed)
      && this.approvalMarkerSeq(record, observed.events) !== null
    return { ...importState(record, created !== undefined, markerReady),
      ...created === undefined || record.abandonedAt !== undefined || record.execution?.status === 'accepted'
        || !await this.canAbandonCreated(record, created.header, this.lifetime.signal) ? {} : {
          createdAbandonable: true as const,
        },
      ...created === undefined || record.abandonedAt !== undefined || record.execution?.status === 'accepted' ? {} : {
        sessionRecovery: await this.ownsInterruptedSession(record, created.header, this.lifetime.signal)
          ? 'delivery-unconfirmed' as const : 'identity-unconfirmed' as const,
      } }
  }

  private workspace(workspaceId: WorkspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RemoteError('workspace/not-found', 'knowledge import project is unavailable', { workspaceId })
    return workspace
  }

  private assertOwner(record: KnowledgeImportRecord, workspaceId: WorkspaceId): void {
    if (record.workspaceId !== workspaceId || record.workspacePath !== this.workspace(workspaceId).path) {
      this.refuse('project-changed')
    }
    this.assertScope(workspaceId, record.manifest)
  }

  private forSession(sessionId: SessionId): KnowledgeImportRecord | undefined {
    return [...this.table.entries()].find(([, record]) => record.sessionId === sessionId)?.[1]
  }

  private scheduleAutomaticImport(sessionId: SessionId): void {
    const found = this.forSession(sessionId)
    if (found?.automatic === undefined || this.lifetime.signal.aborted) return
    if (this.automaticOperations.has(found.manifest.id)) {
      this.automaticReschedules.add(found.manifest.id)
      return
    }
    const id = found.manifest.id
    const pending = this.operations.get(id)
    const work = Promise.resolve(pending).catch((error: unknown) => {
      // The finishing import command owns its error; a completed review may still need receipt inspection.
      void error
    }).then(async () => {
      if (this.lifetime.signal.aborted) return
      await this.run(id, this.lifetime.signal, async (signal) => {
        const record = this.record(found.workspaceId, id)
        if (record.execution?.status === 'accepted' && record.automatic !== undefined
          && ['reviewing', 'applying'].includes(record.automatic.status)) await this.settleAutomaticImport(record, signal)
      })
    }).catch(async (error: unknown) => {
      if (this.lifetime.signal.aborted) return
      const record = this.table.get(id)
      if (record?.automatic === undefined || this.operations.has(id)) return
      // Retain the exact pending request; a lost result is inspected, never replaced with a new operation UUID.
      await this.persistAutomaticImport(id, { ...record, automatic: { ...record.automatic, status: 'failed', reason: 'unknown' } })
      void error
    }).finally(() => {
      this.automaticOperations.delete(id)
      if (this.automaticReschedules.delete(id)) this.scheduleAutomaticImport(sessionId)
    })
    this.automaticOperations.set(id, work)
  }

  private ensureAutomaticRecordCapacity(record: KnowledgeImportRecord): void {
    const policy = this.ctx.knowledgeController.automaticMaintenancePolicy()
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > policy.maxRecordBytes) {
      throw new Error('Complete AI import record exceeds maxRecordBytes; previous receipts remain retained')
    }
  }

  private async persistAutomaticImport(id: KnowledgeImportId, record: KnowledgeImportRecord): Promise<void> {
    this.ensureAutomaticRecordCapacity(record)
    await this.table.put(id, record)
  }

  /** Resume only this new automatic import's frozen authority and exact uncertain operation.
   * @param sessionId - original automatically maintained import conversation, never a legacy held draft.
   * @param signal - caller lifetime; cancellation cannot retract a committed file receipt.
   * @returns current metadata after exact receipt recovery or one newly logged bounded review input.
   */
  @Remote
  resumeAutomaticMaintenance(sessionId: SessionId, signal: AbortSignal): Promise<KnowledgeImportState> {
    const found = this.forSession(sessionId)
    if (found?.automatic === undefined || found.manifest.maintenance !== 'automatic') this.refuse('review-not-ready')
    return this.run(found.manifest.id, signal, async (live) => {
      let record = this.record(found.workspaceId, found.manifest.id)
      if (record.automatic === undefined || record.execution?.status !== 'accepted') this.refuse('review-not-ready')
      if (record.automatic.status === 'applying' || record.automatic.pending !== undefined) {
        await this.settleAutomaticImport(record, live)
      } else if (['deferred', 'failed', 'budget-stopped'].includes(record.automatic.status)) {
        record = { ...record, automatic: { ...record.automatic, budgetStart: record.automatic.rounds } }
        await this.queueAutomaticImportReview(record, live)
      } else if (record.automatic.status === 'reviewing') await this.settleAutomaticImport(record, live)
      return this.state(this.record(found.workspaceId, found.manifest.id))
    })
  }

  private async queueAutomaticImportReview(record: KnowledgeImportRecord, signal: AbortSignal): Promise<void> {
    const automatic = record.automatic
    /* v8 ignore if -- Resume and settlement call this only with an accepted automatic import or its retained copy. */
    if (automatic === undefined || record.manifest.maintenance !== 'automatic') this.refuse('review-not-ready')
    this.assertOwner(record, record.workspaceId)
    const found = await this.ctx.sessionController.resolveAgent(record.sessionId)
    if ('error' in found) throw found.error
    if (!this.matchesSession(record, found.agent.session)) this.refuse('session-unverified')
    let next = record
    if (automatic.continuation === undefined) {
      const catalog = await this.ctx.knowledgeController.automaticMaintenanceCatalog(record.workspaceId, signal)
      const policy = this.ctx.knowledgeController.automaticMaintenancePolicy()
      const sources = await automaticImportSources(this.ctx, record, policy.maxReviewBytes, signal)
      const selectionEvidence = await this.sessionEvidence(record, signal)
      if (selectionEvidence === null) this.refuse('session-unverified')
      const choice = selectionEvidence.events.findLast(event => event.type === 'model/selection' || event.type === 'request/header')
      const selected = choice?.type === 'model/selection' ? {
        provider: choice.data.provider, model: choice.data.model,
        ...choice.data.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.data.reasoningEffort) },
      } : choice?.type === 'request/header' ? choice.data.header.config : record.execution?.selection
      /* v8 ignore if -- Every queue caller retains accepted execution with its schema-required model selection. */
      if (selected === undefined) throw new Error('Automatic import needs its actual Session model selection')
      const prepared = await this.ctx.llm.prepareCall(await this.ctx.llm.resolveCallConfig({
        provider: selected.provider, model: selected.model,
        ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
      }, signal), signal)
      const frozenVisual = automatic.visual ?? record.execution
      const pdfVisual = frozenVisual?.pdfVisual, docxVisual = frozenVisual?.docxVisual
      const reusable = prepared.inputModalities?.includes('image') === true
        && pdfVisual !== undefined && docxVisual !== undefined
        && pdfVisual.every(item => item.coverage.omittedReason === undefined)
        && docxVisual.every(item => item.coverage.omittedImages.length === 0)
      const visual = reusable ? { pdfVisual, docxVisual }
        : await this.compileVisualEvidence(record, prepared.inputModalities?.includes('image') === true, signal)
      const retainedVisual = { pdfVisual: visual.pdfVisual, docxVisual: visual.docxVisual }
      const visualContent = compilationVisualContent(record, visual)
      const text = automaticImportInstructions(record, catalog, true, sources, visual)
      const message = createUserMessage({ source: { kind: 'knowledge-import', importId: record.manifest.id },
        ...visualContent.some(block => block.type === 'image') ? { requiredInputModalities: ['image'] as const } : {},
        content: [{ type: 'text', text }, ...visualContent] })
      if (Buffer.byteLength(JSON.stringify(message), 'utf8') > policy.maxReviewBytes) throw new Error('Complete AI import continuation exceeds maxReviewBytes')
      next = { ...record, automatic: { ...automatic, status: 'reviewing', reason: undefined,
        catalog: { sha256: catalog.catalogSha256, revision: catalog.locationRevision,
          pages: catalog.pages.map(page => ({ path: page.path, version: page.version })) },
        visual: retainedVisual, continuation: { id: message.id, text, visual: retainedVisual },
      } }
      await this.persistAutomaticImport(record.manifest.id, next)
    }
    const queued = next.automatic?.continuation
    /* v8 ignore if -- The existing continuation is retained, or the preceding branch has durably constructed it. */
    if (queued === undefined) throw new Error('Automatic import continuation was not retained')
    const deliveryEvidence = await this.sessionEvidence(record, signal)
    if (deliveryEvidence === null) this.refuse('session-unverified')
    const delivered = deliveryEvidence.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === queued.id))
    if (!delivered) {
      signal.throwIfAborted()
      this.assertOwner(next, next.workspaceId)
      const visualContent = queued.visual === undefined ? [] : compilationVisualContent(next, queued.visual)
      found.agent.followup(freezeMessage({ id: queued.id, role: 'user',
        source: { kind: 'knowledge-import', importId: record.manifest.id },
        ...visualContent.some(block => block.type === 'image') ? { requiredInputModalities: ['image'] as const } : {},
        content: [{ type: 'text', text: queued.text }, ...visualContent] }))
    }
    if (!await this.ctx.sessions.flush(found.agent.session)) throw new Error('Automatic import continuation lacks durable Session input')
  }

  private async settleAutomaticImport(record: KnowledgeImportRecord, signal: AbortSignal): Promise<void> {
    const automatic = record.automatic
    /* v8 ignore if -- All three callers require accepted automatic execution on this same validated captured record. */
    if (automatic === undefined || record.manifest.maintenance !== 'automatic' || record.execution?.status !== 'accepted') return
    const policy = this.ctx.knowledgeController.automaticMaintenancePolicy()
    const evidence = await this.sessionEvidence(record, signal)
    if (evidence === null || !this.matchesEvidence(record, evidence)) this.refuse('session-unverified')
    if (automatic.continuation !== undefined && !evidence.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === automatic.continuation?.id))) {
      await this.queueAutomaticImportReview(record, signal)
      return
    }
    const latestTurn = evidence.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (latestTurn?.type === 'turn/start') return
    let proposal = settledProposal(evidence.events)
    if (proposal === null) {
      const end = evidence.events.findLast(event => event.type === 'turn/end')
      if (end?.type === 'turn/end' && end.data.reason.kind !== 'completed') await this.persistAutomaticImport(record.manifest.id,
        { ...record, automatic: { ...automatic, status: 'failed', reason: 'unavailable' } })
      return
    }
    if (automatic.pending !== undefined) {
      const pendingText = retainedProposal(evidence.events, brandString<MessageId>(automatic.pending.messageId))
      if (pendingText === null) this.refuse('proposal-changed')
      proposal = { messageId: brandString<MessageId>(automatic.pending.messageId), text: pendingText }
    }
    if (automatic.pending === undefined && automatic.processedMessages.includes(proposal.messageId)) {
      if (automatic.status === 'reviewing' && automatic.continuation === undefined) await this.queueAutomaticImportReview(record, signal)
      return
    }
    const inputId = automatic.continuation?.id ?? record.execution.message.id
    const input = evidence.events.findLastIndex(event => event.type === 'user/message' && event.data.id === inputId)
    const final = evidence.events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === proposal.messageId)
    const reviewEvents = input < 0 || final < input ? [] : evidence.events.slice(input, final + 1)
    if (reviewEvents.length === 0) this.refuse('session-unverified')
    let next = record
    let request: KnowledgeAutomaticMaintenanceRequest
    if (automatic.pending !== undefined) {
      const raw: unknown = JSON.parse(automatic.pending.requestJson)
      // Durable JSON is checked by the same Host AI schema, never cast into a trusted request.
      request = validateAutomaticMaintenanceRequest(raw, policy.maxRecordBytes)
    } else {
      if (Buffer.byteLength(proposal.text, 'utf8') > this.config.maxReviewJsonBytes) throw new Error('AI import review exceeds maxReviewJsonBytes')
      let review: ReturnType<typeof parseAutomaticMaintenanceReview>
      try { review = parseAutomaticMaintenanceReview(proposal.text) } catch (error) {
        await this.persistAutomaticImport(record.manifest.id, { ...record, automatic: { ...automatic, status: 'deferred', reason: 'invalid-review' } })
        void error
        return
      }
      if (review.decision === 'change' && review.change.kind === 'merge') {
        await this.persistAutomaticImport(record.manifest.id, { ...record, automatic: { ...automatic, status: 'deferred', reason: 'invalid-review' } })
        return
      }
      const catalog = await this.ctx.knowledgeController.automaticMaintenanceCatalog(record.workspaceId, signal)
      const sources = await automaticImportSources(this.ctx, record, policy.maxReviewBytes, signal)
      const sourceCoverage = await automaticImportCoverage(this.ctx, record, review, evidence.events.slice(0, final + 1), signal)
      const complete = sourceCoverage === 'complete'
        && automatic.catalog?.sha256 === catalog.catalogSha256
        && review.sourceDispositions.length === sources.length
        && sources.every((source, index) => {
          const item = review.sourceDispositions[index]
          return item?.sourceId === source.sourceId && item.disposition !== 'unresolved'
            && (item.quote === undefined || source.text.includes(item.quote))
        }) && review.comparedPages.length === catalog.pages.length
        && catalog.pages.every((page, index) => review.comparedPages[index]?.path === page.path
          && review.comparedPages[index].version === page.version
          && review.comparedPages[index].relation !== 'unknown' && review.comparedPages[index].relation !== 'conflict'
          && (review.comparedPages[index].quote === undefined || page.body.includes(review.comparedPages[index].quote ?? '')))
        && await automaticImportEvidence(this.ctx, record, review, reviewEvents, signal)
      if (review.decision !== 'change' || !complete) {
        const status = !complete || review.decision === 'deferred' ? 'deferred'
          : automatic.writes.length === 0 ? 'no-change' : 'updated'
        await this.persistAutomaticImport(record.manifest.id, { ...record, automatic: { ...automatic, status,
          reason: status === 'deferred' ? !complete ? 'source-incomplete' : 'conflict' : undefined,
          rounds: automatic.rounds + 1, processedMessages: [...automatic.processedMessages, proposal.messageId],
          continuation: undefined,
        } })
        return
      }
      const digest = automaticMaintenanceReviewDigest(review)
      const intentDigest = createHash('sha256').update(JSON.stringify({ kind: review.change.kind,
        destination: review.change.kind === 'create' ? review.change.title : review.change.documentId,
        truth: review.change.truth })).digest('hex')
      if (automatic.candidateDigests.includes(intentDigest)) {
        await this.persistAutomaticImport(record.manifest.id, { ...record, automatic: { ...automatic, status: 'deferred', reason: 'repeated-candidate' } })
        return
      }
      const titleSearch = automaticImportSearch(reviewEvents, record, review.titleQuery)
      const topicSearch = review.topicQuery === undefined ? undefined : automaticImportSearch(reviewEvents, record, review.topicQuery)
      if (titleSearch === null || topicSearch === null || review.change.kind === 'create' && review.titleQuery !== review.change.title) {
        await this.persistAutomaticImport(record.manifest.id, { ...record, automatic: { ...automatic, status: 'deferred', reason: 'invalid-review' } })
        return
      }
      const operationId = brandString<KnowledgeUpdateId>(randomUUID())
      request = {
        operationId, authority: { kind: 'import', importId: record.manifest.id,
          authorizationId: automatic.authorizationId, sourceSessionId: record.sessionId }, reviewerSessionId: record.sessionId,
        resultSha256: createHash('sha256').update(proposal.text).digest('hex'), candidateSha256: digest,
        locationRevision: catalog.locationRevision, catalogSha256: catalog.catalogSha256,
        sourceCoverage, sources, sourceDispositions: review.sourceDispositions,
        comparedPages: review.comparedPages, titleSearch, ...topicSearch === undefined ? {} : { topicSearch },
        change: review.change.kind === 'create' ? { ...review.change, documentId: automaticMaintenancePageId(operationId) } : review.change,
      }
      request = validateAutomaticMaintenanceRequest(request, policy.maxRecordBytes)
      next = { ...record, automatic: { ...automatic, status: 'applying', reason: undefined,
        pending: { messageId: proposal.messageId, requestJson: JSON.stringify(request) } } }
      await this.persistAutomaticImport(record.manifest.id, next)
    }
    const authorize = async (): Promise<void> => {
      signal.throwIfAborted()
      const current = this.record(record.workspaceId, record.manifest.id)
      if (current.automatic?.authorizationId !== request.authority.authorizationId
        || current.manifest.maintenance !== 'automatic' || current.automatic.pending?.requestJson !== JSON.stringify(request)) this.refuse('proposal-changed')
      const actual = await this.sessionEvidence(current, signal)
      if (actual === null || !this.matchesEvidence(current, actual)) this.refuse('session-unverified')
      const text = retainedProposal(actual.events, brandString<MessageId>(current.automatic.pending.messageId))
      if (text === null || createHash('sha256').update(text).digest('hex') !== request.resultSha256
        || !await automaticImportEvidence(this.ctx, current, request, reviewEvents, signal)) this.refuse('proposal-changed')
      const reviewed = parseAutomaticMaintenanceReview(text)
      if (reviewed.decision !== 'change' || reviewed.change.kind === 'merge' || automaticMaintenanceReviewDigest(reviewed) !== request.candidateSha256
        || JSON.stringify(reviewed.sourceDispositions) !== JSON.stringify(request.sourceDispositions)
        || JSON.stringify(reviewed.comparedPages) !== JSON.stringify(request.comparedPages)
        || canonicalReviewJson(reviewed.change.kind === 'create'
          ? { ...reviewed.change, documentId: automaticMaintenancePageId(request.operationId) } : reviewed.change)
          !== canonicalReviewJson(request.change)
        || JSON.stringify(automaticImportSearch(reviewEvents, current, reviewed.titleQuery)) !== JSON.stringify(request.titleSearch)
        || JSON.stringify(reviewed.topicQuery === undefined ? undefined
          : automaticImportSearch(reviewEvents, current, reviewed.topicQuery)) !== JSON.stringify(request.topicSearch)) this.refuse('proposal-changed')
      if (await automaticImportCoverage(this.ctx, current, reviewed, actual.events.slice(0, final + 1), signal)
        !== request.sourceCoverage) this.refuse('proposal-changed')
      const sources = await automaticImportSources(this.ctx, current, policy.maxReviewBytes, signal)
      if (JSON.stringify(sources) !== JSON.stringify(request.sources)) this.refuse('source-changed')
    }
    const result = await this.withBrainWriter(() => this.ctx.knowledgeController.maintainAutomatically(
      record.workspaceId, request, signal, authorize))
    const retained = next.automatic
    /* v8 ignore if -- Both pending-request paths retain the accepted automatic record before writer admission. */
    if (retained === undefined) throw new Error('Automatic import lost its retained operation')
    if (result.status === 'deferred') {
      await this.persistAutomaticImport(record.manifest.id, { ...next, automatic: { ...retained, status: 'deferred', reason: result.reason,
        pending: undefined, continuation: undefined, processedMessages: [...retained.processedMessages, proposal.messageId],
      } })
      return
    }
    const writes = retained.writes.some(write => write.operationId === result.receipt.operationId)
      ? retained.writes : [...retained.writes, { documentId: result.receipt.documentId, version: result.receipt.version,
        operationId: result.receipt.operationId }]
    next = { ...next, automatic: { ...retained, status: 'reviewing', rounds: retained.rounds + 1, writes,
      pending: undefined, continuation: undefined, processedMessages: [...retained.processedMessages, proposal.messageId],
      candidateDigests: [...retained.candidateDigests, createHash('sha256').update(JSON.stringify({ kind: request.change.kind,
        destination: request.change.kind === 'create' ? request.change.title : request.change.documentId,
        truth: request.change.truth })).digest('hex')],
    } }
    if (next.automatic !== undefined && next.automatic.rounds - next.automatic.budgetStart >= this.config.maxReviewChanges) {
      await this.persistAutomaticImport(record.manifest.id, { ...next, automatic: { ...next.automatic, status: 'budget-stopped' } })
      return
    }
    await this.persistAutomaticImport(record.manifest.id, next)
    await this.queueAutomaticImportReview(next, signal)
  }

  private allowTool(name: string, agent: Agent): boolean {
    const imported = carriesImportSource(agent.session)
    if (this.lifetime.signal.aborted) return !imported
    const record = this.forSession(agent.id)
    if (record === undefined) return !imported
    if (record.abandonedAt !== undefined) return false
    if (!this.matchesSession(record, agent.session)) {
      return reviewReadTools.has(name) && this.matchesPendingImport(record, agent.session)
    }
    if (reviewReadTools.has(name)) return true
    if (record.manifest.maintenance !== undefined) return false
    // create_task only saves a pending card; execution still needs its independent user confirmation.
    if (name === 'create_task') return record.reviewDecisions?.at(-1)?.decision === 'approve'
      && record.reviewDecisions.at(-1)?.changes !== undefined
      && record.execution?.status === 'accepted' && this.ownerCurrent(record)
    return reviewWriteTools.has(name) && this.reviewApproved(record, agent.session)
      && (record.reviewDecisions?.at(-1)?.changes?.some(change => change.tool === name) ?? false)
  }

  private ownerCurrent(record: KnowledgeImportRecord): boolean {
    try { this.assertOwner(record, record.workspaceId); return true } catch { return false }
  }

  /** Verify the registered project or logical-workspace account before binding a newly created Session. */
  private sessionOwnerMatches(record: KnowledgeImportRecord, header: SessionHeader): boolean {
    if (header.id !== record.sessionId) return false
    const scope = record.manifest.scope
    if (scope === undefined) {
      const owner = this.ctx.workspaceRegistry.get(record.workspaceId)
      return header.cwd === record.workspacePath && owner?.sessionIds.includes(record.sessionId) === true
    }
    return this.ctx.workspaceRegistry.spaces.some(space => space.spaceId === scope.spaceId
      && space.projectIds.includes(record.workspaceId) && space.looseSessionIds?.includes(record.sessionId))
  }

  /** A creation claim permits recovery before the later binding receipt; old unbound Sessions remain inspect-only. */
  private async ownsInterruptedSession(record: KnowledgeImportRecord, header: SessionHeader,
    signal: AbortSignal): Promise<boolean> {
    if (!this.matchesSessionHeader(record, header)) return false
    const claim = record.execution?.creationClaim
    if (claim === undefined) return record.sessionBinding !== undefined && this.sessionOwnerMatches(record, header)
    if (!this.ownerCurrent(record) || record.manifest.scope === undefined && header.cwd !== record.workspacePath
      || record.sessionBinding !== undefined && !this.sessionOwnerMatches(record, header)) return false
    const evidence = await this.sessionEvidence(record, signal)
    if (evidence === null || evidence.header.id !== header.id || evidence.header.createdAt !== header.createdAt
      || evidence.header.cwd !== header.cwd) return false
    const first = evidence.events[0]
    return first?.type === 'knowledge-import/creation-claim'
      && first.data.importId === record.manifest.id && first.data.workspaceId === record.workspaceId
      && first.data.spaceId === (record.manifest.scope?.spaceId ?? null) && first.data.claim === claim
  }

  /** A missing binding proves this controller never reached its later input delivery. */
  private async canAbandonCreated(record: KnowledgeImportRecord, header: SessionHeader,
    signal: AbortSignal): Promise<boolean> {
    if (record.abandonedAt !== undefined || record.execution?.status !== 'prepared'
      || record.execution.creationClaim === undefined || record.sessionBinding !== undefined
      || !await this.ownsInterruptedSession(record, header, signal)) return false
    const evidence = await this.sessionEvidence(record, signal)
    const bootstrap: readonly string[] | undefined = evidence?.events.slice(2).map(event => event.type)
    return evidence !== null && evidence.header.id === header.id
      && evidence.header.createdAt === header.createdAt && evidence.header.cwd === header.cwd
      && (bootstrap?.length === 0 || bootstrap?.length === 3
        && bootstrap[0] === 'permission/preset'
        && bootstrap[1] === 'sandbox/mode'
        && bootstrap[2] === 'approval/policy')
      && evidence.events[0]?.type === 'knowledge-import/creation-claim'
      && evidence.events[1]?.type === 'session/end-seed'
  }

  private matchesEvidence(record: KnowledgeImportRecord, evidence: { header: SessionHeader; events: readonly SessionEvent[] }): boolean {
    return this.matchesSessionHeader(record, evidence.header)
      && evidence.events.some(event => event.type === 'user/message' && event.data.source.kind === 'knowledge-import'
        && event.data.source.importId === record.manifest.id)
  }

  private matchesSessionHeader(record: KnowledgeImportRecord, header: SessionHeader): boolean {
    return header.id === record.sessionId
      && (record.sessionBinding === undefined || (record.sessionBinding.createdAt === header.createdAt
        && record.sessionBinding.cwd === header.cwd))
  }

  /** The first model request assembles tools before the claimed import message becomes a `user/message`. */
  private matchesPendingImport(record: KnowledgeImportRecord, session: Session): boolean {
    return this.matchesSessionHeader(record, session.header)
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      && session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source.kind === 'knowledge-import'
          && message.source.importId === record.manifest.id))
  }

  private matchesSession(record: KnowledgeImportRecord, session: Session): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return this.matchesEvidence(record, { header: session.header, events: session.snapshotEvents() })
  }

  private reviewApproved(record: KnowledgeImportRecord, session: Session): boolean {
    if (this.lifetime.signal.aborted || record.abandonedAt !== undefined || record.execution?.status !== 'accepted'
      || !this.matchesSession(record, session)) return false
    if (!this.ownerCurrent(record)) return false
    const latest = record.reviewDecisions?.at(-1)
    if (latest?.decision !== 'approve' || latest.changes === undefined || latest.changesSha256 === undefined) return false
    if (record.reviewFormat !== undefined && latest.receiptsSha256 !== this.receiptsSha256(record)) return false
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    const proposal = settledProposal(events)
    if (proposal === null || proposal.messageId !== latest.proposalMessageId
      || createHash('sha256').update(proposal.text).digest('hex') !== latest.proposalSha256) return false
    const current = this.proposalChanges(record, proposal.text)
    if (current === null) return false
    const plan = this.orderedPlan(record, current)
    const finalStepCount = plan?.kind === 'mixed' ? 2 : plan === null ? 0 : 1
    if (sourceDispositionFailure(record, current) !== undefined
      && (plan === null || latest.appliedSteps?.length !== finalStepCount)) return false
    if (record.reviewFormat === 'brain-review-json-v6'
      && (plan === null || latest.appliedSteps?.length !== finalStepCount)
      && !approvedSourceDispositions(current, latest.sourceDispositionChoices,
        latest.sourceDispositionReviewSha256)) return false
    const mixed = this.activeCreationPaths(current).size > 0 && current.some(change =>
      typeof change.arguments.expected_version === 'string' || Array.isArray(change.arguments.paths))
    if (record.reviewFormat !== undefined && mixed && this.v4MixedPlan(record, current) === null) return false
    if (plan !== null && latest.appliedSteps === undefined) return false
    if (usesTopicDiscovery(record.reviewFormat)
      && this.retainedDiscovery(record, current, proposal.text, events, proposal.messageId) === null) return false
    if (record.reviewFormat === 'brain-review-json-v5' && hasSelfDeclaredActiveOverlap(current)
      && (latest.appliedSteps?.length ?? 0) < finalStepCount) return false
    if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredActiveOverlap(current)
      && (latest.appliedSteps?.length ?? 0) < finalStepCount) return false
    return reviewChangesSha256(current) === latest.changesSha256
      && (record.reviewFormat === undefined
        || [...this.activeCreationPaths(current).keys()].every(projectId => latest.activeIndexDigests?.[projectId] !== undefined))
      && (record.reviewFormat === undefined || this.activeTitlesSupported(current, events, proposal.messageId))
      && canonicalReviewJson(current.map(approvedChange)) === canonicalReviewJson(latest.changes)
  }

  private activeTitlesSupported(changes: readonly KnowledgeImportReviewChange[], events: readonly SessionEvent[],
    proposalMessageId: MessageId): boolean {
    const proposalIndex = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === proposalMessageId)
    /* v8 ignore if -- reviewApproved supplies the assistant ID just selected from this captured event array. */
    if (proposalIndex < 0) return false
    const priorEvents = events.slice(0, proposalIndex)
    for (const change of changes) {
      if (change.tool !== 'brain_create_page' || change.arguments.status !== 'active') continue
      const projectId = brandString<WorkspaceId>(change.arguments.target_project_id as string)
      const project = this.ctx.workspaceRegistry.get(projectId)
      if (project === undefined || project.archivedAt !== undefined) return false
      const observed = candidateSearch(priorEvents, projectId, project.path, change.arguments.title as string)
      if (typeof observed === 'string' || hasExactActiveTitle(observed, change.arguments.title as string)) return false
    }
    return true
  }

  private proposalChanges(record: KnowledgeImportRecord, text: string) {
    const scope = record.manifest.scope
    const projects = scope === undefined ? [record.workspaceId] : this.ctx.workspaceRegistry.spaces.find(space =>
      space.spaceId === scope.spaceId && space.projectIds.includes(record.workspaceId))?.projectIds ?? []
    return parseReviewManifest(text, this.config, id => projects.some(projectId => projectId === id
      && this.ctx.workspaceRegistry.get(projectId)?.archivedAt === undefined), record.reviewFormat ?? 'brain-review-json-v1')
  }

  private receiptsSha256(record: KnowledgeImportRecord): string {
    return createHash('sha256').update(canonicalReviewJson({
      manifest: record.manifest.documents.map(document => ({ id: document.id, sha256: document.sha256 })),
      receipts: record.receipts.map(receipt => ({ id: receipt.id, source: receipt.source, text: receipt.text })),
    })).digest('hex')
  }

  private activeCreationPaths(changes: readonly KnowledgeImportReviewChange[]): ReadonlyMap<WorkspaceId, ReadonlySet<string>> {
    const paths = new Map<WorkspaceId, Set<string>>()
    for (const change of changes) {
      if (change.tool !== 'brain_create_page' || change.arguments.status !== 'active'
        || typeof change.arguments.target_project_id !== 'string' || typeof change.arguments.path !== 'string') continue
      const projectId = brandString<WorkspaceId>(change.arguments.target_project_id)
      const group = paths.get(projectId) ?? new Set<string>()
      group.add(change.arguments.path)
      paths.set(projectId, group)
    }
    return paths
  }

  private v4MixedPlan(record: KnowledgeImportRecord,
    changes: readonly KnowledgeImportReviewChange[]): V4MixedPlan | null {
    if (record.reviewFormat !== 'brain-review-json-v4' && !usesTopicDiscovery(record.reviewFormat)
      || changes.length !== 2) return null
    const [update, create] = changes
    if (update?.tool !== 'brain_update_truth' || create?.tool !== 'brain_create_page'
      || create.arguments.status !== 'active'
      || typeof update.arguments.target_project_id !== 'string'
      || update.arguments.target_project_id !== create.arguments.target_project_id
      || typeof update.arguments.path !== 'string' || typeof create.arguments.path !== 'string'
      || update.arguments.path === create.arguments.path) return null
    return { kind: 'mixed', update, create, projectId: brandString<WorkspaceId>(update.arguments.target_project_id),
      existingPath: update.arguments.path, newPath: create.arguments.path }
  }

  private orderedPlan(record: KnowledgeImportRecord,
    changes: readonly KnowledgeImportReviewChange[]): OrderedPlan | null {
    const mixed = this.v4MixedPlan(record, changes)
    if (mixed !== null) return mixed
    if (!usesTopicDiscovery(record.reviewFormat) || changes.length !== 1) return null
    const create = changes[0]
    if (create?.tool !== 'brain_create_page' || create.arguments.status !== 'active'
      || typeof create.arguments.target_project_id !== 'string'
      || typeof create.arguments.path !== 'string') return null
    return { kind: 'single-create', create,
      projectId: brandString<WorkspaceId>(create.arguments.target_project_id), newPath: create.arguments.path }
  }

  private async activeIndexDigest(projectId: WorkspaceId, excludedPaths: ReadonlySet<string>,
    signal: AbortSignal): Promise<string | null> {
    return (await this.activeIndexState(projectId, excludedPaths, signal))?.digest ?? null
  }

  private async activeIndexState(projectId: WorkspaceId, excludedPaths: ReadonlySet<string>,
    signal: AbortSignal): Promise<ActiveIndexState | null> {
    const project = this.ctx.workspaceRegistry.get(projectId)
    if (project === undefined || project.archivedAt !== undefined) return null
    const index = await this.ctx.knowledgeController.index(projectId, signal)
    if (index.truncated || index.issues.length > 0) return null
    const activePages = index.entries.filter(entry => entry.status === 'active'
      && !excludedPaths.has(entry.id))
      .map(entry => ({ path: entry.id, title: entry.title, version: entry.version }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const pages = sortedPageVersions(activePages)
    const digest = createHash('sha256').update(canonicalReviewJson({ projectId, projectPath: project.path,
      directory: index.directory, locationRevision: index.locationRevision, pages })).digest('hex')
    return {
      digest,
      exists: index.exists, pages, activePages, directory: index.directory, locationRevision: index.locationRevision,
      occupiedPaths: new Set(index.entries.filter(entry => entry.kind === 'page').map(entry => entry.id)),
      authoredDocumentCount: index.entries.length,
      hasActiveRoot: index.entries.some(entry => entry.kind === 'root' && entry.status === 'active'),
    }
  }

  private async candidateSearchCurrent(projectId: WorkspaceId, observed: CandidateSearch,
    signal: AbortSignal, ownUpdate?: { path: string; version: string },
    allowEmptyIndexBootstrap = false): Promise<boolean> {
    const current = await this.ctx.knowledgeController.search(projectId, {
      query: observed.query, statuses: ['active'], maxResults: observed.hits.length + 1, maxMatches: 1,
    }, signal)
    const expectedHits = ownUpdate === undefined ? observed.hits : observed.hits.map(hit =>
      hit.path === ownUpdate.path ? { ...hit, version: ownUpdate.version } : hit)
    return (current.exists === observed.exists || allowEmptyIndexBootstrap && !observed.exists
      && current.exists && observed.hits.length === 0)
      && !current.truncated && current.issues.length === 0
      && canonicalReviewJson(sortedPageVersions(current.hits)) === canonicalReviewJson(sortedPageVersions(expectedHits))
  }

  private discoverySha256(discovery: readonly KnowledgeImportDiscovery[]): string {
    return createHash('sha256').update(canonicalReviewJson(discovery)).digest('hex')
  }

  private async proposalDiscovery(record: KnowledgeImportRecord, text: string,
    changes: readonly KnowledgeImportReviewChange[], events: readonly SessionEvent[], messageId: MessageId,
    signal: AbortSignal): Promise<{ discovery: readonly KnowledgeImportDiscovery[]
    reason?: NonNullable<KnowledgeImportReviewLookup['proposal']>['verification']['reason'] }> {
    if (!usesTopicDiscovery(record.reviewFormat)) return { discovery: [] }
    const declarations = parseReviewDiscovery(text, this.config)
    /* v8 ignore if -- verifyProposal parsed this same text and config through the same V5/V6 envelope. */
    if (declarations === null) return { discovery: [], reason: 'invalid-format' }
    const active = changes.map((change, changeIndex) => ({ change, changeIndex })).filter(item =>
      item.change.tool === 'brain_create_page' && item.change.arguments.status === 'active')
    /* v8 ignore if -- The sole verifyProposal caller synchronously rejects multiple active creations before dispatch. */
    if (active.length > 1) return { discovery: [], reason: 'too-many-active-creations' }
    if (declarations.length !== active.length || new Set(declarations.map(item => item.change_index)).size !== declarations.length) {
      return { discovery: [], reason: declarations.length < active.length ? 'missing-discovery-search' : 'invalid-format' }
    }
    const proposalIndex = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === messageId)
    /* v8 ignore if -- The sole verifyProposal caller has already located this ID in the same captured events. */
    if (proposalIndex < 0) return { discovery: [], reason: 'invalid-format' }
    const priorEvents = events.slice(0, proposalIndex)
    const discovery: KnowledgeImportDiscovery[] = []
    for (const { change, changeIndex } of active) {
      const declaration = declarations.find(item => item.change_index === changeIndex)
      if (declaration === undefined) return { discovery: [], reason: 'missing-discovery-search' }
      const projectId = brandString<WorkspaceId>(change.arguments.target_project_id as string)
      const project = this.ctx.workspaceRegistry.get(projectId)
      if (project === undefined || project.archivedAt !== undefined) return { discovery: [], reason: 'missing-discovery-search' }
      if (declaration.mode === 'empty-index') {
        const index = await this.activeIndexState(projectId, new Set(), signal)
        if (index === null || index.authoredDocumentCount !== 0) {
          return { discovery: [], reason: 'discovery-empty-index-changed' }
        }
        discovery.push({ changeIndex, targetProjectId: projectId, mode: 'empty-index', exists: index.exists, hits: [] })
        continue
      }
      const observed = topicSearch(priorEvents, projectId, project.path, declaration.query,
        change.arguments.title as string)
      if (typeof observed === 'string') return { discovery: [], reason: observed }
      if (observed.hits.length > this.config.maxComparedPagesPerChange
        || observed.hits.some(hit => !change.evidence?.compared_pages.some(page =>
          page.target_project_id === projectId && page.path === hit.path && page.version === hit.version
          && typeof page.quote === 'string' && page.quote.trim().length > 0
          && hasInformedBrainRead(priorEvents, project.path, page.path, page.version)))) {
        return { discovery: [], reason: 'discovery-page-not-read' }
      }
      discovery.push({ changeIndex, targetProjectId: projectId, mode: 'search', query: observed.query,
        exists: observed.exists, hits: observed.hits })
    }
    return { discovery }
  }

  private retainedDiscovery(record: KnowledgeImportRecord, changes: readonly KnowledgeImportReviewChange[],
    text: string, events: readonly SessionEvent[], messageId: MessageId): readonly KnowledgeImportDiscovery[] | null {
    if (!usesTopicDiscovery(record.reviewFormat)) return []
    const latest = record.reviewDecisions?.at(-1)
    const discovery = latest?.discovery
    const declarations = parseReviewDiscovery(text, this.config)
    if (discovery === undefined || latest?.discoverySha256 !== this.discoverySha256(discovery)
      || declarations === null || declarations.length !== discovery.length) return null
    const activeIndices = changes.flatMap((change, changeIndex) => change.tool === 'brain_create_page'
      && change.arguments.status === 'active' ? [changeIndex] : [])
    if (activeIndices.length !== discovery.length
      || new Set(discovery.map(item => item.changeIndex)).size !== discovery.length
      || discovery.some(item => !activeIndices.includes(item.changeIndex))) return null
    const proposalIndex = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === messageId)
    /* v8 ignore if -- Both callers select or locate this assistant ID in the same captured readonly events. */
    if (proposalIndex < 0) return null
    const priorEvents = events.slice(0, proposalIndex)
    for (const item of discovery) {
      const change = changes[item.changeIndex]
      const declaration = declarations.find(candidate => candidate.change_index === item.changeIndex)
      if (change?.tool !== 'brain_create_page' || change.arguments.status !== 'active'
        || change.arguments.target_project_id !== item.targetProjectId || declaration?.mode !== item.mode) return null
      if (item.mode === 'search') {
        if (declaration.mode !== 'search' || item.query === undefined || item.query !== declaration.query) return null
        const project = this.ctx.workspaceRegistry.get(item.targetProjectId)
        if (project === undefined || project.archivedAt !== undefined) return null
        const observed = topicSearch(priorEvents, item.targetProjectId, project.path, item.query,
          change.arguments.title as string)
        if (typeof observed === 'string' || canonicalReviewJson(observed) !== canonicalReviewJson({
          query: item.query, exists: item.exists, hits: item.hits,
        })) return null
      } else if (item.query !== undefined || item.hits.length !== 0) return null
    }
    return discovery
  }

  private async discoveryCurrent(discovery: readonly KnowledgeImportDiscovery[], signal: AbortSignal,
    ownUpdate?: { projectId: WorkspaceId; path: string; version: string },
    allowEmptyIndexBootstrap = false): Promise<
      'discovery-search-changed' | 'discovery-empty-index-changed' | null> {
    for (const item of discovery) {
      if (item.mode === 'empty-index') {
        const index = await this.activeIndexState(item.targetProjectId, new Set(), signal)
        if (index === null || index.exists !== item.exists
          && !(allowEmptyIndexBootstrap && !item.exists && index.exists)
          || index.authoredDocumentCount !== 0) {
          return 'discovery-empty-index-changed'
        }
      } else {
        const query = item.query
        assert(query !== undefined, 'Retained search discovery must contain its recorded query')
        if (!await this.candidateSearchCurrent(item.targetProjectId, {
          query, exists: item.exists, hits: item.hits,
        }, signal, ownUpdate?.projectId === item.targetProjectId ? ownUpdate : undefined)) {
          return 'discovery-search-changed'
        }
      }
    }
    return null
  }

  /** Only an exact durable truth receipt may replace the approved target-page comparison on retry. */
  private async v5TruthUpdateReceipt(record: KnowledgeImportRecord, changes: readonly KnowledgeImportReviewChange[],
    session: Session, name: string, args: Record<string, unknown>, signal: AbortSignal,
  ): Promise<{ projectId: WorkspaceId; path: string; version: string } | undefined> {
    const [change] = changes
    if (!usesTopicDiscovery(record.reviewFormat) || changes.length !== 1
      || change?.tool !== 'brain_update_truth' || name !== change.tool
      || this.reviewedChangeIndex(changes, name, args) !== 0 || typeof args.evidence_quote !== 'string') return undefined
    const approved = change.arguments as {
      target_project_id: WorkspaceId
      path: string
      operation_id: string
      expected_version: string
      truth: string
      kind: KnowledgeTruthUpdate['kind']
      summary: string
    }
    const request: KnowledgeTruthUpdate = {
      operationId: brandString<KnowledgeUpdateId>(approved.operation_id), expectedVersion: approved.expected_version,
      truth: approved.truth, kind: approved.kind, summary: approved.summary,
      source: requireUserEvidenceSource(session, args.evidence_quote), evidence: args.evidence_quote,
    }
    const receipt = await this.ctx.knowledgeController.truthUpdateReceipt(approved.target_project_id,
      brandString<KnowledgeDocumentId>(approved.path), request, signal)
    return receipt === null ? undefined : { projectId: approved.target_project_id, path: approved.path,
      version: receipt.version }
  }

  /** A retained exact root receipt permits only an already-written operation to be retried. */
  private async v6RootWriteReceipt(changes: readonly KnowledgeImportReviewChange[], session: Session,
    name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    if (name !== 'brain_write_root' || typeof args.evidence_quote !== 'string') return false
    const changeIndex = this.reviewedChangeIndex(changes, name, args)
    if (changeIndex < 0) return false
    const reviewed = changes[changeIndex]
    /* v8 ignore if -- The nonnegative findIndex result addresses this same unchanged dense parsed array. */
    if (reviewed === undefined) return false
    const approved = reviewed.arguments as {
      target_project_id: WorkspaceId
      path: string
      operation_id: string
      expected_version: string | null
      body: string
      reason: string
    }
    const request: KnowledgeRootWrite = {
      operationId: brandString<KnowledgeUpdateId>(approved.operation_id),
      expectedVersion: approved.expected_version, body: approved.body, reason: approved.reason,
      source: requireUserEvidenceSource(session, args.evidence_quote), evidence: args.evidence_quote,
    }
    return this.retainedReceipt(() => this.ctx.knowledgeController.rootWriteReceipt(approved.target_project_id,
      brandString<KnowledgeDocumentId>(approved.path), request, signal), signal)
  }
  /** A retained exact status receipt permits only an already-written activation to be retried. */
  private async v6StatusUpdateReceipt(changes: readonly KnowledgeImportReviewChange[], session: Session,
    name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    if (name !== 'brain_set_page_status' || typeof args.evidence_quote !== 'string') return false
    const changeIndex = this.reviewedChangeIndex(changes, name, args)
    if (changeIndex < 0) return false
    const reviewed = changes[changeIndex]
    /* v8 ignore if -- The nonnegative findIndex result addresses this same unchanged dense parsed array. */
    if (reviewed === undefined) return false
    if (reviewed.arguments.status !== 'active') return false
    const approved = reviewed.arguments as {
      target_project_id: WorkspaceId
      path: string
      operation_id: string
      expected_version: string
      status: 'active'
      reason: string
    }
    const request: KnowledgePageStatusUpdate = {
      operationId: brandString<KnowledgeUpdateId>(approved.operation_id), expectedVersion: approved.expected_version,
      status: approved.status, reason: approved.reason,
      source: requireUserEvidenceSource(session, args.evidence_quote), evidence: args.evidence_quote,
    }
    return this.retainedReceipt(() => this.ctx.knowledgeController.statusUpdateReceipt(approved.target_project_id,
      brandString<KnowledgeDocumentId>(approved.path), request, signal), signal)
  }
  private async retainedReceipt(read: () => Promise<{ readonly version: string } | null>, signal: AbortSignal): Promise<boolean> {
    try { return await read() !== null } catch (error) {
      signal.throwIfAborted()
      const failure = remoteErrorOf(error)
      if (failure?.code === 'knowledge/document' && failure.details.reason === 'not-found') return false
      throw error
    }
  }

  private async reviewSourcesCurrent(changes: readonly KnowledgeImportReviewChange[],
    digests: Readonly<Record<string, string>> | undefined, signal: AbortSignal,
    requireComparedQuotes = false, ownUpdate?: { projectId: WorkspaceId; path: string; version: string }): Promise<boolean> {
    const comparison = await this.comparedPagesCurrent(changes, signal, requireComparedQuotes, ownUpdate)
    if (comparison !== null) {
      throw new Error(comparison === 'compared-page-changed'
        ? 'Knowledge import compared Brain page changed after approval; review again before writing'
        : 'Knowledge import compared Brain page quote is unavailable; review again before writing')
    }
    for (const [projectId, paths] of this.activeCreationPaths(changes)) {
      const current = await this.activeIndexState(projectId, paths, signal)
      if (current?.hasActiveRoot) {
        throw new Error('Knowledge import active root requires a new import and complete catalog review before creating an active page')
      }
      if (current === null || current.digest !== digests?.[projectId]) {
        throw new Error('Knowledge import active Brain catalog changed after approval; review again before writing')
      }
    }
    return true
  }

  private async verifyProposal(record: KnowledgeImportRecord, text: string, events: readonly SessionEvent[],
    messageId: MessageId, signal: AbortSignal): Promise<{
    changes: readonly KnowledgeImportReviewChange[] | null
    discovery?: readonly KnowledgeImportDiscovery[]
    verification: NonNullable<KnowledgeImportReviewLookup['proposal']>['verification']
  }> {
    const changes = this.proposalChanges(record, text)
    if (changes === null) return { changes: null, verification: { status: 'invalid', reason: 'invalid-format' } }
    if (record.reviewFormat === undefined) return { changes, verification: { status: 'verified' } }
    if (usesTopicDiscovery(record.reviewFormat)
      && changes.filter(change => change.tool === 'brain_create_page' && change.arguments.status === 'active').length > 1) {
      return { changes, verification: { status: 'invalid', reason: 'too-many-active-creations' } }
    }
    const mixed = this.activeCreationPaths(changes).size > 0 && changes.some(change =>
      typeof change.arguments.expected_version === 'string' || Array.isArray(change.arguments.paths))
    const v4Plan = this.v4MixedPlan(record, changes)
    if (mixed && v4Plan === null) {
      return { changes, verification: { status: 'invalid', reason: 'mixed-versioned-review' } }
    }
    const proposalIndex = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === messageId)
    /* v8 ignore if -- Every caller obtained this ID through settledProposal or retainedProposal over these same events. */
    if (proposalIndex < 0) return { changes, verification: { status: 'invalid', reason: 'invalid-format' } }
    const priorEvents = events.slice(0, proposalIndex)
    const discovered = await this.proposalDiscovery(record, text, changes, events, messageId, signal)
    if (discovered.reason !== undefined) {
      return { changes, verification: { status: 'invalid', reason: discovered.reason } }
    }
    const quotes = new Map<string, Set<string>>()
    const documents = new Set(record.manifest.documents.map(document => document.id))
    const searches: Array<{ projectId: WorkspaceId; observed: CandidateSearch }> = []
    const dispositionFailure = sourceDispositionFailure(record, changes)
    if (dispositionFailure === 'missing-source-dispositions'
      || dispositionFailure === 'invalid-source-dispositions') {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: dispositionFailure } }
    }
    for (const change of changes) {
      const cited = change.evidence
      /* v8 ignore if -- The undefined legacy format returned above; every stored V2–V6 format requires evidence when parsed. */
      if (cited === undefined) return { changes, verification: { status: 'invalid', reason: 'invalid-format' } }
      if (record.reviewFormat === 'brain-review-json-v6' && needsSourceDisposition(change)) {
        for (const item of cited.source_dispositions ?? []) {
          const retained = quotes.get(item.document_id) ?? new Set<string>()
          retained.add(item.quote)
          quotes.set(item.document_id, retained)
        }
      }
      for (const source of cited.sources) {
        if (!documents.has(source.document_id) || !record.receipts.some(receipt => receipt.id === source.document_id)) {
          return { changes, verification: { status: 'invalid', reason: 'source-not-in-selection' } }
        }
        const retained = quotes.get(source.document_id) ?? new Set<string>()
        retained.add(source.quote)
        quotes.set(source.document_id, retained)
      }
      const targetProjectId = change.arguments.target_project_id
      const targetPath = change.arguments.path
      const expectedVersion = change.arguments.expected_version
      const targetPaths = Array.isArray(change.arguments.paths) ? change.arguments.paths : []
      if (change.tool === 'brain_create_page' && change.arguments.status === 'active'
        && typeof targetProjectId === 'string' && typeof change.arguments.title === 'string') {
        const projectId = brandString<WorkspaceId>(targetProjectId)
        const project = this.ctx.workspaceRegistry.get(projectId)
        if (project === undefined || project.archivedAt !== undefined) {
          return { changes, verification: { status: 'invalid', reason: 'missing-candidate-search' } }
        }
        const observed = candidateSearch(priorEvents, projectId, project.path, change.arguments.title)
        if (typeof observed === 'string') return { changes, verification: { status: 'invalid', reason: observed } }
        if (observed.hits.some(hit => !cited.compared_pages.some(page => page.target_project_id === projectId
          && page.path === hit.path && page.version === hit.version))) {
          return { changes, verification: { status: 'invalid', reason: 'candidate-page-not-read' } }
        }
        if (hasExactActiveTitle(observed, change.arguments.title)) {
          return { changes, verification: { status: 'invalid', reason: 'duplicate-active-title' } }
        }
        searches.push({ projectId, observed })
      }
      if (typeof targetPath === 'string' && typeof expectedVersion === 'string'
        && !cited.compared_pages.some(page => page.target_project_id === targetProjectId
          && page.path === targetPath && page.version === expectedVersion)) {
        return { changes, verification: { status: 'invalid', reason: 'missing-target-comparison' } }
      }
      if (targetPaths.some(path => typeof path !== 'string' || !cited.compared_pages.some(page =>
        page.target_project_id === targetProjectId && page.path === path))) {
        return { changes, verification: { status: 'invalid', reason: 'missing-target-comparison' } }
      }
      for (const page of cited.compared_pages) {
        const project = this.ctx.workspaceRegistry.get(page.target_project_id)
        if (project === undefined || project.archivedAt !== undefined
          || !hasInformedBrainRead(priorEvents, project.path, page.path, page.version)) {
          return { changes, verification: { status: 'invalid', reason: 'compared-page-not-read' } }
        }
      }
    }
    for (const [documentId, exactQuotes] of quotes) {
      signal.throwIfAborted()
      const receipt = record.receipts.find(item => item.id === documentId)
      const manifestDocument = record.manifest.documents.find(item => item.id === documentId)
      if (receipt === undefined || manifestDocument === undefined || !await containsExactSourceQuotes(
        this.ctx.attachments.readFileStream(receipt.text, signal), exactQuotes, manifestDocument.format, signal)) {
        return { changes, verification: { status: 'invalid', reason: 'source-quote-not-found' } }
      }
    }
    const comparison = await this.comparedPagesCurrent(changes, signal,
      record.reviewFormat === 'brain-review-json-v3' || record.reviewFormat === 'brain-review-json-v4'
        || usesTopicDiscovery(record.reviewFormat))
    if (comparison !== null) {
      return { changes, verification: { status: 'invalid', reason: comparison } }
    }
    if (v4Plan !== null) {
      const current = await this.ctx.knowledgeController.read(v4Plan.projectId,
        brandString<KnowledgeDocumentId>(v4Plan.existingPath), signal)
      if (current.entry.kind !== 'page' || current.entry.status !== 'active') {
        return { changes, verification: { status: 'invalid', reason: 'mixed-versioned-review' } }
      }
    }
    for (const { projectId, observed } of searches) {
      if (!await this.candidateSearchCurrent(projectId, observed, signal)) {
        return { changes, verification: { status: 'invalid', reason: 'candidate-search-changed' } }
      }
    }
    const discoveryChange = await this.discoveryCurrent(discovered.discovery, signal)
    if (discoveryChange !== null) {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: discoveryChange } }
    }
    let rootCatalogReviewRequired = false
    let zeroHitDraftRequired = false
    let discoveryCoverageDraftRequired = false
    for (const [projectId, paths] of this.activeCreationPaths(changes)) {
      const index = await this.activeIndexState(projectId, paths, signal)
      if (index === null) {
        return { changes, verification: { status: 'invalid', reason: 'active-index-incomplete' } }
      }
      rootCatalogReviewRequired ||= !usesTopicDiscovery(record.reviewFormat) && index.hasActiveRoot
      zeroHitDraftRequired ||= index.authoredDocumentCount > 0 && discovered.discovery.some(item =>
        item.targetProjectId === projectId && item.mode === 'search' && item.hits.length === 0)
      discoveryCoverageDraftRequired ||= discovered.discovery.some(item => item.targetProjectId === projectId
        && item.mode === 'search' && item.hits.length > 0 && index.activePages.some(page =>
        !item.hits.some(hit => hit.path === page.path && hit.version === page.version)))
    }
    if (usesTopicDiscovery(record.reviewFormat) && hasSelfDeclaredActiveOverlap(changes)) {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: 'self-declared-overlap-unresolved' } }
    }
    if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredUpdateOverlap(changes)) {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: 'self-declared-update-overlap-unresolved' } }
    }
    if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredRootOverlap(changes)) {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: 'self-declared-root-overlap-unresolved' } }
    }
    if (record.reviewFormat === 'brain-review-json-v6' && hasSelfDeclaredStatusOverlap(changes)) {
      return { changes, discovery: discovered.discovery,
        verification: { status: 'invalid', reason: 'self-declared-status-overlap-unresolved' } }
    }
    if (rootCatalogReviewRequired) return { changes,
      verification: { status: 'invalid', reason: 'root-catalog-review-required' } }
    if (dispositionFailure === 'source-conflict-draft-required') return { changes, discovery: discovered.discovery,
      verification: { status: 'invalid', reason: 'source-conflict-draft-required' } }
    if (zeroHitDraftRequired) return { changes, discovery: discovered.discovery,
      verification: { status: 'invalid', reason: 'zero-hit-draft-required' } }
    if (discoveryCoverageDraftRequired) return { changes, discovery: discovered.discovery,
      verification: { status: 'invalid', reason: 'discovery-coverage-draft-required' } }
    return { changes, ...usesTopicDiscovery(record.reviewFormat) ? { discovery: discovered.discovery } : {},
      verification: { status: 'verified' } }
  }

  private async comparedPagesCurrent(changes: readonly KnowledgeImportReviewChange[], signal: AbortSignal,
    requireQuotes: boolean, ownUpdate?: { projectId: WorkspaceId; path: string; version: string },
  ): Promise<'compared-page-changed' | 'compared-page-quote-missing' | 'compared-page-quote-not-found' | null> {
    const comparisons = new Map<string, { targetProjectId: WorkspaceId; path: string; version: string; quotes: Set<string> }>()
    for (const change of changes) for (const page of change.evidence?.compared_pages ?? []) {
      const updated = ownUpdate !== undefined && page.target_project_id === ownUpdate.projectId
        && page.path === ownUpdate.path
      if (requireQuotes && !updated && (page.quote === undefined || page.quote.trim().length === 0)) {
        return 'compared-page-quote-missing'
      }
      const version = updated ? ownUpdate.version : page.version
      const key = canonicalReviewJson([page.target_project_id, page.path, version])
      const comparison = comparisons.get(key) ?? { targetProjectId: page.target_project_id,
        path: page.path, version, quotes: new Set<string>() }
      if (requireQuotes && !updated && page.quote !== undefined) comparison.quotes.add(page.quote)
      comparisons.set(key, comparison)
    }
    for (const comparison of comparisons.values()) {
      signal.throwIfAborted()
      let current
      try {
        current = await this.ctx.knowledgeController.read(comparison.targetProjectId,
          brandString<KnowledgeDocumentId>(comparison.path), signal)
      } catch (error) {
        signal.throwIfAborted()
        const failure = remoteErrorOf(error)
        if (failure?.code === 'knowledge/document' && failure.details.reason === 'not-found') {
          return 'compared-page-changed'
        }
        throw error
      }
      if (current.entry.version !== comparison.version) return 'compared-page-changed'
      if ([...comparison.quotes].some(quote => !current.body.includes(quote))) return 'compared-page-quote-not-found'
    }
    return null
  }

  private async orderedProgress(record: KnowledgeImportRecord, plan: OrderedPlan,
    changes: readonly KnowledgeImportReviewChange[], events: readonly SessionEvent[], proposalMessageId: MessageId,
    proposalSha256: string, signal: AbortSignal): Promise<KnowledgeImportReviewExecution> {
    const latest = record.reviewDecisions?.at(-1)
    const approval = record.reviewDecisions?.findLast(decision => decision.decision === 'approve'
      && decision.proposalMessageId === proposalMessageId && decision.proposalSha256 === proposalSha256)
    const appliedSteps = approval?.appliedSteps ?? []
    const nextChangeIndex = appliedSteps.length
    const blocked = (reason: NonNullable<KnowledgeImportReviewExecution['reason']>): KnowledgeImportReviewExecution =>
      ({ status: 'blocked', nextChangeIndex, appliedSteps, reason })
    if (latest?.decision === 'reject' && latest.proposalMessageId === proposalMessageId
      && latest.proposalSha256 === proposalSha256 && approval !== undefined) return blocked('review-rejected')
    if (latest !== approval || approval === undefined) {
      return { status: 'awaiting-approval', nextChangeIndex: 0, appliedSteps: [] }
    }
    if (approval.appliedSteps === undefined || approval.inFlight !== undefined) return blocked('step-receipt-missing')
    if (approval.receiptsSha256 !== this.receiptsSha256(record)
      || approval.changes === undefined || approval.changesSha256 !== reviewChangesSha256(changes)
      || canonicalReviewJson(approval.changes) !== canonicalReviewJson(changes.map(approvedChange))) {
      return blocked('step-receipt-stale')
    }
    const proposalEvent = events.find(event => event.type === 'assistant/message'
      && event.data.message.id === proposalMessageId)
    if (proposalEvent?.type !== 'assistant/message') return blocked('step-receipt-stale')
    const proposalText = proposalEvent.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    const discovery = usesTopicDiscovery(record.reviewFormat)
      ? this.retainedDiscovery(record, changes, proposalText, events, proposalMessageId) : []
    if (discovery === null) return blocked('step-receipt-stale')
    for (const step of appliedSteps) {
      const change = changes[step.index]
      assert(change !== undefined, 'Validated applied step must identify its approved change')
      if (change.arguments.operation_id !== step.operationId) return blocked('step-receipt-stale')
    }
    const finalStepCount = plan.kind === 'mixed' ? 2 : 1
    if (appliedSteps.length === finalStepCount) {
      if (plan.kind === 'mixed' && appliedSteps[0]?.postActiveIndexDigest !== appliedSteps[1]?.postActiveIndexDigest
        || plan.kind === 'single-create'
          && appliedSteps[0]?.postActiveIndexDigest !== approval.activeIndexDigests?.[plan.projectId]) {
        return blocked('step-receipt-stale')
      }
      return { status: 'complete', nextChangeIndex: finalStepCount, appliedSteps }
    }
    const dispositionFailure = sourceDispositionFailure(record, changes)
    if (dispositionFailure !== undefined) return blocked(dispositionFailure)
    if (record.reviewFormat === 'brain-review-json-v6'
      && !approvedSourceDispositions(changes, approval.sourceDispositionChoices,
        approval.sourceDispositionReviewSha256)) return blocked('source-review-required')
    if ((record.reviewFormat === 'brain-review-json-v5' || record.reviewFormat === 'brain-review-json-v6')
      && hasSelfDeclaredActiveOverlap(changes)) return blocked('self-declared-overlap-unresolved')
    if (usesTopicDiscovery(record.reviewFormat) && (plan.kind === 'single-create' || appliedSteps.length > 0)
      && !approvedComparedPages(changes, approval.comparedPageChoices, approval.comparedPageReviewSha256)) {
      return blocked('compared-page-review-required')
    }
    const updated = plan.kind === 'mixed' ? appliedSteps[0] : undefined
    const comparison = await this.comparedPagesCurrent(changes, signal, true,
      updated === undefined || plan.kind !== 'mixed' ? undefined : { projectId: plan.projectId, path: plan.existingPath,
        version: updated.postVersion })
    if (comparison !== null) return blocked('compared-page-changed')
    const excluded = new Set([plan.newPath])
    const index = await this.activeIndexState(plan.projectId, excluded, signal)
    const baseline = updated?.postActiveIndexDigest ?? approval.activeIndexDigests?.[plan.projectId]
    if (record.reviewFormat === 'brain-review-json-v4' && index?.hasActiveRoot) {
      return blocked('root-catalog-review-required')
    }
    if (index === null || baseline === undefined || index.digest !== baseline) return blocked('active-index-changed')
    if (updated !== undefined && plan.kind === 'mixed') {
      const current = await this.receiptPage(plan.projectId, plan.existingPath, signal)
      if (current === null) return blocked('step-receipt-stale')
      if (current.entry.status !== 'active' || current.entry.version !== updated.postVersion) {
        return blocked('step-receipt-stale')
      }
    }
    if (index.occupiedPaths.has(plan.newPath)) return blocked('active-index-changed')
    const project = this.ctx.workspaceRegistry.get(plan.projectId)
    const proposalIndex = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.id === proposalMessageId)
    if (project === undefined || proposalIndex < 0) return blocked('candidate-search-changed')
    const observed = candidateSearch(events.slice(0, proposalIndex), plan.projectId, project.path,
      plan.create.arguments.title as string)
    // The Brain writer creates an absent directory before its publication admission runs.
    const emptyIndexBootstrap = discovery.some(item => item.targetProjectId === plan.projectId
      && item.mode === 'empty-index' && !item.exists)
    if (typeof observed === 'string' || !await this.candidateSearchCurrent(plan.projectId, observed, signal,
      updated === undefined || plan.kind !== 'mixed' ? undefined
        : { path: plan.existingPath, version: updated.postVersion }, emptyIndexBootstrap)) {
      return blocked('candidate-search-changed')
    }
    const discoveryChange = await this.discoveryCurrent(discovery, signal,
      updated === undefined || plan.kind !== 'mixed' ? undefined
        : { projectId: plan.projectId, path: plan.existingPath, version: updated.postVersion },
      emptyIndexBootstrap)
    if (discoveryChange !== null) return blocked(discoveryChange)
    if (index.authoredDocumentCount > 0 && discovery.some(item => item.targetProjectId === plan.projectId
      && item.mode === 'search' && item.hits.length === 0)) return blocked('zero-hit-draft-required')
    if (record.reviewFormat === 'brain-review-json-v6' && discovery.some(item =>
      item.targetProjectId === plan.projectId && item.mode === 'search' && item.hits.length > 0
      && index.activePages.some(page => !item.hits.some(hit => hit.path === page.path
        && (hit.version === page.version || updated !== undefined && plan.kind === 'mixed'
          && page.path === plan.existingPath && page.version === updated.postVersion))))) {
      return blocked('discovery-coverage-draft-required')
    }
    return { status: nextChangeIndex === 0 ? 'ready'
      : nextChangeIndex === 1 ? 'partially-applied' : 'complete', nextChangeIndex, appliedSteps }
  }

  private async receiptPage(projectId: WorkspaceId, path: string, signal: AbortSignal) {
    try {
      return await this.ctx.knowledgeController.read(projectId, brandString<KnowledgeDocumentId>(path), signal)
    } catch (error) {
      signal.throwIfAborted()
      const failure = remoteErrorOf(error)
      if (failure?.code === 'knowledge/document' && failure.details.reason === 'not-found') return null
      throw error
    }
  }

  private reviewedChangeIndex(changes: readonly KnowledgeImportReviewChange[], name: string,
    args: Record<string, unknown>): number {
    try {
      const reviewed = reviewExecutionArguments(name, args)
      if (reviewed === null) return -1
      const sha256 = reviewChangeSha256(name, reviewed)
      return changes.findIndex(change => change.tool === name && change.sha256 === sha256)
    } catch { return -1 }
  }

  private approvalMarkerSeq(record: KnowledgeImportRecord, events: readonly SessionEvent[]): number | null {
    const latest = record.reviewDecisions?.at(-1)
    const approvedThroughSeq = latest?.approvedThroughSeq
    if (record.reviewFormat !== 'brain-review-json-v6' || latest?.decision !== 'approve'
      || typeof approvedThroughSeq !== 'number') return null
    const marker = events[approvedThroughSeq]
    if (marker?.type !== 'plugin:dsh-brain/knowledge-import-review-approved'
      || marker.data.importId !== record.manifest.id || marker.data.operationId !== latest.operationId
      || marker.data.proposalMessageId !== latest.proposalMessageId || marker.time !== latest.approvedAt) return null
    return approvedThroughSeq
  }

  private hasPostApprovalUserConfirmation(record: KnowledgeImportRecord, session: Session, name: string,
    args: Record<string, unknown>): boolean {
    if (record.reviewFormat !== 'brain-review-json-v6') return true
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    const approvedThroughSeq = this.approvalMarkerSeq(record, events)
    if (approvedThroughSeq === null) return false
    const quote = args.evidence_quote
    const sources = session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === 'user' && (!requiresLaterUserQuote(name)
        || typeof quote === 'string' && quote.trim().length > 0
          && message.content.some(block => block.type === 'text' && block.text.includes(quote))))
    if (requiresLaterUserQuote(name) && sources.length !== 1) return false
    const sourceIds = new Set(sources.map(message => message.id))
    return events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && sourceIds.has(event.data.id)
      && event.seq > approvedThroughSeq)
  }

  private executeOrderedTool(record: KnowledgeImportRecord, plan: OrderedPlan,
    changes: readonly KnowledgeImportReviewChange[], session: Session, proposalMessageId: MessageId,
    proposalSha256: string, index: number, execution: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    return this.run(record.manifest.id, execution.signal, async (signal) => {
      const current = this.record(record.workspaceId, record.manifest.id)
      if (!this.reviewApproved(current, session) || current.reviewDecisions?.at(-1)?.appliedSteps === undefined
        || this.reviewedChangeIndex(changes, execution.name, execution.arguments as Record<string, unknown>) !== index) {
        throw new Error('Knowledge import review approval is no longer current')
      }
      const change = changes[index]
      /* v8 ignore if -- The sole caller supplies this same private array's nonnegative findIndex result. */
      if (change === undefined) throw new Error('Knowledge import ordered review step is unavailable')
      const applied = current.reviewDecisions.at(-1)?.appliedSteps?.[index]
      if (applied !== undefined) {
        if (applied.index !== index || applied.changeSha256 !== change.sha256
          || applied.operationId !== change.arguments.operation_id
          || applied.targetProjectId !== plan.projectId || applied.path !== change.arguments.path) {
          throw new Error('Knowledge import completed-step receipt does not match the reviewed call')
        }
        return { isError: false, value: {
          acknowledgement: JSON.stringify({ operation_id: applied.operationId, path: applied.path,
            disposition: 'already-applied', ...(change.tool === 'brain_create_page'
              ? { project_id: applied.targetProjectId } : {}) }),
          receipt: { operationId: applied.operationId, documentId: applied.path,
            version: applied.postVersion, disposition: 'already-applied' },
        }, content: [] }
      }
      if (!this.hasPostApprovalUserConfirmation(current, session, execution.name,
        execution.arguments as Record<string, unknown>)) {
        throw new Error('Knowledge import needs a new user confirmation after this review approval')
      }
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const progress = await this.orderedProgress(current, plan, changes, session.snapshotEvents(),
        proposalMessageId, proposalSha256, signal)
      if (progress.status === 'blocked' || progress.status === 'awaiting-approval') {
        throw new Error(`Knowledge import ordered review is blocked: ${progress.reason ?? 'approval unavailable'}`)
      }
      if (index !== progress.nextChangeIndex) {
        throw new Error('Knowledge import review requires its next exact ordered step')
      }
      const before = await this.activeIndexState(plan.projectId, new Set([plan.newPath]), signal)
      const baseline = progress.appliedSteps[0]?.postActiveIndexDigest
        ?? current.reviewDecisions.at(-1)?.activeIndexDigests?.[plan.projectId]
      if (before === null || before.digest !== baseline || before.occupiedPaths.has(plan.newPath)) {
        throw new Error('Knowledge import active Brain catalog changed before its next step')
      }
      const decisions = current.reviewDecisions ?? []
      const approval = decisions.at(-1)
      /* v8 ignore if -- Entry validated this captured record's approval and steps; awaited reads cannot replace it. */
      if (approval?.decision !== 'approve' || approval.appliedSteps === undefined) {
        throw new Error('Knowledge import ordered review approval is unavailable')
      }
      const started: KnowledgeImportRecord = { ...current, reviewDecisions: [
        ...decisions.slice(0, -1), { ...approval, inFlight: { index,
          changeSha256: change.sha256, callId: execution.callId } },
      ] }
      signal.throwIfAborted()
      await this.table.put(record.manifest.id, started)
      const result = await next()
      if (result.isError) return result
      const parsed = brainWriteReceipt.safeParse(result.value)
      const receipt = parsed.success ? parsed.data.receipt : undefined
      if (change.tool === 'brain_create_page' && parsed.success && parsed.data.nonWriting === true && receipt === undefined) {
        await this.table.put(record.manifest.id, current)
        return result
      }
      if (receipt === undefined || receipt.disposition !== 'written'
        || receipt.operationId !== change.arguments.operation_id || receipt.documentId !== change.arguments.path) {
        throw new Error('Knowledge import Brain write has no new exact receipt; review is blocked')
      }
      const after = await this.activeIndexState(plan.projectId, new Set([plan.newPath]), signal)
      if (after === null || after.directory !== before.directory || after.locationRevision !== before.locationRevision) {
        throw new Error('Knowledge import active Brain catalog changed during its reviewed step')
      }
      const page = await this.ctx.knowledgeController.read(plan.projectId,
        brandString<KnowledgeDocumentId>(change.arguments.path), signal)
      if (page.entry.kind !== 'page' || page.entry.status !== 'active' || page.entry.version !== receipt.version) {
        throw new Error('Knowledge import Brain page differs from its actual writer receipt')
      }
      if (plan.kind === 'mixed' && index === 0) {
        const expected = before.pages.map(([path, version]) => [path,
          path === plan.existingPath ? receipt.version : version] as const)
        if (canonicalReviewJson(after.pages) !== canonicalReviewJson(expected)
          || after.occupiedPaths.has(plan.newPath)) {
          throw new Error('Knowledge import active Brain catalog changed during its reviewed update')
        }
      } else if (after.digest !== before.digest || !after.occupiedPaths.has(plan.newPath)) {
        throw new Error('Knowledge import active Brain catalog changed during its reviewed creation')
      }
      const step = { index, changeSha256: change.sha256, operationId: receipt.operationId,
        targetProjectId: plan.projectId, path: receipt.documentId, postVersion: receipt.version,
        postActiveIndexDigest: after.digest }
      const completed: KnowledgeImportRecord = { ...started, reviewDecisions: [
        ...decisions.slice(0, -1), { ...approval, appliedSteps: [...approval.appliedSteps, step] },
      ] }
      await this.table.put(record.manifest.id, completed)
      return result
    })
  }

  /** Check one model Brain call against the latest exact reviewed change, including every argument value.
   * @param session - live import Session whose proposal and owner must still match approval.
   * @param name - actual Brain tool name.
   * @param args - complete parsed model tool arguments, including explicit target project ID.
   * @param callId - current dispatch call identity for an ordered in-flight step.
   * @returns true only for a listed exact action in a current structured approval.
   */
  reviewAllowsTool(session: Session, name: string, args: Record<string, unknown>, callId?: string): boolean {
    const record = this.forSession(session.id)
    if (record === undefined || !this.reviewApproved(record, session)) return false
    const latest = record.reviewDecisions?.at(-1)
    /* v8 ignore if -- The preceding synchronous reviewApproved check requires this same record's listed changes. */
    if (latest?.changes === undefined) return false
    try {
      const reviewed = reviewExecutionArguments(name, args)
      if (reviewed === null) return false
      const sha256 = reviewChangeSha256(name, reviewed)
      const index = latest.changes.findIndex(change => change.tool === name && change.sha256 === sha256)
      if (index < 0) return false
      if (!this.hasPostApprovalUserConfirmation(record, session, name, args)) return false
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const changes = this.proposalChanges(record, settledProposal(session.snapshotEvents())?.text ?? '')
      if (usesTopicDiscovery(record.reviewFormat) && name === 'brain_create_page'
        && !approvedComparedPages(changes ?? [], latest.comparedPageChoices,
          latest.comparedPageReviewSha256)) return false
      if (changes === null || this.orderedPlan(record, changes) === null) return true
      return latest.inFlight?.index === index && latest.inFlight.changeSha256 === sha256
        && latest.inFlight.callId === callId
    } catch { return false }
  }

  private async sessionEvidence(record: KnowledgeImportRecord, signal: AbortSignal): Promise<{
    header: SessionHeader
    events: readonly SessionEvent[]
  } | null> {
    const live = this.ctx.agents.get(record.sessionId)
    if (live !== undefined && !await this.ctx.sessions.flush(live.session)) {
      throw new RemoteError('gateway/internal', 'knowledge import Session is not durable', {})
    }
    if (live === undefined && await this.ctx.sessionPersistence.stat(record.sessionId) === undefined) return null
    await using handle = await this.ctx.sessionPersistence.open(record.sessionId, 'read', { signal })
    return { header: handle.header, events: (await handle.read()).events }
  }

  private assertScope(workspaceId: WorkspaceId, manifest: KnowledgeImportManifest): void {
    if (manifest.scope !== undefined && !this.ctx.workspaceRegistry.spaces.some(space =>
      space.spaceId === manifest.scope?.spaceId && space.projectIds.includes(workspaceId))) this.refuse('project-changed')
  }

  /** Capture model-visible destination choices; review and execution recheck current membership independently. */
  private availableImportProjects(record: KnowledgeImportRecord): readonly { id: WorkspaceId; title: string }[] {
    const scope = record.manifest.scope
    if (scope === undefined) return []
    const space = this.ctx.workspaceRegistry.spaces.find(item => item.spaceId === scope.spaceId
      && item.projectIds.includes(record.workspaceId))
    if (space === undefined) this.refuse('project-changed')
    return space.projectIds.flatMap((id) => {
      const project = this.ctx.workspaceRegistry.get(id)
      if (project === undefined || project.archivedAt !== undefined) return []
      return currentRegisteredDirectory(project.path) ? [{ id, title: project.title }] : []
    })
  }

  private writableRoots(session: Session): readonly string[] {
    if (this.lifetime.signal.aborted) return []
    const record = [...this.table.entries()].find(([, value]) => value.sessionId === session.id)?.[1]
    const scope = record?.manifest.scope
    if (scope === undefined || record?.sessionBinding === undefined || record.execution === undefined
      || !this.reviewApproved(record, session)
      || record.sessionBinding.createdAt !== session.header.createdAt || record.sessionBinding.cwd !== session.header.cwd) return []
    const space = this.ctx.workspaceRegistry.spaces.find(space => space.spaceId === scope.spaceId
      && space.looseSessionIds?.includes(session.id) && space.projectIds.includes(record.workspaceId))
    const anchor = this.ctx.workspaceRegistry.get(record.workspaceId)
    if (space === undefined || anchor?.path !== record.workspacePath) return []
    const execution = this.ctx.workspaceRegistry.conversationExecutionProjects(session.id)
    if (execution === undefined) return []
    // Existing scoped import receipts retain their original grant until a selection is explicitly saved.
    const projectIds = execution.revision === 0 ? space.projectIds : execution.writableProjectIds
    const reviewedProjects = new Set(record.reviewDecisions?.at(-1)?.changes?.map(change => change.targetProjectId))
    return projectIds.filter(id => reviewedProjects.has(id)).flatMap((id) => {
      const project = this.ctx.workspaceRegistry.get(id)
      if (project === undefined || project.archivedAt !== undefined) return []
      return currentRegisteredDirectory(project.path) ? [project.path] : []
    })
  }

  private record(workspaceId: WorkspaceId, importId: KnowledgeImportId, allowAbandoned = false): KnowledgeImportRecord {
    const record = this.table.get(importId)
    if (record === undefined) this.refuse('import-not-found')
    this.assertOwner(record, workspaceId)
    if (!allowAbandoned && record.abandonedAt !== undefined) this.refuse('import-abandoned')
    return record
  }

  private run<T>(
    id: KnowledgeImportId,
    signal: AbortSignal,
    operation: (lifetime: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    if (this.operations.has(id) || this.operations.size >= this.config.maxConcurrent) this.refuse('busy')
    const work = Promise.resolve().then(() => {
      lifetime.throwIfAborted()
      return operation(lifetime)
    }).finally(() => { this.operations.delete(id) })
    this.operations.set(id, work)
    return work
  }

  private assertLimits(manifest: KnowledgeImportManifest): void {
    if (manifest.documents.length > this.config.maxDocuments) this.refuse('too-many-documents')
    let bytes = 0
    for (const document of manifest.documents) {
      if (document.bytes > this.config.maxSourceBytes) this.refuse('source-too-large')
      if (document.bytes > this.config.maxBatchSourceBytes - bytes) this.refuse('batch-too-large')
      bytes += document.bytes
    }
  }

  /** Preserve the import retry identity while exposing only a selected Brain's busy lock. */
  private async withBrainWriter<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      const failure = remoteErrorOf(error)
      if (failure?.code === 'knowledge/update' && failure.details.reason === 'busy') {
        throw new RemoteError('knowledge-import/rejected', 'selected Brain writer lock is busy',
          { reason: 'writer-busy', writerLockPath: failure.details.path })
      }
      throw error
    }
  }

  private refuse(reason: KnowledgeImportFailure): never {
    throw new RemoteError('knowledge-import/rejected', 'knowledge import was not accepted', { reason })
  }
}

export default KnowledgeImportController
