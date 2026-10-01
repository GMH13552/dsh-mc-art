// End-to-end test of the on-demand reference path, through the real plugin host
// half and the real extractor — against a **self-contained fixture**, not against
// whatever happens to be installed on this machine.
//
// The point is not that the functions return something, but that a vanilla or
// other-namespace block becomes a drawable block in a project that has never
// heard of it -- and that the cache is dropped again when nothing holds the block.
//
// WHY THERE IS NO REAL MOD IN HERE (0.2.3):
//   This gate used to be pinned to one third-party mod in one specific 1.12.2
//   install: it asserted the namespace list contained that mod, that its palette
//   label was its Chinese name, and it hardcoded `/home/<user>/...`.  On anyone
//   else's machine that is a skip at best and a false red at worst — and it wrote
//   a third-party mod's name (and its Chinese name) into a public repository.
//   Now the fixture below **is** the reference: a neutral namespace (`examplepkg`)
//   with blocks and `lang` entries we author ourselves, so every assertion is
//   about "what we put in", and the file runs anywhere.
//
// TWO THINGS THIS FILE STILL HAS TO BE CAREFUL ABOUT, both learned the hard way:
//
//  * It once `require('/tmp/mcart21/run.js')` -- a hardcoded working-copy path,
//    so `MCART_HOST` was ignored and "test the artifact that was emitted"
//    silently tested the mirror instead.
//  * It writes to a project's settings: it blanks the reference directory to
//    prove the error message, then puts one back.  What it put back was a
//    hardcoded `.minecraft` rather than what was there, and `.minecraft` makes
//    the extractor auto-pick a version -- the NEXT sweep then measured a
//    different Minecraft for no reason at all.  So the file is snapshotted and
//    restored byte for byte, whatever happens.  (Here the project is ours, but
//    the rule stays: a test does not leave the settings changed.)
const nodeFs = require('fs')
const nodePath = require('path')
const { buildHandlers, fsService } = require('./run.js')
const { realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.test-reference-fixture')
const ROOT = WORK
const PROJECT = 'examplemod'
const REF = nodePath.join(WORK, 'ref')
// 参考根里的"另一个命名空间"：中性名字，夹具自己造，断言只针对我们写进去的东西。
const REF_NS = 'examplepkg'
// 这个数量是为了钉住"一页 >64KB 的 JSON 不能被截断"那条回归（实测过 ~190 KB / 1403 个方块）。
const REF_BLOCKS = 1200
const SETTINGS = nodePath.join(ROOT, PROJECT, 'mc-art.settings.json')

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const handlers = buildHandlers({ fs: fsService, subprocess: realSubprocess() })

/** 一个方块：blockstate + 带 elements 的模型 + 贴图（+ 可选 lang 名）。 */
function putBlock(assets, ns, id, lang) {
  const put = (relative, body, binary) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, binary === true ? body : JSON.stringify(body))
  }
  put('blockstates/' + id + '.json', { variants: { '': { model: ns + ':block/' + id } } })
  const faces = {}
  for (const face of ['down', 'up', 'north', 'south', 'west', 'east']) faces[face] = { texture: '#all' }
  put('models/block/' + id + '.json', { textures: { all: ns + ':block/' + id },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: faces }] })
  put('textures/block/' + id + '.png', Buffer.from(TINY_PNG, 'base64'), true)
  if (lang !== undefined) {
    const langFile = nodePath.join(assets, 'lang', 'zh_cn.json')
    let table = {}
    if (nodeFs.existsSync(langFile)) table = JSON.parse(nodeFs.readFileSync(langFile, 'utf8'))
    table['block.' + ns + '.' + id] = lang
    nodeFs.mkdirSync(nodePath.dirname(langFile), { recursive: true })
    nodeFs.writeFileSync(langFile, JSON.stringify(table))
  }
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  // ---- 项目：自己的两个方块 + 中文名 ----
  const pack = nodePath.join(WORK, PROJECT, 'pack', 'assets', PROJECT)
  putBlock(pack, PROJECT, 'example_soil', '示例土')
  putBlock(pack, PROJECT, 'blood_sac', '示例囊')
  nodeFs.mkdirSync(nodePath.join(WORK, PROJECT), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJECT, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: PROJECT,
      biomes: [{ id: PROJECT, cells: [] }], structures: [{ id: 's', cells: [] }], entities: [], blocks: [] }))
  nodeFs.writeFileSync(SETTINGS, JSON.stringify({ schema: 'mc-art.settings/1',
    reference: { directory: REF, includeGenerated: true, includeMods: true, mods: {} } }))

  // ---- 参考根：原版三块（preview/refIcons 用）+ 一个中性命名空间的 1200 个方块 ----
  const vanilla = nodePath.join(REF, 'assets', 'minecraft')
  for (const [id, chinese] of [['oak_log', '橡木原木'], ['dirt', '泥土'], ['stone', '石头']]) {
    putBlock(vanilla, 'minecraft', id, chinese)
  }
  const other = nodePath.join(REF, 'assets', REF_NS)
  for (let index = 0; index < REF_BLOCKS; index++) {
    // lang 单独写一次（每个方块都重写整个 lang 文件是 O(n²) 的磁盘浪费）。
    putBlock(other, REF_NS, 'b' + index, undefined)
  }
  const langTable = {}
  for (let index = 0; index < REF_BLOCKS; index++) langTable['block.' + REF_NS + '.b' + index] = '示例方块' + index
  nodeFs.mkdirSync(nodePath.join(other, 'lang'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(other, 'lang', 'zh_cn.json'), JSON.stringify(langTable))
  return REF
}

const settingsBefore = () => nodeFs.readFileSync(SETTINGS, 'utf8')

function restoreSettings(before) {
  // Byte for byte: this file is the user's, and a test has no business changing
  // which Minecraft the tool measures.
  if (nodeFs.readFileSync(SETTINGS, 'utf8') !== before) {
    nodeFs.writeFileSync(SETTINGS, before)
    console.log('（参考目录已还原成跑之前的内容）')
  }
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

;(async () => {
  buildFixture()
  const before = settingsBefore()
  try {
    console.log('--- 1. 预览原版方块（项目里从来没有过这个方块）')
    let r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
    check('没有报错', r.error === undefined, r.error)
    check('拿到四边形', Array.isArray(r.quads) && r.quads.length > 0, r.quads && r.quads.length + ' 个')
    check('贴图句柄走 ref: 通道', (r.textureIds || []).every((id) => id.slice(0, 4) === 'ref:'), JSON.stringify(r.textureIds))
    check('贴图真的带回来了', Object.keys(r.textures || {}).length === (r.textureIds || []).length,
      Object.keys(r.textures || {}).length + '/' + (r.textureIds || []).length)
    check('是 data URL', Object.values(r.textures || {}).every((u) => u.slice(0, 15) === 'data:image/png;'))
    const quads = r.quads || []
    check('六面都在', quads.length >= 6, quads.length + ' 面')
    check('坐标贴在 [0,0,0]', quads.every((q) => q.p.every((p) => p.every((v) => v >= -0.001 && v <= 1.001))))

    console.log('--- 2. 项目自己的方块没被这条新路弄坏')
    r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'example_soil', at: [0, 0, 0] })
    check('项目方块仍然能预览', r.error === undefined && (r.quads || []).length > 0, r.error || (r.quads || []).length + ' 面')
    check('项目方块走文件通道', (r.textureIds || []).every((id) => id.slice(0, 4) !== 'ref:'), JSON.stringify(r.textureIds))

    console.log('--- 3. 无命名空间的格子仍然退回项目命名空间')
    r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'blood_sac', at: [0, 0, 0] })
    check('blood_sac 能预览', r.error === undefined && (r.quads || []).length > 0, r.error || (r.quads || []).length + ' 面')

    console.log('--- 4. 参考里有那些命名空间')
    r = await handlers['atlas.refNamespaces']({ root: ROOT, project: PROJECT })
    const names = (r.namespaces || []).map((entry) => entry.name)
    check('能列出命名空间', names.length > 0, names.length + ' 个')
    check('含 minecraft', names.indexOf('minecraft') >= 0, JSON.stringify(names.slice(0, 6)))
    check('含夹具自己造的那个命名空间 ' + REF_NS, names.indexOf(REF_NS) >= 0, JSON.stringify(names.slice(0, 6)))
    check('参考目录已设置', typeof r.directory === 'string' && r.directory.length > 0, r.directory)

    console.log('--- 5. 列出命名空间的方块（这条以前会被 64KB 截断成 JSON 解析失败）')
    const t0 = Date.now()
    r = await handlers['atlas.refBlocks']({ root: ROOT, project: PROJECT, namespace: REF_NS })
    const ms = Date.now() - t0
    check('没有报错', r.error === undefined, r.error)
    const blocks = r.blocks || []
    check('方块数量对得上（>1000，这条 JSON 有 >64KB）', blocks.length > 1000, blocks.length + ' 个，' + ms + 'ms')
    const named = blocks.filter((b) => b.name !== b.id).length
    check('大多数有中文名', named > 0.75 * blocks.length, named + '/' + blocks.length)
    check('中文名就是我们写进去的那个（不是别的模组的）',
      blocks.some((b) => b.id === 'b7' && b.name === '示例方块7'),
      JSON.stringify(blocks.filter((b) => b.id === 'b7')[0]))

    console.log('--- 6. 批量图标')
    r = await handlers['atlas.refIcons']({ root: ROOT, project: PROJECT,
      namespace: 'minecraft', blocks: ['oak_log', 'dirt', 'stone'] })
    check('没有报错', r.error === undefined, r.error)
    const iconKeys = Object.keys(r.icons || {})
    check('图标键是限定名', iconKeys.every((k) => k.indexOf('minecraft:') === 0), JSON.stringify(iconKeys))
    check('三个都拿到了', iconKeys.length === 3, iconKeys.length + '/3')
    check('是 PNG data URL', Object.values(r.icons || {}).every((u) => u.slice(0, 15) === 'data:image/png;'))
    check('名字也带回来了', (r.names || {})['minecraft:oak_log'] === '橡木原木', (r.names || {})['minecraft:oak_log'])

    console.log('--- 7. 结构里混用别的命名空间的方块，真的渲染出来')
    const cells = [
      { block: 'example_soil', at: [0, 0, 0] },
      { block: 'minecraft:oak_log', at: [1, 0, 0] },
      { block: REF_NS + ':b7', at: [2, 0, 0] },
      { block: 'minecraft:stone', at: [0, 1, 0] },
    ]
    r = await handlers['atlas.scene']({ root: ROOT, project: PROJECT, kind: 'biome', id: PROJECT, cells: cells })
    check('没有报错', r.error === undefined, r.error)
    check('四个方块都画出来了', (r.quads || []).length >= 24, (r.quads || []).length + ' 面')
    const palette = (r.palette || []).map((p) => p.block + '=' + p.label)
    check('调色板里原版方块有中文名', palette.some((p) => p.indexOf('minecraft:oak_log=橡木原木') === 0), JSON.stringify(palette))
    check('调色板里那个命名空间的方块有中文名',
      palette.some((p) => p.indexOf(REF_NS + ':b7=示例方块7') === 0), JSON.stringify(palette))
    check('贴图全部到位', Object.keys(r.textures || {}).length === (r.textureIds || []).length,
      Object.keys(r.textures || {}).length + '/' + (r.textureIds || []).length)

    console.log('--- 8. 删除方块后缓存要释放，再问一次要能重新抽出来')
    let released = await handlers['atlas.releaseRefs']({ keep: [PROJECT + ':example_soil'] })
    check('释放掉了东西', released.dropped >= 3, JSON.stringify(released))
    r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
    check('释放后还能重新抽出来', r.error === undefined && (r.quads || []).length > 0, r.error || (r.quads || []).length + ' 面')
    released = await handlers['atlas.releaseRefs']({ keep: ['minecraft:oak_log'] })
    check('留在 keep 里的不会被丢', released.held === 1 && released.dropped === 0, JSON.stringify(released))

    console.log('--- 9. 参考目录没设置时要明说，不能假装成功')
    const saved = await handlers['atlas.saveSettings']({ root: ROOT, project: PROJECT, directory: '',
      includeGenerated: true, includeMods: true, mods: {} })
    check('清空设置成功', saved.error === undefined, saved.error)
    r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
    check('明说没设置参考目录', r.error !== undefined && r.error.indexOf('参考目录') >= 0, r.error)
    await handlers['atlas.saveSettings']({ root: ROOT, project: PROJECT, directory: REF,
      includeGenerated: true, includeMods: true, mods: {} })
    r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
    check('恢复参考目录后又好了', r.error === undefined && (r.quads || []).length > 0, r.error)
  } finally {
    // Even a crash must not leave the settings pointed somewhere else.
    try { restoreSettings(before) } catch (ignored) { /* nothing left to restore */ }
  }
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('THREW', error)
  process.exit(1)
})
