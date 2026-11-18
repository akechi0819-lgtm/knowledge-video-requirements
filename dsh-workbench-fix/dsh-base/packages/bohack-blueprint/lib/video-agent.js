import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Each production job gets its own host session and cwd. The caller owns the
// actual production tools and validates their outputs.
export async function runVideoAgent({ ctx, sessionId, cwd, model, provider, reasoningEffort, prompt, tools, onProgress, onTiming }) {
  const agents = ctx.get?.('agents') || ctx.agents
  const presets = ctx.get?.('agentPresets') || ctx.agentPresets
  if (!agents?.create || !presets?.mount) throw new Error('DSH 制作会话服务不可用')
  if (!cwd || !prompt || !Array.isArray(tools) || !tools.some(tool => tool.name === 'submit')) {
    throw new Error('制作会话缺少工作目录、提示词或 submit 工具')
  }
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
  let resolveTurnEnd
  let turnReason
  let stepTiming
  let toolProgress = 0
  const setup = async agentCtx => {
    await presets.mount(agentCtx, 'bohack-video')
    if (!agentCtx.tools?.register || !agentCtx.tools?.guard || !agentCtx.tools?.view || !agentCtx.tools?.restrict) {
      throw new Error('DSH 工具白名单能力不可用')
    }
    for (const tool of tools) {
      const projections = new WeakMap()
      agentCtx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          timer?.refresh()
          if (submitted) return {ok:false, message:'本次成片已提交。'}
          const timing = onTiming && stepTiming
          const start = onTiming && Date.now()
          try {
            const value = await tool.execute(args)
            if (value?.ok !== false) toolProgress++
            timer?.refresh()
            if (tool.name === 'submit' && value?.ok === true) { submitted = true; result = value; resolveSubmitted() }
            if (!value?.image) return value
            const { image, ...textValue } = value
            const attachments = ctx.get?.('attachments') || ctx.attachments
            const refs = await attachments.saveImages([{ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType }])
            const imageBlock = { type: 'image', attachment: refs[0] }
            textValue.imageStatus = '预览图已提供给模型。'
            projections.set(exec, { value: textValue, imageBlock })
            return textValue
          } finally {
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
          return [{ type: 'text', text: JSON.stringify(projection.value) }, projection.imageBlock]
        },
      })
    }
    // restrict masks inherited tools; guard also covers tools registered in the
    // preset's own scope, which restrict deliberately does not mask.
    agentCtx.tools.guard(call => names.has(call?.name) ? undefined : '此制作会话未允许使用该工具。')
    const inherited = [...agentCtx.tools.view(undefined).restrictableNames].filter(name => !names.has(name))
    if (inherited.length) agentCtx.tools.restrict({ deny: inherited })
    agentCtx.on?.('agent/assistant-stream', payload => {
      const chunk = payload?.frame?.type === 'chunk' ? payload.frame.chunk : null
      const streamSessionId = payload?.sessionId ?? payload?.session?.id
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
    onProgress?.({ type: 'status', text: '正在制作视频' })
    await Promise.race([
      submission,
      (async () => {
        let previousProgress = 0
        let instruction = prompt
        while (!submitted) {
          // Idle may precede admission of a queued followup. Continue only after
          // this session's real turn/end event, never by polling or re-enqueueing.
          const ended = new Promise(resolve => { resolveTurnEnd = resolve })
          await handle.agent.followup({ role: 'user', content: [{ type: 'text', text: instruction }], source: { kind: 'user' }, id: randomUUID() })
          await ended
          if (modelError) throw new Error(modelError.message)
          if (submitted) return
          if (turnReason?.kind !== 'completed') throw new Error('视频制作会话已中止，未提交成片')
          if (toolProgress === previousProgress) throw new Error('视频制作尚未提交，且会话没有新的工具进展')
          previousProgress = toolProgress
          instruction = '本次制作尚未完成。请接着刚才的实际工具进展继续，不要只汇报计划：尚未预览的段落各看一张代表性画面；只修复脚本或播放错误、主体缺失、严重遮挡，然后调用 submit 完成制作。已正常的段落直接沿用，静帧与审美建议不拦交片，不新增用户确认。'
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('视频制作会话连续十分钟没有工具进展')), 600000) }),
    ])
    if (!submitted) throw new Error('视频制作会话结束，但未成功调用 submit 提交成片')
    return result
  } catch (error) {
    handle?.agent?.cancel?.('video production failed')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
