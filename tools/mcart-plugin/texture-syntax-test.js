#!/usr/bin/env node
/**
 * 面的贴图**写漏了 `#`**：这不是"缺贴图"，是语法错。
 *
 * 用户实测：`altar` / `research_desk` 是手写的多 element 模型，每个面写成
 *   `"faces": { "up": { "texture": "stone", "uv": [0,0,16,16] } }`   ← 少了 `#`
 * （两个文件里共 80 处；其余模型全部写法正确）。模型格式里**裸词是路径**：
 * `stone` → `<命名空间>:textures/stone.png`（贴图其实在 `textures/block/` 下）→ 每个面都取不到
 * → 整块丢掉。这两个方块在游戏里同样是坏的。
 *
 * 面板原来说"贴图解不出来"（`textures-unresolved`），于是人跑去翻贴图目录找 PNG ——
 * 而真正要改的是一个字符。这条门禁钉住三件事：
 *   1. 裸词 + 它**恰好是**这张模型 `textures` 映射里的键 → reason `texture-missing-hash`，
 *      并且明说"**你大概想写 `#<词>`**"，还列出映射里的键；
 *   2. 同一个模型把裸词改成 `#词` 就画得出来（证明那句话是对的）；
 *   3. 真·路径不存在仍是 `textures-unresolved`、`#变量` 找不到是 `texture-variable-unresolved`
 *      —— 三者的话**不许一样**。
 *
 *   node tools/mcart-plugin/texture-syntax-test.js
 *   node tools/mcart-plugin/texture-syntax-test.js --fault
 *       # 把"裸词分类"改回不做 -> 第 1/2 条必须红（回到只会说"缺贴图"的那一版）。
 */
const nodeFs = require('fs')
const nodePath = require('path')

const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.texture-syntax-fixture')
const PROJ = 'proj'
const NS = 'exsyn'
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 一个方块：blockstate + 模型（模型体由调用方给）+ 贴图文件。 */
function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  const box = (faces) => ({ from: [0, 0, 0], to: [16, 16, 16], faces: faces })
  const block = (id, model) => {
    put('blockstates/' + id + '.json', { variants: { '': { model: NS + ':block/' + id } } })
    put('models/block/' + id + '.json', model)
  }
  // 唯一存在的贴图：`textures/block/stone_tex.png`。**故意没有** `textures/stone.png`
  // —— 那正是裸词 `stone` 被当成路径后会去找的地方。
  put('textures/block/stone_tex.png', Buffer.from(TINY_PNG, 'base64'))

  // 正例：同一个模型，写成 `#stone` 就画得出来。
  block('correct', { textures: { stone: NS + ':block/stone_tex' },
    elements: [box({ up: { texture: '#stone', uv: [0, 0, 16, 16] } })] })
  // 用户那种写法：裸词，而且**恰好**是 textures 里的键。
  block('bare_word', { textures: { stone: NS + ':block/stone_tex' },
    elements: [box({ up: { texture: 'stone', uv: [0, 0, 16, 16] } })] })
  // 裸词但**不是**键 —— 它是个合法路径（原版的 `block/ladder` 就是这种），不该被当成漏 `#`。
  block('bare_path', { textures: {},
    elements: [box({ up: { texture: 'block/stone_tex', uv: [0, 0, 16, 16] } })] })
  // `#变量` 在映射里找不到：另一类，话要不一样。
  block('dangling', { textures: { all: NS + ':block/stone_tex' },
    elements: [box({ up: { texture: '#nosuch', uv: [0, 0, 16, 16] } })] })
  // 真·路径不存在：仍然是"贴图解不出来"。
  block('missing_path', { textures: { all: NS + ':block/definitely_missing_tex' },
    elements: [box({ up: { texture: '#all', uv: [0, 0, 16, 16] } })] })

  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
}

const scene = (handlers, id) => handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: id })
const reasonOf = (out) => String((((out || {}).diagnostic) || {}).reason)
const textOf = (out) => String((out || {}).error)

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    // 老写法：不区分裸词，一律当"贴图解不出来"。
    const before = source
    source = source.replace('        if (bare && keys.indexOf(raw) >= 0) {',
      '        if (false && bare && keys.indexOf(raw) >= 0) {')
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到裸词分类那段（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：取消"裸词"分类（回到只会说"贴图解不出来"的那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })

  // `--dump`：把三条报告的**全文**打出来（贴给人看、贴进证据里），不做断言。
  if (process.argv.includes('--dump')) {
    for (const id of ['correct', 'bare_word', 'bare_path', 'dangling', 'missing_path']) {
      const out = await scene(handlers, id)
      console.log('================ ' + id + ' ================')
      console.log(out !== undefined && out.error !== undefined
        ? String(out.error)
        : ('画出来了：' + out.quads.length + ' 面'))
    }
    return 0
  }

  console.log('--- 0. 正例：同一个模型写成 `#stone` 就画得出来（证明"你大概想写 #stone"那句话是对的）')
  const correct = await scene(handlers, 'correct')
  check('`"texture": "#stone"` 画得出来（1 个面）',
    correct !== undefined && correct.error === undefined && correct.quads.length > 0,
    correct === undefined ? 'undefined' : (correct.error === undefined ? correct.quads.length + ' 面' : textOf(correct).split('\n')[0]))
  const barePath = await scene(handlers, 'bare_path')
  check('裸**路径**（`block/stone_tex`，没有 `#` 但有 `/`）照旧能画，不算漏 `#`',
    barePath !== undefined && barePath.error === undefined && barePath.quads.length > 0,
    barePath === undefined ? 'undefined' : (barePath.error === undefined ? barePath.quads.length + ' 面' : textOf(barePath).split('\n')[0]))

  console.log('--- 1/2. 裸词 + 它恰恰是 textures 里的键：必须点名"你大概想写 #stone"')
  const bare = await scene(handlers, 'bare_word')
  const bareReason = reasonOf(bare)
  const bareText = textOf(bare)
  check('这条路真的失败了（整块丢掉）',
    bare !== undefined && bare.error !== undefined && bare.quads === undefined, bareText.split('\n')[0])
  check('reason 是 texture-missing-hash（不是 unknown）', bareReason === 'texture-missing-hash', bareReason)
  check('明说"你大概想写 `#stone`"',
    bareText.indexOf('你大概想写') >= 0 && bareText.indexOf('#stone') >= 0, bareText.split('\n').filter((l) => l.indexOf('裸词') >= 0)[1])
  check('点名是哪个面（`up`）', bareText.indexOf('面 up') >= 0, undefined)
  check('说清"裸词被当成路径"（`<ns>:textures/stone.png`）',
    bareText.indexOf('当成') >= 0 && bareText.indexOf(':textures/stone.png') >= 0, undefined)
  check('列出这张模型 textures 里的键（`stone`），方便对照',
    bareText.indexOf('textures 里的键') >= 0 && bareText.indexOf('stone') >= 0, undefined)

  console.log('--- 3. 另外两类：话必须不一样')
  const dangling = await scene(handlers, 'dangling')
  const danglingReason = reasonOf(dangling)
  const danglingText = textOf(dangling)
  check('`#nosuch` 找不到 → reason 是 texture-variable-unresolved',
    danglingReason === 'texture-variable-unresolved', danglingReason)
  check('它说的是"映射里没有这个键"，不是"你大概想写 #"',
    danglingText.indexOf('#nosuch') >= 0 && danglingText.indexOf('你大概想写') < 0, danglingText.split('\n').filter((l) => l.indexOf('映射') >= 0)[0])
  const missing = await scene(handlers, 'missing_path')
  const missingReason = reasonOf(missing)
  const missingText = textOf(missing)
  check('真·路径不存在 → reason 仍是 textures-unresolved', missingReason === 'textures-unresolved', missingReason)
  check('它列的是路径（`.png`），不是"你大概想写 #"',
    missingText.indexOf('.png') >= 0 && missingText.indexOf('你大概想写') < 0, missingText.split('\n').filter((l) => l.indexOf('解不出来') >= 0)[0])
  check('三种话互不相同（裸词 / 悬空变量 / 真缺文件）',
    new Set([bareText, danglingText, missingText]).size === 3, undefined)
  check('三种 reason 互不相同',
    new Set([bareReason, danglingReason, missingReason]).size === 3,
    JSON.stringify([bareReason, danglingReason, missingReason]))

  if (FAULT) {
    const expected = ['reason 是 texture-missing-hash（不是 unknown）', '明说"你大概想写 `#stone`"']
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
