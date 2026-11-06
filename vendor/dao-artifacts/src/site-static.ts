/** Loopback-only, read-only documentation fallback served from captured bytes, not from live filesystem paths. */
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { posix } from 'node:path'
import type { Nodes } from 'hast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toHast } from 'mdast-util-to-hast'
import { toHtml } from 'hast-util-to-html'
import { gfm } from 'micromark-extension-gfm'
import type { SiteProject } from './site-project.ts'

/** One listening fallback site; its owner stops it before releasing the source snapshot. */
export interface StaticSite {
  readonly url: string
  /** Close the listener and its connections; concurrent calls share completion.
   * @returns after the server has closed.
   */
  stop(): Promise<void>
}

const mediaTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
}
const escapes: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => {
  /* v8 ignore next -- Every character matched by the fixed expression has a local escape entry. */
  return escapes[character] ?? character
})
const encoded = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
const markdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

function restrictLinks(node: Nodes): void {
  if (node.type === 'element') {
    for (const name of ['href', 'src']) {
      const value = node.properties[name]
      if (typeof value !== 'string') continue
      const normalized = value.replace(/[\u0000-\u0020\u007f]/gu, '')
      if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(https?|mailto):/i.test(normalized)) Reflect.deleteProperty(node.properties, name)
    }
  }
  if ('children' in node) for (const child of node.children) restrictLinks(child)
}

function render(source: Uint8Array, title: string, navigation: string): Buffer {
  const tree = toHast(fromMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(source), {
    extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
  }))
  restrictLinks(tree)
  return Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(title)}</title><style>body{margin:0;font:16px/1.7 system-ui;color:#20242c;background:#fafafa;display:flex}`
    + 'nav{width:230px;padding:24px;flex-shrink:0;background:#f0f1f3;min-height:100vh;box-sizing:border-box}nav a{display:block;overflow-wrap:anywhere}'
    + 'main{min-width:0;max-width:960px;padding:28px 36px}a{color:#205bbb}pre{overflow:auto;padding:16px;background:#eceef1}'
    + 'code{font-family:ui-monospace,monospace}table{border-collapse:collapse}th,td{border:1px solid #ccd0d5;padding:6px 12px}'
    + 'img{max-width:100%}@media(max-width:680px){body{display:block}nav{width:auto;min-height:0}main{padding:20px}}</style></head>'
    + `<body><nav aria-label="${escapeHtml(title)}"><strong>${escapeHtml(title)}</strong>${navigation}</nav><main>${toHtml(tree)}</main></body></html>`)
}

/** Serve captured pages on an authenticated loopback port with an explicit browser-script policy.
 * @param files - captured source bytes, already bounded by the preparation owner.
 * @param project - resolved content directory and display title.
 * @param maxRenderedBytes - inclusive complete response-body limit, including rendered HTML and raw assets.
 * @param signal - cancels binding; the lifetime owner joins stop after cancellation or shutdown.
 * @param scripts - local and inline scripts require a consented HTML project; fallback always disables scripts.
 * @returns an authenticated browser entry URL and an awaited shutdown operation.
 */
export async function startStaticSite(files: ReadonlyMap<string, Uint8Array>, project: SiteProject,
  maxRenderedBytes: number, signal: AbortSignal, scripts: 'disabled' | 'local'): Promise<StaticSite> {
  signal.throwIfAborted()
  const prefix = project.contentRoot === '' ? '' : `${project.contentRoot}/`
  const content = new Map<string, Uint8Array>()
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue
    const name = path.slice(prefix.length)
    if (name.split('/').some(part => part.startsWith('.'))) continue
    content.set(name, bytes)
  }
  const pages = [...content.keys()].filter(path => markdown(path) || /\.html?$/i.test(path)).sort()
  const first = pages[0]
  if (first === undefined) throw new Error('Documentation artifact has no HTML or Markdown pages for static preview')
  const index = ['index.html', 'index.htm', 'index.md', 'README.md'].find(path => content.has(path)) ?? first
  const navigation = pages.map(path => `<a href="/${encoded(path)}">${escapeHtml(path.replace(/\.(html?|md|markdown)$/i, ''))}</a>`).join('')
  const token = randomBytes(32).toString('hex')
  const cookie = `dsh_site_${randomBytes(16).toString('hex')}`
  const entry = `/__dsh_site__/${token}`
  let origin = ''
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
      + (scripts === 'local' ? "; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'" : ''))
    const end = (status: number): void => { response.statusCode = status; response.end() }
    if (request.headers.host !== origin.slice('http://'.length)) { end(403); return }
    if (request.method !== 'GET' && request.method !== 'HEAD') { end(405); return }
    let url: URL
    let path: string
    /* v8 ignore next -- Native HTTP server requests have a target; IncomingMessage also types client responses. */
    const target = request.url ?? '/'
    try { url = new URL(target, origin); path = decodeURIComponent(url.pathname) } catch { end(400); return }
    if (url.origin !== origin) { end(403); return }
    if (path === entry) {
      response.setHeader('Set-Cookie', `${cookie}=${token}; HttpOnly; SameSite=Lax; Path=/`)
      response.setHeader('Location', `/${encoded(index)}`)
      end(302)
      return
    }
    if (request.headers.origin !== undefined && request.headers.origin !== origin) { end(403); return }
    if (!(request.headers.cookie ?? '').split(';').some(value => value.trim() === `${cookie}=${token}`)) { end(403); return }
    const name = path === '/' ? index : path.slice(1)
    const bytes = content.get(name)
    if (bytes === undefined) { end(404); return }
    try {
      const body = markdown(name) ? render(bytes, project.title, navigation) : Buffer.from(bytes)
      if (body.byteLength > maxRenderedBytes) { end(413); return }
      response.setHeader('Content-Type', markdown(name) ? 'text/html; charset=utf-8' : mediaTypes[posix.extname(name).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('Content-Length', body.byteLength)
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch { end(422) }
  })
  server.on('upgrade', (_request, socket) => { socket.destroy() })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= new Promise<void>((resolve, reject) => {
    server.close((error) => {
      /* v8 ignore if -- Native Server.close reports only ERR_SERVER_NOT_RUNNING or no error. */
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
  try {
    const listening = once(server, 'listening', { signal })
    server.listen({ host: '127.0.0.1', port: 0, signal })
    await listening
    signal.throwIfAborted()
    const address = server.address()
    /* v8 ignore if -- The private listener bound a TCP address and cannot be stopped before this synchronous read. */
    if (address === null || typeof address === 'string') throw new Error('Documentation site has no loopback address')
    origin = `http://127.0.0.1:${address.port}`
    return { url: `${origin}${entry}`, stop }
  } catch (error) {
    try { await stop() }
    /* v8 ignore next -- The private native listener's close outcomes both resolve stop. */
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Documentation site binding and cleanup failed') }
    throw error
  }
}
