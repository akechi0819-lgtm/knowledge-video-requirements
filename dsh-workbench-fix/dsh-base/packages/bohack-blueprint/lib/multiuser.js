import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService } from './service.js'
import { createEngine } from './engine.js'
import { createWebHandler } from './web.js'
import { createProjectExchange } from './project-exchange.js'

// Single-process anonymous sessions. Workspaces are retained until explicitly
// recovered by an operator; expiry is not evidence that a snapshot was saved.
export function createMultiuserHandler(ctx, config) {
  const origin = new URL(config.origin).origin
  if (origin !== config.origin || !/^https?:/.test(origin)) throw new Error('多人模式必须配置完整的允许来源 origin')
  if (!config.workspace || !config.temporaryRoot || !Number.isFinite(config.ttlMs) || config.ttlMs <= 0) throw new Error('多人模式必须配置 workspace、temporaryRoot 和 ttlMs')
  const shared = path.resolve(config.workspace), root = path.resolve(config.temporaryRoot)
  if (root === shared || root.startsWith(shared + path.sep) || shared.startsWith(root + path.sep)) throw new Error('临时目录必须独立于共享工作区')
  const sessions = new Map(), pending = new Map()
  const exchange = createProjectExchange(path.join(root, 'projects'), { ttlMs: config.ttlMs, isActive: id => pending.has(id) || [...sessions.values()].some(session => session.projects.get(id)?.service.production.isActive()) })
  let nextCleanup = 0
  async function cleanup() {
    if (Date.now() < nextCleanup) return
    nextCleanup = Date.now() + 60000
    for (const id of await exchange.cleanup()) {
      for (const session of sessions.values()) {
        const project = session.projects.get(id)
        if (project) { project.engine.reset(); session.projects.delete(id) }
      }
    }
  }
  const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  async function body(req) {
    let size = 0; const chunks = []
    for await (const chunk of req) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error('项目包超过 100 MB'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async function exclusive(id, task) {
    const previous = pending.get(id) || Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    pending.set(id, current)
    try { return await current } finally { if (pending.get(id) === current) pending.delete(id) }
  }
  async function seed(dir) {
    await Promise.all(['.agents', 'rules'].map(name => cp(path.join(shared, name), path.join(dir, name), { recursive: true })))
    await cp(fileURLToPath(new URL('../vendor/scene_retrieval.py', import.meta.url)), path.join(dir, 'scene_retrieval.py'))
  }
  function newSession(token) {
    const projects = new Map(), keys = new Map(), settingsRoot = path.join(root, 'sessions', token)
    const opts = { ...config, temporaryKeys: keys, settingsRoot, styleLibraryRoot: settingsRoot }
    const defaultConfig = { ...opts, workspace: settingsRoot }
    const fallback = { service: createService(ctx, defaultConfig), engine: createEngine(ctx, defaultConfig) }
    const getProject = id => { const item = projects.get(id); if (!item) throw new Error('工作区不存在或不属于当前会话'); return item }
    async function create(snapshot = { version: 1, files: [] }, title = '新会话') {
      const { id, workspace } = await exchange.create(snapshot)
      await seed(workspace)
      const now = new Date().toISOString()
      let previous = {}
      try { previous = JSON.parse(await readFile(path.join(workspace, 'thread.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
      const thread = { id, title: String(previous.title || title || '新会话').slice(0, 40), createdAt: previous.createdAt || now, updatedAt: now }
      await writeFile(path.join(workspace, 'thread.json'), JSON.stringify(thread, null, 2) + '\n')
      const projectConfig = { ...opts, workspace }
      projects.set(id, { thread, service: createService(ctx, projectConfig), engine: createEngine(ctx, projectConfig) })
      return thread
    }
    const threads = {
      create: ({ title } = {}) => create(undefined, title),
      list: async () => [...projects.values()].map(p => p.thread),
      get: async id => id ? getProject(id) : fallback,
      metadata: async id => getProject(id).thread,
      touch: async (id, title) => {
        const item = getProject(id)
        if (item.thread.title === '新会话' && title) item.thread.title = String(title).trim().slice(0, 40) || item.thread.title
        item.thread.updatedAt = new Date().toISOString()
        await writeFile(path.join(exchange.workspace(id), 'thread.json'), JSON.stringify(item.thread, null, 2) + '\n')
        await exchange.touch(id)
      },
    }
    return { projects, threads, create, expiresAt: Date.now() + config.ttlMs, handler: createWebHandler(fallback.service, fallback.engine, ctx, threads, undefined, value => value === origin) }
  }
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost'), method = (req.method || 'GET').toUpperCase()
    const requestOrigin = req.headers.origin
    if ((requestOrigin && requestOrigin !== origin) || (method !== 'GET' && method !== 'HEAD' && requestOrigin !== origin)) { reply(res, 403, { ok: false, error: '来源不允许' }); return }
    const token = /(?:^|;\s*)bohack_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]
    let session = sessions.get(token)
    if (session && session.expiresAt <= Date.now() && ![...session.projects.values()].some(project => project.service.production.isActive())) { sessions.delete(token); session = undefined }
    if (!session && (url.pathname === '/bohack' || url.pathname === '/bohack/' || url.pathname === '/bohack/index.html') && method === 'GET') {
      const id = randomBytes(32).toString('hex'); session = newSession(id); sessions.set(id, session)
      res.setHeader('set-cookie', `bohack_session=${id}; Path=/bohack; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.ceil(config.ttlMs / 1000))}${origin.startsWith('https:') ? '; Secure' : ''}`)
    }
    if (!session) { reply(res, 401, { ok: false, error: '请先打开工作台' }); return }
    const projectScripts = new Map([['/bohack/project-storage', 'project-storage.js'], ['/bohack/local-projects.js', 'local-projects.js']])
    if (method === 'GET' && projectScripts.has(url.pathname)) {
      const script = await readFile(new URL('../web/' + projectScripts.get(url.pathname), import.meta.url))
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(script)
      return
    }
    if (url.pathname === '/bohack/api/asset-open') { reply(res, 403, { ok: false, error: '多人模式不能打开服务器上的文件' }); return }
    const id = url.searchParams.get('threadId') || req.headers['x-thread-id']
    try {
      await cleanup()
      if (url.pathname === '/bohack/api/projects/import' && method === 'POST') {
        if (!req.headers['x-bohack-client']) { reply(res, 403, { ok: false, error: '缺少客户端标识' }); return }
        const thread = await session.create(await body(req)); reply(res, 200, { ok: true, thread }); return
      }
      if (url.pathname === '/bohack/api/projects/export' && method === 'POST') {
        if (!req.headers['x-bohack-client']) { reply(res, 403, { ok: false, error: '缺少客户端标识' }); return }
        if (!session.projects.has(id)) throw new Error('工作区不存在或不属于当前会话')
        await exclusive(id, async () => {
          if (session.projects.get(id).service.production.isActive()) throw new Error('制作正在进行，不能导出')
          await exchange.touch(id)
          reply(res, 200, { ok: true, snapshot: await exchange.exportProject(id) })
        }); return
      }
      if (id) {
        if (!session.projects.has(id)) throw new Error('工作区不存在或不属于当前会话')
        await exclusive(id, async () => { await exchange.touch(id); await session.handler(req, res) })
      } else await session.handler(req, res)
    } catch (e) { if (!res.headersSent) reply(res, 400, { ok: false, error: String(e.message || e) }); else res.destroy() }
  }
}
