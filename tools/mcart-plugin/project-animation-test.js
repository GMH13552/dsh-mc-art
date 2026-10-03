#!/usr/bin/env node
/**
 * 项目自己的动图：**必须被当动图**，而且"读不了"不许说成"没有"。
 *
 * 用户实测：`pack/assets/<ns>/textures/block/whisper_stone.png` 是 16×192 的竖条，旁边
 * `whisper_stone.png.mcmeta` = `{ "animation": { "frametime": 4 } }` 合法存在，
 * **游戏里它动得好好的**；面板的 3D 视图里糊，还提示"形状像条带但没有动画描述 … ← 会糊"。
 *
 * 两个缺陷：
 *   ① `preload()` 收集项目贴图时**只收 `.png`**，`.mcmeta` 一次都没读（全文件 grep `mcmeta` 为 0）；
 *      而 `animationsFor()` 只查 `referenceAnimations`（参考贴图那一侧）。于是项目包的动图
 *      没有动画描述，整条竖条被当成一张贴图贴上去。
 *   ② 客户端那句"形状像条带但没有动画描述"是**指责产物**：文件明明在，只是没人去读。
 *
 * 判据（行为级，真 host + 真夹具）：
 *   A 16×192 + 合法 `.mcmeta`  → `animations[id]` 有、`strip = 12`、`frametime = 4`，**且不提示**；
 *   B 同样条带但**没有** `.mcmeta` → 才是"没有动画描述"（宿主不说话，客户端按形状说）；
 *   C `.mcmeta` 在但内容坏 → 宿主给"**有**，但我读不了：<原因>"，**不是**"没有描述"；
 *   反向夹具：把项目 `.mcmeta` 的读取去掉 → A（和 C）**必须红**。
 *
 *   node tools/mcart-plugin/project-animation-test.js
 *   node tools/mcart-plugin/project-animation-test.js --fault
 */
const nodeFs = require('fs')
const nodePath = require('path')
const zlib = require('zlib')

const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.project-animation-fixture')
const PROJ = 'proj'
const NS = 'exanim'
const FRAMES = 12
const SIZE = 16

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 一张**结构合法**的 PNG（IHDR 的 CRC 也算对），尺寸随便给 —— 条带要真的 16×192。 */
function stripPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    const value = typeof zlib.crc32 === 'function' ? zlib.crc32(body) : 0
    crc.writeUInt32BE(value >>> 0, 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const TEXTURES = {
  strip_ok: { shape: [SIZE, SIZE * FRAMES], meta: JSON.stringify({ animation: { frametime: 4 } }) },
  strip_bare: { shape: [SIZE, SIZE * FRAMES], meta: null },
  strip_broken: { shape: [SIZE, SIZE * FRAMES], meta: '{ "animation": { ' },
  plain: { shape: [SIZE, SIZE], meta: null },
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, body)
  }
  const putJson = (relative, body) => put(relative, JSON.stringify(body))
  const box = { from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all', uv: [0, 0, 16, 16] } } }
  for (const id of Object.keys(TEXTURES)) {
    const spec = TEXTURES[id]
    put('textures/block/' + id + '.png', stripPng(spec.shape[0], spec.shape[1]))
    if (spec.meta !== null) put('textures/block/' + id + '.png.mcmeta', spec.meta)
    putJson('blockstates/' + id + '.json', { variants: { '': { model: NS + ':block/' + id } } })
    putJson('models/block/' + id + '.json', { textures: { all: NS + ':block/' + id }, elements: [box] })
  }
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
}

const scene = (handlers, id) => handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: id })
const textureOf = (out) => ((out || {}).textureIds || [])[0]

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    // 老写法：项目贴图只收 `.png`，`.mcmeta` 一次都不读。
    const before = source
    source = source.replace("          const meta = await statOf(absolute + '.mcmeta')\n          if (meta === undefined || meta.type !== 'file') continue",
      "          const meta = undefined\n          if (meta === undefined || true) continue")
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到读 .mcmeta 那段（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把项目 `.mcmeta` 的读取去掉（只收 .png —— 用户踩到的那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })

  // 客户端那段判据的等价物（client.js:3960-3969）：**不在 `animations` 里** + 解码出来像条带
  // → 它才打印"形状像条带但没有动画描述"。A 的形状**确实**像条带，所以它不进那个分支的唯一
  // 原因就是动画表里有它 —— 这一条就是"那句话说反了"的判据。
  const shapeSaysStrip = (name) => TEXTURES[name].shape[1] > TEXTURES[name].shape[0] &&
    TEXTURES[name].shape[1] % TEXTURES[name].shape[0] === 0

  console.log('--- A. 16×192 + 合法 .mcmeta → 必须被报成动画（12 帧），且不出现"没有动画描述"')
  const a = await scene(handlers, 'strip_ok')
  const idA = textureOf(a)
  const animA = ((a || {}).animations || {})[idA]
  const notesA = ((a || {}).animationNotes || {})
  console.log('    贴图 id = ' + JSON.stringify(idA))
  check('A: 画得出来', a !== undefined && a.error === undefined && a.quads.length > 0,
    a === undefined ? 'undefined' : (a.error === undefined ? a.quads.length + ' 面' : String(a.error).split('\n')[0]))
  check('A: 动画表里有这条贴图（项目自己的 .mcmeta 被读了）', animA !== undefined, JSON.stringify(animA))
  check('A: strip = 12 行（16×192）', animA !== undefined && animA.strip === FRAMES, JSON.stringify(animA && animA.strip))
  check('A: frames = 12、frametime = 4（.mcmeta 里的值）',
    animA !== undefined && animA.frames === FRAMES && animA.frametime === 4, JSON.stringify(animA))
  check('A: playback order 是 12 个（逐帧）',
    animA !== undefined && Array.isArray(animA.order) && animA.order.length === FRAMES, JSON.stringify(animA && animA.order))
  check('A: **没有**任何"我读不了/没有动画描述"的提示', notesA[idA] === undefined, JSON.stringify(notesA[idA]))
  check('A: 客户端那句"形状像条带但没有动画描述"**不会**出现（形状像条带，但 animations 里有它）',
    shapeSaysStrip('strip_ok') === true && animA !== undefined, JSON.stringify({ shapeSaysStrip: shapeSaysStrip('strip_ok') }))

  console.log('--- B. 同样条带但旁边没有 .mcmeta → 才是"没有动画描述"那一类')
  const b = await scene(handlers, 'strip_bare')
  const idB = textureOf(b)
  const animB = ((b || {}).animations || {})[idB]
  const notesB = ((b || {}).animationNotes || {})[idB]
  check('B: 画得出来（没有动画描述不影响几何）', b !== undefined && b.error === undefined && b.quads.length > 0,
    b === undefined ? 'undefined' : (b.error === undefined ? b.quads.length + ' 面' : String(b.error).split('\n')[0]))
  check('B: 动画表里**没有**它（宿主不该瞎猜"高就是动图"）', animB === undefined, JSON.stringify(animB))
  check('B: 宿主也不塞"读不了"的提示（旁边确实没有文件，客户端按形状说的那句话才是对的）',
    notesB === undefined, JSON.stringify(notesB))

  console.log('--- C. .mcmeta 在但内容坏 → "有，但我读不了"，**不是**"没有描述"')
  const c = await scene(handlers, 'strip_broken')
  const idC = textureOf(c)
  const animC = ((c || {}).animations || {})[idC]
  const noteC = ((c || {}).animationNotes || {})[idC]
  check('C: 没有把它当动画（坏 JSON 不能瞎播）', animC === undefined, JSON.stringify(animC))
  check('C: 给了显式说明（state = unreadable）',
    noteC !== undefined && noteC.state === 'unreadable', JSON.stringify(noteC))
  check('C: 说明里点明"有"这个文件 + 读不了的真实原因（JSON 解析失败）',
    noteC !== undefined && noteC.text.indexOf('有') >= 0 && noteC.text.indexOf('.mcmeta') >= 0 &&
      noteC.text.indexOf('读不了') >= 0 && noteC.text.indexOf('JSON') >= 0, noteC && noteC.text)
  check('C: 说明里**绝不出现**"没有动画描述"',
    noteC !== undefined && noteC.text.indexOf('没有动画描述') < 0, noteC && noteC.text)

  console.log('--- D. 16×16 的普通贴图：既不进动画表，也没有说明（不该有噪音）')
  const d = await scene(handlers, 'plain')
  const idD = textureOf(d)
  check('D: 没有动画、没有说明',
    ((d || {}).animations || {})[idD] === undefined &&
      ((d || {}).animationNotes || {})[idD] === undefined, JSON.stringify({ id: idD }))

  if (FAULT) {
    const expected = ['A: 动画表里有这条贴图（项目自己的 .mcmeta 被读了）',
      'A: strip = 12 行（16×192）',
      'C: 给了显式说明（state = unreadable）']
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
