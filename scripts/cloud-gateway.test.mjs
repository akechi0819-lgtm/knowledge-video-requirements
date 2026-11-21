import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const gateway = fileURLToPath(new URL('./cloud-gateway.mjs', import.meta.url))
const request = (path, cookie) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: 3110, path, headers: cookie ? { cookie } : {} }, res => {
    let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: statusCodeOf(res), headers: res.headers, body }))
  }); req.on('error', reject)
})
function statusCodeOf(res) { return res.statusCode }
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { await request('/'); return } catch { await new Promise(r => setTimeout(r, 30)) }
  }
  throw new Error('Gateway did not listen')
}
function stop(process) { return new Promise(resolve => { process.once('exit', resolve); process.kill() }) }
async function until(check, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Condition timed out')
}

async function harness(t, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-test-'))
  const mock = path.join(dir, 'docker')
  let accepting = false
  const worker = http.createServer((req, res) => {
    if (!accepting) { res.destroy(); return }
    res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie, host: req.headers.host }))
  })
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve))
  await writeFile(mock, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2), dir = process.env.MOCK_DIR;
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === 'run') { const name = args[args.indexOf('--name')+1]; fs.writeFileSync(path.join(dir, name), 'true'); console.log(name); }
else if (args[0] === 'inspect') { const f = path.join(dir, args.at(-1)); if (!fs.existsSync(f)) process.exit(1); console.log(fs.readFileSync(f, 'utf8')); }
else if (args[0] === 'start') { fs.writeFileSync(path.join(dir, args[1]), 'true'); console.log(args[1]); }
else if (args[0] === 'port') console.log('127.0.0.1:' + process.env.MOCK_PORT);
else if (args[0] === 'rm') { fs.rmSync(path.join(dir, args.at(-1)), {force:true}); }
`, { mode: 0o755 })
  let child
  const start = async (port = worker.address().port, timeout = '2000') => {
    child = spawn(process.execPath, [gateway], { env: { ...process.env, BOHACK_CLOUD_MODEL: 'gpt-6.1-terra', BOHACK_CLOUD_BASE_URL: 'https://models.example/v1', BOHACK_CLOUD_API: 'openai-responses', BOHACK_CLOUD_REASONING: 'low', BOHACK_CLOUD_KEY: 'never-copy-this-key', GATEWAY_STATE_DIR: path.join(dir, 'state'), GATEWAY_DOCKER: mock, GATEWAY_STARTUP_TIMEOUT_MS: timeout, GATEWAY_WARM_SIZE: '0', MOCK_DIR: dir, MOCK_PORT: String(port), ...env }, stdio: 'ignore' })
    await ready()
  }
  const calls = async () => (await readFile(path.join(dir, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  t.after(async () => {
    if (child) await stop(child)
    await new Promise(resolve => worker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  return { start: async (...args) => { if (child) { await stop(child); child = null } await start(...args) }, calls, cookieOf: res => res.headers['set-cookie'][0].split(';')[0], set accepting(value) { accepting = value }, dir }
}

test('isolates browser workers, exposes prepare status, and reports startup failure', async t => {
  const h = await harness(t)
  await h.start()
  assert.equal((await request('/')).headers.location, '/bohack/')
  assert.equal((await request('/other')).status, 404)
  assert.deepEqual(JSON.parse((await request('/bohack/__prepare')).body), { hasCookie: false, stage: 'idle', message: '' })
  const first = await request('/bohack/?x=1')
  assert.equal(first.status, 202)
  assert.match(first.body, /正在准备工作台/)
  assert.match(first.body, /__prepare/)
  const cookie = h.cookieOf(first)
  assert.match(first.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/)
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal((await request('/bohack/',cookie)).status,202)
  h.accepting = true
  const loaded = await until(async () => {
    const res = await request('/bohack/?x=1', cookie)
    return res.status === 200 ? res : undefined
  })
  assert.deepEqual(JSON.parse(loaded.body), { url: '/bohack/?x=1', host: 'jiangjie.gingers.cloud' })
  assert.equal(JSON.parse((await request('/bohack/__prepare', cookie)).body).stage, 'ready')
  const second = await request('/bohack/')
  assert.notEqual(h.cookieOf(second), cookie)
  const secondCookie = h.cookieOf(second)
  await until(async () => (await request('/bohack/',secondCookie)).status === 200)
  const calls = await h.calls()
  assert.equal(calls.filter(args => args[0] === 'run').length, 2)
  const args = calls.find(args => args[0] === 'run')
  for (const flag of ['--cpus', '--memory', '--pids-limit', '--user', '--cap-drop', '--security-opt', '--read-only', '--mount', '-p']) assert.ok(args.includes(flag), flag)
  assert.ok(args.includes('127.0.0.1::3000'))
  assert.ok(args.includes('ORIGIN=https://jiangjie.gingers.cloud'))
  for (const value of ['BOHACK_CLOUD_MODEL=gpt-6.1-terra', 'BOHACK_CLOUD_BASE_URL=https://models.example/v1', 'BOHACK_CLOUD_API=openai-responses', 'BOHACK_CLOUD_REASONING=low']) assert.ok(args.includes(value), value)
  assert.ok(!args.some(arg => arg.includes('never-copy-this-key') || arg.startsWith('BOHACK_CLOUD_KEY=')))
  assert.ok(args.includes('scripts/cloud-worker.mjs'))
  await h.start()
  await until(async () => (await request('/bohack/', cookie)).status === 200)
  assert.equal((await h.calls()).filter(args => args[0] === 'run').length, 2)
  await h.start(1, '300')
  assert.equal((await request('/bohack/', cookie)).status, 202)
  const failed = await until(async () => {
    const info = JSON.parse((await request('/bohack/__prepare', cookie)).body)
    return info.stage === 'failed' ? info : undefined
  })
  assert.match(failed.message, /启动超时/)
  assert.equal((await readdir(path.join(h.dir, 'state'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).length, 2)
})

test('claims prewarmed containers and refills the pool', async t => {
  const h = await harness(t, { GATEWAY_WARM_SIZE: '1' })
  await h.start()
  h.accepting = true
  assert.equal((await h.calls()).filter(args => args[0] === 'run').length, 1)
  const first = await request('/bohack/')
  assert.equal(first.status, 202)
  const cookie = h.cookieOf(first)
  await until(async () => (await request('/bohack/', cookie)).status === 200)
  const [session] = (await readdir(path.join(h.dir, 'state'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
  const data = JSON.parse(await readFile(path.join(h.dir, 'state', session), 'utf8'))
  const runs = (await h.calls()).filter(args => args[0] === 'run')
  assert.equal(runs.length, 2)
  assert.equal(data.container, runs[0][runs[0].indexOf('--name') + 1])
})

test('evicts the least recently used idle worker when full', async t => {
  const h = await harness(t, { GATEWAY_MAX_WORKERS: '1', GATEWAY_IDLE_EVICT_MS: '0' })
  await h.start()
  h.accepting = true
  const first = await request('/bohack/')
  const cookieA = h.cookieOf(first)
  await until(async () => (await request('/bohack/', cookieA)).status === 200)
  const runsA = (await h.calls()).filter(args => args[0] === 'run')
  const containerA = runsA[0][runsA[0].indexOf('--name') + 1]
  const second = await request('/bohack/')
  const cookieB = h.cookieOf(second)
  await until(async () => (await request('/bohack/', cookieB)).status === 200)
  const calls = await h.calls()
  assert.equal(calls.filter(args => args[0] === 'run').length, 2)
  assert.ok(calls.some(args => args[0] === 'rm' && args.includes(containerA)))
  assert.equal((await readdir(path.join(h.dir, 'state'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).length, 1)
})

test('reports a full pool instead of silently looping', async t => {
  const h = await harness(t, { GATEWAY_MAX_WORKERS: '1' })
  await h.start()
  h.accepting = true
  const first = await request('/bohack/')
  await until(async () => (await request('/bohack/', h.cookieOf(first))).status === 200)
  const second = await request('/bohack/')
  assert.equal(second.status, 202)
  const cookieB = h.cookieOf(second)
  const full = await until(async () => {
    const info = JSON.parse((await request('/bohack/__prepare', cookieB)).body)
    return info.stage === 'full' ? info : undefined
  })
  assert.match(full.message, /已满/)
  assert.equal((await h.calls()).filter(args => args[0] === 'run').length, 1)
})
