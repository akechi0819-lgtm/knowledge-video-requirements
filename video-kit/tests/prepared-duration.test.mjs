import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparedFrames } from '../WORK/modules/video/pipeline.mjs';

test('distributes extra time before the final reveal', () => {
  const frames = preparedFrames([3, 4], 20, 30, 0.3, 0.5);
  assert.equal(frames.reduce((a, b) => a + b), 600);
  assert.equal(frames[1], Math.ceil((0.3 + 4 + 0.5) * 30));
});

test('long narration is never truncated to the requested time', () => {
  const frames = preparedFrames([12, 10], 20, 30, 0.3, 0.5);
  assert.ok(frames[0] / 30 >= 12.8);
  assert.ok(frames[1] / 30 >= 10.8);
  assert.ok(frames.reduce((a, b) => a + b) / 30 > 20);
});
