#!/usr/bin/env node
/**
 * 「模型文件在、但 JSON 写坏了」不许被报成「文件缺失」。
 *
 * 原来错在哪：`preload()` 用 `readJson()` 读项目模型，`readJson` 把任何解析错误吞成
 * `undefined`，于是坏文件与不存在走同一条路 —— 诊断说"项目自己的模型文件缺失 → 补上它"，
 * 指向一个明明就在那里的文件。用户照着"补"只会覆盖掉自己写坏的那份，永远看不到
 * "不是合法 JSON：…" 这句真正有用的原因。
 *
 *   node tools/mcart-plugin/model-json-broken-test.js
 *   node tools/mcart-plugin/model-json-broken-test.js --fault   # 把记录去掉 → 必须红
 */
const nodeFs = require('fs')
const nodePath = require('path')
const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.model-json-fixture')
const PROJ = 'proj'
const NS = 'exjson'
const BROKEN_LINE = "unreadableModels.set(key, { file: 'models/block/' + entry.name, why: '不是合法 JSON：' + messageOf(error) })"

let failures = 0
const failed = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failed.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, PROJ, 'pack', 'assets', NS)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  put('textures/block/ok.png', 'x')
  put('blockstates/broken.json', { variants: { '': { model: NS + ':block/broken' } } })
  put('models/block/broken.json', '{ "parent": ')          // 坏 JSON
  put('blockstates/gone.json', { variants: { '': { model: NS + ':block/gone' } } })
  // gone 的模型文件**故意不写** —— 这是真正的"缺失"，两条报告必须不一样。
  put('models/block/ok.json', { textures: { all: NS + ':block/ok' }, elements: [] })
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: NS, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(WORK, PROJ, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1', reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
}

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    const before = source
    source = source.replace(BROKEN_LINE, 'void 0 // --fault: 记录去掉（回到静默）')
    if (source === before) { console.log('  FAIL --fault 没生效'); process.exit(2) }
    console.log('--- 故障注入：把"解析失败"的记录去掉（回到 readJson 吞错误那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })
  const broke = await handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: 'broken' })
  const text = String((broke || {}).error)
  const reason = String((((broke || {}).diagnostic) || {}).reason)
  check('坏 JSON 的画面不出来、有报告', broke !== undefined && broke.error !== undefined, text.split('\n')[0])
  check('报告说「解析失败」而不是「缺失」', text.indexOf('解析失败') >= 0, text.split('\n').filter((l) => l.indexOf('解析') >= 0 || l.indexOf('缺失') >= 0).join(' / '))
  check('报告点名是哪个文件 + 真实原因（不是合法 JSON）',
    text.indexOf('models/block/broken.json') >= 0 && text.indexOf('不是合法 JSON') >= 0, undefined)
  check('reason 仍是 project-model-missing（行为不回退）', reason === 'project-model-missing', reason)

  const gone = await handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'block', id: 'gone' })
  const goneText = String((gone || {}).error)
  check('真·缺失仍然说「缺失」，并且**不**冒充「解析失败」',
    goneText.indexOf('缺失') >= 0 && goneText.indexOf('解析失败') < 0, goneText.split('\n').filter((l) => l.indexOf('缺失') >= 0 || l.indexOf('解析') >= 0).join(' / '))
  check('两条报告不一样（坏文件 ≠ 缺文件）', text !== goneText, undefined)

  if (FAULT) {
    const expected = ['报告说「解析失败」而不是「缺失」', '报告点名是哪个文件 + 真实原因（不是合法 JSON）']
    const missed = expected.filter((label) => failed.indexOf(label) < 0)
    console.log('--- 故障注入结果：' + failures + ' 条断言变红')
    console.log('    变红的：' + (failed.slice(0, 5).join(' | ') || '（一条都没有）'))
    if (missed.length > 0) { console.log('  FAIL 故障注入没有让这些断言变红：' + missed.join(' / ')); process.exit(1) }
    console.log('全部通过（故障注入下这些断言确实会红）')
    return 0
  }
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1)).catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
