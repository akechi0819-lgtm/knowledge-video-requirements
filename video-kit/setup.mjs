// One-shot kit setup: npm deps + kit-local python venv + pip deps.
//   node setup.mjs
// External tools (ffmpeg / browser) are NOT installed here; see README.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: WIN, cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`[setup] FAILED: ${cmd} ${args.join(' ')} (exit ${r.status})${r.error ? ' ' + r.error.message : ''}`);
    process.exit(r.status ?? 1);
  }
}

console.log('[setup] 1/3 npm install (playwright-core)');
run(WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund']);

const basePython = process.env.VIDEO_SETUP_PYTHON || (WIN ? 'python' : 'python3');
const venvDir = path.join(ROOT, 'WORK', 'modules', 'video', '.venv');
const venvPython = WIN
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

console.log(`[setup] 2/3 python venv at ${venvDir}`);
if (!fs.existsSync(venvPython)) run(basePython, ['-m', 'venv', venvDir], { shell: false });

console.log('[setup] 3/3 pip install -r requirements.txt');
run(venvPython, ['-m', 'pip', 'install', '-r', path.join(ROOT, 'requirements.txt')], { shell: false });

const { default: STYLE } = await import('./WORK/modules/video/style.mjs');
console.log('\n[setup] resolved tools:');
console.log(`  ffmpeg    : ${STYLE.paths.ffmpeg}`);
console.log(`  ffprobe   : ${STYLE.paths.ffprobe}`);
console.log(`  browser   : ${STYLE.paths.edge ?? 'NOT FOUND — set VIDEO_BROWSER'}`);
console.log(`  python    : ${STYLE.paths.python}`);
console.log(`  playwright: ${STYLE.paths.playwright ?? 'NOT FOUND — npm install failed?'}`);
const ff = spawnSync(STYLE.paths.ffmpeg, ['-version'], { encoding: 'utf8', shell: false });
console.log(`  ffmpeg ver: ${ff.status === 0 ? ff.stdout.split('\n')[0] : 'NOT RUNNABLE — set VIDEO_FFMPEG/VIDEO_FFPROBE or fix PATH'}`);
console.log('\n[setup] done. Try: node WORK/modules/video/pipeline.mjs examples/hotpot.v1.json --out out/demo');