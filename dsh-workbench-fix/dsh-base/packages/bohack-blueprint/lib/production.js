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
  async function status() {
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    if (state.status === 'running' && !active) { state.status = 'interrupted'; state.error = '工作台已重启，制作中断，请重新制作。'; await save(state) }
    return state
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
      const production = await exportProduction(workspace)
      const missing = production.sections.filter(s => !s.narration?.trim()).map(s => s.blueprintId)
      if (missing.length) throw new Error(`缺少旁白：${missing.join('、')}；请补充后重新确认并定稿。`)
      let sceneConfig = null
      try { sceneConfig = JSON.parse(await readFile(path.join(workspace, 'hotpot-demo-scene.json'), 'utf8')) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (sceneConfig && sceneConfig.version !== 1) throw new Error('本创作的专用场景配置版本不支持。')
      // Choosing a style explicitly routes this version through the style-aware renderer.
      if (production.style) sceneConfig = null
      const sceneMode = process.env.SCENE_MODE || 'api'
      if (!sceneConfig && !['api', 'dsh'].includes(sceneMode)) throw new Error('SCENE_MODE 只支持 api 或 dsh。')
      const customScene = !(await config.projectModel?.isSaved()) && Boolean(process.env.SCENE_ENDPOINT || process.env.SCENE_MODEL)
      const projectModel = config.projectModel ? await config.projectModel.resolve() : { endpoint: process.env.WORKBENCH_MODEL_ENDPOINT, model: process.env.WORKBENCH_MODEL_NAME, key: process.env.WORKBENCH_MODEL_KEY }
      const endpoint = customScene ? process.env.SCENE_ENDPOINT : projectModel.endpoint
      const model = customScene ? process.env.SCENE_MODEL : projectModel.model
      const key = customScene ? process.env.SCENE_API_KEY : projectModel.key
      if (!sceneConfig && sceneMode === 'api' && (!model || !endpoint ||
          (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)))) {
        throw new Error('未配置可用的画面模型，请设置项目通用模型或 SCENE 专用模型。')
      }
      await mkdir(root, { recursive: true })
      const id = randomUUID(), dir = path.join(root, id)
      await mkdir(dir)
      await bindImages(production, dir)
      await writeFile(path.join(dir, 'production.json'), JSON.stringify(production, null, 2) + '\n')
      const state = { id, status: 'running', phase: '生成画面', version: production.version, startedAt: new Date().toISOString() }
      await save(state)
      ;(async () => {
        try {
          const scenes = path.join(dir, 'scenes'), film = path.join(dir, 'film')
          const sceneArgs = ['--input', path.join(dir, 'production.json'), '--output', scenes]
          if (sceneConfig) await run('scripts/hotpot-scenes.mjs', sceneArgs)
          else await run('scripts/prepare-scenes.mjs', sceneMode === 'dsh' ? [...sceneArgs, '--dsh'] : [...sceneArgs, '--endpoint', endpoint, '--model', model], { ...process.env, SCENE_API_KEY: key || '' })
          state.phase = '配音与渲染'; await save(state)
          const args = ['--prepared', path.join(scenes, 'production.json'), '--out', film]
          if (process.env.VIDEO_VOICE) args.push('--voice', process.env.VIDEO_VOICE)
          else if (process.env.VOICE_NAME) args.push('--voice', `api:${process.env.VOICE_NAME}`)
          await run('WORK/modules/video/pipeline.mjs', args)
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
  async function file(kind) {
    const state = await status()
    if (state?.status !== 'completed' || !/^[0-9a-f-]{36}$/.test(state.id) || !['video', 'mapping'].includes(kind)) throw new Error('成片尚不可用')
    return path.join(root, state.id, 'film', kind === 'video' ? 'final.mp4' : 'mapping.json')
  }
  return { start, status, file }
}
