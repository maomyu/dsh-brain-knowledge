/** Loader-owned bounds for documentation source copies and their explicitly requested execution. */
import z from '@deepseek-ai/schemastery'
import type { ArtifactSiteConfig } from './site-run.ts'

/** Limits apply independently to preparation, package installation, readiness and live ownership checks. */
export const siteConfig = z.object({
  maxEntries: z.number().step(1).min(1).default(20000),
  maxDepth: z.number().step(1).min(1).default(32),
  maxFileBytes: z.number().step(1).min(1).default(25 * 1024 * 1024),
  maxTotalBytes: z.number().step(1).min(1).default(128 * 1024 * 1024),
  maxRenderedBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
  maxActiveSites: z.number().step(1).min(1).default(4),
  ownershipIntervalMs: z.number().step(1).min(1).max(2147483647).default(2000),
  packageManager: z.union([
    z.union(['auto', 'npm', 'pnpm']),
    z.object({ kind: z.union(['npm', 'pnpm']).required(), executable: z.string().min(1).required(),
      args: z.array(z.string().required()).required() }),
  ]).default('auto'),
  installTimeoutMs: z.number().step(1).min(1).max(2147483647).default(300000),
  startupTimeoutMs: z.number().step(1).min(1).max(2147483647).default(60000),
  probeTimeoutMs: z.number().step(1).min(1).max(2147483647).default(10000),
  pollIntervalMs: z.number().step(1).min(1).max(2147483647).default(200),
  graceMs: z.number().step(1).min(1).max(2147483647).default(10000),
  outputBytes: z.number().step(1).min(1).default(16384),
}) satisfies z<ArtifactSiteConfig>
