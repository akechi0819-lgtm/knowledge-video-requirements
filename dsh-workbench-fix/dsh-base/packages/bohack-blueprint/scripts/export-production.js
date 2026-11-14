import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBlueprint, validateBlueprint } from '../lib/blueprint.js'

export function requestedDuration(requirements) {
  const values = requirements.flatMap(text => {
    if (!/(时长|片长|视频|成片|全片)/.test(text) || /不超过|以内|至少|以上|每段|每个/.test(text)) return []
    return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(秒|分钟)/g)]
      .map(m => Number(m[1]) * (m[2] === '分钟' ? 60 : 1))
  }).filter(n => n > 0)
  return values.length && values.every(n => n === values[0]) ? values[0] : null
}

// Read the delivery snapshot, but verify it still corresponds to the finalized
// version and confirmations: a later edit can leave the old delivery on disk.
export async function exportProduction(workspace) {
  const outbox = path.join(path.resolve(workspace), 'outbox')
  const [delivery, stateText, names] = await Promise.all([
    readFile(path.join(outbox, '交付.md'), 'utf8'),
    readFile(path.join(outbox, '状态.json'), 'utf8'),
    readdir(outbox),
  ])
  const state = JSON.parse(stateText)
  const n = state.finalized?.version
  const versions = names.map(name => /^蓝图_v(\d+)\.md$/.exec(name)).filter(Boolean).map(m => Number(m[1]))
  if (state.stage !== 'finalized' || !Number.isInteger(n) || n < 1 || state.finalized.file !== 'outbox/交付.md' || Math.max(...versions) !== n) {
    throw new Error('交付状态不是当前定稿，不能导出')
  }
  const marker = '\n---\n\n'
  const at = delivery.indexOf(marker)
  const header = delivery.slice(0, at)
  const embedded = delivery.slice(at + marker.length).trimEnd()
  const versionText = (await readFile(path.join(outbox, `蓝图_v${n}.md`), 'utf8')).trimEnd()
  const versionLine = header.split('\n').find(line => line.startsWith('- **版本：** '))
  const acceptedVersions = [`- **版本：** v${n}（已定稿）`, `- **版本：** v${n}（已采纳，交视频同学）`]
  if (at < 0 || !header.startsWith('# 交付蓝图：') || !acceptedVersions.includes(versionLine) || embedded !== versionText) {
    throw new Error('交付文件与定稿版本不一致')
  }
  const doc = parseBlueprint(embedded)
  const check = validateBlueprint(doc)
  if (!check.ok || (doc.meta['版本'] && doc.meta['版本'] !== `v${n}`)) throw new Error(`蓝图无效或版本不一致：${check.errors.join('；')}`)
  const confirmed = state.confirmed?.[`v${n}`]
  if (!Array.isArray(confirmed) || doc.sections.some(s => !confirmed.includes(s.id))) throw new Error('定稿段落确认记录不完整')
  return {
    status: '准备制作', version: `v${n}`, topic: doc.topic,
    userRequirements: doc.userRequirements, notes: doc.notes.trim(),
    targetDurationSeconds: requestedDuration(doc.userRequirements),
    sections: doc.sections.map((s, i) => ({
      id: `S${String(i + 1).padStart(2, '0')}`, blueprintId: s.id,
      title: s.title, intent: s.intent, facts: s.facts, visual: s.visual,
      narration: s.narration || null, notes: s.notes,
      gaps: [...(!s.facts.length ? ['关键事实未提供'] : []), ...(!s.narration ? ['旁白未提供'] : [])],
    })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('用法：node scripts/export-production.js <工作区目录>')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await exportProduction(process.argv[2]), null, 2)) }
    catch (error) { console.error(`导出失败：${error.message}`); process.exitCode = 1 }
  }
}
