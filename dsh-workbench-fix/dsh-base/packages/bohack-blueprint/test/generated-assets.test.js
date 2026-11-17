import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGeneratedAssets, renderAsset } from '../lib/generated-assets.js'

test('素材生成、确认、单项重建及风格变更均隔离版本与生产快照', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-test-'))
  try {
    const shapes = Array.from({ length: 5 }, (_, i) => ({ d: `M ${i} 0 L 10 10 Z`, fill: '#123456', stroke: 'none', width: 1 }))
    const calls = []
    let gate = null
    const assets = createGeneratedAssets(root, { settings: { load: async () => ({ model: { baseUrl: 'http://localhost:1234', model: 'test' } }) }, request: async (_url, options) => { calls.push(JSON.parse(options.body)); if (gate) await gate; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ shapes }) } }] }) } } })
    const doc = { assets: [{ id: 'hero', name: '商人', type: 'character', description: '古代商人', sections: ['B01'] }, { id: 'bag', name: '布袋', type: 'prop', description: '货袋', sections: ['B01'] }] }
    const args = { version: 1, doc, style: { name: '纸绘' } }
    assert.deepEqual((await assets.status(args)).assets.map(a => a.status), ['pending', 'pending'])
    await assets.generate(args)
    assert.match(calls[0].messages[0].content, /古代商人/)
    const generated = await assets.status(args)
    const revisions = Object.fromEntries(generated.assets.map(a => [a.id, a.revision]))
    await assert.rejects(assets.approve(args), /重新预览/ )
    await assets.approve({ ...args, revisions })
    const reassigned = {assets: [{...doc.assets[0], sections:['B02']}]}
    const assignedFiles = await assets.availableFiles({...args,doc:reassigned})
    assert.deepEqual(assignedFiles.approved.map(item => [item.id,item.sections,item.revision]), [['hero',['B02'],revisions.hero]])
    const oldUrl = (await assets.status(args)).assets[0].previewUrl
    await assets.generate(args)
    assert.equal(calls.length, 2)
    const files = await assets.approvedFiles(args), before = await readFile(files[0].path, 'utf8')
    await assets.generate({ ...args, id: 'hero' })
    const rebuilt = await assets.status(args)
    assert.deepEqual(rebuilt.assets.map(a => a.status), ['generated', 'approved'])
    assert.notEqual(rebuilt.assets[0].previewUrl, oldUrl)
    await assert.rejects(assets.file({ ...args, id: 'hero', revision: revisions.hero }), /过期/)
    await assert.rejects(assets.approve({ ...args, id: 'hero', revisions }), /重新预览/)
    assert.ok(await assets.file({ ...args, id: 'hero', revision: rebuilt.assets[0].revision }))
    let release
    gate = new Promise(resolve => { release = resolve })
    const running = assets.generate({ ...args, id: 'hero' })
    await assert.rejects(assets.approvedFiles(args), /正在生成或确认/)
    release()
    await running
    assert.equal(await readFile(files[0].path, 'utf8'), before)
    await assert.rejects(assets.approvedFiles(args), /尚未确认/)
    assert.equal((await assets.status({ ...args, style: { name: '像素' } })).assets[1].status, 'pending')
    assert.equal((await assets.status({ ...args, version: 2 })).assets[1].status, 'pending')
    assert.doesNotMatch(renderAsset([...shapes.slice(0, 4), { ...shapes[4], d: 'M 0 0" onload="evil' }]), /onload/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('素材脏图元反馈修正，修正仍无效时保留安全图元', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-repair-test-'))
  try {
    const requests = []
    const good = {d:'M0 0 L5 5',fill:'#abc',stroke:'red',width:20}
    const bad = {...good, d:'M0 0" onload="evil'}
    const assets = createGeneratedAssets(root, {settings:{load:async()=>({model:{baseUrl:'http://localhost',model:'test'}})}, request:async (_url, options) => {
      requests.push(JSON.parse(options.body)); return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({shapes:requests.length === 1 ? [good,bad] : [bad]})}}]})}
    }})
    const args = {version:1,doc:{assets:[{id:'a',name:'书',type:'prop',description:'书',sections:['B01']}]},style:null}
    const result = await assets.generate(args)
    assert.equal(requests.length, 2)
    assert.match(requests[1].messages.at(-1).content, /部分图元/)
    const svg = await readFile(await assets.file({...args,id:'a',revision:result.assets[0].revision}), 'utf8')
    assert.match(svg, /stroke-width="20"/); assert.doesNotMatch(svg, /onload/)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('丢失的素材变为待生成，仅补齐丢失项并保留其他确认', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-missing-'))
  try {
    let calls = 0
    const assets = createGeneratedAssets(root, {settings:{load:async()=>({model:{baseUrl:'http://localhost',model:'test'}})}, request:async()=>{
      calls++; return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({shapes:[{d:`M0 0 L${calls} 1`,fill:'#123456',stroke:'none',width:1}]})}}]})}
    }})
    const args = {version:1,doc:{assets:[{id:'a',name:'船',type:'prop',description:'船',sections:['B01']},{id:'b',name:'书',type:'prop',description:'书',sections:['B01']}]},style:null}
    const initial = await assets.generate(args)
    const revisions = Object.fromEntries(initial.assets.map(a=>[a.id,a.revision]))
    await assets.approve({...args,revisions})
    await rm(await assets.file({...args,id:'a',revision:revisions.a}))
    const missing = await assets.status(args)
    assert.deepEqual(missing.assets.map(a=>a.status),['pending','approved'])
    assert.deepEqual(missing.assets.map(a=>a.missingFile),[true,false])
    assert.equal(missing.assets[0].revision,null); assert.equal(missing.assets[0].previewUrl,null)
    const repaired = await assets.generate(args)
    assert.equal(calls,3); assert.deepEqual(repaired.assets.map(a=>a.status),['generated','approved'])
    assert.equal(repaired.assets[1].revision,revisions.b)
    const before = await readFile(await assets.file({...args,id:'a',revision:repaired.assets[0].revision}),'utf8')
    const rebuilt = await assets.generate({...args,id:'a'})
    assert.equal(calls,4); assert.equal(rebuilt.assets[1].revision,revisions.b)
    assert.notEqual(await readFile(await assets.file({...args,id:'a',revision:rebuilt.assets[0].revision}),'utf8'),before)
  } finally { await rm(root,{recursive:true,force:true}) }
})


test('DSH 模式在隔离目录运行并生成素材', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-dsh-test-'))
  const oldMode = process.env.SCENE_MODE, oldPath = process.env.PATH
  try {
    const bin = path.join(root, 'bin'); await mkdir(bin)
    const executable = path.join(bin, 'dsh')
    const shapes = Array.from({ length: 5 }, () => ({ d: 'M 0 0 L 10 10 Z', fill: '#123456', stroke: 'none', width: 1 }))
    await writeFile(executable, `#!/bin/sh\ncat > /dev/null\nprintf '%s\n' '${JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: JSON.stringify({ shapes }) })}'\n`)
    await chmod(executable, 0o755)
    process.env.SCENE_MODE = 'dsh'; process.env.PATH = bin + path.delimiter + oldPath
    const assets = createGeneratedAssets(root, { settings: { load: async () => ({}) } })
    const args = { version: 1, doc: { assets: [{ id: 'a', name: '书', type: 'prop', description: '书本', sections: ['B01'] }] }, style: null }
    assert.equal((await assets.generate(args)).assets[0].status, 'generated')
  } finally {
    if (oldMode === undefined) delete process.env.SCENE_MODE; else process.env.SCENE_MODE = oldMode
    process.env.PATH = oldPath
    await rm(root, { recursive: true, force: true })
  }
})

test('MiMo 素材关闭思考并允许超过 90 秒，响应超时明确报错', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-timeout-test-'))
  const original = AbortSignal.timeout
  let timeout
  AbortSignal.timeout = ms => { timeout = ms; return original(ms) }
  try {
    const assets = createGeneratedAssets(root, { settings: { load: async () => ({ model: { baseUrl: 'http://localhost:1234', model: 'mimo-v2.6-pro' } }) }, request: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).thinking, { type: 'disabled' })
      return { ok: true, json: async () => { throw new DOMException('timeout', 'TimeoutError') } }
    } })
    await assert.rejects(assets.generate({ version: 1, doc: { assets: [{ id: 'a', name: '书', type: 'prop', description: '书本', sections: ['B01'] }] }, style: null }), /生成超时/)
    assert.equal(timeout, 600000)
  } finally { AbortSignal.timeout = original; await rm(root, { recursive: true, force: true }) }
})

test('模型地址归一化为 chat/completions 端点且禁止重定向', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-url-test-'))
  try {
    const shapes = Array.from({ length: 5 }, () => ({ d: 'M 0 0 L 10 10 Z', fill: '#123456', stroke: 'none', width: 1 }))
    const doc = { assets: [{ id: 'a', name: '书', type: 'prop', description: '书本', sections: ['B01'] }] }
    for (const [i, baseUrl] of ['https://x/v1', 'https://x/v1/chat/completions', 'https://x/v1/'].entries()) {
      const urls = []
      const assets = createGeneratedAssets(root, { settings: { load: async () => ({ model: { baseUrl, model: 'test', apiKey: 'k' } }) }, request: async (url, options) => {
        urls.push(url)
        assert.equal(options.redirect, 'error')
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ shapes }) } }] }) }
      } })
      await assets.generate({ version: i + 1, doc, style: null })
      assert.equal(urls.length, 1)
      assert.equal(String(urls[0]), 'https://x/v1/chat/completions')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('choices 为空或 content 为 null 时给出友好错误', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-empty-test-'))
  try {
    const doc = { assets: [{ id: 'a', name: '书', type: 'prop', description: '书本', sections: ['B01'] }] }
    for (const [i, data] of [{ choices: [] }, { choices: [{ message: { content: null } }] }, {}].entries()) {
      const assets = createGeneratedAssets(root, { settings: { load: async () => ({ model: { baseUrl: 'http://localhost:1234', model: 'test' } }) }, request: async () => ({ ok: true, json: async () => data }) })
      await assert.rejects(assets.generate({ version: i + 1, doc, style: null }), /模型未返回文本内容/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
