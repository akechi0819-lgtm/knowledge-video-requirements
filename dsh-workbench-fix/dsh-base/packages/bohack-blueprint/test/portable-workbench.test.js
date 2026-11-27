import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, lstat, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { childEnvironment, systemTool } from '../lib/runtime.js'
import { resolveSkillDir } from '../lib/skill-packages.js'

const app = fileURLToPath(new URL('../../../../../', import.meta.url))
const base = path.join(app, 'dsh-workbench-fix/dsh-base')
const launcher = path.join(base, 'start-dsh.mjs')
const entry = path.join(base, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

function boot(t, env, args) {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: app, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        spawnSync(systemTool('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else child.kill('SIGTERM')
    }
    await closed
  })
  child.stderr.setEncoding('utf8')
  let log = ''
  child.stderr.on('data', text => { log += text })
  const lines = createInterface({ input: child.stdout })
  return Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    closed.then(([code]) => { throw new Error('Workbench exited ' + code + '\n' + log) }),
  ]).finally(() => lines.close())
}

test('locked DSH allocates distinct loopback ports and writes projects to the configured user tree', { timeout: 150000 }, async t => {
  assert.ok((await lstat(entry)).isFile(), 'Run npm ci in dsh-base before the integration test')
  const root = await mkdtemp(path.join(os.tmpdir(), "讲界 测试 ' "))
  const token = 'test-internal-identity'
  const appTemplate = path.join(base, '.dsh-home/profiles/workbench')
  const appWorkspace = path.join(base, 'workspace')
  const before = await Promise.all([readdir(appTemplate, { recursive: true }), readdir(appWorkspace, { recursive: true })])
  const templates = [path.join(appTemplate, 'cordis.patch.yml'), path.join(appWorkspace, 'rules/blueprint.md')]
  const templateContents = await Promise.all(templates.map(file => readFile(file)))
  const env = childEnvironment({ ...process.env, JIANGJIE_APP_ROOT: app })
  delete env.DSH_HOME
  delete env.JIANGJIE_DESKTOP_WORKSPACE
  delete env.WORKBENCH_PORT
  env.DSH_INTERNAL_TOKEN = token
  env.NODE_PATH = path.join(root, '冲突 Node')
  env.PYTHONHOME = path.join(root, '冲突 Python')
  env.PYTHONPATH = path.join(root, '冲突 模块')
  const data = i => path.join(root, '漫游 数据 ' + i)
  const cache = i => path.join(root, '本地 缓存 ' + i)
  try {
    await t.test('simultaneous listeners and authenticated workbench traffic', async childTest => {
      const first = boot(childTest, { ...env, JIANGJIE_DATA_DIR: data(1), JIANGJIE_CACHE_DIR: cache(1) }, ['--port', '0'])
      const second = boot(childTest, { ...env, DSH_INTERNAL_TOKEN: '', JIANGJIE_DATA_DIR: data(2), JIANGJIE_CACHE_DIR: cache(2) }, [])
      const [a, b] = await Promise.all([first, second])
      for (const ready of [a, b]) {
        assert.equal(ready.event, 'ready')
        assert.ok(ready.port > 0)
        assert.equal(ready.healthUrl, 'http://127.0.0.1:' + ready.port + '/bohack/api/health')
        const health = await (await fetch(ready.healthUrl)).json()
        assert.equal(health.ok, true)
        assert.equal(health.plugin, '@bohack/blueprint')
      }
      assert.notEqual(a.port, b.port)
      assert.equal((await fetch(new URL('/bohack/api/threads', b.healthUrl))).status, 200)
      const url = new URL('/bohack/api/threads', a.healthUrl)
      const auth = { 'x-dsh-internal-token': token, 'x-bohack-client': 'test' }
      assert.equal((await fetch(url)).status, 401)
      assert.equal((await fetch(url, { headers: { ...auth, Origin: new URL(b.healthUrl).origin } })).status, 403)
      const foreignHost = await new Promise((resolve, reject) => {
        get(url, { headers: { ...auth, Host: 'example.test:' + a.port } }, response => {
          response.resume()
          resolve(response.statusCode)
        }).on('error', reject)
      })
      assert.equal(foreignHost, 403)
      assert.equal((await fetch(url, { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
      const response = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '测试 项目' }) })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      const workspace = path.join(data(1), 'workspace')
      const project = JSON.parse(await readFile(path.join(workspace, 'threads', result.thread.id, 'thread.json'), 'utf8'))
      assert.equal(project.title, '测试 项目')
      for (const i of [1, 2]) {
        const profile = path.join(data(i), 'dsh/profiles/workbench/node_modules/@bohack/blueprint')
        assert.equal((await lstat(profile)).isSymbolicLink(), false)
        assert.ok((await lstat(path.join(cache(i), 'tmp'))).isDirectory())
      }
    })
    assert.deepEqual(await Promise.all([readdir(appTemplate, { recursive: true }), readdir(appWorkspace, { recursive: true })]), before)
    assert.deepEqual(await Promise.all(templates.map(file => readFile(file))), templateContents)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

test('rejects writing its runtime profile under the application root', async () => {
  const result = spawnSync(process.execPath, [launcher, '--setup'], {
    cwd: app, env: { ...childEnvironment(), DSH_HOME: '', JIANGJIE_APP_ROOT: app, JIANGJIE_DATA_DIR: path.join(app, 'forbidden-data') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Runtime output must be outside JIANGJIE_APP_ROOT/)
})

test('discovers pinned project skills directly with an explicit directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), '技能 配置 '))
  const skill = path.join(root, 'andy-vibe-knowledge/skills/vibe-knowledge')
  const previous = process.env.JIANGJIE_SKILLS_DIR
  try {
    await mkdir(skill, { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: vibe-knowledge\ndescription: 直接读取\n---\n')
    process.env.JIANGJIE_SKILLS_DIR = root
    assert.equal(await resolveSkillDir('andy-vibe-knowledge', app), await realpath(skill))
  } finally {
    if (previous === undefined) delete process.env.JIANGJIE_SKILLS_DIR
    else process.env.JIANGJIE_SKILLS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
