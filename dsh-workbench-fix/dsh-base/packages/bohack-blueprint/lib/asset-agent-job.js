import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendJsonl, physicalPath, prepareSkillRuntime } from './skill-runtime.js'
import { runVideoAgent } from './video-agent.js'

const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const str = { type: 'string' }
const idPattern = /^[A-Za-z0-9_-]+$/
const types = new Set(['character', 'prop', 'background'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (file, root) => file.startsWith(root + path.sep)

export async function runAssetAgentJob({ ctx, sessionId, dir, kit, repo, workspace, selectedPackage, settings = {}, model, provider, reasoningEffort, production, assets, references = [], priorAssets = [], feedback = '', onProgress, runAgent = runVideoAgent }) {
  dir = path.resolve(dir)
  if (!Array.isArray(assets) || !Array.isArray(production?.sections)) throw new Error('素材清单或蓝图段落无效。')
  const sectionIds = new Set(production.sections.flatMap(section => [section.id, section.blueprintId]).filter(Boolean))
  const planned = new Map()
  for (const asset of assets) {
    if (!idPattern.test(asset.id || '') || planned.has(asset.id) || !types.has(asset.type) || !asset.name || !Array.isArray(asset.sections) || asset.sections.some(id => !sectionIds.has(id))) throw new Error('计划素材的编号、类型或段落无效。')
    planned.set(asset.id, asset)
  }
  const styleId = production.style?.id || 'general'
  const statusText = '正在编码制作素材'
  const activity = text => onProgress?.({ type: 'activity', text })
  await onProgress?.({ type: 'status', text: statusText })
  activity(`正在加载风格规范并规划素材${planned.size ? `（共 ${planned.size} 件素材）` : ''}…`)
  const assetDir = path.join(dir, 'assets')
  await mkdir(path.join(assetDir, 'src'), { recursive: true })
  await mkdir(path.join(assetDir, 'review'), { recursive: true })
  const assetRoot = physicalPath(assetDir)
  const safePath = (relative, prefix = 'assets/') => {
    if (typeof relative !== 'string' || !relative.startsWith(prefix) || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\')) throw new Error(`素材路径无效：${relative}`)
    const target = path.resolve(dir, relative)
    if (!inside(physicalPath(target), assetRoot)) throw new Error(`素材路径越界：${relative}`)
    return target
  }
  for (const file of ['timings.jsonl', 'commands.jsonl']) await writeFile(path.join(dir, file), '', { flag: 'a', mode: 0o600 })
  const timing = record => appendJsonl(dir, 'timings.jsonl', record)
  const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
  const runtime = await prepareSkillRuntime({ repo, workspace, dir, selectedSkill: selectedPackage?.skill, selectedDirectory: selectedPackage?.directory, kit, settings, style, readOnlyPaths: [...references, ...priorAssets.map(item => item.root)] })
  let browser
  try {
    await writeFile(path.join(dir, 'asset-brief.json'), JSON.stringify({ production, assets, references, priorAssets, feedback, skillMode: selectedPackage?.mode, skillReferences: selectedPackage?.references }, null, 2))
    const require = createRequire(import.meta.url)
    const { chromium } = require(style.paths.playwright)
    browser = await chromium.launch({ executablePath: style.paths.edge, headless: true, args: ['--disable-webrtc', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.abort())
    const page = await context.newPage()
    const viewed = new Map(), pending = new WeakMap()
    let inspection = Promise.resolve()
    function inspect(relative) {
      const next = inspection.then(() => renderPreview(relative))
      inspection = next.catch(() => {})
      return next
    }
    async function renderPreview(relative) {
      const target = safePath(relative)
      const ext = path.extname(target).toLowerCase()
      const mime = { '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext]
      if (!mime) throw new Error('素材只支持 PNG、WebP 和 SVG。')
      const bytes = await readFile(target)
      if (ext === '.png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || ext === '.webp' && (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP')) throw new Error('素材文件格式与扩展名不符。')
      await page.setContent('<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img>')
      const info = await page.evaluate(async ({ data, mime }) => {
        const img = document.querySelector('img')
        img.src = `data:${mime};base64,${data}`
        await img.decode()
        const width = img.naturalWidth, height = img.naturalHeight
        if (!width || !height || width > 8192 || height > 8192) throw new Error('素材尺寸无效或过大')
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
        const pixels = ctx.getImageData(0, 0, width, height).data
        let transparent = false
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { transparent = true; break }
        return { width, height, transparent }
      }, { data: bytes.toString('base64'), mime })
      await page.setViewportSize({ width: info.width, height: info.height })
      const image = await page.locator('img').screenshot({ type: 'png', omitBackground: true, animations: 'disabled' })
      return { ...info, image, hash: digest(bytes) }
    }
    const fileSchema = schema({
      variant: str, path: str, width: { type: 'integer' }, height: { type: 'integer' }, transparent: { type: 'boolean' },
    }, ['variant', 'path'])
    const assetSchema = schema({
      id: str, name: str, type: str, sections: { type: 'array', items: str },
      files: { type: 'array', items: fileSchema }, sourceScript: str, usageHint: str,
    }, ['id', 'files', 'sourceScript', 'usageHint', ...(planned.size ? [] : ['name', 'type', 'sections'])])
    const manifestSchema = schema({
      version: { type: 'integer' }, producer: str, styleId: str, assets: { type: 'array', items: assetSchema },
    })
    const tools = [
      { name: 'view_image', description: '渲染并查看一个素材文件，提交每个变体前必须查看其当前版本。', parameters: schema({ file: str }), execute: async args => {
        const { file } = args
        activity(`正在视觉自检素材（已查 ${viewed.size} 个变体）：${path.basename(file)}`)
        const result = await inspect(file)
        pending.set(args, result.hash)
        return { ok: true, width: result.width, height: result.height, transparent: result.transparent, image: { mimeType: 'image/png', data: result.image.toString('base64') } }
      }, onImageProjected: args => {
        if (pending.has(args)) viewed.set(args.file, pending.get(args))
        pending.delete(args)
      } },
      { name: 'submit_assets', description: '提交完整素材清单；每个文件须先通过 view_image 自检。', parameters: schema({ manifest: manifestSchema }), execute: async ({ manifest }) => {
        activity('正在校验并提交素材清单…')
        if (manifest?.version !== 1 || manifest.producer !== 'code-agent' || manifest.styleId !== styleId || !Array.isArray(manifest.assets)) throw new Error('素材清单格式无效。')
        if (planned.size && manifest.assets.length !== planned.size || !planned.size && !selectedPackage && manifest.assets.length) throw new Error('提交的素材与计划不符。')
        const ids = new Set(), paths = new Set(), scripts = new Map()
        const normalized = []
        for (const entry of manifest.assets) {
          const asset = { ...entry }
          const expected = planned.get(asset.id)
          if (!idPattern.test(asset.id || '') || ids.has(asset.id)) throw new Error(`素材编号无效或重复：${asset.id}`)
          if (planned.size && !expected) throw new Error(`素材 ${asset.id} 不在计划中。期望编号：${[...planned.keys()].join('、')}`)
          if (expected) {
            for (const field of ['name', 'type', 'sections']) {
              if (asset[field] === undefined) asset[field] = expected[field]
              else {
                const matches = field === 'sections'
                  ? Array.isArray(asset.sections) && JSON.stringify([...asset.sections].sort()) === JSON.stringify([...expected.sections].sort())
                  : asset[field] === expected[field]
                if (!matches) throw new Error(`素材 ${asset.id} 的 ${field} 与计划冲突，期望值：${JSON.stringify(expected[field])}`)
              }
            }
          }
          if (!types.has(asset.type) || typeof asset.name !== 'string' || !asset.name || !Array.isArray(asset.sections) || asset.sections.some(id => !sectionIds.has(id)) || new Set(asset.sections).size !== asset.sections.length) throw new Error(`素材名称、类型或段落无效：${asset.id}`)
          ids.add(asset.id)
          const hint = `素材 ${asset.id} 需要独立源码，请保存到 assets/src/${asset.id}.js 等专用文件。`
          let source
          try { source = physicalPath(safePath(asset.sourceScript, 'assets/src/')) }
          catch (error) { throw new Error(`${hint} ${error.message}`) }
          if (!inside(source, path.join(assetRoot, 'src'))) throw new Error(hint)
          const info = await stat(source).catch(error => {
            if (error.code !== 'ENOENT') throw error
          })
          if (!info?.isFile()) throw new Error(hint)
          const owner = scripts.get(source)
          if (owner) throw new Error(`素材 ${asset.id} 与 ${owner} 共用源码。 ${hint}`)
          scripts.set(source, asset.id)
          if (!Array.isArray(asset.files) || !asset.files.length || typeof asset.usageHint !== 'string') throw new Error(`素材缺少变体：${asset.id}`)
          normalized.push(asset)
        }
        const validated = []
        for (const asset of normalized) {
          const variants = new Set()
          const files = []
          for (const file of asset.files) {
            const target = safePath(file.path)
            if (file.path.startsWith('assets/review/') || file.path.startsWith('assets/src/')) throw new Error('素材变体不能放在源码或预览目录。')
            if (!idPattern.test(file.variant || '') || variants.has(file.variant) || paths.has(physicalPath(target))) throw new Error('素材变体编号或路径重复。')
            variants.add(file.variant); paths.add(physicalPath(target))
            const result = await inspect(file.path)
            if (viewed.get(file.path) !== result.hash) throw new Error(`素材未查看或查看后已修改：${file.path}`)
            const preview = `assets/review/${asset.id}_${file.variant}.png`
            await writeFile(safePath(preview, 'assets/review/'), result.image)
            files.push({ ...file, width: result.width, height: result.height, transparent: result.transparent, preview })
          }
          validated.push({ ...asset, files })
        }
        const result = { ...manifest, assets: validated }
        await writeFile(safePath('assets/manifest.json'), JSON.stringify(result, null, 2) + '\n')
        return { ok: true, manifest: result }
      } },
    ]
    const planText = planned.size
      ? `只制作并完整提交以下计划素材（id / name / type / sections）。\n${assets.map(({ id, name, type, sections }) => JSON.stringify({ id, name, type, sections })).join('\n')}\n匹配计划的素材可在提交时省略 name、type、sections。`
      : '按选中 Skill 自主规划素材，提交时填写 name、type、sections，段落编号取自蓝图。不需要素材时提交空清单。'
    const prompt = `你是编码素材制作 Agent。工作目录：${dir}。系统已创建 assets/、assets/src/、assets/review/，无需 mkdir 或 glob 空目录。
${runtime.name ? `先调用 skill 加载「${runtime.name}」，按所选风格的原版视觉规范制作。` : '按蓝图风格制作。'} 完整蓝图、参考资料、上一版素材与反馈见 asset-brief.json。
${planText}
每件素材须有独立可运行源码，例如 assets/src/<id>.js 或 .py，多个素材不得共用同一文件。可并行写入独立源码，再用一条命令生成所有素材。上一版及参考资料只读；局部修改时复制上一版对应的 sourceScript 后修改，保留其他主体。
变体使用 PNG、WebP 或 SVG。批量调用 view_image 检查每个最终变体的轮廓、比例、透明度与风格。改图后须重新查看。确认后一次调用 submit_assets 提交 {manifest:{version:1,producer:"code-agent",styleId:"${styleId}",assets:[{id,${planned.size ? '' : 'name,type,sections,'}files:[{variant,path}],sourceScript,usageHint}]}}。路径相对于工作目录，尺寸和透明度由服务端测量。不要提问。`
    const result = await runAgent({ ctx, sessionId, cwd: dir, model, provider, reasoningEffort, prompt, tools, onProgress, onTiming: timing, runtime, preset: 'bohack-skill-runner', submitTool: 'submit_assets', statusText, continuation: '完成剩余素材并查看每个最终变体，然后调用 submit_assets。遇到无法解决的问题如实报告。' })
    if (!result?.manifest) throw new Error('素材 Agent 未提交清单。')
    return result.manifest
  } finally {
    await browser?.close()
    await rm(runtime.tmp, { recursive: true, force: true })
  }
}
