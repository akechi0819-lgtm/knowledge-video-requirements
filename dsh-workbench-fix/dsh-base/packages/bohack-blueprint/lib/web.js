/**
 * /bohack temporary UI: one prefix WebRoute.handler owning the response
 * lifecycle. A handler (not a WebResourceRoute.resource) is required because
 * `resource` answers only GET/HEAD and 405s everything else; the workbench has
 * POST write actions. These HTTP endpoints are a thin transport adapter over
 * the in-process capability service — they are NOT a team contract and carry
 * no authentication (bound to 127.0.0.1 by the shipped webserver config).
 */
import { readFile, stat, mkdtemp, open, rm } from 'node:fs/promises'
import os from 'node:os'
import { analyzeVideo } from './video-style.js'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { readGithubStyle } from './github-style.js'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HTML_FILE = path.resolve(HERE, '..', 'web', 'index.html')

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大（上限 2 MB）')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(raw) } catch { throw new Error('请求体不是合法 JSON') }
}

/** Map a service/validation error to a stable HTTP result. */
function errorBody(e) {
  return { ok: false, error: String(e?.message || e), code: e?.code || 'BOHACK_ERROR' }
}

export function createWebHandler(legacyService, legacyEngine, ctx, threads, videoAnalyzer = analyzeVideo) {
  const queues = new WeakMap()
  async function runTurn(engine, task) {
    const previous = queues.get(engine) || Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    queues.set(engine, current)
    try { return await current } finally { if (queues.get(engine) === current) queues.delete(engine) }
  }
  return async function handle(req, res) {
    let pathname = '/'
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname } catch { /* keep default */ }
    const method = (req.method || 'GET').toUpperCase()

    try {
      // ── static page ─────────────────────────────────────────────────────
      if (['/bohack/style-previews/andy.mp4', '/bohack/style-previews/hey.mp4'].includes(pathname) && (method === 'GET' || method === 'HEAD')) {
        const file = path.join(path.dirname(HTML_FILE), 'style-previews', path.basename(pathname))
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': (await stat(file)).size })
        if (method === 'HEAD') res.end()
        else createReadStream(file).pipe(res)
        return
      }
      if (pathname === '/bohack' || pathname === '/bohack/' || pathname === '/bohack/index.html') {
        if (method !== 'GET' && method !== 'HEAD') { text(res, 405, 'Method Not Allowed'); return }
        const html = await readFile(HTML_FILE, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(method === 'HEAD' ? undefined : html)
        return
      }

      if (pathname === '/bohack/api/threads' && method === 'GET') {
        json(res, 200, { ok: true, threads: await threads.list() }); return
      }
      if (pathname === '/bohack/api/threads' && method === 'POST') {
        json(res, 200, { ok: true, thread: await threads.create(await readBody(req)) }); return
      }
      const params = new URL(req.url || '/', 'http://localhost').searchParams
      const threadId = params.get('threadId') || req.headers['x-thread-id'] || null
      const { service, engine } = threads ? await threads.get(threadId) : { service: legacyService, engine: legacyEngine }
      if (pathname === '/bohack/api/thread' && method === 'GET') {
        if (!threadId) throw new Error('需要指定会话 ID')
        json(res, 200, { ok: true, thread: await threads.metadata(threadId) }); return
      }

      if (pathname === '/bohack/api/production-file' && (method === 'GET' || method === 'HEAD')) {
        const kind = params.get('kind')
        const file = await service.production.file(kind)
        const size = (await stat(file)).size
        const headers = { 'content-type': kind === 'video' ? 'video/mp4' : 'application/json; charset=utf-8', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
        let start = 0, end = size - 1, code = 200
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
          if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return }
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; code = 206
          headers['content-range'] = `bytes ${start}-${end}/${size}`
        }
        headers['content-length'] = end - start + 1
        res.writeHead(code, headers)
        if (method === 'HEAD') res.end(); else createReadStream(file, { start, end }).pipe(res)
        return
      }
      if (pathname === '/bohack/api/style-video' && method === 'POST') {
        const extension = String(req.headers['x-video-extension'] || '').toLowerCase()
        if (!['mp4', 'mov', 'webm'].includes(extension)) throw new Error('请选择 MP4、MOV 或 WebM 视频。')
        const dir = await mkdtemp(path.join(os.tmpdir(), 'bohack-style-video-'))
        let result
        try {
          const videoPath = path.join(dir, `reference.${extension}`)
          const handle = await open(videoPath, 'wx', 0o600)
          try {
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > 500 * 1024 * 1024) throw new Error('视频超过 500 MB 上限。')
              await handle.writeFile(chunk)
            }
            if (!size) throw new Error('视频文件为空。')
          } finally { await handle.close() }
          result = await videoAnalyzer({ videoPath, outputDir: dir, projectModel: await service.projectModel?.resolve() })
        } finally { await rm(dir, { recursive: true, force: true }) }
        json(res, 200, { ok: true, draft: result.draft, evidence: { durationSeconds: result.evidence.durationSeconds, frames: result.evidence.frames.map(frame => ({ seconds: frame.seconds })) } }); return
      }
      if (pathname === '/bohack/api/style-export' && method === 'GET') {
        const markdown = await service.styles.exportMarkdown({ id: params.get('id') })
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename=SKILL.md', 'cache-control': 'no-store' }); res.end(markdown); return
      }
      if (pathname === '/bohack/api/project-model' && method === 'GET') { json(res, 200, await service.projectModel.view()); return }
      if (pathname === '/bohack/api/styles' && method === 'GET') { json(res, 200, await service.styles.list()); return }

      // ── read endpoints ──────────────────────────────────────────────────
      if (pathname === '/bohack/api/status' && method === 'GET') {
        json(res, 200, await service.status()); return
      }
      if (pathname === '/bohack/api/blueprint' && method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams
        const version = q.get('version') ? Number(q.get('version')) : undefined
        json(res, 200, await service.show({ version })); return
      }
      if (pathname === '/bohack/api/validate' && method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams
        const version = q.get('version') ? Number(q.get('version')) : undefined
        json(res, 200, await service.validate({ version })); return
      }
      if (pathname === '/bohack/api/trace' && method === 'GET') {
        json(res, 200, await service.trace().catch(e => errorBody(e))); return
      }
      if (pathname === '/bohack/api/chat' && method === 'GET') {
        json(res, 200, await service.chatHistory()); return
      }
      if (pathname === '/bohack/api/adjustments' && method === 'GET') {
        json(res, 200, await service.adjustments()); return
      }
      if (pathname === '/bohack/api/requirement' && method === 'GET') {
        json(res, 200, await service.requirement()); return
      }
      if (pathname === '/bohack/api/assets' && method === 'GET') {
        json(res, 200, await service.listAssets()); return
      }
      if (pathname === '/bohack/api/upload' && method === 'POST') {
        // Drag-and-drop: base64 body, own cap (10 MB) before generic parsing.
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 12 * 1024 * 1024) { json(res, 400, { ok: false, error: '文件过大（上限 10 MB）' }); return }
          chunks.push(chunk)
        }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        catch { json(res, 400, { ok: false, error: '上传体不是合法 JSON' }); return }
        json(res, 200, await service.uploadAsset(body)); return
      }
      if (pathname === '/bohack/api/file' && method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams
        const rel = String(q.get('path') || '')
        // Only files inside our own workspace directories, never arbitrary paths.
        const allowed = ['inbox/', 'outbox/', 'rules/', 'runs/', 'dialogue/']
        if (!allowed.some(p => rel.startsWith(p)) || rel.includes('..')) {
          json(res, 400, { ok: false, error: '只允许读取 workspace 下的 inbox/outbox/rules/runs/dialogue' }); return
        }
        const root = service._internal.dirs.root
        const buf = await readFile(path.resolve(root, rel), 'utf8')
        text(res, 200, buf, 'text/plain; charset=utf-8'); return
      }
      if (pathname === '/bohack/api/health' && method === 'GET') {
        json(res, 200, {
          ok: true, plugin: '@bohack/blueprint',
          workspace: service._internal.dirs.root,
          engine: {
            agents: !!ctx.get?.('agents'), presets: !!ctx.get?.('agentPresets'),
            webServer: !!ctx.get?.('webServer'),
            diagnostics: typeof engine.diagnostics === 'object' ? engine.diagnostics : null,
          },
          sessionId: engine.sessionId || null,
        }); return
      }

      // ── write endpoints ─────────────────────────────────────────────────
      if (method !== 'POST') { json(res, 404, { ok: false, error: `未知端点 ${method} ${pathname}` }); return }
      const body = await readBody(req)
      const streaming = (pathname === '/bohack/api/chat' || pathname === '/bohack/api/generate') &&
        String(req.headers.accept || '').split(',').some(value => value.trim().split(';')[0] === 'application/x-ndjson')
      const emit = event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n') }
      if (streaming) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.flushHeaders?.()
      }
      let out
      switch (pathname) {
        case '/bohack/api/project-model': out = await service.projectModel.save(body); break
        case '/bohack/api/style-github': out = await readGithubStyle(body); break
        case '/bohack/api/styles-import': out = await service.styles.importStyle(body); break
        case '/bohack/api/styles-update': out = await service.styles.update(body); break
        case '/bohack/api/styles-select': out = await service.selectVisualStyle(body); break
        case '/bohack/api/styles-remove': out = await service.styles.remove(body); break
        case '/bohack/api/ingest':   out = await service.ingest(body); break
        case '/bohack/api/generate':
          // fresh:true = 换车（新需求单 → 新蓝图会话），丢弃旧会话句柄。
          out = await runTurn(engine, async () => {
            if (body.fresh) engine.reset()
            return service.generate(body, engine, streaming ? emit : undefined)
          }); break
        case '/bohack/api/revise':   out = await service.revise(body, engine); break
        case '/bohack/api/confirm':  out = await service.confirm(body); break
        case '/bohack/api/feedback': out = await service.feedback(body); break
        case '/bohack/api/finalize': out = await service.finalize(); break
        case '/bohack/api/production': out = await service.production.start(); break
        case '/bohack/api/chat':     out = await runTurn(engine, () => service.chat(body, engine, streaming ? emit : undefined)); break
        case '/bohack/api/section':  out = await service.manualEdit(body, engine); break
        case '/bohack/api/note':     out = await service.note(body, engine); break
        case '/bohack/api/lock':     out = await service.lock(body); break
        case '/bohack/api/assets-update': out = await service.updateAsset(body); break
        default:
          json(res, 404, { ok: false, error: `未知端点 ${pathname}` }); return
      }
      if (threadId) await threads.touch(threadId, pathname === '/bohack/api/chat' ? body.text : null)
      if (streaming) { emit({ type: 'done', result: out }); res.end() }
      else json(res, 200, out)
    } catch (e) {
      try { ctx.logger?.warn?.('[bohack/web]', String(e?.stack || e)) } catch { /* ignore */ }
      if (!res.headersSent) json(res, 400, errorBody(e))
      else { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type: 'error', code: e?.code, message: String(e?.message || e) }) + '\n'); res.end() }
    }
  }
}
