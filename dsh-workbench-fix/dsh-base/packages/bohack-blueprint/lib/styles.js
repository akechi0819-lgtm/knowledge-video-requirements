import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledSkills, discoverSkillPackages } from './skill-packages.js'


const previews = Object.freeze({
  general: { kind: 'image', file: 'general.svg' },
  editorial: { kind: 'image', file: 'editorial.svg' },
  'andy-pixel-quest': { kind: 'video', file: 'andy.mp4' },
  'heychengc-concrete': { kind: 'video', file: 'hey.mp4' },
  'huashu-vox': { kind: 'image', file: 'huashu-vox.svg' },
  'huashu-whiteboard': { kind: 'image', file: 'huashu-whiteboard.svg' },
  'swiss-kinetic': { kind: 'image', file: 'swiss-kinetic.svg' },
  'vibe-night': { kind: 'image', file: 'vibe-night.svg' },
  'vibe-fable': { kind: 'image', file: 'vibe-fable.svg' },
})

function firstSentence(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/[。！？\n]/).find(part => part.trim())?.trim() || ''
}

function decorate(item, kind) {
  const summary = item.summary || firstSentence(item.description)
  const preview = item.preview || previews[item.id] || { kind: 'poster' }
  return { ...item, kind, summary, preview }
}

const builtins = Object.freeze([
  { id: 'general', name: '简洁知识图解', summary: '用清晰轮廓、大块留白和少量强调色，把关系与变化一步步讲明白。', description: '使用清晰的主体轮廓、大块留白和少量强调色，用短标签说明关系，按蓝图逐步呈现变化。', source: { kind: 'builtin', label: '工作台内置' } },
  { id: 'editorial', name: '杂志式图文', summary: '用鲜明标题、留白和图文组合组织信息，节奏沉稳，重点清晰。', description: '用鲜明标题、留白和图文组合组织信息，节奏沉稳，重点清晰。', source: { kind: 'builtin', label: '工作台内置' } },
])

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRepo = path.resolve(moduleDir, '../../../../..')

export async function collectRepoSkills(startDir) {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth <= 8; depth++, dir = path.dirname(dir)) {
    const skills = await discoverInstalledSkills({ repo: dir })
    if (skills.length) return skills.map(skillCard)
    const atRepo = await stat(path.join(dir, '.git')).then(() => true, error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (atRepo || path.dirname(dir) === dir) return []
  }
  return []
}

function skillCard({ id, name, description, source }) {
  return decorate({ id, name, description: description || name, source: source ? { ...source, kind: 'github', label: source.url || 'GitHub 仓库' } : { kind: 'builtin', label: '项目 Skill' } }, 'skill')
}

const queues = new Map()
async function exclusive(key, task) {
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task); queues.set(key, current)
  try { return await current } finally { if (queues.get(key) === current) queues.delete(key) }
}

export function createStyles(workspace, libraryRoot = workspace, { logger, repo = defaultRepo, kit = path.join(repo, 'video-kit'), skillsRoot = libraryRoot } = {}) {
  const library = path.join(libraryRoot, 'style-library.json')
  const selection = path.join(workspace, 'style-selection.json')
  const warn = (...args) => { try { logger?.warn?.('[bohack/styles]', ...args) } catch { /* ignore */ } }
  async function read(file, empty) {
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (e) {
      if (e.code === 'ENOENT') return empty
      if (e instanceof SyntaxError) { warn(`${path.basename(file)} 不是有效 JSON，按空内容处理：`, String(e.message)); return empty }
      throw e
    }
  }
  async function save(file, data) {
    const dir = path.dirname(file); await mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.style-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n'); await rename(temp, file)
  }
  async function list() {
    const [data, choice, installed, presets] = await Promise.all([
      read(library, { styles: [] }), read(selection, { selectedId: null }),
      discoverInstalledSkills({ repo, workspace: skillsRoot }), discoverSkillPackages(kit),
    ])
    const styles = [
      ...installed.map(skillCard),
      ...presets.filter(item => installed.some(skill => skill.folder === item.skill)).map(item =>
        decorate({ id: item.id, name: item.name, skillPackage: true, summary: item.summary,
          description: item.description || item.name, source: { kind: 'builtin', label: `项目 Skill：${item.skill}` } }, 'preset')),
      ...builtins.map(item => decorate(item, 'builtin')),
      ...data.styles.map(item => decorate(item, 'visual')),
    ]
    const current = styles.find(style => style.id === choice.selectedId)
    const selectedStyle = choice.style && current ? { ...choice.style, kind: current.kind } : choice.style || null
    return { ok: true, selectedId: choice.selectedId, selectedStyle, styles }
  }
  async function blueprintSkill() {
    return read(path.join(workspace, 'blueprint-skill.json'), null)
  }
  async function chooseBlueprintSkill({ id }) {
    const skill = id ? (await list()).styles.find(item => item.id === id) : null
    if (id && !skill) throw new Error('所选 Skill 不在当前风格库中。')
    const preset = skill?.kind === 'preset' && (await discoverSkillPackages(kit)).find(item => item.id === skill.id)
    const installed = skill && (await discoverInstalledSkills({ repo, workspace: skillsRoot })).find(item => preset ? item.folder === preset.skill : item.id === skill.id)
    const content = skill?.kind === 'skill' && installed ? await readFile(path.join(installed.dir, 'SKILL.md'), 'utf8') : skill?.description
    const bounded = (value, limit) => {
      let result = ''
      for (const char of String(value || '')) {
        if (Buffer.byteLength(result + char, 'utf8') > limit) break
        result += char
      }
      return result
    }
    const planning = installed ? { description: bounded(installed.description, 900), ...(preset?.mode && { mode: bounded(preset.mode, 120) }) } : undefined
    const snapshot = skill ? { id: skill.id, name: skill.name, content, description: skill.description, source: skill.source, kind: skill.kind, ...(planning && { planning }) } : null
    await save(path.join(workspace, 'blueprint-skill.json'), snapshot)
    return { ok: true, skill: snapshot }
  }
  async function selected() {
    const { selectedId, selectedStyle, styles } = await list()
    return selectedStyle || styles.find(s => s.id === selectedId) || null
  }
  async function importStyle({ name, description, source } = {}) {
    name = String(name || '').trim(); description = String(description || '').trim()
    if (!name || name.length > 120 || !description || description.length > 100000) throw new Error('请填写风格名称和正文（正文不超过 10 万字符）。')
    const kind = source?.kind
    if (!['text', 'file', 'web', 'video'].includes(kind)) throw new Error('请选择有效的风格来源。')
    const label = String(source?.label || '').trim().slice(0, 500)
    if (kind === 'web') {
      let url
      try { url = new URL(label) } catch { throw new Error('网页来源需要完整的 HTTP(S) 链接。') }
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('网页来源需要完整的 HTTP(S) 链接。')
    }
    const style = { id: randomUUID(), name, description, kind: 'visual', source: { kind, label } }
    return exclusive(library, async () => {
      const data = await read(library, { styles: [] }); data.styles.push(style); await save(library, data)
      return { ok: true, style }
    })
  }
  async function select({ id } = {}) {
    const { styles } = await list()
    const style = styles.find(s => s.id === id)
    if (!style) throw new Error('风格不存在。')
    await save(selection, { selectedId: id, style })
    return { ok: true, style }
  }
  async function update({ id, name, description } = {}) {
    name = String(name || '').trim(); description = String(description || '').trim()
    if (!name || name.length > 120 || !description || description.length > 100000) throw new Error('请填写风格名称和正文（正文不超过 10 万字符）。')
    return exclusive(library, async () => {
      const data = await read(library, { styles: [] })
      const item = data.styles.find(s => s.id === id)
      if (!item) throw new Error('个人风格不存在或不可编辑。')
      item.name = name; item.description = description
      await save(library, data); return { ok: true, style: item }
    })
  }
  async function remove({ id } = {}) {
    if ((await list()).styles.some(s => s.id === id && s.source?.kind === 'builtin')) throw new Error('内置风格不可移除。')
    return exclusive(library, async () => {
      const data = await read(library, { styles: [] })
      if (!data.styles.some(s => s.id === id)) throw new Error('风格不存在。')
      data.styles = data.styles.filter(s => s.id !== id); await save(library, data)
      return { ok: true }
    })
  }
  async function exportMarkdown({ id } = {}) {
    const { styles } = await list(); const style = styles.find(s => s.id === id)
    if (!style || style.kind !== 'visual') throw new Error('个人风格不存在。')
    return `---\nname: personal-style-${style.id}\ndescription: ${JSON.stringify(style.name)}\n---\n\n# ${style.name.replace(/[\r\n]/g, ' ')}\n\n## 设计规则\n\n${style.description}\n\n## 来源\n\n${style.source.label || style.source.kind}\n`
  }

  return { list, selected, blueprintSkill, chooseBlueprintSkill, importStyle, select, remove, update, exportMarkdown }
}
