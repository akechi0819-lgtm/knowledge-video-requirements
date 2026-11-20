/* 讲界成片台：按蓝图段展示制作进度，并用段落映射同步播放。 */
window.BohackFilm = (() => {
  const PHASES = ['生成素材', '生成画面', '配音与渲染', '自动质检', '制作完成']

  function qs(root, sel) { return root.querySelector(sel) }

  function fileUrl(threadId, kind, section) {
    const url = new URL('/bohack/api/production-file', location.origin)
    url.searchParams.set('threadId', threadId)
    url.searchParams.set('kind', kind)
    if (section) url.searchParams.set('section', section)
    return url.pathname + url.search
  }

  function formatClock(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0))
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
  }

  function elapsed(from) {
    if (!from) return ''
    const ms = Date.now() - new Date(from).getTime()
    if (!Number.isFinite(ms) || ms < 0) return ''
    const s = Math.floor(ms / 1000)
    if (s < 60) return `已等待 ${s} 秒`
    return `已等待 ${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
  }

  function sectionStep(sec, phase, status) {
    if (sec.clip) return '片段已出'
    if (sec.audio) return '配音已好'
    if (sec.scene) return '画面已好'
    if (status === 'running' && phase === '生成画面') return '正在出画面'
    if (status === 'running') return '等待出画面'
    return '尚未开始'
  }

  function failureMessage(error) {
    const lines=String(error || '未知错误').trim().split(/\r?\n/)
    const reason=lines.filter(line=>/^(?:[\w.]*Error|Error):/.test(line)).at(-1) || lines[0]
    if(reason.includes('CERTIFICATE_VERIFY_FAILED')) return '配音服务的 HTTPS 证书校验失败。'
    return reason.replace(/^Error:\s*/, '')
  }

  function headline(p) {
    if (!p) return '按定稿蓝图制作画面、旁白和视频。'
    if (p.status === 'failed') return p.error ? `制作失败：${failureMessage(p.error)}` : '制作失败，请重新制作。'
    if (p.status === 'interrupted') return '制作中断。可以从已保存的产物继续。'
    if (p.status === 'abandoned') return '已放弃本片制作，会员制作名额已释放。'
    if (p.status === 'completed') {
      if (p.membershipError) return p.membershipError
      if (p.membershipPending) return '成片已保存在本机，完成回执待确认。'
      if (p.source === 'external') return `蓝图 ${p.version} 的独立制作成片已归档，请按段观看并核对。`
      if (p.verify && p.verify.pass === false) return '成片已合成，质检发现需要核对的问题。'
      return '成片已做好，点击右侧段落可跳到对应时刻。'
    }
    const sections = p.sections || []
    const withScene = sections.filter(s => s.scene).length
    const withAudio = sections.filter(s => s.audio).length
    const withClip = sections.filter(s => s.clip).length
    if (p.phase === '正在制作视频') return '视频 Agent 正在读取蓝图和素材，设计画面。'
    if (p.phase === '生成素材') return '正在为当前蓝图准备动画素材。'
    if (p.phase === '生成画面') {
      const current = sections.find(s => !s.scene)
      if (current) return withScene ? `${current.id} 正在生成画面，已完成 ${withScene} / ${sections.length} 段。` : '正在根据蓝图生成各段画面。'
      return sections.length ? '各段画面已经就绪，即将开始配音与渲染。' : '正在生成画面。'
    }
    if (p.phase === '配音与渲染') {
      const current = sections.find(s => !s.clip)
      if (current?.audio && !current.clip) return `${current.id} 配音已好，正在渲染片段。`
      if (current) return withClip ? `正在为 ${current.id} 配音并渲染，已完成 ${withClip} / ${sections.length} 段。` : '正在为各段配音并渲染片段。'
      return withAudio ? '各段配音已写好，正在合成完整成片。' : '正在配音与渲染。'
    }
    if (p.phase === '自动质检') return '成片已合成，正在做自动质检。'
    return p.phase ? `正在${p.phase}。` : '正在制作成片。'
  }

  function renderPhases(rail, p) {
    if (!p || p.status === 'completed') { rail.hidden = true; rail.replaceChildren(); return }
    const phases = p.mode === 'agent' ? ['启动视频制作 Agent', '生成配音', '编写画面', '预览画面', '配音与渲染', '自动质检', '制作完成'] : PHASES
    const idx = Math.max(0, phases.indexOf(p.phase === '正在制作视频' ? '编写画面' : p.phase))
    const failed = p.status === 'failed' || p.status === 'interrupted'
    rail.hidden = false
    rail.innerHTML = phases.map((name, i) => {
      const state = failed && i === idx ? 'is-fail' : i < idx || p.status === 'completed' ? 'is-done' : i === idx ? 'is-on' : ''
      return `<li class="${state}"><span class="phase-dot" aria-hidden="true"></span><span>${name}</span></li>`
    }).join('')
  }

  function renderCards(rail, p, onSelect, activeId) {
    const sections = p?.sections || []
    if (!sections.length) { rail.hidden = true; rail.replaceChildren(); return }
    rail.hidden = false
    const verifyMap = Object.fromEntries((p.verify?.segments || []).map(s => [s.id, s]))
    rail.innerHTML = sections.map(sec => {
      const step = sectionStep(sec, p.phase, p.status)
      const issues = verifyMap[sec.id]?.issues || []
      const on = sec.id === activeId ? ' is-on' : ''
      const ready = sec.clip || p.artifacts?.video ? ' is-ready' : ''
      return `<button type="button" class="sec-card${on}${ready}" data-sec="${sec.id}">
        <header><span class="sid">${sec.id}</span><span class="step">${step}</span></header>
        <h3>${esc(sec.title || sec.id)}</h3>
        ${sec.narration ? `<p class="narration">${esc(sec.narration)}</p>` : ''}
        ${issues.length ? `<p class="sec-issue">${esc(issues.join('；'))}</p>` : ''}
      </button>`
    }).join('')
    rail.querySelectorAll('[data-sec]').forEach(btn => {
      btn.addEventListener('click', () => onSelect(btn.dataset.sec))
    })
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]))
  }

  function stageMedia(threadId, p, sectionId) {
    if (p?.artifacts?.video) return { kind: 'video', src: fileUrl(threadId, 'video') }
    const sections = p?.sections || []
    const preferred = sections.find(s => s.id === sectionId && s.clip) || sections.filter(s => s.clip).at(-1)
    if (preferred) return { kind: 'clip', src: fileUrl(threadId, 'clip', preferred.id), section: preferred.id }
    const scene = sections.find(s => s.id === sectionId && s.sceneKind === 'html') || sections.find(s => s.sceneKind === 'html')
    if (scene && p.mode !== 'agent') return { kind: 'scene', src: fileUrl(threadId, 'scene', scene.id), section: scene.id }
    return { kind: 'waiting' }
  }

  function waitingMarkup(p) {
    return `<div class="film-waiting">
      <svg class="icon" aria-hidden="true"><use href="#icon-brand"/></svg>
      <p>${esc(headline(p))}</p>
    </div>`
  }

  function bindPlayer(shell, p, threadId) {
    const video = qs(shell, '#filmVideo')
    const fill = qs(shell, '.timeline-fill')
    const time = qs(shell, '.player-time')
    const toggle = qs(shell, '.player-toggle')
    const track = qs(shell, '.timeline-track')
    const playbackError = qs(shell, '.player-error')
    if (!video || !track) return
    const segments = p.mapping?.segments || []
    const duration = () => video.duration || p.mapping?.duration || 0

    function currentId() {
      const t = video.currentTime || 0
      const hit = segments.find(seg => t >= (seg.start || 0) && t < (seg.end || Infinity))
      return hit?.id || segments.at(-1)?.id || ''
    }

    function paint() {
      const total = duration()
      const t = video.currentTime || 0
      if (fill) fill.style.width = total ? `${Math.min(100, (t / total) * 100)}%` : '0%'
      if (time) time.textContent = `${formatClock(t)} / ${formatClock(total)}`
      track.setAttribute('aria-valuenow', String(total ? Math.min(100, Math.round(t / total * 100)) : 0))
      track.setAttribute('aria-valuetext', `${formatClock(t)} / ${formatClock(total)}`)
      const id = currentId()
      shell.querySelectorAll('.sec-card').forEach(card => card.classList.toggle('is-on', card.dataset.sec === id))
      if (toggle) toggle.setAttribute('aria-label', video.paused ? '播放' : '暂停')
      if (toggle) toggle.dataset.playing = video.paused ? '0' : '1'
    }

    function seek(ratio) {
      const total = duration()
      if (!total) return
      video.currentTime = Math.min(total - 0.05, Math.max(0, ratio * total))
    }

    function play() {
      playbackError.textContent = ''
      video.play().catch(error => {
        if (error.name !== 'AbortError') playbackError.textContent = '无法播放这段视频，请稍后重试。'
      })
    }

    video.ontimeupdate = paint
    video.onloadedmetadata = paint
    video.onplay = paint
    video.onpause = paint
    toggle && (toggle.onclick = () => { video.paused ? play() : video.pause() })
    track.onclick = event => {
      const rect = track.getBoundingClientRect()
      seek((event.clientX - rect.left) / rect.width)
    }
    track.onkeydown = event => {
      if (event.target !== track) return
      const total = duration()
      if (!total) return
      const current = video.currentTime || 0
      const positions = { ArrowLeft: current - 5, ArrowRight: current + 5, ArrowDown: current - 5, ArrowUp: current + 5, Home: 0, End: total }
      if (!Object.hasOwn(positions, event.key)) return
      event.preventDefault()
      seek(positions[event.key] / total)
    }
    shell.querySelectorAll('.timeline-tick').forEach(tick => {
      tick.addEventListener('click', event => {
        event.stopPropagation()
        video.currentTime = Number(tick.dataset.start) || 0
        play()
      })
    })
    paint()
    return {
      seekSection(id) {
        const seg = segments.find(item => item.id === id)
        if (seg) { video.currentTime = (seg.start || 0) + 0.05; play() }
        else if (p.sections?.find(s => s.id === id && s.clip) && !p.artifacts?.video) {
          video.src = fileUrl(threadId, 'clip', id)
          play()
        }
        shell.querySelectorAll('.sec-card').forEach(card => card.classList.toggle('is-on', card.dataset.sec === id))
      },
    }
  }

  function renderPlayer(player, p, threadId, activeId, signature) {
    const media = stageMedia(threadId, p, activeId)
    const same = player.dataset.sig === signature && player.dataset.media === media.kind + (media.section || '') + (media.src || '')
    if (same && qs(player, 'video, iframe, .film-waiting')) return player._ctl || null
    player.dataset.sig = signature
    player.dataset.media = media.kind + (media.section || '') + (media.src || '')
    if (media.kind === 'waiting' || !p) {
      player.innerHTML = waitingMarkup(p)
      player._ctl = null
      return null
    }
    if (media.kind === 'scene') {
      player.innerHTML = `<div class="player is-scene"><iframe title="段落画面预览" src="${esc(media.src)}" sandbox="allow-same-origin"></iframe><p class="player-caption">画面已生成，正在等待配音与渲染</p></div>`
      player._ctl = null
      return null
    }
    const segments = p.mapping?.segments || []
    const total = p.mapping?.duration || 0
    const ticks = segments.map(seg => {
      const left = total ? `${(seg.start / total) * 100}%` : '0%'
      return `<button type="button" class="timeline-tick" style="left:${left}" data-start="${seg.start || 0}" title="${esc(seg.title || seg.id)}"></button>`
    }).join('')
    const downloads = p.status === 'completed' ? `<p class="film-downloads">
      <a href="${fileUrl(threadId, 'video')}" download="final.mp4">下载成片</a>
      ${p.mode === 'agent' ? `<a href="${fileUrl(threadId, 'source')}" download="source.zip">下载源码</a>` : ''}
      <a href="${fileUrl(threadId, 'mapping')}" download="mapping.json">下载段落映射</a>
      ${p.source === 'external' ? `<a href="/bohack/api/file?threadId=${encodeURIComponent(threadId)}&path=outbox%2F%E5%88%B6%E4%BD%9C%E8%93%9D%E5%9B%BE.md" target="_blank" rel="noopener">制作蓝图</a><a href="/bohack/api/file?threadId=${encodeURIComponent(threadId)}&path=outbox%2F%E5%BD%92%E6%A1%A3%E9%AA%8C%E6%94%B5.md" target="_blank" rel="noopener">归档验收</a>` : ''}
    </p>` : ''
    player.innerHTML = `<div class="player">
      <video id="filmVideo" playsinline preload="metadata" src="${esc(media.src)}"></video>
      <p class="player-error" role="status"></p>
      <div class="player-bar">
        <button type="button" class="player-toggle" aria-label="播放" data-playing="0"></button>
        <div class="timeline" role="group" aria-label="播放进度">
          <div class="timeline-track" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="timeline-fill"></span></div>
          ${ticks}
        </div>
        <span class="player-time">0:00 / ${formatClock(total)}</span>
      </div>
    </div>${downloads}`
    if (p.previousJobId) {
      const previous = new URL(fileUrl(threadId, 'video'), location.origin); previous.searchParams.set('jobId', p.previousJobId)
      player.insertAdjacentHTML('beforeend', `<details><summary>对照上一版</summary><video controls preload="metadata" src="${esc(previous.pathname + previous.search)}"></video></details>`)
    }
    player._ctl = bindPlayer(player, p, threadId)
    return player._ctl
  }

  function render(s, env) {
    const root = document.getElementById('pane-film')
    if (!root) return
    const p = s.production
    const rail = document.getElementById('phaseRail')
    const line = document.getElementById('filmHeadline')
    const cards = document.getElementById('filmRail')
    const player = document.getElementById('filmPlayer')
    const waitMeta = document.getElementById('filmWaitMeta')
    const prep = document.getElementById('filmPrep')
    const filmBp = document.getElementById('filmBp')
    const filmState = document.getElementById('filmState')
    if (filmBp) filmBp.textContent = s.currentVersion ? `蓝图 v${s.currentVersion}（${(s.sections || []).length} 段）` : '—'
    if (filmState) {
      const done = s.finalized?.version === s.currentVersion && s.stage === 'finalized'
      const labels = { completed:'成片已出', running:p?.phase || '制作中', failed:'制作失败', interrupted:'制作中断', abandoned:'已放弃' }
      filmState.textContent = labels[p?.status] || (done ? '已定稿' : '未定稿')
    }
    renderPhases(rail, p)
    if (line) {
      const show = Boolean(p) && (p.status !== 'completed' || p.verify?.pass === false || p.membershipPending || p.membershipError)
      line.hidden = !show
      if (show) line.textContent = headline(p)
    }
    if (waitMeta) {
      const text = p?.status === 'running' ? elapsed(p.startedAt) : ''
      waitMeta.hidden = !text
      waitMeta.textContent = text
    }
    if (prep) prep.hidden = p?.status === 'running'
    root.classList.toggle('is-producing', p?.status === 'running' || p?.status === 'completed')
    root.classList.toggle('is-completed', p?.status === 'completed')
    const signature = JSON.stringify({
      id: p?.id, status: p?.status, phase: p?.phase, thread: env.threadId,
      artifacts: p?.artifacts, sections: (p?.sections || []).map(sec => [sec.id, sec.scene, sec.sceneKind, sec.audio, sec.clip]),
    })
    const ctl = renderPlayer(player, p, env.threadId, player._active, signature)
    renderCards(cards, p, id => {
      player._active = id
      if (ctl) ctl.seekSection(id)
      else render(s, env)
    }, player._active || p?.sections?.find(sec => !sec.clip)?.id || p?.sections?.[0]?.id)
  }

  return { render, headline, failureMessage, fileUrl, PHASES }
})()
