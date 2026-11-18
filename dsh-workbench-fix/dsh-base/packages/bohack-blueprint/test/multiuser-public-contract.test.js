import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createMultiuserHandler } from '../lib/multiuser.js'

function request(handler, { url, method = 'GET', cookie = '', data } = {}) {
  const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))])
  Object.assign(req, { url, method, headers: { cookie, origin: 'https://workbench.example', 'x-bohack-client': '1', 'content-type': 'application/json' } })
  const headers = {}
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    writeHead(status, values = {}) { this.statusCode = status; Object.assign(headers, values); this.headersSent = true },
    end(value = '') { this.body = String(value) },
    destroy() {},
  }
  return handler(req, res).then(() => ({ ...res, headers }))
}

test('公网会话 Cookie 有明确有效期', async () => {
  const handler = createMultiuserHandler({}, { workspace: '/tmp/bohack-public-shared', temporaryRoot: '/tmp/bohack-public-temp', origin: 'https://workbench.example', ttlMs: 60000 })
  const response = await request(handler, { url: '/bohack/' })
  assert.match(response.headers['set-cookie'], /(?:^|;\s*)Max-Age=[1-9]\d*/i)
})
