#!/usr/bin/env node
/**
 * 「新建项目」的门禁：空目录 → 建骨架 → 面板认得它，而且**一个模组一个命名空间**。
 *
 * 为什么要有：这是新手第一步。宿主认项目的规则是"目录里有 mc-art.atlas.json
 * **或** pack/assets/<命名空间>/"——但**只有 atlas、没有资源目录**时 `build()` 会跳过它
 * （命名空间推不出来）。所以"建完能不能被认出来"必须有人盯着，故障注入那条就是证明。
 *
 *   node tools/mcart-plugin/project-test.js
 *   node tools/mcart-plugin/project-test.js --fault   # **证明前提**：只写 atlas、不建 pack 时
 *      项目认不出来。前提若被推翻（居然认出来了）这条就会红 —— 它证明"骨架是必需的"。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const { handlers, buildHandlers, localFsShim } = require('./run.js')
const fsService = require('./run.js').fsService

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.project-fixture')
// 「服务缺席」那一组的场地：和上面分开，免得互相看见对方的项目。
const WORK2 = nodePath.join(REPO, 'tools', 'mcart-plugin', '.project-fixture-nosvc')
const FAULT = process.argv.includes('--fault')
// 1×1 的 PNG（只在门禁里当字节用）。
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}
const scan = async () => (await handlers['atlas.scan']({ root: WORK })).projects

async function main() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.mkdirSync(WORK, { recursive: true })

  check('空目录里没有项目（面板该给引导，而不是报错）', (await scan()).length === 0)

  if (FAULT) {
    // 只写 atlas、不建 pack 骨架 —— 这正是"看起来成功但其实认不出来"的写法。
    const dir = nodePath.join(WORK, 'faultproj')
    nodeFs.mkdirSync(dir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(dir, 'mc-art.atlas.json'),
      JSON.stringify({ schema: 'mc-art.atlas/1', namespace: 'faultproj', biomes: [], structures: [], entities: [], blocks: [] }))
    const found = await scan()
    check('只有 atlas 的目录认不出来（所以骨架是必需的）', found.length === 0,
      JSON.stringify(found.map((p) => p.id)))
    nodeFs.rmSync(WORK, { recursive: true, force: true })
    console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
    process.exit(failures === 0 ? 0 : 1)
  }

  const made = await handlers['atlas.createProject']({ root: WORK, id: 'examplemod', namespace: 'examplemod' })
  check('建项目成功', made && made.created === true, JSON.stringify(made))
  const after = await scan()
  check('扫得到刚建的项目，命名空间正确',
    after.length === 1 && after[0].id === 'examplemod' && after[0].namespace === 'examplemod',
    JSON.stringify(after.map((p) => p.id + ':' + p.namespace)))
  check('骨架目录真的落在盘上',
    nodeFs.existsSync(nodePath.join(WORK, 'examplemod', 'pack', 'assets', 'examplemod', 'textures', 'block')),
    nodePath.join(WORK, 'examplemod', 'pack'))

  const again = await handlers['atlas.createProject']({ root: WORK, id: 'examplemod' })
  check('同一目录再建一次 → 拒绝（不会覆盖）', again && typeof again.error === 'string', JSON.stringify(again))

  // 真实场景：有人手写了 pack/assets/alpha（没有 atlas），这时不许再给它塞第二个命名空间。
  nodeFs.mkdirSync(nodePath.join(WORK, 'manual', 'pack', 'assets', 'alpha'), { recursive: true })
  const other = await handlers['atlas.createProject']({ root: WORK, id: 'manual', namespace: 'beta' })
  check('目录里已有别的命名空间 → 拒绝（一个模组只用一个）',
    other && typeof other.error === 'string' && other.error.indexOf('命名空间') >= 0, JSON.stringify(other))
  const same = await handlers['atlas.createProject']({ root: WORK, id: 'manual', namespace: 'alpha' })
  check('用已有的那个命名空间 → 允许（不制造第二个）', same && same.created === true, JSON.stringify(same))

  const bad = await handlers['atlas.createProject']({ root: WORK, id: '../escape' })
  check('id 里的路径符号被拒（不许写到根目录外面）', bad && typeof bad.error === 'string', JSON.stringify(bad))

  const badNs = await handlers['atlas.createProject']({ root: WORK, id: 'okid', namespace: 'Bad-Name' })
  check('非法命名空间被拒', badNs && typeof badNs.error === 'string', JSON.stringify(badNs))

  // ── 服务缺席：用户机器上真出现过的状态 ────────────────────────────────────
  //
  // 桌面端实测：面板能扫描、能弹系统目录对话框，但"建目录"只回一句
  //「宿主没有 shell 服务时建不出目录」——而那句话是**猜的**（ensureDir 只看了
  // exitCode，既没查服务在不在，也没把 shell 自己的报错带回来）。所以这一组把
  // "谁缺席"变成能造出来的状态，逐条盯住：每件写入都有退路，四条路全断时必须
  // 说清是哪四条。造不出来 = 这段门禁自己先红。
  nodeFs.rmSync(WORK2, { recursive: true, force: true })
  nodeFs.mkdirSync(WORK2, { recursive: true })

  // (a) 只有 fs 服务（最像用户那台）：没有 shell、没有目录选择器。
  const fsOnly = buildHandlers({ fs: fsService })
  const a = await fsOnly['atlas.createProject']({ root: WORK2, id: 'fsonly' })
  check('只有 fs 服务时也能建出项目', a && a.created === true, JSON.stringify(a))
  check('空目录是写 .gitkeep 占位建出来的（shell 不在）',
    a && a.placeholder === true && String(a.via).indexOf('fs') >= 0, JSON.stringify(a && a.via))
  check('骨架目录真的落在盘上',
    nodeFs.existsSync(nodePath.join(WORK2, 'fsonly', 'pack', 'assets', 'fsonly', 'lang')),
    nodePath.join(WORK2, 'fsonly'))

  // (b) 一个服务都没有，只有 node 垫片：这是真 mkdir，不留占位文件。
  const shimOnly = buildHandlers({ nodeFs: localFsShim })
  const b = await shimOnly['atlas.createProject']({ root: WORK2, id: 'shimonly' })
  check('连 fs 服务都没有时，node 垫片把项目建出来', b && b.created === true, JSON.stringify(b))
  check('这条路是真 mkdir（不留 .gitkeep）',
    b && String(b.via).indexOf('node:fs') >= 0 && b.placeholder !== true, JSON.stringify(b && b.via))
  check('目录在、且没有占位文件',
    nodeFs.existsSync(nodePath.join(WORK2, 'shimonly', 'pack', 'assets', 'shimonly', 'blockstates')) &&
    !nodeFs.existsSync(nodePath.join(WORK2, 'shimonly', 'pack', 'assets', 'shimonly', 'lang', '.gitkeep')),
    nodePath.join(WORK2, 'shimonly'))
  const scannedShim = (await shimOnly['atlas.scan']({ root: WORK2 })).projects
  check('没有 fs 服务时扫描也认得出来（读也走垫片）',
    scannedShim.some((p) => p.id === 'shimonly'), JSON.stringify(scannedShim.map((p) => p.id)))
  const listedShim = await shimOnly['atlas.projects']({ path: WORK2 })
  check('没有 fs 服务也能列目录找项目',
    listedShim && (listedShim.projects || []).length >= 1, JSON.stringify(listedShim))
  const env = await shimOnly['atlas.env']({})
  check('atlas.env 如实报告缺了哪些服务',
    env && env.services.fs === false && env.services.shell === false && env.services.localFs === true,
    JSON.stringify(env && env.services))
  const saved = await shimOnly['atlas.saveTexture']({ root: WORK2, project: 'shimonly',
    path: WORK2 + '/shimonly/pack/assets/shimonly/textures/block/t.png', base64: PNG_BASE64 })
  check('没有 shell 服务也能写贴图字节', saved && saved.saved === true, JSON.stringify(saved))
  check('贴图字节真的写对了（PNG 魔数）',
    nodeFs.existsSync(nodePath.join(WORK2, 'shimonly', 'pack', 'assets', 'shimonly', 'textures', 'block', 't.png')) &&
    nodeFs.readFileSync(nodePath.join(WORK2, 'shimonly', 'pack', 'assets', 'shimonly', 'textures', 'block', 't.png'))
      .slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), '')

  // (c) 目录走宿主那个"新建文件夹"API（directoryPickerController）：这是 harness 自己
  //     的建目录入口（目录选择器用的就是它），所以它排在第一条。它**非递归**、已存在
  //     会抛 EEXIST —— 用它当桩，正好也测住两件事：先建父目录的顺序，以及
  //     "中间层不在骨架清单里"（textures/block 这种）时它会自己先把父目录补出来。
  //     文件（atlas）另算：这个 API 只建目录，所以这一组仍然配着 fs 服务。
  const pickerCalls = []
  const pickerOnly = buildHandlers({ fs: fsService, picker: {
    async createDirectory(parent, name) {
      pickerCalls.push(parent + '|' + name)
      const target = parent + '/' + name
      if (nodeFs.existsSync(target)) throw new Error('directory-exists: ' + target)
      nodeFs.mkdirSync(target)
      return target
    },
  } })
  const d = await pickerOnly['atlas.createProject']({ root: WORK2, id: 'pickeronly' })
  check('有目录选择器 API 时也能建出项目', d && d.created === true, JSON.stringify(d))
  check('目录真的走了 directoryPickerController（不是被后面的路兜住的）',
    d && String(d.via).indexOf('directoryPickerController') >= 0, JSON.stringify(d && d.via))
  check('第一个调用就是项目目录自己，且名字永远是单段',
    pickerCalls.length >= 8 && pickerCalls[0].indexOf('|pickeronly') > 0 &&
    pickerCalls.every((call) => call.split('|')[1].indexOf('/') < 0),
    JSON.stringify(pickerCalls.slice(0, 3)) + ' …共 ' + pickerCalls.length + ' 次')

  // (d) 四条路全断：失败信息必须逐个点名，而不是含糊一句"没有 shell 服务"。
  const nothing = buildHandlers({})
  const c = await nothing['atlas.createProject']({ root: WORK2, id: 'nowhere' })
  check('一个服务都没有时确实失败', c && typeof c.error === 'string', JSON.stringify(c))
  const why = String(c && c.error)
  check('失败信息逐个列出试过的四条路',
    ['directoryPickerController', 'shell', 'fs', 'node:fs'].every((key) => why.indexOf(key) >= 0), why)

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.rmSync(WORK2, { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((error) => { console.error('THREW', error); process.exit(1) })
