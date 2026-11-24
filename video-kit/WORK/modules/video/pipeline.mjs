// Blueprint -> full film pipeline.
//   node WORK/modules/video/pipeline.mjs <blueprint.json> [--out <dir>] [--voice <voice>] [--force-tts] [--allow-unconfirmed]
//
// Every segment is rendered to its own clip, then concatenated. mapping.json
// boundaries use the managed host's frame timeline or measured legacy clip durations.
// Any segment failure aborts before final.mp4 is written.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import STYLE, { WORK_DIR, MODULE_DIR } from './style.mjs';
import { concatClips, probeDuration } from './ffmpeg.mjs';
import { buildPlan } from './plan.mjs';
import { renderSegment } from './render.mjs';

const run = promisify(execFile);

function parseArgs(argv) {
  const args = { blueprint: null, out: null, voice: STYLE.tts.voice, forceTts: false, allowUnconfirmed: false, prepared: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prepared') args.prepared = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timings') args.timings = argv[++i];
    else if (a === '--voice') {
      args.voice = argv[++i];
      if (!args.voice || args.voice.startsWith('--')) throw new Error('--voice requires a voice name or sapi');
    }
    else if (a === '--force-tts') args.forceTts = true;
    else if (a === '--allow-unconfirmed') args.allowUnconfirmed = true;
    else rest.push(a);
  }
  args.blueprint = rest[0];
  if (!args.blueprint) throw new Error('usage: pipeline.mjs <blueprint.json> [--out dir] [--voice <voice>] [--force-tts] [--allow-unconfirmed]');
  return args;
}

// CONTRACT §7: the video module may only accept a blueprint that parses clean
// AND is deliverable. The gate is enforced here, not assumed.
async function enforceGate(bpPath, allowUnconfirmed) {
  const script = path.join(WORK_DIR, 'tools', 'blueprint.mjs');
  let stdout, code = 0;
  try {
    const r = await run(process.execPath, [script, 'parse', bpPath, '--json'], { maxBuffer: 32 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    code = e.code ?? 1;
    stdout = e.stdout ?? '';
    throw new Error(`blueprint parse failed (exit ${code}): ${(e.stderr || '').slice(0, 800)}`);
  }
  const jsonStart = stdout.indexOf('{');
  const summary = JSON.parse(stdout.slice(jsonStart));
  if (!summary.valid) throw new Error('blueprint schema validation failed; returning to blueprint task');
  if (!summary.deliverable_to_video) {
    const msg = `blueprint not deliverable: confirmation_status=${summary.confirmation_status}, blocking_gaps=${summary.blocking_gaps.length}`;
    if (!allowUnconfirmed) throw new Error(`${msg}\nCONTRACT §7 gate refused. Creator must confirm via the blueprint module.`);
    console.warn(`[WARN] ${msg} -- proceeding as ENGINEERING PREVIEW, not an official delivery`);
  }
  return { summary, gatePassed: summary.deliverable_to_video, preview: !summary.deliverable_to_video };
}

export function seedTtsCache(segments, source, audioDir, { skipMissing = false, preserveExisting = false } = {}) {
  fs.mkdirSync(audioDir, { recursive: true });
  for (const seg of segments) {
    const localMetadata = path.join(audioDir, `${seg.id}.json`);
    const localAudio = path.join(audioDir, `${seg.id}.mp3`);
    if (preserveExisting && fs.existsSync(localMetadata) && fs.existsSync(localAudio)) continue;
    const metadata = path.join(source, `${seg.id}.json`);
    const mp3 = path.join(source, `${seg.id}.mp3`);
    if (skipMissing && (!fs.existsSync(metadata) || !fs.existsSync(mp3))) continue;
    const cache = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    fs.rmSync(localMetadata, { force: true });
    fs.copyFileSync(mp3, localAudio);
    const pending = localMetadata + '.tmp';
    fs.writeFileSync(pending, JSON.stringify({ ...cache, audio: localAudio }));
    fs.renameSync(pending, localMetadata);
  }
}

async function synthesizeNarration(bpPath, audioDir, voice, force) {
  fs.mkdirSync(audioDir, { recursive: true });
  const outJson = path.join(audioDir, 'tts-result.json');
  const args = [
    path.join(MODULE_DIR, 'tts_driver.py'), bpPath, audioDir,
    voice, STYLE.tts.rate, STYLE.paths.ffprobe, outJson,
  ];
  if (force) args.push('--force');
  const t0 = Date.now();
  const { stdout } = await run(STYLE.paths.python, args, {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const info = JSON.parse(stdout.trim().split('\n').pop());
  const payload = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  return { payload, ms: Date.now() - t0, info };
}

function fmtSec(x) { return Number(x.toFixed(3)); }

// Preserve every measured narration and distribute extra frames before the
// final segment, so a short reveal is not followed by a long closing hold.
export function preparedFrames(durations, targetSeconds, fps, lead, tail) {
  const frames = durations.map(d => Math.max(1, Math.ceil((lead + d + tail) * fps)));
  if (targetSeconds == null) return frames;
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error('目标时长必须是正数');
  let extra = Math.max(0, Math.round(targetSeconds * fps) - frames.reduce((a, b) => a + b, 0));
  const count = durations.length > 1 ? durations.length - 1 : 1;
  const weight = durations.slice(0, count).reduce((a, b) => a + b, 0);
  let allocated = 0;
  for (let i = 0; i < count; i++) {
    const end = i === count - 1 ? extra : Math.round(extra * durations.slice(0, i + 1).reduce((a, b) => a + b, 0) / weight);
    frames[i] += end - allocated;
    allocated = end;
  }
  return frames;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bpPath = path.resolve(args.blueprint);
  if (!fs.existsSync(bpPath)) throw new Error(`blueprint not found: ${bpPath}`);
  const input = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
  if (args.timings && !args.prepared) throw new Error('--timings requires --prepared');
  const timing = args.timings && JSON.parse(fs.readFileSync(args.timings, 'utf8'));
  if (timing && (timing.fps !== STYLE.video.fps || timing.beats?.length !== input.sections?.length)) throw new Error('宿主时间轴与制作单不一致');
  let bp = input;
  let gate;
  if (args.prepared) {
    if (args.allowUnconfirmed) throw new Error('--allow-unconfirmed is not supported with --prepared');
    if (input.status !== '准备制作') throw new Error('准备单状态不是“准备制作”，请先在蓝图模块完成确认并导出');
    if (!args.out) throw new Error('--prepared requires an explicit --out directory');
    if (!Array.isArray(input.sections) || !input.sections.length) throw new Error('准备单没有段落');
    const ids = new Set();
    const blueprintIds = new Set();
    const segments = input.sections.map((s, i) => {
      const label = `${s.id || `第 ${i + 1} 段`}${s.blueprintId ? ` / ${s.blueprintId}` : ''}`;
      if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id) || ids.has(s.id)) throw new Error(`[${label}] 段号无效或重复`);
      ids.add(s.id);
      if (typeof s.blueprintId !== 'string' || !/^B[0-9]{2}[a-z]?$/.test(s.blueprintId) || blueprintIds.has(s.blueprintId)) throw new Error(`[${label}] 蓝图 B 段号无效或重复`);
      blueprintIds.add(s.blueprintId);
      if (typeof s.narration !== 'string' || !s.narration.trim()) throw new Error(`[${label}] 缺少已确认旁白，请回蓝图模块补充并确认`);
      if (typeof s.scene !== 'string' || !s.scene.trim()) throw new Error(`[${label}] 缺少场景 HTML`);
      const scenePath = path.resolve(path.dirname(bpPath), s.scene);
      if (!fs.existsSync(scenePath) || !fs.statSync(scenePath).isFile()) throw new Error(`[${label}] 场景 HTML 不存在: ${scenePath}`);
      return { id: s.id, blueprintId: s.blueprintId, title: s.title, narration: s.narration, scenePath };
    });
    bp = { title: input.topic, case_id: input.topic, blueprint_id: input.version, version: input.version, targetDurationSeconds: input.targetDurationSeconds, segments };
    gate = { summary: { confirmation_status: input.status }, gatePassed: null, preview: false, prepared: true };
  } else {
    if (args.voice.startsWith('api:') || args.voice.startsWith('say:')) throw new Error('api: and say: voices require --prepared; the original scene requires word timings');
    gate = await enforceGate(bpPath, args.allowUnconfirmed);
  }

  const runStart = Date.now();

  const outDir = path.resolve(args.out ?? path.join(WORK_DIR, 'videos', bp.case_id, `v${bp.version}`));
  if (gate.preview && !args.out) throw new Error('refusing to write an unconfirmed blueprint into the official v目录; pass --out explicitly');
  const resume = args.prepared && process.env.VIDEO_RESUME === '1';
  if (args.prepared && !resume && fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`output directory is not empty: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  const audioDir = path.join(outDir, 'audio');
  if (args.prepared && process.env.VIDEO_TTS_CACHE_DIR) seedTtsCache(bp.segments, process.env.VIDEO_TTS_CACHE_DIR, audioDir, { skipMissing: resume, preserveExisting: resume });

  console.log(`[gate] ${bp.blueprint_id} deliverable=${gate.gatePassed} preview=${gate.preview}`);
  console.log(`[out ] ${outDir}`);

  let ttsInput = bpPath;
  if (args.prepared) {
    ttsInput = path.join(outDir, 'tts-input.json');
    fs.writeFileSync(ttsInput, JSON.stringify({ blueprint_id: bp.blueprint_id, segments: bp.segments }, null, 2), 'utf8');
  }
  const tts = await synthesizeNarration(ttsInput, audioDir, args.voice, args.forceTts);
  console.log(`[tts ] ${tts.payload.segments.length} segments, ${tts.payload.total_audio_seconds}s audio, ${tts.ms}ms`);

  const byId = new Map(tts.payload.segments.map((s) => [s.id, s]));
  const preparedDurations = args.prepared ? bp.segments.map(seg => {
    const t = byId.get(seg.id);
    if (!t) throw new Error(`[${seg.id}] missing TTS result`);
    return t.duration;
  }) : null;
  const frameCounts = args.prepared ? preparedFrames(preparedDurations, bp.targetDurationSeconds, STYLE.video.fps, STYLE.timing.leadIn, STYLE.timing.tailPad) : null;
  const plans = bp.segments.map((seg, i) => {
    const t = byId.get(seg.id);
    if (!t) throw new Error(`[${seg.id}] missing TTS result`);
    if (!args.prepared) return buildPlan(seg, t);
    if (timing) {
      const plan = timing.beats[i];
      const creditFrames = Math.ceil((plan.credits?.at(-1)?.end ?? 0) * STYLE.video.fps);
      const expectedFrames = Math.max(creditFrames, frameCounts[i]);
      if (plan.id !== seg.id || plan.beatId !== seg.blueprintId || plan.frames !== expectedFrames || plan.audioDuration !== t.duration) {
        throw new Error(`[${seg.id}] 配音时长或段号与宿主时间轴不一致`);
      }
      return { ...plan, scenePath: seg.scenePath };
    }
    const audioStart = STYLE.timing.leadIn;
    const frames = frameCounts[i];
    return { id: seg.id, role: 'prepared_html', scenePath: seg.scenePath, duration: frames / STYLE.video.fps,
      frames, audioStart, audioDuration: t.duration, words: t.words || [],
      subtitle: { text: seg.narration, start: audioStart, end: audioStart + t.duration } };

  });
  fs.writeFileSync(path.join(outDir, 'plans.json'), JSON.stringify(plans, null, 2), 'utf8');

  // ---- per-segment render, fail-fast ----
  const rendered = [];
  for (const plan of plans) {
    const t0 = Date.now();
    console.log(`[seg ] ${plan.id} ${plan.role} planned=${plan.duration}s frames=${plan.frames}`);
    const audioFile = byId.get(plan.id).audio;
    let r;
    try {
      r = await renderSegment(plan, audioFile, outDir);
    } catch (e) {
      throw new Error(`segment ${plan.id} failed: ${e.message}\nABORTED before concat; no final.mp4 produced.`);
    }
    const drift = Math.abs(r.measuredDuration - plan.duration);
    if (drift > 0.12) {
      console.warn(`[WARN] segment ${plan.id} duration drift ${drift.toFixed(3)}s (measured ${r.measuredDuration} vs planned ${plan.duration})`);
    }
    rendered.push({ plan, ...r, totalMs: Date.now() - t0 });
    console.log(`[ok  ] ${plan.id} measured=${r.measuredDuration}s capture=${r.captureMs}ms encode=${r.encodeMs}ms`);
  }

  // ---- concat ----
  const finalPath = path.join(outDir, 'final.mp4');
  const concat0 = Date.now();
  const finalDuration = await concatClips(rendered.map((r) => r.clip), finalPath, timing ? plans.map(plan => plan.duration) : undefined);
  const concatMs = Date.now() - concat0;
  console.log(`[concat] ${finalPath} ${finalDuration}s in ${concatMs}ms`);

  // ---- map compiled intervals and renderer observations after concat ----
  let cursor = 0;
  const segments = rendered.map((r) => {
    const start = timing ? r.plan.start : cursor;
    const end = timing ? r.plan.end : cursor + r.measuredDuration;
    cursor = end;
    return {
      id: r.plan.id,
      ...(args.prepared ? { blueprint_id: bp.segments.find((s) => s.id === r.plan.id).blueprintId } : {}),
      title: bp.segments.find((s) => s.id === r.plan.id).title,
      clip: path.relative(outDir, r.clip).replace(/\\/g, '/'),
      ...(!timing && { clip_absolute: r.clip }),
      start_sec: fmtSec(start),
      end_sec: fmtSec(end),
      duration_sec: fmtSec(end - start),
      ...(timing && { samples: r.samples }),
      narration: bp.segments.find((s) => s.id === r.plan.id).narration,
      narration_audio: path.relative(outDir, byId.get(r.plan.id).audio).replace(/\\/g, '/'),
      narration_audio_seconds: byId.get(r.plan.id).duration,
      scene_role: r.plan.role,
      frames: r.frames,
    };
  });
  const measuredSum = rendered.reduce((sum, clip) => sum + clip.measuredDuration, 0);
  const residual = Math.abs(cursor - finalDuration);
  if (residual > 0.25) {
    console.warn(`[WARN] concat duration mismatch: timeline end ${cursor.toFixed(3)}s vs final ${finalDuration.toFixed(3)}s; mapping needs review`);
  }

  const mapping = {
    schema: 'video.mapping.v1',
    case_id: bp.case_id,
    blueprint_id: bp.blueprint_id,
    blueprint_file: path.relative(WORK_DIR, bpPath).replace(/\\/g, '/'),
    final_video: path.relative(outDir, finalPath).replace(/\\/g, '/'),
    ...(!timing && { final_video_absolute: finalPath }),
    final_duration_sec: fmtSec(finalDuration),
    ...(args.prepared && bp.targetDurationSeconds != null ? { target_duration_sec: bp.targetDurationSeconds, target_exceeded: finalDuration > bp.targetDurationSeconds + 1 / STYLE.video.fps } : {}),
    duration_source: timing ? 'host timings and rendered shot observations' : 'ffprobe measured clip durations accumulated after concat',
    clip_sum_sec: fmtSec(measuredSum),
    concat_residual_sec: fmtSec(residual),
    fps: STYLE.video.fps,
    resolution: `${STYLE.video.width}x${STYLE.video.height}`,
    gate: gate.prepared ? { source: 'prepared manifest', status: gate.summary.confirmation_status } : { deliverable_to_video: gate.gatePassed, confirmation_status: gate.summary.confirmation_status, preview: gate.preview },
    segments,
  };
  fs.writeFileSync(path.join(outDir, 'mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');
  if (timing) writeStillPreview(outDir, segments);

  // ---- vibe-knowledge 基础档：强制 BGM 混音 + 成片质检 ----
  const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const fin0 = Date.now();
  const { stdout: finOut } = await run(STYLE.paths.python, [
    path.join(MODULE_DIR, 'finish_bgm.py'), outDir, STYLE.paths.ffmpeg, STYLE.paths.ffprobe,
    ...(tts.payload.backend === 'sapi' ? ['--compress-narration'] : []),
  ], { maxBuffer: 32 * 1024 * 1024, env: pyEnv });
  const bgmInfo = JSON.parse(finOut.trim().split('\n').pop());
  console.log(`[bgm ] ${finOut.trim().split('\n').pop()} (${Date.now() - fin0}ms)`);
  const qa0 = Date.now();
  let qaOut;
  try {
    const lastBeat = timing?.beats.at(-1);
    const firstCredit = lastBeat?.credits?.[0];
    qaOut = (await run(STYLE.paths.python, [
      path.join(MODULE_DIR, 'qa_windows.py'), finalPath, STYLE.paths.ffmpeg, STYLE.paths.ffprobe,
      ...(firstCredit ? ['--freeze-end', String(lastBeat.start + firstCredit.start)] : []),
    ], { maxBuffer: 32 * 1024 * 1024, env: pyEnv })).stdout;
  } catch (e) {
    qaOut = `质检未完成 (exit ${e.code}): ${(e.stdout || '') + (e.stderr || '')}`;
  }
  const qualityNotes = qaOut.split('\n').filter(line => line.startsWith('⚠') || line.startsWith('质检未完成'));
  fs.writeFileSync(path.join(outDir, 'quality-notes.json'), JSON.stringify(qualityNotes, null, 2));
  console.log(qaOut.trim().split('\n').map((l) => `[qa  ] ${l}`).join('\n'));
  console.log(`[qa  ] done in ${Date.now() - qa0}ms`);

  const totalMs = Date.now() - runStart;
  writeRunLog(outDir, { bp, mapping, rendered, tts, concatMs, totalMs, gate, finalDuration, bgmInfo, qaOut });
  console.log(`[done] ${segments.length} segments, ${fmtSec(finalDuration)}s, total ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`[map ] ${path.join(outDir, 'mapping.json')}`);
}

function writeStillPreview(outDir, segments) {
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const figures = segments.flatMap(segment => segment.samples.map(sample =>
    `<figure><img src="${sample.still}" alt=""><figcaption><strong>${escape(segment.blueprint_id)} · ${sample.time.toFixed(2)}s</strong> · 实拍镜头 ${escape(sample.shotId ?? '缺失或重叠')}<br>${escape(sample.caption || '（该时点无字幕）')}</figcaption></figure>`));
  fs.writeFileSync(path.join(outDir, 'stills', 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>画面与旁白对照</title>
<style>body{font:16px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}figure{margin:0}img{width:100%}figcaption{line-height:1.5}@media(max-width:650px){main{grid-template-columns:1fr}}</style>
<h1>画面与旁白对照</h1><main>${figures.join('\n')}</main></html>`, 'utf8');
}

function writeRunLog(outDir, d) {
  const { bp, mapping, rendered, tts, concatMs, totalMs, gate, finalDuration, bgmInfo, qaOut } = d;
  const voices = [...new Set(tts.payload.segments.map((s) => s.voice))];
  const lines = [];
  lines.push(`# 运行记录：${bp.title}`);
  lines.push('');
  lines.push(`- 蓝图：\`${bp.blueprint_id}\`（${mapping.blueprint_file}）`);
  lines.push(gate.prepared ? `- 输入准备单状态：${gate.summary.confirmation_status}（由导出文件提供）` : `- 交付闸门：deliverable_to_video=${gate.gatePassed}，confirmation_status=${gate.summary.confirmation_status}${gate.preview ? '，**工程预览，非正式交付**' : ''}`);
  lines.push(`- 成片：\`${mapping.final_video}\`，实测 ${mapping.final_duration_sec}s`);
  lines.push(`- 规格：${mapping.resolution} @ ${mapping.fps}fps，H.264 + AAC`);
  lines.push(`- 总耗时：${(totalMs / 1000).toFixed(1)}s`);
  lines.push(bp.targetDurationSeconds != null ? `- 目标时长：${bp.targetDurationSeconds}s；实际 ${mapping.final_duration_sec}s${mapping.target_exceeded ? '，完整旁白及必要留白超过目标，未截断音频' : ''}` : '- 时长来源：旁白 TTS 实测音频 + 段首/段尾留白');
  lines.push('');
  lines.push('## 各段耗时');
  lines.push('');
  lines.push('| 段落 | 场景 | 旁白音频(s) | 成片时长(s) | 帧数 | 截帧(ms) | 编码(ms) | 合计(ms) |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rendered) {
    const m = mapping.segments.find((s) => s.id === r.plan.id);
    lines.push(`| ${r.plan.id} ${m.title} | ${r.plan.role} | ${m.narration_audio_seconds} | ${m.duration_sec} | ${r.frames} | ${r.captureMs} | ${r.encodeMs} | ${r.totalMs} |`);
  }
  lines.push('');
  lines.push(`- concat 耗时：${concatMs}ms`);
  lines.push(`- 旁白音频合计：${tts.payload.total_audio_seconds}s；成片合计：${mapping.final_duration_sec}s`);
  lines.push(`- clip 时长累加：${mapping.clip_sum_sec}s；与成片实测差：${mapping.concat_residual_sec}s`);
  lines.push('');
  lines.push('## 调用次数与费用');
  lines.push('');
  lines.push(`- TTS：${tts.payload.backend}，请求音色 ${tts.payload.voice_requested}，实际使用 ${voices.join(', ')}，语速 ${tts.payload.rate}`);
  lines.push(`- TTS 本次网络合成：${tts.payload.network_syntheses_this_run} 次；离线合成：${tts.payload.offline_syntheses_this_run} 次；新合成段：${tts.payload.fresh_segment_ids.join(', ') || '无'}；缓存命中 ${tts.payload.cache_hits_this_run} 段`);
  lines.push(`- TTS 累计：每段旁白各合成 1 次入缓存，返工重跑命中缓存不重复计费/调用`);
  lines.push(`- TTS 耗时：${tts.ms}ms`);
  if (tts.payload.backend === 'sapi') lines.push('- TTS 费用：0（Windows SAPI 本地合成）');
  else if (tts.payload.backend === 'say') lines.push('- TTS：macOS 系统本地合成，无网络配音调用');
  else if (tts.payload.backend === 'edge-tts') lines.push('- TTS：edge-tts');
  else lines.push('- TTS：API 服务，费用以服务商计费为准');
  lines.push('- 本次渲染使用已准备的场景；素材制作阶段的模型调用和费用未由此流水线统计。');
  lines.push('- 渲染：本地无头浏览器逐帧截图并调用 ffmpeg 编码。');
  lines.push('');
  lines.push('## vibe-knowledge 基础档（BGM + 质检）');
  lines.push('');
  lines.push(`- 强制 BGM：vendor/vibe-knowledge assets/music/vibe-bgm.m4a，fit_bgm.py 按片长按小节裁剪；说话时人声比 BGM 高 ${bgmInfo?.voice_gap_db ?? '?'} dB（bgm_force.calibrate 统一校准）`);
  lines.push(`- BGM 混音：${bgmInfo?.ok ? '完成' : '失败'}；峰值限幅：${bgmInfo?.peak_limited ? '是' : '否'}；混音前纯人声版保留为 final_voice_only.mp4`);
  lines.push('- 质检（qa_windows.py，qa.py 的 Windows 适配）：接触表 qa/sheet.jpg、响度、>3s 静止检测、BGM 相关性；macOS Vision OCR 在 Windows 不可用，屏幕文字以接触表人工 review 替代');
  lines.push('');
  lines.push('```');
  lines.push((qaOut ?? '').trim());
  lines.push('```');
  lines.push('');
  lines.push('## 段落定位');
  lines.push('');
  if (!gate.prepared) lines.push('每帧左上角烧录 `S<n>｜段落标题`，观众/团队可据此指出要改哪一段；');
  lines.push('`mapping.json` 给出每段在成片中的起止秒与对应 clip 文件。');
  lines.push('');
  lines.push('## 失败即停');
  lines.push('');
  lines.push('任一段 TTS / 截帧 / 编码 / 校验失败即抛错并非零退出，concat 不执行，不产出缺段成片。');
  lines.push('本次运行全部段落通过。');
  lines.push('');
  fs.writeFileSync(path.join(outDir, 'run-log.md'), lines.join('\n'), 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n[FAIL] ${e.message}`);
    process.exit(1);
  });
}
