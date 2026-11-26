// ffmpeg/ffprobe helpers. Every duration used for mapping.json is measured from
// a real file here — never estimated from narration length or frame counts.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import STYLE from './style.mjs';
import { childEnvironment, emitDesktopDiagnostic } from './runtime.mjs';

const run = promisify(execFile);
const FF = STYLE.paths.ffmpeg;
const FP = STYLE.paths.ffprobe;

// +faststart rewrites the mp4 once after encoding; under heavy concurrent load a
// reader can catch the file mid-rewrite. Retry briefly instead of failing a segment.
const TRANSIENT = /moov atom not found|Invalid data found|Error opening input/;
export async function runRetry(bin, args, opts = {}, attempts = 4) {
  if (!bin) throw new Error('Set VIDEO_FFMPEG and VIDEO_FFPROBE to absolute executable paths');
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await run(bin, args, { ...opts, env: childEnvironment(opts.env, [bin]), windowsHide: true });
      emitDesktopDiagnostic('ffmpeg', result.stderr);
      return result;
    } catch (e) {
      last = e;
      emitDesktopDiagnostic('ffmpeg', e.stderr || 'codec process failed');
      const msg = `${e.stderr ?? ''}${e.message ?? ''}`;
      if (!TRANSIENT.test(msg) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

export async function probeDuration(file) {
  const { stdout } = await runRetry(FP, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad duration for ${file}: ${stdout.trim()}`);
  return d;
}

export async function probeStreams(file) {
  const { stdout } = await runRetry(FP, ['-v', 'error', '-show_streams', '-of', 'json', file]);
  return JSON.parse(stdout).streams ?? [];
}

// A clip must carry both a video and an audio stream, or concat would silently
// drop narration for that segment.
export async function assertClipPlayable(file) {
  const streams = await probeStreams(file);
  const kinds = new Set(streams.map((s) => s.codec_type));
  if (!kinds.has('video')) throw new Error(`clip has no video stream: ${file}`);
  if (!kinds.has('audio')) throw new Error(`clip has no audio stream: ${file}`);
  const v = streams.find((s) => s.codec_type === 'video');
  const { width, height, fps } = STYLE.video;
  if (v.width !== width || v.height !== height) {
    throw new Error(`clip geometry ${v.width}x${v.height} != style ${width}x${height}: ${file}`);
  }
  const [num, den] = (v.r_frame_rate || '0/1').split('/').map(Number);
  const actualFps = den ? num / den : 0;
  if (Math.abs(actualFps - fps) > 0.5) {
    throw new Error(`clip fps ${actualFps} != style ${fps}: ${file}`);
  }
  return { duration: await probeDuration(file), streams: kinds.size };
}

export async function concatClips(clips, outFile) {
  const listFile = path.join(path.dirname(outFile), 'concat-list.txt');
  // concat demuxer needs forward slashes and escaped single quotes.
  const body = clips.map(file => "file '" + path.relative(path.dirname(outFile), file).split(path.sep).join('/').replace(/'/g, "'\\''") + "'").join('\n');
  fs.writeFileSync(listFile, body + '\n', 'utf8');
  const e = STYLE.encode;
  await runRetry(FF, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', e.videoCodec, '-preset', e.preset, '-crf', String(e.crf), '-pix_fmt', e.pixFmt,
    '-c:a', e.audioCodec, '-b:a', e.audioBitrate, '-ar', String(e.audioRate), '-ac', String(e.audioChannels),
    '-movflags', e.movflags, outFile,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return probeDuration(outFile);
}

export { FF, FP };
