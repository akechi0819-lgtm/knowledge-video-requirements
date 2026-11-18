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
      return { agent: { followup: async message => { state.message = message; await run(registered, listeners) }, whenIdle, cancel() {} } }
    },
  } }
  return { ctx, state }
}
const tools = [{ name: 'submit', description: 'submit', parameters: { type: 'object' }, execute: async args => ({ ok: true, args }) }]

test('mounts video preset, isolates tools and returns a successful submit', async () => {
  const { ctx, state } = host(async registered => { await registered.get('submit').execute({ file: 'film.mp4' }) })
  const result = await runVideoAgent({ ctx, sessionId: 'test', cwd: '/tmp/film', model: 'm', provider: 'p', prompt: 'make', tools })
  assert.equal(state.preset, 'bohack-video')
  assert.equal(state.options.meta.cwd, '/tmp/film')
  assert.deepEqual(state.options.agentOptions, { provider: 'p', model: 'm' })
  assert.equal(state.guard({ name: 'submit' }), undefined)
  assert.equal(state.guard({ name: 'skill' }), undefined)
  assert.ok(state.guard({ name: 'bash' }))
  assert.deepEqual(state.restriction, { deny: ['bash'] })
  assert.equal(state.message.role, 'user')
  assert.equal(result.args.file, 'film.mp4')
})

test('rejects a session missing submit', async () => {
  const { ctx } = host(() => {})
  await assert.rejects(runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [] }), /submit/)
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

test('projects screenshots as attachments only for image-capable models', async () => {
  let captured
  const { ctx } = host(async registered => {
    const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} }, signal: new AbortController().signal }
    const tool = registered.get('preview')
    const value = await tool.execute({}, exec)
    captured = { value, content: tool.projectContent(exec, { value, isError: false }) }
    await registered.get('submit').execute({})
  })
  ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  ctx.attachments = { saveImages: async input => { assert.equal(input[0].data.toString(), 'image'); return [{ id: 'attachment' }] } }
  await runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, { name: 'preview', description: '', parameters: { type: 'object' }, execute: async () => ({ ok: true, path: 'preview.png', image: { mimeType: 'image/png', data: Buffer.from('image').toString('base64') } }) }] })
  assert.equal(captured.value.image, undefined)
  assert.equal(captured.content[1].attachment.id, 'attachment')
  assert.doesNotMatch(captured.content[0].text, /aW1hZ2U=/)
})

test('reports unsupported vision without sending base64 as text', async () => {
  let value
  const { ctx } = host(async registered => {
    value = await registered.get('preview').execute({}, { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} }, signal: new AbortController().signal })
    await registered.get('submit').execute({})
  })
  ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  ctx.attachments = { saveImages: async () => { throw new Error('should not save') } }
  await runVideoAgent({ ctx, cwd: '/tmp', prompt: 'make', tools: [...tools, { name: 'preview', description: '', parameters: { type: 'object' }, execute: async () => ({ ok: true, path: 'preview.png', image: { mimeType: 'image/png', data: 'aW1hZ2U=' } }) }] })
  assert.match(value.imageStatus, /不支持图片输入/)
  assert.equal(value.path, 'preview.png')
  assert.equal(value.image, undefined)
})
