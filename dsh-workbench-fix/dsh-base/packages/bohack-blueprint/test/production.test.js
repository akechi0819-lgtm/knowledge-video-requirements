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

test('production status reports per-section artifacts and serves mid-run files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-progress-'))
  try {
    const service = createService({}, { workspace: root })
    await service._internal.ensureDirs()
    const id = '11111111-1111-4111-8111-111111111111'
    const dir = path.join(root, 'production', id)
    await mkdir(path.join(dir, 'scenes'), { recursive: true })
    await mkdir(path.join(dir, 'film', 'clips'), { recursive: true })
    await mkdir(path.join(dir, 'film', 'audio'), { recursive: true })
    await writeFile(path.join(root, 'production', 'status.json'), JSON.stringify({
      id, status: 'running', phase: '配音与渲染', version: 'v1', startedAt: new Date().toISOString(),
    }))
    await writeFile(path.join(dir, 'production.json'), JSON.stringify({
      version: 'v1',
      sections: [
        { id: 'S01', blueprintId: 'B01', title: '第一段', narration: '旁白一', visual: '画面一' },
        { id: 'S02', blueprintId: 'B02', title: '第二段', narration: '旁白二', visual: '画面二' },
      ],
    }))
    await writeFile(path.join(dir, 'scenes', 'S01.html'), '<html>scene</html>')
    await writeFile(path.join(dir, 'film', 'audio', 'S01.mp3'), 'audio')
    const state = await service.production.status()
    assert.equal(state.status, 'interrupted')
    assert.equal(state.sections[0].scene, true)
    assert.equal(state.sections[0].sceneKind, 'html')
    assert.equal(state.sections[0].audio, true)
    assert.equal(state.sections[0].clip, false)
    assert.equal(state.sections[1].scene, false)
    assert.equal(state.artifacts.video, false)
    assert.equal(await readFile(await service.production.file('scene', 'S01'), 'utf8'), '<html>scene</html>')
    assert.equal(await readFile(await service.production.file('audio', 'S01'), 'utf8'), 'audio')
    await assert.rejects(service.production.file('clip', 'S01'), /不可用/)
    await assert.rejects(service.production.file('scene', '../S01'), /不可用/)
    await assert.rejects(service.production.file('video'), /不可用/)
    await writeFile(path.join(dir, 'film', 'mapping.json'), JSON.stringify({
      final_duration_sec: 20,
      final_video_absolute: '/secret/final.mp4',
      segments: [{ id: 'S01', blueprint_id: 'B01', title: '第一段', start_sec: 0, end_sec: 14, duration_sec: 14, narration: '旁白一', clip_absolute: '/secret/S01.mp4' }],
    }))
    await writeFile(path.join(dir, 'film', 'final.mp4'), 'video')
    const later = await service.production.status()
    assert.equal(later.artifacts.video, true)
    assert.equal(later.mapping.duration, 20)
    assert.equal(later.mapping.segments[0].start, 0)
    assert.ok(!JSON.stringify(later.mapping).includes('/secret/'))
    assert.equal(await readFile(await service.production.file('video'), 'utf8'), 'video')
    await assert.rejects(service.production.file('../video'), /不可用/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('chat batch confirmation and production commands preserve finalized state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-confirm-all-'))
  try {
    const service = createService({}, { workspace: root })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:'画面', narration:'旁白', notes:'' })
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
    const engine = { chatTurn: async () => ({ reply:'收到' }) }
    for (const text of ['不要全部确认', '全部确认吗？', '如果全部确认', '全部确认，但不要制作', '四段都确认，开始制作']) {
      await service.chat({ text }, engine)
      assert.deepEqual((await service._internal.getState()).confirmed, {}, text)
    }
    const noModel = { chatTurn: async () => { throw new Error('直接操作不应调用模型') } }
    const confirmation = await service.chat({ text:'全部确认' }, noModel)
    assert.match(confirmation.reply, /已确认并定稿/)
    assert.equal(confirmation.finalized, true)
    assert.equal(confirmation.production, null)
    const before = await service._internal.getState()
    assert.deepEqual(before.confirmed.v1, ['B01','B02'])
    const result = await service.chat({ text:'确认 正式制作吧' }, noModel)
    const after = await service._internal.getState()
    assert.deepEqual(after.finalized, before.finalized)
    assert.equal(after.stage, 'finalized')
    assert.ok(result.production || result.productionError)
    const semantic = await service.chat({ text:'麻烦把它做出来吧' }, { chatTurn: async () => ({ reply:'收到', productionRequested:true }) })
    assert.ok(semantic.production || semantic.productionError)
    assert.notEqual(semantic.productionError?.code, 'CONFIRMATION_REQUIRED')
    for (const text of ['不要正式制作', '正式制作吗？', '如果正式制作']) {
      const denied = await service.chat({ text }, engine)
      assert.equal(denied.production, null)
    }
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('production generates and reuses assets while preserving their review status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-auto-assets-'))
  const kit = path.join(root, 'kit'), workspace = path.join(root, 'ws')
  const old = { ...process.env }, originalFetch = globalThis.fetch
  let calls = 0, release
  const gate = new Promise(resolve => { release = resolve })
  try {
    await mkdir(path.join(kit, 'scripts'), { recursive:true })
    await mkdir(path.join(kit, 'WORK/modules/video'), { recursive:true })
    await writeFile(path.join(kit, 'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; await mkdir(process.argv[5]); await writeFile(process.argv[5]+'/production.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv, out=a[a.indexOf('--out')+1]; await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/verify.mjs'), '')
    Object.assign(process.env, {SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api'})
    globalThis.fetch = async () => { calls++; await gate; return {ok:true,json:async () => ({choices:[{message:{content:JSON.stringify({shapes:Array.from({length:5}, () => ({d:'M0 0 L1 1',fill:'#000000',stroke:'none',width:0}))})}}]})} }
    const service = createService({}, {workspace,videoKitDir:kit})
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const assets = [{id:'A01',name:'船',type:'prop',description:'木船',sections:['B01']}]
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections,assets,meta:{}})
    await service.generate({}, {produce:async () => ({markdown,engine:'test'})})
    await service.confirm({all:true}); await service.finalize()
    let state = await service.production.start()
    assert.equal(state.status, 'running'); assert.equal(state.phase, '生成素材'); assert.equal(state.styleId, 'general')
    assert.equal((await service.production.status()).phase, '生成素材')
    await assert.rejects(service.production.start(), /正在运行/)
    release()
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
    const current = await service.status()
    const args = {version:1,doc:current.doc,style:current.visualStyle.style}
    assert.equal((await service.generatedAssets.status(args)).assets[0].status, 'generated')
    const exported = JSON.parse(await readFile(path.join(workspace, 'production', state.id, 'production.json')))
    assert.equal(exported.sections[0].assets[0].id, 'A01')
    state = await service.production.start()
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error); assert.equal(calls, 1)
    await service.selectVisualStyle({id:'editorial',version:1})
    service.generatedAssets.generate = async () => { throw new Error('素材服务不可用') }
    state = await service.production.start()
    assert.equal(state.styleId, 'editorial')
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'failed'); assert.match(state.error, /素材服务不可用/)
  } finally {
    release(); globalThis.fetch = originalFetch
    for (const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root,{recursive:true,force:true})
  }
})


test('colloquial whole-blueprint commands reach production, but negation does not', async () => {
  const previous = process.env.SCENE_API_KEY
  delete process.env.SCENE_API_KEY
  try {
    for (const text of ['全部确认，开始制作', '都可以，直接做吧', '两段都确认，开始制作']) {
      const root = await mkdtemp(path.join(tmpdir(), 'production-colloquial-'))
      try {
        const service = createService({}, { workspace: root })
        await service._internal.ensureDirs()
        const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:'画面', narration:'旁白', notes:'' })
        await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
        const engine = { chatTurn: async () => ({ reply:'收到' }) }
        const result = await service.chat({ text }, engine)
        assert.equal(result.finalized, true, text)
        assert.ok(result.production || result.productionError, text)
      } finally { await rm(root, { recursive:true, force:true }) }
    }
  } finally { if (previous === undefined) delete process.env.SCENE_API_KEY; else process.env.SCENE_API_KEY = previous }
})

test('a new production reuses only complete scenes with matching inputs and asset bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-scene-reuse-'))
  const kit = path.join(root, 'kit'), workspace = path.join(root, 'ws'), old = {...process.env}
  try {
    await mkdir(path.join(kit, 'scripts'), {recursive:true})
    await mkdir(path.join(kit, 'WORK/modules/video'), {recursive:true})
    await writeFile(path.join(kit, 'scripts/prepare-scenes.mjs'), `import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises'; const a=process.argv, p=JSON.parse(await readFile(a[3])); await mkdir(a[5]); await appendFile(${JSON.stringify(path.join(root,'calls'))},'x'); for(const s of p.sections){s.scene=s.id+'.html'; await writeFile(a[5]+'/'+s.scene,'html'); await writeFile(a[5]+'/'+s.id+'.scene.json','{}')} await writeFile(a[5]+'/production.json',JSON.stringify(p))`)
    await writeFile(path.join(kit, 'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv, out=a[a.indexOf('--out')+1]; await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/verify.mjs'), '')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api'})
    const service = createService({}, {workspace,videoKitDir:kit})
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const assets = [{id:'A01',name:'船',type:'prop',description:'木船',sections:['B01']}]
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections,assets,meta:{}})
    await service.generate({}, {produce:async () => ({markdown,engine:'test'})})
    await service.confirm({all:true}); await service.finalize()
    const source = path.join(root,'asset.svg')
    await writeFile(source,'first')
    service.generatedAssets.generate = async () => ({assets: assets.map(asset => ({...asset,revision:'r1'}))})
    service.generatedAssets.file = async () => source
    async function complete() {
      let state = await service.production.start()
      for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
      assert.equal(state.status,'completed',state.error); return state
    }
    const first = await complete(), second = await complete()
    assert.notEqual(first.id,second.id); assert.equal(second.reusedScenesFrom,first.id)
    assert.equal(await readFile(path.join(root,'calls'),'utf8'),'x')
    await writeFile(source,'changed')
    const changed = await complete()
    assert.equal(changed.reusedScenesFrom,undefined)
    assert.equal(await readFile(path.join(root,'calls'),'utf8'),'xx')
    await rm(path.join(workspace,'production',first.id,'scenes','S01.html'))
    await rm(path.join(workspace,'production',second.id,'scenes','S01.html'))
    await rm(path.join(workspace,'production',changed.id,'scenes','S01.html'))
    const third = await complete()
    assert.equal(third.reusedScenesFrom,undefined)
    assert.equal(await readFile(path.join(root,'calls'),'utf8'),'xxx')
  } finally {
    for (const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root,{recursive:true,force:true})
  }
})
