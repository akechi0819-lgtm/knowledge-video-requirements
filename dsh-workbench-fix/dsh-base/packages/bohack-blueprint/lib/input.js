/**
 * Requirement input adapters.
 *
 * One contract: loadRequirement(source) -> { text, meta, provenance }.
 * Downstream (ingest and everything after it) never learns where the text came
 * from. When teammates decide how requirements are delivered, add one adapter
 * here; no other file needs to change.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export class InputError extends Error {}

function safeName(name) {
  const base = path.basename(String(name || '需求.md'))
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || '需求.md'
}

/** paste: text pasted into the temporary UI. */
async function fromPaste(source, dirs) {
  const text = String(source.text ?? '')
  if (!text.trim()) throw new InputError('粘贴内容为空')
  return {
    text,
    meta: { adapter: 'paste', label: source.label || 'UI 粘贴', bytes: Buffer.byteLength(text, 'utf8') },
    provenance: '手动粘贴',
  }
}

/** file: read a file already sitting in workspace/inbox/. */
async function fromFile(source, dirs) {
  const name = safeName(source.path)
  const target = path.resolve(dirs.inbox, name)
  if (!target.startsWith(path.resolve(dirs.inbox) + path.sep)) throw new InputError('路径越出 inbox/')
  const s = await stat(target).catch(() => null)
  if (!s || !s.isFile()) throw new InputError(`inbox/ 下找不到文件：${name}`)
  const text = await readFile(target, 'utf8')
  if (!text.trim()) throw new InputError(`文件为空：${name}`)
  return {
    text,
    meta: { adapter: 'file', label: name, bytes: s.size, modifiedAt: s.mtime.toISOString() },
    provenance: `workspace/inbox/${name}`,
  }
}

/** local sample: bundled with the workbench so the UI is testable with no upstream file. */
async function fromSample(source, dirs) {
  const target = path.resolve(dirs.rules, '..', 'inbox', '演示视频需求_没有美洲火锅会少什么.md')
  const text = await readFile(target, 'utf8').catch(() => null)
  if (text === null) throw new InputError('示例需求缺失：workspace/inbox/演示视频需求_没有美洲火锅会少什么.md')
  return {
    text,
    meta: { adapter: 'sample', label: '火锅演示需求（内置样例）' },
    provenance: '团队 23:42 演示需求（内置样例，非上游实时交付）',
  }
}

const ADAPTERS = { paste: fromPaste, file: fromFile, sample: fromSample }

export async function loadRequirement(source, dirs) {
  const kind = String(source?.kind || 'paste')
  const adapter = ADAPTERS[kind]
  if (!adapter) throw new InputError(`未知输入适配器：${kind}（可用：${Object.keys(ADAPTERS).join(', ')}）`)
  return adapter(source, dirs)
}

export const availableAdapters = Object.keys(ADAPTERS)
