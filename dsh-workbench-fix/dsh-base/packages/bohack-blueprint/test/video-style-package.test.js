import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverSkillPackages, resolveProductionSkill, resolveSkillDir } from '../lib/skill-packages.js'
import { loadManagedSkillGuidance } from '../lib/managed-skill-guidance.js'

test('discovers packaged Skill guidance without requiring a native adapter', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-package-'))
  try {
    const dir = path.join(temp, 'skill-packages', 'example')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '讲界.manifest.json'), JSON.stringify({ id: 'example', name: 'Example', skill: 'andy-vibe-knowledge' }))
    assert.equal((await discoverSkillPackages(temp))[0].id, 'example')
    const folder = path.join(temp, '.agents/skills/andy-vibe-knowledge')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'SKILL.md'), '示例视觉方法')
    const pkg = await resolveProductionSkill({ kit: temp, repo: temp, style: { id: 'example' } })
    assert.match((await loadManagedSkillGuidance(pkg)).prompt, /示例视觉方法/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('desktop installed skills take precedence and missing skills report installation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-install-'))
  try {
    const desktop = path.join(temp, 'desktop'), repo = path.join(temp, 'repo')
    const installed = path.join(desktop, '.agents', 'skills', 'film')
    await mkdir(installed, { recursive: true })
    await writeFile(path.join(installed, 'SKILL.md'), 'installed upstream')
    assert.equal(await resolveSkillDir('film', repo, desktop), await realpath(installed))
    await assert.rejects(resolveSkillDir('absent', repo, desktop), /原版 Skill 未安装：absent/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('寓言预设向宿主加载所选模式的指导与资料', async () => {
  const repo = path.resolve(import.meta.dirname, '../../../../..')
  const kit = path.join(repo, 'video-kit')
  const pkg = await resolveProductionSkill({ kit, repo, style: { id: 'vibe-fable' } })
  const guidance = await loadManagedSkillGuidance(pkg)
  assert.match(guidance.prompt, /B 寓言/)
  const reference = pkg.references[0]
  assert.ok((await guidance.readSkillFile(reference)).trim())
})
