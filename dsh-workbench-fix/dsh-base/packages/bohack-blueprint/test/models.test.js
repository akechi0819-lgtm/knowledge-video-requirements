import test from 'node:test'
import assert from 'node:assert/strict'
import { listModels } from '../lib/models.js'

const saved = { model: { baseUrl: 'https://api.example/prefix/v1/chat/completions', model: 'scene', apiKey: 'secret' }, tts: { baseUrl: 'https://voice.example/v1/audio/speech', apiKey: 'voice' } }
const ok = { ok: true, json: async () => ({ data: [{ id: 'one' }, { id: 'two' }] }) }

test('discovers models at the provider prefix without leaking saved keys to another endpoint', async () => {
  const calls = []
  const request = async (url, options) => { calls.push([url.href, options]); return ok }
  assert.deepEqual((await listModels({ kind: 'model', baseUrl: saved.model.baseUrl }, saved, request, {})).models, ['one', 'two'])
  assert.equal(calls[0][0], 'https://api.example/prefix/v1/models')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer secret')
  assert.equal(calls[0][1].redirect, 'error')
  await listModels({ kind: 'model', baseUrl: 'https://other.example/v1/chat/completions' }, saved, request, {})
  assert.equal(calls[1][1].headers.Authorization, undefined)
  await listModels({ kind: 'tts', baseUrl: saved.tts.baseUrl, clearApiKey: true }, saved, request, {})
  assert.equal(calls[2][0], 'https://voice.example/v1/models')
  assert.equal(calls[2][1].headers.Authorization, undefined)
  await listModels({ kind: 'image', baseUrl: 'http://localhost:1234/custom/images/generations', apiKey: 'new' }, saved, request, {})
  assert.equal(calls[3][0], 'http://localhost:1234/custom/models')
  assert.equal(calls[3][1].headers.Authorization, 'Bearer new')
})

test('blank scene form uses effective environment configuration without returning its key', async () => {
  const env = { SCENE_ENDPOINT: 'https://scene.example/v1/chat/completions', SCENE_MODEL: 'm', SCENE_API_KEY: 'hidden' }
  const result = await listModels({ kind: 'model' }, {}, async (url, options) => {
    assert.equal(url.href, 'https://scene.example/v1/models')
    assert.equal(options.headers.Authorization, 'Bearer hidden')
    return ok
  }, env)
  assert.deepEqual(result.effective, { baseUrl: env.SCENE_ENDPOINT, model: 'm' })
  assert.equal(JSON.stringify(result).includes('hidden'), false)
})

test('rejects unsafe endpoints and malformed responses without exposing credentials', async () => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=secret']) {
    await assert.rejects(listModels({ kind: 'model', baseUrl }, {}, async () => ok, {}))
  }
  await assert.rejects(listModels({ kind: 'image', baseUrl: 'https://example.test' }, {}, async () => ({ ok: true, json: async () => ({ error: 'secret' }) }), {}), /格式无效/)
  await assert.rejects(listModels({ kind: 'image', baseUrl: 'https://example.test' }, {}, async () => { throw new Error('secret') }, {}), e => !e.message.includes('secret'))
})
