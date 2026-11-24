import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMembership } from '../dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/membership.js';
import { createProduction } from '../dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/production.js';
import { createMembershipService } from './server.mjs';
import { createPaymentHandlers } from './payment-http.mjs';
import { readEpayConfig } from './epay.mjs';

function signAsGateway(data) {
  const canonical = Object.entries(data).filter(([key,value]) => !['sign','sign_type'].includes(key) && value !== '')
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(pair => pair.join('=')).join('&');
  return createHash('md5').update(canonical).update(process.env.EPAY_KEY).digest('hex');
}

async function listen(server, port = 0) {
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const close = server => new Promise(resolve => server.close(resolve));

test('mock Ouyun checkout, verification, reconciliation, and desktop repurchase', async t => {
  const directory=mkdtempSync(join(tmpdir(),'jiangjie-payment-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const database=join(directory,'member.sqlite');
  const merchantOrders=new Map();
  const queryResponses=new Map();
  let checkoutCount=0, queryCount=0, textCount=0;
  const diagnostics=t.mock.method(console,'warn',() => {});
  const gateway=createServer(async (req,res) => {
    const url=new URL(req.url,'http://localhost');
    const reply=(value,status=200) => {
      res.writeHead(status,{'content-type':'application/json'});
      res.end(JSON.stringify(value));
    };
    if (url.pathname==='/gateway/mapi.php' && req.method==='POST') {
      checkoutCount++;
      const data=Object.fromEntries(new URLSearchParams(await new Response(req).text()));
      if (data.pid!==process.env.EPAY_PID || data.sign!==signAsGateway(data) || data.sign_type!=='MD5'
          || data.type!=='alipay' || data.money!=='6.00' || !isIP(data.clientip)) return reply({code:0},400);
      merchantOrders.set(data.out_trade_no,data);
      if (checkoutCount===1) return reply({code:1,trade_no:'trade-mapi',qrcode:'https://qr.alipay.com/fixture'});
      return reply({code:1,trade_no:'trade-mapi',qrcode:'alipays://mock/pay',payurl:`${gatewayBase}/checkout`});
    }
    if (url.pathname==='/gateway/api.php' && req.method==='GET') {
      queryCount++;
      const data=url.searchParams;
      if (data.get('act')!=='order' || data.get('pid')!==process.env.EPAY_PID || data.get('key')!==process.env.EPAY_KEY) return reply({code:0},403);
      const id=data.get('out_trade_no');
      return reply({code:1,status:0,out_trade_no:id,type:'alipay',money:'6.00',...queryResponses.get(id)});
    }
    if (url.pathname==='/relay/responses') {
      textCount++;
      const body=await new Response(req).json();
      return reply({usage:{input_tokens:0,output_tokens:body.use_balance?3517240:2},output:[]});
    }
    return reply({code:0},404);
  });
  const gatewayBase=await listen(gateway);
  t.after(() => close(gateway));
  const env={
    EPAY_API_URL:gatewayBase+'/gateway', EPAY_PID:String(randomBytes(4).readUInt32BE()), EPAY_KEY:randomBytes(32).toString('hex'),
    EPAY_MODE:'mapi', EPAY_PAY_TYPE:'alipay',
  };
  const previous=new Map([...Object.keys(env),'EPAY_NOTIFY_URL','EPAY_RETURN_URL'].map(k=>[k,process.env[k]]));
  delete process.env.EPAY_NOTIFY_URL;
  delete process.env.EPAY_RETURN_URL;
  Object.assign(process.env,env);
  t.after(() => { for(const [k,v] of previous) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
  const portHolder=createServer();
  const base=await listen(portHolder);
  const port=portHolder.address().port;
  await close(portHolder);
  const prefix='/desktop-membership';
  const origin=base+prefix;
  const serviceConfig={database,baseURL:base,pathPrefix:prefix,secret:randomBytes(32).toString('hex'),
    chat:{baseURL:gatewayBase+'/relay',key:randomBytes(16).toString('hex'),model:'fixture-text'}};
  const svc=await createMembershipService(serviceConfig);
  await listen(svc.server,port);
  t.after(async () => { await close(svc.server); svc.db.close(); });
  const fetchApi=(path,{token,body,method=body?'POST':'GET',headers={}}={})=>fetch(origin+path,{
    method,headers:{origin:base,...(token&&{authorization:'Bearer '+token}),...(body&&{'content-type':'application/json'}),...headers},
    body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),
  });
  async function signup(email) {
    const invite=execFileSync(process.execPath,[join(import.meta.dirname,'invite.mjs'),database],{encoding:'utf8'}).trim();
    const body={name:'Local tester',email,password:'only-a-generated-test-password'};
    const response=await fetchApi('/api/auth/sign-up/email',{body,headers:{'x-invite-code':invite}});
    assert.equal(response.status,200);
    return {user:(await response.json()).user,token:response.headers.get('set-auth-token')};
  }
  const bought=await signup('owner@example.test');
  const other=await signup('other@example.test');
  const request=async (path,body,token=bought.token)=>{
    const response=await fetchApi(path,{body,token});
    return {status:response.status,data:await response.json()};
  };
  await request('/api/member');
  svc.db.prepare('UPDATE member SET gifts=0 WHERE user_id=?').run(bought.user.id);
  const cards=()=>svc.db.prepare('SELECT * FROM monthly_pass WHERE user_id=? ORDER BY rowid').all(bought.user.id);
  function callback(orderId,tradeNo,extra={}) {
    const data={pid:process.env.EPAY_PID,trade_no:tradeNo,out_trade_no:orderId,type:'alipay',
      name:'讲界 6 元周卡（7 天）',money:'6.00',trade_status:'TRADE_SUCCESS',...extra};
    return {...data,sign:signAsGateway(data),sign_type:'MD5'};
  }
  async function notify(data,method='GET') {
    const encoded=new URLSearchParams(data).toString();
    const path='/api/payments/epay/notify';
    const res=method==='GET'?await fetchApi(path+'?'+encoded)
      :await fetchApi(path,{method,body:encoded,headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8'}});
    return [res.status,await res.text()];
  }
  const clientRoot=join(directory,'desktop','projects');
  mkdirSync(clientRoot,{recursive:true});
  const connect=()=>createMembership({},clientRoot,{url:origin});
  const desktop=connect();
  await desktop.update({action:'login',email:bought.user.email,password:'only-a-generated-test-password'});
  let first;
  await t.test('concurrent signed mapi checkout reuses a server-priced order and shields its owner',async () => {
    assert.equal((await fetchApi('/api/orders',{body:{plan:'weekly_6'}})).status,401);
    assert.equal((await request('/api/orders',{plan:'unsupported'})).status,400);
    const [one,two]=await Promise.all([
      request('/api/orders',{plan:'weekly_6',amountCents:1,budgetMicroCny:1,durationDays:1000}),
      desktop.update({action:'order-create'}),
    ]);
    assert.equal(one.status,200);
    first=one.data;
    assert.equal(first.orderId,two.order.orderId);
    assert.equal(checkoutCount,1);
    assert.equal(first.amountYuan,'6.00');
    assert.equal(first.qrCode,'https://qr.alipay.com/fixture');
    assert.equal(first.payUrl,null);
    const stored=merchantOrders.get(first.orderId);
    assert.equal(stored.notify_url,origin+'/api/payments/epay/notify');
    assert.equal(stored.return_url,origin+'/payment/return');
    assert.equal(Date.parse(first.expiresAt)-Date.parse(svc.db.prepare('SELECT created_at FROM payment_order WHERE id=?').get(first.orderId).created_at),15*60000);
    assert.equal((await request('/api/orders/'+first.orderId,undefined,other.token)).status,404);
    assert.equal(queryCount,0);
    assert.equal(statSync(join(directory,'desktop','membership','account.json')).mode & 0o777,0o600);
  });
  await t.test('switching to the Ouyun cashier keeps an existing QR order and signs the redirect',async () => {
    const config=readEpayConfig({...process.env,EPAY_MODE:'submit'},{baseUrl:base,pathPrefix:prefix});
    const handlers=createPaymentHandlers(svc.db,config,{
      json:(_,status,data)=>({status,data}),read:async()=>({plan:'weekly_6'}),
    });
    const resumed=await handlers.privateRoute({method:'POST'},{setHeader(){}},'/api/orders',bought.user.id);
    assert.equal(resumed.status,200);
    assert.equal(resumed.data.orderId,first.orderId);
    const url=new URL(resumed.data.payUrl);
    assert.equal(url.pathname,'/gateway/submit.php');
    assert.equal(url.searchParams.get('out_trade_no'),first.orderId);
    assert.equal(url.searchParams.get('money'),'6.00');
    assert.ok(url.searchParams.get('sign')===signAsGateway(Object.fromEntries(url.searchParams)));
    assert.equal(resumed.data.qrCode,null);
    assert.equal(checkoutCount,1);
  });
  await t.test('four notify checks, inert return, valid GET/POST notify and replay protection',async () => {
    assert.ok(first);
    const valid=callback(first.orderId,'mock-trade-first');
    assert.deepEqual(await notify({...valid,sign:'0'.repeat(32)}),[400,'fail']);
    assert.deepEqual(await notify(callback(first.orderId,'mock-trade-first',{pid:'9'}),'POST'),[400,'fail']);
    assert.deepEqual(await notify(callback(first.orderId,'mock-trade-first',{trade_status:'WAIT_BUYER_PAY'})),[400,'fail']);
    assert.deepEqual(await notify(callback(first.orderId,'mock-trade-first',{money:'0.01'}),'POST'),[400,'fail']);
    assert.deepEqual(await notify(callback(first.orderId,'mock-trade-first',{money:'6.001'})),[400,'fail']);
    assert.deepEqual(await notify(callback('00000000-0000-4000-8000-000000000000','mock-trade-first')),[400,'fail']);
    const forgedReturn=await fetchApi('/payment/return?'+new URLSearchParams(valid));
    assert.equal(forgedReturn.status,200);
    assert.match(await forgedReturn.text(),/支付结果处理中/);
    assert.equal(cards().length,0);
    assert.deepEqual(await notify(valid),[200,'success']);
    assert.deepEqual(await Promise.all([notify(valid,'POST'),notify(valid),notify(valid,'POST')]),
      [[200,'success'],[200,'success'],[200,'success']]);
    assert.equal(cards().length,1);
    const [card]=cards();
    assert.equal(card.order_id,first.orderId);
    assert.equal(card.budget_micro_cny,51000);
    assert.equal(Date.parse(card.expires_at)-Date.parse(card.starts_at),7*86400000);
    assert.equal((await request('/api/orders',{plan:'weekly_6'})).status,409);
    const checked=await connect().update({action:'order-check'});
    assert.equal(checked.order.status,'fulfilled');
    assert.equal(checked.account.passStatus,'active');
    assert.equal(checked.account.remainingPercent,100);
  });
  await t.test('exhausted production repurchases via desktop, then renews authorization on continue',async () => {
    const project=desktop.project(join(clientRoot,'film'));
    const old=await project.lease();
    const proxy=(lease,body)=>fetch(lease.baseUrl+'/responses',{
      method:'POST',headers:{authorization:'Bearer '+lease.token,'content-type':'application/json'},body:JSON.stringify(body),
    });
    assert.equal((await proxy(old,{use_balance:true})).status,200);
    const cutoff=await proxy(old,{});
    assert.equal(cutoff.status,402);
    assert.equal((await cutoff.json()).error,'quota_circuit_broken');
    assert.equal(textCount,1);
    assert.equal((await desktop.view()).account.canPurchase,true);
    const second=(await desktop.update({action:'order-create'})).order;
    assert.notEqual(second.orderId,first.orderId);
    assert.equal(second.payUrl,gatewayBase+'/checkout');
    assert.deepEqual(await notify(callback(second.orderId,'mock-trade-first')),[400,'fail']);
    assert.equal(cards().length,1);
    assert.deepEqual(await notify(callback(second.orderId,'mock-trade-second'),'POST'),[200,'success']);
    const restarted=connect();
    assert.equal((await restarted.update({action:'order-check'})).account.remainingPercent,100);
    assert.equal((await proxy(old,{})).status,402);
    const workspace=join(clientRoot,'film');
    const kit=join(directory,'fixture-kit');
    const jobId='de0caa3e-9518-45b3-92c2-2a5a5fdb319d';
    const job=join(workspace,'production',jobId);
    const scripts=join(kit,'WORK/modules/video');
    for (const dir of [join(job,'scenes'),join(job,'film'),scripts]) mkdirSync(dir,{recursive:true});
    writeFileSync(join(job,'scenes/production.json'),'{}');
    writeFileSync(join(job,'production.json'),JSON.stringify({version:'v1',sections:[{id:'S01',narration:'旁白'}]}));
    writeFileSync(join(workspace,'production/status.json'),JSON.stringify({
      id:jobId,mode:'structured',version:'v1',status:'failed',membershipAuthorizationId:old.id,error:'quota_circuit_broken',
    }));
    writeFileSync(join(scripts,'pipeline.mjs'),`
      import {writeFile} from 'node:fs/promises';
      const responses=process.env.VIDEO_TTS_ENDPOINT.replace(/audio\\/speech$/, 'responses');
      const res=await fetch(responses,{method:'POST',headers:{
        authorization:'Bearer '+process.env.VIDEO_TTS_KEY,'content-type':'application/json',
      },body:'{}'});
      if (!res.ok) throw Error('Mock relay rejected continuation '+res.status);
      await res.json();
      const out=process.argv[process.argv.indexOf('--out')+1];
      await writeFile(out+'/mapping.json','{}');
      await writeFile(out+'/final.mp4','fixture');
    `);
    writeFileSync(join(scripts,'verify.mjs'),`
      import {writeFile} from 'node:fs/promises';
      await writeFile(new URL('./verify-report.json','file://'+process.argv[2]), '{"hardErrors":[]}');
    `);
    const app=createProduction(workspace,{desktop:true,videoKitDir:kit,memberProject:restarted.project(workspace),
      settings:{forCall:async auth=>({
        model:{baseUrl:auth.baseUrl,model:'fixture'},
        tts:{baseUrl:auth.baseUrl,model:'fixture',voice:'fixture',apiKey:auth.token},
      })},
    });
    const resumed=await app.start({jobId});
    assert.equal(resumed.id,jobId);
    assert.notEqual(resumed.membershipAuthorizationId,old.id);
    for (let i=0; app.isActive() && i<100; i++) await delay(20);
    const final=await app.status();
    assert.equal(final.status,'completed',final.error);
    assert.ok(!final.membershipPending);
    assert.deepEqual(cards().map(card=>card.used_micro_cny),[51000,1]);
  });
  await t.test('owner-only active query is throttled and fulfills only matching gateway data',async () => {
    const created=await request('/api/orders',{plan:'weekly_6'},other.token);
    const id=created.data.orderId;
    const route='/api/orders/'+id;
    assert.equal(created.status,200);
    assert.equal((await request(route)).status,404);
    const baseline=queryCount;
    queryResponses.set(id,{status:1,trade_no:'mock-query',money:'0.01'});
    const batch=await Promise.all([request(route,undefined,other.token),request(route,undefined,other.token)]);
    assert.ok(batch.every(result=>result.data.status==='pending'));
    assert.equal(queryCount,baseline+1);
    svc.db.prepare('UPDATE payment_order SET last_polled_at=? WHERE id=?').run(new Date(Date.now()-5001).toISOString(),id);
    queryResponses.set(id,{status:1,trade_no:'mock-query',out_trade_no:first.orderId});
    assert.equal((await request(route,undefined,other.token)).data.status,'pending');
    svc.db.prepare('UPDATE payment_order SET last_polled_at=? WHERE id=?').run(new Date(Date.now()-5001).toISOString(),id);
    queryResponses.set(id,{status:1,trade_no:'mock-query'});
    const confirmed=await request(route,undefined,other.token);
    assert.equal(confirmed.data.status,'fulfilled');
    assert.equal(confirmed.data.passStatus,'active');
    assert.equal((await request(route,undefined,other.token)).data.status,'fulfilled');
    assert.equal(queryCount,baseline+3);
    assert.equal(svc.db.prepare('SELECT COUNT(*) AS n FROM monthly_pass WHERE user_id=?').get(other.user.id).n,1);
    assert.ok(diagnostics.mock.calls.every(call=>!call.arguments.join(' ').includes(env.EPAY_KEY) && !call.arguments.join(' ').includes(env.EPAY_PID)));
  });
  await t.test('explicit submit mode builds a signed redirect without submitting any payment',async () => {
    process.env.EPAY_MODE='submit';
    try {
      const {createEpayPayment,readEpayConfig}=await import('./epay.mjs');
      const result=await createEpayPayment(readEpayConfig(process.env,{baseUrl:base,pathPrefix:prefix}),{
        outTradeNo:'local-submit-test',name:'讲界 6 元周卡（7 天）',money:'6.00',clientIp:'127.0.0.1',
      });
      const url=new URL(result.payUrl);
      const data=Object.fromEntries(url.searchParams);
      assert.equal(url.pathname,'/gateway/submit.php');
      assert.equal(result.qrCode,null);
      assert.ok(data.sign===signAsGateway(data));
      assert.ok(!url.searchParams.has('clientip'));
      assert.ok(!url.href.includes(env.EPAY_KEY));
    } finally {
      process.env.EPAY_MODE='mapi';
    }
  });
});
