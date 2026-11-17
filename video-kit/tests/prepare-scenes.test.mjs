import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { defaultProcessGuidance } from '../../dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/process-guidance.js';

const script = resolve(fileURLToPath(new URL('../scripts/prepare-scenes.mjs', import.meta.url)));
const scene = {
  background: '#112233',
  layers: [{ type: 'text', x: 100, y: 100, width: 300, height: 40,
    fill: '#ffffff', text: '</script><script>evil()</script>', start: 0, end: 1,
    motion: {toX: 760, toY: 220, onclick: 'bad()'}, onclick: 'evil()', href: 'https://example.invalid' }],
  script: 'evil()',
};

async function runCase(production, modelScene = scene, imageBytes = null, assetFiles = {}, model = 'test', reuse = false, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-scenes-test-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'out');
  if (reuse) { await mkdir(join(dir, 'reuse')); await writeFile(join(dir, 'reuse/S01.html'), 'reused html'); await writeFile(join(dir, 'reuse/S01.scene.json'), '{}'); }
  await writeFile(input, JSON.stringify(production));
  if (imageBytes) { await mkdir(join(dir, 'images')); await writeFile(join(dir, 'images/S01.png'), imageBytes); }
  if (Object.keys(assetFiles).length) { await mkdir(join(dir, 'assets')); for (const [name, contents] of Object.entries(assetFiles)) await writeFile(join(dir, 'assets', name), contents); }
  const requests = [], paths = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (options.handler) return options.handler(req, res, requests.length);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelScene) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [script, '--input', input, '--output', output,
    '--endpoint', `http://127.0.0.1:${server.address().port}${options.endpointPath ?? '/v1/chat/completions'}`,
    '--model', model], { env: { ...process.env, SCENE_API_KEY: 'test', VIDEO_SCENE_REUSE_DIR: reuse ? join(dir, 'reuse') : '' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  await new Promise(resolve => server.close(resolve));
  return { dir, output, requests, paths, stderr, code };
}

const base = () => ({ status: '准备制作', topic: '潮汐', userRequirements: ['简洁'], notes: null,
  sections: [{ id: 'S01', blueprintId: 'B03', title: '月球', intent: '理解潮汐',
    facts: ['月球影响海水'], visual: '月球与海洋', narration: '月球影响潮汐。', notes: null, gaps: [] }] });

test('reuses complete supplied sections and generates only the remaining sections', async () => {
  const input = base(); input.sections.push({...input.sections[0],id:'S02',blueprintId:'B04'});
  const result = await runCase(input, scene, null, {}, 'test', true);
  try {
    assert.equal(result.code, 0, result.stderr); assert.equal(result.requests.length, 1);
    assert.equal(await readFile(join(result.output, 'S01.html'), 'utf8'), 'reused html');
    const prepared = JSON.parse(await readFile(join(result.output, 'production.json')));
    assert.deepEqual(prepared.sections.map(s => s.scene), ['S01.html','S02.html']);
  } finally { await rm(result.dir, {recursive:true,force:true}); }
});

test('MiMo 场景制作请求关闭思考', async () => {
  const result = await runCase(base(), scene, null, {}, 'mimo-v2.6-pro');
  try { assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.requests[0].thinking, { type: 'disabled' }); }
  finally { await rm(result.dir, { recursive: true, force: true }); }
});

test('preserves narration and confines model output to data', async () => {
  const input = base(); input.style = { id:'editorial', name:'杂志式图文', description:'暖色与留白', source:{kind:'text',label:'资料'} };
  input.skill = defaultProcessGuidance();
  const result = await runCase(input);
  try {
    assert.equal(result.code, 0, result.stderr);
    const production = JSON.parse(await readFile(join(result.output, 'production.json')));
    assert.equal(production.sections[0].narration, '月球影响潮汐。');
    assert.equal(production.sections[0].scene, 'S01.html');
    assert.equal(production.sections[0].narrationConfirmed, undefined);
    const sent = JSON.parse(result.requests[0].messages[1].content);
    assert.deepEqual(sent.userRequirements, ['简洁']);
    assert.equal(sent.notes, null);
    assert.deepEqual(sent.gaps, []);
    assert.deepEqual(sent.visualStyle, input.style);
    assert.deepEqual(sent.sequence.map(s => s.id), ['S01']);
    assert.deepEqual(sent.skillGuidance, defaultProcessGuidance());
    const data = JSON.parse(await readFile(join(result.output, 'S01.scene.json')));
    assert.equal(data.script, undefined);
    assert.equal(data.layers[0].onclick, undefined);
    assert.equal(data.layers[0].href, undefined);
    assert.deepEqual(data.layers[0].motion, {toX: 760, toY: 220});
    const html = await readFile(join(result.output, 'S01.html'), 'utf8');
    assert.ok(!html.includes('</script><script>evil()'));
    assert.ok(html.includes('\\u003c/script>'));
  } finally { await rm(result.dir, { recursive: true, force: true }); }
});

test('selected style guides composition and its camera is rendered', async () => {
  const input = base(); input.style = {id:'andy-pixel-quest',name:'像素闯关',description:'有限色板，地图构图，镜头平移',source:{kind:'builtin',label:'参考'}};
  input.skill = {id:'repo-skill:example',name:'制作方法',content:'完整技能方法，包含分镜和动作规则'};
  const camera = {fromScale:1,toScale:1.25,fromX:0,fromY:0,toX:120,toY:-40};
  const result = await runCase(input, {...scene,camera});
  try {
    assert.equal(result.code,0,result.stderr);
    const prompt = result.requests[0].messages;
    assert.match(prompt[0].content,/色彩、构图、文字层级、素材位置、运动方式和节奏/);
    const sent = JSON.parse(prompt[1].content);
    assert.deepEqual(sent.visualStyle,input.style); assert.deepEqual(sent.skillGuidance,input.skill);
    assert.deepEqual(JSON.parse(await readFile(join(result.output,'S01.scene.json'))).camera,camera);
    const html = await readFile(join(result.output,'S01.html'),'utf8');
    assert.match(html,/camera\.fromScale \+ \(camera\.toScale - camera\.fromScale\) \* progress/);
    assert.match(html,/960 \+ cameraX/);
  } finally { await rm(result.dir,{recursive:true,force:true}); }
});

test('text and source image layouts produce different rendered properties', async () => {
  const input = base(); input.sections[0].image = 'images/S01.png';
  const png = Buffer.from('89504e470d0a1a0a00000000','hex');
  const model = (box, anchor, font) => ({background:'#112233',imageLayout:box,layers:[{...scene.layers[0],textAnchor:anchor,fontFamily:font}]});
  const a = await runCase(input,model({x:0,y:0,width:960,height:450},'start','serif'),png);
  const b = await runCase(input,model({x:960,y:450,width:960,height:450},'end','monospace'),png);
  function render(html) {
    const elements = Object.fromEntries(['#stage','svg','g','#source-image','#sub'].map(key => [key,{style:{},attrs:{},classList:{add(){}},setAttribute(k,v){this.attrs[k]=v},appendChild(child){this.child=child}}]));
    elements.svg.querySelector = () => elements.g;
    const document = {querySelector: key => elements[key],createElementNS: () => ({style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v}})};
    const window = {STYLE:{video:{width:1920,height:1080},subtitle:{bottom:0,fontWeight:400,fontSize:30},font:{family:'sans-serif'}}};
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document,window});
    return {image:elements['#source-image'].style,text:elements.g.child.attrs};
  }
  try {
    assert.equal(a.code,0,a.stderr); assert.equal(b.code,0,b.stderr);
    const left = render(await readFile(join(a.output,'S01.html'),'utf8'));
    const right = render(await readFile(join(b.output,'S01.html'),'utf8'));
    assert.equal(left.image.left,'0%'); assert.equal(right.image.left,'50%');
    assert.equal(left.text['text-anchor'],'start'); assert.equal(right.text['text-anchor'],'end');
    assert.equal(left.text['font-family'],'serif'); assert.equal(right.text['font-family'],'monospace');
  } finally { await rm(a.dir,{recursive:true,force:true}); await rm(b.dir,{recursive:true,force:true}); }
});

test('invalid optional layout fields are ignored or clamped', async () => {
  const input = base(); input.sections[0].image = 'images/S01.png';
  const invalid = {...scene,camera:{fromScale:-4,toScale:9,fromX:99999,fromY:0,toX:0,toY:0},imageLayout:{x:-5,y:850,width:5000,height:999},layers:[{...scene.layers[0],textAnchor:'unsafe',fontFamily:'url(evil)',motion:{toX:'bad'}}]};
  const result = await runCase(input,invalid,Buffer.from('89504e470d0a1a0a00000000','hex'));
  try {
    assert.equal(result.code,0,result.stderr); assert.equal(result.requests.length,1);
    const data=JSON.parse(await readFile(join(result.output,'S01.scene.json')));
    assert.deepEqual(data.camera,{fromScale:0.5,toScale:2,fromX:1920,fromY:0,toX:0,toY:0});
    assert.deepEqual(data.imageLayout,{x:0,y:850,width:1920,height:50});
    assert.equal(data.layers[0].textAnchor,undefined); assert.equal(data.layers[0].fontFamily,undefined); assert.equal(data.layers[0].motion,undefined);
  } finally { await rm(result.dir,{recursive:true,force:true}); }
});

test('missing narration fails before any request and names blueprint section', async () => {
  const input = base();
  input.sections[0].narration = null;
  const result = await runCase(input);
  try {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /B03/);
    assert.equal(result.requests.length, 0);
  } finally { await rm(result.dir, { recursive: true, force: true }); }
});

test('rejects unsupported model layer types', async () => {
  const invalid = { ...scene, layers: [{ ...scene.layers[0], type: 'script' }] };
  const result = await runCase(base(), invalid);
  try {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Invalid scene response/);
  } finally { await rm(result.dir, { recursive: true, force: true }); }
});

test('线条和图层可越界移动，负尺寸形状自动归正，字幕区被裁切', async () => {
  const line = {type:'line', x:500, y:300, width:-300, height:-200, fill:'#112233', start:0, end:1};
  const result = await runCase(base(), {background:'#ffffff',layers:[line]});
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(result.output, 'S01.scene.json'))).layers[0], line);
    assert.match(result.requests[0].messages[0].content, /可为负数/);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
  const oversized = {type:'rect',x:-100,y:950,width:2200,height:1000,fill:'#112233',start:0,end:1,motion:{toX:2100,toY:-400}};
  const text = {type:'text',x:0,y:0,width:1,height:150,fill:'#112233',text:'字'.repeat(121),start:0,end:1};
  const outside = await runCase(base(), {background:'#ffffff',layers:[{...line,width:-501,height:-301},oversized,...Array(30).fill(text)]});
  try {
    assert.equal(outside.code, 0, outside.stderr);
    const data = JSON.parse(await readFile(join(outside.output, 'S01.scene.json')));
    assert.deepEqual(data.layers[1], oversized);
    assert.equal(data.layers.length, 32);
    const html = await readFile(join(outside.output, 'S01.html'), 'utf8');
    assert.match(html, /<clipPath id="content-clip"><rect x="0" y="0" width="1920" height="900"\/><\/clipPath>/);
    assert.match(html, /content.appendChild\(e\)/);
  } finally { await rm(outside.dir, {recursive:true, force:true}); }
  const bad = await runCase(base(), {background:'#ffffff',layers:[{...line,type:'rect'}]});
  try { assert.equal(bad.code, 0, bad.stderr); const data = JSON.parse(await readFile(join(bad.output, 'S01.scene.json'))); assert.equal(data.layers[0].x,200); assert.equal(data.layers[0].width,300); }
  finally { await rm(bad.dir, {recursive:true, force:true}); }
});

test('null section is rejected before any request', async () => {
  const input = base();
  input.sections = [null];
  const result = await runCase(input);
  try {
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.length, 0);
  } finally { await rm(result.dir, { recursive: true, force: true }); }
});

test('DSH mode reads a completed native final event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-scenes-dsh-test-'));
  try {
    const fakeJs = join(dir, 'fake-dsh.js');
    await writeFile(fakeJs, `let data='';process.stdin.on('data', x=>data+=x);process.stdin.on('end', () => {require('fs').writeFileSync(${JSON.stringify(join(dir, 'request.txt'))},data);console.log(${JSON.stringify(JSON.stringify({type:'final',reason:{kind:'completed'},text:JSON.stringify(scene)}))})});\n`);
    let cli;
    if (process.platform === 'win32') {
      cli = join(dir, 'dsh.cmd');
      await writeFile(cli, `@echo off\r\nnode "${fakeJs}" %*\r\n`);
    } else {
      cli = join(dir, 'dsh');
      await writeFile(cli, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeJs)});\n`);
      await chmod(cli, 0o755);
    }
    const input = join(dir, 'input.json'), output = join(dir, 'out');
    const doc = base(); doc.style = { id:'editorial', name:'杂志式图文', description:'暖色与留白' };
    await writeFile(input, JSON.stringify(doc));
    const child = spawn(process.execPath, [script, '--input', input, '--output', output, '--dsh'], { env: { ...process.env, DSH_CLI: cli } });
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(await readFile(join(output, 'production.json'))).sections[0].scene, 'S01.html');
    assert.match(await readFile(join(dir, 'request.txt'), 'utf8'), /暖色与留白/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uses the uploaded image in the scene without sending local paths to the model', async () => {
  const input = base();
  input.sections[0].image = 'images/S01.png';
  input.sections[0].visual = '展示 /Users/alice/private/火锅.png';
  input.notes = '来源 C:\\Users\\alice\\secret.png';
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const result = await runCase(input, scene, image);
  try {
    assert.equal(result.code, 0, result.stderr);
    const sent = result.requests[0].messages[1].content;
    assert.ok(!sent.includes('/Users/alice'));
    assert.ok(!sent.includes('alice'));
    assert.ok(!sent.includes('images/S01.png'));
    const html = await readFile(join(result.output, 'S01.html'), 'utf8');
    assert.ok(html.includes('data:image/png;base64,' + image.toString('base64')));
    assert.ok(html.includes('has-image'));
  } finally { await rm(result.dir, { recursive: true, force: true }); }
});


test('reuses one character across three independently directed scenes', async () => {
  const input = base();
  const character = {id:'traveler', name:'旅行者', type:'character', image:'assets/traveler.svg'};
  input.sections = [0, 1, 2].map(i => ({...input.sections[0], id:`S0${i+1}`, assets:[character], visual:`第 ${i+1} 段`}));
  const modelScene = {background:'#ffffff', layers:[{type:'asset', assetId:'traveler', x:200, y:100, width:300, height:400, start:0, end:1, motion:{toX:900,toY:200}}, {type:'rect',x:20,y:20,width:100,height:100,fill:'#112233',start:0,end:1}]};
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
  const result = await runCase(input, modelScene, null, {'traveler.svg':svg});
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 3);
    for (let i = 1; i <= 3; i++) {
      const request = JSON.parse(result.requests[i-1].messages[1].content);
      assert.deepEqual(request.assets, [{id:'traveler',name:'旅行者',type:'character'}]);
      const data = JSON.parse(await readFile(join(result.output, `S0${i}.scene.json`)));
      assert.equal(data.layers[0].assetId, 'traveler');
      assert.equal(data.layers[0].fill, undefined);
      assert.equal(data.layers[0].text, undefined);
      assert.equal(data.layers[1].text, undefined);
      assert.deepEqual(data.layers[0].motion, {toX:900,toY:200});
      const html = await readFile(join(result.output, `S0${i}.html`), 'utf8');
      assert.ok(html.includes(Buffer.from(svg).toString('base64')));
    }
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});

test('rejects a model reference to an asset outside the section', async () => {
  const invalid = {...scene, layers:[{...scene.layers[0], type:'asset', assetId:'missing'}]};
  const result = await runCase(base(), invalid);
  try {
    assert.notEqual(result.code, 0); assert.match(result.stderr, /layers\[0\].*assetId/);
    assert.match(result.requests[1].messages.at(-1).content, /layers\[0\].*assetId/);
    assert.match(result.requests[1].messages.at(-1).content, /图层示例/);
  }
  finally { await rm(result.dir, {recursive:true, force:true}); }
});


test('fills omitted planned assets from the approved section', async () => {
  const input = base();
  input.sections[0].assets = [{id:'traveler',name:'旅行者',type:'character',image:'assets/traveler.svg'}];
  const result = await runCase(input, scene, null, {'traveler.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>'});
  try { assert.equal(result.code, 0, result.stderr); const data=JSON.parse(await readFile(join(result.output,'S01.scene.json'))); assert.equal(data.layers.at(-1).assetId,'traveler'); }
  finally { await rm(result.dir, {recursive:true, force:true}); }
});


test('preserves valid asset rotation and orbit and ignores invalid pivots', async () => {
  const input = base();
  input.sections[0].assets = [{id:'moon',name:'月球',type:'character',image:'assets/moon.svg'}];
  const layer = {type:'asset',assetId:'moon',x:300,y:200,width:100,height:100,fill:'#ffffff',text:'',start:0,end:1,rotation:{from:0,to:-360},orbit:{cx:960,cy:450,from:0,to:360}};
  const modelScene = {background:'#000000',layers:[layer]};
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const result = await runCase(input, modelScene, null, {'moon.svg':svg});
  try {
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(await readFile(join(result.output, 'S01.scene.json')));
    assert.deepEqual(data.layers[0].rotation, {from:0,to:-360});
    assert.deepEqual(data.layers[0].orbit, {cx:960,cy:450,from:0,to:360});
    const html = await readFile(join(result.output, 'S01.html'), 'utf8');
    assert.match(html, /orbitTransform \+ selfTransform/);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
  const bad = await runCase(input, {background:'#000000',layers:[{...layer, orbit:{cx:null,cy:450,from:0,to:360}}]}, null, {'moon.svg':svg});
  try { assert.equal(bad.code, 0, bad.stderr); assert.equal(JSON.parse(await readFile(join(bad.output,'S01.scene.json'))).layers[0].orbit,undefined); }
  finally { await rm(bad.dir, {recursive:true, force:true}); }
});

test('修正两轮仍含无效图层时保留有效图层并记录提醒', async () => {
  const partial = {...scene, layers:[...scene.layers, {type:'script'}]};
  const result = await runCase(base(), partial);
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 2);
    const data = JSON.parse(await readFile(join(result.output,'S01.scene.json')));
    assert.equal(data.layers.length, 1);
    assert.ok(data.warning);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});

test('scrubPaths 保留分数、日期、URL 与中文 slash，只替换真实本地路径', async () => {
  const input = base();
  input.sections[0].visual = '对比 1/3 与 2026/11/17，和/或 https://github.com/a/b';
  input.sections[0].facts = ['来源 C:\\x\\y 与 /home/u/f', '/workspace/inbox/需求.md'];
  const result = await runCase(input);
  try {
    assert.equal(result.code, 0, result.stderr);
    const sent = JSON.parse(result.requests[0].messages[1].content);
    assert.equal(sent.visual, '对比 1/3 与 2026/11/17，和/或 https://github.com/a/b');
    assert.deepEqual(sent.facts, ['来源 [本地路径] 与 [本地路径]', '[本地路径]']);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});

test('endpoint 归一化：base URL 补全 chat/completions 且对完整地址幂等', async () => {
  const fromBase = await runCase(base(), scene, null, {}, 'test', false, { endpointPath: '/v1' });
  try { assert.equal(fromBase.code, 0, fromBase.stderr); assert.deepEqual(fromBase.paths, ['/v1/chat/completions']); }
  finally { await rm(fromBase.dir, {recursive:true, force:true}); }
  const fromFull = await runCase(base(), scene, null, {}, 'test', false, { endpointPath: '/v1/chat/completions/' });
  try { assert.equal(fromFull.code, 0, fromFull.stderr); assert.deepEqual(fromFull.paths, ['/v1/chat/completions']); }
  finally { await rm(fromFull.dir, {recursive:true, force:true}); }
});

test('429 首次失败后等待重试并成功', async () => {
  const result = await runCase(base(), scene, null, {}, 'test', false, {
    handler: (req, res, count) => {
      if (count === 1) { res.statusCode = 429; res.end('{}'); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scene) } }] }));
    },
  });
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.paths, ['/v1/chat/completions', '/v1/chat/completions']);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});

test('响应缺少 message content 时抛出带 section id 的友好错误', async () => {
  const result = await runCase(base(), scene, null, {}, 'test', false, {
    handler: (req, res) => res.end(JSON.stringify({})),
  });
  try {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /S01/);
    assert.match(result.stderr, /missing message content/);
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});
