export const mimoBaseUrl = 'https://api.xiaomimimo.com/v1'

export function missingCredential() {
  return Object.assign(new Error('请配置通用模型的接口地址、模型名称和 API 密钥。'), { code: 'MISSING_CREDENTIAL' })
}

export function desktopModelRoute(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('请填写有效的模型地址。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('模型地址应使用 HTTPS（本机环回可使用 HTTP），且不能包含凭据或查询参数。')
  }
  return url.origin === 'https://api.openai.com' ? '/responses' : '/chat/completions'
}

export async function testDesktopModel(input, request = fetch) {
  const model = String(input.model || '').trim()
  const apiKey = String(input.apiKey || '').trim()
  const base = String(input.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '')
  if (!model || !apiKey || !base) throw missingCredential()
  const route = desktopModelRoute(base)
  const payload = route === '/responses' ? { model, input: 'Reply OK' } : { model, messages: [{ role: 'user', content: 'Reply OK' }] }
  let response
  try {
    response = await request(base + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(payload) })
  } catch { throw new Error('无法连接模型。请检查网络和接口地址。') }
  const body = response.ok ? await response.json().catch(() => null) : null
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error('模型连通性测试失败（HTTP ' + response.status + '）。请检查密钥和模型名称。')
  }
  if (route === '/responses' ? !Array.isArray(body?.output) : !Array.isArray(body?.choices)) {
    throw new Error('接口返回的内容与所选模型协议不匹配。')
  }
  return { ok: true }
}

export function checkCloudEndpoint(value, kind) {
  if (process.env.BOHACK_CLOUD_MODEL && value && kind === 'tts') {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('配音接口必须是公网 HTTPS 地址，不能包含凭据或查询参数。')
    return
  }
  if (process.env.BOHACK_CLOUD_MODEL && kind === 'model') {
    const baseUrl = process.env.BOHACK_CLOUD_BASE_URL
    if (!baseUrl) throw new Error('云工作台必须配置 BOHACK_CLOUD_BASE_URL。')
    if (value && String(value).replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '')) throw new Error('云工作台模型接口固定为 ' + baseUrl)
  }
}

// Use the same endpoint and credentials as scene generation when no model is saved.
export function effectiveScene(settings, env = process.env) {
  const saved = settings.model || {}
  return {
    baseUrl: saved.baseUrl || env.SCENE_ENDPOINT || env.WORKBENCH_MODEL_ENDPOINT || '',
    model: saved.model || env.SCENE_MODEL || env.WORKBENCH_MODEL_NAME || '',
    apiKey: saved.baseUrl ? saved.apiKey : (env.SCENE_ENDPOINT ? env.SCENE_API_KEY : env.WORKBENCH_MODEL_KEY),
  }
}

// A trailing slash is the same endpoint, but a different origin must never inherit the saved key.
function normalizeEndpoint(value) {
  try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.href } catch { return value }
}

export async function listModels(input, settings, request = fetch, env = process.env) {
  const { kind } = input
  if (!['model', 'tts', 'image'].includes(kind)) throw new Error('不支持的模型类型。')
  const saved = settings[kind] || {}
  const effective = kind === 'model' ? effectiveScene(settings, env) : null
  const baseUrl = String(input.baseUrl || effective?.baseUrl || saved.baseUrl || '').trim()
  checkCloudEndpoint(baseUrl, kind)
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('请填写有效的模型地址。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!local && url.protocol !== 'https:')) throw new Error('模型地址应使用 HTTPS，本机环回可使用 HTTP，且不能包含凭据或查询参数。')
  const endpoint = normalizeEndpoint(baseUrl)
  const savedKey = endpoint === normalizeEndpoint(saved.baseUrl) ? saved.apiKey : (effective && endpoint === normalizeEndpoint(effective.baseUrl) ? effective.apiKey : '')
  const key = input.clearApiKey ? '' : String(input.apiKey || savedKey || '')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|audio\/speech|images\/generations)$/, '') + '/models'
  let response
  try { response = await request(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
  catch { throw new Error('获取模型列表失败，请检查地址和连接。') }
  if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}）。`)
  let data
  try { data = await response.json() } catch { throw new Error('模型列表响应不是有效 JSON。') }
  if (!Array.isArray(data.data) || data.data.some(item => typeof item?.id !== 'string')) throw new Error('模型列表响应格式无效。')
  return { models: data.data.map(item => item.id), ...(effective ? { effective: { baseUrl: effective.baseUrl, model: effective.model } } : {}) }
}
