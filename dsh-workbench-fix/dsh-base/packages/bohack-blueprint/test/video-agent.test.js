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
      return { agent: { followup: async message => { state.message = message; await run(registered, listeners); listeners.get('session/event')?.({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}}) }, whenIdle, cancel() {} } }
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
  const progress = { name: 'write_scene', parameters: {}, execute: async () => ({ ok: true }) }
  const { ctx, state } = host(async registered => {
    turns++
    if (turns === 1) await registered.get('write_scene').execute({})
    else await registered.get('submit').execute({ file: 'finished.mp4' })
  }, async () => {})
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
  for (let i = 0; i < 3; i++) {
    tick(300000)
    await registered.get('progress').execute({})
  }
  await registered.get('submit').execute({ file: 'film.mp4' })
  assert.equal((await result).args.file, 'film.mp4')

  const idle = host(async () => { await new Promise(() => {}) })
  const timeout = runVideoAgent({ ctx: idle.ctx, cwd: '/tmp', prompt: 'make', tools })
  await new Promise(resolve => setImmediate(resolve))
  tick(600000)
  await assert.rejects(timeout, /连续十分钟没有工具进展/)
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
