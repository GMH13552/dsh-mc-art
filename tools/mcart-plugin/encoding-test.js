#!/usr/bin/env node
/**
 * 子进程边界上的编码：中文必须原样穿过，而且**与 locale 无关**。
 *
 * 撞出来的经过：同一份代码、同一台机器，只换环境变量 ——
 *   `python -X utf8 -m pytest tools/test_extract_block.py` → 53 passed / exit 0
 *   `python      -m pytest tools/test_extract_block.py` → 22 failed / exit 1（cp936 解 UTF-8）
 * 根因在**门禁的夹具**，不在产品：抽取器故意把 stdout 钉成 UTF-8
 * （脚本自己 `sys.stdout.reconfigure(encoding="utf-8")`，宿主那边还传 `-X utf8`），
 * 而 `subprocess.run(..., text=True)` 不写 `encoding=` 时父进程按**区域编码**（中文 Windows 上
 * cp936）解 —— 中文名字全成乱码，门禁就假红了。**假红比没有门禁更坏**：它教所有人忽略这个门禁。
 *
 * 所以这条门禁做两件事：
 *   1. 静态：`tools/*.py` 里每个 `subprocess.run(...)`，**text 模式必须写 `encoding=`**，
 *      **起 Python 子进程必须带 `-X utf8`**（和面板宿主的做法逐字对齐）；
 *   2. 运行时：在 `PYTHONUTF8=0` 的前提下，让真的抽取器读一个含中文 lang 的夹具，
 *      断言中文逐字回来；并用两个**反向夹具**证明上面两条去掉任何一个都会坏事。
 *
 *   node tools/mcart-plugin/encoding-test.js
 *   node tools/mcart-plugin/encoding-test.js --fault
 *       # 把 5 个文件各做两份"退回旧写法"的改写（去掉 encoding= / 去掉 -X utf8），
 *       # 静态扫描必须都能抓到；再加上两个运行时反向夹具必须真的坏掉。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.encoding-fixture')
const TOOL = nodePath.join(REPO, 'tools', 'mcart_extract_block.py')

// 子进程的**默认**编码：本机是 cp936（中文 Windows）。设成 0 就是为了逼出"没带 -X utf8"的形态。
const CHILD_ENV = Object.assign({}, process.env, { PYTHONUTF8: '0' })
delete CHILD_ENV.PYTHONIOENCODING

const FILES = [
  'tools/test_extract_block.py',
  'tools/check_jdk_test.py',
  'tools/mcmod_gametest.py',
  'tools/skill_vocab_test.py',
  'tools/strip_gate.py',
]

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/**
 * 标出**注释**覆盖的字符位置（1 = 在这一段注释里）。
 *
 * 为什么需要：说明"以前这里是 `subprocess.run(..., text=True)`"的注释本身就会被朴素扫描
 * 当成一个调用点（第一版就是这样自己把自己判红的）。扫的是代码，注释不算。
 * 字符串/三引号 docstring 里的 `#` 不能当注释，所以按引号状态走一遍。
 */
function commentMask(text) {
  const mask = new Uint8Array(text.length)
  let index = 0
  let quote = null
  let triple = false
  while (index < text.length) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') { index += 2; continue }
      if (triple) {
        if (text.startsWith(quote + quote + quote, index)) { index += 3; quote = null; triple = false; continue }
        index += 1
        continue
      }
      if (char === quote) { quote = null; index += 1; continue }
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      if (text.startsWith(char + char + char, index)) { quote = char; triple = true; index += 3; continue }
      quote = char
      index += 1
      continue
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') { mask[index] = 1; index += 1 }
      continue
    }
    index += 1
  }
  return mask
}

/** 代码里（非注释）某段文字的全部出现位置。 */
function occurrences(text, mask, needle) {
  const out = []
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    from = at + 1
    if (mask[at] !== 1) out.push(at)
  }
  return out
}

/** 从某个 `(` 开始，配平到它的 `)`，返回这段调用文本。 */
function callSpan(text, mask, openAt) {
  let depth = 0
  let quote = null
  for (let index = openAt; index < text.length; index++) {
    if (mask[index] === 1) continue
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return { text: text.slice(openAt, index + 1), line: text.slice(0, openAt).split('\n').length }
      }
    }
  }
  return null
}

/** 把某个位置**包住**的那次调用（往前找最近的未配平 `(`）—— 不关心被调的是谁，
 *  这样 `run = subprocess.run` 这种**换了名字**的调用也能被看到（实测 javac 那条就在这里）。 */
function enclosingCall(text, mask, position) {
  let depth = 0
  for (let index = position; index >= 0; index--) {
    if (mask[index] === 1) continue
    const char = text[index]
    if (char === ')') depth += 1
    else if (char === '(') {
      if (depth === 0) return callSpan(text, mask, index)
      depth -= 1
    }
  }
  return null
}

/**
 * 静态判据（按"这次调用的参数表"判，不按被调函数名判）：
 *   * 哪里写了 `text=True`，那次调用就必须有 `encoding=`；
 *   * 哪里出现了 `sys.executable`，那次调用就必须有 `-X` + `utf8`。
 */
function scanText(text) {
  const mask = commentMask(text)
  const hits = []
  const seen = {}
  const report = (call, rule) => {
    const key = call.line + ':' + rule
    if (seen[key] === true) return
    seen[key] = true
    hits.push({ line: call.line, rule: rule })
  }
  for (const position of occurrences(text, mask, 'text=True')) {
    const call = enclosingCall(text, mask, position)
    if (call !== null && !/encoding\s*=/.test(call.text)) {
      report(call, 'text 模式没写 encoding=（父进程会按区域编码解）')
    }
  }
  // 同一个洞的另一半：**捕获了输出**却连 `text=True` 都省了、也没写怎么解。
  // `capture_output=True` 拿到的是 bytes，不声明 `encoding=`/`text=` 就没人解它。
  for (const position of occurrences(text, mask, 'capture_output=True')) {
    const call = enclosingCall(text, mask, position)
    if (call !== null && !/encoding\s*=/.test(call.text) && !/text\s*=/.test(call.text)) {
      report(call, '捕获了子进程输出却没写怎么解（encoding= / text=）')
    }
  }
  for (const position of occurrences(text, mask, 'sys.executable')) {
    const call = enclosingCall(text, mask, position)
    if (call !== null && !(/-X/.test(call.text) && /utf8/.test(call.text))) {
      report(call, '起 Python 子进程没带 -X utf8')
    }
  }
  return hits
}

function decode(buffer, encoding) {
  try { return new TextDecoder(encoding).decode(buffer) } catch (error) { return null }
}

/** 起一个 Python 子进程打印一行中文，返回**原始字节**（不替它猜编码）。 */
function runPython(args, env) {
  // 这条门禁量的就是"字节到底是不是 UTF-8"，所以这里**故意**不用 text 模式、也不要
  // 父进程替我解码：拿到裸字节再自己按两种编码各解一次，才看得出差别。
  // utf8-check: exempt —— 按字节看子进程输出是本门禁的判据本身，不是漏配编码。
  const done = cp.spawnSync('python', args, { encoding: 'buffer', env: env === undefined ? CHILD_ENV : env, timeout: 60000 })
  if (done.error !== undefined) throw done.error
  return Buffer.concat([done.stdout === undefined ? Buffer.alloc(0) : done.stdout,
    done.stderr === undefined ? Buffer.alloc(0) : done.stderr])
}

const CHINESE = '迷雾石·桉格尼木'

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const assets = nodePath.join(WORK, 'ref', 'assets', 'zhns')
  const put = (relative, body) => {
    const target = nodePath.join(assets, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, body)
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  put('textures/block/foo.png', png)
  put('models/block/foo.json', JSON.stringify({ parent: 'block/cube_all', textures: { all: 'zhns:block/foo' } }))
  put('blockstates/foo.json', JSON.stringify({ variants: { '': { model: 'zhns:block/foo' } } }))
  // 1.12.2 那种 `.lang`：`tile.<id>.name`（**不带命名空间段**），正是
  // test_bare_and_pascal_lang_keys 量过的那一类拼写。
  put('lang/zh_cn.lang', 'tile.foo.name=' + CHINESE + '\n')
  return nodePath.join(WORK, 'ref')
}

function main() {
  console.log('--- 静态：tools/*.py 的子进程调用')
  const hitsByFile = {}
  for (const relative of FILES) {
    const file = nodePath.join(REPO, relative)
    if (!nodeFs.existsSync(file)) { check(relative + ' 存在', false); continue }
    const hits = scanText(nodeFs.readFileSync(file, 'utf8'))
    hitsByFile[relative] = hits
    check(relative + ' 的 subprocess 调用都写对了（text→encoding=，Python→-X utf8）',
      hits.length === 0, hits.map((hit) => hit.line + ':' + hit.rule).join(' | '))
  }

  console.log('--- 运行时：PYTHONUTF8=0（本机默认编码 ' + (process.env.PYTHONUTF8 === undefined ? 'cp936/区域' : process.env.PYTHONUTF8) + '）')
  // 正例 1：子进程带 `-X utf8` + 父进程按 UTF-8 解 → 逐字节相同。
  const goodBytes = runPython(['-X', 'utf8', '-c', 'print(' + JSON.stringify(CHINESE) + ')'])
  const goodUtf8 = decode(goodBytes, 'utf-8')
  check('正例：子进程带 -X utf8、父进程按 UTF-8 解 → 中文逐字回来',
    goodUtf8 !== null && goodUtf8.trim() === CHINESE, JSON.stringify(goodUtf8))

  // 正例 2（**产品路径**）：真的抽取器读含中文 lang 的夹具，按修好后的夹具写法起它。
  // 子进程带 `-X utf8`；父进程**按字节收**（下面自己解 UTF-8）——这也是本门禁要量的东西。
  // utf8-check: exempt —— 同上：这里必须拿到原始字节。
  const ref = buildFixture()
  const toolRun = cp.spawnSync('python', ['-X', 'utf8', TOOL, '--root', ref, '--block', 'zhns:foo'],
    { encoding: 'buffer', env: CHILD_ENV, timeout: 60000 })
  const toolText = decode(Buffer.concat([
    toolRun.stdout === undefined ? Buffer.alloc(0) : toolRun.stdout,
    toolRun.stderr === undefined ? Buffer.alloc(0) : toolRun.stderr]), 'utf-8')
  let name = null
  let nameKey = null
  try {
    const parsed = JSON.parse(toolText)
    name = parsed.name
    nameKey = parsed.nameKey
  } catch (error) { /* 下面断言会说 */ }
  check('正例：抽取器在 PYTHONUTF8=0 下读中文 lang，名字逐字回来（test_bare_and_pascal_lang_keys 那个场景）',
    name === CHINESE, JSON.stringify({ name: name, nameKey: nameKey, raw: String(toolText).slice(0, 160) }))
  check('正例：名字的来源 key 也说得出（tile.<id>.name 的裸拼写）',
    nameKey === 'tile.foo.name', String(nameKey))

  // 反向夹具 A：子进程写 UTF-8，父进程却按**区域编码**解（= 旧的 `text=True` 不写 encoding）。
  let sawBadCase = false
  const localeDecoded = decode(goodBytes, 'gbk')
  if (localeDecoded === null) {
    console.log('    A) SKIP：这个 Node 里没有 gbk 解码器（没编 full-icu），这个反向夹具在这里无法成立')
  } else {
    const badA = localeDecoded.trim() !== CHINESE
    if (badA) sawBadCase = true
    console.log('    A) 按 gbk 解 UTF-8 字节 → ' + JSON.stringify(localeDecoded) + '（' + (badA ? '坏掉了，符合预期' : '居然还对') + '）')
    check('反向夹具 A：丢掉 encoding=（按区域编码解）→ 中文必然坏掉（证明这条判据是活的）', badA,
      JSON.stringify(localeDecoded))
  }

  // 反向夹具 B：子进程**不带** `-X utf8`，父进程按 UTF-8 解。
  // 只有当这台机器的默认子进程编码不是 UTF-8 时，这个形态才会坏 —— 是 UTF-8 的机器上
  // 它本来就不会坏，那就**说清为什么这次不算**（仓库规矩：不许红着当绿，也不许假装验过）。
  const plainBytes = runPython(['-c', 'print(' + JSON.stringify(CHINESE) + ')'])
  const plainUtf8 = decode(plainBytes, 'utf-8')
  const plainIsAlreadyUtf8 = plainUtf8 !== null && plainUtf8.trim() === CHINESE
  if (plainIsAlreadyUtf8) {
    console.log('    B) SKIP：这台机器的子进程默认编码**就是 UTF-8**（没带 -X utf8 也写 UTF-8），'
      + '这个反向夹具在这里无法成立；静态那条（必须写 -X utf8）仍然在管。')
  } else {
    sawBadCase = true
    console.log('    B) 不带 -X utf8 时子进程写的是区域编码，按 UTF-8 解 → ' + JSON.stringify(plainUtf8)
      + '（坏掉了，符合预期）')
    check('反向夹具 B：丢掉 -X utf8（父进程仍按 UTF-8 解）→ 中文必然坏掉', true,
      JSON.stringify(plainUtf8))
  }
  check('正例与反向夹具必须给出**不同**的结果（不然上面那条正例证明不了什么）',
    goodUtf8 !== null && goodUtf8.trim() === CHINESE && sawBadCase,
    JSON.stringify({ good: goodUtf8, sawBadCase: sawBadCase }))

  if (FAULT) {
    console.log('--- --fault：把每个文件做"退回旧写法"的改写，静态扫描必须抓到')
    const kinds = { encoding: 0, utf8: 0 }
    for (const relative of FILES) {
      const file = nodePath.join(REPO, relative)
      if (!nodeFs.existsSync(file)) continue
      const text = nodeFs.readFileSync(file, 'utf8')
      if (text.indexOf('encoding="utf-8"') >= 0) {
        kinds.encoding += 1
        // 只去掉 encoding=，其余原样 —— 就是修复前那份写法。
        const mutant = text.replace(/(,\s*)encoding="utf-8"(,\s*errors="replace")?/g, '')
        const hits = scanText(mutant)
        check('--fault：' + relative + ' 去掉 encoding= 之后被抓到',
          mutant !== text && hits.some((hit) => hit.rule.indexOf('encoding') >= 0),
          hits.map((hit) => hit.line + ':' + hit.rule).join(' | ') || '（没抓到）')
      }
      if (text.indexOf('"-X", "utf8"') >= 0) {
        kinds.utf8 += 1
        const mutant = text.replace(/"-X",\s*"utf8",\s*/g, '')
        const hits = scanText(mutant)
        check('--fault：' + relative + ' 去掉 -X utf8 之后被抓到',
          mutant !== text && hits.some((hit) => hit.rule.indexOf('-X utf8') >= 0),
          hits.map((hit) => hit.line + ':' + hit.rule).join(' | ') || '（没抓到）')
      }
    }
    check('--fault：两类反向夹具都真的做过（encoding / -X utf8，不能只做一类）',
      kinds.encoding > 0 && kinds.utf8 > 0, JSON.stringify(kinds))
  }

  console.log(failures === 0 ? (FAULT ? '全部通过（故障注入下这些断言确实会红）' : '全部通过') : (failures + ' 项失败'))
  return failures
}

main()
process.exit(failures === 0 ? 0 : 1)
