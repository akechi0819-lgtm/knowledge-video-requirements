import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActivityObserver } from '../lib/engine.js'

test('reports committed web searches and matched results without leaking unrelated sessions', () => {
  const output = []
  const observe = createActivityObserver(() => 'ours', { onProgress: event => output.push(event) })
  const event = (id, type, data) => observe({ id }, { type, data })
  event('other', 'tool/call', { name: 'web_search', callId: 'wrong', arguments: '{"queries":["secret"]}' })
  event('ours', 'tool/call', { name: 'web_search', callId: '1', arguments: '{"queries":["火锅起源"]}' })
  event('ours', 'tool/call', { name: 'web_search', callId: '2', arguments: '{"queries":["辣椒历史"]}' })
  event('ours', 'tool/result', { message: { toolCallId: '2', isError: false }, meta: { sources: [] } })
  event('ours', 'tool/result', { message: { toolCallId: '1', isError: false }, meta: { sources: [{ url: 'https://example.org' }] } })
  event('ours', 'tool/call', { name: 'web_search', callId: '3', arguments: '{"queries":["失败测试"]}' })
  event('ours', 'tool/result', { message: { toolCallId: '3', isError: true, content: [{ text: 'private details' }] } })
  assert.deepEqual(output.map(e => e.text), [
    '正在搜索网页资料：火锅起源', '正在搜索网页资料：辣椒历史',
    '搜索网页资料完成，未找到来源：辣椒历史', '搜索网页资料完成，返回 1 条来源：火锅起源',
    '正在搜索网页资料：失败测试', '搜索网页资料失败：失败测试',
  ])
  assert.ok(output.every(e => e.type === 'activity'))
})
