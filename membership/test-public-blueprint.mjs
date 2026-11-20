import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [appPath, invitePath, evidencePath] = process.argv.slice(2)
if (!appPath || !invitePath || !evidencePath) {
  console.error('用法：node membership/test-public-blueprint.mjs /path/to/讲界.app /path/to/private-invite /path/to/new-evidence-dir')
  process.exit(2)
}

const app = path.resolve(appPath, 'Contents')
const origin = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :JiangjieMemberURL', path.join(app, 'Info.plist')], { encoding: 'utf8' }).trim()
if (origin !== 'https://jiangjie.gingers.cloud/desktop-membership') throw new Error('不是讲界公网内测包')
const invite = (await readFile(invitePath, 'utf8')).trim()
if (!/^[A-Za-z0-9_-]{32}$/.test(invite)) throw new Error('验收码格式无效')
await mkdir(evidencePath, { mode: 0o700 })
const data = await mkdtemp(path.join(tmpdir(), 'jiangjie-blueprint-'))
const report = { ok: false, stage: 'startup', http: {} }
let launcher, workbenchPid, browser, page
let registered = false

function requireCheck(condition, check) {
  if (!condition) {
    report.check = check
    throw new Error(check)
  }
}

function post(route) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/bohack/api/' + route
    && response.request().method() === 'POST', { timeout: 240000 })
}

async function resultFor(response, label) {
  report.http[label] = response.status()
  requireCheck(response.ok(), label + '_http')
  if (!response.headers()['content-type']?.includes('ndjson')) return response.json()
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  requireCheck(!events.some(event => event.type === 'error'), label + '_stream_error')
  const result = events.findLast(event => event.type === 'done')?.result
  requireCheck(result, label + '_missing_result')
  return result
}

try {
  const { chromium } = await import(pathToFileURL(path.join(app, 'Resources/video-kit/node_modules/playwright-core/index.mjs')))
  launcher = spawn(path.join(app, 'MacOS/Jiangjie'), [], {
    env: { HOME: process.env.HOME, USER: process.env.USER, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', JIANGJIE_DESKTOP_DATA: data },
    stdio: 'ignore',
  })
  const launched = once(launcher, 'spawn')
  await launched
  let address
  for (let attempt = 0; attempt < 150 && !address && launcher.exitCode === null; attempt++) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    workbenchPid = processes.split('\n').map(line => line.trim().split(/\s+/, 3))
      .find(([, parent, name]) => Number(parent) === launcher.pid && (name === 'node' || name?.endsWith('/node')))?.[0]
    if (workbenchPid) {
      try {
        address = execFileSync('/usr/sbin/lsof', ['-a', '-p', workbenchPid, '-iTCP', '-sTCP:LISTEN', '-Fn', '-nP'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/^n(127\.0\.0\.1:\d+)$/m)?.[1]
      } catch (error) {
        if (error.status !== 1) throw error
      }
    }
    if (!address) await delay(250)
  }
  requireCheck(address, 'local_workbench_not_listening')
  browser = await chromium.launch({ executablePath: path.join(app, 'Helpers/Chromium.app/Contents/MacOS/Chromium'), headless: true })
  page = await browser.newPage()
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/bohack/api/preview') report.http.preview = response.status()
  })
  await page.goto('http://' + address + '/bohack/')
  const account = page.getByRole('button', { name: '账号 · 会员模式' })
  report.stage = 'register'
  await account.click()
  await page.getByText('尚未登录。注册或登录后可使用会员额度。').waitFor()
  await page.locator('.account-form input[name=email]').fill('desktop-qa-' + randomUUID() + '@example.test')
  await page.locator('.account-form input[name=password]').fill(randomBytes(20).toString('hex'))
  await page.locator('.account-form input[name=inviteCode]').fill(invite)
  const registration = post('membership')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  const registrationResponse = await registration
  registered = registrationResponse.ok()
  const member = await resultFor(registrationResponse, 'register')
  requireCheck(member.account?.gifts === 3, 'initial_gift_balance')
  await page.getByRole('button', { name: '关闭账号' }).click()

  report.stage = 'requirement'
  await page.locator('#entryText').fill('我想做一条横屏有旁白的中文科普短片，给初中生讲清楚影子为什么总在光源另一侧。就两段，用同一根直立小杆演示：第一段光从左边照，第二段换到右边。每段旁白一句，画面保持简单，不用联网。')
  const first = post('chat')
  await page.locator('#entrySend').click()
  const reply = await resultFor(await first, 'requirement')
  requireCheck(reply.reply?.includes('影子') && !reply.generation, 'requirement_dialogue')
  await page.locator('#chatLog .note:not(.note-user) p').filter({ hasText: '影子' }).first().waitFor()

  report.stage = 'blueprint'
  await page.locator('#chatInput').fill('我确认以上需求，讲完了。请按这些整理需求并开始生成正式蓝图。')
  const confirmation = post('chat')
  await page.locator('#btnChat').click()
  const result = await resultFor(await confirmation, 'blueprint')
  if (result.generationError) {
    const { code, message } = result.generationError
    report.generationError = /^[A-Z_]{1,48}$/.test(code) ? code : 'UNKNOWN'
    const modelCode = /蓝图模型请求失败（([A-Z_]{1,48})）/.exec(message || '')?.[1]
    if (modelCode) report.modelCode = modelCode
    if (/未产出可解析的蓝图/.test(message || '')) report.check = 'unparseable_blueprint'
    throw new Error('generation_error')
  }
  const generation = result.generation
  requireCheck(generation?.realCall === true && generation.engine === 'agent', 'missing_real_blueprint')
  requireCheck(generation.validation?.ok === true, 'invalid_blueprint')
  const ids = generation.sections?.map(section => section.id)
  requireCheck(JSON.stringify(ids) === '["B01","B02"]', 'missing_blueprint_sections')
  report.sections = ids
  await page.locator('#bpStart').waitFor({ state: 'visible' })

  report.stage = 'preview'
  await page.locator('[data-tab=bp]').click()
  await page.waitForFunction(() => {
    const frames = document.querySelector('#frames')
    return frames.querySelector('.preview-error') || (frames.querySelector('.bpv') && !frames.querySelector('.bpv-wait'))
  }, null, { timeout: 150000 })
  requireCheck(!(await page.locator('#frames .preview-error, #frames .bpv-wait').count()), 'missing_real_preview')
  for (const id of ids) {
    const paths = page.locator(`#frames [data-preview-target="${id}"] .bpv-art svg[role="img"] path[d]`)
    requireCheck(await paths.evaluateAll(shapes => shapes.some(shape => shape.getAttribute('d').trim())), 'missing_preview_geometry')
  }
  await page.screenshot({ path: path.join(evidencePath, 'blueprint.png') })
  report.ok = true
} catch (error) {
  report.check ||= error.name === 'TimeoutError' ? 'timeout' : 'unexpected_error'
  process.exitCode = 1
} finally {
  if (registered && page) {
    try {
      if (!(await page.locator('.account-logout').isVisible())) {
        await page.getByRole('button', { name: '账号 · 会员模式' }).click({ timeout: 5000 })
      }
      await page.getByRole('button', { name: '退出登录' }).click({ timeout: 5000 })
      await page.getByText('尚未登录。注册或登录后可使用会员额度。').waitFor({ timeout: 20000 })
      report.loggedOut = true
    } catch {
      report.loggedOut = false
      process.exitCode = 1
    }
  }
  await browser?.close()
  if (launcher?.pid && launcher.exitCode === null && launcher.signalCode === null) {
    const exited = once(launcher, 'exit')
    if (workbenchPid) {
      const child = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
        .split('\n').some(line => line.trim().replace(/\s+/g, ' ') === workbenchPid + ' ' + launcher.pid)
      if (child) {
        try { process.kill(Number(workbenchPid), 'SIGTERM') }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    launcher.kill('SIGTERM')
    await exited
  }
  await rm(data, { recursive: true, force: true })
  const summary = JSON.stringify(report, null, 2) + '\n'
  await writeFile(path.join(evidencePath, 'result.json'), summary, { mode: 0o600 })
  console.log(summary.trim())
}
