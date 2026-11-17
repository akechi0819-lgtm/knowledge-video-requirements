import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assetPlan, assignAssetPlan, inheritAssetPlan } from '../lib/asset-plan.js'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'

const doc = { sections: [{id:'B01', visual:'书.png'}, {id:'B02', visual:''}], assets: [{id:'A01', name:'月亮', type:'prop', description:'月球', sections:['B01']}] }
test('版本计划同步、删除不复建，历史及手动继承', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plan-'))
  try {
    await writeFile(path.join(root, 'assets.jsonl'), JSON.stringify({id:'file',name:'书.png',type:'image',path:'sources/书.png',trust:'vetted'})+'\n')
    const plan = await assetPlan(root, 1, doc)
    assert.equal(plan.length,2)
    const moon = plan.find(a => a.id === 'A01')
    assert.deepEqual((await assetPlan(root, 1, doc)), plan)
    await assignAssetPlan(root, 1, doc, 'file', [], undefined)
    await assignAssetPlan(root, 1, doc, 'file', ['B02'], undefined)
    assert.equal((await assetPlan(root, 1, doc)).find(a => a.ledgerId === 'file').id, 'ledger-file')
    await assignAssetPlan(root, 1, doc, 'file', [], undefined)
    await assignAssetPlan(root, 1, doc, moon.ledgerId, [], undefined)
    await assignAssetPlan(root, 1, doc, moon.ledgerId, ['B01'], undefined)
    assert.equal((await assetPlan(root, 1, doc))[0].id, 'A01')
    assert.equal((await assetPlan(root, 1, doc)).length, 1)
    const ledger = (await readFile(path.join(root, 'assets.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(a => a.id !== moon.ledgerId)
    await writeFile(path.join(root, 'assets.jsonl'), ledger.map(JSON.stringify).join('\n')+'\n')
    assert.equal((await assetPlan(root, 1, doc)).length,0)
    const next = await assetPlan(root, 2, doc, {legacy:false})
    assert.equal(next.length,1)
    assert.equal(next[0].id,'A01')
    await assignAssetPlan(root, 2, doc, 'file', ['B02'], 'background')
    await inheritAssetPlan(root, 2, 3, doc)
    assert.deepEqual((await assetPlan(root,3,doc)).find(a=>a.ledgerId==='file').sections,['B02'])
    assert.equal((await assetPlan(root,1,doc)).length,0)
    assert.equal((await assetPlan(root,4,{...doc,assets:[]},{legacy:false})).length,0)
    await assignAssetPlan(root,4,{...doc,assets:[]},'file',['B01'],'prop')
    assert.equal((await assetPlan(root,4,doc))[0].ledgerId,'file')
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('素材写入与首次同步并发不会丢失记录，也不将 PDF 绑入段落', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plan-concurrent-'))
  try {
    const service = createService({}, { workspace: root })
    await Promise.all([
      assetPlan(root, 1, doc, { legacy: false }),
      ...Array.from({length: 20}, (_, i) => service.addAsset({id:`item${i}`, name:`图${i}`, side:'videomake', path:`sources/${i}.png`, type:'image'})),
    ])
    const list = (await service.listAssets()).assets
    assert.equal(list.length, 21)
    await Promise.all([
      assignAssetPlan(root, 1, doc, 'item0', ['B01']),
      service.updateAsset({id:'item1', action:'approve'}),
      service.updateAsset({id:'item2', action:'delete'}),
      service.addAsset({id:'pdf', name:'资料', side:'videomake', path:'sources/资料.pdf'}),
    ])
    const result = (await service.listAssets()).assets
    assert.equal(result.length, 21)
    assert.equal(result.find(a=>a.id==='item1').trust, 'vetted')
    assert.deepEqual(result.find(a=>a.id==='item0').planBindings.v1.sections, ['B01'])
    assert.equal(result.some(a=>a.id==='item2'), false)
    await assert.rejects(assignAssetPlan(root, 1, doc, 'pdf', ['B01']), /PNG/)
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('转正和确认生成图并发保留各自账本更新', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plan-realize-'))
  try {
    const service = createService({}, { workspace: root })
    await service.addAsset({id:'manual', name:'手工图', side:'videomake', declared:true})
    await service.addAsset({id:'generated', name:'生成图', side:'videomake', declared:true})
    await mkdir(path.join(root, 'sources'), {recursive:true})
    const input = path.join(root,'sources','manual.png')
    const rendered = path.join(root,'render.svg')
    await writeFile(input, 'picture')
    await writeFile(rendered, '<svg/>')
    service.generatedAssets.approve = async () => ({ok:true})
    service.generatedAssets.availableFiles = async () => ({approved:[{id:'A01',name:'生成图',path:rendered,revision:'r1'}]})
    await Promise.all([
      service.realizeAsset({id:'manual',path:'sources/manual.png'}),
      service.filmApprove({version:1,doc:{assets:[{id:'A01',ledgerId:'generated'}]}}),
    ])
    const list = (await service.listAssets()).assets
    assert.equal(list.find(a=>a.id==='manual').path,'sources/manual.png')
    assert.equal(list.find(a=>a.id==='generated').generatedRevision,'r1')
  } finally { await rm(root, {recursive:true,force:true}) }
})


test('已有蓝图状态与素材诊断容忍损坏的素材账本', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plan-bad-ledger-'))
  try {
    const service = createService({}, { workspace: root })
    await mkdir(path.join(root, 'outbox'), { recursive: true })
    const sections = [{ id: 'B01', title: '开头', intent: '讲述', visual: '画面', facts: [] }]
    const assets = [{ id: 'A01', name: '月亮', type: 'prop', description: '月球', sections: ['B01'] }]
    await writeFile(path.join(root, 'outbox', '蓝图_v1.md'), renderBlueprint({ topic: '测试', userRequirements: [], sections, assets, meta: {} }))
    const records = [null, { name: '无编号' }, { id: 'bad-path', name: '坏路径', type: 'image', path: 123, trust: 'vetted' }, { id: 'good', name: '资料', type: 'file', path: 'sources/missing.pdf' }]
    await writeFile(path.join(root, 'assets.jsonl'), records.map(JSON.stringify).join('\n') + '\n{"id":\n')
    const status = await service.status()
    assert.equal(status.ok, true)
    assert.deepEqual(status.blueprintAssets.map(a => a.id), ['A01'])
    const diagnosis = await service.chat({ text: '哪些素材丢了？' }, { async chatTurn() { throw new Error('unexpected engine call') } })
    assert.equal(diagnosis.ok, true)
    assert.match(diagnosis.reply, /资料/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
