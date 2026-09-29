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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, hostModule, clientBundle } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAULT = process.argv.includes('--fault')
let failures = 0
function fail(line) { failures += 1; console.log(line) }

/** 目录里每个文件的相对路径 → 内容（用于逐字节比对随包的 preset/ 与 skill/）。 */
function snapshot(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.set(relative(root, full).replace(/\\/g, '/'), readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return out
}

// ① 先读快照（此刻磁盘上是"上一次生成的结果"）
const before = {
  index: readFileSync(join(HERE, 'lib', 'index.js'), 'utf8'),
  client: readFileSync(join(HERE, 'lib', 'client.js'), 'utf8'),
  preset: snapshot(join(HERE, 'preset')),
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

for (const [label, dir] of [['preset', 'preset']]) {
  const after = snapshot(join(HERE, dir))
  const oldKeys = [...before[label].keys()].sort()
  const newKeys = [...after.keys()].sort()
  const missing = oldKeys.filter((key) => !newKeys.includes(key))
  const extra = newKeys.filter((key) => !oldKeys.includes(key))
  const changed = oldKeys.filter((key) => newKeys.includes(key) && before[label].get(key) !== after.get(key))
  if (missing.length === 0 && extra.length === 0 && changed.length === 0 && oldKeys.length > 0) {
    console.log(`  OK   ${dir}/ 与仓库里的源码逐字节相同（${oldKeys.length} 个文件）`)
    continue
  }
  fail(`  FAIL ${dir}/ 与仓库源码不一致：旧有 ${oldKeys.length} 个文件，新生成 ${newKeys.length} 个` +
    `（少了 ${missing.length}、多了 ${extra.length}、改了 ${changed.length}）` +
    (changed.length > 0 ? ' 例如 ' + changed.slice(0, 3).join(', ') : ''))
}

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
