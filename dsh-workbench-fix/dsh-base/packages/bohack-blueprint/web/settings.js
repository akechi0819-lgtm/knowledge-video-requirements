/* 工作台模型配置和风格 Skill 管理。 */
(() => {
  // 服务端要求所有 POST 带 x-bohack-client（跨域简单请求带不上该自定义头）。
  const apiFetch = (url, opt={}) => fetch(url, {...opt, headers:{...opt.headers, 'x-bohack-client':'1'}})
  const dialog = document.createElement('dialog')
  dialog.className = 'ws-dialog'
  dialog.setAttribute('aria-labelledby', 'ws-title')
  dialog.innerHTML = `<div class="ws-inner"><div class="ws-head"><h2 id="ws-title">工作台设置</h2><button class="ws-close" type="button" aria-label="关闭设置"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><form><section class="ws-section"><p class="ws-help">1. 配置通用模型密钥　2. 配置配音密钥与音色　3. 保存设置。密钥留空会保留已保存的密钥。</p><h3>通用文本 / 代码模型</h3><p class="ws-help ws-model-scope"></p><label class="ws-field">API 密钥<input name="apiKey" type="password" autocomplete="new-password"></label><label class="ws-field"><input name="modelClear" type="checkbox"> 清除已保存的密钥</label><p class="ws-help ws-key-state" style="margin-top:8px"></p><p class="ws-help ws-model-default"></p><details><summary>连接详情</summary><div class="ws-grid"><label class="ws-field full">接口地址<input name="baseUrl" type="url" placeholder="https://…" autocomplete="url"></label><label class="ws-field">模型名称<input name="model" autocomplete="off"></label></div></details></section><section class="ws-section"><h3>配音 TTS</h3><p class="ws-help">用于成片配音。共享密钥仅适用于同一服务商。</p><label class="ws-field"><input name="ttsUseTextKey" type="checkbox"> 使用通用模型的 Key</label><div class="ws-tts-independent"><label class="ws-field">API 密钥<input name="ttsApiKey" type="password" autocomplete="new-password"></label><label class="ws-field"><input name="ttsClear" type="checkbox"> 清除已保存的密钥</label><p class="ws-help ws-tts-key-state"></p></div><label class="ws-field">音色<input name="ttsVoice"></label><details><summary>连接详情</summary><div class="ws-grid"><label class="ws-field full">完整接口地址<input name="ttsBaseUrl" type="url"></label><label class="ws-field">模型名称<input name="ttsModel"></label><label class="ws-field">协议<select name="ttsProtocol"><option value="speech">speech</option><option value="mimo">mimo</option></select></label></div></details></section><section class="ws-section"><h3>生图</h3><p class="ws-help">暂未接入制作，无需配置。</p></section><section class="ws-section ws-advanced"><details><summary>高级设置：独立路由</summary><p class="ws-help">需要单独指定模型时使用；折叠不会清除已填写的内容。</p><div class="ws-agent-routes"></div><div class="ws-tool-routes"></div></details></section><p class="ws-status" role="status" aria-live="polite"></p><div class="ws-actions"><button class="ws-cancel ghost" type="button">取消</button><button class="ws-save primary" type="submit">保存设置</button></div></form></div>`
  const agentKinds = [['requirementAgent','需求 Agent'], ['blueprintAgent','蓝图 Agent'], ['videoAgent','视频 Agent']]
  const toolKinds = [['assetModel','素材图工具'], ['previewModel','蓝图示意工具'], ['styleAnalysisModel','风格分析工具']]
  const formRoot = dialog.querySelector('form')
  for (const [kind, title] of agentKinds) {
    const section = document.createElement('section'); section.className = 'ws-section'
    section.innerHTML = `<h3>${title}</h3><p class="ws-help">填写 DSH 宿主的 provider ID 和模型名；留空沿用原默认配置。更改后下一次调用会创建新的 Agent 会话。</p><div class="ws-grid"><label class="ws-field">Provider ID<input name="${kind}Provider"></label><label class="ws-field">模型名称<input name="${kind}Model"></label></div>`
    formRoot.querySelector('.ws-agent-routes').append(section)
  }
  for (const [kind, title] of toolKinds) {
    const section = document.createElement('section'); section.className = 'ws-section'
    section.innerHTML = `<h3>${title}</h3><p class="ws-help">留空继承通用模型；配置接口地址后使用此处模型。密钥留空保留已保存密钥。</p><div class="ws-grid"><label class="ws-field full">接口地址<input name="${kind}BaseUrl" type="url"></label><label class="ws-field">模型名称<input name="${kind}Model"></label><label class="ws-field">API 密钥<input name="${kind}ApiKey" type="password" autocomplete="new-password"></label></div><label class="ws-field"><input name="${kind}Clear" type="checkbox"> 清除已保存的密钥</label><p class="ws-help ws-${kind}-key-state"></p>`
    formRoot.querySelector('.ws-tool-routes').append(section)
  }
  document.body.append(dialog)
  const form = dialog.querySelector('form')
  const status = dialog.querySelector('.ws-status')
  const ttsProvider = document.createElement('select')
  ttsProvider.name = 'ttsProvider'
  ttsProvider.add(new Option('小米 MiMo', 'mimo'))
  ttsProvider.add(new Option('其他服务（OpenAI 兼容）', 'custom'))
  const providerLabel = document.createElement('label')
  providerLabel.className = 'ws-field'
  providerLabel.append('配音服务', ttsProvider)
  const ttsSection = form.elements.ttsVoice.closest('section')
  ttsSection.querySelector('h3').after(providerLabel)
  const voiceField = form.elements.ttsVoice.closest('label')
  voiceField.firstChild.textContent = '音色 ID / Voice ID'
  form.elements.ttsVoice.placeholder = '填写当前配音服务支持的音色 ID'
  const voiceHelp = document.createElement('p')
  voiceHelp.className = 'ws-help'
  voiceHelp.textContent = '音色由配音服务提供。其他服务请填写其文档中的音色 ID，不使用 MiMo 的音色名称。'
  voiceField.after(voiceHelp)
  ttsProvider.addEventListener('change', () => {
    const mimo = ttsProvider.value === 'mimo'
    form.elements.ttsBaseUrl.value = mimo ? 'https://api.xiaomimimo.com/v1' : ''
    form.elements.ttsModel.value = mimo ? 'mimo-v2.5-tts' : ''
    form.elements.ttsProtocol.value = mimo ? 'mimo' : 'speech'
    form.elements.ttsVoice.value = mimo ? '茉莉' : ''
    form.elements.ttsApiKey.value = ''
    form.elements.ttsUseTextKey.checked = mimo
    form.elements.ttsClear.checked = false
    updateTtsKey()
  })
  const tabs = document.createElement('nav'); tabs.className = 'ws-tabs'; tabs.setAttribute('aria-label', '设置分区')
  const modelPanel = document.createElement('div'); modelPanel.className = 'ws-panel'; modelPanel.dataset.panel = 'model'
  const stylePanel = document.createElement('div'); stylePanel.className = 'ws-panel'; stylePanel.dataset.panel = 'styles'
  const sections = [...form.querySelectorAll(':scope > section')]
  sections.forEach(section => modelPanel.append(section))
  form.prepend(tabs, modelPanel)
  form.after(stylePanel)
  let activePanel = 'model'
  function showPanel(name) {
    activePanel = name
    if(name==='styles') loadStyles()
    dialog.querySelector('.ws-inner').scrollTop=0
    for (const panel of [modelPanel, stylePanel]) panel.hidden = panel.dataset.panel !== name
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.dataset.panel === name))
    dialog.querySelector('.ws-actions').hidden = name === 'styles'
  }
  for (const [name, label] of [['model','模型配置'], ['styles','风格 Skill 管理']]) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.panel = name; button.textContent = label
    button.onclick = () => showPanel(name); tabs.append(button)
  }
  showPanel('model')
  let data = null
  let threadId = null
  async function request(body) {
    const response = await apiFetch('/bohack/api/settings', body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error || `请求失败（${response.status}）`)
    return result.settings || result
  }
  async function load() { data = await request(); return data }
  const resetPickers = []
  for (const [kind, title, modelField, urlField, keyField] of [
    ['model','通用','model','baseUrl','apiKey'],
  ]) {
    const field=form.elements[modelField], address=form.elements[urlField], key=form.elements[keyField]
    const label=field.closest('label'), outer=document.createElement('div')
    label.replaceWith(outer); outer.append(label)
    const button=document.createElement('button'), choices=document.createElement('select'), message=document.createElement('small')
    button.type='button'; button.className='ws-fetch'; button.textContent='获取模型'
    button.setAttribute('aria-label','获取'+title+'模型')
    choices.className='ws-model-options'; choices.setAttribute('aria-label',title+'可用模型'); choices.hidden=true
    field.placeholder='获取列表或输入模型名'
    message.setAttribute('role','status'); message.className='ws-model-message'
    label.after(choices,button,message)
    let revision=0
    function reset(){
      revision++; choices.hidden=true; choices.replaceChildren(); field.hidden=false
      message.textContent=''; button.disabled=false;button.textContent='获取模型'
    }
    resetPickers.push(reset)
    for(const control of [address,key,form.elements[kind+'Clear']]) control.addEventListener('input',reset)
    choices.onchange=()=>{field.value=choices.value}
    button.onclick=async()=>{
      const current=++revision
      button.disabled=true;button.textContent='获取中…';message.textContent=''
      try {
        const response=await apiFetch('/bohack/api/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,baseUrl:address.value.trim(),apiKey:key.value,clearApiKey:form.elements[kind+'Clear'].checked})})
        const result=await response.json()
        if(current!==revision) return
        if(!response.ok || result.ok===false) throw new Error(result.error || '获取失败')
        if(!result.models?.length) throw new Error('服务未返回可选模型，可手动输入模型名。')
        const value=field.value
        choices.replaceChildren(new Option('请选择模型',''))
        for(const id of new Set(result.models)) choices.add(new Option(id,id))
        if(value && !result.models.includes(value)) choices.add(new Option(value+'（当前设置）',value))
        choices.value=value;choices.hidden=false;field.hidden=true
        choices.focus()
        message.textContent='已获取 '+result.models.length+' 个模型'
      }catch(e){if(current===revision){message.textContent=e.message;choices.hidden=true;field.hidden=false}}
      finally{if(current===revision){button.disabled=false;button.textContent='获取模型'}}
    }
  }
  function drawForm() {
    resetPickers.forEach(reset=>reset())
    form.elements.baseUrl.value = data.model?.baseUrl || ''
    form.elements.model.value = data.model?.model || ''
    form.elements.apiKey.value = ''
    dialog.querySelector('.ws-key-state').textContent = data.model?.hasApiKey ? '已保存密钥。' : '尚未保存密钥。'
    for (const kind of ['tts']) {
      for (const field of ['baseUrl', 'model', ...(kind === 'tts' ? ['voice', 'protocol'] : [])]) {
        form.elements[kind + field[0].toUpperCase() + field.slice(1)].value = data[kind]?.[field] || (field === 'protocol' ? 'speech' : '')
      }
      form.elements[kind + 'ApiKey'].value = ''
      dialog.querySelector('.ws-' + kind + '-key-state').textContent = data[kind]?.hasApiKey ? '已保存密钥。' : '尚未保存密钥。'
    }
    for (const [kind] of agentKinds) for (const field of ['provider', 'model']) form.elements[kind + field[0].toUpperCase() + field.slice(1)].value = data[kind]?.[field] || ''
    for (const [kind] of toolKinds) {
      for (const field of ['baseUrl', 'model']) form.elements[kind + field[0].toUpperCase() + field.slice(1)].value = data[kind]?.[field] || ''
      form.elements[kind + 'ApiKey'].value = ''
      dialog.querySelector('.ws-' + kind + '-key-state').textContent = data[kind]?.hasApiKey ? '已保存密钥。' : '尚未保存密钥。'
    }
    for (const kind of ['model', 'tts', ...toolKinds.map(([k]) => k)]) form.elements[kind + 'Clear'].checked = false
    form.elements.ttsUseTextKey.checked = data.tts?.useTextKey === true
    ttsProvider.value = data.tts?.provider || (data.tts?.baseUrl?.startsWith('https://api.xiaomimimo.com/') ? 'mimo' : 'custom')
    updateTtsKey()
    const cloud = data.capabilities?.cloudManagedModel === true
    form.elements.baseUrl.readOnly = cloud
    form.elements.model.readOnly = cloud
    dialog.querySelector('.ws-fetch').disabled = cloud
    const routes = dialog.querySelector('.ws-agent-routes')
    routes.hidden = cloud
    dialog.querySelector('.ws-model-scope').textContent = cloud ? '云端统一用于需求、蓝图、视频 Agent 和默认工具模型。' : '用于成片场景和默认工具模型；本地 Agent 路由可在高级设置中配置。'
    dialog.querySelector('.ws-model-default').textContent = '当前默认模型：' + (data.model?.model || '未设置')

  }
  function updateTtsKey() {
    let sameProvider = false
    try { sameProvider = new URL(form.elements.baseUrl.value).origin === new URL(form.elements.ttsBaseUrl.value).origin } catch { sameProvider = false }
    form.elements.ttsUseTextKey.disabled = !sameProvider
    if (!sameProvider) form.elements.ttsUseTextKey.checked = false
    form.elements.ttsVoice.required = !!form.elements.ttsBaseUrl.value
    dialog.querySelector('.ws-tts-independent').hidden = form.elements.ttsUseTextKey.checked
  }
  form.elements.baseUrl.addEventListener('input', updateTtsKey)
  form.elements.ttsBaseUrl.addEventListener('input', updateTtsKey)
  form.elements.ttsUseTextKey.addEventListener('change', updateTtsKey)
  dialog.querySelector('.ws-close').onclick = () => dialog.close()
  dialog.querySelector('.ws-cancel').onclick = () => dialog.close()
  form.addEventListener('submit', async event => {
    event.preventDefault(); status.textContent = ''; const save = dialog.querySelector('.ws-save'); save.disabled = true
    try {
      const extra = {}
      if (!data.capabilities?.cloudManagedModel) for (const [kind] of agentKinds) extra[kind] = { provider: form.elements[kind + 'Provider'].value.trim(), model: form.elements[kind + 'Model'].value.trim() }
      for (const [kind] of toolKinds) extra[kind] = { baseUrl: form.elements[kind + 'BaseUrl'].value.trim(), model: form.elements[kind + 'Model'].value.trim(), apiKey: form.elements[kind + 'ApiKey'].value, clearApiKey: form.elements[kind + 'Clear'].checked }
      status.textContent = '正在保存…'
      await request({
        ...extra,
        model: {
          baseUrl: form.elements.baseUrl.value.trim(),
          model: form.elements.model.value.trim(),
          apiKey: form.elements.apiKey.value,
          clearApiKey: form.elements.modelClear.checked,
        },
        tts: {
          provider: ttsProvider.value,
          baseUrl: form.elements.ttsBaseUrl.value.trim(),
          model: form.elements.ttsModel.value.trim(),
          voice: form.elements.ttsVoice.value.trim(),
          protocol: form.elements.ttsProtocol.value.trim(),
          useTextKey: form.elements.ttsUseTextKey.checked,
          apiKey: form.elements.ttsUseTextKey.checked ? '' : form.elements.ttsApiKey.value,
          clearApiKey: !form.elements.ttsUseTextKey.checked && form.elements.ttsClear.checked,
        },
      })
      await load(); drawForm(); status.textContent = '设置已保存。'
    } catch (error) { status.textContent = `保存失败：${error.message}` } finally { save.disabled = false }
  })
  window.BohackSettings = {
    async open(panel = 'model') {
      showPanel(panel)
      status.textContent = '正在读取设置…'; form.querySelectorAll('input,button[type=submit]').forEach(el => el.disabled = true)
      dialog.showModal()
      try { await load(); form.querySelectorAll('input,button[type=submit]').forEach(el => el.disabled = false); drawForm(); status.textContent = '' }
      catch (error) { status.textContent = `读取设置失败：${error.message}` }
    },
    setThread(id) { threadId = id },
    mountStylePanel(panel) { panel.classList.remove('pane'); panel.classList.add('ws-style-content'); stylePanel.append(panel) },
  }
})()

// 原有风格面板继续复用现有导入和视频处理逻辑。
window.BohackSettings.mountStylePanel(document.getElementById('pane-styles'))
var styleFileName = '', videoPreviewUrl = ''
async function loadStyles(){
  const thread=state.threadId
  try {
    const data=await api('/bohack/api/styles'); if(thread!==state.threadId) return
    state.styleLibrary=data.styles; if(state.status) renderFilm(state.status)
    const visible=(data.styles||[]).filter(style=>style.kind==='style'||(!style.kind && !String(style.id||'').startsWith('repo-skill:')))
    document.querySelector('#styleList').innerHTML=visible.map(style=>`<div class="leaf" style="margin-bottom:8px"><b>${esc(style.name)}</b><p class="hint">${esc(style.summary || style.description.split(/[。\n]/).find(Boolean) || '')}</p>${style.source?.kind==='builtin'?'':`<details><summary>管理</summary><button class="sm ghost" data-style-edit="${esc(style.id)}">编辑</button><a href="/bohack/api/style-export?id=${encodeURIComponent(style.id)}${thread?'&amp;threadId='+encodeURIComponent(thread):''}" download="SKILL.md">导出</a><button class="sm ghost" data-style-remove="${esc(style.id)}">移除</button></details>`}</div>`).join('')
    document.querySelector('#styleList').querySelectorAll('[data-style-edit]').forEach(b=>b.addEventListener('click',()=>{
      const item=data.styles.find(s=>s.id===b.dataset.styleEdit); if(!item) return
      const card=b.closest('.leaf'); card.innerHTML=`<input class="style-edit-name" value="${esc(item.name)}" style="width:100%"><textarea class="style-edit-text" style="width:100%;min-height:140px">${esc(item.description)}</textarea><button class="sm primary style-edit-save">保存</button><button class="sm ghost style-edit-cancel">取消</button>`
      card.querySelector('.style-edit-save').addEventListener('click',async()=>{try{await api('/bohack/api/styles-update',{id:item.id,name:card.querySelector('.style-edit-name').value,description:card.querySelector('.style-edit-text').value}); if(thread!==state.threadId) return; document.querySelector('#styleMessage').textContent='已更新风格库；成片页可应用更新后的风格。'; await loadStyles()}catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}})
      card.querySelector('.style-edit-cancel').addEventListener('click',loadStyles)
    }))
    document.querySelector('#styleList').querySelectorAll('[data-style-remove]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('从个人风格库移除这个风格？')) return; try{await api('/bohack/api/styles-remove',{id:b.dataset.styleRemove}); if(thread!==state.threadId) return; await loadStyles(); if(state.threadId) await refresh()}catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}}))
  }catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}
}
document.querySelector('#styleVideo').addEventListener('change', e=>{
  if(videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl)
  videoPreviewUrl=''; document.querySelector('#styleVideoResult').replaceChildren()
  const file=e.target.files[0], video=document.querySelector('#styleVideoPreview')
  if(!file){video.style.display='none';video.removeAttribute('src');return}
  videoPreviewUrl=URL.createObjectURL(file); video.src=videoPreviewUrl; video.style.display='block'
})
document.querySelector('#styleVideoAnalyze').addEventListener('click',async()=>{
  const thread=state.threadId, file=document.querySelector('#styleVideo').files[0]
  if(!file){document.querySelector('#styleMessage').textContent='请先选择参考视频。';return}
  const ext=file.name.split('.').pop().toLowerCase()
  if(!['mp4','mov','webm'].includes(ext)){ document.querySelector('#styleMessage').textContent='请选择 MP4、MOV 或 WebM 视频。';return }
  if(file.size>500*1024*1024){ document.querySelector('#styleMessage').textContent='视频超过 500 MB 上限。';return }
  const button=document.querySelector('#styleVideoAnalyze'); button.disabled=true; document.querySelector('#styleMessage').textContent='正在从参考视频抽帧并提取视觉规则，完成后可对照原片审阅。'
  try{
    const response=await fetch('/bohack/api/style-video?threadId='+encodeURIComponent(thread),{method:'POST',headers:{'content-type':'application/octet-stream','x-video-extension':ext,'x-bohack-client':'1'},body:file})
    const data=await response.json(); if(!response.ok || !data.ok) throw new Error(data.error || '视频学习失败')
    if(thread!==state.threadId || document.querySelector('#styleVideo').files[0]!==file) return
    const result=document.querySelector('#styleVideoResult')
    result.innerHTML=`<p class="hint">已分析 ${esc(data.evidence.durationSeconds)} 秒，抽取 ${data.evidence.frames.length} 帧。请核对并修改后保存。</p><div id="styleVideoTimes" style="display:flex;gap:6px;flex-wrap:wrap"></div><input id="learnedStyleName" placeholder="风格名称" style="width:100%"><textarea id="learnedStyleDraft" style="width:100%;min-height:180px"></textarea><button class="sm primary" id="saveLearnedStyle">保存到风格库</button>`
    for(const frame of data.evidence.frames){ const t=Number(frame.seconds); if(!Number.isFinite(t) || t<0) continue; const b=document.createElement('button'); b.className='sm ghost'; b.textContent=`${t.toFixed(1)} 秒`; b.addEventListener('click',()=>{const video=document.querySelector('#styleVideoPreview'); video.currentTime=t; video.play().catch(()=>{})}); document.querySelector('#styleVideoTimes').appendChild(b) }
    document.querySelector('#learnedStyleName').value=file.name.replace(/\.[^.]+$/,'')+'风格'
    document.querySelector('#learnedStyleDraft').value=data.draft
    document.querySelector('#saveLearnedStyle').addEventListener('click',async()=>{try{
      await api('/bohack/api/styles-import',{name:document.querySelector('#learnedStyleName').value,description:document.querySelector('#learnedStyleDraft').value,source:{kind:'video',label:file.name}})
      if(thread!==state.threadId) return
      document.querySelector('#styleMessage').textContent='已存入个人风格库，可在成片页选择。'; result.replaceChildren(); await loadStyles()
    }catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}})
    document.querySelector('#styleMessage').textContent='学习结果已生成，请审阅。'
  }catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}
  finally{button.disabled=false}
})
document.querySelector('#styleFile').addEventListener('change',async e=>{
  const thread=state.threadId, file=e.target.files[0]; if(!file) return
  if(file.size>100000){ document.querySelector('#styleMessage').textContent='文件超过 10 万字节。'; return }
  const content=await file.text(); if(thread!==state.threadId) return
  styleFileName=file.name; document.querySelector('#styleText').value=content
  if(!document.querySelector('#styleName').value) document.querySelector('#styleName').value=file.name.replace(/\.(md|txt)$/i,'')
})
document.querySelector('#styleGithub').addEventListener('click',async()=>{
  const thread=state.threadId
  try{ const r=await api('/bohack/api/style-github',{url:document.querySelector('#styleSource').value.trim()}); if(thread!==state.threadId) return; document.querySelector('#styleName').value=r.name; document.querySelector('#styleText').value=r.content; document.querySelector('#styleSource').value=r.source; document.querySelector('#styleMessage').textContent='已读取，请查看正文后保存。' }catch(e){ if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message }
})
document.querySelector('#styleImport').addEventListener('click',async()=>{
  const source=document.querySelector('#styleSource').value.trim(), thread=state.threadId
  try{
    await api('/bohack/api/styles-import',{name:document.querySelector('#styleName').value,description:document.querySelector('#styleText').value,source:{kind:source?'web':styleFileName?'file':'text',label:source||styleFileName}})
    if(thread!==state.threadId) return
    document.querySelector('#styleName').value=''; document.querySelector('#styleText').value=''; document.querySelector('#styleSource').value=''; document.querySelector('#styleFile').value=''; styleFileName=''
    document.querySelector('#styleMessage').textContent='已存入个人风格库，可在成片页选择。'; await loadStyles()
  }catch(e){if(thread===state.threadId) document.querySelector('#styleMessage').textContent=e.message}
})
