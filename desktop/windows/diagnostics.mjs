import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readSync, renameSync } from 'node:fs'
import { lstat, open, readdir, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { createZip } from './diagnostics-zip.mjs'

const defaultAppRoot = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const sources = new Set(['supervisor', 'dsh', 'video', 'ffmpeg'])
const forwardedSources = new Set(['video', 'ffmpeg'])
const forwardedPrefix = 'JIANGJIE_DIAGNOSTICS '
const maxLine = 16 * 1024
const maxLogTail = 256 * 1024
const logGenerations = 3
const omitted = '[oversized diagnostic line omitted]'
const redacted = '[REDACTED]'
const secretName = /authorization|cookie|password|passwd|credential|secret|(?:api|access|private)[_.-]?key|token|invite[_.-]?code|dsn/i
const secretAssignment = /(^|[^\w.-])(["']?[\w.-]*(?:password|passwd|credential|secret|(?:api|access|private)[_.-]?key|token|invite[_.-]?code|dsn)[\w.-]*["']?\s*(?:[:=]|\s+(?<=--[\w.-]+\s))\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'<>}\]]+)/gi

function roots({ env = process.env, appRoot, dataRoot, logRoot } = {}) {
  const home = env.USERPROFILE || os.homedir()
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return {
    app: path.resolve(appRoot || env.JIANGJIE_APP_ROOT || defaultAppRoot),
    data: path.resolve(dataRoot || env.JIANGJIE_DATA_DIR || path.join(roaming, 'Jiangjie')),
    logs: path.resolve(logRoot || env.JIANGJIE_DESKTOP_LOG_DIR || path.join(dataRoot || env.JIANGJIE_DATA_DIR || path.join(local, 'Jiangjie'), 'logs')),
  }
}

export function redactDiagnostic(value, env = process.env) {
  const text = stripVTControlCharacters(String(value))
  return redactText(text, sensitiveValues(env))
}

function sensitiveValues(env) {
  return [...new Set(Object.entries(env).filter(([key, value]) => secretName.test(key) && typeof value === 'string' && value.length >= 4)
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'),
      encodeURIComponent(value), new URLSearchParams([['', value]]).toString().slice(1)]))].sort((a, b) => b.length - a.length)
}

function redactText(text, secrets) {
  let result = text
    // Match the complete credential even when it is an HTTP header or quoted JSON field.
    .replace(/(["']?(?:(?:proxy[-_])?authorization|(?:set[-_])?cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi, `$1${redacted}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${redacted}`)
    .replace(secretAssignment, `$1$2${redacted}`)
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@<>"']+@/gi, `$1${redacted}@`)
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'?#]+)[?#][^\s<>"']*/gi, `$1?${redacted}`)
    .replace(/\b(?:sk-[\w-]{8,}|gh[oprsu]_[\w-]{12,}|github_pat_[\w-]{12,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/g, redacted)
  for (const secret of secrets) result = result.replaceAll(secret, redacted)
  return result
}

function structuredJson(text, secrets) {
  return JSON.stringify(JSON.parse(text), (key, value) => {
    if (key && secretName.test(key)) return undefined
    return typeof value === 'string' ? redactText(stripVTControlCharacters(value), secrets) : value
  })
}

// Tool output can include model responses, prompts, arguments and unknown
// credentials. Retain only operational signals derived from those lines.
function toolSignal(source, text) {
  if (text === omitted) return omitted
  if (source === 'ffmpeg') {
    if (/unknown encoder|encoder .* not found/i.test(text)) return 'encoder_unavailable'
    if (/no such filter|filter .* not found/i.test(text)) return 'filter_unavailable'
    if (/no such file|error opening input/i.test(text)) return 'input_unavailable'
    if (/permission denied|access is denied/i.test(text)) return 'access_denied'
    if (/invalid data|moov atom not found/i.test(text)) return 'invalid_media'
    if (/^frame=\s*\d+/.test(text)) return 'encoding_progress'
    if (/error|failed|fatal/i.test(text)) return 'codec_error'
    return 'codec_output'
  }
  if (source === 'video') {
    if (/^phase=(tts|render-compose|render|concat|verify|prepare|prepare-input|encode|quality|pipeline) (ok|failed)$/.test(text)) return text
    return /error|failed|fatal|\[FAIL\]/i.test(text) ? 'render_error' : 'render_output'
  }
  if (/MISSING_CREDENTIAL/i.test(text)) return 'missing_credential'
  if (/EADDRINUSE/i.test(text)) return 'port_in_use'
  if (/EACCES|EPERM|access is denied/i.test(text)) return 'access_denied'
  if (/MODULE_NOT_FOUND|ENOENT/i.test(text)) return 'component_unavailable'
  if (/error|failed|fatal|warn/i.test(text)) return 'dsh_error_or_warning'
  return 'dsh_output'
}

function logDay(file) {
  const fd = openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(17)
    return readSync(fd, prefix) === prefix.length && prefix.subarray(0, 7).toString() === '{"ts":"' ? prefix.toString('ascii', 7) : ''
  } finally { closeSync(fd) }
}

function collectLines(readable, onLine) {
  if (!readable) return () => {}
  const decoder = new StringDecoder('utf8')
  let pending = '', overflow = false, detached = false
  const flush = () => {
    if (overflow || pending) onLine(overflow ? omitted : pending)
    pending = ''
    overflow = false
  }
  const consume = text => {
    let start = 0
    for (const match of text.matchAll(/[\r\n]/g)) {
      add(text.slice(start, match.index))
      flush()
      start = match.index + 1
    }
    add(text.slice(start))
  }
  const add = text => {
    if (!overflow && pending.length + text.length <= maxLine) pending += text
    else { pending = ''; overflow = true }
  }
  const onData = chunk => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk))
  const detach = () => {
    if (detached) return
    detached = true
    readable.off('data', onData).off('end', detach).off('close', detach)
    consume(decoder.end())
    flush()
  }
  readable.on('data', onData).once('end', detach).once('close', detach)
  return detach
}

// Video descendants already have a stderr path back to the Windows supervisor.
export function createDesktopDiagnostics({ env = process.env, logRoot, maxLogBytes = 3_000_000, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const { logs } = roots({ env, logRoot })
  const secrets = sensitiveValues(env)
  function log(source, value) {
    if (!sources.has(source)) return
    try {
      let text = String(value)
      if (source === 'dsh' && text.startsWith(forwardedPrefix)) {
        const origin = text.slice(forwardedPrefix.length).split(' ', 1)[0]
        if (forwardedSources.has(origin)) {
          source = origin
          text = text.slice(forwardedPrefix.length + origin.length + 1)
        }
      }
      text = stripVTControlCharacters(text)
      const message = text.length > maxLine ? omitted : source === 'supervisor'
        ? redactText(text, secrets).replace(/[\x00-\x1f\x7f]/g, ' ') : toolSignal(source, text)
      const ts = now().toISOString()
      const line = JSON.stringify({ ts, source, message }) + '\n'
      const file = path.join(logs, `${source}.log`)
      mkdirSync(logs, { recursive: true, mode: 0o700 })
      const stat = lstatSync(file, { throwIfNoEntry: false })
      if (stat && !stat.isFile()) return
      if (Buffer.byteLength(line) > maxLogBytes) return
      if (stat?.size && (stat.size + Buffer.byteLength(line) > maxLogBytes || logDay(file) !== ts.slice(0, 10))) {
        for (let i = logGenerations; i > 0; i--) {
          try { renameSync(i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`) }
          catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      }
      appendFileSync(file, line, { mode: 0o600 })
    } catch {
      // Diagnostics must not interrupt process supervision.
    }
  }
  async function reportCrash(source, error) {
    if (!sources.has(source) && source !== 'main') return false
    const code = Number.isSafeInteger(error?.code) ? error.code : null
    log('supervisor', 'Unexpected ' + source + ' exit' + (code === null ? '' : ' (code ' + code + ')'))
    const dsn = env.JIANGJIE_DESKTOP_CRASH_DSN?.trim()
    if (!dsn) return false
    try {
      const url = new URL(dsn)
      const project = /^(.*)\/(\d+)\/?$/.exec(url.pathname)
      if (url.protocol !== 'https:' || url.password || url.search || url.hash || !/^[a-z0-9_-]+$/i.test(url.username) || !project) return false
      const endpoint = `${url.origin}${project[1]}/api/${project[2]}/envelope/`
      const eventId = randomUUID().replaceAll('-', '')
      const timestamp = new Date().toISOString()
      const event = JSON.stringify({ event_id: eventId, timestamp, platform: 'node', level: 'fatal',
        logger: 'jiangjie.desktop', message: `Unexpected ${source} exit`, tags: { source },
        extra: { exitCode: code } })
      const body = `${JSON.stringify({ event_id: eventId, sent_at: timestamp })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(event) })}\n${event}\n`
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${url.username}` }, body })
      await response.body?.cancel()
      return response.ok
    } catch { return false }
  }
  return { log, capture: (source, readable) => collectLines(readable, line => log(source, line)), reportCrash }
}

export async function reportPreviousNativeCrash(diagnostics, env = process.env) {
  const marker = path.join(roots({ env }).logs, 'main-crash.marker')
  try {
    if (!(await lstat(marker)).isFile()) return
    const file = await open(marker, 'r')
    const buffer = Buffer.alloc(4)
    let bytesRead = 0
    try { ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0)) } finally { await file.close() }
    await unlink(marker)
    await diagnostics.reportCrash('main', { code: bytesRead === 4 ? buffer.readUInt32LE() : null })
  } catch {}
}

const windowsInfoScript = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$candidates = @($env:JIANGJIE_DIAGNOSTICS_EDGE)
foreach ($hive in 'CurrentUser', 'LocalMachine') {
  foreach ($view in 'Registry64', 'Registry32') {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')
      if ($key) { try { $candidates += $key.GetValue('') } finally { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
}
foreach ($root in @([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:ProgramFiles, $env:LOCALAPPDATA)) {
  if ($root) { $candidates += Join-Path $root 'Microsoft\Edge\Application\msedge.exe' }
}
$edge = $null
foreach ($candidate in $candidates) {
  if ($candidate) {
    $candidate = $candidate.Trim('"')
    if ([IO.Path]::IsPathRooted($candidate) -and [IO.Path]::GetFileName($candidate) -ieq 'msedge.exe') {
      $edge = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
      if ($edge) { break }
    }
  }
}
[ordered]@{
  displayVersion = $version.DisplayVersion
  edition = $version.EditionID
  build = $version.CurrentBuildNumber
  revision = $version.UBR
  edgePath = $edge.FullName
  edgeVersion = $edge.VersionInfo.ProductVersion
} | ConvertTo-Json -Compress
`

async function windowsInfo(env) {
  if (!windows) return {}
  const system = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  const program = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsInfoScript, 'utf16le').toString('base64')]
  try {
    const { stdout } = await promisify(execFile)(program, args, { encoding: 'utf8', windowsHide: true, timeout: 5000,
      maxBuffer: 64 * 1024, env: { ...env, JIANGJIE_DIAGNOSTICS_EDGE: env.VIDEO_EDGE_PATH || env.VIDEO_BROWSER || '' } })
    return JSON.parse(stdout)
  } catch { return {} }
}

async function diskFree(file) {
  try {
    let probe = file
    for (;;) {
      try {
        const disk = await statfs(probe)
        return disk.bavail * disk.bsize
      } catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(probe) === probe) throw error
        probe = path.dirname(probe)
      }
    }
  } catch { return null }
}

async function boundedFile(file, limit, tail = false) {
  if (!(await lstat(file)).isFile()) return null
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (!tail && stat.size > limit)) return null
    const start = Math.max(0, stat.size - limit)
    const buffer = Buffer.alloc(stat.size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8', 0, bytesRead)
    // With a truncated file, drop the first partial line, which can lack its credential label.
    return start ? text.slice((text.indexOf('\n') + 1) || text.length) : text
  } finally { await handle.close() }
}

export async function exportDiagnostics(destination, { env = process.env, appRoot, dataRoot, logRoot } = {}) {
  const { app, data, logs } = roots({ env, appRoot, dataRoot, logRoot })
  const output = path.resolve(destination)
  if (path.extname(output).toLowerCase() !== '.zip') throw new Error('The diagnostics destination must end in .zip')
  const [info, dataDisk, appDisk, bom, names] = await Promise.all([
    windowsInfo(env), diskFree(data), diskFree(app), boundedFile(path.join(app, 'runtime-bom.json'), 1024 * 1024).catch(() => null),
    readdir(logs, { withFileTypes: true }).catch(() => []),
  ])
  const secrets = sensitiveValues(env)
  const clean = text => structuredJson(text, secrets)
  const metadata = {
    exportedAt: new Date().toISOString(),
    os: { platform: os.platform(), arch: os.arch(), release: os.release(), version: os.version(), edition: info.edition ?? null,
      displayVersion: info.displayVersion ?? null, build: info.build ?? null, revision: info.revision ?? null },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    disk: { dataFreeBytes: dataDisk, appFreeBytes: appDisk },
    edge: { path: info.edgePath ?? null, version: info.edgeVersion ?? null },
    runtimeBomIncluded: false,
  }
  const entries = []
  if (bom !== null) {
    try {
      entries.push(['runtime-bom.json', clean(bom) + '\n'])
      metadata.runtimeBomIncluded = true
    } catch {}
  }
  entries.unshift(['system.json', clean(JSON.stringify(metadata)) + '\n'])
  const logName = /^(?:main|native|supervisor|dsh|video|ffmpeg)\.log(?:\.[1-3])?$/
  for (const item of names.filter(item => item.isFile() && logName.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const log = await boundedFile(path.join(logs, item.name), maxLogTail, true).catch(() => null)
    if (log === null) continue
    const lines = log.split(/\r?\n/).filter(Boolean).map(line => {
      try { return clean(line) } catch { return JSON.stringify({ message: 'legacy_log_line_omitted' }) }
    })
    if (lines.length) entries.push(['logs/' + item.name, lines.join('\n') + '\n'])
  }
  const temp = path.join(path.dirname(output), `.jiangjie-diagnostics-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, createZip(entries), { flag: 'wx', mode: 0o600 })
    await rename(temp, output)
  }
  finally { await unlink(temp).catch(() => {}) }
  return output
}

async function cli(args) {
  const [command, destination, ...options] = args
  if (command === 'crash' && destination === 'main' && options.length <= 1) {
    const code = /^-?\d+$/.test(options[0]) ? Number(options[0]) : null
    await createDesktopDiagnostics().reportCrash('main', { code })
    return
  }
  if (command !== 'export' || !destination || options.length % 2) throw new Error('Usage: node diagnostics.mjs export <destination> [--app-root <dir>] [--data-root <dir>] [--log-root <dir>]')
  const flags = { '--app-root': 'appRoot', '--data-root': 'dataRoot', '--log-root': 'logRoot' }
  const config = {}
  for (let i = 0; i < options.length; i += 2) {
    const key = Object.hasOwn(flags, options[i]) && flags[options[i]]
    if (!key || !options[i + 1] || Object.hasOwn(config, key)) throw new Error('Invalid diagnostics root arguments')
    config[key] = options[i + 1]
  }
  await exportDiagnostics(destination, config)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(error => {
    console.error(`[diagnostics] ${redactDiagnostic(error.message)}`)
    process.exitCode = 1
  })
}
