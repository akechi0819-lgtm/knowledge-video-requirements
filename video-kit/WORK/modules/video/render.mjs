// Per-segment renderer: deterministic HTML frames -> one clip mp4 with narration.
// The renderer is an adapter; timing, concat and mapping live in pipeline.mjs and
// do not depend on this implementation.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import STYLE, { MODULE_DIR } from './style.mjs';
import { FF, assertClipPlayable } from './ffmpeg.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const p = STYLE.paths.playwright;
  if (!p) throw new Error('playwright-core not installed; run `npm install` at the kit root (or set VIDEO_PLAYWRIGHT)');
  if (!fs.existsSync(p)) throw new Error(`playwright-core not found at ${p}`);
  return require(p);
}

export async function renderSegment(plan, audioFile, outDir) {
  const { width, height, fps } = STYLE.video;
  const framesDir = path.join(outDir, 'frames', plan.id);
  fs.mkdirSync(framesDir, { recursive: true });
  for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));

  const { chromium } = loadPlaywright();
  if (!STYLE.paths.edge) throw new Error('no Edge/Chrome/Chromium executable found; set VIDEO_BROWSER to a browser executable');
  const browser = await chromium.launch({
    executablePath: STYLE.paths.edge,
    headless: true,
    // Hardened for frame determinism: single raster thread, no LCD text /
    // GPU compositing / threaded animation / checker imaging, and all
    // compositor stages completed before draw (see spike/s1-determinism).
    args: [
      '--disable-gpu', '--disable-gpu-compositing', '--disable-lcd-text',
      '--num-raster-threads=1', '--disable-threaded-animation',
      '--disable-checker-imaging', '--run-all-compositor-stages-before-draw',
      '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none',
    ],
  });

  const t0 = Date.now();
  let captured = 0;
  const staticLeadFrames = plan.targetNames?.length ? Math.ceil(plan.audioStart * fps) : 0;
  try {
    const pageCount = Math.max(1, STYLE.capture.pages);
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const pg = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      // scene.html reads STYLE/PLAN while its own script executes, so they must
      // exist before any page script runs — not injected after goto.
      await pg.addInitScript(([style, pl]) => {
        window.STYLE = style; window.__PLAN__ = pl;
      }, [STYLE, plan]);
      await pg.goto(pathToFileURL(plan.scenePath || path.join(MODULE_DIR, 'scene.html')).href);
      await pg.waitForFunction('typeof window.seek === "function" && !!window.__PLAN__ && !!window.STYLE');
      pages.push(pg);
    }

    const ext = STYLE.capture.type === 'jpeg' ? 'jpg' : 'png';
    await Promise.all(pages.map(async (pg, p) => {
      for (let i = p; i < plan.frames; i += pageCount) {
        await pg.evaluate((t) => window.seek(t), i / fps);
        // The first raster of a new layer state (fractional-opacity saveLayer)
        // races with capture and differs run-to-run; the second raster of the
        // same state is settled and byte-stable. Discard the first.
        await pg.locator('#stage').screenshot();
        const opts = { path: path.join(framesDir, `f${String(i).padStart(5, '0')}.${ext}`) };
        if (STYLE.capture.type === 'jpeg') opts.quality = STYLE.capture.quality;
        await pg.locator('#stage').screenshot(opts);
        captured++;
      }
    }));
    if (staticLeadFrames >= 9) {
      // The annotated map is static before narration; reuse a settled lead-in
      // raster across those frames to remove the compositor's startup variance.
      const framePath = (i) => path.join(framesDir, `f${String(i).padStart(5, '0')}.${ext}`);
      for (let i = 0; i < staticLeadFrames - 1; i++) {
        fs.copyFileSync(framePath(staticLeadFrames - 1), framePath(i));
      }
    }
  } finally {
    await browser.close();
  }
  const captureMs = Date.now() - t0;

  if (captured !== plan.frames) {
    throw new Error(`[${plan.id}] captured ${captured}/${plan.frames} frames; refusing to encode a short clip`);
  }

  const clip = path.join(outDir, 'clips', `${plan.id}.mp4`);
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  const e = STYLE.encode;
  const delayMs = Math.round(plan.audioStart * 1000);
  const ext = STYLE.capture.type === 'jpeg' ? 'jpg' : 'png';
  const args = [
    '-y', '-framerate', String(fps), '-i', path.join(framesDir, `f%05d.${ext}`),
    '-i', audioFile,
    '-filter_complex', `[1:a]adelay=${delayMs}|${delayMs},apad=whole_dur=${plan.duration}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', e.videoCodec, '-preset', e.preset, '-crf', String(e.crf), '-pix_fmt', e.pixFmt,
    '-r', String(fps), '-t', String(plan.duration),
    '-c:a', e.audioCodec, '-b:a', e.audioBitrate, '-ar', String(e.audioRate), '-ac', String(e.audioChannels),
    '-movflags', e.movflags, clip,
  ];
  const enc0 = Date.now();
  await run(FF, args, { maxBuffer: 64 * 1024 * 1024 });
  const encodeMs = Date.now() - enc0;

  const verified = await assertClipPlayable(clip);
  return {
    clip,
    frames: captured,
    captureMs,
    encodeMs,
    measuredDuration: verified.duration,
    plannedDuration: plan.duration,
  };
}
