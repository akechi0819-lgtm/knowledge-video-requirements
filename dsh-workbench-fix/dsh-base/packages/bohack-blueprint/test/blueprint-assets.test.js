import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderBlueprint, parseBlueprint, validateBlueprint } from '../lib/blueprint.js'
import { createService } from '../lib/service.js'

test('asset list survives blueprint Markdown and validates section references', () => {
  const assets = [{ id: 'A01', name: '商人', type: 'character', description: '身穿蓝袍，携带货篮', sections: ['B01', 'B02'] }]
  const sections = ['B01', 'B02'].map(id => ({ id, title: id, intent: '讲述', visual: '画面', facts: [] }))
  const doc = parseBlueprint(renderBlueprint({ topic: '测试', userRequirements: [], sections, assets, meta: {} }))
  assert.deepEqual(doc.assets, assets)
  assert.equal(validateBlueprint(doc).ok, true)
  doc.assets[0].id = '../A01'
  assert.match(validateBlueprint(doc).errors.join(' '), /资产编号无效/)
  doc.assets[0].id = 'A01'
  doc.assets[0].sections = ['B03']
  assert.match(validateBlueprint(doc).errors.join(' '), /关联段落无效/)
})

test('bad asset lines are skipped with warnings instead of failing the whole parse', () => {
  const good = { id: 'A01', name: '商人', type: 'character', description: '身穿蓝袍，携带货篮', sections: ['B01', 'B02'] }
  const md = [
    '# 蓝图：测试',
    '',
    '## 三、分段蓝图',
    '',
    '### B01｜开头',
    '',
    '**讲什么：** 商人出发。',
    '',
    '**画面意图：** 商队上路。',
    '',
    '## 资产清单',
    '',
    `- ${JSON.stringify(good)}`,
    '- {"id": "A02", "name":',
    '- 不是 JSON',
    '- ["A03"]',
    '- {"name": "无编号"}',
    `- ${JSON.stringify({ ...good, id: 'A04' })}`,
    '',
    '## 四、确认与修改',
    '',
    '- 全部段落确认后，可以定稿。',
  ].join('\n')
  const doc = parseBlueprint(md)
  assert.deepEqual(doc.assets, [good, { ...good, id: 'A04' }])
  assert.equal(doc.warnings.length, 4)
  assert.equal(doc.sections.length, 1)
  assert.equal(doc.sections[0].intent, '商人出发。')
})

test('status() stays usable when a hand-edited blueprint contains a bad asset line', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-assets-'))
  try {
    const service = createService({}, { workspace })
    const sections = ['B01', 'B02'].map(id => ({ id, title: id, intent: '讲述', visual: '画面', facts: [] }))
    const assets = [{ id: 'A01', name: '商人', type: 'character', description: '蓝袍', sections: ['B01'] }]
    const md = renderBlueprint({ topic: '测试', userRequirements: [], sections, assets, meta: {} })
      .replace('## 资产清单\n', '## 资产清单\n\n- {"id": "A02", "name":\n')
    await mkdir(path.join(workspace, 'outbox'), { recursive: true })
    await writeFile(path.join(workspace, 'outbox', '蓝图_v1.md'), md)
    const status = await service.status()
    assert.equal(status.ok, true)
    assert.deepEqual(status.blueprintAssets.map(a => a.id), ['A01'])
    assert.equal(status.doc.warnings.length, 1)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('chat context survives malformed assets.jsonl entries', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-assets-'))
  try {
    const service = createService({}, { workspace })
    const lines = [
      JSON.stringify({ id: 'g1', name: '资料摘录', type: 'text', path: 'sources/a.txt', note: '火山灰可以影响航空。' }),
      JSON.stringify({ id: 'b1', name: '坏路径', type: 'text', path: 123, note: 'x' }),
      JSON.stringify({ id: 'b2', name: '空路径', type: 'text', path: null }),
      JSON.stringify({ id: 'b3', name: '缺路径', type: 'text' }),
      JSON.stringify({ id: 'b4', name: '坏备注', type: 'text', path: 'sources/b.txt', note: { evil: true } }),
      '{"id": "b5", "name":',
    ]
    await writeFile(path.join(workspace, 'assets.jsonl'), lines.join('\n') + '\n')
    let contextText = ''
    const engine = { async chatTurn(args) { contextText = args.contextText; return { reply: '收到' } } }
    const result = await service.chat({ text: '你好' }, engine)
    assert.equal(result.ok, true)
    assert.match(contextText, /火山灰可以影响航空。/)
    assert.match(contextText, /sources\/a\.txt/)
    assert.doesNotMatch(contextText, /坏路径|空路径|缺路径/)
    assert.match(contextText, /坏备注/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})


test('asset diagnosis and repair skip malformed reference records', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-assets-'))
  try {
    const service = createService({}, { workspace })
    const lines = [null, { id: 'bad-number', type: 'file', path: 123 }, { id: 'bad-missing', type: 'image' },
      { id: 'good', name: '缺失原件', type: 'file', path: 'sources/missing.pdf' }]
    await writeFile(path.join(workspace, 'assets.jsonl'), lines.map(JSON.stringify).join('\n') + '\n')
    const engine = { async chatTurn() { throw new Error('unexpected engine call') } }
    const diagnosis = await service.chat({ text: '哪些素材丢了？' }, engine)
    assert.equal(diagnosis.ok, true)
    assert.match(diagnosis.reply, /缺失原件/)
    const repair = await service.chat({ text: '把缺失素材补齐继续制作' }, engine)
    assert.equal(repair.ok, true)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
