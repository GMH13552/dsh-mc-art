#!/usr/bin/env node
/**
 * 「语言文件在、但 JSON 写坏了」不许被吞成「什么都没有」。
 *
 * 原来错在哪：`readLang()` 用 `readJson()` 读 `lang/en_us.json` / `lang/zh_cn.json`，
 * 而 `readJson` 把任何解析错误吞成 `undefined` —— 坏文件与不存在的文件走同一条路，
 * 名字表变空，报告里只剩"方块名只能用原始 id"，**没人知道是文件写坏了**。
 * 更糟的是：文件明明在那里，用户按"缺文件"去补，永远看不到"不是合法 JSON：…"。
 *
 * 判据（行为级，真 host + 真夹具）：
 *   1. 坏 `lang/en_us.json` → 报告点名这个文件 + 真实原因（不是合法 JSON），并说清
 *      "语言文件读不出来 → 方块名只能用原始 id"；
 *   2. **真·缺文件仍按"缺"说**：缺的 `zh_cn.json` 说的是"文件不存在（缺失，不是读坏了）"，
 *      不许冒充"读坏了"；真·缺的项目模型也照旧说"缺失"，不是"解析失败"；
 *   3. 只缺一个语言、另一个读得出来时**不报**（名字是好的，不能把正常状态说成故障）。
 *
 *   node tools/mcart-plugin/lang-json-broken-test.js
 *   node tools/mcart-plugin/lang-json-broken-test.js --fault   # 去掉"读坏了"的记录 → 必须红
 */
const nodeFs = require('fs')
const nodePath = require('path')
const { loadHost, readHostSource, fsService, realSubprocess } = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.lang-json-fixture')
// 三个工程：坏语言的（同时缺 zh_cn）、只缺一个语言的（en_us 是好的）、以及正常对照。
const BROKEN = { id: 'broken', ns: 'exl' }
const PARTIAL = { id: 'partial', ns: 'exp' }
// `--fault` 注入的**原始字节**：把"解析失败"这条记录整段去掉，回到 readJson 吞错误那一版。
const FAULT_FROM = "        } catch (error) {\n"
  + "          broken.push({ file: file, why: '不是合法 JSON：' + messageOf(error) })\n"
  + '          continue\n'
  + '        }'
const FAULT_TO = '        } catch (error) {\n'
  + '          continue\n'
  + '        }'

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 一个工程：只有 blockstate（指向一个**不存在的**模型），让每次 scene 都出报告。 */
function makeProject(spec) {
  const dir = nodePath.join(WORK, spec.id)
  const assets = nodePath.join(dir, 'pack', 'assets', spec.ns)
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
  }
  put('blockstates/gone.json', { variants: { '': { model: spec.ns + ':block/gone' } } })
  // gone 的模型文件**故意不写** —— 这是真正的"缺失"，报告必须继续说"缺失"。
  nodeFs.writeFileSync(nodePath.join(dir, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: spec.ns, biomes: [], structures: [], entities: [], blocks: [] }))
  nodeFs.writeFileSync(nodePath.join(dir, 'mc-art.settings.json'),
    JSON.stringify({ schema: 'mc-art.settings/1', reference: { directory: '', includeGenerated: true, includeMods: true, mods: {} } }))
  return { dir: dir, put: put }
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  // 坏语言：en_us 不是合法 JSON；zh_cn **真的不存在**（两件事必须分开说）。
  const broken = makeProject(BROKEN)
  broken.put('lang/en_us.json', '{ "block.exl.gone": ')
  // 只缺一个语言：en_us 读得出来，名字是好的 —— 这不叫"读不出来"。
  const partial = makeProject(PARTIAL)
  partial.put('lang/en_us.json', { 'block.exp.gone': '名字是好的' })
}

const scene = (handlers, spec) =>
  handlers['atlas.scene']({ root: WORK, project: spec.id, kind: 'block', id: 'gone' })

async function main() {
  buildFixture()
  let source = readHostSource()
  if (FAULT) {
    const before = source
    source = source.replace(FAULT_FROM, FAULT_TO)
    if (source === before) {
      console.log('  FAIL --fault 没生效：宿主里没找到记录"不是合法 JSON"那三条语句（门禁要跟着改）')
      process.exit(2)
    }
    console.log('--- 故障注入：把语言文件"解析失败"的记录去掉（回到 readJson 吞错误那一版）')
  }
  const handlers = loadHost(source, { fs: fsService, subprocess: realSubprocess() })

  console.log('--- 1. 坏语言文件：报告点名文件 + 真实原因')
  const broke = await scene(handlers, BROKEN)
  const text = String((broke || {}).error)
  const reason = String((((broke || {}).diagnostic) || {}).reason)
  check('坏语言的项目仍然画不出来、有报告（行为不回退）',
    broke !== undefined && broke.error !== undefined, text.split('\n')[0])
  check('报告点名 lang/en_us.json',
    text.indexOf('lang/en_us.json') >= 0,
    text.split('\n').filter((line) => line.indexOf('lang/') >= 0).join(' / '))
  check('报告写出真实原因「不是合法 JSON」',
    text.indexOf('不是合法 JSON') >= 0,
    text.split('\n').filter((line) => line.indexOf('不是合法 JSON') >= 0)[0])
  check('报告说清「语言文件读不出来 → 方块名只能用原始 id」',
    text.indexOf('语言文件读不出来') >= 0 && text.indexOf('只能用原始 id') >= 0,
    text.split('\n').filter((line) => line.indexOf('语言文件') >= 0)[0])
  check('结构化 diagnostic 的 tried 里也看得到它',
    Array.isArray(((broke || {}).diagnostic || {}).tried) &&
      ((broke || {}).diagnostic).tried.some((line) => line.indexOf('lang/en_us.json') >= 0),
    (((broke || {}).diagnostic || {}).tried || []).filter((line) => line.indexOf('lang/') >= 0).join(' / '))
  check('reason 仍是 project-model-missing（语言坏了不改模型那条诊断）',
    reason === 'project-model-missing', reason)

  console.log('--- 2. 真·缺文件仍按「缺」说，不冒充「读坏了」')
  const zhLine = text.split('\n').filter((line) => line.indexOf('lang/zh_cn.json') >= 0)[0]
  check('缺的 lang/zh_cn.json 被点名，并且说的是「缺失」不是「读坏了」',
    zhLine !== undefined && zhLine.indexOf('缺失') >= 0 && zhLine.indexOf('不是合法 JSON') < 0,
    zhLine)
  check('真·缺的项目模型仍然说「缺失」，而不是「解析失败」',
    text.indexOf('项目自己的模型文件缺失') >= 0 && text.indexOf('解析失败') < 0,
    text.split('\n').filter((line) => line.indexOf('缺失') >= 0 || line.indexOf('解析') >= 0).join(' / '))
  check('坏语言与缺语言两条说的是两回事（文本不同）',
    text.indexOf('lang/en_us.json → 不是合法 JSON') >= 0 &&
      text.indexOf('lang/zh_cn.json → 文件不存在') >= 0, undefined)

  console.log('--- 3. 只缺一个语言、另一个读得出来：不报（名字是好的）')
  const partial = await scene(handlers, PARTIAL)
  const partialText = String((partial || {}).error)
  check('只缺 zh_cn（en_us 好的）时**不**出现「语言文件读不出来」',
    partialText.indexOf('语言文件读不出来') < 0,
    partialText.split('\n').filter((line) => line.indexOf('语言') >= 0).join(' / ') || '（没有这一句）')
  check('只缺 zh_cn 时也不点名 zh_cn.json（不把正常状态说成故障）',
    partialText.indexOf('zh_cn.json') < 0,
    partialText.split('\n').filter((line) => line.indexOf('zh_cn') >= 0).join(' / ') || '（没有提到）')

  if (FAULT) {
    // 注意：这里**不**把"整段话消失"当作必红断言 —— zh_cn 真的缺，缺文件本身仍会触发
    // 那一段（名字确实是原始 id）。故障注入要抓的是"坏文件"这条记录：文件名、真实原因、
    // tried 里的那一条、以及"坏 ≠ 缺"的区别。
    const expected = ['报告点名 lang/en_us.json', '报告写出真实原因「不是合法 JSON」',
      '结构化 diagnostic 的 tried 里也看得到它', '坏语言与缺语言两条说的是两回事（文本不同）']
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
