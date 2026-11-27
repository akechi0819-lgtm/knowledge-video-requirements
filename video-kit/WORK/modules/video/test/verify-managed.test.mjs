import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const beats = ['B01', 'B07', 'B08'].map((beatId, i) => ({ id: `S0${i + 1}`, beatId, start: i, end: i + 1 }));
function setup(color = 'white') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-verify-'));
  const png = color === 'white' ? 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RwQ0AMAjDwJT9d05HMB9+vgGCZF7bXJrT9XhgwR8gEyETIRMhEyETIRMhEyEThXzH8QM9OMM6fAAAAABJRU5ErkJggg==' : 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGklEQVR4nO3BAQ0AAADCoPdP7WYOoAAAALoBDCAAATV8oiUAAAAASUVORK5CYII=';
  const image = path.join(dir, 'frame.png'); fs.writeFileSync(image, Buffer.from(png, 'base64'));
  execFileSync(process.env.VIDEO_FFMPEG || 'ffmpeg', ['-v', 'error', '-loop', '1', '-framerate', '10', '-i', image, '-t', '3', '-c:v', 'libx264', path.join(dir, 'final.mp4')]);
  fs.writeFileSync(path.join(dir, 'timings.json'), JSON.stringify({ beats }));
  const segments = beats.map(b => ({ id: b.id, blueprint_id: b.beatId, start_sec: b.start, end_sec: b.end, samples: [0.25, 0.75].map(fraction => ({ fraction, time: b.start + fraction, shotId: b.beatId })) }));
  fs.writeFileSync(path.join(dir, 'mapping.json'), JSON.stringify({ final_video: 'final.mp4', segments }));
  return dir;
}
function verify(dir) {
  const result = spawnSync(process.execPath, [verifier, path.join(dir, 'mapping.json'), path.join(dir, 'timings.json')], { encoding: 'utf8' });
  return { status: result.status, report: JSON.parse(fs.readFileSync(path.join(dir, 'verify-report.json'))) };
}
function change(dir, edit) {
  const file = path.join(dir, 'mapping.json');
  const map = JSON.parse(fs.readFileSync(file)); edit(map); fs.writeFileSync(file, JSON.stringify(map));
}
test('managed gate accepts matching samples despite QA notes', () => {
  const dir = setup(); fs.writeFileSync(path.join(dir, 'quality-notes.json'), '["warning"]');
  const { status, report } = verify(dir); assert.equal(status, 0); assert.equal(report.pass, true); assert.deepEqual(report.problems, ['warning']);
});
test('rejects B01 rendered as B02 and B07 rendered as B08', () => {
  const dir = setup(); change(dir, m => { m.segments[0].samples[0].shotId = 'B02'; m.segments[1].samples.forEach(s => s.shotId = 'B08'); });
  const { status, report } = verify(dir); assert.equal(status, 1); assert.equal(report.pass, false); assert.match(report.hardErrors.join('\n'), /B02 != B01/); assert.match(report.hardErrors.join('\n'), /B08 != B07/);
});
test('rejects missing mapping, wrong interval and missing sample', () => {
  const dir = setup(); fs.unlinkSync(path.join(dir, 'mapping.json'));
  assert.equal(verify(dir).report.pass, false);
  changeFixture();
  function changeFixture() {
    const other = setup(); change(other, m => { m.segments[0].end_sec = 0; m.segments[1].samples.pop(); });
    const { report } = verify(other); assert.match(report.hardErrors.join('\n'), /interval/); assert.match(report.hardErrors.join('\n'), /missing or duplicate/);
  }
});
test('rejects black frames and undecodable film', () => {
  const dir = setup('black'); assert.match(verify(dir).report.hardErrors.join('\n'), /fully black/);
  fs.writeFileSync(path.join(dir, 'final.mp4'), 'broken'); assert.match(verify(dir).report.hardErrors.join('\n'), /decode\/probe failed/);
});
