import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, cp, copyFile } from 'node:fs/promises'
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

for (const [skill, fallback] of [[undefined, false], [defaultProcessGuidance(), false], [undefined, true]]) {
  test(`default production guidance reaches the agent (${fallback ? 'API speech fallback' : skill ? 'explicit default' : 'missing skill'})`, async () => {
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
      await writeFile(path.join(modules, 'tts_driver.py'), `const fs = require('node:fs'); if (${fallback} && process.argv[4].startsWith('api:')) process.exit(2); const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); fs.writeFileSync(process.argv[7], JSON.stringify({ segments: input.segments.map(s => ({ id: s.id, duration: 1, words: [] })) }));`)
      const registry = new Map()
      const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
      const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
        await setup(toolCtx)
        return { agent: { followup: async message => { prompt = message.content[0].text; throw sentinel }, cancel() {} } }
      } } }
      const production = { status: '准备制作', version: 'v1', topic: 'test', ...(skill ? { skill } : {}), sections: [{ id: 's1', title: 'test', narration: 'Hello.' }] }
      await assert.rejects(runVideoJob({ ctx, dir: job, kit: fakeKit, production, settings: { tts: { baseUrl: 'https://example.invalid', apiKey: secret, ...(fallback && { voice: 'remote' }) } } }), error => error === sentinel)
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
      const fallbackEntry = records.find(record => record.type === 'tts-fallback')
      assert.equal(Boolean(fallbackEntry), fallback)
      if (fallback) assert.equal(fallbackEntry.requestedVoice, 'api:remote')
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

test('installed Skill uses managed tools to verify a film with real speech and task images', { timeout: 120000, skip: process.platform !== 'darwin' }, async t => {
  const ffmpeg = process.env.VIDEO_FFMPEG || path.join(kit, '.runtime/bin/ffmpeg')
  const ffprobe = process.env.VIDEO_FFPROBE || path.join(kit, '.runtime/bin/ffprobe')
  try { await Promise.all([access(ffmpeg, constants.X_OK), access(ffprobe, constants.X_OK)]) } catch { t.skip('video-kit runtime unavailable'); return }
  process.env.VIDEO_FFMPEG = ffmpeg; process.env.VIDEO_FFPROBE = ffprobe; process.env.VIDEO_VOICE = 'say:Samantha'
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-job-test-'))
  const previous = path.join(dir, 'old'), job = path.join(dir, 'new')
  const skill = path.join(dir, '.agents/skills/third-party-example')
  const registry = new Map()
  const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
  let previewPath
  const artifacts = process.env.JIANGJIE_TEST_ARTIFACTS
  const ctx = { attachments: { saveImages: async images => { assert.equal(images[0].mediaType, 'image/png'); return [{ id: 'preview-image' }] } }, agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
    await setup(toolCtx)
    return { agent: { followup: async ({ content }) => {
      assert.match(content[0].text, /冻结的视觉规则/)
      assert.match(content[0].text, /第三方制作规则/)
      assert.match(content[0].text, /允许|替换或重画/)
      assert.match(content[0].text, /data-protected-text/)
      assert.equal(registry.has('bash'), false)
      const call = (name, args = {}) => registry.get(name).execute(args, {})
      assert.match((await call('read_previous_scene', { id: 's1' })).html, /old/)
      assert.equal(registry.has('read_skill_file'), true)
      assert.equal(registry.has('compose'), false)
      assert.equal(registry.has('submit'), true)
      await assert.rejects(call('submit'), /先按意见修改/)
      const timing = await call('tts_durations')
      assert.equal(timing.plans.s1.stage.topBar, true)
      assert.ok(timing.durations.s1 > 0); assert.ok(timing.plans.s1.duration >= timing.durations.s1)
      const shot = (beatId, body, seek = '') => `<!doctype html><style>body{margin:0}</style><div id="stage" data-shot-id="${beatId}" style="width:100vw;height:100vh;display:flow-root;background:white">${body}</div><script>window.seek=t=>{${seek}}</script>`
      const first = '<img src="../assets/test.svg">'
      await call('write_scene', { id: 's1', html: shot('B01', first, "document.querySelector('#stage').dataset.shotId = t >= 0.3 ? 'B02' : 'B01'") })
      await call('write_scene', { id: 's7', html: shot('B08', '<h1 data-protected-text="标题">Second</h1>') })
      await call('write_scene', { id: 's8', html: shot('B08', '<h1 data-protected-text="标题">Third</h1><div style="position:fixed;left:0;right:0;top:80vh;height:100vh;background:#315ea8"></div>') })
      await assert.rejects(call('submit'), /B02 != B01[\s\S]*B08 != B07/)
      await assert.rejects(access(path.join(job, 'film/final.mp4')), { code: 'ENOENT' })
      if (artifacts) {
        const rejected = path.join(artifacts, 'rejected')
        await mkdir(rejected, { recursive: true })
        const pending = path.join(job, '.film-render')
        for (const name of ['final.mp4', 'mapping.json', 'verify-report.json', 'stills']) {
          await cp(path.join(pending, name), path.join(rejected, name), { recursive: true })
        }
      }
      await call('write_scene', { id: 's1', html: shot('B01', first) })
      await call('write_scene', { id: 's7', html: shot('B07', '<h1 data-protected-text="标题">Second</h1>') })
      const preview = await call('preview', { id: 's1', seconds: 0 })
      assert.match(preview.imageStatus, /预览图已提供给模型/); previewPath = preview.imagePath
      assert.equal((await call('submit')).ok, true)
    }, whenIdle: async () => {}, cancel() {} } }
  } } }
  try {
    await mkdir(path.join(previous, 'scenes'), { recursive: true }); await mkdir(path.join(job, 'assets'), { recursive: true })
    await writeFile(path.join(previous, 'scenes/s1.html'), 'old')
    await mkdir(skill, { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), '第三方制作规则')
    await writeFile(path.join(skill, 'jiangjie.stage.json'), '{"topBar":true,"tailCard":true}')
    const style = (await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')).href)).default
    const previousAudio = path.join(previous, 'film/audio')
    await mkdir(previousAudio, { recursive: true })
    const input = path.join(previous, 'tts-input.json'), result = path.join(previousAudio, 'tts-result.json')
    await writeFile(input, JSON.stringify({ blueprint_id: 'v1', segments: [{ id: 's1', narration: 'Hello.' }] }))
    const synthesize = () => promisify(execFile)(style.paths.python, [path.join(kit, 'WORK/modules/video/tts_driver.py'), input, previousAudio, 'say:Samantha', style.tts.rate, ffprobe, result])
    await synthesize()
    const originalAudio = await readFile(path.join(previousAudio, 's1.mp3'))
    await writeFile(path.join(job, 'assets/test.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    await runVideoJob({ ctx, dir: job, kit, skillsRoot: dir, previousDir: previous, feedback:'更新画面', production: { status: '准备制作', version: 'v1', topic: 'test', skill: { id: 'custom', name: '自定义', content: '自定义制作规则' }, style: { id: 'repo-skill:third-party-example', kind: 'skill', description: '冻结的视觉规则' }, sections: [
      { id: 's1', blueprintId: 'B01', title: 'First', narration: 'Hello.', assets: [{ image: 'assets/test.svg' }] },
      { id: 's7', blueprintId: 'B07', title: 'Second', narration: 'A second step.' },
      { id: 's8', blueprintId: 'B08', title: 'Third', narration: 'A third step.', facts: ['来源：《本地测试资料》'] },
    ] } })
    assert.equal(JSON.parse(await readFile(path.join(job, 'audio-cache/tts-result.json'))).cache_hits_this_run, 1)
    assert.deepEqual(await readFile(path.join(job, 'film/audio/s1.mp3')), originalAudio)
    await writeFile(input, JSON.stringify({ blueprint_id: 'v1', segments: [{ id: 's1', narration: 'Changed narration.' }] }))
    await synthesize()
    assert.equal(JSON.parse(await readFile(result)).cache_hits_this_run, 0)
    await assert.rejects(access(path.join(job, 'video-agent/.agents/skills')), { code: 'ENOENT' })
    assert.ok((await readFile(previewPath)).length > 100)
    const mapping = JSON.parse(await readFile(path.join(job, 'film/mapping.json')))
    assert.equal(mapping.segments[0].blueprint_id, 'B01')
    assert.deepEqual(mapping.segments[0].samples.map(({ fraction, shotId }) => [fraction, shotId]), [[0.25, 'B01'], [0.75, 'B01']])
    const compare = await readFile(path.join(job, 'film/stills/index.html'), 'utf8')
    assert.match(compare, /Hello\./)
    assert.match(compare, /资料来源 · 本地测试资料/)
    assert.ok((await readFile(path.join(job, 'film/final.mp4'))).length > 0)
    const report = JSON.parse(await readFile(path.join(job, 'film/verify-report.json')))
    assert.equal(report.pass, true)
    assert.deepEqual(report.segments.map(segment => segment.beatId), ['B01', 'B07', 'B08'])
    if (artifacts) {
      const accepted = path.join(artifacts, 'accepted')
      await mkdir(accepted, { recursive: true })
      for (const name of ['final.mp4', 'mapping.json', 'verify-report.json', 'stills']) {
        await cp(path.join(job, 'film', name), path.join(accepted, name), { recursive: true })
      }
      await copyFile(path.join(job, 'timings.json'), path.join(artifacts, 'timings.json'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('resume 保留已保存画面和配音缓存，并恢复返工校验', async () => {
  for (const changed of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'video-resume-'))
    const fakeKit = path.join(dir, 'fakekit'), modules = path.join(fakeKit, 'WORK/modules/video')
    const job = path.join(dir, 'job'), previous = path.join(dir, 'previous')
    const sentinel = new Error('agent stopped')
    try {
      await mkdir(modules, { recursive: true })
      await mkdir(path.join(job, 'scenes'), { recursive: true })
      await mkdir(path.join(job, 'audio-cache'), { recursive: true })
      await mkdir(path.join(previous, 'scenes'), { recursive: true })
      await writeFile(path.join(previous, 'scenes/s1.html'), 'original')
      await writeFile(path.join(job, 'scenes/s1.html'), changed ? 'revised' : 'original')
      await writeFile(path.join(job, 'audio-cache/s1.mp3'), 'cached audio')
      await writeFile(path.join(modules, 'playwright.cjs'), 'module.exports = { chromium: {} }')
      await writeFile(path.join(modules, 'style.mjs'), `export default ${JSON.stringify({ paths: { python: process.execPath, ffprobe: 'fake', playwright: path.join(modules, 'playwright.cjs') }, tts: { voice: 'fake', rate: '1' }, video: { fps: 30 }, timing: { leadIn: 0, tailPad: 0 } })}`)
      await writeFile(path.join(modules, 'pipeline.mjs'), `export const preparedFrames = d => d.map(() => 30); export function seedTtsCache() { throw new Error('must preserve cache') }; if (process.argv.includes('--prepared')) throw new Error('render reached')`)
      await writeFile(path.join(modules, 'isolated-page.mjs'), 'export function installSceneRoutes() {}')
      await writeFile(path.join(modules, 'tts_driver.py'), `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); if (fs.readFileSync(process.argv[3] + '/s1.mp3', 'utf8') !== 'cached audio') throw Error('cache lost'); fs.writeFileSync(process.argv[7], JSON.stringify({ segments: input.segments.map(s => ({ id: s.id, duration: 1 })) }));`)
      const registry = new Map()
      const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
      const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
        await setup(toolCtx)
        return { agent: { followup: async message => {
          assert.match(message.content[0].text, /已保存的段落：\["s1"\]/)
          assert.match(message.content[0].text, /尚未保存的段落：\["s2"\]/)
          assert.equal((await registry.get('read_saved_scene').execute({ id: 's1' })).html, changed ? 'revised' : 'original')
          await writeFile(path.join(job, 'scenes/s2.html'), 'second')
          await assert.rejects(registry.get('submit').execute({}), changed ? /render reached/ : /先按意见修改/)
          throw sentinel
        }, cancel() {} } }
      } } }
      const production = { version: 'v1', sections: [{ id: 's1', narration: 'one' }, { id: 's2', narration: 'two' }] }
      await assert.rejects(runVideoJob({ ctx, dir: job, kit: fakeKit, production, previousDir: previous, feedback: '调整', resume: true }), error => error === sentinel)
      assert.equal(await readFile(path.join(job, 'scenes/s1.html'), 'utf8'), changed ? 'revised' : 'original')
      assert.equal(await readFile(path.join(job, 'audio-cache/s1.mp3'), 'utf8'), 'cached audio')
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})
