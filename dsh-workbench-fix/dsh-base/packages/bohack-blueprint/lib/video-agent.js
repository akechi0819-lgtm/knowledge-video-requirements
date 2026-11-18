import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Each production job gets its own host session and cwd. The caller owns the
// actual production tools and validates their outputs.
export async function runVideoAgent({ ctx, sessionId, cwd, model, provider, prompt, tools, onProgress }) {
  const agents = ctx.get?.('agents') || ctx.agents
  const presets = ctx.get?.('agentPresets') || ctx.agentPresets
  if (!agents?.create || !presets?.mount) throw new Error('DSH 制作会话服务不可用')
  if (!cwd || !prompt || !Array.isArray(tools) || !tools.some(tool => tool.name === 'submit')) {
    throw new Error('制作会话缺少工作目录、提示词或 submit 工具')
  }
  const names = new Set(['skill', ...tools.map(tool => tool.name)])
  if (names.size !== tools.length + 1) throw new Error('制作工具名称重复或与 skill 冲突')
  let submitted = false
  const activeSessionId = sessionId || `video-${randomUUID()}`
  let modelError
  let result
  let handle
  let resolveSubmitted
  const submission = new Promise(resolve => { resolveSubmitted = resolve })
  let timer
  let settleTimer
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
          const value = await tool.execute(args)
          timer?.refresh()
          if (tool.name === 'submit' && value?.ok === true) { submitted = true; result = value; resolveSubmitted() }
          if (!value?.image) return value
          const { image, ...textValue } = value
          let imageBlock
          try {
            const route = exec.agent?.session.requestHeader()?.config
            const activeProvider = route?.provider ?? exec.agent?.options.provider
            const activeModel = route?.model ?? exec.agent?.options.model
            const llm = ctx.get?.('llm') || ctx.llm
            const attachments = ctx.get?.('attachments') || ctx.attachments
            if (!llm || !attachments || !activeProvider || !activeModel) throw new Error('无法确认当前模型的视觉能力')
            const info = await llm.resolveModelInfo(activeProvider, activeModel, exec.signal)
            if (!info.inputModalities?.includes('image')) throw new Error('当前模型不支持图片输入')
            const refs = await attachments.saveImages([{ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType }])
            imageBlock = { type: 'image', attachment: refs[0] }
            textValue.imageStatus = '预览图已提供给模型。'
          } catch (error) {
            textValue.imageStatus = `模型无法查看预览图：${error.message}。请查看已保存的预览文件。`
          }
          if (imageBlock) projections.set(exec, { value: textValue, imageBlock })
          return textValue
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
      if (chunk?.type === 'text-delta' && chunk.text) onProgress?.({ type: 'text', text: chunk.text })
    })
    agentCtx.on?.('session/event', (session, event) => {
      if (session?.id === activeSessionId && event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
        modelError = event.data.reason.error
      }
    })
  }
  try {
    handle = await agents.create({ sessionId: activeSessionId, meta: { cwd: path.resolve(cwd) }, agentOptions: { provider, model }, setup })
    onProgress?.({ type: 'status', text: '正在制作视频' })
    await Promise.race([
      submission,
      (async () => {
        await handle.agent.followup({ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' }, id: randomUUID() })
        await handle.agent.whenIdle()
        if (modelError) throw new Error(modelError.message)
        if (submitted) return
        // The host can report idle before the queued message is admitted.
        await new Promise(resolve => { settleTimer = setTimeout(resolve, 12000) })
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
    clearTimeout(settleTimer)
  }
}
