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
