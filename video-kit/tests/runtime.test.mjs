import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { childEnvironment, resolveBrowser, resolveTool, runtimePaths, writablePath } from '../WORK/modules/video/runtime.mjs';

test('absolute overrides take precedence and invalid overrides never select a fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "讲界 测试 ' "));
  try {
    const app = path.join(root, '程序');
    const bin = path.join(root, '测试 工具');
    await mkdir(app);
    await mkdir(bin);
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const exe of ['ffmpeg' + ext, 'ffprobe' + ext, process.platform === 'win32' ? 'python.exe' : 'python3']) {
      await writeFile(path.join(bin, exe), '');
      await chmod(path.join(bin, exe), 0o755);
    }
    const env = { PATH: bin, VIDEO_FFMPEG: process.execPath, VIDEO_FFPROBE: process.execPath,
      VIDEO_PYTHON: process.execPath, VIDEO_EDGE_PATH: process.execPath, VIDEO_BROWSER: 'invalid-browser' };
    for (const tool of ['ffmpeg', 'ffprobe', 'python']) assert.equal(resolveTool(tool, env, app), process.execPath);
    assert.equal(resolveBrowser(env), process.execPath);
    assert.throws(() => resolveTool('ffmpeg', { ...env, VIDEO_FFMPEG: 'ffmpeg' + ext }, app), /VIDEO_FFMPEG/);
    assert.throws(() => resolveTool('python', { ...env, VIDEO_PYTHON: path.join(root, 'missing') }, app), /VIDEO_PYTHON/);
    assert.equal(resolveTool('ffmpeg', { PATH: bin }, app), path.join(bin, 'ffmpeg' + ext));
    assert.equal(resolveTool('ffmpeg', { PATH: bin, CONDA_PREFIX: bin }, app, false), null);
    const dirs = runtimePaths({ JIANGJIE_APP_ROOT: app, JIANGJIE_DATA_DIR: path.join(root, '数据'), JIANGJIE_CACHE_DIR: path.join(root, '缓存') });
    assert.equal(writablePath(dirs.cache, dirs.app), dirs.cache);
    assert.throws(() => writablePath(path.join(app, 'output', 'clip.mp4'), app), /outside JIANGJIE_APP_ROOT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Python handles Chinese, spaces and apostrophes with hostile host variables removed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "测试 用户 ' "));
  try {
    const python = resolveTool('python');
    const script = path.join(root, '脚本 文件.py');
    const output = path.join(root, "输出 ' 文件.txt");
    const content = '中文与空格 🙂';
    await writeFile(script, [
      'import os, pathlib, sys',
      'assert sys.flags.utf8_mode == 1',
      'assert os.environ["PYTHONIOENCODING"] == "utf-8"',
      'assert "PYTHONPATH" not in os.environ and "PYTHONHOME" not in os.environ',
      'assert "NODE_OPTIONS" not in os.environ and "CONDA_PREFIX" not in os.environ',
      'pathlib.Path(sys.argv[1]).write_text(sys.argv[2], encoding="utf-8")',
      'print(sys.argv[2])',
    ].join('\n'));
    const env = childEnvironment({ ...process.env, PYTHONPATH: root, PYTHONHOME: root, NODE_OPTIONS: '--invalid-option',
      CONDA_PREFIX: root, PYTHONUTF8: '0', PYTHONIOENCODING: 'ascii' }, [python]);
    assert.equal(execFileSync(python, [script, output, content], { env, cwd: root, encoding: 'utf8' }).trim(), content);
    assert.equal(await readFile(output, 'utf8'), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});
