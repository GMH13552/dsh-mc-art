#!/usr/bin/env node
/**
 * 同一张资产，**图标路径**与**场景路径**必须给出同一份贴图事实。
 *
 * 背景（0.2.9 的形状）：项目自己包里一张 16×192 的竖条动图 + 合法 `.mcmeta`，
 * 游戏里动得好好的；面板的 3D 视图里却被拉成一张竖条（"糊"），而图标那边正常 ——
 * 因为两条路各自解析：
 *   · 图标路径 `atlas.itemIcons` → Python 抽取器（`ref:` 句柄 + 参考动画表）；
 *   · 场景路径 `atlas.scene` → `preload()` 读项目 `.mcmeta`（`host/24-texture-handles.js`）。
 * 一旦场景侧不读项目 `.mcmeta`，同一个资源在两条路上就会给出不同的动画事实。
 *
 * 这个门禁**只量**：夹具是自包含的 `example_*` 项目包（不需要参考目录、不读 jar），
 * 同一张 `textures/block/spin.png` 既被方块模型引用、也被物品模型 `layer0` 引用；
 * 比较贴图 url（同一资源相对路径）、是否判为动图、strip 行数、frames、frametime。
 * **全部一致才绿；任一项不一致即红。**
 *
 *   node tools/mcart-plugin/texture-path-parity-test.js
 *   node tools/mcart-plugin/texture-path-parity-test.js --fault
 *       # 把"场景侧读项目 .mcmeta"那段注入成"不读"（0.2.9 那个 bug 的形状）→ 必须红。
 *       # 注入只改内存里的源码副本（照 model-test.js / parent-fallback-test.js 的体例），
 *       # 不写 host.js 一个字节。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const zlib = require('zlib')

const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.texture-path-parity-fixture')
const PROJ = 'example_parity'      // 自包含的 example_* 项目包：只有 pack/assets/<ns>
const NS = 'example_parity'
const SIZE = 16
const FRAMES = 12                  // 16×192 竖条 = 12 行
const FRAMETIME = 4
const SPRITE = 'assets/' + NS + '/textures/block/spin.png'

// 注入口（原始字节，逐字节匹配）：场景侧 `preload()` 读项目 `.mcmeta` 的那一段。
const FAULT_FROM = "          const meta = await statOf(absolute + '.mcmeta')\n"
  + "          if (meta === undefined || meta.type !== 'file') continue"
const FAULT_TO = '          const meta = undefined\n'
  + '          if (meta === undefined || true) continue'

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 一张**结构合法**的 PNG（IHDR/IDAT/IEND 的 CRC 都对），每帧一个可辨认的颜色。 */
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
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width * 4)
    const frame = Math.floor(y / width)
    raw[at] = 0    // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = at + 1 + x * 4
      raw[pixel] = (frame * 37) & 255
      raw[pixel + 1] = (frame * 91 + 40) & 255
      raw[pixel + 2] = 200
      raw[pixel + 3] = 255
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
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
  // 一张竖条动图 + 合法 .mcmeta（游戏读的就是它）。
  put('textures/block/spin.png', stripPng(SIZE, SIZE * FRAMES))
  put('textures/block/spin.png.mcmeta', JSON.stringify({ animation: { frametime: FRAMETIME } }))
  // 方块：模型直接引用这张图（场景路径）。
  const box = { from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all', uv: [0, 0, 16, 16] } } }
  putJson('models/block/spin.json', { textures: { all: NS + ':block/spin' }, elements: [box] })
  putJson('blockstates/spin.json', { variants: { '': { model: NS + ':block/spin' } } })
  // 物品：扁平模型，layer0 指向**同一张**图（图标路径；不需要参考目录 / 原版母模型）。
  putJson('models/item/spin.json', { textures: { layer0: NS + ':block/spin' } })
  putJson('lang/en_us.json', { ['block.' + NS + '.spin']: 'Spin' })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  // **自包含**：参考目录是空的（图标路径只读项目包）。
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
}

/** 句柄 → 包内相对路径：`ref:ns:path` 与 `pack/assets/...` 都要能对上同一个资源。 */
function resourcePathOf(handle) {
  const text = String(handle === undefined || handle === null ? '' : handle)
  if (text.slice(0, 4) === 'ref:') {
    const rest = text.slice(4)
    const colon = rest.indexOf(':')
    const namespace = colon >= 0 ? rest.slice(0, colon) : ''
    const path = colon >= 0 ? rest.slice(colon + 1) : rest
    return 'assets/' + namespace + '/textures/' + path + '.png'
  }
  return text.replace(/^pack\//, '')
}

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    const before = source
    source = source.replace(FAULT_FROM, FAULT_TO)
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到场景侧读项目 `.mcmeta` 那一段（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：场景侧不读项目 `.mcmeta`（0.2.9 那个 bug 的形状；只改内存副本）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })

  console.log('--- 1. 同一张图：场景路径与图标路径都画得出来')
  const scene = await handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: 'spin' })
  const page = await handlers['atlas.itemIcons']({ root: WORK, project: PROJ, namespace: NS,
    source: 'project', items: ['spin'] })
  const item = ((page || {}).items || {}).spin || {}
  check('场景侧画得出来（方块模型引用 textures/block/spin.png）',
    scene !== undefined && scene.error === undefined && (scene.quads || []).length > 0,
    scene === undefined ? 'undefined'
      : (scene.error === undefined ? (scene.quads || []).length + ' 面' : String(scene.error).split('\n')[0]))
  check('图标侧画得出来（物品模型 layer0 指向同一张图）',
    page !== undefined && page.error === undefined && item.error === null && (item.layers || []).length > 0,
    page === undefined ? 'undefined' : (page.error !== undefined ? String(page.error)
      : (item.error !== null ? String(item.error) : JSON.stringify(item.layers))))

  const sceneId = (scene.textureIds || [])[0]
  const itemId = (item.textureIds || [])[0]
  const sceneUrl = (scene.textures || {})[sceneId]
  const itemUrl = (item.textures || {})[itemId]
  const sceneAnim = (scene.animations || {})[sceneId]
  const itemAnim = (item.animations || {})[itemId]
  console.log('    场景句柄 = ' + JSON.stringify(sceneId) + '  图标句柄 = ' + JSON.stringify(itemId))

  console.log('--- 2. 贴图 url：同一个资源相对路径、同一份字节')
  check('两条路的资源相对路径一致（' + SPRITE + '）',
    resourcePathOf(sceneId) === SPRITE && resourcePathOf(itemId) === SPRITE,
    JSON.stringify({ scene: resourcePathOf(sceneId), item: resourcePathOf(itemId) }))
  check('两条路的贴图 url 逐字节相同（同一张 PNG 的 data URL）',
    typeof sceneUrl === 'string' && sceneUrl.indexOf('data:image/png;base64,') === 0 &&
      typeof itemUrl === 'string' && sceneUrl === itemUrl,
    JSON.stringify({ scene: String(sceneUrl).slice(0, 40), item: String(itemUrl).slice(0, 40) }))

  console.log('--- 3. 动画事实：是否动图 / strip / frames / frametime 必须一致')
  check('两条路都判为动图',
    sceneAnim !== undefined && itemAnim !== undefined,
    JSON.stringify({ scene: sceneAnim === undefined ? null : sceneAnim, item: itemAnim === undefined ? null : itemAnim }))
  check('strip 行数一致（16×192 → ' + FRAMES + ' 行）',
    sceneAnim !== undefined && itemAnim !== undefined &&
      sceneAnim.strip === FRAMES && itemAnim.strip === FRAMES,
    JSON.stringify({ scene: sceneAnim && sceneAnim.strip, item: itemAnim && itemAnim.strip }))
  check('frames 一致（.mcmeta 没写 frames → 逐帧 ' + FRAMES + '）',
    sceneAnim !== undefined && itemAnim !== undefined &&
      sceneAnim.frames === FRAMES && itemAnim.frames === FRAMES,
    JSON.stringify({ scene: sceneAnim && sceneAnim.frames, item: itemAnim && itemAnim.frames }))
  check('frametime 一致（.mcmeta 写 ' + FRAMETIME + '）',
    sceneAnim !== undefined && itemAnim !== undefined &&
      sceneAnim.frametime === FRAMETIME && itemAnim.frametime === FRAMETIME,
    JSON.stringify({ scene: sceneAnim && sceneAnim.frametime, item: itemAnim && itemAnim.frametime }))
  check('播放顺序一致（逐帧 0..' + (FRAMES - 1) + '）',
    sceneAnim !== undefined && itemAnim !== undefined &&
      JSON.stringify(sceneAnim.order) === JSON.stringify(itemAnim.order),
    JSON.stringify({ scene: sceneAnim && sceneAnim.order, item: itemAnim && itemAnim.order }))

  if (FAULT) {
    const expected = ['两条路都判为动图', 'strip 行数一致（16×192 → ' + FRAMES + ' 行）',
      'frames 一致（.mcmeta 没写 frames → 逐帧 ' + FRAMES + '）',
      'frametime 一致（.mcmeta 写 ' + FRAMETIME + '）']
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
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
