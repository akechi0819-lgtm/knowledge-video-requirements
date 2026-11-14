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
    assert.throws(() => renderAsset([...shapes.slice(0, 4), { ...shapes[4], d: 'M 0 0" onload="evil' }]), /无效/)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('DSH 模式在隔离目录运行并生成素材', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-dsh-test-'))
  const oldMode = process.env.SCENE_MODE, oldPath = process.env.PATH
  try {
    const bin = path.join(root, 'bin'); await mkdir(bin)
    const executable = path.join(bin, 'dsh')
    const shapes = Array.from({ length: 5 }, () => ({ d: 'M 0 0 L 10 10 Z', fill: '#123456', stroke: 'none', width: 1 }))
    await writeFile(executable, `#!/bin/sh\nprintf '%s\n' '${JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: JSON.stringify({ shapes }) })}'\n`)
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
