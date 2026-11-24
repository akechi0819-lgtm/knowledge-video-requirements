import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { createProduction } from '../lib/production.js'
import { renderBlueprint, parseBlueprint } from '../lib/blueprint.js'
import { assignAssetPlan } from '../lib/asset-plan.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('chat diagnoses a model outage and passes the original authorized job ID to production', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-resume-'))
  try {
    const service = createService({}, { workspace:root })
    const previous = { id:'previous-job', membershipAuthorizationId:'authorization', status:'failed', phase:'编写画面', error:'画面模型服务暂时不可用（503），制作已暂停。' }
    const starts = []
    service.production.status = async () => previous
    service.production.start = async ({ jobId }) => {
      starts.push(jobId)
      previous.status = 'running'
      return previous
    }
    const engine = { chatTurn:async () => { throw new Error('制作指令不应依赖聊天模型') } }
    const diagnosis = await service.chat({ text:'制作停在哪一步了？' }, engine)
    assert.match(diagnosis.reply, /编写画面.*画面模型服务暂时不可用（503）.*继续制作.*复用/)
    assert.deepEqual(starts, [])
    assert.match((await service.chat({ text:'请帮我继续制作' }, engine)).reply, /已继续原制作/)
    assert.match((await service.chat({ text:'重试' }, engine)).reply, /仍在运行，无需重复启动/)
    assert.deepEqual(starts, [previous.id])
  } finally { await rm(root, { recursive:true, force:true }) }
})

const naturalRecoveryRequest = '现在一直卡在S07的制作中，你检查一下什么问题？如果有bug的话恢复一下。'

for (const { title, text, status, shouldResume } of [
  { title:'reports the actual phase without restarting a running job', text:naturalRecoveryRequest, status:'running', shouldResume:false },
  { title:'resumes a failed job once using the original job ID', text:naturalRecoveryRequest, status:'failed', shouldResume:true },
  { title:'reports a failed job without resuming on a read-only request', text:'现在一直卡在S07的制作中，你检查一下什么问题？先不要恢复。', status:'failed', shouldResume:false }
]) {
  test(`natural production dialogue ${title}`, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'chat-production-recovery-'))
    try {
      const service = createService({}, { workspace })
      const previous = { id:'original-job', membershipAuthorizationId:'authorization', status, phase:'编写画面', error:status === 'failed' ? '画面制作超时，制作已暂停。' : null }
      const starts = []
      let modelCalls = 0
      let current = previous
      service.production.status = async () => current
      service.production.start = async ({ jobId }) => {
        starts.push(jobId)
        current = { ...previous, status:'running', error:null }
        return current
      }
      const engine = { chatTurn:async () => { modelCalls++; return { reply:'普通聊天回复' } } }

      const result = await service.chat({ text }, engine)
      assert.equal(result.recovery?.previousStatus, status)
      assert.equal(result.recovery?.phase, previous.phase)
      if (shouldResume) {
        assert.match(result.reply, /已继续原制作/)
        assert.equal(result.production?.id, previous.id)
        const repeated = await service.chat({ text }, engine)
        assert.match(repeated.reply, /编写画面/)
        assert.equal(repeated.production, null)
      } else {
        assert.match(result.reply, /编写画面/)
        assert.match(result.reply, status === 'running' ? /仍在运行|正在制作/ : /超时/)
        assert.equal(result.production, null)
      }
      assert.equal(modelCalls, 0)
      assert.deepEqual(starts, shouldResume ? [previous.id] : [])
    } finally { await rm(workspace, { recursive:true, force:true }) }
  })
}

test('default DSH launcher can be executed directly on POSIX', { skip: process.platform === 'win32' }, async () => {
  await access(new URL('../../../dsh.sh', import.meta.url), constants.X_OK)
})

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
    const service = createService({}, {productionMode:"structured",  workspace, videoKitDir: kit })
    await service._internal.ensureDirs()
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    const uploaded = await service.uploadAsset({ name:'火锅餐桌.png', dataBase64:png.toString('base64') })
    await service.updateAsset({ id: uploaded.asset.id, action:'approve' })
    await assert.rejects(service.production.start())
    const section = (id, narration) => ({ id, title:id, intent:'讲什么', facts:[], visual:id === 'B01' ? '展示 火锅餐桌.png' : '画面', narration, notes:'' })
    const doc = narration => renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01', narration), section('B02','旁白二')], notes:'', meta:{'版本':'v1'} })
    await writeFile(path.join(workspace, 'outbox/蓝图_v1.md'), doc(''))
    await service.confirm({ all:true }); await service.finalize()
    await writeFile(path.join(workspace, 'outbox/蓝图_v1.md'), doc('旁白一'))
    await service.finalize()
    assert.equal((await service.production.start()).status, 'running')
    const ongoing = await service.chat({ text:'继续制作' }, { chatTurn: async () => { throw new Error('不应调用模型') } })
    assert.equal(ongoing.recovery.previousStatus, 'running')
    assert.equal(ongoing.production, null)
    assert.match(ongoing.reply, /无需重复启动/)
    await assert.rejects(service.production.start(), /正在运行/)
    let state
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
    const bundle = path.join(workspace, 'production', state.id)
    const exported = JSON.parse(await readFile(path.join(bundle, 'production.json')))
    assert.equal(exported.sections[0].image, undefined)
    assert.equal(exported.sections[1].image, undefined)
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
    const service = createService({}, {productionMode:"structured",  workspace: root })
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

test('production status reports per-section artifacts and serves mid-run files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-progress-'))
  try {
    const service = createService({}, {productionMode:"structured",  workspace: root })
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
    assert.equal(JSON.parse(await readFile(path.join(root, 'production', 'status.json'))).status, 'running')
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

test('status does not overwrite stale running state while a new job starts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-status-race-'))
  let release
  const gate = new Promise(resolve => { release = resolve })
  try {
    await mkdir(path.join(root, 'production'))
    const stateFile = path.join(root, 'production', 'status.json')
    const old = {id:'11111111-1111-4111-8111-111111111111',status:'running'}
    await writeFile(stateFile, JSON.stringify(old))
    const service = createProduction(root, {productionMode:"structured", settings:{load:async () => { await gate; return {} }}})
    const starting = service.start()
    const status = await service.status()
    assert.equal(status.status, 'running')
    assert.deepEqual(JSON.parse(await readFile(stateFile)), old)
    release()
    await assert.rejects(starting)
    assert.equal((await service.status()).status, 'interrupted')
    const finished = {...old,status:'completed'}
    await writeFile(stateFile, JSON.stringify(finished))
    await Promise.all(Array.from({length:30}, () => service.status()))
    assert.deepEqual(JSON.parse(await readFile(stateFile)), finished)
  } finally { release(); await rm(root,{recursive:true,force:true}) }
})


test('chat batch confirmation and production commands preserve finalized state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-confirm-all-'))
  try {
    const service = createService({}, {productionMode:"structured",  workspace: root })
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

test('colloquial whole-blueprint commands reach production, but negation does not', async () => {
  const previous = process.env.SCENE_API_KEY
  delete process.env.SCENE_API_KEY
  try {
    for (const text of ['全部确认，开始制作', '都可以，直接做吧', '两段都确认，开始制作']) {
      const root = await mkdtemp(path.join(tmpdir(), 'production-colloquial-'))
      try {
        const service = createService({}, {productionMode:"structured",  workspace: root })
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
    const service = createService({}, {productionMode:"structured", workspace,videoKitDir:kit})
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const assets = [{id:'A01',name:'船',type:'prop',description:'木船',sections:['B01']}]
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections,assets,meta:{}})
    await service.generate({}, {produce:async () => ({markdown,engine:'test'})})
    await service.confirm({all:true}); await service.finalize()
    const source = path.join(root,'asset.svg')
    await writeFile(source,'first')
    service.generatedAssets.prepare = async ({ planned }) => ({ pool: planned.map(asset => ({...asset, path:source})) })
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
    assert.equal(third.reusedScenesFrom,changed.id)
    assert.deepEqual(third.reusedSceneSections,['S02'])
    assert.equal(await readFile(path.join(root,'calls'),'utf8'),'xxx')
  } finally {
    for (const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root,{recursive:true,force:true})
  }
})

test('无预设的可执行 Skill 切换到 Agent，活动只在当前制作阶段返回', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-direct-skill-'))
  const previousWorkspace = process.env.JIANGJIE_DESKTOP_WORKSPACE
  process.env.JIANGJIE_DESKTOP_WORKSPACE = path.join(root, 'runtime-workspace')
  t.after(() => {
    if (previousWorkspace === undefined) delete process.env.JIANGJIE_DESKTOP_WORKSPACE
    else process.env.JIANGJIE_DESKTOP_WORKSPACE = previousWorkspace
  })
  try {
    const kit = path.join(root, 'kit'), skill = path.join(root, '.agents/skills/new-skill')
    const modules = path.join(kit, 'WORK/modules/video'), playwright = path.join(modules, 'playwright.cjs')
    await mkdir(modules, { recursive:true })
    await mkdir(skill, { recursive:true })
    await writeFile(playwright, `module.exports.chromium = { launch: async () => ({
      close: async () => {}, newContext: async () => ({ route: async () => {}, newPage: async () => ({}) }),
    }) }`)
    await writeFile(path.join(modules, 'style.mjs'), `export default ${JSON.stringify({ paths: {
      python: process.execPath, ffmpeg: '/usr/bin/true', ffprobe: '/usr/bin/true', edge: '/usr/bin/true', playwright,
    }, tts: { voice: 'fake', rate: '+0%' }, video: { fps: 30 }, timing: { leadIn: 0, tailPad: 0 } })}`)
    await writeFile(path.join(modules, 'pipeline.mjs'), 'export const preparedFrames = ds => ds.map(d => d * 30); export function seedTtsCache() {}')
    await writeFile(path.join(modules, 'isolated-page.mjs'), 'export function installSceneRoutes() {}')
    await writeFile(path.join(modules, 'tts_driver.py'), `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(process.argv[2])); fs.writeFileSync(process.argv[7], JSON.stringify({ segments: input.segments.map(s => ({ id: s.id, duration: 1 })) }));`)
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: new-skill\ndescription: 测试风格\n---\n原版流程')
    const stateFile = path.join(root, 'production/status.json')
    let assetState, videoState, diskDuringAsset, videoGuard
    const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
      const tools = new Map(), listeners = new Map()
      await setup({ tools: { register: tool => tools.set(tool.name, tool), guard: guard => { videoGuard = guard }, view: () => ({ restrictableNames: [] }), restrict() {} }, on: (name, listener) => listeners.set(name, listener) })
      return { agent: { followup: async () => {
        if (tools.has('submit_assets')) {
          assetState = await service.production.status()
          diskDuringAsset = JSON.parse(await readFile(stateFile, 'utf8'))
          await tools.get('submit_assets').execute({ manifest: { version: 1, producer: 'code-agent', styleId: 'repo-skill:new-skill', assets: [] } })
        } else {
          videoState = await service.production.status()
          throw new Error('测试停止制作')
        }
      } } }
    } } }
    const service = createService(ctx, { productionMode:'structured', workspace:root, styleLibraryRoot:root, videoKitDir:kit })
    await service._internal.ensureDirs()
    const section = { id:'B01', title:'开头', intent:'介绍', facts:[], visual:'画面', narration:'', notes:'' }
    await writeFile(path.join(root, 'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', userRequirements:[], sections:[section, { ...section, id:'B02', title:'结尾' }], assets:[], meta:{'版本':'v1'} }))
    await service.confirm({ all:true }); await service.finalize()
    await service.selectVisualStyle({ id:'repo-skill:new-skill', version:1 })
    let input
    const prepare = service.generatedAssets.prepare
    service.generatedAssets.prepare = async options => { input = options; return prepare(options) }
    const started = await service.production.start({ mode:'structured' })
    assert.equal(started.mode, 'agent')
    let state
    for (let i = 0; i < 100; i++) { state = await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'failed')
    assert.match(JSON.parse(await readFile(stateFile, 'utf8')).error, /测试停止制作/)
    assert.equal(assetState.activity, '正在加载风格规范并规划素材…')
    assert.equal(diskDuringAsset.phase, assetState.phase)
    assert.equal(Object.hasOwn(diskDuringAsset, 'activity'), false)
    assert.equal(videoState.phase, '正在制作视频')
    assert.equal(Object.hasOwn(videoState, 'activity'), false)
    assert.match(videoGuard({ name: 'bash' }), /未允许使用/)
    assert.equal(Object.hasOwn(state, 'activity'), false)
    assert.equal(input.auto, true)
    assert.deepEqual(input.planned, [])
    assert.equal(typeof input.run, 'function')
    assert.equal(input.doc.style.id, 'repo-skill:new-skill')
  } finally { await rm(root, { recursive:true, force:true }) }
})

test('restyle asks when unspecified and applies the next named choice without reconfirmation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-restyle-'))
  const previous = process.env.SCENE_API_KEY
  delete process.env.SCENE_API_KEY
  try {
    const service = createService({}, {productionMode:"structured", multiuser:true, workspace: root })
    service.production.start = async () => ({ status: 'running' })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:'画面', narration:'旁白', notes:'' })
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
    await service.finalize({ all:true, version:1 })
    const before = await service._internal.getState()
    const engine = { chatTurn: async () => { throw new Error('不应调用模型') } }
    const request = await service.chat({ text:'修改画风重绘' }, engine)
    assert.equal(request.chooseRestyle, true)
    assert.deepEqual((await service.status()).pendingRestyle, { version:1 })
    const choice = await service.chat({ text:'白板手绘' }, engine)
    assert.equal(choice.chooseRestyle, false)
    assert.ok(choice.production || choice.productionError)
    assert.equal((await service.status()).visualStyle.style?.id, 'huashu-whiteboard', JSON.stringify(choice))
    assert.equal((await service.status()).pendingRestyle, null)
    assert.deepEqual((await service._internal.getState()).finalized, before.finalized)
    const pixel = await service.chat({ text:'换成像素画风重新做' }, engine)
    assert.ok(pixel.production || pixel.productionError)
    assert.equal((await service.status()).visualStyle.style.id, 'andy-pixel-quest')
    assert.deepEqual((await service._internal.getState()).finalized, before.finalized)
    const quoted = await service.chat({ text:'换成「白板手绘：关系逐步展开」重新制作' }, engine)
    assert.ok(quoted.production || quoted.productionError)
    assert.equal((await service.status()).visualStyle.style.id, 'huashu-whiteboard')
    for (const [text, id] of [['这版重新画一遍，用像素风', 'andy-pixel-quest'], ['用白板手绘重做', 'huashu-whiteboard'], ['换成白板手绘', 'huashu-whiteboard']]) {
      const changed = await service.chat({ text }, engine)
      assert.ok(changed.production || changed.productionError, text)
      assert.equal((await service.status()).visualStyle.style.id, id, text)
    }
    await service.styles.importStyle({ name:'白板手绘新版本', description:'另一种白板风格', source:{ kind:'text', label:'测试' } })
    const fullName = await service.chat({ text:'换成「白板手绘：关系逐步展开」重新制作' }, engine)
    assert.ok(fullName.production || fullName.productionError)
    assert.equal((await service.status()).visualStyle.style.id, 'huashu-whiteboard')
    const byId = await service.chat({ text:'换成 huashu-whiteboard 重新制作' }, engine)
    assert.ok(byId.production || byId.productionError)
    assert.equal((await service.status()).visualStyle.style.id, 'huashu-whiteboard')
    for (const text of ['算了', '取消重绘']) {
      await service.chat({ text:'修改画风重绘' }, engine)
      const cancelled = await service.chat({ text }, engine)
      assert.match(cancelled.reply, /已取消重绘/)
      assert.equal((await service.status()).pendingRestyle, null)
      assert.equal(cancelled.production, null)
    }
    await service.chat({ text:'修改画风重绘' }, engine)
    const semanticEngine = { chatTurn: async () => ({ reply:'收到', productionRequested:true }) }
    for (const text of ['不要用白板手绘重做', '换成像素风好吗？', '取消重绘吧？']) {
      const denied = await service.chat({ text }, semanticEngine)
      assert.equal(denied.production, null, text)
      assert.equal((await service.status()).visualStyle.style.id, 'huashu-whiteboard', text)
    }
  } finally {
    if (previous === undefined) delete process.env.SCENE_API_KEY; else process.env.SCENE_API_KEY = previous
    await rm(root, {recursive:true, force:true})
  }
})

test('redrawing passes audio only from a completed job with identical narration', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'production-audio-reuse-'))
  const kit = path.join(root,'kit'), workspace = path.join(root,'ws'), old = {...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,readFile,writeFile} from 'node:fs/promises'; const a=process.argv,p=JSON.parse(await readFile(a[3])); await mkdir(a[5]); for(const s of p.sections){s.scene=s.id+'.html';await writeFile(a[5]+'/'+s.scene,'html');await writeFile(a[5]+'/'+s.id+'.scene.json','{}')} await writeFile(a[5]+'/production.json',JSON.stringify(p))`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises'; const a=process.argv,out=a[a.indexOf('--out')+1],p=JSON.parse(await readFile(a[3])); await appendFile(${JSON.stringify(path.join(root,'sources'))},(process.env.VIDEO_TTS_CACHE_DIR||'none')+'\\n'); await mkdir(out); await mkdir(out+'/audio'); for(const s of p.sections){await writeFile(out+'/audio/'+s.id+'.mp3','audio');await writeFile(out+'/audio/'+s.id+'.json',JSON.stringify({id:s.id,narration:s.narration}))} await writeFile(out+'/final.mp4','video');await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api'})
    const service = createService({}, {productionMode:"structured", workspace,videoKitDir:kit}); await service._internal.ensureDirs()
    await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    const engine = {produce:async () => ({markdown,engine:'test'})}
    await service.generate({},engine); await service.confirm({all:true}); await service.finalize()
    async function complete() { let state=await service.production.start(); for(let i=0;i<100;i++){state=await service.production.status();if(state.status!=='running')break;await sleep(20)} assert.equal(state.status,'completed',state.error);return state }
    const first = await complete()
    await service.selectVisualStyle({id:'editorial',version:1}); await complete()
    let sources=(await readFile(path.join(root,'sources'),'utf8')).trim().split('\n')
    assert.equal(sources[0],'none'); assert.equal(sources[1],path.join(workspace,'production',first.id,'film','audio'))
    await service.manualEdit({section:'B01',fields:{narration:'修改旁白'}},engine); await service.confirm({all:true}); await service.finalize(); await complete()
    sources=(await readFile(path.join(root,'sources'),'utf8')).trim().split('\n'); assert.equal(sources[2],'none')
  } finally { for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']) {if(old[key]===undefined) delete process.env[key]; else process.env[key]=old[key]} await rm(root,{recursive:true,force:true}) }
})

test('failed scene production reuses matching completed sections only', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'partial-scenes-')), kit=path.join(root,'kit'), workspace=path.join(root,'ws'), old={...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,readFile,writeFile,appendFile,copyFile} from 'node:fs/promises'; const a=process.argv,p=JSON.parse(await readFile(a[3])),seed=process.env.VIDEO_SCENE_REUSE_DIR; await mkdir(a[5]); for(const s of p.sections){s.scene=s.id+'.html'; try{await copyFile(seed+'/'+s.scene,a[5]+'/'+s.scene);await copyFile(seed+'/'+s.id+'.scene.json',a[5]+'/'+s.id+'.scene.json');continue}catch{} await appendFile(${JSON.stringify(path.join(root,'calls'))},s.id+'\\n'); if(s.id==='S03'&&!seed)process.exit(1); await writeFile(a[5]+'/'+s.scene,'html');await writeFile(a[5]+'/'+s.id+'.scene.json','{}')} await writeFile(a[5]+'/production.json',JSON.stringify(p))`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises';const a=process.argv,out=a[a.indexOf('--out')+1];await mkdir(out);await writeFile(out+'/final.mp4','x');await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api'})
    const service=createService({}, {productionMode:"structured", workspace,videoKitDir:kit}); await service._internal.ensureDirs(); await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections=['B01','B02','B03'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown=renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    await service.generate({}, {produce:async()=>({markdown,engine:'test'})});await service.confirm({all:true});await service.finalize()
    async function run(){let s=await service.production.start();for(let i=0;i<100;i++){s=await service.production.status();if(s.status!=='running')break;await sleep(20)}return s}
    const first=await run();assert.equal(first.status,'failed')
    const second=await run();assert.equal(second.status,'completed',second.error);assert.equal(second.reusedScenesFrom,first.id);assert.deepEqual(second.reusedSceneSections,['S01','S02'])
    assert.deepEqual((await readFile(path.join(root,'calls'),'utf8')).trim().split('\n'),['S01','S02','S03','S03'])
    await service.selectVisualStyle({id:'editorial',version:1})
    const changed=await run();assert.equal(changed.status,'failed');assert.equal(changed.reusedScenesFrom,undefined)
  } finally {for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}await rm(root,{recursive:true,force:true})}
})

test('reusableAudio skips corrupt and null completed.json without throwing', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'production-audio-corrupt-'))
  const kit = path.join(root,'kit'), workspace = path.join(root,'ws'), old = {...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,readFile,writeFile} from 'node:fs/promises'; const a=process.argv,p=JSON.parse(await readFile(a[3])); await mkdir(a[5]); for(const s of p.sections){s.scene=s.id+'.html';await writeFile(a[5]+'/'+s.scene,'html');await writeFile(a[5]+'/'+s.id+'.scene.json','{}')} await writeFile(a[5]+'/production.json',JSON.stringify(p))`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile,readFile,appendFile} from 'node:fs/promises'; const a=process.argv,out=a[a.indexOf('--out')+1],p=JSON.parse(await readFile(a[3])); await appendFile(${JSON.stringify(path.join(root,'sources'))},(process.env.VIDEO_TTS_CACHE_DIR||'none')+'\\n'); await mkdir(out); await mkdir(out+'/audio'); for(const s of p.sections){await writeFile(out+'/audio/'+s.id+'.mp3','audio');await writeFile(out+'/audio/'+s.id+'.json',JSON.stringify({id:s.id,narration:s.narration}))} await writeFile(out+'/final.mp4','video');await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api',SCENE_API_KEY:'test'})
    const service=createService({}, {productionMode:'structured',workspace,videoKitDir:kit}); await service._internal.ensureDirs()
    await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections=['B01','B02'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown=renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    await service.generate({},{produce:async()=>({markdown,engine:'test'})}); await service.confirm({all:true}); await service.finalize()
    async function complete(){let s=await service.production.start();for(let i=0;i<100;i++){s=await service.production.status();if(s.status!=='running')break;await sleep(20)}assert.equal(s.status,'completed',s.error);return s}
    const first=await complete()
    const badDir=path.join(workspace,'production','22222222-2222-4222-8222-222222222222')
    await mkdir(badDir,{recursive:true}); await writeFile(path.join(badDir,'completed.json'),'{broken json')
    const nullDir=path.join(workspace,'production','33333333-3333-4333-8333-333333333333')
    await mkdir(nullDir,{recursive:true}); await writeFile(path.join(nullDir,'completed.json'),'null')
    await complete()
    const sources=(await readFile(path.join(root,'sources'),'utf8')).trim().split('\n')
    assert.equal(sources[0],'none')
    assert.equal(sources[1],path.join(workspace,'production',first.id,'film','audio'))
  } finally {for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE','SCENE_API_KEY']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}await rm(root,{recursive:true,force:true})}
})

test('production normalizes scene and tts endpoints idempotently by protocol', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'production-endpoint-'))
  const kit=path.join(root,'kit'), workspace=path.join(root,'ws'), old={...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile,appendFile} from 'node:fs/promises'; const a=process.argv; await mkdir(a[5]); await appendFile(${JSON.stringify(path.join(root,'scene-endpoints'))},a[a.indexOf('--endpoint')+1]+'\\n'); await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile,appendFile} from 'node:fs/promises'; const a=process.argv,out=a[a.indexOf('--out')+1]; await appendFile(${JSON.stringify(path.join(root,'tts-endpoints'))},(process.env.VIDEO_TTS_ENDPOINT||'none')+' '+(process.env.VIDEO_TTS_PROTOCOL||'none')+'\\n'); await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/v1/',SCENE_MODEL:'test',SCENE_MODE:'api',SCENE_API_KEY:'test'})
    const service=createService({}, {productionMode:'structured',workspace,videoKitDir:kit}); await service._internal.ensureDirs()
    await writeFile(path.join(workspace,'settings.json'),JSON.stringify({tts:{baseUrl:'http://localhost/tts/',model:'m',voice:'茉莉',protocol:'speech',apiKey:'k'}}))
    await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections=['B01','B02'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown=renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    await service.generate({},{produce:async()=>({markdown,engine:'test'})}); await service.confirm({all:true}); await service.finalize()
    async function complete(){let s=await service.production.start();for(let i=0;i<100;i++){s=await service.production.status();if(s.status!=='running')break;await sleep(20)}assert.equal(s.status,'completed',s.error);return s}
    await complete()
    assert.equal((await readFile(path.join(root,'scene-endpoints'),'utf8')).trim(),'http://localhost/v1/chat/completions')
    assert.equal((await readFile(path.join(root,'tts-endpoints'),'utf8')).trim(),'http://localhost/tts/audio/speech speech')
    await writeFile(path.join(workspace,'settings.json'),JSON.stringify({tts:{baseUrl:'http://localhost/tts/chat/completions/',model:'m',voice:'茉莉',protocol:'mimo',apiKey:'k'}}))
    process.env.SCENE_ENDPOINT='http://localhost/v1/chat/completions'
    await service.selectVisualStyle({id:'editorial',version:1})
    await complete()
    assert.equal((await readFile(path.join(root,'scene-endpoints'),'utf8')).trim().split('\n')[1],'http://localhost/v1/chat/completions')
    assert.equal((await readFile(path.join(root,'tts-endpoints'),'utf8')).trim().split('\n')[1],'http://localhost/tts/chat/completions mimo')
  } finally {for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE','SCENE_API_KEY']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}await rm(root,{recursive:true,force:true})}
})

test('prepare-scenes subprocess gets default DSH_CLI and honors env override', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'production-dsh-cli-'))
  const kit=path.join(root,'kit'), workspace=path.join(root,'ws'), old={...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile,appendFile} from 'node:fs/promises'; const a=process.argv; if(!a.includes('--dsh')) throw Error('missing dsh mode'); await mkdir(a[5]); await appendFile(${JSON.stringify(path.join(root,'dsh-cli'))},(process.env.DSH_CLI||'none')+'\\n'); await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv,out=a[a.indexOf('--out')+1]; await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_MODE:'dsh'})
    delete process.env.DSH_CLI
    const service=createService({}, {productionMode:'structured',workspace,videoKitDir:kit}); await service._internal.ensureDirs()
    await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections=['B01','B02'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown=renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    await service.generate({},{produce:async()=>({markdown,engine:'test'})}); await service.confirm({all:true}); await service.finalize()
    async function complete(){let s=await service.production.start();for(let i=0;i<100;i++){s=await service.production.status();if(s.status!=='running')break;await sleep(20)}assert.equal(s.status,'completed',s.error);return s}
    await complete()
    const expected=path.join(path.resolve(kit,'..','dsh-workbench-fix','dsh-base'),process.platform==='win32'?'dsh.cmd':'dsh.sh')
    assert.equal((await readFile(path.join(root,'dsh-cli'),'utf8')).trim(),expected)
    process.env.DSH_CLI='custom-cli'
    await service.selectVisualStyle({id:'editorial',version:1})
    await complete()
    assert.equal((await readFile(path.join(root,'dsh-cli'),'utf8')).trim().split('\n')[1],'custom-cli')
  } finally {for(const key of ['SCENE_MODE','DSH_CLI']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}await rm(root,{recursive:true,force:true})}
})

test('run watchdog terminates a hung production and allows restarting', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'production-timeout-'))
  const kit=path.join(root,'kit'), workspace=path.join(root,'ws'), old={...process.env}
  try {
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `setTimeout(()=>{},1000000);await new Promise(()=>{})`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv,out=a[a.indexOf('--out')+1]; await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api',SCENE_API_KEY:'test',VIDEO_PRODUCTION_TIMEOUT_MS:'500'})
    const service=createService({}, {productionMode:'structured',workspace,videoKitDir:kit}); await service._internal.ensureDirs()
    await writeFile(path.join(workspace,'inbox/需求.md'),'# 主题\n潮汐\n')
    const sections=['B01','B02'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const markdown=renderBlueprint({topic:'潮汐',userRequirements:[],sections,meta:{}})
    await service.generate({},{produce:async()=>({markdown,engine:'test'})}); await service.confirm({all:true}); await service.finalize()
    let state=await service.production.start()
    for(let i=0;i<200;i++){state=await service.production.status();if(state.status!=='running')break;await sleep(20)}
    assert.equal(state.status,'failed'); assert.match(state.error,/制作超时/)
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; await mkdir(a[5]); await writeFile(a[5]+'/production.json','{}')`)
    delete process.env.VIDEO_PRODUCTION_TIMEOUT_MS
    let again=await service.production.start(); assert.equal(again.status,'running')
    for(let i=0;i<100;i++){again=await service.production.status();if(again.status!=='running')break;await sleep(20)}
    assert.equal(again.status,'completed',again.error)
  } finally {for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE','SCENE_API_KEY','VIDEO_PRODUCTION_TIMEOUT_MS']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}await rm(root,{recursive:true,force:true})}
})

test('chat diagnoses and resumes failed work without rerunning completed work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-recovery-'))
  const previous = process.env.SCENE_API_KEY
  delete process.env.SCENE_API_KEY
  try {
    const service = createService({}, {productionMode:"structured",  workspace: root })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:id === 'B01' ? '展示 原图.png' : '画面', narration:'旁白', notes:'' })
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], notes:'', meta:{'版本':'v1'} }))
    await service.finalize({ all:true, version:1 })
    const finalized = (await service._internal.getState()).finalized
    await mkdir(path.join(root,'production'), {recursive:true})
    const statusPath = path.join(root,'production/status.json')
    const state = { id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status:'failed', phase:'生成画面', error:'400: {"message":"fetch failed"}\n    at internal.js:10\nsecret stack', version:'v1' }
    await writeFile(statusPath, JSON.stringify(state))
    const engine = { chatTurn: async () => { throw new Error('直接操作不应调用模型') } }
    const diagnostic = await service.chat({ text:'制作停在哪一步了？' }, engine)
    assert.match(diagnostic.reply, /生成画面.*画面模型连接失败/)
    assert.doesNotMatch(diagnostic.reply, /400|fetch failed|internal.js|secret stack/)
    assert.match(diagnostic.reply, /继续制作/)
    for (const text of ['继续制作','恢复制作','接着做','重试','请帮我继续制作','帮我重试制作']) {
      const result = await service.chat({ text }, engine)
      assert.equal(result.recovery.previousStatus, 'failed')
      assert.equal(result.recovery.phase, '生成画面')
      assert.match(result.recovery.error, /画面模型连接失败/)
      assert.ok(result.production || result.productionError)
      assert.deepEqual((await service._internal.getState()).finalized, finalized)
    }
    await writeFile(statusPath, JSON.stringify({...state, status:'running', phase:'配音与渲染', error:null}))
    const interrupted = await service.chat({ text:'恢复制作' }, engine)
    assert.equal(interrupted.recovery.previousStatus, 'interrupted')
    assert.equal(interrupted.recovery.phase, '配音与渲染')
    assert.ok(interrupted.production || interrupted.productionError)
    await writeFile(statusPath, JSON.stringify({...state, status:'completed', phase:'制作完成', error:null}))
    const done = await service.chat({ text:'继续制作' }, engine)
    assert.match(done.reply, /成片已完成/)
    assert.equal(done.production, null)
    assert.equal(JSON.parse(await readFile(statusPath,'utf8')).id, state.id)
    await service.addAsset({name:'旧资料.pdf', type:'file', path:'sources/旧资料.pdf'})
    const noMissingWork = await service.chat({text:'把缺失的素材补齐，继续制作'}, engine)
    assert.equal(noMissingWork.production, null)
    assert.match(noMissingWork.reply, /没有需要补齐的生成素材/)
    const missingImage = await service.addAsset({name:'原图.png', type:'image', path:'sources/原图.png',trust:'vetted'})
    await service.assignAsset({id:missingImage.asset.id, version:1, sections:['B01']})
    const missing = await service.chat({ text:'哪些素材丢了？' }, engine)
    assert.deepEqual(missing.assetDiagnosis.missingReferences, ['旧资料.pdf', '原图.png'])
    assert.match(missing.reply, /请重新上传/)
    const repair = await service.chat({ text:'把缺失的素材补齐，继续制作' }, engine)
    assert.equal(repair.production, null)
    assert.match(repair.reply, /请重新上传/)
    const replacement=await service.uploadAsset({name:'原图.png',dataBase64:Buffer.from('image').toString('base64')})
    await service.updateAsset({id:replacement.asset.id,action:'approve'})
    await service.assignAsset({id:missingImage.asset.id,version:1,sections:[]})
    await service.assignAsset({id:replacement.asset.id,version:1,sections:['B01']})
    const replaced = await service.chat({text:'把缺失的素材补齐，继续制作'}, engine)
    assert.deepEqual(replaced.assetDiagnosis.missingRequiredImages, [])
    assert.match(replaced.reply, /没有需要补齐的生成素材/)
  } finally {
    if (previous === undefined) delete process.env.SCENE_API_KEY; else process.env.SCENE_API_KEY = previous
    await rm(root,{recursive:true, force:true})
  }
})

test('chat regenerates only the named asset and rejects uncertain requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-asset-retry-'))
  try {
    const service = createService({}, {productionMode:"structured", workspace:root})
    await service._internal.ensureDirs()
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
    const assets = [{id:'A01',name:'硝石晶体',type:'prop',description:'晶体',sections:['B01']}]
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({topic:'测试',userRequirements:[],sections,assets,meta:{}}))
    await service.finalize({all:true,version:1})
    const engine = { chatTurn: async () => { throw new Error('不应调用模型') } }
    const calls = []
    service.production.start = async args => { calls.push(args); return {status:'running'} }
    const result = await service.chat({text:'重新生成硝石晶体，然后继续制作'},engine)
    assert.equal(result.production.status,'running')
    assert.deepEqual(calls,[{regenerateAssetId:'A01'}])
    for (const text of ['重新生成不存在素材，然后继续制作','重新生成硝石晶体吗？','不要重新生成硝石晶体']) {
      const denied = await service.chat({text},engine)
      assert.equal(denied.production,null,text)
      assert.equal(calls.length,1,text)
    }
    for (const text of ['重新生成蓝图', '重新生成需求单', '重做这一段']) {
      const normal = await service.chat({text}, {chatTurn: async () => ({reply:'交给对话处理'})})
      assert.equal(normal.reply, '交给对话处理', text)
      assert.equal(calls.length, 1)
    }
    const missing = await service.chat({text:'素材丢了，重新生成'},engine)
    assert.equal(missing.production.status,'running')
    assert.equal(calls.length,2)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('声明素材先经素材阶段制作并交接给成片', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-declared-'))
  const old = { ...process.env }
  try {
    const kit = path.join(root, 'kit')
    await mkdir(path.join(kit, 'scripts'), { recursive: true })
    await mkdir(path.join(kit, 'WORK/modules/video'), { recursive: true })
    await writeFile(path.join(kit, 'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; await mkdir(a[5]); await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises'; const a=process.argv; const out=a[a.indexOf('--out')+1]; await mkdir(out); await writeFile(out+'/final.mp4','video'); await writeFile(out+'/mapping.json','{}')`)
    await writeFile(path.join(kit, 'WORK/modules/video/verify.mjs'), `import {readFile} from 'node:fs/promises'; JSON.parse(await readFile(process.argv[2]))`)
    Object.assign(process.env, { SCENE_API_KEY:'test', SCENE_ENDPOINT:'http://localhost/test', SCENE_MODEL:'test', VIDEO_VOICE:'say:Tingting' })
    const service = createService({}, {productionMode:"structured",  workspace: root, videoKitDir: kit })
    await service._internal.ensureDirs()
    const section = id => ({ id, title:id, intent:'讲什么', facts:[], visual:'画面', narration:'旁白', notes:'' })
    const assets = [{ id:'box', name:'字符串盒子', type:'prop', description:'std::string 对象的横向盒子示意', sections:['B01'] }]
    await writeFile(path.join(root,'outbox/蓝图_v1.md'), renderBlueprint({ topic:'测试', core:'', audience:'', order:'', userRequirements:[], sections:[section('B01'),section('B02')], assets, notes:'', meta:{'版本':'v1'} }))
    await service.confirm({all:true}); await service.finalize()
    const source = path.join(root, 'fixture.svg')
    await writeFile(source, '<svg/>')
    let plannedAssets
    service.generatedAssets.prepare = async ({ planned }) => { plannedAssets = planned; return { pool: planned.map(asset => ({ ...asset, path: source })) } }
    // 素材阶段完成后自动继续成片。
    assert.equal((await service.production.start()).status, 'running')
    let state
    for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(20) }
    assert.equal(state.status, 'completed', state.error)
    const bundle = path.join(root, 'production', state.id)
    const exported = JSON.parse(await readFile(path.join(bundle, 'production.json')))
    assert.deepEqual(plannedAssets.map(a => a.id), ['box'])
    const manifest = JSON.parse(await readFile(path.join(bundle, 'assets/manifest.json'), 'utf8'))
    assert.deepEqual(manifest.assets.map(a => a.id), ['box'])
    assert.equal(exported.assetManifest, 'assets/manifest.json')
    assert.equal(exported.sections[0].assets[0].image, manifest.assets[0].files[0].path)
  } finally {
    for (const key of ['SCENE_API_KEY','SCENE_ENDPOINT','SCENE_MODEL','VIDEO_VOICE']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root, { recursive:true, force:true })
  }
})


test('only vetted production images bind and fulfilled declarations target their sections', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-ledger-')), old = {...process.env}
  try {
    const kit = path.join(root,'kit')
    await mkdir(path.join(kit,'scripts'),{recursive:true}); await mkdir(path.join(kit,'WORK/modules/video'),{recursive:true})
    await writeFile(path.join(kit,'scripts/prepare-scenes.mjs'), `import {mkdir,writeFile} from 'node:fs/promises';const a=process.argv;await mkdir(a[5]);await writeFile(a[5]+'/production.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/pipeline.mjs'), `import {mkdir,writeFile} from 'node:fs/promises';const a=process.argv,o=a[a.indexOf('--out')+1];await mkdir(o);await writeFile(o+'/final.mp4','x');await writeFile(o+'/mapping.json','{}')`)
    await writeFile(path.join(kit,'WORK/modules/video/verify.mjs'),'')
    Object.assign(process.env,{SCENE_ENDPOINT:'http://localhost/test',SCENE_MODEL:'test',SCENE_MODE:'api'})
    const service=createService({}, {productionMode:"structured", workspace:root,videoKitDir:kit}); await service._internal.ensureDirs()
    const sections=['B01','B02','B03'].map(id=>({id,title:id,intent:'讲解',facts:[],visual:id==='B01'?'参考.png 未审.png 旧图.png':id==='B02'?'月亮.png':'星星.png',narration:'旁白'}))
    const assets=[{id:'A01',name:'月亮.png',type:'prop',description:'月亮图',sections:['B02']},{id:'A02',name:'星星.png',type:'prop',description:'星星图',sections:['B03']}]
    await writeFile(path.join(root,'outbox/蓝图_v1.md'),renderBlueprint({topic:'测试',userRequirements:[],sections,assets,meta:{}}))
    await service.confirm({all:true}); await service.finalize()
    const png=Buffer.from('89504e470d0a1a0a00000000','hex')
    for(const name of ['参考.png','未审.png','旧图.png','moon.png','star.png']) await writeFile(path.join(root,'sources',name),png)
    const ledger=[
      {id:'ref',name:'参考.png',type:'image',path:'sources/参考.png',side:'blueprint',trust:'vetted'},
      {id:'un',name:'未审.png',type:'image',path:'sources/未审.png',side:'videomake',trust:'unvetted'},
      {id:'old',name:'旧图.png',type:'image',path:'sources/旧图.png',trust:'vetted'},
      {id:'moon',name:'月亮.png',type:'image',path:'sources/moon.png',side:'videomake',trust:'vetted'},
      {id:'star',name:'星星.png',type:'image',path:'sources/star.png',side:'videomake',trust:'vetted',generatedAssetId:'A02',generatedVersion:1},
    ]
    await writeFile(path.join(root,'assets.jsonl'),ledger.map(a=>JSON.stringify(a)).join('\n')+'\n')
    const blueprint = parseBlueprint(await readFile(path.join(root,'outbox/蓝图_v1.md'),'utf8'))
    await assignAssetPlan(root,1,blueprint,'old',['B01'])
    await assignAssetPlan(root,1,blueprint,'moon',['B02'])
    let plannedAssets
    service.generatedAssets.prepare = async ({ planned }) => { plannedAssets = planned; return { pool: planned.map(asset => ({ ...asset, path: path.join(root, 'sources/star.png') })) } }
    let state=await service.production.start(); for(let i=0;i<100;i++){state=await service.production.status();if(state.status!=='running')break;await sleep(20)}
    assert.equal(state.status,'completed',state.error)
    const dir=path.join(root,'production',state.id), doc=JSON.parse(await readFile(path.join(dir,'production.json')))
    assert.equal(doc.sections[0].image,undefined)
    assert.deepEqual(await readFile(path.join(dir,doc.sections[0].assets[0].image)),png)
    assert.equal(doc.sections[1].assets.length,1)
    assert.deepEqual(await readFile(path.join(dir,doc.sections[1].assets[0].image)),png)
    assert.equal(doc.sections[1].image,undefined)
    assert.equal(doc.sections[2].image,undefined)
    const manifest=await readFile(path.join(dir,'现成素材','素材清单.md'),'utf8')
    assert.doesNotMatch(manifest,/星星/)
    assert.deepEqual(plannedAssets.map(a => a.id), ['A02'])
    const generated = JSON.parse(await readFile(path.join(dir, 'assets/manifest.json'), 'utf8'))
    assert.deepEqual(generated.assets.map(a => a.id), ['A02'])
    assert.equal(doc.sections[2].assets[0].image, generated.assets[0].files[0].path)
  } finally { for(const key of ['SCENE_ENDPOINT','SCENE_MODEL','SCENE_MODE']) {if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]} await rm(root,{recursive:true,force:true}) }
})

test('completed jobs regenerate missing source archive atomically without changing status', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'source-recovery-'))
  try {
    const id = '11111111-1111-4111-8111-111111111111'
    const root = path.join(workspace, 'production'), dir = path.join(root, id)
    await mkdir(path.join(dir, 'scenes'), {recursive:true})
    await mkdir(path.join(dir, 'audio-cache'), {recursive:true})
    const state = {id, status:'completed', mode:'agent', version:'v1'}
    const original = JSON.stringify(state) + '\n'
    await writeFile(path.join(root, 'status.json'), original)
    await writeFile(path.join(dir, 'completed.json'), original)
    await writeFile(path.join(dir, 'production.json'), '{}')
    await writeFile(path.join(dir, 'scenes', 'S01.json'), '{"elements":[]}')
    await writeFile(path.join(dir, 'audio-cache', 'S01.mp3'), 'test audio')
    const production = createProduction(workspace)
    const [first, second] = await Promise.all([production.file('source'), production.file('source', undefined, id)])
    assert.equal(first, await realpath(path.join(dir, 'source.zip')))
    assert.equal(second, first)
    const {execFileSync} = await import('node:child_process')
    const files = JSON.parse(execFileSync(process.env.VIDEO_PYTHON || 'python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', first], {encoding:'utf8'}))
    assert.ok(files.includes('scenes/S01.json'))
    assert.ok(files.includes('audio-cache/S01.mp3'))
    assert.equal(await readFile(path.join(root, 'status.json'), 'utf8'), original)
    assert.equal(await readFile(path.join(dir, 'completed.json'), 'utf8'), original)
    assert.deepEqual((await readdir(dir)).filter(n => n.startsWith('.source-')), [])
  } finally { await rm(workspace, {recursive:true, force:true}) }
})

test('source recovery refuses incomplete jobs', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'source-incomplete-'))
  try {
    const id = '22222222-2222-4222-8222-222222222222'
    await mkdir(path.join(workspace, 'production', id), {recursive:true})
    await assert.rejects(createProduction(workspace).file('source', undefined, id), /成片尚不可用/)
  } finally { await rm(workspace, {recursive:true, force:true}) }
})

test('pixel asset lookup serves only a listed code-drawn PNG within the job', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixel-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const id = 'c1d7daa5-7cd0-470f-869c-8dd1fdc0190f'
  const assets = path.join(root, 'production', id, 'assets')
  await mkdir(path.join(assets, 'pixel'), { recursive: true })
  const image = path.join(assets, 'pixel', 'pool.png')
  await writeFile(image, Buffer.from([137,80,78,71]))
  await writeFile(path.join(assets, 'pixel-library.json'), JSON.stringify({ assets: [
    { id:'pool', name:'销烟池', file:'assets/pixel/pool.png', sceneIds:['S02'] }
  ] }))
  const production = createProduction(root)
  assert.equal(await production.file('pixel-image', null, id, 'pool'), await import('node:fs/promises').then(fs => fs.realpath(image)))
  await assert.rejects(production.file('pixel-image', null, id, 'other'), /素材不存在/)
  await assert.rejects(production.file('pixel-image', null, id, '../pool'), /编号无效/)
})


for (const styleId of ['general', 'editorial']) {
  test(`${styleId} 轻蓝图开工时保留用户旁白并以讲述内容补齐`, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'light-blueprint-start-'))
    const previousVoice = process.env.VIDEO_VOICE
    process.env.VIDEO_VOICE = 'say:Tingting'
    try {
      const service = createService({}, {workspace, videoKitDir:path.join(workspace,'no-kit')})
      await service._internal.ensureDirs()
      const sections = [
        {id:'B01', title:'一', intent:'第一段讲述内容'},
        {id:'B02', title:'二', intent:'第二段讲述内容', narration:'用户原有旁白'},
      ]
      await writeFile(path.join(workspace,'outbox/蓝图_v1.md'), renderBlueprint({topic:'测试', userRequirements:[], sections, meta:{}}))
      await service.confirm({all:true}); await service.finalize()
      await service.selectVisualStyle({id:styleId, version:1})
      const started = await service.production.start()
      assert.equal(started.status, 'running')
      const production = JSON.parse(await readFile(path.join(workspace,'production',started.id,'production.json'), 'utf8'))
      assert.deepEqual(production.sections.map(s=>s.narration), ['第一段讲述内容','用户原有旁白'])
      assert.ok(!production.sections[0].gaps.includes('旁白未提供'))
      let state
      for (let i=0; i<100; i++) { state=await service.production.status(); if (state.status !== 'running') break; await sleep(10) }
      assert.equal(state.status, 'failed') // 测试环境没有视频工具，不运行成片
    } finally {
      if (previousVoice === undefined) delete process.env.VIDEO_VOICE; else process.env.VIDEO_VOICE = previousVoice
      await rm(workspace, {recursive:true, force:true})
    }
  })
}

test('继续制作不能把旧 Skill 的无映射成片标为已完成', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'silent-original-resume-'))
  try {
    const kit = path.join(root, 'kit')
    const modules = path.join(kit, 'WORK/modules/video')
    const jobId = '8b542786-1dc5-4566-be8d-76055fa2c113'
    const job = path.join(root, 'production', jobId)
    const film = path.join(job, 'film')
    const skill = path.join(root, '.agents/skills/silent-local')
    await Promise.all([modules, film, skill].map(dir => mkdir(dir, { recursive: true })))
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: silent-local\n---\n正文')
    await writeFile(path.join(root, 'production/status.json'), JSON.stringify({
      id: jobId, mode: 'agent', status: 'interrupted', version: 'v1', phase: '正在制作视频',
    }))
    await writeFile(path.join(job, 'production.json'), JSON.stringify({
      version: 'v1', style: { id: 'repo-skill:silent-local', kind: 'skill' },
      sections: [{ id: 'S01', blueprintId: 'B01', intent: '保留内容要点', narration: null }],
    }))
    await writeFile(path.join(film, 'final.mp4'), 'old film without host timing evidence')
    const production = createProduction(root, { desktop:true, skillsRoot:root, videoKitDir:kit, settings:{ load:async () => ({tts:{}}) } })
    await assert.rejects(production.start({ jobId }), /配置当前配音服务/)
    assert.equal((await production.status()).status, 'interrupted')
  } finally { await rm(root, { recursive:true, force:true }) }
})
