#!/usr/bin/env node
// CONTRACT.md §7 约定的蓝图解析 / 渲染 / diff 脚本。Node >=18，无第三方依赖。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const CONTRACT_ID = 'blueprint.v1';
const DIFF_ALLOWLIST = ['blueprint_id', 'version', 'derived_from'];
const CONFIRM_STATES = ['draft', 'pending_creator', 'confirmed', 'rework_requested'];
const FORBIDDEN_KEYS = new Set([
  'animation', 'animate', 'frames', 'frame', 'fps', 'keyframe', 'keyframes',
  'camera', 'shot', 'shots', 'component', 'components', 'font', 'codec',
  'transition', 'timeline', 'renderer', 'engine', 'easing',
  'duration_ms', 'start_ms', 'end_ms',
]);

const TOP_FIELDS = {
  contract: 'string', case_id: 'string', version: 'int', blueprint_id: 'string',
  derived_from: 'string|null', title: 'string', core_message: 'string', audience: 'string',
  narrative_order: 'array', user_narration: 'string|null', narration_mode: 'string',
  user_requirements: 'array', segments: 'array', blocking_gaps: 'array',
  non_blocking_open_items: 'array', boundaries: 'array', confirmation: 'object',
};
const SEG_FIELDS = {
  id: 'string', title: 'string', content: 'string', narration: 'string',
  visual_intent: 'string', requirement_refs: 'array', video_module_decides: 'array',
};
const REWORK_FIELDS = {
  from_version: 'string', opinion: 'string', opinion_source: 'string',
  applied: 'array', needs_creator_decision: 'array',
};

const GLOBAL_REQ_KINDS = new Set(['process', 'scope', 'global']);

const kind = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'int' : typeof v;
const isStr = (v) => typeof v === 'string';
const okType = (v, t) => t.split('|').some((x) => x === 'int' ? Number.isInteger(v) : kind(v) === x);

function deepEqual(a, b) {
  if (a === b) return true;
  const ta = kind(a), tb = kind(b);
  if (ta !== tb) return false;
  if (ta === 'array') return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (ta === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function diffPaths(a, b, path, out) {
  if (deepEqual(a, b)) return;
  const ta = kind(a), tb = kind(b);
  if (ta !== tb) { out.push(path || '(root)'); return; }
  if (ta === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
  } else if (ta === 'array') {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
  } else out.push(path || '(root)');
}

function walkForbidden(node, path, errors) {
  if (kind(node) === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        errors.push(`V9 禁止字段 "${k}" 出现在 ${path || '(root)'}（蓝图不得规定动画技术/逐帧/组件）`);
      }
      walkForbidden(v, path ? `${path}.${k}` : k, errors);
    }
  } else if (kind(node) === 'array') {
    node.forEach((v, i) => walkForbidden(v, `${path}[${i}]`, errors));
  }
}

function checkFields(obj, spec, label, errors) {
  for (const [f, t] of Object.entries(spec)) {
    if (!Object.hasOwn(obj, f)) errors.push(`V12 ${label} 缺少必填字段 "${f}"`);
    else if (!okType(obj[f], t)) errors.push(`V12 ${label}.${f} 类型应为 ${t}，实际 ${kind(obj[f])}`);
  }
}

// V8 的锚点 user_narration 与段落旁白同在一个可改文件里，两边一起改就能让 V8 通过。
// V13 另找外部不可改锚点：需求文档。错误级（v1.0 起）：原文不匹配即阻断；
// 仅当需求文档目录/文件缺失时降级为警告（需求模块未交付不应阻断蓝图）。
function checkNarrationAnchor(bp, bpPath, errors, warnings) {
  if (!bpPath) return 'unverified';
  const reqDir = resolve(dirname(bpPath), '..', 'requirements');
  const label = `V13 旁白锚点`;
  if (!existsSync(reqDir)) {
    warnings.push(`${label}：未找到需求文档目录 ${reqDir}，无法核验 user_narration 是否为用户原话（跳过）`);
    return 'unverified';
  }
  const docs = readdirSync(reqDir).filter((f) => f.startsWith(`${bp.case_id}.`) && f.endsWith('.md'));
  if (!docs.length) {
    warnings.push(`${label}：${reqDir} 下没有 ${bp.case_id}.*.md，无法核验 user_narration 是否为用户原话（跳过）`);
    return 'unverified';
  }
  const hit = docs.find((f) => readFileSync(resolve(reqDir, f), 'utf8').includes(bp.user_narration));
  if (hit) return 'ok';
  if (bp.narration_mode === 'rewritten') {
    errors.push(
      `${label}：narration_mode=rewritten，但改写后的 user_narration 未逐字出现在需求文档（已查 ${docs.join(', ')}）。` +
      `授权改写必须先把改写版旁白逐字落档进需求文档（如 <case>.v2.md）并登记 narration_rewrite；否则视为未授权改写。`
    );
  } else {
    errors.push(
      `${label}：narration_mode=verbatim，但 user_narration 未逐字出现在需求文档（已查 ${docs.join(', ')}）。` +
      `V8 通过只说明蓝图内部自洽，不说明旁白没被改写。` +
      `若确为创作者授权的改写，应改 narration_mode=rewritten、登记 narration_rewrite 并把改写版落档进需求文档；否则还原用户原话。`
    );
  }
  return 'mismatch';
}

function validate(bp, bpPath) {
  const errors = [], warnings = [];
  let narrationAnchor = 'not-applicable';
  if (kind(bp) !== 'object') return { errors: ['V12 蓝图根节点必须是 JSON 对象'], warnings, narrationAnchor };
  checkFields(bp, TOP_FIELDS, '顶层', errors);
  if (errors.length) return { errors, warnings, narrationAnchor };

  if (bp.contract !== CONTRACT_ID) errors.push(`V1 contract 应为 "${CONTRACT_ID}"，实际 "${bp.contract}"`);
  if (bp.blueprint_id !== `${bp.case_id}.v${bp.version}`) {
    errors.push(`V2 blueprint_id "${bp.blueprint_id}" 与 case_id/version 不一致`);
  }
  if (bp.version < 1) errors.push('V3 version 必须 >= 1');
  if (bp.version === 1 && bp.derived_from !== null) errors.push('V3 v1 的 derived_from 必须为 null');
  if (bp.version > 1 && !isStr(bp.derived_from)) errors.push('V3 v2+ 的 derived_from 必须指向上一个 blueprint_id');
  if (!['verbatim', 'rewritten', 'none'].includes(bp.narration_mode)) {
    errors.push(`V12 narration_mode 非法："${bp.narration_mode}"`);
  }

  const reqIds = new Set();
  bp.user_requirements.forEach((r, i) => {
    const label = `user_requirements[${i}]`;
    if (kind(r) !== 'object') { errors.push(`V12 ${label} 必须是对象`); return; }
    checkFields(r, { id: 'string', short: 'string', text: 'string', source: 'string' }, label, errors);
    if (!/^R[0-9]{2,}$/.test(r.id ?? '')) errors.push(`V7 ${label}.id "${r.id}" 不匹配 ^R[0-9]{2,}$`);
    if (reqIds.has(r.id)) errors.push(`V7 用户要求 id 重复："${r.id}"`);
    reqIds.add(r.id);
  });

  if (!bp.segments.length) errors.push('V4 segments 不能为空');
  const segIds = [];
  bp.segments.forEach((s, i) => {
    const label = `segments[${i}]`;
    if (kind(s) !== 'object') { errors.push(`V12 ${label} 必须是对象`); return; }
    checkFields(s, SEG_FIELDS, label, errors);
    segIds.push(s.id);
    if (!/^S[1-9][0-9]*$/.test(s.id ?? '')) errors.push(`V4 ${label}.id "${s.id}" 不匹配 ^S[1-9][0-9]*$`);
    if (s.id !== `S${i + 1}`) errors.push(`V4 ${label}.id 应为 "S${i + 1}"（数组顺序即视频顺序），实际 "${s.id}"`);
    for (const ref of s.requirement_refs ?? []) {
      if (!reqIds.has(ref)) errors.push(`V6 ${s.id}.requirement_refs 引用了未登记的用户要求 "${ref}"`);
    }
    if (Object.hasOwn(s, 'rework') && s.rework !== null) {
      if (kind(s.rework) !== 'object') errors.push(`V12 ${label}.rework 必须是对象或 null`);
      else checkFields(s.rework, REWORK_FIELDS, `${label}.rework`, errors);
    }
  });
  if (new Set(segIds).size !== segIds.length) errors.push('V4 段落 id 重复');
  if (!deepEqual(bp.narrative_order, segIds)) {
    errors.push(`V5 narrative_order [${bp.narrative_order}] 与 segments 顺序 [${segIds}] 不一致`);
  }

  if (bp.narration_mode === 'verbatim' || bp.narration_mode === 'rewritten') {
    if (!isStr(bp.user_narration)) errors.push(`V8 narration_mode=${bp.narration_mode} 时 user_narration 必须是字符串`);
    else {
      const joined = bp.segments.map((s) => s.narration).join('');
      if (joined !== bp.user_narration) {
        errors.push('V8 各段旁白按序拼接不等于用户完整旁白原文（蓝图不得悄悄改写用户旁白）');
      }
      narrationAnchor = checkNarrationAnchor(bp, bpPath, errors, warnings);
    }
  }
  if (bp.narration_mode === 'rewritten') {
    const nr = bp.narration_rewrite;
    if (kind(nr) !== 'object') {
      errors.push('V8 narration_mode=rewritten 必须提供 narration_rewrite 对象，登记旁白原话（original_narration）与创作者授权出处（authorization）');
    } else {
      checkFields(nr, { original_narration: 'string', authorization: 'string' }, 'narration_rewrite', errors);
      if (isStr(nr.original_narration) && bpPath) {
        const reqDir = resolve(dirname(bpPath), '..', 'requirements');
        if (existsSync(reqDir)) {
          const docs = readdirSync(reqDir).filter((f) => f.startsWith(`${bp.case_id}.`) && f.endsWith('.md'));
          if (docs.length && !docs.some((f) => readFileSync(resolve(reqDir, f), 'utf8').includes(nr.original_narration))) {
            errors.push(`V13 narration_rewrite.original_narration 未逐字出现在任何需求文档（已查 ${docs.join(', ')}）——登记的“原话”必须真实可溯，不得伪造`);
          }
        }
      }
    }
  } else if (Object.hasOwn(bp, 'narration_rewrite') && bp.narration_rewrite !== null) {
    errors.push('V12 narration_rewrite 仅在 narration_mode=rewritten 时允许填写');
  }

  walkForbidden(bp, '', errors);

  const c = bp.confirmation;
  checkFields(c, { status: 'string', confirmed_by: 'string|null', confirmed_at: 'string|null', note: 'string|null' }, 'confirmation', errors);
  if (!CONFIRM_STATES.includes(c.status)) errors.push(`V10 confirmation.status 非法："${c.status}"`);
  if (c.status === 'confirmed' && (!c.confirmed_by || !c.confirmed_at)) {
    errors.push('V10 status=confirmed 必须同时填写 confirmed_by 与 confirmed_at');
  }

  bp.blocking_gaps.forEach((g, i) => {
    if (kind(g) !== 'object') { errors.push(`V11 blocking_gaps[${i}] 必须是对象`); return; }
    checkFields(g, { id: 'string', question: 'string', why_blocking: 'string', asked_to: 'string' }, `blocking_gaps[${i}]`, errors);
  });
  bp.non_blocking_open_items.forEach((o, i) => {
    if (kind(o) !== 'object') errors.push(`V12 non_blocking_open_items[${i}] 必须是对象`);
    else checkFields(o, { item: 'string', owner: 'string' }, `non_blocking_open_items[${i}]`, errors);
  });
  if (!bp.boundaries.every(isStr)) errors.push('V12 boundaries 每项必须是字符串');

  const referenced = new Set(bp.segments.flatMap((s) => s.requirement_refs ?? []));
  for (const r of bp.user_requirements) {
    if (referenced.has(r.id)) continue;
    if (GLOBAL_REQ_KINDS.has(r.kind)) {
      warnings.push(
        `用户要求 ${r.id}（${r.short}）属全局/流程类（kind=${r.kind}），不落单一段落，未被段落引用属预期。` +
        `须在 blueprints/${bp.case_id}.global-coverage.md 中显式承接（模块 prompt §4.1）`
      );
    } else {
      warnings.push(`用户要求 ${r.id}（${r.short}）未被任何段落引用，请确认它在全局层面生效`);
    }
  }
  return { errors, warnings, narrationAnchor };
}

const deliverable = (bp) => bp.blocking_gaps.length === 0 && bp.confirmation.status === 'confirmed';

function load(file) {
  const path = resolve(file);
  let bp;
  try { bp = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`读取失败 ${path}: ${e.message}`); process.exit(2); }
  const { errors, warnings, narrationAnchor } = validate(bp, path);
  return { path, bp, errors, warnings, narrationAnchor };
}

function reportValidation({ bp, errors, warnings }) {
  for (const e of errors) console.error(`  [错误] ${e}`);
  for (const w of warnings) console.error(`  [警告] ${w}`);
  if (!errors.length) console.error('  校验 V1–V13 全部通过（V13 旁白锚点：原文不匹配为错误；需求文档缺失时降级为警告）');
  return errors.length === 0;
}

function cmdParse(file, asJson) {
  const r = load(file);
  const ok = reportValidation(r);
  const summary = {
    file: r.path, blueprint_id: r.bp.blueprint_id, contract: r.bp.contract,
    segments: r.bp.segments.map((s) => ({ id: s.id, title: s.title, requirement_refs: s.requirement_refs })),
    user_requirements_count: r.bp.user_requirements.length,
    narration_mode: r.bp.narration_mode,
    narration_anchor: r.narrationAnchor,
    blocking_gaps: r.bp.blocking_gaps.map((g) => g.id),
    confirmation_status: r.bp.confirmation.status,
    deliverable_to_video: ok ? deliverable(r.bp) : false,
    valid: ok,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\n蓝图 ${summary.blueprint_id} ｜ 段落 ${r.bp.segments.length} ｜ 用户要求 ${summary.user_requirements_count} 条`);
    for (const s of summary.segments) console.log(`  ${s.id} ${s.title}  ← ${s.requirement_refs.join(', ') || '（无引用）'}`);
    console.log(`  旁白模式 ${summary.narration_mode} ｜ 确认状态 ${summary.confirmation_status}`);
    console.log(`  阻碍生成的缺失项 ${summary.blocking_gaps.length ? summary.blocking_gaps.join(', ') : '无'}`);
    console.log(`  deliverable_to_video = ${summary.deliverable_to_video}`);
  }
  if (!ok) process.exit(2);
  if (r.bp.blocking_gaps.length) process.exit(3);
  process.exit(0);
}

function renderView(bp, narrationAnchor) {
  const L = [];
  const statusText = {
    draft: '草稿（尚未提交确认）', pending_creator: '待创作者确认',
    confirmed: '创作者已确认', rework_requested: '创作者已提出修改',
  }[bp.confirmation.status];
  L.push(`# 蓝图确认单：《${bp.title}》`, '');
  L.push('> 这份文件是给创作者看的确认单，不含任何代码或动画技术细节。你只需要读它。');
  L.push(`> 版本 **${bp.blueprint_id}** ｜ 状态 **${statusText}** ｜ 段落 ${bp.segments.length} 段`);
  if (bp.derived_from) {
    L.push(`> 本版由 **${bp.derived_from}** 修改而来，旧版本文件已原样保留，可随时对照。`);
  }
  L.push('');
  const changed = bp.segments.filter((s) => s.rework);
  if (changed.length) {
    L.push('## 本次改了什么', '');
    for (const s of changed) {
      L.push(`**${s.id}《${s.title}》**`);
      L.push(`- 创作者意见：${s.rework.opinion}`);
      L.push(`- 意见来源：${s.rework.opinion_source}`);
      for (const a of s.rework.applied) L.push(`- 已落实：${a}`);
      for (const d of s.rework.needs_creator_decision) L.push(`- **待你拍板**：${d}`);
      L.push('');
    }
    L.push(`其余 ${bp.segments.length - changed.length} 段与 ${bp.derived_from} 完全一致，未作改动。`, '');
  }
  L.push('## 这条视频要让观众理解什么', '', bp.core_message, '');
  L.push('## 给谁看', '', bp.audience, '');
  L.push('## 播放顺序', '', '| 段落 | 标题 | 讲什么 |', '| --- | --- | --- |');
  for (const id of bp.narrative_order) {
    const s = bp.segments.find((x) => x.id === id);
    L.push(`| ${s.id} | ${s.title} | ${s.content} |`);
  }
  L.push('');
  if (bp.narration_mode === 'verbatim') {
    L.push('## 旁白（你的原话，逐字保留）', '', `> ${bp.user_narration}`, '');
    if (narrationAnchor === 'ok') {
      L.push('各段旁白按顺序拼接后与上面这段原文完全一致（V8），且脚本已在需求文档中逐字找到这段原话（V13）。', '');
    } else {
      L.push('各段旁白按顺序拼接后与上面这段原文完全一致（V8）。需求文档缺失，外部锚点核验跳过（V13 警告）。', '');
    }
  } else if (bp.narration_mode === 'rewritten') {
    const nr = bp.narration_rewrite || {};
    L.push('## 旁白（经创作者授权的改写版，不是你的原话）', '', `> ${bp.user_narration}`, '');
    L.push('**改写前你的原话：**', '', `> ${nr.original_narration || '（未登记）'}`, '');
    L.push(`**授权记录：** ${nr.authorization || '（未登记）'}`, '');
    if (narrationAnchor === 'ok') {
      L.push('各段旁白拼接与上面的改写版一致（V8）；改写版已逐字收录进需求文档，原话可在旧版需求文档中追溯（V13）。', '');
    } else {
      L.push('各段旁白拼接与上面的改写版一致（V8）。需求文档缺失，外部锚点核验跳过（V13 警告）。', '');
    }
  }
  L.push('## 逐段内容', '');
  const reqById = new Map(bp.user_requirements.map((r) => [r.id, r]));
  for (const s of bp.segments) {
    L.push(`### ${s.id} ｜ ${s.title}`, '');
    L.push(`**讲什么：** ${s.content}`, '');
    L.push(`**旁白：**`, '', `> ${s.narration || '（本段无旁白）'}`, '');
    L.push(`**画面意图：** ${s.visual_intent}`, '');
    if (s.requirement_refs.length) {
      const labels = s.requirement_refs.map((ref) => {
        const r = reqById.get(ref);
        return `${r.id} ${r.short}`;
      });
      L.push(`**本段要遵守的你提过的要求：** ${labels.join('；')}`, '');
      L.push('（每条要求的全文见文末附录）', '');
    }
    if (s.video_module_decides.length) {
      L.push('**这些没指定，由视频同学决定：**', '');
      for (const d of s.video_module_decides) L.push(`- ${d}`);
      L.push('');
    }
    if (s.rework) {
      L.push(`**本段返工记录（来自 ${s.rework.from_version}）：**`, '');
      L.push(`- 意见：${s.rework.opinion}`);
      for (const a of s.rework.applied) L.push(`- 已落实：${a}`);
      for (const d of s.rework.needs_creator_decision) L.push(`- 待你拍板：${d}`);
      L.push('');
    }
  }
  L.push('## 阻碍生成的缺失项', '');
  if (bp.blocking_gaps.length) {
    L.push('**以下信息缺失会导致蓝图无法生成，需要你补充：**', '');
    for (const g of bp.blocking_gaps) {
      L.push(`- **${g.id}｜${g.question}**`);
      L.push(`  - 为什么阻碍：${g.why_blocking}`);
      L.push(`  - 需要谁回答：${g.asked_to}`);
    }
  } else {
    L.push('无。现有需求已足够生成分段蓝图，不需要你补充信息。');
  }
  L.push('');
  L.push('## 不用你操心、由团队决定的事', '');
  if (bp.non_blocking_open_items.length) {
    for (const o of bp.non_blocking_open_items) L.push(`- ${o.item} —— 由 ${o.owner} 决定`);
  } else L.push('（无）');
  L.push('');
  if (bp.boundaries.length) {
    L.push('## 内容表述边界', '');
    for (const b of bp.boundaries) L.push(`- ${b}`);
    L.push('');
  }
  L.push('## 附录：你提过的要求（全文与出处）', '');
  L.push('下面是从需求文档里逐条摘出的你的明确要求。蓝图没有替你新增要求，也没有把我们的推测写成你的原话。', '');
  for (const r of bp.user_requirements) {
    L.push(`- **${r.id} ${r.short}**：${r.text}`);
    L.push(`  - 出处：${r.source}`);
  }
  L.push('');
  L.push('## 请你确认', '');
  L.push('看完成片或这份蓝图后，你可以直接这样说：');
  L.push('');
  L.push('- 同意：「蓝图可以，按这个做。」');
  L.push('- 改某一段：「第 1 段开场太快了，想让火锅多停一会儿。」');
  L.push('- 改整体：「顺序我想调一下，先讲美洲再讲火锅。」');
  L.push('');
  L.push('提意见时带上段落编号或标题最快；只描述内容也可以，我们会先复述定位到哪一段再动手。');
  L.push('修改会生成新版本（如 v2），旧版本保留，方便对照。');
  L.push('');
  L.push(`当前确认状态：${statusText}${bp.confirmation.note ? `（${bp.confirmation.note}）` : ''}`);
  if (bp.confirmation.confirmed_by) {
    L.push(`确认人：${bp.confirmation.confirmed_by} ｜ 确认时间：${bp.confirmation.confirmed_at}`);
  }
  L.push('');
  return L.join('\n');
}

function cmdView(file, out) {
  const r = load(file);
  if (!reportValidation(r)) process.exit(2);
  const target = resolve(out ?? r.path.replace(/\.json$/, '.view.md'));
  writeFileSync(target, renderView(r.bp, r.narrationAnchor), 'utf8');
  console.log(`\n人读视图已渲染：${target}`);
  process.exit(0);
}

function cmdDiff(oldFile, newFile, expect) {
  const a = load(oldFile), b = load(newFile);
  if (!reportValidation(a) || !reportValidation(b)) process.exit(2);
  const A = a.bp, B = b.bp;
  console.log(`\n语义 diff：${A.blueprint_id} → ${B.blueprint_id}`);

  const topChanged = [];
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    if (k === 'segments' || DIFF_ALLOWLIST.includes(k)) continue;
    if (!deepEqual(A[k], B[k])) topChanged.push(k);
  }
  const allowChanged = DIFF_ALLOWLIST.filter((k) => !deepEqual(A[k], B[k]));
  console.log(`  身份字段变化（白名单内，允许）：${allowChanged.join(', ') || '无'}`);
  console.log(`  白名单外顶层字段变化：${topChanged.length ? topChanged.join(', ') : '无'}`);

  const idsA = A.segments.map((s) => s.id), idsB = B.segments.map((s) => s.id);
  const added = idsB.filter((x) => !idsA.includes(x));
  const removed = idsA.filter((x) => !idsB.includes(x));
  const changedSegs = [], segPaths = [];
  for (const id of idsA.filter((x) => idsB.includes(x))) {
    const sa = A.segments.find((s) => s.id === id), sb = B.segments.find((s) => s.id === id);
    if (!deepEqual(sa, sb)) {
      changedSegs.push(id);
      diffPaths(sa, sb, id, segPaths);
    }
  }
  console.log(`  新增段落：${added.join(', ') || '无'} ｜ 删除段落：${removed.join(', ') || '无'}`);
  console.log(`  内容变化段落：${changedSegs.join(', ') || '无'}`);
  for (const p of segPaths) console.log(`    - ${p}`);

  let bad = false;
  if (topChanged.length) { console.error(`  [越界] 白名单外顶层字段被改动：${topChanged.join(', ')}`); bad = true; }
  if (added.length || removed.length) { console.error('  [越界] 段落被新增或删除'); bad = true; }
  if (!deepEqual(idsA, idsB)) { console.error('  [越界] 段落顺序被改动'); bad = true; }
  if (expect) {
    const want = expect.split(',').map((s) => s.trim()).filter(Boolean).sort();
    const got = [...changedSegs].sort();
    if (!deepEqual(want, got)) {
      console.error(`  [不符预期] 期望只有 ${want.join(', ')} 变化，实际 ${got.join(', ') || '无段落变化'}`);
      bad = true;
    } else console.log(`  符合预期：改动仅落在 ${want.join(', ')}`);
  }
  if (bad) process.exit(4);
  console.log('  diff 检查通过');
  process.exit(0);
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const positional = args.filter((a) => !a.startsWith('-'));
const optVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (cmd === 'parse' && positional[0]) cmdParse(positional[0], flag('--json'));
else if (cmd === 'view' && positional[0]) cmdView(positional[0], optVal('-o'));
else if (cmd === 'diff' && positional[0] && positional[1]) cmdDiff(positional[0], positional[1], optVal('--expect-segments'));
else {
  console.log(`用法：
  node WORK/tools/blueprint.mjs parse <blueprint.json> [--json]
  node WORK/tools/blueprint.mjs view  <blueprint.json> [-o <out.view.md>]
  node WORK/tools/blueprint.mjs diff  <old.json> <new.json> [--expect-segments S2]`);
  process.exit(2);
}