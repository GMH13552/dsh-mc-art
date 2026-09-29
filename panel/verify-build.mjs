#!/usr/bin/env node
/**
 * lib/ 是生成物，但它要随包发布——所以必须有东西挡住"改了源码忘了重跑 build"。
 * 做法和仓库里 verify_emitted.py 一样：重新生成一遍，逐字节比。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, hostModule, clientBundle } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
// 只构建一次，两个入口都用它的结果（build() 会写盘，重复调用既慢又吵）。
const built = build()
for (const [file, text] of [['index.js', hostModule(built.host)], ['client.js', clientBundle(built.client)]]) {
  const onDisk = readFileSync(join(HERE, 'lib', file), 'utf8')
  if (onDisk === text) {
    console.log(`  OK   lib/${file} 与源码去注释后重新生成的结果逐字符相同（${onDisk.length} 字符）`)
    continue
  }
  failures += 1
  console.log(`  FAIL lib/${file} 和重新生成的不一样：磁盘 ${onDisk.length}，新生成 ${text.length}`)
  const limit = Math.min(onDisk.length, text.length)
  const at = [...Array(limit).keys()].find((i) => onDisk[i] !== text[i])
  if (at !== undefined) console.log(`       第一处不同在第 ${at} 个字符：磁盘 ${JSON.stringify(onDisk.slice(at - 40, at + 40))} / 新 ${JSON.stringify(text.slice(at - 40, at + 40))}`)
}
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
