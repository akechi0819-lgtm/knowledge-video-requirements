import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const builtins = Object.freeze([
  { id: 'general', name: '通用知识讲解', description: '以清楚、易读的方式讲解知识，具体画面与节奏由本片蓝图决定。', source: { kind: 'builtin', label: '工作台内置' } },
  { id: 'editorial', name: '杂志式图文', description: '用鲜明标题、留白和图文组合组织信息，节奏沉稳，重点清晰。', source: { kind: 'builtin', label: '工作台内置' } },
])

const queues = new Map()
async function exclusive(key, task) {
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task); queues.set(key, current)
  try { return await current } finally { if (queues.get(key) === current) queues.delete(key) }
}

export function createStyles(workspace, libraryRoot = workspace) {
  const library = path.join(libraryRoot, 'style-library.json')
  const selection = path.join(workspace, 'style-selection.json')
  async function read(file, empty) {
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return empty; throw e }
  }
  async function save(file, data) {
    const dir = path.dirname(file); await mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.style-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n'); await rename(temp, file)
  }
  async function list() {
    const [data, choice] = await Promise.all([read(library, { styles: [] }), read(selection, { selectedId: null })])
    return { ok: true, selectedId: choice.selectedId, selectedStyle: choice.style || null, styles: [...builtins, ...data.styles] }
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
    const style = { id: randomUUID(), name, description, source: { kind, label } }
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
    if (builtins.some(s => s.id === id)) throw new Error('内置风格不可移除。')
    return exclusive(library, async () => {
      const data = await read(library, { styles: [] })
      if (!data.styles.some(s => s.id === id)) throw new Error('风格不存在。')
      data.styles = data.styles.filter(s => s.id !== id); await save(library, data)
      return { ok: true }
    })
  }
  async function exportMarkdown({ id } = {}) {
    const { styles } = await list(); const style = styles.find(s => s.id === id)
    if (!style || style.source.kind === 'builtin') throw new Error('个人风格不存在。')
    return `---\nname: personal-style-${style.id}\ndescription: ${JSON.stringify(style.name)}\n---\n\n# ${style.name.replace(/[\r\n]/g, ' ')}\n\n## 设计规则\n\n${style.description}\n\n## 来源\n\n${style.source.label || style.source.kind}\n`
  }

  return { list, selected, importStyle, select, remove, update, exportMarkdown }
}
