import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createThreads } from '../lib/threads.js'

test('threads keep project data separate and reopen from disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-threads-'))
  try {
    await mkdir(path.join(root, '.agents', 'skills'), { recursive: true })
    await mkdir(path.join(root, 'rules'), { recursive: true })
    await writeFile(path.join(root, 'rules', 'blueprint.md'), 'shared rules')
    const store = createThreads({}, { workspace: root }, {}, {})
    const a = await store.create({ title: '甲' })
    const b = await store.create({ title: '乙' })
    const first = await store.get(a.id)
    const second = await store.get(b.id)
    await first.service.ingest({ kind: 'paste', text: '# 甲的需求' })
    assert.equal((await first.service.status()).hasRequirement, true)
    assert.equal((await second.service.status()).hasRequirement, false)
    assert.equal(await readFile(path.join(root, 'threads', a.id, 'rules', 'blueprint.md'), 'utf8'), 'shared rules')
    assert.deepEqual(new Set((await store.list()).map(x => x.id)), new Set([a.id, b.id]))
    await writeFile(path.join(root, 'rules', 'blueprint.md'), 'updated instructions')
    const reopened = createThreads({}, { workspace: root }, {}, {})
    assert.equal((await (await reopened.get(a.id)).service.status()).hasRequirement, true)
    assert.equal(await readFile(path.join(root, 'threads', a.id, 'rules', 'blueprint.md'), 'utf8'), 'updated instructions')
    await assert.rejects(reopened.get('../other'))
    await assert.rejects(reopened.get('00000000-0000-0000-0000-000000000000'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy project is listed only when it has data and stays separate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-legacy-'))
  try {
    await mkdir(path.join(root, '.agents'), { recursive: true })
    await mkdir(path.join(root, 'rules'), { recursive: true })
    const legacyService = {}, legacyEngine = {}
    const store = createThreads({}, { workspace: root }, legacyService, legacyEngine)
    assert.deepEqual(await store.list(), [])
    await assert.rejects(store.get('legacy'))
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    await writeFile(path.join(root, 'inbox', '需求.md'), '# 视频需求\n\n## 主题\n\n丝绸之路\n')
    const legacy = (await store.list())[0]
    assert.equal(legacy.id, 'legacy')
    assert.equal(legacy.title, '历史项目 · 丝绸之路')
    assert.equal((await store.get('legacy')).service, legacyService)
    await store.touch('legacy', '新标题')
    assert.deepEqual(await store.metadata('legacy'), legacy)
    const fresh = await store.create()
    assert.equal((await (await store.get(fresh.id)).service.status()).hasRequirement, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one corrupt thread.json is skipped and warned about instead of failing the list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-corrupt-'))
  try {
    await mkdir(path.join(root, '.agents'), { recursive: true })
    await mkdir(path.join(root, 'rules'), { recursive: true })
    const warnings = []
    const ctx = { logger: { warn: (...args) => warnings.push(args.join(' ')) } }
    const store = createThreads(ctx, { workspace: root }, {}, {})
    const good = await store.create({ title: '可读会话' })
    const bad = await store.create({ title: '损坏会话' })
    await writeFile(path.join(root, 'threads', bad.id, 'thread.json'), '{ 这不是合法 JSON')
    const listed = await store.list()
    assert.deepEqual(listed.map(t => t.id), [good.id])
    assert.equal(listed[0].title, '可读会话')
    assert.ok(warnings.some(w => w.includes(bad.id)), '损坏会话应被记录')
    await assert.rejects(store.get(bad.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed create removes its .creating directory instead of leaking it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-leak-'))
  try {
    // Neither .agents nor rules exists, so syncInstructions fails after the staging dir was made.
    const store = createThreads({}, { workspace: root }, {}, {})
    await assert.rejects(store.create({ title: '注定失败' }))
    assert.deepEqual(await readdir(path.join(root, 'threads')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cached instances are capped at 32 and the evicted engine is reset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-lru-'))
  try {
    await mkdir(path.join(root, '.agents'), { recursive: true })
    await mkdir(path.join(root, 'rules'), { recursive: true })
    const store = createThreads({}, { workspace: root }, {}, {})
    const ids = []
    for (let i = 0; i < 33; i++) {
      const id = randomUUID()
      ids.push(id)
      const dir = path.join(root, 'threads', id)
      await mkdir(dir, { recursive: true })
      const at = new Date().toISOString()
      await writeFile(path.join(dir, 'thread.json'), JSON.stringify({ id, title: `会话${i}`, createdAt: at, updatedAt: at }))
    }
    const first = await store.get(ids[0])
    let resets = 0
    const originalReset = first.engine.reset.bind(first.engine)
    first.engine.reset = () => { resets++; originalReset() }
    for (const id of ids.slice(1)) await store.get(id)
    assert.equal(resets, 1, '最旧实例被驱逐前应 reset 一次')
    const recent = await store.get(ids[32])
    assert.equal(await store.get(ids[32]), recent, '刚用过的实例应仍在缓存中')
    const rebuilt = await store.get(ids[0])
    assert.notEqual(rebuilt, first, '被驱逐的实例应重新构建')
    assert.notEqual(rebuilt.engine, first.engine)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
