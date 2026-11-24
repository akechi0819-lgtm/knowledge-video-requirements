import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { registerSkillExecution } from './skill-process.js'

const toolActivities = new Map([
  ['skill', '正在加载风格规范…'],
  ['read', '正在读取制作资料…'],
  ['write', '正在编写源码…'],
  ['apply_patch', '正在编写源码…'],
  ['write_scene', '正在编写画面源码…'],
  ['bash', '正在运行生成或渲染脚本…'],
  ['preview', '正在生成画面预览…'],
  ['view_image', '正在检查画面预览…'],
  ['submit', '正在校验并提交成片…'],
])

// Each production job gets its own host session and cwd. The caller owns the
// actual production tools and validates their outputs.
export async function runVideoAgent({ ctx, sessionId, cwd, model, provider, reasoningEffort, prompt, tools, onProgress, onTiming, preset = 'bohack-video', continuation, runtime, submitTool = 'submit', statusText = '正在制作视频' }) {
  const agents = ctx.get?.('agents') || ctx.agents
  const presets = ctx.get?.('agentPresets') || ctx.agentPresets
  if (!agents?.create || !presets?.mount) throw new Error('DSH 制作会话服务不可用')
  if (!cwd || !prompt || !Array.isArray(tools) || !tools.some(tool => tool.name === submitTool)) {
    throw new Error('制作会话缺少工作目录、提示词或 submit 工具')
  }
  const llm = runtime && model && provider ? ctx.get?.('llm') || ctx.llm : undefined
  const names = new Set(tools.map(tool => tool.name))
  if (names.size !== tools.length) throw new Error('制作工具名称重复')
  let submitted = false
  const activeSessionId = sessionId || `video-${randomUUID()}`
  let modelError
  let result
  let handle
  let resolveSubmitted
  const submission = new Promise(resolve => { resolveSubmitted = resolve })
  let timer
  let warningTimer
  let activityTimer
  let waitingForModel = false
  let warningShown = false
  let rejectTimeout
  let stopped = false
  const toolAbort = new AbortController()
  let activeTools = 0
  let inheritedTools = 0
  let budgetTimer
  const budgetMs = Number(process.env.BOHACK_VIDEO_BUDGET_MS || 3600000)
  const idleMs = Number(process.env.BOHACK_VIDEO_IDLE_MS || 720000)
  if (![budgetMs, idleMs].every(ms => Number.isInteger(ms) && ms > 0 && ms <= 2147483647)) throw new Error('制作总预算和空闲预算必须是有效的毫秒数。')
  const expire = message => {
    stopped = true
    rejectTimeout(new Error(message))
  }
  const activity = text => onProgress?.({ type: 'activity', text })
  const armActivity = () => {
    clearTimeout(activityTimer)
    if (!onProgress || stopped || submitted || !rejectTimeout || activeTools || inheritedTools || waitingForModel) return
    activityTimer = setTimeout(() => {
      waitingForModel = true
      activity('正在等待模型生成下一步…')
    }, 25000)
  }
  const toolActivity = (name, ownTool = false) => {
    const text = ownTool && submitTool === 'submit_assets' ? undefined : toolActivities.get(name)
    if (text || waitingForModel) activity(text || '正在执行制作工具…')
    waitingForModel = false
  }
  const armWatchdog = () => {
    armActivity()
    clearTimeout(timer)
    clearTimeout(warningTimer)
    if (warningShown) {
      warningShown = false
      onProgress?.({ type: 'wait', text: '' })
    }
    if (stopped || submitted || !rejectTimeout) return
    if (activeTools === 0) warningTimer = setTimeout(() => {
      warningShown = true
      onProgress?.({ type: 'wait', text: '画面模型等待时间较长，正在继续等待。' })
    }, 120000)
    timer = setTimeout(() => {
      const liveJobs = runtime?.processes.size || agentCtxJobs?.list(activeSessionId).some(job => job.status === 'running')
      if (liveJobs || activeTools > 0) armWatchdog()
      else expire('制作任务长时间没有活动，已暂停，可继续制作。')
    }, idleMs)
  }
  let agentCtxJobs
  const unregister = runtime && registerSkillExecution(activeSessionId, Object.assign(runtime, {
    signal: toolAbort.signal,
    processes: new Set(),
    beat: armWatchdog,
  }))
  let resolveTurnEnd
  let turnReason
  let stepTiming
  let toolProgress = 0
  const setup = async agentCtx => {
    await presets.mount(agentCtx, preset)
    if (!agentCtx.tools?.register) throw new Error('DSH 制作工具注册不可用')
    agentCtxJobs = agentCtx.get?.('jobs') || agentCtx.jobs
    for (const tool of tools) {
      const projections = new WeakMap()
      agentCtx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          if (stopped) return {ok:false, message:'本次制作已暂停。'}
          if (submitted) return {ok:false, message:'本次成片已提交。'}
          activeTools++
          toolActivity(tool.name, true)
          armWatchdog()
          const timing = onTiming && stepTiming
          const start = onTiming && Date.now()
          try {
            const value = await tool.execute(args, toolAbort.signal)
            if (stopped) return {ok:false, message:'本次制作已暂停。'}
            if (value?.ok !== false) toolProgress++
            if (tool.name === submitTool && value?.ok === true) { submitted = true; result = value; resolveSubmitted() }
            if (!value?.image) return value
            if (llm?.resolveModelInfo) {
              const modelInfo = await llm.resolveModelInfo(provider, model, toolAbort.signal)
              if (modelInfo?.inputModalities && !modelInfo.inputModalities.includes('image')) {
                return { ok: false, message: `当前制作模型 ${model} 不接收图片。预览文件已生成，视觉自检尚未完成。` }
              }
            }
            const { image, ...textValue } = value
            const attachments = ctx.get?.('attachments') || ctx.attachments
            const refs = await attachments.saveImages([{ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType }])
            const imageBlock = { type: 'image', attachment: refs[0] }
            textValue.imageStatus = runtime ? '预览图已附在工具结果中。' : '预览图已提供给模型。'
            projections.set(exec, { value: textValue, imageBlock, args })
            return textValue
          } finally {
            activeTools--
            armWatchdog()
            if (onTiming) {
              const end = Date.now()
              timing?.intervals.push([start, end])
              timing?.toolNames.add(tool.name)
              onTiming({ type: 'tool', sessionId: activeSessionId, turn: timing?.turn, step: timing?.step, toolName: tool.name, start, end, elapsed: end - start })
            }
          }
        },
        projectContent(exec, result) {
          const projection = projections.get(exec)
          projections.delete(exec)
          if (!projection || result.isError || !isDeepStrictEqual(result.value, projection.value)) return undefined
          tool.onImageProjected?.(projection.args)
          return [{ type: 'text', text: JSON.stringify(projection.value) }, projection.imageBlock]
        },
      })
    }
    if (!runtime) {
      // Lightweight HTML production still owns its existing tool contract.
      agentCtx.tools.guard(call => names.has(call?.name) ? undefined : '此制作会话未允许使用该工具。')
      const inherited = [...agentCtx.tools.view(undefined).restrictableNames].filter(name => !names.has(name))
      if (inherited.length) agentCtx.tools.restrict({ deny: inherited })
    } else {
      agentCtx.on('tools/execute', async (exec, next) => {
        if (exec.agent?.id !== activeSessionId || names.has(exec.name)) return next()
        const start = Date.now(), timing = stepTiming
        inheritedTools++
        toolActivity(exec.name)
        armWatchdog()
        try {
          const value = await next()
          if (!value.isError) toolProgress++
          return value
        } finally {
          inheritedTools--
          const end = Date.now()
          timing?.intervals.push([start, end])
          timing?.toolNames.add(exec.name)
          onTiming?.({ type: 'tool', sessionId: activeSessionId, turn: timing?.turn, step: timing?.step, toolName: exec.name, start, end, elapsed: end - start })
          armWatchdog()
        }
      })
    }
    agentCtx.on?.('agent/assistant-stream', payload => {
      const chunk = payload?.frame?.type === 'chunk' ? payload.frame.chunk : null
      const streamSessionId = payload?.sessionId ?? payload?.session?.id
      if (chunk && (streamSessionId == null || streamSessionId === activeSessionId)) {
        if (waitingForModel) {
          waitingForModel = false
          activity('模型正在生成下一步…')
        }
        armWatchdog()
      }
      if (stepTiming && (streamSessionId == null || streamSessionId === activeSessionId)) {
        if (chunk?.type === 'reasoning-delta') stepTiming.reasoningChars += chunk.text?.length || 0
        if (chunk?.type === 'text-delta') stepTiming.textChars += chunk.text?.length || 0
        if (chunk?.type === 'tool-call-delta') stepTiming.toolArgumentChars += chunk.argumentsDelta?.length || 0
      }
      if (chunk?.type === 'text-delta' && chunk.text) onProgress?.({ type: 'text', text: chunk.text })
    })
    agentCtx.on?.('session/event', (session, event) => {
      if (onTiming && session?.id === activeSessionId) {
        if (event?.type === 'step/start') {
          stepTiming = { turn: event.data.turn, step: event.data.step, start: event.time, intervals: [], toolNames: new Set(), reasoningChars: 0, textChars: 0, toolArgumentChars: 0 }
        } else if (event?.type === 'step/end' && stepTiming && event.data.turn === stepTiming.turn && event.data.step === stepTiming.step) {
          const timing = stepTiming
          stepTiming = undefined
          const end = event.time
          let toolMs = 0
          let coveredUntil = timing.start
          for (const [start, finish] of timing.intervals.sort((a, b) => a[0] - b[0])) {
            const from = Math.max(start, coveredUntil, timing.start)
            const to = Math.min(finish, end)
            if (to > from) toolMs += to - from
            coveredUntil = Math.max(coveredUntil, to)
          }
          const elapsed = end - timing.start
          onTiming({ type: 'step', sessionId: activeSessionId, turn: timing.turn, step: timing.step, start: timing.start, end, elapsed, toolMs, modelWaitMs: elapsed - toolMs, toolNames: [...timing.toolNames], reasoningChars: timing.reasoningChars, textChars: timing.textChars, toolArgumentChars: timing.toolArgumentChars })
        }
      }
      if (session?.id === activeSessionId && event?.type === 'turn/end') {
        clearTimeout(activityTimer)
        onTiming?.({ type: 'turn', sessionId: activeSessionId, end: event.time, reason: event.data?.reason?.kind })
        if (event.data?.reason?.kind === 'error') modelError = event.data.reason.error
        if (resolveTurnEnd) {
          turnReason = event.data?.reason
          const resolve = resolveTurnEnd
          resolveTurnEnd = undefined
          resolve()
        }
      }
    })
  }
  try {
    handle = await agents.create({ sessionId: activeSessionId, meta: { cwd: path.resolve(cwd) }, agentOptions: { provider, model, ...(reasoningEffort != null ? { reasoningEffort } : {}) }, setup })
    // Pin the internal session title before its first prompt to avoid a second model request.
    const sessionTitle = ctx.get?.('sessionTitle') || ctx.sessionTitle
    if (sessionTitle && handle.agent.session) sessionTitle.rename(handle.agent.session, statusText)
    await onProgress?.({ type: 'status', text: statusText })
    const timeout = new Promise((_, reject) => { rejectTimeout = reject })
    armWatchdog()
    budgetTimer = setTimeout(() => expire('制作达到总时间预算，已暂停，可继续制作。'), budgetMs)
    await Promise.race([
      submission,
      (async () => {
        let previousProgress = 0
        let instruction = prompt
        while (!submitted && !stopped) {
          const ended = new Promise(resolve => { resolveTurnEnd = resolve })
          armActivity()
          await handle.agent.followup({ role: 'user', content: [{ type: 'text', text: instruction }], source: { kind: 'user' }, id: randomUUID() })
          await ended
          if (modelError) {
            const status = /^(?:HTTP\s+)?(429|500|502|503|504)\s*:/.exec(modelError.message)?.[1]
            if (status === '429') throw new Error('画面模型请求受到限制（429），制作已暂停。')
            if (status) throw new Error(`画面模型服务暂时不可用（${status}），制作已暂停。`)
            throw new Error(modelError.message)
          }
          if (submitted || stopped) return
          if (!['completed', 'max-tokens'].includes(turnReason?.kind)) throw new Error(`视频制作会话已中止，未提交成片（${turnReason?.kind || '未知结束状态'}）`)
          if (toolProgress === previousProgress) throw new Error('视频制作尚未提交，且会话没有新的工具进展')
          previousProgress = toolProgress
          await handle.agent.whenIdle?.()
          instruction = continuation || '本次制作尚未完成。请先补写尚未保存的画面，再对尚未预览的段落各看一张代表性画面；只修复脚本或播放错误、主体缺失、严重遮挡，然后调用 submit 完成制作。已正常的段落直接沿用，静帧与审美建议不拦交片，不新增用户确认。'
        }
      })(),
      timeout,
    ])
    if (runtime?.auditError) throw runtime.auditError
    if (!submitted) throw new Error('视频制作会话结束，但未成功调用 submit 提交成片')
    return result
  } catch (error) {
    toolAbort.abort()
    await handle?.agent?.cancel?.({ kind: 'parent' })
    if (runtime) {
      await Promise.allSettled([...runtime.processes].map(process => process.done))
      await writeFile(path.join(runtime.dir, 'agent-pause.json'), JSON.stringify({ sessionId: activeSessionId, reason: error.message, date: new Date().toISOString() }))
    }
    throw error
  } finally {
    stopped = true
    clearTimeout(timer)
    clearTimeout(warningTimer)
    clearTimeout(activityTimer)
    clearTimeout(budgetTimer)
    if (runtime) {
      toolAbort.abort()
      await Promise.allSettled([...runtime.processes].map(process => process.done))
      await handle?.dispose?.()
      unregister()
    }
    if (warningShown) onProgress?.({ type: 'wait', text: '' })
  }
}
