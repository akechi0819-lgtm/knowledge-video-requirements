import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createProjectExchange } from '../lib/project-exchange.js'
import { createProjectTransfer, openLocalProjects } from '../web/local-projects.js'

test('项目往返保留文字和二进制，排除服务端配置', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exchange-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exchange = createProjectExchange(root, { ttlMs: 100, isActive: () => false })
  const snapshot = { version: 1, files: [{ path: 'inbox/需求.md', data: Buffer.from('你好').toString('base64') }, { path: 'sources/图.png', data: Buffer.from([0, 255, 1]).toString('base64') }] }
  const first = await exchange.create(snapshot)
  await writeFile(path.join(first.workspace, 'settings.json'), 'secret')
  await writeFile(path.join(first.workspace, 'project-model.private.json'), '{"key":"private-model-key"}')
  await mkdir(path.join(first.workspace, 'production/job/film/frames'), {recursive:true})
  await writeFile(path.join(first.workspace, 'production/job/film/frames/one.png'), 'derived-frame')
  await mkdir(path.join(first.workspace, 'rules'))
  await writeFile(path.join(first.workspace, 'rules', 'rule.md'), 'rule')
  const exported = await exchange.exportProject(first.id)
  assert.doesNotMatch(JSON.stringify(exported), /private-model-key|project-model.private.json/)
  assert.deepEqual(exported.files.sort((a,b) => a.path < b.path ? -1 : 1), snapshot.files.sort((a,b) => a.path < b.path ? -1 : 1))
  const second = await exchange.create(exported)
  assert.equal(await readFile(path.join(second.workspace, 'inbox/需求.md'), 'utf8'), '你好')
  assert.deepEqual(await readFile(path.join(second.workspace, 'sources/图.png')), Buffer.from([0, 255, 1]))
  await symlink(path.join(root, 'outside'), path.join(first.workspace, 'link'))
  await assert.rejects(exchange.exportProject(first.id), /特殊文件/)
})

test('恢复包含 2 MiB 二进制文件的快照并逐字节校验', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exchange-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exchange = createProjectExchange(root, { ttlMs: 60000, isActive: () => false })
  const media = Buffer.alloc(2 * 1024 * 1024, Buffer.from([0, 127, 254, 255]))
  const file = { path: 'production/job/film/final.mp4', data: media.toString('base64') }
  const { workspace } = await exchange.create({ version: 1, files: [file] })
  assert.deepEqual(await readFile(path.join(workspace, file.path)), media)
})

test('拒绝路径穿越、配置文件、重复文件和错误内容', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exchange-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exchange = createProjectExchange(root, { ttlMs: 1, isActive: () => false })
  for (const files of [[{ path: '../secret', data: '' }], [{ path: 'settings.json', data: '' }], [{ path: 'a', data: '' }, { path: 'a', data: '' }], [{ path: 'a', data: '***' }]]) {
    await assert.rejects(exchange.create({ version: 1, files }))
  }
})

test('只清理过期且不活跃的托管工作区，touch 延长寿命', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exchange-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 0, active = new Set()
  const exchange = createProjectExchange(root, { ttlMs: 100, now: () => now, isActive: id => active.has(id) })
  const a = await exchange.create({ version: 1, files: [] })
  const b = await exchange.create({ version: 1, files: [] })
  const c = await exchange.create({ version: 1, files: [] })
  await mkdir(path.join(root, 'unmanaged'))
  now = 80; await exchange.touch(c.id); active.add(b.id); now = 100
  assert.deepEqual(await exchange.cleanup(), [a.id])
  await assert.rejects(exchange.exportProject(a.id))
  await exchange.exportProject(b.id); await exchange.exportProject(c.id)
  active.clear(); now = 181
  assert.deepEqual(new Set(await exchange.cleanup()), new Set([b.id, c.id]))
  assert.ok(await readFile(path.join(root, 'unmanaged', 'missing')).catch(e => e.code === 'ENOENT'))
})

test('传输完成后才覆盖本地项目，恢复使用保存的快照', async () => {
  const values = new Map([['p', { id: 'p', snapshot: 'old' }]])
  const store = { get: async id => values.get(id), save: async value => values.set(value.id, value) }
  let fail = true
  const transport = { create: async snapshot => snapshot, exportProject: async () => { if (fail) throw Error('network'); return { version: 1, files: [] } } }
  const transfer = createProjectTransfer(store, transport)
  await assert.rejects(transfer.save('p', '标题', 'w'), /network/)
  assert.equal(values.get('p').snapshot, 'old')
  fail = false; await transfer.save('p', '标题', 'w')
  assert.deepEqual(await transfer.restore('p'), { version: 1, files: [] })
  await assert.rejects(transfer.restore('missing'), /不存在/)
})

test('本地项目存储等待事务完成并支持列出、读取和删除', async () => {
  const records = new Map()
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = { objectStore() { return {
        put(value) { const req = { result: value.id }; queueMicrotask(() => { records.set(value.id, value); tx.oncomplete() }); return req },
        get(id) { const req = { result: records.get(id) }; queueMicrotask(() => tx.oncomplete()); return req },
        getAll() { const req = { result: [...records.values()] }; queueMicrotask(() => tx.oncomplete()); return req },
        delete(id) { const req = {}; queueMicrotask(() => { records.delete(id); tx.oncomplete() }); return req },
      } } }
      return tx
    },
  }
  const indexedDB = { open() { const req = { result: db }; queueMicrotask(() => { req.onupgradeneeded(); req.onsuccess() }); return req } }
  const store = openLocalProjects(indexedDB)
  const project = { id: 'project', snapshot: { version: 1, files: [] } }
  await store.save(project)
  assert.deepEqual(await store.get('project'), project)
  assert.deepEqual(await store.list(), [project])
  await store.remove('project')
  assert.equal(await store.get('project'), undefined)
})
