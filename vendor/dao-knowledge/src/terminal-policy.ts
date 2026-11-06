/** Shared deployment-owned limits for independently hosted task knowledge. */
import z from '@deepseek-ai/schemastery'
import type { KnowledgeFilePolicy } from './files.ts'

/** Complete source, query, audit and request-lifetime limits. */
export interface TerminalKnowledgePolicy extends KnowledgeFilePolicy {
  maxReadBytes: number
  maxSearchResults: number
  maxSearchMatches: number
  maxEventBytes: number
  queryTimeoutMs: number
}

/** Every terminal limit is explicitly supplied by its owning deployment. */
export const TerminalKnowledgePolicy: z<TerminalKnowledgePolicy> = z.object({
  maxDocumentBytes: z.number().step(1).min(1).required(), maxIndexBytes: z.number().step(1).min(1).required(),
  maxEntries: z.number().step(1).min(1).required(), maxDepth: z.number().step(1).min(1).required(),
  maxReadBytes: z.number().step(1).min(1).required(), maxSearchResults: z.number().step(1).min(1).required(),
  maxSearchMatches: z.number().step(1).min(1).required(), maxEventBytes: z.number().step(1).min(1).required(),
  queryTimeoutMs: z.number().step(1).min(1).max(2147483647).required(),
})
