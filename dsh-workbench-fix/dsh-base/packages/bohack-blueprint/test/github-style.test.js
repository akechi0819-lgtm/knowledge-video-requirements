import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGithubInstaller } from '../lib/github-style.js'
const run = promisify(execFile)
const git = async (...args) => (await run('git', args)).stdout.trim()

test('整仓检出锁定提交，发现目录中的多个 Skill 并按选择启用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-install-'))
  try {
    const repo = path.join(root, 'upstream'), workspace = path.join(root, 'workspace')
    await mkdir(path.join(repo, 'skills/a'), { recursive: true })
    await mkdir(path.join(repo, 'skills/b/scripts'), { recursive: true })
    await mkdir(path.join(repo, 'extra'), { recursive: true })
    await writeFile(path.join(repo, 'extra/SKILL.md'), '---\nname: second\ndescription: 同名独立技能\n---\n规则')
    await writeFile(path.join(repo, 'skills/a/SKILL.md'), '---\nname: first\ndescription: 第一种\n---\n规则')
    await writeFile(path.join(repo, 'skills/a/requirements.txt'), 'pillow')
    await writeFile(path.join(repo, 'skills/b/SKILL.md'), '---\nname: second\ndescription: 第二种\n---\n规则')
    await writeFile(path.join(repo, 'skills/b/scripts/run.py'), 'print(1)')
    await git('init', repo)
    await git('-C', repo, 'config', 'user.name', 'test')
    await git('-C', repo, 'config', 'user.email', 'test@example.test')
    await git('-C', repo, 'add', '.')
    await git('-C', repo, 'commit', '-m', 'fixture')
    await git('-C', repo, 'branch', 'feature/video')
    const commit = await git('-C', repo, 'rev-parse', 'HEAD')
    const installer = createGithubInstaller(workspace, { cloneUrl: 'file://' + repo })
    const result = await installer.inspect({ url: 'https://github.com/example/film/tree/feature/video/skills' })
    assert.equal(result.source.commit, commit)
    assert.equal(result.source.ref, 'feature/video')
    assert.deepEqual(result.skills.map(x => x.name).sort(), ['first', 'second'])
    assert.deepEqual(result.skills.find(x => x.name === 'first').dependencyHints, ['requirements.txt'])
    const installed = await installer.install({ installId: result.installId, selected: ['b'] })
    assert.equal(installed.skills[0].name, 'second')
    assert.equal(await readFile(path.join(installed.skills[0].path, 'scripts/run.py'), 'utf8'), 'print(1)')
    const other = await installer.inspect({ url: `https://github.com/example/film/tree/${commit}/extra` })
    const sameName = await installer.install({ installId: other.installId, selected: ['.'] })
    assert.equal(sameName.skills[0].name, 'second')
    assert.notEqual(sameName.skills[0].path, installed.skills[0].path)
    const metadata = JSON.parse(await readFile(path.join(workspace, '.agents/.github-skill-checkouts', result.installId, 'source.json')))
    assert.equal(metadata.commit, commit)
    await assert.rejects(installer.install({ installId: result.installId, selected: ['b'] }), /失效/)
    const byCommit = await installer.inspect({ url: `https://github.com/example/film/tree/${commit}/skills/a` })
    assert.equal(byCommit.skills[0].name, 'first')
    await assert.rejects(installer.inspect({ url: 'https://example.com/org/repo' }), /GitHub/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('不跟随仓库内的外部符号链接发现 Skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-symlink-'))
  try {
    const repo = path.join(root, 'repo'), outside = path.join(root, 'outside')
    await mkdir(repo); await mkdir(outside)
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: escape\ndescription: no\n---')
    await symlink(outside, path.join(repo, 'escape'))
    await git('init', repo); await git('-C', repo, 'config', 'user.name', 'test'); await git('-C', repo, 'config', 'user.email', 'test@example.test')
    await git('-C', repo, 'add', '.'); await git('-C', repo, 'commit', '-m', 'fixture')
    const installer = createGithubInstaller(path.join(root, 'workspace'), { cloneUrl: 'file://' + repo })
    await assert.rejects(installer.inspect({ url: 'https://github.com/example/repo' }), /没有 SKILL/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
