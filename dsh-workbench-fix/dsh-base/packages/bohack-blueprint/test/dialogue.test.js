import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'

test('restores history and blocks stale requirements', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-dialogue-'))
  try {
    const service = createService({}, { workspace })
    const inbox = path.join(workspace, 'inbox', '需求.md')
    let turn = 0, recovered = ''
    const engine = {
      async chatTurn(args) {
        recovered = args.historyText
        if (++turn === 1) {
          return { reply: '需求已整理。', requirementMarkdown: '# 主题\n火山\n' }
        }
        return { reply: '记下修改。', requirementChanged: true }
      },
      async produce() { throw new Error('生成已调用') },
    }
    await service.chat({ text: '整理火山需求' }, engine)
    await assert.rejects(service.generate({}, engine), /生成已调用/)
    await service.chat({ text: '改成讲地震' }, engine)
    assert.match(recovered, /整理火山需求/)
    await assert.rejects(service.generate({}, engine), /最新对话不一致/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('blueprint freezes baseline until explicit replacement and keeps old version', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-baseline-'))
  try {
    const service = createService({}, { workspace })
    const engine = { async chatTurn() { return { reply: '已整理', requirementMarkdown: '# 新需求' } } }
    await service.chat({ text: '整理需求' }, engine)
    const outbox = path.join(workspace, 'outbox')
    await writeFile(path.join(outbox, '蓝图_v1.md'), '# 蓝图：测试')
    engine.chatTurn = async () => ({ reply: '已整理', requirementMarkdown: '# 意外改动' })
    const blocked = await service.chat({ text: '改一下蓝图' }, engine)
    assert.match(blocked.reply, /需求基线只读/)
    assert.equal((await service.requirement()).raw, '# 新需求\n')
    engine.chatTurn = async () => ({ reply: '基线已重建', requirementMarkdown: '# 更新的需求', replaceBaseline: true })
    await service.chat({ text: '同意重建需求基线' }, engine)
    assert.equal((await service.requirement()).raw, '# 更新的需求\n')
    const { readdir, readFile } = await import('node:fs/promises')
    const history = path.join(workspace, 'inbox', '需求基线历史')
    const files = await readdir(history)
    assert.equal(files.length, 1)
    assert.equal(await readFile(path.join(history, files[0]), 'utf8'), '# 新需求\n')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('dialogue text materials are registered and reach blueprint generation', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-material-'))
  try {
    const service = createService({}, { workspace })
    let received
    const engine = {
      async chatTurn() {
        return { reply: '已记下资料', requirementMarkdown: '# 主题\n火山', textAssets: [{ name: '资料摘录', note: '火山灰可以影响航空。' }] }
      },
      async produce(args) { received = args.textAssets; throw new Error('已收到资料') },
    }
    await service.chat({ text: '整理需求，并参考：火山灰可以影响航空。' }, engine)
    const assets = await service.listAssets()
    assert.equal(assets.assets[0].note, '火山灰可以影响航空。')
    await assert.rejects(service.generate({}, engine), /已收到资料/)
    assert.equal(received[0].name, '资料摘录')
    assert.equal(received[0].note, '火山灰可以影响航空。')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
