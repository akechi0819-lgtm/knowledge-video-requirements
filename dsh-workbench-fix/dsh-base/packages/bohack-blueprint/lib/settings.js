import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function createSettings(workspace, config = {}) {
  const settingsRoot = path.resolve(config.settingsRoot || workspace)
  const file = path.join(settingsRoot, 'settings.json')
  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e }
  }
  async function get() {
    const settings = await load()
    return { ...Object.fromEntries(['model', 'tts', 'image'].map(k => [k, { ...settings[k], apiKey: undefined, hasApiKey: !!settings[k]?.apiKey }])) }
  }
  async function update(input = {}) {
    if ('skills' in input) throw new Error('通用制作方法已默认启用，无需设置技能开关。')
    const settings = await load()
    for (const k of ['model', 'tts', 'image']) {
      if (!input[k]) continue
      const previous = settings[k] || {}
      const fields = k === 'tts' ? ['baseUrl', 'model', 'voice', 'protocol'] : ['baseUrl', 'model']
      settings[k] = Object.fromEntries(fields.map(field => [field, String(input[k][field] ?? previous[field] ?? '')]))
      const sameEndpoint = settings[k].baseUrl === (previous.baseUrl || '')
      settings[k].apiKey = input[k].clearApiKey ? '' : String(input[k].apiKey || (sameEndpoint ? previous.apiKey : '') || '')
      if (k === 'tts' && settings[k].protocol && !['speech', 'mimo'].includes(settings[k].protocol)) throw new Error('不支持的配音协议')
    }
    await mkdir(settingsRoot, { recursive: true })
    await writeFile(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    return get()
  }
  return { get, update, load }
}
