/** Private local authorization channel for a detached terminal's Brain queries. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createConnection, createServer } from 'node:net'

const POINTER_BYTES = 1024
const UNAVAILABLE = 'Terminal knowledge grant is unavailable; open the desktop app and retry this read'

/** One Host-owned grant endpoint; closing it denies further detached queries. */
export interface TerminalKnowledgeGrant {
  readonly path: string
  close(): Promise<void>
}

/** Serve fresh Host authorization without sharing the application registry or database with the terminal.
 * @param current - checks the original project and selected Brain at each connection.
 * @returns a private endpoint whose owner must close it on unload.
 */
export async function openTerminalKnowledgeGrant(current: () => boolean): Promise<TerminalKnowledgeGrant> {
  const directory = process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'dsh-knowledge-grant-'))
  const path = directory === undefined ? `\\\\.\\pipe\\dsh-knowledge-${randomUUID()}` : join(directory, 'grant.sock')
  const server = createServer((socket) => {
    let allowed = false
    try { allowed = current() } catch { /* Missing project or provider denies this query. */ }
    socket.end(allowed ? '1' : '0')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    if (directory !== undefined) await rmdir(directory)
    throw error
  }
  let closing: Promise<void> | undefined
  return { path, close: () => closing ??= (async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    if (directory !== undefined) {
      await rmdir(directory)
    }
  })() }
}

/** Atomically select one live Host endpoint for a private retained terminal profile.
 * @param pointer - owner-only file inside the retained profile's private knowledge directory.
 * @param socketPath - freshly opened Host socket; no prior endpoint is unlinked or adopted.
 */
export async function publishTerminalKnowledgeGrant(pointer: string, socketPath: string): Promise<void> {
  const temporary = `${pointer}.${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, socketPath })}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, pointer)
  } catch (error) {
    try { await unlink(temporary) }
    catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError }
    throw error
  }
}

async function selectedGrantPath(endpoint: string): Promise<string> {
  if (basename(endpoint) !== 'grant.json') return endpoint
  let file
  try {
    file = await open(endpoint, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > POINTER_BYTES || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
      throw new Error('Terminal knowledge grant pointer is unavailable')
    }
    const bytes = await file.readFile()
    if (bytes.byteLength > POINTER_BYTES) throw new Error('Terminal knowledge grant pointer is unavailable')
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
      || !('socketPath' in parsed) || typeof parsed.socketPath !== 'string' || parsed.socketPath.length === 0) {
      throw new Error('Terminal knowledge grant pointer is unavailable')
    }
    return parsed.socketPath
  } catch (error) {
    throw new Error(UNAVAILABLE, { cause: error })
  } finally { await file?.close() }
}

/** Confirm that the Host still owns the captured project and Brain selection.
 * @param path - endpoint from the private task profile.
 * @param signal - query timeout and terminal lifetime.
 * @returns after one live Host decision; absence and denial both reject.
 */
export async function requireTerminalKnowledgeGrant(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const selected = await selectedGrantPath(path)
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(selected)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error)
    }
    const abort = () => { finish(new Error('Terminal knowledge grant check was cancelled', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    socket.once('data', (data: Buffer) => {
      finish(data.length === 1 && data[0] === 49 ? undefined : new Error('Terminal knowledge grant was revoked'))
    })
    socket.once('error', (error) => { finish(new Error(UNAVAILABLE, { cause: error })) })
    socket.once('end', () => { finish(new Error(UNAVAILABLE)) })
  })
}
