import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSettings, resolveAgent } from '../lib/settings.js'
import { defaultProcessGuidance } from '../lib/process-guidance.js'

test('云端自定义 TTS 独立于 MiMo，不带入茉莉音色', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-custom-tts-'))
  const oldModel = process.env.BOHACK_CLOUD_MODEL
  const oldKey = process.env.BOHACK_CLOUD_KEY
  const oldBase = process.env.BOHACK_CLOUD_BASE_URL
  process.env.BOHACK_CLOUD_MODEL = 'terra-test'
  process.env.BOHACK_CLOUD_BASE_URL = 'https://terra.example/v1'
  process.env.BOHACK_CLOUD_KEY = 'text-key'
  try {
    const settings = createSettings(root, {temporaryKeys:new Map()})
    await settings.update({tts:{provider:'custom',baseUrl:'https://speech.example/v1',model:'custom-tts',voice:'voice-7',protocol:'speech',apiKey:'speech-key',useTextKey:false}})
    const loaded = await settings.load()
    assert.equal(loaded.tts.voice,'voice-7')
    assert.equal(loaded.tts.model,'custom-tts')
    assert.equal(loaded.tts.protocol,'speech')
    assert.equal(loaded.tts.apiKey,'speech-key')
    assert.equal(loaded.model.apiKey,'text-key')
    await settings.update({tts:{voice:''}})
    assert.equal((await settings.load()).tts.voice,'')
    await assert.rejects(settings.update({tts:{baseUrl:'http://127.0.0.1:3000'}}),/HTTPS/)
  } finally {
    if (oldModel === undefined) delete process.env.BOHACK_CLOUD_MODEL
    else process.env.BOHACK_CLOUD_MODEL = oldModel
    if (oldKey === undefined) delete process.env.BOHACK_CLOUD_KEY
    else process.env.BOHACK_CLOUD_KEY = oldKey
    if (oldBase === undefined) delete process.env.BOHACK_CLOUD_BASE_URL
    else process.env.BOHACK_CLOUD_BASE_URL = oldBase
    await rm(root,{recursive:true,force:true})
  }
})

test('云端更换服务商时解除旧配音共用并允许单独填写密钥', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-cloud-migrate-'))
  const names = ['BOHACK_CLOUD_MODEL', 'BOHACK_CLOUD_BASE_URL', 'BOHACK_CLOUD_KEY']
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { BOHACK_CLOUD_MODEL: 'terra-test', BOHACK_CLOUD_BASE_URL: 'https://terra.example/v1', BOHACK_CLOUD_KEY: 'new-text-key' })
  try {
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({
      model: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'old-model', apiKey: 'old-text-key' },
      tts: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'old-tts', voice: '旧音色', useTextKey: true, apiKey: 'old-text-key' },
    }))
    const settings = createSettings(root, { temporaryKeys: new Map([['model', 'old-text-key'], ['tts', 'old-text-key']]) })
    const visible = await settings.get()
    assert.equal(visible.tts.useTextKey, false)
    assert.equal(visible.tts.hasApiKey, false)
    assert.equal(visible.tts.model, 'old-tts')
    assert.equal(visible.tts.voice, '旧音色')
    assert.equal((await settings.load()).tts.apiKey, undefined)
    await assert.rejects(settings.update({ tts: { useTextKey: true } }), /同一服务商/)
    await settings.update({ tts: { apiKey: 'new-tts-key' } })
    const loaded = await settings.load()
    assert.equal(loaded.tts.apiKey, 'new-tts-key')
    assert.equal(loaded.tts.model, 'old-tts')
    assert.equal(loaded.tts.voice, '旧音色')
    assert.equal(loaded.model.apiKey, 'new-text-key')
    assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).tts.useTextKey, false)
  } finally {
    for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]
    await rm(root, { recursive: true, force: true })
  }
})

test('配音共用通用 Key，随通用 Key 更新和清除且不重复保存', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-shared-'))
  try {
    const keys = new Map()
    const settings = createSettings(root, {temporaryKeys:keys})
    await settings.update({model:{baseUrl:'https://provider.test/v1',model:'text',apiKey:'first-key'},tts:{baseUrl:'https://provider.test/v1/chat/completions',model:'voice',useTextKey:true}})
    assert.equal((await settings.load()).tts.apiKey,'first-key')
    assert.equal(keys.has('tts'),false)
    await settings.update({model:{apiKey:'second-key'}})
    assert.equal((await settings.load()).tts.apiKey,'second-key')
    const saved = JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'))
    assert.equal(saved.tts.useTextKey,true)
    assert.equal(saved.tts.apiKey,undefined)
    await settings.update({model:{clearApiKey:true}})
    assert.equal((await settings.get()).tts.hasApiKey,false)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('不同服务商不能共用 Key，取消共用时不复制通用 Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-shared-origin-'))
  try {
    const settings = createSettings(root)
    await settings.update({model:{baseUrl:'https://provider.test/v1',model:'text',apiKey:'text-key'},tts:{baseUrl:'https://provider.test/v1',model:'voice',useTextKey:true}})
    await assert.rejects(settings.update({tts:{baseUrl:'https://other.test/v1',useTextKey:true}}),/同一服务商/)
    assert.equal((await settings.load()).tts.apiKey,'text-key')
    await settings.update({tts:{useTextKey:false}})
    assert.equal((await settings.get()).tts.hasApiKey,false)
    await settings.update({tts:{baseUrl:'https://other.test/v1',apiKey:'independent-key',useTextKey:false}})
    await settings.update({model:{apiKey:'updated-text-key'}})
    assert.equal((await settings.load()).tts.apiKey,'independent-key')
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('temporary keys are shared only with the same session and never written to settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-temporary-'))
  try {
    const keys = new Map()
    const settings = createSettings(root, { temporaryKeys: keys })
    const engineSettings = createSettings(root, { temporaryKeys: keys })
    await settings.update({ model: { baseUrl: 'https://example.test', model: 'one', apiKey: 'session-secret' } })
    assert.equal((await engineSettings.load()).model.apiKey, 'session-secret')
    assert.equal((await readFile(path.join(root, 'settings.json'), 'utf8')).includes('session-secret'), false)
    assert.equal((await createSettings(root, { temporaryKeys: new Map() }).get()).model.hasApiKey, false)
    await settings.update({ model: { baseUrl: 'https://other.test' } })
    assert.equal((await engineSettings.load()).model.apiKey, '')
    await settings.update({ model: { apiKey: 'second-secret' } })
    await settings.update({ model: { clearApiKey: true } })
    assert.equal((await engineSettings.get()).model.hasApiKey, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

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


test('云端通用模型与小米配音密钥独立，路由和端点固定', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-cloud-general-'))
  const names = ['BOHACK_CLOUD_MODEL', 'BOHACK_CLOUD_BASE_URL', 'BOHACK_CLOUD_KEY', 'BOHACK_CLOUD_REASONING']
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { BOHACK_CLOUD_MODEL: 'terra-test', BOHACK_CLOUD_BASE_URL: 'https://terra.example/v1', BOHACK_CLOUD_KEY: 'terra-fake-key' })
  delete process.env.BOHACK_CLOUD_REASONING
  try {
    const settings = createSettings(root, { temporaryKeys: new Map() })
    const initial = await settings.load()
    assert.deepEqual(initial.model, { baseUrl: 'https://terra.example/v1', model: 'terra-test', apiKey: 'terra-fake-key' })
    assert.equal(initial.tts.baseUrl, 'https://api.xiaomimimo.com/v1')
    assert.equal(initial.tts.model, 'mimo-v2.5-tts')
    assert.equal(initial.tts.voice, '茉莉')
    assert.equal(initial.tts.useTextKey, false)
    for (const role of ['requirementAgent', 'blueprintAgent', 'videoAgent']) {
      assert.deepEqual(resolveAgent(initial, role), { provider: 'cloud-general', model: 'terra-test', reasoningEffort: 'low' })
      assert.deepEqual(initial[role], resolveAgent(initial, role))
    }
    process.env.BOHACK_CLOUD_REASONING = 'high'
    assert.equal(resolveAgent(initial, 'videoAgent').reasoningEffort, 'high')
    await settings.update({ tts: { apiKey: 'xiaomi-fake-key' } })
    assert.equal((await settings.load()).tts.apiKey, 'xiaomi-fake-key')
    const savedWithKeys = await readFile(path.join(root, 'settings.json'), 'utf8')
    assert.equal(savedWithKeys.includes('terra-fake-key'), false)
    assert.equal(savedWithKeys.includes('xiaomi-fake-key'), false)
    await assert.rejects(settings.update({ model: { baseUrl: 'https://other.example/v1' } }), /固定/)
    await assert.rejects(settings.update({ model: { model: 'other' } }), /当前模型/)
    await settings.update({ model: { clearApiKey: true } })
    assert.equal((await settings.load()).model.apiKey, '')
    assert.equal((await settings.load()).tts.apiKey, 'xiaomi-fake-key')
    await settings.update({ model: { apiKey: 'terra-new-fake-key' }, tts: { clearApiKey: true } })
    assert.equal((await settings.load()).model.apiKey, 'terra-new-fake-key')
    assert.equal((await settings.load()).tts.apiKey, '')
    const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
    for (const key of ['terra-fake-key', 'terra-new-fake-key', 'xiaomi-fake-key']) assert.equal(persisted.includes(key), false)
    delete process.env.BOHACK_CLOUD_BASE_URL
    await assert.rejects(settings.load(), /BOHACK_CLOUD_BASE_URL/)
  } finally {
    for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]
    await rm(root, { recursive: true, force: true })
  }
})
