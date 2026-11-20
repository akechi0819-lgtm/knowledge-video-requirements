import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { createMembershipService } from './server.mjs';
import { initializeMonthly } from './monthly.mjs';

test('the service entry point starts from a path containing spaces and Chinese characters', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), '讲界 内测-'));
  for (const file of ['server.mjs', 'monthly.mjs']) copyFileSync(join(import.meta.dirname, file), join(dir, file));
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

test('real HTTP auth, quota, concurrent authorization, proxy and accounting', async () => {
  const dir=mkdtempSync(join(tmpdir(),'member-'));
  const seen=[];
  const delayed = Promise.withResolvers(), release = Promise.withResolvers();
  const mock=createServer(async(req,res)=>{
    const body=JSON.parse(await new Response(req).text()); seen.push({url:req.url,authorization:req.headers.authorization,body});
    if(body.delay_test) { delayed.resolve(); await release.promise; }
    if(body.fail_test) { res.writeHead(503,{'content-type':'application/json'}); return res.end(JSON.stringify({error:'temporary_failure'})); }
    if(body.redirect_test) { res.writeHead(302,{location:'http://127.0.0.1:1/'}); return res.end(); }
    if(body.audio) { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({choices:[{message:{audio:{data:Buffer.from([4,5,6]).toString('base64')}}}]})); }
    if(req.url.endsWith('/audio/speech')) { res.writeHead(200,{'content-type':'audio/mpeg'}); return res.end(Buffer.from([1,2,3])); }
    if(body.stream) { res.writeHead(200,{'content-type':'text/event-stream'}); return res.end('data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n\ndata: [DONE]\n\n'); }
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({usage:{total_tokens:7},choices:[]}));
  });
  mock.listen(0,'127.0.0.1'); await once(mock,'listening');
  const upstream=`http://127.0.0.1:${mock.address().port}/v1`;
  const portServer=createServer(); portServer.listen(0,'127.0.0.1'); await once(portServer,'listening'); const port=portServer.address().port; await new Promise(r=>portServer.close(r));
  const baseURL=`http://127.0.0.1:${port}`;
  const config={database:join(dir,'test.sqlite'),baseURL,secret:'AnActualRandomSecretForTestingOnly987654321',chat:{baseURL:upstream,key:'server-secret',model:'paid-model'},tts:{baseURL:upstream,key:'tts-secret',model:'tts-model',voice:'voice'}};
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
    assert.equal((await request('/api/member',null,token)).value.monthlyStatus,'none');
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
    const oldOrder = run('test-order',email,'20');
    assert.equal(oldOrder.pass_id,null);
    assert.equal(run('test-order',email,'20').id,oldOrder.id);
    assert.equal((await request('/api/member',null,token)).value.monthlyStatus,'none');
    const fulfill = async () => JSON.parse((await promisify(execFile)(process.execPath,[cli,config.database,'test-fulfill',oldOrder.id])).stdout);
    const [first, duplicate] = await Promise.all([fulfill(),fulfill()]);
    const oldPass = first.pass_id;
    assert.ok(oldPass);
    assert.equal(duplicate.pass_id,oldPass);
    assert.equal((await request('/api/member',null,token)).value.monthlyTokens,20);
    assert.throws(() => run('test-order',email,'40'),/暂不接受提前下单/);
    assert.throws(() => run('open',email,'40',new Date(Date.now()+86400000).toISOString()),/暂不叠加/);
    assert.equal((await request('/api/productions/start',{productionId:'monthly'},token)).status,200);
    const lateUsage = request('/api/proxy/monthly/responses',{delay_test:true},token);
    await delayed.promise;
    expire(oldPass);
    assert.equal((await request('/api/member',null,token)).value.monthlyTokens,0);
    assert.equal((await request('/api/member',null,token)).value.monthlyStatus,'expired');
    assert.equal((await request('/api/proxy/monthly/responses',{fail_test:true},token)).status,503);
    assert.equal((await request('/api/productions/start',{productionId:'monthly'},token)).status,200);
    assert.equal((await request('/api/productions/finish',{productionId:'monthly'},token)).status,200);
    const newOrder = run('test-order',email,'6');
    const newPass = run('test-fulfill',newOrder.id).pass_id;
    assert.notEqual(newPass,oldPass);
    release.resolve();
    assert.equal((await lateUsage).status,200);
    assert.equal(run('test-fulfill',oldOrder.id).pass_id,oldPass);
    assert.equal((await request('/api/member',null,token)).value.monthlyTokens,6);
    assert.equal((await request('/api/productions/start',{productionId:'new-monthly'},token)).status,200);
    assert.equal((await request('/api/proxy/new-monthly/chat/completions',{messages:[],stream:true},token)).status,200);
    assert.equal(run('test-fulfill',newOrder.id).pass_id,newPass);
    assert.equal((await request('/api/member',null,token)).value.monthlyTokens,0);
    assert.equal((await request('/api/productions/finish',{productionId:'new-monthly'},token)).status,200);
    assert.equal((await request('/api/productions/start',{productionId:'blocked'},token)).value.error,'quota_exhausted');
    assert.equal(run('stop',email).id,newPass);
    assert.equal(run('stop',email).id,newPass);
    assert.equal((await request('/api/member',null,token)).value.monthlyStatus,'stopped');
    const manualPass = run('open',email,'15',new Date(Date.now()+86400000).toISOString());
    assert.equal((await request('/api/member',null,token)).value.monthlyTokens,15);
    assert.equal(run('stop',email).id,manualPass.id);
    const stopped = (await request('/api/member',null,token)).value;
    assert.equal(stopped.monthlyTokens,0);
    assert.equal(stopped.monthlyExpiresAt,manualPass.expires_at);
    assert.equal((await request('/api/productions/start',{productionId:'stopped'},token)).value.error,'quota_exhausted');
    assert.equal((await request('/api/member',null,otherToken)).value.monthlyStatus,'none');
    const audit = run('inspect',email);
    assert.deepEqual(audit.testOrders.map(order=>order.pass_id),[newPass,oldPass]);
    assert.deepEqual(audit.passes.map(pass=>[pass.id,pass.tokens]),[[manualPass.id,15],[newPass,0],[oldPass,13]]);
    assert.ok(audit.usage.some(row=>row.production_id==='monthly' && row.pass_id===oldPass && row.amount===7));
    assert.equal(svc.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE kind='tts'").get().n,2);
    assert.equal(svc.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE kind='text'").get().n,3);
  } finally { release.resolve(); await new Promise(r=>svc.server.close(r)); await new Promise(r=>mock.close(r)); svc.db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('legacy balances migrate once without guessing a period for existing productions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE member(user_id TEXT PRIMARY KEY,gifts INTEGER,tokens INTEGER,expires_at TEXT);
      CREATE TABLE production(user_id TEXT,id TEXT,status TEXT,funding TEXT,PRIMARY KEY(user_id,id));
      INSERT INTO member VALUES ('account', 0, 55, '2099-01-01T00:00:00Z');
      INSERT INTO production VALUES ('account', 'old', 'active', 'monthly');`);
    initializeMonthly(db);
    initializeMonthly(db);
    assert.deepEqual(db.prepare('SELECT tokens FROM monthly_pass').all().map(pass=>pass.tokens),[55]);
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
  const svc = await createMembershipService({ database, baseURL: origin, pathPrefix: prefix, secret: 'local-test-only-32-character-secret' });
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
    const restarted = await createMembershipService({ database, baseURL: origin, pathPrefix: prefix, secret: 'local-test-only-32-character-secret' });
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
