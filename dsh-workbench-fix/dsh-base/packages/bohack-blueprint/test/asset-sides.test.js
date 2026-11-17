import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.js'

test('分身模型：参考分身必须有本体，素材分身可声明先于实物', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-asset-sides-'))
  try {
    const service = createService({}, { workspace })
    // 参考分身无本体 → 拒绝（参考性必须实物在先）
    await assert.rejects(
      service.addAsset({ name: '架构图.png', side: 'blueprint', note: 'xxx项目的架构看这个' }),
      /实物在先/,
    )
    // 参考分身声明态不允许（只有素材分身可以声明先于实物）
    await assert.rejects(
      service.addAsset({ name: 'x', side: 'blueprint', declared: true }),
      /声明先于实物/,
    )
    // 素材分身声明态：无本体、unvetted
    const declared = await service.declareAsset({ name: '枫叶素材', note: '一片秋天的枫叶，用于转场' })
    assert.equal(declared.asset.side, 'videomake')
    assert.equal(declared.asset.declared, true)
    assert.equal(declared.asset.path, '')
    assert.equal(declared.asset.trust, 'unvetted')

    // 未声明过的条目不能转正
    const plain = await service.addAsset({ name: '普通素材', path: 'sources/a.png' })
    await assert.rejects(service.realizeAsset({ id: plain.asset.id, path: 'sources/a.png' }), /声明态/)

    // 转正路径必须在 sources/ 单层
    await assert.rejects(service.realizeAsset({ id: declared.asset.id, path: 'other/枫叶.png' }), /上传目录/)
    await assert.rejects(service.realizeAsset({ id: declared.asset.id, path: 'sources/../需求.md' }), /上传目录/)

    // 准备一份 sources/ 实物并转正
    const upload = await service.uploadAsset({ name: '枫叶.png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64').padEnd(4, 'A') })
    const realized = await service.realizeAsset({ id: declared.asset.id, path: upload.asset.path })
    assert.equal(realized.asset.path, upload.asset.path)
    assert.equal(realized.asset.declared, undefined)
    assert.equal(realized.asset.trust, 'unvetted') // 转正 ≠ 审核，闸门仍在创作者
    // 已转正不能再次转正
    await assert.rejects(service.realizeAsset({ id: declared.asset.id, path: upload.asset.path }), /声明态/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('read_material：参考分身 vetted 可读，素材分身与未审核拒绝', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-read-material-'))
  try {
    const service = createService({}, { workspace })
    const upload = await service.uploadAsset({ name: '架构说明.md', dataBase64: Buffer.from('SSO 把短字符串放进对象内部缓冲。').toString('base64') })
    // 素材分身不可读
    const material = await service.addAsset({ name: '配图.png', path: 'sources/x.png', side: 'videomake' })
    await assert.rejects(service.readMaterial({ id: material.asset.id }), /参考分身/)
    // 参考分身未审核不可读
    const ref = await service.addAsset({ name: '架构说明.md', path: upload.asset.path, side: 'blueprint', note: '架构事实看这个' })
    await assert.rejects(service.readMaterial({ id: ref.asset.id }), /未通过审核/)
    // 审核后可读原文
    await service.updateAsset({ id: ref.asset.id, action: 'approve' })
    const read = await service.readMaterial({ id: ref.asset.id })
    assert.equal(read.ok, true)
    assert.equal(read.kind, 'text')
    assert.match(read.content, /SSO 把短字符串/)
    assert.equal(read.note, '架构事实看这个')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('素材声明合并：契约 assets 字段与 declare_asset 双通道按归一化名去重', async () => {
  const { mergeAssetDeclarations } = await import('../lib/service.js')
  // 用户实测场景：工具声明 2 条（近名带"示意"），契约清单 3 条（含唯一写进清单的背景）
  const toolDecls = [
    { name: 'std::string 字符串盒子示意', note: '横向盒子…' },
    { name: 'C 字符串与 std::string 对比示意', note: 'B01 钩子用…' },
  ]
  const docDecls = [
    { name: 'std::string 字符串盒子', note: '横向盒子…；用于段落 B01、B02' },
    { name: 'C 字符串与 std::string 对比底图', note: 'B01 钩子用…；用于段落 B01' },
    { name: '代码讲解板', note: '深色代码编辑器背景；用于段落 B01、B02' },
  ]
  const merged = mergeAssetDeclarations(toolDecls, docDecls, [])
  assert.equal(merged.length, 3, '近名与同名去重后应剩 3 条')
  const names = merged.map(m => m.name)
  assert.ok(names.includes('代码讲解板'), '契约清单独有的背景必须被桥接登记')
  assert.ok(!names.includes('std::string 字符串盒子'), '与工具声明近名的条目不应重复登记')

  // 与账本已有条目去重（修订重新生成时不重复登记）
  const again = mergeAssetDeclarations(toolDecls, docDecls, merged.map(m => ({ name: m.name })))
  assert.equal(again.length, 0, '账本已有同名声明时不重复登记')

  // 蓝图参考与制作素材各有用途，同名参考不应阻止声明。
  assert.equal(mergeAssetDeclarations([], [{ name: '地图', note: '制作地图' }], [{ name: '地图', side: 'blueprint' }]).length, 1)
  assert.equal(mergeAssetDeclarations([], [{ name: '地图', note: '制作地图' }], [{ name: '地图', side: 'videomake' }]).length, 0)
  assert.equal(mergeAssetDeclarations([], [{ name: '地图', note: '制作地图' }], [{ name: '地图', type: 'text' }]).length, 1)

  // 归一化只影响去重比较，登记用首个原始名
  const order = mergeAssetDeclarations([], docDecls, [])
  assert.equal(order[0].name, 'std::string 字符串盒子')
})

test('implementAsset：声明态素材可由模型直接实现并转正（待审核）', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-asset-implement-'))
  const old = { ...process.env }
  try {
    const shapes = Array.from({ length: 5 }, (_, i) => ({ d: `M ${i} 0 L 10 10 Z`, fill: '#123456', stroke: 'none', width: 1 }))
    let received = ''
    const service = createService({}, {
      workspace,
      request: async (_url, options) => {
        received = JSON.parse(options.body).messages[0].content
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ shapes }) } }] }) }
      },
    })
    await service._internal.ensureDirs()
    const declared = await service.declareAsset({ name: '枫叶素材', note: '一片秋天的枫叶，用于转场' })
    Object.assign(process.env, { SCENE_ENDPOINT: 'http://localhost/test', SCENE_MODEL: 'test' })
    const out = await service.implementAsset({ id: declared.asset.id })
    assert.match(received, /枫叶素材/, '画图指令必须带上声明名')
    assert.match(received, /枫叶/, '画图指令必须带上声明备注')
    assert.equal(out.ok, true)
    assert.match(out.path, /^sources\/.+\.svg$/)
    assert.equal(out.asset.declared, undefined, '实现后不再处于声明态')
    assert.equal(out.asset.trust, 'unvetted', '生成不等于审核')
    const svg = await import('node:fs/promises').then(fs => fs.readFile(path.join(workspace, out.path), 'utf8'))
    assert.match(svg, /<svg/)
    // 已实现后不能再次实现
    await assert.rejects(service.implementAsset({ id: declared.asset.id }), /声明态/)
  } finally {
    for (const key of ['SCENE_ENDPOINT', 'SCENE_MODEL']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(workspace, { recursive: true, force: true })
  }
})

test('filmApprove：成片素材确认后按归一化名同步转正账本声明', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-film-approve-'))
  const old = { ...process.env }
  try {
    const shapes = Array.from({ length: 5 }, () => ({ d: 'M 0 0 L 10 10 Z', fill: '#123456', stroke: 'none', width: 1 }))
    const service = createService({}, {
      workspace,
      request: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ shapes }) } }] }) }),
    })
    await service._internal.ensureDirs()
    // 模拟 produce 落库：蓝图清单声明同名进了账本（声明态）
    const slot = await service.declareAsset({ name: '字符串盒子示意', note: '横向盒子；用于段落 B01' })
    Object.assign(process.env, { SCENE_ENDPOINT: 'http://localhost/test', SCENE_MODEL: 'test' })
    const doc = { assets: [{ id: 'box', ledgerId: slot.asset.id, name: '字符串盒子', type: 'prop', description: '横向盒子', sections: ['B01'] }] }
    const args = { version: 1, doc, style: { name: '纸绘' } }
    const gen = await service.generatedAssets.generate(args)
    const revisions = Object.fromEntries(gen.assets.map(a => [a.id, a.revision]))
    const result = await service.filmApprove({ ...args, revisions })
    assert.equal(result.assets[0].status, 'approved')
    // 账本里的同名声明已被转正（归一化名匹配："字符串盒子示意" ≈ "字符串盒子"）
    const entry = (await service.listAssets()).assets.find(a => a.name === '字符串盒子示意')
    assert.ok(entry && entry.path, '确认后账本声明必须有本体')
    assert.match(entry.path, /^sources\/.+\.svg$/)
    assert.equal(entry.declared, undefined)
    assert.equal(entry.trust, 'vetted')
    const oldPath = entry.path
    const newer = await service.generatedAssets.generate({ ...args, id: 'box' })
    await service.filmApprove({ ...args, id: 'box', revisions: { box: newer.assets[0].revision } })
    const updated = (await service.listAssets()).assets.find(a => a.id === entry.id)
    assert.notEqual(updated.path, oldPath)
    assert.equal(updated.generatedRevision, newer.assets[0].revision)
    assert.equal(updated.trust, 'vetted')
  } finally {
    for (const key of ['SCENE_ENDPOINT', 'SCENE_MODEL']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    await rm(workspace, { recursive: true, force: true })
  }
})

test('上传直接补入声明，不新增账本记录且须另行审核', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-bind-upload-'))
  try {
    const service = createService({}, { workspace })
    const declaration = await service.declareAsset({ name: '地图', note: '历史地图' })
    const payload = { name: 'map.png', dataBase64: Buffer.from('image').toString('base64'), side: 'videomake', declarationId: declaration.asset.id }
    const result = await service.uploadAsset(payload)
    assert.equal(result.asset.id, declaration.asset.id)
    assert.equal(result.asset.name, '地图')
    assert.equal(result.asset.type, 'image')
    assert.equal(result.asset.trust, 'unvetted')
    assert.equal((await service.listAssets()).assets.length, 1)
    await assert.rejects(service.uploadAsset(payload), /待实现/)
    await service.updateAsset({ id: declaration.asset.id, action: 'approve' })
    assert.equal((await service.listAssets()).assets[0].trust, 'vetted')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('旧版无侧别文字审核后可读取，制作专用文字不可读取', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-legacy-text-'))
  try {
    const service = createService({}, { workspace })
    const text = await service.addAsset({ type: 'text', name: '旧文字', note: '旧资料正文' })
    await assert.rejects(service.readMaterial({ id: text.asset.id }), /未通过审核/)
    await service.updateAsset({ id: text.asset.id, action: 'approve' })
    assert.equal((await service.readMaterial({ id: text.asset.id })).content, '旧资料正文')
    const film = await service.addAsset({ type: 'text', name: '成片文字', note: '秘密', side: 'videomake', trust: 'vetted' })
    await assert.rejects(service.readMaterial({ id: film.asset.id }), /参考分身/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
