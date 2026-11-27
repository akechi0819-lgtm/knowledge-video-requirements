import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeVideo } from '../lib/video-style.js'
import { createMutedVideo } from './media-fixture.js'

async function videoFixture(dir, duration) {
  const video = path.join(dir, 'v.mp4')
  if (process.platform === 'win32') {
    const { ffmpeg, ffprobe } = await createMutedVideo(video, duration)
    return { video, ffmpeg, ffprobe }
  }
  const ffprobe = path.join(dir, 'probe'), ffmpeg = path.join(dir, 'ffmpeg')
  await fs.writeFile(video, 'video')
  const info = JSON.stringify({ format: { duration: String(duration) }, streams: [{ codec_type: 'video' }] })
  await fs.writeFile(ffprobe, "#!/bin/sh\nprintf '%s\\n' '" + info + "'\n", { mode: 0o755 })
  await fs.writeFile(ffmpeg, '#!/bin/sh\nfor last; do :; done\nprintf image > "$last"\n', { mode: 0o755 })
  return { video, ffmpeg, ffprobe }
}

test('视频抽帧附时间证据，传给视觉模型并标注局限；模型失败不生成草案', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-style-'))
  const old = { ...process.env }, oldFetch = globalThis.fetch
  try {
    const { video, ffprobe, ffmpeg } = await videoFixture(dir, 12)
    Object.assign(process.env, { VIDEO_FFPROBE: ffprobe, VIDEO_FFMPEG: ffmpeg, WORKBENCH_VISION_ENDPOINT: 'http://127.0.0.1:11434/v1/chat/completions', WORKBENCH_VISION_MODEL: 'test' })
    delete process.env.WORKBENCH_VISION_KEY; delete process.env.WORKBENCH_MODEL_KEY
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.messages[0].content.filter(c => c.type === 'image_url').length, 6)
      assert.equal(options.headers.Authorization, undefined)
      return new Response(JSON.stringify({ choices: [{ message: { content: '观察：画面以蓝色为主。' } }] }))
    }
    const result = await analyzeVideo({ videoPath: video, outputDir: path.join(dir, 'out') })
    assert.equal(result.evidence.frames.length, 6)
    assert.equal(result.evidence.frames[0].seconds, 1)
    assert.match(result.draft, /无法确认帧间运动/)
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'out/analysis.json'))).draft, result.draft)
    globalThis.fetch = async () => new Response('unsupported', { status: 400 })
    await assert.rejects(analyzeVideo({ videoPath: video, outputDir: path.join(dir, 'failed') }), /是否支持图片输入/)
    await assert.rejects(fs.access(path.join(dir, 'failed/analysis.json')))
  } finally { process.env = old; globalThis.fetch = oldFetch; await fs.rm(dir, { recursive: true, force: true }) }
})

test('视觉模型地址归一化为 chat/completions 端点且禁止重定向', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-style-url-'))
  const old = { ...process.env }, oldFetch = globalThis.fetch
  try {
    const { video, ffprobe, ffmpeg } = await videoFixture(dir, 2)
    Object.assign(process.env, { VIDEO_FFPROBE: ffprobe, VIDEO_FFMPEG: ffmpeg, WORKBENCH_VISION_MODEL: 'test', WORKBENCH_VISION_KEY: 'k' })
    delete process.env.WORKBENCH_MODEL_KEY
    const urls = []
    globalThis.fetch = async (url, options) => {
      urls.push(url)
      assert.equal(options.redirect, 'error')
      return new Response(JSON.stringify({ choices: [{ message: { content: '观察：画面以蓝色为主。' } }] }))
    }
    for (const endpoint of ['https://x/v1', 'https://x/v1/chat/completions', 'https://x/v1/']) {
      process.env.WORKBENCH_VISION_ENDPOINT = endpoint
      await analyzeVideo({ videoPath: video, outputDir: path.join(dir, 'out') })
    }
    assert.deepEqual(urls.map(String), Array(3).fill('https://x/v1/chat/completions'))
  } finally { process.env = old; globalThis.fetch = oldFetch; await fs.rm(dir, { recursive: true, force: true }) }
})
