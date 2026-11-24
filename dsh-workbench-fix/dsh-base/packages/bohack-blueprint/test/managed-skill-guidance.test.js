import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadManagedSkillGuidance } from '../lib/managed-skill-guidance.js'

test('loads selected Skill guidance and confines referenced text to its directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'managed-skill-'))
  try {
    const skill = path.join(dir, 'skill')
    await mkdir(path.join(skill, 'references'), { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), 'Skill instructions')
    await writeFile(path.join(skill, 'references', 'style.md'), 'Style reference')
    await writeFile(path.join(dir, 'outside.md'), 'outside')
    await symlink(path.join(dir, 'outside.md'), path.join(skill, 'escape.md'))
    const guidance = await loadManagedSkillGuidance({ directory: skill, name: 'Test', skill: 'test', mode: 'B', references: ['references/style.md'] })
    assert.match(guidance.prompt, /Skill instructions/)
    assert.match(guidance.prompt, /references\/style\.md/)
    assert.match(guidance.prompt, /"mode": "B"/)
    assert.equal(await guidance.readSkillFile('references/style.md'), 'Style reference')
    await assert.rejects(guidance.readSkillFile('../outside.md'), /目录之外/)
    await assert.rejects(guidance.readSkillFile('escape.md'), /目录之外/)
    await assert.rejects(guidance.readSkillFile(path.join(dir, 'outside.md')), /相对路径/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
