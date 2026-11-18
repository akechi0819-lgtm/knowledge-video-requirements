import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = fileURLToPath(new URL('../dsh-workbench-fix/dsh-base/', import.meta.url))
const cli = process.env.DSH_BIN || path.join(base, 'node_modules/.bin/dsh')
const origin = new URL(process.env.ORIGIN).origin
const state = path.resolve(process.env.WORKER_STATE_DIR || os.tmpdir())
await mkdir(state, { recursive: true })
const home = await mkdtemp(path.join(state, 'dsh-worker-'))
const profile = path.join(home, 'profiles/workbench')
const plugins = path.join(profile, 'node_modules/@bohack')
await mkdir(plugins, { recursive: true })
await symlink(path.join(base, 'packages/bohack-blueprint'), path.join(plugins, 'blueprint'))
const model = 'mimo-v2.6-pro'
const baseURL = 'https://api.xiaomimimo.com/v1'
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@bohack/blueprint']
// The stock credential provider snapshots the launch environment. This worker's
// MiMo reference must observe settings changes on every DSH model request.
const runtime = createRequire(await realpath(cli))
const adapter = path.join(plugins, 'worker-credentials')
await mkdir(adapter)
await writeFile(path.join(adapter, 'package.json'), JSON.stringify({ name: '@bohack/worker-credentials', type: 'module', main: 'index.js' }))
await writeFile(path.join(adapter, 'index.js'), `import LocalCredentials from ${JSON.stringify(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-credentials-local')).href)}
export default class WorkerCredentials extends LocalCredentials {
  async resolve(ref) {
    if (ref !== 'MIMO_API_KEY') return super.resolve(ref)
    const value = process.env.MIMO_API_KEY
    return value ? { value, source: 'env' } : undefined
  }
}
`)
const patch = [
  { id: 'credentials', disabled: true },
  { insert: [{ id: 'worker-credentials', name: '@bohack/worker-credentials' }] },
  { id: 'llm-pi-ai', config: { providers: { 'cloud-mimo': { api: 'openai-completions', baseURL, apiKeyEnv: 'MIMO_API_KEY', models: [{ id: model }] } } } },
  { id: 'bohack', config: { provider: 'cloud-mimo', model, workspace: path.join(base, 'workspace'), multiuser: { origin, temporaryRoot: path.join(state, 'bohack-sessions'), ttlMs: 86400000 } } },
]
for (const [name, value] of Object.entries({ 'package.json': { private: true, name: 'cloud-workbench', dsh: { profile: { bundles } } }, 'cordis.yml': [], 'cloud.patch.yml': patch })) {
  await writeFile(path.join(profile, name), JSON.stringify(value))
}
await copyFile(path.join(base, '.dsh-home/profiles/workbench/cordis.patch.yml'), path.join(profile, 'cordis.patch.yml'))
const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: home, BOHACK_CLOUD_MODEL: model }
for (const name of ['MIMO_API_KEY', 'VIDEO_PYTHON', 'VIDEO_KIT_DIR']) {
  if (process.env[name]) env[name] = process.env[name]
}
const innerPort = 3080
const child = spawn(cli, ['--profile', 'workbench', '--patch', path.join(profile, 'cloud.patch.yml'), '--no-open', '--port', String(innerPort)], { cwd: home, env, stdio: 'inherit' })
// DSH accepts concrete bind addresses only. Expose just the product route.
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname !== '/bohack' && !pathname.startsWith('/bohack/')) { res.writeHead(404).end(); return }
  const upstream = http.request({ host: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:' + innerPort } }, reply => {
    res.writeHead(reply.statusCode, reply.headers)
    reply.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end() })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
server.on('error', error => { console.error(error.message); process.exitCode = 1; child.kill() })

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('close', async code => {
  server.close()
  await rm(home, { recursive: true, force: true })
  process.exitCode ||= code ?? 0
})

while (child.exitCode === null && child.signalCode === null && child.pid) {
  let ready = false
  try {
    const response = await fetch('http://127.0.0.1:' + innerPort + '/bohack/', { signal: AbortSignal.timeout(1000) })
    ready = response.status === 200
    await response.body?.cancel()
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError') throw error
  }
  if (ready) {
    server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0')
    break
  }
  await delay(150)
}
