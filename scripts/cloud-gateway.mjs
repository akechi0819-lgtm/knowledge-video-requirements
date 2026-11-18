import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execute = promisify(execFile)
const stateDir = process.env.GATEWAY_STATE_DIR || path.join(os.homedir(), '.jiangjie-cloud-gateway')
const docker = process.env.GATEWAY_DOCKER || 'docker'
const workerPort = 3000
const origin = 'https://jiangjie.gingers.cloud'
const lifetime = 24 * 60 * 60 * 1000
const startupTimeout = Number(process.env.GATEWAY_STARTUP_TIMEOUT_MS || 30000)
const cookieName = '__Host-jiangjie-session'
const pending = new Map()

await mkdir(stateDir, { recursive: true, mode: 0o700 })

async function dockerCmd(...args) {
  const { stdout } = await execute(docker, args, { timeout: startupTimeout, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
const keyFor = token => createHash('sha256').update(token).digest('hex')
const fileFor = key => path.join(stateDir, `${key}.json`)
async function save(key, data) {
  const temp = `${fileFor(key)}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
  await rename(temp, fileFor(key))
}
async function load(key) {
  try { return JSON.parse(await readFile(fileFor(key), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function remove(key, data) {
  await dockerCmd('rm', '-f', data.container)
  await dockerCmd('volume', 'rm', data.volume)
  await unlink(fileFor(key))
}
async function portFor(container) {
  const raw = await dockerCmd('port', container, `${workerPort}/tcp`)
  const match = /^127\.0\.0\.1:(\d+)$/.exec(raw)
  if (!match) throw new Error('Worker has no loopback port')
  return Number(match[1])
}
function probe(port) {
  return new Promise(resolve => {
    const request = http.get({ port, host: '127.0.0.1', path: '/bohack/api/health' }, response => {
      response.resume()
      resolve(response.statusCode === 200 || response.statusCode === 401)
    })
    request.setTimeout(500, () => request.destroy())
    request.once('error', () => resolve(false))
  })
}
async function waitReady(port, deadline) {
  do {
    if (await probe(port)) return
    await new Promise(resolve => setTimeout(resolve, 150))
  } while (Date.now() < deadline)
  throw new Error('Worker startup timed out')
}
async function worker(key) {
  let data = await load(key)
  if (data && data.expires <= Date.now()) { await remove(key, data); data = null }
  if (!data) {
    const workers = (await readdir(stateDir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
    if (workers.length >= 4) throw new Error('预览实例已满')
    const suffix = randomBytes(16).toString('hex')
    data = { container: `jiangjie-worker-${suffix}`, volume: `jiangjie-tmp-${suffix}`, expires: Date.now() + lifetime }
    // Persist ownership before creating resources, so a gateway restart can find them.
    await save(key, data)
    try {
      await dockerCmd('create', '--name', data.container, '--cpus', '1', '--memory', '1g', '--pids-limit', '256',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
        '--mount', `type=volume,source=${data.volume},target=/tmp`, '-p', `127.0.0.1::${workerPort}`,
        '-e', `PORT=${workerPort}`, '-e', 'HOST=0.0.0.0', '-e', `ORIGIN=${origin}`,
        ...['BOHACK_CLOUD_MODEL', 'BOHACK_CLOUD_BASE_URL', 'BOHACK_CLOUD_API', 'BOHACK_CLOUD_REASONING'].flatMap(name => process.env[name] ? ['-e', `${name}=${process.env[name]}`] : []),
        'jiangjie-preview-worker:local', 'node', 'scripts/cloud-worker.mjs')
    } catch (error) {
      // A failed create may still have created the volume.
      try { await dockerCmd('volume', 'rm', data.volume) } catch {}
      await unlink(fileFor(key))
      throw error
    }
  }
  const deadline = Date.now() + startupTimeout
  const running = await dockerCmd('inspect', '-f', '{{.State.Running}}', data.container)
  if (running !== 'true') await dockerCmd('start', data.container)
  const port = await portFor(data.container)
  await waitReady(port, deadline)
  return port
}
function getWorker(key) {
  if (!pending.has(key)) {
    const task = worker(key).finally(() => pending.delete(key))
    pending.set(key, task)
  }
  return pending.get(key)
}
function tokenFrom(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)__Host-jiangjie-session=([a-f0-9]{64})(?:;|$)/)
  return match?.[1]
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, origin).pathname
  if (pathname === '/') { res.writeHead(302, { location: '/bohack/' }); res.end(); return }
  if (pathname !== '/bohack' && !pathname.startsWith('/bohack/')) { res.writeHead(404); res.end(); return }
  let token = tokenFrom(req)
  try {
    const existing = token && await load(keyFor(token))
    if ((!existing && !pending.has(token && keyFor(token))) || existing?.expires <= Date.now()) {
      if (req.method !== 'GET' || !['/bohack','/bohack/','/bohack/index.html'].includes(pathname)) {
        res.writeHead(401, {'content-type':'application/json'})
        res.end(JSON.stringify({ok:false,error:'请先打开工作台'}))
        return
      }
      token = randomBytes(32).toString('hex')
      res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`)
    }
    const key = keyFor(token)
    if ((!existing || pending.has(key)) && req.method === 'GET' && ['/bohack','/bohack/','/bohack/index.html'].includes(pathname)) {
      getWorker(key).catch(() => console.error('Worker startup failed'))
      res.writeHead(202, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
      res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>讲界视频工坊</title><body><p>正在准备工作台，请稍候…</p></body></html>')
      return
    }
    const port = await getWorker(keyFor(token))
    const headers = { ...req.headers, host: 'jiangjie.gingers.cloud', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jiangjie.gingers.cloud' }
    // The routing secret belongs only to the gateway.
    if (headers.cookie) {
      headers.cookie = headers.cookie.split(';').filter(part => !part.trim().startsWith(`${cookieName}=`)).join(';').trim()
      if (!headers.cookie) delete headers.cookie
    }
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, response => {
      const cookies = (response.headers['set-cookie'] || []).filter(value => !value.startsWith(`${cookieName}=`))
      const sessionCookie = res.getHeader('set-cookie')
      if (sessionCookie) cookies.push(sessionCookie)
      if (cookies.length) response.headers['set-cookie'] = cookies
      else delete response.headers['set-cookie']
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  } catch {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Worker unavailable')
  }
})

async function expireWorkers() {
  for (const file of await readdir(stateDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const key = file.slice(0, -5)
    if (pending.has(key)) continue
    const data = await load(key)
    if (data && data.expires <= Date.now()) {
      try { await remove(key, data) } catch { console.error('Could not remove expired worker') }
    }
  }
}
setInterval(() => { expireWorkers().catch(() => console.error('Worker cleanup failed')) }, 60_000).unref()
await expireWorkers()
server.listen(3110, '127.0.0.1')
