import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { setResponse } from 'better-call/node';
import { currentPass, initializeMonthly, passStatus } from './monthly.mjs';

export async function createMembershipService(config) {
  const db = new DatabaseSync(config.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, gifts INTEGER NOT NULL DEFAULT 3);
    CREATE TABLE IF NOT EXISTS production (user_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, funding TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_production ON production(user_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, production_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER, created_at TEXT NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS invite_code (hash TEXT PRIMARY KEY, reservation TEXT, reserved_email TEXT, used_at TEXT)');
  if (!db.prepare('PRAGMA table_info(invite_code)').all().some(column => column.name === 'reserved_email')) db.exec('ALTER TABLE invite_code ADD COLUMN reserved_email TEXT');
  initializeMonthly(db);
  const prefix = config.pathPrefix || '';
  if (prefix && !/^\/(?:[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error('Invalid membership path prefix');
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
  function begin(id, pid) {
    db.exec('BEGIN IMMEDIATE');
    try {
      ensure(id);
      const prev = production(id,pid);
      if (prev) { db.exec('COMMIT'); return prev.status === 'active' ? {productionId:pid,status:'active'} : {error:'production_finished',message:'此制作已结束，请新建制作。',status:409}; }
      if (db.prepare("SELECT id FROM production WHERE user_id=? AND status='active'").get(id)) { db.exec('COMMIT'); return {error:'active_production',message:'已有进行中的制作。',status:409}; }
      const m = member(id);
      let funding, passId = null;
      const pass = currentPass(db,id);
      if (m.gifts > 0) { funding='gift'; db.prepare('UPDATE member SET gifts=gifts-1 WHERE user_id=?').run(id); }
      else if (passStatus(pass)==='active' && pass.tokens > 0) { funding='monthly'; passId=pass.id; }
      else { db.exec('COMMIT'); return {error:'quota_exhausted',message:'赠片及月卡额度已用完，请购买月卡。',status:403}; }
      db.prepare("INSERT INTO production(user_id,id,status,funding,pass_id) VALUES (?,?,'active',?,?)").run(id,pid,funding,passId);
      db.exec('COMMIT'); return {productionId:pid,status:'active'};
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function record(id,pid,kind,amount) {
    if (!Number.isSafeInteger(amount) || amount < 0) amount = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run(randomUUID(),id,pid,kind,amount,new Date().toISOString());
      const passId = production(id,pid)?.pass_id;
      if (kind==='text' && amount !== null && passId) db.prepare('UPDATE monthly_pass SET tokens=MAX(0,tokens-?) WHERE id=? AND user_id=?').run(amount,passId,id);
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const read=async req=>{ const chunks=[]; let size=0; for await(const chunk of req) { size+=chunk.length; if(size>32*1024*1024) { const e=new Error('request too large'); e.status=413; throw e; } chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const authHandler=toNodeHandler(auth);
  const server=createServer(async(req,res)=>{
    try {
      const pathname=decodeURIComponent(new URL(req.url,config.baseURL).pathname);
      if (prefix && !pathname.startsWith(prefix + '/')) return json(res,404,{error:'not_found',message:'接口不存在。'});
      let path=pathname.slice(prefix.length).replace(/\/+$/, '') || '/';
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
        return json(res,200,{giftRemaining:m.gifts,monthlyTokens:status==='active'?pass.tokens:0,monthlyExpiresAt:pass?.expires_at ?? null,monthlyStatus:status,purchaseAvailable:false,activeProductionId:active?.id ?? null});
      }
      if(req.method==='POST' && path==='/api/orders') return json(res,503,{error:'payment_unconfigured',message:'收款渠道尚未开通，暂不能购买月卡。'});
      if(req.method==='POST' && (path==='/api/productions/start'||path==='/api/productions/finish'||path==='/api/productions/abandon')) {
        const {productionId:pid}=await read(req);
        if(typeof pid!=='string'||!pid||pid.length>128) return json(res,400,{error:'invalid_production',message:'制作标识无效。'});
        if(path.endsWith('/start')) { const result=begin(id,pid); return json(res,result.status==='active'?200:result.status,result); }
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
        if(typeof pid!=='string'||production(id,pid)?.status!=='active') return json(res,403,{error:'production_not_active',message:'制作授权不存在或已结束。'});
        const [kind,suffix]=routes[path], provider=config[kind];
        if(!provider?.baseURL || !provider.key || !provider.model || (kind==='tts'&&!provider.voice)) return json(res,503,{error:'provider_unconfigured',message:'平台供应商尚未配置。'});
        let body=await read(req); body.model=provider.model;
        if(suffix==='responses' && body.tools && (!Array.isArray(body.tools) || body.tools.some(tool=>tool.type!=='function'))) return json(res,400,{error:'unsupported_tool',message:'仅支持本地函数工具。'});
        if(kind==='tts') body.voice=provider.voice;
        if(kind==='chat' && body.stream && suffix==='chat/completions') body.stream_options={...body.stream_options,include_usage:true};
        const mimo=kind==='tts' && provider.protocol==='mimo';
        const textInput=body.input;
        if(mimo) body={model:provider.model,messages:[{role:'assistant',content:textInput}],audio:{voice:provider.voice,format:'mp3'},stream:false};
        const upstream=await fetch(`${provider.baseURL.replace(/\/$/,'')}/${mimo?'chat/completions':suffix}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${provider.key}`},body:JSON.stringify(body)});
        if(mimo && upstream.ok) {
          const value=await upstream.json(); const encoded=value.choices?.[0]?.message?.audio?.data;
          if(typeof encoded!=='string' || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return json(res,502,{error:'invalid_tts_response',message:'配音供应商未返回有效音频。'});
          const bytes=Buffer.from(encoded,'base64'); record(id,pid,'tts',typeof textInput==='string'?textInput.length:null);
          res.writeHead(200,{'content-type':'audio/mpeg'}); return res.end(bytes);
        }
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') || 'application/octet-stream'});
        if(!upstream.body) return res.end();
        if(!upstream.ok) { Readable.fromWeb(upstream.body).pipe(res); return; }
        if(kind==='tts') { record(id,pid,'tts',typeof body.input==='string'?body.input.length:null); Readable.fromWeb(upstream.body).pipe(res); return; }
        if(!body.stream) {
          const bytes=Buffer.from(await upstream.arrayBuffer());
          const value=JSON.parse(bytes.toString()); const usage=value.usage;
          record(id,pid,'text',usage?.total_tokens ?? ((usage?.input_tokens != null && usage?.output_tokens != null)?usage.input_tokens+usage.output_tokens:null));
          return res.end(bytes);
        }
        let pending='', recorded=false;
        for await(const chunk of upstream.body) {
          const bytes=Buffer.from(chunk); res.write(bytes); pending+=bytes.toString();
          const lines=pending.split('\n'); pending=lines.pop();
          for(const line of lines) if(line.startsWith('data: ')) {
            let event; try { event=JSON.parse(line.slice(6)); } catch { continue; }
            const usage=event.usage ?? event.response?.usage;
            if(usage && !recorded) { const total=usage.total_tokens ?? ((usage.input_tokens != null && usage.output_tokens != null)?usage.input_tokens+usage.output_tokens:null); record(id,pid,'text',total); recorded=true; }
          }
        }
        if(!recorded) record(id,pid,'text',null);
        return res.end();
      }
      return json(res,404,{error:'not_found',message:'接口不存在。'});
    } catch(e) { if(!res.headersSent) json(res,e.status===413?413:500,{error:e.status===413?'request_too_large':'internal_error',message:e.status===413?'请求超过 32 MB。':'服务请求失败。'}); else res.destroy(); }
  });
  return {server,db,auth};
}

if(import.meta.main) {
  const port=Number(process.env.PORT || 8787);
  const config={database:process.env.MEMBER_DATABASE || './membership.sqlite',baseURL:process.env.BETTER_AUTH_URL || `http://localhost:${port}`,pathPrefix:process.env.MEMBER_PATH_PREFIX || '',secret:process.env.BETTER_AUTH_SECRET,chat:{baseURL:process.env.MEMBER_CHAT_BASE_URL,key:process.env.MEMBER_CHAT_API_KEY,model:process.env.MEMBER_CHAT_MODEL},tts:{baseURL:process.env.MEMBER_TTS_BASE_URL,key:process.env.MEMBER_TTS_API_KEY,model:process.env.MEMBER_TTS_MODEL,voice:process.env.MEMBER_TTS_VOICE,protocol:process.env.MEMBER_TTS_PROTOCOL || 'speech'}};
  if(!['speech','mimo'].includes(config.tts.protocol)) throw new Error('MEMBER_TTS_PROTOCOL must be speech or mimo');
  if(!config.secret || config.secret.length<32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const {server}=await createMembershipService(config);
  server.listen(port,process.env.MEMBER_HOST || '127.0.0.1',()=>console.log(`Membership service listening on ${port}`));
}
