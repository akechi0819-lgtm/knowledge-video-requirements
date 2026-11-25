// Run against an installed desktop bundle with fixture membership and model services.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createMembershipService } from './server.mjs'

const app = process.argv[2]
if (!app) throw new Error('Usage: node membership/test-desktop.mjs <installed app directory>')
const windows = process.platform === 'win32'
const root = await mkdtemp(path.join(os.tmpdir(), 'jiangjie-membership-e2e-'))
const bin = windows ? app : path.join(app, 'Contents', 'MacOS')
const ffmpeg = windows ? path.join(app, 'resources', 'runtime', 'ffmpeg', 'ffmpeg.exe') : path.join(bin, 'ffmpeg')
const mount = async (server, port = 0) => {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}
const stop = server => new Promise(resolve => server.close(resolve))
const sections = [
  { id: 'B01', title: '岩浆喷出', intent: '岩浆可沿裂缝到达地面。', visual: '剖面展示岩浆通道。', narration: '岩浆沿着火山裂缝喷出。' },
  { id: 'B02', title: '冷却成岩', intent: '熔岩冷却会形成火成岩。', visual: '展示熔岩冷却的变化。', narration: '流出的熔岩冷却成为岩石。' },
]
const html = id => `<!doctype html><meta charset="utf-8"><style>body{margin:0}#stage{position:relative;width:1280px;height:720px;background:#f5e4cd}div#lava{width:220px;height:200px;border-radius:70%;background:#c03b19;position:absolute;left:530px;top:240px}</style><div id="stage" data-shot-id="${id}"><div id="lava"></div></div><script>window.seek=t=>lava.style.transform='translateY('+(-40*t)+'px)'</script>`
const audio = execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-f', 'mp3', '-'])
const calls = []
const mock = createServer(async (req, res) => {
  const chunks = []
  for await (const bytes of req) chunks.push(bytes)
  const body = JSON.parse(Buffer.concat(chunks))
  const own = req.url.startsWith('/own/')
  const speech = req.url.endsWith('/audio/speech')
  const model = own ? 'own-text' : speech ? 'platform-voice' : 'platform-text'
  if (body.model !== model || req.headers.authorization !== (own ? 'Bearer own-fixture-key' : 'Bearer provider-fixture-key')) {
    return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'wrong upstream route, model or credential' } }))
  }
  if (speech) { calls.push('platform/tts'); return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(audio) }
  const last = body.messages?.findLast(message => message.role === 'tool')
  if (last && String(last.content).startsWith('Error:')) console.error('Fixture received tool error:', JSON.stringify(last.content).slice(0, 1800))
  const tools = body.tools?.map(tool => tool.function.name) || []
  const used = body.messages?.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []) || []
  let name, args
  let content = '我记下了。'
  if (tools.includes('write_blueprint') && !used.some(call => call.function.name === 'write_blueprint')) {
    name = 'write_blueprint'; args = { topic: '火山', core: '火山熔岩的变化', sections, assets: [] }
    calls.push('platform/blueprint')
  } else if (tools.includes('submit')) {
    const written = used.filter(call => call.function.name === 'write_scene').length
    const previewed = used.filter(call => call.function.name === 'preview').length
    if (written < sections.length) { name = 'write_scene'; args = { id: 'S0' + (written + 1), html: html(sections[written].id) } }
    else if (previewed < sections.length) { name = 'preview'; args = { id: 'S0' + (previewed + 1), seconds: 0 } }
    else if (!used.some(call => call.function.name === 'submit')) { name = 'submit'; args = {} }
    calls.push('platform/video:' + name)
  } else calls.push(own ? 'own/requirement' : 'platform/requirement')
  const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }], usage }))
  const id = 'chatcmpl-' + calls.length
  const send = (choices, extra = {}) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model, created: 1, choices, ...extra }) + '\n\n')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const tool_calls = [{ index: 0, id: 'call_' + calls.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  send([{ index: 0, delta: name ? { role: 'assistant', tool_calls } : { role: 'assistant', content }, finish_reason: null }])
  send([{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }])
  send([], { usage })
  res.end('data: [DONE]\n\n')
})

const mockUrl = await mount(mock)
const reserve = createServer()
const memberUrl = await mount(reserve)
const port = reserve.address().port
await stop(reserve)
const database = path.join(root, 'membership.sqlite')
const { server, db } = await createMembershipService({
  database, baseURL: memberUrl, secret: 'local-desktop-test-only-not-a-real-secret',
  chat: { baseURL: mockUrl + '/platform', key: 'provider-fixture-key', model: 'platform-text' },
  tts: { baseURL: mockUrl + '/platform', key: 'provider-fixture-key', model: 'platform-voice', voice: 'fixture' },
})
await mount(server, port)
const child = spawn(path.join(bin, windows ? 'Jiangjie.exe' : 'Jiangjie'), windows ? ['--integration-test'] : [], {
  env: { ...(windows ? process.env : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), USER: process.env.USER }),
    JIANGJIE_DESKTOP_DATA: path.join(root, 'AppData'), JIANGJIE_MEMBER_URL: memberUrl },
  stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
})
const ended = once(child, 'exit')
let workbenchPid
let startup = ''
if (windows) child.stdout.on('data', bytes => { startup += bytes })
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
let workbench
let savedByokKey = false
const fixtureCode = randomBytes(24).toString('base64url')
db.prepare('INSERT INTO invite_code(hash) VALUES (?)').run(createHash('sha256').update(fixtureCode).digest('hex'))
const fixtureCredentials = { email: 'desktop-fixture@example.test', password: 'test-password-only-123', inviteCode: fixtureCode }
const getMember = () => workbenchApi('membership')
const useAccount = (action, fields) => workbenchApi('membership', { action, ...fields })
function processList() { return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }) }
async function workbenchApi(route, body, thread, expectFailure = false) {
  const response = await fetch(workbench + '/bohack/api/' + route, {
    headers: { 'content-type': 'application/json', 'x-bohack-client': '1', ...(thread && { 'x-thread-id': thread }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!expectFailure) assert.ok(response.ok && data.ok !== false, `${route}: ${JSON.stringify(data)}`)
  else assert.equal(response.ok, false, route)
  return data
}
async function poll(get, check, seconds = 45) {
  const until = Date.now() + seconds * 1000
  let value
  do {
    value = await get()
    if (check(value)) return value
    await delay(250)
  } while (Date.now() < until)
  throw new Error('Timed out: ' + JSON.stringify(value))
}
const newThread = async () => (await workbenchApi('threads', {})).thread.id
const count = () => db.prepare('SELECT COUNT(*) AS count FROM usage').get().count
try {
  workbench = await poll(async () => {
    if (windows) {
      if (child.exitCode !== null) throw new Error('Windows launcher exited before the workbench was ready')
      return startup.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+)\r?$/m)?.[1]
    }
    const pid = processList().split('\n').map(line => line.trim().split(/\s+/, 3))
      .find(([, ppid, command]) => Number(ppid) === child.pid && (command === 'node' || command?.endsWith('/node')))?.[0]
    if (!pid) return null
    workbenchPid = Number(pid)
    try {
      const info = execFileSync('/usr/sbin/lsof', ['-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn', '-nP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const address = info.match(/^n(127\.0\.0\.1:\d+)$/m)?.[1]
      return address ? 'http://' + address : null
    } catch { return null }
  }, Boolean)
  assert.match(await (await fetch(workbench + '/bohack/')).text(), /id="accountBtn"/)
  assert.deepEqual(await getMember(), { enabled: true, mode: 'member', account: null })
  const first = await newThread()
  assert.match((await workbenchApi('chat', { text: '想讲火山' }, first, true)).error, /先登录/)
  assert.equal((await useAccount('register', fixtureCredentials)).account.gifts, 3)
  assert.equal((await getMember()).account.gifts, 3)
  assert.equal(count(), 0)
  console.log('Native App / workbench, default member mode and one-time signup gift OK')
  const usageBefore = count()
  await workbenchApi('chat', { text: '想讲火山' }, first)
  await workbenchApi('chat', { text: '从熔岩冷却讲起' }, first)
  assert.equal((await getMember()).account.gifts, 2)
  assert.equal(count(), usageBefore + 2)
  await useAccount('logout')
  assert.equal((await useAccount('login', fixtureCredentials)).account.gifts, 2)
  const second = await newThread()
  assert.match((await workbenchApi('chat', { text: '做第二条' }, second, true)).error, /原项目/)
  console.log('First real request, continuation, logout/login and active-project isolation OK')
  const requirement = '# 视频需求\n\n## 主题\n火山\n\n## 想讲的内容\n岩浆沿裂缝到达地面，熔岩随后冷却。'
  await workbenchApi('ingest', { kind: 'paste', text: requirement }, first)
  const blueprint = await workbenchApi('generate', {}, first)
  assert.ok(blueprint.realCall)
  await workbenchApi('confirm', { all: true }, first)
  await workbenchApi('finalize', {}, first)
  await workbenchApi('styles-select', { id: 'general', version: 1 }, first)
  const job = await workbenchApi('production', { mode: 'agent' }, first)
  assert.ok(job.membershipAuthorizationId)
  const settled = await poll(async () => (await workbenchApi('status', undefined, first)).production, state => ['completed', 'failed'].includes(state?.status), 60)
  assert.equal(settled.status, 'completed', settled.error)
  assert.ok(!settled.membershipError, settled.membershipError)
  await poll(() => db.prepare("SELECT COUNT(*) AS count FROM production WHERE status='active'").get().count, count => count === 0)
  const film = await fetch(workbench + '/bohack/api/production-file?kind=video&threadId=' + first)
  assert.ok(film.ok && (await film.arrayBuffer()).byteLength > 1000)
  const report = JSON.parse(await readFile(path.join(root, 'AppData', 'workspace', 'threads', first, 'production', job.id, 'film', 'verify-report.json'), 'utf8'))
  assert.deepEqual(report.hardErrors, [])
  for (const route of ['platform/requirement', 'platform/blueprint', 'platform/tts', 'platform/video:submit']) assert.ok(calls.includes(route), route)
  assert.equal(db.prepare('SELECT COUNT(DISTINCT production_id) AS count FROM usage').get().count, 1)
  console.log('Blueprint, TTS, DSH video Agent, native rendering, MP4 export and finished grant OK', JSON.stringify(calls))
  await useAccount('mode', { mode: 'byok' })
  await workbenchApi('settings', { model: { baseUrl: mockUrl + '/own', model: 'own-text', apiKey: 'own-fixture-key' } })
  savedByokKey = true
  const settingsFile = await readFile(path.join(root, 'AppData', 'workspace', 'settings.json'), 'utf8')
  assert.doesNotMatch(settingsFile, /own-fixture-key/)
  const beforeByok = count()
  await workbenchApi('chat', { text: '自配模式测试' }, second)
  assert.equal(calls.at(-1), 'own/requirement')
  assert.equal(count(), beforeByok)
  assert.equal((await getMember()).account.gifts, 2)
  console.log('Advanced BYOK routes directly to the configured endpoint with no member ledger change')
} finally {
  try {
    if (savedByokKey) await workbenchApi('settings', { model: { clearApiKey: true } })
  } finally {
    if (windows) child.stdin.end()
    else child.kill()
    const [exitCode] = await ended
    if (windows) assert.equal(exitCode, 0, 'Windows launcher did not shut down cleanly')
    if (workbenchPid) {
      try { process.kill(-workbenchPid, 'SIGTERM') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await stop(server)
    await stop(mock)
    db.close()
    if (process.env.JIANGJIE_TEST_KEEP) console.log('Fixture files:', root)
    else await rm(root, { recursive: true, force: true })
  }
}
