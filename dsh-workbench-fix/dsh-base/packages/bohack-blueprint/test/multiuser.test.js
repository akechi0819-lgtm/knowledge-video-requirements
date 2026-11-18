import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createMultiuserHandler } from '../lib/multiuser.js'

test('匿名会话隔离项目和临时 Key，快照往返并限制来源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-multi-'))
  const shared = path.join(root, 'shared')
  await mkdir(path.join(shared, '.agents'), { recursive: true })
  await mkdir(path.join(shared, 'rules'), { recursive: true })
  const origin = 'https://workbench.example'
  const server = http.createServer(createMultiuserHandler({}, { workspace: shared, temporaryRoot: path.join(root, 'temp'), origin, ttlMs: 60000 }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  async function page() { const r = await fetch(base + '/bohack/'); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0] }
  async function request(cookie, url, { method = 'GET', data, source = origin } = {}) {
    return fetch(base + '/bohack/api/' + url, { method, headers: { cookie, origin: source, 'x-bohack-client': '1', 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
  }
  try {
    const a = await page(), b = await page()
    assert.notEqual(a, b)
    assert.equal((await request(a, 'threads', { source: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(base + '/bohack/api/threads')).status, 401)
    assert.equal((await request(a, 'asset-open', { method: 'POST', data: {} })).status, 403)
    const created = await (await request(a, 'threads', { method: 'POST', data: { title: '项目甲' } })).json()
    const id = created.thread.id
    assert.equal((await (await request(a, 'threads')).json()).threads.length, 1)
    assert.equal((await (await request(b, 'threads')).json()).threads.length, 0)
    assert.equal((await request(b, 'thread?threadId=' + id)).status, 400)
    await request(a, 'settings?threadId=' + id, { method: 'POST', data: { model: { baseUrl: 'https://example.test', model: 'm', apiKey: 'secret-a' } } })
    assert.equal((await (await request(a, 'settings?threadId=' + id)).json()).model.hasApiKey, true)
    assert.equal((await (await request(b, 'settings')).json()).model.hasApiKey, false)
    const aSession = a.split('=')[1]
    assert.doesNotMatch(await readFile(path.join(root, 'temp/sessions', aSession, 'settings.json'), 'utf8'), /secret-a/)
    const exported = await (await request(a, 'projects/export?threadId=' + id, { method: 'POST' })).json()
    assert.equal(exported.snapshot.version, 1)
    assert.ok(!JSON.stringify(exported.snapshot).includes('secret-a'))
    assert.equal((await request(b, 'projects/export?threadId=' + id, { method: 'POST' })).status, 400)
    const restored = await (await request(b, 'projects/import', { method: 'POST', data: exported.snapshot })).json()
    assert.notEqual(restored.thread.id, id)
    assert.equal(restored.thread.title, '项目甲')
    assert.equal((await (await request(b, 'thread?threadId=' + restored.thread.id)).json()).thread.id, restored.thread.id)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})

test('多人模式要求精确来源及独立临时目录', () => {
  assert.throws(() => createMultiuserHandler({}, { workspace: '/tmp/work', temporaryRoot: '/tmp/work/temp', origin: 'https://example.test', ttlMs: 1 }))
  assert.throws(() => createMultiuserHandler({}, { workspace: '/tmp/work', temporaryRoot: '/tmp/temp', origin: 'https://example.test/path', ttlMs: 1 }))
})
