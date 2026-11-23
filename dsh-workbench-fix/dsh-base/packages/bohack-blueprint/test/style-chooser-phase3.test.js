import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const source = html.slice(html.indexOf('function styleItems('), html.indexOf('function stylePreviewHtml('))
const {styleItems,styleKindLabel} = vm.runInNewContext(source+'\n({styleItems,styleKindLabel})')

test('制作选择器保留全部类型并标识可执行 Skill 与视觉参考', () => {
  const items=[{kind:'skill'},{kind:'preset'},{kind:'visual'},{kind:'builtin'}]
  assert.equal(styleItems(items).length,4)
  assert.deepEqual(items.map(styleKindLabel),['制作 Skill','Skill 预设','纯文字视觉参考','内置轻量风格'])
})
