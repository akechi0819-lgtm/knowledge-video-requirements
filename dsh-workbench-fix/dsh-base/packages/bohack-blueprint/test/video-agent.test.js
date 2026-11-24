import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVideoAgent } from '../lib/video-agent.js'

function host(run, whenIdle = () => new Promise(() => {})) {
  const registered = new Map()
  const listeners = new Map()
  const state = {}
  const agentCtx = { tools: {
    register: tool => registered.set(tool.name, tool),
    guard: fn => { state.guard = fn },
    view: () => ({ restrictableNames: ['bash', 'skill'] }),
    restrict: value => { state.restriction = value },
  }, on: (name, fn) => listeners.set(name, fn) }
  const ctx = { agentPresets: { mount: async (_ctx, id) => { state.preset = id } }, agents: {
    create: async options => {
      state.options = options
      await options.setup(agentCtx)
      return { agent: { session: { id:options.sessionId }, followup: async message => { state.message = message; await run(registered, listeners); listeners.get('session/event')?.({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}}) }, whenIdle, cancel() {} } }
    },
  } }
  return { ctx, state }
}
const tools = [{ name: 'submit', description: 'submit', parameters: { type: 'object' }, execute: async args => ({ ok: true, args }) }]

test('records step and tool timing without retaining content or mixing sessions', async t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const records = []
  const render = { name: 'render', description: '', parameters: {}, execute: async () => { now = 1040; return { text: 'secret output' } } }
  const { ctx } = host(async (registered, listeners) => {
    const emit = listeners.get('session/event')
    const stream = listeners.get('agent/assistant-stream')
    emit({ id: 'test' }, { type: 'step/start', time: 1000, data: { turn: 1, step: 2 } })
    emit({ id: 'other' }, { type: 'step/start', time: 1001, data: { turn: 99, step: 99 } })
    stream({ sessionId: 'other', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'ignore me' } } })
    stream({ frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '思考中' } } })
    stream({ sessionId: 'test', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '正文' } } })
    stream({ sessionId: 'test', frame: { type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta: 'secret-code' } } })
    now = 1020
    await registered.get('render').execute({ prompt: 'secret input', key: 'secret key' })
    emit({ id: 'other' }, { type: 'step/end', time: 1050, data: { turn: 1, step: 2 } })
    emit({ id: 'test' }, { type: 'step/end', time: 1100, data: { turn: 1, step: 2 } })
    await registered.get('submit').execute({ file: 'secret film' })
  })
  await runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp', prompt: 'secret prompt', tools: [...tools, render], onTiming: record => records.push(record) })
  assert.deepEqual(records[0], { type: 'tool', sessionId: 'test', turn: 1, step: 2, toolName: 'render', start: 1020, end: 1040, elapsed: 20 })
  assert.deepEqual(records[1], { type: 'step', sessionId: 'test', turn: 1, step: 2, start: 1000, end: 1100, elapsed: 100, toolMs: 20, modelWaitMs: 80, toolNames: ['render'], reasoningChars: 3, textChars: 2, toolArgumentChars: 11 })
  assert.equal(records[2].toolName, 'submit')
  assert.doesNotMatch(JSON.stringify(records), /secret|思考|正文|ignore/)
})

test('mounts video preset, isolates tools and returns a successful submit', async () => {
  const { ctx, state } = host(async registered => { await registered.get('submit').execute({ file: 'film.mp4' }) })
  const result = await runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp/film', model: 'm', provider: 'p', prompt: 'make', tools })
  assert.equal(state.preset, 'bohack-video')
  assert.equal(state.options.meta.cwd, '/tmp/film')
  assert.deepEqual(state.options.agentOptions, { provider: 'p', model: 'm' })
  assert.equal(state.guard({ name: 'submit' }), undefined)
  assert.ok(state.guard({ name: 'skill' }))
  assert.ok(state.guard({ name: 'bash' }))
  assert.deepEqual(state.restriction, { deny: ['bash', 'skill'] })
  assert.equal(state.message.role, 'user')
  assert.equal(result.args.file, 'film.mp4')
})

test('pins the production session title before sending the first prompt', async () => {
  let title
  const { ctx } = host(async registered => {
    assert.deepEqual(title, [{ id:'production-title-fixture' }, '正在制作视频'])
    await registered.get('submit').execute({})
  })
  ctx.sessionTitle = { rename(...args) { title = args } }
  await runVideoAgent({ ctx, sessionId:'production-title-fixture', cwd:'/tmp', prompt:'make', tools })
})

test('passes an explicit reasoning effort to the host', async () => {
  const { ctx, state } = host(async registered => { await registered.get('submit').execute({}) })
  await runVideoAgent({ ctx, cwd: '/tmp', model: 'm', provider: 'p', reasoningEffort: 'off', prompt: 'make', tools })
  assert.deepEqual(state.options.agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'off' })
})

test('rejects a session missing submit', async () => {
  const { ctx } = host(() => {})
  await assert.rejects(runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [] }), /submit/)
})

test('continues the same unfinished session after real tool progress', async () => {
  let turns = 0
  let idle = true
  let idlePromise
  const progress = { name: 'write_scene', parameters: {}, execute: async () => ({ ok: true }) }
  const { ctx, state } = host(async registered => {
    assert.equal(idle, true, 'turn/end does not mean the driver can accept another turn')
    idle = false
    turns++
    if (turns === 1) {
      await registered.get('write_scene').execute({})
      idlePromise = new Promise(resolve => setImmediate(() => { idle = true; resolve() }))
    }
    else await registered.get('submit').execute({ file: 'finished.mp4' })
  }, () => idlePromise)
  const result = await runVideoAgent({ ctx, sessionId: 'same-job', cwd: '/tmp', prompt: 'make', tools: [...tools, progress] })
  assert.equal(turns, 2)
  assert.equal(state.options.sessionId, 'same-job')
  assert.equal(result.args.file, 'finished.mp4')
})

test('fails when continuation produces no further tool progress', async () => {
  let turns = 0
  const progress = { name: 'write_scene', parameters: {}, execute: async () => ({ ok: true }) }
  const { ctx } = host(async registered => {
    if (++turns === 1) await registered.get('write_scene').execute({})
  }, async () => {})
  await assert.rejects(runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, progress] }), /没有新的工具进展/)
  assert.equal(turns, 2)
})

test('does not resume an interrupted turn even after tool progress', async () => {
  let turns = 0
  const progress = { name: 'write_scene', parameters: {}, execute: async () => ({ ok: true }) }
  const { ctx } = host(async (registered, listeners) => {
    turns++
    await registered.get('write_scene').execute({})
    listeners.get('session/event')({id:'cancelled-job'},{type:'turn/end',data:{reason:{kind:'cancelled'}}})
  }, async () => {})
  await assert.rejects(runVideoAgent({ ctx, sessionId: 'cancelled-job', cwd: '/tmp', prompt: 'make', tools: [...tools, progress] }), /会话已中止/)
  assert.equal(turns, 1)
})

test('rejects duplicate tool names', async () => {
  const { ctx } = host(() => {})
  await assert.rejects(runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, tools[0]] }), /制作工具名称重复/)
})

test('allows skill when explicitly supplied as a tool', async () => {
  const { ctx, state } = host(async registered => { await registered.get('submit').execute({}) })
  await runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, { name: 'skill', execute: async () => ({}) }] })
  assert.equal(state.guard({ name: 'skill' }), undefined)
  assert.deepEqual(state.restriction, { deny: ['bash'] })
})

test('reports this session’s model error after idle and ignores other sessions', async () => {
  const { ctx } = host(async (_registered, listeners) => {
    const emit = listeners.get('session/event')
    emit({ id: 'test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Provider finish_reason: content_filter', code: 'PI_AI_ERROR' } } } })
    emit({ id: 'other' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'other session failure' } } } })
  }, async () => {})
  await assert.rejects(runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp', prompt: 'make', tools }), /Provider finish_reason: content_filter/)
})

test('localizes a temporary upstream model failure without exposing the response body', async () => {
  const { ctx } = host(async (_registered, listeners) => {
    listeners.get('session/event')({ id: 'test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '503: {"message":"Service temporarily unavailable","type":"api_error"}', code: 'SERVER' } } } })
  }, async () => {})
  await assert.rejects(runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp', prompt: 'make', tools }), {
    message: '画面模型服务暂时不可用（503），制作已暂停。',
  })
})

test('keeps a session alive beyond ten minutes while tools make progress', async t => {
  let now = 0
  const timers = new Set()
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, deadline: now + delay, refresh() { this.deadline = now + this.delay; return this } }
    timers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer))
  const tick = duration => {
    now += duration
    for (const timer of timers) {
      if (timer.deadline <= now) { timers.delete(timer); timer.callback() }
    }
  }
  let registered
  const { ctx } = host(async available => {
    registered = available
    await new Promise(() => {})
  })
  const progress = { name: 'progress', description: '', parameters: { type: 'object' }, execute: async () => ({ ok: true }) }
  const result = runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, progress] })
  // Allow session setup and the inactivity timer to start.
  await new Promise(resolve => setImmediate(resolve))
  for (let index = 0; index < 6; index++) {
    tick(120000)
    await registered.get('progress').execute({})
  }
  await registered.get('submit').execute({ file: 'film.mp4' })
  assert.equal((await result).args.file, 'film.mp4')

  const idle = host(async () => { await new Promise(() => {}) })
  const timeout = runVideoAgent({ ctx: idle.ctx, cwd: '/tmp', prompt: 'make', tools })
  await new Promise(resolve => setImmediate(resolve))
  tick(720000)
  await assert.rejects(timeout, /长时间没有活动.*已暂停/)
})

test('warns after two minutes and clears the warning when tool progress resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let registered
  const progress = { name: 'progress', parameters: {}, execute: async () => ({ ok: true }) }
  const { ctx } = host(async available => { registered = available; await new Promise(() => {}) })
  const result = runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, progress], onProgress: event => events.push(event) })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(119999)
  assert.equal(events.filter(event => event.type === 'wait').length, 0)
  t.mock.timers.tick(1)
  assert.match(events.at(-1).text, /等待/)
  assert.equal(events.at(-1).type, 'wait')
  await registered.get('progress').execute({})
  assert.deepEqual(events.at(-1), { type: 'wait', text: '' })
  t.mock.timers.tick(120000)
  assert.match(events.at(-1).text, /等待/)
  await registered.get('submit').execute({})
  await result
  assert.deepEqual(events.at(-1), { type: 'wait', text: '' })
  t.mock.timers.tick(600000)
  assert.deepEqual(events.at(-1), { type: 'wait', text: '' })
})

test('reports a quiet model at 25 seconds and resumes activity on streaming or tool execution', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let registered, listeners
  const { ctx } = host(async (tools, hooks) => {
    registered = tools
    listeners = hooks
    await new Promise(() => {})
  })
  const result = runVideoAgent({ ctx, sessionId: 'live', cwd: '/tmp', prompt: 'make', tools, runtime: {}, onProgress: event => events.push(event) })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(24999)
  assert.equal(events.some(event => event.type === 'activity'), false)
  t.mock.timers.tick(1)
  assert.deepEqual(events.at(-1), { type: 'activity', text: '正在等待模型生成下一步…' })
  assert.equal(events.some(event => event.type === 'wait'), false)
  const stream = listeners.get('agent/assistant-stream')
  const frame = { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'planning' } }
  stream({ sessionId: 'other', frame })
  assert.match(events.at(-1).text, /正在等待模型/)
  stream({ sessionId: 'live', frame })
  assert.deepEqual(events.at(-1), { type: 'activity', text: '模型正在生成下一步…' })
  t.mock.timers.tick(25000)
  assert.match(events.at(-1).text, /正在等待模型/)
  await listeners.get('tools/execute')({ agent: { id: 'live' }, name: 'bash' }, async () => {
    assert.deepEqual(events.at(-1), { type: 'activity', text: '正在运行生成或渲染脚本…' })
    t.mock.timers.tick(25000)
    assert.match(events.at(-1).text, /正在运行/)
    return { isError: false }
  })
  t.mock.timers.tick(25000)
  assert.match(events.at(-1).text, /正在等待模型/)
  await registered.get('submit').execute({})
  await result
  const count = events.length
  t.mock.timers.tick(120000)
  assert.equal(events.length, count)
})

test('keeps an active tool alive until the total production budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let registered
  let aborted
  const slow = { name: 'slow', parameters: {}, execute: async (_args, signal) => {
    aborted = signal
    await new Promise(() => {})
  } }
  const { ctx } = host(async available => { registered = available; await new Promise(() => {}) })
  const result = runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, slow], onProgress: event => events.push(event) })
  await new Promise(resolve => setImmediate(resolve))
  void registered.get('slow').execute({})
  t.mock.timers.tick(660000)
  assert.equal(events.filter(event => event.type === 'wait').length, 0)
  assert.equal(aborted.aborted, false)
  t.mock.timers.tick(3600000 - 660000)
  await assert.rejects(result, /达到总时间预算/)
  assert.equal(aborted.aborted, true)
})

test('reports model errors immediately and clears the pending warning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let fail
  const { ctx } = host(async (_registered, listeners) => {
    await new Promise(resolve => { fail = () => {
      listeners.get('session/event')({ id: 'test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '503: unavailable' } } } })
      resolve()
    } })
  })
  const result = runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp', prompt: 'make', tools, onProgress: event => events.push(event) })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(120000)
  fail()
  await assert.rejects(result, /画面模型服务暂时不可用（503）/)
  assert.deepEqual(events.at(-1), { type: 'wait', text: '' })
  const count = events.length
  t.mock.timers.tick(600000)
  assert.equal(events.length, count)
})

test('projects screenshots as attachments and protects projection consistency', async () => {
  let captured
  const { ctx } = host(async registered => {
    const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} }, signal: new AbortController().signal }
    const tool = registered.get('preview')
    const value = await tool.execute({}, exec)
    assert.equal(tool.projectContent(exec, { value: { ...value, path: 'changed.png' }, isError: false }), undefined)
    const nextValue = await tool.execute({}, exec)
    captured = { value: nextValue, content: tool.projectContent(exec, { value: nextValue, isError: false }) }
    await registered.get('submit').execute({})
  })
  ctx.attachments = { saveImages: async input => { assert.equal(input[0].data.toString(), 'image'); assert.equal(input[0].mediaType, 'image/png'); return [{ id: 'attachment' }] } }
  await runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, { name: 'preview', description: '', parameters: { type: 'object' }, execute: async () => ({ ok: true, path: 'preview.png', image: { mimeType: 'image/png', data: Buffer.from('image').toString('base64') } }) }] })
  assert.equal(captured.value.image, undefined)
  assert.equal(captured.content[1].attachment.id, 'attachment')
  assert.doesNotMatch(captured.content[0].text, /aW1hZ2U=/)
})

test('reports unavailable visual review for a text-only production route', async () => {
  let preview
  const { ctx } = host(async registered => {
    preview = await registered.get('view_image').execute({}, {})
    await registered.get('submit').execute({})
  })
  ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  ctx.attachments = { saveImages: async () => assert.fail('text-only route must not receive an image attachment') }
  await runVideoAgent({ ctx, cwd: '/tmp', runtime: {}, model: 'text-only', provider: 'provider', prompt: 'make', tools: [
    ...tools,
    { name: 'view_image', execute: async () => ({ ok: true, image: { mimeType: 'image/png', data: 'aW1hZ2U=' } }) },
  ] })
  assert.equal(preview.ok, false)
  assert.match(preview.message, /视觉自检尚未完成/)
})

test('propagates attachment service errors instead of reporting a successful preview', async () => {
  let failure
  const { ctx } = host(async registered => {
    try {
      await registered.get('preview').execute({}, {})
    } catch (error) {
      failure = error
    }
    await registered.get('submit').execute({})
  })
  ctx.attachments = { saveImages: async () => { throw new Error('attachment service failed') } }
  await runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, { name: 'preview', description: '', parameters: { type: 'object' }, execute: async () => ({ ok: true, path: 'preview.png', image: { mimeType: 'image/png', data: 'aW1hZ2U=' } }) }] })
  assert.match(failure?.message || '', /attachment service failed/)
})
