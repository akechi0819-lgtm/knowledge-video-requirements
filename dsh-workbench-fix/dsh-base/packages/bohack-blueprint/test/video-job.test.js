import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runVideoJob } from '../lib/video-job.js'
import { defaultProcessGuidance } from '../lib/process-guidance.js'

const root = path.resolve(import.meta.dirname, '../../../../..')
const kit = path.join(root, 'video-kit')

for (const skill of [undefined, defaultProcessGuidance()]) {
  test(`default production guidance reaches the agent (${skill ? 'explicit default' : 'missing skill'})`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'video-default-test-'))
    const fakeKit = path.join(dir, 'fakekit')
    const modules = path.join(fakeKit, 'WORK/modules/video')
    const job = path.join(dir, 'job')
    const secret = 'test-tts-secret-do-not-record'
    const sentinel = new Error('stop before rendering')
    let prompt
    try {
      await mkdir(modules, { recursive: true })
      await mkdir(job)
      await writeFile(path.join(modules, 'playwright.cjs'), 'module.exports = { chromium: { launch() { throw new Error("unexpected browser launch") } } }')
      await writeFile(path.join(modules, 'style.mjs'), `export default ${JSON.stringify({ paths: { python: process.execPath, ffprobe: 'fake-ffprobe', playwright: path.join(modules, 'playwright.cjs') }, tts: { voice: 'fake', rate: '1' }, video: { fps: 30 }, timing: { leadIn: 0, tailPad: 0 } })}`)
      await writeFile(path.join(modules, 'pipeline.mjs'), 'export const preparedFrames = durations => durations.map(d => Math.ceil(d * 30)); export function seedTtsCache() {}')
      await writeFile(path.join(modules, 'isolated-page.mjs'), 'export function installSceneRoutes() {}')
      await writeFile(path.join(modules, 'tts_driver.py'), `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); fs.writeFileSync(process.argv[7], JSON.stringify({ segments: input.segments.map(s => ({ id: s.id, duration: 1, words: [] })) }));`)
      const registry = new Map()
      const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
      const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
        await setup(toolCtx)
        return { agent: { followup: async message => { prompt = message.content[0].text; throw sentinel }, cancel() {} } }
      } } }
      const production = { status: '准备制作', version: 'v1', topic: 'test', ...(skill ? { skill } : {}), sections: [{ id: 's1', title: 'test', narration: 'Hello.' }] }
      await assert.rejects(runVideoJob({ ctx, dir: job, kit: fakeKit, production, settings: { tts: { baseUrl: 'https://example.invalid', apiKey: secret } } }), error => error === sentinel)
      const guidance = defaultProcessGuidance()
      assert.ok(prompt.includes(guidance.content), '完整默认方法应直接出现在提示词中')
      for (const heading of ['拆解与核证', '知识讲述', '动态设计', '直观演示']) assert.match(prompt, new RegExp(heading))
      assert.doesNotMatch(prompt, /andy-vibe-knowledge|Andy个人/i)
      assert.match(prompt, /不必重复调用 skill/)
      assert.match(prompt, /保留方法中的讲述、设计与旁白对位标准/)
      assert.match(prompt, /执行流程以本次网页制作契约为准/)
      assert.match(prompt, /配音已生成；不重新选题、改旁白、提问或请求逐项确认/)
      assert.equal(registry.has('read_skill_file'), false, '单篇方法没有外部资料文件，不应提供无法完成的读文件工具')
      assert.equal(registry.has('compose'), false)
      assert.equal(registry.has('submit'), true)
      const timingText = await readFile(path.join(job, 'timings.jsonl'), 'utf8')
      const records = timingText.trim().split('\n').map(line => JSON.parse(line))
      for (const phase of ['tts', 'agent']) assert.ok(records.some(record => record.type === 'phase' && record.phase === phase))
      assert.ok(!timingText.includes(secret))
      assert.doesNotMatch(timingText, /apiKey|VIDEO_TTS_KEY/i)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('submit 渲染或质检失败时抛错，任务不能成功完成', async () => {
  for (const failure of ['render', 'verify']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `video-submit-${failure}-`))
    const fakeKit = path.join(dir, 'fakekit'), modules = path.join(fakeKit, 'WORK/modules/video'), job = path.join(dir, 'job')
    try {
      await mkdir(modules, { recursive: true })
      await mkdir(job)
      await writeFile(path.join(modules, 'playwright.cjs'), 'module.exports = { chromium: {} }')
      await writeFile(path.join(modules, 'style.mjs'), `export default ${JSON.stringify({ paths: { python: process.execPath, ffprobe: 'fake-ffprobe', playwright: path.join(modules, 'playwright.cjs') }, tts: { voice: 'fake', rate: '1' }, video: { fps: 30 }, timing: { leadIn: 0, tailPad: 0 } })}`)
      await writeFile(path.join(modules, 'pipeline.mjs'), `export const preparedFrames = durations => durations.map(d => Math.ceil(d * 30)); export function seedTtsCache() {}\nif (process.argv.includes('--prepared')) { ${failure === 'render' ? "throw new Error('render failed')" : ''} }`)
      await writeFile(path.join(modules, 'verify.mjs'), "throw new Error('verify failed')")
      await writeFile(path.join(modules, 'isolated-page.mjs'), 'export function installSceneRoutes() {}')
      await writeFile(path.join(modules, 'tts_driver.py'), `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); fs.writeFileSync(process.argv[7], JSON.stringify({ segments: input.segments.map(s => ({ id: s.id, duration: 1, words: [] })) }));`)
      const registry = new Map(), listeners = new Map()
      let started = false
      const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on: (name, fn) => listeners.set(name, fn) }
      const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup, sessionId }) => {
        await setup(toolCtx)
        return { agent: { followup: async () => {
          if (!started) {
          started = true
          assert.equal(registry.has('compose'), false)
          assert.equal(registry.has('submit'), true)
          await registry.get('write_scene').execute({ id: 's1', html: '<div id="stage"></div>' })
          await assert.rejects(registry.get('submit').execute({}), new RegExp(`${failure} failed`))
          }
          listeners.get('session/event')({id:sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}})
        }, whenIdle: async () => {}, cancel() {} } }
      } } }
      const production = { status: '准备制作', version: 'v1', topic: 'test', sections: [{ id: 's1', title: 'test', narration: 'Hello.' }] }
      await assert.rejects(runVideoJob({ ctx, dir: job, kit: fakeKit, production }), /没有新的工具进展|未完成成片/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('video tools create and verify a film with real speech and task images', { timeout: 120000, skip: process.platform !== 'darwin' }, async t => {
  const ffmpeg = path.join(kit, '.runtime/bin/ffmpeg'), ffprobe = path.join(kit, '.runtime/bin/ffprobe')
  try { await Promise.all([access(ffmpeg, constants.X_OK), access(ffprobe, constants.X_OK)]) } catch { t.skip('video-kit runtime unavailable'); return }
  process.env.VIDEO_FFMPEG = ffmpeg; process.env.VIDEO_FFPROBE = ffprobe; process.env.VIDEO_VOICE = 'say:Alex'
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-job-test-'))
  const previous = path.join(dir, 'old'), job = path.join(dir, 'new')
  const registry = new Map()
  const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
  let previewPath
  const ctx = { attachments: { saveImages: async images => { assert.equal(images[0].mediaType, 'image/png'); return [{ id: 'preview-image' }] } }, agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
    await setup(toolCtx)
    return { agent: { followup: async () => {
      const call = (name, args = {}) => registry.get(name).execute(args)
      assert.match((await call('read_previous_scene', { id: 's1' })).html, /old/)
      assert.equal(registry.has('read_skill_file'), false)
      assert.equal(registry.has('compose'), false)
      assert.equal(registry.has('submit'), true)
      await assert.rejects(call('submit'), /先按意见修改/)
      const timing = await call('tts_durations')
      assert.ok(timing.durations.s1 > 0); assert.ok(timing.plans.s1.duration >= timing.durations.s1)
      await call('write_scene', { id: 's1', html: '<div id="stage" style="width:1280px;height:720px;background:white"><img src="../assets/test.svg"></div><script>window.seek=t=>{}</script>' })
      const preview = await call('preview', { id: 's1', seconds: 0 })
      assert.match(preview.imageStatus, /预览图已提供给模型/); previewPath = preview.imagePath
      assert.equal((await call('submit')).ok, true)
    }, whenIdle: async () => {}, cancel() {} } }
  } } }
  try {
    await mkdir(path.join(previous, 'scenes'), { recursive: true }); await mkdir(path.join(job, 'assets'), { recursive: true })
    await writeFile(path.join(previous, 'scenes/s1.html'), 'old')
    const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
    const previousAudio = path.join(previous, 'film/audio')
    await mkdir(previousAudio, { recursive: true })
    const input = path.join(previous, 'tts-input.json'), result = path.join(previousAudio, 'tts-result.json')
    await writeFile(input, JSON.stringify({ blueprint_id: 'v1', segments: [{ id: 's1', narration: 'Hello.' }] }))
    const synthesize = () => promisify(execFile)(style.paths.python, [path.join(kit, 'WORK/modules/video/tts_driver.py'), input, previousAudio, 'say:Alex', style.tts.rate, ffprobe, result])
    await synthesize()
    const originalAudio = await readFile(path.join(previousAudio, 's1.mp3'))
    await writeFile(path.join(job, 'assets/test.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    await runVideoJob({ ctx, dir: job, kit, previousDir: previous, feedback:'更新画面', production: { status: '准备制作', version: 'v1', topic: 'test', skill: { id: 'custom', name: '自定义', content: '自定义制作规则' }, style: { id: 'general', description: '冻结的视觉规则' }, sections: [{ id: 's1', blueprintId: 'B01', title: 'test', narration: 'Hello.', assets: [{ image: 'assets/test.svg' }] }] } })
    assert.equal(JSON.parse(await readFile(path.join(job, 'audio-cache/tts-result.json'))).cache_hits_this_run, 1)
    assert.deepEqual(await readFile(path.join(job, 'film/audio/s1.mp3')), originalAudio)
    await writeFile(input, JSON.stringify({ blueprint_id: 'v1', segments: [{ id: 's1', narration: 'Changed narration.' }] }))
    await synthesize()
    assert.equal(JSON.parse(await readFile(result)).cache_hits_this_run, 0)
    assert.match(await readFile(path.join(job, 'video-agent/.agents/skills/film-visual-style/SKILL.md'), 'utf8'), /冻结的视觉规则/)
    assert.ok((await readFile(previewPath)).length > 100)
    const mapping = JSON.parse(await readFile(path.join(job, 'film/mapping.json')))
    assert.equal(mapping.segments[0].blueprint_id, 'B01')
    assert.ok((await readFile(path.join(job, 'film/final.mp4'))).length > 0)
    assert.ok(JSON.parse(await readFile(path.join(job, 'film/verify-report.json'))).segments.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
