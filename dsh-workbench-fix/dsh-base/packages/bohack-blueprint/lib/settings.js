import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const queues = new Map()
async function exclusive(key, task) {
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task); queues.set(key, current)
  try { return await current } finally { if (queues.get(key) === current) queues.delete(key) }
}

// A trailing slash is the same endpoint, but a different origin must never inherit the saved key.
function normalizeEndpoint(value) {
  try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.href } catch { return value }
}

export function createSettings(workspace, config = {}) {
  const settingsRoot = path.resolve(config.settingsRoot || workspace)
  const file = path.join(settingsRoot, 'settings.json')
  const warn = (...args) => { try { config.logger?.warn?.('[bohack/settings]', ...args) } catch { /* ignore */ } }
  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (e) {
      if (e.code === 'ENOENT') return {}
      if (e instanceof SyntaxError) { warn('settings.json 不是有效 JSON，按空设置处理：', String(e.message)); return {} }
      throw e
    }
  }
  async function get() {
    const settings = await load()
    return { ...Object.fromEntries(['model', 'tts', 'image'].map(k => [k, { ...settings[k], apiKey: undefined, hasApiKey: !!settings[k]?.apiKey }])) }
  }
  async function update(input = {}) {
    if ('skills' in input) throw new Error('通用制作方法已默认启用，无需设置技能开关。')
    return exclusive(file, async () => {
      const settings = await load()
      for (const k of ['model', 'tts', 'image']) {
        if (!input[k]) continue
        const previous = settings[k] || {}
        const fields = k === 'tts' ? ['baseUrl', 'model', 'voice', 'protocol'] : ['baseUrl', 'model']
        settings[k] = Object.fromEntries(fields.map(field => [field, String(input[k][field] ?? previous[field] ?? '')]))
        const sameEndpoint = normalizeEndpoint(settings[k].baseUrl) === normalizeEndpoint(previous.baseUrl || '')
        settings[k].apiKey = input[k].clearApiKey ? '' : String(input[k].apiKey || (sameEndpoint ? previous.apiKey : '') || '')
        if (k === 'tts' && settings[k].protocol && !['speech', 'mimo'].includes(settings[k].protocol)) throw new Error('不支持的配音协议')
      }
      await mkdir(settingsRoot, { recursive: true })
      await writeFile(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
      // mode only applies when the file is created, so an existing settings.json needs an explicit chmod.
      await chmod(file, 0o600).catch(() => {})
      return get()
    })
  }
  return { get, update, load }
}
