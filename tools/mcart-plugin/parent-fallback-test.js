#!/usr/bin/env node
/**
 * 母模型兜底链：**"取到了"不等于"能用"**。
 *
 * 用户实测 `…:abyss_bricks`（模型文件完全正常：`parent: minecraft:block/cube_all` + 一张
 * 项目自己的贴图，同族逐字同形的都能画）却报"整条链一个面都没画出来 / 原因：unknown"。
 *
 * 根因：`resolveBlockModel` 的兜底链是
 *   `loadParent(parent) || VANILLA_PARENTS[...] || VANILLA_PARENTS[bare] || { textures: {} }`
 * —— `loadParent` 回一个**真值但空**的壳（`{}` / `{textures:{}}`）时，`||` 认为"解析到了"，
 * **短路掉内置母模型表**，链到此为止 → 没有 elements。而 `unknown` 又掩盖了真正的失败。
 *
 * 判据（行为级，真 host + 真夹具）：
 *   1. `parent: minecraft:block/cube_all` 的项目方块，在**参考目录不可用**（内置表是唯一出路）
 *      时画得出来；
 *   2. 项目包里**放一个空壳 `models/block/cube_all.json`** 想盖住内置表时，**仍然画得出来**
 *      （这正是用户那种形态）；
 *   3. 链真的断了（空壳 + 内置表也没有那个键）时，`reason` 必须是 `no-geometry`，
 *      **不许是 `unknown`**，而且不把用户引向"方块实体渲染"；
 *   4. "已试过的路"里内置表那一行要按**实际是否用过**说，不能什么都没缺时也写"（这次没走到）"。
 *
 *   node tools/mcart-plugin/parent-fallback-test.js
 *   node tools/mcart-plugin/parent-fallback-test.js --fault
 *       # 把兜底链改回"真值即可用" -> 第 2 条必须红（用户踩到的那一版）。
 */
const nodeFs = require('fs')
const nodePath = require('path')

const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.parent-fallback-fixture')
// 两个工程：`plain` 的包里**没有** cube_all（内置表是唯一出路）；`shell` 的包里有一个**空壳**
// cube_all（用户那种形态：想盖住内置表）。
const PLAIN = { id: 'plain', ns: 'exfq' }
const SHELL = { id: 'shell', ns: 'exfb' }
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const png = Buffer.from(TINY_PNG, 'base64')
  const project = (which) => {
    const assets = nodePath.join(WORK, which.id, 'pack', 'assets', which.ns)
    const put = (relative, body) => {
      const target = nodePath.join(assets, relative)
      nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
      nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
    }
    const block = (id, parent, texture) => {
      put('blockstates/' + id + '.json', { variants: { '': { model: which.ns + ':block/' + id } } })
      put('models/block/' + id + '.json', { parent: parent, textures: { all: texture } })
    }
    return { put: put, block: block, assets: assets }
  }

  // ── plain：包里没有 cube_all，内置表是唯一出路 ──────────────────────────────
  const plain = project(PLAIN)
  plain.put('textures/block/builtin_parent.png', png)
  plain.block('builtin_parent', 'minecraft:block/cube_all', PLAIN.ns + ':block/builtin_parent')
  // 内置表真的兜住、但贴图解不出来 -> 报告里"已试过的路"能看到它被用上。
  plain.block('builtin_hit_no_texture', 'minecraft:block/cube_all', PLAIN.ns + ':block/missing_texture')

  // ── shell：包里有一个空壳 cube_all，想盖住内置表（用户那种形态） ─────────────
  const shell = project(SHELL)
  shell.put('models/block/cube_all.json', { textures: {} })
  shell.put('textures/block/shell_parent.png', png)
  shell.block('shell_parent', 'minecraft:block/cube_all', SHELL.ns + ':block/shell_parent')
  // 链真的断：空壳 + 内置表里也没有那个键。
  shell.block('builtin_then_gap', 'minecraft:block/definitely_not_a_vanilla_parent', SHELL.ns + ':block/nope')
  shell.put('models/block/definitely_not_a_vanilla_parent.json', { textures: {} })

  for (const which of [PLAIN, SHELL]) {
    nodeFs.writeFileSync(nodePath.join(WORK, which.id, 'mc-art.atlas.json'),
      JSON.stringify({ schema: 'mc-art.atlas/1', namespace: which.ns, biomes: [], structures: [],
        entities: [], blocks: [] }))
    // 参考目录**空**：内置表是唯一能兜住的（用户那份报告的场景正是"jar 那条路不可用"）。
    nodeFs.writeFileSync(nodePath.join(WORK, which.id, 'mc-art.settings.json'),
      JSON.stringify({ schema: 'mc-art.settings/1',
        reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
  }
}

const scene = (handlers, which, id) =>
  handlers['atlas.scene']({ root: WORK, project: which.id, kind: 'block', id: id })

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    // 老写法：`loadParent(parent) || …` —— 真值（哪怕是个空壳）就算"解析到了"。
    const before = source
    source = source.replace('    if (parentModelUsable(loaded)) {',
      '    if (loaded !== undefined && loaded !== null) {')
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到 parentModelUsable 那个判定（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把兜底链改回"真值即可用"（空壳短路内置表 —— 用户踩到的那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })

  console.log('--- 1/2. 内置表是唯一出路：包里没有空壳（对照）与有空壳，都必须画得出来')
  const control = await scene(handlers, PLAIN, 'builtin_parent')
  check('对照组（包里没有 cube_all）走内置表画得出来',
    control !== undefined && control.error === undefined && control.quads.length > 0,
    control === undefined ? 'undefined' : (control.error === undefined ? control.quads.length + ' 面' : String(control.error).split('\n')[0]))
  const shelled = await scene(handlers, SHELL, 'shell_parent')
  check('空壳在包里（`models/block/cube_all.json` = {textures:{}}）时**仍然**画得出来 —— 这是用户那种形态',
    shelled !== undefined && shelled.error === undefined && shelled.quads.length > 0,
    shelled === undefined ? 'undefined' : (shelled.error === undefined ? shelled.quads.length + ' 面' : String(shelled.error).split('\n')[0]))
  check('两种情况下选用的模型都是 blockstate 里写的那个（不是猜的）',
    control !== undefined && shelled !== undefined &&
      control.model === PLAIN.ns + ':block/builtin_parent' && shelled.model === SHELL.ns + ':block/shell_parent',
    JSON.stringify({ control: control === undefined ? null : control.model, shelled: shelled === undefined ? null : shelled.model }))

  console.log('--- 3. 链真的断了：reason 必须是 no-geometry，不许是 unknown')
  const broken = await scene(handlers, SHELL, 'broken_chain_placeholder')
  check('空的 / 不存在的方块仍然照常报错，不是静默',
    broken !== undefined && broken.error !== undefined, JSON.stringify(broken).slice(0, 120))
  const gap = await scene(handlers, SHELL, 'builtin_then_gap')
  const diagnostic = (gap && gap.diagnostic) || {}
  check('链断了的诊断 reason = no-geometry（不是 unknown）',
    diagnostic.reason === 'no-geometry', String(diagnostic.reason))
  const text = String((gap || {}).error)
  check('人读文本说"整条链没有任何 elements"，并且点出"通常是母模型没取到"',
    text.indexOf('没有任何 elements') >= 0 && text.indexOf('母模型') >= 0, text.split('\n').filter((l) => l.indexOf('elements') >= 0)[0])
  check('不再拿旧那句当结论（"模型链是完整的，但…可能靠方块实体渲染"）',
    text.indexOf('模型链是完整的，但') < 0, text.split('\n').filter((l) => l.indexOf('模型链') >= 0).join(' / '))
  check('"已试过的路"里内置表那一行按实际说（这条是"查过、没有那个键"）',
    Array.isArray(diagnostic.tried) && diagnostic.tried.some((line) =>
      line.indexOf('面板内置的原版母模型表：') === 0 && line.indexOf('查过，没有') >= 0),
    JSON.stringify(diagnostic.tried && diagnostic.tried[1]))

  console.log('--- 4. 内置表**真的**兜住时，那一行要敢说"这一条是它兜住的"')
  // 这个方块的 parent 就是内置表里的 `block/cube_all`（兜住了），但贴图解不出来 -> 仍然出报告，
  // 于是"已试过的路"里能看到内置表那条被真的用上（旧代码这里会写"（这次没走到）"）。
  const usedBuiltin = await scene(handlers, PLAIN, 'builtin_hit_no_texture')
  const usedDiag = (usedBuiltin && usedBuiltin.diagnostic) || {}
  check('内置表被用上时，报告里写着命中的键 + "这一条是它兜住的"（不是"这次没走到"）',
    Array.isArray(usedDiag.tried) && usedDiag.tried.some((line) =>
      line.indexOf('面板内置的原版母模型表：') === 0 && line.indexOf('block/cube_all') >= 0
      && line.indexOf('它兜住的') >= 0 && line.indexOf('这次没走到') < 0),
    JSON.stringify(usedDiag.tried && usedDiag.tried[1]))

  if (FAULT) {
    // 用户那一版里，报告本身的 reason 也**不许**是 unknown（②的判据一起钉在这里）。
    const shellDiag = (shelled && shelled.diagnostic) || {}
    check('故障注入下（= 用户那一版）报告里的 reason 也不是 unknown（这条把②一起钉住）',
      shelled !== undefined && shelled.diagnostic !== undefined &&
        typeof shellDiag.reason === 'string' && shellDiag.reason !== '' && shellDiag.reason !== 'unknown',
      JSON.stringify(shellDiag.reason))
    const expected = ['空壳在包里（`models/block/cube_all.json` = {textures:{}}）时**仍然**画得出来 —— 这是用户那种形态']
    const missed = expected.filter((label) => failedLabels.indexOf(label) < 0)
    console.log('--- 故障注入结果：' + failures + ' 条断言变红')
    console.log('    变红的：' + (failedLabels.slice(0, 6).join(' | ') || '（一条都没有）'))
    if (missed.length > 0) {
      console.log('  FAIL 故障注入没有让这些断言变红（门禁对它们失效）：' + missed.join(' / '))
      process.exit(1)
    }
    console.log('全部通过（故障注入下这些断言确实会红）')
    return 0
  }
  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
