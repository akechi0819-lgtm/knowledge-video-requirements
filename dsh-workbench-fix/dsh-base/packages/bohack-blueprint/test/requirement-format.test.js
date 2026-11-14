import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRequirement } from '../lib/blueprint.js'

test('creator handoff reads its topic and the full content section', () => {
  const result = parseRequirement('# 视频需求\n\n## 主题\n丝绸之路\n\n## 想讲的内容\n商人接力。\n\n为什么分段交易？\n\n## 用户的明确要求\n- 聚焦接力')
  assert.equal(result.topic, '丝绸之路')
  assert.equal(result.core, '商人接力。\n\n为什么分段交易？')
})
