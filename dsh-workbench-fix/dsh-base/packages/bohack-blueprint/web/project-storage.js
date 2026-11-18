import { openLocalProjects } from '/bohack/local-projects.js'

const store = openLocalProjects()
const controls = document.createElement('details')
controls.className = 'local-projects'
controls.innerHTML = `
  <summary><svg class="icon" aria-hidden="true"><use href="#icon-folder"/></svg><span class="utility-label">项目存档</span></summary>
  <div class="local-projects-panel">
    <button class="ghost" type="button">保存到本机</button>
    <div class="local-projects-row"><select aria-label="本机项目"></select><button class="primary" type="button">恢复</button></div>
    <output aria-live="polite"></output>
  </div>`
document.querySelector('.utility').prepend(controls)
const [save, restore] = controls.querySelectorAll('button')
const list = controls.querySelector('select')
const status = controls.querySelector('output')
document.addEventListener('click', event => {
  if (!controls.contains(event.target)) controls.open = false
})
async function refreshLocal() {
  list.replaceChildren(new Option('选择本机项目', ''), ...(await store.list()).map(project => new Option(project.title, project.id)))
}
async function run(task) {
  save.disabled = restore.disabled = true
  try { await task() } catch (error) { status.textContent = '操作失败：' + error.message }
  finally { save.disabled = restore.disabled = false }
}
async function saveCurrent() {
  status.textContent = '正在保存到本机…'
  const threadId = state.threadId
  if (!threadId) throw new Error('请先打开创作')
  const title = state.threads.find(thread => thread.id === threadId)?.title || '创作'
  const { snapshot } = await api('/bohack/api/projects/export', {}, threadId)
  await store.save({ id: threadId, title, snapshot })
  await refreshLocal()
  status.textContent = '已保存到本机'
}
save.onclick = () => run(saveCurrent)
restore.onclick = () => run(async () => {
  status.textContent = '正在读取本机项目…'
  const project = await store.get(list.value)
  if (!project) throw new Error('请选择本机项目')
  status.textContent = '正在上传项目…'
  const result = await apiFetch('/bohack/api/projects/import', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(project.snapshot),
  })
  const restored = await result.json()
  if (!result.ok || !restored.ok) throw new Error(restored.error || '恢复失败')
  status.textContent = '正在载入项目…'
  await loadThreads()
  await selectThread(restored.thread.id)
  status.textContent = '已恢复'
})
await run(refreshLocal)
setInterval(() => {
  if (state.threadId && !state.busy && !save.disabled && state.status?.production?.status !== 'running') run(saveCurrent)
}, 30000)
