import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
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

test('implementAsset：调用素材 Agent 并将产物转正', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-asset-implement-'))
  try {
    const service = createService({}, { workspace })
    await service._internal.ensureDirs()
    const declared = await service.declareAsset({ name: '枫叶素材', note: '一片秋天的枫叶，用于转场' })
    const rendered = path.join(workspace, 'render.svg')
    await writeFile(rendered, '<svg/>')
    let received
    service.production.generateAsset = async args => { received = args }
    service.generatedAssets.availableFiles = async () => ({ approved: [{ path: rendered }] })
    const out = await service.implementAsset({ id: declared.asset.id })
    assert.equal(received.id, declared.asset.id)
    assert.equal(received.doc.assets[0].name, '枫叶素材')
    assert.match(received.doc.assets[0].description, /枫叶/)
    assert.match(out.asset.path, /^sources\/.+\.svg$/)
    assert.equal(out.asset.declared, undefined)
    assert.equal(out.asset.trust, 'unvetted')
    assert.match(await readFile(path.join(workspace, out.asset.path), 'utf8'), /<svg/)
    await assert.rejects(service.implementAsset({ id: declared.asset.id }), /声明态/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('历史已确认素材可转换为素材池清单', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bohack-legacy-asset-'))
  try {
    const { copyAssetPool } = await import('../lib/generated-assets.js')
    const source = path.join(workspace, 'old.svg')
    await writeFile(source, '<svg/>')
    const output = path.join(workspace, 'film')
    const manifest = await copyAssetPool(output, { id: 'general' }, [{ id: 'box', name: '盒子', type: 'prop', sections: ['B01'], path: source }])
    assert.equal(manifest.assets[0].files[0].path, 'assets/box.svg')
    assert.equal(await readFile(path.join(output, 'assets/box.svg'), 'utf8'), '<svg/>')
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'assets/manifest.json'), 'utf8')), manifest)
  } finally { await rm(workspace, { recursive: true, force: true }) }
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
