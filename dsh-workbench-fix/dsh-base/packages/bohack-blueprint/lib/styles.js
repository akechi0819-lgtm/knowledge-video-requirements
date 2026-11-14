import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const builtins = Object.freeze([
  { id: 'general', name: '简洁知识图解', description: '使用清晰的主体轮廓、大块留白和少量强调色，用短标签说明关系，按蓝图逐步呈现变化。', source: { kind: 'builtin', label: '工作台内置' } },
  { id: 'editorial', name: '杂志式图文', description: '用鲜明标题、留白和图文组合组织信息，节奏沉稳，重点清晰。', source: { kind: 'builtin', label: '工作台内置' } },
  { id: 'andy-pixel-quest', name: '像素闯关：地图与状态栏（Andy）', description: '以深靛色与亮黄色为主，使用清晰的像素边缘和有限色板。用冒险地图组织关卡，逐关呈现题目、选择与结果；按讲述内容安排进度或状态栏，最终汇总关键收获。地图和状态栏是可调整的设计建议，按题目制作。', source: { kind: 'builtin', label: '本地 .agents/skills/andy-vibe-knowledge/references/03-visual-systems.md 与 01-templates.md' } },
  { id: 'heychengc-concrete', name: '具象动态图解（HeyChengC 参考）', description: '先找到观众认得出的实物或场景，让讲述中的动作在画面中发生；先展示例子，再解释结论。让同一场景和道具跨句延续，每次突出一个变化；提问或结论可留白，不强配图。', source: { kind: 'builtin', label: '本地 .agents/skills/vibe-knowledge-film/SKILL.md（具象讲解规则）' } },
  { id: 'huashu-vox', name: '剪报调查：拼贴与标注', description: '用图片、纸片和短标题构成信息拼贴；以红线、框选或荧光笔标注引导注意力，让关键材料随讲述逐步出现。根据主题重新设计构图，不复用参考样片的固定场景。', source: { kind: 'builtin', label: 'https://github.com/alchaincyf/huashu-art-motion#看效果（Vox 解说语法）' } },
  { id: 'huashu-whiteboard', name: '白板手绘：关系逐步展开', description: '用简洁线稿建立对象与关系，沿着讲解顺序逐步揭示线条和标注；保留清晰留白，让新出现的关系成为焦点。', source: { kind: 'builtin', label: 'https://github.com/alchaincyf/huashu-art-motion#看效果（白板解说语法）' } },
  { id: 'swiss-kinetic', name: '瑞士动态排版：网格与大字', description: '以暖白和近黑为底，每个画面只用一个高对比强调色；大字沿非对称网格排列，保留大块留白，用线条和矩形组织层次。文字沿网格滑入，色块擦除或黑白反转作为节奏变化，避免装饰渐变和圆角卡片。', source: { kind: 'builtin', label: '本地 .agents/skills/motion-design-prompt-generator/design-systems/swiss-kinetic.md' } },
  { id: 'vibe-night', name: '夜曲知识实验：暗底光点', description: '以黑色背景、金白与青色点亮重点，为抽象概念设计可看见的小实验；保持统一配色，中心主体清晰，字幕与画面各有空间。光点只辅助表达，不替代必要的具象对象。', source: { kind: 'builtin', label: 'https://github.com/zhaosenlin12-creator/vibe-know--skill#-看看做出来什么样（C 夜曲）' } },
  { id: 'vibe-fable', name: '寓言场景：角色与变化仪表', description: '以人物或动物及明确场景承载行为机制，围绕一个持续可见的指标展示变化；同一角色和道具贯穿，结尾可回到开场场景，让变化本身说明结论。', source: { kind: 'builtin', label: 'https://github.com/zhaosenlin12-creator/vibe-know--skill#-最新一条-101-秒的完整成片（B 寓言）' } },
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
