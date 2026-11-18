import { createProjectTransfer } from './local-projects.js'

// The host supplies the transport and decides when a workspace is idle.
export function createProjectSession(store, transport, { onChange = () => {} } = {}) {
  const transfer = createProjectTransfer(store, transport)
  let current = null, dirty = false, saving = false, active = false

  function report(error = null) {
    onChange({ current, dirty, saving, active, error })
  }
  function requireIdle() {
    if (active || saving) throw new Error('项目正在处理，请等待完成')
  }
  function requireSaved() {
    requireIdle()
    if (dirty) throw new Error('项目尚未保存，请先保存')
  }
  return {
    list: () => store.list(),
    getState: () => ({ current, dirty, saving, active }),
    async create(id, title) {
      requireSaved()
      active = true; report()
      try {
        const workspace = await transport.create({ version: 1, files: [] })
        current = { id, title, workspaceId: workspace.id }
        dirty = true
        return current
      } finally { active = false; report() }
    },
    async open(id) {
      requireSaved()
      active = true; report()
      try {
        const project = await store.get(id)
        if (!project) throw new Error('本地项目不存在')
        const workspace = await transfer.restore(id)
        current = { id, title: project.title, workspaceId: workspace.id }
        dirty = false
        return current
      } finally { active = false; report() }
    },
    setActive(value) {
      if (value && saving) throw new Error('项目正在保存，请等待完成')
      active = value
      report()
    },
    markDirty() {
      if (!current) throw new Error('请先选择创作')
      if (saving) throw new Error('项目正在保存，请等待完成')
      dirty = true
      report()
    },
    async save(title = current?.title) {
      if (!current) throw new Error('请先选择创作')
      requireIdle()
      saving = true
      report()
      try {
        await transfer.save(current.id, title, current.workspaceId)
        current = { ...current, title }
        dirty = false
      } catch (error) {
        dirty = true
        report(error)
        throw error
      } finally {
        saving = false
        report()
      }
    },
    close() {
      requireSaved()
      current = null
      report()
    },
  }
}
