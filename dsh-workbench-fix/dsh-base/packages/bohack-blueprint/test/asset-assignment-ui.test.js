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

test('定稿后的已绑定声明只保留上传入口',()=>{
  const box={innerHTML:'',querySelectorAll:()=>[]}
  const state={status:{currentVersion:3,stage:'finalized',finalized:{version:3},sections:[{id:'B01'}],blueprintAssets:[{ledgerId:'one',sections:['B01']}]}}
  const render=vm.runInNewContext(code+'\nrenderAssets',{$:()=>box,state,esc:String})
  render([{id:'one',name:'绑定',side:'videomake',type:'image',declared:true},{id:'two',name:'未绑定',side:'videomake',type:'image',declared:true}])
  assert.match(box.innerHTML,/data-upload-declaration="one"/)
  assert.doesNotMatch(box.innerHTML,/data-implement-declaration="one"/)
  assert.match(box.innerHTML,/data-implement-declaration="two"/)
  state.status.stage='draft'
  render([{id:'one',name:'绑定',side:'videomake',type:'image',declared:true}])
  assert.match(box.innerHTML,/data-implement-declaration="one"/)
})
