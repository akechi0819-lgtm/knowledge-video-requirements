import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { discoverInstalledSkills, resolveProductionSkill, readSkillMetadata } from '../lib/skill-packages.js'
import { checkRuntimePath, prepareSkillRuntime } from '../lib/skill-runtime.js'
import { resolveTool } from '../lib/runtime.js'

async function skill(root, folder, name, description = '说明') {
  const dir = path.join(root, '.agents/skills', folder)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  ${description}\n---\n正文`)
  return dir
}

test('发现任意目录、工作区覆盖、预设与完整仓库来源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-discovery-'))
  try {
    const repo = path.join(root, 'repo'), workspace = path.join(root, 'workspace'), kit = path.join(root, 'kit')
    await skill(repo, 'one', 'original')
    const selected = await skill(workspace, 'one', 'workspace-one', '工作区优先')
    const holder = path.join(workspace, '.agents/.github-skill-checkouts/first')
    const checkout = path.join(holder, 'repo')
    const imported = path.join(checkout, 'skills/other')
    await mkdir(imported, { recursive: true })
    await writeFile(path.join(imported, 'SKILL.md'), '---\nname: other\ndescription: "导入的技能"\n---\n')
    await writeFile(path.join(holder, 'source.json'), JSON.stringify({ commit: '123' }))
    const installed = path.join(workspace, '.agents/skills/imported')
    if (process.platform === 'win32') {
      await mkdir(installed)
      await writeFile(path.join(installed, '.jiangjie-checkout'), path.join('first', 'repo', 'skills', 'other'))
    } else {
      await symlink(imported, installed, 'dir')
    }
    const preset = path.join(kit, 'skill-packages/preset')
    await mkdir(preset, { recursive: true })
    await writeFile(path.join(preset, '讲界.manifest.json'), JSON.stringify({ id: 'preset', name: '预设', skill: 'one' }))
    const items = await discoverInstalledSkills({ repo, workspace })
    assert.deepEqual(items.map(item => item.id).sort(), ['repo-skill:imported', 'repo-skill:one'])
    assert.equal(items.find(item => item.folder === 'one').description, '工作区优先\n')
    const origin = items.find(item => item.folder === 'imported')
    assert.deepEqual(origin.source, { commit: '123' })
    assert.equal(origin.checkoutDir, await realpath(checkout))
    assert.equal((await resolveProductionSkill({ repo, workspace, kit, style: { id: 'repo-skill:one' } })).directory, await realpath(selected))
    assert.equal((await resolveProductionSkill({ repo, workspace, kit, style: { id: 'preset' } })).directory, await realpath(selected))
    assert.equal(await resolveProductionSkill({ repo, workspace, kit, style: { id: 'general' } }), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同名 Skill 并发任务各自读取正确别名并共享持久缓存', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-collision-'))
  const windows = process.platform === 'win32'
  const oldCache = process.env.JIANGJIE_CACHE_DIR
  process.env.JIANGJIE_CACHE_DIR = path.join(root, 'cache')
  let a, b
  try {
    const repo = path.join(root, 'repo'), kit = path.join(root, 'kit')
    const first = await skill(repo, 'first', 'same', '第一份')
    const second = await skill(repo, 'second', 'same', '第二份')
    await mkdir(kit, { recursive: true })
    const playwright = path.join(kit, 'playwright.cjs')
    await writeFile(playwright, 'module.exports={chromium:{}}')
    const style = { paths: windows ? { python: resolveTool('python'), ffmpeg: resolveTool('ffmpeg'),
      ffprobe: resolveTool('ffprobe'), edge: process.execPath, playwright }
      : { python: '/usr/bin/true', ffmpeg: '/usr/bin/true', ffprobe: '/usr/bin/true', edge: '/usr/bin/true', playwright } }
    const dirs = [path.join(root, 'job-a'), path.join(root, 'job-b')]
    await Promise.all(dirs.map(dir => mkdir(dir)))
    ;[a, b] = await Promise.all([first, second].map((selectedDirectory, i) => prepareSkillRuntime({ repo, dir: dirs[i], selectedDirectory, selectedSkill: i ? 'second' : 'first', kit, settings: {}, style })))
    for (const [runtime, expected] of [[a, first], [b, second]]) {
      for (const kind of ['.agents', '.claude']) {
        const mounted = path.join(runtime.env.HOME, kind, 'skills/same')
        if (windows) {
          assert.equal((await lstat(mounted)).isSymbolicLink(), false)
          assert.equal(await readFile(path.join(mounted, 'SKILL.md'), 'utf8'), await readFile(path.join(expected, 'SKILL.md'), 'utf8'))
        } else {
          assert.equal(await realpath(mounted), await realpath(expected))
        }
        assert.equal(checkRuntimePath(runtime, runtime.dir, `~/${kind}/skills/same/SKILL.md`), await realpath(path.join(mounted, 'SKILL.md')))
      }
      const catalog = path.join(runtime.catalogRoot, 'same')
      if (windows) assert.equal((await lstat(catalog)).isSymbolicLink(), false)
      else assert.equal(await readlink(catalog), await realpath(expected))
      assert.match(await readFile(path.join(runtime.env.HOME, '.agents/skills/same/SKILL.md'), 'utf8'), /正文/)
    }
    assert.notEqual(a.env.HOME, b.env.HOME)
    assert.equal(a.env.XDG_CACHE_HOME, b.env.XDG_CACHE_HOME)
    if (!windows) assert.equal(await realpath(path.join(a.env.HOME, '.cache')), await realpath(path.join(b.env.HOME, '.cache')))
  } finally {
    if (oldCache === undefined) delete process.env.JIANGJIE_CACHE_DIR
    else process.env.JIANGJIE_CACHE_DIR = oldCache
    for (const runtime of [a, b]) if (runtime) await rm(runtime.tmp, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})


test('Skill 元数据解析 YAML 标量和块字符串，不读取正文', async () => {
  const parse = body => readSkillMetadata(`---\n${body}\n---\nname: body-name\ndescription: body`, 'folder')
  assert.deepEqual(await parse('name: simple # 注释\ndescription: value # 注释'), { name:'simple', description:'value' })
  assert.deepEqual(await parse("name: 'it''s skill' # 注释\ndescription: 'it''s # text'"), { name:"it's skill", description:"it's # text" })
  assert.deepEqual(await parse(String.raw`name: "skill"
description: "path C:\\tools\nline\tquote: \" escaped \x41\u4E2D\U0001F600"`), { name:'skill', description:'path C:\\tools\nline\tquote: " escaped A中😀' })
  assert.deepEqual(await parse('name: test\ndescription: >-\n  第一行\n  第二行\n\n  新段落'), { name:'test', description:'第一行 第二行\n新段落' })
  assert.deepEqual(await parse('name: test\ndescription: |+\n  第一行\n  第二行\n'), { name:'test', description:'第一行\n第二行\n\n' })
  assert.deepEqual(await parse('description: |\n  内容\n\n'), { name:'folder', description:'内容\n' })
  assert.deepEqual(await readSkillMetadata('正文\nname: forged', 'folder'), { name:'folder', description:'' })
  await assert.rejects(parse('description: "bad\\q"'), /转义无效/)
})
