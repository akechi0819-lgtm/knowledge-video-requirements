import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../WORK/modules/video/pipeline.mjs', import.meta.url));
test('缺旁白或场景时在 TTS 前报告 S 和 B 段号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-kit-test-'));
  try {
    const file = path.join(dir, 'production.json');
    const input = { status: '准备制作', topic: '测试', version: 'v1', sections: [
      { id: 'S01', blueprintId: 'B03a', title: '测试', narration: '', scene: 'S01.html' },
    ] };
    const check = () => {
      fs.writeFileSync(file, JSON.stringify(input));
      return spawnSync(process.execPath, [cli, '--prepared', file, '--out', path.join(dir, 'out')], { encoding: 'utf8' });
    };
    let result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /S01 \/ B03a.*缺少已确认旁白/);
    input.sections[0].narration = '测试旁白';
    result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /S01 \/ B03a.*场景 HTML 不存在/);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('拒绝缺失或重复的蓝图 B 段号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-kit-test-'));
  try {
    const file = path.join(dir, 'production.json');
    fs.writeFileSync(path.join(dir, 'scene.html'), '<div id="stage"></div>');
    const segment = { id: 'S01', blueprintId: 'B03', title: '测试', narration: '旁白', scene: 'scene.html' };
    const input = { status: '准备制作', topic: '测试', version: 'v1', sections: [segment, { ...segment, id: 'S02' }] };
    const check = () => {
      fs.writeFileSync(file, JSON.stringify(input));
      return spawnSync(process.execPath, [cli, '--prepared', file, '--out', path.join(dir, 'out')], { encoding: 'utf8' });
    };
    let result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /S02 \/ B03.*B 段号无效或重复/);
    delete input.sections[1].blueprintId;
    result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /S02.*B 段号无效或重复/);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
