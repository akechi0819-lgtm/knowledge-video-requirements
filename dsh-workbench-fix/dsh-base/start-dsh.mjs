import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, readlink, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { childEnvironment, runtimePaths, systemTool, writablePath } from '../../video-kit/WORK/modules/video/runtime.mjs'

const base = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.join(base, 'packages/bohack-blueprint')
const lockedVersion = '0.2.2-rc.1'
const sourceRoot = path.resolve(base, '../..')
const nativeDesktop = process.platform === 'win32' && process.env.JIANGJIE_WINDOWS_DESKTOP === '1'
let diagnostics
if (nativeDesktop) {
  const diagnosticsUrl = pathToFileURL(path.join(sourceRoot, 'desktop/windows/diagnostics.mjs')).href
  const module = await import(diagnosticsUrl)
  diagnostics = module.createDesktopDiagnostics({ env: process.env })
  void module.reportPreviousNativeCrash(diagnostics)
  process.once('uncaughtException', () => {
    stopDesktop?.()
    void diagnostics.reportCrash('supervisor').finally(() => process.exit(1))
  })
}

let parentClosed = false
let stopDesktop
if (nativeDesktop) {
  process.stdin.once('end', () => { parentClosed = true; stopDesktop?.() })
  process.stdin.resume()
}

async function seed(file, contents) {
  try { await writeFile(file, contents, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}

async function refresh(file, contents) {
  if (await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error }) === contents) return
  const next = file + '.' + randomUUID()
  await writeFile(next, contents, { flag: 'wx', mode: 0o600 })
  try { await rename(next, file) }
  finally { await unlink(next).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

async function seedWorkspace(from, to, app) {
  await mkdir(writablePath(to, app), { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const input = path.join(from, entry.name), output = path.join(to, entry.name)
    if (entry.isDirectory()) await seedWorkspace(input, output, app)
    else if (entry.isFile()) await seed(writablePath(output, app), await readFile(input))
  }
}

async function prepareProfile(dshHome, profile, app) {
  const source = path.join(base, '.dsh-home/profiles', profile)
  const target = writablePath(path.join(dshHome, 'profiles', profile), app)
  await mkdir(target, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    await seed(writablePath(path.join(target, name), app), await readFile(path.join(source, name)))
  }
  const bundle = path.join(target, 'node_modules/@bohack/blueprint')
  writablePath(path.dirname(bundle), app)
  const oldLink = await readlink(bundle).catch(error => {
    if (!['ENOENT', 'EINVAL', 'UNKNOWN'].includes(error.code)) throw error
  })
  if (oldLink !== undefined) {
    if (await realpath(bundle) !== await realpath(plugin)) throw new Error('Unexpected legacy blueprint link: ' + bundle)
    // Remove the legacy link only after checking its target. Its contents stay in the app tree.
    await unlink(bundle)
  }
  await mkdir(writablePath(bundle, app), { recursive: true })
  await refresh(writablePath(path.join(bundle, 'package.json'), app), await readFile(path.join(plugin, 'package.json'), 'utf8'))
  await refresh(writablePath(path.join(bundle, 'cordis.patch.yml'), app), await readFile(path.join(plugin, 'cordis.patch.yml'), 'utf8'))
  await mkdir(writablePath(path.join(bundle, 'lib'), app), { recursive: true })
  for (const name of ['index.js', 'lib/skill-process.js']) {
    await refresh(writablePath(path.join(bundle, name), app), 'export * from ' + JSON.stringify(pathToFileURL(path.join(plugin, name)).href) + '\n')
  }
  if (nativeDesktop) {
    const name = 'lib/windows-credentials.js'
    await refresh(writablePath(path.join(bundle, name), app), 'export { default } from ' + JSON.stringify(pathToFileURL(path.join(plugin, name)).href) + '\n')
  }
}

async function start() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) throw new Error('Node 24.9.0 or newer is required')
  const args = process.argv.slice(2)
  const cliMode = args[0] === '--cli'
  if (cliMode) args.shift()
  const setup = args[0] === '--setup'
  if (setup) args.shift()
  const profile = cliMode ? args[0] === '--profile' ? args[1] : args[0] : 'workbench'
  const inspect = args.some(arg => arg === '-h' || /^--(?:help|dump-config|dump-default-config)/.test(arg))
  const web = ['bohack', 'workbench'].includes(profile) && !inspect
  const dirs = runtimePaths(process.env, sourceRoot)
  const app = process.env.JIANGJIE_APP_ROOT ? dirs.app : undefined
  const data = dirs.data || path.join(base, '.dsh-home')
  const dshHome = writablePath(path.resolve(process.env.DSH_HOME || (dirs.data ? path.join(data, 'dsh') : data)), app)
  const workspace = writablePath(path.resolve(process.env.JIANGJIE_DESKTOP_WORKSPACE || process.env.JIANGJIE_WORKBENCH_WORKSPACE
    || (dirs.data ? path.join(data, 'workspace') : path.join(base, 'workspace'))), app)
  const cache = writablePath(dirs.cache || path.join(data, 'cache'), app)
  const tmp = writablePath(path.join(cache, 'tmp'), app)
  await mkdir(tmp, { recursive: true })
  for (const name of setup ? ['bohack', 'workbench'] : [profile]) {
    if (['bohack', 'workbench'].includes(name)) await prepareProfile(dshHome, name, app)
  }
  if (setup || web) {
    for (const name of ['.agents', 'rules']) await seedWorkspace(path.join(base, 'workspace', name), path.join(workspace, name), app)
  }
  if (setup) { console.log('DSH profiles prepared in ' + dshHome); return }
  if (nativeDesktop && web) {
    const [{ createSettings }, { createMembership }] = await Promise.all([
      import('./packages/bohack-blueprint/lib/settings.js'),
      import('./packages/bohack-blueprint/lib/membership.js'),
    ])
    await Promise.all([createSettings(workspace).load(), createMembership(null, workspace).prepareCredentials()])
  }

  const manifest = path.join(base, 'node_modules/@deepseek-ai/dsh/package.json')
  const installed = JSON.parse(await readFile(manifest, 'utf8'))
  if (installed.version !== lockedVersion || installed.bin?.dsh !== 'lib/bin.js') throw new Error('Expected DSH ' + lockedVersion + ' with lib/bin.js')
  const bin = path.join(path.dirname(manifest), installed.bin.dsh)
  const readyId = randomUUID()
  const env = {
    ...childEnvironment(process.env, [process.execPath, process.env.VIDEO_PYTHON, process.env.VIDEO_FFMPEG, process.env.VIDEO_FFPROBE]),
    DSH_HOME: dshHome, VIDEO_KIT_DIR: process.env.VIDEO_KIT_DIR || path.join(dirs.app, 'video-kit'),
    JIANGJIE_WORKBENCH_WORKSPACE: workspace, JIANGJIE_CACHE_DIR: cache, JIANGJIE_READY_ID: readyId,
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, XDG_CACHE_HOME: cache,
  }
  if (process.env.DSH_INTERNAL_TOKEN) env.DSH_INTERNAL_TOKEN = process.env.DSH_INTERNAL_TOKEN
  if (!cliMode) {
    args.unshift('--profile', profile)
    if (process.env.JIANGJIE_DESKTOP_DSH_PATCH) args.splice(2, 0, '--patch', process.env.JIANGJIE_DESKTOP_DSH_PATCH)
  }
  if (web) {
    let port = process.env.WORKBENCH_PORT || '0'
    for (let i = 2 - Number(cliMode && args[0] !== '--profile'); i < args.length; i++) {
      const [flag, inline] = args[i].split(/=(.*)/s)
      if (flag === '--port' || flag === '--host') {
        const value = inline ?? args[i + 1]
        args.splice(i, inline === undefined ? 2 : 1)
        i--
        if (flag === '--port') port = value
        else if (value !== '127.0.0.1') throw new Error('Workbench must bind to 127.0.0.1')
      } else if (/^--(?:$|public-url$|open$|trusted-host$|tls(?:-|$))/.test(flag)) {
        throw new Error('Unsupported local workbench option: ' + flag)
      }
    }
    if (!/^\d+$/.test(port ?? '') || Number(port) > 65535) throw new Error('Invalid workbench port')
    args.push('--host', '127.0.0.1', '--port', port, '--no-open')
  }

  if (parentClosed) return
  const executableArgs = nativeDesktop
    ? ['--import', pathToFileURL(path.join(sourceRoot, 'desktop/windows/dsh-shutdown.mjs')).href, bin, ...args] : [bin, ...args]
  delete env.JIANGJIE_DESKTOP_CRASH_DSN
  if (nativeDesktop) env.JIANGJIE_DESKTOP_DIAGNOSTICS = '1'
  const child = spawn(process.execPath, executableArgs, { cwd: web ? workspace : process.cwd(), env, windowsHide: true,
    stdio: nativeDesktop ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['inherit', web ? 'pipe' : 'inherit', 'inherit'] })
  const detachStderr = diagnostics?.capture('dsh', child.stderr)
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)))
  })
  let stopping = false
  const stop = () => {
    if (stopping || !child.pid) return
    stopping = true
    if (nativeDesktop) {
      if (child.connected) child.send('shutdown', error => {
        if (error) diagnostics?.log('supervisor', 'DSH shutdown IPC failed: ' + error.code)
      })
      return
    }
    if (process.platform !== 'win32') { child.kill(); return }
    const kill = spawn(systemTool('taskkill.exe', env), ['/pid', String(child.pid), '/T', '/F'],
      { env: childEnvironment(env), windowsHide: true, stdio: 'ignore' })
    kill.once('error', () => child.kill())
    kill.once('exit', code => { if (code !== 0) child.kill() })
  }
  stopDesktop = stop
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const abort = new AbortController()
  let watchdog
  try {
    if (web) {
      watchdog = setTimeout(() => {
        if (diagnostics) diagnostics.log('supervisor', 'Timed out waiting for workbench health')
        else console.error('Timed out waiting for workbench health')
        stop()
      }, 60000)
      let probing = false
      const output = createInterface({ input: child.stdout, crlfDelay: Infinity })
      output.on('line', async line => {
        if (!line.startsWith('dsh web: ')) {
          if (diagnostics) diagnostics.log('dsh', line)
          else console.error(line)
          return
        }
        if (probing) return
        probing = true
        try {
          const url = new URL(line.slice('dsh web: '.length))
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Invalid DSH listener URL')
          const healthUrl = new URL('/bohack/api/health', url.origin).href
          while (!abort.signal.aborted) {
            const response = await fetch(healthUrl, { headers: { 'x-jiangjie-ready-id': readyId },
              redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) }).catch(() => null)
            if (response?.status === 200 && response.headers.get('x-jiangjie-ready-id') === readyId) {
              await response.body?.cancel()
              clearTimeout(watchdog)
              console.log(JSON.stringify({ event: 'ready', port: Number(url.port), healthUrl }))
              return
            }
            await response?.body?.cancel()
            await delay(100, undefined, { signal: abort.signal })
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            if (diagnostics) diagnostics.log('supervisor', 'DSH health check failed')
            else console.error(error.message)
            stop()
          }
        }
      })
    }
    const code = await exit
    if (diagnostics && !stopping) await diagnostics.reportCrash('dsh', { code })
    process.exitCode = code
  } finally {
    abort.abort()
    clearTimeout(watchdog)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    detachStderr?.()
    if (nativeDesktop) process.stdin.pause()
  }
}

start().catch(error => {
  if (diagnostics) {
    const code = /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'START_FAILED'
    diagnostics.log('supervisor', 'Workbench startup failed: ' + code)
  }
  else console.error('[workbench] ' + error.message)
  if (nativeDesktop) process.stdin.pause()
  process.exitCode = 1
})
