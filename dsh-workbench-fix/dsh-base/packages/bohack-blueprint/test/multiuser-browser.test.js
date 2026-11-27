import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createMultiuserHandler } from '../lib/multiuser.js'
import style from '../../../../../video-kit/WORK/modules/video/style.mjs'

// Run with: node --test test/multiuser-browser.test.js
// Override these paths when Chrome or the existing playwright-core is elsewhere.
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || style.paths.playwright)
const chrome = process.env.CHROME_PATH || style.paths.edge
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

test('Chrome 多用户隔离、并发密钥、本机快照与重开持久化', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bohack-browser-'))
  const shared = path.join(root, 'shared')
  await Promise.all(['.agents', 'rules'].map(dir => mkdir(path.join(shared, dir), { recursive: true })))
  let handler
  const server = http.createServer((req, res) => handler(req, res))
  const seen = []
  let waiting
  const mock = http.createServer((req, res) => {
    seen.push(req.headers.authorization)
    // Hold both responses until both users have reached the mock server.
    if (!waiting) { waiting = res; return }
    for (const response of [waiting, res]) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    }
    waiting = null
  })
  await listen(server); await listen(mock)
  const origin = `http://127.0.0.1:${server.address().port}`
  const modelUrl = `http://127.0.0.1:${mock.address().port}/v1`
  handler = createMultiuserHandler({}, { workspace: shared, temporaryRoot: path.join(root, 'temp'), origin, ttlMs: 3600000 })
  const contexts = new Set()
  t.after(async () => {
    for (const context of contexts) await context.close()
    if (waiting) waiting.destroy()
    await close(server); await close(mock)
    await rm(root, { recursive: true, force: true })
  })
  async function launch(name) {
    const context = await chromium.launchPersistentContext(path.join(root, name), { executablePath: chrome, headless: true, reducedMotion: 'reduce' })
    contexts.add(context)
    return context
  }
  async function api(page, route, data) {
    return page.evaluate(async ({ route, data }) => {
      const response = await fetch('/bohack/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-bohack-client': '1', 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
      return { status: response.status, body: await response.json() }
    }, { route, data })
  }
  const [a, b] = await Promise.all([launch('profile-a'), launch('profile-b')])
  let [pa, pb] = await Promise.all([a.newPage(), b.newPage()])
  await Promise.all([pa.goto(origin + '/bohack/'), pb.goto(origin + '/bohack/')])
  const cookie = async context => (await context.cookies(origin + '/bohack/')).find(c => c.name === 'bohack_session')
  const [ca, cb] = await Promise.all([cookie(a), cookie(b)])
  assert.ok(ca?.httpOnly && ca.expires > Date.now() / 1000)
  assert.notEqual(ca.value, cb.value)

  async function saveKey(page, key) {
    await page.locator('#settingsBtn').click()
    await page.locator('.ws-dialog details summary').first().click()
    await page.locator('.ws-dialog input[name="baseUrl"]').fill(modelUrl)
    await page.locator('.ws-dialog input[name="model"]').fill('mock-model')
    await page.locator('.ws-dialog input[name="apiKey"]').fill(key)
    await page.locator('.ws-save').click()
    await page.locator('.ws-status').getByText('设置已保存。').waitFor()
    await page.locator('.ws-key-state').getByText('已保存密钥。').waitFor()
  }
  await Promise.all([saveKey(pa, 'mock-key-a'), saveKey(pb, 'mock-key-b')])
  await Promise.all([pa, pb].map(page => page.getByRole('button', { name: '获取通用模型' }).click()))
  await Promise.all([pa, pb].map(page => page.getByText('已获取 1 个模型').waitFor()))
  assert.deepEqual(new Set(seen), new Set(['Bearer mock-key-a', 'Bearer mock-key-b']))
  for (const c of [ca, cb]) {
    const settings = await readFile(path.join(root, 'temp', 'sessions', c.value, 'settings.json'), 'utf8')
    assert.doesNotMatch(settings, /mock-key-[ab]/)
  }
  await Promise.all([pa, pb].map(page => page.locator('.ws-close').click()))

  // Import a small fixture through the public endpoint to avoid starting an AI job.
  const fixture = { version: 1, files: [
    { path: 'thread.json', data: Buffer.from(JSON.stringify({ title: '浏览器项目甲' })).toString('base64') },
    { path: 'inbox/参考.txt', data: Buffer.from('真实浏览器快照内容').toString('base64') },
  ] }
  const imported = await api(pa, 'projects/import', fixture)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const id = imported.body.thread.id
  assert.deepEqual((await api(pb, 'threads')).body.threads, [])
  assert.equal((await api(pb, 'thread?threadId=' + id)).status, 400)
  await pa.goto(origin + '/bohack/?thread=' + id)
  await pa.getByText('项目存档', { exact: true }).click()
  await pa.getByRole('button', { name: '保存到本机' }).click()
  await pa.locator('output').getByText('已保存到本机').waitFor()
  assert.equal(await pb.getByLabel('本机项目').locator('option').count(), 1)

  // Close both browser profiles, then reopen the same profiles (not storageState copies).
  await Promise.all([a.close(), b.close()]); contexts.delete(a); contexts.delete(b)
  const projectDir = path.join(root, 'temp', 'projects', id)
  assert.ok((await stat(projectDir)).isDirectory())
  await writeFile(path.join(projectDir, 'expiry.json'), JSON.stringify({ expiresAt: Date.now() - 1 }))
  // No pages remain open to touch the project. Wait for the real cleanup window.
  await new Promise(resolve => setTimeout(resolve, 61000))
  const [a2, b2] = await Promise.all([launch('profile-a'), launch('profile-b')])
  ;[pa, pb] = await Promise.all([a2.newPage(), b2.newPage()])
  await Promise.all([pa.goto(origin + '/bohack/'), pb.goto(origin + '/bohack/')])
  assert.equal((await cookie(a2)).value, ca.value)
  assert.equal((await cookie(b2)).value, cb.value)
  assert.deepEqual((await api(pa, 'threads')).body.threads, [])
  assert.deepEqual((await api(pb, 'threads')).body.threads, [])
  await assert.rejects(stat(projectDir), { code: 'ENOENT' })
  assert.equal((await api(pa, 'thread?threadId=' + id)).status, 400)
  await pa.getByText('项目存档', { exact: true }).click()
  await pa.getByLabel('本机项目').selectOption(id)
  await pa.getByRole('button', { name: '恢复', exact: true }).click()
  await pa.locator('output').getByText('已恢复').waitFor()
  const restoredId = new URL(pa.url()).searchParams.get('thread')
  assert.ok(restoredId && restoredId !== id)
  const exported = await api(pa, 'projects/export?threadId=' + restoredId, {})
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  assert.equal(Buffer.from(exported.body.snapshot.files.find(f => f.path === 'inbox/参考.txt').data, 'base64').toString(), '真实浏览器快照内容')
  assert.doesNotMatch(JSON.stringify(exported.body.snapshot), /mock-key-[ab]/)
  assert.equal((await api(pb, 'thread?threadId=' + restoredId)).status, 400)
})
