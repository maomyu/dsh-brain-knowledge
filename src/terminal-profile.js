import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { apply as register, inject } from '../vendor/dao-knowledge/src/terminal-profile.ts'

export { inject }

export function apply(ctx) {
  if (process.platform !== 'darwin') return
  const launcher = process.argv[1]
  if (!launcher || !isAbsolute(launcher)) return
  const require = createRequire(launcher)
  const cliEntry = process.env.DSH_DESKTOP_CLI_ENTRY
    ?? join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  register(ctx, {
    executable: process.execPath,
    cliEntry,
    launchEnvironment: process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1'
      ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    policy: {
      maxDocumentBytes: 1048576, maxIndexBytes: 2097152, maxEntries: 1000, maxDepth: 6,
      maxReadBytes: 65536, maxSearchResults: 20, maxSearchMatches: 3, maxEventBytes: 1048576, queryTimeoutMs: 30000,
    },
  })
}
