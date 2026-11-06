/** Resolve a captured documentation artifact into a project and an explicit package-script choice without executing code. */
import { posix } from 'node:path'
import { z } from 'zod'

/** Source-relative project and fallback content locations resolved from captured file bytes. */
export interface SiteProject {
  readonly root: string
  readonly contentRoot: string
  readonly title: string
  readonly framework: string
  readonly hasPackage: boolean
  readonly scriptName: string | null
  readonly script: string | null
}

const markerSchema = z.object({ title: z.string().optional(), rootDir: z.string().optional(), framework: z.string().optional() })
const packageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional() })

function readJson<T>(bytes: Uint8Array, schema: z.ZodType<T>, file: string): T {
  try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch {
    // Captured manifest bytes are untrusted JSON; do not include their contents in diagnostics.
    throw new Error(`Invalid documentation project metadata: ${file}`)
  }
}

function sourcePath(value: string): string {
  if (value.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(value)) throw new Error('Documentation project root must stay inside its artifact')
  const path = posix.normalize(value)
  if (path === '..' || path.startsWith('../')) throw new Error('Documentation project root must stay inside its artifact')
  return path === '.' ? '' : path.replace(/\/$/, '')
}

/** Resolve metadata and choose only a recognized script name from the captured project.
 * @param files - complete source bytes captured by the site's preparation owner.
 * @param title - catalog title used when the optional site marker has no title.
 * @returns relative project/content roots and the retained script text; no package command or configuration module runs.
 */
export function resolveSiteProject(files: ReadonlyMap<string, Uint8Array>, title: string): SiteProject {
  const markerBytes = files.get('.mindmux-site.json')
  const marker = markerBytes === undefined ? undefined : readJson(markerBytes, markerSchema, '.mindmux-site.json')
  const contains = (directory: string): boolean => [...files.keys()].some(path => path.startsWith(`${directory}/`))
  const root = marker?.rootDir === undefined
    ? files.has('package.json') ? '' : contains('docs') ? 'docs' : ''
    : sourcePath(marker.rootDir)
  const path = (relative: string): string => root === '' ? relative : `${root}/${relative}`
  const packageFile = path('package.json')
  const packageBytes = files.get(packageFile)
  const metadata = packageBytes === undefined ? undefined : readJson(packageBytes, packageSchema, packageFile)
  const dependencies = { ...metadata?.dependencies, ...metadata?.devDependencies }
  let detected = 'generic'
  if (['mjs', 'ts', 'js'].some(extension => files.has(path(`astro.config.${extension}`)))) detected = 'astro-starlight'
  else if (contains(path('.vitepress'))) detected = 'vitepress'
  else if (['js', 'mjs', 'ts'].some(extension => files.has(path(`docusaurus.config.${extension}`)))) detected = 'docusaurus'
  else if (files.has(path('mkdocs.yml'))) detected = 'mkdocs'
  else if (['hugo.toml', 'hugo.yaml', 'config.toml'].some(file => files.has(path(file)))) detected = 'hugo'
  else if (files.has(path('_config.yml')) || 'hexo' in dependencies) detected = 'hexo'
  else if (['quartz.config.ts', 'quartz.config.js'].some(file => files.has(path(file))) || '@jackyzha0/quartz' in dependencies) detected = 'quartz'
  else if ('vitepress' in dependencies) detected = 'vitepress'
  else if ('@docusaurus/core' in dependencies) detected = 'docusaurus'
  else if ('astro' in dependencies || '@astrojs/starlight' in dependencies) detected = 'astro-starlight'
  const framework = marker?.framework?.trim() || detected
  const names = framework === 'docusaurus' ? ['start', 'dev']
    : framework === 'astro-starlight' ? ['dev', 'start']
      : framework === 'vitepress' ? ['dev', 'docs:dev', 'start'] : ['dev', 'docs:dev', 'start', 'serve']
  const script = names.map(name => ({ name, text: metadata?.scripts?.[name] })).find(candidate => candidate.text?.trim())
  const contentCandidates = framework === 'astro-starlight'
    ? ['src/content/docs', 'docs', 'content/docs'] : ['docs', 'src/content/docs', 'content/docs']
  const content = contentCandidates.find(candidate => contains(path(candidate)))
  return { root, contentRoot: content === undefined ? root : path(content), title: marker?.title?.trim() || title,
    framework, hasPackage: metadata !== undefined, scriptName: script?.name ?? null, script: script?.text ?? null }
}
