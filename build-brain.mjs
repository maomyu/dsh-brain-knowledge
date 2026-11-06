import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const upstream = resolve('vendor')
const output = resolve('dist/brain')
const source = name => resolve(upstream, name, 'src/index.ts')
const modules = new Map([
  ['@deepseek-ai/dsh-fs-local', source('dao-fs-local')],
  ['@deepseek-ai/dsh-api-task-controller', source('dao-task')],
  ['@deepseek-ai/dsh-workspace', source('dao-workspace')],
  ['@deepseek-ai/dsh-subagent-codex', source('dao-codex')],
  ['@deepseek-ai/dsh-subagent-claude-code', source('dao-claude')],
  ['@deepseek-ai/dsh-subagent/native-tools', resolve(upstream, 'dao-runtime/native-tools.ts')],
])

await rm(output, { recursive: true, force: true })
await build({
  entryPoints: {
    index: source('dao-knowledge'),
    model: resolve(upstream, 'dao-knowledge/src/model.ts'),
    curator: resolve(upstream, 'dao-knowledge/src/curator.ts'),
    task: source('dao-task'),
    workspace: source('dao-workspace'),
    artifact: source('dao-artifacts'),
    'goal-command': resolve('src/goal-command.js'),
    'fs-local': source('dao-fs-local'),
    'fs-sandbox': source('dao-fs-sandbox'),
  },
  outdir: output,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  plugins: [{
    name: 'harness-host-interface',
    setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-/ }, ({ path, importer }) => {
        if (path === '@deepseek-ai/dsh-fs' && !importer.endsWith('/dao-fs/compat.ts')) {
          return { path: resolve(upstream, 'dao-fs/compat.ts') }
        }
        if (modules.has(path)) return { path: modules.get(path) }
        if (['atomic-write', 'native-command', 'sandbox', 'subagent'].includes(path.slice('@deepseek-ai/dsh-'.length))) {
          return { path: '../../vendor/dao-runtime/' + path.slice('@deepseek-ai/dsh-'.length) + '.js', external: true }
        }
      })
      builder.onLoad({ filter: /\/dao-fs\/src\/tree\.ts$/ }, async ({ path }) => {
        const contents = (await readFile(path, 'utf8')).replace("from './types.ts'", "from '../compat.ts'")
        return { contents, loader: 'ts', resolveDir: dirname(path) }
      })
      builder.onLoad({ filter: /\/(curation-access|model-protocol)\.ts$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8')
        const contents = original.replace(/((?:exec\.)?agent\.session)\.workingDirectory\(\)/gu,
          '((ctx.get("workingDirectory")?.get($1) ?? $1.header.cwd))')
        if (original === contents) throw new Error('Expected a Dao working-directory read in ' + basename(path))
        return { contents, loader: 'ts', resolveDir: dirname(path) }
      })
    },
  }],
})
