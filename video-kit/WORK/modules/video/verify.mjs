// Acceptance checks for a rendered film.
//   node WORK/modules/video/verify.mjs <mapping.json>
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

main().catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
