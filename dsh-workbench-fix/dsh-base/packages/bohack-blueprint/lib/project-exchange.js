import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const reserved = new Set(['.agents', '.dsh', '.dsh-home', 'rules', 'scene_retrieval.py', 'settings.json', 'project-model.private.json'])

function checkPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('无效的项目文件路径')
  if (reserved.has(name.split('/')[0].toLowerCase())) throw new Error('项目包包含服务端配置或指令')
  return name
}

// The caller owns the staging directory and publishes it only after setup succeeds.
export async function unpackProject(snapshot, staging) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files)) throw new Error('无效的项目包')
  const names = new Set()
  for (const file of snapshot.files) {
    const name = checkPath(file?.path)
    if (names.has(name) || typeof file.data !== 'string' || Buffer.from(file.data, 'base64').toString('base64') !== file.data) throw new Error('项目文件重复或内容无效')
    names.add(name)
  }
  await mkdir(staging, { recursive: true })
  for (const file of snapshot.files) {
    const target = path.join(staging, file.path)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(file.data, 'base64'), { flag: 'wx' })
  }
}

// Only workspaces created by this module are eligible for expiry.
export function createProjectExchange(root, { ttlMs, now = Date.now, isActive } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || typeof isActive !== 'function') throw new Error('必须提供有效的过期时间和活动检查')
  root = path.resolve(root)
  const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  const dir = id => { if (!validId(id)) throw new Error('无效的临时工作区 ID'); return path.join(root, id) }
  const metadataPath = id => path.join(dir(id), 'expiry.json')
  const workspace = id => path.join(dir(id), 'workspace')
  const expires = () => now() + ttlMs
  async function create(snapshot) {
    await mkdir(root, { recursive: true })
    const id = randomUUID(), staging = path.join(root, `${id}.creating`)
    try {
      await unpackProject(snapshot, path.join(staging, 'workspace'))
      await writeFile(path.join(staging, 'expiry.json'), JSON.stringify({ expiresAt: expires() }))
      await rename(staging, dir(id))
      return { id, workspace: workspace(id) }
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  }
  async function touch(id) {
    await readFile(metadataPath(id))
    await writeFile(metadataPath(id), JSON.stringify({ expiresAt: expires() }))
  }
  async function exportProject(id) {
    await readFile(metadataPath(id))
    const files = []
    async function visit(base, prefix = '') {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name
        if (/^production\/[^/]+\/film\/(frames|clips|checks|qa)$/.test(name)) continue
        if (!prefix && reserved.has(name.toLowerCase())) continue
        checkPath(name)
        const full = path.join(base, entry.name)
        if (entry.isDirectory()) await visit(full, name)
        else if (entry.isFile()) files.push({ path: name, data: (await readFile(full)).toString('base64') })
        else throw new Error(`不支持导出特殊文件：${name}`)
      }
    }
    await visit(workspace(id))
    files.sort ( (a, b) => a.path.localeCompare(b.path))
    return { version: 1, files }
  }
  async function cleanup() {
    await mkdir(root, { recursive: true })
    const removed = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue
      const meta = JSON.parse(await readFile(metadataPath(entry.name), 'utf8'))
      if (!Number.isFinite(meta.expiresAt)) throw new Error(`工作区过期时间无效：${entry.name}`)
      if (meta.expiresAt <= now() && !await isActive(entry.name)) {
        await rm(dir(entry.name), { recursive: true })
        removed.push(entry.name)
      }
    }
    return removed
  }
  return { create, workspace, touch, exportProject, cleanup }
}
