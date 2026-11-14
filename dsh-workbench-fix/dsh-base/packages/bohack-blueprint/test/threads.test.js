import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
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
