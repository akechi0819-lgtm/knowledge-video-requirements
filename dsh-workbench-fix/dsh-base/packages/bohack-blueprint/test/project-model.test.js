import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProjectModel } from '../lib/project-model.js'

test('项目配置共享、密钥不回显且切换地址不沿用密钥', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-model-'))
  try {
    const a = createProjectModel(dir), b = createProjectModel(dir)
    const result = await a.save({ endpoint: 'https://one.example/v1/chat/completions', model: 'm', key: 'secret' })
    assert.equal(result.hasKey, true); assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal((await b.view()).endpoint, result.endpoint)
    assert.equal(JSON.stringify(await b.view()).includes('secret'), false)
    await a.save({ endpoint: result.endpoint, model: 'm2', key: '' })
    assert.equal((await b.resolve()).key, 'secret')
    await assert.rejects(a.save({ endpoint: 'https://two.example/v1/chat/completions', model: 'm', key: '' }), /重新填写/)
    await a.save({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local', key: '' })
    assert.equal((await b.resolve()).key, '')
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'project-model.private.json'))).mode & 0o777, 0o600)
    await assert.rejects(a.save({ endpoint: 'http://remote.example/api', model: 'm', key: 'x' }), /HTTPS/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
