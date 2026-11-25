import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8')
const code=html.slice(html.indexOf('function trustTag('),html.indexOf('async function loadAssets('))

test('资料页展示当前蓝图的段落并保存或取消关联', async()=>{
  let handler, selected=['B02'], call
  const button={dataset:{assign:'ledger-1'},addEventListener(_event,fn){handler=fn},closest(){return {querySelectorAll:()=>selected.map(id=>({dataset:{section:id}}))}}}
  const box={innerHTML:'',querySelectorAll:selector=>selector==='[data-assign]'?[button]:[]}
  const state={threadId:'t',status:{currentVersion:3,sections:[{id:'B01'},{id:'B02'}],blueprintAssets:[{ledgerId:'ledger-1',sections:['B01']}]}}
  const context={$:()=>box,state,esc:String,api:async(url,body,thread)=>{call={url,body,thread}},refresh:async()=>{},loadAssets:async()=>{},log(){}}
  const render=vm.runInNewContext(code+'\nrenderAssets',context)
  render([{id:'ledger-1',name:'图',side:'videomake',type:'image'}])
  assert.match(box.innerHTML,/data-section="B01" checked/)
  assert.match(box.innerHTML,/data-section="B02"/)
  await handler()
  assert.equal(JSON.stringify(call),JSON.stringify({url:'/bohack/api/asset-assign',body:{id:'ledger-1',version:3,sections:['B02']},thread:'t'}))
  selected=[]
  await handler()
  assert.equal(JSON.stringify(call.body.sections),'[]')
})

test('声明素材在定稿前后均保留图片上传入口',()=>{
  const box={innerHTML:'',querySelectorAll:()=>[]}
  const state={status:{currentVersion:3,stage:'finalized',finalized:{version:3},sections:[{id:'B01'}],blueprintAssets:[{ledgerId:'one',sections:['B01']}]}}
  const render=vm.runInNewContext(code+'\nrenderAssets',{$:()=>box,state,esc:String})
  render([{id:'one',name:'绑定',side:'videomake',type:'image',declared:true},{id:'two',name:'未绑定',side:'videomake',type:'image',declared:true}])
  assert.match(box.innerHTML,/data-upload-declaration="one"/)
  assert.doesNotMatch(box.innerHTML,/data-implement-declaration="one"/)
  assert.match(box.innerHTML,/data-upload-declaration="two"/)
  assert.doesNotMatch(box.innerHTML,/data-implement-declaration/)
  state.status.stage='draft'
  render([{id:'one',name:'绑定',side:'videomake',type:'image',declared:true}])
  assert.match(box.innerHTML,/data-upload-declaration="one"/)
  assert.doesNotMatch(box.innerHTML,/data-implement-declaration/)
})

test('制作完成的素材声明显示已生成，未匹配的声明与真实上传保留原状态',()=>{
  const box={innerHTML:'',querySelectorAll:()=>[]}
  const status={currentVersion:3,stage:'draft',sections:[],visualStyle:{style:{id:'ink'}},
    blueprintAssets:[{id:'hero',ledgerId:'one',sections:[]},{id:'missing',ledgerId:'two',sections:[]},{id:'hero',ledgerId:'uploaded',sections:[]}],
    production:{status:'completed',version:'v3',styleId:'ink',assets:[{id:'hero',files:[{previewUrl:'/hero.png'}]},{id:'missing',files:[]}]}}
  const render=vm.runInNewContext(code+'\nrenderAssets',{$:()=>box,state:{status},esc:String})
  const assets=[{id:'one',name:'人物图',side:'videomake',type:'image',declared:true},
    {id:'two',name:'未生成',side:'videomake',type:'image',declared:true},
    {id:'uploaded',name:'上传',side:'videomake',type:'image',declared:true,path:'sources/upload.png',trust:'vetted'}]
  const row=id=>box.innerHTML.split(`data-asset-id="${id}"`)[1].split('data-asset-id="')[0]
  render(assets)
  assert.match(row('one'),/tag[^>]*>已生成/)
  assert.doesNotMatch(row('one'),/待补|data-upload-declaration|data-implement-declaration/)
  assert.match(row('two'),/待补/)
  assert.match(row('two'),/data-upload-declaration="two"/)
  assert.doesNotMatch(row('two'),/data-implement-declaration/)
  assert.match(row('uploaded'),/可用/)
  assert.doesNotMatch(row('uploaded'),/tag[^>]*>已生成/)
})

test('轮询发现素材制作完成时即使蓝图未变也刷新资料页',async()=>{
  const initial={currentVersion:3,stage:'draft',sections:[],visualStyle:{style:{id:'ink'}},
    blueprintAssets:[{id:'hero',ledgerId:'one',sections:[]}],
    production:{status:'running',version:'v3',styleId:'ink',assets:[]}}
  const completed={...initial,production:{...initial.production,status:'completed',assets:[{id:'hero',files:[{previewUrl:'/hero.png'}]}]}}
  const state={threadId:'t',threads:[],status:initial,assets:[{id:'one'}],
    blueprintKey:JSON.stringify(['t',initial.currentVersion,initial.sections,initial.locked,initial.blueprintSkill,initial.hasFeedback,initial.lastRun,initial.stage,initial.blueprintAssets])}
  let rendered=0, blueprintRendered=0, warning
  const elements={}
  const context={state,$:selector=>selector==='#edTitle'||selector==='#noteText'?null:(elements[selector]||=( {style:{}} )),
    api:async url=>url.endsWith('/status')?completed:{raw:''},syncStudioChoice(){},renderBlueprint(){blueprintRendered++},
    renderAssets(){rendered++},renderFilm(){},renderValidation(){},renderRequirement(){},scheduleRefresh(){},
    console:{warn(...args){warning=args}}}
  const refreshCode=html.slice(html.indexOf('async function refresh(){'),html.indexOf('let filmRender=0'))
  const refresh=vm.runInNewContext(code.slice(0,code.indexOf('function t2tag('))+'\n'+refreshCode+'\nrefresh',context)
  await refresh()
  assert.equal(warning,undefined)
  assert.equal(blueprintRendered,0)
  assert.equal(rendered,1)
})

test('制作状态、版本、风格或素材不匹配时声明仍待补',()=>{
  const box={innerHTML:'',querySelectorAll:()=>[]}
  const status={currentVersion:3,stage:'draft',sections:[],visualStyle:{style:{id:'ink'}},
    blueprintAssets:[{id:'hero',ledgerId:'one',sections:[]}],
    production:{status:'completed',version:'v3',styleId:'ink',assets:[{id:'hero',files:[{path:'assets/hero.png'}]}]}}
  const render=vm.runInNewContext(code+'\nrenderAssets',{$:()=>box,state:{status},esc:String})
  const asset={id:'one',name:'人物',side:'videomake',type:'image',declared:true}
  const cases=[
    {status:'running'}, {status:'failed'}, {version:'v2'}, {styleId:'other'},
    {assets:[{id:'other',files:[{path:'assets/other.png'}]}]}, {assets:[{id:'hero',files:[]}]}, {assets:[]}
  ]
  for(const change of cases){
    const production=status.production
    status.production={...production,...change}
    render([asset])
    assert.match(box.innerHTML,/待补/,JSON.stringify(change))
    assert.match(box.innerHTML,/data-upload-declaration="one"/,JSON.stringify(change))
    assert.doesNotMatch(box.innerHTML,/data-implement-declaration/,JSON.stringify(change))
    status.production=production
  }
  status.blueprintAssets=[]
  render([asset])
  assert.match(box.innerHTML,/待补/)
})
