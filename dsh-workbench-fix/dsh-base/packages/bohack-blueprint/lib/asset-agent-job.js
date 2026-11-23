import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendJsonl, physicalPath, prepareSkillRuntime } from './skill-runtime.js'
import { runVideoAgent } from './video-agent.js'

const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
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
    const viewed = new Map(), pending = new Map()
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
    const tools = [
      { name: 'view_image', description: '渲染并查看一个素材文件，提交每个变体前必须查看其当前版本。', parameters: schema({ file: str }), execute: async ({ file }) => {
        const result = await inspect(file)
        pending.set(file, result.hash)
        return { ok: true, width: result.width, height: result.height, transparent: result.transparent, image: { mimeType: 'image/png', data: result.image.toString('base64') } }
      }, onImageProjected: ({ file }) => { if (pending.has(file)) viewed.set(file, pending.get(file)) } },
      { name: 'submit_assets', description: '提交完整素材清单；每个文件须先通过 view_image 自检。', parameters: schema({ manifest: { type: 'object', properties: { version: { type: 'integer' }, producer: str, styleId: str, assets: { type: 'array', items: { type: 'object', properties: { id: str, name: str, type: str, sections: { type: 'array', items: str }, files: { type: 'array', items: { type: 'object', properties: { variant: str, path: str, width: { type: 'integer' }, height: { type: 'integer' }, transparent: { type: 'boolean' } }, required: ['variant', 'path', 'width', 'height', 'transparent'], additionalProperties: false } }, sourceScript: str, usageHint: str }, required: ['id', 'name', 'type', 'sections', 'files', 'sourceScript', 'usageHint'], additionalProperties: false } } }, required: ['version', 'producer', 'styleId', 'assets'], additionalProperties: false } }), execute: async ({ manifest }) => {
        if (manifest?.version !== 1 || manifest.producer !== 'code-agent' || manifest.styleId !== styleId || !Array.isArray(manifest.assets)) throw new Error('素材清单格式无效。')
        if (planned.size && manifest.assets.length !== planned.size || !planned.size && !selectedPackage && manifest.assets.length) throw new Error('提交的素材与计划不符。')
        const ids = new Set(), paths = new Set(), scripts = new Set()
        const validated = []
        for (const asset of manifest.assets) {
          const expected = planned.get(asset.id)
          if (!idPattern.test(asset.id || '') || ids.has(asset.id) || !types.has(asset.type) || typeof asset.name !== 'string' || !asset.name || !Array.isArray(asset.sections) || asset.sections.some(id => !sectionIds.has(id)) || new Set(asset.sections).size !== asset.sections.length || planned.size && (!expected || asset.type !== expected.type || asset.name !== expected.name || JSON.stringify([...asset.sections].sort()) !== JSON.stringify([...expected.sections].sort()))) throw new Error(`素材编号、类型或段落不符合计划：${asset.id}`)
          ids.add(asset.id)
          const source = safePath(asset.sourceScript, 'assets/src/')
          if (scripts.has(physicalPath(source)) || !(await stat(source)).isFile()) throw new Error(`素材需要独立源码：${asset.id}`)
          scripts.add(physicalPath(source))
          if (!Array.isArray(asset.files) || !asset.files.length || typeof asset.usageHint !== 'string') throw new Error(`素材缺少变体：${asset.id}`)
          const variants = new Set()
          const files = []
          for (const file of asset.files) {
            const target = safePath(file.path)
            if (file.path.startsWith('assets/review/') || file.path.startsWith('assets/src/')) throw new Error('素材变体不能放在源码或预览目录。')
            if (!idPattern.test(file.variant || '') || variants.has(file.variant) || paths.has(physicalPath(target))) throw new Error('素材变体编号或路径重复。')
            variants.add(file.variant); paths.add(physicalPath(target))
            const result = await inspect(file.path)
            if (viewed.get(file.path) !== result.hash) throw new Error(`素材未查看或查看后已修改：${file.path}`)
            if (file.width !== result.width || file.height !== result.height || file.transparent !== result.transparent) throw new Error(`素材尺寸或透明度与实际不符：${file.path}`)
            const preview = `assets/review/${asset.id}_${file.variant}.png`
            await writeFile(safePath(preview, 'assets/review/'), result.image)
            files.push({ ...file, preview })
          }
          validated.push({ ...asset, files })
        }
        const result = { ...manifest, assets: validated }
        await writeFile(safePath('assets/manifest.json'), JSON.stringify(result, null, 2) + '\n')
        return { ok: true, manifest: result }
      } },
    ]
    const prompt = `你是编码素材制作 Agent。${runtime.name ? `先调用 skill 工具加载「${runtime.name}」，读取 asset-brief.json 中选定风格对应的原版视觉规范与引用资料。` : '按蓝图风格制作。'} 工作目录：${dir}；完整需求、蓝图、只读参考路径、上一版素材和反馈见 asset-brief.json。素材写在 assets/，每个主体的独立可运行源码写在 assets/src/。上一版及参考资料只读；局部修改应读取上一版 sourceScript，复制后针对反馈修改，保留其余主体。计划素材不为空时仅制作并完整提交这些素材；为空时可按选中 Skill 自主规划相关素材，不需要时提交空清单。每个变体可用 PNG、WebP 或 SVG；用 view_image 查看每个最终文件，检查轮廓、比例、透明度与风格，必要时改源码重做。用 submit_assets 提交 {manifest:{version:1,producer:"code-agent",styleId:"${styleId}",assets:[{id,name,type,sections,files:[{variant,path,width,height,transparent}],sourceScript,usageHint}]}}；路径相对于工作目录，段落编号必须来自蓝图。尺寸和透明度必须与真实文件一致。不要提问或修改只读资料。`
    const result = await runAgent({ ctx, sessionId, cwd: dir, model, provider, reasoningEffort, prompt, tools, onProgress, onTiming: timing, runtime, preset: 'bohack-skill-runner', submitTool: 'submit_assets', statusText: '正在编码制作素材', continuation: '完成剩余素材并查看每个最终变体，然后调用 submit_assets。遇到无法解决的问题如实报告。' })
    if (!result?.manifest) throw new Error('素材 Agent 未提交清单。')
    return result.manifest
  } finally {
    await browser?.close()
    await rm(runtime.tmp, { recursive: true, force: true })
  }
}
