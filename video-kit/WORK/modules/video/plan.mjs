// Turns blueprint segments + measured TTS word timings into per-segment scene plans.
// This is where the video module exercises `video_module_decides`: the blueprint
// states intent, never animation, so all cue timing is derived here from real audio.

import STYLE from './style.mjs';

const T = STYLE.timing;

// Scene kind is resolved from blueprint wording, not from segment ids, so a
// reworked blueprint that reorders segments still maps correctly.
export function resolveKind(seg) {
  const text = `${seg.visual_intent ?? ''} ${seg.content ?? ''}`;
  // Hotpot states are tested first: S1's content quotes the question "如果没有美洲",
  // so a bare 美洲 match would wrongly turn the opening into a map scene.
  // Return precedes vanish because S4's intent says "与 S2 的消失形成对照".
  if (/回归|重新出现|回到火锅/.test(text)) return 'hotpot_return';
  if (/消失|拿走|去掉/.test(text)) return 'hotpot_vanish';
  if (/地图|示意画面|传播|跨洲交流/.test(text)) return 'map';
  return 'hotpot_intro';
}

const INGREDIENTS = [
  { key: 'chili', word: '辣椒', label: '辣椒' },
  { key: 'potato', word: '土豆', label: '土豆' },
  { key: 'tomato', word: '番茄', label: '番茄' },
];

function wordAt(words, target) {
  const hit = words.find((w) => w.text === target)
    ?? words.find((w) => w.text.includes(target))
    ?? words.find((w) => target.includes(w.text) && w.text.length >= 2);
  return hit ?? null;
}

function requireWord(words, target, sid) {
  const w = wordAt(words, target);
  if (!w) throw new Error(`[${sid}] narration word "${target}" not found in TTS word boundaries; cannot sync visuals`);
  return w;
}

export function buildPlan(seg, tts) {
  const kind = resolveKind(seg);
  const words = tts.words ?? [];
  if (!words.length) throw new Error(`[${seg.id}] no TTS word boundaries; refusing to guess cue timing`);

  const audioStart = T.leadIn;
  const audioDur = tts.duration;
  const abs = (w) => audioStart + w.offset;

  let duration = audioStart + audioDur + T.tailPad;
  const plan = {
    id: seg.id,
    kind: kind.startsWith('hotpot') ? 'hotpot' : 'map',
    role: kind,
    segmentTag: `${seg.id}｜${seg.title}`,
    duration: 0,
    audioStart,
    audioDuration: audioDur,
    subtitle: { text: seg.narration, start: audioStart, end: audioStart + audioDur },
    ingredientLabels: Object.fromEntries(INGREDIENTS.map((i) => [i.key, i.label])),
  };

  if (kind === 'hotpot_intro') {
    duration += T.s1GuessPause;
    plan.ingredients = Object.fromEntries(INGREDIENTS.map((i) => [i.key, {
      init: 0,
      cues: [{ t: 0.05, v: 1, dur: 0.5 }],
    }]));
    // Guess beat (R08): ring each ingredient in turn while the question hangs,
    // so the hold is never a static picture (skill premium rule: still ≤3s).
    plan.guessPulses = INGREDIENTS.map((ing, i) => ({ key: ing.key, t: 0.9 + i * 0.8, dur: 0.7 }));
  } else if (kind === 'hotpot_vanish') {
    // Light up + name each ingredient as it is spoken (R09), then remove them in
    // the same order during "先从桌上消失". Other food is never touched.
    const vanishWord = wordAt(words, '消失') ?? words[words.length - 1];
    const vanishBase = abs(vanishWord) - 0.42;
    plan.ingredients = {};
    const specifiedOrder = seg.visual_intent?.match(/(辣椒|土豆|番茄)\s*→\s*(辣椒|土豆|番茄)\s*→\s*(辣椒|土豆|番茄)/u)?.slice(1);
    const order = new Set(specifiedOrder).size === INGREDIENTS.length
      ? specifiedOrder.map((name) => INGREDIENTS.find((ingredient) => ingredient.word === name))
      : INGREDIENTS;
    order.forEach((ing, i) => {
      const w = requireWord(words, ing.word, seg.id);
      const hlStart = Math.max(0.02, abs(w) - T.highlightLead);
      const vanishAt = vanishBase + i * T.vanishStagger;
      plan.ingredients[ing.key] = {
        init: 1,
        cues: [{ t: vanishAt, v: 0, dur: T.vanishDur }],
        label: { t: hlStart, until: vanishAt + 0.1 },
      };
    });
    const lastGone = vanishBase + 2 * T.vanishStagger + T.vanishDur;
    if (lastGone > duration - 0.15) duration = lastGone + 0.35;
  } else if (kind === 'hotpot_return') {
    duration += T.s4ClosingHold;
    const first = words[0];
    const base = abs(first);
    plan.ingredients = {};
    INGREDIENTS.forEach((ing, i) => {
      plan.ingredients[ing.key] = {
        init: 0,
        cues: [{ t: base + i * T.returnStagger, v: 1, dur: T.returnDur }],
      };
    });
    plan.closing = { start: audioStart + audioDur + 0.22 };
    plan.subtitle.end = audioStart + audioDur;
  } else if (kind === 'map') {
    const am = requireWord(words, '美洲', seg.id);
    const spreadWord = wordAt(words, '跨') ?? wordAt(words, '交流') ?? words[words.length - 1];
    plan.americasHighlight = { t: Math.max(0.05, abs(am) - T.highlightLead) };
    plan.spread = {
      t: abs(spreadWord),
      stagger: 0.26,
      dur: Math.max(0.7, duration - abs(spreadWord) - 0.45),
    };
    plan.caption = { text: '概念示意 · 非精确路线与传入时间', t: plan.americasHighlight.t + 0.3 };
    plan.ingredients = {};
    // Explicit arrows in the blueprint (e.g. 美洲→欧洲、美洲→亚洲) override the
    // default schematic targets; names are resolved against the scene's table.
    const names = [...seg.visual_intent.matchAll(/美洲→([一-龥]{2,6})/g)].map((m) => m[1]);
    if (names.length) {
      plan.targetNames = names;
      plan.spread.dur = Math.min(plan.spread.dur, 2.7);
    }
  } else {
    throw new Error(`[${seg.id}] unresolved scene kind: ${kind}`);
  }

  plan.duration = Number(duration.toFixed(4));
  plan.frames = Math.max(1, Math.round(plan.duration * STYLE.video.fps));
  // Snap duration to a whole frame count so video and audio stay aligned.
  plan.duration = Number((plan.frames / STYLE.video.fps).toFixed(6));
  return plan;
}
