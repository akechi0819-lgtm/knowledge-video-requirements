import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [repo, scratch, cache, registry] = process.argv.slice(2);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));
const { node, python, ffmpeg } = readJson(path.join(import.meta.dirname, 'runtime-manifest.json')).assets;
const payload = path.join(scratch, 'payload');
const relativeDsh = 'dsh-workbench-fix/dsh-base';
const relativeVideo = 'video-kit';
const projectPaths = [relativeDsh, relativeVideo];
const npmHosts = ['registry.npmjs.org', 'registry.npmmirror.com'];
const selectedHost = new URL(registry).host;
const nodeArchiveRoot = path.join(scratch, node.archive.replace(/\.zip$/, ''));
const npmRoot = path.join(nodeArchiveRoot, 'node_modules/npm');
const npmVersion = readJson(path.join(npmRoot, 'package.json')).version;
const npmCli = path.join(npmRoot, 'bin/npm-cli.js');
const systemPath = path.join(process.env.SystemRoot, 'System32');

// Keep proxy and certificate settings for download tools. Apart from that each
// package manager uses only the inputs and config supplied by this build.
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:path$|node_(?:options|path)$|npm_config_|pip_|python)/i.test(key)));
isolatedEnv.Path = systemPath;
const userNpmrc = path.join(scratch, 'user.npmrc');
const globalNpmrc = path.join(scratch, 'global.npmrc');

function run(exe, args, { cwd = scratch, env = isolatedEnv, capture = false, timeout = 120000 } = {}) {
  return execFileSync(exe, args, {
    cwd, env, windowsHide: true, timeout, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
    else throw new Error('Unexpected link or special file: ' + file);
  }
  return files;
}

function relativeTo(directory, file) {
  return path.relative(directory, file).split(path.sep).join('/');
}

function collectPackageDirs(modules) {
  const dirs = [];
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    assert(entry.isDirectory(), 'Unexpected entry in node_modules: ' + entry.name);
    const target = path.join(modules, entry.name);
    const packages = entry.name.startsWith('@')
      ? fs.readdirSync(target).map(name => path.join(target, name))
      : [target];
    for (const directory of packages) {
      assert(fs.lstatSync(directory).isDirectory(), 'Expected a real package directory: ' + directory);
      dirs.push(directory);
      const nested = path.join(directory, 'node_modules');
      if (fs.existsSync(nested)) dirs.push(...collectPackageDirs(nested));
    }
  }
  return dirs;
}

function installNode(relative) {
  const source = path.join(repo, relative);
  const target = path.join(payload, relative);
  fs.mkdirSync(target, { recursive: true });
  const packageFile = path.join(source, 'package.json');
  fs.copyFileSync(packageFile, path.join(target, 'package.json'));
  const lockFile = path.join(source, 'package-lock.json');
  const lock = readJson(lockFile);
  assert.equal(lock.lockfileVersion, 3);
  for (const [location, dependency] of Object.entries(lock.packages)) {
    if (!location) continue;
    assert(/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(dependency.integrity),
      'Missing or unsupported registry integrity for ' + location);
    const url = new URL(dependency.resolved);
    assert(url.protocol === 'https:' && npmHosts.includes(url.host) && !url.username && !url.password &&
      !url.search && !url.hash, 'Unexpected npm tarball URL for ' + location);
    url.host = selectedHost;
    dependency.resolved = url.href;
  }
  const stagedLock = path.join(target, 'package-lock.json');
  writeJson(stagedLock, lock);
  console.log('Installing locked npm production dependencies for ' + relative);
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit',
    '--no-fund', '--no-progress', '--no-update-notifier', '--prefer-offline', '--replace-registry-host=never',
    '--userconfig=' + userNpmrc, '--globalconfig=' + globalNpmrc, '--registry=' + registry,
    '--cache=' + path.join(cache, 'npm')], { cwd: target, timeout: 20 * 60 * 1000, env: {
    ...isolatedEnv, Path: path.dirname(process.execPath) + path.delimiter + systemPath,
  } });

  const modules = path.join(target, 'node_modules');
  const installed = {};
  for (const directory of collectPackageDirs(modules).sort()) {
    const location = relativeTo(target, directory);
    const manifest = readJson(path.join(directory, 'package.json'));
    const expected = lock.packages[location];
    assert(expected && !expected.dev && expected.version === manifest.version, 'Unexpected installed package: ' + location);
    installed[location] = { name: manifest.name, version: manifest.version, integrity: expected.integrity };
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const isDocs = entry.isDirectory() && /^(?:doc|docs|test|tests|__tests__)$/i.test(entry.name);
      const isReadme = entry.isFile() && /^readme(?:\.(?:md|txt|rst))?$/i.test(entry.name) &&
        entries.some(other => /^licen[cs]e(?:[.-]|$)/i.test(other.name));
      if (!isDocs && !isReadme) continue;
      const file = path.join(directory, entry.name);
      if (isDocs) {
        for (const child of walkFiles(file)) {
          if (!/^(?:licen[cs]e|notice|copying|copyright)(?:[.-]|$)/i.test(path.basename(child))) fs.unlinkSync(child);
        }
      } else fs.unlinkSync(file);
    }
  }
  for (const [location, dependency] of Object.entries(lock.packages)) {
    if (!location || dependency.dev || dependency.optional) continue;
    const allowed = (values, value) => !values || (!values.includes('!' + value) &&
      (values.includes(value) || values.every(item => item.startsWith('!'))));
    if (!allowed(dependency.os, 'win32') || !allowed(dependency.cpu, 'x64') || dependency.libc) continue;
    const parentMarker = location.lastIndexOf('/node_modules/');
    if (parentMarker >= 0 && !installed[location.slice(0, parentMarker)]) continue;
    assert(installed[location], 'Missing Windows production dependency: ' + location);
  }
  for (const file of walkFiles(modules)) {
    if (file.endsWith('.map')) fs.unlinkSync(file);
  }
  // npm's hidden lock contains source URLs that differ between registry choices.
  fs.rmSync(path.join(modules, '.package-lock.json'), { force: true });
  fs.unlinkSync(path.join(target, 'package.json'));
  fs.unlinkSync(stagedLock);
  return { version: lock.version, packageJsonSha256: hashFile(packageFile), lockSha256: hashFile(lockFile), packages: installed };
}

function installPython(pythonRoot) {
  const lockFile = path.join(import.meta.dirname, 'python-requirements.lock.txt');
  const requirements = path.join(repo, relativeVideo, 'requirements.txt');
  const pythonExe = path.join(pythonRoot, 'python.exe');
  const pipEnv = { ...isolatedEnv, PIP_CONFIG_FILE: os.devNull };
  const runPython = args => run(pythonExe, ['-I', '-B', ...args], { env: pipEnv, timeout: 20 * 60 * 1000 });
  const reportFile = path.join(scratch, 'pip-report.json');
  console.log('Installing locked Windows Python wheels');
  runPython(['-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-input',
    '--index-url', 'https://pypi.org/simple', '--cache-dir', path.join(cache, 'pip'),
    '--require-hashes', '--only-binary=:all:', '--no-compile', '--no-warn-script-location',
    '--report', reportFile, '-r', lockFile]);
  runPython(['-m', 'pip', 'check']);
  // Catch drift when the development input changes without updating the release lock.
  runPython(['-c', `
import importlib.metadata as metadata
from pathlib import Path
from pip._vendor.packaging.requirements import Requirement
import sys
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = line.partition("#")[0].strip()
    if line:
        requirement = Requirement(line)
        if requirement.marker is None or requirement.marker.evaluate():
            assert requirement.specifier.contains(metadata.version(requirement.name)), requirement
`, requirements]);
  const report = readJson(reportFile);
  const packages = report.install.map(item => ({
    name: item.metadata.name, version: item.metadata.version,
    wheel: path.posix.basename(new URL(item.download_info.url).pathname),
    sha256: item.download_info.archive_info.hashes.sha256,
  })).sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase(), 'en'));
  const locked = fs.readFileSync(lockFile, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const wheelPin = ({ name, version, sha256: hash }) =>
    name.toLowerCase().replace(/[-_.]+/g, '-') + '==' + version + ' --hash=sha256:' + hash;
  assert.deepEqual(packages.map(wheelPin).sort(), locked.sort(), 'Installed wheels differ from the Windows wheel lock');

  // distlib console launchers embed the interpreter's absolute install path.
  // Video-kit uses python.exe with scripts or -m, so drop those launchers.
  const scripts = path.join(pythonRoot, 'Scripts');
  if (fs.existsSync(scripts)) {
    for (const entry of fs.readdirSync(scripts, { withFileTypes: true })) {
      assert(entry.isFile(), 'Unexpected Python Scripts entry: ' + entry.name);
      fs.unlinkSync(path.join(scripts, entry.name));
    }
    fs.rmdirSync(scripts);
  }
  for (const file of walkFiles(pythonRoot)) {
    if (/\.(?:pyc|pyo)$/.test(file) || path.basename(file) === 'direct_url.json') fs.unlinkSync(file);
  }
  // RECORD entries for removed launchers contain hashes that vary with the
  // original installation path. Preserve the metadata for files we ship.
  runPython(['-c', `
import csv
from pathlib import Path
import sys
site = Path(sys.prefix) / "Lib" / "site-packages"
for record in site.glob("*.dist-info/RECORD"):
    with record.open(encoding="utf-8", newline="") as source:
        rows = list(csv.reader(source))
    retained = [row for row in rows if (site / row[0]).is_file()]
    if retained != rows:
        with record.open("w", encoding="utf-8", newline="") as target:
            csv.writer(target).writerows(retained)
`]);
  return { pipVersion: report.pip_version, requirementsSha256: hashFile(requirements), lockSha256: hashFile(lockFile), packages };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inventory(root) {
  const hostPaths = [...new Set([repo, cache, scratch, os.tmpdir(), process.env.USERPROFILE].filter(Boolean))];
  const patterns = hostPaths.flatMap(host => {
    const slash = host.split('\\').join('/');
    const paths = new Set([host, slash, host.replaceAll('\\', '\\\\'), encodeURI(slash)]);
    return [...paths].flatMap(value => ['utf8', 'utf16le'].map(encoding =>
      escapeRegex(Buffer.from(value, encoding).toString('latin1'))));
  });
  const hostPath = new RegExp(patterns.join('|'), 'i');
  const paths = walkFiles(root).sort((left, right) => {
    const a = relativeTo(root, left);
    const b = relativeTo(root, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const tree = createHash('sha256');
  let bytes = 0;
  for (const file of paths) {
    const content = fs.readFileSync(file);
    const relative = relativeTo(root, file);
    assert(!hostPath.test(content.toString('latin1')), 'Build-host path embedded in ' + relative);
    if (file.endsWith('.pth')) {
      for (const line of content.toString('utf8').split(/\r?\n/)) {
        const entry = line.trim();
        if (entry && !entry.startsWith('#') && !/^import\s/.test(entry)) {
          assert(!path.isAbsolute(entry) && !/^[a-z]:/i.test(entry), 'Absolute Python site path in ' + relative);
        }
      }
    }
    tree.update(relative + '\0' + content.length + '\0' + sha256(content) + '\n');
    bytes += content.length;
  }
  return { files: paths.length, bytes, treeSha256: tree.digest('hex') };
}

function smoke(root) {
  const nodeExe = path.join(root, 'runtime/node/node.exe');
  const pythonExe = path.join(root, 'runtime/python/python.exe');
  const ffmpegExe = path.join(root, 'runtime/codecs/ffmpeg.exe');
  const ffprobeExe = path.join(root, 'runtime/codecs/ffprobe.exe');
  const dshRoot = path.join(root, relativeDsh);
  const dsh = readJson(path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/package.json'));
  const dshBin = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
  assert.equal(dsh.bin.dsh, 'lib/bin.js');
  assert.equal(run(nodeExe, ['-p', 'process.version + " " + process.arch'], { capture: true }).trim(), 'v' + node.version + ' x64');
  assert.equal(run(nodeExe, [path.join(dshRoot, dshBin), '--version'], { capture: true }).trim(), dsh.version);
  run(nodeExe, ['-e', `
const assert = require('node:assert/strict');
const koffi = require('koffi');
assert.equal(koffi.load('kernel32.dll').func('uint32_t GetCurrentProcessId()')(), process.pid);
require('node-pty');
const conpty = require('./node_modules/node-pty/lib/utils.js').loadNativeModule('conpty').module;
assert.equal(typeof conpty.startProcess, 'function');
require('@deepseek-ai/dsh-subprocess-local');
require('sharp')({create:{width:1,height:1,channels:3,background:'#123456'}}).png().toBuffer()
  .then(png => assert.equal(png.toString('ascii', 1, 4), 'PNG'));
`], { cwd: dshRoot });
  run(nodeExe, ['-e', "require('playwright-core'); require('@remotion/compositor-win32-x64-msvc'); require('esbuild').transformSync('let x = 1');"],
    { cwd: path.join(root, relativeVideo) });
  run(pythonExe, ['-I', '-B', '-c', `
import importlib.metadata as metadata
from pathlib import Path
import ssl
import sys
import edge_tts
import numpy
import scipy.signal
from PIL import Image
from playwright.sync_api import sync_playwright
exe = Path(sys.executable).resolve()
assert Path(sys.prefix).resolve() == exe.parent == Path(sys.base_prefix).resolve()
assert sys.version.split()[0] == sys.argv[1]
assert all(Path(entry).resolve().is_relative_to(exe.parent) for entry in sys.path), sys.path
assert all(Path(dist.locate_file("")).resolve().is_relative_to(exe.parent) for dist in metadata.distributions())
ssl.create_default_context()
assert Image.new("RGB", (1, 1)).size == (1, 1)
assert scipy.signal.convolve(numpy.array([1, 2]), [1]).tolist() == [1, 2]
with sync_playwright() as driver:
    assert driver.chromium.name == "chromium"
`, python.version]);
  for (const [name, exe] of [['ffmpeg', ffmpegExe], ['ffprobe', ffprobeExe]]) {
    const version = run(exe, ['-version'], { capture: true });
    assert(version.startsWith(name + ' version ' + ffmpeg.version + '-essentials_build'), 'Unexpected ' + name + ' version');
  }
  const encoders = run(ffmpegExe, ['-hide_banner', '-encoders'], { capture: true });
  for (const encoder of ['libx264', 'aac', 'libmp3lame', 'png']) {
    assert(new RegExp('^\\s+\\w[.\\w]+\\s+' + encoder + '\\s', 'm').test(encoders), 'Missing FFmpeg encoder: ' + encoder);
  }
  const sample = path.join(scratch, 'codec-smoke.mp4');
  run(ffmpegExe, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=0.3',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', sample]);
  const { streams } = JSON.parse(run(ffprobeExe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', sample], { capture: true }));
  assert.deepEqual(streams.map(stream => stream.codec_name).sort(), ['aac', 'h264']);
  return { entry: relativeDsh + '/' + dshBin, version: dsh.version };
}

const runtime = path.join(payload, 'runtime');
const nodeRoot = path.join(runtime, 'node');
const pythonRoot = path.join(runtime, 'python');
const codecsRoot = path.join(runtime, 'codecs');
fs.mkdirSync(nodeRoot, { recursive: true });
fs.mkdirSync(codecsRoot);
for (const name of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(nodeArchiveRoot, name), path.join(nodeRoot, name));
const ffmpegRoot = path.join(scratch, ffmpeg.archive.replace(/\.zip$/, ''));
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(ffmpegRoot, 'bin', name), path.join(codecsRoot, name));
fs.copyFileSync(path.join(ffmpegRoot, 'LICENSE'), path.join(codecsRoot, 'LICENSE'));
fs.renameSync(path.join(scratch, 'python'), pythonRoot);

const nodeModules = Object.fromEntries(projectPaths.map(project => [project, installNode(project)]));
const pythonWheels = installPython(pythonRoot);
const relocated = path.join(scratch, "迁移 runtime ' smoke");
fs.renameSync(payload, relocated);
console.log('Validating relocated runtime with only Windows system tools on PATH');
const dsh = smoke(relocated);
const components = {
  node: { ...node, path: 'runtime/node', ...inventory(path.join(relocated, 'runtime/node')) },
  python: { ...python, path: 'runtime/python', ...inventory(path.join(relocated, 'runtime/python')), ...pythonWheels },
  ffmpeg: { ...ffmpeg, path: 'runtime/codecs', ...inventory(path.join(relocated, 'runtime/codecs')) },
};
for (const [project, installed] of Object.entries(nodeModules)) {
  const location = project + '/node_modules';
  components[project] = { path: location, ...inventory(path.join(relocated, location)), ...installed };
}
const top = fs.readdirSync(relocated).sort();
assert.deepEqual(top, ['dsh-workbench-fix', 'runtime', 'video-kit']);
assert.deepEqual(fs.readdirSync(path.join(relocated, 'runtime')).sort(), ['codecs', 'node', 'python']);
assert.deepEqual(fs.readdirSync(path.join(relocated, 'runtime/node')).sort(), ['LICENSE', 'node.exe']);
assert.deepEqual(fs.readdirSync(path.join(relocated, 'runtime/codecs')).sort(), ['LICENSE', 'ffmpeg.exe', 'ffprobe.exe']);
for (const project of projectPaths) {
  assert.deepEqual(fs.readdirSync(path.join(relocated, project)), ['node_modules']);
}
const output = path.join(repo, 'build/win-runtime');
const previous = path.join(scratch, 'previous');
const totalBytes = Object.values(components).reduce((total, component) => total + component.bytes, 0);
writeJson(path.join(relocated, 'runtime-bom.json'), {
  schemaVersion: 1, platform: 'win32-x64', nodeStrategy: 'standalone',
  sourceManifestSha256: hashFile(path.join(import.meta.dirname, 'runtime-manifest.json')),
  payloadBytes: totalBytes, npmVersion, dsh,
  skillPins: readJson(path.join(scratch, 'skills.json')), components,
});
for (const file of walkFiles(relocated)) fs.chmodSync(file, 0o444);

function moveForPublish(from, to) {
  // Windows antivirus and freshly exited media helpers can hold a share lock.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 29 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(sleeper, 0, 0, 500);
    }
  }
}

const old = fs.lstatSync(output, { throwIfNoEntry: false });
if (old) {
  assert(old.isDirectory(), 'Refusing to replace an unexpected build/win-runtime entry');
  const previousBom = readJson(path.join(output, 'runtime-bom.json'));
  assert(previousBom.schemaVersion === 1 && previousBom.platform === 'win32-x64' && previousBom.components,
    'Refusing to replace an unrecognized runtime directory');
  moveForPublish(output, previous);
}
try {
  moveForPublish(relocated, output);
} catch (error) {
  if (old) {
    try {
      moveForPublish(previous, output);
    } catch (restoreError) {
      fs.writeFileSync(path.join(scratch, 'preserve-staging'), '');
      throw new AggregateError([error, restoreError], 'Previous runtime preserved at ' + previous);
    }
  }
  fs.writeFileSync(path.join(scratch, 'preserve-staging'), '');
  throw new Error('Validated runtime preserved at ' + relocated, { cause: error });
}
console.log('Assembled build/win-runtime (' + totalBytes + ' payload bytes, plus runtime-bom.json)');
