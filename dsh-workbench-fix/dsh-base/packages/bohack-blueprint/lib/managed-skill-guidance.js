import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// The selected package is resolved by resolveProductionSkill; never expose files
// outside that Skill, even when an internal path traverses a symbolic link.
export async function loadManagedSkillGuidance(selectedPackage) {
  const root = await realpath(selectedPackage.directory)
  async function readSkillFile(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Skill 文件路径必须是相对路径。')
    }
    const target = await realpath(path.resolve(root, relativePath))
    if (!target.startsWith(root + path.sep)) throw new Error('不能读取 Skill 目录之外的文件。')
    const bytes = await readFile(target)
    if (bytes.includes(0)) throw new Error('Skill 文件必须是文本。')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('Skill 文件必须是 UTF-8 文本。') }
  }
  const document = await readSkillFile('SKILL.md')
  let stage
  try { stage = JSON.parse(await readSkillFile('jiangjie.stage.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const value of [stage, selectedPackage.stage]) {
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.entries(value).some(([key, enabled]) => !['topBar', 'tailCard'].includes(key) || typeof enabled !== 'boolean')) {
      throw new Error('舞台声明仅支持布尔值 topBar 与 tailCard。')
    }
  }
  const details = { name: selectedPackage.name, skill: selectedPackage.skill, mode: selectedPackage.mode, references: selectedPackage.references }
  return {
    prompt: `所选制作 Skill 的包信息：\n${JSON.stringify(details, null, 2)}\n\nSKILL.md：\n${document}`,
    readSkillFile,
    stage: { ...stage, ...selectedPackage.stage },
  }
}
