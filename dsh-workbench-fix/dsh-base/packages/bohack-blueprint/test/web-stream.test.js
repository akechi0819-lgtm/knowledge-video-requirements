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
    const response = await fetch(base + endpoint + '?threadId=' + id, { method: 'POST', headers: { 'content-type': 'application/json', ...(stream ? { accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify({ text }) })
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
    const invalid=await fetch(url,{method:'POST',headers:{'x-video-extension':'exe'},body:'x'})
    assert.equal(invalid.status,400)
    const response=await fetch(url,{method:'POST',headers:{'x-video-extension':'mp4'},body:'video bytes'})
    const result=await response.json()
    assert.deepEqual(result, {ok:true,draft:'节奏明快',evidence:{durationSeconds:3,frames:[{seconds:1}]}})
    await assert.rejects(stat(tempPath), {code:'ENOENT'})
  } finally { await new Promise(resolve=>server.close(resolve)) }
})

test('asset review serves the thread preview and confirms its exact revision', async () => {
  const service = {
    status: async () => ({ currentVersion: 1, finalized: {version: 1}, doc: {assets: []}, visualStyle: {status: 'selected', style: {id:'general'}} }),
    generatedAssets: {
      status: async () => ({assets: [{previewUrl:'/bohack/api/generated-asset-file?version=1&id=guide&rev=r1'}]}),
      approve: async ({version, revisions}) => {
        assert.equal(version, 1)
        assert.deepEqual(revisions, {guide:'r1'})
        return {assets:[], allApproved:true}
      },
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
    const confirm = await fetch(url+'-approve?threadId=example', {method:'POST', body:JSON.stringify({version:1,revisions:{guide:'r1'}})})
    assert.equal((await confirm.json()).allApproved, true)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
