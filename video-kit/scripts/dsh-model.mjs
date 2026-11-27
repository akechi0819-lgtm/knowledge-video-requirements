import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnvironment, findExecutable, runtimePaths, writablePath } from '../WORK/modules/video/runtime.mjs'

// An empty cwd keeps the headless task outside project instructions.
export async function callDsh(messages) {
  const runtime = runtimePaths()
  const bundled = fileURLToPath(new URL('../../dsh-workbench-fix/dsh-base/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
  const windows = process.platform === 'win32'
  let cli = process.env.DSH_CLI || (windows ? bundled : 'dsh')
  if (windows && path.basename(cli).toLowerCase() === 'dsh.cmd') {
    // Recognize the source and npm shims without invoking cmd.exe.
    if (cli === 'dsh.cmd') cli = bundled
    else {
      const parent = path.dirname(cli)
      cli = path.resolve(parent, path.basename(parent) === '.bin' ? '../@deepseek-ai/dsh/lib/bin.js' : 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    }
  }
  const entry = findExecutable(cli)
  if (!entry || (windows && /\.(cmd|bat)$/i.test(entry))) throw new Error('Set DSH_CLI to the DSH JavaScript bin or executable: ' + cli)
  const js = /\.(?:c?js|mjs)$/i.test(entry)
  const command = js ? process.execPath : entry
  const args = ['headless', '--json', '--approval-policy', 'never', '-']
  if (js) args.unshift(entry)
  const tmp = runtime.cache ? path.join(runtime.cache, 'tmp') : os.tmpdir()
  await mkdir(writablePath(tmp, process.env.JIANGJIE_APP_ROOT && runtime.app), { recursive: true })
  const cwd = await mkdtemp(path.join(tmp, 'dsh-scene-'))
  try {
    return await new Promise((resolve, reject) => {
      const env = childEnvironment(process.env, [command])
      const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdin.on('error', reject)
      const watchdog = setTimeout(() => child.kill(), 180000)
      let stdout = '', stderr = '', pending = '', toolUsed = false
      child.stdout.on('data', chunk => {
        stdout += chunk
        pending += chunk
        const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (/tool/i.test(String(event.type || ''))) { toolUsed = true; child.kill() }
          } catch { /* report malformed output on close */ }
        }
      })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => { clearTimeout(watchdog); reject(error) })
      child.on('close', code => {
        clearTimeout(watchdog)
        if (toolUsed) return reject(new Error('DSH attempted to use a tool; generation stopped.'))
        if (code !== 0) return reject(new Error(`DSH request failed: ${stderr.trim()}`))
        try {
          const events = stdout.trim().split('\n').map(line => JSON.parse(line))
          const final = events.findLast(event => event.type === 'final')
          if (!final || final.reason?.kind !== 'completed') throw new Error('No completed final response')
          resolve(final.text)
        } catch (error) { reject(new Error(`Invalid DSH response: ${error.message}`)) }
      })
      child.stdin.end(`只按下列消息生成 JSON，不要调用任何工具。\n${JSON.stringify(messages)}`)
    })
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
