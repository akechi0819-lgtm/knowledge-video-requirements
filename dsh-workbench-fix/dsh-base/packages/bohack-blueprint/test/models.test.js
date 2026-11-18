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

test('a trailing slash difference still hits the saved key, but another origin never does', async () => {
  const calls = []
  const request = async (url, options) => { calls.push([url.href, options]); return ok }
  const trailing = {
    model: { baseUrl: 'https://api.example/prefix/v1/chat/completions/', model: 'scene', apiKey: 'secret' },
    tts: { baseUrl: 'https://voice.example/v1/audio/speech/', apiKey: 'voice' },
  }
  await listModels({ kind: 'model', baseUrl: 'https://api.example/prefix/v1/chat/completions' }, trailing, request, {})
  assert.equal(calls[0][0], 'https://api.example/prefix/v1/models')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer secret')
  await listModels({ kind: 'model', baseUrl: 'https://api.example/prefix/v1/chat/completions///' }, saved, request, {})
  assert.equal(calls[1][1].headers.Authorization, 'Bearer secret')
  await listModels({ kind: 'tts', baseUrl: 'https://voice.example/v1/audio/speech' }, trailing, request, {})
  assert.equal(calls[2][0], 'https://voice.example/v1/models')
  assert.equal(calls[2][1].headers.Authorization, 'Bearer voice')
  await listModels({ kind: 'model', baseUrl: 'https://evil.example/prefix/v1/chat/completions' }, saved, request, {})
  assert.equal(calls[3][1].headers.Authorization, undefined, '同路径不同主机不得继承密钥')
  const env = { SCENE_ENDPOINT: 'https://scene.example/v1/chat/completions/', SCENE_MODEL: 'm', SCENE_API_KEY: 'hidden' }
  const result = await listModels({ kind: 'model', baseUrl: 'https://scene.example/v1/chat/completions' }, {}, request, env)
  assert.equal(calls[4][1].headers.Authorization, 'Bearer hidden')
  assert.equal(JSON.stringify(result).includes('hidden'), false)
})


test('云端模型列表锁定通用端点，配音可使用小米端点', async () => {
  const oldModel = process.env.BOHACK_CLOUD_MODEL
  const oldBase = process.env.BOHACK_CLOUD_BASE_URL
  process.env.BOHACK_CLOUD_MODEL = 'terra-test'
  process.env.BOHACK_CLOUD_BASE_URL = 'https://terra.example/v1'
  try {
    const calls = []
    const request = async (url, options) => { calls.push([url.href, options]); return ok }
    const settings = { model: { baseUrl: 'https://terra.example/v1', apiKey: 'terra-fake-key' }, tts: { baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'xiaomi-fake-key' } }
    await listModels({ kind: 'model' }, settings, request)
    await listModels({ kind: 'tts' }, settings, request)
    assert.equal(calls[0][1].headers.Authorization, 'Bearer terra-fake-key')
    assert.equal(calls[1][1].headers.Authorization, 'Bearer xiaomi-fake-key')
    await assert.rejects(listModels({ kind: 'model', baseUrl: 'https://other.example/v1' }, settings, request), /固定/)
  } finally {
    oldModel === undefined ? delete process.env.BOHACK_CLOUD_MODEL : process.env.BOHACK_CLOUD_MODEL = oldModel
    oldBase === undefined ? delete process.env.BOHACK_CLOUD_BASE_URL : process.env.BOHACK_CLOUD_BASE_URL = oldBase
  }
})
