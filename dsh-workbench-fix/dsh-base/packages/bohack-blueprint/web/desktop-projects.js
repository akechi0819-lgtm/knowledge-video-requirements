const button = document.createElement('button')
button.type = 'button'
button.className = 'ghost'
button.textContent = '导入项目包'
const picker = document.createElement('input')
picker.type = 'file'
picker.accept = '.json,application/json'
picker.hidden = true
document.querySelector('.utility').prepend(button, picker)
button.onclick = () => picker.click()
picker.onchange = async () => {
  const file = picker.files[0]
  if (!file) return
  button.disabled = true
  button.textContent = '正在导入…'
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('项目包超过 100 MB')
    const response = await apiFetch('/bohack/api/projects/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: file,
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    await loadThreads()
    await selectThread(result.thread.id)
  } catch (error) {
    window.alert('导入项目包失败：' + error.message)
  } finally {
    picker.value = ''
    button.disabled = false
    button.textContent = '导入项目包'
  }
}
