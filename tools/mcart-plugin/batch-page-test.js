#!/usr/bin/env node
/**
 * 一页四十格：**一格取不到，不许把整页拖垮**。
 *
 * 撞出来的经过（panel-ui 报的，Lead 复核）：`atlas.itemIcons` 对项目里取不到图标的物品
 * 回 `{items: {<id>: undefined}}` —— `undefined` 不是可无损 JSON，宿主的运行时（`cloneJson`）
 * 会**整条拒收**；`run.js` 的 jsonProblem（同一条判据）当场抛：
 *   `宿主返回值不是可无损 JSON 的数据：…items.nothing_yet.item 是 undefined`
 * 后果不是"那一格空着"，而是**整页 40 格一起失败、屏幕上什么都没有** —— 用户以为面板坏了。
 *
 * 判据：坏格存在时，这一页仍然**返回**、并且是可无损 JSON；坏格有**显式**标记；其余格完好、
 * 数量也不受坏格影响。同类批量 handler（`atlas.icons` / `atlas.refIcons`）一起量。
 *
 *   node tools/mcart-plugin/batch-page-test.js
 *   node tools/mcart-plugin/batch-page-test.js --fault
 *       # 把老的 `out[item] = await itemIcon(...)`（塞 undefined）改回去，
 *       # 要求**共享那套真校验**（run.js 的 jsonProblem，与真运行时 cloneJson 同判据）当场拒绝。
 */
const nodeFs = require('fs')
const nodePath = require('path')

const { loadHost, readHostSource, realSubprocess, fsService } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.batch-page-fixture')
const PROJ = 'proj'
const NS = 'batchns'
const REF = nodePath.join(WORK, 'ref')
const MOD = 'refmod'

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 自包含夹具：一个**好**物品 + 一个**根本不存在**的物品（坏格）。 */
function buildPageFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  const png = Buffer.from(TINY_PNG, 'base64')
  put('textures/item/good.png', png)
  put('models/item/generated.json', { parent: 'builtin/generated', textures: { layer0: NS + ':item/good' } })
  put('models/item/good.json', { parent: 'item/generated', textures: { layer0: NS + ':item/good' } })
  // 项目自己的一个方块（给 `atlas.icons` 用：它按 `models/block/<名字>.json` 取图标）。
  put('textures/block/solid.png', png)
  put('blockstates/solid.json', { variants: { '': { model: NS + ':block/solid' } } })
  const blockFaces = {}
  for (const face of ['down', 'up', 'north', 'south', 'west', 'east']) blockFaces[face] = { texture: '#all' }
  put('models/block/solid.json', { textures: { all: NS + ':block/solid' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: blockFaces }] })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: REF, includeGenerated: true, includeMods: true, mods: {} } }))

  // 参考根：一个**好**方块（给 atlas.refIcons 用），没有别的。
  const ref = nodePath.join(REF, 'assets', MOD)
  const putRef = (relative, body) => {
    const target = nodePath.join(ref, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  putRef('textures/block/solid.png', png)
  putRef('blockstates/solid.json', { variants: { '': { model: MOD + ':block/solid' } } })
  const faces = {}
  for (const face of ['down', 'up', 'north', 'south', 'west', 'east']) faces[face] = { texture: '#all' }
  putRef('models/block/solid.json', { textures: { all: MOD + ':block/solid' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: faces }] })
}

const pageArgs = (items) => ({ root: WORK, project: PROJ, namespace: NS, source: 'project', items: items })

async function main() {
  buildPageFixture()
  const source = readHostSource()
  let patched = source
  if (FAULT) {
    // 把老写法塞回去：坏条目直接进 itemIcon（`item: parsed.item` 就是 undefined），
    // 并且不设"坏格"分支 —— 复现 Lead 贴的那条报错。
    const before = patched
    patched = patched.replace('        if (reason !== null) {', '        if (false && reason !== null) {')
    patched = patched.replace("          out[item] = missingItemIcon(namespace, item, reason)\n          continue\n",
      '')
    patched = patched.replace("item: text(parsed.item, ''),", 'item: parsed.item,')
    if (patched === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到那两处（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把 `out[item] = await itemIcon(...)`（塞 undefined）改回去')
  }
  const handlers = loadHost(patched, { fs: fsService, subprocess: realSubprocess() })

  console.log('--- atlas.itemIcons：一页里混一个取不到图标的物品')
  let page = null
  let thrown = null
  try {
    page = await handlers['atlas.itemIcons'](pageArgs(['good', 'nothing_yet']))
  } catch (error) {
    thrown = String(error && error.message ? error.message : error)
  }
  const items = (page && page.items) || {}
  check('坏格存在时这一页**仍然返回**（没被运行时拒收、也没抛）',
    thrown === null && page !== undefined && page.error === undefined, thrown === null ? JSON.stringify(Object.keys(items)) : thrown)
  if (thrown === null && page !== undefined) {
    check('坏格**在**返回里（不许整格消失）', Object.prototype.hasOwnProperty.call(items, 'nothing_yet'),
      JSON.stringify(Object.keys(items)))
    check('坏格有显式标记 missing:true', (items.nothing_yet || {}).missing === true,
      JSON.stringify(items.nothing_yet))
    check('坏格说得清为什么（error/reason 是提到这个 id 的字符串）',
      typeof (items.nothing_yet || {}).error === 'string' && items.nothing_yet.error !== '' &&
        items.nothing_yet.error.indexOf('nothing_yet') >= 0,
      JSON.stringify((items.nothing_yet || {}).error))
    check('坏格仍然是合法的 itemIcon 形状（shape/layers/quads 都在）',
      typeof items.nothing_yet.shape === 'string' && Array.isArray(items.nothing_yet.layers) &&
        Array.isArray(items.nothing_yet.quads) && typeof items.nothing_yet.display !== 'undefined',
      JSON.stringify(Object.keys(items.nothing_yet)))
    check('**好格完好**：一样拿到了图层（坏格没有影响它）',
      items.good !== undefined && items.good.missing !== true &&
        Array.isArray(items.good.layers) && items.good.layers.length > 0,
      JSON.stringify({ layers: (items.good || {}).layers, shape: (items.good || {}).shape }))
    check('好格也照样是可无损 JSON 的普通对象（没有 undefined 字段）',
      items.good !== undefined && JSON.stringify(items.good) !== undefined, undefined)
  }

  // 坏格排在最前面也一样 —— "整页不因一格而失败"不能只在一个顺序下成立。
  let reordered = null
  let reorderThrown = null
  try { reordered = await handlers['atlas.itemIcons'](pageArgs(['nothing_yet', 'good'])) }
  catch (error) { reorderThrown = String(error && error.message ? error.message : error) }
  check('坏格排在最前面时整页仍然返回，好格也还在',
    reorderThrown === null && reordered !== undefined &&
      ((reordered.items || {}).good || {}).missing !== true &&
      Array.isArray(((reordered.items || {}).good || {}).layers) &&
      ((reordered.items || {}).good || {}).layers.length > 0,
    reorderThrown === null ? JSON.stringify(Object.keys((reordered || {}).items || {})) : reorderThrown)

  console.log('--- 同类批量 handler：一个坏名字不许拖垮整批')
  {
    // 项目方块图标：好方块 + 不存在的方块。
    const icons = await handlers['atlas.icons']({ root: WORK, project: PROJ, blocks: ['solid', 'nope_block'] })
    check('atlas.icons：整批返回、好方块有图标、坏名字进 failed',
      icons !== undefined && icons.error === undefined &&
        typeof (icons.icons || {}).solid === 'string' &&
        (icons.icons || {}).nope_block === undefined &&
        Array.isArray(icons.failed) && icons.failed.some((line) => String(line).indexOf('nope_block') >= 0),
      JSON.stringify({ keys: Object.keys(icons.icons || {}), failed: icons.failed }))

    // 参考方块图标：好方块 + 不存在的方块（走真抽取器的 --icons）。
    const refIcons = await handlers['atlas.refIcons']({
      root: WORK, project: PROJ, namespace: MOD, blocks: ['solid', 'nope_block'],
    })
    check('atlas.refIcons：整批返回、好方块有图标、坏名字进 failed（不是 undefined 把整批拒掉）',
      refIcons !== undefined && refIcons.error === undefined &&
        typeof (refIcons.icons || {})[MOD + ':solid'] === 'string' &&
        (refIcons.icons || {})[MOD + ':nope_block'] === undefined &&
        Array.isArray(refIcons.failed) && refIcons.failed.some((line) => String(line).indexOf('nope_block') >= 0),
      JSON.stringify({ keys: Object.keys((refIcons || {}).icons || {}), failed: (refIcons || {}).failed }))
    check('atlas.refIcons：names 里每个键都是字符串（缺名字时退回 id，不给 undefined）',
      Object.keys(refIcons.names || {}).every((key) => typeof refIcons.names[key] === 'string'),
      JSON.stringify(refIcons.names))
  }
  {
    // 顺带：其它批量 handler 在退化输入下也必须回可无损 JSON（这几条是回归网，不是本次缺陷）。
    for (const [name, args] of [
      ['atlas.scan', { root: WORK }],
      ['atlas.refBlocks', { root: WORK, project: PROJ, namespace: MOD }],
      ['atlas.refItems', { root: WORK, project: PROJ, namespace: NS, source: 'project' }],
      ['atlas.icon', { root: WORK, project: PROJ, namespace: NS, item: 'nothing_yet', source: 'project' }],
    ]) {
      let out = null
      let bad = null
      try { out = await handlers[name](args) } catch (error) { bad = String(error && error.message ? error.message : error) }
      check(name + ' 在退化输入下回的是可无损 JSON（没被运行时拒收）', bad === null && out !== undefined,
        bad === null ? JSON.stringify(out).slice(0, 80) : bad)
    }
  }

  // ── 可选的真实工程（只读）：一页里混一个真不存在的物品 ───────────────────────
  const real = process.env.MCART_REAL_PROJECT || ''
  if (real !== '') {
    const projectDir = nodePath.resolve(real)
    const root = nodePath.dirname(projectDir)
    const projectId = nodePath.basename(projectDir)
    const scanned = await handlers['atlas.scan']({ root: root })
    const project = ((scanned && scanned.projects) || []).filter((item) => item.id === projectId)[0]
    let source = 'project'
    let namespace = project === undefined ? '' : project.namespace
    let ids = []
    if (project !== undefined) {
      const listed = await handlers['atlas.refItems']({ root: root, project: projectId,
        namespace: project.namespace, source: 'project' })
      ids = ((listed && listed.items) || []).slice(0, 3).map((item) => item.id)
    }
    if (ids.length === 0) {
      // 这个工程没有自己的物品模型（只有方块）——就换成参考目录里的原版物品，
      // 照样量"一页里混一个取不到的物品"。页面路径是同一条。
      source = 'reference'
      namespace = 'minecraft'
      ids = ['carrot', 'stick', 'dirt']
    }
    if (namespace !== '' && ids.length > 0) {
      const realPage = await handlers['atlas.itemIcons']({
        root: root, project: projectId, namespace: namespace, source: source,
        items: ids.concat(['definitely_not_an_item_here']),
      })
      const realItems = (realPage && realPage.items) || {}
      // 好格 = 真的画出了东西（平面物品是 layers，方块物品是 iso 的 quads）。
      const good = ids.filter((id) => {
        const recipe = realItems[id]
        if (recipe === undefined || recipe.missing === true) return false
        return (Array.isArray(recipe.layers) && recipe.layers.length > 0) ||
          (Array.isArray(recipe.quads) && recipe.quads.length > 0)
      })
      console.log('    真实工程：source=' + source + ' namespace=' + namespace + '，好格 ' + good.length + '/' + ids.length
        + '，坏格标记 = ' + JSON.stringify((realItems.definitely_not_an_item_here || {}).missing === true))
      check('real: 真工程里混一个不存在的物品，整页仍然返回、好格拿到图层、坏格有显式标记',
        realPage !== undefined && realPage.error === undefined && good.length === ids.length &&
          (realItems.definitely_not_an_item_here || {}).missing === true,
        JSON.stringify({ good: good, keys: Object.keys(realItems) }))
    } else {
      console.log('    真实工程：SKIP（没有命名空间/物品可问）')
    }
  }

  // ── 反向夹具：老写法必须被**共享那套真校验**当场拒掉 ────────────────────────
  if (FAULT) {
    console.log('--- --fault 判定：老写法（塞 undefined）必须被 jsonProblem / cloneJson 拒收')
    check('注入之后这一页**真的被校验拒了**（不是被我自己新写的断言抓住）',
      thrown !== null && thrown.indexOf('不是可无损 JSON') >= 0, thrown)
    check('拒收的理由指向坏格的那个字段（…items.<id> … undefined）',
      thrown !== null && thrown.indexOf('nothing_yet') >= 0 && thrown.indexOf('undefined') >= 0, thrown)

    // 再用**共享门禁那套**（run.js 的 buildHandlers）跑一遍，证明是同一条判据。
    const patchedPath = nodePath.join(WORK, 'fault-host.js')
    nodeFs.writeFileSync(patchedPath, patched)
    const previous = process.env.MCART_HOST
    process.env.MCART_HOST = patchedPath
    let shared = null
    try {
      delete require.cache[require.resolve('./run.js')]
      const fresh = require('./run.js')
      const sharedHandlers = fresh.buildHandlers({ fs: fresh.fsService, subprocess: realSubprocess() })
      await sharedHandlers['atlas.itemIcons'](pageArgs(['good', 'nothing_yet']))
      shared = null
    } catch (error) {
      shared = String(error && error.message ? error.message : error)
    } finally {
      if (previous === undefined) delete process.env.MCART_HOST
      else process.env.MCART_HOST = previous
      delete require.cache[require.resolve('./run.js')]
    }
    check('run.js 那套共享校验（与真运行时 cloneJson 同判据）也当场拒收',
      shared !== null && shared.indexOf('不是可无损 JSON') >= 0, shared)

    // 故障注入下**必须**有断言变红，否则这些断言就是摆设。
    const expected = [
      '坏格存在时这一页**仍然返回**（没被运行时拒收、也没抛）',
      '坏格排在最前面时整页仍然返回，好格也还在',
    ]
    const missed = expected.filter((label) => failedLabels.indexOf(label) < 0)
    console.log('--- 故障注入结果：' + failures + ' 条断言变红')
    console.log('    变红的：' + (failedLabels.join(' | ') || '（一条都没有）'))
    if (missed.length > 0) {
      console.log('  FAIL 故障注入没有让这些断言变红（门禁对它们失效）：' + missed.join(' / '))
      process.exit(1)
    }
  }

  if (FAULT) {
    console.log('全部通过（故障注入下这些断言确实会红）')
    return 0
  }
  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
