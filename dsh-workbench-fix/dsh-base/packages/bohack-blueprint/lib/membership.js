import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'

export const desktopAgentOrigin = 'https://jiangjie-agent.invalid'
const agentProvider = 'jiangjie-desktop'
const responsesProvider = 'jiangjie-desktop-responses'
const alias = 'jiangjie'
const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const transportCode = error => error?.name === 'TimeoutError' ? 'TimeoutError' : error?.cause?.code ?? error?.code
const fetchFailure = error => error?.name === 'TimeoutError' || (error instanceof TypeError && error.message === 'fetch failed') || transientCodes.has(transportCode(error))

function atTransportStage(stage, error) {
  if (!fetchFailure(error)) return error
  const code = transportCode(error)
  const detail = typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? ` (${code})` : ''
  return new Error(`${stage}: ${error.message}${detail}`, { cause: error })
}

function endpoint(value) {
  if (!value) return null
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) throw new Error('会员服务地址应使用 HTTPS，本机调试可用 HTTP。')
  return url.href.replace(/\/+$/, '')
}

async function read(file, absent) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return absent; throw error }
}

async function write(file, value) {
  const temp = file + '.' + randomUUID()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
  await rename(temp, file)
}

export function createMembership(ctx, root, options = {}) {
  const origin = endpoint(options.url ?? process.env.JIANGJIE_MEMBER_URL)
  const memberResponses = (options.agentApi ?? process.env.JIANGJIE_MEMBER_AGENT_API) === 'openai-responses'
  const privateRoot = path.join(path.dirname(root), 'membership')
  const accountFile = path.join(privateRoot, 'account.json')
  const rawFetch = options.request || globalThis.fetch
  const sessions = new Map()
  let held = 0
  let accountQueue = Promise.resolve()
  async function account() {
    const state = await read(accountFile, { mode: 'member' })
    return state.origin === origin ? state : { mode: state.mode }
  }
  async function api(route, { body, token, signal, inviteCode } = {}) {
    if (!origin) throw new Error('平台服务地址尚未配置。')
    const request = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined && { 'content-type': 'application/json', origin: new URL(origin).origin }), ...(token && { authorization: 'Bearer ' + token }), ...(inviteCode && { 'x-invite-code': inviteCode }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    }
    const send = () => {
      const timeout = AbortSignal.timeout(15000)
      return rawFetch(origin + route, { ...request, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    }
    let response
    if (route === '/api/productions/start') {
      try {
        response = await send().catch(async error => {
          const code = transportCode(error)
          const retryable = code ? code === 'TimeoutError' || transientCodes.has(code) : !error.cause && fetchFailure(error)
          if (!retryable) throw error
          await delay(300, undefined, { signal })
          return send()
        })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw atTransportStage('会员开片请求', error)
      }
    } else response = await send()
    const data = await response.json()
    if (!response.ok) {
      const code = data.code || data.error
      const message = code === 'quota_exhausted' ? '制作额度已用完，请购买 6 元周卡。'
        : code === 'active_production' ? '这个账号已有一条片在制作中，请先回到原项目完成。'
        : response.status === 401 ? '请先登录讲界账号。' : data.message || '会员服务请求失败。'
      throw Object.assign(new Error(message), { code, status: response.status })
    }
    return { data, token: response.headers.get('set-auth-token') }
  }
  async function view() {
    const state = await account()
    if (!state.token) return { enabled: true, mode: state.mode, account: null }
    let member
    try { member = (await api('/api/member', state)).data }
    catch (error) {
      if (error.status === 401) return { enabled: true, mode: state.mode, account: null }
      throw error
    }
    return {
      enabled: true, mode: state.mode, pendingOrderId: state.pendingOrderId, account: {
        email: state.email, gifts: member.giftRemaining,
        plan: member.plan, passStatus: member.passStatus, remainingPercent: member.remainingPercent,
        expiresAt: member.expiresAt, canPurchase: member.canPurchase, purchaseAvailable: member.purchaseAvailable,
        activeProductionId: member.activeProductionId,
      },
    }
  }
  function update(input) {
    const current = accountQueue.catch(() => {}).then(async () => {
      if (held) throw new Error('请等待当前 AI 操作完成再更改账号或模式。')
      const state = await account()
      if (input.action === 'order-create' || input.action === 'order-check') {
        if (!state.token) throw new Error('请先登录讲界账号。')
        const orderId = input.action === 'order-check' ? state.pendingOrderId : null
        if (input.action === 'order-check' && !orderId) throw new Error('没有待支付的订单。')
        const result = input.action === 'order-create'
          ? await api('/api/orders', {token:state.token, body:{plan:'weekly_6'}})
          : await api('/api/orders/' + encodeURIComponent(orderId), {token:state.token})
        const order = result.data
        if (!order.orderId || (orderId && order.orderId !== orderId)) throw new Error('会员服务返回的订单编号无效。')
        if (['fulfilled', 'expired', 'failed'].includes(order.status)) delete state.pendingOrderId
        else state.pendingOrderId = order.orderId
        await write(accountFile, state)
        return { ...(await view()), order }
      }
      if (input.action === 'mode') {
        if (!['member', 'byok'].includes(input.mode)) throw new Error('未知的调用模式。')
        if (input.mode !== state.mode && state.mode === 'member' && state.token) {
          const result = await api('/api/member', state).catch(error => { if (error.status !== 401) throw error })
          if (result?.data.activeProductionId) throw new Error('请先在原项目完成正在使用会员授权的成片，再切换为自配 API。')
        }
        await write(accountFile, { ...state, mode: input.mode })
      } else if (input.action === 'logout') {
        if (state.token) await api('/api/auth/sign-out', { token: state.token, body: {} }).catch(error => { if (error.status !== 401) throw error })
        await write(accountFile, { mode: state.mode })
      } else if (['register', 'login'].includes(input.action)) {
        const email = String(input.email || '').trim()
        const password = String(input.password || '')
        const register = input.action === 'register'
        const result = await api(register ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email', {
          body: { email, password, ...(register && { name: email.split('@')[0] }) },
          ...(register && { inviteCode: String(input.inviteCode || '').trim() }),
        })
        if (!result.token || !result.data.user?.id) throw new Error('会员服务没有返回登录凭据。')
        await write(accountFile, { mode: 'member', origin, token: result.token, userId: result.data.user.id, email: result.data.user.email })
      } else throw new Error('未知的账号操作。')
      return view()
    })
    accountQueue = current
    return current
  }
  function hold() {
    held++
    return () => { held-- }
  }
  function project(directory) {
    const key = createHash('sha256').update(path.relative(root, directory)).digest('hex')
    const file = path.join(privateRoot, 'projects', key + '.json')
    let opening = Promise.resolve()
    function serialize(task) {
      const current = opening.catch(() => {}).then(task)
      opening = current
      return current
    }
    async function current() {
      const { token, userId, mode } = await account()
      if (!token || mode !== 'member') return null
      const saved = (await read(file, {}))[userId]
      return saved ? { id: saved.id, closing: saved.closing || (saved.finishing ? 'finish' : null), terminal: saved.terminal } : null
    }
    async function lease({ state, signal, id: expectedId, replace = false } = {}) {
      state ||= await account()
      if (state.mode === 'byok' && !expectedId) return null
      if (!state.token || state.mode !== 'member') throw new Error(expectedId ? '请先登录原讲界账号，再继续这条片。' : '请先登录讲界账号，再使用平台 AI。')
      return serialize(async () => {
        const projects = await read(file, {})
        const saved = projects[state.userId]
        if (expectedId && ((saved?.id !== expectedId && saved?.replacesProductionId !== expectedId) || saved.terminal)) throw new Error('请登录开片时使用的讲界账号。')
        const job = await read(path.join(directory, 'production', 'status.json'), null)
        if (saved?.closing === 'abandon') throw new Error('请先在原项目重试放弃本片授权。')
        if (saved?.closing || saved?.finishing || (job?.status === 'completed' && job.membershipAuthorizationId === saved?.id &&
            (job.membershipPending || job.membershipError || (saved && !saved.terminal)))) {
          throw new Error('请先在原项目处理上一条片的授权回执。')
        }
        const replacing = replace || (!!expectedId && saved?.replacesProductionId === expectedId)
        const id = replacing ? (saved?.replacesProductionId === expectedId ? saved.id : randomUUID()) : saved && !saved.terminal ? saved.id : randomUUID()
        if (id !== saved?.id) {
          projects[state.userId] = { id, ...(replacing && { replacesProductionId: expectedId }) }
          await write(file, projects)
        }
        const result = await api('/api/productions/start', { token: state.token, body: { productionId: id, ...(replacing && { replacesProductionId: expectedId }) }, signal }).catch(async error => {
          if (!replacing && ['quota_exhausted', 'active_production'].includes(error.code)) {
            delete projects[state.userId]
            await write(file, projects)
          }
          throw error
        })
        if (result.data.status !== 'active') throw new Error('这条片的授权已结束，请重新打开项目后再试。')
        return { id, userId: state.userId, token: state.token, baseUrl: origin + '/api/proxy/' + id }
      })
    }
    function close(action, id) {
      return serialize(async () => {
        const { token, userId, mode } = await account()
        if (!token || mode !== 'member') throw new Error('请登录开片时使用的讲界账号。')
        const projects = await read(file, {})
        const saved = projects[userId]
        const replacement = action === 'abandon' && saved?.replacesProductionId === id
        if (saved?.id !== id && !replacement) throw new Error('当前账号在此项目的制作授权已变更。')
        if (saved.terminal) return saved.terminal
        const closing = saved.closing || (saved.finishing ? 'finish' : action)
        projects[userId] = replacement ? { ...saved, closing } : { id, closing }
        await write(file, projects)
        if (replacement) {
          const { data: { status } } = await api('/api/productions/abandon', { token, body: { productionId: saved.id } })
          if (status !== 'abandoned') throw new Error('会员服务未确认替换授权已放弃。')
        }
        const { data: { status: terminal } } = await api('/api/productions/' + closing, { token, body: { productionId: id } })
        if (!['finished', 'abandoned'].includes(terminal)) throw new Error('会员服务未确认制作结束。')
        projects[userId] = { id, terminal }
        await write(file, projects)
        return terminal
      })
    }
    function bind(sessionId, load, auth, byok = false) {
      sessions.set(String(sessionId), { authorize: auth || byok ? () => auth : lease, load })
    }
    function unbind(sessionId) { sessions.delete(String(sessionId)) }
    async function route(loadSettings) {
      const { mode } = await account()
      const baseUrl = mode === 'byok' && loadSettings ? (await loadSettings()).model?.baseUrl : null
      const useResponses = mode === 'member' ? memberResponses : baseUrl && new URL(baseUrl).origin === 'https://api.openai.com'
      return { provider: useResponses ? responsesProvider : agentProvider, model: alias }
    }
    return { lease, current, close, bind, unbind, route, hold, error: id => sessions.get(String(id))?.error }
  }

  function install() {
    const original = globalThis.fetch
    ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      if (request.provider !== agentProvider && request.provider !== responsesProvider) return next()
      headers.set('x-jiangjie-session', String(request.sessionId || ''))
      return headers
    })
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, desktopAgentOrigin)
      if (url.origin !== desktopAgentOrigin) return original(input, init)
      const request = new Request(input, init)
      const binding = sessions.get(request.headers.get('x-jiangjie-session'))
      if (!binding) return Response.json({ error: { message: '桌面模型请求缺少项目会话。' } }, { status: 400 })
      binding.error = undefined
      const route = url.pathname
      if (!['/chat/completions', '/responses'].includes(route)) return new Response(null, { status: 404 })
      const release = hold()
      try {
        const auth = await binding.authorize({ signal: request.signal })
        const model = auth ? { baseUrl: auth.baseUrl, model: alias, apiKey: auth.token } : (await binding.load()).model
        if (!model?.baseUrl || !model.model) throw new Error('请在高级设置中配置通用模型地址和名称。')
        const base = endpoint(model.baseUrl).replace(/\/(?:chat\/completions|responses)$/, '')
        const body = await request.json()
        const response = await rawFetch(base + route, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(model.apiKey && { authorization: 'Bearer ' + model.apiKey }) },
          body: JSON.stringify({ ...body, model: model.model }), redirect: 'error', signal: request.signal,
        }).catch(error => { throw atTransportStage(auth ? '会员模型代理请求' : '自配模型请求', error) })
        if (response.status === 402) {
          const data = await response.clone().json().catch(() => null)
          if ((data?.error?.code || data?.error || data?.code) === 'quota_circuit_broken') {
            binding.error = Object.assign(new Error('本周卡额度已用尽，购买新周卡后点击继续制作。'), { code: 'quota_circuit_broken', status: 402 })
          }
        }
        return response
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason
        binding.error = error
        if (fetchFailure(error.cause)) throw error
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status || 400 })
      } finally { release() }
    }
    return () => { globalThis.fetch = original; sessions.clear() }
  }
  return { view, update, project, install }
}
