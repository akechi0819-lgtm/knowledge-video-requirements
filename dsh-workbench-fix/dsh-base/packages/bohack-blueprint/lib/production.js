import { mkdir, readFile, writeFile, stat, rename, realpath, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportProduction } from '../scripts/export-production.js'

const defaultKit = fileURLToPath(new URL('../../../../../video-kit/', import.meta.url))

export function createProduction(workspace, config = {}) {
  const root = path.join(workspace, 'production')
  const stateFile = path.join(root, 'status.json')
  const kit = path.resolve(config.videoKitDir || process.env.VIDEO_KIT_DIR || defaultKit)
  let active = false
  async function save(state) { const temp = path.join(root, `.status-${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(state, null, 2) + '\n'); await rename(temp, stateFile) }
  async function exists(file) {
    try { await stat(file); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
  }
  async function decorate(state) {
    if (!state?.id || !/^[0-9a-f-]{36}$/.test(state.id)) return state
    const dir = path.join(root, state.id)
    let production = null
    try { production = JSON.parse(await readFile(path.join(dir, 'production.json'), 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    const film = path.join(dir, 'film')
    const scenes = path.join(dir, 'scenes')
    const sections = []
    for (const sec of production?.sections || []) {
      const id = String(sec.id || '')
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) continue
      const hasHtml = await exists(path.join(scenes, `${id}.html`))
      const hasJson = await exists(path.join(scenes, `${id}.scene.json`))
      const hasClip = await exists(path.join(film, 'clips', `${id}.mp4`))
      const hasAudio = await exists(path.join(film, 'audio', `${id}.mp3`))
      sections.push({
        id,
        blueprintId: sec.blueprintId || '',
        title: sec.title || '',
        narration: sec.narration || '',
        visual: sec.visual || '',
        scene: hasHtml || hasJson,
        sceneKind: hasHtml ? 'html' : hasJson ? 'json' : null,
        audio: hasAudio,
        clip: hasClip,
      })
    }
    let mapping = null
    if (await exists(path.join(film, 'mapping.json'))) {
      try {
        const raw = JSON.parse(await readFile(path.join(film, 'mapping.json'), 'utf8'))
        mapping = {
          duration: raw.final_duration_sec || raw.target_duration_sec || null,
          segments: (raw.segments || []).map(seg => ({
            id: seg.id,
            blueprintId: seg.blueprint_id || seg.blueprintId,
            title: seg.title || '',
            start: seg.start_sec,
            end: seg.end_sec,
            duration: seg.duration_sec,
            narration: seg.narration || '',
          })),
        }
      } catch { mapping = null }
    }
    let verify = null
    if (await exists(path.join(film, 'verify-report.json'))) {
      try {
        const raw = JSON.parse(await readFile(path.join(film, 'verify-report.json'), 'utf8'))
        const problems = (raw.problems || []).map(item => typeof item === 'string' ? item : (item.message || String(item)))
        verify = {
          pass: raw.pass !== false && !problems.length,
          problems,
          segments: (raw.segments || []).map(seg => ({ id: seg.id, issues: seg.issues || [] })),
        }
      } catch { verify = null }
    }
    return {
      ...state,
      sections,
      artifacts: {
        video: await exists(path.join(film, 'final.mp4')),
        mapping: Boolean(mapping),
        verify: Boolean(verify),
      },
      mapping,
      verify,
    }
  }
  async function status() {
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    if (state.status === 'running' && !active) { state.status = 'interrupted'; state.error = '工作台已重启，制作中断，请重新制作。'; await save(state) }
    return decorate(state)
  }
  function run(script, args, env = process.env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(kit, script), ...args], { cwd: kit, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let errors = ''
      child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000) })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}：${errors.trim()}`)))
    })
  }
  async function bindImages(production, dir) {
    let raw
    try { raw = await readFile(path.join(workspace, 'assets.jsonl'), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') raw = ''; else throw e }
    const assets = raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(a => a.type === 'image' && /\.(png|jpe?g)$/i.test(a.name || ''))
    for (const section of production.sections) {
      const visual = String(section.visual || '')
      const matches = assets.filter(a => visual.includes(a.name))
      if (matches.length > 1) throw new Error(`${section.blueprintId} 匹配多张图片或重复文件名，请明确保留一张资料。`)
      if (!matches.length) {
        if (/\.(?:png|jpe?g)\b/i.test(visual)) throw new Error(`${section.blueprintId} 指定的图片未在本创作资料中登记。`)
        continue
      }
      const asset = matches[0]
      if (!/^sources\/[^/\\]+$/.test(asset.path || '')) throw new Error(`${section.blueprintId} 图片路径不在本创作上传目录。`)
      const sourceRoot = await realpath(path.join(workspace, 'sources'))
      const source = await realpath(path.join(workspace, asset.path))
      if (path.dirname(source) !== sourceRoot) throw new Error(`${section.blueprintId} 图片不在本创作上传目录。`)
      const bytes = await readFile(source)
      const isPng = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      const isJpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      if ((!isPng && !isJpeg) || (isPng !== /\.png$/i.test(asset.name))) throw new Error(`${section.blueprintId} 图片内容与 PNG/JPEG 文件名不符。`)
      const image = `images/${section.id}.${isPng ? 'png' : 'jpg'}`
      await mkdir(path.join(dir, 'images'), { recursive: true })
      await copyFile(source, path.join(dir, image))
      section.image = image
    }
  }
  async function start() {
    if (active) throw new Error('本创作已有制作任务正在运行')
    active = true
    try {
      const saved = await config.settings?.load() || {}
      const production = await exportProduction(workspace)
      const missing = production.sections.filter(s => !s.narration?.trim()).map(s => s.blueprintId)
      if (missing.length) throw new Error(`缺少旁白：${missing.join('、')}；请补充后重新确认并定稿。`)
      const approved = production.assets?.length
        ? await config.generatedAssets.approvedFiles({ version: Number(production.version.slice(1)), doc: production, style: production.style })
        : []
      let sceneConfig = null
      try { sceneConfig = JSON.parse(await readFile(path.join(workspace, 'hotpot-demo-scene.json'), 'utf8')) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (sceneConfig && sceneConfig.version !== 1) throw new Error('本创作的专用场景配置版本不支持。')
      // Choosing a style explicitly routes this version through the style-aware renderer.
      if (approved.length || production.style || production.skill) sceneConfig = null
      const sceneMode = process.env.SCENE_MODE || 'api'
      if (!sceneConfig && !['api', 'dsh'].includes(sceneMode)) throw new Error('SCENE_MODE 只支持 api 或 dsh。')
      const customScene = Boolean(process.env.SCENE_ENDPOINT || process.env.SCENE_MODEL)
      const projectModel = { endpoint: process.env.WORKBENCH_MODEL_ENDPOINT, model: process.env.WORKBENCH_MODEL_NAME, key: process.env.WORKBENCH_MODEL_KEY }
      const endpoint = saved.model?.baseUrl || (customScene ? process.env.SCENE_ENDPOINT : projectModel.endpoint)
      const model = saved.model?.model || (customScene ? process.env.SCENE_MODEL : projectModel.model)
      const key = saved.model?.baseUrl ? saved.model.apiKey : customScene ? process.env.SCENE_API_KEY : projectModel.key
      if (!sceneConfig && sceneMode === 'api' && (!model || !endpoint ||
          (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)))) {
        throw new Error('未配置可用的画面模型，请设置项目通用模型或 SCENE 专用模型。')
      }
      await mkdir(root, { recursive: true })
      const id = randomUUID(), dir = path.join(root, id)
      await mkdir(dir)
      if (approved.length) {
        await mkdir(path.join(dir, 'assets'))
        for (const { id, name, type, sections, path: source } of approved) {
          const image = `assets/${id}.svg`
          await copyFile(source, path.join(dir, image))
          for (const section of production.sections.filter(s => sections.includes(s.blueprintId))) {
            ;(section.assets ||= []).push({ id, name, type, image })
          }
        }
      }
      await bindImages(production, dir)
      await writeFile(path.join(dir, 'production.json'), JSON.stringify(production, null, 2) + '\n')
      const state = { id, status: 'running', phase: '生成画面', version: production.version, startedAt: new Date().toISOString(), styleId: production.style?.id || null, styleName: production.style?.name || null }
      await save(state)
      ;(async () => {
        try {
          const scenes = path.join(dir, 'scenes'), film = path.join(dir, 'film')
          const sceneArgs = ['--input', path.join(dir, 'production.json'), '--output', scenes]
          if (sceneConfig) await run('scripts/hotpot-scenes.mjs', sceneArgs)
          else await run('scripts/prepare-scenes.mjs', sceneMode === 'dsh' ? [...sceneArgs, '--dsh'] : [...sceneArgs, '--endpoint', endpoint, '--model', model], { ...process.env, SCENE_API_KEY: key || '' })
          state.phase = '配音与渲染'; await save(state)
          const args = ['--prepared', path.join(scenes, 'production.json'), '--out', film]
          if (saved.tts?.voice) args.push('--voice', `api:${saved.tts.voice}`)
          else if (process.env.VIDEO_VOICE) args.push('--voice', process.env.VIDEO_VOICE)
          else if (process.env.VOICE_NAME) args.push('--voice', `api:${process.env.VOICE_NAME}`)
          await run('WORK/modules/video/pipeline.mjs', args, { ...process.env, ...(saved.tts?.baseUrl ? { VIDEO_TTS_ENDPOINT: saved.tts.baseUrl } : {}), ...(saved.tts?.model ? { VIDEO_TTS_MODEL: saved.tts.model } : {}), ...(saved.tts?.baseUrl ? { VIDEO_TTS_KEY: saved.tts.apiKey || '' } : {}), ...(saved.tts?.protocol ? { VIDEO_TTS_PROTOCOL: saved.tts.protocol } : {}) })
          state.phase = '自动质检'; await save(state)
          await run('WORK/modules/video/verify.mjs', [path.join(film, 'mapping.json')])
          await Promise.all([stat(path.join(film, 'final.mp4')), readFile(path.join(film, 'mapping.json'), 'utf8').then(JSON.parse)])
          state.status = 'completed'; state.phase = '制作完成'; state.completedAt = new Date().toISOString()
        } catch (e) { state.status = 'failed'; state.error = String(e.message || e); state.completedAt = new Date().toISOString() }
        finally { await save(state); active = false }
      })().catch(e => { active = false; console.error('保存制作状态失败', e) })
      return state
    } catch (e) { active = false; throw e }
  }
  async function file(kind, section) {
    const state = await status()
    if (!state?.id || !/^[0-9a-f-]{36}$/.test(state.id)) throw new Error('成片尚不可用')
    const dir = path.join(root, state.id)
    const kinds = {
      video: path.join(dir, 'film', 'final.mp4'),
      mapping: path.join(dir, 'film', 'mapping.json'),
    }
    if (kind === 'clip' || kind === 'audio' || kind === 'scene') {
      if (!section || !/^[A-Za-z0-9_-]{1,32}$/.test(section)) throw new Error('成片尚不可用')
      if (kind === 'clip') kinds.clip = path.join(dir, 'film', 'clips', `${section}.mp4`)
      if (kind === 'audio') kinds.audio = path.join(dir, 'film', 'audio', `${section}.mp3`)
      if (kind === 'scene') {
        const html = path.join(dir, 'scenes', `${section}.html`)
        kinds.scene = await exists(html) ? html : path.join(dir, 'scenes', `${section}.scene.json`)
      }
    }
    const target = kinds[kind]
    if (!target) throw new Error('成片尚不可用')
    let resolved, rootResolved
    try {
      resolved = await realpath(target)
      rootResolved = await realpath(dir)
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('成片尚不可用')
      throw e
    }
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) throw new Error('成片尚不可用')
    return resolved
  }
  return { start, status, file }
}
