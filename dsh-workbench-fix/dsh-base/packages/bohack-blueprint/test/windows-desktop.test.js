
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMembership } from '../lib/membership.js'
import { testDesktopModel } from '../lib/models.js'
import { createSettings } from '../lib/settings.js'

const helper = process.env.JIANGJIE_TEST_DPAPI_HELPER

test('BYOK connectivity exercises the configured inference protocol before saving', async () => {
  const candidate = { baseUrl: 'https://example.test/v1/chat/completions', model: 'demo', apiKey: 'connectivity-test-key' }
  const request = async (url, options) => {
    assert.equal(url, candidate.baseUrl)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer ' + candidate.apiKey)
    assert.equal(JSON.parse(options.body).model, 'demo')
    return Response.json({ choices: [{ message: { content: 'OK' } }] })
  }
  assert.deepEqual(await testDesktopModel(candidate, request), { ok: true })
  await assert.rejects(testDesktopModel({ ...candidate, apiKey: '' }, request), { code: 'MISSING_CREDENTIAL' })
  await assert.rejects(testDesktopModel({ ...candidate, baseUrl: 'https://example.test/v1?secret=private' }, request), /不能包含/)
  await assert.rejects(testDesktopModel(candidate, async () => new Response('credential should never echo', { status: 401 })), { message: /HTTP 401/ })
  await assert.rejects(testDesktopModel(candidate, async () => Response.json({ data: [] })), /协议不匹配/)
})

test('Windows DPAPI persists new settings and membership tokens and migrates old plaintext atomically', {
  skip: process.platform !== 'win32' || !helper,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "Windows 凭据 ' "))
  const previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(root, 'Local')
  t.after(async () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    await rm(root, { recursive: true, force: true })
  })

  const workspace = path.join(root, 'workspace')
  const settingsFile = path.join(workspace, 'settings.json')
  const accountFile = path.join(root, 'membership', 'account.json')
  const fixtureModel = { baseUrl: 'https://example.test/v1', model: 'demo' }
  const oldKey = 'former-key-测试-"', newKey = 'new-provider-key-测试'
  const oldToken = 'previous-session-token', newToken = 'updated-session-token'
  const origin = 'https://membership.example.test'
  await Promise.all([mkdir(workspace), mkdir(path.dirname(accountFile))])
  await writeFile(settingsFile, JSON.stringify({ model: { ...fixtureModel, apiKey: oldKey } }))
  await writeFile(accountFile, JSON.stringify({ mode: 'member', origin, email: 'me@example.test', userId: 'member-1', token: oldToken }))

  const settings = () => createSettings(workspace, { credentialHelper: helper })
  assert.equal((await settings().load()).model.apiKey, oldKey)
  assert.ok(!JSON.parse(await readFile(settingsFile, 'utf8')).model.apiKey)
  const newSettings = await settings().update({ model: { apiKey: newKey } })
  assert.equal(newSettings.model.hasApiKey, true)
  assert.equal(newSettings.model.apiKey, undefined)
  assert.equal((await settings().load()).model.apiKey, newKey)
  assert.ok(!JSON.parse(await readFile(settingsFile, 'utf8')).model.apiKey)
  assert.match(JSON.parse(await readFile(settingsFile, 'utf8')).keychainCredentials, /^[a-f0-9-]{36}$/)

  let lastHeader
  const membership = () => createMembership({}, workspace, {
    url: origin, credentialHelper: helper,
    request: async (url, options) => {
      if (url.endsWith('/api/auth/sign-in/email')) return Response.json({ user: { id: 'member-1', email: 'me@example.test' } }, { headers: { 'set-auth-token': newToken } })
      if (url.endsWith('/api/member')) {
        lastHeader = new Headers(options.headers).get('authorization')
        return Response.json({ giftRemaining: 2 })
      }
      throw Error('Unexpected request ' + url)
    },
  })
  assert.equal((await membership().view()).account.gifts, 2)
  assert.equal(lastHeader, 'Bearer ' + oldToken)
  assert.ok(!JSON.parse(await readFile(accountFile, 'utf8')).token)
  await membership().update({ action: 'login', email: 'me@example.test', password: 'test-password' })
  assert.equal((await membership().view()).account.email, 'me@example.test')
  assert.equal(lastHeader, 'Bearer ' + newToken)
  assert.ok(!JSON.parse(await readFile(accountFile, 'utf8')).token)
  const protectedDir = path.join(process.env.LOCALAPPDATA, 'Jiangjie', 'credentials')
  const encrypted = await readdir(protectedDir)
  assert.equal(encrypted.length, 2)
  for (const item of encrypted) {
    assert.match(item, /^[a-f0-9]{64}\.dpapi$/)
    const bytes = await readFile(path.join(protectedDir, item))
    for (const secret of [oldToken, newToken, oldKey, newKey]) assert.ok(!bytes.includes(Buffer.from(secret)))
  }
  await membership().update({ action: 'mode', mode: 'byok' })
  await settings().update({ model: { clearApiKey: true } })
  await assert.rejects(membership().project(workspace).route(settings().load), { code: 'MISSING_CREDENTIAL' })
  await assert.rejects(settings().forCall(null), { code: 'MISSING_CREDENTIAL' })
});
