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

test('breaks the actual B03 and B06 narration at natural boundaries', () => {
  const narrations = [
    '只看一半对一半，好像跟猜硬币差不多。可让电子一个一个走向两条细缝，盯住屏幕同一个小圈：只开左缝有落点，只开右缝也有，两条缝一起开，这个小圈里反而几乎没点，整块屏排出了明暗条纹！这可不是像硬币那样早就偷偷选好了路，而是神奇的量子叠加。',
    '现实里为什么看不见大物体的干涉？因为空气和光线不停撞击系统，让干涉痕迹极快淡去，这叫退相干。但每次打开盒子，为什么偏偏只读到一个确定结果，至今仍是迷人的科学问题。记住，这只是脑海里的思想实验，用来带我们思考微观世界与现实的边界。',
  ];
  for (const text of narrations) {
    const cues = buildCaptionCues({ text, start: 2, end: 22 });
    assert.equal(cues.map(c => c.text.replaceAll('\n', '')).join(''), text);
    assert.equal(cues[0].start, 2);
    assert.equal(cues.at(-1).end, 22);
    let consumed = 0;
    for (const [i, cue] of cues.entries()) {
      const lines = cue.text.split('\n');
      assert.ok(lines.length <= 2 && lines.every(line => length(line) <= 28));
      assert.ok(!cue.text.startsWith('么偏偏') && !cue.text.startsWith('有，'));
      assert.ok(!cue.text.endsWith('量') && !cue.text.endsWith('为什'));
      assert.ok(lines.every(line => !line.endsWith('量') && !line.endsWith('为什')));
      assert.ok(cue.end > cue.start);
      if (i) assert.equal(cue.start, 2 + 20 * (consumed / length(text)));
      consumed += length(cue.text.replaceAll('\n', ''));
    }
  }
});

test('uses matching word offsets at natural page cuts', () => {
  const first = '这是第一句旁白，'.repeat(4);
  const last = '这是后面的句子。'.repeat(3);
  const text = first + last;
  const initial = buildCaptionCues({ text, start: 5, end: 15 });
  const cut = length(initial[0].text.replaceAll('\n', ''));
  const chars = Array.from(segmenter.segment(text), part => part.segment);
  const cues = buildCaptionCues({ text, start: 5, end: 15 }, [
    { text: chars.slice(0, cut).join(''), offset: 0, duration: 6 },
    { text: chars.slice(cut).join(''), offset: 6, duration: 4 },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 11);
  assert.equal(cues[1].start, 11);
});
