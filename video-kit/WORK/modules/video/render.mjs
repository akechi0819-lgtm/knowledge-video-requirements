// Per-segment renderer: deterministic HTML frames -> one clip mp4 with narration.
// The renderer is an adapter; timing, concat and mapping live in pipeline.mjs and
// do not depend on this implementation.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import STYLE, { MODULE_DIR } from './style.mjs';
import { FF, assertClipPlayable, runRetry } from './ffmpeg.mjs';
import { installSceneRoutes } from './isolated-page.mjs';
import { childEnvironment, runtimePaths, writablePath } from './runtime.mjs';
import { openManagedStage } from './managed-stage.mjs';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const p = STYLE.paths.playwright;
  if (!p) throw new Error('playwright-core not installed; run `npm install` at the kit root (or set VIDEO_PLAYWRIGHT)');
  if (!fs.existsSync(p)) throw new Error(`playwright-core not found at ${p}`);
  return require(p);
}

export async function renderSegment(plan, audioFile, outDir) {
  const runtime = runtimePaths();
  const app = process.env.JIANGJIE_APP_ROOT && runtime.app;
  writablePath(outDir, app);
  const useCache = runtime.cache && (process.platform === 'win32' || process.env.JIANGJIE_CACHE_DIR);
  if (!useCache) return renderToClip(plan, audioFile, outDir, path.join(outDir, 'frames', plan.id));
  const tmp = writablePath(path.join(runtime.cache, 'tmp'), app);
  fs.mkdirSync(tmp, { recursive: true });
  const framesDir = fs.mkdtempSync(path.join(tmp, 'frames-'));
  try {
    return await renderToClip(plan, audioFile, outDir, framesDir);
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function renderToClip(plan, audioFile, outDir, framesDir) {
  const { width, height, fps } = STYLE.video;
  fs.mkdirSync(framesDir, { recursive: true });
  for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));

  const { chromium } = loadPlaywright();
  if (!STYLE.paths.edge) throw new Error('no Edge/Chrome/Chromium executable found; set VIDEO_EDGE_PATH or VIDEO_BROWSER to a browser executable');
  const browser = await chromium.launch({
    executablePath: STYLE.paths.edge,
    env: childEnvironment(process.env, [STYLE.paths.edge]),
    headless: true,
    // Hardened for frame determinism: single raster thread, no LCD text /
    // GPU compositing / threaded animation / checker imaging, and all
    // compositor stages completed before draw (see spike/s1-determinism).
    args: [
      '--disable-gpu', '--disable-gpu-compositing', '--disable-lcd-text',
      '--num-raster-threads=1', '--disable-threaded-animation',
      '--disable-checker-imaging', '--run-all-compositor-stages-before-draw',
      '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none',
      ...(process.env.VIDEO_ASSET_MANIFEST ? ['--disable-webrtc', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
    ],
  });

  const t0 = Date.now();
  let captured = 0;
  const fractions = plan.beatId ? [0.25, 0.75] : [];
  const samples = [];
  const stillsDir = path.join(outDir, 'stills');
  if (fractions.length) fs.mkdirSync(stillsDir, { recursive: true });
  const staticLeadFrames = plan.targetNames?.length ? Math.ceil(plan.audioStart * fps) : 0;
  try {
    const pageCount = Math.max(1, STYLE.capture.pages);
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      if (process.env.VIDEO_ASSET_MANIFEST) {
        const manifest = JSON.parse(fs.readFileSync(process.env.VIDEO_ASSET_MANIFEST, 'utf8'));
        await installSceneRoutes(context, plan.scenePath, manifest.root, manifest.assets);
      }
      if (plan.stage) {
        pages.push(await openManagedStage(context, STYLE, plan));
      } else {
        const pg = await context.newPage();
        // scene.html needs STYLE and PLAN while its own script executes.
        await pg.addInitScript(([style, pl]) => {
          window.STYLE = style; window.__PLAN__ = pl;
          if (pl.role === "prepared_html") { window.RTCPeerConnection = undefined; window.webkitRTCPeerConnection = undefined; }
        }, [STYLE, plan]);
        await pg.goto(process.env.VIDEO_ASSET_MANIFEST ? 'https://video.invalid/scenes/scene.html' : pathToFileURL(plan.scenePath || path.join(MODULE_DIR, 'scene.html')).href);
        await pg.waitForFunction('typeof window.seek === "function" && !!window.__PLAN__ && !!window.STYLE');
        pages.push({ view: pg.locator('#stage'), seek: t => pg.evaluate(seconds => window.seek(seconds), t) });
      }
    }

    const ext = STYLE.capture.type === 'jpeg' ? 'jpg' : 'png';
    await Promise.all(pages.map(async (page, p) => {
      for (let i = p; i < plan.frames; i += pageCount) {
        await page.seek(i / fps);
        // The first raster of a new layer state can race with capture.
        await page.view.screenshot();
        const opts = { type: STYLE.capture.type, path: path.join(framesDir, `f${String(i).padStart(5, '0')}.${ext}`) };
        if (STYLE.capture.type === 'jpeg') opts.quality = STYLE.capture.quality;
        const screenshot = await page.view.screenshot(opts);
        const matching = fractions.filter(fraction => Math.floor(plan.frames * fraction) === i);
        if (matching.length) {
          // Read the active DOM of the shot that contributed to the same frame.
          const [shotId, caption] = await Promise.all([page.shotId(), page.caption()]);
          for (const fraction of matching) {
            const still = `${plan.id}-${fraction * 100}.${ext}`;
            fs.writeFileSync(path.join(stillsDir, still), screenshot);
            samples.push({ fraction, time: plan.start + plan.duration * fraction, shotId, caption, still });
          }
        }
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
  await runRetry(FF, args, { maxBuffer: 64 * 1024 * 1024 });
  const encodeMs = Date.now() - enc0;

  const verified = await assertClipPlayable(clip);
  return {
    clip,
    frames: captured,
    captureMs,
    encodeMs,
    measuredDuration: verified.duration,
    plannedDuration: plan.duration,
    samples: samples.sort((a, b) => a.fraction - b.fraction),
  };
}
