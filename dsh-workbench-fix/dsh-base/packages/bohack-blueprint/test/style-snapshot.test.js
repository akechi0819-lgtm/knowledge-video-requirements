import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'
import { exportProduction } from '../scripts/export-production.js'

test('visual selection follows finalized blueprint versions', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'visual-selection-'))
  try {
    const service = createService({}, {productionMode:"structured",  workspace })
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:['事实'],visual:'画面',narration:'旁白',notes:''}))
    const markdown = renderBlueprint({topic:'潮汐',core:'',audience:'',order:'',userRequirements:[],sections,notes:'',meta:{}})
    const calls = []
    const engine = { async produce(args) { calls.push(args); return {markdown,engine:'test'} }, async note() {return {delivered:true}} }
    await service.generate({}, engine)
    assert.equal(calls[0].style, undefined)
    assert.equal((await service.status()).visualStyle.status, 'pending')
    await assert.rejects(service.selectVisualStyle({id:'general',version:1}), /先确认当前蓝图/)
    await service.confirm({all:true}); await service.finalize()
    await assert.rejects(exportProduction(workspace), /选择视觉参考/)
    await service.selectVisualStyle({id:'general',version:1})
    assert.equal((await exportProduction(workspace)).style.id, 'general')
    await service.selectVisualStyle({id:'editorial',version:1})
    assert.equal((await exportProduction(workspace)).style.id, 'editorial')
    const custom = (await service.styles.importStyle({name:'自定义',description:'暖色',source:{kind:'text',label:'资料'}})).style
    await service.selectVisualStyle({id:custom.id,version:1})
    await service.styles.update({id:custom.id,name:'自定义',description:'冷色'})
    assert.equal((await exportProduction(workspace)).style.description, '暖色')
    await service.selectVisualStyle({id:custom.id,version:1})
    assert.equal((await exportProduction(workspace)).style.description, '冷色')
    await service.lock({section:'B02'})
    const blockedVisual = path.join(workspace,'outbox/蓝图_v2.视觉选择.json')
    await mkdir(blockedVisual)
    await assert.rejects(service.revise({}, engine), {code:'EISDIR'})
    await assert.rejects(service.manualEdit({section:'B01',fields:{title:'修改'}}, engine), {code:'EISDIR'})
    assert.equal((await service.status()).currentVersion, 1)
    await rm(blockedVisual, {recursive:true})
    await service.manualEdit({section:'B01',fields:{title:'修改'}}, engine)
    assert.deepEqual((await service.status()).locked, ['B02'])
    assert.equal((await service.status()).visualStyle.style.description, '冷色')
    await assert.rejects(service.selectVisualStyle({id:'general',version:1}), /先确认当前蓝图/)
    await service.confirm({all:true}); await service.finalize()
    assert.equal((await exportProduction(workspace)).style.description, '冷色')
    await service.selectVisualStyle({id:'general',version:2})
    assert.equal((await exportProduction(workspace)).style.id, 'general')
    await service.revise({}, engine)
    assert.equal((await service.status()).visualStyle.status, 'pending')
    assert.equal(calls[1].style, undefined)
  } finally { await rm(workspace,{recursive:true,force:true}) }
})

test('chat confirmation finalizes and calls the shared production entry', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'visual-chat-'))
  try {
    const service = createService({}, {productionMode:"structured",  workspace })
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:['事实'],visual:'画面',narration:'旁白',notes:''}))
    const assets = [{id:'A01',name:'船',type:'prop',description:'木船',sections:['B01']}]
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections,assets,meta:{}})
    const engine = { async produce(){return {markdown,engine:'test'}}, async chatTurn(){return {reply:'已提交',productionRequested:true}} }
    await service.generate({},engine)
    service.production.start = async () => ({started:true})
    const result = await service.chat({text:'确认当前蓝图全部段落，开始制作成片'},engine)
    assert.deepEqual(result.production, {started:true})
    assert.equal(result.productionError, null)
    assert.equal((await service.status()).stage, 'finalized')
    let revision
    service.production.start = async options => { revision = options; return {started:true} }
    const edit = await service.chat({text:'第二段的转场太突然，请让它缓慢淡入'}, {chatTurn:async () => ({reply:'', filmRevisionNote:'第二段缓慢淡入'})})
    assert.deepEqual(revision, {mode:'agent', feedback:'第二段缓慢淡入'})
    assert.equal(edit.production.started, true)
  } finally { await rm(workspace,{recursive:true,force:true}) }
})

test('chat selects a blueprint skill before drafting and keeps it in the snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-skill-chat-'))
  try {
    const service = createService({}, {productionMode:"structured", workspace:root})
    await service._internal.ensureDirs()
    const noModel = {chatTurn:async () => {throw new Error('纯选择无需模型')}}
    const ambiguous = await service.chat({text:'用简洁知识图解和杂志式图文风格'}, noModel)
    assert.equal(ambiguous.chooseBlueprintSkill, true)
    assert.equal(await service.styles.blueprintSkill(), null)
    const question = await service.chat({text:'能用像素风格吗？'}, {chatTurn:async () => ({reply:'可以讨论'})})
    assert.equal(question.blueprintSkillSelection, null)
    assert.equal(await service.styles.blueprintSkill(), null)
    const topic = await service.chat({text:'用像素风讲月亮为什么会变弯？不要背景音乐'}, {chatTurn:async ({text}) => ({reply:text})})
    assert.equal(topic.blueprintSkillSelection.id, 'andy-pixel-quest')
    assert.match(topic.reply, /不要背景音乐/)
    await service.styles.chooseBlueprintSkill({id:null})
    const denied = await service.chat({text:'不要用像素风格'}, {chatTurn:async () => ({reply:'收到'})})
    assert.equal(denied.blueprintSkillSelection, null)
    assert.equal(await service.styles.blueprintSkill(), null)
    const selected = await service.chat({text:'用像素风格'}, noModel)
    assert.equal(selected.blueprintSkillSelection.id, 'andy-pixel-quest')
    assert.equal((await service.status()).selectedBlueprintSkill.id, 'andy-pixel-quest')
    const section = id => ({id,title:id,intent:'讲什么',facts:[],visual:'画面',narration:'旁白'})
    const markdown = renderBlueprint({topic:'测试',userRequirements:[],sections:[section('B01'),section('B02')],meta:{}})
    const process = (await service.styles.list()).styles.find(s => s.kind === 'skill')
    assert.ok(process)
    let usedSkill
    const engine = {
      chatTurn:async () => ({reply:'开始起草', requirementMarkdown:'# 主题\n测试\n', blueprintRequested:true}),
      produce:async ({skill}) => { usedSkill = skill; return {markdown,engine:'test'} },
    }
    const result = await service.chat({text:`用 ${process.name} 技能起草蓝图`}, engine)
    assert.equal(result.blueprintSkillSelection.id, process.id)
    assert.ok(result.generation, JSON.stringify(result.generationError))
    assert.equal(usedSkill.id, process.id)
    assert.equal(usedSkill.description, process.description)
    assert.equal((await service.status()).blueprintSkill, process.name)
    assert.equal((await service.styles.blueprintSkill()).id, process.id)
    const snapshot = JSON.parse(await readFile(path.join(root,'outbox/蓝图_v1.技能.json'),'utf8'))
    assert.equal(snapshot.id, process.id)
    const before = await readFile(path.join(root,'outbox/蓝图_v1.md'), 'utf8')
    const switched = await service.chat({text:'换成简洁知识图解风格'}, noModel)
    assert.equal(switched.blueprintSkillSelection.id, 'general')
    assert.doesNotMatch(switched.reply, /重新起草/)
    assert.equal((await service.status()).visualStyle.style.id, 'general')
    assert.equal((await service.status()).selectedBlueprintSkill.id, 'general')
    assert.equal(JSON.parse(await readFile(path.join(root,'outbox/蓝图_v1.技能.json'),'utf8')).id, 'general')
    assert.equal(await readFile(path.join(root,'outbox/蓝图_v1.md'), 'utf8'), before)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('selected visual or repository skill reaches production and scopes asset cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'style-end-to-end-'))
  const old = {...process.env}
  try {
    const probe = createService({}, {productionMode:"structured", workspace:path.join(root,'probe')})
    const library = (await probe.styles.list()).styles
    const repo = library.find(item => item.kind === 'skill')
    assert.ok(repo)
    for (const [i, id] of ['andy-pixel-quest', repo.id].entries()) {
      const workspace = path.join(root, String(i))
      const service = createService({}, {productionMode:"structured", workspace, multiuser:true})
      await service._internal.ensureDirs()
      await writeFile(path.join(workspace,'inbox/需求.md'), '# 主题\n测试\n')
      const chosen = (await service.styles.chooseBlueprintSkill({id})).skill
      const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:[],visual:'画面',narration:'旁白'}))
      const assets = [{id:'A01',name:'晶体',type:'prop',description:'晶体',sections:['B01']}]
      const markdown = renderBlueprint({topic:'测试',userRequirements:[],sections,assets,meta:{}})
      const engine = {produce:async () => ({markdown,engine:'test'}), note:async () => ({delivered:true})}
      await service.generate({},engine)
      const visual = (await service.status()).visualStyle
      assert.equal(visual.status,'selected')
      assert.equal(visual.style.id,id)
      assert.equal(visual.style.description,chosen.description)
      assert.deepEqual(visual.style.source,chosen.source)
      await service.manualEdit({section:'B01',fields:{title:'更新'}},engine)
      assert.deepEqual((await service.status()).visualStyle.style,visual.style)
      await service.finalize({all:true,version:2})
      const exported = await exportProduction(workspace)
      assert.deepEqual(exported.style,visual.style)
      assert.equal(exported.skill.content,chosen.content)
      const doc=(await service.show({version:2})).doc
      const planned=doc.assets
      await service.generatedAssets.prepare({version:2,doc,style:exported.style,planned,run:async ({dir,assets})=>{
        assert.deepEqual(assets,planned)
        await mkdir(path.join(dir,'assets'),{recursive:true})
        await writeFile(path.join(dir,'assets/crystal.png'),'preview')
        return {assets:[{...assets[0],files:[{variant:'idle',path:'assets/crystal.png'}]}]}
      }})
      assert.equal((await service.generatedAssets.status({version:2,doc,style:exported.style})).assets[0].status,'approved')
      assert.equal((await service.generatedAssets.status({version:2,doc,style:{...exported.style,id:'different'}})).assets[0].status,'pending')
      // Older versions stored the choice only in their versioned skill snapshot.
      await writeFile(path.join(workspace,'outbox/蓝图_v2.视觉选择.json'), JSON.stringify({status:'pending',style:null}))
      await writeFile(path.join(workspace,'outbox/蓝图_v2.技能.json'), JSON.stringify({id:chosen.id,name:chosen.name,content:chosen.content}))
      await assert.rejects(service.production.start(), /多人工作台尚未配置单任务进程沙箱/)
      assert.equal((await exportProduction(workspace)).style.id,id)
      assert.equal((await exportProduction(workspace)).style.description,chosen.content)
      assert.deepEqual((await exportProduction(workspace)).style.source,chosen.source)
    }
  } finally {
    for (const key of ['SCENE_MODE','SCENE_ENDPOINT','SCENE_MODEL']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(root,{recursive:true,force:true})
  }
})

test('选中 Skill 的元数据用于首稿及修订，正文仅留在快照', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'blueprint-skill-prompt-'))
  try {
    const service = createService({}, { workspace })
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const chosen = (await service.styles.list()).styles.find(item => item.kind === 'skill')
    assert.ok(chosen)
    await service.styles.chooseBlueprintSkill({ id: chosen.id })
    const markdown = renderBlueprint({topic:'潮汐',userRequirements:[],sections:[{id:'B01',title:'潮汐',intent:'引力作用',facts:[]},{id:'B02',title:'变化',intent:'潮位升降',facts:[]}],meta:{}})
    const calls = []
    const engine = { produce: async args => { calls.push(args); return { markdown, engine:'test' } } }
    await service.generate({}, engine)
    await service.revise({}, engine)
    for (const call of calls) {
      assert.equal(call.skill.id, chosen.id)
      assert.equal(call.skill.description, chosen.description)
      assert.equal(call.skill.content, undefined)
    }
    const saved = JSON.parse(await readFile(path.join(workspace, 'outbox/蓝图_v2.技能.json'), 'utf8'))
    assert.ok(saved.content)
  } finally { await rm(workspace, { recursive:true, force:true }) }
})

test('真实制作预设继承原 Skill 形态，直接 Skill 保留有声信息', async () => {
  const { selectedMediaSummary } = await import('../lib/engine.js')
  const workspace = await mkdtemp(path.join(tmpdir(), 'blueprint-preset-mode-'))
  try {
    const service = createService({}, { workspace })
    const cards = (await service.styles.list()).styles
    const preset = cards.find(item => item.id === 'vibe-fable')
    const voiced = cards.find(item => item.id === 'repo-skill:andy-vibe-knowledge')
    assert.ok(preset)
    assert.ok(voiced)
    const snapshot = (await service.styles.chooseBlueprintSkill({ id: preset.id })).skill
    assert.equal(snapshot.description, preset.description)
    assert.equal(snapshot.planning.mode, 'B 寓言')
    assert.match(selectedMediaSummary({ skill: snapshot }), /旁白形态：无旁白/)
    assert.match(selectedMediaSummary({ skill: snapshot }), /预设模式："B 寓言"/)
    assert.ok(Buffer.byteLength(selectedMediaSummary({ skill: snapshot })) <= 2048)
    const voiceSnapshot = (await service.styles.chooseBlueprintSkill({ id: voiced.id })).skill
    assert.match(selectedMediaSummary({ skill: voiceSnapshot }), /旁白形态：有旁白/)
  } finally { await rm(workspace, { recursive:true, force:true }) }
})
