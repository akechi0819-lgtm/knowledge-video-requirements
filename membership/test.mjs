import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createMembershipService } from './server.mjs';
import { initializeMonthly, issuePass, passStatus, transaction } from './monthly.mjs';

function fixturePass(db, userId) {
  return transaction(db, () => issuePass(db,userId,Date.now(),'fixture-'+userId+'-'+db.prepare('SELECT COUNT(*) AS n FROM monthly_pass').get().n,
    {budgetMicroCny:51000,durationDays:7}));
}

test('the service entry point starts from a path containing spaces and Chinese characters', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), '讲界 内测-'));
  for (const file of ['server.mjs', 'monthly.mjs', 'billing.mjs', 'epay.mjs', 'payment-orders.mjs', 'payment-http.mjs']) copyFileSync(join(import.meta.dirname, file), join(dir, file));
  symlinkSync(join(import.meta.dirname, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const child = spawn(process.execPath, [join(dir, 'server.mjs')], {
    cwd: dir,
    env: { PORT: '0', BETTER_AUTH_URL: 'http://127.0.0.1:8787', BETTER_AUTH_SECRET: 'local-test-only-32-character-secret' },
  });
  const closed = once(child, 'close');
  try {
    const [output] = await Promise.race([once(child.stdout, 'data'), closed]);
    assert.match(String(output), /Membership service listening/);
  } finally {
    child.kill();
    await closed;
    rmSync(dir, { recursive: true });
  }
});

test('real HTTP auth, quota, concurrent authorization, proxy and accounting', async t => {
  const dir=mkdtempSync(join(tmpdir(),'member-'));
  const seen=[];
  const largeAudio=Buffer.alloc(300*1024,1);
  const delayed = Promise.withResolvers(), release = Promise.withResolvers();
  const lateStarted = Promise.withResolvers(), lateRelease = Promise.withResolvers();
  const mock=createServer(async(req,res)=>{
    const body=JSON.parse(await new Response(req).text()); seen.push({url:req.url,authorization:req.headers.authorization,body});
    if(body.delay_test) { delayed.resolve(); await release.promise; }
    if(body.late_test) { lateStarted.resolve(); await lateRelease.promise; }
    if(body.fail_test) { res.writeHead(503,{'content-type':'application/json'}); return res.end(JSON.stringify({error:'temporary_failure'})); }
    if(body.redirect_test) { res.writeHead(302,{location:'http://127.0.0.1:1/'}); return res.end(); }
    if(body.audio) {
      const data=body.messages[0].content==='invalid audio'?'not-base64!':Buffer.from([4,5,6]).toString('base64');
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify({choices:[{message:{audio:{data}}}],usage:{input_tokens:30,output_tokens:50}}));
    }
    if(req.url.endsWith('/audio/speech')) {
      res.writeHead(200,{'content-type':'audio/mpeg'});
      return res.end(body.input==='large audio'?largeAudio:Buffer.from([1,2,3]));
    }
    const usage=body.break_test ? {input_tokens:0,output_tokens:3517240}
      : {input_tokens:5,output_tokens:2,input_tokens_details:{cached_tokens:3}};
    if(body.interrupt_test) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"type":"response.output_text.delta","delta":"部分响应"}\n\n');
      await new Promise(resolve => setTimeout(resolve,20));
      return res.destroy();
    }
    if(body.stream) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      const event=req.url.endsWith('/responses')
        ? {type:'response.completed',response:{usage}}
        : {usage:{prompt_tokens:5,completion_tokens:2,prompt_tokens_details:{cached_tokens:3}}};
      return res.end(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\n\n`);
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({usage:body.missing_usage?undefined:usage,choices:[]}));
  });
  mock.listen(0,'127.0.0.1'); await once(mock,'listening');
  const upstream=`http://127.0.0.1:${mock.address().port}/v1`;
  const portServer=createServer(); portServer.listen(0,'127.0.0.1'); await once(portServer,'listening'); const port=portServer.address().port; await new Promise(r=>portServer.close(r));
  const baseURL=`http://127.0.0.1:${port}`;
  const config={localTestUnlimited:true,database:join(dir,'test.sqlite'),baseURL,secret:'AnActualRandomSecretForTestingOnly987654321',chat:{baseURL:upstream,key:'server-secret',model:'paid-model'},tts:{baseURL:upstream,key:'tts-secret',model:'tts-model',voice:'voice'}};
  const svc=await createMembershipService(config);
  svc.server.listen(port,'127.0.0.1'); await once(svc.server,'listening');
  try {
    const cli = fileURLToPath(new URL('./grant.mjs', import.meta.url));
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, config.database, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    async function request(path,body,token,extra={}) {
      const res=await fetch(baseURL+path,{method:body?'POST':'GET',headers:{origin:baseURL,...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{ }),...extra},body:body?JSON.stringify(body):undefined});
      const value=(res.headers.get('content-type')||'').includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return {status:res.status,value,headers:res.headers};
    }
    const issue = () => execFileSync(process.execPath, [fileURLToPath(new URL('./invite.mjs', import.meta.url)), config.database], {encoding:'utf8'}).trim();
    const firstCode = issue();
    const signup=await request('/api/auth/sign-up/email',{name:'Test',email:'test@example.com',password:'some-password-123'},null,{'x-invite-code':firstCode});
    assert.equal(signup.status,200,JSON.stringify(signup.value)); const token=signup.headers.get('set-auth-token'); assert.ok(token);
    assert.equal((await request('/api/member',null,token)).value.giftRemaining,3);
    assert.equal((await request('/api/member',null,token)).value.purchaseAvailable,false);
    assert.equal((await request('/api/member',null,token)).value.passStatus,'none');
    assert.equal((await request('/api/orders',{tokens:999},token)).value.error,'payment_unconfigured');
    const login=await request('/api/auth/sign-in/email',{email:'test@example.com',password:'some-password-123'});
    assert.equal(login.status,200); const token2=login.headers.get('set-auth-token'); assert.ok(token2);
    assert.equal((await request('/api/member',null,token2)).value.giftRemaining,3);
    for(const pid of ['one','two']) { assert.equal((await request('/api/productions/start',{productionId:pid},token)).status,200); assert.equal((await request('/api/productions/finish',{productionId:pid},token)).status,200); }
    const race=await Promise.all(['three','four'].map(productionId=>request('/api/productions/start',{productionId},token2)));
    assert.deepEqual(race.map(x=>x.status).sort(),[200,409]); const pid=race.find(x=>x.status===200).value.productionId;
    assert.equal((await request('/api/productions/start',{productionId:pid},token)).status,200);
    assert.equal((await request('/api/member',null,token)).value.giftRemaining,0);
    const chat=await request(`/api/proxy/${pid}/chat/completions`,{model:'evil',messages:[]},token); assert.equal(chat.status,200);
    const tts=await request(`/api/proxy/${pid}/audio/speech`,{model:'evil',voice:'evil',input:'hello'},token); assert.deepEqual(tts.value,Buffer.from([1,2,3]));
    assert.equal(seen[0].body.model,'paid-model'); assert.equal(seen[0].authorization,'Bearer server-secret');
    assert.equal(seen[1].body.model,'tts-model'); assert.equal(seen[1].body.voice,'voice');
    assert.equal((await request(`/api/proxy/${pid}/responses`,{tools:[{type:'web_search'}]},token)).value.error,'unsupported_tool');
    assert.equal((await request(`/api/proxy/${pid}/chat/completions`,{redirect_test:true},token)).status,500);
    config.tts.protocol='mimo';
    assert.deepEqual((await request(`/api/proxy/${pid}/audio/speech`,{input:'hello'},token)).value,Buffer.from([4,5,6]));
    assert.equal(seen[3].body.audio.voice,'voice'); assert.equal(seen[3].url,'/v1/chat/completions');
    assert.equal((await request('/api/productions/abandon',{productionId:pid},token)).value.status,'abandoned');
    assert.equal((await request('/api/productions/abandon',{productionId:pid},token)).value.status,'abandoned');
    assert.equal((await request('/api/productions/finish',{productionId:pid},token)).value.status,'abandoned');
    assert.equal((await request('/api/member',null,token)).value.activeProductionId,null);
    assert.equal((await request('/api/member',null,token)).value.giftRemaining,0);
    assert.equal((await request('/api/productions/abandon',{productionId:'one'},token)).value.status,'finished');
    assert.equal((await request('/api/productions/abandon',{productionId:'delayed-start'},token)).value.status,'abandoned');
    assert.equal((await request('/api/productions/start',{productionId:'delayed-start'},token)).value.error,'production_finished');
    const other=await request('/api/auth/sign-up/email',{name:'Other',email:'other@example.com',password:'some-password-123'},null,{'x-invite-code':issue()});
    const otherToken=other.headers.get('set-auth-token'); assert.ok(otherToken);
    assert.equal((await request('/api/productions/abandon',{productionId:pid},otherToken)).value.status,'abandoned');
    assert.equal((await request('/api/member',null,otherToken)).value.giftRemaining,3);
    assert.equal((await request('/api/productions/start',{productionId:'other'},otherToken)).status,200);
    assert.equal((await request('/api/productions/abandon',{productionId:'other'},otherToken)).value.status,'abandoned');
    assert.equal((await request('/api/productions/start',{productionId:'next'},otherToken)).status,200);
    assert.equal((await request('/api/member',null,otherToken)).value.giftRemaining,1);
    assert.equal((await request('/api/productions/start',{productionId:'new'},token)).value.error,'quota_exhausted');
    assert.equal((await request(`/api/proxy/${pid}/chat/completions`,{messages:[]},token)).value.error,'production_not_active');
    const email = 'test@example.com';
    const expire = id => svc.db.prepare('UPDATE monthly_pass SET expires_at=? WHERE id=?').run(new Date(Date.now()-86400000).toISOString(),id);
    const memberView = async () => (await request('/api/member',null,token)).value;
    const start = (productionId, replacesProductionId) => request('/api/productions/start',{productionId,replacesProductionId},token);
    const pass = id => svc.db.prepare('SELECT * FROM monthly_pass WHERE id=?').get(id);
    assert.equal((await memberView()).passStatus,'none');
    const oldPass=fixturePass(svc.db,signup.value.user.id).id;
    assert.equal(Date.parse(pass(oldPass).expires_at)-Date.parse(pass(oldPass).starts_at),7*86400000);
    assert.equal(pass(oldPass).budget_micro_cny,51000);
    const active = await memberView();
    assert.equal(active.plan,'weekly_6');
    assert.equal(active.remainingPercent,100);
    assert.equal(active.canPurchase,false);
    assert.doesNotMatch(JSON.stringify(active), /0\.04|micro_cny|monthlyTokens|unlimitedProduction|relayRate/);
    assert.throws(() => fixturePass(svc.db,signup.value.user.id),/暂不叠加/);
    assert.throws(() => run('open-weekly',email),/用法/);
    assert.throws(() => run('test-fulfill','fake'),/用法/);
    assert.equal((await start('weekly')).status,200);

    const firstResponse = request('/api/proxy/weekly/responses',{break_test:true,delay_test:true,stream:true},token);
    await delayed.promise;
    const before = seen.length;
    const concurrentResponse = request('/api/proxy/weekly/responses',{stream:true},token);
    release.resolve();
    assert.equal((await firstResponse).status,200);
    const broken = await concurrentResponse;
    assert.equal(broken.status,402);
    assert.equal(broken.value.error,'quota_circuit_broken');
    assert.equal(seen.length,before);
    assert.equal(pass(oldPass).used_micro_cny,51000);
    assert.ok(pass(oldPass).circuit_broken_at);
    assert.equal((await request('/api/proxy/responses',{stream:true},token,{'x-production-id':'weekly'})).status,402);
    assert.equal(seen.length,before);
    const exhausted = await memberView();
    assert.equal(exhausted.passStatus,'exhausted');
    assert.equal(exhausted.remainingPercent,0);
    assert.equal(exhausted.canPurchase,true);
    assert.ok(Date.parse(exhausted.expiresAt) > Date.now()+6*86400000);
    assert.equal((await start('replacement','weekly')).status,402);
    assert.equal((await memberView()).activeProductionId,'weekly');
    assert.equal((await request('/api/orders',{plan:'weekly_6',amount:1},token)).status,503);

    const newPass=fixturePass(svc.db,signup.value.user.id).id;
    assert.notEqual(newPass,oldPass);
    assert.equal((await memberView()).remainingPercent,100);
    assert.equal((await request('/api/proxy/weekly/responses',{stream:true},token)).status,402);
    assert.equal(seen.length,before);
    assert.equal((await start('replacement','not-owned')).status,409);
    assert.equal((await start('replacement','weekly')).status,200);
    assert.equal((await start('replacement','weekly')).status,200);
    assert.equal((await request('/api/proxy/weekly/responses',{stream:true},token)).status,403);
    assert.equal((await request('/api/proxy/replacement/chat/completions',{messages:[],stream:true},token)).status,200);
    assert.equal((await request('/api/proxy/replacement/responses',{missing_usage:true},token)).status,200);
    assert.equal(pass(oldPass).used_micro_cny,51000);
    assert.equal(pass(newPass).used_micro_cny,2);
    await assert.rejects(request('/api/proxy/replacement/responses',{interrupt_test:true,stream:true},token));
    assert.equal(pass(newPass).used_micro_cny,3);
    const ttsLedger = svc.db.prepare(`SELECT kind,amount,cost_micro_cny,estimated,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens
      FROM usage WHERE production_id='replacement' AND kind='tts'`);
    await t.test('300 KiB speech on an active pass records characters without debiting it', async () => {
      config.tts.protocol='speech';
      const audio=await request('/api/proxy/replacement/audio/speech',{input:'large audio'},token);
      assert.equal(audio.status,200);
      assert.deepEqual(audio.value,largeAudio);
      assert.deepEqual(ttsLedger.all().map(row=>({...row})),[{
        kind:'tts',amount:'large audio'.length,cost_micro_cny:0,estimated:0,
        input_tokens:null,cache_read_tokens:null,cache_write_tokens:null,output_tokens:null,
      }]);
      assert.equal(pass(newPass).used_micro_cny,3);
    });
    await t.test('invalid MiMo audio returns 502 without recording usage or debiting the pass', async () => {
      config.tts.protocol='mimo';
      const count=svc.db.prepare("SELECT COUNT(*) AS count FROM usage").get().count;
      const audio=await request('/api/proxy/replacement/audio/speech',{input:'invalid audio'},token);
      assert.equal(audio.status,502);
      assert.equal(audio.value.error,'invalid_tts_response');
      assert.equal(svc.db.prepare("SELECT COUNT(*) AS count FROM usage").get().count,count);
      assert.equal(pass(newPass).used_micro_cny,3);
    });
    assert.equal((await memberView()).remainingPercent,99);
    assert.equal(run('stop',email).id,newPass);
    assert.equal(run('stop',email).id,newPass);
    assert.equal((await memberView()).passStatus,'stopped');
    assert.equal((await request('/api/proxy/replacement/responses',{stream:true},token)).status,402);
    assert.equal((await request('/api/productions/finish',{productionId:'replacement'},token)).status,200);
    const manualPass = fixturePass(svc.db,signup.value.user.id);
    assert.equal((await memberView()).remainingPercent,100);
    assert.equal((await start('expired')).status,200);
    const late = request('/api/proxy/expired/responses',{late_test:true},token);
    await lateStarted.promise;
    expire(manualPass.id);
    assert.equal((await request('/api/proxy/expired/responses',{stream:true},token)).status,402);
    assert.equal((await memberView()).passStatus,'expired');
    assert.equal((await memberView()).canPurchase,true);
    const afterExpiry = fixturePass(svc.db,signup.value.user.id);
    assert.equal((await start('after-expiry','expired')).status,200);
    lateRelease.resolve();
    assert.equal((await late).status,200);
    assert.equal(pass(manualPass.id).used_micro_cny,1);
    assert.equal(pass(afterExpiry.id).used_micro_cny,0);
    assert.equal((await request('/api/productions/finish',{productionId:'after-expiry'},token)).status,200);
    assert.equal(run('stop',email).id,afterExpiry.id);
    assert.equal((await start('blocked')).value.error,'quota_exhausted');
    assert.equal((await request('/api/member',null,otherToken)).value.passStatus,'none');

    assert.equal(run('unlimited',email).unlimitedProduction,true);
    assert.equal((await request('/api/unlimited',{},token)).status,404);
    assert.ok(!Object.hasOwn(await memberView(),'unlimitedProduction'));
    for (const productionId of ['unlimited-1','unlimited-2']) {
      assert.equal((await start(productionId)).status,200);
      assert.equal((await request(`/api/proxy/${productionId}/responses`,{fail_test:productionId==='unlimited-2'},token)).status,productionId==='unlimited-2'?503:200);
      assert.equal((await request('/api/productions/finish',{productionId},token)).status,200);
    }
    assert.equal(run('metered',email).unlimitedProduction,false);
    assert.equal((await start('metered')).value.error,'quota_exhausted');
    const audit = run('inspect',email);
    assert.deepEqual(audit.orders,[]);
    const exhaustedAudit = audit.passes.find(p=>p.id===oldPass);
    assert.equal(exhaustedAudit.usedYuan,5.10);
    assert.equal(exhaustedAudit.usedPercent,100);
    assert.ok(exhaustedAudit.circuitBroken);
    assert.deepEqual(exhaustedAudit.tokenTotals,{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:3517240});
    assert.ok(audit.usage.some(row=>row.production_id==='replacement' && row.pass_id===newPass && row.estimated===1 && row.cost_micro_cny>0));
    assert.equal(audit.usage.filter(row=>row.production_id==='replacement' && row.estimated===1).length,2);
    assert.ok(audit.usage.some(row=>row.funding==='unlimited' && !row.pass_id && row.cost_micro_cny>0));
    const giftUsage=audit.usage.filter(row=>row.funding==='gift');
    assert.equal(giftUsage.length,3);
    assert.ok(giftUsage.every(row=>!row.pass_id && (row.kind==='tts' ? row.cost_micro_cny===0 && row.amount===5 && row.input_tokens===null : row.cost_micro_cny>0)));
  } finally { release.resolve(); lateRelease.resolve(); await new Promise(r=>svc.server.close(r)); await new Promise(r=>mock.close(r)); svc.db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('legacy balances migrate once without guessing a period for existing productions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE member(user_id TEXT PRIMARY KEY,gifts INTEGER,tokens INTEGER,expires_at TEXT);
      CREATE TABLE monthly_pass(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tokens INTEGER NOT NULL,starts_at TEXT,expires_at TEXT NOT NULL,stopped_at TEXT);
      INSERT INTO monthly_pass(id,user_id,tokens,expires_at) VALUES ('spent-card','spent',0,'2099-01-01T00:00:00Z');
      CREATE TABLE production(user_id TEXT,id TEXT,status TEXT,funding TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,production_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER,created_at TEXT NOT NULL);
      INSERT INTO usage VALUES ('historical','account','old','text',42,'2026-01-01T00:00:00Z');
      INSERT INTO member VALUES ('account', 0, 55, '2099-01-01T00:00:00Z');
      INSERT INTO member VALUES ('spent-member',0,0,'2099-01-01T00:00:00Z');
      INSERT INTO production VALUES ('account', 'old', 'active', 'monthly');`);
    initializeMonthly(db);
    const pass = userId => db.prepare('SELECT * FROM monthly_pass WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(userId);
    const spent = ['spent','spent-member'].map(pass);
    for (const card of spent) {
      assert.equal(card.tokens,0);
      assert.equal(card.budget_micro_cny,51000);
      assert.equal(card.used_micro_cny,51000);
      assert.ok(card.circuit_broken_at);
      assert.equal(passStatus(card),'exhausted');
    }
    assert.equal(pass('account').tokens,55);
    assert.equal(pass('account').plan_code,'weekly_6');
    assert.equal(pass('account').used_micro_cny,0);
    assert.equal(passStatus(pass('account')),'active');
    const newCard = fixturePass(db,'spent');
    assert.equal(newCard.tokens,0);
    initializeMonthly(db);
    assert.deepEqual(db.prepare('SELECT * FROM monthly_pass WHERE id=?').get(spent[0].id),spent[0]);
    assert.deepEqual(pass('spent-member'),spent[1]);
    assert.equal(pass('spent').id,newCard.id);
    assert.equal(pass('spent').used_micro_cny,0);
    assert.equal(passStatus(pass('spent')),'active');
    assert.deepEqual({...db.prepare('SELECT amount,cost_micro_cny,estimated,input_tokens FROM usage').get()},
      {amount:42,cost_micro_cny:null,estimated:0,input_tokens:null});
    assert.equal(db.prepare('SELECT pass_id FROM production').get().pass_id,null);
  } finally { db.close(); }
});

test('invitation registration is single use, releases on failure and honors the public prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-invite-'));
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const prefix = '/desktop-membership';
  const database = join(dir, 'member.sqlite');
  const svc = await createMembershipService({ database, baseURL: origin, pathPrefix: prefix, localTestUnlimited: true, secret: 'local-test-only-32-character-secret' });
  svc.server.listen(port, '127.0.0.1');
  await once(svc.server, 'listening');
  const cli = fileURLToPath(new URL('./invite.mjs', import.meta.url));
  const issue = () => execFileSync(process.execPath, [cli, database], { encoding: 'utf8' }).trim();
  const request = async (route, data, code, token) => {
    const res = await fetch(origin + prefix + route, {
      method: data ? 'POST' : 'GET',
      headers: { origin, ...(data && { 'content-type': 'application/json' }), ...(code && { 'x-invite-code': code }), ...(token && { authorization: 'Bearer ' + token }) },
      ...(data && { body: JSON.stringify(data) }),
    });
    return { status: res.status, data: await res.json(), token: res.headers.get('set-auth-token') };
  };
  const credentials = email => ({ name: 'Test', email, password: 'some-password-123' });
  try {
    assert.equal((await request('/api/auth/sign-up/email', credentials('missing@example.com'))).status, 403);
    assert.equal((await request('/api/auth/sign-up/email/', credentials('missing@example.com'))).status, 403);
    assert.equal((await fetch(origin + '/api/auth/sign-up/email', { method: 'POST' })).status, 404);
    const code = issue();
    assert.equal((await request('/api/auth/sign-up/email', { ...credentials('invalid@example.com'), password: 'x' }, code)).status, 400);
    const pair = await Promise.all([
      request('/api/auth/sign-up/email', credentials('first@example.com'), code),
      request('/api/auth/sign-up/email', credentials('second@example.com'), code),
    ]);
    assert.deepEqual(pair.map(result => result.status).sort(), [200, 403]);
    const created = pair.find(result => result.status === 200);
    assert.ok(created.token);
    assert.equal((await request('/api/member', null, null, created.token)).data.giftRemaining, 3);
    svc.db.prepare('INSERT INTO unlimited_production(user_id) VALUES (?)').run(created.data.user.id);
    svc.db.prepare('UPDATE member SET gifts=0 WHERE user_id=?').run(created.data.user.id);
    const publicMember = await request('/api/member', null, null, created.token);
    assert.ok(!Object.hasOwn(publicMember.data,'unlimitedProduction'));
    assert.equal((await request('/api/productions/start',{productionId:'public-bypass'},null,created.token)).data.error,'quota_exhausted');
    svc.db.prepare('UPDATE member SET gifts=3 WHERE user_id=?').run(created.data.user.id);
    assert.equal((await request('/api/auth/sign-up/email', credentials('third@example.com'), code)).status, 403);
    const login = await request('/api/auth/sign-in/email', credentials(created.data.user.email));
    assert.equal(login.status, 200);
    assert.equal((await request('/api/member', null, null, login.token)).data.giftRemaining, 3);
    const next = issue();
    assert.equal((await request('/api/auth/sign-up/email', credentials(created.data.user.email), next)).status, 422);
    assert.equal((await request('/api/auth/sign-up/email', credentials('fresh@example.com'), next)).status, 200);
    assert.equal(svc.db.prepare('SELECT COUNT(*) count FROM invite_code WHERE used_at IS NOT NULL').get().count, 2);
    assert.equal(svc.db.prepare('SELECT COUNT(*) count FROM invite_code WHERE hash=?').get(code).count, 0);
    const recoveryUsed = issue(), recoveryFree = issue();
    const digest = code => createHash('sha256').update(code).digest('hex');
    const reserve = svc.db.prepare('UPDATE invite_code SET reservation=?,reserved_email=? WHERE hash=?');
    reserve.run('crash-after-account', created.data.user.email, digest(recoveryUsed));
    reserve.run('crash-before-account', 'absent@example.com', digest(recoveryFree));
    const restarted = await createMembershipService({ database, baseURL: origin, pathPrefix: prefix, localTestUnlimited: true, secret: 'local-test-only-32-character-secret' });
    try {
      assert.ok(restarted.db.prepare('SELECT used_at FROM invite_code WHERE hash=?').get(digest(recoveryUsed)).used_at);
      assert.deepEqual({ ...restarted.db.prepare('SELECT used_at,reservation FROM invite_code WHERE hash=?').get(digest(recoveryFree)) }, { used_at: null, reservation: null });
    } finally { restarted.db.close(); }

  } finally {
    await new Promise(resolve => svc.server.close(resolve));
    svc.db.close();
    rmSync(dir, { recursive: true });
  }
});
