import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkCloudEndpoint, mimoBaseUrl } from './models.js'

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

export function resolveAgent(settings, kind, defaults = {}) {
  if (process.env.BOHACK_CLOUD_MODEL) return { provider: 'cloud-mimo', model: process.env.BOHACK_CLOUD_MODEL }
  const saved = settings[kind] || {}
  return { provider: saved.provider || defaults.provider, model: saved.model || defaults.model }
}

export function createSettings(workspace, config = {}) {
  const settingsRoot = path.resolve(config.settingsRoot || workspace)
  const file = path.join(settingsRoot, 'settings.json')
  // A server session can share this map between its service and engines while
  // keeping credentials out of the persistent settings file.
  const temporaryKeys = config.temporaryKeys
  const warn = (...args) => { try { config.logger?.warn?.('[bohack/settings]', ...args) } catch { /* ignore */ } }
  async function readSettings() {
    try {
      const settings = JSON.parse(await readFile(file, 'utf8'))
      if (temporaryKeys) {
        for (const [kind, value] of Object.entries(settings)) {
          if (value && typeof value === 'object') {
            delete value.apiKey
            if (temporaryKeys.has(kind)) value.apiKey = temporaryKeys.get(kind)
          }
        }
      }
      return settings
    }
    catch (e) {
      if (e.code === 'ENOENT') return {}
      if (e instanceof SyntaxError) { warn('settings.json 不是有效 JSON，按空设置处理：', String(e.message)); return {} }
      throw e
    }
  }
  async function load() {
    const settings = await readSettings()
    const model = process.env.BOHACK_CLOUD_MODEL
    if (model) {
      settings.model = { baseUrl: mimoBaseUrl, model, apiKey: process.env.MIMO_API_KEY || '' }
      settings.tts = { baseUrl: mimoBaseUrl, model: 'mimo-v2.5-tts', protocol: 'mimo', voice: '茉莉', ...settings.tts }
      for (const role of ['requirementAgent', 'blueprintAgent', 'videoAgent']) settings[role] = resolveAgent(settings, role)
    }
    return settings
  }
  async function get() {
    const settings = await load()
    return { ...Object.fromEntries(['model', 'tts', 'image', 'requirementAgent', 'blueprintAgent', 'videoAgent', 'assetModel', 'previewModel', 'styleAnalysisModel'].map(k => [k, { ...settings[k], apiKey: undefined, hasApiKey: !!settings[k]?.apiKey }])) }
  }
  async function update(input = {}) {
    if ('skills' in input) throw new Error('通用制作方法已默认启用，无需设置技能开关。')
    return exclusive(file, async () => {
      const settings = await load()
      for (const k of ['model', 'tts', 'image', 'requirementAgent', 'blueprintAgent', 'videoAgent', 'assetModel', 'previewModel', 'styleAnalysisModel']) {
        if (!input[k]) continue
        checkCloudEndpoint(input[k].baseUrl)
        if (process.env.BOHACK_CLOUD_MODEL && k === 'model' && input[k].model && input[k].model !== process.env.BOHACK_CLOUD_MODEL) throw new Error('云工作台当前模型为 ' + process.env.BOHACK_CLOUD_MODEL)
        const previous = settings[k] || {}
        const fields = k.endsWith('Agent') ? ['provider', 'model'] : k === 'tts' ? ['baseUrl', 'model', 'voice', 'protocol'] : ['baseUrl', 'model']
        settings[k] = Object.fromEntries(fields.map(field => [field, String(input[k][field] ?? previous[field] ?? '')]))
        if (k.endsWith('Agent')) continue
        const sameEndpoint = normalizeEndpoint(settings[k].baseUrl) === normalizeEndpoint(previous.baseUrl || '')
        settings[k].apiKey = input[k].clearApiKey ? '' : String(input[k].apiKey || (sameEndpoint ? previous.apiKey : '') || '')
        if (k === 'tts' && settings[k].protocol && !['speech', 'mimo'].includes(settings[k].protocol)) throw new Error('不支持的配音协议')
      }
      await mkdir(settingsRoot, { recursive: true })
      const persisted = structuredClone(settings)
      if (temporaryKeys) {
        for (const value of Object.values(persisted)) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'apiKey')) continue
          delete value.apiKey
        }
      }
      await writeFile(file, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 })
      if (temporaryKeys) {
        for (const [kind, value] of Object.entries(settings)) {
          if (value && typeof value === 'object' && Object.hasOwn(value, 'apiKey')) temporaryKeys.set(kind, value.apiKey)
        }
      }
      if (process.env.BOHACK_CLOUD_MODEL && input.model) {
        if (settings.model.apiKey) process.env.MIMO_API_KEY = settings.model.apiKey
        else delete process.env.MIMO_API_KEY
      }
      // mode only applies when the file is created, so an existing settings.json needs an explicit chmod.
      await chmod(file, 0o600).catch(() => {})
      return get()
    })
  }
  return { get, update, load }
}
