/**
 * 讲界视频工坊官网智能下载区脚本（零依赖，自动读取 /downloads/release-manifest.json）。
 * - 优先使用 navigator.userAgentData.getHighEntropyValues(['platform', 'architecture'])
 * - 自动兼容降级至 navigator.userAgent / navigator.platform
 * - 严禁在前端写死版本号，所有版本、体积、链接与 SHA-256 均从 release-manifest.json 动态渲染
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof root !== 'undefined') {
    root.JiangjieDownloads = api
    if (root.document) {
      if (root.document.readyState === 'loading') {
        root.document.addEventListener('DOMContentLoaded', () => api.initDownloadsSection())
      } else {
        api.initDownloadsSection()
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FALLBACK_ONLINE_URL = '/downloads/windows/x64/stable/Jiangjie-Setup-Online-x64.exe'

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }

  function formatDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  async function detectClientPlatform(nav = typeof navigator !== 'undefined' ? navigator : {}) {
    let platform = ''
    let arch = ''

    try {
      const uaData = nav?.userAgentData
      if (uaData) {
        platform = String(uaData.platform || '').toLowerCase()
        if (typeof uaData.getHighEntropyValues === 'function') {
          const hints = await uaData.getHighEntropyValues(['platform', 'architecture', 'bitness'])
          if (hints?.platform) platform = String(hints.platform).toLowerCase()
          if (hints?.architecture) arch = String(hints.architecture).toLowerCase()
        }
      }
    } catch {
      // Fallback gracefully to userAgent parsing
    }

    const ua = String(nav?.userAgent || '').toLowerCase()
    const legacyPlatform = String(nav?.platform || '').toLowerCase()

    if (!platform) {
      if (ua.includes('windows') || legacyPlatform.includes('win')) platform = 'windows'
      else if (ua.includes('mac os x') || ua.includes('macintosh') || legacyPlatform.includes('mac')) platform = 'macos'
      else if (ua.includes('linux')) platform = 'linux'
    }

    if (!arch) {
      if (ua.includes('arm64') || ua.includes('aarch64') || ua.includes('apple silicon')) arch = 'arm'
      else if (ua.includes('win64') || ua.includes('x64') || ua.includes('wow64') || ua.includes('x86_64') || ua.includes('amd64')) arch = 'x86'
    }

    if (platform.includes('win')) {
      return {
        id: 'windows-x64',
        os: 'windows',
        arch: arch.includes('arm') ? 'arm64' : 'x64',
        displayName: arch.includes('arm') ? 'Windows ARM64（通过 x64 兼容运行）' : 'Windows x64',
      }
    }
    if (platform.includes('mac')) {
      const isIntel = arch === 'x86' && !ua.includes('arm')
      return {
        id: 'macos-arm64',
        os: 'macos',
        arch: isIntel ? 'x64' : 'arm64',
        displayName: isIntel ? 'macOS（桌面端当前仅支持 Apple Silicon）' : 'macOS Apple Silicon',
      }
    }
    return {
      id: 'windows-x64',
      os: 'other',
      arch: 'unknown',
      displayName: '当前系统（推荐查看以下桌面版本）',
    }
  }

  function resolveChannelData(manifest, requestedChannel) {
    if (!manifest || typeof manifest !== 'object' || !manifest.channels) return null
    const channelName = requestedChannel && manifest.channels[requestedChannel]
      ? requestedChannel
      : (manifest.defaultChannel && manifest.channels[manifest.defaultChannel] ? manifest.defaultChannel : Object.keys(manifest.channels)[0])
    if (!channelName) return null
    return { channelName, data: manifest.channels[channelName] }
  }

  function buildPlatformView(manifest, platformId, requestedChannel) {
    const resolved = resolveChannelData(manifest, requestedChannel)
    if (!resolved) return null
    const { channelName, data } = resolved
    const platforms = data.platforms || {}
    const selectedId = platforms[platformId] ? platformId : (platforms['windows-x64'] ? 'windows-x64' : Object.keys(platforms)[0])
    const entry = platforms[selectedId]
    if (!entry) return null

    if (selectedId === 'windows-x64') {
      const primary = entry.online || entry.offline
      const isOnline = Boolean(entry.online)
      return {
        platformId: selectedId,
        channelName,
        version: data.version,
        publishedAt: data.publishedAt,
        requirements: entry.requirements || 'Windows 11 x64（兼容 Windows 10 22H2 x64）· 免管理员权限',
        primaryLabel: isOnline ? '立即下载（在线安装版）' : '立即下载（离线完整版）',
        primaryArtifact: primary,
        offlineArtifact: isOnline ? entry.offline : null,
        codecSource: entry.codecSource || null,
        notesUrl: data.releaseNotesUrl || null,
        availablePlatforms: Object.keys(platforms),
      }
    }

    return {
      platformId: selectedId,
      channelName,
      version: entry.version || data.version,
      publishedAt: entry.publishedAt || data.publishedAt,
      requirements: entry.minOs || 'macOS 14.0+ (Apple Silicon)',
      primaryLabel: '立即下载（macOS Apple Silicon）',
      primaryArtifact: entry.installer || null,
      offlineArtifact: null,
      codecSource: entry.codecSource || null,
      notesUrl: data.releaseNotesUrl || null,
      availablePlatforms: Object.keys(platforms),
    }
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function isSafeHref(url) {
    if (!url || typeof url !== 'string') return false
    return url.startsWith('https://') || url.startsWith('/')
  }

  function initDownloadsSection(rootEl) {
    const section = rootEl || document.getElementById('downloads')
    if (!section) return

    const manifestUrl = section.dataset.manifestUrl || '/downloads/release-manifest.json'
    const fallbackUrl = section.dataset.fallbackOnlineUrl || FALLBACK_ONLINE_URL
    const stateBox = section.querySelector('[data-dl-state]')
    const switcher = section.querySelector('[data-dl-switcher]')
    const primaryBtn = section.querySelector('[data-dl-primary]')
    const primaryMeta = section.querySelector('[data-dl-meta]')
    const detectedBadge = section.querySelector('[data-dl-detected]')
    const detailsBox = section.querySelector('[data-dl-details]')
    const offlineRow = section.querySelector('[data-dl-offline-row]')
    const shaList = section.querySelector('[data-dl-sha-list]')
    const codecRow = section.querySelector('[data-dl-codec-row]')

    let loadedManifest = null
    let activePlatformId = 'windows-x64'
    let detected = null

    function renderView() {
      const view = buildPlatformView(loadedManifest, activePlatformId)
      if (!view || !view.primaryArtifact || !isSafeHref(view.primaryArtifact.url)) {
        renderError('发布清单缺少当前平台的有效下载链接。')
        return
      }

      if (stateBox) stateBox.hidden = true
      if (detectedBadge && detected) {
        detectedBadge.textContent = `已自动识别系统：${detected.displayName}`
      }

      if (primaryBtn) {
        primaryBtn.href = view.primaryArtifact.url
        primaryBtn.setAttribute('download', view.primaryArtifact.fileName || '')
        primaryBtn.hidden = false
        const labelEl = primaryBtn.querySelector('[data-dl-primary-label]')
        if (labelEl) labelEl.textContent = view.primaryLabel
        else primaryBtn.textContent = view.primaryLabel
      }

      if (primaryMeta) {
        const sizeText = formatBytes(view.primaryArtifact.sizeBytes)
        const parts = [
          `版本 v${view.version}`,
          sizeText !== '—' ? `大小 ${sizeText}` : null,
          `发布于 ${formatDate(view.publishedAt)}`,
          view.requirements,
        ].filter(Boolean)
        primaryMeta.textContent = parts.join(' · ')
      }

      if (switcher) {
        const labels = { 'windows-x64': 'Windows x64', 'macos-arm64': 'macOS Apple Silicon' }
        switcher.innerHTML = view.availablePlatforms.map(id => {
          const active = id === view.platformId
          return `<button type="button" class="dl-tab${active ? ' is-active' : ''}" data-platform="${escapeHtml(id)}" aria-pressed="${active}">${escapeHtml(labels[id] || id)}</button>`
        }).join('')
        switcher.querySelectorAll('button[data-platform]').forEach(btn => {
          btn.addEventListener('click', () => {
            activePlatformId = btn.dataset.platform
            renderView()
          })
        })
      }

      if (offlineRow) {
        if (view.offlineArtifact && isSafeHref(view.offlineArtifact.url)) {
          offlineRow.hidden = false
          offlineRow.innerHTML = `
            <div class="dl-sub-row">
              <div>
                <strong>离线完整安装包</strong>
                <span>适合弱网或企业内网环境 · ${escapeHtml(view.offlineArtifact.fileName)}（${escapeHtml(formatBytes(view.offlineArtifact.sizeBytes))}）</span>
              </div>
              <a class="dl-link" href="${escapeHtml(view.offlineArtifact.url)}" download="${escapeHtml(view.offlineArtifact.fileName || '')}">下载离线完整版 ↘</a>
            </div>`
        } else {
          offlineRow.hidden = true
          offlineRow.innerHTML = ''
        }
      }

      if (shaList) {
        const rows = []
        if (view.primaryArtifact.sha256) {
          rows.push({
            label: view.platformId === 'windows-x64' ? '在线引导安装器' : '安装包',
            fileName: view.primaryArtifact.fileName,
            sha256: view.primaryArtifact.sha256,
          })
        }
        if (view.offlineArtifact?.sha256) {
          rows.push({
            label: '离线完整安装包',
            fileName: view.offlineArtifact.fileName,
            sha256: view.offlineArtifact.sha256,
          })
        }
        shaList.innerHTML = rows.length
          ? rows.map(r => `
              <div class="dl-sha-item">
                <div class="dl-sha-head">
                  <span>${escapeHtml(r.label)} · ${escapeHtml(r.fileName)}</span>
                  <button type="button" class="dl-copy" data-copy-sha="${escapeHtml(r.sha256)}">复制 SHA-256</button>
                </div>
                <code>${escapeHtml(r.sha256)}</code>
              </div>`).join('')
          : '<p class="dl-muted">该版本暂未提供 SHA-256 摘要，请查看对应 GitHub Release 说明。</p>'

        shaList.querySelectorAll('button[data-copy-sha]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const val = btn.dataset.copySha
            try {
              await navigator.clipboard?.writeText(val)
              const orig = btn.textContent
              btn.textContent = '已复制'
              setTimeout(() => { btn.textContent = orig }, 1800)
            } catch {
              btn.textContent = '请手动选中复制'
            }
          })
        })
      }

      if (codecRow) {
        if (view.codecSource && isSafeHref(view.codecSource.url)) {
          codecRow.hidden = false
          codecRow.innerHTML = `开源合规：<a class="dl-link" href="${escapeHtml(view.codecSource.url)}">下载 FFmpeg GPL 对应源码包（${escapeHtml(formatBytes(view.codecSource.sizeBytes))}）</a>`
        } else {
          codecRow.hidden = true
        }
      }

      if (detailsBox) detailsBox.hidden = false
    }

    function renderError(message) {
      if (primaryBtn) {
        primaryBtn.href = fallbackUrl
        primaryBtn.hidden = false
        const labelEl = primaryBtn.querySelector('[data-dl-primary-label]')
        if (labelEl) labelEl.textContent = '立即下载（在线安装版）'
      }
      if (primaryMeta) {
        primaryMeta.textContent = '未能获取最新版本清单，已为您切换同源兜底在线安装入口。'
      }
      if (stateBox) {
        stateBox.hidden = false
        stateBox.innerHTML = `<span>${escapeHtml(message)}</span> <button type="button" class="dl-retry">重试获取版本信息</button>`
        const retry = stateBox.querySelector('.dl-retry')
        if (retry) retry.addEventListener('click', load)
      }
    }

    async function load() {
      detected = await detectClientPlatform()
      activePlatformId = detected.id
      if (detectedBadge) detectedBadge.textContent = `已自动识别系统：${detected.displayName}`
      if (stateBox) {
        stateBox.hidden = false
        stateBox.textContent = '正在获取最新版本清单…'
      }
      try {
        const res = await fetch(manifestUrl, { cache: 'no-cache', credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        loadedManifest = await res.json()
        renderView()
      } catch (err) {
        renderError(`版本清单暂时不可用（${err?.message || '网络异常'}）。`)
      }
    }

    load()
  }

  return {
    detectClientPlatform,
    buildPlatformView,
    resolveChannelData,
    formatBytes,
    formatDate,
    initDownloadsSection,
  }
})
