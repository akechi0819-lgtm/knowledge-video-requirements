import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runVideoJob } from '../lib/video-job.js'

test('Agent TTS passes normalized endpoints to the driver', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'video-job-endpoint-'))
  try {
    const kit = path.join(root, 'kit'), video = path.join(kit, 'WORK/modules/video')
    await mkdir(video, { recursive: true })
    await writeFile(path.join(video, 'style.mjs'), `export default ${JSON.stringify({ paths: { python: process.execPath, ffprobe: 'unused' }, tts: { voice: 'unused', rate: '0' } })}`)
    await writeFile(path.join(video, 'pipeline.mjs'), 'export function preparedFrames() {}\nexport function seedTtsCache() {}')
    await writeFile(path.join(video, 'tts_driver.py'), "require('node:fs').writeFileSync(process.argv[2] + '.endpoint', process.env.VIDEO_TTS_ENDPOINT); process.exit(1)")
    const cases = [
      ['speech', 'https://example.test/v1/', 'https://example.test/v1/audio/speech'],
      ['speech', 'https://example.test/v1/audio/speech/', 'https://example.test/v1/audio/speech'],
      ['mimo', 'https://example.test/v1/', 'https://example.test/v1/chat/completions'],
      ['mimo', 'https://example.test/v1/chat/completions', 'https://example.test/v1/chat/completions'],
    ]
    for (const [index, [protocol, baseUrl, expected]] of cases.entries()) {
      const dir = path.join(root, `job-${index}`)
      const production = { version: 'v1', skill: { id: 'custom', content: 'test' }, sections: [{ id: 's1', narration: 'test' }] }
      await assert.rejects(runVideoJob({ dir, kit, production, settings: { tts: { protocol, baseUrl } } }))
      assert.equal(await readFile(path.join(dir, 'tts-input.json.endpoint'), 'utf8'), expected)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
