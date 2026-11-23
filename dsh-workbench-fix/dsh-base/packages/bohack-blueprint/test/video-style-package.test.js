import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverSkillPackages, resolveSkillDir } from '../lib/skill-packages.js'
import { runVideoJob } from '../lib/video-job.js'

test('discovers original skill packages without adapters and blocks multiuser execution', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-package-'))
  try {
    const dir = path.join(temp, 'skill-packages', 'example')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '讲界.manifest.json'), JSON.stringify({ id: 'example', name: 'Example', skill: 'andy-vibe-knowledge' }))
    assert.equal((await discoverSkillPackages(temp))[0].id, 'example')
    await assert.rejects(runVideoJob({ dir: temp, kit: temp, multiuser: true, production: { style: { id: 'example' } } }), /单任务进程沙箱/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('desktop installed skills take precedence and missing skills report installation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-install-'))
  try {
    const desktop = path.join(temp, 'desktop'), repo = path.join(temp, 'repo')
    const installed = path.join(desktop, '.agents', 'skills', 'film')
    await mkdir(installed, { recursive: true })
    await writeFile(path.join(installed, 'SKILL.md'), 'installed upstream')
    assert.match(await resolveSkillDir('film', repo, desktop), /desktop\/\.agents\/skills\/film$/)
    await assert.rejects(resolveSkillDir('absent', repo, desktop), /原版 Skill 未安装：absent/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('正式制作入口将寓言任务交给原版制作会话', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'original-entry-'))
  const kit = path.resolve(import.meta.dirname, '../../../../../video-kit')
  const reachedSession = new Error('已到达制作会话')
  try {
    await assert.rejects(runVideoJob({
      kit, dir: temp, sessionId: 'entry-test',
      production: { style: { id: 'vibe-fable' }, sections: [] },
      withProductionSession: async (id, start) => {
        assert.equal(id, 'entry-test')
        assert.equal(typeof start, 'function')
        throw reachedSession
      },
    }), error => error === reachedSession)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
