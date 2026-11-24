import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGeneratedAssets, copyAssetPool, readAssetManifest } from '../lib/generated-assets.js'

const doc = { assets: [
  { id: 'hero', name: '商人', type: 'character', description: '古代商人', sections: ['B01'] },
  { id: 'bag', name: '布袋', type: 'prop', description: '货袋', sections: ['B01'] },
] }
const style = { id: 'pixel', name: '像素' }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function fixtureAgent({ dir, assets, priorAssets, feedback }) {
  const results = []
  for (const asset of assets) {
    const previous = priorAssets.find(entry => entry.asset.id === asset.id)
    const oldSource = previous ? await readFile(path.join(previous.root, previous.asset.sourceScript), 'utf8') : ''
    const sourceScript = `assets/src/${asset.id}.js`
    await mkdir(path.join(dir, 'assets/src'), { recursive: true })
    await mkdir(path.join(dir, 'assets/review'), { recursive: true })
    await writeFile(path.join(dir, sourceScript), `${oldSource}${asset.id}:${feedback || 'initial'}\n`)
    const files = []
    for (const variant of asset.id === 'hero' ? ['idle', 'walk'] : ['idle']) {
      const file = { variant, path: `assets/${asset.id}_${variant}.svg`, width: 100, height: 100, transparent: true, preview: `assets/review/${asset.id}_${variant}.png` }
      await writeFile(path.join(dir, file.path), `${asset.id}-${variant}-${feedback || 'initial'}`)
      await writeFile(path.join(dir, file.preview), `preview-${asset.id}-${variant}-${feedback || 'initial'}`)
      files.push(file)
    }
    results.push({ id: asset.id, name: asset.name, type: asset.type, sections: asset.sections, sourceScript, files, usageHint: '可直接使用' })
  }
  return { version: 1, producer: 'code-agent', styleId: style.id, assets: results }
}

test('持久化多变体、预览及源码，单件返工读取上一版且保留其他素材', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-store-'))
  try {
    const store = createGeneratedAssets(root)
    const args = { version: 1, doc, style }
    assert.deepEqual((await store.status(args)).assets.map(item => item.status), ['pending', 'pending'])
    const first = await store.prepare({ ...args, planned: doc.assets, run: fixtureAgent })
    assert.equal(first.pool.length, 2)
    const before = await store.availableFiles(args)
    const hero = before.approved.find(item => item.id === 'hero')
    const bag = before.approved.find(item => item.id === 'bag')
    const bagContents = await readFile(bag.path, 'utf8')
    const state = await store.status(args)
    assert.deepEqual(state.assets.map(item => item.status), ['approved', 'approved'])
    assert.deepEqual(state.assets[0].variants.map(item => item.variant), ['idle', 'walk'])
    assert.equal(await readFile(await store.file({ ...args, id: 'hero', revision: hero.revision, variant: 'walk' }), 'utf8'), 'preview-hero-walk-initial')
    await assert.rejects(store.file({ ...args, id: 'hero', revision: hero.revision, variant: 'missing' }), /变体不存在/)
    let calls = 0
    await store.prepare({ ...args, planned: doc.assets, regenerateAssetId: 'hero', assetFeedback: '红帽子', run: async input => {
      calls++
      assert.deepEqual(input.assets.map(item => item.id), ['hero'])
      assert.deepEqual(input.priorAssets.map(item => item.asset.id), ['hero'])
      assert.equal(input.feedback, '红帽子')
      return fixtureAgent(input)
    } })
    assert.equal(calls, 1)
    const after = await store.availableFiles(args)
    const updated = after.approved.find(item => item.id === 'hero')
    const unchanged = after.approved.find(item => item.id === 'bag')
    assert.notEqual(updated.revision, hero.revision)
    assert.equal(unchanged.revision, bag.revision)
    assert.equal(await readFile(unchanged.path, 'utf8'), bagContents)
    assert.equal(await readFile(path.join(updated.root, updated.asset.sourceScript), 'utf8'), 'hero:initial\nhero:红帽子\n')
    await assert.rejects(store.file({ ...args, id: 'hero', revision: hero.revision }), /过期/)
    const destination = path.join(root, 'delivery')
    const manifest = await copyAssetPool(destination, style, after.approved)
    assert.deepEqual(await readAssetManifest(destination), manifest)
    for (const entry of after.approved) {
      for (const relative of [entry.asset.sourceScript, ...entry.asset.files.flatMap(file => [file.path, file.preview])]) {
        assert.deepEqual(await readFile(path.join(destination, relative)), await readFile(path.join(entry.root, relative)))
      }
    }
    assert.equal((await store.status({ ...args, style: { id: 'other' } })).assets[0].status, 'pending')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('旧状态可只读恢复并纳入素材池，无须旧版生成或确认接口', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-legacy-'))
  try {
    const directory = path.join(root, 'outbox/素材_v1')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'old.svg'), '<svg/>')
    await writeFile(path.join(directory, '状态.json'), JSON.stringify({ entries: { hero: { signature: hash({ assets: [doc.assets[0]], style }), filename: 'old.svg', approved: true } } }))
    const args = { version: 1, doc: { assets: [doc.assets[0]] }, style }
    const store = createGeneratedAssets(root)
    assert.equal((await store.status(args)).assets[0].status, 'approved')
    const { approved, pending } = await store.availableFiles(args)
    assert.equal(pending.length, 0)
    assert.equal(await readFile(await store.file({ ...args, id: 'hero', revision: 'old.svg' }), 'utf8'), '<svg/>')
    const destination = path.join(root, 'delivery')
    const manifest = await copyAssetPool(destination, style, approved)
    assert.equal(manifest.assets[0].files[0].path, 'assets/hero.svg')
    assert.equal(await readFile(path.join(destination, 'assets/hero.svg'), 'utf8'), '<svg/>')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('asset submission preserves frozen DSH arguments and requires viewing the current file', { skip: process.platform !== 'darwin' }, async () => {
  const { runAssetAgentJob } = await import('../lib/asset-agent-job.js')
  const root = await mkdtemp(path.join(os.tmpdir(), 'asset-submit-'))
  try {
    const modules = path.join(root, 'kit/WORK/modules/video')
    const playwright = path.join(modules, 'playwright.cjs')
    const dir = path.join(root, 'job')
    await mkdir(modules, { recursive: true })
    await writeFile(playwright, `module.exports.chromium = { launch: async () => ({
      close: async () => {},
      newContext: async () => ({ route: async () => {}, newPage: async () => ({
        setContent: async () => {}, setViewportSize: async () => {},
        evaluate: async () => ({ width: 32, height: 32, transparent: true }),
        locator: () => ({ screenshot: async () => Buffer.from('preview') }),
      }) }),
    }) }`)
    await writeFile(path.join(modules, 'style.mjs'), `export default { paths: {
      python: '/usr/bin/true', ffmpeg: '/usr/bin/true', ffprobe: '/usr/bin/true',
      edge: '/usr/bin/true', playwright: ${JSON.stringify(playwright)}
    } }`)
    const [hero, bag] = doc.assets
    const events = []
    const result = await runAssetAgentJob({
      dir, repo: root, kit: path.join(root, 'kit'), production: { style, sections: [{ id: 'S01', blueprintId: 'B01' }] }, assets: [hero, bag],
      onProgress: event => events.push(event),
      async runAgent({ tools, preset, submitTool, prompt }) {
        assert.equal(preset, 'bohack-skill-runner')
        assert.equal(submitTool, 'submit_assets')
        assert.match(prompt, /无需 mkdir 或 glob 空目录/)
        assert.ok(prompt.includes(JSON.stringify({ id: hero.id, name: hero.name, type: hero.type, sections: hero.sections })))
        const [view, submit] = tools
        const schema = submit.parameters.properties.manifest.properties.assets.items
        assert.deepEqual(schema.required, ['id', 'files', 'sourceScript', 'usageHint'])
        assert.deepEqual(schema.properties.files.items.required, ['variant', 'path'])
        const file = Object.freeze({ variant: 'idle', path: 'assets/hero.svg' })
        const bagFile = Object.freeze({ variant: 'idle', path: 'assets/bag.svg', width: 11, height: 22, transparent: false })
        const sourceScript = 'assets/src/hero.mjs'
        const bagSource = 'assets/src/bag.js'
        const manifest = Object.freeze({ version: 1, producer: 'code-agent', styleId: style.id, assets: Object.freeze([
          Object.freeze({ id: hero.id, files: Object.freeze([file]), sourceScript, usageHint: '放置在地面线上' }),
          Object.freeze({ id: bag.id, files: Object.freeze([bagFile]), sourceScript: bagSource, usageHint: '' }),
        ]) })
        const withBag = changes => ({ manifest: { ...manifest, assets: [manifest.assets[0], { ...manifest.assets[1], ...changes }] } })
        await writeFile(path.join(dir, sourceScript), 'export {}')
        await assert.rejects(submit.execute(withBag({ name: '错名' })), /bag.*name.*布袋/)
        await assert.rejects(submit.execute(withBag({ type: 'character' })), /bag.*type.*prop/)
        await assert.rejects(submit.execute(withBag({ sections: ['S01'] })), /bag.*sections.*B01/)
        await assert.rejects(submit.execute(withBag({ sourceScript })), /bag 与 hero 共用源码.*assets\/src\/bag.js/)
        await assert.rejects(submit.execute(withBag({ sourceScript: file.path })), /bag.*assets\/src\/bag.js/)
        await writeFile(path.join(dir, bagSource), 'export {}')
        await writeFile(path.join(dir, bagFile.path), '<svg/>')
        await writeFile(path.join(dir, file.path), '<svg/>')
        const args = { file: file.path }
        await view.execute(args)
        await assert.rejects(submit.execute({ manifest }), /素材未查看/)
        view.onImageProjected(args)
        await writeFile(path.join(dir, file.path), '<svg><!--new--></svg>')
        await assert.rejects(submit.execute({ manifest }), /查看后已修改/)
        const stale = { file: file.path }
        await view.execute(stale)
        await writeFile(path.join(dir, file.path), '<svg><!--latest--></svg>')
        const latest = { file: file.path }
        await view.execute(latest)
        view.onImageProjected(stale)
        await assert.rejects(submit.execute({ manifest }), /查看后已修改/)
        view.onImageProjected(latest)
        const bagArgs = { file: bagFile.path }
        await view.execute(bagArgs)
        view.onImageProjected(bagArgs)
        const submitted = await submit.execute(Object.freeze({ manifest }))
        assert.equal(file.preview, undefined)
        return submitted
      },
    })
    assert.equal(result.assets[0].files[0].preview, 'assets/review/hero_idle.png')
    for (const [asset, planned] of [[result.assets[0], hero], [result.assets[1], bag]]) {
      assert.deepEqual([asset.name, asset.type, asset.sections], [planned.name, planned.type, planned.sections])
      const [{ width, height, transparent }] = asset.files
      assert.deepEqual({ width, height, transparent }, { width: 32, height: 32, transparent: true })
    }
    assert.match(events[1].text, /共 2 件素材/)
    assert.ok(events.some(event => /已查 1 个变体.*bag.svg/.test(event.text)))
    assert.equal(events.at(-1).text, '正在校验并提交素材清单…')
    assert.deepEqual(await readAssetManifest(dir), result)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
