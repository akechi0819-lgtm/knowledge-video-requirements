import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export function createProjectModel(root) {
  const file = path.join(root, 'project-model.private.json')
  async function stored() {
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return null; throw e }
  }
  async function resolve() {
    return await stored() || { endpoint: process.env.WORKBENCH_MODEL_ENDPOINT || '', model: process.env.WORKBENCH_MODEL_NAME || '', key: process.env.WORKBENCH_MODEL_KEY || '' }
  }
  async function view() {
    const { endpoint, model, key } = await resolve()
    return { ok: true, endpoint, model, hasKey: Boolean(key) }
  }
  async function save(input = {}) {
    const endpoint = String(input.endpoint || '').trim(), model = String(input.model || '').trim()
    let url
    try { url = new URL(endpoint) } catch { throw new Error('请输入完整模型接口地址。') }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (!['https:', 'http:'].includes(url.protocol) || (!local && url.protocol !== 'https:') || url.username || url.password || url.hash || url.search) throw new Error('模型接口应使用 HTTPS，本机环回可以使用 HTTP，地址不能包含凭据或参数。')
    if (!model || model.length > 200) throw new Error('请填写模型名称。')
    const old = await resolve()
    const key = String(input.key || '').trim() || (old.endpoint === endpoint ? old.key : '')
    if (!key && !local) throw new Error('远程模型需要密钥；更换地址时请重新填写。')
    if (key.length > 10000) throw new Error('密钥过长。')
    await mkdir(root, { recursive: true })
    const temp = path.join(root, `.project-model-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify({ endpoint, model, key }) + '\n', { mode: 0o600 })
    await rename(temp, file)
    return { ok: true, endpoint, model, hasKey: Boolean(key) }
  }
  return { resolve, view, save, isSaved: async () => Boolean(await stored()) }
}
