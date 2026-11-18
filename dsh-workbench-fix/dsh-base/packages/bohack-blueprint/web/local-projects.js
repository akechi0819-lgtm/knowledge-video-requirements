// IndexedDB stores the entire project package, including binary assets.
export function openLocalProjects(indexedDB = globalThis.indexedDB) {
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('bohack-local-projects', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  async function run(mode, operation) {
    const db = await opened
    return new Promise((resolve, reject) => {
      const tx = db.transaction('projects', mode)
      const request = operation(tx.objectStore('projects'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () => reject(tx.error || request.error)
    })
  }
  return {
    save: project => run('readwrite', store => store.put(project)),
    get: id => run('readonly', store => store.get(id)),
    list: () => run('readonly', store => store.getAll()),
    remove: id => run('readwrite', store => store.delete(id)),
  }
}

// Transport is supplied by the host, which owns authentication and routing.
export function createProjectTransfer(store, transport) {
  return {
    async restore(id) {
      const project = await store.get(id)
      if (!project) throw new Error('本地项目不存在')
      return transport.create(project.snapshot)
    },
    async save(id, title, workspaceId) {
      const snapshot = await transport.exportProject(workspaceId)
      await store.save({ id, title, snapshot, updatedAt: new Date().toISOString() })
    },
  }
}
