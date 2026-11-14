import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
test('production requires a current confirmed blueprint and executes the kit contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-'))
  const workspace = path.join(root, 'ws'), kit = path.join(root, 'kit')
  const old = { ...process.env }
  try {
    await mkdir(path.join(kit, 'scripts'), { recursive: true })
    await mkdir(path.join(kit, 'WORK/modules/video'), { recursive: true })
    await writeFile(path.join(kit, 'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; await mkdir(a[5]); await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; const out=a[a.indexOf('--out')+1]; if(a[a.indexOf('--voice')+1]!=='say:Tingting') throw Error('wrong voice'); await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/verify.mjs'), `import {readFile} from 'node:fs/promises'; JSON.parse(await readFile(process.argv[2]))`)
    Object.assign(process.env, { SCENE_API_KEY:'test', SCENE_ENDPOINT:'http://localhost/test', SCENE_MODEL:'test', VIDEO_VOICE:'say:Tingting', VOICE_NAME:'ignored' })
    const service = createService({}, { workspace, videoKitDir: kit })
    await service._internal.ensureDirs()
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    await service.uploadAsset({ name:'火锅餐桌.png', dataBase64:png.toString('base64') })
    await assert.rejects(service.production.start())
    const section = (id, narration) => ({ id, title:id, intent:'讲什么', facts:[], visual:id === 'B01' ? '展示 火锅餐桌.png' : '画面', narration, notes:'' })
    const doc = narration => renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01', narration), section('B02','旁白二')], notes:'', meta:{'版本':'v1'} })
    await writeFile(path.join(workspace, 'outbox/蓝图_v1.md'), doc(''))
    await service.confirm({ all:true }); await service.finalize()
    await assert.rejects(service.production.start(), /缺少旁白：B01/)
    await writeFile(path.join(workspace, 'outbox/蓝图_v1.md'), doc('旁白一'))
    await service.finalize()
    assert.equal((await service.production.start()).status, 'running')
    await assert.rejects(service.production.start(), /正在运行/)
    let state
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
    const bundle = path.join(workspace, 'production', state.id)
    const exported = JSON.parse(await readFile(path.join(bundle, 'production.json')))
    assert.equal(exported.sections[0].image, 'images/S01.png')
    assert.equal(exported.sections[1].image, undefined)
    assert.deepEqual(await readFile(path.join(bundle, exported.sections[0].image)), png)
    assert.equal(await readFile(await service.production.file('video'), 'utf8'), 'video')
    await assert.rejects(service.production.file('../video'), /不可用/)
    await writeFile(path.join(kit, 'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; if(!a.includes('--dsh')) throw Error('missing dsh mode'); await mkdir(a[5]); await writeFile(a[5]+'/production.json','{}')`)
    process.env.SCENE_MODE = 'dsh'
    delete process.env.SCENE_API_KEY
    assert.equal((await service.production.start()).status, 'running')
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
    await writeFile(path.join(kit, 'scripts/hotpot-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; await mkdir(a[5]); await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(workspace, 'hotpot-demo-scene.json'), JSON.stringify({version:1}))
    delete process.env.SCENE_API_KEY
    assert.equal((await service.production.start()).status, 'running')
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
  } finally {
    for (const key of ['SCENE_API_KEY','SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE','VIDEO_VOICE','VOICE_NAME']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root, { recursive:true, force:true })
  }
})

test('chat production requires a direct whole-blueprint approval and preserves real outcome', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-chat-'))
  const previous = process.env.SCENE_API_KEY
  delete process.env.SCENE_API_KEY
  try {
    const service = createService({}, { workspace: root })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:'画面', narration:'旁白', notes:'' })
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
    const engine = { chatTurn: async () => ({ reply:'已提交', productionRequested:true }) }
    for (const text of ['不要确认当前蓝图全部段落并生成视频', '如果确认整份蓝图并开始制作成片会怎样？', '确认当前蓝图全部并制作视频吗？', '确认 v2 蓝图全部段落并制作视频']) {
      const result = await service.chat({ text }, engine)
      assert.ok(result.productionError, text)
      assert.deepEqual((await service._internal.getState()).confirmed, {})
    }
    const result = await service.chat({ text:'确认当前蓝图全部段落，开始制作成片' }, engine)
    assert.match(result.productionError.message, /未配置/)
    assert.match(result.reply, /未启动/)
    const state = await service._internal.getState()
    assert.equal(state.stage,'finalized')
    assert.deepEqual(state.confirmed.v1,['B01','B02'])
  } finally {
    if (previous === undefined) delete process.env.SCENE_API_KEY; else process.env.SCENE_API_KEY = previous
    await rm(root,{recursive:true,force:true})
  }
})

test('image bindings reject missing, ambiguous and outside-workspace assets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-image-'))
  const old = { ...process.env }
  try {
    Object.assign(process.env, { SCENE_API_KEY:'test', SCENE_ENDPOINT:'http://localhost', SCENE_MODEL:'test' })
    const service = createService({}, { workspace: root })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'内容', facts:[], visual:id === 'B01' ? '展示 火锅.png' : '画面', narration:'旁白', notes:'' })
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
    await service.confirm({all:true}); await service.finalize()
    await assert.rejects(service.production.start(), /未在本创作资料中登记/)
    await service.addAsset({name:'火锅.png',type:'image',path:'../outside.png'})
    await assert.rejects(service.production.start(), /不在本创作上传目录/)
    await service.addAsset({name:'火锅.png',type:'image',path:'sources/another.png'})
    await assert.rejects(service.production.start(), /重复文件名/)
  } finally {
    for (const key of ['SCENE_API_KEY','SCENE_ENDPOINT','SCENE_MODEL']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root,{recursive:true,force:true})
  }
})
