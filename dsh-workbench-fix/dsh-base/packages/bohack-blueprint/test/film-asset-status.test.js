import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const source = html.slice(html.indexOf('function filmAssetStatus('), html.indexOf('async function renderFilmAssets('))
const status = vm.runInNewContext(source + '\nfilmAssetStatus')
const asset = { ledgerId:'ledger-a', name:'销烟池', status:'pending' }
const file = { id:'ledger-a', name:'销烟池图', side:'videomake', path:'sources/pool.png', trust:'vetted' }

test('成片页只按绑定的账本 ID 读取审核状态', () => {
  assert.equal(status(asset, [file]), 'ledger-approved')
  assert.equal(status(asset, [{ ...file, trust:'unvetted' }]), 'ledger-review')
  assert.equal(status(asset, [{ ...file, id:'other', name:'销烟池' }]), 'pending')
  assert.equal(status({ ...asset, status:'generated' }, []), 'generated')
  assert.equal(status({ ...asset, status:'approved' }, [file]), 'generated-approved')
})

test('混合状态只对单项生成及确认发请求', async () => {
  const render = html.slice(html.indexOf('async function renderFilmAssets('), html.indexOf('function styleSummary('))
  const calls = []
  const buttons = []
  const box = {
    set innerHTML(value) {
      this.markup = value
      for (const match of value.matchAll(/data-(generate|approve)="([^"]+)"/g)) {
        const kind = match[1], id = match[2]
        buttons.push({ dataset: { [kind]: id }, hasAttribute: name => name === 'data-' + kind })
      }
    },
    querySelectorAll: () => buttons,
    querySelector: () => ({ textContent: '' }),
    replaceChildren() {},
  }
  const items = [
    { id:'a', name:'人工图', sections:['B01'], description:'', status:'pending' },
    { id:'b', name:'待审核图', sections:['B02'], description:'', status:'pending' },
    { id:'c', name:'已生成', sections:['B03'], description:'', status:'generated', revision:'rev-c', previewUrl:'/preview' },
    { id:'d', name:'待生成', sections:['B04'], description:'', status:'pending' },
  ]
  const ledger = [
    { id:'ledger-a', name:'人工图', side:'videomake', path:'sources/a.png', trust:'vetted' },
    { id:'ledger-b', name:'待审核图', side:'videomake', path:'sources/b.jpg', trust:'unvetted' },
  ]
  const context = {
    $: () => box, state: {threadId:'t', busy:false}, filmRender:1, assetRequests:new Set(),
    esc: x => String(x), updateProductionAction(){}, setProductionStatus(){}, refresh:async()=>{}, loadAssets:async()=>{},
    api: async (url, body) => { calls.push({url,body}); return url.includes('generated-assets?') ? {assets:items} : url==='/bohack/api/assets' ? {assets:ledger} : {} },
  }
  const run = vm.runInNewContext(source + '\n' + render + '\nrenderFilmAssets', context)
  await run({currentVersion:1, blueprintAssets:items.map((a,i)=>({...a,ledgerId:['ledger-a','ledger-b','ledger-c','ledger-d'][i]}))}, true, 1)
  assert.match(box.markup, /已确认 · 来自资料库/)
  assert.match(box.markup, /待确认 · 请到资料页审核/)
  assert.deepEqual(buttons.map(b => [Object.keys(b.dataset)[0], Object.values(b.dataset)[0]]), [['generate','c'],['approve','c'],['generate','d']])
  await buttons.find(b=>b.dataset.approve==='c').onclick()
  const approve = calls.find(c=>c.url.endsWith('generated-assets-approve'))
  assert.equal(JSON.stringify(approve.body), JSON.stringify({version:1,id:'c',revisions:{c:'rev-c'}}))
})
