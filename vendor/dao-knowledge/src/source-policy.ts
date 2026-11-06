/** Deployment bounds for project source lookup, separate from Brain-page search. */
import z from '@deepseek-ai/schemastery'

/** Every bound applies to one source-tool invocation. */
export interface SourcePolicy {
  /** Largest source file accepted by explicit reading. */
  maxFileBytes: number
  /** Files above this size require a line range and use byte-window streaming. */
  streamThresholdBytes: number
  /** Maximum lines without a range, and maximum requested streamed lines. */
  maxReadLines: number
  /** Bytes requested from the provider in each streaming window. */
  chunkBytes: number
  /** Maximum visible direct entries or glob matches. */
  maxEntries: number
  /** Maximum physical files considered by recursive lookup. */
  maxWalkFiles: number
  /** Maximum directory entries examined, including directories and excluded entries. */
  maxWalkEntries: number
  /** Maximum nested directories visited below the selected path. */
  maxDepth: number
  /** Largest complete file searched; larger files are reported as skipped. */
  maxSearchFileBytes: number
  /** Maximum matching lines returned across all searched files. */
  maxMatches: number
  /** Maximum matching lines retained from one file. */
  maxMatchesPerFile: number
  /** Maximum source characters displayed per matching line, including ellipsis. */
  maxLineCharacters: number
  /** Maximum synchronous JavaScript regular-expression execution time per file. */
  regexTimeoutMs: number
}

/** Observed source-tool defaults with explicit traversal and regex execution budgets. */
export const SourcePolicy: z<Partial<SourcePolicy>, SourcePolicy> = z.object({
  maxFileBytes: z.number().step(1).min(1).default(4194304),
  streamThresholdBytes: z.number().step(1).min(1).default(1048576),
  maxReadLines: z.number().step(1).min(1).default(2000),
  chunkBytes: z.number().step(1).min(1).default(65536),
  maxEntries: z.number().step(1).min(1).default(500),
  maxWalkFiles: z.number().step(1).min(1).default(5000),
  maxWalkEntries: z.number().step(1).min(1).default(50000),
  maxDepth: z.number().step(1).min(1).default(128),
  maxSearchFileBytes: z.number().step(1).min(1).default(262144),
  maxMatches: z.number().step(1).min(1).default(200),
  maxMatchesPerFile: z.number().step(1).min(1).default(20),
  maxLineCharacters: z.number().step(1).min(3).default(240),
  regexTimeoutMs: z.number().step(1).min(1).max(2147483647).default(100),
})
