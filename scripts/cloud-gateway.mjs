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
const lifetime = Number(process.env.GATEWAY_WORKER_TTL_MS || 24 * 60 * 60 * 1000)
const startupTimeout = Number(process.env.GATEWAY_STARTUP_TIMEOUT_MS || 30000)
const maxWorkers = Number(process.env.GATEWAY_MAX_WORKERS || 4)
const warmSize = Number(process.env.GATEWAY_WARM_SIZE || 1)
const idleEvictMs = Number(process.env.GATEWAY_IDLE_EVICT_MS || 10 * 60 * 1000)
const cookieName = '__Host-jiangjie-session'
const entryPages = ['/bohack', '/bohack/', '/bohack/index.html']
const pending = new Map()
const status = new Map()
const lastSeen = new Map()
const lastSaved = new Map()
let warmTask = Promise.resolve()
let allocateLock = Promise.resolve()

// Container allocation must not interleave: two sessions claiming the same
// warm file or both passing the capacity check would corrupt ownership.
function serialize(task) {
  const run = allocateLock.then(task, task)
  allocateLock = run.then(() => {}, () => {})
  return run
}

await mkdir(stateDir, { recursive: true, mode: 0o700 })

async function dockerCmd(...args) {
  const { stdout } = await execute(docker, args, { timeout: startupTimeout, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
const keyFor = token => createHash('sha256').update(token).digest('hex')
const fileFor = key => path.join(stateDir, `${key}.json`)
const warmFileFor = suffix => path.join(stateDir, `warm-${suffix}.json`)
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
  lastSeen.delete(key)
  lastSaved.delete(key)
  status.delete(key)
}
async function workerFiles() {
  return (await readdir(stateDir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
}
async function warmFiles() {
  return (await readdir(stateDir)).filter(file => /^warm-[a-f0-9]{32}\.json$/.test(file))
}
function setStatus(key, stage, message) {
  status.set(key, { stage, message, at: Date.now() })
}
function forget(key) {
  status.delete(key)
  lastSeen.delete(key)
  lastSaved.delete(key)
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
  throw new Error('工作台引擎启动超时，正在自动重试。')
}
function sessionArgs(data) {
  return ['run', '-d', '--name', data.container, '--cpus', '1', '--memory', '1g', '--pids-limit', '256',
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--mount', `type=volume,source=${data.volume},target=/tmp`, '-p', `127.0.0.1::${workerPort}`,
    '-e', `PORT=${workerPort}`, '-e', 'HOST=0.0.0.0', '-e', `ORIGIN=${origin}`,
    ...['BOHACK_CLOUD_MODEL', 'BOHACK_CLOUD_BASE_URL', 'BOHACK_CLOUD_API', 'BOHACK_CLOUD_REASONING'].flatMap(name => process.env[name] ? ['-e', `${name}=${process.env[name]}`] : []),
    'jiangjie-preview-worker:local', 'node', 'scripts/cloud-worker.mjs']
}
async function createContainer(data) {
  try { await dockerCmd(...sessionArgs(data)) }
  catch (error) {
    // A failed run may still have created the volume.
    try { await dockerCmd('volume', 'rm', data.volume) } catch {}
    throw error
  }
}
async function destroyWarm(data) {
  try { await dockerCmd('rm', '-f', data.container) } catch {}
  try { await dockerCmd('volume', 'rm', data.volume) } catch {}
}
async function ensureWarm() {
  if (warmSize <= 0) return
  await serialize(async () => {
    const files = await warmFiles()
    for (let i = files.length; i < warmSize; i++) {
      const suffix = randomBytes(16).toString('hex')
      const data = { container: `jiangjie-worker-${suffix}`, volume: `jiangjie-tmp-${suffix}`, createdAt: Date.now() }
      await writeFile(warmFileFor(suffix), JSON.stringify(data), { mode: 0o600 })
      try { await createContainer(data) }
      catch (error) {
        await unlink(warmFileFor(suffix)).catch(() => {})
        await destroyWarm(data)
        throw error
      }
    }
  })
}
function refillWarm() {
  warmTask = warmTask.then(ensureWarm, ensureWarm).catch(error => console.error(`Warm pool refill failed: ${error.message}`))
  return warmTask
}
async function claimWarm(key) {
  for (const file of await warmFiles()) {
    let data
    try { data = JSON.parse(await readFile(path.join(stateDir, file), 'utf8')) } catch { continue }
    let usable = false
    try {
      const running = await dockerCmd('inspect', '-f', '{{.State.Running}}', data.container)
      if (running === 'true') {
        const port = await portFor(data.container)
        usable = await probe(port)
      }
    } catch {}
    if (!usable) {
      await destroyWarm(data)
      await unlink(path.join(stateDir, file)).catch(() => {})
      continue
    }
    await unlink(path.join(stateDir, file))
    const session = { container: data.container, volume: data.volume, expires: Date.now() + lifetime, lastSeen: Date.now() }
    await save(key, session)
    lastSeen.set(key, Date.now())
    refillWarm()
    return session
  }
  return null
}
function seenAt(key, data) {
  return lastSeen.get(key) ?? data.lastSeen ?? data.expires - lifetime
}
async function evictIdle() {
  const now = Date.now()
  let best = null
  for (const file of await workerFiles()) {
    const key = file.slice(0, -5)
    if (pending.has(key)) continue
    const data = await load(key)
    if (!data) continue
    const seen = seenAt(key, data)
    if (now - seen < idleEvictMs) continue
    if (!best || seen < best.seen) best = { key, data, seen }
  }
  if (!best) return false
  try { await remove(best.key, best.data) } catch { return false }
  console.log(`Evicted idle worker ${best.key.slice(0, 8)}`)
  return true
}
async function minutesUntilFree() {
  const now = Date.now()
  let soonest = Infinity
  for (const file of await workerFiles()) {
    const key = file.slice(0, -5)
    if (pending.has(key)) continue
    const data = await load(key)
    if (!data) continue
    soonest = Math.min(soonest, seenAt(key, data) + idleEvictMs - now)
  }
  if (!Number.isFinite(soonest)) return 1
  return Math.max(1, Math.ceil(soonest / 60000))
}
async function worker(key) {
  setStatus(key, 'queued')
  let data = await load(key)
  if (data && data.expires <= Date.now()) { await remove(key, data); data = null }
  if (!data) {
    data = await serialize(async () => {
      const held = await load(key)
      if (held) return held
      const warm = await claimWarm(key)
      if (warm) return warm
      const workers = await workerFiles()
      if (workers.length >= maxWorkers) {
        if (!await evictIdle()) {
          const error = new Error('full')
          error.fullWait = await minutesUntilFree()
          throw error
        }
      }
      setStatus(key, 'creating')
      const suffix = randomBytes(16).toString('hex')
      const created = { container: `jiangjie-worker-${suffix}`, volume: `jiangjie-tmp-${suffix}`, expires: Date.now() + lifetime, lastSeen: Date.now() }
      // Persist ownership before creating resources, so a gateway restart can find them.
      await save(key, created)
      lastSeen.set(key, Date.now())
      try { await createContainer(created) }
      catch (error) { await unlink(fileFor(key)).catch(() => {}); forget(key); throw error }
      return created
    })
  }
  setStatus(key, 'starting')
  const running = await dockerCmd('inspect', '-f', '{{.State.Running}}', data.container)
  if (running !== 'true') await dockerCmd('start', data.container)
  setStatus(key, 'booting')
  const deadline = Date.now() + startupTimeout
  const port = await portFor(data.container)
  await waitReady(port, deadline)
  setStatus(key, 'ready')
  return port
}
function getWorker(key) {
  if (!pending.has(key)) {
    const task = worker(key).catch(error => {
      if (error.message === 'full') setStatus(key, 'full', `工作台实例已满，最早约 ${error.fullWait} 分钟后有空位，将自动重试。`)
      else setStatus(key, 'failed', error.message || '工作台启动失败，将自动重试。')
      throw error
    }).finally(() => pending.delete(key))
    pending.set(key, task)
  }
  return pending.get(key)
}
function touch(key) {
  const now = Date.now()
  lastSeen.set(key, now)
  if (now - (lastSaved.get(key) || 0) < 60000 || pending.has(key)) return
  lastSaved.set(key, now)
  load(key).then(data => data && save(key, { ...data, lastSeen: now })).catch(() => {})
}
function tokenFrom(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)__Host-jiangjie-session=([a-f0-9]{64})(?:;|$)/)
  return match?.[1]
}

const waitingPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>讲界视频工坊 · 正在准备工作台</title>
<noscript><meta http-equiv="refresh" content="3"></noscript>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { min-height: 100vh; display: grid; place-items: center; background: #0a0a0c; color: #f2f2f4;
    font: 15px/1.7 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif }
  .card { width: min(420px, calc(100vw - 40px)); padding: 40px 36px; border: 1px solid #26262c;
    border-radius: 14px; background: #131317; box-shadow: 0 18px 50px rgba(0,0,0,.45) }
  .brand { font-size: 13px; letter-spacing: .35em; color: #8a8a92; margin-bottom: 26px }
  .spin { width: 42px; height: 42px; margin-bottom: 22px; border-radius: 50%;
    border: 3px solid #2b2b33; border-top-color: #7aa2ff; animation: spin 1s linear infinite }
  .spin.done { animation: none; border-top-color: #58c27d; border-color: #2b2b33 #2b2b33 #58c27d #58c27d }
  @keyframes spin { to { transform: rotate(360deg) } }
  h1 { font-size: 19px; font-weight: 600; margin-bottom: 20px }
  .steps { list-style: none; margin-bottom: 22px }
  .steps li { display: flex; align-items: center; gap: 10px; padding: 5px 0; color: #63636c; transition: color .3s }
  .steps li::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #2b2b33; flex: none; transition: background .3s }
  .steps li.doing { color: #cfcfd6 }
  .steps li.doing::before { background: #7aa2ff; animation: pulse 1.2s ease-in-out infinite }
  .steps li.done { color: #8a8a92 }
  .steps li.done::before { background: #58c27d }
  @keyframes pulse { 50% { opacity: .35 } }
  .muted { color: #63636c; font-size: 13px }
  #error { display: none; margin: 6px 0 14px; padding: 12px 14px; border-radius: 10px;
    border: 1px solid #5b3030; background: #241416; color: #f0b0b0; font-size: 14px }
  #retry { display: none; margin-top: 14px; padding: 9px 22px; border: 0; border-radius: 9px;
    background: #7aa2ff; color: #0a0a0c; font-size: 14px; font-weight: 600; cursor: pointer }
</style>
</head>
<body>
<main class="card">
  <div class="brand">讲界视频工坊</div>
  <div class="spin" id="spin"></div>
  <h1 id="title">正在准备工作台…</h1>
  <ul class="steps">
    <li id="s0">分配专属实例</li>
    <li id="s1">启动工作台引擎</li>
    <li id="s2">初始化创作会话</li>
  </ul>
  <p id="error"></p>
  <p class="muted" id="elapsed">已等待 0 秒</p>
  <p class="muted">首次准备约需十几秒。每台浏览器都会分配独立的服务器实例。</p>
  <button id="retry" type="button">立即重试</button>
</main>
<script>
(function () {
  var stageIndex = { queued: 0, creating: 0, starting: 1, booting: 2 }
  var items = [document.getElementById('s0'), document.getElementById('s1'), document.getElementById('s2')]
  var title = document.getElementById('title')
  var error = document.getElementById('error')
  var elapsed = document.getElementById('elapsed')
  var retry = document.getElementById('retry')
  var spin = document.getElementById('spin')
  var start = Date.now()
  var countdown = 0
  var timer = null
  function paint(active) {
    for (var i = 0; i < items.length; i++) {
      items[i].className = i < active ? 'done' : i === active ? 'doing' : ''
    }
  }
  function fail(message, seconds) {
    title.textContent = '工作台暂时不可用'
    error.textContent = message
    error.style.display = 'block'
    retry.style.display = 'inline-block'
    countdown = seconds
  }
  function enter() {
    paint(3)
    title.textContent = '工作台已就绪，正在进入…'
    spin.classList.add('done')
    location.replace('/bohack/')
  }
  function schedule(ms) { timer = setTimeout(poll, ms) }
  async function poll() {
    try {
      var response = await fetch('/bohack/__prepare', { cache: 'no-store' })
      var info = await response.json()
      if (!info.hasCookie) {
        fail('浏览器没有保存本站会话 Cookie（可能开启了严格隐私保护）。请在浏览器设置中允许本站 Cookie，然后刷新页面。', 0)
        return
      }
      if (info.stage === 'ready') { enter(); return }
      if (info.stage === 'failed') { fail(info.message || '工作台启动失败，将自动重试。', 15); schedule(1000); return }
      if (info.stage === 'full') { fail(info.message || '工作台实例已满，将自动重试。', 30); schedule(1000); return }
      if (info.stage === 'idle') { location.reload(); return }
      error.style.display = 'none'
      paint(stageIndex[info.stage] ?? 0)
    } catch (e) {
      title.textContent = '连接中断，正在重试…'
    }
    schedule(1500)
  }
  setInterval(function () {
    elapsed.textContent = '已等待 ' + Math.round((Date.now() - start) / 1000) + ' 秒'
    if (countdown > 0) {
      countdown -= 1
      if (countdown === 0) location.reload()
    }
  }, 1000)
  retry.addEventListener('click', function () { location.reload() })
  poll()
})()
</script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, origin).pathname
  if (pathname === '/') { res.writeHead(302, { location: '/bohack/' }); res.end(); return }
  if (pathname !== '/bohack' && !pathname.startsWith('/bohack/')) { res.writeHead(404); res.end(); return }
  let token = tokenFrom(req)
  if (pathname === '/bohack/__prepare' && req.method === 'GET') {
    const key = token && keyFor(token)
    let stage = (key && status.get(key)?.stage) || 'idle'
    if (stage === 'idle' && key && !pending.has(key)) {
      const data = await load(key)
      if (data && data.expires > Date.now()) stage = 'ready'
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ hasCookie: Boolean(token), stage, message: (key && status.get(key)?.message) || '' }))
    return
  }
  const isEntry = req.method === 'GET' && entryPages.includes(pathname)
  try {
    const existing = token && await load(keyFor(token))
    if ((!existing && !pending.has(token && keyFor(token))) || existing?.expires <= Date.now()) {
      if (!isEntry) {
        res.writeHead(401, {'content-type':'application/json; charset=utf-8'})
        res.end(JSON.stringify({ok:false,error:'请先打开工作台'}))
        return
      }
      token = randomBytes(32).toString('hex')
      res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`)
    }
    const key = keyFor(token)
    const ready = status.get(key)?.stage === 'ready' && !pending.has(key)
    if (isEntry && !ready) {
      getWorker(key).catch(() => {})
      res.writeHead(202, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
      res.end(waitingPage)
      return
    }
    const port = await getWorker(key)
    touch(key)
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
    if (isEntry) {
      // Startup failed or the pool is full; the waiting page reports the reason and retries.
      res.writeHead(202, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
      res.end(waitingPage)
      return
    }
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

// Warm containers from a previous gateway process may be stale; sweep and rebuild the pool.
for (const file of await readdir(stateDir)) {
  if (file.endsWith('.tmp')) await unlink(path.join(stateDir, file)).catch(() => {})
}
for (const file of await warmFiles()) {
  const target = path.join(stateDir, file)
  try { await destroyWarm(JSON.parse(await readFile(target, 'utf8'))) } catch {}
  await unlink(target).catch(() => {})
}
await expireWorkers()
await ensureWarm().catch(error => console.error(`Warm pool setup failed: ${error.message}`))
setInterval(() => { refillWarm().catch(() => {}) }, 60_000).unref()
setInterval(() => { expireWorkers().catch(() => console.error('Worker cleanup failed')) }, 60_000).unref()
server.listen(3110, '127.0.0.1')
