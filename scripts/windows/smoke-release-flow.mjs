#!/usr/bin/env node
/**
 * 端到端本地冒烟验证：
 *  1. 启动本地 HTTP 测试源，预置 100 KiB 断点缓存 + ETag，实测原生 Jiangjie-Setup-Online-x64.exe
 *     发起 HTTP 206 Range 断点续传并完成 SHA-256 校验；
 *  2. 实测 JiangjieUpdater.exe 针对本地组件增量清单完成 A -> B 组件复用（零下载未变更组件）、
 *     只下载变更组件并生成 pending-update.json，再执行 --apply 原子切换 current.json；
 *  3. 实测工作台 /bohack/api/desktop/busy 端点在渲染进行中返回 busy: true、空闲返回 busy: false。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebHandler } from '../../dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/web.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const NATIVE_DIR = process.env.JIANGJIE_NATIVE_BUILD_DIR || path.join(REPO, '.runtime', 'windows-desktop', 'native-phase5')
const BOOTSTRAPPER = path.join(NATIVE_DIR, 'Jiangjie-Setup-Online-x64.exe')
const UPDATER = path.join(NATIVE_DIR, 'JiangjieUpdater.exe')

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function testBootstrapperRangeResumeAndUpdater() {
  assert.ok(existsSync(BOOTSTRAPPER), `Missing compiled bootstrapper: ${BOOTSTRAPPER}`)
  assert.ok(existsSync(UPDATER), `Missing compiled updater: ${UPDATER}`)

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jj-release-e2e-'))
  // Copy test binaries to the temp directory so Windows MIC inherits normal user IL
  const binDir = path.join(tmp, 'bin')
  mkdirSync(binDir, { recursive: true })
  const runBootstrapper = path.join(binDir, 'Jiangjie-Setup-Online-x64.exe')
  const runUpdater = path.join(binDir, 'JiangjieUpdater.exe')
  copyFileSync(BOOTSTRAPPER, runBootstrapper)
  copyFileSync(UPDATER, runUpdater)
  const offlinePayload = Buffer.alloc(256 * 1024, 0x5a)
  for (let i = 0; i < offlinePayload.length; i += 4096) offlinePayload[i] = i & 0xff
  const offlineSha = sha256(offlinePayload)

  // Prepare one changed component archive (app) using Windows tar.exe
  const compSrc = path.join(tmp, 'comp-app-src')
  mkdirSync(compSrc, { recursive: true })
  writeFileSync(path.join(compSrc, 'app-v2.txt'), 'v2-app-binary-payload\n')
  const compArchive = path.join(tmp, 'component-app.tar.gz')
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tarExe, ['-czf', compArchive, '-C', compSrc, '.'], { stdio: 'pipe' })
  const compBuf = readFileSync(compArchive)
  const compSha = sha256(compBuf)
  const unchangedNodeSha = 'a'.repeat(64)

  let rangeHeaderSeen = false
  let nodeCompRequested = false
  let appCompRequested = false

  const server = http.createServer((req, res) => {
    const addr = server.address()
    const base = `http://127.0.0.1:${addr.port}`

    if (req.url === '/feed.json') {
      const feed = {
        schemaVersion: 1,
        version: '0.2.9',
        releaseSequence: 9,
        channel: 'stable',
        platform: 'windows',
        arch: 'x64',
        minWindowsBuild: 19045,
        rolloutPercentage: 100,
        publishedAt: '2026-11-26T00:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        artifacts: {
          offline: {
            url: `${base}/Jiangjie-Setup-Offline-x64.exe`,
            fileName: 'Jiangjie-Setup-Offline-x64.exe',
            sizeBytes: offlinePayload.length,
            sha256: offlineSha,
          },
        },
        components: [
          {
            id: 'node',
            url: `${base}/components/node.tar.gz`,
            sizeBytes: 90000000,
            unpackedSizeBytes: 90000000,
            sha256: unchangedNodeSha,
            fileManifestSha256: unchangedNodeSha,
            unpackDir: 'runtime/node',
          },
          {
            id: 'app',
            url: `${base}/components/app.tar.gz`,
            sizeBytes: compBuf.length,
            unpackedSizeBytes: 32,
            sha256: compSha,
            fileManifestSha256: compSha,
            unpackDir: '',
          },
        ],
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(feed))
      return
    }

    if (req.url === '/Jiangjie-Setup-Offline-x64.exe') {
      const range = req.headers.range
      if (range) {
        rangeHeaderSeen = true
        const m = /^bytes=(\d+)-(\d*)$/.exec(range)
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : offlinePayload.length - 1
        const slice = offlinePayload.subarray(start, end + 1)
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': slice.length,
          'content-range': `bytes ${start}-${end}/${offlinePayload.length}`,
          'accept-ranges': 'bytes',
          etag: '"v9-etag"',
        })
        res.end(slice)
        return
      }
      res.writeHead(200, { 'content-length': offlinePayload.length, 'accept-ranges': 'bytes', etag: '"v9-etag"' })
      res.end(offlinePayload)
      return
    }

    if (req.url === '/components/node.tar.gz') {
      nodeCompRequested = true
      res.writeHead(500)
      res.end('should have been reused locally!')
      return
    }
    if (req.url === '/components/app.tar.gz') {
      appCompRequested = true
      res.writeHead(200, { 'content-length': compBuf.length, 'accept-ranges': 'bytes' })
      res.end(compBuf)
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const localDir = path.join(tmp, 'local')
    const installDir = path.join(tmp, 'install')
    const dlDir = path.join(localDir, 'cache', 'downloads')
    mkdirSync(dlDir, { recursive: true })

    // 1. Pre-seed 100 KiB partial file + ETag -> verify online bootstrapper resumes via HTTP 206 & verifies SHA-256
    const partPath = path.join(dlDir, 'Jiangjie-Setup-Offline-x64.exe.part')
    writeFileSync(partPath, offlinePayload.subarray(0, 100 * 1024))
    writeFileSync(`${partPath}.etag`, '"v9-etag"\n')

    try {
      await execFileAsync(
        runBootstrapper,
        [
          '--silent',
          '--dry-run-download',
          '--allow-local-http',
          '--feed-url',
          `http://127.0.0.1:${port}/feed.json`,
          '--install-dir',
          installDir,
        ],
        { env: { ...process.env, JIANGJIE_LOCAL_DIR: localDir } },
      )
    } catch (err) {
      const logPath = path.join(localDir, 'logs', 'installer.log')
      if (existsSync(logPath)) console.error('installer.log:\n' + readFileSync(logPath, 'utf8'))
      throw err
    }

    const committed = path.join(dlDir, 'Jiangjie-Setup-Offline-x64.exe')
    assert.ok(existsSync(committed), 'Downloaded installer must be committed atomically')
    assert.equal(sha256(readFileSync(committed)), offlineSha, 'Downloaded installer SHA-256 must match')
    assert.equal(rangeHeaderSeen, true, 'Online bootstrapper must send HTTP Range header to resume')

    // 2. Seed installed version seq=2 with matching `node` component -> verify JiangjieUpdater reuses `node` (0 bytes downloaded) and only fetches `app`!
    const v2Dir = path.join(installDir, 'versions', '2')
    mkdirSync(path.join(v2Dir, 'runtime', 'node'), { recursive: true })
    writeFileSync(path.join(v2Dir, 'runtime', 'node', 'node.exe'), 'existing-node-binary')
    writeFileSync(path.join(v2Dir, 'component-hashes.json'), JSON.stringify({ node: unchangedNodeSha, app: '0'.repeat(64) }))
    writeFileSync(
      path.join(installDir, 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: '0.2.1',
        releaseSequence: 2,
        previousSequence: 0,
        previousVersion: '',
        healthySequence: 2,
        unverifiedAttempts: 0,
      }),
    )

    await execFileAsync(
      runUpdater,
      [
        '--check',
        '--stage',
        '--quiet',
        '--allow-local-http',
        '--feed-url',
        `http://127.0.0.1:${port}/feed.json`,
        '--install-dir',
        installDir,
      ],
      { env: { ...process.env, JIANGJIE_LOCAL_DIR: localDir } },
    )

    assert.equal(nodeCompRequested, false, 'Unchanged `node` component MUST be reused locally with 0 network fetch')
    assert.equal(appCompRequested, true, 'Changed `app` component MUST be downloaded')
    const pending = JSON.parse(readFileSync(path.join(installDir, 'pending-update.json'), 'utf8'))
    assert.equal(pending.releaseSequence, 9)
    assert.equal(pending.reusedBytes, 90000000)
    assert.equal(pending.downloadedBytes, compBuf.length)

    // 3. Apply pending update atomically and verify current.json switched 2 -> 9 while preserving previousSequence=2
    await execFileAsync(runUpdater, ['--apply', '--install-dir', installDir], {
      env: { ...process.env, JIANGJIE_LOCAL_DIR: localDir },
    })
    const currentAfter = JSON.parse(readFileSync(path.join(installDir, 'current.json'), 'utf8'))
    assert.equal(currentAfter.releaseSequence, 9)
    assert.equal(currentAfter.previousSequence, 2)
    assert.ok(existsSync(path.join(installDir, 'versions', '9', 'runtime', 'node', 'node.exe')))
    assert.ok(existsSync(path.join(installDir, 'versions', '9', 'app-v2.txt')))
    console.log('PASS: Live bootstrapper HTTP 206 Range resume + SHA-256 + incremental component reuse (90MB reused, 0B fetched) + atomic activation')
  } finally {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function testWorkbenchBusyEndpoint() {
  let rendering = false
  const fakeService = { production: { isActive: () => rendering } }
  const fakeThreads = { hasActiveProduction: async () => rendering }
  const handler = createWebHandler(fakeService, {}, {}, fakeThreads)

  const invoke = () =>
    new Promise((resolve, reject) => {
      let status = 0
      let raw = ''
      const res = {
        setHeader() {},
        writeHead(code) { status = code },
        end(body) {
          raw += body || ''
          resolve({ status, json: JSON.parse(raw) })
        },
      }
      handler({ method: 'GET', url: '/bohack/api/desktop/busy', headers: {} }, res).catch(reject)
    })

  const idle = await invoke()
  assert.equal(idle.status, 200)
  assert.equal(idle.json.busy, false)

  rendering = true
  const busy = await invoke()
  assert.equal(busy.status, 200)
  assert.equal(busy.json.busy, true)
  assert.equal(busy.json.reason, 'video_production_running')
  console.log('PASS: /bohack/api/desktop/busy accurately guards against restart during active video rendering')
}

await testBootstrapperRangeResumeAndUpdater()
await testWorkbenchBusyEndpoint()
