import { mkdir, readFile, writeFile, stat, rename, realpath, copyFile, readdir, cp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportProduction } from '../scripts/export-production.js'

const defaultKit = fileURLToPath(new URL('../../../../../video-kit/', import.meta.url))

export function createProduction(workspace, config = {}) {
  const root = path.join(workspace, 'production')
  const stateFile = path.join(root, 'status.json')
  const kit = path.resolve(config.videoKitDir || process.env.VIDEO_KIT_DIR || defaultKit)
  let active = false
  let generation = 0
  async function save(state) { const temp = path.join(root, `.status-${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(state, null, 2) + '\n'); await rename(temp, stateFile); if (state.status === 'completed') await writeFile(path.join(root, state.id, 'completed.json'), JSON.stringify(state) + '\n') }
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
    const activeAtRead = active, generationAtRead = generation
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    if (state.status === 'running' && !activeAtRead && !active && generationAtRead === generation) {
      state.status = 'interrupted'; state.error = '工作台已重启，制作中断，请重新制作。'
    }
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
  async function reusableScenes(production, dir) {
    const files = [...new Set(production.sections.flatMap(s => [s.image, ...(s.assets || []).map(a => a.image)].filter(Boolean)))]
    let best = null
    for (const id of (await readdir(root)).filter(name => /^[0-9a-f-]{36}$/.test(name) && name !== path.basename(dir)).reverse()) {
      const previous = path.join(root, id), scenes = path.join(previous, 'scenes')
      try {
        const input = JSON.parse(await readFile(path.join(previous, 'production.json'), 'utf8'))
        if (!isDeepStrictEqual(input, production)) continue
        for (const file of files) if (!(await readFile(path.join(previous, file))).equals(await readFile(path.join(dir, file)))) throw new Error('changed asset')
        const sections = []
        for (const section of production.sections) {
          if (!/^[A-Za-z0-9_-]+$/.test(section.id)) continue
          try {
            const html = await readFile(path.join(scenes, `${section.id}.html`))
            const json = await readFile(path.join(scenes, `${section.id}.scene.json`))
            if (html.length && json.length) { JSON.parse(json.toString()); sections.push(section.id) }
          } catch (e) { if (e.code && e.code !== 'ENOENT') throw e }
        }
        if (!sections.length) continue
        let complete = false
        if (sections.length === production.sections.length) {
          try {
            const prepared = JSON.parse(await readFile(path.join(scenes, 'production.json'), 'utf8'))
            complete = prepared.sections.every(s => s.scene === `${s.id}.html`) && isDeepStrictEqual({ ...prepared, sections: prepared.sections.map(({ scene, ...section }) => section) }, production)
          } catch (e) { if (e.code && e.code !== 'ENOENT') throw e }
        }
        if (complete) return { id, scenes, sections, complete }
        if (!best || sections.length > best.sections.length) best = { id, scenes, sections, complete }
      } catch (e) {
        if (e.code && e.code !== 'ENOENT') throw e
        // Missing or incomplete scene outputs are not reusable.
      }
    }
    return best
  }
  async function reusableAudio(production, prior) {
    const candidates = []
    if (prior?.status === 'completed') candidates.push(prior)
    for (const id of (await readdir(root)).filter(name => /^[0-9a-f-]{36}$/.test(name))) {
      try { candidates.push(JSON.parse(await readFile(path.join(root, id, 'completed.json'), 'utf8'))) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    candidates.sort ( (a, b) => (b.completedAt || '').localeCompare(a.completedAt || '') )
    const narration = production.sections.map(({ id, narration }) => ({ id, narration }))
    for (const candidate of candidates) {
      if (candidate.status !== 'completed' || !/^[0-9a-f-]{36}$/.test(candidate.id || '')) continue
      const dir = path.join(root, candidate.id)
      try {
        const previous = JSON.parse(await readFile(path.join(dir, 'production.json'), 'utf8'))
        if (!isDeepStrictEqual(previous.sections.map(({ id, narration }) => ({ id, narration })), narration)) continue
        const audio = path.join(dir, 'film', 'audio')
        for (const { id } of narration) {
          if (!/^[A-Za-z0-9_-]+$/.test(id) || !(await stat(path.join(audio, `${id}.mp3`))).size) throw new Error('missing audio')
          JSON.parse(await readFile(path.join(audio, `${id}.json`), 'utf8'))
        }
        return { id: candidate.id, audio }
      } catch (e) { if (e.code && e.code !== 'ENOENT') throw e }
    }
    return null
  }
  async function bindImages(production, dir) {
    let raw
    try { raw = await readFile(path.join(workspace, 'assets.jsonl'), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') raw = ''; else throw e }
    const assets = raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(a => a.type === 'image' && /\.(png|jpe?g)$/i.test(a.name || ''))
    for (const section of production.sections) {
      const visual = String(section.visual || '')
      const matches = assets.filter(a => visual.includes(a.name))
      if (!matches.length) {
        if (/\.(?:png|jpe?g)\b/i.test(visual)) throw new Error(`${section.blueprintId} 指定的图片未在本创作资料中登记。`)
        continue
      }
      const available = []
      for (const asset of matches) {
        if (!/^sources\/[^/\\]+$/.test(asset.path || '')) throw new Error(`${section.blueprintId} 图片路径不在本创作上传目录。`)
        try {
          const source = await realpath(path.join(workspace, asset.path))
          const sourceRoot = await realpath(path.join(workspace, 'sources'))
          if (path.dirname(source) !== sourceRoot) throw new Error(`${section.blueprintId} 图片不在本创作上传目录。`)
          available.push({asset, source})
        } catch (e) { if (e.code !== 'ENOENT') throw e }
      }
      if (available.length > 1) throw new Error(`${section.blueprintId} 匹配多张图片或重复文件名，请明确保留一张资料。`)
      if (!available.length) throw new Error(`${section.blueprintId} 图片文件缺失，请重新上传：${[...new Set(matches.map(a => a.name))].join('、')}。`)
      const {asset, source} = available[0]
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
  async function start({ regenerateAssetId } = {}) {
    if (active) throw new Error('本创作已有制作任务正在运行')
    active = true
    generation++
    try {
      const saved = await config.settings?.load() || {}
      await config.ensureVisual?.()
      const production = await exportProduction(workspace)
      if (regenerateAssetId !== undefined && !production.assets?.some(asset => asset.id === regenerateAssetId)) throw new Error('要重做的素材不存在。')
      const missing = production.sections.filter(s => !s.narration?.trim()).map(s => s.blueprintId)
      if (missing.length) throw new Error(`缺少旁白：${missing.join('、')}；请补充后重新确认并定稿。`)
      let prior = null
      try { prior = JSON.parse(await readFile(stateFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
      let sceneConfig = null
      try { sceneConfig = JSON.parse(await readFile(path.join(workspace, 'hotpot-demo-scene.json'), 'utf8')) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (sceneConfig && sceneConfig.version !== 1) throw new Error('本创作的专用场景配置版本不支持。')
      // Choosing a style explicitly routes this version through the style-aware renderer.
      if (production.assets?.length || production.style || production.skill) sceneConfig = null
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
      await bindImages(production, dir)
      const state = { id, status: 'running', phase: '生成素材', version: production.version, startedAt: new Date().toISOString(), styleId: production.style?.id || null, styleName: production.style?.name || null }
      await save(state)
      ;(async () => {
        try {
          const assetArgs = { version: Number(production.version.slice(1)), doc: production, style: production.style }
          if (regenerateAssetId !== undefined) await config.generatedAssets.generate({ ...assetArgs, id: regenerateAssetId })
          const generated = production.assets?.length ? (await config.generatedAssets.generate(assetArgs)).assets : []
          if (generated.length) await mkdir(path.join(dir, 'assets'))
          for (const asset of generated) {
            const source = await config.generatedAssets.file({ ...assetArgs, id: asset.id, revision: asset.revision })
            const image = `assets/${asset.id}.svg`
            await copyFile(source, path.join(dir, image))
            for (const section of production.sections.filter(s => asset.sections.includes(s.blueprintId))) {
              ;(section.assets ||= []).push({ id: asset.id, name: asset.name, type: asset.type, image })
            }
          }
          await writeFile(path.join(dir, 'production.json'), JSON.stringify(production, null, 2) + '\n')
          state.phase = '生成画面'; await save(state)
          const scenes = path.join(dir, 'scenes'), film = path.join(dir, 'film')
          const sceneArgs = ['--input', path.join(dir, 'production.json'), '--output', scenes]
          const reused = sceneConfig ? null : await reusableScenes(production, dir)
          if (reused?.complete) { await cp(reused.scenes, scenes, { recursive: true }); state.reusedScenesFrom = reused.id; await save(state) }
          else if (sceneConfig) await run('scripts/hotpot-scenes.mjs', sceneArgs)
          else {
            let reuseDir = ''
            if (reused) {
              reuseDir = path.join(dir, 'reused-scenes'); await mkdir(reuseDir)
              for (const id of reused.sections) for (const suffix of ['.html', '.scene.json']) await copyFile(path.join(reused.scenes, id + suffix), path.join(reuseDir, id + suffix))
              state.reusedScenesFrom = reused.id; state.reusedSceneSections = reused.sections; await save(state)
            }
            await run('scripts/prepare-scenes.mjs', sceneMode === 'dsh' ? [...sceneArgs, '--dsh'] : [...sceneArgs, '--endpoint', endpoint, '--model', model], { ...process.env, SCENE_API_KEY: key || '', VIDEO_SCENE_REUSE_DIR: reuseDir })
          }
          state.phase = '配音与渲染'; await save(state)
          const audio = await reusableAudio(production, prior)
          const args = ['--prepared', path.join(scenes, 'production.json'), '--out', film]
          if (saved.tts?.voice) args.push('--voice', `api:${saved.tts.voice}`)
          else if (process.env.VIDEO_VOICE) args.push('--voice', process.env.VIDEO_VOICE)
          else if (process.env.VOICE_NAME) args.push('--voice', `api:${process.env.VOICE_NAME}`)
          await run('WORK/modules/video/pipeline.mjs', args, { ...process.env, VIDEO_TTS_CACHE_DIR: audio?.audio || '', ...(saved.tts?.baseUrl ? { VIDEO_TTS_ENDPOINT: saved.tts.baseUrl } : {}), ...(saved.tts?.model ? { VIDEO_TTS_MODEL: saved.tts.model } : {}), ...(saved.tts?.baseUrl ? { VIDEO_TTS_KEY: saved.tts.apiKey || '' } : {}), ...(saved.tts?.protocol ? { VIDEO_TTS_PROTOCOL: saved.tts.protocol } : {}) })
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
