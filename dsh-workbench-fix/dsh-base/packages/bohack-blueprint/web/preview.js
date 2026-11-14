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
      const palette = { ink: '#49473e', red: '#aa5445', sand: '#c8b899', none: 'none' }
      const drawing = scene ? `<svg viewBox="0 0 400 220" role="img" aria-label="${escape(sec.title)}场景示意">${scene.shapes.map(shape => `<path d="${escape(shape.d)}" fill="${palette[shape.fill] || 'none'}" stroke="${palette[shape.stroke] || 'none'}" stroke-width="${Number(shape.width)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>` : '<span class="bpv-wait">场景示意生成中…</span>'
      const detail = excerpt(sec.intent || sec.narration || (sec.facts || []).join('；'), 75)
      return `<button type="button" class="bpv-card bpv-card-${position + 1}" data-preview-target="${escape(sec.id)}" aria-label="查看 ${escape(sec.id)} ${escape(sec.title)} 的完整内容">
        <span class="bpv-art"><span class="bpv-index">${escape(sec.id)}</span>${drawing}</span>
        <span class="bpv-body"><span class="bpv-kicker">第 ${index + 1} 段 / 共 ${sections.length} 段</span><strong>${escape(sec.title)}</strong><span class="bpv-detail">${escape(detail)}</span><span class="bpv-link">查看完整段落 →</span></span>
      </button>`
    }).join('')
    return `<section class="bpv" aria-label="章节画面预览"><style>
      .bpv{margin:0 0 24px;color:#302d28}.bpv-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}.bpv-heading h3{margin:0;font:500 20px/1.3 Georgia,'Songti SC',serif}.bpv-heading span{font:12px/1.5 sans-serif;color:#8b8070}.bpv-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.bpv-card{appearance:none;width:100%;min-width:0;text-align:left;padding:0;border:1px solid #d5cbbb;background:#fbf8f1;color:inherit;cursor:pointer;box-shadow:0 6px 20px #3327190d}.bpv-card:hover,.bpv-card:focus-visible{border-color:#a64b3b;outline:2px solid #a64b3b;outline-offset:2px}.bpv-art{height:175px;display:flex;position:relative;overflow:hidden;box-sizing:border-box;flex-direction:column;justify-content:center;padding:24px;background:radial-gradient(ellipse at 80% 25%,#eee8db 0,transparent 45%),linear-gradient(135deg,#e5ddce,#d4c7b3);border-bottom:1px solid #d5cbbb}.bpv-card-2 .bpv-art{background:radial-gradient(ellipse at 20% 80%,#ded4c2 0,transparent 50%),linear-gradient(145deg,#eae4d8,#c9c1b3)}.bpv-card-3 .bpv-art{background:radial-gradient(ellipse at 80% 80%,#e7dfcb 0,transparent 48%),linear-gradient(130deg,#d8d4c8,#bbc5be)}.bpv-art svg{position:absolute;inset:0;width:100%;height:100%;z-index:1}.bpv-wait{color:#8b8070;font:13px sans-serif}.bpv-art:after{content:'';position:absolute;width:135px;height:135px;right:-28px;bottom:-65px;border:1px solid #82796955;border-radius:50%;box-shadow:0 0 0 18px #8279690c,0 0 0 36px #8279690a}.bpv-index{position:absolute;top:12px;left:16px;color:#a34738;font:12px sans-serif;letter-spacing:.15em}.bpv-art-label{font:10px sans-serif;letter-spacing:.22em;color:#8c715c;margin-bottom:9px}.bpv-visual{position:relative;z-index:1;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font:500 16px/1.55 Georgia,'Songti SC',serif}.bpv-mark{position:absolute;right:13px;top:6px;color:#81766522;font:60px Georgia,serif}.bpv-body{display:flex;flex-direction:column;gap:7px;padding:15px 16px 16px}.bpv-kicker,.bpv-link{font:11px/1.5 sans-serif;letter-spacing:.08em;color:#a34738}.bpv-body strong{font:500 19px/1.35 Georgia,'Songti SC',serif}.bpv-detail{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#776e62;font:13px/1.6 sans-serif;min-height:2.6em}.bpv-link{margin-top:4px}
    </style><div class="bpv-heading"><h3>章节画面预览</h3><span>点击画面查看对应段落</span></div><div class="bpv-grid">${cards}</div></section>`
  }
  global.renderBlueprintPreview = renderBlueprintPreview
})(globalThis)
