#!/usr/bin/env node
/**
 * lib/ 与随包的 preset/（含 skills/）都是**生成物**，但它们要随包发布——所以必须有东西
 * 挡住"改了源码忘了重跑 build"。做法和仓库里 verify_emitted.py 一样：重新生成一遍，逐字节比。
 *
 * ⚠️ 顺序很重要：`build()` 会**覆盖**这些生成物，所以必须先读一份快照，再生成、再比。
 * （第一版没这么做：它先 build()，于是自己把漂移修好了再比对——一个永远不会失败的门禁。）
 *
 *   node verify-build.mjs
 *   node verify-build.mjs --fault   # 往"期望结果"里塞一个字节，要求门禁红
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_SCRIPTS, VENDOR_STATE, VANILLA_PARENTS_JSON, VANILLA_PARENTS_FRAGMENT, vanillaParentsText, build, hostModule, clientBundle, isJunk, isSkipped, eolPolicy } from './build.mjs'
import { SOURCES, checkBarrels } from './source.mjs'
import { runPython } from '../tools/python_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAULT = process.argv.includes('--fault')
/** `--fault-eol`：把包内那份 `bin/mc-art` 写成 CRLF + 把 `.cmd` 写成 LF，要求行尾检查当场红。 */
const FAULT_EOL = process.argv.includes('--fault-eol')
let failures = 0
function fail(line) { failures += 1; console.log(line) }

/** 目录里每个文件的相对路径 → 内容（用于逐字节比对随包的 preset/ 与 skill/）。 */
function snapshot(root, skip = () => false) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const key = relative(root, full).replace(/\\/g, '/')
      if (skip(key)) continue
      if (statSync(full).isDirectory()) walk(full)
      // 比较时**忽略行尾差异**：包内的行尾由 build.mjs 统一（eolPolicy），而来源 clone
      // 的行尾取决于它是怎么被 checkout 的 —— 比内容，不比换行符（换行符另有专门断言）。
      else out.set(key, readFileSync(full, 'utf8').replace(/\r\n/g, '\n'))
    }
  }
  walk(root)
  return out
}

// ① 先读快照（此刻磁盘上是"上一次生成的结果"）
const before = {
  index: readFileSync(join(HERE, 'lib', 'index.js'), 'utf8'),
  client: readFileSync(join(HERE, 'lib', 'client.js'), 'utf8'),
}
/** 上一次 vendor 的来源 provenance：来源是旧 clone 这件事必须看得见。 */
const vendorBefore = existsSync(VENDOR_STATE) ? JSON.parse(readFileSync(VENDOR_STATE, 'utf8')) : null
// `--fault-vendor`：**在内存里**把"上一次记录"改成一个旧 commit，模拟"来源 clone 变新了"。
// 为什么不改磁盘上的文件：这一份是别人的构建也可能同时在写的生成物（实测踩过：我刚写好
// 假 commit，另一个进程正好重新 vendor，把我的夹具覆盖了 —— 门禁于是"不红"）。
if (process.argv.includes('--fault-vendor') && vendorBefore !== null) {
  vendorBefore.mcArt.commit = '0'.repeat(40)
}

// ② 重新生成
const built = build()

// ②'' barrel == 清单拼接（逐字节）。
//
// `tools/mcart-plugin/host.js` / `client.js` 现在是**生成物**：真源是 `<half>.manifest.json`
// 里按序排列的片段（入口列最后）。这条断言盯的是"片段改了但没重写 barrel"——
// 那会让 15+ 个直接读 barrel 的门禁看到过期源码，比红更坏。
// `--fault-barrel`：把 barrel 弄坏，要求这条当场红。legacy 模式（清单为空、尚未拆分）
// 没有可比的东西，此时用一份**临时夹具**跑同一个比较函数，证明它真能红。
const FAULT_BARREL = process.argv.includes('--fault-barrel')
const barrelProblems = []
if (FAULT_BARREL) {
  // 先按当前真实树判断模式：split → 直接改磁盘上的 barrel；legacy → 临时夹具。
  const probe = checkBarrels({ halves: ['host'] })
  if (probe.report.host.mode === 'split') {
    const target = join(SOURCES, 'host.js')
    const original = readFileSync(target)
    try {
      writeFileSync(target, Buffer.concat([original, Buffer.from('\n// fault-barrel\n', 'utf8')]))
      barrelProblems.push(...checkBarrels({ halves: ['host'] }).problems.map((problem) => '（--fault-barrel 注入后）' + problem))
    } finally {
      writeFileSync(target, original)
    }
    if (barrelProblems.length === 0) fail('  FAIL --fault-barrel：barrel 被改了，逐字节比对却没红')
    // 与 `--fault` / `--fault-eol` / `--fault-vendor` 同一体例：注入证明**以红收尾**
    // （这样退出码非 0 就是"这条断言真的能红"的证明；仓库本身没坏，已按字节还原）。
    else fail('  FAIL --fault-barrel：barrel 被改后逐字节比对报红（这是能红证明，仓库未受影响）')
  } else {
    const fixture = mkdtempSync(join(tmpdir(), 'mcart-barrel-'))
    try {
      mkdirSync(join(fixture, 'host'), { recursive: true })
      writeFileSync(join(fixture, 'host', 'p-a.js'), 'function alpha() { return 1 }\n')
      writeFileSync(join(fixture, 'host.manifest.json'), JSON.stringify(['host/p-a.js']))
      writeFileSync(join(fixture, 'host.js'), 'function alpha() { return 1 }\n// 手改过\n')
      barrelProblems.push(...checkBarrels({ root: fixture, halves: ['host'] }).problems)
    } finally { rmSync(fixture, { recursive: true, force: true }) }
    if (barrelProblems.length === 0) fail('  FAIL --fault-barrel 夹具失效：barrel 与拼接不同却没红')
    else fail('  FAIL --fault-barrel（legacy 模式夹具）：barrel 与拼接不同 → 比对报红（能红证明）')
  }
} else {
  const { problems, report } = checkBarrels()
  for (const [half, item] of Object.entries(report)) {
    if (item.mode === 'legacy') {
      console.log(`  · ${half}：legacy 单文件模式（清单为空，barrel 就是真源）—— 拆分落地后这条自动变成逐字节比对`)
    } else if (item.fragments > 0) {
      console.log(`  OK   ${half}：barrel == ${item.fragments} 个片段的清单拼接（${item.bytes} 字符，逐字节）`)
    }
  }
  for (const problem of problems) fail('  FAIL ' + problem)
  if (problems.length === 0 && Object.values(report).every((item) => item.mode === 'legacy')) {
    console.log('  · barrel 比对：当前仍是 legacy 单文件模式，没有可比的拼接结果（拆分后自动生效）')
  }
}

// ②''' 原版母模型表：**唯一真源**是 `tools/mcart-plugin/vanilla-parents.json`。
//   · 宿主片段 `host/06-vanilla-parents.generated.js` 必须 == 从 JSON 重新生成的结果；
//   · 打包副本 `panel/python/vanilla-parents.json` 必须逐字节等于真源；
//   · Python 实际读到的表必须 == JSON（漂移门禁：宿主片段 / JSON / Python 三者同一份）。
// `--fault-vanilla`：把 JSON 改一个值 → 上面两条比对必须红（然后按字节还原）。
const FAULT_VANILLA = process.argv.includes('--fault-vanilla')

function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function vanillaChecks(referencePayload) {
  const problems = []
  // ① 生成片段 == 从**当前磁盘上的** JSON 重新生成的结果（确定性渲染）
  let expectedFragment = null
  try {
    expectedFragment = vanillaParentsText(VANILLA_PARENTS_JSON)
  } catch (error) {
    problems.push('vanilla-parents.json 读不出来：' + error.message)
  }
  if (expectedFragment !== null) {
    const actualFragment = existsSync(VANILLA_PARENTS_FRAGMENT) ? readFileSync(VANILLA_PARENTS_FRAGMENT, 'utf8') : null
    if (actualFragment === null) problems.push('缺少生成片段 ' + VANILLA_PARENTS_FRAGMENT)
    else if (actualFragment !== expectedFragment) {
      problems.push('生成片段与从 JSON 重新生成的结果不同（' + actualFragment.length + ' vs ' + expectedFragment.length + ' 字符）'
        + ' —— 改了 JSON 却没 node panel/build.mjs，或手改了生成片段')
    }
  }
  // ② 打包副本逐字节（发布包里 python 读的就是它）
  const packed = join(HERE, 'python', 'vanilla-parents.json')
  if (!existsSync(packed)) problems.push('缺少打包副本 ' + packed)
  else if (!readFileSync(packed).equals(readFileSync(VANILLA_PARENTS_JSON))) {
    problems.push('打包副本 panel/python/vanilla-parents.json 与真源 JSON 不是逐字节相同')
  }
  // ③ Python 实际读到的表 == JSON（语义比较：对象键序无关）
  const script = join(HERE, '..', 'tools', 'mcart_extract_block.py')
  let dumped = null
  try {
    const done = runPython([script, '--dump-vanilla-parents'])
    if (done.status !== 0) problems.push('Python --dump-vanilla-parents 失败（退出码 ' + done.status + '）：'
      + String(done.stderr || '').trim().slice(0, 300))
    else dumped = JSON.parse(String(done.stdout || '').trim())
  } catch (error) {
    problems.push('跑不动 Python 取表：' + error.message)
  }
  if (dumped !== null) {
    if (dumped.parents === undefined) problems.push('Python 的输出里没有 parents')
    else if (canon(dumped.parents) !== canon(referencePayload.parents)) {
      problems.push('Python 实际读到的表与 JSON 不同 —— 两侧漂移（' + Object.keys(dumped.parents).length
        + ' vs ' + Object.keys(referencePayload.parents).length + ' 条）')
    }
  }
  return problems
}

{
  const originalJson = readFileSync(VANILLA_PARENTS_JSON)
  const originalPayload = JSON.parse(originalJson.toString('utf8'))
  if (FAULT_VANILLA) {
    try {
      const mutated = JSON.parse(JSON.stringify(originalPayload))
      mutated.parents['block/cross'].textures.particle = '#fault'
      writeFileSync(VANILLA_PARENTS_JSON, JSON.stringify(mutated, null, 2) + '\n')
      const problems = vanillaChecks(originalPayload)
      if (problems.length === 0) fail('  FAIL --fault-vanilla：JSON 改了值，两侧比对却没红')
      else for (const problem of problems) fail('  FAIL --fault-vanilla：' + problem)
      console.log('  · --fault-vanilla：JSON 改了一个值 → 上面 ' + problems.length + ' 条比对报红（能红证明，JSON 已按字节还原）')
    } finally {
      writeFileSync(VANILLA_PARENTS_JSON, originalJson)
      if (!readFileSync(VANILLA_PARENTS_JSON).equals(originalJson)) fail('  FAIL --fault-vanilla 还原失败')
    }
  } else {
    const problems = vanillaChecks(originalPayload)
    const entries = Object.keys(originalPayload.parents || {}).length
    if (problems.length === 0) {
      console.log('  OK   原版母模型表：生成片段 == JSON 重新生成（' + entries + ' 条）；'
        + '打包副本逐字节相同；Python 读到的表 == JSON（漂移门禁）')
    }
    for (const problem of problems) fail('  FAIL ' + problem)
  }
}

// ②' 来源 provenance：vendor 用了哪个 clone 的哪个 commit。
//     两次之间 commit 变了 = 生成物落后于来源 → 必须重新 vendor（"来源是旧 clone"这次
//     就是靠这条才会被看见；以前生成物里没有任何来源信息）。
const vendorAfter = existsSync(VENDOR_STATE) ? JSON.parse(readFileSync(VENDOR_STATE, 'utf8')) : null
if (vendorAfter === null) {
  fail('  FAIL 生成物里没有 vendor provenance（' + VENDOR_STATE + '）—— 来源无从追溯')
} else if (vendorBefore !== null && vendorBefore.mcArt.commit !== vendorAfter.mcArt.commit) {
  fail(`  FAIL mc-art 来源 clone 变新了：上一次 vendor 是 ${vendorBefore.mcArt.commit || '(空)'}，`
    + `现在是 ${vendorAfter.mcArt.commit || '(空)'} —— 重新跑 node panel/build.mjs`)
} else {
  console.log(`  OK   mc-art 来源：${vendorAfter.mcArt.source} @ ${vendorAfter.mcArt.commit || '(没有 .git)'}` +
    `（${vendorAfter.mcArt.files} 个文件进了包）`)
}

// ②'' `--fault-eol`：把包内行尾弄坏，要求下面的断言红（反向夹具）。
if (FAULT_EOL) {
  const launcher = join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art', 'bin', 'mc-art')
  const cmd = join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art', 'bin', 'mc-art.cmd')
  if (existsSync(launcher)) {
    const text = readFileSync(launcher, 'utf8').replace(/\r\n/g, '\n')
    writeFileSync(launcher, text.replace(/\n/g, '\r\n'))
    console.log('  （--fault-eol：把包内 bin/mc-art 写成 CRLF）')
  }
  if (existsSync(cmd)) {
    writeFileSync(cmd, readFileSync(cmd, 'utf8').replace(/\r\n/g, '\n'))
    console.log('  （--fault-eol：把包内 bin/mc-art.cmd 写成 LF）')
  }
}

// ③ 比对
let expectedHost = hostModule(built.host)
const expectedClient = clientBundle(built.client)
if (FAULT) expectedHost += '\n// fault\n'
for (const [label, disk, expected] of [['lib/index.js', before.index, expectedHost],
  ['lib/client.js', before.client, expectedClient]]) {
  if (disk === expected) {
    console.log(`  OK   ${label} 与源码去注释后重新生成的结果逐字符相同（${disk.length} 字符）`)
    continue
  }
  fail(`  FAIL ${label} 和重新生成的不一样：磁盘 ${disk.length}，新生成 ${expected.length}`)
  const limit = Math.min(disk.length, expected.length)
  const at = [...Array(limit).keys()].find((i) => disk[i] !== expected[i])
  if (at !== undefined) {
    console.log(`       第一处不同在第 ${at} 个字符：磁盘 ${JSON.stringify(disk.slice(at - 40, at + 40))} / 新 ${JSON.stringify(expected.slice(at - 40, at + 40))}`)
  }
}

// ③ 行尾门禁：包内的行尾由 `build.mjs:eolPolicy` 统一，**不许取决于来源 clone 的
//    `core.autocrlf`**。实测过一次：`bin/mc-art`（POSIX shebang 启动器）带 53 个 CR
//    进了 npm 包，在 bash 里直接跑不了；而 `.cmd`/`.ps1` 两个 Windows 入口那时还是旧的。
const eolViolations = []
function checkEol(full, label) {
  const policy = eolPolicy(full)
  if (policy === null) return
  const buffer = readFileSync(full)
  if (buffer.includes(0)) return                                  // 二进制不碰
  let cr = 0
  let lf = 0
  for (const byte of buffer) { if (byte === 13) cr += 1; else if (byte === 10) lf += 1 }
  if (policy === 'lf' && cr > 0) eolViolations.push(`${label}: 该 LF，却有 ${cr} 个 CR`)
  if (policy === 'crlf' && cr !== lf) eolViolations.push(`${label}: 该 CRLF，${lf} 个 LF 里只有 ${cr} 个带 CR`)
}
const walkEol = (root, prefix) => {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    const label = prefix + '/' + entry.name
    if (entry.isDirectory()) walkEol(full, label)
    else checkEol(full, label)
  }
}
for (const [root, label] of [[join(HERE, 'preset'), 'preset'], [join(HERE, 'python'), 'python'], [join(HERE, 'lib'), 'lib']]) {
  walkEol(root, label)
}
if (eolViolations.length === 0) {
  console.log('  OK   包里所有文本的行尾都符合政策（脚本 .cmd/.ps1 用 CRLF，其余用 LF）')
} else {
  for (const problem of eolViolations.slice(0, 10)) fail('  FAIL 行尾不对：' + problem)
  if (eolViolations.length > 10) fail(`  FAIL 还有 ${eolViolations.length - 10} 处行尾问题`)
}
// 三个 mc-art 入口单独点名（这是那次真事故的位置）。
const artSkill = join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art')
if (!existsSync(artSkill)) {
  console.log('  · mc-art skill 没进包（开发机上没有克隆）—— 入口那三条没跑')
} else {
  const launcher = join(artSkill, 'bin', 'mc-art')
  if (!existsSync(launcher)) fail('  FAIL 包内缺 bin/mc-art（POSIX 入口）')
  else {
    const cr = readFileSync(launcher).filter((byte) => byte === 13).length
    if (cr === 0) console.log('  OK   bin/mc-art 是纯 LF（CR=0）')
    else fail(`  FAIL bin/mc-art 里有 ${cr} 个 CR —— POSIX 启动器必须 LF`)
  }
  for (const name of ['mc-art.cmd', 'mc-art.ps1']) {
    const full = join(artSkill, 'bin', name)
    if (!existsSync(full)) { fail(`  FAIL 包内缺 bin/${name}（Windows 入口）`); continue }
    const buffer = readFileSync(full)
    let cr = 0
    let lf = 0
    for (const byte of buffer) { if (byte === 13) cr += 1; else if (byte === 10) lf += 1 }
    if (lf > 0 && cr === lf) console.log(`  OK   bin/${name} 是 CRLF（${lf} 行）`)
    else fail(`  FAIL bin/${name} 该是 CRLF：${lf} 个 LF / ${cr} 个 CR`)
  }
}

/** 两份目录树逐字节比；一致返回 null，否则返回一句人话。 */
function treeDiff(expectedRoot, actualRoot, label, skipActual = () => false) {
  // 垃圾（.git / __pycache__ / .cache）两边都要忽略；skipActual 只用来处理
  // "生成的那份多带了 skills/" 这种结构性差异。
  // 两侧都要用同一套"不复制"规则：build 会跳过 tests/，比对时也得跳过，
  // 否则门禁会把"有意没复制"报成"少了 25 个文件"（它刚这么干过）。
  const skipCommon = (key) => isJunk(key) || isSkipped(key)
  const expected = snapshot(expectedRoot, skipCommon)
  const actual = snapshot(actualRoot, (key) => skipCommon(key) || skipActual(key))
  const missing = [...expected.keys()].filter((key) => !actual.has(key))
  const extra = [...actual.keys()].filter((key) => !expected.has(key))
  const changed = [...expected.keys()].filter((key) => actual.has(key) && expected.get(key) !== actual.get(key))
  if (missing.length === 0 && extra.length === 0 && changed.length === 0) return null
  return `${label}：应有 ${expected.size} 个文件、实际 ${actual.size} 个` +
    `（少了 ${missing.length}、多了 ${extra.length}、改了 ${changed.length}）` +
    (changed.length > 0 ? ' 例如 ' + changed.slice(0, 3).join(', ') : '') +
    (missing.length > 0 ? ' 缺 ' + missing.slice(0, 3).join(', ') : '')
}

// 随包的 preset/ 是 panel/vendor.mjs 在打包时生成的（仓库里不留副本），
// 所以这里比的是"生成出来的那份"和"它的来源"。
const artSource = process.env.MC_ART_SKILL_DIR ?? join(homedir(), '.dsh', 'skills', 'mc-art')
const pairs = [
  // 生成的那份还带着随包 skill（skills/），来源里没有——比的是"预设本身"。
  ['「MC 模组工作室」模式', join(HERE, '..', 'presets', 'mc-studio'), join(HERE, 'preset', 'mc-studio'),
    (key) => key.startsWith('skills/')],
  ['mc-mod skill', join(HERE, '..', 'skills', 'mc-mod'), join(HERE, 'preset', 'mc-studio', 'skills', 'mc-mod')],
]
if (existsSync(join(artSource, 'SKILL.md'))) {
  pairs.push(['mc-art skill', artSource, join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art'), isJunk])
} else {
  console.log(`  SKIP mc-art 没在本机找到克隆（${artSource}）——这一份没进包，也没得比`)
}
// 随包的 Python 引擎脚本：包里的那份必须和仓库里的**逐字节相同**
// （它们读 jar、决定参考目录能读到什么；一份漂了的副本会让"别人机器上读不出来"重现）。
for (const name of ENGINE_SCRIPTS) {
  const from = join(HERE, '..', 'tools', name)
  const to = join(HERE, 'python', name)
  if (!existsSync(to)) { fail(`  FAIL 引擎脚本没进包：${to}`); continue }
  const same = readFileSync(from, 'utf8') === readFileSync(to, 'utf8')
  if (same) console.log(`  OK   引擎脚本 ${name}：包里那份与仓库逐字节相同`)
  else fail(`  FAIL 引擎脚本 ${name} 与仓库里的不一样（先跑 node panel/build.mjs）`)
}

for (const [label, from, to, skipActual] of pairs) {
  const problem = treeDiff(from, to, label, skipActual)
  if (problem === null) console.log(`  OK   ${label}：包里那份与来源逐字节相同（${snapshot(to).size} 个文件）`)
  else fail(`  FAIL ${problem}`)
}

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
