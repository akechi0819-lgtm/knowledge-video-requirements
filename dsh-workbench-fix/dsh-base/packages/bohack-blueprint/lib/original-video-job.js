import { copyFile, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { assetFile, readAssetManifest } from './generated-assets.js'
import { appendJsonl, checkRuntimePath, prepareSkillRuntime } from './skill-runtime.js'
import { childEnvironment, resolveTool } from './runtime.js'

const runFile = promisify(execFile)
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const str = { type: 'string' }

export async function verifyOriginalFilm(film, production, kit) {
  const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
  const file = path.join(film, 'final.mp4')
  const invalidFilm = message => Object.assign(new Error(message), { code: 'INVALID_FILM' })
  let info
  try { info = await stat(file) } catch (error) { if (error.code === 'ENOENT') throw invalidFilm('成片文件不存在。'); throw error }
  if (!info.isFile() || !info.size) throw invalidFilm('成片文件为空或无效。')
  async function audited(command, args) {
    const start = Date.now()
    let stderr = '', exitCode = null
    try {
      const result = await runFile(command, args, { cwd: film, env: childEnvironment(process.env, [command]), maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      stderr = result.stderr
      exitCode = 0
      return result
    } catch (error) {
      exitCode = typeof error.code === 'number' ? error.code : null
      stderr = error.stderr || error.message
      if (typeof error.code !== 'number') throw error
      throw invalidFilm(`成片无法解码或检查：${stderr.slice(0, 500)}`)
    } finally {
      appendJsonl(path.dirname(film), 'commands.jsonl', { ts: new Date(start).toISOString(), cmd: [command, ...args].map(arg => JSON.stringify(arg)).join(' '), exitCode, durationMs: Date.now() - start, stderrHead: stderr.slice(0, 1000), cwd: process.cwd() })
    }
  }
  const probed = await audited(style.paths.ffprobe || resolveTool('ffprobe', process.env, kit), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file])
  const probe = JSON.parse(probed.stdout), duration = Number(probe.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0 || !probe.streams?.some(stream => stream.codec_type === 'video' && stream.width > 0 && stream.height > 0)) throw invalidFilm('成片不是有效视频')
  // Decode the complete video, count actual frames and detect a fully black film.
  const decoded = await audited(style.paths.ffmpeg || resolveTool('ffmpeg', process.env, kit), ['-v', 'info', '-xerror', '-i', file, '-map', '0:v:0', '-vf', 'blackdetect=d=0', '-an', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'])
  const counts = [...decoded.stdout.matchAll(/^frame=\s*(\d+)\s*$/gm)].map(match => Number(match[1]))
  if (!counts.length || Math.max(...counts) < 1) throw invalidFilm('成片没有可解码的视频帧。')
  const black = [...decoded.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
  if (black.some(match => Number(match[1]) <= 0.05 && Number(match[2]) >= duration - Math.max(0.1, duration * 0.01))) throw invalidFilm('成片画面全黑。')
  let mapping, mappingProblem
  try { mapping = JSON.parse(await readFile(path.join(film, 'mapping.json'), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') mappingProblem = '未提供段落映射，使用整片播放。'
    else if (error instanceof SyntaxError) mappingProblem = '段落映射格式无效，使用整片播放。'
    else throw error
  }
  const seen = new Set()
  if (mapping && (mapping.final_video !== 'final.mp4' || !Array.isArray(mapping.segments) || !mapping.segments.length || mapping.segments.some(segment => {
    if (!segment || typeof segment.id !== 'string' || !segment.id || seen.has(segment.id) || !Number.isFinite(segment.start_sec) || !Number.isFinite(segment.end_sec) || segment.start_sec < 0 || segment.start_sec >= segment.end_sec || segment.end_sec > duration + 0.05) return true
    seen.add(segment.id)
    return false
  }))) { mapping = null; mappingProblem = '段落映射内容无效，使用整片播放。' }
  const report = { pass: true, hardErrors: [], problems: mappingProblem ? [mappingProblem] : [], totalDuration: duration,
    mappingMode: mapping ? 'mapped' : 'full', segments: mapping ? mapping.segments.map(segment => ({ id: segment.id, start: segment.start_sec, end: segment.end_sec, issues: [] })) : [] }
  await writeFile(path.join(film, 'verify-report.json'), JSON.stringify(report, null, 2))
  return report
}

// The original skill owns the production process. The host only supplies a
// work directory, tools, and the existing final-film verification contract.
export async function runOriginalVideoJob({ ctx, sessionId, dir, production, kit, settings = {}, model, provider, reasoningEffort, feedback, previousDir, resume, onProgress, runVideoAgent, repo, workspace, manifest }) {
  const scenes = path.join(dir, 'scenes'), film = path.join(dir, 'film')
  await Promise.all([mkdir(scenes, { recursive: true }), mkdir(film, { recursive: true })])
  for (const file of ['timings.jsonl', 'commands.jsonl']) await writeFile(path.join(dir, file), '', { flag: 'a', mode: 0o600 })
  const timing = record => appendJsonl(dir, 'timings.jsonl', record)
  const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
  const start = Date.now()
  let runtime
  try {
    runtime = await prepareSkillRuntime({ repo, workspace, dir, previousDir, selectedSkill: manifest.skill, selectedDirectory: manifest.directory, kit, settings, style })
  } finally {
    const end = Date.now()
    timing({ type: 'phase', phase: 'preflight', start, end, elapsed: end - start, ok: !!runtime })
  }
  try {
    const assetManifest = await readAssetManifest(dir)
    if (assetManifest?.assets.length) {
      const mount = path.join(scenes, 'assets')
      const target = path.relative(scenes, path.join(dir, 'assets'))
      if (process.platform === 'win32') {
        const files = new Set(['assets/manifest.json', ...assetManifest.assets.flatMap(asset =>
          [asset.sourceScript, ...asset.files.flatMap(file => [file.path, file.preview])]).filter(Boolean)])
        for (const asset of files) {
          const input = await assetFile(dir, asset)
          const output = checkRuntimePath(runtime, scenes, asset, true)
          if (input === output) continue
          await mkdir(path.dirname(output), { recursive: true })
          await copyFile(input, output)
        }
      } else {
        try { await symlink(target, mount, 'dir') }
        catch (error) { if (error.code !== 'EEXIST' || await readlink(mount) !== target) throw error }
      }
    }
    await writeFile(path.join(dir, 'decisions.json'), JSON.stringify({
      version: production.version,
      topic: production.topic,
      contentOutline: production.contentOutline,
      userRequirements: production.userRequirements || [],
      notesAndBoundaries: production.notes || '',
      confirmedPoints: production.sections.map(section => ({
        id: section.blueprintId || section.id,
        title: section.title,
        intent: section.intent,
        facts: section.facts || [],
        notes: section.notes || '',
      })),
    }, null, 2) + '\n')
    await writeFile(path.join(dir, 'brief.json'), JSON.stringify({
      blueprint: 'scenes/blueprint.json',
      decisions: 'decisions.json',
      planning: {
        approvedContent: '保留已确认的核心内容、事实、出处、硬要求与表述边界。',
        structure: '原版 Skill 有结构规划时按其规划制作；否则沿用蓝图内容要点的顺序。',
        choices: '按 Skill 推荐自主决定并记录流程分支。',
        quality: '按 Skill 要求做预览、看图自检和修片。',
      },
      assetManifest: assetManifest ? 'assets/manifest.json' : null,
      existingMediaDirectory: '现成素材',
    }, null, 2) + '\n')
    const assetInstructions = assetManifest?.assets.length
      ? '先读取 brief.json 与 assets/manifest.json。清单中的主体和变体已由独立编码素材 Agent 按所选 Skill 自检交付，直接引用清单路径，在场景源码中用 assets/文件名（工程目录中的 assets 已映射到任务素材池）。不得重画已交付的主体。缺少的临时配件可按相同风格补充。另可读取现成素材目录。'
      : '任务入口见 brief.json；可按需查看现成素材目录。'
    await writeFile(path.join(scenes, 'blueprint.json'), JSON.stringify(production, null, 2))
    const references = (manifest.references || []).map(file => path.join(runtime.selected, file))
    let submitted = false
    const tools = [
      { name: 'view_image', description: '查看原版流程生成的预览图', parameters: schema({ file: str }), execute: async ({ file }) => {
        const target = checkRuntimePath(runtime, dir, file)
        const ext = path.extname(target).toLowerCase()
        const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext]
        if (!mimeType) throw new Error('仅支持 PNG、JPEG、WebP 预览')
        return { ok: true, image: { mimeType, data: (await readFile(target)).toString('base64') } }
      } },
      { name: 'submit', description: '完成原版制作与预览后校验并提交 film/final.mp4；映射可选', parameters: schema({}), execute: async () => {
        for (const file of ['final.mp4', 'mapping.json', 'verify-report.json']) checkRuntimePath(runtime, film, file, true)
        const report = await verifyOriginalFilm(film, production, kit)
        submitted = true
        return { ok: true, report }
      } },
    ]
    const prompt = `你是视频制作 Agent。先调用 skill 工具加载「${runtime.name}」，再用 read 按需读取其引用的资料。按该原版 Skill 完整制作，并调用其原生脚本。原版目录：${runtime.selected}；任务工作目录：${dir}；工程放在：${scenes}；最终交付目录：${film}。不得修改原版文件；需要改模板时复制到当前任务目录。${assetInstructions} 先读取 decisions.json 和蓝图：创作者已确认的内容主线、事实及来源、硬要求和表述边界必须完整保留，无需再次提问。若 Skill 自带结构、分镜、节奏或有无旁白的规划，遵循 Skill，可合并、拆分或调整蓝图段落；若没有规划方法，则按蓝图段落及顺序兜底。流程中的分支按 Skill 推荐方案自主决定并记录在 scenes/decisions-log.md。用 jobs 处理长渲染；按 Skill 要求预览、自检并修片，用 view_image 检查画面，发现问题后修改重看。必要的外部服务或依赖不可用时报告真实错误。完成后提供 film/final.mp4；可选提供 film/mapping.json，包含 final_video: "final.mp4" 和 segments（每项 id、start_sec、end_sec），无需强行对应蓝图段落。调用 submit 进行技术检查。修改意见：${feedback || '无'}。${previousDir ? `上一版：${previousDir}。` : ''}${resume ? '这是中断后的续作，沿用已完成的文件。' : ''}
  风格：${manifest.name}${manifest.mode ? `；选定原版模式：${manifest.mode}，按原文该模式制作` : ''}
  ${references.length ? '按需读取的资料：' + references.join('、') : ''}
  蓝图：scenes/blueprint.json`
    await runVideoAgent({ ctx, sessionId, cwd: dir, model, provider, reasoningEffort, prompt, tools, onProgress, onTiming: timing, runtime, preset: 'bohack-skill-runner', continuation: '继续按原版制作流程完成剩余工作；检查后调用 submit。遇到无法解决的依赖或服务错误时如实说明。' })
    if (!submitted) throw new Error('视频 Agent 未完成成片')
    return { scenes, film }
  } finally {
    await rm(runtime.tmp, { recursive: true, force: true })
  }
}
