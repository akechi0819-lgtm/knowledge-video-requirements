import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { childEnvironment } from './runtime.js'

export function credentialScope(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

export function desktopCredentialHelper(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !env.JIANGJIE_DESKTOP_WORKSPACE) return undefined
  if (!env.BOHACK_DESKTOP_KEYCHAIN_HELPER) throw new Error('Windows 桌面凭据存储尚未配置。')
  return env.BOHACK_DESKTOP_KEYCHAIN_HELPER
}

export function createCredentialStore(helper, scope) {
  function call(action, keys) {
    return new Promise((resolve, reject) => {
      const failure = () => new Error('无法访问桌面凭据存储。请重试或重新配置凭据。')
      const child = spawn(helper, ['--desktop-settings-keychain'], {
        env: childEnvironment(process.env, [helper]),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 10000,
      })
      let output = ''
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk
        if (output.length > 1024 * 1024) child.kill()
      })
      child.on('error', () => reject(failure()))
      child.stdin.on('error', () => {})
      child.on('close', code => {
        if (code !== 0) return reject(failure())
        if (action === 'write') return resolve()
        try {
          const value = JSON.parse(output)
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(key => typeof key !== 'string')) throw failure()
          resolve(value)
        } catch { reject(failure()) }
      })
      child.stdin.end(JSON.stringify({ action, scope, keys }))
    })
  }
  return { read: () => call('read'), write: keys => call('write', keys) }
}
