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

const root = path.resolve(import.meta.dirname, '../../../../..')
const kit = path.join(root, 'video-kit')

test('video tools create and verify a film with real speech and task images', { timeout: 120000, skip: process.platform !== 'darwin' }, async t => {
  const ffmpeg = path.join(kit, '.runtime/bin/ffmpeg'), ffprobe = path.join(kit, '.runtime/bin/ffprobe')
  try { await Promise.all([access(ffmpeg, constants.X_OK), access(ffprobe, constants.X_OK)]) } catch { t.skip('video-kit runtime unavailable'); return }
  process.env.VIDEO_FFMPEG = ffmpeg; process.env.VIDEO_FFPROBE = ffprobe; process.env.VIDEO_VOICE = 'say:Alex'
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-job-test-'))
  const previous = path.join(dir, 'old'), job = path.join(dir, 'new')
  const registry = new Map()
  const toolCtx = { tools: { register: tool => registry.set(tool.name, tool), guard() {}, view: () => ({ restrictableNames: [] }), restrict() {} }, on() {} }
  let previewPath
  const ctx = { agentPresets: { mount: async () => {} }, agents: { create: async ({ setup }) => {
    await setup(toolCtx)
    return { agent: { followup: async () => {
      const call = (name, args = {}) => registry.get(name).execute(args)
      assert.match((await call('read_previous_scene', { id: 's1' })).html, /old/)
      assert.match((await call('read_skill_file', { file: 'SKILL.md' })).text, /自定义制作规则/)
      await assert.rejects(call('read_skill_file', { file: '../outside.txt' }))
      await assert.rejects(call('compose'), /先按意见修改/)
      const timing = await call('tts_durations')
      assert.ok(timing.durations.s1 > 0); assert.ok(timing.plans.s1.duration >= timing.durations.s1)
      await call('write_scene', { id: 's1', html: '<div id="stage" style="width:1280px;height:720px;background:white"><img src="../assets/test.svg"></div><script>window.seek=t=>{}</script>' })
      const preview = await call('preview', { id: 's1', seconds: 0 })
      assert.match(preview.imageStatus, /无法查看/); previewPath = preview.imagePath
      assert.equal((await call('compose')).ok, true)
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
