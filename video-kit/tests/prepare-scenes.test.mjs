import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultProcessGuidance } from '../../dsh-workbench-fix/dsh-base/packages/bohack-blueprint/lib/process-guidance.js';

const script = resolve(fileURLToPath(new URL('../scripts/prepare-scenes.mjs', import.meta.url)));
const scene = {
  background: '#112233',
  layers: [{ type: 'text', x: 100, y: 100, width: 300, height: 40,
    fill: '#ffffff', text: '</script><script>evil()</script>', start: 0, end: 1,
    motion: {toX: 760, toY: 220, onclick: 'bad()'}, onclick: 'evil()', href: 'https://example.invalid' }],
  script: 'evil()',
};

async function runCase(production, modelScene = scene, imageBytes = null, assetFiles = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-scenes-test-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'out');
  await writeFile(input, JSON.stringify(production));
  if (imageBytes) { await mkdir(join(dir, 'images')); await writeFile(join(dir, 'images/S01.png'), imageBytes); }
  if (Object.keys(assetFiles).length) { await mkdir(join(dir, 'assets')); for (const [name, contents] of Object.entries(assetFiles)) await writeFile(join(dir, 'assets', name), contents); }
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelScene) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [script, '--input', input, '--output', output,
    '--endpoint', `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    '--model', 'test'], { env: { ...process.env, SCENE_API_KEY: 'test' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  await new Promise(resolve => server.close(resolve));
  return { dir, output, requests, stderr, code };
}

const base = () => ({ status: '准备制作', topic: '潮汐', userRequirements: ['简洁'], notes: null,
  sections: [{ id: 'S01', blueprintId: 'B03', title: '月球', intent: '理解潮汐',
    facts: ['月球影响海水'], visual: '月球与海洋', narration: '月球影响潮汐。', notes: null, gaps: [] }] });

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
    assert.deepEqual(sent.visualStyle, { name:'杂志式图文', description:'暖色与留白' });
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
    const fake = join(dir, 'dsh');
    await writeFile(fake, `#!/usr/bin/env node\nlet data='';process.stdin.on('data', x=>data+=x);process.stdin.on('end', () => {require('fs').writeFileSync(${JSON.stringify(join(dir, 'request.txt'))},data);console.log(${JSON.stringify(JSON.stringify({type:'final',reason:{kind:'completed'},text:JSON.stringify(scene)}))})});\n`);
    await chmod(fake, 0o755);
    const input = join(dir, 'input.json'), output = join(dir, 'out');
    const doc = base(); doc.style = { id:'editorial', name:'杂志式图文', description:'暖色与留白' };
    await writeFile(input, JSON.stringify(doc));
    const child = spawn(process.execPath, [script, '--input', input, '--output', output, '--dsh'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
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
  const modelScene = {background:'#ffffff', layers:[{type:'asset', assetId:'traveler', x:200, y:100, width:300, height:400, fill:'#ffffff', text:'', start:0, end:1, motion:{toX:900,toY:200}}]};
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
      assert.deepEqual(data.layers[0].motion, {toX:900,toY:200});
      const html = await readFile(join(result.output, `S0${i}.html`), 'utf8');
      assert.ok(html.includes(Buffer.from(svg).toString('base64')));
    }
  } finally { await rm(result.dir, {recursive:true, force:true}); }
});

test('rejects a model reference to an asset outside the section', async () => {
  const invalid = {...scene, layers:[{...scene.layers[0], type:'asset', assetId:'missing'}]};
  const result = await runCase(base(), invalid);
  try { assert.notEqual(result.code, 0); assert.match(result.stderr, /Unknown asset id/); }
  finally { await rm(result.dir, {recursive:true, force:true}); }
});


test('rejects omitted planned assets', async () => {
  const input = base();
  input.sections[0].assets = [{id:'traveler',name:'旅行者',type:'character',image:'assets/traveler.svg'}];
  const result = await runCase(input, scene, null, {'traveler.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>'});
  try { assert.notEqual(result.code, 0); assert.match(result.stderr, /Missing asset id: traveler/); }
  finally { await rm(result.dir, {recursive:true, force:true}); }
});


test('preserves asset rotation and orbit and rejects invalid pivots', async () => {
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
  const bad = await runCase(input, {background:'#000000',layers:[{...layer, orbit:{cx:2000,cy:450,from:0,to:360}}]}, null, {'moon.svg':svg});
  try { assert.notEqual(bad.code, 0); assert.match(bad.stderr, /Invalid orbit/); }
  finally { await rm(bad.dir, {recursive:true, force:true}); }
});
