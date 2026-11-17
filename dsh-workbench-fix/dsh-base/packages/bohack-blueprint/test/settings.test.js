import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSettings } from '../lib/settings.js'
import { defaultProcessGuidance } from '../lib/process-guidance.js'

test('model secrets remain independent and skill toggles are retired', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-'))
  const settings = createSettings(root)
  await settings.update({ tts: { baseUrl: 'https://example.test/speech', model: 'voice', voice: 'one', apiKey: 'secret' }, image: { apiKey: 'other' } })
  const visible = JSON.stringify(await settings.get())
  assert.equal(visible.includes('secret'), false)
  assert.equal(visible.includes('other'), false)
  assert.equal((await settings.get()).tts.hasApiKey, true)
  await settings.update({ tts: { model: 'new' }, image: { clearApiKey: true } })
  assert.equal((await settings.load()).tts.apiKey, 'secret')
  assert.equal((await settings.get()).image.hasApiKey, false)
  assert.equal((await stat(path.join(root, 'settings.json'))).mode & 0o077, 0)
  await assert.rejects(settings.update({skills:[]}), /无需设置技能开关/)
  assert.equal((await settings.get()).skills, undefined)
})

test('all four methods are applied and frozen regardless of legacy switches', async () => {
  const { createService } = await import('../lib/service.js')
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-blueprint-'))
  await mkdir(root, {recursive:true})
  await writeFile(path.join(root,'settings.json'), JSON.stringify({skills:{'ai-teardown':false,'vibe-knowledge-film':false}}))
  await writeFile(path.join(root,'skill-selection.json'), JSON.stringify({skillId:'unavailable'}))
  const service = createService({}, { workspace: root })
  let received
  const engine = { async chatTurn() { return { reply: '已整理', requirementMarkdown: '# 主题\n测试' } }, async produce(args) { received = args.skill; return { markdown: '# 蓝图：测试\n', engine: 'test' } } }
  await service.chat({ text: '整理需求' }, engine)
  await service.generate({}, engine)
  assert.deepEqual(received, defaultProcessGuidance())
  for (const name of ['拆解与核证','知识讲述','动态设计','直观演示']) assert.match(received.content, new RegExp(name))
  const frozen = JSON.parse(await readFile(path.join(root, 'outbox', '蓝图_v1.技能.json'), 'utf8'))
  assert.deepEqual(frozen, received)
})

test('changing endpoint clears old credentials independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-keys-'))
  const settings = createSettings(root)
  for (const type of ['model', 'tts', 'image']) {
    await settings.update({ [type]: { baseUrl: 'https://first.test', apiKey: 'secret' } })
    await settings.update({ [type]: { baseUrl: 'https://second.test' } })
    assert.equal((await settings.load())[type].apiKey, '')
  }
})

test('an imported design Skill binds to this blueprint and survives library edits', async () => {
  const { createService } = await import('../lib/service.js')
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'design-skill-'))
  const service = createService({}, { workspace })
  const { style } = await service.styles.importStyle({name:'墨线场景',description:'使用墨线表现光影边界',source:{kind:'file',label:'SKILL.md'}})
  await service.styles.chooseBlueprintSkill({id:style.id})
  await service.styles.update({id:style.id,name:'新版',description:'另一个设计'})
  let selected
  const engine = { async chatTurn(){return {reply:'已整理',requirementMarkdown:'# 主题\n日食'}}, async produce(args){ selected=args.skill;return {markdown:'# 蓝图：日食\n',engine:'test'} } }
  await service.chat({text:'整理需求'},engine)
  await service.generate({},engine)
  assert.equal(selected.content,'使用墨线表现光影边界')
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'outbox','蓝图_v1.技能.json'),'utf8')), selected)
})

test('concurrent updates serialize so no field is lost, even across instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-race-'))
  try {
    const a = createSettings(root), b = createSettings(root)
    await Promise.all([
      a.update({ model: { baseUrl: 'https://m.test/v1', apiKey: 'mk', model: 'm1' } }),
      b.update({ tts: { baseUrl: 'https://t.test/v1', apiKey: 'tk', voice: 'v1', protocol: 'speech' } }),
      a.update({ image: { baseUrl: 'https://i.test/v1', apiKey: 'ik', model: 'i1' } }),
      b.update({ model: { model: 'm2' } }),
      a.update({ tts: { voice: 'v2' } }),
      b.update({ image: { model: 'i2' } }),
    ])
    const saved = await a.load()
    assert.equal(saved.model.baseUrl, 'https://m.test/v1')
    assert.equal(saved.model.apiKey, 'mk')
    assert.equal(saved.model.model, 'm2')
    assert.equal(saved.tts.apiKey, 'tk')
    assert.equal(saved.tts.voice, 'v2')
    assert.equal(saved.tts.protocol, 'speech')
    assert.equal(saved.image.apiKey, 'ik')
    assert.equal(saved.image.model, 'i2')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a corrupt settings.json degrades to empty settings while a missing one stays silent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-corrupt-'))
  try {
    const warnings = []
    const settings = createSettings(root, { logger: { warn: (...args) => warnings.push(args.join(' ')) } })
    assert.deepEqual(await settings.load(), {})
    assert.deepEqual(warnings, [], '文件不存在时不应告警')
    await writeFile(path.join(root, 'settings.json'), '{ 坏掉的 JSON')
    assert.deepEqual(await settings.load(), {})
    assert.equal((await settings.get()).model.hasApiKey, false)
    assert.ok(warnings.some(w => w.includes('settings.json')), '坏 JSON 应告警')
    await settings.update({ model: { baseUrl: 'https://m.test/v1', apiKey: 'recovered' } })
    assert.equal((await settings.load()).model.apiKey, 'recovered')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a trailing slash keeps the saved key but a different origin still clears it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-slash-'))
  try {
    const settings = createSettings(root)
    for (const type of ['model', 'tts', 'image']) {
      await settings.update({ [type]: { baseUrl: 'https://api.test/v1/', apiKey: 'secret' } })
      await settings.update({ [type]: { baseUrl: 'https://api.test/v1', model: 'm' } })
      assert.equal((await settings.load())[type].apiKey, 'secret', `${type} 尾斜杠差异不应丢密钥`)
      await settings.update({ [type]: { baseUrl: 'https://api.test/v1///' } })
      assert.equal((await settings.load())[type].apiKey, 'secret')
      await settings.update({ [type]: { baseUrl: 'https://other.test/v1' } })
      assert.equal((await settings.load())[type].apiKey, '', `${type} 换主机仍须清空密钥`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('agent routes and tool models are saved independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-routes-'))
  try {
    const settings = createSettings(root)
    await settings.update({ requirementAgent: { provider: 'provider-a', model: 'a' }, videoAgent: { provider: 'provider-b', model: 'b' }, assetModel: { baseUrl: 'https://asset.example', model: 'draw', apiKey: 'asset-key' }, previewModel: { baseUrl: 'https://preview.example', model: 'preview', apiKey: 'preview-key' } })
    const saved = await settings.load()
    assert.deepEqual(saved.videoAgent, { provider: 'provider-b', model: 'b' })
    assert.equal(saved.assetModel.apiKey, 'asset-key')
    assert.equal(saved.previewModel.apiKey, 'preview-key')
    const publicSettings = await settings.get()
    assert.equal(publicSettings.assetModel.apiKey, undefined)
    assert.equal(publicSettings.assetModel.hasApiKey, true)
    await settings.update({ assetModel: { model: 'draw2' } })
    assert.equal((await settings.load()).assetModel.apiKey, 'asset-key')
  } finally { await rm(root, { recursive: true, force: true }) }
})
