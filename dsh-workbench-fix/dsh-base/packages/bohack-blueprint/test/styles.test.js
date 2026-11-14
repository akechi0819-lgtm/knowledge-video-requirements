import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStyles } from '../lib/styles.js'

test('personal library is shared but choices are isolated per creative thread', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'styles-'))
  try {
    const a = createStyles(path.join(root, 'a'), root), b = createStyles(path.join(root, 'b'), root), other = createStyles(path.join(root, 'other'))
    assert.equal((await a.list()).styles.length, 2)
    assert.equal(await a.selected(), null)
    const item = (await a.importStyle({name:'我的风格',description:'# 视觉\n参考正文',source:{kind:'web',label:'https://example.com/style'}})).style
    assert.ok((await b.list()).styles.some(s => s.id === item.id))
    assert.equal((await other.list()).styles.length, 2)
    await a.select({id:item.id}); await b.select({id:'general'})
    assert.equal((await a.selected()).id, item.id)
    assert.equal((await b.selected()).id, 'general')
    await assert.rejects(a.remove({id:'general'}), /不可移除/)
    await b.update({id:item.id,name:'新名称',description:'新规则'})
    assert.equal((await a.selected()).name, '我的风格')
    const exported=await b.exportMarkdown({id:item.id})
    assert.match(exported, /^---\nname: personal-style-/); assert.match(exported, /\ndescription: /); assert.match(exported, /新规则/); assert.match(exported, /https:\/\/example.com/ )
    await b.remove({id:item.id})
    assert.equal((await a.selected()).name, '我的风格')
    assert.equal((await b.selected()).id, 'general')
    await Promise.all(Array.from({length:12},(_,i)=>a.importStyle({name:`并发${i}`,description:'规则',source:{kind:'text'}})))
    assert.equal((await a.list()).styles.length, 14)
    await assert.rejects(a.importStyle({name:'test',description:'x',source:{kind:'web',label:'javascript:alert(1)'}}), /HTTP/)
  } finally { await rm(root, { recursive:true, force:true }) }
})
