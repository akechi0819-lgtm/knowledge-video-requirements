import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSession } from '../web/project-session.js'

test('本地项目保存后可恢复到新的工作区，未保存或运行中不得切换', async () => {
  const records = new Map()
  const store = { list: async () => [...records.values()], get: async id => records.get(id), save: async p => records.set(p.id, p) }
  let count = 0
  const snapshots = []
  const transport = {
    create: async snapshot => { snapshots.push(snapshot); return { id: `workspace-${++count}` } },
    exportProject: async id => ({ version: 1, files: [{ path: 'a', data: id }] }),
  }
  const session = createProjectSession(store, transport)
  await session.create('local-1', '标题')
  assert.throws(() => session.close(), /尚未保存/)
  session.setActive(true)
  await assert.rejects(session.save(), /正在处理/)
  session.setActive(false)
  await session.save()
  session.close()
  assert.equal((await session.open('local-1')).workspaceId, 'workspace-2')
  assert.deepEqual(snapshots[1], records.get('local-1').snapshot)
  session.markDirty()
  await assert.rejects(session.open('local-1'), /尚未保存/)
})

test('存储失败保留未保存状态且禁止关闭；事务完成前禁止并发写入', async () => {
  let finish
  const store = { save: () => new Promise((resolve, reject) => { finish = reject }), get: async () => null }
  const session = createProjectSession(store, { create: async () => ({ id: 'w' }), exportProject: async () => ({ version: 1, files: [] }) })
  await session.create('p', '标题')
  const save = session.save()
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => session.markDirty(), /正在保存/)
  assert.throws(() => session.setActive(true), /正在保存/)
  finish(new Error('存储空间不足'))
  await assert.rejects(save, /存储空间不足/)
  assert.equal(session.getState().dirty, true)
  assert.throws(() => session.close(), /尚未保存/)
})
