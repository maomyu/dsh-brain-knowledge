/** Durable import intent and attachment receipts; malformed records reject domain activation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { DocumentImportSourceId } from '@deepseek-ai/dsh-api-document-import-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KnowledgeAutomaticAuthorizationId, KnowledgeDocumentId, KnowledgeUpdateId } from '@deepseek-ai/dsh-api-knowledge-controller/types'
import { ReasoningEffortId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectSpaceId, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { KnowledgeImportCreationClaim, KnowledgeImportDraftActionId, KnowledgeImportId,
  KnowledgeImportPdfVisualCoverage, KnowledgeImportDocxVisualCoverage, KnowledgeImportPublicationReview,
  KnowledgeImportReviewId, KnowledgeImportState } from './types.ts'
import { canonicalReviewJson, comparedPageReviewSha256, reviewChangesSha256,
  sourceDispositionReviewSha256 } from './review-manifest.ts'

const leafName = z.string().min(1).max(1024)
  .refine(name => !/[/\\\0]/u.test(name) && name !== '.' && name !== '..')

/** Wire validation shared by initial submission and durable reads. */
export const manifestSchema = z.object({
  id: z.uuid().transform(value => brandString<KnowledgeImportId>(value)),
  locale: z.enum(['en', 'zh-CN']),
  scope: z.object({ kind: z.literal('workspace'),
    spaceId: z.string().min(1).transform(value => brandString<ProjectSpaceId>(value)),
  }).strict().optional(),
  maintenance: z.enum(['automatic', 'read-only']).optional(),
  documents: z.array(z.object({
    id: z.string().min(1).max(1024).transform(value => brandString<DocumentImportSourceId>(value)),
    name: leafName,
    format: z.enum(['text', 'docx', 'pdf']),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).min(1),
}).strict().refine(manifest => new Set(manifest.documents.map(document => document.id)).size === manifest.documents.length)

const attachment = z.object({
  attachmentId: z.string().min(1).transform(value => brandString<AttachmentId>(value)),
  name: leafName,
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

const pdfExtraction = z.object({
  kind: z.literal('pdf-text'),
  pageCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pagesWithoutText: z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)),
  pagesWithTextAndPaintedImages: z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).optional(),
}).strict().refine(value => value.pagesWithoutText.length <= value.pageCount
  && value.pagesWithoutText.every((page, index, pages) => page <= value.pageCount
    && page > (pages[index - 1] ?? 0))
  && (value.pagesWithTextAndPaintedImages === undefined
    || value.pagesWithTextAndPaintedImages.length <= value.pageCount - value.pagesWithoutText.length
      && value.pagesWithTextAndPaintedImages.every((page, index, pages) => page <= value.pageCount
        && page > (pages[index - 1] ?? 0) && !value.pagesWithoutText.includes(page))))

const docxExtraction = z.object({
  kind: z.literal('docx-text'),
  imageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  imagesWithoutDescription: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.imagesWithoutDescription <= value.imageCount)

const receiptSchema = z.object({
  id: z.string().transform(value => brandString<DocumentImportSourceId>(value)),
  source: attachment,
  text: attachment,
  extraction: z.discriminatedUnion('kind', [pdfExtraction, docxExtraction]).optional(),
}).strict()

const imageAttachment = z.object({
  attachmentId: z.string().min(1).transform(value => brandString<AttachmentId>(value)),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  name: leafName.optional(),
  originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
}).strict().transform((value): ImageAttachmentRef => {
  const { name, originalDimensions, ...required } = value
  return { ...required, ...name === undefined ? {} : { name },
    ...originalDimensions === undefined ? {} : { originalDimensions } }
}) satisfies z.ZodType<ImageAttachmentRef>

const pdfVisualCoverage = z.object({
  pageCount: z.number().int().positive(),
  renderedPages: z.array(z.number().int().positive()),
  omittedReason: z.enum(['text-only-route', 'page-limit', 'byte-limit', 'render-failed']).optional(),
}).strict().refine(value => value.renderedPages.length <= value.pageCount
  && value.renderedPages.every((page, index) => page === index + 1)
  && (value.renderedPages.length === value.pageCount) === (value.omittedReason === undefined)) satisfies
  z.ZodType<KnowledgeImportPdfVisualCoverage>

const docxVisualCoverage = z.object({
  imageCount: z.number().int().nonnegative(),
  suppliedImages: z.array(z.number().int().positive()),
  omittedImages: z.array(z.object({ image: z.number().int().positive(),
    reason: z.enum(['text-only-route', 'image-limit', 'byte-limit', 'unsupported-format', 'unreadable-image']),
  }).strict()),
  layoutReviewed: z.literal(false),
}).strict().refine((value) => {
  const numbers = [...value.suppliedImages, ...value.omittedImages.map(item => item.image)].sort((a, b) => a - b)
  return numbers.length === value.imageCount && numbers.every((image, index) => image === index + 1)
    && value.suppliedImages.every((image, index) => image > (value.suppliedImages[index - 1] ?? 0))
    && value.omittedImages.every((item, index) => item.image > (value.omittedImages[index - 1]?.image ?? 0))
}) satisfies z.ZodType<KnowledgeImportDocxVisualCoverage>

const pdfVisualSchema = z.object({
  documentId: z.string().min(1).transform(value => brandString<DocumentImportSourceId>(value)),
  coverage: pdfVisualCoverage,
  images: z.array(imageAttachment),
}).strict()
const docxVisualSchema = z.object({
  documentId: z.string().min(1).transform(value => brandString<DocumentImportSourceId>(value)),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  coverage: docxVisualCoverage,
  images: z.array(imageAttachment),
}).strict()
const automaticVisualSchema = z.object({ pdfVisual: z.array(pdfVisualSchema), docxVisual: z.array(docxVisualSchema) }).strict()

const executionSchema = z.object({
  /** Absent from older imports; a new Session must publish the matching first event. */
  creationClaim: z.uuid().transform(value => brandString<KnowledgeImportCreationClaim>(value)).optional(),
  selection: z.object({
    provider: z.string().min(1), model: z.string().min(1),
    reasoningEffort: z.string().transform(ReasoningEffortId).optional(),
  }).strict(),
  agentPreset: z.string().min(1).optional(),
  pdfVisual: z.array(pdfVisualSchema).optional(),
  docxVisual: z.array(docxVisualSchema).optional(),
  message: z.object({
    id: z.string().min(1).transform(value => brandString<MessageId>(value)),
    role: z.literal('user'),
    source: z.object({
      kind: z.literal('knowledge-import'),
      importId: z.uuid().transform(value => brandString<KnowledgeImportId>(value)),
    }).strict(),
    requiredInputModalities: z.array(z.literal('image')).min(1).optional(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string().min(1) }).strict(),
      z.object({ type: z.literal('file'), attachment }).strict(),
      z.object({ type: z.literal('image'), attachment: imageAttachment }).strict(),
    ])).min(2),
  }).strict().refine(message => message.content.some(block => block.type === 'image')
    === (message.requiredInputModalities?.includes('image') === true))
    .transform((message): UserMessage & { source: { kind: 'knowledge-import'; importId: KnowledgeImportId } } => {
      const { requiredInputModalities, ...required } = message
      return { ...required, ...requiredInputModalities === undefined ? {} : { requiredInputModalities } }
    }),
  status: z.enum(['prepared', 'accepted']),
}).strict().refine(execution => (execution.pdfVisual?.flatMap(item => item.images) ?? []).length
  + (execution.docxVisual?.flatMap(item => item.images) ?? []).length
  === execution.message.content.filter(block => block.type === 'image').length)

const discoveryReceiptSchema = z.object({
  changeIndex: z.number().int().min(0),
  targetProjectId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  mode: z.enum(['search', 'empty-index']),
  query: z.string().min(1).optional(),
  exists: z.boolean(),
  hits: z.array(z.object({ path: z.string().min(1), title: z.string().min(1), version: z.string().min(1) }).strict()),
}).strict().refine(value => value.mode === 'search' ? value.query !== undefined
  : value.query === undefined && value.hits.length === 0)

const comparedPageChoiceSchema = z.object({
  changeIndex: z.number().int().min(0), pageIndex: z.number().int().min(0),
  changeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  targetProjectId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  path: z.string().min(1), version: z.string().min(1),
  pageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  relation: z.enum(['distinct', 'duplicate', 'conflict', 'unknown']),
}).strict()

const comparedPageReviewSchema = z.object({
  proposalMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  choices: z.array(comparedPageChoiceSchema),
}).strict()

const comparedPageReadSchema = comparedPageChoiceSchema.omit({ relation: true }).extend({
  proposalMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

const sourceDispositionChoiceSchema = z.object({
  changeIndex: z.number().int().min(0), sourceIndex: z.number().int().min(0),
  changeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  documentId: z.string().min(1).transform(value => brandString<DocumentImportSourceId>(value)),
  dispositionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  judgment: z.enum(['unknown', 'confirmed', 'disputed']),
}).strict()

const sourceDispositionReviewSchema = z.object({
  proposalMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  choices: z.array(sourceDispositionChoiceSchema),
}).strict()

const reviewDecisionSchema = z.object({
  operationId: z.uuid().transform(value => brandString<KnowledgeImportReviewId>(value)),
  decision: z.enum(['approve', 'reject']),
  proposalMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  changes: z.array(z.object({
    tool: z.string().min(1),
    targetProjectId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).min(1).optional(),
  changesSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  discovery: z.array(discoveryReceiptSchema).max(1).optional(),
  discoverySha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  comparedPageChoices: z.array(comparedPageChoiceSchema).optional(),
  comparedPageReviewSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  sourceDispositionChoices: z.array(sourceDispositionChoiceSchema).optional(),
  sourceDispositionReviewSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  receiptsSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  activeIndexDigests: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  appliedSteps: z.array(z.object({
    index: z.number().int().min(0).max(1),
    changeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: z.uuid(),
    targetProjectId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
    path: z.string().min(1),
    postVersion: z.string().min(1),
    postActiveIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).max(2).optional(),
  inFlight: z.object({ index: z.number().int().min(0).max(1),
    changeSha256: z.string().regex(/^[a-f0-9]{64}$/u), callId: z.string().min(1) }).strict().optional(),
  /** Null until the exact v6 approval marker is durable; a number orders later user messages by Session sequence. */
  approvedThroughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  approvedAt: z.number().int().min(0).optional(),
  decidedAt: z.number().int().min(0),
}).strict().refine((value) => {
  if (value.approvedThroughSeq !== undefined && value.decision !== 'approve') return false
  if ((typeof value.approvedThroughSeq === 'number') !== (value.approvedAt !== undefined)) return false
  if ((value.changes === undefined) !== (value.changesSha256 === undefined)) return false
  if ((value.discovery === undefined) !== (value.discoverySha256 === undefined)) return false
  if ((value.comparedPageChoices === undefined) !== (value.comparedPageReviewSha256 === undefined)) return false
  if ((value.sourceDispositionChoices === undefined) !== (value.sourceDispositionReviewSha256 === undefined)) return false
  if (value.comparedPageChoices !== undefined
    && value.comparedPageReviewSha256 !== comparedPageReviewSha256(value.comparedPageChoices)) return false
  if (value.sourceDispositionChoices !== undefined
    && value.sourceDispositionReviewSha256 !== sourceDispositionReviewSha256(value.sourceDispositionChoices)) return false
  if (value.discovery !== undefined && value.discoverySha256 !== createHash('sha256')
    .update(canonicalReviewJson(value.discovery)).digest('hex')) return false
  const changes = value.changes
  if (changes === undefined) return true
  return value.changesSha256 === reviewChangesSha256(changes)
      && (value.appliedSteps === undefined || value.decision === 'approve'
        && value.appliedSteps.every((step, index) => step.index === index
          && changes[index]?.sha256 === step.changeSha256
          && changes[index].targetProjectId === step.targetProjectId
          && changes[index].path === step.path))
      && (value.inFlight === undefined || value.decision === 'approve'
        && value.inFlight.index === (value.appliedSteps?.length ?? 0)
        && changes[value.inFlight.index]?.sha256 === value.inFlight.changeSha256)
})

const zeroHitDraftSchema = z.object({
  operationId: z.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
  proposalMessageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  changeIndex: z.number().int().min(0).max(1),
  changeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  targetProjectId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  path: z.string().regex(/^pages\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u),
  sourceDocumentId: z.string().min(1).transform(value => brandString<DocumentImportSourceId>(value)),
  sourceQuote: z.string().min(1),
  reason: z.enum(['zero-hit-draft-required', 'source-conflict-draft-required',
    'discovery-coverage-draft-required']).optional(),
  originalBodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  originalTitle: z.string().min(1),
  baselineActiveIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  savedVersion: z.string().min(1).optional(),
  /** Absent on historical drafts; each receipt belongs to this draft and one observed catalog. */
  catalogPageReads: z.array(z.object({ draftVersion: z.string().min(1), activeIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    path: z.string().min(1), title: z.string().min(1), version: z.string().min(1),
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).optional(),
  publication: z.object({
    operationId: z.uuid().transform(value => brandString<KnowledgeImportDraftActionId>(value)),
    expectedDraftVersion: z.string().min(1),
    expectedActiveIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewedPages: z.array(z.object({ path: z.string().min(1), title: z.string().min(1),
      version: z.string().min(1), relation: z.enum(['distinct', 'duplicate', 'conflict', 'unknown']),
    }).strict()).optional(),
    /** Absent on historical intents, which cannot authorize a new status write. */
    reviewedPageBodies: z.array(z.object({ path: z.string().min(1),
      bodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict()).optional(),
    publishedVersion: z.string().min(1).optional(),
    review: z.discriminatedUnion('status', [
      z.object({ status: z.literal('verified'), observedActiveIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
      z.object({ status: z.literal('required'), reason: z.literal('active-catalog-changed'),
        observedActiveIndexDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
      z.object({ status: z.literal('unknown'), reason: z.enum([
        'catalog-unavailable', 'receipt-recovered', 'receipt-unconfirmed', 'not-recorded',
      ]) }).strict(),
    ]).optional(),
  }).strict().optional(),
}).strict().refine(value => value.publication === undefined || value.savedVersion !== undefined
  && (value.publication.review === undefined || value.publication.publishedVersion !== undefined))

const automaticSchema = z.object({
  authorizationId: z.uuid().transform(value => brandString<KnowledgeAutomaticAuthorizationId>(value)),
  status: z.enum(['reviewing', 'applying', 'updated', 'no-change', 'deferred', 'failed', 'budget-stopped']),
  rounds: z.number().int().nonnegative(),
  budgetStart: z.number().int().nonnegative(),
  writes: z.array(z.object({ documentId: z.string().min(1).transform(value => brandString<KnowledgeDocumentId>(value)),
    version: z.string().min(1), operationId: z.uuid().transform(value => brandString<KnowledgeUpdateId>(value)) }).strict()),
  processedMessages: z.array(z.string().min(1)),
  candidateDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
  reason: z.enum(['conflict', 'source-incomplete', 'catalog-changed', 'disabled', 'unavailable', 'unknown', 'invalid-review', 'repeated-candidate']).optional(),
  catalog: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.string().nullable(),
    pages: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()),
  }).strict().optional(),
  /** Latest prepared source references, reused without replacing the original execution input. */
  visual: automaticVisualSchema.optional(),
  /** Serialized Host request is parsed by the shared AI-maintenance validator before every use. */
  pending: z.object({ messageId: z.string().min(1), requestJson: z.string().min(1) }).strict().optional(),
  continuation: z.object({ id: z.string().min(1).transform(value => brandString<MessageId>(value)), text: z.string().min(1),
    /** Optional on historical text-only continuations; absence cannot imply visual coverage. */
    visual: automaticVisualSchema.optional(),
  }).strict().optional(),
}).strict().refine(value => value.budgetStart <= value.rounds
  && new Set(value.processedMessages).size === value.processedMessages.length
  && new Set(value.candidateDigests).size === value.candidateDigests.length)

const recordSchema = z.object({
  workspaceId: z.string().min(1).transform(value => brandString<WorkspaceId>(value)),
  workspacePath: z.string().min(1),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  /** Omitted on imports created before evidence-bound review. */
  reviewFormat: z.enum(['brain-review-json-v2', 'brain-review-json-v3', 'brain-review-json-v4', 'brain-review-json-v5', 'brain-review-json-v6']).optional(),
  manifest: manifestSchema,
  receipts: z.array(receiptSchema),
  abandonedAt: z.number().int().min(0).optional(),
  execution: executionSchema.optional(),
  sessionBinding: z.object({ createdAt: z.number(), cwd: z.string().optional() }).strict().optional(),
  comparedPageReview: comparedPageReviewSchema.optional(),
  comparedPageReads: z.array(comparedPageReadSchema).optional(),
  sourceDispositionReview: sourceDispositionReviewSchema.optional(),
  reviewDecisions: z.array(reviewDecisionSchema).refine(decisions =>
    new Set(decisions.map(decision => decision.operationId)).size === decisions.length).optional(),
  zeroHitDraft: zeroHitDraftSchema.optional(),
  automatic: automaticSchema.optional(),
}).strict().refine((record) => {
  if ((record.manifest.maintenance === 'automatic') !== (record.automatic !== undefined)) return false
  if (record.manifest.maintenance !== undefined && (record.reviewDecisions !== undefined || record.zeroHitDraft !== undefined)) return false
  if (record.abandonedAt !== undefined && (record.execution?.status === 'accepted'
    || record.reviewDecisions !== undefined)) return false
  if (record.reviewDecisions?.length !== undefined && record.reviewDecisions.length > 0
    && record.execution?.status !== 'accepted') return false
  if (record.zeroHitDraft !== undefined && (record.execution?.status !== 'accepted'
    || record.reviewFormat !== 'brain-review-json-v5' && record.reviewFormat !== 'brain-review-json-v6'
    || record.zeroHitDraft.operationId === record.zeroHitDraft.publication?.operationId)) return false
  if (record.reviewFormat !== undefined && record.reviewDecisions?.some(decision =>
    decision.decision === 'approve' && decision.changes !== undefined && decision.receiptsSha256 === undefined)) return false
  if ((record.reviewFormat === 'brain-review-json-v5' || record.reviewFormat === 'brain-review-json-v6')
    && record.reviewDecisions?.some(decision =>
      decision.decision === 'approve' && decision.changes !== undefined
      && (decision.discovery === undefined || decision.discoverySha256 === undefined))) return false
  if (new Set(record.receipts.map(receipt => receipt.id)).size !== record.receipts.length) return false
  for (const continuedVisual of [record.automatic?.visual, record.automatic?.continuation?.visual]) {
    if (continuedVisual === undefined) continue
    const identities = [...continuedVisual.pdfVisual, ...continuedVisual.docxVisual].map(item => item.documentId)
    if (new Set(identities).size !== identities.length) return false
    if (continuedVisual.pdfVisual.some((item) => {
      const document = record.manifest.documents.find(document => document.id === item.documentId)
      const receipt = record.receipts.find(receipt => receipt.id === item.documentId)
      return document?.format !== 'pdf' || receipt?.extraction?.kind !== 'pdf-text'
        || item.coverage.pageCount !== receipt.extraction.pageCount || item.images.length !== item.coverage.renderedPages.length
    }) || continuedVisual.docxVisual.some((item) => {
      const document = record.manifest.documents.find(document => document.id === item.documentId)
      const receipt = record.receipts.find(receipt => receipt.id === item.documentId)
      return document?.format !== 'docx' || document.sha256 !== item.sourceSha256 || receipt?.extraction?.kind !== 'docx-text'
        || item.coverage.imageCount !== receipt.extraction.imageCount || item.images.length !== item.coverage.suppliedImages.length
    })) return false
  }
  if (record.execution !== undefined) {
    if (record.receipts.length !== record.manifest.documents.length
      || record.execution.message.source.importId !== record.manifest.id) return false
    const files = record.execution.message.content.filter(block => block.type === 'file')
    const expected = record.manifest.documents.map(document => record.receipts.find(receipt => receipt.id === document.id)?.text)
    if (JSON.stringify(files.map(file => file.attachment)) !== JSON.stringify(expected)) return false
    if (record.execution.message.content[0]?.type !== 'text') return false
    const imageCount = record.execution.message.content.filter(block => block.type === 'image').length
    const textCount = record.execution.message.content.filter(block => block.type === 'text').length
    if (textCount < 1 + imageCount || textCount > 1 + imageCount + (record.execution.pdfVisual?.length ?? 0)) return false
    if (record.execution.pdfVisual !== undefined) {
      const visual = record.execution.pdfVisual
      if (new Set(visual.map(item => item.documentId)).size !== visual.length) return false
      if (!visual.every((item) => {
        const document = record.manifest.documents.find(document => document.id === item.documentId)
        const receipt = record.receipts.find(receipt => receipt.id === item.documentId)
        return document?.format === 'pdf' && receipt?.extraction?.kind === 'pdf-text'
          && item.coverage.pageCount === receipt.extraction.pageCount
          && item.images.length === item.coverage.renderedPages.length
      })) return false
      const images = record.execution.message.content.filter(block => block.type === 'image')
      if (JSON.stringify(images.map(block => block.attachment)) !== JSON.stringify([
        ...visual.flatMap(item => item.images), ...(record.execution.docxVisual?.flatMap(item => item.images) ?? []),
      ])) return false
    }
    if (record.execution.docxVisual !== undefined) {
      const visual = record.execution.docxVisual
      if (new Set(visual.map(item => item.documentId)).size !== visual.length) return false
      if (!visual.every((item) => {
        const document = record.manifest.documents.find(document => document.id === item.documentId)
        const receipt = record.receipts.find(receipt => receipt.id === item.documentId)
        return document?.format === 'docx' && document.sha256 === item.sourceSha256
          && receipt?.extraction?.kind === 'docx-text' && item.coverage.imageCount === receipt.extraction.imageCount
          && item.images.length === item.coverage.suppliedImages.length
      })) return false
      const images = record.execution.message.content.filter(block => block.type === 'image')
      if (JSON.stringify(images.map(block => block.attachment)) !== JSON.stringify([
        ...(record.execution.pdfVisual?.flatMap(item => item.images) ?? []), ...visual.flatMap(item => item.images),
      ])) return false
    }
  }
  return record.receipts.every(receipt => record.manifest.documents.some(document =>
    document.id === receipt.id && document.bytes === receipt.source.bytes
    && (receipt.extraction === undefined || document.format === 'pdf' && receipt.extraction.kind === 'pdf-text'
      || document.format === 'docx' && receipt.extraction.kind === 'docx-text')))
}, 'import receipts must uniquely match frozen source identities and byte lengths')

/** One immutable stored selection and its fully committed document pairs. */
export type KnowledgeImportRecord = z.infer<typeof recordSchema>

/** A committed publication without a retained comparison requires review rather than presumed verification.
 * @param draft - durable held-draft record.
 * @returns publication-time comparison only after the status receipt is recorded.
 */
export function publicationReviewOf(draft: KnowledgeImportRecord['zeroHitDraft']): KnowledgeImportPublicationReview | undefined {
  const publication = draft?.publication
  if (publication?.publishedVersion === undefined) return undefined
  return publication.review ?? { status: 'unknown', reason: 'not-recorded' }
}

/** Durable metadata only; original and converted bytes belong to the attachment service. */
export const knowledgeImportDomain = defineDomain({
  name: 'knowledge_import',
  version: 1,
  tables: { imports: domainTable<KnowledgeImportId, KnowledgeImportRecord>(recordSchema) },
})

/**
 * Project one committed record without exposing document bytes or Host paths.
 * @param record - durable selection and complete attachment pairs.
 * @param sessionCreated - independently observed durable Session existence.
 * @param confirmationBoundaryReady - whether the approved v6 sequence identifies its exact Session marker.
 * @returns metadata suitable for a reconnecting Client.
 */
export function importState(record: KnowledgeImportRecord, sessionCreated: boolean,
  confirmationBoundaryReady: boolean): KnowledgeImportState {
  const stored = new Map(record.receipts.map(receipt => [receipt.id, receipt]))
  const decisions = record.reviewDecisions ?? []
  const latest = decisions.at(-1)
  const publicationReview = publicationReviewOf(record.zeroHitDraft)
  return {
    id: record.manifest.id,
    sessionId: record.sessionId,
    sessionCreated,
    locale: record.manifest.locale,
    ...record.manifest.scope === undefined ? {} : { scope: record.manifest.scope },
    ...record.manifest.maintenance === undefined ? {} : { maintenance: record.manifest.maintenance },
    ...record.automatic === undefined ? {} : { automatic: {
      status: record.automatic.status, rounds: record.automatic.rounds, writes: record.automatic.writes,
      ...record.automatic.reason === undefined ? {} : { reason: record.automatic.reason },
      recoverable: ['failed', 'deferred', 'budget-stopped'].includes(record.automatic.status),
    } },
    status: record.abandonedAt !== undefined ? 'abandoned'
      : record.execution?.status === 'accepted' ? 'accepted'
        : stored.size === record.manifest.documents.length ? 'ready' : 'preparing',
    ...record.abandonedAt === undefined ? {} : { abandonedAt: record.abandonedAt },
    ...latest === undefined ? {} : { review: {
      revision: decisions.length,
      operationId: latest.operationId,
      decision: latest.decision === 'approve' ? 'approved' as const : 'rejected' as const,
      proposalMessageId: latest.proposalMessageId,
      proposalSha256: latest.proposalSha256,
      ...latest.changes === undefined || latest.changesSha256 === undefined ? {} : {
        changes: latest.changes,
        changesSha256: latest.changesSha256,
      },
      ...latest.discoverySha256 === undefined ? {} : { discoverySha256: latest.discoverySha256 },
      ...latest.comparedPageReviewSha256 === undefined ? {} : {
        comparedPageReviewSha256: latest.comparedPageReviewSha256 },
      ...latest.sourceDispositionReviewSha256 === undefined ? {} : {
        sourceDispositionReviewSha256: latest.sourceDispositionReviewSha256 },
      ...latest.appliedSteps === undefined ? {} : { appliedSteps: latest.appliedSteps },
      ...record.reviewFormat !== 'brain-review-json-v6' || latest.decision !== 'approve' ? {} : {
        confirmationBoundaryReady,
      },
      decidedAt: latest.decidedAt,
    } },
    ...record.zeroHitDraft === undefined ? {} : { zeroHitDraft: {
      operationId: record.zeroHitDraft.operationId,
      proposalMessageId: record.zeroHitDraft.proposalMessageId,
      proposalSha256: record.zeroHitDraft.proposalSha256,
      changeIndex: record.zeroHitDraft.changeIndex,
      changeSha256: record.zeroHitDraft.changeSha256,
      targetProjectId: record.zeroHitDraft.targetProjectId,
      path: record.zeroHitDraft.path,
      sourceDocumentId: record.zeroHitDraft.sourceDocumentId,
      sourceQuote: record.zeroHitDraft.sourceQuote,
      ...record.zeroHitDraft.reason === undefined ? {} : { reason: record.zeroHitDraft.reason },
      phase: record.zeroHitDraft.publication?.publishedVersion !== undefined ? 'published' as const
        : record.zeroHitDraft.savedVersion !== undefined ? 'saved' as const : 'saving' as const,
      ...record.zeroHitDraft.savedVersion === undefined ? {} : { savedVersion: record.zeroHitDraft.savedVersion },
      ...record.zeroHitDraft.publication === undefined ? {} : {
        publicationOperationId: record.zeroHitDraft.publication.operationId,
        ...record.zeroHitDraft.publication.publishedVersion === undefined ? {} : {
          publishedVersion: record.zeroHitDraft.publication.publishedVersion,
        },
        ...publicationReview === undefined ? {} : { publicationReview },
        ...record.zeroHitDraft.publication.publishedVersion === undefined ? { pendingPublication: {
          operationId: record.zeroHitDraft.publication.operationId,
          expectedDraftVersion: record.zeroHitDraft.publication.expectedDraftVersion,
          expectedActiveIndexDigest: record.zeroHitDraft.publication.expectedActiveIndexDigest,
          ...record.zeroHitDraft.publication.reviewedPages === undefined
            || record.zeroHitDraft.publication.reviewedPageBodies === undefined ? {} : {
              reviewedPages: record.zeroHitDraft.publication.reviewedPages,
            },
        } } : {},
      },
    } },
    documents: record.manifest.documents.map((document) => {
      const receipt = stored.get(document.id)
      const visual = (record.automatic?.visual?.pdfVisual ?? record.automatic?.continuation?.visual?.pdfVisual
        ?? record.execution?.pdfVisual)
        ?.find(item => item.documentId === document.id)?.coverage
      const docxVisual = (record.automatic?.visual?.docxVisual ?? record.automatic?.continuation?.visual?.docxVisual
        ?? record.execution?.docxVisual)
        ?.find(item => item.documentId === document.id)?.coverage
      return {
        ...document,
        status: receipt === undefined ? 'pending' as const : 'stored' as const,
        ...receipt?.extraction === undefined ? {} : { extraction: receipt.extraction },
        ...visual === undefined ? {} : { visual },
        ...docxVisual === undefined ? {} : { docxVisual },
      }
    }),
  }
}
