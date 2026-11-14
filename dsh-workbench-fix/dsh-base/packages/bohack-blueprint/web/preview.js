/* 蓝图的内容摘览。实际画面以制作阶段为准。 */
(function (global) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const excerpt = (value, limit) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit) + '…' : text
  }
  function renderBlueprintPreview(sections, scenes) {
    if (!Array.isArray(sections) || !sections.length) return ''
    // 首、中央、末段提供全篇的起承收概览，同时保留原始顺序。
    const indexes = scenes ? scenes.map(scene => sections.findIndex(s => s.id === scene.id)).filter(i=>i>=0) : [...new Set([0, Math.floor((sections.length - 1) / 2), sections.length - 1])]
    const cards = indexes.map((index, position) => {
      const sec = sections[index]
      const scene = scenes?.find(item => item.id === sec.id)
      const palette = { ink: '#d5d0c6', red: '#e08a82', sand: '#8a8070', none: 'none' }
      const drawing = scene ? `<svg viewBox="0 0 400 220" role="img" aria-label="${escape(sec.title)}场景示意">${scene.shapes.map(shape => `<path d="${escape(shape.d)}" fill="${palette[shape.fill] || 'none'}" stroke="${palette[shape.stroke] || 'none'}" stroke-width="${Number(shape.width)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>` : '<span class="bpv-wait">场景示意生成中…</span>'
      const detail = excerpt(sec.intent || sec.narration || (sec.facts || []).join('；'), 75)
      return `<button type="button" class="bpv-card bpv-card-${position + 1}" data-preview-target="${escape(sec.id)}" aria-label="查看 ${escape(sec.id)} ${escape(sec.title)} 的完整内容">
        <span class="bpv-art"><span class="bpv-index">${escape(sec.id)}</span>${drawing}</span>
        <span class="bpv-body"><span class="bpv-kicker">第 ${index + 1} 段 / 共 ${sections.length} 段</span><strong>${escape(sec.title)}</strong><span class="bpv-detail">${escape(detail)}</span><span class="bpv-link">查看完整段落 →</span></span>
      </button>`
    }).join('')
    return `<section class="bpv" aria-label="章节画面预览"><style>
      .bpv{margin:0 0 24px;color:var(--ink,#eceef3)}.bpv-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}.bpv-heading h3{margin:0;font:500 20px/1.3 var(--serif,serif);color:var(--ivory,#ece7dc)}.bpv-heading span{font:12px/1.5 var(--sans,sans-serif);color:var(--faded,#7d8290)}.bpv-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.bpv-card{appearance:none;width:100%;min-width:0;text-align:left;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:22px;overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.28);transition:transform .4s cubic-bezier(0.16,1,0.3,1),box-shadow .4s cubic-bezier(0.16,1,0.3,1)}.bpv-card:hover,.bpv-card:focus-visible{transform:translateY(-6px) scale(1.03);box-shadow:0 22px 50px rgba(0,0,0,.45),0 0 0 1px rgba(236,231,220,.16);outline:none}.bpv-art{height:175px;display:flex;position:relative;overflow:hidden;box-sizing:border-box;flex-direction:column;justify-content:center;padding:24px;background:radial-gradient(ellipse at 80% 25%,rgba(143,164,212,.22) 0,transparent 45%),linear-gradient(135deg,#1a2238,#0c0e14)}.bpv-card-2 .bpv-art{background:radial-gradient(ellipse at 20% 80%,rgba(201,164,106,.14) 0,transparent 50%),linear-gradient(145deg,#161410,#0b0d13)}.bpv-card-3 .bpv-art{background:radial-gradient(ellipse at 80% 80%,rgba(126,168,184,.14) 0,transparent 48%),linear-gradient(130deg,#12161a,#0b0d13)}.bpv-art svg{position:absolute;inset:0;width:100%;height:100%;z-index:1}.bpv-wait{color:var(--faded,#7d8290);font:13px var(--sans,sans-serif)}.bpv-art:after{content:none;display:none}.bpv-index{position:absolute;top:12px;left:16px;color:var(--gold,#c9a46a);font:12px var(--sans,sans-serif);letter-spacing:0;z-index:2}.bpv-body{display:flex;flex-direction:column;gap:7px;padding:14px 16px 16px}.bpv-kicker,.bpv-link{font:11px/1.5 var(--sans,sans-serif);letter-spacing:0;color:var(--faded,#7d8290)}.bpv-body strong{font:500 16px/1.35 var(--serif,serif);color:var(--ivory,#ece7dc)}.bpv-detail{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--ink-soft,#b7bcc8);font:13px/1.6 var(--sans,sans-serif);min-height:2.6em}.bpv-link{margin-top:4px;color:var(--cobalt,#8fa4d4)}
    </style><div class="bpv-heading"><h3>章节画面预览</h3><span>点击画面查看对应段落</span></div><div class="bpv-grid">${cards}</div></section>`
  }
  global.renderBlueprintPreview = renderBlueprintPreview
})(globalThis)
