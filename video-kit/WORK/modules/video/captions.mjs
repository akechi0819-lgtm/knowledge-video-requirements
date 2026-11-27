// Bound captions to two lines of at most 28 graphemes each. Inserted line breaks
// are presentation only; all original narration characters remain in order.
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const graphemes = text => Array.from(segmenter.segment(text), part => part.segment);
const LINE_LENGTH = 28;
const punctuation = /[。！？；，、：,.!?;:]/u;

function splitLines(chars) {
  const lines = [];
  for (let pos = 0; pos < chars.length;) {
    const remaining = chars.length - pos;
    let size = Math.min(LINE_LENGTH, remaining);
    if (remaining > LINE_LENGTH) {
      const candidates = [];
      for (let i = 0; i < LINE_LENGTH; i++) {
        if (punctuation.test(chars[pos + i])) candidates.push(i + 1);
      }
      if (candidates.length) {
        // If possible, leave enough text for the next line rather than a
        // punctuation-delimited fragment of just one or two characters.
        size = candidates.filter(n => remaining - n >= 6).at(-1) ?? candidates.at(-1);
      }
    }
    lines.push(chars.slice(pos, pos + size));
    pos += size;
  }
  return lines;
}

export function buildCaptionCues(subtitle, words = []) {
  const { text, start, end } = subtitle;
  if (typeof text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Caption requires text and a valid narration interval');
  }
  // Treat source line breaks as spaces so they cannot create extra display lines.
  const chars = graphemes(text.replace(/\r\n|\r|\n/g, ' '));
  if (!chars.length) return [];
  const lines = splitLines(chars);
  const chunks = [];
  for (let i = 0; i < lines.length;) {
    // Move a whole line to the last page if pairing it here would leave a
    // tiny final page. Unpunctuated text retains its existing fixed cuts.
    const leaveLine = lines.length - i === 3 && lines[i + 2].length < 6 &&
      punctuation.test(lines[i].at(-1));
    const count = leaveLine ? 1 : 2;
    chunks.push(lines.slice(i, i + count));
    i += count;
  }

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
    count += chunks[i - 1].reduce((sum, line) => sum + line.length, 0);
    const alignedIndex = graphemes(nonspace(chars.slice(0, count).join(''))).length;
    const offset = offsets.get(alignedIndex);
    if (offset === undefined || start + offset <= starts[i - 1] || start + offset >= end) valid = false;
    starts.push(start + offset);
  }
  if (!valid) {
    let count = 0;
    for (let i = 1; i < chunks.length; i++) {
      count += chunks[i - 1].reduce((sum, line) => sum + line.length, 0);
      starts[i] = start + (end - start) * (count / chars.length);
    }
  }
  return chunks.map((chunk, i) => ({
    text: chunk.map(line => line.join('')).join('\n'),
    start: starts[i],
    end: starts[i + 1] ?? end,
  }));
}
