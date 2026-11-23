import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const locks = new Map()
const nameKey = name => String(name || '').replace(/[\s《》""''「」·]/g, '').replace(/(?:示意|图示|底图|素材|背景|图)+$/g, '')
const sideOf = a => a.side || (a.type === 'text' ? 'blueprint' : 'videomake')
const keyOf = version => `v${version}`
async function readOptional(file, fallback) {
  try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}
export async function withAssetLock(workspace, fn) {
  const root = path.resolve(workspace)
  const previous = locks.get(root) || Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  locks.set(root, current)
  try { return await current } finally { if (locks.get(root) === current) locks.delete(root) }
}
async function load(root) {
  const raw = await readOptional(path.join(root, 'assets.jsonl'), '')
  const entries = raw.split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(entry => entry && entry.id)
  const synced = JSON.parse(await readOptional(path.join(root, 'asset-plan-sync.json'), '{}'))
  return { entries, synced }
}
async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, content)
  await rename(temp, file)
}
export async function writeAssetLedger(root, entries) {
  await atomicWrite(path.join(root, 'assets.jsonl'), entries.map(a => JSON.stringify(a)).join('\n') + (entries.length ? '\n' : ''))
}
async function save(root, entries, synced) {
  await mkdir(root, { recursive: true })
  await writeAssetLedger(root, entries)
  await atomicWrite(path.join(root, 'asset-plan-sync.json'), JSON.stringify(synced, null, 2) + '\n')
}
function project(entries, version) {
  const key = keyOf(version)
  return entries.filter(a => a.planBindings?.[key]?.sections?.length).map(a => ({
    ...a.planBindings[key], name: a.name, ledgerId: a.id,
  }))
}
function sync(entries, synced, version, doc, legacy) {
  const key = keyOf(version)
  if (synced[key]) return false
  for (const suggestion of doc.assets || []) {
    let entry = entries.find(a => sideOf(a) === 'videomake' && nameKey(a.name) === nameKey(suggestion.name) && !a.planBindings?.[key])
    if (!entry) {
      entry = { id: `a${Date.now()}-${randomUUID().slice(0, 4)}`, name: suggestion.name, type: 'file', path: '', trust: 'unvetted', note: suggestion.description, addedBy: '蓝图', addedAt: new Date().toISOString(), side: 'videomake', declared: true }
      entries.push(entry)
    }
    entry.planBindings ||= {}
    entry.planBindings[key] = { id: suggestion.id, type: suggestion.type, description: suggestion.description, sections: [...suggestion.sections] }
  }
  if (legacy) for (const entry of entries) {
    if (sideOf(entry) !== 'videomake' || entry.generatedAssetId || entry.type !== 'image' || entry.trust !== 'vetted' || !entry.path || entry.planBindings?.[key]) continue
    const sections = (doc.sections || []).filter(s => s.visual?.includes(entry.name)).map(s => s.id)
    if (!sections.length) continue
    entry.planBindings ||= {}
    entry.planBindings[key] = { id: `ledger-${entry.id}`, type: 'prop', description: entry.note || entry.name, sections }
  }
  synced[key] = true
  return true
}
export async function assetPlan(workspace, version, doc, options = {}) {
  const root = path.resolve(workspace)
  return withAssetLock(root, async () => {
    const { entries, synced } = await load(root)
    if (sync(entries, synced, version, doc, options.legacy !== false)) await save(root, entries, synced)
    return project(entries, version)
  })
}
export async function inheritAssetPlan(workspace, from, version, doc) {
  const root = path.resolve(workspace)
  return withAssetLock(root, async () => {
    const { entries, synced } = await load(root)
    const valid = new Set(doc.sections.map(s => s.id))
    for (const entry of entries) {
      const previous = entry.planBindings?.[keyOf(from)]
      if (!previous) continue
      const sections = previous.sections.filter(id => valid.has(id))
      if (sections.length) entry.planBindings[keyOf(version)] = { ...previous, sections }
    }
    synced[keyOf(version)] = true
    await save(root, entries, synced)
  })
}
export async function assignAssetPlan(workspace, version, doc, id, sections, type) {
  const root = path.resolve(workspace)
  return withAssetLock(root, async () => {
    const { entries, synced } = await load(root)
    sync(entries, synced, version, doc, true)
    const entry = entries.find(a => a.id === id)
    if (!entry || sideOf(entry) !== 'videomake') throw Object.assign(new Error('素材不存在或不是制作素材'), { code: 'BAD_INPUT' })
    const key = keyOf(version)
    const previous = entry.planBindings?.[key]
    if (sections.some(section => !previous?.sections.includes(section)) && !(entry.declared && !entry.path) && !/\.(png|jpe?g|svg|webp)$/i.test(entry.path || '')) throw Object.assign(new Error('关联段落需要待补素材声明或 PNG、JPEG、SVG、WebP 图片'), { code: 'BAD_INPUT' })
    entry.planBindings ||= {}
    if (!sections.length) { if (previous) entry.planBindings[key] = { ...previous, sections: [] } }
    else entry.planBindings[key] = { id: previous?.id || `ledger-${entry.id}`, type: type || previous?.type || 'prop', description: previous?.description || entry.note || entry.name, sections: [...sections] }
    await save(root, entries, synced)
    return { ok: true, asset: entry, assets: project(entries, version) }
  })
}
