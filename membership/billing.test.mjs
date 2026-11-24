import test from 'node:test';
import assert from 'node:assert/strict';
import { readPricingConfig, weeklyConfig, extractUsage, estimateUsage, calculateCostMicroCny } from './billing.mjs';

test('normalizes chat and responses usage without counting cached input twice', () => {
  const chat = { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, cache_creation_input_tokens: 10 } };
  const expected = { inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20, totalTokens: 120, raw: chat.usage };
  assert.deepEqual(extractUsage(chat), expected);
  assert.deepEqual(extractUsage({ response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, cache_creation_input_tokens: 10 } } }), { ...expected, raw: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, cache_creation_input_tokens: 10 } });
  assert.equal(extractUsage(chat, { inputIncludesCached: false }).inputTokens, 100);
  assert.equal(extractUsage({ usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 } }).inputTokens, 0);
  assert.equal(extractUsage({ usage: { total_tokens: 7 } }), null);
  assert.equal(extractUsage({ choices: [] }), null);
});

test('estimates missing usage from bytes', () => {
  assert.deepEqual(estimateUsage(7, 4), { inputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, totalTokens: 5, raw: null, estimated: true });
});

test('recognizes DeepSeek cache hits while preferring standard cached tokens', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 };
  assert.equal(extractUsage({ usage }).cacheReadTokens, 60);
  assert.equal(extractUsage({ usage }).inputTokens, 40);
  assert.equal(extractUsage({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 30 } } }).cacheReadTokens, 30);
});

test('uses exact decimal arithmetic, long context tiers, and a per-call ceiling', () => {
  const config = readPricingConfig({});
  const usage = { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 3000, outputTokens: 4000 };
  assert.equal(calculateCostMicroCny(usage, config), 73);
  assert.equal(calculateCostMicroCny({ inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, config), 1);
  assert.equal(calculateCostMicroCny({ inputTokens: 272000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, config), 789);
  assert.equal(calculateCostMicroCny({ inputTokens: 272001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, config), 1578);
  assert.equal(calculateCostMicroCny({ inputTokens: 272001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, { ...config, longContext: false }), 789);
  assert.deepEqual(weeklyConfig({}), { priceCents: 600, budgetMicroCny: 51000 });
  assert.deepEqual(weeklyConfig({ MEMBER_WEEKLY_PRICE_CENTS: '999', MEMBER_CIRCUIT_RATIO: '0.333' }), { priceCents: 999, budgetMicroCny: 33266 });
});

test('Phase 4 measured 3.78M tokens cost about 0.13 yuan with per-request rounding', () => {
  // Numeric usage from 68 assistant/message rows across the Phase 4 audit's
  // blueprint, asset and production sessions. Streaming usage duplicates are excluded.
  const measured = [
    [3, 0, 5890, 60], [3, 5890, 455, 1063], [3, 6345, 1261, 138], [3, 0, 6093, 31],
    [3, 6093, 4821, 30], [3, 10914, 4672, 107], [3, 15586, 135, 149], [3, 15721, 21274, 173],
    [3, 36995, 188, 146], [3, 37183, 233, 140], [3, 37416, 168, 347], [3, 37584, 370, 333],
    [3, 37954, 356, 374], [3, 38310, 386, 701], [3, 38696, 734, 683], [3, 39430, 716, 38],
    [3, 40146, 56, 25], [3, 40202, 53, 39], [3, 40255, 56, 40], [3, 40311, 67, 457],
    [3, 40378, 760, 2147], [3, 41138, 2308, 261], [3, 43446, 482, 76], [3, 43928, 104, 54],
    [3, 44032, 1093, 413], [3, 0, 6306, 21], [3, 6306, 4809, 177], [3, 11115, 20447, 135],
    [3, 31562, 163, 217], [3, 31725, 272, 208], [3, 31997, 14022, 192], [3, 46019, 9791, 990],
    [3, 55810, 1027, 930], [3, 56837, 1091, 96], [3, 57928, 124, 143], [3, 58052, 161, 86],
    [3, 58213, 751, 117], [3, 58964, 1369, 78], [3, 60333, 308, 452], [3, 60641, 507, 41],
    [3, 61148, 3117, 2072], [3, 64265, 2230, 142], [3, 66495, 170, 92], [3, 66665, 179, 24],
    [3, 66844, 3919, 302], [3, 70763, 315, 34], [3, 71078, 121, 33], [3, 71199, 1470, 688],
    [3, 72669, 920, 60], [3, 73589, 166, 109], [3, 73755, 210, 96], [3, 73965, 7532, 592],
    [3, 81497, 753, 121], [3, 82250, 147, 28], [3, 82397, 2683, 75], [3, 85080, 101, 68],
    [3, 85181, 2727, 296], [3, 87908, 408, 459], [3, 88316, 620, 109], [3, 88936, 135, 28],
    [3, 89071, 2687, 61], [3, 91758, 87, 250], [3, 91845, 338, 40], [3, 92183, 152, 124],
    [3, 92335, 343, 206], [3, 92678, 234, 110], [3, 92912, 124, 25], [3, 93036, 2106, 13],
  ];
  const config = readPricingConfig({});
  assert.equal(measured.length, 68);
  assert.deepEqual(measured.reduce((total, row) => total.map((sum, i) => sum + row[i]), [0, 0, 0, 0]),
    [204, 3613273, 147873, 18165]);
  const cost = measured.reduce((total, [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens]) =>
    total + calculateCostMicroCny({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }, config), 0);
  assert.equal(cost, 1356);
});
