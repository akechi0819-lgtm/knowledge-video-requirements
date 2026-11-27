// Acceptance checks for a rendered film.
//   node WORK/modules/video/verify.mjs <mapping.json> [timings.json]
// Verifies: every segment id maps to a playable, contiguous interval inside the
// final video; narration audio is actually present in each segment's window and
// absent in the lead-in; frames can be decoded at interval boundaries.

import fs from 'node:fs';
import path from 'node:path';
import STYLE from './style.mjs';
import { FF, probeDuration, probeStreams, runRetry } from './ffmpeg.mjs';
import { runtimePaths, writablePath } from './runtime.mjs';

async function meanVolume(file, start, dur) {
  const { stderr } = await runRetry(FF, [
    '-v', 'info', '-ss', String(start), '-t', String(dur), '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], { maxBuffer: 32 * 1024 * 1024 });
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number.parseFloat(m[1]) : null;
}

async function frameAt(file, t, out) {
  await runRetry(FF, ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', out]);
  return fs.existsSync(out) && fs.statSync(out).size > 0;
}

// Managed mode treats timings as the authoritative timeline. Warnings do not
// decide acceptance; missing evidence, mismatched intervals or frames do.
async function verifyManaged(mapPath, timingsPath) {
  const dir = path.dirname(mapPath);
  const report = { final: null, totalDuration: null, segments: [], problems: [], hardErrors: [], pass: false };
  const fail = message => report.hardErrors.push(message);
  const readJson = (file, label) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { fail(`${label}: ${error.message}`); return null; }
  };
  try {
    const timings = readJson(timingsPath, 'timings');
    const map = readJson(mapPath, 'mapping');
    const beats = timings?.beats;
    const segments = map?.segments;
    if (!Array.isArray(beats) || !beats.length) fail('timings.beats must be a non-empty array');
    if (!Array.isArray(segments) || !segments.length) fail('mapping.segments must be a non-empty array');
    if (map?.final_video !== 'final.mp4') fail('mapping.final_video must be final.mp4');
    let total = null;
    if (map?.final_video === 'final.mp4') {
      const final = path.join(dir, map.final_video);
      report.final = map.final_video;
      try {
        total = await probeDuration(final);
        report.totalDuration = total;
        const stage = beats?.[0]?.stage;
        const crop = stage ? `crop=${stage.width}:${stage.height}:0:${stage.top},` : '';
        const { stdout, stderr } = await runRetry(FF, [
          '-v', 'info', '-xerror', '-i', final, '-map', '0:v:0', '-vf', crop + 'blackframe=amount=100:threshold=17',
          '-an', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats',
        ], { maxBuffer: 32 * 1024 * 1024 });
        if (!/^frame=\s*[1-9]\d*\s*$/m.test(stdout)) fail('final video contains no decoded frames');
        const black = /frame:(\d+) pblack:100/.exec(stderr);
        if (black) fail(`final video frame ${black[1]} is fully black`);
      } catch (error) { fail(`final video decode/probe failed: ${error.message}`); }
    }
    if (Array.isArray(beats) && Array.isArray(segments)) {
      const seenIds = new Set(), seenBeats = new Set();
      let previousEnd = 0;
      for (const beat of beats) {
        const { id, beatId, start, end } = beat ?? {};
        if (typeof id !== 'string' || !id || typeof beatId !== 'string' || !beatId || seenIds.has(id) || seenBeats.has(beatId) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
          fail(`invalid timing beat ${id ?? '(missing id)'}`); continue;
        }
        seenIds.add(id);
        seenBeats.add(beatId);
        if (Math.abs(start - previousEnd) > 0.001) fail(`${id}: timing gap or overlap`);
        previousEnd = end;
        const matches = segments.filter(s => s?.id === id);
        if (matches.length !== 1) { fail(`${id}: expected exactly one mapping segment`); continue; }
        const segment = matches[0];
        const row = { id, beatId, start, end, samples: segment.samples, issues: [] };
        const issue = message => { row.issues.push(message); fail(`${id}: ${message}`); };
        if (segment.blueprint_id !== beatId) issue('blueprint_id does not match timing beatId');
        if (!Number.isFinite(segment.start_sec) || !Number.isFinite(segment.end_sec) || segment.end_sec <= segment.start_sec || Math.abs(segment.start_sec - start) > 0.001 || Math.abs(segment.end_sec - end) > 0.001) issue('mapping interval does not match timing');
        for (const fraction of [0.25, 0.75]) {
          const expected = start + (end - start) * fraction;
          const samples = Array.isArray(segment.samples) ? segment.samples.filter(sample => sample?.fraction === fraction) : [];
          if (samples.length !== 1) { issue(`missing or duplicate ${fraction} sample`); continue; }
          const sample = samples[0];
          if (!Number.isFinite(sample.time) || Math.abs(sample.time - expected) > 0.001) issue(`sample ${fraction} time mismatch`);
          if (sample.shotId !== beatId) issue(`sample ${fraction} shotId ${String(sample.shotId)} != ${beatId}`);
          if (total !== null && expected >= total) issue(`sample ${fraction} outside final video`);
        }
        report.segments.push(row);
      }
      for (const segment of segments) if (!seenIds.has(segment?.id)) fail(`unexpected mapping segment ${segment?.id}`);
      if (total !== null && Math.abs(previousEnd - total) > 0.1) fail(`timings end ${previousEnd} != final duration ${total}`);
    }
    const notesFile = path.join(dir, 'quality-notes.json');
    if (fs.existsSync(notesFile)) {
      try { const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8')); if (Array.isArray(notes)) report.problems.push(...notes); }
      catch (error) { report.problems.push(`quality notes: ${error.message}`); }
    }
  } catch (error) { fail(`verification failed: ${error.message}`); }
  report.pass = report.hardErrors.length === 0;
  fs.writeFileSync(path.join(dir, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
  if (report.pass) console.log('VERIFY PASS');
  else console.error(`VERIFY FAIL:\n${report.hardErrors.join('\n')}`);
  if (!report.pass) process.exitCode = 1;
}

async function main() {
  const mapPath = path.resolve(process.argv[2]);
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const app = process.env.JIANGJIE_APP_ROOT && runtimePaths().app;
  const dir = writablePath(path.dirname(mapPath), app);
  const final = path.join(dir, map.final_video);
  const voiceOnly = path.join(dir, 'final_voice_only.mp4');
  const narrationTrack = fs.existsSync(voiceOnly) ? voiceOnly : final;
  const total = await probeDuration(final);
  const hasAudio = (await probeStreams(narrationTrack)).some(stream => stream.codec_type === 'audio');
  const notesFile = path.join(dir, 'quality-notes.json');
  const problems = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf8')) : [];
  const hardErrors = [];
  const rows = [];

  let cursor = 0;
  for (const s of map.segments) {
    const issues = [];
    if (s.start_sec < 0 || s.end_sec > total + 0.05) issues.push(`interval outside [0,${total.toFixed(3)}]`);
    if (Math.abs(s.start_sec - cursor) > 0.05) issues.push(`gap/overlap vs previous end ${cursor.toFixed(3)}`);
    if (s.end_sec - s.start_sec <= 0) issues.push('non-positive duration');
    cursor = s.end_sec;

    const clipPath = path.join(dir, s.clip);
    if (!fs.existsSync(clipPath)) { issues.push('clip file missing'); hardErrors.push(`${s.id}: clip file missing`); }
    else {
      const cd = await probeDuration(clipPath);
      if (Math.abs(cd - s.duration_sec) > 0.05) issues.push(`clip duration ${cd} != mapping ${s.duration_sec}`);
    }

    // narration must be audible inside its window
    const narStart = s.start_sec + STYLE.timing.leadIn + 0.15;
    const narDur = Math.max(0.3, s.narration_audio_seconds - 0.3);
    const vNarr = hasAudio ? await meanVolume(narrationTrack, narStart, narDur) : null;
    if (vNarr == null || vNarr < -45) issues.push(`narration window too quiet (${vNarr} dB)`);
    // BGM can play during the lead-in, so check the narration track for silence.
    const vLead = hasAudio ? await meanVolume(narrationTrack, s.start_sec + 0.02, Math.max(0.1, STYLE.timing.leadIn - 0.06)) : null;
    if (vLead != null && vLead > -50) issues.push(`lead-in not silent (${vLead} dB)`);

    // decodable frames at both boundaries and the middle
    const checksDir = writablePath(path.join(dir, 'checks'), app);
    fs.mkdirSync(checksDir, { recursive: true });
    for (const [label, t] of [['start', s.start_sec + 0.05], ['mid', (s.start_sec + s.end_sec) / 2], ['end', s.end_sec - 0.08]]) {
      if (t < 0 || t >= total) continue;
      const ok = await frameAt(final, t, path.join(checksDir, `verify_${s.id}_${label}.png`));
      if (!ok) { const message = `cannot decode frame at ${label} (${t}s)`; issues.push(message); hardErrors.push(`${s.id}: ${message}`); }
    }

    rows.push({ id: s.id, start: s.start_sec, end: s.end_sec, narrationDb: vNarr, leadDb: vLead, issues });
    if (issues.length) problems.push(`${s.id}: ${issues.join('; ')}`);
  }
  if (Math.abs(cursor - total) > 0.25) problems.push(`segments end ${cursor.toFixed(3)} != final ${total.toFixed(3)}`);

  const report = { final, totalDuration: total, segments: rows, problems, hardErrors, pass: problems.length === 0 };
  fs.writeFileSync(path.join(dir, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const r of rows) {
    console.log(`${r.id} [${r.start.toFixed(3)}..${r.end.toFixed(3)}] narration=${r.narrationDb}dB lead=${r.leadDb}dB ${r.issues.length ? 'ISSUES: ' + r.issues.join('; ') : 'OK'}`);
  }
  console.log(report.pass ? 'VERIFY PASS' : `${hardErrors.length ? 'VERIFY FAIL' : 'VERIFY WARN'}:\n${problems.join('\n')}`);
  process.exit(hardErrors.length ? 1 : 0);
}

if (process.argv[3]) {
  verifyManaged(path.resolve(process.argv[2]), path.resolve(process.argv[3])).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
} else {
  main().catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
}
