
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { crc32, inflateRawSync } from 'node:zlib'
import { createDesktopDiagnostics, exportDiagnostics, redactDiagnostic, reportPreviousNativeCrash } from './diagnostics.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "讲界 ' diagnostics-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appRoot = path.join(root, 'app')
  const logRoot = path.join(root, 'logs')
  await Promise.all([mkdir(appRoot), mkdir(logRoot)])
  return { root, appRoot, logRoot, dataRoot: path.join(root, 'data') }
}

function readZip(zip) {
  const entries = new Map()
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    const flags = zip.readUInt16LE(offset + 6)
    const method = zip.readUInt16LE(offset + 8)
    assert.equal(flags, 0x800)
    assert.equal(method, 8)
    const length = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength
    const content = inflateRawSync(zip.subarray(contentStart, contentStart + length))
    assert.equal(crc32(content), zip.readUInt32LE(offset + 14))
    entries.set(zip.toString('utf8', nameStart, contentStart), content.toString())
    offset = contentStart + length
  }
  return entries
}

test('redacts credentials in headers, flags, URLs and encoded environment values', () => {
  const key = 'provided value:/中'
  const values = [
    'Authorization: Bearer alpha-value',
    'X-DSH-Internal-Token: bravo-value',
    'X-Api-Key: charlie-value',
    'Cookie: session=delta-value',
    'password="echo value"',
    '--invite-code foxtrot-value',
    'https://login:golf-value@example.test/v1?session=hotel-value',
    'sk-longopaquevalue',
    'plain ' + key,
    'encoded ' + encodeURIComponent(key),
    'base64 ' + Buffer.from(key).toString('base64'),
  ]
  const cleaned = redactDiagnostic(values.join('\n'), { PROVIDER_API_KEY: key })
  for (const secret of ['alpha-value', 'bravo-value', 'charlie-value', 'delta-value', 'echo value',
    'foxtrot-value', 'golf-value', 'hotel-value', 'sk-longopaquevalue', key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) {
    assert.ok(!cleaned.includes(secret), secret)
  }
  assert.match(cleaned, /example\.test\/v1/)
})

test('writes bounded JSON lines, rotates by UTC day and size, and omits raw tool output', async t => {
  const { logRoot } = await fixture(t)
  let day = '2026-11-25'
  const logger = createDesktopDiagnostics({
    logRoot, env: {}, maxLogBytes: 200, now: () => new Date(day + 'T18:20:00.000Z'),
  })
  logger.log('supervisor', 'initial startup')
  day = '2026-11-26'
  logger.log('supervisor', 'new day')
  assert.match(await readFile(path.join(logRoot, 'supervisor.log.1'), 'utf8'), /initial startup/)
  for (let i = 0; i < 30; i++) logger.log('supervisor', 'size rotation ' + i)
  const logs = (await readdir(logRoot)).filter(name => name.startsWith('supervisor.'))
  assert.equal(logs.length, 4)
  for (const name of logs) {
    const content = await readFile(path.join(logRoot, name), 'utf8')
    assert.ok(Buffer.byteLength(content) <= 200)
    for (const line of content.trim().split('\n')) assert.equal(JSON.parse(line).source, 'supervisor')
  }
  const out = new PassThrough()
  logger.capture('dsh', out)
  const input = Buffer.from('JIANGJIE_DIAGNOSTICS ffmpeg Unknown encoder 绝密name\n')
  out.write(input.subarray(0, input.length - 6))
  out.end(input.subarray(input.length - 6))
  await new Promise(resolve => out.once('end', resolve))
  const record = JSON.parse(await readFile(path.join(logRoot, 'ffmpeg.log'), 'utf8'))
  assert.equal(record.message, 'encoder_unavailable')
  assert.equal(record.source, 'ffmpeg')
  assert.equal(await readFile(path.join(logRoot, 'ffmpeg.log'), 'utf8').then(x => x.includes('绝密name')), false)
})

test('exports parseable redacted system and BOM JSON, rotated logs and no other user files', async t => {
  const config = await fixture(t)
  const { root, appRoot, logRoot } = config
  await writeFile(path.join(appRoot, 'runtime-bom.json'), JSON.stringify({
    component: 'python', path: 'https://example.test/v1?credential=should-not-ship',
    nested: { apiKey: 'unlabeled-private-value', authorization: ['hidden-auth'] },
  }))
  await writeFile(path.join(logRoot, 'dsh.log.1'), JSON.stringify({
    source: 'dsh', message: 'authorization: Bearer private-log-access', accessToken: 'secret-token-field',
  }) + '\nlegacy without label example-private-string\n')
  await writeFile(path.join(logRoot, 'settings.json'), '{"apiKey":"private-settings"}')
  const destination = path.join(root, '讲界诊断.zip')
  await exportDiagnostics(destination, { ...config, env: process.env })
  const entries = readZip(await readFile(destination))
  assert.deepEqual([...entries.keys()], ['system.json', 'runtime-bom.json', 'logs/dsh.log.1'])
  const bom = JSON.parse(entries.get('runtime-bom.json'))
  assert.equal(bom.component, 'python')
  assert.deepEqual(bom.nested, {})
  const metadata = JSON.parse(entries.get('system.json'))
  assert.equal(metadata.runtimeBomIncluded, true)
  assert.ok(metadata.memory.totalBytes > 0)
  assert.ok(metadata.disk.appFreeBytes > 0)
  const content = [...entries.values()].join('\n')
  for (const secret of ['should-not-ship', 'unlabeled-private-value', 'hidden-auth', 'private-log-access',
    'secret-token-field', 'example-private-string', 'private-settings']) assert.ok(!content.includes(secret))
})

test('crash reporting skips absent DSN and forwards only a whitelisted envelope with a DSN', async t => {
  const { logRoot } = await fixture(t)
  const sent = []
  const fetchImpl = async (...args) => {
    sent.push(args)
    return new Response(null, { status: 200 })
  }
  const marker = path.join(logRoot, 'main-crash.marker')
  const code = Buffer.alloc(4)
  code.writeUInt32LE(0xc0000005)
  await writeFile(marker, code)
  const env = { JIANGJIE_DESKTOP_LOG_DIR: logRoot }
  await reportPreviousNativeCrash(createDesktopDiagnostics({ env, fetchImpl }), env)
  assert.equal(sent.length, 0)
  assert.match(await readFile(path.join(logRoot, 'supervisor.log'), 'utf8'), /3221225477/)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })

  const enabled = { ...env, JIANGJIE_DESKTOP_CRASH_DSN: 'https://publickey@errors.example.test/prefix/4' }
  assert.equal(await createDesktopDiagnostics({ env: enabled, fetchImpl }).reportCrash('dsh', { code: 7, message: 'private provider log' }), true)
  assert.equal(sent[0][0], 'https://errors.example.test/prefix/api/4/envelope/')
  const event = JSON.parse(sent[0][1].body.split('\n')[2])
  assert.deepEqual(event.extra, { exitCode: 7 })
  assert.ok(!sent[0][1].body.includes('private provider log'))
})

test('the native DSH preload prevents the upstream plaintext startup dump', async t => {
  const { root, logRoot } = await fixture(t)
  const file = path.join(logRoot, 'startup-2026-11-26T00-00-00.000Z-' + randomUUID() + '.log')
  const setup = new URL('./dsh-shutdown.mjs', import.meta.url).href
  const program = [
    "import { writeFile } from 'node:fs/promises'",
    "import assert from 'node:assert/strict'",
    "await assert.rejects(writeFile(process.argv[1], 'arbitrary provider response'), /redacted supervisor log/)",
  ].join('\n')
  await promisify(execFile)(process.execPath, ['--import', setup, '--input-type=module', '--eval', program, file], {
    windowsHide: true, env: { ...process.env, DSH_HOME: root },
  })
  assert.deepEqual(await readdir(logRoot), [])
})
