/**
 * ctx.bohack — the A (blueprint & main flow) capability service.
 *
 * Nine capabilities from A-SCOPE.md §6. Files are the ONLY source of truth:
 * every capability reads files, does its work, writes files, and returns a
 * structured result. Nothing is held in memory except a live agent handle
 * (an engine resource, not state) — see lib/engine.js.
 *
 * Manual file drops, the terminal, and the Web UI are therefore equivalent.
 */
import { readFile, writeFile, readdir, mkdir, stat, appendFile } from 'node:fs/promises'
import { createProduction } from './production.js'
import { createProjectModel } from './project-model.js'
import { createStyles } from './styles.js'
import { defaultProcessGuidance } from './process-guidance.js'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import {
  parseBlueprint, validateBlueprint, renderBlueprint, parseRequirement,
} from './blueprint.js'
import { loadRequirement, availableAdapters, InputError } from './input.js'

const STATE_FILE = '状态.json'
const FEEDBACK_FILE = '反馈.md'
const DELIVERY_FILE = '交付.md'
const REQUIREMENT_FILE = '需求.md'
const ADJUSTMENTS_FILE = '调整记录.md'
const DIALOGUE_FILE = '对话记录.md'
const ASSETS_FILE = 'assets.jsonl'

function now() { return new Date().toISOString() }
function pad(n) { return String(n).padStart(2, '0') }

export class ServiceError extends Error {
  constructor(message, code = 'BOHACK_ERROR') { super(message); this.code = code }
}

// A semantic tool request must also be grounded in an affirmative current message.
export function explicitProductionApproval(message) {
  const text = String(message).trim()
  if (/[?？“”「」『』"]/.test(text) || /不|没|别|取消|暂缓|如果|假如|假设|是否|能否|可以吗|怎么|如何|讨论|举例|引用/.test(text)) return false
  return /(确认|认可|同意|通过|采纳)/.test(text) && /(全部|所有|整(个|体|份|版)|全(部|段)|当前|这(版|份|个|一版))/.test(text) && /(蓝图|段落|分段|这版|这一版)/.test(text) && /(生成|制作|做|开始|出).{0,12}(成片|视频)|(?:成片|视频).{0,12}(生成|制作|开始)/.test(text)
}

export function createService(ctx, config = {}) {
  const root = path.resolve(config.workspace || './workspace')
  const dirs = {
    root,
    inbox: path.join(root, 'inbox'),
    outbox: path.join(root, 'outbox'),
    rules: path.join(root, 'rules'),
    runs: path.join(root, 'runs'),
    dialogue: path.join(root, 'dialogue'),
    sources: path.join(root, 'sources'),
  }
  const projectModel = createProjectModel(config.styleLibraryRoot || root)
  const productionService = createProduction(root, { ...config, projectModel })
  const styles = createStyles(root, config.styleLibraryRoot || root)
  const log = (...a) => { try { ctx.logger?.info?.('[bohack]', ...a) } catch { /* ignore */ } }

  async function ensureDirs() {
    for (const d of Object.values(dirs)) await mkdir(d, { recursive: true })
  }

  const statePath = () => path.join(dirs.outbox, STATE_FILE)
  const requirementPath = () => path.join(dirs.inbox, REQUIREMENT_FILE)
  const feedbackPath = () => path.join(dirs.outbox, FEEDBACK_FILE)
  const deliveryPath = () => path.join(dirs.outbox, DELIVERY_FILE)
  const versionPath = (n) => path.join(dirs.outbox, `蓝图_v${n}.md`)
  const stylePath = (n) => path.join(dirs.outbox, `蓝图_v${n}.风格.json`)
  const visualPath = (n) => path.join(dirs.outbox, `蓝图_v${n}.视觉选择.json`)
  async function visualStyle(n) {
    if (!n) return null
    try { return { version: n, ...JSON.parse(await readFile(visualPath(n), 'utf8')) } }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    let style = null
    try { style = JSON.parse(await readFile(stylePath(n), 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    return { version: n, status: 'legacy', style }
  }
  async function selectVisualStyle({ id, version } = {}) {
    const n = await latestVersion(), state = await getState()
    if (!n || Number(version) !== n || state.stage !== 'finalized' || state.finalized?.version !== n) {
      throw new ServiceError('请先确认当前蓝图并定稿，再选择本版本的视觉参考。', 'STYLE_VERSION')
    }
    const result = await styles.select({ id })
    await writeFile(visualPath(n), JSON.stringify({ status: 'selected', style: result.style }, null, 2) + '\n', 'utf8')
    return { ...result, version: n }
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
  }
  async function writeJson(file, value) {
    await ensureDirs()
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  }
  async function exists(file) {
    try { await stat(file); return true } catch { return false }
  }

  /** Discover existing blueprint versions strictly from filenames. */
  async function versions() {
    await ensureDirs()
    const names = await readdir(dirs.outbox)
    return names
      .map(n => /^蓝图_v(\d+)\.md$/.exec(n))
      .filter(Boolean)
      .map(m => Number(m[1]))
      .sort((a, b) => a - b)
  }
  async function latestVersion() {
    const v = await versions()
    return v.length ? v[v.length - 1] : 0
  }
  async function readVersion(n) {
    const file = versionPath(n)
    if (!await exists(file)) throw new ServiceError(`蓝图版本 v${n} 不存在`, 'NOT_FOUND')
    return readFile(file, 'utf8')
  }

  async function getState() {
    return readJson(statePath(), {
      stage: 'empty', currentVersion: 0, confirmed: {}, locked: {}, finalized: null,
      lastRun: null, sessionId: null, createdAt: now(),
    })
  }
  async function setState(patch) {
    const prev = await getState()
    await writeJson(statePath(), { ...prev, ...patch, updatedAt: now() })
  }

  async function writeRun(record) {
    await ensureDirs()
    const id = `${now().replace(/[:.]/g, '-')}-${record.action || 'run'}`
    await writeJson(path.join(dirs.runs, `${id}.json`), { id, at: now(), ...record })
    return id
  }

  async function saveRequirement(raw, replaceBaseline = false) {
    const existing = await readFile(requirementPath(), 'utf8').catch(() => '')
    if (await latestVersion() && existing && existing !== raw) {
      if (!replaceBaseline) throw new ServiceError('已有蓝图的需求基线只读；只有明确批准重建基线才能更改。', 'BASELINE_LOCKED')
      const historyDir = path.join(dirs.inbox, '需求基线历史')
      await mkdir(historyDir, { recursive: true })
      await writeFile(path.join(historyDir, `${now().replace(/[:.]/g, '-')}-${randomUUID()}.md`), existing, 'utf8')
    }
    await writeFile(requirementPath(), raw, 'utf8')
    await setState({ requirementHash: createHash('sha256').update(raw).digest('hex'), requirementDirty: false })
  }

  // ── ingest ────────────────────────────────────────────────────────────────
  async function ingest(source = { kind: 'sample' }) {
    await ensureDirs()
    let loaded
    try { loaded = await loadRequirement(source, dirs) }
    catch (e) {
      if (e instanceof InputError) throw new ServiceError(e.message, 'BAD_INPUT')
      throw e
    }
    const header = [
      `> 来源：${loaded.provenance}`,
      `> 归一化时间：${now()}`,
      `> 输入适配器：${loaded.meta.adapter}`,
      '',
    ].join('\n')
    await saveRequirement(header + loaded.text, source.replaceBaseline === true)
    const parsed = parseRequirement(loaded.text)
    const state = await getState()
    await setState({
      stage: state.stage === 'empty' ? 'ingested' : state.stage,
      requirement: { ...loaded.meta, provenance: loaded.provenance, title: parsed.topic },
      requirementHash: createHash('sha256').update(header + loaded.text).digest('hex'), requirementDirty: false,
    })
    await writeRun({ action: 'ingest', adapter: loaded.meta.adapter, provenance: loaded.provenance })
    return {
      ok: true, path: 'inbox/' + REQUIREMENT_FILE,
      provenance: loaded.provenance, meta: loaded.meta,
      topic: parsed.topic, requirementCount: parsed.requirements.length,
    }
  }

  // ── show ──────────────────────────────────────────────────────────────────
  async function show({ version } = {}) {
    const n = version ?? await latestVersion()
    if (!n) return { ok: true, empty: true, sections: [], doc: null }
    const raw = await readVersion(n)
    const doc = parseBlueprint(raw)
    return { ok: true, version: n, file: `outbox/蓝图_v${n}.md`, raw, doc }
  }

  // ── validate ──────────────────────────────────────────────────────────────
  async function validate({ version, text } = {}) {
    let raw = text
    let n = version ?? await latestVersion()
    if (raw === undefined) {
      if (!n) return { ok: false, version: 0, errors: ['尚无蓝图，请先生成'], warnings: [], summary: '无产物' }
      raw = await readVersion(n)
    }
    const doc = parseBlueprint(raw)
    const result = validateBlueprint(doc, { quality: config.quality })
    return { ok: result.ok, version: n, ...result, sections: doc.sections.map(s => s.id) }
  }

  // ── confirm ───────────────────────────────────────────────────────────────
  async function confirm({ version, section, all = false } = {}) {
    const n = version ?? await latestVersion()
    if (!n) throw new ServiceError('没有可确认的蓝图', 'NOT_FOUND')
    const doc = parseBlueprint(await readVersion(n))
    const ids = doc.sections.map(s => s.id)
    const state = await getState()
    const confirmed = { ...(state.confirmed || {}) }
    const key = `v${n}`
    const current = new Set(confirmed[key] || [])
    if (all) for (const id of ids) current.add(id)
    else if (section) {
      if (!ids.includes(section)) throw new ServiceError(`段 ${section} 不在 v${n} 中`, 'BAD_SECTION')
      current.add(section)
    } else throw new ServiceError('需要指定 section 或 all:true', 'BAD_INPUT')
    confirmed[key] = [...current].sort()
    await setState({ confirmed, stage: 'confirmed' })
    await writeRun({ action: 'confirm', version: n, section: section || 'all' })
    return { ok: true, version: n, confirmed: confirmed[key], total: ids.length, allConfirmed: confirmed[key].length === ids.length }
  }

  // ── feedback ──────────────────────────────────────────────────────────────
  async function feedback({ section, text, author = '创作者' } = {}) {
    if (!text || !String(text).trim()) throw new ServiceError('反馈意见不能为空', 'BAD_INPUT')
    const n = await latestVersion()
    if (!n) throw new ServiceError('尚无蓝图，无法定位段落', 'NOT_FOUND')
    if (section) {
      const doc = parseBlueprint(await readVersion(n))
      if (!doc.sections.some(s => s.id === section)) throw new ServiceError(`段 ${section} 不在 v${n} 中`, 'BAD_SECTION')
    }
    await ensureDirs()
    const line = [
      '',
      `## ${now()} · 针对 v${n}${section ? ` / ${section}` : ' / 整体'}`,
      `- 提出人：${author}`,
      `- 意见：${String(text).trim()}`,
      '',
    ].join('\n')
    await appendFile(feedbackPath(), line, 'utf8')
    const state = await getState()
    await setState({ stage: 'feedback', pendingFeedback: { version: n, section: section || null, text: String(text).trim(), at: now() } })
    await writeRun({ action: 'feedback', version: n, section: section || null, text: String(text).trim() })
    return { ok: true, version: n, section: section || null, file: 'outbox/' + FEEDBACK_FILE }
  }

  // ── generate / revise (delegated to the engine) ───────────────────────────
  async function produce(action, options, engine, onProgress) {
    await ensureDirs()
    const requirementFile = requirementPath()
    if (!await exists(requirementFile)) throw new ServiceError('缺少 inbox/需求.md，请先 ingest', 'NO_REQUIREMENT')
    const requirementText = await readFile(requirementFile, 'utf8')
    const requirement = parseRequirement(requirementText)
    let rulesText = ''
    try { rulesText = await readFile(path.join(dirs.rules, 'blueprint.md'), 'utf8') } catch { /* optional */ }

    const skill = defaultProcessGuidance()
    const n = await latestVersion()
    const next = n + 1
    const state = await getState()
    let previousDoc = null
    if (action === 'revise') {
      if (!n) throw new ServiceError('没有可返工的蓝图', 'NOT_FOUND')
      previousDoc = parseBlueprint(await readVersion(n))
    }
    let feedbackText = ''
    try { feedbackText = await readFile(feedbackPath(), 'utf8') } catch { /* optional */ }

    const t0 = Date.now()
    let result
    try {
      result = await engine.produce({
        action, requirement, requirementText, rulesText, previousDoc, skill,
        textAssets: (await readAssetLines()).filter(a => a.type === 'text'),
        feedbackText, feedback: state.pendingFeedback || null,
        version: next, config, options, onProgress,
      })
    } catch (e) {
      await writeRun({ action, version: next, ok: false, engine: 'error', error: String(e?.message || e), ms: Date.now() - t0 })
      throw new ServiceError(`引擎失败：${e?.message || e}`, 'ENGINE_FAILED')
    }

    onProgress?.({ type: 'status', text: '正在校验并保存蓝图' })
    // The engine returns Markdown; parse + validate is the real shape guarantee.
    let doc = parseBlueprint(result.markdown)
    let check = validateBlueprint(doc, { quality: config.quality })
    let attempts = 1
    if (!check.ok && result.retry) {
      try {
        const retry = await result.retry({ errors: check.errors, warnings: check.warnings })
        if (retry?.markdown) {
          const retryDoc = parseBlueprint(retry.markdown)
          const retryCheck = validateBlueprint(retryDoc, { quality: config.quality })
          if (retryCheck.ok || retryCheck.errors.length < check.errors.length) {
            doc = retryDoc; check = retryCheck; result = { ...result, ...retry }
          }
          attempts++
        }
      } catch (e) { log('retry failed:', String(e)) }
    }

    // Render through the canonical renderer so hand-dropped files and engine
    // output share exactly one schema.
    doc.meta = {
      ...doc.meta,
      '版本': `v${next}`,
      '状态': '待确认',
      '引擎': result.engineLabel || result.engine || 'unknown',
      '来源': 'inbox/需求.md',
    }
    const canonical = renderBlueprint(doc)
    await writeFile(versionPath(next), canonical, 'utf8')
    await writeFile(path.join(dirs.outbox, `蓝图_v${next}.技能.json`), JSON.stringify(skill, null, 2) + '\n')
    await writeFile(visualPath(next), JSON.stringify({ status: 'pending', style: null }, null, 2) + '\n', 'utf8')

    const finalCheck = validateBlueprint(parseBlueprint(canonical), { quality: config.quality })
    const runId = await writeRun({
      action, version: next, ok: finalCheck.ok,
      engine: result.engine, realCall: !!result.realCall,
      webResearch: !!result.webResearch,
      engineLabel: result.engineLabel || result.engine,
      reason: result.reason || null,
      presetMounted: result.presetMounted ?? null,
      toolRegistered: result.toolRegistered ?? null,
      toolSubmitted: result.toolSubmitted ?? null,
      sessionId: result.sessionId || null, model: result.model || null,
      attempts, errors: finalCheck.errors, warnings: finalCheck.warnings,
      ms: Date.now() - t0,
    })
    await setState({
      stage: 'generated', currentVersion: next,
      lastRun: {
        runId, action, engine: result.engine, realCall: !!result.realCall,
        webResearch: !!result.webResearch,
        engineLabel: result.engineLabel || result.engine,
        reason: result.reason || null,
        presetMounted: result.presetMounted ?? null,
        toolRegistered: result.toolRegistered ?? null,
        validation: { ok: finalCheck.ok, errors: finalCheck.errors, warnings: finalCheck.warnings },
        at: now(), ms: Date.now() - t0,
      },
      confirmed: {}, pendingFeedback: null,
      sessionId: result.sessionId || state.sessionId || null,
    })
    return {
      ok: true, version: next, file: `outbox/蓝图_v${next}.md`,
      engine: result.engine, realCall: !!result.realCall, engineLabel: result.engineLabel || result.engine,
      model: result.model || null, attempts, validation: finalCheck, runId,
      sections: doc.sections.map(s => ({ id: s.id, title: s.title })),
    }
  }

  async function generate(options = {}, engine, onProgress) {
    const state = await getState()
    const raw = await readFile(requirementPath(), 'utf8').catch(() => '')
    const hash = createHash('sha256').update(raw).digest('hex')
    if (!raw || state.requirementDirty || (state.requirementHash && hash !== state.requirementHash) || (!state.requirementHash && await exists(dialoguePath()))) {
      throw new ServiceError('需求单尚未整理或已与最新对话不一致，请先明确要求整理需求。', 'NO_CURRENT_REQUIREMENT')
    }
    return produce('generate', options, engine, onProgress)
  }
  const revise = (options = {}, engine) => produce('revise', options, engine)

  // ── finalize ──────────────────────────────────────────────────────────────
  async function finalize() {
    const n = await latestVersion()
    if (!n) throw new ServiceError('没有可定稿的蓝图', 'NOT_FOUND')
    const state = await getState()
    const doc = parseBlueprint(await readVersion(n))
    const ids = doc.sections.map(s => s.id)
    const confirmed = (state.confirmed?.[`v${n}`] || [])
    const missing = ids.filter(id => !confirmed.includes(id))
    if (missing.length) throw new ServiceError(`还有未确认的段落：${missing.join(', ')}`, 'NOT_CONFIRMED')
    const check = validateBlueprint(doc, { quality: config.quality })
    if (!check.ok) throw new ServiceError(`蓝图校验未通过：${check.errors.join('；')}`, 'INVALID')

    const L = []
    L.push(`# 交付蓝图：${doc.topic || '未命名主题'}`)
    L.push('')
    L.push(`- **版本：** v${n}（已定稿）`)
    L.push(`- **定稿时间：** ${now()}`)
    L.push(`- **段落编号：** ${ids.join(' / ')}（返工时请引用编号）`)
    L.push(`- **本次生成：** ${state.lastRun?.engineLabel || '未记录'}（${state.lastRun?.realCall ? '真实模型调用' : '离线/预生成'}）`)
    L.push('')
    L.push('## 段落索引')
    L.push('')
    L.push('| 编号 | 标题 | 讲什么 |')
    L.push('| --- | --- | --- |')
    for (const s of doc.sections) L.push(`| ${s.id} | ${s.title} | ${String(s.intent).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)
    L.push('')
    L.push('## 使用说明')
    L.push('')
    L.push('- 本文件包含已确认的分段内容，对应的蓝图版本见同目录 `蓝图_v' + n + '.md`。')
    L.push('- 修改时可用段落编号定位，例如 B01。')
    L.push('- 每段列出讲述内容和画面意图。')
    L.push('')
    L.push('---')
    L.push('')
    L.push(await readVersion(n))
    await writeFile(deliveryPath(), L.join('\n'), 'utf8')
    await setState({ stage: 'finalized', finalized: { version: n, at: now(), file: 'outbox/' + DELIVERY_FILE } })
    await writeRun({ action: 'finalize', version: n })
    return { ok: true, version: n, file: 'outbox/' + DELIVERY_FILE, sections: ids }
  }

  // ── status ────────────────────────────────────────────────────────────────
  async function status() {
    await ensureDirs()
    const vs = await versions()
    const n = vs.length ? vs[vs.length - 1] : 0
    const state = await getState()
    let validation = null, sections = [], doc = null
    if (n) {
      doc = parseBlueprint(await readVersion(n))
      validation = validateBlueprint(doc, { quality: config.quality })
      sections = doc.sections.map(s => ({
        id: s.id, title: s.title, intent: s.intent,
        facts: s.facts || [], visual: s.visual, narration: s.narration,
        confirmed: (state.confirmed?.[`v${n}`] || []).includes(s.id),
      }))
    }
    const inboxNames = (await readdir(dirs.inbox).catch(() => [])).filter(x => !x.startsWith('.'))
    const outboxNames = (await readdir(dirs.outbox).catch(() => [])).filter(x => !x.startsWith('.'))
    const runNames = (await readdir(dirs.runs).catch(() => [])).filter(x => x.endsWith('.json')).sort().slice(-8)
    return {
      ok: true,
      workspace: 'workspace/', dirs: { inbox: 'inbox/', outbox: 'outbox/', rules: 'rules/', runs: 'runs/' },
      stage: state.stage, currentVersion: n, versions: vs,
      requirement: state.requirement || null,
      hasRequirement: await exists(requirementPath()),
      hasFeedback: await exists(feedbackPath()),
      hasDelivery: await exists(deliveryPath()),
      pendingFeedback: state.pendingFeedback || null,
      finalized: state.finalized || null, visualStyle: await visualStyle(n),
      locked: (state.locked || {})[`v${n}`] || [],
      confirmed: state.confirmed?.[`v${n}`] || [],
      sections, validation, doc,
      lastRun: state.lastRun || null, production: await productionService.status(),
      adapters: availableAdapters,
      inboxFiles: inboxNames, outboxFiles: outboxNames, recentRuns: runNames,
      engineAvailable: true,
    }
  }

  // ── trace (optional, covers acceptance item 6) ────────────────────────────
  // Chinese has no word separators, so match on character bi-grams instead of
  // whole punctuation-delimited phrases. This is a visible correspondence aid,
  // not a proof of semantic coverage — the UI labels it as such.
  function grams(text) {
    const s = String(text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim()
    const out = new Set()
    for (const w of s.split(/\s+/)) {
      if (!w) continue
      if (/^[a-zA-Z0-9]+$/.test(w)) { if (w.length >= 2) out.add(w.toLowerCase()); continue }
      for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2))
    }
    return [...out]
  }
  async function trace() {
    const n = await latestVersion()
    if (!n) throw new ServiceError('没有可追溯的蓝图', 'NOT_FOUND')
    const doc = parseBlueprint(await readVersion(n))
    const req = parseRequirement(await readFile(requirementPath(), 'utf8').catch(() => ''))
    const haystacks = doc.sections.map(s => ({
      id: s.id, text: `${s.title} ${s.intent} ${(s.facts || []).join(' ')} ${s.visual} ${s.narration || ''}`,
    }))
    const rows = req.requirements.map((text, i) => {
      const keys = grams(text)
      const scored = haystacks.map(h => ({
        id: h.id, score: keys.filter(k => h.text.includes(k)).length,
      })).filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
      const floor = Math.max(2, Math.ceil(keys.length * 0.12))
      const matches = scored.filter(x => x.score >= floor).slice(0, 3).map(x => x.id)
      return {
        requirement: text, index: i + 1, matches,
        coverage: keys.length ? Math.min(1, (scored[0]?.score || 0) / keys.length) : 0,
      }
    })
    return { ok: true, version: n, topic: doc.topic, rows, unmapped: rows.filter(r => !r.matches.length).length }
  }

  // ── lock (继承与锁定：创作者标记满意段落，换车时成为继承与锁定段) ────────────
  async function lock({ section, on = true } = {}) {
    const n = await latestVersion()
    if (!n) throw new ServiceError('尚无蓝图，无法锁定段落', 'NOT_FOUND')
    if (!section) throw new ServiceError('需要指定 section', 'BAD_INPUT')
    const doc = parseBlueprint(await readVersion(n))
    if (!doc.sections.some(s => s.id === section)) throw new ServiceError(`段 ${section} 不在 v${n} 中`, 'BAD_SECTION')
    const state = await getState()
    const locked = { ...(state.locked || {}) }
    const key = `v${n}`
    const set = new Set(locked[key] || [])
    if (on) set.add(section); else set.delete(section)
    locked[key] = [...set].sort()
    await setState({ locked })
    await appendFile(adjustmentsPath(), [
      '',
      `## ${now()} · ${on ? '锁定' : '解锁'} v${n} / ${section}`,
      on ? `- 语义：该段已标记为锁定。` : `- 语义：取消继承锁定。`,
      '',
    ].join('\n'), 'utf8')
    await writeRun({ action: 'lock', version: n, section, on: !!on })
    return { ok: true, version: n, section, locked: locked[key] }
  }

  // ── asset registry (资料资产契约) ──────────────────────────────────────────
  // One JSON object per line in workspace/assets.jsonl:
  //   {id, name, type: file|link|image|index, path, trust: vetted|unvetted|candidate,
  //    note, addedBy: 创作者|需求助手, addedAt}
  // The dialogue agent (standard tool face) appends entries per contract —
  // including materials it fetches from the web into workspace/sources/.
  // The creator approves (unvetted→vetted) or deletes entries from the UI.
  const assetsPath = () => path.join(root, ASSETS_FILE)

  async function readAssetLines() {
    const raw = await readFile(assetsPath(), 'utf8').catch(() => '')
    return raw.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(a => a && a.id)
  }

  async function listAssets() {
    const assets = await readAssetLines()
    return { ok: true, file: ASSETS_FILE, assets, empty: !assets.length }
  }

  async function addAsset(asset = {}) {
    await ensureDirs()
    const entry = {
      id: asset.id || `a${Date.now()}-${randomUUID().slice(0, 4)}`,
      name: String(asset.name || '未命名资产'),
      type: asset.type || 'file',
      path: String(asset.path || ''),
      trust: asset.trust || 'unvetted',
      note: String(asset.note || ''),
      addedBy: asset.addedBy || '创作者',
      addedAt: now(),
    }
    await appendFile(assetsPath(), JSON.stringify(entry) + '\n', 'utf8')
    await writeRun({ action: 'asset-add', id: entry.id, name: entry.name, by: entry.addedBy })
    return { ok: true, asset: entry }
  }

  async function updateAsset({ id, action } = {}) {
    const lines = await readAssetLines()
    const target = lines.find(a => a.id === id)
    if (!target) throw new ServiceError(`资产 ${id} 不存在`, 'NOT_FOUND')
    if (action === 'approve') {
      target.trust = 'vetted'
      target.approvedAt = now()
    } else if (action === 'delete') {
      // Registry entry removal only — the file stays in sources/ (dirty zone).
      // Physical deletion is a dirty-zone matter for the dialogue agent.
    } else throw new ServiceError(`未知操作 ${action}`, 'BAD_INPUT')
    const rest = lines.filter(a => a.id !== id)
    const out = action === 'approve' ? [...rest, target] : rest
    await writeFile(assetsPath(), out.map(a => JSON.stringify(a)).join('\n') + (out.length ? '\n' : ''), 'utf8')
    await writeRun({ action: `asset-${action}`, id })
    return { ok: true, id, action, asset: target }
  }

  /** Upload a dropped file into the dirty zone (sources/) and register it. */
  async function uploadAsset({ name, dataBase64, note } = {}) {
    if (!name || !dataBase64) throw new ServiceError('需要 name 与 dataBase64', 'BAD_INPUT')
    const safe = String(name).replace(/[\\/]/g, '_').slice(0, 120)
    await mkdir(dirs.sources, { recursive: true })
    const file = path.join(dirs.sources, `${Date.now()}-${safe}`)
    await writeFile(file, Buffer.from(dataBase64, 'base64'))
    const rel = 'sources/' + path.basename(file)
    const r = await addAsset({
      name: safe, type: /\.(png|jpe?g|gif|webp|svg)$/i.test(safe) ? 'image' : 'file',
      path: rel, trust: 'unvetted', note: String(note || '创作者拖入'), addedBy: '创作者',
    })
    return { ok: true, ...r }
  }

  // ── requirement dialogue (standard-preset session via the engine) ─────────
  const dialoguePath = () => path.join(dirs.dialogue, DIALOGUE_FILE)
  const adjustmentsPath = () => path.join(dirs.outbox, ADJUSTMENTS_FILE)

  async function chatContextText() {
    const reqRaw = await readFile(requirementPath(), 'utf8').catch(() => '')
    const n = await latestVersion()
    let blueprintSummary = '(尚无蓝图)'
    if (n) {
      const doc = parseBlueprint(await readVersion(n))
      blueprintSummary = [
        `当前蓝图：v${n}，主题「${doc.topic || '未命名'}」，共 ${doc.sections.length} 段：`,
        ...doc.sections.map(s => `- ${s.id}｜${s.title}`),
      ].join('\n')
    }
    return [
      `项目阶段：${(await getState()).stage || 'empty'}`,
      '',
      '## 当前需求单全文（inbox/需求.md，仅在创作者明确要求整理需求时更新它）',
      reqRaw ? reqRaw.slice(0, 12000) : '(还没有需求单——创作者的第一句话可能就是需求的起点)',
      '',
      '## 蓝图现状',
      blueprintSummary,
    ].join('\n')
  }

  async function appendDialogue(role, text) {
    await mkdir(dirs.dialogue, { recursive: true })
    const who = role === 'user' ? '创作者' : '需求助手'
    await appendFile(dialoguePath(), `\n## ${now()} · ${who}\n\n${String(text).trim()}\n`, 'utf8')
  }

  async function chat({ text, author = '创作者' } = {}, engine, onProgress) {
    const message = String(text || '').trim()
    if (!message) throw new ServiceError('消息不能为空', 'BAD_INPUT')
    await ensureDirs()
    const initialVersion = await latestVersion()
    const contextText = await chatContextText()
    const t0 = Date.now()
    const historyText = await readFile(dialoguePath(), 'utf8').catch(() => '')
    const activities = []
    const turnIndex = (historyText.match(/^## [^\n]+ · 创作者$/gm) || []).length
    function progress(event) {
      if (event.type === 'activity') activities.push({ turnIndex, text: event.text })
      onProgress?.(event)
    }
    let turn
    try { turn = await engine.chatTurn({ text: message, contextText, historyText, onProgress: progress }) }
    catch (e) {
      await writeRun({ action: 'chat', ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
      throw new ServiceError(`需求助手不可用：${e?.message || e}`, 'CHAT_FAILED')
    }
    let reply = typeof turn === 'string' ? turn : turn.reply
    for (const asset of turn?.textAssets || []) await addAsset({ ...asset, type: 'text', addedBy: '创作者' })
    let saveError = null
    if (turn?.requirementMarkdown) {
      const raw = String(turn.requirementMarkdown).trim() + '\n'
      try { await saveRequirement(raw, turn.replaceBaseline === true) }
      catch (e) { if (e.code !== 'BASELINE_LOCKED') throw e; saveError = e; reply = e.message }
    } else if (turn?.requirementChanged && !await latestVersion()) await setState({ requirementDirty: true })
    let production = null, productionError = null
    if (turn?.productionRequested) {
      try {
        if (!explicitProductionApproval(message)) throw new ServiceError('请明确确认当前蓝图全部段落，并明确要求开始制作成片。', 'CONFIRMATION_REQUIRED')
        const mentionedVersions = [...message.matchAll(/v(\d+)/gi)].map(m => Number(m[1]))
        if (!initialVersion || initialVersion !== await latestVersion() || mentionedVersions.some(n => n !== initialVersion)) throw new ServiceError('蓝图版本已变化，请查看当前版本后重新确认。', 'STALE_VERSION')
        const validation = await validate({ version: initialVersion })
        if (!validation.ok) throw new ServiceError(`蓝图校验未通过：${validation.errors.join('；')}`, 'INVALID')
        await confirm({ version: initialVersion, all: true })
        await finalize()
        const visual = await visualStyle(initialVersion)
        if (visual?.status === 'pending') {
          productionError = { code: 'STYLE_REQUIRED', message: '蓝图已定稿，请在成片页选择视觉参考，再开始制作。' }
          reply = productionError.message
        } else {
          onProgress?.({ type: 'status', text: '已确认蓝图，正在启动成片制作' })
          production = await productionService.start()
          reply = `已确认蓝图 v${initialVersion} 全部段落并定稿，成片制作已启动。可在成片页查看进度。`
        }
      } catch (e) {
        productionError = { code: e.code || 'PRODUCTION_FAILED', message: String(e.message || e) }
        reply = `成片制作未启动：${productionError.message}`
      }
    }
    await appendDialogue('user', message)
    await appendDialogue('assistant', reply)
    if (activities.length) {
      await appendFile(path.join(dirs.dialogue, '操作记录.jsonl'), activities.map(item => JSON.stringify(item)).join('\n') + '\n')
    }
    await writeRun({ action: 'chat', ok: true, chars: reply.length, ms: Date.now() - t0, author })
    let generation = null, generationError = null
    if (turn?.blueprintRequested) {
      try {
        if (saveError) throw saveError
        onProgress?.({ type: 'status', text: '开始生成蓝图' })
        generation = await generate({}, engine, onProgress)
      } catch (e) { generationError = { code: e.code || 'ENGINE_FAILED', message: String(e.message || e) } }
    }
    return { ok: true, reply, generation, generationError, production, productionError, sessionId: engine.chatSessionId || null, at: now() }
  }

  async function chatHistory() {
    const raw = await readFile(dialoguePath(), 'utf8').catch(() => '')
    const events = await readFile(path.join(dirs.dialogue, '操作记录.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const activities = events.trim() ? events.trim().split('\n').map(line => JSON.parse(line)) : []
    return { ok: true, file: 'dialogue/' + DIALOGUE_FILE, raw, activities, empty: !raw }
  }

  // ── manual section edit (the direct-control channel) ──────────────────────
  async function manualEdit({ section, fields = {} } = {}, engine) {
    const n = await latestVersion()
    if (!n) throw new ServiceError('尚无蓝图，无法手动编辑', 'NOT_FOUND')
    const doc = parseBlueprint(await readVersion(n))
    const target = doc.sections.find(s => s.id === section)
    if (!target) throw new ServiceError(`段 ${section} 不在 v${n} 中`, 'BAD_SECTION')

    const allowed = ['title', 'intent', 'facts', 'visual', 'narration']
    const changes = []
    for (const key of allowed) {
      if (!(key in fields)) continue
      const before = key === 'facts' ? [...(target[key] || [])] : (target[key] || '')
      let value = fields[key]
      if (key === 'facts') {
        if (!Array.isArray(value)) value = String(value).split('\n').map(s => s.trim()).filter(Boolean)
        target[key] = value
      } else {
        target[key] = String(value ?? '')
      }
      changes.push({ field: key, before: String(Array.isArray(before) ? before.join('；') : before).slice(0, 400), after: String(Array.isArray(value) ? value.join('；') : value).slice(0, 400) })
    }
    if (!changes.length) throw new ServiceError('没有可更新的字段', 'BAD_INPUT')

    const next = n + 1
    doc.meta = { ...doc.meta, '版本': `v${next}`, '状态': '待确认', '来源': '手动编辑' }
    const canonical = renderBlueprint(doc)
    await writeFile(versionPath(next), canonical, 'utf8')
    await writeFile(visualPath(next), JSON.stringify({ status: 'pending', style: null }, null, 2) + '\n', 'utf8')

    await ensureDirs()
    const lines = [
      '',
      `## ${now()} · 手动编辑 v${n} → v${next} / ${section}`,
      ...changes.map(c => `- ${c.field}：「${c.before}」→「${c.after}」`),
      '',
    ]
    await appendFile(adjustmentsPath(), lines.join('\n'), 'utf8')

    // Re-inject into the live blueprint session so context matches disk.
    let sessionNotified = false, notifyReason = null
    try {
      const noteText = [
        `创作者在 UI 手动编辑了 ${section}，已落盘为 v${next}（文件是唯一真相源，以文件为准）。`,
        ...changes.map(c => `- ${c.field} 现为：「${c.after}」`),
        '后续基于该段工作时，直接采用以上最新内容，不要恢复旧文本。',
      ].join('\n')
      const r = await engine.note(noteText)
      sessionNotified = !!r?.delivered
      notifyReason = r?.reason || null
    } catch (e) { notifyReason = String(e?.message || e) }

    const check = validateBlueprint(parseBlueprint(canonical), { quality: config.quality })
    const state = await getState()
    await setState({
      stage: state.stage === 'finalized' ? state.stage : 'generated',
      currentVersion: next,
      confirmed: {}, pendingFeedback: null,
    })
    await writeRun({ action: 'manual-edit', from: n, version: next, section, fields: changes.map(c => c.field), sessionNotified, validation: { ok: check.ok, errors: check.errors } })
    return {
      ok: true, version: next, section, changes, sessionNotified, notifyReason,
      validation: { ok: check.ok, errors: check.errors, warnings: check.warnings },
    }
  }

  /** Direct message to the live blueprint session (no file change). */
  async function note({ text, author = '创作者' } = {}, engine) {
    const message = String(text || '').trim()
    if (!message) throw new ServiceError('留言不能为空', 'BAD_INPUT')
    await ensureDirs()
    let r
    try { r = await engine.note(message) }
    catch (e) { r = { delivered: false, reason: String(e?.message || e) } }
    await appendFile(adjustmentsPath(), [
      '',
      `## ${now()} · 直接留言（${author}）`,
      `- 内容：${message.slice(0, 500)}`,
      `- 会话接收：${r.delivered ? '已送达活会话' : '未送达（' + (r.reason || '无活会话') + '），已记录在案，下次重跑时随反馈注入'}`,
      '',
    ].join('\n'), 'utf8')
    await writeRun({ action: 'note', delivered: !!r.delivered })
    return { ok: true, delivered: !!r.delivered, reason: r.reason || null }
  }

  async function adjustments() {
    const raw = await readFile(adjustmentsPath(), 'utf8').catch(() => '')
    return { ok: true, file: 'outbox/' + ADJUSTMENTS_FILE, raw, empty: !raw }
  }

  async function requirement() {
    const raw = await readFile(requirementPath(), 'utf8').catch(() => '')
    const state = await getState()
    return {
      ok: true, file: 'inbox/' + REQUIREMENT_FILE, raw, empty: !raw,
      meta: state.requirement || null,
    }
  }

  return {
    ingest, generate, show, validate, confirm, feedback, revise, finalize, status, trace,
    lock, chat, chatHistory, manualEdit, note, adjustments, requirement,
    listAssets, updateAsset, addAsset, uploadAsset, styles, selectVisualStyle, projectModel, production: productionService,
    _internal: { dirs, versions, latestVersion, readVersion, getState, setState, writeRun, ensureDirs },
  }
}
