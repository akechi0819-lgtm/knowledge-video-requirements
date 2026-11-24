// Monetary values are decimal strings until the final integer micro-CNY rounding.
export function readPricingConfig(env = process.env) {
  return {
    input: env.MEMBER_PRICE_INPUT_USD ?? '1.00',
    cacheRead: env.MEMBER_PRICE_CACHE_READ_USD ?? '0.05',
    cacheWrite: env.MEMBER_PRICE_CACHE_WRITE_USD ?? '1.25',
    output: env.MEMBER_PRICE_OUTPUT_USD ?? '5.00',
    relayRate: env.MEMBER_RELAY_RATE ?? '0.04',
    usdCny: env.MEMBER_USD_CNY ?? '7.25',
    inputIncludesCached: boolean(env.MEMBER_INPUT_INCLUDES_CACHED, true),
    longContext: boolean(env.MEMBER_LONG_CONTEXT_ENABLED, true),
    longContextThreshold: Number(env.MEMBER_LONG_CONTEXT_THRESHOLD ?? 272000),
  };
}

function boolean(value, fallback) {
  if (value == null) return fallback;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new Error('Invalid boolean configuration');
}

function decimal(value) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new Error(`Invalid nonnegative decimal: ${value}`);
  return [BigInt(match[1] + (match[2] ?? '')), 10n ** BigInt((match[2] ?? '').length)];
}

export function weeklyConfig(env = process.env) {
  const priceCents = Number(env.MEMBER_WEEKLY_PRICE_CENTS ?? 600);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error('Invalid weekly price');
  const [ratio, denominator] = decimal(env.MEMBER_CIRCUIT_RATIO ?? '0.85');
  if (ratio <= 0n || ratio > denominator) throw new Error('Invalid circuit ratio');
  const budget = BigInt(priceCents) * 100n * ratio / denominator;
  if (budget < 1n) throw new Error('Weekly budget is below one billing unit');
  if (budget > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Weekly budget exceeds safe integer');
  return { priceCents, budgetMicroCny: Number(budget) };
}

export function extractUsage(payload, opts = {}) {
  const raw = payload?.usage ?? payload?.response?.usage;
  if (!raw || typeof raw !== 'object') return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
  const read = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const write = raw.cache_creation_input_tokens ?? 0;
  if (![read, write].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const inputTokens = (opts.inputIncludesCached ?? true) ? Math.max(0, input - read - write) : input;
  return { inputTokens, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output,
    totalTokens: inputTokens + read + write + output, raw };
}

export function estimateUsage(requestBytes, responseBytes) {
  if (![requestBytes, responseBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid byte count');
  const inputTokens = Math.ceil(requestBytes / 3), outputTokens = Math.ceil(responseBytes / 3);
  return { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens,
    totalTokens: inputTokens + outputTokens, raw: null, estimated: true };
}

export function calculateCostMicroCny(usage, config = readPricingConfig()) {
  const counts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid usage');
  const long = config.longContext && counts[0] + counts[1] + counts[2] > config.longContextThreshold;
  const prices = [config.input, config.cacheRead, config.cacheWrite, config.output].map(decimal);
  const common = prices.reduce((a, [, d]) => a > d ? a : d, 1n);
  // Multipliers are represented in halves: input/cache 2x, output 1.5x.
  const weighted = counts.reduce((sum, count, i) => sum + BigInt(count) * prices[i][0] * (common / prices[i][1]) * BigInt(long ? (i === 3 ? 3 : 4) : 2), 0n);
  const [relay, relayDen] = decimal(config.relayRate), [currency, currencyDen] = decimal(config.usdCny);
  const numerator = weighted * relay * currency * 10000n;
  const denominator = common * 2n * 1000000n * relayDen * currencyDen;
  const cost = (numerator + denominator - 1n) / denominator;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Cost exceeds safe integer');
  return Number(cost || (counts.some(Boolean) ? 1n : 0n));
}
