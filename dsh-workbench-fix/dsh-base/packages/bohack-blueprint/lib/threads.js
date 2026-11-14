import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService } from './service.js'
import { createEngine } from './engine.js'
import { parseRequirement } from './blueprint.js'

export function createThreads(ctx, config, legacyService, legacyEngine) {
  const root = path.resolve(config.workspace || './workspace')
  const threadsDir = path.join(root, 'threads')
  const instances = new Map()
  const validId = id => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)
  const threadDir = id => {
    if (!validId(id)) throw new Error('无效的会话 ID')
    return path.join(threadsDir, id)
  }
  async function legacyMetadata() {
    const read = async file => { try { return await readFile(path.join(root, file), 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } }
    const [requirement, dialogue, assets] = await Promise.all([read('inbox/需求.md'), read('dialogue/对话记录.md'), read('assets.jsonl')])
    let names = []
    try { names = await readdir(path.join(root, 'outbox')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!requirement.trim() && !dialogue.trim() && !assets.trim() && !names.some(n => /^蓝图_v\d+\.md$|^交付\.md$/.test(n))) return null
    const topic = parseRequirement(requirement).topic || /## [^\n]*创作者[^\n]*\n+([^\n]+)/.exec(dialogue)?.[1]?.trim().slice(0, 40) || '未命名'
    return { id: 'legacy', title: `历史项目 · ${topic}`, legacy: true }
  }
  async function metadata(id) {
    if (id === 'legacy') { const result = await legacyMetadata(); if (!result) throw new Error('历史项目不存在'); return result }
    return JSON.parse(await readFile(path.join(threadDir(id), 'thread.json'), 'utf8'))
  }
  async function syncInstructions(dir) {
    await Promise.all(['.agents', 'rules'].map(name =>
      cp(path.join(root, name), path.join(dir, name), { recursive: true })
    ))
  }
  async function create({ title } = {}) {
    const id = randomUUID()
    const dir = path.join(threadsDir, id + ".creating")
    await mkdir(dir, { recursive: true })
    // Only shared instructions are seeded; project data always starts empty.
    await syncInstructions(dir)
    await cp(fileURLToPath(new URL('../vendor/scene_retrieval.py', import.meta.url)), path.join(dir, 'scene_retrieval.py'))
    const at = new Date().toISOString()
    const thread = { id, title: String(title || '新会话').trim() || '新会话', createdAt: at, updatedAt: at }
    await writeFile(path.join(dir, 'thread.json'), JSON.stringify(thread, null, 2) + '\n')
    await rename(dir, threadDir(id))
    return thread
  }
  async function list() {
    await mkdir(threadsDir, { recursive: true })
    const names = await readdir(threadsDir, { withFileTypes: true })
    const threads = await Promise.all(names.filter(d => d.isDirectory() && validId(d.name)).map(d => metadata(d.name)))
    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const legacy = await legacyMetadata()
    return legacy ? [...threads, legacy] : threads
  }
  async function get(id) {
    if (!id) return { service: legacyService, engine: legacyEngine }
    if (id === 'legacy') { await metadata(id); return { service: legacyService, engine: legacyEngine } }
    await metadata(id) // Reject unknown threads instead of creating them implicitly.
    if (!instances.has(id)) {
      const threadConfig = { ...config, workspace: threadDir(id), styleLibraryRoot: root, settingsRoot: root }
      const instance = syncInstructions(threadConfig.workspace).then(() => ({
        service: createService(ctx, threadConfig), engine: createEngine(ctx, threadConfig)
      })).catch(error => { instances.delete(id); throw error })
      instances.set(id, instance)
    }
    return instances.get(id)
  }
  async function touch(id, title) {
    if (!id || id === 'legacy') return
    const thread = await metadata(id)
    if (thread.title === '新会话' && title) thread.title = String(title).trim().slice(0, 40) || thread.title
    thread.updatedAt = new Date().toISOString()
    await writeFile(path.join(threadDir(id), 'thread.json'), JSON.stringify(thread, null, 2) + '\n')
  }
  function reset() { for (const instance of instances.values()) instance.then(({ engine }) => engine.reset(), () => {}) }
  return { create, list, get, metadata, touch, reset }
}
