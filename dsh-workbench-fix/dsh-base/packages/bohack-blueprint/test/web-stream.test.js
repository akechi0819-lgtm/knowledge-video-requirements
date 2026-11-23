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

test('asset endpoints retain thread, revision, variant and selected style', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'web-asset-'))
  const file = path.join(dir, 'preview.png')
  await writeFile(file, 'preview')
  const calls = []
  const context = {version:1, doc:{assets:[{id:'guide',ledgerId:'library'}]}, style:{id:'general'}}
  const service = {
    status: async () => ({currentVersion:1,finalized:{version:1},doc:{assets:[{id:'old'}]},blueprintAssets:context.doc.assets,visualStyle:{status:'selected',style:context.style}}),
    generatedAssets: {
      status: async args => {calls.push(['status',args]); return {assets:[{previewUrl:'/bohack/api/generated-asset-file?version=1&id=guide&rev=r1',variants:[{variant:'walk',previewUrl:'/bohack/api/generated-asset-file?version=1&id=guide&rev=r1&variant=walk'}]}]}},
      file: async args => {calls.push(['file',args]); return file},
    },
    production: {generateAsset:async args => {calls.push(['generate',args]); return {assets:[]}}},
  }
  const threads = {get:async id=>{assert.equal(id,'example');return {service}},touch:async()=>{}}
  const server = http.createServer(createWebHandler(null,null,{},threads))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${server.address().port}/bohack/api/generated-assets`
  try {
    const data=await (await fetch(url+'?version=1&threadId=example')).json()
    assert.match(data.assets[0].previewUrl,/threadId=example/)
    assert.match(data.assets[0].variants[0].previewUrl,/threadId=example/)
    const preview=await fetch(`http://127.0.0.1:${server.address().port}`+data.assets[0].variants[0].previewUrl)
    assert.equal(await preview.text(),'preview')
    assert.equal(preview.headers.get('content-type'),'image/png')
    assert.deepEqual(calls.find(c=>c[0]==='file')[1],{...context,id:'guide',revision:'r1',variant:'walk'})
    const generated=await fetch(url+'-generate?threadId=example',{method:'POST',headers:{'content-type':'application/json','x-bohack-client':'1'},body:JSON.stringify({version:1,id:'guide',feedback:'换红帽子'})})
    assert.equal(generated.status,200)
    assert.deepEqual(calls.find(c=>c[0]==='generate')[1],{...context,id:'guide',feedback:'换红帽子'})
    const wrong=await fetch(url+'?version=2&threadId=example')
    assert.equal(wrong.status,400)
  } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})}
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

test('GitHub 安装接口可在无会话时访问，并禁止多人工作台', async () => {
  let enabled = true
  const service = { skillsRoot: '/tmp/unused-github-skills', get skillsInstallEnabled() { return enabled } }
  const threads = { get: async id => { assert.equal(id, null); return { service } } }
  const server = http.createServer(createWebHandler(null, null, {}, threads))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/bohack/api/styles/github/`
    const post = async (endpoint, body) => (await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bohack-client': '1' }, body: JSON.stringify(body) })).json()
    assert.match((await post('inspect', { url: 'https://example.com/a/b' })).error, /GitHub/)
    assert.match((await post('install', { installId: 'missing', selected: ['a'] })).error, /失效/)
    enabled = false
    assert.match((await post('inspect', { url: 'https://github.com/a/b' })).error, /不支持安装/)
    assert.match((await post('install', {})).error, /不支持安装/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
