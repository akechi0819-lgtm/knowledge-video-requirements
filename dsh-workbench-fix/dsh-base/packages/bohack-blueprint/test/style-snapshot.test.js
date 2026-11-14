import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'
import { exportProduction } from '../scripts/export-production.js'

test('visual selection follows finalized blueprint versions', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'visual-selection-'))
  try {
    const service = createService({}, { workspace })
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
    await service.manualEdit({section:'B01',fields:{title:'修改'}}, engine)
    assert.equal((await service.status()).visualStyle.status, 'pending')
    await assert.rejects(service.selectVisualStyle({id:'general',version:1}), /先确认当前蓝图/)
    await service.confirm({all:true}); await service.finalize()
    await assert.rejects(exportProduction(workspace), /选择视觉参考/)
    await service.selectVisualStyle({id:'general',version:2})
    assert.equal((await exportProduction(workspace)).style.id, 'general')
    await service.revise({}, engine)
    assert.equal((await service.status()).visualStyle.status, 'pending')
    assert.equal(calls[1].style, undefined)
  } finally { await rm(workspace,{recursive:true,force:true}) }
})

test('chat confirmation finalizes then prompts for visual choice', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'visual-chat-'))
  try {
    const service = createService({}, { workspace })
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:['事实'],visual:'画面',narration:'旁白',notes:''}))
    const markdown = renderBlueprint({topic:'潮汐',core:'',audience:'',order:'',userRequirements:[],sections,notes:'',meta:{}})
    const engine = { async produce(){return {markdown,engine:'test'}}, async chatTurn(){return {reply:'已提交',productionRequested:true}} }
    await service.generate({},engine)
    const result = await service.chat({text:'确认当前蓝图全部段落，开始制作成片'},engine)
    assert.equal(result.productionError.code, 'STYLE_REQUIRED')
    assert.match(result.reply, /蓝图已定稿.*选择视觉参考/)
    assert.equal((await service.status()).stage, 'finalized')
    assert.equal(await service.production.status(), null)
  } finally { await rm(workspace,{recursive:true,force:true}) }
})
