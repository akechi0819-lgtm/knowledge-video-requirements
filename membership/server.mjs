import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { setResponse } from 'better-call/node';
import { currentPass, initializeMonthly, passStatus, transaction } from './monthly.mjs';
import { calculateCostMicroCny, estimateUsage, extractUsage, readPricingConfig } from './billing.mjs';
import { readEpayConfig } from './epay.mjs';
import { initializePaymentOrders } from './payment-orders.mjs';
import { createPaymentHandlers } from './payment-http.mjs';

const circuitError = {
  error:'quota_circuit_broken',
  message:'本周卡额度已达到上限并已暂停制作，重新购买周卡后可继续制作。',
};

function sseUsage(pricing) {
  const decoder = new StringDecoder('utf8');
  let pending = '', data = [], usage = null;
  function event() {
    if (data.length) {
      let payload;
      try { payload = JSON.parse(data.join('\n')); } catch { /* SSE sentinels are not JSON. */ }
      if (payload) usage = extractUsage(payload, pricing) ?? usage;
      data = [];
    }
  }
  function line(value) {
    if (!value) event();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  return {
    push(chunk) {
      const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
      pending = lines.pop();
      for (const value of lines) line(value);
    },
    finish() {
      line(pending + decoder.end());
      event();
      return usage;
    },
  };
}

export async function createMembershipService(config) {
  const pricing = readPricingConfig();
  const prefix = config.pathPrefix || '';
  if (prefix && !/^\/(?:[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error('Invalid membership path prefix');
  const paymentConfig = readEpayConfig(process.env,{baseUrl:config.baseURL,pathPrefix:prefix});
  // An HTTP listener behind a reverse proxy can also have a loopback peer.
  const allowUnlimited = config.localTestUnlimited === true
    && new URL(config.baseURL).protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseURL).hostname)
    && !config.pathPrefix;
  const db = new DatabaseSync(config.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, gifts INTEGER NOT NULL DEFAULT 3);
    CREATE TABLE IF NOT EXISTS unlimited_production (user_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS production (user_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, funding TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_production ON production(user_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, production_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER, created_at TEXT NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS invite_code (hash TEXT PRIMARY KEY, reservation TEXT, reserved_email TEXT, used_at TEXT)');
  if (!db.prepare('PRAGMA table_info(invite_code)').all().some(column => column.name === 'reserved_email')) db.exec('ALTER TABLE invite_code ADD COLUMN reserved_email TEXT');
  initializeMonthly(db);
  initializePaymentOrders(db);
  const auth = betterAuth({ database: db, baseURL: config.baseURL, basePath: prefix + '/api/auth', secret: config.secret, emailAndPassword: { enabled: true }, disabledPaths: ['/sign-up/email'], plugins: [bearer()] });
  await (await getMigrations(auth.options)).runMigrations();
  db.exec(`UPDATE invite_code SET used_at=datetime('now'),reservation=NULL,reserved_email=NULL
    WHERE used_at IS NULL AND reservation IS NOT NULL
    AND EXISTS (SELECT 1 FROM user WHERE lower(user.email)=invite_code.reserved_email);
    UPDATE invite_code SET reservation=NULL,reserved_email=NULL WHERE used_at IS NULL;`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invite_pending_email ON invite_code(reserved_email) WHERE reservation IS NOT NULL');
  const ensure = id => db.prepare('INSERT OR IGNORE INTO member(user_id) VALUES (?)').run(id);
  const member = id => db.prepare('SELECT * FROM member WHERE user_id=?').get(id);
  const production = (id, pid) => db.prepare('SELECT * FROM production WHERE user_id=? AND id=?').get(id,pid);
  const isUnlimited = id => allowUnlimited && Boolean(db.prepare('SELECT 1 FROM unlimited_production WHERE user_id=?').get(id));
  const passFor = p => p.pass_id && ['weekly', 'monthly'].includes(p.funding)
    ? db.prepare('SELECT * FROM monthly_pass WHERE id=? AND user_id=?').get(p.pass_id,p.user_id)
    : null;
  const cardFunded = p => Boolean(p.pass_id && ['weekly', 'monthly'].includes(p.funding));
  const passBlocked = p => cardFunded(p) && passStatus(passFor(p)) !== 'active';
  const validId = pid => typeof pid === 'string' && pid.length > 0 && pid.length <= 128;
  const quotaExhausted = {error:'quota_exhausted',message:'制作额度已用完，请购买 6 元周卡。',status:403};

  function begin(id, pid, replaces) {
    return transaction(db, () => {
      ensure(id);
      const prev = production(id,pid);
      if (prev) {
        if (prev.status !== 'active') return {error:'production_finished',message:'此制作已结束，请新建制作。',status:409};
        if (passBlocked(prev)) return {...circuitError,status:402};
        return {productionId:pid,status:'active'};
      }
      const active = db.prepare("SELECT * FROM production WHERE user_id=? AND status='active'").get(id);
      const pass = currentPass(db,id);
      if (replaces) {
        if (!active || active.id !== replaces || !passBlocked(active)) {
          return {error:'invalid_production_replacement',message:'原制作没有可更换的周卡授权。',status:409};
        }
        if (passStatus(pass) !== 'active') return {...circuitError,status:402};
      } else if (active) {
        return {error:'active_production',message:'已有进行中的制作。',status:409};
      }

      let funding, passId = null;
      if (!replaces && isUnlimited(id)) funding='unlimited';
      else if (!replaces && member(id).gifts > 0) {
        funding='gift';
        db.prepare('UPDATE member SET gifts=gifts-1 WHERE user_id=?').run(id);
      } else if (passStatus(pass)==='active') {
        funding='weekly'; passId=pass.id;
      } else return quotaExhausted;

      if (replaces) db.prepare("UPDATE production SET status='abandoned' WHERE user_id=? AND id=?").run(id,replaces);
      db.prepare("INSERT INTO production(user_id,id,status,funding,pass_id) VALUES (?,?,'active',?,?)").run(id,pid,funding,passId);
      return {productionId:pid,status:'active'};
    });
  }

  function record(p, kind, amount, usage) {
    if (!Number.isSafeInteger(amount) || amount < 0) amount = null;
    const cost = kind === 'text' ? calculateCostMicroCny(usage, pricing) : 0;
    const now = new Date().toISOString();
    transaction(db, () => {
      db.prepare(`INSERT INTO usage
        (id,user_id,production_id,kind,amount,created_at,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_micro_cny,estimated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),p.user_id,p.id,kind,amount,now,usage?.inputTokens ?? null,usage?.cacheReadTokens ?? null,usage?.cacheWriteTokens ?? null,usage?.outputTokens ?? null,cost,Number(Boolean(usage?.estimated)));
      if (kind === 'text' && cardFunded(p)) db.prepare(`UPDATE monthly_pass SET used_micro_cny=used_micro_cny+?,
        circuit_broken_at=CASE WHEN used_micro_cny+? >= budget_micro_cny THEN COALESCE(circuit_broken_at,?) ELSE circuit_broken_at END
        WHERE id=? AND user_id=?`).run(cost,cost,now,p.pass_id,p.user_id);
    });
  }
  const passRequests = new Map();
  async function withPassRequest(p, action) {
    if (!cardFunded(p)) return action();
    // A pass admits one request at a time so queued calls see the settled balance.
    const previous = passRequests.get(p.pass_id);
    const {promise, resolve} = Promise.withResolvers();
    passRequests.set(p.pass_id, promise);
    try {
      await previous;
      return await action();
    } finally {
      resolve();
      if (passRequests.get(p.pass_id) === promise) passRequests.delete(p.pass_id);
    }
  }
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const read=async req=>{ const chunks=[]; let size=0; for await(const chunk of req) { size+=chunk.length; if(size>32*1024*1024) { const e=new Error('request too large'); e.status=413; throw e; } chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const authHandler=toNodeHandler(auth);
  const payment=createPaymentHandlers(db,paymentConfig,{json,read});
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,config.baseURL);
      const pathname=decodeURIComponent(url.pathname);
      if (prefix && !pathname.startsWith(prefix + '/')) return json(res,404,{error:'not_found',message:'接口不存在。'});
      let path=pathname.slice(prefix.length).replace(/\/+$/, '') || '/';
      const publicPayment=payment.publicRoute(req,res,url,path);
      if (publicPayment) return await publicPayment;
      const match=path.match(/^\/api\/proxy\/([^/]+)\/(chat\/completions|audio\/speech|responses)$/);
      const pathProductionId=match ? decodeURIComponent(match[1]) : null;
      if(match) path=`/api/proxy/${match[2]}`;
      if(path.startsWith('/api/auth/')) {
        if(path !== '/api/auth/sign-up/email' || req.method !== 'POST') return authHandler(req,res);
        if(req.headers.origin !== new URL(config.baseURL).origin) return json(res,403,{error:'invalid_origin',message:'请求来源无效。'});
        const code=req.headers['x-invite-code'];
        if(typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) return json(res,403,{error:'invite_invalid',message:'请输入有效的邀请码。'});
        const body=await read(req);
        const email=typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email) return json(res,400,{error:'invalid_email',message:'请输入邮箱。'});
        if (db.prepare('SELECT id FROM user WHERE lower(email)=?').get(email)) return json(res,422,{error:'account_exists',message:'该邮箱已注册，请登录。'});
        const hash=createHash('sha256').update(code).digest('hex'), reservation=randomUUID();
        try {
          if(!db.prepare('UPDATE invite_code SET reservation=?,reserved_email=? WHERE hash=? AND reservation IS NULL AND used_at IS NULL').run(reservation,email,hash).changes) return json(res,403,{error:'invite_invalid',message:'邀请码无效或已使用。'});
        } catch(error) {
          if(error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) return json(res,409,{error:'signup_pending',message:'该邮箱正在注册，请稍后重试。'});
          throw error;
        }
        function reconcile() {
          if (db.prepare('SELECT id FROM user WHERE lower(email)=?').get(email)) {
            db.prepare('UPDATE invite_code SET used_at=?,reservation=NULL,reserved_email=NULL WHERE hash=? AND reservation=? AND used_at IS NULL').run(new Date().toISOString(),hash,reservation);
          } else {
            db.prepare('UPDATE invite_code SET reservation=NULL,reserved_email=NULL WHERE hash=? AND reservation=? AND used_at IS NULL').run(hash,reservation);
          }
        }
        try {
          const response=await auth.api.signUpEmail({body:{...body,email},headers:fromNodeHeaders(req.headers),asResponse:true});
          reconcile();
          await setResponse(res,response);
        } finally {
          reconcile();
        }
        return;
      }
      const session=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
      if(!session) return json(res,401,{error:'unauthorized',message:'请先登录。'});
      const id=session.user.id; ensure(id);
      if(req.method==='GET' && path==='/api/member') {
        const m=member(id), active=db.prepare("SELECT id FROM production WHERE user_id=? AND status='active'").get(id);
        const pass = currentPass(db,id), status = passStatus(pass);
        return json(res,200,{
          giftRemaining:m.gifts, plan:'weekly_6', passStatus:status,
          remainingPercent:status==='active'?Math.floor((pass.budget_micro_cny-pass.used_micro_cny)*100/pass.budget_micro_cny):0,
          expiresAt:pass?.expires_at ?? null, canPurchase:status!=='active',
          purchaseAvailable:payment.available, activeProductionId:active?.id ?? null,
          monthlyExpiresAt:pass?.expires_at ?? null, monthlyStatus:status,
        });
      }
      const privatePayment=payment.privateRoute(req,res,path,id);
      if (privatePayment) return await privatePayment;
      if(req.method==='POST' && (path==='/api/productions/start'||path==='/api/productions/finish'||path==='/api/productions/abandon')) {
        const {productionId:pid,replacesProductionId:replaces}=await read(req);
        if(!validId(pid) || (replaces !== undefined && (!validId(replaces) || pid === replaces || !path.endsWith('/start')))) {
          return json(res,400,{error:'invalid_production',message:'制作标识无效。'});
        }
        if(path.endsWith('/start')) { const result=begin(id,pid,replaces); return json(res,result.status==='active'?200:result.status,result); }
        const abandoning=path.endsWith('/abandon');
        const status=abandoning ? 'abandoned' : 'finished';
        // A start request can reach us after a client times out and abandons its saved ID.
        if(abandoning) db.prepare("INSERT OR IGNORE INTO production(user_id,id,status,funding) VALUES (?,?,'abandoned','none')").run(id,pid);
        db.prepare("UPDATE production SET status=? WHERE user_id=? AND id=? AND status='active'").run(status,id,pid);
        const p=production(id,pid);
        if(!p) return json(res,404,{error:'production_not_found',message:'制作不存在。'});
        return json(res,200,{productionId:pid,status:p.status});
      }
      const routes={'/api/proxy/chat/completions':['chat','chat/completions'],'/api/proxy/responses':['chat','responses'],'/api/proxy/audio/speech':['tts','audio/speech']};
      if(req.method==='POST' && routes[path]) {
        const pid=pathProductionId || req.headers['x-production-id'];
        const p=validId(pid) && production(id,pid);
        const inactive=()=>json(res,403,{error:'production_not_active',message:'制作授权不存在或已结束。'});
        const blocked=()=>json(res,402,circuitError);
        if (p?.status !== 'active' || (p.funding==='unlimited' && !allowUnlimited)) return inactive();
        if (passBlocked(p)) return blocked();
        const [kind,suffix]=routes[path], provider=config[kind];
        if(!provider?.baseURL || !provider.key || !provider.model || (kind==='tts'&&!provider.voice)) return json(res,503,{error:'provider_unconfigured',message:'平台供应商尚未配置。'});
        let body=await read(req); body.model=provider.model;
        if(suffix==='responses' && body.tools && (!Array.isArray(body.tools) || body.tools.some(tool=>tool.type!=='function'))) return json(res,400,{error:'unsupported_tool',message:'仅支持本地函数工具。'});
        if(kind==='tts') body.voice=provider.voice;
        if(kind==='chat' && body.stream && suffix==='chat/completions') body.stream_options={...body.stream_options,include_usage:true};
        const mimo=kind==='tts' && provider.protocol==='mimo';
        const inputChars=typeof body.input==='string'?body.input.length:null;
        if(mimo) body={model:provider.model,messages:[{role:'assistant',content:body.input}],audio:{voice:provider.voice,format:'mp3'},stream:false};
        const requestBody=JSON.stringify(body);
        const controller=new AbortController();
        const abortUpstream=()=>{ if (!res.writableFinished) controller.abort(); };
        res.on('close',abortUpstream);
        try { await withPassRequest(p, async () => {
          if (res.destroyed) return;
          if (production(id,pid)?.status !== 'active') return inactive();
          if (passBlocked(p)) return blocked();
          const upstream=await fetch(`${provider.baseURL.replace(/\/$/,'')}/${mimo?'chat/completions':suffix}`,{
            method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${provider.key}`},body:requestBody,signal:controller.signal,
          });
          const contentType=upstream.headers.get('content-type') || 'application/octet-stream';
          const headers={'content-type':contentType};
          if (!upstream.ok) {
            res.writeHead(upstream.status,headers);
            if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
            return res.end();
          }
          if (kind==='tts') {
            if (mimo) {
              const raw=await upstream.text();
              let value;
              try { value=JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
              const encoded=value?.choices?.[0]?.message?.audio?.data;
              if(typeof encoded!=='string' || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
                return json(res,502,{error:'invalid_tts_response',message:'配音供应商未返回有效音频。'});
              }
              const audio=Buffer.from(encoded,'base64');
              record(p,'tts',inputChars,null);
              res.writeHead(200,{'content-type':'audio/mpeg'});
              return res.end(audio);
            }
            res.writeHead(upstream.status,headers);
            if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
            record(p,'tts',inputChars,null);
            return res.end();
          }
          const sse=contentType.includes('text/event-stream') ? sseUsage(pricing) : null;
          const streamed=Boolean(sse);
          let usage, responseBytes=0;
          const chunks=[];
          if (streamed) res.writeHead(upstream.status,headers);
          try {
            if (upstream.body) for await (const chunk of upstream.body) {
              const bytes=Buffer.from(chunk);
              responseBytes+=bytes.length;
              sse?.push(bytes);
              if (streamed) res.write(bytes);
              else chunks.push(bytes);
            }
            if (!streamed && /(?:^|[+/])json(?:;|$)/i.test(contentType)) {
              let value;
              try { value=JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Meter malformed successful responses by bytes. */ }
              usage=extractUsage(value,pricing);
            }
          } finally {
            usage ??= sse?.finish() ?? estimateUsage(Buffer.byteLength(requestBody),responseBytes);
            record(p,'text',usage.totalTokens,usage);
          }
          if (!streamed) res.writeHead(upstream.status,headers);
          return res.end(streamed?undefined:Buffer.concat(chunks));
        }); } finally { res.off('close',abortUpstream); }
        return;
      }
      return json(res,404,{error:'not_found',message:'接口不存在。'});
    } catch(e) { if(!res.headersSent) json(res,e.status===413?413:500,{error:e.status===413?'request_too_large':'internal_error',message:e.status===413?'请求超过 32 MB。':'服务请求失败。'}); else res.destroy(); }
  });
  return {server,db,auth};
}

if(import.meta.main) {
  const port=Number(process.env.PORT || 8787);
  const host=process.env.MEMBER_HOST || '127.0.0.1';
  const config={localTestUnlimited:process.env.MEMBER_LOCAL_TEST_UNLIMITED==='true' && ['localhost','127.0.0.1','::1'].includes(host),database:process.env.MEMBER_DATABASE || './membership.sqlite',baseURL:process.env.BETTER_AUTH_URL || `http://localhost:${port}`,pathPrefix:process.env.MEMBER_PATH_PREFIX || '',secret:process.env.BETTER_AUTH_SECRET,chat:{baseURL:process.env.MEMBER_CHAT_BASE_URL,key:process.env.MEMBER_CHAT_API_KEY,model:process.env.MEMBER_CHAT_MODEL},tts:{baseURL:process.env.MEMBER_TTS_BASE_URL,key:process.env.MEMBER_TTS_API_KEY,model:process.env.MEMBER_TTS_MODEL,voice:process.env.MEMBER_TTS_VOICE,protocol:process.env.MEMBER_TTS_PROTOCOL || 'speech'}};
  if(!['speech','mimo'].includes(config.tts.protocol)) throw new Error('MEMBER_TTS_PROTOCOL must be speech or mimo');
  if(!config.secret || config.secret.length<32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const {server}=await createMembershipService(config);
  server.listen(port,host,()=>console.log(`Membership service listening on ${port}`));
}
