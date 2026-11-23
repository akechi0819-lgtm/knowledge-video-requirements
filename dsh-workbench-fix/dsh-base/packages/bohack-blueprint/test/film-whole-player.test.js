import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const script=readFileSync(new URL('../web/film.js',import.meta.url),'utf8')
function render(mapping) {
  const make=()=>({dataset:{},classList:{toggle(){}},replaceChildren(){this.innerHTML=''},querySelector(){return null},querySelectorAll(){return []},insertAdjacentHTML(_where,html){this.innerHTML+=html}})
  const elements=Object.fromEntries(['pane-film','phaseRail','filmHeadline','filmRail','filmPlayer','filmWaitMeta','filmPrep','filmBp','filmState','pixelAssets'].map(id=>[id,make()]))
  elements['pane-film'].querySelector=sel=>sel==='#pixelAssets'?elements.pixelAssets:null
  const window={}
  vm.runInNewContext(script,{window,document:{getElementById:id=>elements[id]},location:{origin:'http://localhost'},URL})
  window.BohackFilm.render({currentVersion:1,sections:[{id:'B01',title:'一'},{id:'B02',title:'二'}],production:{id:'p',status:'completed',mode:'agent',artifacts:{video:true},sections:[{id:'B01',title:'一'},{id:'B02',title:'二'}],verify:{duration:30,pass:true},mapping}}, {threadId:'t'})
  return elements
}
test('无映射或不对应蓝图的映射显示完整播放器，不显示跳转卡和映射下载',()=>{
  for(const mapping of [null,{duration:30,segments:[{id:'custom',start:0,end:10}]}]) {
    const e=render(mapping)
    assert.match(e.filmPlayer.innerHTML,/<video id="filmVideo" controls/)
    assert.match(e.filmPlayer.innerHTML,/下载成片/)
    assert.doesNotMatch(e.filmPlayer.innerHTML,/下载时间映射/)
    assert.equal(e.filmRail.hidden,true)
  }
})
test('部分映射仅显示可跳转的段落，保留映射下载',()=>{
  const e=render({duration:30,segments:[{id:'B01',start:0,end:10},{id:'custom',start:10,end:20}]})
  assert.match(e.filmRail.innerHTML,/data-sec="B01"/)
  assert.doesNotMatch(e.filmRail.innerHTML,/data-sec="B02"|data-sec="custom"/)
  assert.match(e.filmPlayer.innerHTML,/下载时间映射/)
})
