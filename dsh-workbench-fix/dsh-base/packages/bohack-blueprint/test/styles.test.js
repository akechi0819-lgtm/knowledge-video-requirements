import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStyles, collectRepoSkills } from '../lib/styles.js'

const skillFolders = ['ai-teardown', 'andy-vibe-knowledge', 'motion-design-prompt-generator', 'vibe-knowledge-film']

async function seedSkills(root, label) {
  for (const folder of skillFolders) {
    const dir = path.join(root, '.agents', 'skills', folder)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${label}-${folder}\n---\n${label} 的设计规则`)
  }
}

test('personal library is shared but choices are isolated per creative thread', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-'))
  try {
    const a = createStyles(path.join(root, 'a'), root), b = createStyles(path.join(root, 'b'), root), other = createStyles(path.join(root, 'other'))
    const initial = (await a.list()).styles
    assert.ok(initial.some(s => s.name === "vibe-knowledge" && s.summary && s.kind === 'skill'))
    assert.ok(initial.filter(s => s.kind === 'skill').every(s => String(s.id).startsWith('repo-skill:')))
    assert.ok(initial.some(s => s.id === 'general' && s.kind === 'builtin' && s.preview.file === 'general.svg'))
    assert.equal(await a.selected(), null)
    const item = (await a.importStyle({name:'我的风格',description:'# 视觉\n参考正文',source:{kind:'web',label:'https://example.com/style'}})).style
    assert.ok((await b.list()).styles.some(s => s.id === item.id))
    assert.equal((await other.list()).styles.length, initial.length)
    await a.select({id:item.id}); await b.select({id:'general'})
    assert.equal((await a.selected()).id, item.id)
    assert.equal((await b.selected()).id, 'general')
    await assert.rejects(a.remove({id:'general'}), /不可移除/)
    await b.update({id:item.id,name:'新名称',description:'新规则'})
    assert.equal((await a.selected()).name, '我的风格')
    const exported=await b.exportMarkdown({id:item.id})
    assert.match(exported, /^---\nname: personal-style-/); assert.match(exported, /\ndescription: /); assert.match(exported, /新规则/); assert.match(exported, /https:\/\/example.com/ )
    await b.remove({id:item.id})
    assert.equal((await a.selected()).name, '我的风格')
    assert.equal((await b.selected()).id, 'general')
    await Promise.all(Array.from({length:12},(_,i)=>a.importStyle({name:`并发${i}`,description:'规则',source:{kind:'text'}})))
    assert.equal((await a.list()).styles.length, initial.length + 12)
    await assert.rejects(a.importStyle({name:'test',description:'x',source:{kind:'web',label:'javascript:alert(1)'}}), /HTTP/)
  } finally { await rm(root, { recursive:true, force:true }) }
})

test('九个正式入口分别加载七个上游制作包和两个内置风格', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-builtins-'))
  try {
    const service = createStyles(root), list = (await service.list()).styles
    assert.equal(list.filter(s => ['builtin','preset'].includes(s.kind)).length, 9)
    assert.deepEqual(list.filter(s => s.kind === 'builtin').map(s => s.id).sort(), ['editorial', 'general'])
    for (const id of ['andy-pixel-quest','heychengc-concrete','huashu-vox','huashu-whiteboard','swiss-kinetic','vibe-night','vibe-fable']) {
      const item = list.find(s => s.id === id)
      assert.equal(item?.skillPackage, true)
      assert.ok(item.description && item.source.label)
      assert.equal(item.kind, 'preset')
      assert.ok(item.summary)
      assert.ok(item.preview?.file)
      await service.select({ id }); assert.equal((await service.selected()).id, id)
    }
    const imported = (await service.importStyle({name:'手写风格',description:'以手写标注组织讲解。',source:{kind:'text'}})).style
    const listed = (await service.list()).styles.find(s => s.id === imported.id)
    assert.equal(listed.kind, 'visual')
    assert.equal(listed.preview.kind, 'poster')
    assert.match(listed.summary, /手写标注/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a corrupt style library degrades to the builtins instead of failing the list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-corrupt-'))
  try {
    await writeFile(path.join(root, 'style-library.json'), '{ 坏掉的 JSON')
    await mkdir(path.join(root, 'a'), { recursive: true })
    await writeFile(path.join(root, 'a', 'style-selection.json'), '也不是 JSON')
    const warnings = []
    const service = createStyles(path.join(root, 'a'), root, { logger: { warn: (...args) => warnings.push(args.join(' ')) } })
    const list = await service.list()
    assert.equal(list.ok, true)
    assert.equal(list.selectedId, null)
    assert.ok(list.styles.some(s => s.id === 'general'))
    assert.ok(warnings.some(w => w.includes('style-library.json')))
    assert.ok(warnings.some(w => w.includes('style-selection.json')))
    await service.select({ id: 'general' })
    assert.equal((await service.selected()).id, 'general')
    const imported = await service.importStyle({ name: '修复后', description: '规则', source: { kind: 'text' } })
    assert.ok((await service.list()).styles.some(s => s.id === imported.style.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('repo skills are found at a repository root marked by .git, past a package.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-repo-'))
  try {
    await mkdir(path.join(root, '.git'), { recursive: true })
    await seedSkills(root, 'project')
    const pkg = path.join(root, 'packages', 'bohack-blueprint')
    await mkdir(path.join(pkg, 'lib'), { recursive: true })
    // The package has its own package.json but no skills: it must not end the walk.
    await writeFile(path.join(pkg, 'package.json'), '{"name":"@bohack/blueprint"}')
    const skills = await collectRepoSkills(path.join(pkg, 'lib'))
    assert.equal(skills.length, 4)
    assert.ok(skills.every(s => s.kind === 'skill' && String(s.id).startsWith('repo-skill:')))
    assert.ok(skills.some(s => s.name === 'project-vibe-knowledge-film' && s.summary && s.description))
    assert.deepEqual(await collectRepoSkills(root), skills)
    await rm(path.join(root, '.agents/skills/vibe-knowledge-film'), { recursive: true })
    assert.equal((await collectRepoSkills(root)).length, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the walk stops at the repository root and never absorbs ancestor skills', async () => {
  const outer = await mkdtemp(path.join(tmpdir(), 'styles-ancestor-'))
  try {
    await seedSkills(outer, 'unrelated')
    for (const marker of ['dir', 'file']) {
      const repo = path.join(outer, `repo-${marker}`)
      const deep = path.join(repo, 'packages', 'bohack-blueprint', 'lib')
      await mkdir(deep, { recursive: true })
      if (marker === 'dir') await mkdir(path.join(repo, '.git'), { recursive: true })
      else await writeFile(path.join(repo, '.git'), 'gitdir: /elsewhere\n')
      assert.deepEqual(await collectRepoSkills(deep), [], `.git 作为${marker}时都应停止向上`)
    }
  } finally { await rm(outer, { recursive: true, force: true }) }
})

test('the walk gives up beyond the depth limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-depth-'))
  try {
    await seedSkills(root, 'far')
    const at = depth => path.join(root, ...Array.from({ length: depth }, (_, i) => `d${i}`))
    const within = at(8)
    await mkdir(within, { recursive: true })
    assert.equal((await collectRepoSkills(within)).length, 4)
    const beyond = at(9)
    await mkdir(beyond, { recursive: true })
    assert.deepEqual(await collectRepoSkills(beyond), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
