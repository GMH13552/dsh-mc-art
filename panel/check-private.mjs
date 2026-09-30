#!/usr/bin/env node
/**
 * 发布前门禁：**要发出去的东西里，不许有作者的机器痕迹或私人项目名。**
 *
 * 为什么要有：0.1.2–0.1.8 我都把开发时的注释、示例路径和随包 skill 里的私人项目名一起发了出去
 * （`/home/gmh/...`、`fleshland`、示例包名、你项目的中文名）—— 因为 `lib/` 是由源码逐字生成的，
 * 而 `preset/` 是另一个仓库的快照，**发布前没人扫一遍**。npm 的版本不能改，所以这条只能靠
 * "发之前拦住"。
 *
 *   node check-private.mjs            # 扫 lib/ preset/ 与几个根文件
 *   node check-private.mjs --fault    # 塞一个带标记的临时文件，要求它红
 *
 * 标记表是"不想让陌生人看到的东西"：改这里就是改规矩。**注意别写进合法内容**
 * （比如仓库自己的 GitHub 用户名是公开的，不该在这里）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKERS = ['fleshland', '/home/gmh', 'eyeball', '血肉']
const ROOTS = ['lib', 'preset']
const FILES = ['cordis.patch.yml', 'README.md', 'build.mjs', 'package.json']
const FAULT = process.argv.includes('--fault')
const PLANT = join(HERE, 'lib', '.private-fault.txt')

if (FAULT) writeFileSync(PLANT, 'fleshland /home/gmh 血肉\n')
try {
  const hits = []
  const walk = (path, label) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry), label + '/' + entry)
      return
    }
    const text = readFileSync(path, 'utf8')
    for (const marker of MARKERS) {
      if (text.includes(marker)) {
        const at = text.indexOf(marker)
        hits.push(`${label} ← ${marker} … ${JSON.stringify(text.slice(Math.max(0, at - 30), at + 30))}`)
      }
    }
  }
  for (const root of ROOTS) walk(join(HERE, root), root)
  for (const file of FILES) walk(join(HERE, file), file)
  if (hits.length === 0) {
    console.log(`  OK   要发的 ${ROOTS.join('/ ')} 与根文件里没有私有标记（${MARKERS.join(' / ')}）`)
    console.log('全部通过')
  } else {
    for (const hit of hits.slice(0, 20)) console.log('  FAIL ' + hit)
    console.log(`${hits.length} 处私有内容 —— 拒绝发布`)
    process.exitCode = 1
  }
} finally {
  if (FAULT) rmSync(PLANT, { force: true })
}
