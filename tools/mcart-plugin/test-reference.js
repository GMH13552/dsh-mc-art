// End-to-end test of the on-demand reference path, through the real plugin
// host half and the real extractor against the real installation.
//
// The point is not that the functions return something, but that a vanilla or
// mod block becomes a drawable block in a project that has never heard of it --
// and that the cache is dropped again when nothing holds the block.
//
// TWO THINGS THIS FILE HAS TO BE CAREFUL ABOUT, both learned the hard way:
//
//  * It used to `require('/tmp/mcart21/run.js')` -- a hardcoded working-copy
//    path, so `MCART_HOST` was ignored and "test the artifact that was emitted"
//    silently tested the mirror instead.  (Lesson 53, again.)
//  * It writes to a REAL project's settings: it blanks the reference directory
//    to prove the error message, then puts one back.  What it put back was a
//    hardcoded `.minecraft` rather than what was there, and `.minecraft` makes
//    the extractor auto-pick a version -- it picked 1.12.2, so the NEXT sweep's
//    `orient-test` measured a different Minecraft and 10 assertions about
//    1.18.2 blocks went red for no reason at all.  So the file is snapshotted
//    and restored byte for byte, whatever happens.
const nodeFs = require('fs')
const nodePath = require('path')
const { handlers } = require(process.env.MCART_RUN || nodePath.join(__dirname, 'run.js'))

const ROOT = process.argv[2] || process.cwd()
const PROJECT = 'examplemod'
const SETTINGS = nodePath.join(ROOT, PROJECT, 'mc-art.settings.json')
const settingsBefore = nodeFs.readFileSync(SETTINGS, 'utf8')

function restoreSettings() {
  // Byte for byte: this file is the user's, and a test has no business changing
  // which Minecraft the tool measures.
  if (nodeFs.readFileSync(SETTINGS, 'utf8') !== settingsBefore) {
    nodeFs.writeFileSync(SETTINGS, settingsBefore)
    console.log('（参考目录已还原成跑之前的内容）')
  }
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// This gate's namespace assertions are about AoA3, which exists in the 1.12.2
// install and not in the 1.18.2 one -- so it is pinned to 1.12.2 while
// `orient-test` is pinned to 1.18.2.  Two gates measuring two different
// Minecrafts is not lovely, but it is the truth of what is on this machine, and
// silently measuring the other one is how a sweep reports six failures nobody
// can explain.  Say which one it is and exit 3 (skipped) instead.
const EXPECTED = '1.12.2'

async function requireVersion() {
  const refs = await handlers['atlas.refNamespaces']({ root: ROOT, project: PROJECT })
  const version = String(refs.version || '')
  if (version.indexOf(EXPECTED) >= 0) return
  console.log('跳过：参考目录现在量到的是 ' + (version || '（认不出）') + '，这批断言是按 '
    + EXPECTED + ' 量的（要 aoa3）。')
  console.log('     改 ' + SETTINGS + ' 的 reference.directory 再跑。')
  restoreSettings()
  process.exit(3)
}

;(async () => {
  await requireVersion()
  console.log('--- 1. 预览原版方块（项目里从来没有过这个方块）')
  let r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
  check('没有报错', r.error === undefined, r.error)
  check('拿到四边形', Array.isArray(r.quads) && r.quads.length > 0, r.quads && r.quads.length + ' 个')
  check('贴图句柄走 ref: 通道', (r.textureIds || []).every((id) => id.slice(0, 4) === 'ref:'), JSON.stringify(r.textureIds))
  check('贴图真的带回来了', Object.keys(r.textures || {}).length === (r.textureIds || []).length,
    Object.keys(r.textures || {}).length + '/' + (r.textureIds || []).length)
  check('是 data URL', Object.values(r.textures || {}).every((u) => u.slice(0, 15) === 'data:image/png;'))
  const quads = r.quads || []
  check('六面都在（axis=y 的柱子）', quads.length >= 6, quads.length + ' 面')
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
  const names = (r.namespaces || []).map((n) => n.name)
  check('能列出命名空间', names.length > 0, names.length + ' 个')
  check('含 minecraft', names.indexOf('minecraft') >= 0)
  check('含 aoa3', names.indexOf('aoa3') >= 0)
  check('参考目录已设置', typeof r.directory === 'string' && r.directory.length > 0, r.directory)

  console.log('--- 5. 列出命名空间的方块（这条以前会被 64KB 截断成 JSON 解析失败）')
  const t0 = Date.now()
  r = await handlers['atlas.refBlocks']({ root: ROOT, project: PROJECT, namespace: 'aoa3' })
  const ms = Date.now() - t0
  check('没有报错', r.error === undefined, r.error)
  const blocks = r.blocks || []
  check('方块数量对得上', blocks.length > 1000, blocks.length + ' 个，' + ms + 'ms')
  const named = blocks.filter((b) => b.name !== b.id).length
  check('大多数有中文名', named > 0.75 * blocks.length, named + '/' + blocks.length)
  check('确实是中文而不是英文', blocks.some((b) => b.name === '桉格尼木'),
    JSON.stringify(blocks.filter((b) => b.id === 'achony_log')[0]))

  console.log('--- 6. 批量图标')
  r = await handlers['atlas.refIcons']({ root: ROOT, project: PROJECT, namespace: 'minecraft', blocks: ['oak_log', 'dirt', 'stone'] })
  check('没有报错', r.error === undefined, r.error)
  const iconKeys = Object.keys(r.icons || {})
  check('图标键是限定名', iconKeys.every((k) => k.indexOf('minecraft:') === 0), JSON.stringify(iconKeys))
  check('三个都拿到了', iconKeys.length === 3, iconKeys.length + '/3')
  check('是 PNG data URL', Object.values(r.icons || {}).every((u) => u.slice(0, 15) === 'data:image/png;'))
  check('名字也带回来了', (r.names || {})['minecraft:oak_log'] === '橡木原木', (r.names || {})['minecraft:oak_log'])

  console.log('--- 7. 结构里混用原版方块，真的渲染出来')
  const cells = [
    { block: 'example_soil', at: [0, 0, 0] },
    { block: 'minecraft:oak_log', at: [1, 0, 0] },
    { block: 'aoa3:achony_log', at: [2, 0, 0] },
    { block: 'minecraft:stone', at: [0, 1, 0] },
  ]
  r = await handlers['atlas.scene']({ root: ROOT, project: PROJECT, kind: 'biome', id: 'examplemod', cells: cells })
  check('没有报错', r.error === undefined, r.error)
  check('四个方块都画出来了', (r.quads || []).length >= 24, (r.quads || []).length + ' 面')
  const palette = (r.palette || []).map((p) => p.block + '=' + p.label)
  check('调色板里原版方块有中文名', palette.some((p) => p.indexOf('minecraft:oak_log=橡木原木') === 0), JSON.stringify(palette))
  check('调色板里模组方块有中文名', palette.some((p) => p.indexOf('aoa3:achony_log=桉格尼木') === 0), JSON.stringify(palette))
  check('贴图全部到位', Object.keys(r.textures || {}).length === (r.textureIds || []).length,
    Object.keys(r.textures || {}).length + '/' + (r.textureIds || []).length)

  console.log('--- 8. 删除方块后缓存要释放，再问一次要能重新抽出来')
  let released = await handlers['atlas.releaseRefs']({ keep: ['examplemod:example_soil'] })
  check('释放掉了东西', released.dropped >= 3, JSON.stringify(released))
  r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
  check('释放后还能重新抽出来', r.error === undefined && (r.quads || []).length > 0, r.error || (r.quads || []).length + ' 面')
  released = await handlers['atlas.releaseRefs']({ keep: ['minecraft:oak_log'] })
  check('留在 keep 里的不会被丢', released.held === 1 && released.dropped === 0, JSON.stringify(released))

  console.log('--- 9. 参考目录没设置时要明说，不能假装成功')
  const saved = await handlers['atlas.saveSettings']({ root: ROOT, project: PROJECT, directory: '', includeGenerated: true, includeMods: true, mods: {} })
  check('清空设置成功', saved.error === undefined, saved.error)
  r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
  check('明说没设置参考目录', r.error !== undefined && r.error.indexOf('参考目录') >= 0, r.error)
  await handlers['atlas.saveSettings']({
    root: ROOT, project: PROJECT, directory: process.env.MCART_TEST_MINECRAFT || '',
    includeGenerated: true, includeMods: true, mods: {},
  })
  r = await handlers['atlas.preview']({ root: ROOT, project: PROJECT, block: 'minecraft:oak_log', at: [0, 0, 0] })
  check('恢复参考目录后又好了', r.error === undefined && (r.quads || []).length > 0, r.error)

  restoreSettings()
  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  // Even a crash must not leave the user's project pointed somewhere else.
  try { restoreSettings() } catch (ignored) { /* nothing left to restore */ }
  console.error('THREW', e)
  process.exit(1)
})
