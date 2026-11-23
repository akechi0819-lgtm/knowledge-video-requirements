import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// A package belongs to the host; `skill` names an unchanged project Skill.
export async function discoverSkillPackages(kit) {
  const root = path.join(kit, 'skill-packages')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let manifest
    try { manifest = JSON.parse(await readFile(path.join(dir, '讲界.manifest.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (![manifest.id, manifest.name, manifest.skill].every(v => typeof v === 'string' && v.trim())) throw new Error(`制作包清单字段不完整: ${dir}`)
    if (path.basename(manifest.skill) !== manifest.skill) throw new Error(`制作包路径无效: ${dir}`)
    if (packages.some(p => p.id === manifest.id)) throw new Error(`制作包 ID 重复: ${manifest.id}`)
    packages.push({ ...manifest, dir })
  }
  return packages
}

export async function resolveSkillDir(name, repo, desktopWorkspace = process.env.JIANGJIE_DESKTOP_WORKSPACE) {
  for (const root of [desktopWorkspace, repo].filter(Boolean)) {
    try { return await realpath(path.join(root, '.agents', 'skills', name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error(`原版 Skill 未安装：${name}；请按项目安装说明安装上游资源。`)
}

// Parse the two scalar metadata fields used by the workbench. This intentionally
// supports YAML scalar syntax, not arbitrary YAML collections or aliases.
function doubleQuoted(value) {
  const escapes = { '0':'\0', a:'\x07', b:'\b', t:'\t', n:'\n', v:'\v', f:'\f', r:'\r', e:'\x1b', ' ':' ', '"':'"', '/':'/', '\\':'\\', N:'\u0085', _:'\u00a0', L:'\u2028', P:'\u2029' }
  let result = ''
  for (let i = 1; i < value.length; i++) {
    const char = value[i]
    if (char === '"') {
      if (!/^(?:\s*(?:#.*)?)?$/.test(value.slice(i + 1))) throw new Error('Skill 元数据引号后内容无效。')
      return result
    }
    if (char !== '\\') { result += char; continue }
    const escape = value[++i]
    if (Object.hasOwn(escapes, escape)) { result += escapes[escape]; continue }
    const length = { x:2, u:4, U:8 }[escape]
    const hex = value.slice(i + 1, i + 1 + length)
    if (!length || hex.length !== length || !/^[0-9a-f]+$/i.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) throw new Error('Skill 元数据转义无效。')
    result += String.fromCodePoint(Number.parseInt(hex, 16))
    i += length
  }
  throw new Error('Skill 元数据缺少结束引号。')
}

function scalar(value) {
  if (value.startsWith('"')) return doubleQuoted(value)
  if (value.startsWith("'")) {
    let result = ''
    for (let i = 1; i < value.length; i++) {
      if (value[i] !== "'") { result += value[i]; continue }
      if (value[i + 1] === "'") { result += "'"; i++; continue }
      if (!/^(?:\s*(?:#.*)?)?$/.test(value.slice(i + 1))) throw new Error('Skill 元数据引号后内容无效。')
      return result
    }
    throw new Error('Skill 元数据缺少结束引号。')
  }
  return value.startsWith('#') ? '' : value.replace(/\s+#.*$/, '').trim()
}

function blockScalar(lines, start, indicator) {
  const content = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() && !/^ +/.test(line)) break
    content.push(line)
  }
  const indents = content.filter(line => line.trim()).map(line => /^ */.exec(line)[0].length)
  const indent = indents.length ? Math.min(...indents) : 0
  const parts = content.map(line => line.trim() ? line.slice(indent) : '')
  let result = ''
  for (let i = 0; i < parts.length; i++) {
    result += parts[i]
    if (i + 1 < parts.length) {
      const current = parts[i], next = parts[i + 1]
      result += indicator[0] === '>' && !current && next && i > 0 ? '' : indicator[0] === '>' && current && next && !/^ /.test(current) && !/^ /.test(next) ? ' ' : '\n'
    }
  }
  if (parts.length) result += '\n'
  if (indicator.includes('-')) return result.replace(/\n+$/, '')
  if (indicator.includes('+')) return result
  return result.replace(/\n+$/, '') + (parts.length ? '\n' : '')
}

export async function readSkillMetadata(document, folder) {
  const frontmatter = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(document)?.[1]
  if (frontmatter === undefined) return { name: folder, description: '' }
  const lines = frontmatter.split(/\r?\n/)
  const fields = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^(name|description):(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i])
    if (!match) continue
    const raw = (match[2] || '').trim()
    fields[match[1]] = /^[>|][+-]?(?:\s+#.*)?$/.test(raw)
      ? blockScalar(lines, i + 1, raw.split(/\s/)[0]) : scalar(raw)
  }
  return { name: fields.name?.trim() || folder, description: fields.description || '' }
}

// Installed folders are the stable identity. A workspace folder overrides a
// repository folder with the same name, matching resolveSkillDir's precedence.
export async function discoverInstalledSkills({ repo, workspace } = {}) {
  const found = new Map()
  for (const base of [repo, workspace].filter(Boolean)) {
    const root = path.join(base, '.agents/skills')
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const folder = entry.name
      if (!/^[\w-]+$/.test(folder)) continue
      let dir, document
      try {
        dir = await realpath(path.join(root, folder))
        document = await readFile(path.join(dir, 'SKILL.md'), 'utf8')
      } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const { name, description } = await readSkillMetadata(document, folder)
      let source, checkoutDir
      const workspaceRoot = workspace && await realpath(workspace).catch(error => { if (error.code !== 'ENOENT') throw error })
      const storage = workspaceRoot && path.join(workspaceRoot, '.agents', '.github-skill-checkouts')
      if (storage && dir.startsWith(storage + path.sep)) {
        const [installation, checkout] = path.relative(storage, dir).split(path.sep)
        if (checkout === 'repo') {
          const holder = path.join(storage, installation)
          source = JSON.parse(await readFile(path.join(holder, 'source.json'), 'utf8'))
          checkoutDir = path.join(holder, 'repo')
        }
      }
      found.set(folder, { id: `repo-skill:${folder}`, folder, name, description, dir, ...(source && { source }), ...(checkoutDir && { checkoutDir }) })
    }
  }
  return [...found.values()]
}

export async function resolveProductionSkill({ kit, repo, workspace, style }) {
  const id = typeof style === 'string' ? style : style?.id
  if (!id) return null
  const skills = await discoverInstalledSkills({ repo, workspace })
  const legacyName = id.startsWith('repo-skill:') ? id.slice('repo-skill:'.length) : null
  const matches = legacyName ? skills.filter(skill => skill.name === legacyName) : []
  const direct = skills.find(skill => skill.id === id) || (matches.length === 1 ? matches[0] : null)
  if (direct) return { ...direct, skill: direct.folder, directory: direct.dir }
  if (legacyName || style?.kind === 'skill') throw new Error(`所选制作 Skill 不可用：${id}。请重新选择已安装的 Skill。`)
  const preset = (await discoverSkillPackages(kit)).find(item => item.id === id)
  if (!preset) {
    if (style?.kind === 'preset' || style?.skillPackage) throw new Error(`所选制作预设不可用：${id}。`)
    return null
  }
  const selected = skills.find(skill => skill.folder === preset.skill)
  if (!selected) throw new Error(`原版 Skill 未安装：${preset.skill}；请按项目安装说明安装上游资源。`)
  return { ...preset, directory: selected.dir }
}
