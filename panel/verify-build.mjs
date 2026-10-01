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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_SCRIPTS, VENDOR_STATE, build, hostModule, clientBundle, isJunk, isSkipped, eolPolicy } from './build.mjs'

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
