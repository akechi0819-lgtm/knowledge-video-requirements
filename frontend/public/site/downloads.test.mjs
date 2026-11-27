import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dl = require('./downloads.js')

const SAMPLE_MANIFEST = {
  schemaVersion: 1,
  defaultChannel: 'stable',
  channels: {
    stable: {
      version: '0.3.2',
      releaseSequence: 7,
      rolloutPercentage: 100,
      publishedAt: '2026-11-26T08:00:00Z',
      releaseNotesUrl: 'https://jiangjie.gingers.cloud/#downloads',
      platforms: {
        'windows-x64': {
          requirements: 'Windows 11 x64 · 免管理员权限',
          online: {
            fileName: 'Jiangjie-Setup-Online-x64.exe',
            url: 'https://jiangjie.gingers.cloud/downloads/windows/x64/stable/7/Jiangjie-Setup-Online-x64.exe',
            sizeBytes: 420000,
            sha256: 'a'.repeat(64),
          },
          offline: {
            fileName: 'Jiangjie-Setup-Offline-x64.exe',
            url: 'https://jiangjie.gingers.cloud/downloads/windows/x64/stable/7/Jiangjie-Setup-Offline-x64.exe',
            sizeBytes: 512 * 1024 * 1024,
            sha256: 'b'.repeat(64),
          },
        },
        'macos-arm64': {
          version: '0.3.2',
          minOs: 'macOS 14.0+ (Apple Silicon)',
          installer: {
            fileName: 'Jiangjie-macOS-arm64.dmg',
            url: 'https://jiangjie.gingers.cloud/downloads/macos/arm64/stable/Jiangjie-macOS-arm64.dmg',
            sizeBytes: 600 * 1024 * 1024,
            sha256: 'c'.repeat(64),
          },
        },
      },
    },
  },
}

test('detectClientPlatform prefers navigator.userAgentData and falls back to userAgent', async () => {
  const winUaData = await dl.detectClientPlatform({
    userAgentData: {
      platform: 'Windows',
      getHighEntropyValues: async () => ({ platform: 'Windows', architecture: 'x86', bitness: '64' }),
    },
  })
  assert.equal(winUaData.id, 'windows-x64')
  assert.equal(winUaData.os, 'windows')

  const macUaData = await dl.detectClientPlatform({
    userAgentData: {
      platform: 'macOS',
      getHighEntropyValues: async () => ({ platform: 'macOS', architecture: 'arm', bitness: '64' }),
    },
  })
  assert.equal(macUaData.id, 'macos-arm64')
  assert.equal(macUaData.arch, 'arm64')

  const winFallback = await dl.detectClientPlatform({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  })
  assert.equal(winFallback.id, 'windows-x64')

  const macFallback = await dl.detectClientPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
  })
  assert.equal(macFallback.id, 'macos-arm64')
})

test('buildPlatformView dynamically resolves Windows online/offline and macOS artifacts without hardcoded versions', () => {
  const winView = dl.buildPlatformView(SAMPLE_MANIFEST, 'windows-x64')
  assert.equal(winView.version, '0.3.2')
  assert.equal(winView.primaryLabel, '立即下载（在线安装版）')
  assert.equal(winView.primaryArtifact.fileName, 'Jiangjie-Setup-Online-x64.exe')
  assert.equal(winView.offlineArtifact.fileName, 'Jiangjie-Setup-Offline-x64.exe')

  const macView = dl.buildPlatformView(SAMPLE_MANIFEST, 'macos-arm64')
  assert.equal(macView.version, '0.3.2')
  assert.equal(macView.primaryLabel, '立即下载（macOS Apple Silicon）')
  assert.equal(macView.primaryArtifact.fileName, 'Jiangjie-macOS-arm64.dmg')
  assert.equal(macView.offlineArtifact, null)
})

test('formatBytes formats KB/MB/GB cleanly', () => {
  assert.equal(dl.formatBytes(425984), '416 KB')
  assert.equal(dl.formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(dl.formatBytes(1.5 * 1024 ** 3), '1.50 GB')
})
