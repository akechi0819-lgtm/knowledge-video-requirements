#!/usr/bin/env node
/**
 * 讲界视频工坊 Windows 增量更新包、.blockmap 与多通道发布清单生成器。
 *
 * 产出文件：
 *   - releases.win.json        Windows 详细发布清单（含 components、deltaMetrics、rolloutPercentage）
 *   - feed.json                ADR-04 ECDSA P-256/SHA-256 签名信封（未提供私钥时输出明文 payload）
 *   - latest.yml / beta.yml    通用 YAML 自动更新清单（含 sha512、sha256、blockmap、channel、rolloutPercentage）
 *   - *.blockmap               64 KiB 固定分块 SHA-256 差分块映射（gzip JSON）
 *   - release-manifest.json    官网下载页聚合清单（Windows x64 在线/离线 + macOS Apple Silicon）
 *   - SHA256SUMS.txt           标准校验汇总文件
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK_SIZE = 64 * 1024 // 64 KiB deterministic chunking for .blockmap

/** Component map aligned with docs/win-release-spec.md ADR-03 */
export const COMPONENT_LAYOUT = [
  { id: 'node', unpackDir: 'runtime/node', sources: ['runtime/node'] },
  { id: 'python', unpackDir: 'runtime/python', sources: ['runtime/python'] },
  { id: 'webview2', unpackDir: 'runtime/webview2', sources: ['runtime/webview2'] },
  { id: 'chromium', unpackDir: 'runtime/chromium', sources: ['runtime/chromium'] },
  { id: 'codecs', unpackDir: 'runtime/codecs', sources: ['runtime/codecs'] },
  { id: 'skills', unpackDir: '.project-skills', sources: ['.project-skills'], optional: true },
  { id: 'notices', unpackDir: 'notices', sources: ['notices'], optional: true },
  {
    id: 'app',
    unpackDir: '',
    sources: [
      'Jiangjie.exe',
      'JiangjieApp.exe',
      'JiangjieUpdater.exe',
      'BohackCredentialStore.exe',
      'desktop-agent.patch.yml',
      'runtime-bom.json',
      'desktop',
      'dsh-workbench-fix',
      'video-kit',
    ],
  },
]

export function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

export async function hashFile(filePath, algorithm = 'sha256', encoding = 'hex') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest(encoding)))
  })
}

export async function generateBlockmap(filePath, blockSize = BLOCK_SIZE) {
  const size = statSync(filePath).size
  const blocks = []
  const fileHash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: blockSize })
    let buffer = Buffer.alloc(0)
    let offset = 0
    const flushChunk = chunk => {
      fileHash.update(chunk)
      const h = createHash('sha256').update(chunk).digest('base64url')
      blocks.push({ o: offset, s: chunk.length, h })
      offset += chunk.length
    }
    stream.on('data', chunk => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      while (buffer.length >= blockSize) {
        flushChunk(buffer.subarray(0, blockSize))
        buffer = buffer.subarray(blockSize)
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (buffer.length > 0) flushChunk(buffer)
      resolve()
    })
  })
  const payload = {
    version: 2,
    algorithm: 'sha256',
    blockSize,
    fileSize: size,
    fileSha256: fileHash.digest('hex'),
    blockCount: blocks.length,
    blocks,
  }
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
  const blockmapSha256 = createHash('sha256').update(compressed).digest('hex')
  return { payload, compressed, blockmapSha256 }
}

export function diffBlockmaps(prevCompressed, nextCompressed) {
  const prev = JSON.parse(gunzipSync(prevCompressed).toString('utf8'))
  const next = JSON.parse(gunzipSync(nextCompressed).toString('utf8'))
  const prevSet = new Set(prev.blocks.map(b => `${b.s}:${b.h}`))
  let reusedBytes = 0
  let changedBytes = 0
  for (const b of next.blocks) {
    if (prevSet.has(`${b.s}:${b.h}`)) reusedBytes += b.s
    else changedBytes += b.s
  }
  const fullBytes = next.fileSize || reusedBytes + changedBytes
  const savingsPercent = fullBytes > 0 ? Number(((reusedBytes / fullBytes) * 100).toFixed(2)) : 0
  return { fullBytes, changedBytes, reusedBytes, savingsPercent }
}

function collectFilesSorted(rootDir, relPaths) {
  const files = []
  const walk = (absPath, relPath) => {
    const st = statSync(absPath)
    if (st.isDirectory()) {
      for (const name of readdirSync(absPath).sort()) {
        walk(path.join(absPath, name), relPath ? `${relPath}/${name}` : name)
      }
    } else if (st.isFile()) {
      files.push({ absPath, relPath, size: st.size })
    }
  }
  for (const rel of relPaths) {
    const abs = path.join(rootDir, rel)
    if (existsSync(abs)) walk(abs, rel.replace(/\\/g, '/'))
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

export async function buildComponents({ stageDir, outDir, hashesOut }) {
  mkdirSync(outDir, { recursive: true })
  const index = []
  const hashes = {}
  const tarCmd = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

  for (const spec of COMPONENT_LAYOUT) {
    const existingSources = spec.sources.filter(s => existsSync(path.join(stageDir, s)))
    if (existingSources.length === 0) {
      if (spec.optional) continue
      throw new Error(`Missing required staging sources for component "${spec.id}": ${spec.sources.join(', ')}`)
    }

    const baseDir = spec.unpackDir && existingSources.length === 1 && existingSources[0] === spec.unpackDir
      ? path.join(stageDir, spec.unpackDir)
      : stageDir
    const relInputs = baseDir === stageDir ? existingSources : ['.']
    const files = collectFilesSorted(baseDir, baseDir === stageDir ? existingSources : readdirSync(baseDir))
    let unpackedSizeBytes = 0
    const manifestHash = createHash('sha256')
    for (const f of files) {
      unpackedSizeBytes += f.size
      const fh = await hashFile(f.absPath, 'sha256', 'hex')
      manifestHash.update(`${f.relPath}\0${f.size}\0${fh}\n`)
    }
    const fileManifestSha256 = manifestHash.digest('hex')
    const archiveName = `component-${spec.id}-${fileManifestSha256.slice(0, 12)}.tar.gz`
    const archivePath = path.join(outDir, archiveName)

    execFileSync(tarCmd, ['-czf', archivePath, '-C', baseDir, ...relInputs], { stdio: 'pipe' })
    const sizeBytes = statSync(archivePath).size
    const sha256 = await hashFile(archivePath, 'sha256', 'hex')

    hashes[spec.id] = sha256
    index.push({
      id: spec.id,
      fileName: archiveName,
      sizeBytes,
      unpackedSizeBytes,
      sha256,
      fileManifestSha256,
      unpackDir: spec.unpackDir,
      fileCount: files.length,
    })
  }

  writeFileSync(path.join(outDir, 'components-index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  if (hashesOut) {
    mkdirSync(path.dirname(hashesOut), { recursive: true })
    writeFileSync(hashesOut, JSON.stringify(hashes, null, 2) + '\n', 'utf8')
  }
  return { index, hashes }
}

export function generateEcdsaP256KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const jwk = publicKey.export({ format: 'jwk' })
  const rawXY = Buffer.concat([fromBase64Url(jwk.x), fromBase64Url(jwk.y)])
  if (rawXY.length !== 64) throw new Error('Expected 64-byte raw P-256 public key')
  return {
    privatePem,
    publicKeyBase64Url: toBase64Url(rawXY),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  }
}

export function signFeedPayload(payloadJson, privateKeyPem, keyId = 'jiangjie-release-2026') {
  const payloadBytes = Buffer.from(payloadJson, 'utf8')
  const sig = cryptoSign('sha256', payloadBytes, { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
  if (sig.length !== 64) throw new Error(`Expected 64-byte P-256 IEEE P1363 signature, got ${sig.length}`)
  return {
    schemaVersion: 1,
    keyId,
    payload: toBase64Url(payloadBytes),
    signature: toBase64Url(sig),
  }
}

export function verifySignedEnvelope(envelope, publicKeyBase64Url) {
  if (!envelope || envelope.schemaVersion !== 1 || !envelope.payload || !envelope.signature) {
    return { valid: false, reason: 'Invalid envelope schema' }
  }
  const rawXY = fromBase64Url(publicKeyBase64Url)
  if (rawXY.length !== 64) return { valid: false, reason: 'Invalid raw P-256 public key length' }
  const pubKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(rawXY.subarray(0, 32)),
      y: toBase64Url(rawXY.subarray(32, 64)),
    },
    format: 'jwk',
  })
  const payloadBytes = fromBase64Url(envelope.payload)
  const sigBytes = fromBase64Url(envelope.signature)
  const ok = cryptoVerify('sha256', payloadBytes, { key: pubKey, dsaEncoding: 'ieee-p1363' }, sigBytes)
  if (!ok) return { valid: false, reason: 'Signature verification failed' }
  return { valid: true, payload: JSON.parse(payloadBytes.toString('utf8')) }
}

function formatLatestYaml({ version, channel, releaseSequence, rolloutPercentage, publishedAt, files, notesUrl }) {
  const lines = [
    `version: ${version}`,
    `channel: ${channel}`,
    `releaseSequence: ${releaseSequence}`,
    `rolloutPercentage: ${rolloutPercentage}`,
    `releaseDate: '${publishedAt}'`,
  ]
  if (notesUrl) lines.push(`releaseNotesUrl: ${notesUrl}`)
  lines.push('files:')
  for (const f of files) {
    lines.push(`  - url: ${f.url}`)
    lines.push(`    fileName: ${f.fileName}`)
    lines.push(`    sha512: ${f.sha512}`)
    lines.push(`    sha256: ${f.sha256}`)
    lines.push(`    size: ${f.sizeBytes}`)
    if (f.blockmapUrl) lines.push(`    blockmapUrl: ${f.blockmapUrl}`)
    if (f.blockmapSha256) lines.push(`    blockmapSha256: ${f.blockmapSha256}`)
  }
  if (files[0]) {
    lines.push(`path: ${files[0].fileName}`)
    lines.push(`sha512: ${files[0].sha512}`)
    lines.push(`sha256: ${files[0].sha256}`)
  }
  return lines.join('\n') + '\n'
}

export async function generateReleaseManifests(opts) {
  const {
    version,
    sequence,
    channel = 'stable',
    rollout = 100,
    baseUrl = 'https://jiangjie.gingers.cloud/downloads',
    outDir,
    onlinePath,
    offlinePath,
    componentsIndexPath,
    previousManifestPath,
    macDmgPath,
    macVersion,
    macUrl,
    codecSourcePath,
    signingKeyPem,
    keyId = 'jiangjie-release-2026',
    expiresDays = 14,
    notesUrl,
    minWindowsBuild = 19045,
  } = opts

  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid SemVer version: ${version}`)
  }
  const releaseSequence = Number(sequence)
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
    throw new Error(`Invalid releaseSequence: ${sequence}`)
  }
  if (!['stable', 'beta'].includes(channel)) {
    throw new Error(`Invalid channel: ${channel}`)
  }
  const rolloutPercentage = Number(rollout)
  if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) {
    throw new Error(`Invalid rolloutPercentage: ${rollout}`)
  }

  mkdirSync(outDir, { recursive: true })
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const versionPrefix = `${cleanBase}/windows/x64/${channel}/${releaseSequence}`
  const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expiresAt = new Date(Date.now() + expiresDays * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  const checksums = []
  const artifacts = {}
  const yamlFiles = []

  const processArtifact = async (key, filePath, withBlockmap = false) => {
    if (!filePath || !existsSync(filePath)) return null
    const fileName = path.basename(filePath)
    const sizeBytes = statSync(filePath).size
    const [sha256, sha512] = await Promise.all([
      hashFile(filePath, 'sha256', 'hex'),
      hashFile(filePath, 'sha512', 'base64'),
    ])
    const entry = {
      url: `${versionPrefix}/${fileName}`,
      fileName,
      sizeBytes,
      sha256,
      sha512,
    }
    checksums.push(`${sha256}  ${fileName}`)
    if (withBlockmap) {
      const bm = await generateBlockmap(filePath)
      const bmName = `${fileName}.blockmap`
      writeFileSync(path.join(outDir, bmName), bm.compressed)
      entry.blockmapUrl = `${versionPrefix}/${bmName}`
      entry.blockmapSha256 = bm.blockmapSha256
      checksums.push(`${bm.blockmapSha256}  ${bmName}`)
    }
    artifacts[key] = entry
    return entry
  }

  const onlineEntry = await processArtifact('bootstrapper', onlinePath, false)
  const offlineEntry = await processArtifact('offline', offlinePath, true)
  const codecSourceEntry = await processArtifact('codecSource', codecSourcePath, false)
  if (offlineEntry) yamlFiles.push(offlineEntry)
  if (onlineEntry) yamlFiles.push(onlineEntry)

  let components = []
  if (componentsIndexPath && existsSync(componentsIndexPath)) {
    const rawIndex = JSON.parse(readFileSync(componentsIndexPath, 'utf8'))
    components = rawIndex.map(c => {
      checksums.push(`${c.sha256}  components/${c.fileName}`)
      return {
        id: c.id,
        url: `${versionPrefix}/components/${c.fileName}`,
        sizeBytes: c.sizeBytes,
        unpackedSizeBytes: c.unpackedSizeBytes,
        sha256: c.sha256,
        fileManifestSha256: c.fileManifestSha256,
        unpackDir: c.unpackDir ?? '',
        fileCount: c.fileCount ?? 0,
      }
    })
  }

  let deltaMetrics = null
  if (components.length > 0) {
    const prevMap = new Map()
    let prevSeq = null
    if (previousManifestPath && existsSync(previousManifestPath)) {
      const prevDoc = JSON.parse(readFileSync(previousManifestPath, 'utf8'))
      prevSeq = prevDoc.releaseSequence ?? null
      for (const c of prevDoc.components || []) prevMap.set(c.id, c)
    }
    let fullBytes = 0
    let changedBytes = 0
    let reusedBytes = 0
    const changedIds = []
    const reusedIds = []
    for (const c of components) {
      const prevComp = prevMap.get(c.id)
      const contentUnchanged = prevComp && (
        prevComp.sha256 === c.sha256 ||
        (prevComp.fileManifestSha256 && prevComp.fileManifestSha256 === c.fileManifestSha256)
      )
      if (contentUnchanged) {
        // Reuse the immutable previous component URL & SHA-256 so clients hit local SHA-256 cache with 0 bytes downloaded!
        c.url = prevComp.url
        c.sha256 = prevComp.sha256
        c.sizeBytes = prevComp.sizeBytes
        fullBytes += c.sizeBytes
        reusedBytes += c.sizeBytes
        reusedIds.push(c.id)
      } else {
        fullBytes += c.sizeBytes
        changedBytes += c.sizeBytes
        changedIds.push(c.id)
      }
    }
    deltaMetrics = {
      previousSequence: prevSeq,
      fullBytes,
      changedBytes,
      reusedBytes,
      savingsPercent: fullBytes > 0 ? Number(((reusedBytes / fullBytes) * 100).toFixed(2)) : 0,
      changedComponentIds: changedIds,
      reusedComponentIds: reusedIds,
    }
  }

  const releasePayload = {
    schemaVersion: 1,
    version,
    releaseSequence,
    channel,
    platform: 'windows',
    arch: 'x64',
    minWindowsBuild,
    rolloutPercentage,
    publishedAt,
    expiresAt,
    minBootstrapperVersion: '0.2.1',
    minUpdaterVersion: '0.2.1',
    releaseNotesUrl: notesUrl || `https://jiangjie.gingers.cloud/#downloads`,
    ...(deltaMetrics ? { deltaMetrics } : {}),
    artifacts,
    components,
  }

  const payloadJson = JSON.stringify(releasePayload, null, 2) + '\n'
  writeFileSync(path.join(outDir, 'releases.win.json'), payloadJson, 'utf8')

  let feedDoc = releasePayload
  if (signingKeyPem) {
    const pem = existsSync(signingKeyPem) ? readFileSync(signingKeyPem, 'utf8') : signingKeyPem
    feedDoc = signFeedPayload(payloadJson, pem, keyId)
  }
  writeFileSync(path.join(outDir, 'feed.json'), JSON.stringify(feedDoc, null, 2) + '\n', 'utf8')

  const yamlName = channel === 'beta' ? 'beta.yml' : 'latest.yml'
  const yamlText = formatLatestYaml({
    version,
    channel,
    releaseSequence,
    rolloutPercentage,
    publishedAt,
    files: yamlFiles,
    notesUrl: releasePayload.releaseNotesUrl,
  })
  writeFileSync(path.join(outDir, yamlName), yamlText, 'utf8')

  // Website-facing multi-platform release-manifest.json
  let macEntry = null
  if (macDmgPath && existsSync(macDmgPath)) {
    const macFileName = path.basename(macDmgPath)
    const macSha = await hashFile(macDmgPath, 'sha256', 'hex')
    macEntry = {
      version: macVersion || version,
      publishedAt,
      minOs: 'macOS 14.0+ (Apple Silicon)',
      installer: {
        fileName: macFileName,
        url: macUrl || `${cleanBase}/macos/arm64/${channel}/${macFileName}`,
        sizeBytes: statSync(macDmgPath).size,
        sha256: macSha,
      },
    }
  } else if (macUrl) {
    macEntry = {
      version: macVersion || version,
      publishedAt,
      minOs: 'macOS 14.0+ (Apple Silicon)',
      installer: {
        fileName: path.basename(new URL(macUrl).pathname) || 'Jiangjie-macOS-arm64.dmg',
        url: macUrl,
        sizeBytes: null,
        sha256: null,
      },
    }
  }

  const siteManifest = {
    schemaVersion: 1,
    generatedAt: publishedAt,
    defaultChannel: channel,
    channels: {
      [channel]: {
        version,
        releaseSequence,
        rolloutPercentage,
        publishedAt,
        releaseNotesUrl: releasePayload.releaseNotesUrl,
        platforms: {
          'windows-x64': {
            label: 'Windows 11 / 10 (64 位)',
            requirements: 'Windows 11 x64（或 Windows 10 22H2 x64）· 免管理员权限',
            feedUrl: `${cleanBase}/windows/x64/${channel}/feed.json`,
            online: onlineEntry
              ? {
                  fileName: onlineEntry.fileName,
                  url: onlineEntry.url,
                  sizeBytes: onlineEntry.sizeBytes,
                  sha256: onlineEntry.sha256,
                }
              : null,
            offline: offlineEntry
              ? {
                  fileName: offlineEntry.fileName,
                  url: offlineEntry.url,
                  sizeBytes: offlineEntry.sizeBytes,
                  sha256: offlineEntry.sha256,
                  blockmapUrl: offlineEntry.blockmapUrl,
                }
              : null,
            codecSource: codecSourceEntry
              ? {
                  fileName: codecSourceEntry.fileName,
                  url: codecSourceEntry.url,
                  sizeBytes: codecSourceEntry.sizeBytes,
                  sha256: codecSourceEntry.sha256,
                }
              : null,
          },
          ...(macEntry ? { 'macos-arm64': macEntry } : {}),
        },
      },
    },
  }
  writeFileSync(path.join(outDir, 'release-manifest.json'), JSON.stringify(siteManifest, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8')

  return { releasePayload, feedDoc, siteManifest, yamlName }
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    if (!key.startsWith('--')) continue
    const val = rest[i + 1]
    if (val === undefined || val.startsWith('--')) {
      opts[key.slice(2)] = true
    } else {
      opts[key.slice(2)] = val
      i++
    }
  }
  return { command, opts }
}

async function main() {
  const { command, opts } = parseCliArgs(process.argv.slice(2))
  if (command === 'keygen') {
    const pair = generateEcdsaP256KeyPair()
    if (opts['private-out']) writeFileSync(opts['private-out'], pair.privatePem, { mode: 0o600 })
    if (opts['public-out']) writeFileSync(opts['public-out'], pair.publicKeyBase64Url + '\n', 'utf8')
    console.log(JSON.stringify({ publicKeyBase64Url: pair.publicKeyBase64Url }, null, 2))
    return
  }
  if (command === 'build-components') {
    const res = await buildComponents({
      stageDir: opts.stage,
      outDir: opts['out-dir'],
      hashesOut: opts['hashes-out'],
    })
    console.log(JSON.stringify({ components: res.index.length, outDir: opts['out-dir'] }, null, 2))
    return
  }
  if (command === 'generate') {
    const res = await generateReleaseManifests({
      version: opts.version,
      sequence: opts.sequence,
      channel: opts.channel || 'stable',
      rollout: opts.rollout ?? 100,
      baseUrl: opts['base-url'] || 'https://jiangjie.gingers.cloud/downloads',
      outDir: opts['out-dir'],
      onlinePath: opts.online,
      offlinePath: opts.offline,
      componentsIndexPath: opts['components-index'],
      previousManifestPath: opts['previous-manifest'],
      macDmgPath: opts['mac-dmg'],
      macVersion: opts['mac-version'],
      macUrl: opts['mac-url'],
      codecSourcePath: opts['codec-source'],
      signingKeyPem: opts['signing-key'],
      keyId: opts['key-id'] || 'jiangjie-release-2026',
      notesUrl: opts['notes-url'],
    })
    console.log(JSON.stringify({
      version: res.releasePayload.version,
      releaseSequence: res.releasePayload.releaseSequence,
      channel: res.releasePayload.channel,
      rolloutPercentage: res.releasePayload.rolloutPercentage,
      yaml: res.yamlName,
      deltaMetrics: res.releasePayload.deltaMetrics || null,
    }, null, 2))
    return
  }
  if (command === 'verify') {
    const envelope = JSON.parse(readFileSync(opts.feed, 'utf8'))
    const result = verifySignedEnvelope(envelope, opts.pubkey)
    if (!result.valid) {
      console.error(`Verify failed: ${result.reason}`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify({ valid: true, version: result.payload.version, releaseSequence: result.payload.releaseSequence }))
    return
  }
  throw new Error('Usage: generate-release-manifest.mjs <build-components|generate|verify|keygen> [options]')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => {
    console.error(`[manifest] ${err.message}`)
    process.exitCode = 1
  })
}
