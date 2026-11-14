import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { generatePreview } from '../lib/preview.js'
const context = vm.createContext({})
vm.runInContext(await readFile(new URL('../web/preview.js', import.meta.url), 'utf8'), context)
const settings = { model: { baseUrl: 'http://localhost:1234', model: 'test' } }
const shape = d => ({ d, fill: 'none', stroke: 'ink', width: 2 })
for (const [topic, paths] of [
  ['火锅', ['M150 100 L250 100 L230 160 L170 160 Z', 'M180 100 C170 80 190 70 180 50', 'M210 100 C200 80 220 70 210 50', 'M150 120 L120 110', 'M250 120 L280 110']],
  ['商队', ['M50 150 L350 150', 'M80 140 L120 140 L130 110 L100 95 L80 110 Z', 'M95 140 L95 170', 'M120 140 L120 170', 'M200 150 L240 150 L250 120 L220 105 Z']],
]) test(`${topic}场景通过受限图元生成并渲染`, async () => {
  const sections = [{ id: 'B01', title: topic, visual: `${topic}的场面`, facts: ['测试事实'] }]
  const request = async (_url, options) => {
    assert.match(JSON.parse(options.body).messages[0].content, new RegExp(topic))
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scenes: [{ id: 'B01', shapes: paths.map(shape) }] }) } }] }) }
  }
  const scenes = await generatePreview(sections, settings, request)
  const html = context.renderBlueprintPreview(sections, scenes)
  assert.match(html, /<svg/)
  assert.match(html, new RegExp(paths[0]))
  assert.match(html, /data-preview-target="B01"/)
})
test('invalid markup in model geometry is rejected', async () => {
  const request = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scenes: [{ id: 'B01', shapes: Array(5).fill(shape('M0 0" onload="alert(1)')) }] }) } }] }) })
  await assert.rejects(generatePreview([{ id: 'B01' }], settings, request), /图元无效/)
})
