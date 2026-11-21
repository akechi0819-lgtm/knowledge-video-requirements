import { mkdir, writeFile, readFile, readdir, realpath, stat, rm, copyFile, rename } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { runVideoAgent } from './video-agent.js'
import { defaultProcessGuidance } from './process-guidance.js'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../../..')
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const str = { type: 'string' }

function normalizeEndpoint(baseUrl, suffix) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix
}

export async function runVideoJob({ ctx, sessionId, dir, production, kit, settings = {}, model, provider, reasoningEffort, feedback, previousDir, resume = false, onProgress, generateAsset }) {
  const jobStart = Date.now()
  const timingFile = path.join(dir, 'timings.jsonl')
  // Timing records contain names, timestamps and counts, never model text or keys.
  const timing = record => appendFileSync(timingFile, JSON.stringify(record) + '\n')
  async function measure(phase, task) {
    const start = Date.now()
    try { return await task() }
    finally { timing({ type: 'phase', phase, start, end: Date.now(), elapsed: Date.now() - start }) }
  }
  const scenes = path.join(dir, 'scenes'), film = path.join(dir, 'film'), audio = path.join(dir, 'audio-cache')
  const cwd = path.join(dir, 'video-agent')
  await Promise.all([mkdir(scenes, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(audio, { recursive: true })])
  const ids = new Set()
  for (const section of production.sections) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(section.id) || ids.has(section.id)) throw new Error('段号无效或重复')
    ids.add(section.id)
    if (previousDir && !resume) {
      try { await copyFile(path.join(previousDir, 'scenes', `${section.id}.html`), path.join(scenes, `${section.id}.html`)) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  }
  const skillNames = ['ai-teardown', 'andy-vibe-knowledge', 'motion-design-prompt-generator', 'vibe-knowledge-film']
  const selectedSkill = production.skill || defaultProcessGuidance()
  const skillId = selectedSkill.id || ''
  let folder = skillNames.find(name => skillId === `repo-skill:${name}`)
  // The repo's skill frontmatter may name itself differently from its folder.
  if (!folder && skillId.startsWith('repo-skill:')) {
    for (const name of skillNames) {
      const text = await readFile(path.join(repo, '.agents/skills', name, 'SKILL.md'), 'utf8')
      if (`repo-skill:${text.match(/^name:\s*(.+)$/m)?.[1]}` === skillId) { folder = name; break }
    }
    if (!folder) throw new Error('所选制作 Skill 不存在')
  }
  const customSkill = !skillId.startsWith('repo-skill:')
  folder ||= 'selected-skill'
  const skillDir = customSkill ? path.join(cwd, '.agents', 'skills', folder) : await realpath(path.join(repo, '.agents/skills', folder))
  if (customSkill) {
    const content = selectedSkill.content || selectedSkill.description
    if (!content?.trim()) throw new Error('所选制作 Skill 没有正文')
    await mkdir(skillDir, { recursive: true })
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: selected-video-skill\ndescription: 本次选定的视频制作规则\n---\n\n${body}`)
  }
  let visualSkillName = null
  if (production.style) {
    const visualText = production.style.description || production.style.content
    if (!visualText?.trim()) throw new Error('所选视觉风格没有正文')
    visualSkillName = 'film-visual-style'
    const visualDir = path.join(cwd, '.agents', 'skills', visualSkillName)
    await mkdir(visualDir, { recursive: true })
    await writeFile(path.join(visualDir, 'SKILL.md'), `---\nname: ${visualSkillName}\ndescription: 本次选定的视频视觉风格\n---\n\n${visualText}`)
  }
  const available = new Set()
  for (const section of production.sections) for (const item of [section.image, ...(section.assets || []).map(a => a.image)]) if (item) available.add(item)
  try {
    for (const name of await readdir(path.join(dir, '现成素材'))) if (/\.(png|jpe?g|svg|webp)$/i.test(name)) available.add(`现成素材/${name}`)
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const assets = [...available]
  const manifest = path.join(dir, 'asset-manifest.json')
  await writeFile(manifest, JSON.stringify({ root: dir, assets }))
  const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
  const voice = settings.tts?.voice ? `api:${settings.tts.voice}` : process.env.VIDEO_VOICE || (process.env.VOICE_NAME ? `api:${process.env.VOICE_NAME}` : style.tts.voice)
  const env = { ...process.env, VIDEO_ASSET_MANIFEST: manifest, ...(settings.tts?.baseUrl ? { VIDEO_TTS_ENDPOINT: normalizeEndpoint(settings.tts.baseUrl, settings.tts.protocol === 'mimo' ? '/chat/completions' : '/audio/speech'), VIDEO_TTS_KEY: settings.tts.apiKey || '' } : {}), ...(settings.tts?.model ? { VIDEO_TTS_MODEL: settings.tts.model } : {}), ...(settings.tts?.protocol ? { VIDEO_TTS_PROTOCOL: settings.tts.protocol } : {}) }
  const input = path.join(dir, 'tts-input.json'), result = path.join(audio, 'tts-result.json')
  await writeFile(input, JSON.stringify({ blueprint_id: production.version, segments: production.sections }))
  const { preparedFrames, seedTtsCache } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/pipeline.mjs')).href)
  if (previousDir && !resume) seedTtsCache(production.sections, path.join(previousDir, 'film', 'audio'), audio, { skipMissing: true })
  timing({ type: 'phase', phase: 'prepare', start: jobStart, end: Date.now(), elapsed: Date.now() - jobStart })
  await onProgress?.('生成配音')
  await measure('tts', () => exec(style.paths.python, [path.join(kit, 'WORK/modules/video/tts_driver.py'), input, audio, voice, style.tts.rate, style.paths.ffprobe, result], { env, maxBuffer: 32 * 1024 * 1024 }))
  const tts = JSON.parse(await readFile(result, 'utf8'))
  const durations = Object.fromEntries(tts.segments.map(s => [s.id, s.duration]))
  const frames = preparedFrames(production.sections.map(s => durations[s.id]), production.targetDurationSeconds, style.video.fps, style.timing.leadIn, style.timing.tailPad)
  const plans = Object.fromEntries(production.sections.map((s, i) => [s.id, { id: s.id, role: 'prepared_html', duration: frames[i] / style.video.fps, frames: frames[i], audioStart: style.timing.leadIn, audioDuration: durations[s.id], words: tts.segments.find(t => t.id === s.id).words || [], subtitle: { text: s.narration, start: style.timing.leadIn, end: style.timing.leadIn + durations[s.id] } }]))
  const prepared = { ...production, sections: production.sections.map(s => ({ ...s, scene: `${s.id}.html` })) }
  await writeFile(path.join(scenes, 'production.json'), JSON.stringify(prepared, null, 2))
  const skillText = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
  const skillName = skillText.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  if (!skillName) throw new Error('所选制作 Skill 缺少名称')
  const { installSceneRoutes } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/isolated-page.mjs')).href)
  const { chromium } = require(style.paths.playwright)
  async function preview(id, seconds) {
    if (!ids.has(id)) throw new Error('段号不存在')
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > plans[id].duration) throw new Error('预览时间无效')
    await onProgress?.('预览画面')
    const browser = await chromium.launch({ executablePath: style.paths.edge, headless: true, args: ['--disable-webrtc', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
    try {
      const context = await browser.newContext({ viewport: { width: style.video.width, height: style.video.height }, serviceWorkers: 'block' })
      await installSceneRoutes(context, path.join(scenes, `${id}.html`), dir, assets)
      const page = await context.newPage()
      const plan = plans[id]
      await page.addInitScript(([s, p]) => { window.STYLE = s; window.__PLAN__ = p; window.RTCPeerConnection = undefined; window.webkitRTCPeerConnection = undefined }, [style, plan])
      await page.goto('https://video.invalid/scenes/scene.html')
      await page.waitForFunction('typeof window.seek === "function"')
      await page.evaluate(t => window.seek(t), seconds)
      const image = await page.locator('#stage').screenshot({ type: 'png' })
      const previewDir = path.join(dir, 'previews')
      await mkdir(previewDir, { recursive: true })
      const imagePath = path.join(previewDir, `${id}-${seconds}.png`)
      await writeFile(imagePath, image)
      return { ok: true, image: { mimeType: 'image/png', data: image.toString('base64') }, imagePath, id, seconds }
    } finally { await browser.close() }
  }
  let submission
  let composed = false
  const revised = new Set()
  const savedScenes = []
  if (resume) for (const id of ids) {
    let html
    try { html = await readFile(path.join(scenes, `${id}.html`), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') continue; throw e }
    if (!html.trim()) continue
    savedScenes.push(id)
    if (previousDir && feedback) {
      let baseline
      try { baseline = await readFile(path.join(previousDir, 'scenes', `${id}.html`), 'utf8') }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (html !== baseline) revised.add(id)
    }
  }
  async function writeScene({ id, html }) {
    if (submission || composed) throw new Error('正在合成或已完成成片，不能继续修改画面')
    if (!ids.has(id)) throw new Error('段号不存在')
    if (typeof html !== 'string' || !html.trim()) throw new Error('HTML 为空')
    if (previousDir && feedback) {
      let baseline
      try { baseline = await readFile(path.join(previousDir, 'scenes', id + '.html'), 'utf8') }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (html === baseline) revised.delete(id)
      else revised.add(id)
    }
    await onProgress?.('编写画面')
    const target = path.join(scenes, id + '.html')
    const pending = path.join(dir, '.scene-' + randomUUID() + '.tmp')
    await writeFile(pending, html)
    await rename(pending, target)
    return { ok: true }
  }
  async function submitFilm(signal) {
    if (previousDir && feedback && revised.size === 0) throw new Error('本次要求返工。请先按意见修改对应段落，再合成。')
    for (const id of ids) await stat(path.join(scenes, `${id}.html`))
    await onProgress?.('配音与渲染')
    await rm(film, { recursive: true, force: true })
    await measure('render-compose', () => exec(process.execPath, [path.join(kit, 'WORK/modules/video/pipeline.mjs'), '--prepared', path.join(scenes, 'production.json'), '--out', film, '--voice', voice], { signal, env: { ...env, VIDEO_TTS_CACHE_DIR: audio }, maxBuffer: 32 * 1024 * 1024 }))
    await onProgress?.('自动质检')
    await measure('verify', () => exec(process.execPath, [path.join(kit, 'WORK/modules/video/verify.mjs'), path.join(film, 'mapping.json')], { signal, env, maxBuffer: 32 * 1024 * 1024 }))
    const report = JSON.parse(await readFile(path.join(film, 'verify-report.json'), 'utf8'))
    composed = true
    return { ok: true, report }
  }
  function submit(_args, signal) {
    if (submission) return submission
    submission = submitFilm(signal).catch(error => { submission = undefined; throw error })
    return submission
  }
  const tools = [
    { name: 'tts_durations', description: '读取各段真实配音时长（秒）', parameters: schema({}), execute: async () => ({ durations, plans }) },
    { name: 'write_scene', description: '写入一个段落的完整 HTML，包含 #stage 和 window.seek(t)', parameters: schema({ id: str, html: str }), execute: writeScene },
    { name: 'preview', description: '先用 write_scene 写入该段完整 HTML，再调用本工具渲染并查看该段某秒截图', parameters: schema({ id: str, seconds: { type: 'number' } }), execute: ({ id, seconds }) => preview(id, seconds) },
    { name: 'submit', description: '完成预览检查后调用：按真实配音渲染、合成并质检，通过后提交成片。失败会报错，不会提交。', parameters: schema({}), execute: submit },
  ]
  if (!customSkill) tools.unshift({ name: 'read_skill_file', description: '读取已选项目 Skill 明确引用的相对文本资料', parameters: schema({ file: str }), execute: async ({ file }) => { const target = await realpath(path.resolve(skillDir, file)); const root = await realpath(skillDir); if (!target.startsWith(root + path.sep)) throw new Error('只能读取当前 Skill 内资料'); return { file, text: await readFile(target, 'utf8') } } })
  if (resume) tools.push({ name: 'read_saved_scene', description: '读取本次任务已经保存的段落 HTML，继续编辑或预览', parameters: schema({ id: str }), execute: async ({ id }) => { if (!ids.has(id)) throw new Error('段号不存在'); return { id, html: await readFile(path.join(scenes, `${id}.html`), 'utf8') } } })
  if (previousDir) tools.push({ name: 'read_previous_scene', description: '读取上一版对应段落的 HTML，供按意见修改', parameters: schema({ id: str }), execute: async ({ id }) => { if (!ids.has(id)) throw new Error('段号不存在'); return { id, html: await readFile(path.join(previousDir, 'scenes', `${id}.html`), 'utf8') } } })
  if (generateAsset) tools.push({ name: 'generate_asset', description: '为未实现的声明素材生成候选，候选需作者确认', parameters: schema({ id: str }), execute: async ({ id }) => generateAsset({ id }) })
  const { skill: _skill, style: _style, ...blueprint } = production
  const prompt = `你是视频制作 Agent。完整制作方法 ${skillName} 已载入下文，不必重复调用 skill。保留方法中的讲述、设计与旁白对位标准；执行流程以本次网页制作契约为准：需求、蓝图和风格已确认，配音已生成；不重新选题、改旁白、提问或请求逐项确认，不执行本机脚本、不使用其他引擎。Skill 的历史个人偏好不代表本次用户要求。只有需要明确引用的相对资料时才用 read_skill_file，不猜文件名。用工具为每段创作独立 HTML/CSS/JS，不得执行主机代码。画布 #stage 为 1280×720，window.seek(t) 必须按秒确定画面；参考 window.__PLAN__ 和 window.STYLE。用 tts_durations 取实际配音时间，先 preview 检查画面和中途状态，必要时修正，再调用 submit 完成渲染、质检和提交；技术质检不代表已经完成事实核验或 OCR。图片通过 ../assets/文件名 或 ../现成素材/文件名引用；按蓝图意图选用已确认图片。未实现的声明只是创作线索，不得阻塞制作。\n完整制作方法：\n${skillText}\n蓝图：${JSON.stringify(blueprint)}\n可用图片：${JSON.stringify(assets)}\n视觉风格：${JSON.stringify(production.style || null)}\n修改意见：${feedback || '无'}${previousDir ? '\n本次为根据意见重新制作，可用 read_previous_scene 查看上一版对应段落。' : ''}`
  const resumeInstructions = resume ? `\n本次从中断处继续。已保存的段落：${JSON.stringify(savedScenes)}；尚未保存的段落：${JSON.stringify([...ids].filter(id => !savedScenes.includes(id)))}。先补写缺失的段落，默认复用已保存段落，不逐段读回 HTML；只有为了衔接缺失段落或修正已发现的问题才调用 read_saved_scene。` : ''
  const taskPrompt = `${prompt}${resumeInstructions}${customSkill ? '\n本次方法是完整的单篇正文，没有附带资料文件。不需要寻找 README、项目源码、模板或额外设计文档；按已给蓝图与视觉规则自由创作 HTML/CSS/JS。' : ''}\n本次执行顺序：tts_durations → ${resume ? '检查并补齐所有段落' : 'write_scene 写完全部段落'} → 每段只 preview 一张代表性画面 → submit 渲染、基础检查并提交。默认只审一轮；仅自动修复脚本或播放错误、主体缺失、严重遮挡，修复后只复查受影响段。实际脚本错误继续修到可运行，不因已经改过一轮就停止；静帧、装饰、排版偏好和审美建议只作提示，不拦交片、不自动返工。上述方法用于创作指导，不增加额外审稿轮次或用户确认。`
  await measure('agent', () => runVideoAgent({ ctx, sessionId, cwd, model, provider, reasoningEffort, prompt: taskPrompt, tools, onProgress, onTiming: timing }))
  if (!composed) throw new Error('视频 Agent 未完成成片')
  return { scenes, film }
}
