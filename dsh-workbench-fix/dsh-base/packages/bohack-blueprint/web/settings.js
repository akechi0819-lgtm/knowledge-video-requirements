/* 工作台模型配置和风格 Skill 管理。 */
(() => {
  // 服务端要求所有 POST 带 x-bohack-client（跨域简单请求带不上该自定义头）。
  const apiFetch = (url, opt={}) => fetch(url, {...opt, headers:{...opt.headers, 'x-bohack-client':'1'}})
  const dialog = document.createElement('dialog')
  dialog.className = 'ws-dialog'
  dialog.setAttribute('aria-labelledby', 'ws-title')
  dialog.innerHTML = `<div class="ws-inner"><div class="ws-head"><h2 id="ws-title">工作台设置</h2><button class="ws-close" type="button" aria-label="关闭设置"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><form><section class="ws-section"><p class="ws-help">1. 配置通用模型密钥　2. 配置配音密钥与音色　3. 保存设置。密钥留空会保留已保存的密钥。</p><h3>通用模型</h3><p class="ws-help ws-model-scope"></p><label class="ws-field">API 密钥<input name="apiKey" type="password" autocomplete="new-password"></label><label class="ws-field"><input name="modelClear" type="checkbox"> 清除已保存的密钥</label><p class="ws-help ws-key-state" style="margin-top:8px"></p><p class="ws-help ws-model-default"></p><details><summary>连接详情</summary><div class="ws-grid"><label class="ws-field full">接口地址<input name="baseUrl" type="url" placeholder="https://…" autocomplete="url"></label><label class="ws-field">模型名称<input name="model" autocomplete="off"></label></div></details></section><section class="ws-section"><h3>配音 TTS</h3><p class="ws-help">用于成片配音。共享密钥仅适用于同一服务商。</p><label class="ws-field"><input name="ttsUseTextKey" type="checkbox"> 使用通用模型的 Key</label><div class="ws-tts-independent"><label class="ws-field">API 密钥<input name="ttsApiKey" type="password" autocomplete="new-password"></label><label class="ws-field"><input name="ttsClear" type="checkbox"> 清除已保存的密钥</label><p class="ws-help ws-tts-key-state"></p></div><label class="ws-field">音色<input name="ttsVoice"></label><details><summary>连接详情</summary><div class="ws-grid"><label class="ws-field full">完整接口地址<input name="ttsBaseUrl" type="url"></label><label class="ws-field">模型名称<input name="ttsModel"></label><label class="ws-field">协议<select name="ttsProtocol"><option value="speech">speech</option><option value="mimo">mimo</option></select></label></div></details></section><section class="ws-section"><h3>生图</h3><p class="ws-help">暂未接入制作，无需配置。</p></section><section class="ws-section ws-advanced"><details><summary>高级设置：独立路由</summary><p class="ws-help">需要单独指定模型时使用；折叠不会清除已填写的内容。</p><div class="ws-agent-routes"></div><div class="ws-tool-routes"></div></details></section><p class="ws-status" role="status" aria-live="polite"></p><div class="ws-actions"><button class="ws-cancel ghost" type="button">取消</button><button class="ws-save primary" type="submit">保存设置</button></div></form></div>`
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
  const wizard = document.createElement('dialog')
  wizard.className = 'ws-dialog'
  wizard.setAttribute('aria-labelledby', 'credential-title')
  wizard.innerHTML = '<div class="ws-inner"><h2 id="credential-title">配置自有模型</h2><form class="ws-section"><p class="ws-help">填写服务商提供的接口地址、模型名称和密钥。保存前会发送一条简短请求测试连接，可能产生少量模型费用。</p><label class="ws-field">接口地址<input name="baseUrl" type="url" placeholder="https://api.example.com/v1" required></label><label class="ws-field">模型名称<input name="model" autocomplete="off" required></label><label class="ws-field">API 密钥<input name="apiKey" type="password" autocomplete="new-password" required></label><p class="ws-status" role="status"></p><div class="ws-actions"><button class="ghost" type="button">稍后配置</button><button class="primary" type="submit">测试连接并保存</button></div></form></div>'
  const wizardForm = wizard.querySelector('form')
  const wizardStatus = wizard.querySelector('.ws-status')
  let wizardLoading = false
  wizard.querySelector('button[type=button]').onclick = () => wizard.close()
  wizard.addEventListener('close', () => {
    wizardForm.elements.apiKey.value = ''
    wizardStatus.textContent = ''
    wizard.remove()
  })
  wizardForm.addEventListener('submit', async event => {
    event.preventDefault()
    const fields = ['baseUrl', 'model', 'apiKey'].map(name => wizardForm.elements[name])
    const model = Object.fromEntries(fields.map(field => [field.name, field.value.trim()]))
    const submit = wizardForm.querySelector('button[type=submit]')
    const cancel = wizardForm.querySelector('button[type=button]')
    for (const field of [...fields, submit, cancel]) field.disabled = true
    const preventClose = event => event.preventDefault()
    wizard.addEventListener('cancel', preventClose)
    try {
      wizardStatus.textContent = '正在测试模型连接…'
      const response = await apiFetch('/bohack/api/model-connectivity', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(model),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || '未能连接模型。')
      wizardStatus.textContent = '连接已通过，正在加密保存…'
      await request({ model })
      wizard.close()
    } catch (error) {
      wizardStatus.textContent = error.message
    } finally {
      for (const field of [...fields, submit, cancel]) field.disabled = false
      wizard.removeEventListener('cancel', preventClose)
    }
  })
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
  if (window.chrome?.webview?.postMessage) {
    const exportButton = document.createElement('button')
    exportButton.type = 'button'
    exportButton.className = 'ghost'
    exportButton.textContent = '导出诊断包'
    exportButton.onclick = () => window.chrome.webview.postMessage('export-diagnostics')
    dialog.querySelector('.ws-head h2').after(exportButton)

    // Gentle in-app update banner (never forces restart during active video rendering)
    let updateBanner = null
    const ensureUpdateBanner = () => {
      if (updateBanner) return updateBanner
      const el = document.createElement('aside')
      el.className = 'jj-update-banner'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:9999;max-width:380px;padding:14px 16px;border-radius:10px;border:1px solid rgba(246,174,98,.45);background:rgba(18,18,22,.96);color:#f5f5f5;box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:10px'
      el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong class="jj-upd-title" style="color:#f6ae62;font-size:14px">新版本已就绪，重启即生效</strong><button type="button" class="jj-upd-dismiss" aria-label="稍后提醒" style="background:none;border:0;color:#999;cursor:pointer;font-size:15px">×</button></div><p class="jj-upd-msg" style="margin:0;color:#d6d6d6"></p><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="jj-upd-later ghost" style="padding:6px 12px">稍后</button><button type="button" class="jj-upd-restart primary" style="padding:6px 12px">立即重启更新</button></div>'
      el.querySelector('.jj-upd-dismiss').onclick = () => el.remove()
      el.querySelector('.jj-upd-later').onclick = () => el.remove()
      el.querySelector('.jj-upd-restart').onclick = async () => {
        const msg = el.querySelector('.jj-upd-msg')
        try {
          const r = await fetch('/bohack/api/desktop/busy')
          const busyState = r.ok ? await r.json() : { busy: false }
          if (busyState.busy) {
            msg.textContent = '当前有视频渲染任务正在进行，为避免中断成片，请在渲染完成后再重启更新。'
            return
          }
        } catch {}
        window.chrome.webview.postMessage('apply-update-restart')
      }
      document.body.append(el)
      updateBanner = el
      return el
    }
    window.chrome.webview.addEventListener?.('message', event => {
      const payload = typeof event.data === 'string' ? (() => { try { return JSON.parse(event.data) } catch { return null } })() : event.data
      if (!payload || typeof payload !== 'object') return
      if (payload.type === 'update-ready') {
        const el = ensureUpdateBanner()
        if (!el.isConnected) document.body.append(el)
        el.querySelector('.jj-upd-title').textContent = `新版本 v${payload.version || ''} 已就绪，重启即生效`
        el.querySelector('.jj-upd-msg').textContent = '差分更新已在后台完成校验并准备就绪。点击下方按钮将在空闲时重启生效，或下次打开时自动切换。'
      } else if (payload.type === 'update-blocked-busy') {
        const el = ensureUpdateBanner()
        if (!el.isConnected) document.body.append(el)
        el.querySelector('.jj-upd-msg').textContent = '当前有视频渲染任务正在进行，为避免中断成片，请在渲染完成后再重启更新。'
      }
    })
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
    dialog.querySelector('.ws-model-scope').textContent = cloud ? '统一用于需求、蓝图、画面代码和看图预览；配音单独配置。' : '用于成片场景和默认工具模型；本地 Agent 路由可在高级设置中配置。'
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
    async openCredentialWizard(force = false) {
      if (wizard.open || wizardLoading) return
      wizardLoading = true
      try {
        const settings = await request()
        const { baseUrl, model, hasApiKey } = settings.model || {}
        if (!force && baseUrl && model && hasApiKey) return
        wizardForm.elements.baseUrl.value = baseUrl || ''
        wizardForm.elements.model.value = model || ''
        document.body.append(wizard)
        wizard.showModal()
      } catch {
        // The Settings page still provides the underlying storage error.
        if (force) {
          document.body.append(wizard)
          wizard.showModal()
        }
      } finally { wizardLoading = false }
    },
    async open(panel = 'model') {
      const member = document.getElementById('accountBtn').dataset.mode === 'member'
      tabs.querySelector('[data-panel="model"]').hidden = member
      showPanel(member ? 'styles' : panel)
      status.textContent = '正在读取设置…'; form.querySelectorAll('input,button[type=submit]').forEach(el => el.disabled = true)
      dialog.showModal()
      if (member) { status.textContent = ''; return }
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
    const visible=data.styles||[]
    document.querySelector('#styleList').innerHTML=visible.map(style=>`<div class="leaf" style="margin-bottom:8px"><b>${esc(style.name)}</b> <span class="tag">${esc(styleKindLabel(style))}</span><p class="hint">${esc(style.summary || (style.description||'').split(/[。\n]/).find(Boolean) || '')}</p>${style.source?.kind==='builtin' || !['visual','style'].includes(style.kind)?'':`<details><summary>管理</summary><button class="sm ghost" data-style-edit="${esc(style.id)}">编辑</button><a href="/bohack/api/style-export?id=${encodeURIComponent(style.id)}${thread?'&amp;threadId='+encodeURIComponent(thread):''}" download="SKILL.md">导出</a><button class="sm ghost" data-style-remove="${esc(style.id)}">移除</button></details>`}</div>`).join('')
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
document.querySelector('#skillGithubInspect').addEventListener('click',async()=>{
  const button=document.querySelector('#skillGithubInspect'), results=document.querySelector('#skillGithubResults')
  const url=document.querySelector('#skillGithubUrl').value.trim()
  button.disabled=true; results.textContent='正在检查仓库…'
  try {
    const data=await api('/bohack/api/styles/github/inspect',{url})
    results.innerHTML=(data.skills||[]).length ? `<p class="hint">选择要安装的 Skill：</p>${data.skills.map(skill=>`<label style="display:block;margin:8px 0"><input type="checkbox" value="${esc(skill.id)}" checked> <b>${esc(skill.name)}</b> · ${esc(skill.path)}<br><span class="hint">${esc(skill.description||'')}</span>${(skill.dependencyHints||[]).length?`<br><span class="hint">依赖：${esc(skill.dependencyHints.join('、'))}</span>`:''}</label>`).join('')}<button class="sm primary" id="skillGithubInstall">安装所选 Skill</button>` : '<p class="hint">仓库中没有发现 Skill。</p>'
    results.querySelector('#skillGithubInstall')?.addEventListener('click',async e=>{
      const selected=[...results.querySelectorAll('input:checked')].map(input=>input.value)
      if(!selected.length){document.querySelector('#styleMessage').textContent='请至少选择一个 Skill。';return}
      e.currentTarget.disabled=true
      try {
        const installed=await api('/bohack/api/styles/github/install',{installId:data.installId,selected})
        results.textContent='已安装：'+installed.skills.map(skill=>skill.name).join('、')
        await loadStyles(); await loadEntrySkills(); if(state.threadId) await loadBlueprintSkill(state.threadId)
      } catch(error){document.querySelector('#styleMessage').textContent=error.message; e.currentTarget.disabled=false}
    })
  } catch(error){results.textContent='检查失败：'+error.message}
  finally{button.disabled=false}
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


// 会员账号与模式由服务端保存，刷新后以服务端状态为准。
;(() => {
  const button = document.getElementById('accountBtn')
  const dialog = document.createElement('dialog')
  dialog.className = 'ws-dialog'
  dialog.setAttribute('aria-labelledby', 'account-title')
  dialog.innerHTML = `<div class="ws-inner"><div class="ws-head"><h2 id="account-title">账号与使用模式</h2><button class="ws-close" type="button" aria-label="关闭账号"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><section class="ws-section"><p class="account-info"></p><form class="account-form"><label class="ws-field">邮箱<input name="email" type="email" autocomplete="email" required></label><label class="ws-field">密码<input name="password" type="password" autocomplete="current-password" required></label><label class="ws-field">邀请码（注册时填写）<input name="inviteCode" autocomplete="off"></label><div class="ws-actions"><button type="submit" name="action" value="register" class="ghost">注册</button><button type="submit" name="action" value="login" class="primary">登录</button></div></form><button class="account-logout ghost" type="button">退出登录</button></section><section class="ws-section"><h3>使用模式</h3><label class="ws-field">当前模式<select class="account-mode"><option value="member">会员模式（无需配置模型密钥）</option><option value="byok">高级模式（使用自己的密钥）</option></select></label><p class="ws-help">高级模式的密钥在工作台设置中配置。</p></section><p class="ws-status" role="status" aria-live="polite"></p></div>`
  const card = document.createElement('section')
  card.className = 'ws-section'
  card.innerHTML = '<h3>6 元周卡</h3><p class="ws-help">有效期 7 天，手动购买，不自动续费。</p><button class="ghost account-purchase" type="button" disabled>购买 6 元周卡（7 天）</button><p class="account-purchase-help ws-help"></p><div class="account-payment" hidden><canvas class="account-qr" aria-label="支付宝支付二维码"></canvas><p><a class="account-pay-link" target="_blank" rel="noopener noreferrer">在浏览器打开支付宝支付</a></p><p class="account-payment-status" role="status"></p></div>'
  dialog.querySelector('.account-mode').closest('section').before(card)
  const form = dialog.querySelector('.account-form')
  const info = dialog.querySelector('.account-info')
  const mode = dialog.querySelector('.account-mode')
  const logout = dialog.querySelector('.account-logout')
  const status = dialog.querySelector('.ws-status')
  const purchase = card.querySelector('.account-purchase'), help = card.querySelector('.account-purchase-help')
  const payment = card.querySelector('.account-payment'), qr = card.querySelector('.account-qr'), link = card.querySelector('.account-pay-link'), paymentStatus = card.querySelector('.account-payment-status')
  let state = null, timer = null, pollGeneration = 0, busy = false
  function stopPolling() { clearTimeout(timer); timer = null; pollGeneration++ }
  function purchaseEnabled() {
    purchase.textContent = state?.pendingOrderId ? '查询待处理订单' : '购买 6 元周卡（7 天）'
    purchase.disabled = busy || !state?.account || (!state.pendingOrderId && (!state.account.purchaseAvailable || !state.account.canPurchase))
  }
  async function request(body) {
    const response = await fetch('/bohack/api/membership', body ? {method:'POST', headers:{'content-type':'application/json','x-bohack-client':'1'}, body:JSON.stringify(body)} : {headers:{'x-bohack-client':'1'}})
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error || `请求失败（${response.status}）`)
    return result
  }
  function render(result) {
    state = result
    button.hidden = !result.enabled
    if (!result.enabled) return
    button.dataset.mode = result.mode
    button.title = ''
    button.textContent = result.mode === 'member' ? '账号 · 会员模式' : '账号 · 自有密钥'
    form.hidden = !!result.account
    logout.hidden = !result.account
    mode.value = result.mode
    help.textContent = !result.account ? '登录后可购买周卡。' : !result.account.purchaseAvailable ? '购买渠道暂未开放。' : !result.account.canPurchase ? '当前周卡仍有效。' : ''
    purchaseEnabled()
    if (!result.account) info.textContent = '尚未登录。注册或登录后可使用会员额度。'
    else {
      const account = result.account
      const passStatus = {active:'有效', exhausted:'额度已用尽，可重新购买', expired:'已过期', stopped:'已停用', none:'未开通'}[account.passStatus] || '状态未知'
      info.textContent = `${account.email} · 赠送剩余 ${account.gifts} 次 · 6 元周卡${passStatus}` + (account.remainingPercent == null ? '' : ` · 剩余额度 ${account.remainingPercent}%`) + (account.expiresAt ? ` · 到期时间 ${new Date(account.expiresAt).toLocaleString('zh-CN', {year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}` : '')
    }
  }
  async function update(body) {
    status.textContent = '正在处理…'
    busy = true
    dialog.querySelectorAll('button, input, select').forEach(el => el.disabled = true)
    try {
      render(await request(body))
      status.textContent = ''
      if (body) await refresh()
      if (body?.action === 'mode' && state.mode === 'byok' && state.credentialWizard) {
        dialog.close()
        await window.BohackSettings.openCredentialWizard()
      }
    }
    catch (error) { status.textContent = `操作失败：${error.message}`; if (state) mode.value = state.mode }
    finally { busy = false; dialog.querySelectorAll('button, input, select').forEach(el => el.disabled = false); purchaseEnabled() }
  }
  button.onclick = () => {
    if (!dialog.isConnected) document.body.append(dialog)
    payment.hidden = true
    dialog.showModal()
    update().then(() => { if (dialog.open && state?.pendingOrderId) pollOrder() })
  }
  dialog.addEventListener('close', stopPolling)
  dialog.querySelector('.ws-close').onclick = () => dialog.close()
  form.onsubmit = async event => {
    event.preventDefault()
    await update({action:event.submitter.value, email:form.elements.email.value.trim(), password:form.elements.password.value, inviteCode:form.elements.inviteCode.value.trim()})
    form.elements.password.value = ''
    form.elements.inviteCode.value = ''
  }
  logout.onclick = () => { stopPolling(); payment.hidden = true; update({action:'logout'}) }
  function showOrder(order) {
    payment.hidden = false
    if (order.status === 'paid') {
      qr.hidden = true; link.hidden = true; link.removeAttribute('href'); paymentStatus.textContent = '已付款，待生效。'; return
    }
    const safeUrl = value => {
      try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) ? url.href : null } catch { return null }
    }
    const payUrl = safeUrl(order.payUrl)
    link.hidden = !payUrl
    if (payUrl) link.href = payUrl
    else link.removeAttribute('href')
    qr.hidden = !order.qrCode
    if (order.qrCode) {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']
      const code = qrcode(0, 'M'); code.addData(order.qrCode); code.make()
      const n = code.getModuleCount(), scale = 4, margin = 4
      qr.width = qr.height = (n + margin * 2) * scale
      const ctx = qr.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, qr.width, qr.height); ctx.fillStyle = '#000'
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (code.isDark(y, x)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale)
    }
    paymentStatus.textContent = '请使用支付宝完成支付，支付结果会自动刷新。'
  }
  async function pollOrder() {
    stopPolling()
    const generation = pollGeneration, deadline = Date.now() + 15 * 60 * 1000
    async function check() {
      if (Date.now() >= deadline) { paymentStatus.textContent = '自动查询已暂停，可重新打开账号或点击查询待处理订单。'; return }
      try {
        const result = await request({action:'order-check'})
        if (generation !== pollGeneration) return
        render(result)
        const order = result.order
        if (order.status === 'fulfilled') {
          payment.hidden = true; status.textContent = '购买成功，可以开始或继续制作。'; await refresh(); return
        }
        if (['expired','failed'].includes(order.status) || (order.status === 'pending' && order.expiresAt && Date.parse(order.expiresAt) <= Date.now())) {
          payment.hidden = true; status.textContent = '订单已结束，请重新购买。'; return
        }
        showOrder(order)
        timer = setTimeout(check, Math.min(2500, Math.max(0, deadline - Date.now())))
      } catch (error) {
        if (generation !== pollGeneration) return
        paymentStatus.textContent = '查询订单失败：' + error.message + '。请重新打开账号重试。'
      }
    }
    await check()
  }
  purchase.onclick = async () => {
    if (state?.pendingOrderId) { await pollOrder(); return }
    stopPolling(); const generation = pollGeneration; busy = true; purchaseEnabled(); status.textContent = '正在创建订单…'
    try {
      const result = await request({action:'order-create'})
      if (generation !== pollGeneration) return
      render(result); status.textContent = ''
      if (result.order.status === 'fulfilled') { payment.hidden = true; status.textContent = '购买成功，可以开始或继续制作。'; await refresh() }
      else { showOrder(result.order); await pollOrder() }
    } catch (error) { status.textContent = '操作失败：' + error.message }
    finally { busy = false; purchaseEnabled() }
  }
  mode.onchange = () => update({action:'mode', mode:mode.value})
  request().then(result => {
    render(result)
    if (result.mode === 'byok' && result.credentialWizard) void window.BohackSettings.openCredentialWizard()
  }).catch(error => { button.textContent = '账号'; button.title = '账号状态读取失败：'+error.message })
  window.addEventListener('bohack-missing-credential', () => {
    if (state?.mode === 'byok' && state.credentialWizard) void window.BohackSettings.openCredentialWizard(true)
  })
})()
