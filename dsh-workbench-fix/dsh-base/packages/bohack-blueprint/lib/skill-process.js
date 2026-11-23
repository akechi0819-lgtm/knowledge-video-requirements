import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { appendJsonl, checkRuntimePath, expandRuntimeHome } from './skill-runtime.js'

export const name = 'bohack-skill-process'
export const inject = ['tools', 'workingDirectory', 'skills']
const execution = new AsyncLocalStorage()
const runtimes = new Map()

export function registerSkillExecution(sessionId, runtime) {
  runtimes.set(sessionId, runtime)
  return () => runtimes.delete(sessionId)
}

function executionRuntime(agent) {
  for (let current = agent; current; current = current.parentAgent) {
    const runtime = runtimes.get(current.id)
    if (runtime) return runtime
  }
}

export async function apply(ctx) {
  const requireFromDsh = createRequire(realpathSync(process.argv[1]))
  const { FileSystemSkillProvider } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-skill-filesystem')))
  ctx.skills.registerProvider(control => new class extends FileSystemSkillProvider {
    async roots(cwd) {
      if (!cwd) return []
      const location = path.resolve(cwd)
      const runtime = [...runtimes.values()].find(item => location === item.dir || location.startsWith(item.dir + path.sep) || location === item.tmp || location.startsWith(item.tmp + path.sep))
      return runtime ? [{ path: runtime.catalogRoot, source: 'custom', rank: 0 }] : []
    }
  }(ctx, control, { providerName: 'bohack-managed', watch: false, includeDefaultRoots: false }))

  const policy = ctx.root.get('sandboxPolicy')
  const fs = ctx.root.get('fs')
  if (!fs) throw new Error('DSH 原生文件服务不可用。')
  ctx.provide('fs', new Proxy({}, {
    get(_target, key) {
      const value = fs[key]
      if (key === 'resolve' || key === 'lstat') return (file, ...args) => {
        const runtime = execution.getStore()?.runtime
        return value.call(fs, runtime ? expandRuntimeHome(runtime, file) : file, ...args)
      }
      return typeof value === 'function' ? value.bind(fs) : value
    },
  }))

  const host = ctx.root.get('subprocess')
  if (!host) throw new Error('DSH 原生子进程服务不可用。')
  ctx.provide('subprocess', {
    resolveExecutable: (...args) => host.resolveExecutable(...args),
    terminalEnvironment: (...args) => host.terminalEnvironment(...args),
    spawn(spec) {
      const { runtime, tool, args, sessionId } = execution.getStore() || {}
      if (!runtime) throw new Error('原版 Skill 子进程缺少任务运行时。')
      const cwd = checkRuntimePath(runtime, runtime.dir, spec.cwd)
      const cmd = tool === 'bash' ? args.command : spec.argv.map(arg => JSON.stringify(arg)).join(' ')
      const ts = new Date().toISOString()
      const start = Date.now()
      const secrets = [runtime.env.MIMO_API_KEY, runtime.env.VIDEO_TTS_KEY].filter(Boolean)
      const sanitize = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
      const log = (exitCode, stderrHead) => appendJsonl(runtime.dir, 'commands.jsonl', {
        ts, sessionId, tool, cmd: sanitize(cmd), exitCode, durationMs: Date.now() - start, stderrHead: sanitize(stderrHead).slice(0, 1000), cwd,
      })
      let handle
      try {
        handle = host.spawn({ ...spec, cwd, env: { ...spec.env, ...runtime.env }, signal: AbortSignal.any([spec.signal, runtime.signal].filter(Boolean)) })
      } catch (error) {
        log(null, error.message)
        throw error
      }
      runtime.processes.add(handle)
      runtime.beat?.()
      const heartbeat = () => {
        const bytes = (handle.collected.stdout?.readFrom(0).nextOffset || 0) + (handle.collected.stderr?.readFrom(0).nextOffset || 0)
        if (bytes !== lastBytes) runtime.beat?.()
        lastBytes = bytes
      }
      let lastBytes = 0
      const timer = setInterval(heartbeat, 5000)
      timer.unref()
      handle.done.then(
        outcome => log(outcome.exitCode, handle.collected.stderr?.readFrom(0).text || (outcome.signal ? `被信号 ${outcome.signal} 终止` : '')),
        error => log(null, error.message),
      ).finally(() => {
        clearInterval(timer)
        runtime.processes.delete(handle)
        runtime.beat?.()
      }).catch(error => { runtime.auditError = error })
      return handle
    },
    spawnTerminal() { throw new Error('原版 Skill 任务只能使用受管制作命令。') },
  })
  ctx.on('tools/execute', (exec, next) => {
    const runtime = executionRuntime(exec.agent)
    if (!runtime) return next()
    return execution.run({ runtime, sessionId: exec.agent?.id, tool: exec.name, args: exec.arguments }, next)
  })
  ctx.tools.guard(exec => {
    const runtime = executionRuntime(exec.agent)
    if (!runtime) return undefined
    try {
      const args = exec.arguments ?? {}
      const cwd = ctx.workingDirectory.get(exec.agent.session)
      if (args.sandbox_permissions !== undefined &&
          args.sandbox_permissions !== policy?.resolve({ session: exec.agent.session }).mode) {
        return '制作任务不能扩大路径权限。'
      }
      if (['read', 'read_image'].includes(exec.name)) checkRuntimePath(runtime, cwd, args.file_path)
      if (['write', 'edit'].includes(exec.name)) checkRuntimePath(runtime, cwd, args.file_path, true)
      if (exec.name === 'apply_patch') {
        // Match the native patch headers, including rename destinations.
        for (const line of args.input.split(/\r?\n/)) {
          const file = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line.trim())?.[1]
          if (file) checkRuntimePath(runtime, cwd, file.trim(), true)
        }
      }
      if (exec.name === 'skill' && !runtime.names.has(args.name)) return '只能加载本次制作已安装的 Skill。'
      if (['glob', 'grep'].includes(exec.name) && args.path) checkRuntimePath(runtime, cwd, args.path)
      if (exec.name === 'bash' && args.workdir) checkRuntimePath(runtime, cwd, args.workdir)
      if (exec.name === 'working_directory' && args.cd) checkRuntimePath(runtime, cwd, args.cd, true)
      if (exec.name === 'subagent' && args.cwd) checkRuntimePath(runtime, cwd, args.cwd, true)
    } catch (error) { return error.message }
  })
}
