// Single source of truth for every style, timing, path and encoding constant.
// The HTML scene reads these via window.STYLE (injected by render.mjs), so the
// renderer and the orchestrator can never drift apart.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, resolveTool } from './runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_DIR = HERE;
export const WORK_DIR = path.resolve(HERE, '..', '..');
export const REPO_DIR = path.resolve(WORK_DIR, '..');

// Portable tool resolution (kit portability layer): env override first, then
// kit-local installs, then PATH / well-known browser locations. The original
// repo pinned machine-specific absolute paths here; the kit must run anywhere.
const require = createRequire(import.meta.url);

function resolvePlaywright() {
  if (process.env.VIDEO_PLAYWRIGHT) return process.env.VIDEO_PLAYWRIGHT;
  try { return require.resolve('playwright-core'); } catch { return null; }
}

let browser;

export const STYLE = {
  video: { width: 1280, height: 720, fps: 30 },

  palette: {
    bg: '#FDF3E3',
    bgGlow: '#F7E4C6',
    table: '#E3BE8C',
    tableEdge: '#C99A63',
    potOuter: '#B8402F',
    potRim: '#D9553F',
    broth: '#E8613C',
    brothDeep: '#C4452B',
    brothBubble: '#F58A5F',
    chili: '#E23B2E',
    chiliShade: '#B72C22',
    stem: '#4E9A51',
    potato: '#EFC978',
    potatoSkin: '#C99A4E',
    tomato: '#E8452F',
    tomatoShade: '#C23320',
    mushroom: '#B9A08C',
    mushroomCap: '#9C8270',
    greens: '#6FBF73',
    greensDeep: '#4E9A51',
    tofu: '#F8F2E2',
    tofuEdge: '#E0D5BC',
    ink: '#3A2A22',
    inkSoft: '#7A6355',
    highlight: '#FFC93C',
    steam: '#FFFFFF',
    ocean: '#DCEEF7',
    land: '#CFE3C8',
    landEdge: '#B4CDA9',
    route: '#E8613C',
  },

  font: {
    family: '"Microsoft YaHei","Segoe UI",sans-serif',
    labelSize: 30,
    labelWeight: 700,
    titleSize: 46,
    captionSize: 34,
  },

  subtitle: {
    fontSize: 40,
    fontWeight: 700,
    color: '#FFFFFF',
    pillColor: 'rgba(38,24,18,0.72)',
    pillRadius: 18,
    padX: 28,
    padY: 14,
    bottom: 46,
    maxWidth: 1120,
    // Closing card line requested by the blueprint (R11), not narration.
    closingText: '一顿火锅，也藏着世界交流史。',
  },

  // Segment identity is burned into every frame so a viewer can name the段.
  segmentTag: { fontSize: 24, color: 'rgba(58,42,34,0.55)', left: 32, top: 28 },

  layout: {
    potCx: 640, potCy: 430, potRx: 300, potRy: 132,
    chili: { x: 470, y: 392 },
    potato: { x: 640, y: 404 },
    tomato: { x: 806, y: 392 },
    labelOffsetY: -74,
  },

  timing: {
    leadIn: 0.35,        // silence before narration starts in each clip
    tailPad: 0.55,       // silence after narration ends
    s1GuessPause: 1.10,  // extra hold so the viewer can guess (R08)
    s4ClosingHold: 1.90, // extra hold for the closing card (R11)
    highlightLead: 0.06, // ring appears just before the word is spoken
    vanishStagger: 0.34, // gap between successive disappearances
    vanishDur: 0.42,     // fade-out length of one ingredient
    returnStagger: 0.30,
    returnDur: 0.46,
    steamPeriod: 2.4,
  },

  tts: { voice: 'zh-CN-XiaoxiaoNeural', rate: process.env.VIDEO_TTS_RATE || '+0%' },

  encode: {
    videoCodec: 'libx264', preset: 'medium', crf: 18, pixFmt: 'yuv420p',
    audioCodec: 'aac', audioBitrate: '160k', audioRate: 48000, audioChannels: 2,
    movflags: '+faststart',
  },

  paths: {
    get ffmpeg() { return resolveTool('ffmpeg', process.env, REPO_DIR, false); },
    get ffprobe() { return resolveTool('ffprobe', process.env, REPO_DIR, false); },
    get edge() { return browser === undefined ? (browser = resolveBrowser()) : browser; },
    get python() { return resolveTool('python', process.env, REPO_DIR, false); },
    get playwright() { return resolvePlaywright(); },
  },

  // Screenshot format/quality chosen from T4 spike A measurements.
  capture: { type: 'jpeg', quality: 92, pages: Number(process.env.VIDEO_CAPTURE_PAGES || 3) },
};

export default STYLE;
