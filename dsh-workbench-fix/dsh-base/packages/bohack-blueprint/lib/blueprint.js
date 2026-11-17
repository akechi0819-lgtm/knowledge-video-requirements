/**
 * Blueprint contract: parse / render / validate / requirement extraction.
 *
 * Pure Node, no DSH imports. This is the single place where the file contract
 * lives: both the real agent engine and the offline fallback produce documents
 * that go through parseBlueprint() + validateBlueprint() before they land in
 * outbox/. See workspace/rules/blueprint.md for the human-readable contract.
 */

export const CONTRACT_VERSION = 'bohack-blueprint/2'

/** Stable section ids: B01..B99, with optional lowercase suffix for inserts (B03a). */
export const SECTION_ID = /^B(\d{2})([a-z])?$/
const HEADER = /^###\s+(B\d{2}[a-z]?)\s*[｜|]\s*(.+?)\s*$/
const FIELD = /^\*\*(.+?)[：:]\*\*\s*(.*)$/

// 通用契约（跨项目稳定）只有讲什么 / 画面意图两项必填。
// 「关键事实」等内容门槛是本项目/本片的质量 policy（validateBlueprint 的 opts.quality），
// 不属于通用契约 —— 不要把单个视频的要求固化进契约，那是对着样例打补丁。
const REQUIRED_FIELDS = ['讲什么', '画面意图']
const OPTIONAL_FIELDS = ['关键事实', '旁白', '备注']

/** Words that signal the blueprint over-specifies implementation (warn, never hard-fail). */
const IMPLEMENTATION_HINTS = [
  '逐帧', '关键帧', '关键帧动画', '帧率', 'AE', 'After Effects',
  'CSS 动画', 'transform:', 'keyframes', 'ffmpeg', 'SVG 路径', '组件名',
]

/**
 * v2 content gate. These phrases describe *what should be written* instead of
 * writing it — the exact failure the creator flagged twice ("离完整科普还差得远").
 */
const PLACEHOLDER_PATTERNS = [
  '以核对后的资料为准', '以资料为准', '以核对为准', '待核对',
  '具体地区与年代', '具体年代与遗址名', '具体时间或路线',
  '不自行写死', '不新增台词', '讲解文案待创作者', '待创作者确认后补',
  '本段只讲', '这一段只负责', '本段只负责', '该讲哪一层',
  '讲到什么颗粒度', '以…为准', '观众应能复述', '让观众有获得感',
  '只给概念印象', '不宣布具体年代', '具体内容放到', '后面会逐层给出',
  '不自行添加史实', '文案待创作者',
]

/** Meta-narration in 讲什么: describing the writing instead of the content. */
const META_NARRATION = [
  '要让观众', '应能复述', '这一段负责', '本段负责', '这一段只负责',
  '后面会', '具体内容放到', '让观众有获得感', '本段承担', '只讲这一层',
]

/**
 * A fact must carry at least one concrete anchor to count as knowledge.
 * 只用通用规则 —— 不出现任何具体题目的专名表，否则校验器就是在背样例答案。
 */
export function hasFactAnchor(text) {
  const t = String(text || '')
  // 数字 / 年代
  if (/\d/.test(t)) return true
  if (/公元前|距今|世纪|年前|公元|年代|数千年|数百年/.test(t)) return true
  // 地理实体（通用中文后缀，如 特瓦坎谷 / 的的喀喀湖 / 安第斯山脉 / 某某洞穴）
  if (/[\u4e00-\u9fa5]{1,8}(省|市|县|区|镇|谷|湖|海|湾|山|山脉|河|江|溪|岛|群岛|半岛|高原|平原|盆地|沙漠|森林|洞穴|遗址|王朝|帝国)/.test(t)) return true
  // 引用出处（书名号 / 引号）
  if (/《.+?》|「.+?」/.test(t)) return true
  // 拉丁词 / 基因位点 / 学名 / 外语音译（fw2.2、Solanum、chuño…）
  if (/[A-Za-z][A-Za-z\d.]{2,}/.test(t)) return true
  // 具体枚举：一口气列出 ≥4 个具体对象的清单本身就是硬信息
  if (/、[^、，。]+、[^、，。]+、[^、，。]+/.test(t)) return true
  // 通用证据链 / 科学机制名词
  if (/出土|遗存|地层|化石|花粉|淀粉粒|文献|记载|器物|考古|基因组|测序|测定|基因|遗传|生物碱|驯化综合征/.test(t)) return true
  return false
}

/** Split the rendered 关键事实 line back into an array (round-trip safe). */
function splitFacts(text) {
  return String(text || '')
    .split(/[；;]\s*|\n+/)
    .map(s => s.trim()).filter(Boolean)
}

export function emptyDoc() {
  return {
    contract: CONTRACT_VERSION,
    topic: '',
    core: '',
    audience: '',
    order: '',
    userRequirements: [],
    sections: [],
    assets: [],
    notes: '',
    meta: {},
    raw: '',
  }
}

/** Parse a blueprint Markdown document into the contract shape. Tolerates missing meta. */
export function parseBlueprint(md) {
  const doc = emptyDoc()
  doc.raw = String(md ?? '')
  const lines = doc.raw.replace(/\r\n/g, '\n').split('\n')

  let section = null
  let zone = 'head'
  let buffer = []

  const flush = () => {
    if (section) {
      section.body = buffer.join('\n').trim()
      section.fields = parseFields(section.body)
      section.intent = section.fields['讲什么'] || ''
      section.facts = splitFacts(section.fields['关键事实'] || '')
      section.visual = section.fields['画面意图'] || ''
      section.narration = section.fields['旁白'] || ''
      section.notes = section.fields['备注'] || ''
      doc.sections.push(section)
    }
    buffer = []
  }

  for (const line of lines) {
    const h1 = /^#\s+蓝图[：:]\s*(.+?)\s*$/.exec(line)
    if (h1) { doc.topic = doc.topic || h1[1]; continue }

    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      flush(); section = null
      const t = h2[1]
      if (/整体内容|一、/.test(t)) zone = 'meta'
      else if (/用户明确|二、/.test(t)) zone = 'requirements'
      else if (/分段蓝图|三、/.test(t)) zone = 'sections'
      // The canonical renderer owns the "确认与交接" boilerplate. Collecting
      // its bullets into notes would duplicate them on the next render.
      else if (/资产清单/.test(t)) zone = 'assets'
      else if (/确认|交接|四、/.test(t)) zone = 'handoff'
      else if (/表述边界|五、|备注/.test(t)) zone = 'notes'
      else zone = 'other'
      continue
    }

    const sh = HEADER.exec(line)
    if (sh) {
      flush()
      section = { id: sh[1], title: sh[2].trim(), body: '', fields: {}, intent: '', visual: '', narration: '', notes: '' }
      continue
    }

    const kv = /^[-*]\s*\*\*(.+?)[：:]\*\*\s*(.*)$/.exec(line)
    if (kv && zone === 'meta') {
      const key = kv[1].trim(), value = kv[2].trim()
      if (/主题/.test(key)) doc.topic = value
      else if (/核心|意思/.test(key)) doc.core = value
      else if (/观众/.test(key)) doc.audience = value
      else if (/顺序|叙事/.test(key)) doc.order = value
      else if (/引擎|版本|状态|来源/.test(key)) doc.meta[key] = value
      continue
    }

    if (/^[-*]\s*\*\*(引擎|版本|状态|来源)[：:]\*\*\s*(.*)$/.test(line)) {
      const m = /^[-*]\s*\*\*(.+?)[：:]\*\*\s*(.*)$/.exec(line)
      doc.meta[m[1].trim()] = m[2].trim()
      continue
    }

    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line)
    if (bullet && zone === 'assets') {
      // 单条坏资产行只降级为跳过 + 警告，绝不能让整份蓝图解析失败。
      let asset
      try { asset = JSON.parse(bullet[1]) } catch { asset = null }
      if (asset && typeof asset === 'object' && typeof asset.id === 'string') doc.assets.push(asset)
      else {
        doc.warnings = doc.warnings || []
        doc.warnings.push(`资产清单行不是含 id 的 JSON 对象，已跳过：${bullet[1].slice(0, 80)}`)
      }
      continue
    }
    if (bullet && zone === 'requirements' && section === null) {
      doc.userRequirements.push(bullet[1].trim())
      continue
    }

    if (section) buffer.push(line)
    else if (zone === 'notes' && line.trim()) doc.notes += line + '\n'
    else if (zone === 'head') {
      const plain = /^[-*]\s*(.+?)\s*$/.exec(line)
      if (plain && /^主题[：:]/.test(plain[1])) doc.topic = plain[1].replace(/^主题[：:]\s*/, '')
      if (plain && /^核心意思[：:]/.test(plain[1])) doc.core = plain[1].replace(/^核心意思[：:]\s*/, '')
    }
  }
  flush()
  return doc
}

function parseFields(body) {
  const out = {}
  let current = null
  for (const line of body.split('\n')) {
    const m = FIELD.exec(line)
    if (m) {
      current = m[1].trim()
      out[current] = m[2].trim()
    } else if (current && line.trim()) {
      out[current] = (out[current] ? out[current] + '\n' : '') + line.trim()
    }
  }
  return out
}

/**
 * Validate a parsed doc.
 * opts.quality —— 本项目的内容质量 policy（可选，缺省 = 只查通用契约形态）：
 *   { facts: true,                 // 每段必填关键事实 + 锚点/占位话术门
 *     minFactsPerSection?: 1,      // 每段最少事实条数
 *     minDatedFacts?: 2,           // 全片最少带年代/数字的事实条数
 *   }
 * Returns { ok, errors, warnings, summary }.
 */
export function validateBlueprint(doc, opts = {}) {
  const errors = [], warnings = []
  const sections = doc.sections || []
  const q = opts.quality || null
  const factGate = !!(q && q.facts)

  if (!doc.topic) errors.push('缺少主题（# 蓝图：<主题> 或 整体内容里的主题）')
  if (sections.length < 2) errors.push(`段落少于 2 段（当前 ${sections.length} 段）`)

  const seen = new Set()
  for (const s of sections) {
    if (!SECTION_ID.test(s.id)) errors.push(`段 ${s.id} 编号不合法，应为 B01…B99（可带 a/b 后缀）`)
    if (seen.has(s.id)) errors.push(`段编号重复：${s.id}`)
    seen.add(s.id)
    for (const f of REQUIRED_FIELDS) {
      if (!s.fields?.[f]) errors.push(`段 ${s.id} 缺少「${f}」`)
    }
    for (const f of Object.keys(s.fields || {})) {
      if (!REQUIRED_FIELDS.includes(f) && !OPTIONAL_FIELDS.includes(f)) {
        warnings.push(`段 ${s.id} 有未定义字段「${f}」`)
      }
    }
    const hay = `${s.intent} ${s.visual} ${s.narration}`
    for (const w of IMPLEMENTATION_HINTS) {
      if (hay.includes(w)) warnings.push(`段 ${s.id} 可能越界指定实现：「${w}」`)
    }

    // ── 本项目质量 policy（不是通用契约）──────────────────────────────
    if (!factGate) continue
    const minFacts = Number(q.minFactsPerSection) > 0 ? Number(q.minFactsPerSection) : 1
    const facts = Array.isArray(s.facts) ? s.facts : splitFacts(s.fields?.['关键事实'] || '')
    if (facts.length < minFacts) {
      errors.push(`段 ${s.id}「关键事实」不足 ${minFacts} 条：给能被复述的硬知识（年代地点 / 可量化变化 / 机制 / 证据 / 事件节点），不要写「要讲什么层」`)
    }
    for (const f of facts) {
      const hit = PLACEHOLDER_PATTERNS.find(p => f.includes(p))
      if (hit) {
        errors.push(`段 ${s.id}「关键事实」是占位话术「${hit}」：把具体事实直接写出来，不确定性写进备注`)
      } else if (f.length < 15 || !hasFactAnchor(f)) {
        errors.push(`段 ${s.id}「关键事实」缺具体锚点（时间 / 地点 / 数字 / 证据 / 专名）或太短：「${f.slice(0, 26)}」`)
      }
    }
    const metaHits = META_NARRATION.filter(p => String(s.intent || '').includes(p)).length
    if (metaHits >= 2) warnings.push(`段 ${s.id}「讲什么」像在描述写法而不是内容（${metaHits} 处元叙述）`)
    const narrationHit = PLACEHOLDER_PATTERNS.find(p => String(s.narration || '').includes(p))
    if (narrationHit) warnings.push(`段 ${s.id}「旁白」用占位话术顶替内容：「${narrationHit}」`)
  }

  const assetIds = new Set()
  for (const a of doc.assets || []) {
    if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(a.id) || assetIds.has(a.id)) errors.push(`资产编号无效或重复（仅限字母、数字、下划线和连字符）：${a.id || '空'}`)
    assetIds.add(a.id)
    if (!a.name || !a.description || !['character', 'prop', 'background'].includes(a.type)) errors.push(`资产 ${a.id || '空'} 缺少名称、描述或类型不合法`)
    if (!Array.isArray(a.sections) || !a.sections.length || a.sections.some(id => !seen.has(id))) errors.push(`资产 ${a.id || '空'} 的关联段落无效`)
  }

  if (factGate && sections.length) {
    const allFacts = sections.flatMap(s => Array.isArray(s.facts) ? s.facts : [])
    const minDated = Number(q.minDatedFacts) > 0 ? Number(q.minDatedFacts) : 2
    const dated = allFacts.filter(f => /\d/.test(f) && /年前|世纪|公元前|公元|距今|年|倍|克|厘米|件|道|%|种/.test(f))
    if (dated.length < minDated) {
      errors.push(`全片只有 ${dated.length} 条带年代 / 数字的事实（本片要求至少 ${minDated} 条）：必须留得出观众能记住的硬信息`)
    }
    if (allFacts.length < sections.length) {
      warnings.push(`全片 ${allFacts.length} 条事实 / ${sections.length} 段，信息密度偏低；知识主体应占一半以上段落`)
    }
  }

  // Ids must start at B01 and stay ordered; gaps are reported but not fatal
  // because deleting a段留空号 is part of the agreed rework convention.
  if (sections.length) {
    if (sections[0].id !== 'B01') errors.push(`首段应为 B01，当前 ${sections[0].id}`)
    const nums = sections.map(s => parseInt(s.id.slice(1, 3), 10))
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] < nums[i - 1]) errors.push(`段编号顺序错乱：${sections[i - 1].id} → ${sections[i].id}`)
    }
  }

  // User requirements must be carried through (soft keyword match).
  const reqs = doc.userRequirements || []
  if (reqs.length === 0) warnings.push('未记录「用户明确要求」；若需求中确实没有可省略')
  const allText = sections.map(s => `${s.title} ${s.intent} ${s.visual}`).join('\n')
  for (const r of reqs) {
    const keys = extractKeywords(r)
    if (keys.length && !keys.some(k => allText.includes(k))) {
      warnings.push(`用户要求在分段中未明显体现：「${r.slice(0, 24)}」`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${sections.length} 段 · ${errors.length} 个错误 · ${warnings.length} 个提醒`,
  }
}

function extractKeywords(text) {
  const stop = /^(请|需要|希望|要|把|让|从|各段|段|视频|画面|并|以及|或|的|了|在|用|不|能|可|使)$/
  // 剥掉否定 / 情态前缀，只留名词核：否则「不要求写实人物」匹配不到
  // 蓝图里的「不出现写实人物」，造成否定式要求的永久误报。
  const strip = /^(不要求|不需要|无需|不要|不必|避免|禁止|尽量|最好|优先|可以|需要|要求|必须|使用|表现|呈现|采用|加入|不|请)+(?=[\u4e00-\u9fa5]{2,})/g
  return String(text)
    .replace(/[，。；、,.;：:（）()"「」【】\s]/g, ' ')
    .split(/\s+/)
    .flatMap(w => w.split(/或|及|和|与/))
    .map(w => w.replace(strip, ''))
    .filter(w => w.length >= 2 && !stop.test(w))
    .slice(0, 8)
}

/** Render the contract shape back to canonical Markdown. */
export function renderBlueprint(doc) {
  const L = []
  L.push(`# 蓝图：${doc.topic || '未命名主题'}`)
  L.push('')
  L.push(`- **版本：** ${doc.meta['版本'] || 'v1'}`)
  L.push(`- **状态：** ${doc.meta['状态'] || '待确认'}`)
  L.push(`- **引擎：** ${doc.meta['引擎'] || '未标注'}`)
  L.push(`- **来源：** ${doc.meta['来源'] || 'inbox/需求.md'}`)
  L.push('')
  L.push('## 一、整体内容')
  L.push('')
  if (doc.core) L.push(`- **核心意思：** ${doc.core}`)
  if (doc.audience) L.push(`- **目标观众：** ${doc.audience}`)
  if (doc.order) L.push(`- **叙事顺序：** ${doc.order}`)
  L.push('')
  L.push('## 二、用户明确要求')
  L.push('')
  if (doc.userRequirements.length) for (const r of doc.userRequirements) L.push(`- ${r}`)
  else L.push('- （需求文档未明确提出必须遵守的呈现要求）')
  L.push('')
  L.push('## 三、分段蓝图')
  L.push('')
  for (const s of doc.sections) {
    L.push(`### ${s.id}｜${s.title}`)
    L.push('')
    L.push(`**讲什么：** ${s.intent || ''}`)
    L.push('')
    const facts = Array.isArray(s.facts) ? s.facts : []
    if (facts.length) { L.push(`**关键事实：** ${facts.join('；')}`); L.push('') }
    L.push(`**画面意图：** ${s.visual || ''}`)
    L.push('')
    if (s.narration) { L.push(`**旁白：** ${s.narration}`); L.push('') }
    if (s.notes) { L.push(`**备注：** ${s.notes}`); L.push('') }
  }
  L.push('## 资产清单')
  L.push('')
  for (const asset of doc.assets || []) L.push(`- ${JSON.stringify(asset)}`)
  L.push('')
  L.push('## 四、确认与修改')
  L.push('')
  L.push('- 请在蓝图侧栏逐段查看、修改和确认。')
  L.push('- 全部段落确认后，可以定稿。')
  L.push('')
  if (doc.notes && doc.notes.trim()) {
    L.push('## 五、备注与表述边界')
    L.push('')
    L.push(doc.notes.trim())
    L.push('')
  }
  return L.join('\n')
}

/** Extract the minimal context the engines need from an upstream requirement doc. */
export function parseRequirement(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  const out = {
    topic: '', core: '', audience: '', feeling: '',
    requirements: [], explicit: [], suggestions: [], refs: [], boundaries: '', raw: src,
  }
  const pick = (label) => {
    const re = new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n###|\\n##|$)`)
    const m = re.exec(src)
    return m ? m[1].replace(/^>\s?/gm, '').trim() : ''
  }
  const pickH2 = (label) => {
    const re = new RegExp(`##\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`)
    const m = re.exec(src)
    return m ? m[1].replace(/^>\s?/gm, '').trim() : ''
  }
  out.topic = (pick('选题') || pickH2('主题').split('\n')[0] || (/^#\s*(.+)$/m.exec(src)?.[1] || ''))
    .replace(/^(视频需求|选题)[：:]\s*/, '').replace(/[《》]/g, '').trim()
  out.core = pick('核心意思')
  out.audience = pick('目标观众')
  out.feeling = pick('想达到的观看感受')

  // "三、交给蓝图同学" numbered list is the strongest signal for section intents.
  const handoff = /##\s*三、交给蓝图同学([\s\S]*?)(?=\n##\s|$)/.exec(src)
  if (handoff) {
    for (const line of handoff[1].split('\n')) {
      const m = /^\s*\d+[.、)]\s*(.+?)\s*$/.exec(line)
      if (m && !/^请基于|^蓝图需要/.test(m[1])) out.requirements.push(m[1].trim())
    }
  }
  const explicit = /###\s*用户明确的呈现要求([\s\S]*?)(?=\n###|\n##|$)/.exec(src)
  if (explicit) {
    for (const line of explicit[1].split('\n')) {
      const m = /^[-*]\s+(.+?)\s*$/.exec(line)
      if (m) out.explicit.push(m[1].trim())
    }
  }
  const boundary = /##\s*六、资料与表述边界([\s\S]*?)$/.exec(src)
  if (boundary) out.boundaries = boundary[1].trim()

  // Teammate format compat: `## 主题 / ## 想讲的内容 / ## 用户的明确要求`
  // (handover docs use h2 sections instead of our `### 选题…` h3 labels).
  if (!out.topic) {
    const m = /##\s*主题\s*\n+([\s\S]*?)(?=\n##\s|$)/.exec(src)
    if (m) out.topic = m[1].trim().split('\n')[0].replace(/^(视频需求|选题)[：:]\s*/, '').replace(/[《》]/g, '').trim()
  }
  if (!out.topic) out.topic = (/^#\s*(.+)$/m.exec(src)?.[1] || '').replace(/^(视频需求|选题)[：:]\s*/, '').replace(/[《》]/g, '').trim()
  if (!out.core) out.core = pickH2('想讲的内容')
  if (!out.explicit.length) {
    const block = /##\s*用户的明确要求([\s\S]*?)(?=\n##\s|$)/.exec(src)
    if (block) {
      for (const line of block[1].split('\n')) {
        const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
        if (m) out.explicit.push(m[1].trim())
      }
    }
  }

  // Teammate contract: 创意建议（待确认）is a proposal list, NOT a hard
  // requirement. Keeping it in a separate field is what stops the blueprint
  // engine from treating un-adopted ideas as binding constraints.
  const sugg = /###?\s*创意建议[^\n]*\n+([\s\S]*?)(?=\n##|\n###|$)/.exec(src)
  if (sugg) {
    for (const line of sugg[1].split('\n')) {
      const m = /^\s*(?:[-*]|\d+[.、)])\s*(.+?)\s*$/.exec(line)
      if (m && !/^（?待作者确认/.test(m[1])) out.suggestions.push(m[1].trim())
    }
  }

  // Teammate contract: the 本地引用查询 block lists scene-index files the
  // blueprint agent may query through the query_scene tool (never raw files).
  const refsBlock = /##\s*本地引用查询([\s\S]*?)(?=\n##\s|$)/.exec(src)
  if (refsBlock) {
    for (const m of refsBlock[1].matchAll(/\]\(\.{0,2}\/?([^)]+?\.json)\)/g)) {
      const file = m[1].trim()
      if (file && !out.refs.some(r => r.file === file)) out.refs.push({ file })
    }
  }
  return out
}
