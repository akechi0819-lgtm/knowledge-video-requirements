// Fetch one public document into the editor. Nothing from a repository is installed.
export async function readGithubStyle(input, fetcher = fetch) {
  const url = new URL(typeof input === 'string' ? input : input?.url)
  let parts = url.pathname.split('/').slice(1)
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) {
    throw new Error('请粘贴 GitHub 上具体 SKILL.md 的 HTTPS 链接。')
  }
  if (url.hostname === 'github.com') {
    if (parts[2] !== 'blob') throw new Error('请打开仓库中的 SKILL.md 文件，再复制链接。')
    parts.splice(2, 1)
  }
  if (parts.length < 4 || parts.at(-1).toLowerCase() !== 'skill.md' || parts.some(p => !p)) {
    throw new Error('链接应指向具体版本的 SKILL.md 文件。')
  }
  const raw = new URL('https://raw.githubusercontent.com')
  raw.pathname = '/' + parts.join('/')
  const response = await fetcher(raw, { redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('无法读取公开 SKILL.md，GitHub 返回 ' + response.status)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 400000) throw new Error('风格文档过大，请粘贴其中的设计说明。')
    chunks.push(chunk)
  }
  const content = Buffer.concat(chunks).toString('utf8').trim()
  if (!content || content.length > 100000) throw new Error('风格文档应包含 1 至 10 万字符。')
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const name = front && /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim().replace(/^["']|["']$/g, '')
  return { name: name || decodeURIComponent(parts.length === 4 ? parts[1] : parts.at(-2)), content, source: url.href }
}
