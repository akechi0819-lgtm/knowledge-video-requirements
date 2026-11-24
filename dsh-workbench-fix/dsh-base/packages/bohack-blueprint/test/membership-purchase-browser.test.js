import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || '/Users/akechi/Desktop/hackson/video-kit/node_modules/playwright-core')
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

test('account checkout renders a local QR and restores paid order until fulfilled', async t => {
  const accountScript = (await readFile(new URL('../web/settings.js', import.meta.url), 'utf8')).split('// 会员账号与模式由服务端保存，刷新后以服务端状态为准。')[1]
  const qrScript = await readFile(new URL('../web/qrcode.js', import.meta.url), 'utf8')
  let pending = false, orderStatus = 'pending', checks = 0
  const server = createServer(async (req,res) => {
    if (req.url === '/') { res.writeHead(200,{'content-type':'text/html'}); return res.end('<button id="accountBtn">账号</button>') }
    let raw = ''; for await (const chunk of req) raw += chunk
    const action = raw ? JSON.parse(raw).action : ''
    if (action === 'order-create') pending = true
    if (action === 'order-check') checks++
    if (action === 'logout') pending = false
    if (orderStatus === 'fulfilled' && action === 'order-check') pending = false
    const data = {enabled:true,mode:'member',...(pending && {pendingOrderId:'order-1'}),account:{email:'test@example.test',gifts:0,passStatus:orderStatus === 'fulfilled' ? 'active' : 'none',remainingPercent:100,purchaseAvailable:true,canPurchase:orderStatus !== 'fulfilled'}}
    if (action === 'order-create' || action === 'order-check') data.order = {orderId:'order-1',status:orderStatus,qrCode:'https://pay.example.test/二维码',payUrl:'https://pay.example.test',expiresAt:'2099-01-01T00:00:00Z'}
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(data))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const browser = await chromium.launch({executablePath:chrome,headless:true})
  t.after(async()=>{await browser.close(); await new Promise(resolve=>server.close(resolve))})
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(() => { window.refresh = async () => {} })
  await page.addScriptTag({content:qrScript})
  await page.addScriptTag({content:accountScript})
  await page.locator('#accountBtn').click()
  await page.locator('.account-purchase:not([disabled])').click()
  await page.locator('.account-qr:visible').waitFor()
  assert.ok(await page.locator('.account-qr').evaluate(el=>el.width > 0))
  assert.equal(await page.locator('.account-pay-link').getAttribute('href'),'https://pay.example.test/')
  await page.locator('.ws-close').click()
  orderStatus = 'paid'
  await page.locator('#accountBtn').click()
  await page.getByText('已付款，待生效。').waitFor()
  assert.equal(await page.locator('.account-purchase').textContent(),'查询待处理订单')
  orderStatus = 'fulfilled'
  await page.getByText('购买成功，可以开始或继续制作。').waitFor({timeout:5000})
  assert.ok(checks >= 2)
  assert.equal(await page.locator('.account-payment').isVisible(),false)
  await page.locator('.ws-close').click()
  orderStatus = 'paid'
  await page.locator('#accountBtn').click()
  await page.locator('.account-purchase:not([disabled])').click()
  await page.getByText('已付款，待生效。').waitFor()
  assert.equal(await page.locator('.account-qr').isVisible(), false)
  assert.equal(await page.locator('.account-pay-link').getAttribute('href'), null)
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 16 * 60 * 1000 })
  await page.getByText('自动查询已暂停，可重新打开账号或点击查询待处理订单。').waitFor({timeout:5000})
  const stopped = checks
  await page.waitForTimeout(2600)
  assert.equal(checks, stopped)
  await page.locator('.ws-close').click()
  await page.locator('#accountBtn').click()
  await page.getByText('已付款，待生效。').waitFor()
  assert.ok(checks > stopped)
})
