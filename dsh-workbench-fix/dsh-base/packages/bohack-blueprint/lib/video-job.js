import { mkdir, writeFile, readFile, readdir, stat, rm, copyFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { appendJsonl } from './skill-runtime.js'
import { runVideoAgent } from './video-agent.js'
import { loadManagedSkillGuidance } from './managed-skill-guidance.js'
import { defaultProcessGuidance } from './process-guidance.js'
import { resolveProductionSkill } from './skill-packages.js'
import { appRoot as repo, childEnvironment, emitDesktopDiagnostic, resolveTool } from './runtime.js'
import { buildCaptionCues } from '../../../../../video-kit/WORK/modules/video/captions.mjs'
import { creditHold, creditTitles, managedStageLayout, openManagedStage } from '../../../../../video-kit/WORK/modules/video/managed-stage.mjs'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const str = { type: 'string' }

function normalizeEndpoint(baseUrl, suffix) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix
}

export async function runVideoJob({ ctx, sessionId, dir, production, kit, settings = {}, model, provider, reasoningEffort, feedback, previousDir, resume = false, onProgress, skillsRoot = process.env.JIANGJIE_DESKTOP_WORKSPACE, executable }) {
  const selectedPackage = executable === undefined ? await resolveProductionSkill({ kit, repo, workspace: skillsRoot, style: production.style }) : executable
  const skillPackage = selectedPackage && await loadManagedSkillGuidance(selectedPackage)
  const jobStart = Date.now()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'commands.jsonl'), '', { flag: 'a', mode: 0o600 })
  // Timing records contain names, timestamps and counts, never model text or keys.
  const timing = record => appendJsonl(dir, 'timings.jsonl', record)
  async function measure(phase, task) {
    const start = Date.now()
    let result = 'failed'
    try {
      const value = await task()
      result = 'ok'
      return value
    } finally {
      emitDesktopDiagnostic('video', 'phase=' + phase + ' ' + result)
      timing({ type: 'phase', phase, start, end: Date.now(), elapsed: Date.now() - start })
    }
  }
  async function auditedExec(command, args, options) {
    const ts = new Date().toISOString(), start = Date.now()
    let exitCode = null, stderr = ''
    try {
      const result = await exec(command, args, { cwd: dir, ...options, env: childEnvironment(options.env, [command]), windowsHide: true })
      exitCode = 0
      stderr = result.stderr
      return result
    } catch (error) {
      exitCode = typeof error.code === 'number' ? error.code : null
      stderr = error.stderr || error.message
      throw error
    } finally {
      emitDesktopDiagnostic('video', stderr)
      const key = settings.tts?.apiKey
      if (key) stderr = stderr.replaceAll(key, '[REDACTED]')
      appendJsonl(dir, 'commands.jsonl', { ts, cmd: [command, ...args].map(arg => JSON.stringify(arg)).join(' '), exitCode, durationMs: Date.now() - start, stderrHead: stderr.slice(0, 1000), cwd: options.cwd || dir })
    }
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
  const chosen = production.skill
  const guidance = chosen && !['skill', 'preset'].includes(chosen.kind) && !chosen.id?.startsWith('repo-skill:')
    ? chosen : defaultProcessGuidance()
  const skillText = guidance.content || guidance.description
  const skillName = guidance.name || '自定义制作方法'
  if (!skillText?.trim()) throw new Error('所选制作方法缺少名称或正文')
  const available = new Set()
  for (const section of production.sections) for (const item of [section.image, ...(section.assets || []).flatMap(asset => [asset.image, ...(asset.variants || []).map(file => file.path)])]) if (item) available.add(item)
  try {
    for (const name of await readdir(path.join(dir, '现成素材'))) if (/\.(png|jpe?g|svg|webp)$/i.test(name)) available.add(`现成素材/${name}`)
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const assets = [...available]
  const manifest = path.join(dir, 'asset-manifest.json')
  await writeFile(manifest, JSON.stringify({ root: dir, assets }))
  const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
  let voice = settings.tts?.voice ? `api:${settings.tts.voice}` : process.env.VIDEO_VOICE || (process.env.VOICE_NAME ? `api:${process.env.VOICE_NAME}` : style.tts.voice)
  const python = style.paths.python || resolveTool('python', process.env, kit)
  const ffprobe = style.paths.ffprobe || resolveTool('ffprobe', process.env, kit)
  const ffmpeg = style.paths.ffmpeg
  const env = { ...process.env, ...(ffmpeg && { VIDEO_FFMPEG: ffmpeg }), VIDEO_ASSET_MANIFEST: manifest, ...(settings.tts?.baseUrl ? { VIDEO_TTS_ENDPOINT: normalizeEndpoint(settings.tts.baseUrl, settings.tts.protocol === 'mimo' ? '/chat/completions' : '/audio/speech'), VIDEO_TTS_KEY: settings.tts.apiKey || '' } : {}), ...(settings.tts?.model ? { VIDEO_TTS_MODEL: settings.tts.model } : {}), ...(settings.tts?.protocol ? { VIDEO_TTS_PROTOCOL: settings.tts.protocol } : {}) }
  const input = path.join(dir, 'tts-input.json'), result = path.join(audio, 'tts-result.json')
  const timings = path.join(dir, 'timings.json')
  await writeFile(input, JSON.stringify({ blueprint_id: production.version, segments: production.sections }))
  const { preparedFrames, seedTtsCache } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/pipeline.mjs')).href)
  if (previousDir && !resume) seedTtsCache(production.sections, path.join(previousDir, 'film', 'audio'), audio, { skipMissing: true })
  timing({ type: 'phase', phase: 'prepare', start: jobStart, end: Date.now(), elapsed: Date.now() - jobStart })
  await onProgress?.('生成配音')
  const synthesize = () => auditedExec(python, [path.join(kit, 'WORK/modules/video/tts_driver.py'), input, audio, voice, style.tts.rate, ffprobe, result], { env, maxBuffer: 32 * 1024 * 1024 })
  await measure('tts', async () => {
    try { await synthesize() }
    catch (error) {
      if (!voice.startsWith('api:') || typeof error.code !== 'number') throw error
      const requestedVoice = voice
      voice = process.platform === 'darwin' ? 'say:Tingting' : process.platform === 'win32' ? 'sapi' : style.tts.voice
      timing({ type: 'tts-fallback', requestedVoice, fallbackVoice: voice })
      await onProgress?.('配音服务失败，正在使用备用音色')
      await synthesize()
    }
  })
  const tts = JSON.parse(await readFile(result, 'utf8'))
  const results = new Map(tts.segments.map(segment => [segment.id, segment]))
  const durations = Object.fromEntries(production.sections.map(section => {
    const duration = results.get(section.id)?.duration
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`[${section.id}] 缺少有效配音时长`)
    return [section.id, duration]
  }))
  const fps = style.video.fps
  const frames = preparedFrames(production.sections.map(s => durations[s.id]), production.targetDurationSeconds, fps, style.timing.leadIn, style.timing.tailPad)
  const stage = managedStageLayout(style.video, skillPackage?.stage)
  const creditLines = stage.tailCard ? creditTitles(production.sections).map(source => `资料来源 · ${source}`) : []
  if (!creditLines.length && skillPackage?.stage.tailCard && production.topic) creditLines.push(production.topic)
  let cursor = 0
  const beats = production.sections.map((s, i) => {
    const start = cursor / fps
    const words = results.get(s.id).words || []
    const subtitle = { text: s.narration, start: style.timing.leadIn, end: style.timing.leadIn + durations[s.id] }
    const credits = i === production.sections.length - 1 ? creditLines.flatMap((text, index) => buildCaptionCues({
      text,
      start: subtitle.end + index * creditHold,
      end: subtitle.end + (index + 1) * creditHold,
    })) : []
    if (credits.length) frames[i] = Math.max(frames[i], Math.ceil(credits.at(-1).end * fps))
    cursor += frames[i]
    return { id: s.id, beatId: s.blueprintId || s.id, role: 'prepared_html', start, end: cursor / fps,
      title: s.title || s.id, duration: frames[i] / fps, frames: frames[i], audioStart: style.timing.leadIn, audioDuration: durations[s.id],
      words, subtitle, captions: buildCaptionCues(subtitle, words), credits, stage }
  })
  const plans = Object.fromEntries(beats.map(beat => [beat.id, beat]))
  await writeFile(timings, JSON.stringify({ fps, beats }, null, 2))
  const prepared = { ...production, sections: production.sections.map(s => ({ ...s, scene: `${s.id}.html` })) }
  await writeFile(path.join(scenes, 'production.json'), JSON.stringify(prepared, null, 2))
  const pendingFilm = path.join(dir, '.film-render')
  // Only submissions in this job run share partial renders.
  await rm(pendingFilm, { recursive: true, force: true })

  const { installSceneRoutes } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/isolated-page.mjs')).href)
  const { chromium } = require(style.paths.playwright)
  async function preview(id, seconds) {
    if (!ids.has(id)) throw new Error('段号不存在')
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > plans[id].duration) throw new Error('预览时间无效')
    await onProgress?.('预览画面')
    const browser = await chromium.launch({ executablePath: style.paths.edge || undefined, env: childEnvironment(env, [style.paths.edge]), headless: true, args: ['--disable-webrtc', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
    try {
      const context = await browser.newContext({ viewport: { width: style.video.width, height: style.video.height }, serviceWorkers: 'block' })
      await installSceneRoutes(context, path.join(scenes, `${id}.html`), dir, assets)
      const page = await openManagedStage(context, style, plans[id])
      await page.seek(seconds)
      const image = await page.view.screenshot({ type: 'png' })
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
  async function listSavedScenes() {
    const saved = []
    for (const id of ids) {
      try {
        if ((await readFile(path.join(scenes, `${id}.html`), 'utf8')).trim()) saved.push(id)
      } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    return saved
  }
  function resumeInstructions(saved) {
    return `本次从中断处继续。已保存的段落：${JSON.stringify(saved)}；尚未保存的段落：${JSON.stringify([...ids].filter(id => !saved.includes(id)))}。先补写缺失的段落，默认复用已保存段落，不逐段读回 HTML；只有为了衔接缺失段落或修正已发现的问题才调用 read_saved_scene。`
  }
  const savedScenes = resume ? await listSavedScenes() : []
  if (previousDir && feedback) for (const id of savedScenes) {
    const html = await readFile(path.join(scenes, `${id}.html`), 'utf8')
    let baseline
    try { baseline = await readFile(path.join(previousDir, 'scenes', `${id}.html`), 'utf8') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (html !== baseline) revised.add(id)
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
    await measure('render-compose', () => auditedExec(process.execPath, [path.join(kit, 'WORK/modules/video/pipeline.mjs'), '--prepared', path.join(scenes, 'production.json'), '--out', pendingFilm, '--voice', voice, '--timings', timings], { signal, env: { ...env, VIDEO_TTS_CACHE_DIR: audio, VIDEO_RESUME: '1' }, maxBuffer: 32 * 1024 * 1024 }))
    await onProgress?.('自动质检')
    await measure('verify', () => auditedExec(process.execPath, [path.join(kit, 'WORK/modules/video/verify.mjs'), path.join(pendingFilm, 'mapping.json'), timings], { signal, env, maxBuffer: 32 * 1024 * 1024 }))
    const report = JSON.parse(await readFile(path.join(pendingFilm, 'verify-report.json'), 'utf8'))
    if (!report.pass || report.hardErrors?.length) throw new Error('成片未通过宿主校验')
    await rm(path.join(pendingFilm, '.clip-cache'), { recursive: true, force: true })
    await rm(film, { recursive: true, force: true })
    await rename(pendingFilm, film)
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
    { name: 'write_scene', description: '写入一个 beat 的局部 HTML，包含 #stage、可见镜头的 data-shot-id 和局部 window.seek(t)', parameters: schema({ id: str, html: str }), execute: writeScene },
    { name: 'preview', description: '先用 write_scene 写入该段完整 HTML，再调用本工具渲染并查看该段某秒截图', parameters: schema({ id: str, seconds: { type: 'number' } }), execute: ({ id, seconds }) => preview(id, seconds) },
    { name: 'submit', description: '完成预览检查后调用：按真实配音渲染、合成并质检，通过后提交成片。失败会报错，不会提交。', parameters: schema({}), execute: submit },
  ]
  if (skillPackage) tools.push({
    name: 'read_skill_file', description: '读取选中 Skill 目录内的相关文本参考，使用相对于 SKILL.md 的路径',
    parameters: schema({ file: str }), execute: async ({ file }) => ({ file, text: await skillPackage.readSkillFile(file) }),
  })
  tools.push({ name: 'read_saved_scene', description: '读取本次任务已经保存的段落 HTML，继续编辑或预览', parameters: schema({ id: str }), execute: async ({ id }) => { if (!ids.has(id)) throw new Error('段号不存在'); return { id, html: await readFile(path.join(scenes, `${id}.html`), 'utf8') } } })
  if (previousDir) tools.push({ name: 'read_previous_scene', description: '读取上一版对应段落的 HTML，供按意见修改', parameters: schema({ id: str }), execute: async ({ id }) => { if (!ids.has(id)) throw new Error('段号不存在'); return { id, html: await readFile(path.join(previousDir, 'scenes', `${id}.html`), 'utf8') } } })
  const { skill: _skill, style: _style, ...blueprint } = production
  const prompt = `你是视频制作 Agent。制作方法 ${selectedPackage?.name || skillName} 已载入下文，不必重复调用 skill。保留方法中的讲述、设计与旁白对位标准；执行流程以本次网页制作契约为准：需求、蓝图和风格已确认，配音已生成；不重新选题、改旁白、提问或请求逐项确认，不执行本机脚本、不使用其他引擎。Skill 的历史个人偏好不代表本次用户要求。用工具为每个蓝图 beat 创作独立 HTML/CSS/JS，只定义局部画面和动效。write_scene 的 id 取该段工具编号，主舞台 #stage 使用 window.__PLAN__.stage.width 和 height。宿主提供字幕区与所选风格声明的顶部栏／片尾；模型只在 Main Stage 内创作，保留解释内容所需的标注，避免把字幕、章节栏或出处栏再画进场景。用 data-protected-text 注册必须可读的关键文字块，确保可见时完全位于舞台内且彼此不重叠。给该 beat 实际可见的镜头容器（可以是 #stage 本身）标记 data-shot-id，值是 window.__PLAN__.beatId 对应的蓝图 B 段号；标记应跟随实际画面，不能用隐藏占位元素。window.seek(t) 接收本段局部秒数，用 window.__PLAN__.words（配音后端有逐字时间时提供，offset 相对旁白起点）或 window.__PLAN__.subtitle 对齐局部动作。把旁白说到的关键变化当成动作的时序锚点；演示两轮结果时，标清各自的条件和结果，切到新一轮时同步更新对应标记与结果。旁白、段落顺序、时长、总时间轴、混音与交付由宿主控制。用 tts_durations 取实际配音时间，先 preview 检查画面和中途状态，必要时修正，再调用 submit 完成渲染、质检和提交；技术质检不代表已经完成事实核验或 OCR。图片通过 ../assets/文件名 或 ../现成素材/文件名引用；可用图片非空时优先复用；识别度不足、自带冲突 HUD 或无法演示动作时，按统一画风替换或重画。可用图片为空时直接用 HTML/SVG/CSS 创作画面。每个 beat 让观众看见蓝图中的具体对象发生什么变化，服从事实和已确认旁白。把出处保留在蓝图 facts 和宿主片尾，镜头内避免反复排免责声明、道德说教、逐屏学术脚注与「画面为示意」牌。准确性所需的限定照常保留。\n完整制作方法：\n${skillPackage?.prompt || skillText}\n蓝图：${JSON.stringify(blueprint)}\n可用图片：${JSON.stringify(assets)}\n视觉风格：${JSON.stringify(production.style || null)}\n修改意见：${feedback || '无'}${previousDir ? '\n本次为根据意见重新制作，可用 read_previous_scene 查看上一版对应段落。' : ''}`
  const taskPrompt = `${prompt}${resume ? `\n${resumeInstructions(savedScenes)}` : ''}\n按蓝图与视觉规则创作 HTML/CSS/JS。\n本次执行顺序：tts_durations → ${resume ? '检查并补齐所有段落' : 'write_scene 写完全部段落'} → 每段只 preview 一张代表性画面 → submit 渲染、基础检查并提交。默认只审一轮；仅自动修复脚本或播放错误、主体缺失、严重遮挡，修复后只复查受影响段。实际脚本错误继续修到可运行，不因已经改过一轮就停止；静帧、装饰、排版偏好和审美建议只作提示，不拦交片、不自动返工。上述方法用于创作指导，不增加额外审稿轮次或用户确认。`
  await measure('agent', () => runVideoAgent({ ctx, sessionId, cwd, model, provider, reasoningEffort, prompt: taskPrompt, tools, onProgress, onTiming: timing,
    retryInstruction: async () => `${resumeInstructions(await listSavedScenes())} 完成尚未做的画面预览检查后调用 submit；沿用已生成的配音。`,
  }))
  if (!composed) throw new Error('视频 Agent 未完成成片')
  return { scenes, film }
}
