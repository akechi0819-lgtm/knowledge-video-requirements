import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { parseBlueprint } from './blueprint.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const signature = (asset, style) => 'asset:' + hash([asset.ledgerId || asset.id, asset.name, asset.type, asset.description, style])
const styleId = style => style?.id || 'general'
const oldStyle = style => hash(style)
export const assetMime = file => ({ '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' })[path.extname(file).toLowerCase()]

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, file)
}

export async function assetFile(root, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('assets/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('素材路径不在交付目录。')
  const sourceRoot = await realpath(path.join(root, 'assets'))
  const file = await realpath(path.join(root, relative))
  if (!file.startsWith(sourceRoot + path.sep)) throw new Error('素材文件越界。')
  return file
}

export const readAssetManifest = directory => optionalJson(path.join(directory, 'assets/manifest.json'), null)

export async function copyAssetPool(directory, style, pool) {
  const assets = []
  const seen = new Set()
  for (const entry of pool) {
    if (!entry.asset) {
      // Historical approvals contain one persisted SVG rather than a manifest.
      const extension = path.extname(entry.path).toLowerCase()
      if (!assetMime(entry.path) || !/^[\w-]+$/.test(entry.id)) throw new Error('历史素材文件无效。')
      const relative = `assets/${entry.id}${extension}`
      if (seen.has(relative)) throw new Error(`交付素材路径重复：${relative}`)
      await mkdir(path.join(directory, 'assets'), { recursive: true })
      await copyFile(entry.path, path.join(directory, relative))
      assets.push({ id: entry.id, name: entry.name, type: entry.type, sections: entry.sections, files: [{ variant: '默认', path: relative }] })
      seen.add(relative)
      continue
    }
    const { asset, root } = entry
    for (const relative of new Set([asset.sourceScript, ...asset.files.flatMap(file => [file.path, file.preview])].filter(Boolean))) {
      if (relative === 'assets/manifest.json' || seen.has(relative)) throw new Error(`交付素材路径重复：${relative}`)
      seen.add(relative)
      const source = await assetFile(root, relative)
      const target = path.join(directory, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(source, target)
    }
    assets.push(asset)
  }
  const manifest = { version: 1, producer: 'code-agent', styleId: styleId(style), assets }
  await atomicJson(path.join(directory, 'assets/manifest.json'), manifest)
  return manifest
}

export function createGeneratedAssets(root) {
  let mutating = false
  const directory = version => path.join(root, 'outbox', `素材_v${version}`)
  const stateFile = version => path.join(directory(version), '状态.json')

  async function readState(version, doc, style) {
    if (!Number.isInteger(version) || version < 1 || !Array.isArray(doc?.assets)) throw new Error('蓝图版本或素材清单无效。')
    const state = await optionalJson(stateFile(version), { entries: {} })
    state.entries = Object.assign(Object.create(null), state.entries)
    if (Object.values(state.entries).some(entry => entry.signature && !entry.signature.startsWith('asset:'))) {
      let original
      try { original = parseBlueprint(await readFile(path.join(root, 'outbox', `蓝图_v${version}.md`), 'utf8')).assets }
      catch (error) { if (error.code !== 'ENOENT') throw error; original = doc.assets }
      const oldSignature = hash({ assets: original, style })
      for (const asset of doc.assets) {
        const entry = state.entries[asset.id], previous = original.find(a => a.id === asset.id)
        if (entry?.signature === oldSignature && previous && previous.description === asset.description && previous.name === asset.name && previous.type === asset.type)
          entry.signature = signature(asset, style)
      }
    }
    return state
  }

  const autoPlan = (state, doc, style) => !doc.assets.length && state.auto?.style === oldStyle(style) ? state.auto : null
  async function persisted(version, entry, plan, style) {
    if (!entry || plan && entry.signature !== signature(plan, style)) return null
    try {
      if (entry.asset) {
        if (!/^[\w-]+$/.test(entry.revision)) throw new Error('素材版本编号无效。')
        const build = path.join(directory(version), 'build', entry.revision)
        const first = await assetFile(build, entry.asset.files[0].path)
        const asset = plan ? { ...entry.asset, sections: plan.sections } : entry.asset
        return { ...asset, asset, root: build, revision: entry.revision, path: first, approved: true }
      }
      if (!entry.filename || path.basename(entry.filename) !== entry.filename || !assetMime(entry.filename)) throw new Error('历史素材版本无效。')
      const file = await realpath(path.join(directory(version), entry.filename))
      if (path.dirname(file) !== await realpath(directory(version))) throw new Error('历史素材文件越界。')
      return { ...plan, revision: entry.filename, path: file, approved: !!entry.approved }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }

  async function status({ version, doc, style }) {
    const state = await readState(version, doc, style)
    const auto = autoPlan(state, doc, style)
    const assets = []
    for (const plan of doc.assets.length ? doc.assets : (auto?.ids || []).map(id => state.entries[id]?.asset).filter(Boolean)) {
      const entry = await persisted(version, state.entries[plan.id], doc.assets.length ? plan : null, style)
      const url = entry && `/bohack/api/generated-asset-file?version=${version}&id=${encodeURIComponent(plan.id)}&rev=${encodeURIComponent(entry.revision)}`
      const variants = url && entry.asset ? entry.asset.files.map(file => ({
        variant: file.variant, previewUrl: `${url}&variant=${encodeURIComponent(file.variant)}`,
      })) : []
      assets.push({ ...plan, revision: entry?.revision || null, status: entry ? entry.approved ? 'approved' : 'generated' : 'pending', missingFile: Boolean(!entry && state.entries[plan.id]?.signature === signature(plan, style)), previewUrl: variants[0]?.previewUrl || url || null, variants })
    }
    return { ok: true, version, assets, allApproved: assets.every(asset => asset.status === 'approved') }
  }

  async function file({ version, doc, style, id, revision, variant }) {
    const state = await readState(version, doc, style)
    const plan = doc.assets.find(asset => asset.id === id)
    const entry = (plan || autoPlan(state, doc, style)?.ids.includes(id)) && await persisted(version, state.entries[id], plan, style)
    if (!entry || revision !== entry.revision) throw new Error('素材预览已过期，请重新查看。')
    if (!entry.asset) return entry.path
    const rendered = variant ? entry.asset.files.find(file => file.variant === variant) : entry.asset.files[0]
    if (!rendered) throw new Error('素材变体不存在。')
    return assetFile(entry.root, rendered.preview || rendered.path)
  }

  async function availableFiles({ version, doc, style }) {
    const state = await readState(version, doc, style)
    const approved = [], pending = []
    const auto = autoPlan(state, doc, style)
    for (const plan of doc.assets.length ? doc.assets : (auto?.ids || []).map(id => state.entries[id]?.asset).filter(Boolean)) {
      const entry = await persisted(version, state.entries[plan.id], doc.assets.length ? plan : null, style)
      if (entry?.approved) approved.push(entry)
      else pending.push(plan)
    }
    return { approved, pending, autonomousReady: Boolean(auto) && !pending.length }
  }

  async function prepare({ version, doc, style, planned, auto = false, regenerateAssetId, assetFeedback = '', previous = [], run }) {
    if (mutating) throw new Error('本创作已有素材正在制作。')
    mutating = true
    try {
      const { approved, autonomousReady } = await availableFiles({ version, doc, style })
      const allowed = new Set(planned.map(asset => asset.id))
      const cached = approved.filter(entry => auto || allowed.has(entry.id))
      for (const entry of previous) {
        if (!auto && !allowed.has(entry.asset.id)) continue
        const previousIndex = cached.findIndex(value => value.id === entry.asset.id)
        const plan = planned.find(asset => asset.id === entry.asset.id)
        const value = { ...entry, asset: plan ? { ...entry.asset, sections: plan.sections } : entry.asset, id: entry.asset.id }
        if (previousIndex < 0) cached.push(value)
        else cached[previousIndex] = value
      }
      const target = regenerateAssetId && (planned.find(asset => asset.id === regenerateAssetId) || cached.find(entry => entry.id === regenerateAssetId)?.asset)
      if (regenerateAssetId && !target) throw new Error('要重做的素材不存在。')
      const existing = cached.filter(entry => entry.id !== regenerateAssetId)
      const missing = planned.filter(asset => !existing.some(entry => entry.id === asset.id))
      if (target && !missing.some(asset => asset.id === target.id)) missing.push(target)
      if (!missing.length && (!auto || cached.length || autonomousReady)) return { pool: existing }
      const revision = randomUUID()
      const dir = path.join(directory(version), 'build', revision)
      const priorAssets = cached.filter(entry => entry.id === regenerateAssetId && entry.asset?.sourceScript).map(({ asset, root }) => ({ asset, root }))
      const manifest = await run({ dir, assets: missing, priorAssets, feedback: assetFeedback })
      const state = await readState(version, doc, style)
      const pool = [...existing]
      for (const asset of manifest.assets) {
        if (pool.some(entry => entry.id === asset.id)) throw new Error(`素材编号重复：${asset.id}`)
        const plan = planned.find(item => item.id === asset.id)
        state.entries[asset.id] = { signature: signature(plan || asset, style), revision, asset }
        pool.push({ id: asset.id, asset, root: dir })
      }
      if (auto) state.auto = { style: oldStyle(style), ids: pool.map(entry => entry.id) }
      await atomicJson(stateFile(version), state)
      return { pool, build: path.relative(root, dir) }
    } finally { mutating = false }
  }

  return { status, file, availableFiles, prepare }
}
