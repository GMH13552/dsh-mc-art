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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, hostModule, clientBundle, isJunk, isSkipped } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAULT = process.argv.includes('--fault')
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
      else out.set(key, readFileSync(full, 'utf8'))
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

// ② 重新生成
const built = build()

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
for (const [label, from, to, skipActual] of pairs) {
  const problem = treeDiff(from, to, label, skipActual)
  if (problem === null) console.log(`  OK   ${label}：包里那份与来源逐字节相同（${snapshot(to).size} 个文件）`)
  else fail(`  FAIL ${problem}`)
}

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
