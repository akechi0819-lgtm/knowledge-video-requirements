import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// An empty cwd keeps the headless task outside project instructions.
export async function callDsh(messages) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-scene-'))
  try {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env }
      const child = spawn('dsh', ['headless', '--json', '--approval-policy', 'never', '-'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
      child.on('error', reject)
      child.on('close', code => {
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
