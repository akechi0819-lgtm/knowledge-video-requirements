// These values are embedded into SVG attributes; exclude markup and CSS URLs.
const pathData = /^[MmLlHhVvCcQqSsTtAaZz0-9.eE,+\-\s]+$/
const color = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s]+\))$/i

export function safeShapes(shapes) {
  if (!Array.isArray(shapes)) return []
  return shapes.filter(s => s && typeof s.d === 'string' && /^\s*[Mm]\s*[-+\d.]/.test(s.d) && pathData.test(s.d) &&
    typeof s.fill === 'string' && color.test(s.fill) && typeof s.stroke === 'string' && color.test(s.stroke) &&
    Number.isFinite(s.width) && s.width >= 0).map(({d, fill, stroke, width}) => ({d, fill, stroke, width}))
}
