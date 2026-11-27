import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { checkRuntimePath } from '../lib/skill-runtime.js'
import { runVideoAgent } from '../lib/video-agent.js'

test('task path checks allow upstream reads and reject writes through outside symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-boundary-'))
  try {
    const dir = path.join(root, 'job'), skill = path.join(root, 'skill')
    await Promise.all([mkdir(dir), mkdir(skill)])
    await symlink(path.join(root, 'new-outside.txt'), path.join(dir, 'dangling'))
    const runtime = { dir: await realpath(dir), tmp: await realpath(dir), readRoots: await Promise.all([realpath(dir), realpath(skill)]) }
    assert.throws(() => checkRuntimePath(runtime, dir, './dangling', true), /只能写入/)
    assert.throws(() => checkRuntimePath(runtime, dir, '../outside.txt'), /只能读取/)
    assert.throws(() => checkRuntimePath(runtime, dir, '../skill/SKILL.md', true), /只能写入/)
    assert.equal(checkRuntimePath(runtime, dir, '../skill/SKILL.md'), path.join(await realpath(skill), 'SKILL.md'))
    assert.equal(checkRuntimePath(runtime, dir, 'output.txt', true), path.join(runtime.dir, 'output.txt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an active native job is still allowed to submit after more than ten minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let submit
  const jobs = { list: () => [{ status: 'running' }] }
  const started = Promise.withResolvers()
  const context = { jobs, on() {}, tools: { register(tool) { submit = tool.execute } } }
  const ctx = {
    agentPresets: { mount: async () => {} },
    agents: { async create({ setup }) {
      await setup(context)
      return { agent: { async followup() { started.resolve() } } }
    } },
  }
  const result = runVideoAgent({ ctx, cwd: '/tmp', prompt: 'test', runtime: {}, tools: [
    { name: 'submit', execute: async () => ({ ok: true }) },
  ] })
  await started.promise
  t.mock.timers.tick(13 * 60 * 1000)
  assert.deepEqual(await submit({}), { ok: true })
  assert.deepEqual(await result, { ok: true })
})
