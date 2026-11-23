import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
test('成片页区分继续原任务和重新制作', () => {
  const actions = html.slice(html.indexOf('function pendingReceipt('), html.indexOf("$('#productionMode').onchange"))
  const { productionLabel, productionNote } = vm.runInNewContext(actions + '\n({ productionLabel, productionNote })')
  const authorized = { production:{ id:'saved-job', status:'failed', membershipAuthorizationId:'authorization' } }
  assert.equal(productionLabel(authorized), '继续制作')
  assert.match(productionNote(authorized), /点「继续制作」.*说「继续制作」.*复用/)
  const byok = { production:{ id:'saved-job', status:'failed' } }
  assert.equal(productionLabel(byok), '继续制作')
  const noSavedJob = { production:{ status:'failed' } }
  assert.equal(productionLabel(noSavedJob), '重新制作')
  assert.match(productionNote(noSavedJob), /点「重新制作」重试/)
  assert.equal(productionNote({ production:{ status:'running' } }), '')
})

test('续跑时显示仍在等待的段落及已保存进度', () => {
  const film = readFileSync(new URL('../web/film.js', import.meta.url), 'utf8')
  const window = {}
  vm.runInNewContext(film, { window })
  const sections = Array.from({ length: 7 }, (_, index) => ({ id:`S0${index + 1}`, scene:index < 6 }))
  assert.match(window.BohackFilm.headline({status:'running', phase:'正在制作视频', sections}), /等待 S07 的画面，已保存 6 \/ 7 段/)
  assert.match(window.BohackFilm.headline({status:'running', phase:'正在制作视频', sections, waitMessage:'画面模型等待时间较长，正在继续等待。'}), /等待时间较长/)
  assert.match(window.BohackFilm.headline({status:'running', phase:'正在制作视频', sections:sections.map(section=>({...section,scene:true}))}), /各段画面已保存/)
})

test('成片素材显示多种预览，单项修改直接启动制作', async () => {
  const render = html.slice(html.indexOf('async function renderFilmAssets('), html.indexOf('function styleSummary('))
  const calls = [], buttons = [], status = {textContent:''}, feedback = {dataset:{assetFeedback:'a'},value:'换红帽子'}
  const box = {
    dataset:{},
    set innerHTML(value) { this.markup=value; buttons.push({dataset:{reviseAsset:'a'}}) },
    querySelectorAll(selector) { return selector==='[data-asset-feedback]' ? [feedback] : buttons },
    querySelector() { return status }, replaceChildren() {},
  }
  const s={currentVersion:1,production:{status:'completed',version:'v1',mode:'agent',assets:[{id:'a',name:'人物',files:[{variant:'idle',previewUrl:'/idle.png'},{variant:'walk',previewUrl:'/walk.png'}],sourceUrl:'/character.py'},{id:'b',name:'背景',revisable:false,sourceUrl:'/background.py'}]}}
  const context={
    $:()=>box,state:{threadId:'t',busy:false,status:s},filmRender:1,assetRequests:new Set(),productionRequest:null,productionFailure:null,
    esc:x=>String(x),pendingReceipt:()=>false,updateProductionAction(){},refresh:async()=>{},
    api:async(url,body)=>{calls.push({url,body}); return url.includes('generated-assets?') ? {assets:[]} : {}},
  }
  const run=vm.runInNewContext(render+'\nrenderFilmAssets',context)
  await run(s,true,1)
  assert.match(box.markup,/\/idle.png/)
  assert.match(box.markup,/\/walk.png/)
  assert.match(box.markup,/href="\/character.py" download/)
  assert.doesNotMatch(box.markup,/<img src="\/background.py"/)
  assert.doesNotMatch(box.markup,/data-revise-asset="b"/)
  assert.doesNotMatch(box.markup,/确认此项/)
  feedback.value='换红帽子'
  await buttons[0].onclick()
  const production=calls.find(c=>c.url==='/bohack/api/production')
  assert.equal(JSON.stringify(production.body),JSON.stringify({mode:'agent',regenerateAssetId:'a',assetFeedback:'换红帽子'}))
})
