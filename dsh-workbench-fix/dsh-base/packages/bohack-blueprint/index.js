/**
 * @bohack/blueprint — Host plugin entry.
 *
 * One Cordis row registers both the capability service (ctx.bohack) and the
 * /bohack prefix route. Only `webServer` is declared as a hard dependency so
 * the temporary UI always comes up; agent/preset/session services are looked
 * up lazily at generation time, and a missing one degrades to the offline
 * engine instead of blocking the whole plugin.
 */
import { createService } from './lib/service.js'
import { createEngine } from './lib/engine.js'
import { createWebHandler } from './lib/web.js'
import { createThreads } from './lib/threads.js'
import { createMembership } from './lib/membership.js'
import { createMultiuserHandler } from './lib/multiuser.js'
import path from 'node:path'
import { runtimePaths, writablePath } from './lib/runtime.js'

export const name = '@bohack/blueprint'
export const inject = ['webServer']

/**
 * Optional network diagnostics. DSH's DeepSeek adapter wraps a raw fetch
 * failure as "DeepSeek Messages transport failed / TRANSPORT" and discards the
 * cause, which makes a proxy/TLS/credential problem indistinguishable from a
 * plugin bug. This wrapper only logs; it never changes the request.
 */
function installNetworkDiagnostics(ctx) {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  globalThis.fetch = async function debugFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url
    if (!/deepseek/i.test(String(url))) return original(input, init)
    try {
      const res = await original(input, init)
      if (!res.ok) {
        try {
          const body = await res.clone().text()
          process.stderr.write(`[bohack/net] ${init?.method || 'GET'} ${url} -> ${res.status} ${body.slice(0, 600)}\n`)
        } catch { /* ignore */ }
      }
      return res
    } catch (e) {
      const cause = e?.cause
      process.stderr.write(`[bohack/net] FETCH THROW ${url}: ${e?.name} ${e?.message} | cause=${cause?.code || cause?.message || cause?.name || 'none'}\n`)
      throw e
    }
  }
  return () => { globalThis.fetch = original }
}

export function apply(ctx, config = {}) {
  if (config.multiuser) {
    if (process.env.DSH_INTERNAL_TOKEN || process.env.JIANGJIE_READY_ID) throw new Error('Local workbench startup cannot use the multiuser profile')
    const handler = createMultiuserHandler(ctx, { ...config, ...config.multiuser })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/bohack', handler }), 'bohack: multiuser route')
    return
  }
  if (process.env.JIANGJIE_DESKTOP_WORKSPACE) {
    config = { ...config, workspace: process.env.JIANGJIE_DESKTOP_WORKSPACE, desktop: true }
  } else if (process.env.JIANGJIE_WORKBENCH_WORKSPACE || process.env.JIANGJIE_DATA_DIR) {
    config = { ...config, workspace: process.env.JIANGJIE_WORKBENCH_WORKSPACE || path.join(runtimePaths().data, 'workspace') }
  }
  if (process.env.JIANGJIE_APP_ROOT) {
    const { app, data } = runtimePaths()
    config = { ...config, workspace: config.workspace || (data && path.join(data, 'workspace')) }
    for (const directory of [config.workspace || './workspace', config.settingsRoot, config.styleLibraryRoot].filter(Boolean)) {
      writablePath(path.resolve(directory), app)
    }
  }
  if (config.debugNetwork) {
    ctx.effect(() => installNetworkDiagnostics(ctx), 'bohack: network diagnostics')
  }
  if (config.desktop) {
    const membership = createMembership(ctx, config.workspace)
    config = { ...config, membership, memberProject: membership.project(config.workspace) }
    ctx.effect(() => membership.install(), 'bohack: desktop model routing')
  }
  const service = createService(ctx, config)
  const engine = createEngine(ctx, config)
  const threads = createThreads(ctx, config, service, engine)
  const handler = createWebHandler(service, engine, ctx, threads, undefined, undefined, config.membership)

  ctx.effect(() => ctx.provide('bohack', service), 'bohack: ctx.bohack service')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bohack',
    handler,
  }), 'bohack: /bohack prefix route')

  ctx.effect(() => () => { engine.reset(); threads.reset() }, 'bohack: release agent session')

  try {
    ctx.logger?.info?.('[bohack] ready — workspace:', service._internal.dirs.root,
      '| preset:', config.preset || 'blueprint',
      '| allowWebResearch:', !!config.allowWebResearch)
  } catch { /* logging must never break activation */ }
}
