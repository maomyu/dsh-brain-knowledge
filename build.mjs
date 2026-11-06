import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  outdir: 'dist',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text', '.module.css': 'local-css' },
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': './src/primitives.jsx',
    '@deepseek-ai/dsh-util-crypto': './src/primitives.jsx',
  },
  inject: ['src/react-runtime.js'],
  legalComments: 'none',
  write: false,
})
await mkdir('dist', { recursive: true })
await writeFile('dist/client.js', [
  "window.__ModuleLoader__.load({ id: 'dsh-brain-knowledge', factory(require) {",
  'const module = { exports: {} }; let exports = module.exports;',
  'const workflowStyles = ' + JSON.stringify(result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '') + ';',
  result.outputFiles.find(file => file.path.endsWith('.js')).text,
  'return module.exports;',
  '} });',
].join('\n'))
