import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionCues } from '../captions.mjs';

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const length = value => Array.from(segmenter.segment(value)).length;

test('preserves long narration in bounded lines and measured interval', () => {
  const text = '这是一个需要完整显示的字幕。'.repeat(9);
  const cues = buildCaptionCues({ text, start: 2, end: 14 });
  assert.equal(cues.map(cue => cue.text.replaceAll('\n', '')).join(''), text);
  assert.equal(cues[0].start, 2);
  assert.equal(cues.at(-1).end, 14);
  for (const [i, cue] of cues.entries()) {
    assert.ok(cue.text.split('\n').length <= 2);
    assert.ok(cue.text.split('\n').every(line => length(line) <= 28));
    assert.ok(cue.end > cue.start);
    if (i) assert.equal(cue.start, cues[i - 1].end);
  }
});

test('uses matching word offsets at cue boundaries', () => {
  const text = '甲'.repeat(56) + '乙'.repeat(20);
  const cues = buildCaptionCues({ text, start: 5, end: 15 }, [
    { text: '甲'.repeat(56), offset: 0, duration: 6 },
    { text: '乙'.repeat(20), offset: 6, duration: 4 },
  ]);
  assert.equal(cues[0].end, 11);
  assert.equal(cues[1].start, 11);
});

test('estimates boundaries when alignment does not cover narration', () => {
  const text = '甲'.repeat(56) + '乙'.repeat(56);
  const cues = buildCaptionCues({ text, start: 1, end: 9 }, [{ text: '甲', offset: 0, duration: 1 }]);
  assert.equal(cues[0].end, 5);
  assert.equal(cues[1].end, 9);
});
