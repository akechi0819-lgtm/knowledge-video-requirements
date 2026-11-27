import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const kit = path.resolve(moduleDir, '../../..');

export function emitDesktopDiagnostic(source, text) {
  if (process.env.JIANGJIE_DESKTOP_DIAGNOSTICS !== '1' || !text) return;
  for (const line of String(text).slice(-16384).split(/[\r\n]+/)) {
    if (line.startsWith('JIANGJIE_DIAGNOSTICS ')) process.stderr.write(line + '\n');
    else if (line) process.stderr.write('JIANGJIE_DIAGNOSTICS ' + source + ' ' + line + '\n');
  }
}

export function runtimePaths(env = process.env, appRoot = path.resolve(kit, '..')) {
  const home = env.USERPROFILE || os.homedir();
  const data = env.JIANGJIE_DATA_DIR || (windows ? path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Jiangjie') : env.JIANGJIE_DESKTOP_DATA);
  const cache = env.JIANGJIE_CACHE_DIR || (windows ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Jiangjie', 'cache') : data && path.join(data, 'cache'));
  const app = path.resolve(env.JIANGJIE_APP_ROOT || appRoot);
  return { app, skills: path.resolve(env.JIANGJIE_SKILLS_DIR || path.join(app, '.project-skills')),
    data: data && path.resolve(data), cache: cache && path.resolve(cache) };
}

function physical(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    return path.join(physical(path.dirname(file)), path.basename(file));
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export function writablePath(file, appRoot) {
  if (!appRoot) return file;
  if (inside(physical(appRoot), physical(file))) {
    throw new Error('Runtime output must be outside JIANGJIE_APP_ROOT: ' + file);
  }
  return file;
}

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch { return false; }
}

export function explicitExecutable(key, env = process.env) {
  const value = env[key];
  if (!value) return null;
  if (!path.isAbsolute(value) || !executable(value) || (windows && /\.(cmd|bat)$/i.test(value))) {
    throw new Error(key + ' must name an absolute executable file: ' + value);
  }
  return path.normalize(value);
}

export function systemTool(file, env = process.env) {
  return path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', file);
}

function developerPath(env) {
  const conda = Object.entries(env).filter(([key, value]) => /^CONDA_PREFIX(?:_\d+)?$/i.test(key) && path.isAbsolute(value)).map(([, value]) => value);
  return (env.PATH || '').split(path.delimiter).map(dir => dir.replace(/^"(.*)"$/, '$1'))
    .filter(dir => path.isAbsolute(dir) && !conda.some(root => inside(root, dir))
      && (!windows || !/(?:^|[\\/])(?:ana|mini)conda[^\\/]*|(?:^|[\\/])(?:mamba(?:forge)?|WindowsApps)(?:[\\/]|$)/i.test(dir)));
}

export function findExecutable(name, env = process.env) {
  if (path.isAbsolute(name)) return executable(name) ? name : null;
  if (env.JIANGJIE_APP_ROOT && windows) {
    const managed = path.join(env.JIANGJIE_APP_ROOT, 'runtime/bin', name);
    return executable(managed) ? managed : null;
  }
  return developerPath(env).map(dir => path.join(dir, name)).find(executable) || null;
}

export function childEnvironment(env = process.env, commands = []) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:NODE_OPTIONS|NODE_PATH|PYTHON\w*|CONDA\w*|VIRTUAL_ENV\w*|_CE_(?:CONDA|M)|DSH_INTERNAL_TOKEN|JIANGJIE_READY_ID)$/i.test(key)));
  Object.assign(clean, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' });
  const dirs = commands.filter(command => command && path.isAbsolute(command)).map(command => path.dirname(command));
  if (windows) {
    for (const key of Object.keys(clean)) if (key.toUpperCase() === 'PATH') delete clean[key];
    dirs.push(path.dirname(process.execPath), systemTool('', env), path.dirname(systemTool('', env)));
    if (!env.JIANGJIE_APP_ROOT) dirs.push(...developerPath(env));
  } else {
    dirs.push(...developerPath(env));
  }
  clean.PATH = [...new Set(dirs)].join(path.delimiter);
  return clean;
}

export function resolveTool(tool, env = process.env, kitRoot = kit, required = true) {
  const key = 'VIDEO_' + tool.toUpperCase();
  const explicit = explicitExecutable(key, env);
  if (explicit) return explicit;
  const exe = windows ? tool + '.exe' : tool === 'python' ? 'python3' : tool;
  const runtime = env.JIANGJIE_APP_ROOT && path.join(env.JIANGJIE_APP_ROOT, 'runtime');
  const packaged = runtime && path.join(runtime, tool === 'python' ? 'python' : 'codecs', exe);
  const venv = tool === 'python' && path.join(kitRoot, 'WORK/modules/video/.venv', windows ? 'Scripts/python.exe' : 'bin/python');
  const installer = !windows && tool !== 'python' && path.join(kitRoot, 'node_modules', '@' + tool + '-installer', process.platform + '-' + process.arch, exe);
  const programs = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs/Python');
  const installedPython = windows && tool === 'python' && !runtime && programs && fs.existsSync(programs)
    ? fs.readdirSync(programs).filter(name => /^Python\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => path.join(programs, name, exe))
    : [];
  const found = [packaged, !runtime && venv, installer, ...installedPython,
    ...(!runtime ? developerPath(env).map(dir => path.join(dir, exe)) : [])].find(file => file && executable(file));
  if (found) return found;
  if (required) throw new Error('No usable ' + tool + ' found. Set ' + key + ' to its absolute executable path.');
  return null;
}

export function resolveBrowser(env = process.env) {
  const explicit = explicitExecutable('VIDEO_EDGE_PATH', env) || explicitExecutable('VIDEO_BROWSER', env);
  if (explicit) return explicit;
  const bundled = env.JIANGJIE_APP_ROOT && path.join(env.JIANGJIE_APP_ROOT, 'runtime/chromium/chrome.exe');
  if (bundled && executable(bundled)) return bundled;
  if (windows) {
    const query = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      'foreach ($hive in "CurrentUser", "LocalMachine") {',
      '  foreach ($view in "Registry64", "Registry32") {',
      '    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)',
      "    $key = $base.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe')",
      '    if ($key) { try { $key.GetValue("") } finally { $key.Dispose() } }',
      '    $base.Dispose()',
      '  }',
      '}',
    ].join('\n');
    const result = spawnSync(systemTool('WindowsPowerShell/v1.0/powershell.exe', env),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')],
      { env: childEnvironment(env), encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const registry = (result.stdout || '').split(/\r?\n/).map(line => line.trim().replace(/^"(.*)"$/, '$1'));
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    return [...registry, ...roots.map(dir => path.join(dir, 'Microsoft/Edge/Application/msedge.exe')),
      ...(!env.JIANGJIE_APP_ROOT ? roots.map(dir => path.join(dir, 'Google/Chrome/Application/chrome.exe')) : [])
    ].find(file => path.isAbsolute(file) && executable(file)) || null;
  }
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(executable) || null;
}
