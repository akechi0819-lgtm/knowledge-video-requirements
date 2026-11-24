// Bound captions to two lines of at most 28 graphemes each. Inserted line breaks
// are presentation only; all original narration characters remain in order.
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const graphemes = text => Array.from(segmenter.segment(text), part => part.segment);
const LINE_LENGTH = 28;
const CUE_LENGTH = LINE_LENGTH * 2;

export function buildCaptionCues(subtitle, words = []) {
  const { text, start, end } = subtitle;
  if (typeof text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Caption requires text and a valid narration interval');
  }
  // Treat source line breaks as spaces so they cannot create extra display lines.
  const chars = graphemes(text.replace(/\r\n|\r|\n/g, ' '));
  if (!chars.length) return [];
  const chunks = [];
  for (let i = 0; i < chars.length; i += CUE_LENGTH) chunks.push(chars.slice(i, i + CUE_LENGTH));

  // Alignment is usable only when it covers the same text and every cue starts
  // at an actual word boundary. Otherwise sub-boundaries are estimates based on
  // the proportion of narration characters within the measured audio interval.
  const nonspace = value => graphemes(value).filter(c => !/^\s+$/u.test(c)).join('');
  const offsets = new Map();
  let wordText = '';
  let lastOffset = -1;
  let valid = Array.isArray(words) && words.length > 0;
  for (const word of valid ? words : []) {
    if (typeof word.text !== 'string' || !Number.isFinite(word.offset) || !Number.isFinite(word.duration) ||
        word.offset < 0 || word.duration < 0 || word.offset < lastOffset || word.offset + word.duration > end - start + 0.001) {
      valid = false;
      break;
    }
    offsets.set(graphemes(wordText).length, word.offset);
    wordText += nonspace(word.text);
    lastOffset = word.offset;
  }
  valid &&= wordText === nonspace(chars.join(''));
  const starts = [start];
  let count = 0;
  for (let i = 1; i < chunks.length; i++) {
    count += chunks[i - 1].length;
    const alignedIndex = graphemes(nonspace(chars.slice(0, count).join(''))).length;
    const offset = offsets.get(alignedIndex);
    if (offset === undefined || start + offset <= starts[i - 1] || start + offset >= end) valid = false;
    starts.push(start + offset);
  }
  if (!valid) {
    for (let i = 1; i < chunks.length; i++) starts[i] = start + (end - start) * (i * CUE_LENGTH / chars.length);
  }
  return chunks.map((chunk, i) => ({
    text: [chunk.slice(0, LINE_LENGTH).join(''), chunk.slice(LINE_LENGTH).join('')].filter(Boolean).join('\n'),
    start: starts[i],
    end: starts[i + 1] ?? end,
  }));
}
