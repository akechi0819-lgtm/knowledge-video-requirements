import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const kit = path.resolve(import.meta.dirname, '../../../../../video-kit')
const { default: style } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/style.mjs')))
const { installSceneRoutes } = await import(pathToFileURL(path.join(kit, 'WORK/modules/video/isolated-page.mjs')))
const { chromium } = createRequire(import.meta.url)(style.paths.playwright)

test('scene can load only explicitly allowed declared and ready task images', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-isolation-'))
  const browser = await chromium.launch({ executablePath: style.paths.edge, headless: true })
  try {
    await mkdir(path.join(dir, 'assets'))
    await mkdir(path.join(dir, '现成素材'))
    await writeFile(path.join(dir, 'assets', 'allowed.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
    await writeFile(path.join(dir, '现成素材', '人物 1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>')
    await writeFile(path.join(dir, 'secret.txt'), 'secret')
    const scene = path.join(dir, 'scene.html')
    await writeFile(scene, '<div id="stage"></div>')
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await installSceneRoutes(context, scene, dir, ['assets/allowed.svg', '现成素材/人物 1.svg'])
    const page = await context.newPage()
    await page.goto('https://video.invalid/scenes/scene.html')
    const results = await page.evaluate(async secret => {
      const get = async url => { try { const r = await fetch(url); return await r.text() } catch { return 'blocked' } }
      return Promise.all([get('../assets/allowed.svg'), get('../现成素材/人物 1.svg'), get('../secret.txt'), get('file://' + secret), get('https://example.com/')])
    }, path.join(dir, 'secret.txt'))
    assert.match(results[0], /<svg/)
    assert.match(results[1], /<svg.*width="3"/)
    assert.deepEqual(results.slice(2), ['blocked', 'blocked', 'blocked'])
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }) }
})
