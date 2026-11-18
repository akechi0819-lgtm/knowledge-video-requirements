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
    let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }); req.on('error', reject)
})
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { await request('/'); return } catch { await new Promise(r => setTimeout(r, 30)) }
  }
  throw new Error('Gateway did not listen')
}
function stop(process) { return new Promise(resolve => { process.once('exit', resolve); process.kill() }) }

test('isolates and restores browser workers, configures Docker, and times out', async () => {
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
if (args[0] === 'create') { const name = args[args.indexOf('--name')+1]; fs.writeFileSync(path.join(dir, name), 'false'); console.log(name); }
else if (args[0] === 'inspect') { const f = path.join(dir, args.at(-1)); if (!fs.existsSync(f)) process.exit(1); console.log(fs.readFileSync(f, 'utf8')); }
else if (args[0] === 'start') { fs.writeFileSync(path.join(dir, args[1]), 'true'); console.log(args[1]); }
else if (args[0] === 'port') console.log('127.0.0.1:' + process.env.MOCK_PORT);
else if (args[0] === 'rm') { fs.rmSync(path.join(dir, args.at(-1)), {force:true}); }
`, { mode: 0o755 })
  let child
  const start = async (port = worker.address().port, timeout = '2000') => {
    child = spawn(process.execPath, [gateway], { env: { ...process.env, GATEWAY_STATE_DIR: path.join(dir, 'state'), GATEWAY_DOCKER: mock, GATEWAY_STARTUP_TIMEOUT_MS: timeout, MOCK_DIR: dir, MOCK_PORT: String(port) }, stdio: 'ignore' })
    await ready()
  }
  try {
    await start()
    assert.equal((await request('/')).headers.location, '/bohack/')
    assert.equal((await request('/other')).status, 404)
    const first = await request('/bohack/?x=1')
    assert.equal(first.status, 202)
    const cookie = first.headers['set-cookie'][0].split(';')[0]
    assert.match(first.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/)
    await new Promise(resolve=>setTimeout(resolve,200))
    assert.equal((await request('/bohack/',cookie)).status,202)
    accepting = true
    let loaded
    for (let attempt = 0; attempt < 100; attempt++) {
      loaded = await request('/bohack/?x=1', cookie)
      if (loaded.status === 200) break
      await new Promise(resolve=>setTimeout(resolve,30))
    }
    assert.deepEqual(JSON.parse(loaded.body), { url: '/bohack/?x=1', host: 'jiangjie.gingers.cloud' })
    const second = await request('/bohack/')
    assert.notEqual(second.headers['set-cookie'][0].split(';')[0], cookie)
    const secondCookie = second.headers['set-cookie'][0].split(';')[0]
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await request('/bohack/',secondCookie)).status === 200) break
      await new Promise(resolve=>setTimeout(resolve,30))
    }
    let calls = (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(args => args[0] === 'create').length, 2)
    const args = calls.find(args => args[0] === 'create')
    for (const flag of ['--cpus', '--memory', '--pids-limit', '--user', '--cap-drop', '--security-opt', '--read-only', '--mount', '-p']) assert.ok(args.includes(flag), flag)
    assert.ok(args.includes('127.0.0.1::3000'))
    assert.ok(args.includes('ORIGIN=https://jiangjie.gingers.cloud'))
    assert.ok(args.includes('scripts/cloud-worker.mjs'))
    await stop(child); child = null
    await start()
    assert.equal((await request('/bohack/', cookie)).status, 200)
    calls = (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(args => args[0] === 'create').length, 2)
    await stop(child); child = null
    await start(1, '300')
    assert.equal((await request('/bohack/', cookie)).status, 503)
    assert.equal((await readdir(path.join(dir, 'state'))).length, 2)
  } finally {
    if (child) await stop(child)
    await new Promise(resolve => worker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
