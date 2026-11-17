import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createWebHandler } from '../lib/web.js'

test('streaming emits progress, isolates threads, preserves JSON and reports errors', async () => {
  const instances = new Map()
  const threads = {
    async get(id) {
      if (!instances.has(id)) instances.set(id, { engine: {}, service: {
        async chat(body, engine, emit) {
          emit?.({ type: 'status', text: body.text })
          await new Promise(resolve => setTimeout(resolve, 20))
          if (body.text === 'fail') throw new Error('failed')
          emit?.({ type: 'text', text: body.text })
          return { ok: true, reply: body.text }
        },
        async generate(body, engine, emit) {
          emit?.({ type: 'status', text: '蓝图生成中' })
          return { ok: true, version: 1 }
        },
      } })
      return instances.get(id)
    },
    async touch() {},
  }
  const server = http.createServer(createWebHandler(null, null, {}, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/bohack/api/`
  const request = async (endpoint, id, text, stream = true) => {
    const response = await fetch(base + endpoint + '?threadId=' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bohack-client': '1', origin: new URL(base).origin, ...(stream ? { accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify({ text }) })
    const body = await response.text()
    return stream ? body.trim().split('\n').map(JSON.parse) : JSON.parse(body)
  }
  try {
    const [a, b, json, generation, error] = await Promise.all([
      request('chat', 'a', 'one'), request('chat', 'b', 'two'),
      request('chat', 'c', 'plain', false), request('generate', 'd', ''), request('chat', 'e', 'fail'),
    ])
    assert.deepEqual(a.map(e => e.text || e.result.reply), ['one', 'one', 'one'])
    assert.deepEqual(b.map(e => e.text || e.result.reply), ['two', 'two', 'two'])
    assert.equal(json.reply, 'plain')
    assert.deepEqual(generation.map(e => e.type), ['status', 'done'])
    assert.deepEqual(error.at(-1), { type: 'error', message: 'failed' })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('video upload streams to temporary storage and returns review data without paths', async () => {
  const { readFile, stat } = await import('node:fs/promises')
  let tempPath
  const analyzer = async ({videoPath, outputDir}) => {
    tempPath = videoPath
    assert.equal(await readFile(videoPath, 'utf8'), 'video bytes')
    return { draft:'节奏明快', evidence:{durationSeconds:3,frames:[{seconds:1,path:outputDir+'/frame.jpg'}]} }
  }
  const handler = createWebHandler({}, {}, {}, null, analyzer)
  const server = http.createServer(handler)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const url=`http://127.0.0.1:${server.address().port}/bohack/api/style-video`
    const invalid=await fetch(url,{method:'POST',headers:{'x-video-extension':'exe','x-bohack-client':'1'},body:'x'})
    assert.equal(invalid.status,400)
    const response=await fetch(url,{method:'POST',headers:{'x-video-extension':'mp4','x-bohack-client':'1'},body:'video bytes'})
    const result=await response.json()
    assert.deepEqual(result, {ok:true,draft:'节奏明快',evidence:{durationSeconds:3,frames:[{seconds:1}]}})
    await assert.rejects(stat(tempPath), {code:'ENOENT'})
  } finally { await new Promise(resolve=>server.close(resolve)) }
})

test('asset review serves the thread preview and confirms its exact revision', async () => {
  const service = {
    status: async () => ({ currentVersion: 1, finalized: {version: 1}, doc: {assets: [{id:'only-in-markdown'}]}, blueprintAssets: [{id:'guide',ledgerId:'library'}], visualStyle: {status: 'selected', style: {id:'general'}} }),
    generatedAssets: {
      status: async () => ({assets: [{previewUrl:'/bohack/api/generated-asset-file?version=1&id=guide&rev=r1'}]}),
    },
    filmApprove: async ({version, doc, style, id, revisions}) => {
      assert.equal(version, 1)
      assert.deepEqual(doc.assets, [{id:'guide', ledgerId:'library'}])
      assert.deepEqual(style, {id:'general'})
      assert.equal(id, 'guide')
      if (revisions?.guide !== 'r1') throw new Error('素材已变化，请重新预览后确认。')
      return {assets:[], allApproved:true}
    },
  }
  const threads = {get: async id => { assert.equal(id, 'example'); return {service} }, touch: async () => {}}
  const server = http.createServer(createWebHandler(null, null, {}, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:'+server.address().port+'/bohack/api/generated-assets'
  try {
    const res = await fetch(url+'?version=1&threadId=example')
    assert.equal(res.status, 200)
    assert.match((await res.json()).assets[0].previewUrl, /threadId=example/)
    const approve = (body) => fetch(url+'-approve?threadId=example', {method:'POST', headers:{'content-type':'application/json','x-bohack-client':'1'}, body:JSON.stringify(body)})
    const confirm = await approve({version:1,id:'guide',revisions:{guide:'r1'}})
    assert.equal(confirm.status, 200)
    assert.equal((await confirm.json()).allApproved, true)
    const stale = await approve({version:1,id:'guide',revisions:{guide:'old'}})
    assert.equal(stale.status, 400)
    assert.match((await stale.json()).error, /素材已变化/)
    const wrongVersion = await approve({version:2,id:'guide',revisions:{guide:'r1'}})
    assert.equal(wrongVersion.status, 400)
    assert.match((await wrongVersion.json()).error, /当前蓝图版本/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('CSRF gate rejects foreign origins and POSTs without the client header', async () => {
  const threads = { get: async () => ({ service: {}, engine: {} }), create: async () => ({ id: 't1' }), touch: async () => {} }
  const server = http.createServer(createWebHandler(null, null, {}, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (headers) => fetch(base + '/bohack/api/threads', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
  try {
    assert.equal((await post({ 'x-bohack-client': '1', origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(base + '/bohack/api/threads', { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await post({ origin: base })).status, 403)
    assert.equal((await post({})).status, 403)
    assert.equal((await post({ 'x-bohack-client': '1', origin: base })).status, 200)
    assert.equal((await post({ 'x-bohack-client': '1', origin: `http://localhost:${server.address().port}` })).status, 200)
    assert.equal((await post({ 'x-bohack-client': '1', origin: `http://[::1]:${server.address().port}` })).status, 200)
    assert.equal((await post({ 'x-bohack-client': '1' })).status, 200)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('revise, section and note share the per-engine turn queue with chat', async () => {
  const active = [], overlaps = []
  const guard = async label => {
    if (active.length) overlaps.push([active[0], label])
    active.push(label)
    await new Promise(resolve => setTimeout(resolve, 15))
    active.pop()
    return { ok: true, label }
  }
  const service = { chat: () => guard('chat'), revise: () => guard('revise'), manualEdit: () => guard('section'), note: () => guard('note') }
  const engine = {}
  const threads = { get: async () => ({ service, engine }), touch: async () => {} }
  const server = http.createServer(createWebHandler(null, null, {}, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/bohack/api/`
  const post = (endpoint, body) => fetch(base + endpoint + '?threadId=q', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bohack-client': '1' }, body: JSON.stringify(body) })
  try {
    const results = await Promise.all([post('chat', { text: 'hi' }), post('revise', {}), post('section', {}), post('note', {})])
    for (const res of results) assert.equal(res.status, 200)
    assert.deepEqual(overlaps, [])
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('thread touch failure does not turn a successful request into 400', async () => {
  const service = { chat: async () => ({ ok: true, reply: 'ok' }) }
  const threads = { get: async () => ({ service, engine: {} }), touch: async () => { throw new Error('touch down') } }
  const warnings = []
  const ctx = { logger: { warn: (...args) => warnings.push(args) } }
  const server = http.createServer(createWebHandler(null, null, ctx, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/bohack/api/chat?threadId=t`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bohack-client': '1' }, body: JSON.stringify({ text: 'hi' }) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).reply, 'ok')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].join(' '), /touch down/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
