import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrainStore } from '../src/store.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-brain-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = { id: randomUUID(), title: '家政服务', path: join(directory, 'project'), sessionIds: ['session-1'] }
  const other = { id: randomUUID(), title: '运营项目', path: join(directory, 'other'), sessionIds: [] }
  const data = join(directory, 'storage')
  await mkdir(join(project.path, 'brain', 'pages'), { recursive: true })
  const store = () => new BrainStore(data, () => [project, other])
  const save = overrides => ({
    op: 'save', projectId: project.id, path: 'pages/notes.md', title: '服务交接', body: '# 服务交接\n再次核对地址',
    status: 'active', revision: null, operationId: randomUUID(), ...overrides,
  })
  return { directory, data, project, other, store, save }
}

test('saves durably, deduplicates retry, and refuses concurrent stale writes', async t => {
  const { store, save, project } = await fixture(t)
  const brain = store()
  const initial = save()
  const first = (await brain.request(initial)).page
  const retry = (await store().request(initial)).page
  assert.equal(first.revision, retry.revision)
  const results = await Promise.all(['回访', '交接'].map(body => brain.request(save({ body, revision: first.revision }))))
  assert.ok(results[0].page.revision !== first.revision)
  assert.equal(results[1].conflict, true)
  const saved = (await store().request({ op: 'read', projectId: project.id, path: first.path })).page
  assert.equal(saved.body, '回访')
  assert.equal(saved.versions[0].body, initial.body)
})

test('indexes legacy Markdown safely and searches only the selected project by default', async t => {
  const { directory, project, other, store, save } = await fixture(t)
  const legacy = join(project.path, 'brain', 'pages', 'legacy.md')
  await writeFile(legacy, '---\nstatus: draft\n---\n# 资料核对\n先找合同')
  const outside = join(directory, 'secret.md')
  await writeFile(outside, '# 不可读')
  await symlink(outside, join(project.path, 'brain', 'pages', 'link.md'))
  const brain = store()
  await brain.request(save({ projectId: other.id, title: '资料核对' }))
  const input = { op: 'search', projectId: project.id, query: '核对 合同' }
  assert.deepEqual((await brain.request(input)).pages, [])
  const draft = (await brain.request({ ...input, drafts: true })).pages[0]
  assert.equal(draft.title, '资料核对')
  assert.equal(draft.projectId, project.id)
  assert.deepEqual((await brain.request({ ...input, query: '不可读', drafts: true })).pages, [])
  const updated = await brain.request(save({ path: draft.path, title: draft.title, body: '新正文', revision: draft.revision }))
  assert.equal(updated.page.source.kind, 'legacy')
  assert.equal(await readFile(legacy, 'utf8'), '---\nstatus: draft\n---\n# 资料核对\n先找合同')
})

test('archives knowledge, preserves Agent evidence, and restores only previously active pages', async t => {
  const { project, other, store, save } = await fixture(t)
  const source = { kind: 'agent', name: 'Agent 主动沉淀', sessionId: 'session-1',
    messageId: 'message-1', quote: '回访前先确认服务地址。', turn: 1 }
  assert.match((await store().request(save({ projectId: other.id, source }))).error, /会话所属/)
  const active = (await store().request(save({ source }))).page
  const input = { op: 'status', projectId: project.id, path: active.path, revision: active.revision,
    status: 'archived', operationId: randomUUID() }
  const archived = (await store().request(input)).page
  assert.deepEqual(archived.source, source)
  assert.equal(archived.status, 'archived')
  assert.equal((await store().request(input)).page.revision, archived.revision)
  const restore = { ...input, status: 'active', revision: archived.revision, operationId: randomUUID() }
  const restored = (await store().request(restore)).page
  assert.equal(restored.status, 'active')
  assert.equal((await store().request(restore)).page.revision, restored.revision)
})
