import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEngine, selectedMediaSummary } from '../lib/engine.js'

const dialogueTools = ['save_requirement', 'add_text_asset', 'mark_requirement_changed', 'request_blueprint', 'request_blueprint_revision', 'realize_asset', 'request_video_revision', 'request_confirm_and_produce']
const dangerousTools = ['bash', 'read', 'write', 'apply_patch', 'subagent']

function mockContext(globalNames, blueprintFailure, prompts = []) {
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
            async followup(message) {
              prompts.push(message.content[0].text)
              if (scoped.has('write_blueprint')) {
                const failure = blueprintFailure?.()
                if (failure) {
                  listeners.get('agent/assistant-stream')({ frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } } })
                  return
                }
                assert.ok(!scoped.get('write_blueprint').parameters.properties.sections.items.required.includes('visual'))
                const result = await scoped.get('write_blueprint').execute({
                  topic: '火山', assets: [], sections: [
                    { id: 'B01', title: '喷发', intent: '岩浆从地表喷出。' },
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

test('blueprint reports the model failure code without leaking its message or poisoning the next turn', async () => {
  let failure = { code: 'TRANSPORT', message: 'private provider details' }
  const mock = mockContext(['skill'], () => failure)
  const engine = createEngine(mock.ctx)
  await assert.rejects(engine.produce({ requirementText: '讲火山' }), {
    message: '蓝图模型请求失败（TRANSPORT）',
  })
  failure = null
  assert.equal((await engine.produce({ requirementText: '讲火山' })).toolSubmitted, true)
  engine.reset()
})

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


test('生成与修订均只传递选中 Skill 的有界元数据', async () => {
  const prompts = []
  const mock = mockContext(['skill'], null, prompts)
  const engine = createEngine(mock.ctx)
  const skill = { name: '示例', description: '无旁白字幕知识短片，支持互动课件。' + '长'.repeat(3000), content: '秘密完整技能正文不得进入蓝图' }
  for (const action of ['draft', 'revise']) await engine.produce({ action, skill, requirementText: '讲火山', previousDoc: { raw: '旧蓝图' }, version: 2 })
  assert.equal(prompts.length, 2)
  for (const prompt of prompts) {
    assert.match(prompt, /可见的具体对象及本段中对象发生什么变化/)
    assert.match(prompt, /出处紧跟对应的关键事实，核查过程留在备注/)
    assert.match(prompt, /必要的不确定性、准确性限定和用户要求的表述边界仍须保留/)
    assert.match(prompt, /旁白形态：无旁白/)
    assert.match(prompt, /互动形态：包含互动内容/)
    assert.match(prompt, /Skill 自有结构规划时由 Skill 决定成片结构/)
    assert.doesNotMatch(prompt, /秘密完整技能正文/)
  }
  assert.ok(Buffer.byteLength(selectedMediaSummary({skill}), 'utf8') <= 2048)
  const quotes = '"'.repeat(1000)
  assert.ok(Buffer.byteLength(selectedMediaSummary({skill:{name:quotes,description:quotes,planning:{description:quotes+'x',mode:quotes}}}), 'utf8') <= 2048)
  assert.doesNotMatch(selectedMediaSummary({style:{name:'普通',description:'清晰的视觉风格'}}), /旁白形态|互动形态/)
  assert.match(selectedMediaSummary({skill:{name:'有声',description:'有旁白的讲解短片'}}), /旁白形态：有旁白/)
  engine.reset()
})
