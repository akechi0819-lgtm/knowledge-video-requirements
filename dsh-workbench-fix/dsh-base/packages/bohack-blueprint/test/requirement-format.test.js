import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseRequirement } from '../lib/blueprint.js'
import { createService, affirmative } from '../lib/service.js'

test('creator handoff reads its topic and the full content section', () => {
  const result = parseRequirement('# 视频需求\n\n## 主题\n丝绸之路\n\n## 想讲的内容\n商人接力。\n\n为什么分段交易？\n\n## 用户的明确要求\n- 聚焦接力')
  assert.equal(result.topic, '丝绸之路')
  assert.equal(result.core, '商人接力。\n\n为什么分段交易？')
})

test('chat history tolerates a half-written activity line', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-history-'))
  try {
    const service = createService({}, { workspace })
    assert.deepEqual((await service.chatHistory()).activities, [])
    await mkdir(path.join(workspace, 'dialogue'), { recursive: true })
    await writeFile(path.join(workspace, 'dialogue', '对话记录.md'), '\n## 2026-01-01T00:00:00.000Z · 创作者\n\n你好\n')
    await writeFile(path.join(workspace, 'dialogue', '操作记录.jsonl'), '{"turnIndex":0,"text":"正在搜索网页资料"}\n{"turnIndex":0,"text":"半行')
    const history = await service.chatHistory()
    assert.equal(history.ok, true)
    assert.deepEqual(history.activities, [{ turnIndex: 0, text: '正在搜索网页资料' }])
    assert.match(history.raw, /你好/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('affirmative strips approval idioms but keeps rejecting negations and questions', () => {
  assert.equal(affirmative('不错，全部确认'), true)
  assert.equal(affirmative('不错，全部确认并制作视频'), true)
  assert.equal(affirmative('没问题，开始制作'), true)
  assert.equal(affirmative('没毛病，就这样做'), true)
  assert.equal(affirmative('不要确认'), false)
  assert.equal(affirmative('如何换风格'), false)
  assert.equal(affirmative('怎么生成蓝图'), false)
  assert.equal(affirmative('先讨论一下'), false)
  assert.equal(affirmative('“全部确认”'), false)
})

test('run records written in the same millisecond keep distinct ids', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-runs-'))
  try {
    const service = createService({}, { workspace })
    const ids = await Promise.all(Array.from({ length: 20 }, () => service._internal.writeRun({ action: 'chat' })))
    assert.equal(new Set(ids).size, 20)
    assert.equal((await readdir(path.join(workspace, 'runs'))).length, 20)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
