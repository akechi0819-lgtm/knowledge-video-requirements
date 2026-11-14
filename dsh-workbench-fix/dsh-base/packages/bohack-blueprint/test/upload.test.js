import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createService } from '../lib/service.js'
import { createWebHandler } from '../lib/web.js'

test('uploads preserve files and expose UTF-8 text to blueprint generation', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-upload-'))
  try {
    const service = createService({}, { workspace })
    const upload = (name, bytes) => service.uploadAsset({ name, dataBase64: Buffer.from(bytes).toString('base64') })
    const [first, second, pdf, image] = await Promise.all([
      upload('资料.md', '第一份资料'), upload('资料.md', '第二份资料'),
      upload('参考.pdf', '%PDF-1.4'), upload('参考.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ])
    assert.notEqual(first.asset.path, second.asset.path)
    assert.equal(await readFile(path.join(workspace, first.asset.path), 'utf8'), '第一份资料')
    assert.equal(await readFile(path.join(workspace, second.asset.path), 'utf8'), '第二份资料')
    assert.equal(await readFile(path.join(workspace, pdf.asset.path), 'utf8'), '%PDF-1.4')
    assert.deepEqual(await readFile(path.join(workspace, image.asset.path)), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    assert.equal(pdf.asset.type, 'file')
    assert.equal(image.asset.type, 'image')
    await service.styles.select({ id: 'general' })
    await service.chat({ text: '整理需求' }, { async chatTurn() { return { reply: '已整理', requirementMarkdown: '# 主题\n测试' } } })
    let received
    await assert.rejects(service.generate({}, { async produce(args) { received = args.textAssets; throw new Error('已收到') } }), /已收到/)
    assert.deepEqual(received.map(a => a.note).sort(), ['第一份资料', '第二份资料'].sort())
    await assert.rejects(upload('坏文件.txt', Buffer.from([0xff])), /UTF-8/)
    await assert.rejects(service.uploadAsset({ name: 'a.pdf', dataBase64: '%%%%' }), /Base64/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('HTTP upload accepts 10 MiB decoded and rejects larger files and requests', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-upload-http-'))
  const service = createService({}, { workspace })
  const server = http.createServer(createWebHandler(service, {}, {}, null))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/bohack/api/upload`
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const limit = 10 * 1024 * 1024
    const accepted = await post({ name: 'large.pdf', dataBase64: Buffer.alloc(limit).toString('base64') })
    assert.equal(accepted.status, 200)
    const rejected = await post({ name: 'large.pdf', dataBase64: Buffer.alloc(limit + 1).toString('base64') })
    assert.equal(rejected.status, 400)
    assert.match((await rejected.json()).error, /上限 10 MB/)
    const tooLargeRequest = await post({ name: 'a.pdf', dataBase64: 'AAAA', note: 'x'.repeat(15 * 1024 * 1024) })
    assert.equal(tooLargeRequest.status, 400)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(workspace, { recursive: true, force: true })
  }
})
