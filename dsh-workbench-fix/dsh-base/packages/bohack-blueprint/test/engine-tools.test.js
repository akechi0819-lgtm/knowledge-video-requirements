import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'

const dialogueTools = ['save_requirement', 'add_text_asset', 'mark_requirement_changed', 'request_blueprint', 'request_blueprint_revision', 'realize_asset', 'request_video_revision', 'request_confirm_and_produce']
const dangerousTools = ['bash', 'read', 'write', 'apply_patch', 'subagent']

function mockContext(globalNames) {
  const globals = new Set()
  const scoped = new Map()
  const masks = new Set()
  const guards = new Set()
  const listeners = new Map()
  const tools = {
    register(tool) { scoped.set(tool.name, tool) },
    view() { return { restrictableNames: [...globals, ...scoped.keys()] } },
    restrict({ deny }) {
      assert.ok(deny.length)
      assert.ok(deny.every(name => globals.has(name) || scoped.has(name)))
      masks.add(deny)
      return () => masks.delete(deny)
    },
    guard(fn) { guards.add(fn); return () => guards.delete(fn) },
  }
  return {
    available(name) {
      return (scoped.has(name) || (globals.has(name) && ![...masks].some(mask => mask.includes(name))))
        && ![...guards].some(guard => guard({ name }))
    },
    ctx: {
      agentPresets: {
        async mount(_agentCtx, preset) {
          assert.ok(['standard', 'bohack-chat', 'blueprint'].includes(preset))
          for (const name of globalNames) globals.add(name)
        },
      },
      agents: {
        async create({ setup }) {
          await setup({ tools, on: (name, listener) => listeners.set(name, listener) })
          return { agent: {
            async followup() {
              if (scoped.has('write_blueprint')) {
                const result = await scoped.get('write_blueprint').execute({
                  topic: '火山', assets: [], sections: [
                    { id: 'B01', title: '喷发', intent: '岩浆从地表喷出。', visual: '火山喷发的过程。' },
                    { id: 'B02', title: '冷却', intent: '岩浆冷却形成岩石。', visual: '岩浆变为岩石。' },
                  ],
                })
                assert.equal(result.ok, true)
              } else {
                listeners.get('agent/assistant-stream')({ frame: { type: 'chunk', chunk: { type: 'text-delta', text: '已记下。' } } })
              }
            },
            async whenIdle() {},
          } }
        },
      },
    },
  }
}

for (const globals of [['web_search', 'skill'], ['web_search', 'skill', ...dangerousTools]]) {
  test(`dialogue keeps web search and all requirement tools with globals: ${globals.join(', ')}`, async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-engine-tools-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const skillDir = path.join(workspace, '.agents', 'skills', 'knowledge-video-requirement')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '只整理用户明确提供的视频需求。')
    const mock = mockContext(globals)
    const engine = createEngine(mock.ctx, { workspace })
    await engine.chatTurn({ text: '讲火山' })
    for (const name of ['web_search', 'skill', ...dialogueTools]) assert.equal(mock.available(name), true, name)
    for (const name of dangerousTools) assert.equal(mock.available(name), false, name)
    engine.reset()
  })
}

for (const allowWebResearch of [true, false]) {
  test(`blueprint setup respects allowWebResearch=${allowWebResearch}`, async () => {
    const mock = mockContext(['web_search', 'skill'])
    const engine = createEngine(mock.ctx, { allowWebResearch })
    await engine.produce({ requirementText: '讲火山' })
    assert.equal(mock.available('web_search'), allowWebResearch)
    for (const name of ['skill', 'write_blueprint', 'read_requirement', 'query_scene']) assert.equal(mock.available(name), true, name)
    for (const name of dangerousTools) assert.equal(mock.available(name), false, name)
    engine.reset()
  })
}
