import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMembership } from '../lib/membership.js'
import { createProduction } from '../lib/production.js'
import { createWebHandler } from '../lib/web.js'

test('desktop restart resumes the same authorization and recovers a lost finish receipt without rerendering', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'jiangjie-resume-'))
  t.after(() => rm(home, { recursive:true, force:true }))
  const root = path.join(home, 'projects'), kit = path.join(home, 'kit')
  const workspace = path.join(root, 'old-film')
  const stateFile = path.join(workspace, 'production', 'status.json')
  const jobId = 'de0caa3e-9518-45b3-92c2-2a5a5fdb319d'
  const job = path.join(workspace, 'production', jobId)
  const audio = path.join(job, 'film', 'audio')
  const traces = path.join(home, 'pipeline-calls.txt')
  let remaining = 3, lostReceipt = false, offline = false
  const monthlyExpiresAt = '2099-12-20T00:00:00.000Z'
  const calls = [], authorized = new Map()
  const server = async (url, options) => {
    const route = new URL(url).pathname
    const { productionId } = JSON.parse(options.body || '{}')
    calls.push([route, productionId])
    if (offline) throw new Error('本机模拟断线')
    if (route === '/api/auth/sign-in/email') {
      return Response.json({ user:{id:'owner',email:'owner@example.test'} }, { headers:{'set-auth-token':'local-fixture-token'} })
    }
    if (route === '/api/member') return Response.json({ giftRemaining:remaining, monthlyExpiresAt, monthlyStatus:'active', monthlyTokens:25, purchaseAvailable:false, activeProductionId:[...authorized].find(([, state]) => state === 'active')?.[0] })
    if (route === '/api/productions/start') {
      if (!authorized.has(productionId)) {
        if ([...authorized.values()].includes('active')) return Response.json({error:'active_production'}, {status:409})
        remaining--
        authorized.set(productionId, 'active')
      }
      assert.equal(authorized.get(productionId), 'active')
      return Response.json({status:'active'})
    }
    assert.ok(authorized.has(productionId), route)
    if (authorized.get(productionId) === 'active') authorized.set(productionId, route.endsWith('/finish') ? 'finished' : 'abandoned')
    if (lostReceipt && route.endsWith('/finish')) { lostReceipt = false; throw new Error('本机模拟丢失 HTTP 回执') }
    return Response.json({status:authorized.get(productionId)})
  }
  const connect = () => createMembership({}, root, { url:'http://127.0.0.1:8765', request:server })
  const makeProduction = (client, directory = workspace) => createProduction(directory, {
    desktop:true, videoKitDir:kit, memberProject:client.project(directory),
    settings:{ forCall:async ({baseUrl,token}) => ({model:{baseUrl,model:'fixture',apiKey:token},tts:{baseUrl,model:'fixture',voice:'fixture'}}) },
  })
  const finishRun = async production => {
    for (let i=0; production.isActive() && i<100; i++) await delay(20)
    assert.equal(production.isActive(), false)
    return production.status()
  }
  const client = connect(), memberProject = client.project(workspace)
  const accountView = await client.update({action:'login',email:'owner@example.test',password:'test-password'})
  assert.deepEqual(accountView.account, {email:'owner@example.test',gifts:3,monthly:{expiresAt:monthlyExpiresAt},monthlyBalance:25,monthlyStatus:'active'})
  const { id:authorizationId } = await memberProject.lease()
  await mkdir(audio, {recursive:true})
  await mkdir(path.join(job, 'scenes'), {recursive:true})
  await mkdir(path.join(kit, 'WORK', 'modules', 'video'), {recursive:true})
  await writeFile(path.join(job, 'scenes', 'production.json'), '{}')
  await writeFile(path.join(audio, 'S01.mp3'), 'previously paid audio')
  await writeFile(path.join(job, 'production.json'), JSON.stringify({version:'v1',sections:[{id:'S01',narration:'段落'}]}))
  await writeFile(stateFile, JSON.stringify({id:jobId,mode:'structured',version:'v1',status:'running',membershipAuthorizationId:authorizationId}))
  const scripts = path.join(kit, 'WORK', 'modules', 'video')
  await writeFile(path.join(scripts, 'pipeline.mjs'), `
    import { appendFile, readFile, writeFile } from 'node:fs/promises'
    const out = process.argv[process.argv.indexOf('--out')+1]
    if (process.env.VIDEO_RESUME !== '1' || await readFile(out+'/audio/S01.mp3','utf8') !== 'previously paid audio') throw Error('lost checkpoint')
    await appendFile(${JSON.stringify(traces)}, 'pipeline\\n')
    if ((await readFile(${JSON.stringify(traces)}, 'utf8')) === 'pipeline\\n') throw Error('fixture transient provider failure')
    await writeFile(out+'/mapping.json', '{}')
    await writeFile(out+'/final.mp4', 'fixture media bytes')
  `)
  await writeFile(path.join(scripts, 'verify.mjs'), `
    import { writeFile } from 'node:fs/promises'
    await writeFile(new URL('./verify-report.json', 'file://'+process.argv[2]), '{"hardErrors":[]}')
  `)

  let app = makeProduction(connect())
  const workbench = createServer(createWebHandler({ get production() { return app } }, null, {}))
  workbench.listen(0, '127.0.0.1')
  await once(workbench, 'listening')
  t.after(() => new Promise(resolve => workbench.close(resolve)))
  const endpoint = `http://127.0.0.1:${workbench.address().port}/bohack/api`
  async function operate(body) {
    const response = await fetch(endpoint + '/production', {method:'POST',
      headers:{'x-bohack-client':'1','content-type':'application/json'},body:JSON.stringify(body)})
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }
  const stale = await app.status()
  assert.equal(stale.status, 'interrupted')
  await assert.rejects(operate({mode:'agent',feedback:'Change the film'}), /先继续或放弃/)
  offline = true
  await assert.rejects(operate({jobId}), /模拟断线/)
  assert.equal((await app.status()).id, jobId)
  offline = false
  assert.equal((await operate({jobId})).id, jobId)
  await assert.rejects(operate({jobId}), /正在运行/)
  assert.match((await finishRun(app)).error, /fixture transient provider failure/)
  assert.equal(remaining, 2)

  app = makeProduction(connect())
  lostReceipt = true
  assert.equal((await operate({jobId})).id, jobId)
  const pending = await finishRun(app)
  assert.equal(pending.status, 'completed')
  assert.equal(pending.membershipPending, true)
  assert.match(pending.membershipError, /模拟丢失 HTTP 回执/)
  assert.equal(authorized.get(authorizationId), 'finished')
  await assert.rejects(operate({mode:'agent',feedback:'Change the film'}), /先补交完成回执/)
  const callCount = calls.length
  offline = true
  app = makeProduction(connect())
  const download = await fetch(endpoint + '/production-file?kind=video')
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'video/mp4')
  assert.equal(await download.text(), 'fixture media bytes')
  assert.equal(calls.length, callCount)
  await assert.rejects(operate({jobId}), /回执待处理/)
  offline = false
  assert.equal((await operate({jobId})).membershipPending, undefined)
  assert.equal((await operate({jobId})).status, 'completed')
  assert.equal(await readFile(traces,'utf8'), 'pipeline\npipeline\n')
  assert.equal(authorized.size, 1)
  assert.equal(remaining, 2)

  // A new AI request after confirmed completion receives a new authorization.
  const fresh = await connect().project(workspace).lease()
  assert.notEqual(fresh.id, authorizationId)
  assert.equal(remaining, 1)
  offline = true
  await assert.rejects(operate({action:'abandon', authorizationId:fresh.id}), /模拟断线/)
  assert.equal((await connect().project(workspace).current()).closing, 'abandon')
  offline = false
  await operate({action:'abandon', authorizationId:fresh.id})
  await operate({action:'abandon', authorizationId:fresh.id})
  assert.equal(authorized.get(fresh.id), 'abandoned')
  assert.equal(remaining, 1)
  const nextWorkspace = path.join(root, 'next-film')
  const next = await connect().project(nextWorkspace).lease()
  assert.notEqual(next.id, fresh.id)
  await assert.rejects(app.abandon(authorizationId), /授权已完成/)
  assert.equal(authorized.get(next.id), 'active')
  assert.equal(remaining, 0)
  // The App can quit after writing the verified movie and before saving completion.
  const nextJob = path.join(nextWorkspace, 'production', jobId)
  await cp(job, nextJob, {recursive:true})
  await writeFile(path.join(nextWorkspace, 'production', 'status.json'),
    JSON.stringify({id:jobId,mode:'structured',version:'v1',status:'running',membershipAuthorizationId:next.id}))
  app = makeProduction(connect(), nextWorkspace)
  offline = true
  const beforeRecovery = calls.length
  const recovered = await operate({jobId})
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.membershipPending, true)
  assert.deepEqual(calls.slice(beforeRecovery), [['/api/productions/finish', next.id]])
  assert.equal(authorized.get(next.id), 'active')
  offline = false
  await operate({jobId})
  assert.equal(authorized.get(next.id), 'finished')
  assert.equal(await readFile(traces,'utf8'), 'pipeline\npipeline\n')
  assert.equal(remaining, 0)
})
