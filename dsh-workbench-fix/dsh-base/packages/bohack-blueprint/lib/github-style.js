import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readSkillMetadata } from './skill-packages.js'
import { childEnvironment, findExecutable } from './runtime.js'

const exec = promisify(execFile)
const git = async (...args) => {
  const command = findExecutable(process.platform === 'win32' ? 'git.exe' : 'git')
  if (!command) throw new Error('当前运行环境未找到 Git。')
  return (await exec(command, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...childEnvironment(process.env, [command]), GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
}

function githubUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new Error('请输入公开 GitHub 仓库链接。') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('请输入公开 GitHub 仓库链接。')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || p.includes('/') || p.includes('\\')) || !parts.slice(0, 2).every(p => /^[\w.-]+$/.test(p))) throw new Error('GitHub 仓库链接无效。')
  const repo = parts[1].replace(/\.git$/, '')
  if (parts.length > 2 && parts[2] !== 'tree') throw new Error('请使用仓库地址或 tree 目录地址。')
  return { source: `https://github.com/${parts[0]}/${repo}`, tail: parts.slice(3) }
}

async function refAndPath(remote, tail) {
  if (!tail.length) return {}
  const refs = (await git('ls-remote', '--heads', '--tags', remote)).split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean).map(ref => ref.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, ''))
  const ref = refs.filter(candidate => tail.join('/').startsWith(candidate + '/') || tail.join('/') === candidate).sort((a, b) => b.length - a.length)[0]
  if (ref) return { ref, subdir: tail.slice(ref.split('/').length).join('/') }
  if (/^[a-f\d]{40}$/i.test(tail[0])) return { ref: tail[0], subdir: tail.slice(1).join('/') }
  throw new Error('无法找到链接中的分支、标签或完整提交号。')
}

async function scan(root, relative = '') {
  const dir = path.join(root, relative)
  const entries = await readdir(dir, { withFileTypes: true })
  const found = []
  if (entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) {
    const text = await readFile(path.join(dir, 'SKILL.md'), 'utf8')
    const { name, description } = await readSkillMetadata(text, path.basename(dir))
    const hints = entries.filter(entry => entry.isFile() && ['package.json', 'requirements.txt', 'pyproject.toml', 'uv.lock', 'Pipfile'].includes(entry.name)).map(entry => entry.name)
    found.push({ id: relative || '.', name, description, path: relative || '.', dependencyHints: hints })
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== '.venv') found.push(...await scan(root, path.join(relative, entry.name)))
  }
  return found
}

export function createGithubInstaller(workspace, { cloneUrl } = {}) {
  const pending = new Map()
  const storage = path.join(workspace, '.agents', '.github-skill-checkouts')
  async function inspect({ url } = {}) {
    const parsed = githubUrl(url)
    const remote = cloneUrl || parsed.source + '.git'
    const { ref, subdir = '' } = await refAndPath(remote, parsed.tail)
    const id = randomUUID(), holder = path.join(storage, id), repo = path.join(holder, 'repo')
    await mkdir(holder, { recursive: true })
    try {
      if (ref && /^[a-f\d]{40}$/i.test(ref)) {
        await git('init', repo)
        await git('-C', repo, 'fetch', '--depth', '1', remote, ref)
        await git('-C', repo, 'checkout', '--detach', 'FETCH_HEAD')
      } else {
        await git('clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', remote, repo)
      }
      const commit = await git('-C', repo, 'rev-parse', 'HEAD')
      const root = await realpath(repo), target = await realpath(path.join(root, subdir))
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('指定目录超出仓库范围。')
      const skills = await scan(target)
      if (!skills.length) throw new Error('所选仓库目录中没有 SKILL.md。')
      const source = { url: parsed.source, ref: ref || null, commit, subdir }
      pending.set(id, { holder, repo: root, target, skills, source })
      return { ok: true, installId: id, source, skills }
    } catch (error) { await rm(holder, { recursive: true, force: true }); throw error }
  }
  async function install({ installId, selected } = {}) {
    const entry = pending.get(installId)
    if (!entry) throw new Error('安装预览已失效，请重新检查仓库。')
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(id => !entry.skills.some(skill => skill.id === id))) throw new Error('请选择要启用的 Skill。')
    const chosen = selected.map(id => entry.skills.find(skill => skill.id === id))
    const root = path.join(workspace, '.agents', 'skills')
    await mkdir(root, { recursive: true })
    const linked = []
    pending.delete(installId)
    try {
      await writeFile(path.join(entry.holder, 'source.json'), JSON.stringify({ ...entry.source, installedAt: new Date().toISOString() }, null, 2) + '\n')
      for (const skill of chosen) {
        const slug = skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        if (!slug) throw new Error(`Skill 名称无效：${skill.name}`)
        const target = path.join(entry.target, skill.id === '.' ? '' : skill.id)
        const location = path.relative(entry.repo, target).split(path.sep).join('/')
        const suffix = createHash('sha256').update(JSON.stringify([entry.source.url.toLowerCase(), location])).digest('hex').slice(0, 12)
        const link = path.join(root, `${slug}-${suffix}`)
        if (process.platform === 'win32') {
          await mkdir(link)
          linked.push(link)
          await writeFile(path.join(link, '.jiangjie-checkout'), path.relative(storage, target), { flag: 'wx' })
        } else {
          await symlink(target, link, 'dir')
          linked.push(link)
        }
        skill.installedPath = process.platform === 'win32' ? target : link
      }
    } catch (error) {
      await Promise.all(linked.map(link => rm(link, { recursive: true, force: true })))
      pending.set(installId, entry)
      if (error.code === 'EEXIST') throw new Error('此仓库目录的 Skill 已安装。')
      throw error
    }
    return { ok: true, skills: chosen.map(skill => ({ id: skill.id, name: skill.name, path: skill.installedPath })) }
  }
  return { inspect, install }
}
