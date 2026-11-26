import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, stat, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runOriginalVideoJob } from '../lib/original-video-job.js'
import { checkRuntimePath } from '../lib/skill-runtime.js'
import { runVideoAgent } from '../lib/video-agent.js'

test('original job mirrors installed skills and mounts only the two host tools', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'original-video-'))
  try {
    const dir = path.join(root, 'job'), kit = path.join(root, 'kit')
    const skillDir = path.join(root, '.agents/skills/example'), otherSkill = path.join(root, '.agents/skills/helper')
    const modules = path.join(kit, 'WORK/modules/video')
    await Promise.all([mkdir(skillDir, { recursive: true }), mkdir(otherSkill, { recursive: true }), mkdir(modules, { recursive: true })])
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: example\n---\nORIGINAL CONTENT')
    await writeFile(path.join(otherSkill, 'SKILL.md'), '---\nname: helper-alias\n---\nHELPER CONTENT')
    await writeFile(path.join(skillDir, 'template.txt'), 'UPSTREAM TEMPLATE')
    await writeFile(path.join(modules, 'playwright.cjs'), 'module.exports = {chromium: {}}')
    await writeFile(path.join(modules, 'style.mjs'), `export default ${JSON.stringify({ paths: {
      python: '/usr/bin/true', ffmpeg: '/usr/bin/true', ffprobe: '/usr/bin/true', edge: '/usr/bin/true', playwright: path.join(modules, 'playwright.cjs'),
    } })}`)
    const fakeKey = 'test-mimo-key'
    await assert.rejects(runOriginalVideoJob({ dir, repo: root, kit, production: { sections: [] },
      settings: { tts: { protocol: 'mimo', baseUrl: 'https://example.invalid/chat/completions', apiKey: fakeKey } },
      manifest: { name: 'Original', skill: 'example', references: ['template.txt'] },
      runVideoAgent: async ({ prompt, tools, preset, runtime, onTiming }) => {
        assert.equal(preset, 'bohack-skill-runner')
        assert.deepEqual(tools.map(tool => tool.name), ['view_image', 'submit'])
        assert.match(prompt, /skill 工具加载「example」/)
        assert.match(prompt, /template.txt/)
        assert.doesNotMatch(prompt, /ORIGINAL CONTENT|UPSTREAM TEMPLATE/)
        for (const relative of ['.agents/skills', '.claude/skills']) {
          assert.equal(await readFile(path.join(runtime.home, relative, 'helper/SKILL.md'), 'utf8'), '---\nname: helper-alias\n---\nHELPER CONTENT')
          assert.equal(await readlink(path.join(runtime.home, relative, 'helper-alias')), await realpath(otherSkill))
        }
        assert.equal(await readlink(path.join(dir, '.dsh/skills/example')), runtime.selected)
        assert.match(await readFile(path.join(dir, '.dsh/skills/helper-alias/SKILL.md'), 'utf8'), /HELPER CONTENT/)
        await assert.rejects(stat(path.join(dir, '.git')), { code: 'ENOENT' })
        assert.equal(runtime.env.MIMO_BASE_URL, 'https://example.invalid')
        assert.match(await readFile(path.join(runtime.home, '.config/ai-teardown/mimo.env'), 'utf8'), /MIMO_API_KEY=test-mimo-key/)
        assert.doesNotMatch(prompt, new RegExp(fakeKey))
        onTiming({ type: 'tool', toolName: 'skill' })
        assert.match(prompt, /若 Skill 自带结构/); assert.match(prompt, /view_image 检查画面/); assert.match(prompt, /decisions.json/)
        assert.equal(JSON.parse(await readFile(path.join(dir, 'brief.json'), 'utf8')).decisions, 'decisions.json')
        await assert.rejects(tools[1].execute({}), { code:'INVALID_FILM' })
      },
    }), /未完成成片/)
    assert.match(await readFile(path.join(dir, 'timings.jsonl'), 'utf8'), /"toolName":"skill"/)
    assert.equal(await readFile(path.join(dir, 'commands.jsonl'), 'utf8'), '')
    const decisions = JSON.parse(await readFile(path.join(dir, 'decisions.json'), 'utf8'))
    const brief = JSON.parse(await readFile(path.join(dir, 'brief.json'), 'utf8'))
    assert.deepEqual(decisions.confirmedPoints, [])
    assert.equal(brief.decisions, 'decisions.json')
    assert.match(brief.planning.structure, /原版 Skill 有结构规划时.*否则沿用蓝图/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('task path checks allow upstream reads and reject writes through outside symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-boundary-'))
  try {
    const dir = path.join(root, 'job'), skill = path.join(root, 'skill')
    await Promise.all([mkdir(dir), mkdir(skill)])
    await symlink(path.join(root, 'new-outside.txt'), path.join(dir, 'dangling'))
    const runtime = { dir: await realpath(dir), tmp: await realpath(dir), readRoots: await Promise.all([realpath(dir), realpath(skill)]) }
    assert.throws(() => checkRuntimePath(runtime, dir, './dangling', true), /只能写入/)
    assert.throws(() => checkRuntimePath(runtime, dir, '../outside.txt'), /只能读取/)
    assert.throws(() => checkRuntimePath(runtime, dir, '../skill/SKILL.md', true), /只能写入/)
    assert.equal(checkRuntimePath(runtime, dir, '../skill/SKILL.md'), path.join(await realpath(skill), 'SKILL.md'))
    assert.equal(checkRuntimePath(runtime, dir, 'output.txt', true), path.join(runtime.dir, 'output.txt'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an active native job is still allowed to submit after more than ten minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let submit
  const jobs = { list: () => [{ status: 'running' }] }
  const started = Promise.withResolvers()
  const context = { jobs, on() {}, tools: { register(tool) { submit = tool.execute } } }
  const ctx = {
    agentPresets: { mount: async () => {} },
    agents: { async create({ setup }) {
      await setup(context)
      return { agent: { async followup() { started.resolve() } } }
    } },
  }
  const result = runVideoAgent({ ctx, cwd: '/tmp', prompt: 'test', runtime: {}, tools: [
    { name: 'submit', execute: async () => ({ ok: true }) },
  ] })
  await started.promise
  t.mock.timers.tick(13 * 60 * 1000)
  assert.deepEqual(await submit({}), { ok: true })
  assert.deepEqual(await result, { ok: true })
})

test('成片校验允许无映射和自定义段落，损坏映射降级整片', async () => {
  const { verifyOriginalFilm } = await import('../lib/original-video-job.js')
  const { chmod } = await import('node:fs/promises')
  const { createMutedVideo } = await import('./media-fixture.js')
  const root = await mkdtemp(path.join(os.tmpdir(), 'original-check-'))
  try {
    const film = path.join(root, 'film'), kit = path.join(root, 'kit')
    await mkdir(film); await mkdir(path.join(kit, 'WORK/modules/video'), {recursive:true})
    const probe = path.join(root, 'probe'), decoder = path.join(root, 'decoder')
    const final = path.join(film, 'final.mp4')
    let paths
    if (process.platform === 'win32') {
      paths = await createMutedVideo(final, 10)
    } else {
      await writeFile(probe, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ format:{duration:'10'}, streams:[{codec_type:'video',width:320,height:180}] })}'\n`)
      await writeFile(decoder, '#!/bin/sh\nprintf "frame=10\\nprogress=end\\n"\n')
      await Promise.all([chmod(probe, 0o755), chmod(decoder, 0o755)])
      await writeFile(final, 'fixture')
      paths = { ffprobe: probe, ffmpeg: decoder }
    }
    await writeFile(path.join(kit, 'WORK/modules/video/style.mjs'), 'export default ' + JSON.stringify({ paths }))
    const production = {sections:[{id:'B01',narration:''},{id:'B02',narration:''}]}
    let report = await verifyOriginalFilm(film, production, kit)
    assert.equal(report.pass, true); assert.equal(report.mappingMode, 'full'); assert.deepEqual(report.segments, [])
    const mapping = {final_video:'final.mp4',segments:[{id:'custom-scene',start_sec:0,end_sec:4}]}
    await writeFile(path.join(film, 'mapping.json'), JSON.stringify(mapping))
    report = await verifyOriginalFilm(film, production, kit)
    assert.equal(report.mappingMode, 'mapped'); assert.equal(report.segments[0].id, 'custom-scene')
    mapping.segments[0].end_sec = 11
    await writeFile(path.join(film, 'mapping.json'), JSON.stringify(mapping))
    report = await verifyOriginalFilm(film, production, kit)
    assert.equal(report.mappingMode, 'full'); assert.match(report.problems[0], /映射内容无效/)
    await writeFile(path.join(film, 'mapping.json'), '{broken')
    assert.equal((await verifyOriginalFilm(film, production, kit)).mappingMode, 'full')
    if (process.platform === 'win32') await createMutedVideo(final, 10, 'black')
    else {
      await writeFile(decoder, '#!/bin/sh\nprintf "frame=0\\nprogress=end\\n"\n')
      await assert.rejects(verifyOriginalFilm(film, production, kit), { code:'INVALID_FILM', message:/没有可解码/ })
      await writeFile(decoder, '#!/bin/sh\nprintf "frame=10\\nprogress=end\\n"\nprintf "black_start:0 black_end:9.95 black_duration:9.95\\n" >&2\n')
    }
    await assert.rejects(verifyOriginalFilm(film, production, kit), { code:'INVALID_FILM', message:/全黑/ })
    if (process.platform === 'win32') await writeFile(final, 'corrupt mp4')
    else await writeFile(decoder, '#!/bin/sh\nexit 1\n')
    await assert.rejects(verifyOriginalFilm(film, production, kit), { code:'INVALID_FILM' })
    await writeFile(path.join(film, 'final.mp4'), '')
    await assert.rejects(verifyOriginalFilm(film, production, kit), { code:'INVALID_FILM' })
  } finally { await rm(root,{recursive:true,force:true}) }
})
