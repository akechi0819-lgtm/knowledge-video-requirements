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
    const cards = indexes.map(index => {
      const sec = sections[index]
      const scene = scenes?.find(item => item.id === sec.id)
      const palette = { ink: '#d5d0c6', red: '#e08a82', sand: '#8a8070', none: 'none' }
      const drawing = scene ? `<svg viewBox="0 0 400 220" role="img" aria-label="${escape(sec.title)}场景示意">${scene.shapes.map(shape => `<path d="${escape(shape.d)}" fill="${escape(palette[shape.fill] || shape.fill)}" stroke="${escape(palette[shape.stroke] || shape.stroke)}" stroke-width="${Number(shape.width)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>` : '<span class="bpv-wait">场景示意生成中…</span>'
      const detail = excerpt(sec.intent || sec.narration || (sec.facts || []).join('；'), 75)
      return `<button type="button" class="bpv-card" data-preview-target="${escape(sec.id)}" aria-label="查看 ${escape(sec.id)} ${escape(sec.title)} 的完整内容">
        <span class="bpv-art"><span class="bpv-index">${escape(sec.id)}</span>${drawing}</span>
        <span class="bpv-body"><strong>${escape(sec.title)}</strong><span class="bpv-detail">${escape(detail)}</span><span class="bpv-link">查看段落<svg class="icon" aria-hidden="true"><use href="#icon-arrow"/></svg></span></span>
      </button>`
    }).join('')
    return `<section class="bpv" aria-label="章节画面预览"><div class="bpv-heading"><h3>章节画面预览</h3><span>点击画面查看对应段落</span></div><div class="bpv-grid">${cards}</div></section>`
  }
  global.renderBlueprintPreview = renderBlueprintPreview
})(globalThis)
