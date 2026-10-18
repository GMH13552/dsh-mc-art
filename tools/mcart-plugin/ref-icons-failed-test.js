#!/usr/bin/env node
/**
 * 「抽取器回了一个缺 png 的图标条目」不许被静默丢掉、更不许丢掉**原因**。
 *
 * 原来错在哪：`atlas.refIcons` 遇到缺 `png` / 不是对象的条目，只 `continue` —— 这一格
 * 从 `icons` 里消失，屏幕上什么都不说。后来 `failed` 里有了 `id（没有图标数据）`，
 * 但"没有图标数据"仍然没说**为什么**：png 字段缺了、是空字符串、还是抽取器根本没回
 * 这一条？三种修法完全不同。
 *
 * 判据（行为级，真 host + 桩 subprocess）：
 *   1. 好条目照常出图标（`data:image/png;base64,…`），名字照旧，已有字段语义不变；
 *   2. 每个坏条目的失败条是 `<id>（没有图标数据：<真实原因>）`，点名 id + 原因；
 *   3. 抽取器自己回的 `failed` 原样保留（不吞，也不去重成一条糊的）。
 *   4. `--fault`：把失败记录去掉（回到静默丢格子）→ 必须红。
 *
 *   node tools/mcart-plugin/ref-icons-failed-test.js
 *   node tools/mcart-plugin/ref-icons-failed-test.js --fault
 */
const nodeFs = require('fs')
const nodePath = require('path')
const { loadHost, readHostSource, fsService, fakeSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.ref-icons-failed-fixture')
const PROJ = 'proj'
const NS = 'exrf'
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

// 抽取器 `--icons` 的返回：一个好格子 + 三种坏格子 + 一条抽取器自己报的失败。
const EXTRACTOR_REPLY = {
  namespace: NS, version: '1.20.1',
  icons: {
    solid: { name: 'Solid', texture: 'block/solid', png: TINY_PNG },
    nopng: { name: 'No Png', texture: 'block/nopng' },
    blank: { name: 'Blank', texture: 'block/blank', png: '' },
    nulled: null,
  },
  failed: ['extractor_said_no'],
}

// `--fault` 的**原始字节**：把"失败记录"那一句整行去掉，只留 `continue`（回到静默丢格）。
const FAULT_FROM = "          if (problem !== null) { failed.push(id + '（没有图标数据：' + problem + '）'); continue }"
const FAULT_TO = '          if (problem !== null) { continue }'

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  nodeFs.mkdirSync(nodePath.join(assets, 'blockstates'), { recursive: true })
  nodeFs.mkdirSync(nodePath.join(assets, 'models', 'block'), { recursive: true })
  // 参考目录只要是个字符串；refIcons 这一层不读 jar（抽取器由桩替身回答）。
  nodeFs.mkdirSync(nodePath.join(WORK, 'ref'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1',
      reference: { directory: nodePath.join(WORK, 'ref'), includeGenerated: true, includeMods: true, mods: {} } }))
}

/** 桩：`resolvePython` 的 `-c print(1)` 探针，以及 `--icons` 那一次调用。 */
function runFake(argv) {
  if (argv.indexOf('print(1)') >= 0) return { exitCode: 0, stdout: '1\n', stderr: '' }
  if (argv.indexOf('--icons') >= 0) return { exitCode: 0, stdout: JSON.stringify(EXTRACTOR_REPLY), stderr: '' }
  return { exitCode: 1, stdout: '', stderr: 'unexpected argv: ' + argv.join(' ') }
}

const failedLine = (out, id) => ((out || {}).failed || []).filter((line) => String(line).indexOf(id + '（没有图标数据：') === 0)[0]

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    const before = source
    source = source.replace(FAULT_FROM, FAULT_TO)
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到 refIcons 记录失败那一行（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把失败记录去掉（回到"静默丢一格"那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: fakeSubprocess(runFake) })

  const out = await handlers['atlas.refIcons']({ root: WORK, project: PROJ, namespace: NS,
    blocks: ['solid', 'nopng', 'blank', 'nulled'] })

  console.log('--- 1. 好条目照常：图标 + 名字，字段语义不变')
  check('整批没有失败（不是 error 把整批拒掉）', out !== undefined && out.error === undefined,
    out === undefined ? 'undefined' : String(out.error))
  check('好方块有图标（data:image/png;base64,…）',
    (out.icons || {})[NS + ':solid'] === 'data:image/png;base64,' + TINY_PNG,
    String((out.icons || {})[NS + ':solid']).slice(0, 40))
  check('好方块的名字照旧（names[namespace:id]）', (out.names || {})[NS + ':solid'] === 'Solid',
    JSON.stringify((out.names || {})[NS + ':solid']))
  check('坏方块**不进** icons（这一格仍然只空自己）',
    (out.icons || {})[NS + ':nopng'] === undefined && (out.icons || {})[NS + ':blank'] === undefined,
    JSON.stringify(Object.keys(out.icons || {})))
  check('现有字段都在（icons / names / failed / version）',
    typeof (out.icons || {}) === 'object' && typeof (out.names || {}) === 'object' &&
      Array.isArray(out.failed) && out.version === '1.20.1', JSON.stringify(Object.keys(out || {})))

  console.log('--- 2. 坏条目的失败条 = <id>（没有图标数据：<真实原因>）')
  const nopng = failedLine(out, 'nopng')
  check('缺 png 字段的条目点名 id + 原因（条目里没有 png 字段）',
    nopng === 'nopng（没有图标数据：条目里没有 png 字段）', String(nopng))
  const blank = failedLine(out, 'blank')
  check('png 是空字符串的条目给出不同的原因（png 字段是空的）',
    blank === 'blank（没有图标数据：png 字段是空的）', String(blank))
  const nulled = failedLine(out, 'nulled')
  check('抽取器没回条目的也给原因（没有返回这个方块的条目）',
    nulled === 'nulled（没有图标数据：抽取器没有返回这个方块的条目）', String(nulled))
  check('抽取器自己回的 failed 原样保留', (out.failed || []).indexOf('extractor_said_no') >= 0,
    JSON.stringify(out.failed))

  if (FAULT) {
    const expected = ['缺 png 字段的条目点名 id + 原因（条目里没有 png 字段）',
      'png 是空字符串的条目给出不同的原因（png 字段是空的）',
      '抽取器没回条目的也给原因（没有返回这个方块的条目）']
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
