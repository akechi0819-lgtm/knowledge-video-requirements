/**
 * /bohack temporary UI: one prefix WebRoute.handler owning the response
 * lifecycle. A handler (not a WebResourceRoute.resource) is required because
 * `resource` answers only GET/HEAD and 405s everything else; the workbench has
 * POST write actions. These HTTP endpoints are a thin transport adapter over
 * the in-process capability service — they are NOT a team contract and carry
 * no authentication (bound to 127.0.0.1 by the shipped webserver config).
 */
import { readFile, stat, mkdtemp, open, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import { analyzeVideo } from './video-style.js'
import { generatePreview } from './preview.js'
import { listModels } from './models.js'
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

    // CSRF gate: this API has no authentication, so only loopback pages may call
    // it, and POSTs must carry a custom header cross-origin simple requests cannot set.
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { text(res, 403, 'Forbidden'); return }
    if (method === 'POST' && !req.headers['x-bohack-client']) { text(res, 403, 'Forbidden'); return }

    try {
      const assetTypes = { 'studio.css': 'text/css', 'preview.js': 'text/javascript', 'settings.js': 'text/javascript', 'film.js': 'text/javascript', 'paper-fiber.png': 'image/png' }
      const asset = pathname.slice('/bohack/'.length)
      if (pathname.startsWith('/bohack/') && Object.hasOwn(assetTypes, asset) && (method === 'GET' || method === 'HEAD')) {
        const data = await readFile(path.join(path.dirname(HTML_FILE), asset))
        res.writeHead(200, { 'content-type': assetTypes[asset], 'cache-control': 'no-cache' })
        res.end(method === 'HEAD' ? undefined : data)
        return
      }
      // ── static page ─────────────────────────────────────────────────────
      if (pathname.startsWith('/bohack/style-previews/') && (method === 'GET' || method === 'HEAD')) {
        const types = { '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
        const name = path.basename(pathname)
        const ext = path.extname(name).toLowerCase()
        const dir = path.resolve(path.dirname(HTML_FILE), 'style-previews')
        const file = path.resolve(dir, name)
        if (!types[ext] || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name) || file !== path.join(dir, name)) {
          text(res, 404, 'Not Found'); return
        }
        try {
          const info = await stat(file)
          if (!info.isFile()) { text(res, 404, 'Not Found'); return }
          const resolved = await realpath(file)
          const rootResolved = await realpath(dir)
          if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) { text(res, 404, 'Not Found'); return }
          const headers = { 'content-type': types[ext], 'content-length': info.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }
          if (ext === '.svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"
          res.writeHead(200, headers)
          if (method === 'HEAD') res.end()
          else {
            const stream = createReadStream(file)
            stream.on('error', () => { if (!res.headersSent) text(res, 500, 'read error'); res.destroy() })
            stream.pipe(res)
          }
        } catch (e) {
          if (e.code === 'ENOENT') { text(res, 404, 'Not Found'); return }
          throw e
        }
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
      async function generatedContext(version) {
        const current = await service.status()
        if (!current.currentVersion || !current.doc || Number(version || current.currentVersion) !== current.currentVersion) throw new Error('请使用当前蓝图版本。')
        if (current.finalized?.version !== current.currentVersion || current.visualStyle?.status !== 'selected') throw new Error('请先确认蓝图并选择视觉参考。')
        return { version: current.currentVersion, doc: current.doc, style: current.visualStyle?.style || null }
      }
      function generatedUrls(result) {
        if (threadId) for (const asset of result.assets) if (asset.previewUrl) asset.previewUrl += `&threadId=${encodeURIComponent(threadId)}`
        return result
      }
      if (pathname === '/bohack/api/generated-assets' && method === 'GET') {
        json(res, 200, generatedUrls(await service.generatedAssets.status(await generatedContext(params.get('version'))))); return
      }
      if (pathname === '/bohack/api/generated-asset-file' && (method === 'GET' || method === 'HEAD')) {
        const file = await service.generatedAssets.file({ ...await generatedContext(params.get('version')), id: params.get('id'), revision: params.get('rev') })
        const data = await readFile(file)
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-security-policy': "default-src 'none'; style-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
        res.end(method === 'HEAD' ? undefined : data); return
      }
      if (pathname === '/bohack/api/blueprint-skill' && method === 'GET') { json(res, 200, {ok:true, skill:await service.styles.blueprintSkill()}); return }
      if (pathname === '/bohack/api/blueprint-skill' && method === 'POST') { json(res, 200, await service.styles.chooseBlueprintSkill(await readBody(req))); return }
      if (pathname === '/bohack/api/models' && method === 'POST') { json(res, 200, await listModels(await readBody(req), await service.settings.load())); return }
      if (pathname === '/bohack/api/settings' && method === 'GET') { json(res, 200, await service.settings.get()); return }
      if (pathname === '/bohack/api/settings' && method === 'POST') { json(res, 200, await service.settings.update(await readBody(req))); return }
      if (pathname === '/bohack/api/thread' && method === 'GET') {
        if (!threadId) throw new Error('需要指定会话 ID')
        json(res, 200, { ok: true, thread: await threads.metadata(threadId) }); return
      }

      if (pathname === '/bohack/api/production-file' && (method === 'GET' || method === 'HEAD')) {
        const kind = params.get('kind')
        const file = await service.production.file(kind, params.get('section'))
        const size = (await stat(file)).size
        const type = kind === 'video' || kind === 'clip' ? 'video/mp4'
          : kind === 'audio' ? 'audio/mpeg'
          : kind === 'scene' && file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/json; charset=utf-8'
        const headers = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
        let start = 0, end = size - 1, code = 200
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
          if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return }
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; code = 206
          headers['content-range'] = `bytes ${start}-${end}/${size}`
        }
        headers['content-length'] = end - start + 1
        res.writeHead(code, headers)
        if (method === 'HEAD') res.end()
        else {
          const stream = createReadStream(file, { start, end })
          stream.on('error', () => { if (!res.headersSent) text(res, 500, 'read error'); res.destroy() })
          stream.pipe(res)
        }
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
          const model = (await service.settings?.load())?.model
          result = await videoAnalyzer({ videoPath, outputDir: dir, projectModel: model?.baseUrl ? { endpoint: model.baseUrl, model: model.model, key: model.apiKey } : undefined })
        } finally { await rm(dir, { recursive: true, force: true }) }
        json(res, 200, { ok: true, draft: result.draft, evidence: { durationSeconds: result.evidence.durationSeconds, frames: result.evidence.frames.map(frame => ({ seconds: frame.seconds })) } }); return
      }
      if (pathname === '/bohack/api/style-export' && method === 'GET') {
        const markdown = await service.styles.exportMarkdown({ id: params.get('id') })
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename=SKILL.md', 'cache-control': 'no-store' }); res.end(markdown); return
      }
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
        // Allow a 10 MiB file after Base64 expansion plus JSON metadata.
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 4 * Math.ceil(10 * 1024 * 1024 / 3) + 64 * 1024) { json(res, 400, { ok: false, error: '文件过大（上限 10 MB）' }); return }
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
        // Symlinks/junctions can pass the string checks above; resolve before reading.
        const resolved = await realpath(path.resolve(root, rel))
        const rootResolved = await realpath(root)
        if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
          json(res, 400, { ok: false, error: '只允许读取 workspace 下的 inbox/outbox/rules/runs/dialogue' }); return
        }
        const buf = await readFile(resolved, 'utf8')
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
        case '/bohack/api/generated-assets-generate': out = generatedUrls(await service.generatedAssets.generate({ ...await generatedContext(body.version), id: body.id })); break
        case '/bohack/api/generated-assets-approve': out = generatedUrls(await service.generatedAssets.approve({ ...await generatedContext(body.version), id: body.id, revisions: body.revisions })); break
        case '/bohack/api/preview': out = { ok: true, scenes: await generatePreview((await service.status()).sections, await service.settings.load()) }; break
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
        case '/bohack/api/revise':   out = await runTurn(engine, () => service.revise(body, engine)); break
        case '/bohack/api/confirm':  out = await service.confirm(body); break
        case '/bohack/api/feedback': out = await service.feedback(body); break
        case '/bohack/api/finalize': out = await service.finalize(body); break
        case '/bohack/api/production': out = await service.production.start(); break
        case '/bohack/api/chat':     out = await runTurn(engine, () => service.chat(body, engine, streaming ? emit : undefined)); break
        case '/bohack/api/section':  out = await runTurn(engine, () => service.manualEdit(body, engine)); break
        case '/bohack/api/note':     out = await runTurn(engine, () => service.note(body, engine)); break
        case '/bohack/api/lock':     out = await service.lock(body); break
        case '/bohack/api/assets-update': out = await service.updateAsset(body); break
        default:
          json(res, 404, { ok: false, error: `未知端点 ${pathname}` }); return
      }
      if (threadId) {
        // touch is bookkeeping; its failure must not turn a successful turn into 400.
        try { await threads.touch(threadId, pathname === '/bohack/api/chat' ? body.text : null) }
        catch (e) { ctx.logger?.warn?.('[bohack/web] threads.touch', String(e?.message || e)) }
      }
      if (streaming) { emit({ type: 'done', result: out }); res.end() }
      else json(res, 200, out)
    } catch (e) {
      try { ctx.logger?.warn?.('[bohack/web]', String(e?.stack || e)) } catch { /* ignore */ }
      if (!res.headersSent) json(res, 400, errorBody(e))
      else { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type: 'error', message: String(e?.message || e) }) + '\n'); res.end() }
    }
  }
}
