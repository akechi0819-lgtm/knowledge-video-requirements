import test from 'node:test'
import assert from 'node:assert/strict'
import { renderBlueprint, parseBlueprint, validateBlueprint } from '../lib/blueprint.js'

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
