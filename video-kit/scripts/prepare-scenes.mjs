#!/usr/bin/env node
// Generate data-only SVG scenes. Model output is never executed as code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { callDsh } from './dsh-model.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--input' || args[2] !== '--output' || !((args.length === 5 && args[4] === '--dsh') || (args.length === 8 && args[4] === '--endpoint' && args[6] === '--model'))) {
  console.error('Usage: node scripts/prepare-scenes.mjs --input production.json --output NEW_DIRECTORY --dsh | --endpoint URL --model MODEL');
  process.exit(1);
}
const input = resolve(args[1]), output = resolve(args[3]), endpoint = args[5], model = args[7];
const dsh = args[4] === '--dsh';
const key = process.env.SCENE_API_KEY;
if (!dsh) {
  const url = new URL(endpoint);
  if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Set SCENE_API_KEY explicitly.');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Endpoint must use HTTP or HTTPS.');
}
const production = JSON.parse(await readFile(input, 'utf8'));
if (!production || production.status !== '准备制作' || !Array.isArray(production.sections) || !production.sections.length) throw new Error('Expected an adapter production document with status 准备制作 and sections.');
const ids = new Set();
for (const s of production.sections) {
  if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id) || ids.has(s.id)) {
    throw new Error('Each section needs a unique safe id.');
  }
  if (typeof s.narration !== 'string' || !s.narration.trim()) {
    throw new Error(`缺少旁白：${s.blueprintId || s.id}；请返回蓝图补充。`);
  }
  ids.add(s.id);
}
await mkdir(output); // Do not overwrite an existing task.
const layerExamples = '图层示例：素材 {"type":"asset","assetId":"素材ID","x":100,"y":100,"width":200,"height":200,"start":0,"end":1}；图形 {"type":"rect","x":100,"y":100,"width":200,"height":200,"fill":"#112233","start":0,"end":1}；文字 {"type":"text","x":100,"y":100,"width":200,"height":40,"fill":"#112233","text":"文字","start":0,"end":1}。';
const system = `你是知识视频画面设计师。根据单段制作信息，设计可读的矢量动态图解，按所选风格安排空间、动作和节奏。只返回 JSON 对象，不要 Markdown。画布 1920×1080，底部 180 像素留给字幕。格式：{"background":"#rrggbb","layers":[图层]}。每层必须有 type、x、y、width、height、start、end；type 为 rect、ellipse、line、text 或 asset。asset 必须有 assetId，不需要 fill 和 text；其他类型必须有 fill；仅 text 类型必须有 text。${layerExamples}最多 30 层；x/y 为左上角，line 从 (x,y) 到 (x+width,y+height)，width 和 height 可为负数表示向左或向上，起点和终点的 x 均在 0–1920、y 均在 0–900；text 的 x/y 为基线，height 为字号。start/end 是出现和消失时间比例，start < end。需要移动的主体可加可选字段 motion: {"toX":数字,"toY":数字}，表示本图层出现后从 x/y 移动到的目标坐标。对照叙述让动作解释变化，标签保持可读。背景色直接写 background，不要铺全屏背景矩形。图层 x 在 0–1920、y 在 0–900；非 line 类型 width 在 0–1920、height 在 0–900；文字字号 height 12–100。图形与文字不越过内容区，留出字幕区。画面用分阶段的可见变化解释动作；只画本段需要的信息，提问段遵守揭晓时机。不得添加未经材料支持的事实，不要编写旁白、代码、外链或 SVG。缺失信息不要猜测。`;
const color = /^#[0-9a-fA-F]{6}$/;
function validate(data, assetIds) {
  if (!data || typeof data.background !== 'string' || !color.test(data.background)) throw new Error('background 必须是 #rrggbb 颜色');
  if (!Array.isArray(data.layers) || data.layers.length < 1 || data.layers.length > 30) throw new Error('layers 必须是 1 至 30 个图层的数组');
  for (const [i, l] of data.layers.entries()) {
    const fail = message => { throw new Error(`layers[${i}]：${message}`); };
    if (!l || !['rect','ellipse','line','text','asset'].includes(l.type) ) fail('type 必须是 rect、ellipse、line、text 或 asset');
    if (l.type !== 'asset' && (typeof l.fill !== 'string' || !color.test(l.fill))) fail('fill 必须是 #rrggbb 颜色');
    if (l.type === 'text' && (typeof l.text !== 'string' || l.text.length > 120)) fail('text 必须是最多 120 个字符的文字');
    if (l.type === 'asset' && !assetIds.has(l.assetId)) fail(`assetId 必须是本段素材 ID，收到 ${JSON.stringify(l.assetId)}`);
    for (const k of ['x','y','width','height','start','end']) if (typeof l[k] !== 'number' || !Number.isFinite(l[k])) fail(`${k} 必须是有限数字`);
    for (const key of ['rotation', 'orbit']) {
      if (l[key] !== undefined && (l.type !== 'asset' || !Number.isFinite(l[key]?.from) || !Number.isFinite(l[key]?.to) ||
          (key === 'orbit' && (!Number.isFinite(l[key]?.cx) || !Number.isFinite(l[key]?.cy) || l[key].cx < 0 || l[key].cx > 1920 || l[key].cy < 0 || l[key].cy > 900)))) fail(`${key} 字段无效，仅 asset 可用，角度及中心坐标须为有效数字`);
    }
    if (l.motion !== undefined && (!Number.isFinite(l.motion?.toX) || !Number.isFinite(l.motion?.toY) ||
        l.motion.toX < 0 || l.motion.toX > 1920 || l.motion.toY < 0 || l.motion.toY > 900)) fail('motion.toX 或 motion.toY 超出画布范围');
    for (const [k, max] of [['x',1920],['y',900]]) if (l[k] < 0 || l[k] > max) fail(`${k} 必须在 0 至 ${max} 之间`);
    if (l.type === 'line') {
      if (l.x + l.width < 0 || l.x + l.width > 1920) fail('line 终点 x + width 必须在 0 至 1920 之间');
      if (l.y + l.height < 0 || l.y + l.height > 900) fail('line 终点 y + height 必须在 0 至 900 之间');
    } else {
      for (const [k, max] of [['width',1920],['height',900]]) if (l[k] < 0 || l[k] > max) fail(`${k} 必须在 0 至 ${max} 之间`);
    }
    if (l.start < 0 || l.end > 1 || l.start >= l.end) fail('start 和 end 必须满足 0 ≤ start < end ≤ 1');
    if (l.type === 'text' && (l.height < 12 || l.height > 100)) fail('文字的 height 必须在 12 至 100 之间');
  }
  const usedAssets = new Set(data.layers.filter(l => l.type === 'asset').map(l => l.assetId));
  for (const id of assetIds) if (!usedAssets.has(id)) throw new Error(`layers 缺少 assetId 为 ${id} 的素材图层`);
  // Discard all properties beyond the schema, including possible code or URLs.
  return {background:data.background,layers:data.layers.map(({type,x,y,width,height,fill,text,start,end,motion,assetId,rotation,orbit}) => ({type,x,y,width,height,fill,text,start,end,...(type === 'asset' ? {assetId} : {}),...(rotation ? {rotation:{from:rotation.from,to:rotation.to}} : {}),...(orbit ? {orbit:{cx:orbit.cx,cy:orbit.cy,from:orbit.from,to:orbit.to}} : {}),...(motion ? {motion:{toX:motion.toX,toY:motion.toY}} : {})}))};
}
function html(data, imageData, assets) {
  const assetsJson = JSON.stringify(assets).replaceAll('<', '\\u003c');
  const imageJson = JSON.stringify(imageData).replaceAll('<', '\\u003c');
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; }
#stage { position: relative; overflow: hidden; }
svg { width: 100%; height: 100%; }
#source-image { display: none; position: absolute; left: 3%; top: 7%; width: 42%; height: 70%; object-fit: contain; }
#stage.has-image svg { position: absolute; left: 48%; width: 50%; height: 100%; }
#sub { position: absolute; left: 50%; transform: translateX(-50%); width: max-content; max-width: 85%; text-align: center; color: white; background: #181c24e8; border-radius: 12px; padding: 8px 22px; line-height: 1.3; }
#sub:empty { display: none; }
</style>
</head>
<body>
<div id="stage">
  <img id="source-image" alt="">
  <svg viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="sub"></div>
</div>
<script>
const data = ${json};
const imageData = ${imageJson};
const assets = ${assetsJson};
const style = window.STYLE;
const stage = document.querySelector('#stage');
const svg = document.querySelector('svg');
if (imageData) { const image = document.querySelector('#source-image'); image.src = imageData; image.style.display = 'block'; stage.classList.add('has-image'); }
const sub = document.querySelector('#sub');
stage.style.width = style.video.width + 'px';
stage.style.height = style.video.height + 'px';
stage.style.background = data.background;
sub.style.bottom = style.subtitle.bottom + 'px';
sub.style.font = style.subtitle.fontWeight + ' ' + style.subtitle.fontSize + 'px ' + style.font.family;
const ns = 'http://www.w3.org/2000/svg';
const nodes = data.layers.map(l => {
  const e = document.createElementNS(ns, l.type === 'asset' ? 'image' : l.type);
  if (l.type === 'asset') {
    e.setAttribute('x', l.x); e.setAttribute('y', l.y);
    e.setAttribute('width', l.width); e.setAttribute('height', l.height);
    e.setAttribute('href', assets[l.assetId]);
  } else if (l.type === 'rect') {
    e.setAttribute('x', l.x); e.setAttribute('y', l.y);
    e.setAttribute('width', l.width); e.setAttribute('height', l.height);
  } else if (l.type === 'ellipse') {
    e.setAttribute('cx', l.x + l.width / 2); e.setAttribute('cy', l.y + l.height / 2);
    e.setAttribute('rx', l.width / 2); e.setAttribute('ry', l.height / 2);
  } else if (l.type === 'line') {
    e.setAttribute('x1', l.x); e.setAttribute('y1', l.y);
    e.setAttribute('x2', l.x + l.width); e.setAttribute('y2', l.y + l.height);
    e.setAttribute('stroke', l.fill); e.setAttribute('stroke-width', '5');
  } else {
    e.setAttribute('x', l.x); e.setAttribute('y', l.y);
    e.setAttribute('font-size', l.height); e.setAttribute('font-family', 'sans-serif');
    e.textContent = l.text;
  }
  if (l.type !== 'asset') e.setAttribute('fill', l.fill);
  svg.appendChild(e);
  return e;
});
window.seek = function(t) {
  const p = window.__PLAN__;
  const progress = Math.max(0, Math.min(1, t / p.duration));
  // Bring the diagram out of a soft shadow as its layers unfold.
  svg.style.filter = 'brightness(' + (0.82 + 0.18 * progress) + ')';
  nodes.forEach((node, i) => {
    const l = data.layers[i];
    const visible = progress >= l.start && (progress < l.end || (progress === 1 && l.end === 1));
    const fade = Math.max(0, Math.min(1, (progress - l.start) / 0.04));
    node.style.opacity = visible ? String(fade) : '0';
    // Keep related shapes registered as one diagram; reveal the composition with a shared camera.
    const zoom = 0.58 + 0.42 * progress;
    const t = Math.min(1, Math.max(0, (progress - l.start) / (l.end - l.start)));
    const ease = t * t * (3 - 2 * t);
    const dx = l.motion ? (l.motion.toX - l.x) * ease : 0;
    const dy = l.motion ? (l.motion.toY - l.y) * ease : 0;
    const angle = l.rotation ? l.rotation.from + (l.rotation.to - l.rotation.from) * ease : 0;
    const orbit = l.orbit ? l.orbit.from + (l.orbit.to - l.orbit.from) * ease : 0;
    const orbitTransform = l.orbit ? ' rotate(' + orbit + ' ' + l.orbit.cx + ' ' + l.orbit.cy + ')' : '';
    const selfTransform = l.rotation ? ' rotate(' + angle + ' ' + (l.x + l.width / 2) + ' ' + (l.y + l.height / 2) + ')' : '';
    node.setAttribute('transform', 'translate(960 450) scale(' + zoom + ') translate(' + (dx - 960) + ' ' + (dy - 450) + ')' + orbitTransform + selfTransform);
    if (l.type === 'line') {
      const length = Math.hypot(l.width, l.height);
      const reveal = Math.min(1, Math.max(0, (progress - l.start) / Math.min(0.32, l.end - l.start)));
      node.setAttribute('stroke-dasharray', length);
      node.setAttribute('stroke-dashoffset', length * (1 - reveal));
    }
  });
  const caption = p.subtitle;
  sub.textContent = caption && t >= caption.start && t < caption.end ? caption.text : '';
};
</script>
</body>
</html>`;
}

// Send descriptive content to the model without exposing local paths.
function scrubPaths(value) {
  if (typeof value === 'string') return value.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s，。；、：:（）()"'<>]+[\/\\])*[^\s，。；、：:（）()"'<>]+/g, '[本地路径]');
  if (Array.isArray(value)) return value.map(scrubPaths);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubPaths(item)]));
  return value;
}
async function imageDataFor(section) {
  if (!section.image) return null;
  if (typeof section.image !== 'string' || !/^images\/S[0-9]+\.(png|jpg)$/.test(section.image)) throw new Error(`Invalid image path for ${section.id}`);
  const bytes = await readFile(join(dirname(input), section.image));
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if ((section.image.endsWith('.png') && !png) || (section.image.endsWith('.jpg') && !jpeg)) throw new Error(`Invalid image content for ${section.id}`);
  return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}

for (const section of production.sections) {
  const assets = Object.create(null);
  const assetInfo = [];
  for (const asset of section.assets || []) {
    if (!asset || typeof asset.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(asset.id) || Object.hasOwn(assets, asset.id) || typeof asset.name !== 'string' || !['character', 'prop', 'background'].includes(asset.type) || asset.image !== `assets/${asset.id}.svg`) throw new Error(`Invalid asset for ${section.id}`);
    const bytes = await readFile(join(dirname(input), asset.image));
    assets[asset.id] = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
    assetInfo.push({id: asset.id, name: asset.name, type: asset.type});
  }
  const sceneInput = {
    topic: production.topic,
    userRequirements: production.userRequirements,
    productionNotes: production.notes,
    skillGuidance: production.skill || null,
    visualStyle: production.style ? { name: production.style.name, description: production.style.description } : null,
    assets: assetInfo,
    title: section.title,
    intent: section.intent,
    facts: section.facts,
    visual: section.visual,
    narration: section.narration,
    notes: section.notes,
    gaps: section.gaps,
  };
  const messages = [
    { role: 'system', content: system + ' 本段必须使用 assets 列出的每个素材，分别增加 type 为 asset 的图层，并填写 assetId 对应素材 id，其余字段与普通图层相同。根据本段叙述安排素材大小、位置和 motion；复用角色时使用同一 id。素材图层可选 rotation: {from:起始角度,to:结束角度} 表示在公转基础上绕素材中心旋转；可选 orbit: {cx:中心横坐标,cy:中心纵坐标,from:起始角度,to:结束角度} 表示绕画面中固定中心公转，角度单位均为度。公转会改变朝向，如需始终面向固定方向，请用自转抵消公转；如需始终面向中心，保持自转角度不变。 skillGuidance 是制作方法参考；仅采用与已确认蓝图、用户要求和 visualStyle 兼容的画面建议。visualStyle 是创作者选定的视觉参考，只应用于色彩、构图、字体与视觉语言；发生冲突时以已确认蓝图、用户要求及选定风格为准。' },
    { role: 'user', content: JSON.stringify(scrubPaths(sceneInput)) },
  ];
  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    let content;
    if (dsh) content = await callDsh(messages);
    else {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages,
        ...(/^mimo-v2\.[56](?:-pro)?$/i.test(model) ? { thinking: { type: 'disabled' } } : {}),
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });
    if (!response.ok) throw new Error(`Scene request for ${section.id} failed: HTTP ${response.status}`);
    const result = await response.json();
    content = result.choices[0].message.content;
    }
    try { data = validate(JSON.parse(content), new Set(Object.keys(assets))); break; }
    catch (error) {
      if (attempt === 1) throw new Error(`Invalid scene response for ${section.id}: ${error.message}`);
      messages.push({ role: 'assistant', content }, { role: 'user', content: `图层校验失败：${error.message}。${layerExamples}请修正后重新提交完整 JSON。` });
    }
  }
  await writeFile(join(output,`${section.id}.scene.json`),JSON.stringify(data,null,2)+'\n');
  await writeFile(join(output,`${section.id}.html`),html(data, await imageDataFor(section), assets));
  section.scene = `${section.id}.html`;
}
await writeFile(join(output,'production.json'),JSON.stringify(production,null,2)+'\n');
console.log(`Prepared ${production.sections.length} scenes: ${join(output,'production.json')}`);
