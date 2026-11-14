import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'
import { exportProduction } from '../scripts/export-production.js'

test('style is confirmed, versioned, and stale selection blocks delivery', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'style-snapshot-'))
  try {
    const service = createService({}, { workspace })
    await service._internal.ensureDirs()
    await writeFile(path.join(workspace, 'inbox/需求.md'), '# 主题\n潮汐\n')
    const sections = ['B01','B02'].map(id => ({id,title:id,intent:'讲解',facts:['事实'],visual:'画面',narration:'旁白',notes:''}))
    const markdown = renderBlueprint({topic:'潮汐',core:'',audience:'',order:'',userRequirements:[],sections,notes:'',meta:{}})
    const calls = []
    const engine = { async produce(args) { calls.push(args.style); return {markdown,engine:'test'} }, async note() {return {delivered:true}} }
    await assert.rejects(service.generate({}, engine), /选择并确认视频风格/)
    await service.styles.select({id:'general'})
    await service.generate({}, engine)
    assert.equal(calls[0].id, 'general')
    await service.manualEdit({section:'B01',fields:{title:'修改'}}, engine)
    assert.equal(JSON.parse(await readFile(path.join(workspace,'outbox/蓝图_v2.风格.json'))).id, 'general')
    await service.confirm({all:true}); await service.finalize()
    assert.equal((await exportProduction(workspace)).style.id, 'general')
    await service.styles.select({id:'editorial'})
    await assert.rejects(exportProduction(workspace), /风格已更换/)
    await assert.rejects(service.finalize(), /风格已更换/)
    await service.revise({}, engine)
    assert.equal(calls[1].id, 'editorial')
    await service.confirm({all:true}); await service.finalize()
    assert.equal((await exportProduction(workspace)).style.id, 'editorial')
    await service.generate({fresh:true}, engine)
    assert.equal(calls[2].id, 'editorial')
    const custom = (await service.styles.importStyle({name:'自定义',description:'暖色',source:{kind:'text',label:'用户素材'}})).style
    await service.styles.select({id:custom.id})
    await service.generate({fresh:true}, engine)
    await service.confirm({all:true}); await service.finalize()
    await service.styles.update({id:custom.id,name:'自定义',description:'冷色'})
    assert.equal((await exportProduction(workspace)).style.description, '暖色')
    await service.styles.select({id:custom.id})
    await assert.rejects(exportProduction(workspace), /风格已更换/)
    await assert.rejects(service.finalize(), /风格已更换/)
    await service.revise({}, engine)
    assert.equal(calls.at(-1).description, '冷色')
  } finally { await rm(workspace,{recursive:true,force:true}) }
})
