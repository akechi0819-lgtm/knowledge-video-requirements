import { mkdir, mkdtemp, rm, readFile, readdir, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { appendFileSync, readlinkSync, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir as osTmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { discoverInstalledSkills } from './skill-packages.js'

const run = promisify(execFile)
const within = (file, root) => file === root || file.startsWith(root + path.sep)
const runtimeSubdirs = ['.claude/skills', '.agents/skills']
let syncTail = Promise.resolve()

export function appendJsonl(dir, file, record) {
  appendFileSync(path.join(dir, file), JSON.stringify(record) + '\n', { mode: 0o600 })
}

export function physicalPath(file, links = 0) {
  if (links > 40) throw new Error('任务路径包含循环符号链接。')
  try { return realpathSync(file) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(file)
    if (file === parent) throw error
    let destination
    try { destination = readlinkSync(file) }
    catch (linkError) { if (!['ENOENT', 'EINVAL'].includes(linkError.code)) throw linkError }
    return destination === undefined
      ? path.join(physicalPath(parent, links), path.basename(file))
      : physicalPath(path.resolve(parent, destination), links + 1)
  }
}

async function optional(file, read) {
  try { return await read(file) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function syncLinks(root, skills) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && !skills.has(entry.name)) await unlink(path.join(root, entry.name))
  }
  for (const [name, directory] of skills) {
    const target = path.join(root, name)
    const current = await optional(target, readlink)
    if (current === directory) continue
    const next = path.join(root, `.${name}-${randomUUID()}`)
    await symlink(directory, next, 'dir')
    await rename(next, target)
  }
}

async function toolCheck(name, command, args, env, cwd) {
  try { await run(command, args, { cwd, env, timeout: 15000 }) }
  catch (error) {
    throw new Error(`制作环境缺少可用的 ${name}（${error.code ?? error.name}）。桌面版请重新安装讲界，开发态请按 video-kit/README.md 安装依赖后重试。`)
  }
}

export async function prepareSkillRuntime({ repo, workspace, dir, previousDir, selectedSkill, selectedDirectory, kit, settings, style, readOnlyPaths = [] }) {
  const desktopWorkspace = process.env.JIANGJIE_DESKTOP_WORKSPACE
  const home = path.resolve(desktopWorkspace ? path.join(desktopWorkspace, '..', 'skill-runtime') : path.join(repo, '.runtime/skill-runtime'))
  await mkdir(home, { recursive: true, mode: 0o700 })
  const installed = await discoverInstalledSkills({ repo, workspace })
  const skills = new Map(installed.map(item => [item.folder, item.dir]))
  const selected = selectedDirectory ? await realpath(selectedDirectory) : skills.get(selectedSkill)
  if (selectedDirectory && ![...skills.values()].includes(selected)) throw new Error('选中的 Skill 不在已安装目录中。')
  if (selectedSkill && !selected) throw new Error(`原版 Skill 未安装：${selectedSkill}；请按项目安装说明安装上游资源。`)
  const aliases = new Map(skills)
  const catalog = new Map()
  let hasCollision = false
  const names = new Map()
  const byDirectory = new Map(installed.map(item => [item.dir, item.name]))
  for (const [directory, name] of [...byDirectory].sort(([first], [second]) => first.localeCompare(second))) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`原版 Skill 缺少有效的 name：${directory}`)
    names.set(directory, name)
    if (aliases.has(name) && aliases.get(name) !== directory || catalog.has(name) && catalog.get(name) !== directory) hasCollision = true
    if (!aliases.has(name)) aliases.set(name, directory)
    if (!catalog.has(name)) catalog.set(name, directory)
  }
  const name = names.get(selected)
  // A selected alias is task-local; never rewrite the shared HOME for it.
  const taskAliases = new Map(aliases)
  if (selected) { catalog.set(name, selected); taskAliases.set(name, selected); if (selectedSkill) taskAliases.set(selectedSkill, selected) }
  const catalogRoot = path.join(dir, '.dsh/skills')
  const python = (await optional(path.join(home, 'venv/bin/python3'), stat)) ? path.join(home, 'venv/bin/python3') : style.paths.python
  const cache = path.join(home, '.cache')
  const managedBrowserCache = path.join(home, 'Library/Caches/ms-playwright')
  const localBrowserCache = path.join(homedir(), 'Library/Caches/ms-playwright')
  const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH === '0' ? '0' : path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (await optional(localBrowserCache, stat) ? localBrowserCache : managedBrowserCache))
  const env = {
    HOME: home, XDG_CACHE_HOME: cache,
    UV_CACHE_DIR: path.join(cache, 'uv'), PIP_CACHE_DIR: path.join(cache, 'pip'), npm_config_cache: path.join(cache, 'npm'),
    PLAYWRIGHT_BROWSERS_PATH: browserCache, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    NODE_PATH: path.join(kit, 'node_modules'), VIDEO_PYTHON: python,
    PATH: [...new Set([python, style.paths.ffmpeg, style.paths.ffprobe, process.execPath]
      .filter(path.isAbsolute).map(path.dirname).concat(process.env.PATH || ''))].join(path.delimiter),
  }
  for (const [key, value] of Object.entries({ VIDEO_BROWSER: style.paths.edge, VIDEO_PLAYWRIGHT: style.paths.playwright, VIDEO_FFMPEG: style.paths.ffmpeg, VIDEO_FFPROBE: style.paths.ffprobe })) {
    if (value) env[key] = value
  }
  const tts = settings.tts || {}
  for (const [key, value] of Object.entries({ VIDEO_TTS_ENDPOINT: tts.baseUrl, VIDEO_TTS_KEY: tts.apiKey, VIDEO_TTS_MODEL: tts.model, VIDEO_TTS_PROTOCOL: tts.protocol, VIDEO_VOICE: tts.voice && `api:${tts.voice}` })) {
    if (value) env[key] = value
  }
  if (tts.protocol === 'mimo' && tts.apiKey && tts.baseUrl) {
    env.MIMO_BASE_URL = tts.baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
    env.MIMO_API_KEY = tts.apiKey
  }

  // Serialize shared HOME updates. Each job's environment and selected catalog entry are independent.
  const sync = syncTail.then(async () => {
    await Promise.all(runtimeSubdirs.map(relative => syncLinks(path.join(home, relative), aliases)))
    if (browserCache !== managedBrowserCache && browserCache !== '0' && !await optional(managedBrowserCache, stat)) {
      await mkdir(path.dirname(managedBrowserCache), { recursive: true, mode: 0o700 })
      await symlink(browserCache, managedBrowserCache, 'dir')
    }
    const config = path.join(home, '.config/ai-teardown')
    await mkdir(config, { recursive: true, mode: 0o700 })
    const target = path.join(config, 'mimo.env')
    if (env.MIMO_API_KEY) {
      const next = path.join(config, `mimo-${randomUUID()}.env`)
      await writeFile(next, `MIMO_BASE_URL=${env.MIMO_BASE_URL}\nMIMO_API_KEY=${env.MIMO_API_KEY}\n`, { mode: 0o600 })
      await rename(next, target)
    } else {
      await optional(target, unlink)
    }
  })
  syncTail = sync.catch(() => {})
  await sync
  await syncLinks(catalogRoot, catalog)

  const browser = style.paths.edge || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  await Promise.all([
    toolCheck('python3', python, ['--version'], env, dir),
    toolCheck('node', process.execPath, ['--version'], env, dir),
    toolCheck('ffmpeg', style.paths.ffmpeg, ['-version'], env, dir),
    toolCheck('ffprobe', style.paths.ffprobe, ['-version'], env, dir),
    toolCheck('Chromium', browser, ['--version'], env, dir),
    toolCheck('Playwright', process.execPath, ['-e', 'require(process.argv[1]).chromium', style.paths.playwright || 'playwright'], env, dir),
  ])
  const checkouts = installed.map(item => item.checkoutDir).filter(Boolean)
  const readRoots = [dir, previousDir, home, ...skills.values(), ...checkouts, ...readOnlyPaths].filter(Boolean).map(physicalPath)
  const requirements = selected && path.join(selected, 'requirements.txt')
  if (requirements && await optional(requirements, stat)) {
    const check = [
      'import sys, importlib.metadata as md',
      'try: from packaging.requirements import Requirement',
      'except ModuleNotFoundError: from pip._vendor.packaging.requirements import Requirement',
      'for line in open(sys.argv[1], encoding="utf-8"):',
      '    line = line.split(" #", 1)[0].strip()',
      '    if not line or line.startswith("#"): continue',
      '    req = Requirement(line)',
      '    if req.marker and not req.marker.evaluate(): continue',
      '    try: installed = md.version(req.name)',
      '    except md.PackageNotFoundError: installed = None',
      '    if installed is None or installed not in req.specifier: print(line)',
    ].join('\n')
    const { stdout } = await run(python, ['-c', check, requirements], { cwd: dir, env, timeout: 15000 })
    if (stdout.trim()) throw new Error(`原版 Skill 缺少 Python 依赖：${stdout.trim().replaceAll('\n', '、')}。请在受管 Python 环境执行 python3 -m pip install -r "${requirements}" 后重试。`)
  }
  // Chromium uses MAC_CHROMIUM_TMPDIR for a Unix socket with a short path limit.
  const tmp = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : osTmpdir(), 'jiangjie-'))
  if (hasCollision && selected) {
    const taskHome = path.join(tmp, 'home')
    await mkdir(taskHome, { recursive: true, mode: 0o700 })
    for (const relative of ['.cache', '.config', 'Library', 'venv', '.npm', '.local']) {
      const shared = path.join(home, relative)
      await mkdir(shared, { recursive: true, mode: 0o700 })
      await symlink(shared, path.join(taskHome, relative), 'dir')
    }
    await Promise.all(runtimeSubdirs.map(relative => syncLinks(path.join(taskHome, relative), taskAliases)))
    env.HOME = taskHome
  }
  env.TMPDIR = tmp
  if (process.platform === 'darwin') env.MAC_CHROMIUM_TMPDIR = tmp
  const runtime = { home: env.HOME, dir: physicalPath(dir), tmp, selected, name, names: new Set(catalog.keys()), catalogRoot, env, readRoots: [...readRoots, tmp] }
  try {
    for (const [file, command] of selected ? [['scripts/doctor.py', python], ['scripts/doctor.sh', '/bin/bash'], ['scripts/doctor.mjs', process.execPath]] : []) {
      const target = path.join(selected, file)
      if (!await optional(target, stat)) continue
      try { await run(command, [target], { cwd: runtime.dir, env, timeout: 30000 }) }
      catch (error) {
        let detail = (error.stderr || error.stdout || error.message).trim()
        for (const key of [env.MIMO_API_KEY, env.VIDEO_TTS_KEY].filter(Boolean)) detail = detail.replaceAll(key, '[REDACTED]')
        throw new Error(`原版 Skill 诊断失败（${file}）：${detail.slice(0, 1000)}。请按该 Skill 的安装说明修复受管运行时后重试。`)
      }
    }
    return runtime
  } catch (error) {
    await rm(tmp, { recursive: true, force: true })
    throw error
  }
}

export function expandRuntimeHome(runtime, file) {
  return file === '~' || file.startsWith('~/') ? runtime.home + file.slice(1) : file
}

export function checkRuntimePath(runtime, cwd, file, write = false) {
  const target = physicalPath(path.resolve(cwd, expandRuntimeHome(runtime, file)))
  if (!(write ? [runtime.dir, runtime.tmp] : runtime.readRoots).some(root => within(target, root))) {
    throw new Error(write ? '只能写入当前制作任务目录。' : '只能读取当前或上一版任务、已安装 Skill 和受管运行时。')
  }
  return target
}
