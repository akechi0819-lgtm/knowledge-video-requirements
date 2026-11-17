import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readGithubStyle } from '../lib/github-style.js'
test('imports only a public GitHub skill document and returns an editable draft', async () => {
  const source = 'https://github.com/org/repo/blob/main/styles/news/SKILL.md'
  const draft = await readGithubStyle({url: source}, async (raw, opts) => {
    assert.equal(raw.href, 'https://raw.githubusercontent.com/org/repo/main/styles/news/SKILL.md')
    assert.equal(opts.redirect, 'error')
    return new Response('---\nname: news\n---\n暖色纸张')
  })
  assert.equal(draft.name, 'news')
  assert.equal(draft.source, source)
  await assert.rejects(readGithubStyle({url:'https://example.org/a/b/c/SKILL.md'}), /GitHub/)
})

// 已知限制：raw URL 无法区分 ref 与 path 的边界，消歧需要额外的 API ref 解析，成本高于收益。
// 本用例固定当前行为，而不是断言它正确。
test('a slash-containing branch stays ambiguous and a 404 points at the workaround', async () => {
  const source = 'https://github.com/org/repo/blob/feature/x/styles/SKILL.md'
  const raws = []
  const draft = await readGithubStyle({ url: source }, async raw => {
    raws.push(raw.href)
    return new Response('设计规则正文')
  })
  assert.deepEqual(raws, ['https://raw.githubusercontent.com/org/repo/feature/x/styles/SKILL.md'])
  assert.equal(draft.name, 'styles', '无 frontmatter 时名字取倒数第二段，斜杠分支下并不可靠')
  assert.equal(draft.source, source)
  await assert.rejects(
    readGithubStyle({ url: source }, async () => new Response('', { status: 404 })),
    /若分支名含斜杠，请改用默认分支链接或手动粘贴文档内容/,
  )
})
