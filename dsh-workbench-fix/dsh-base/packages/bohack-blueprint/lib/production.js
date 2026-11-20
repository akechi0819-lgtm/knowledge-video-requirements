import { mkdir, readFile, writeFile, stat, rename, realpath, copyFile, readdir, cp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from './settings.js'
import { exportProduction } from '../scripts/export-production.js'

const defaultKit = fileURLToPath(new URL('../../../../../video-kit/', import.meta.url))

function normalizeEndpoint(baseUrl, suffix) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix
}

export function createProduction(workspace, config = {}) {
  const root = path.join(workspace, 'production')
  const stateFile = path.join(root, 'status.json')
  const kit = path.resolve(config.videoKitDir || process.env.VIDEO_KIT_DIR || defaultKit)
  let active = false
  let generation = 0
  const memberProject = config.memberProject
  const jobIdPattern = /^[0-9a-f-]{36}$/
  async function readState() {
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e; return null }
    if (state?.membershipAuthorizationId && ['running', 'failed', 'interrupted'].includes(state.status)) {
      const authorization = await memberProject?.current()
      if (authorization?.id === state.membershipAuthorizationId && authorization.terminal === 'abandoned') {
        return { ...state, status: 'abandoned', phase: '已放弃', error: undefined }
      }
    }
    return state
  }
  async function save(state) {
    const temp = path.join(root, `.status-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n')
    // Windows antivirus / concurrent readers briefly lock the file, making rename fail with EPERM/EBUSY.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, stateFile); break }
      catch (e) {
        if ((e.code === 'EPERM' || e.code === 'EBUSY') && attempt < 50) { await new Promise(r => setTimeout(r, 20 + Math.random() * 30)); continue }
        throw e
      }
    }
    if (state.status === 'completed') await writeFile(path.join(root, state.id, 'completed.json'), JSON.stringify(state) + '\n')
  }
  async function exists(file) {
    try { await stat(file); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
  }
  async function decorate(state) {
    if (!state?.id || !jobIdPattern.test(state.id)) return state
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
    const state = await readState()
    if (state?.status === 'running' && !activeAtRead && !active && generationAtRead === generation) {
      state.status = 'interrupted'; state.error = state.membershipAuthorizationId ? '工作台已重启，可继续原制作。' : '工作台已重启，制作中断，请重新制作。'
    }
    return decorate(state)
  }
  function run(script, args, env = process.env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(kit, script), ...args], { cwd: kit, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let errors = ''
      let timedOut = false
      let killTimer = null
      const timeoutMs = Number(process.env.VIDEO_PRODUCTION_TIMEOUT_MS) || 30 * 60 * 1000
      const watchdog = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            else child.kill('SIGKILL')
          }
        }, 5000)
      }, timeoutMs)
      child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000) })
      child.on('error', error => { clearTimeout(watchdog); if (killTimer) clearTimeout(killTimer); reject(error) })
      child.on('close', code => {
        clearTimeout(watchdog)
        if (killTimer) clearTimeout(killTimer)
        if (timedOut) return reject(new Error(`${script} 制作超时（${Math.round(timeoutMs / 60000)} 分钟），已终止子进程。`))
        code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}：${errors.trim()}`))
      })
    })
  }
  async function reusableScenes(production, dir) {
    const files = [...new Set(production.sections.flatMap(s => [s.image, ...(s.assets || []).map(a => a.image)].filter(Boolean)))]
    let best = null
    for (const id of (await readdir(root)).filter(name => jobIdPattern.test(name) && name !== path.basename(dir)).reverse()) {
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
    for (const id of (await readdir(root)).filter(name => jobIdPattern.test(name))) {
      try {
        const candidate = JSON.parse(await readFile(path.join(root, id, 'completed.json'), 'utf8'))
        if (candidate && typeof candidate === 'object') candidates.push(candidate)
      } catch { /* Missing or corrupt completion records are not reusable. */ }
    }
    candidates.sort ( (a, b) => (b.completedAt || '').localeCompare(a.completedAt || '') )
    const narration = production.sections.map(({ id, narration }) => ({ id, narration }))
    for (const candidate of candidates) {
      if (candidate.status !== 'completed' || !jobIdPattern.test(candidate.id || '')) continue
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
  // 仅按素材清单中的账本 ID 绑定人工实物。
  async function bindDeclaredAssets(production, pending, dir) {
    let raw
    try { raw = await readFile(path.join(workspace, 'assets.jsonl'), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') raw = ''; else throw e }
    const ledger = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
    const remaining = []
    for (const declaration of pending) {
      if (!declaration.ledgerId) { remaining.push(declaration); continue }
      const asset = ledger.find(a => a.id === declaration.ledgerId && a.trust === 'vetted' && !a.declared && !a.generatedAssetId && a.path && (a.side === 'videomake' || (!a.side && a.type === 'image')))
      if (!asset) { remaining.push(declaration); continue }
      if (!/^sources\/[^/\\]+$/.test(asset.path)) throw new Error(`素材「${declaration.name}」路径不在本创作上传目录。`)
      const source = await realpath(path.join(workspace, asset.path))
      if (path.dirname(source) !== await realpath(path.join(workspace, 'sources'))) throw new Error(`素材「${declaration.name}」不在本创作上传目录。`)
      const bytes = await readFile(source), ext = path.extname(asset.path).toLowerCase().replace('.jpeg', '.jpg')
      if (!['.png', '.jpg', '.svg'].includes(ext)) throw new Error(`素材「${declaration.name}」不是支持的图片格式。`)
      if (ext === '.png' && !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          ext === '.jpg' && !bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) throw new Error(`素材「${declaration.name}」图片内容与文件名不符。`)
      const image = `assets/${declaration.id}${ext}`
      await mkdir(path.join(dir, 'assets'), { recursive: true })
      await copyFile(source, path.join(dir, image))
      for (const section of production.sections.filter(s => declaration.sections.includes(s.blueprintId))) {
        ;(section.assets ||= []).push({ id: declaration.id, name: declaration.name, type: declaration.type, image })
      }
    }
    return remaining
  }
  /**
   * 随行搬运层：凡「素材分身」且 vetted 的素材全部随片搬进视频工作区的
   * 「现成素材/」文件夹，备注随行（素材清单.md：文件名→备注，身份说明而非
   * 使用边界——用谁、用多少、怎么用由视频侧按画面需要自主决定）。漏斗在
   * 备注审核层收口，不在蓝图指认层。旧条目（无 side 的 image）按素材语义兼容。
   * 失败不阻断成片：搬运是增强，不是闸门。
   */
  async function bindReadyAssets(dir) {
    let raw
    try { raw = await readFile(path.join(workspace, 'assets.jsonl'), 'utf8') }
    catch (e) { if (e.code === 'ENOENT') return; else throw e }
    const assets = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(a => a && a.trust === 'vetted' && a.path && !a.declared && !a.generatedAssetId && (a.side === 'videomake' || (!a.side && a.type === 'image')))
    if (!assets.length) return
    const sourceRoot = await realpath(path.join(workspace, 'sources'))
    await mkdir(path.join(dir, '现成素材'), { recursive: true })
    const manifest = ['## 现成素材清单', '', '这是素材身份说明，不是使用边界——用谁、用多少、怎么用，按画面需要自主决定。蓝图正文里如有提及，意图以蓝图为准。', '']
    const used = new Set()
    for (const asset of assets) {
      try {
        const source = await realpath(path.join(workspace, asset.path))
        if (path.dirname(source) !== sourceRoot) continue
        let target = asset.name
        if (used.has(target)) {
          const ext = path.extname(target), base = path.basename(target, ext)
          let i = 2
          while (used.has(`${base}-${i}${ext}`)) i++
          target = `${base}-${i}${ext}`
        }
        used.add(target)
        await copyFile(source, path.join(dir, '现成素材', target))
        manifest.push(`- 《${target}》${asset.note || '（无备注）'}`)
      } catch (e) {
        console.error(`[bohack/production] 素材《${asset.name}》随行搬运失败，已跳过：${String(e?.message || e)}`)
      }
    }
    if (used.size) await writeFile(path.join(dir, '现成素材', '素材清单.md'), manifest.join('\n') + '\n', 'utf8')
  }
  function validateVoice(saved) {
    if (((process.env.BOHACK_CLOUD_MODEL || config.desktop) && (!saved.tts?.baseUrl || !saved.tts.model)) || (saved.tts?.baseUrl && !saved.tts.voice?.trim())) {
      throw new Error('请配置当前配音服务的地址、模型和音色 ID。')
    }
  }
  function sceneSettings(saved, sceneConfig) {
    const sceneMode = config.desktop ? 'api' : process.env.SCENE_MODE || 'api'
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
    return { sceneMode, endpoint, model, key }
  }
  async function settleReceipt(state) {
    try {
      const outcome = await memberProject.close('finish', state.membershipAuthorizationId)
      if (outcome !== 'finished') throw new Error('这条片的会员授权已经放弃。')
      delete state.membershipPending
      delete state.membershipError
    } catch (error) {
      state.membershipPending = true
      state.membershipError = '成片已保存，平台授权回执待处理：' + error.message
    }
    await save(state)
    return state
  }
  async function restoreFilm(film) {
    const mapping = path.join(film, 'mapping.json')
    if (!await exists(mapping) || !await exists(path.join(film, 'final.mp4'))) return false
    const report = path.join(film, 'verify-report.json')
    let verification
    try { verification = JSON.parse(await readFile(report, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      await run('WORK/modules/video/verify.mjs', [mapping])
      return true
    }
    return Array.isArray(verification.hardErrors) && !verification.hardErrors.length
  }
  async function runJob(state, production, dir, saved, auth, prior, resume, release) {
    const { mode, sceneConfig, previousJobId, feedback = '' } = state
    const declaredPending = production.declaredPending || []
    const assetArgs = { version: Number(production.version.slice(1)), doc: production, style: production.style }
    const previousDir = feedback && previousJobId ? path.join(root, previousJobId) : null
    const agentRoute = mode === 'agent' && (await memberProject?.route() ||
      resolveAgent(saved, 'videoAgent', { provider: config.provider || 'deepseek-official', model: config.model || 'deepseek-v4-pro' }))
    await save(state)
    void (async () => {
      try {
        const film = path.join(dir, 'film')
        if (mode === 'agent') {
          const { runVideoJob } = await import('./video-job.js')
          const onProgress = async event => {
            const phase = typeof event === 'string' ? event : event?.type === 'status' ? event.text : null
            if (phase) { state.phase = phase; await save(state) }
          }
          const generateAsset = async ({id:assetId}) => {
            const planned = declaredPending.find(a => a.id === assetId)
            if (!planned) throw new Error('只能为本次制作尚缺实物的素材生成候选。')
            const result = await config.generatedAssets.generate({ ...assetArgs, id:assetId })
            const item = result.assets.find(a => a.id === assetId)
            return {id:assetId, status:item.status, revision:item.revision, message:'候选已送回资料页，作者可单独确认。'}
          }
          memberProject?.bind(state.sessionId, config.settings.load, auth?.id)
          await runVideoJob({ctx:config.ctx, sessionId:state.sessionId, dir, production, kit,
            settings:saved, ...agentRoute, feedback, previousDir, onProgress, generateAsset, resume})
          await sourceArchive(dir, kit)
        } else {
          state.phase = '生成画面'; await save(state)
          const scenes = path.join(dir, 'scenes')
          const { sceneMode, endpoint, model, key } = sceneSettings(saved, sceneConfig)
          const sceneArgs = ['--input', path.join(dir, 'production.json'), '--output', scenes]
          const reused = resume || sceneConfig ? null : await reusableScenes(production, dir)
          const prepared = resume ? await readFile(path.join(scenes, 'production.json'), 'utf8').then(JSON.parse).catch(error => {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
            throw error
          }) : null
          if (prepared) { /* 已完成场景准备 */ }
          else if (reused?.complete) { await cp(reused.scenes, scenes, { recursive: true }); state.reusedScenesFrom = reused.id; await save(state) }
          else if (sceneConfig) await run('scripts/hotpot-scenes.mjs', sceneArgs, { ...process.env, VIDEO_RESUME: resume ? '1' : '' })
          else {
            let reuseDir = ''
            if (reused) {
              reuseDir = path.join(dir, 'reused-scenes'); await mkdir(reuseDir)
              for (const id of reused.sections) for (const suffix of ['.html', '.scene.json']) await copyFile(path.join(reused.scenes, id + suffix), path.join(reuseDir, id + suffix))
              state.reusedScenesFrom = reused.id; state.reusedSceneSections = reused.sections; await save(state)
            }
            const dshBase = path.resolve(kit, '..', 'dsh-workbench-fix', 'dsh-base')
            const dshCli = process.env.DSH_CLI || path.join(dshBase, process.platform === 'win32' ? 'dsh.cmd' : 'dsh.sh')
            await run('scripts/prepare-scenes.mjs', sceneMode === 'dsh' ? [...sceneArgs, '--dsh'] : [...sceneArgs, '--endpoint', normalizeEndpoint(endpoint, '/chat/completions'), '--model', model], { ...process.env, SCENE_API_KEY: key || '', VIDEO_SCENE_REUSE_DIR: reuseDir, VIDEO_RESUME: resume ? '1' : '', DSH_CLI: dshCli })
          }
          state.phase = '配音与渲染'; await save(state)
          const audio = await reusableAudio(production, prior)
          const args = ['--prepared', path.join(scenes, 'production.json'), '--out', film]
          if (saved.tts?.voice) args.push('--voice', `api:${saved.tts.voice}`)
          else if (process.env.VIDEO_VOICE) args.push('--voice', process.env.VIDEO_VOICE)
          else if (process.env.VOICE_NAME) args.push('--voice', `api:${process.env.VOICE_NAME}`)
          await run('WORK/modules/video/pipeline.mjs', args, { ...process.env, VIDEO_RESUME: resume ? '1' : '', VIDEO_TTS_CACHE_DIR: audio?.audio || '', ...(saved.tts?.baseUrl ? { VIDEO_TTS_ENDPOINT: normalizeEndpoint(saved.tts.baseUrl, saved.tts.protocol === 'mimo' ? '/chat/completions' : '/audio/speech') } : {}), ...(saved.tts?.model ? { VIDEO_TTS_MODEL: saved.tts.model } : {}), ...(saved.tts?.baseUrl ? { VIDEO_TTS_KEY: saved.tts.apiKey || '' } : {}), ...(saved.tts?.protocol ? { VIDEO_TTS_PROTOCOL: saved.tts.protocol } : {}) })
          state.phase = '自动质检'; await save(state)
          await run('WORK/modules/video/verify.mjs', [path.join(film, 'mapping.json')])
        }
        await Promise.all([stat(path.join(film, 'final.mp4')), readFile(path.join(film, 'mapping.json'), 'utf8').then(JSON.parse)])
        state.status = 'completed'; state.phase = '制作完成'; state.completedAt = new Date().toISOString()
        if (auth) state.membershipPending = true
      } catch (e) { state.status = 'failed'; state.error = String(e.message || e); state.completedAt = new Date().toISOString() }
      finally {
        if (state.sessionId) config.memberProject?.unbind(state.sessionId)
        try {
          await save(state)
          if (state.membershipPending) await settleReceipt(state)
        } finally { active = false; release?.() }
      }
    })().catch(e => { active = false; console.error('保存制作状态失败', e) })
  }
  async function start({ mode = config.productionMode || 'agent', feedback = '', regenerateAssetId, jobId } = {}) {
    if (!['agent', 'structured'].includes(mode)) throw new Error('未知的视频制作方式。')
    if (typeof feedback !== 'string' || (feedback.trim() && mode !== 'agent')) throw new Error('返工意见需提交给视频制作 Agent。')
    if (active) throw new Error('本创作已有制作任务正在运行')
    const release = config.memberProject?.hold()
    active = true
    generation++
    try {
      const prior = await readState()
      if (jobId !== undefined && jobId !== prior?.id) throw new Error('制作记录已变更，请刷新后再试。')
      if (memberProject && prior?.status === 'completed' && (prior.membershipPending || prior.membershipError)) {
        if (jobId === undefined) throw new Error('成片已保存，请先补交完成回执再开新片。')
        const state = await settleReceipt(prior)
        if (state.membershipPending) throw new Error(state.membershipError)
        active = false; release?.()
        return state
      }
      if (jobId !== undefined && prior?.status === 'completed') {
        active = false; release?.()
        return prior
      }
      if (memberProject && prior?.membershipAuthorizationId && ['running', 'failed', 'interrupted'].includes(prior.status)) {
        if (jobId === undefined) throw new Error('请先继续或放弃原制作，再开始新片。')
        if (!jobIdPattern.test(prior.id)) throw new Error('原制作记录的任务编号无效。')
        const dir = path.join(root, prior.id)
        const production = JSON.parse(await readFile(path.join(dir, 'production.json'), 'utf8'))
        if (await restoreFilm(path.join(dir, 'film'))) {
          if (prior.mode === 'agent') await sourceArchive(dir, kit)
          const state = { ...prior, status: 'completed', phase: '制作完成', completedAt: new Date().toISOString(), membershipPending: true }
          delete state.error
          await save(state)
          await settleReceipt(state)
          active = false; release?.()
          return state
        }
        const state = { ...prior, status: 'running', phase: '继续原制作' }
        delete state.error
        delete state.completedAt
        if (state.mode === 'agent') state.sessionId = 'bohack-video-' + randomUUID()
        const auth = await memberProject.lease({ id: state.membershipAuthorizationId })
        const saved = await config.settings.forCall(auth)
        validateVoice(saved)
        await runJob(state, production, dir, saved, auth, prior, true, release)
        return state
      }
      if (jobId !== undefined) throw new Error('这条制作已结束。')
      let saved
      if (!config.memberProject) {
        saved = await config.settings?.load() || {}
        validateVoice(saved)
      }
      await config.ensureVisual?.()
      const production = await exportProduction(workspace)
      if (regenerateAssetId !== undefined && !production.assets?.some(asset => asset.id === regenerateAssetId)) throw new Error('要重做的素材不存在。')
      const missing = production.sections.filter(s => !s.narration?.trim()).map(s => s.blueprintId)
      if (missing.length) throw new Error(`缺少旁白：${missing.join('、')}；请补充后重新确认并定稿。`)
      const assetArgs = { version: Number(production.version.slice(1)), doc: production, style: production.style }
      const previousJobId = prior?.status === 'completed' ? prior.id : prior?.previousJobId || null
      if (feedback.trim() && !previousJobId) throw new Error('尚无已完成的成片可以返工。')
      const auth = await memberProject?.lease()
      if (config.memberProject) {
        saved = await config.settings.forCall(auth)
        validateVoice(saved)
      }
      if (regenerateAssetId !== undefined) await config.generatedAssets.generate({ ...assetArgs, id: regenerateAssetId })
      const { approved, pending } = production.assets?.length
        ? await config.generatedAssets.availableFiles(assetArgs)
        : { approved: [], pending: [] }
      let sceneConfig = null
      try { sceneConfig = JSON.parse(await readFile(path.join(workspace, 'hotpot-demo-scene.json'), 'utf8')) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (sceneConfig && sceneConfig.version !== 1) throw new Error('本创作的专用场景配置版本不支持。')
      // Choosing a style explicitly routes this version through the style-aware renderer.
      if (approved.length || production.style || production.skill) sceneConfig = null
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
      const declaredPending = await bindDeclaredAssets(production, pending, dir)
      if (declaredPending.length) production.declaredPending = declaredPending
      if (declaredPending.length !== pending.length) sceneConfig = null
      if (mode === 'structured') sceneSettings(saved, sceneConfig)
      await bindReadyAssets(dir)
      if (declaredPending.length) {
        const lines = ['## 未实现的声明素材', '', '这些素材只有声明、还没有成品文件。不要求全部实现：画面需要时即席实现，或直接用其他方式表现，不得因此中断制作。', '',
          ...declaredPending.map(a => `- 《${a.name}》（${a.sections.join('、')}）：${a.description}`)]
        await writeFile(path.join(dir, '声明素材.md'), lines.join('\n') + '\n', 'utf8')
      }
      const state = { id, mode, previousJobId, ...(mode === 'agent' ? {sessionId:'bohack-video-'+id, feedback:feedback.trim()} : {}), ...(auth && { membershipAuthorizationId: auth.id }), status: 'running', phase: mode === 'agent' ? '启动视频制作 Agent' : '生成素材', version: production.version, ...(sceneConfig && { sceneConfig }), startedAt: new Date().toISOString(), styleId: production.style?.id || null, styleName: production.style?.name || null }
      await writeFile(path.join(dir, 'production.json'), JSON.stringify(production, null, 2) + '\n')
      await runJob(state, production, dir, saved, auth, prior, false, release)
      return state
    } catch (e) { active = false; release?.(); throw e }
  }
  async function abandon(id) {
    if (!memberProject || typeof id !== 'string' || !id) throw new Error('缺少本项目的制作授权。')
    if (active) throw new Error('制作仍在运行，请等待当前任务结束。')
    const release = memberProject.hold()
    active = true
    generation++
    try {
      const state = await readState()
      if (state?.membershipAuthorizationId === id && state.status === 'completed') {
        throw new Error(state.membershipPending || state.membershipError ? '成片已保存，请补交完成回执。' : '该片的制作授权已完成。')
      }
      const outcome = await memberProject.close('abandon', id)
      if (outcome !== 'abandoned') throw new Error('会员授权已完成。')
      if (state?.membershipAuthorizationId === id && state.status !== 'abandoned') {
        await save({ ...state, status: 'abandoned', phase: '已放弃', error: undefined })
      }
    } finally { active = false; release() }
  }
  async function file(kind, section, jobId) {
    const state = jobId ? {id:jobId} : await status()
    if (!state?.id || !jobIdPattern.test(state.id)) throw new Error('成片尚不可用')
    const dir = path.join(root, state.id)
    const kinds = {
      source: path.join(dir, 'source.zip'),
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
  return { start, abandon, status, file, isActive: () => active }
}

// Archive only editable scenes, their declared images and timing data.
async function sourceArchive(dir, kit) {
  const script = [
    'import pathlib, sys, zipfile',
    'root = pathlib.Path(sys.argv[1])',
    "with zipfile.ZipFile(root/'.source.zip.tmp', 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
    "    for relative in ('production.json', 'scenes', 'assets', 'images', '现成素材', 'film/audio', 'film/mapping.json'):",
    '        source = root / relative',
    '        for file in (source.rglob("*") if source.is_dir() else [source]):',
    '            if file.is_file() and file.resolve().is_relative_to(root.resolve()): archive.write(file, file.relative_to(root))',
  ].join('\n')
  await new Promise((resolve, reject) => {
    const python = process.env.VIDEO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const child = spawn(python, ['-c', script, dir], {cwd:kit, stdio:['ignore','ignore','pipe']})
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('源码归档失败：'+error.trim())))
  })
}
