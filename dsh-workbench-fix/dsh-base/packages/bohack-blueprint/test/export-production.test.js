import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'
import { renderBlueprint } from '../lib/blueprint.js'
import { exportProduction, requestedDuration } from '../scripts/export-production.js'

test('extracts an explicitly requested overall duration', () => {
  assert.equal(requestedDuration(['视频时长约 20 秒']), 20)
  assert.equal(requestedDuration(['做一条约 1.5 分钟的视频']), 90)
  assert.equal(requestedDuration(['每段 5 秒']), null)
  assert.equal(requestedDuration(['视频不超过 20 秒']), null)
  assert.equal(requestedDuration(['视频时长 20 秒', '视频时长 30 秒']), null)
})

test('exports finalized snapshot and rejects stale or unconfirmed work', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'blueprint-export-'))
  try {
    const service = createService({}, { workspace })
    await service._internal.ensureDirs()
    const outbox = path.join(workspace, 'outbox')
    const section = (id, narration = '') => ({ id, title: id, intent: '讲解内容', facts: ['事实一'], visual: '画面意图', narration, notes: '待核实' })
    const raw = renderBlueprint({ topic: '测试', core: '', audience: '', order: '', userRequirements: ['视频时长约 20 秒'], sections: [section('B01'), section('B01a', '旁白内容')], notes: '', meta: { '版本': 'v1' } })
    await writeFile(path.join(outbox, '蓝图_v1.md'), raw)
    await writeFile(path.join(outbox, '蓝图_v1.技能.json'), JSON.stringify({name:'旧版方法',content:'旧版内容'}))
    await service.confirm({ all: true })
    await service.finalize()
    const result = await exportProduction(workspace)
    assert.equal(result.version, 'v1')
    assert.deepEqual(result.skill, {name:'旧版方法',content:'旧版内容'})
    assert.deepEqual(result.userRequirements, ['视频时长约 20 秒'])
    assert.equal(result.targetDurationSeconds, 20)
    assert.deepEqual(result.sections.map(s => [s.id, s.blueprintId]), [['S01', 'B01'], ['S02', 'B01a']])
    assert.equal(result.sections[0].narration, null)
    assert.deepEqual(result.sections[0].gaps, ['旁白未提供'])
    assert.equal(result.sections[1].narration, '旁白内容')
    assert.equal(result.sections[0].notes, '待核实')
    // finalize accepts hand-written blueprints without version metadata.
    const withoutMeta = raw.replace(/^- \*\*版本：\*\* v1\n/m, '')
    await writeFile(path.join(outbox, '蓝图_v1.md'), withoutMeta)
    await service.finalize()
    assert.equal((await exportProduction(workspace)).version, 'v1')
    const conflictingMeta = withoutMeta.replace('# 蓝图：测试', '# 蓝图：测试\n\n- **版本：** v2')
    await writeFile(path.join(outbox, '蓝图_v1.md'), conflictingMeta)
    await service.finalize()
    await assert.rejects(exportProduction(workspace), /版本不一致/)
    await writeFile(path.join(outbox, '蓝图_v1.md'), raw)
    await service.finalize()
    const stateFile = path.join(outbox, '状态.json')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    await writeFile(stateFile, JSON.stringify({ ...state, confirmed: {} }))
    await assert.rejects(exportProduction(workspace), /确认记录不完整/)
    await writeFile(stateFile, JSON.stringify(state))
    await writeFile(path.join(outbox, '蓝图_v2.md'), raw)
    await assert.rejects(exportProduction(workspace), /不是当前定稿/)
    await rm(path.join(outbox, '蓝图_v2.md'))
    await writeFile(path.join(outbox, '交付.md'), '伪造的交付')
    await assert.rejects(exportProduction(workspace), /交付文件与定稿版本不一致/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
