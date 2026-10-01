#!/usr/bin/env node
/**
 * 编辑器保存贴图这条路：**项目自己的贴图必须能存下去**。
 *
 * 用户实测（阻断性）：「这啥意思啊……？我写的是自己的啊」——面板拒绝保存他自己的贴图，
 * 屏幕上写着「这条贴图句柄不是项目包里的相对路径，没有写盘：<绝对路径>」，而那条路径
 * **就在他自己的项目包里**，读起来自相矛盾。
 *
 * 根因：`preload()` 把项目贴图表存成了**绝对路径**，这个值一路流到 `quad.tex` →
 * `textureIds` → 客户端编辑器的句柄，而客户端编辑器的底线是"只写项目自己的包"
 * （`client.js` 的 `safeTextureHandle`：拒盘符、拒前导斜杠、拒 `..`）。于是**项目自己的
 * 每一张贴图都保存不了** —— 既有 bug，不是用户操作问题。
 *
 * 判据是**行为**，不是查源码：
 *   1. 取一个项目自己的贴图 -> 句柄必须**通过客户端那道安全检查**（用 client.js 里那份
 *      **真实现**，不是这里再抄一遍），并且宿主**真的把字节落进项目包**（写前/写后比对）；
 *   2. 包内的绝对路径，宿主也要认（防线在内，别处再产出绝对句柄也不会卡死用户）；
 *   3. 拒绝消息必须指名**真实**原因（空 / NUL / 盘符 / 前导斜杠 / `..` / 包外），
 *      不许把"不在包里"当成万能理由。
 *
 *   node tools/mcart-plugin/texture-edit-test.js
 *   node tools/mcart-plugin/texture-edit-test.js --fault
 *       # 把 `preload()` 的 value 改回绝对路径 -> 必须红（红在"句柄没通过安全检查 / 没落盘"）。
 */
const nodeFs = require('fs')
const nodePath = require('path')

const { loadHost, readHostSource, fsService } = require('./model-test.js')
const localFs = require('./local-fs-shim.js').makeLocalFs()

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.texture-edit-fixture')
const PROJ = 'proj'
const NS = 'texns'
const TARGET_REL = 'pack/assets/' + NS + '/textures/block/solid.png'

// 两张**不同**的 PNG：写前/写后比对字节，才能证明"真的落盘了"。
const PNG_BEFORE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_AFTER = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4EIwDiqkL4KAVFRBgFj4Q0zAAAAAElFTkSuQmCC'

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 从 client.js 里**抽出真实现**（和 multipart-test 抽 `aroundOf` 同一个套路）。 */
function clientSafeTextureHandle() {
  const source = nodeFs.readFileSync(nodePath.join(__dirname, 'client.js'), 'utf8')
  const start = source.indexOf('function safeTextureHandle(')
  if (start < 0) throw new Error('client.js 里没有 safeTextureHandle（门禁要跟着改）')
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(source.slice(start, index + 1) + '\nreturn safeTextureHandle')()
      }
    }
  }
  throw new Error('safeTextureHandle 的花括号没配平')
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  put('textures/block/solid.png', Buffer.from(PNG_BEFORE, 'base64'))
  put('blockstates/solid.json', { variants: { '': { model: NS + ':block/solid' } } })
  put('models/block/solid.json', { parent: 'block/cube_all', textures: { all: NS + ':block/solid' } })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [{ id: PROJ, cells: [] }],
      structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
}

const textureFile = () => nodePath.join(WORK, PROJ, TARGET_REL)
const bytesNow = () => nodeFs.readFileSync(textureFile())

async function main() {
  buildFixture()
  const safeTextureHandle = clientSafeTextureHandle()
  let source = readHostSource()
  if (FAULT) {
    // 老的 `preload()`：value 是绝对路径（用户踩到的那一版）。
    const before = source
    source = source.replace("'pack/assets/' + namespace + '/textures/' + kind + '/' + entry.name)",
      "assets + '/textures/' + kind + '/' + entry.name)")
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到 preload() 的那个 value（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把 preload() 的贴图 value 改回**绝对路径**（用户踩到的那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, nodeFs: localFs })

  console.log('--- 1. 项目自己的贴图句柄：形态 + 客户端安全检查')
  const scene = await handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: 'solid' })
  check('scene 画得出来', scene !== undefined && scene.error === undefined && scene.quads.length > 0,
    scene === undefined ? 'undefined' : (scene.error || scene.quads.length + ' 面'))
  const handle = ((scene || {}).textureIds || [])[0]
  console.log('    句柄 = ' + JSON.stringify(handle))
  check('句柄是**包内相对路径**（不是绝对路径）',
    handle === TARGET_REL, JSON.stringify(handle))
  check('句柄**通过客户端那道安全检查**（safeTextureHandle 是从 client.js 抽出来的真实现）',
    safeTextureHandle(handle) === true, JSON.stringify(handle))
  check('贴图字节照样读得到（读图那条路也按项目根解析了）',
    scene !== undefined && typeof (scene.textures || {})[handle] === 'string' &&
      (scene.textures || {})[handle].indexOf('data:image/png;base64,') === 0,
    JSON.stringify(Object.keys((scene || {}).textures || {})))
  const preview = await handlers['atlas.preview']({ root: WORK, project: PROJ, block: 'solid', at: [0, 0, 0] })
  check('preview 的句柄也是相对的、也过安全检查',
    preview !== undefined && ((preview.textureIds || [])[0] === TARGET_REL) &&
      safeTextureHandle((preview.textureIds || [])[0]) === true, JSON.stringify(preview.textureIds))
  const icons = await handlers['atlas.icons']({ root: WORK, project: PROJ, blocks: ['solid'] })
  check('atlas.icons 仍然拿得到图标（读图那条路）',
    icons !== undefined && typeof (icons.icons || {}).solid === 'string', JSON.stringify(icons.failed))

  console.log('--- 2. 走"编辑器保存"那条路：安全检查 -> 宿主写盘 -> 字节真的变了')
  const before = bytesNow()
  // 客户端在发出去之前先挡：这里就用它**真实现**的那道闸。
  const blocked = safeTextureHandle(handle) ? null : '这条贴图句柄不是项目包里的相对路径，没有写盘：' + handle
  const saved = blocked === null
    ? await handlers['atlas.saveTexture']({ root: WORK, project: PROJ, path: handle, base64: PNG_AFTER })
    : { error: blocked }
  check('编辑器保存没有被客户端那道闸挡下', blocked === null, blocked)
  check('宿主回了 saved:true', saved !== undefined && saved.saved === true, JSON.stringify(saved))
  const after = bytesNow()
  check('项目包里那张图**真的被换了**（写前/写后字节不同，且等于新 PNG）',
    !before.equals(after) && after.equals(Buffer.from(PNG_AFTER, 'base64')),
    'before=' + before.length + 'B after=' + after.length + 'B')

  console.log('--- 3. 防线在内：包内的**绝对路径**宿主也认（客户端仍会先挡，但别处再产出它也不卡死）')
  nodeFs.writeFileSync(textureFile(), Buffer.from(PNG_BEFORE, 'base64'))
  const absoluteInPack = textureFile().split('\\').join('/')
  const viaAbsolute = await handlers['atlas.saveTexture']({
    root: WORK, project: PROJ, path: absoluteInPack, base64: PNG_AFTER,
  })
  check('包内绝对路径：saved:true，而且字节真的落了盘',
    viaAbsolute !== undefined && viaAbsolute.saved === true &&
      bytesNow().equals(Buffer.from(PNG_AFTER, 'base64')),
    JSON.stringify(viaAbsolute))

  console.log('--- 4. 拒绝消息必须指名**真实**原因')
  const beforeReject = bytesNow()
  const outsideAbsolute = nodePath.join(REPO, 'must-not-be-written.png').split('\\').join('/')
  const cases = [
    ['空句柄', '', '空的'],
    ['含 NUL', 'pack/assets/' + NS + '/textures/block/sol\u0000id.png', 'NUL'],
    ['前导斜杠', '/tmp/mcart-must-not-be-written.png', '前导斜杠'],
    ['相对路径带 ..', '../../outside.png', '..'],
    ['包外绝对路径', outsideAbsolute, '绝对路径'],
  ]
  const messages = []
  for (const [label, value, needle] of cases) {
    const refused = await handlers['atlas.saveTexture']({ root: WORK, project: PROJ, path: value, base64: PNG_AFTER })
    const text = String((refused || {}).error)
    messages.push(text)
    check('拒绝「' + label + '」：说了真实原因（含「' + needle + '」）且含「拒绝写」',
      text.indexOf('拒绝写') >= 0 && text.indexOf(needle) >= 0, text.slice(0, 160))
  }
  const distinct = new Set(messages).size
  check('五种拒绝理由**互不相同**（不是一句万能话术）', distinct === cases.length,
    distinct + '/' + cases.length)
  check('包外那条拒绝没有伪装成"写成功了"（拒绝那一组跑完文件一个字节没动）',
    bytesNow().equals(beforeReject))

  if (FAULT) {
    // 故障注入下：句柄变绝对 -> 客户端那道闸必须挡下 -> 文件必须没被改动。
    const expected = ['句柄是**包内相对路径**（不是绝对路径）',
      '句柄**通过客户端那道安全检查**（safeTextureHandle 是从 client.js 抽出来的真实现）',
      '编辑器保存没有被客户端那道闸挡下']
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
