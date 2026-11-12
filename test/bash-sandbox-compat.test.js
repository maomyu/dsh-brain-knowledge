import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SandboxBashExecutor } from '../vendor/dao-runtime/bash-sandbox.js'

function fixture(mode, { enforcement = 'full' } = {}) {
  const spawns = []
  const read = text => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const executor = Object.create(SandboxBashExecutor.prototype)
  const policy = { mode, workspaceRoot: '/fixture', protectedWriteRoots: ['/fixture/brain'] }
  const ctx = {
    sandbox: { requiresFullAccessWrapper: true, async confine(argv) {
      return { argv, enforcement, env: { TEST_PROVIDER: 'yes', TEST_REMOVE: null }, envDenyNames: ['DSH_SECRET_DEMO'], denialSignatures: ['operation not permitted'], runnerFailureRules: [] }
    } },
    subprocess: { spawn(spec) {
      // Use the real Host LocalBashExecutor; the subprocess boundary requires argv.
      const [command, ...args] = spec.argv
      assert.equal(command, 'bash'); assert.deepEqual(args, ['-c', 'echo ok'])
      spawns.push(spec)
      return { collected: { stdout: read('ok\n'), stderr: read('') }, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
    } },
  }
  Object.defineProperties(executor, {
    ctx: { value: ctx }, mode: { value: mode }, processFacts: { value: new Map() },
    config: { value: { maxSpillBytes: { get: () => 4096 }, maxOutputBytes: { get: () => 4096 }, graceMs: { get: () => 10 } } },
  })
  const spec = { command: 'echo ok', workdir: '/fixture', timeoutMs: 1000, onExpiry: 'none', stdoutMaxBytes: 4096,
    sandboxPolicy: policy, env: { TEST_REMOVE: 'remove me', TEST_KEEP: 'kept' }, dshEnv: { DSH_SECRET_DEMO: 'synthetic-only', DSH_SESSION_ID: 'fixture-session' } }
  return { executor, spec, spawns }
}

for (const mode of ['workspace-write', 'danger-full-access']) {
  test(`real Host bash contract executes under ${mode} while retaining protected-write confinement`, async () => {
    const { executor, spec, spawns } = fixture(mode)
    const before = structuredClone(spec)
    const handle = await executor.execute(spec)
    const result = await handle.result()
    assert.equal(result.stdout.text, 'ok\n'); assert.equal(result.exitCode, 0)
    assert.equal(result.sandbox.mode, mode); assert.equal(result.sandbox.enforcement, 'full')
    assert.equal(spawns[0].env.TEST_PROVIDER, 'yes'); assert.equal(spawns[0].env.TEST_KEEP, 'kept')
    assert.equal(spawns[0].env.TEST_REMOVE, undefined); assert.equal(spawns[0].env.DSH_SECRET_DEMO, undefined)
    assert.equal(spawns[0].env.DSH_SESSION_ID, 'fixture-session')
    assert.deepEqual(spec, before)
  })
}

test('full access still refuses incomplete protected-write enforcement before spawning', async () => {
  const { executor, spec, spawns } = fixture('danger-full-access', { enforcement: 'partial' })
  await assert.rejects(() => executor.execute(spec), /partial protected-write enforcement/)
  assert.equal(spawns.length, 0)
})
