import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildComponents,
  diffBlockmaps,
  generateBlockmap,
  generateEcdsaP256KeyPair,
  generateReleaseManifests,
  verifySignedEnvelope,
} from './generate-release-manifest.mjs'

function makeFakeStage(root, appText) {
  mkdirSync(path.join(root, 'runtime/node'), { recursive: true })
  mkdirSync(path.join(root, 'runtime/python'), { recursive: true })
  mkdirSync(path.join(root, 'runtime/webview2'), { recursive: true })
  mkdirSync(path.join(root, 'runtime/chromium'), { recursive: true })
  mkdirSync(path.join(root, 'runtime/codecs'), { recursive: true })
  mkdirSync(path.join(root, 'desktop/windows'), { recursive: true })
  mkdirSync(path.join(root, 'dsh-workbench-fix/dsh-base'), { recursive: true })
  mkdirSync(path.join(root, 'video-kit'), { recursive: true })

  writeFileSync(path.join(root, 'runtime/node/node.exe'), Buffer.alloc(4096, 0x41))
  writeFileSync(path.join(root, 'runtime/python/python.exe'), Buffer.alloc(4096, 0x42))
  writeFileSync(path.join(root, 'runtime/webview2/msedgewebview2.exe'), Buffer.alloc(8192, 0x43))
  writeFileSync(path.join(root, 'runtime/chromium/chrome.exe'), Buffer.alloc(8192, 0x44))
  writeFileSync(path.join(root, 'runtime/codecs/ffmpeg.exe'), Buffer.alloc(4096, 0x45))
  writeFileSync(path.join(root, 'Jiangjie.exe'), Buffer.from(`launcher-${appText}`))
  writeFileSync(path.join(root, 'JiangjieApp.exe'), Buffer.from(`app-${appText}`))
  writeFileSync(path.join(root, 'JiangjieUpdater.exe'), Buffer.from(`updater-${appText}`))
  writeFileSync(path.join(root, 'BohackCredentialStore.exe'), Buffer.from('cred'))
  writeFileSync(path.join(root, 'desktop-agent.patch.yml'), '[]\n')
  writeFileSync(path.join(root, 'runtime-bom.json'), JSON.stringify({ appText }))
  writeFileSync(path.join(root, 'desktop/windows/diagnostics.mjs'), '// diag\n')
  writeFileSync(path.join(root, 'dsh-workbench-fix/dsh-base/start-dsh.mjs'), '// dsh\n')
  writeFileSync(path.join(root, 'video-kit/package.json'), '{"name":"video-kit"}\n')
}

test('generates blockmaps, signed feeds, multi-channel YAML, and proves A->B component reuse savings', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jiangjie-manifest-test-'))
  try {
    const keys = generateEcdsaP256KeyPair()
    assert.equal(Buffer.from(keys.publicKeyBase64Url, 'base64url').length, 64)

    // Release A (v0.2.1, seq 2)
    const stageA = path.join(tmp, 'stage-a')
    const outA = path.join(tmp, 'out-a')
    makeFakeStage(stageA, 'v1')
    const onlineA = path.join(tmp, 'Jiangjie-Setup-Online-x64.exe')
    const offlineA = path.join(tmp, 'Jiangjie-Setup-Offline-x64.exe')
    writeFileSync(onlineA, Buffer.alloc(128 * 1024, 0x11))
    writeFileSync(offlineA, Buffer.concat([Buffer.alloc(128 * 1024, 0x22), Buffer.alloc(64 * 1024, 0x33)]))

    await buildComponents({
      stageDir: stageA,
      outDir: path.join(outA, 'components'),
      hashesOut: path.join(outA, 'component-hashes.json'),
    })

    const resA = await generateReleaseManifests({
      version: '0.2.1',
      sequence: 2,
      channel: 'stable',
      rollout: 25,
      outDir: outA,
      onlinePath: onlineA,
      offlinePath: offlineA,
      componentsIndexPath: path.join(outA, 'components/components-index.json'),
      signingKeyPem: keys.privatePem,
      keyId: 'k-2026',
    })

    // Verify signed envelope
    const feedA = JSON.parse(readFileSync(path.join(outA, 'feed.json'), 'utf8'))
    const verified = verifySignedEnvelope(feedA, keys.publicKeyBase64Url)
    assert.equal(verified.valid, true)
    assert.equal(verified.payload.version, '0.2.1')
    assert.equal(verified.payload.rolloutPercentage, 25)

    // Tampered envelope must fail
    const badFeed = { ...feedA, signature: feedA.signature.slice(0, -2) + 'AA' }
    assert.equal(verifySignedEnvelope(badFeed, keys.publicKeyBase64Url).valid, false)

    // Verify latest.yml and release-manifest.json
    const latestYml = readFileSync(path.join(outA, 'latest.yml'), 'utf8')
    assert.match(latestYml, /version: 0\.2\.1/)
    assert.match(latestYml, /channel: stable/)
    assert.match(latestYml, /rolloutPercentage: 25/)
    assert.match(latestYml, /\.blockmap/)

    const siteManifest = JSON.parse(readFileSync(path.join(outA, 'release-manifest.json'), 'utf8'))
    assert.equal(siteManifest.channels.stable.version, '0.2.1')
    assert.equal(siteManifest.channels.stable.platforms['windows-x64'].online.fileName, 'Jiangjie-Setup-Online-x64.exe')
    assert.equal(siteManifest.channels.stable.platforms['windows-x64'].offline.fileName, 'Jiangjie-Setup-Offline-x64.exe')

    // Release B (v0.2.2, seq 3, beta channel) — only `app` changed, runtime components identical!
    const stageB = path.join(tmp, 'stage-b')
    const outB = path.join(tmp, 'out-b')
    makeFakeStage(stageB, 'v2-changed-only-app')
    const offlineB = path.join(tmp, 'Jiangjie-Setup-Offline-x64-b.exe')
    writeFileSync(offlineB, Buffer.concat([Buffer.alloc(128 * 1024, 0x22), Buffer.alloc(64 * 1024, 0x99)]))

    await buildComponents({
      stageDir: stageB,
      outDir: path.join(outB, 'components'),
      hashesOut: path.join(outB, 'component-hashes.json'),
    })

    const resB = await generateReleaseManifests({
      version: '0.2.2-beta.1',
      sequence: 3,
      channel: 'beta',
      rollout: 50,
      outDir: outB,
      onlinePath: onlineA,
      offlinePath: offlineB,
      componentsIndexPath: path.join(outB, 'components/components-index.json'),
      previousManifestPath: path.join(outA, 'releases.win.json'),
      signingKeyPem: keys.privatePem,
    })

    assert.equal(resB.yamlName, 'beta.yml')
    const delta = resB.releasePayload.deltaMetrics
    assert.ok(delta.reusedComponentIds.includes('node'))
    assert.ok(delta.reusedComponentIds.includes('python'))
    assert.ok(delta.reusedComponentIds.includes('webview2'))
    assert.ok(delta.reusedComponentIds.includes('chromium'))
    assert.ok(delta.reusedComponentIds.includes('codecs'))
    assert.deepEqual(delta.changedComponentIds, ['app'])
    assert.ok(delta.reusedBytes > 0)
    assert.ok(delta.savingsPercent > 50, `Expected >50% component reuse, got ${delta.savingsPercent}%`)

    // Verify blockmap differential savings on the offline binary
    const bmA = await generateBlockmap(offlineA)
    const bmB = await generateBlockmap(offlineB)
    const bmDiff = diffBlockmaps(bmA.compressed, bmB.compressed)
    assert.equal(bmDiff.reusedBytes, 128 * 1024)
    assert.equal(bmDiff.changedBytes, 64 * 1024)
    assert.ok(bmDiff.savingsPercent > 66)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
