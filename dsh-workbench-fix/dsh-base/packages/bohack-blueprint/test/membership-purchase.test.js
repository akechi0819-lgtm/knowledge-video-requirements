import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createMembership } from '../lib/membership.js'

test('purchase resumes after restart with private credentials, and logout clears pending order', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'jiangjie-purchase-'))
  t.after(() => rm(home, {recursive:true,force:true}))
  const root = path.join(home, 'projects'), requests = []
  let orderStatus = 'pending', passStatus = 'none'
  const request = async (url, options) => {
    const route = new URL(url).pathname
    const body = JSON.parse(options.body || '{}')
    requests.push({route, body, authorization:options.headers.authorization})
    if (route === '/api/auth/sign-in/email') return Response.json({user:{id:'owner',email:'owner@example.test'}}, {headers:{'set-auth-token':'test-token'}})
    if (route === '/api/auth/sign-out') return Response.json({success:true})
    if (route === '/api/member') return Response.json({plan:'weekly_6',passStatus,remainingPercent:passStatus === 'active' ? 100 : 0,expiresAt:null,canPurchase:passStatus !== 'active',purchaseAvailable:true,giftRemaining:0})
    if (route === '/api/orders' || route === '/api/orders/order-1') return Response.json({orderId:'order-1',plan:'weekly_6',status:orderStatus,qrCode:'https://pay.example.test/qr',payUrl:'https://pay.example.test',expiresAt:'2099-01-01T00:00:00Z'})
    throw Error('unexpected route ' + route)
  }
  const connect = () => createMembership({},root,{url:'http://localhost:8765',request})
  const client = connect()
  await client.update({action:'login',email:'owner@example.test',password:'test'})
  const created = await client.update({action:'order-create'})
  assert.equal(created.pendingOrderId,'order-1')
  assert.deepEqual(requests.find(call => call.route === '/api/orders').body, {plan:'weekly_6'})
  const accountFile = path.join(home,'membership','account.json')
  if (process.platform !== 'win32') assert.equal((await stat(accountFile)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(accountFile,'utf8')).token,'test-token')
  let restarted = connect()
  assert.equal((await restarted.view()).pendingOrderId,'order-1')
  orderStatus = 'paid'
  assert.equal((await restarted.update({action:'order-check'})).order.status,'paid')
  orderStatus = 'fulfilled'; passStatus = 'active'
  const fulfilled = await restarted.update({action:'order-check'})
  assert.equal(fulfilled.pendingOrderId,undefined)
  assert.equal(fulfilled.account.passStatus,'active')
  assert.equal(fulfilled.account.remainingPercent,100)
  assert.equal(requests.find(call => call.route === '/api/orders/order-1').authorization,'Bearer test-token')
  orderStatus = 'pending'; passStatus = 'expired'
  await restarted.update({action:'order-create'})
  await restarted.update({action:'logout'})
  restarted = connect()
  assert.equal((await restarted.view()).account,null)
  assert.equal(JSON.parse(await readFile(accountFile,'utf8')).pendingOrderId,undefined)
  await assert.rejects(restarted.update({action:'order-check'}), /请先登录/)
})
