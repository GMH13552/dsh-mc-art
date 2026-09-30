#!/usr/bin/env node
/**
 * 发布前门禁：**要发出去的东西里，不许有作者的机器痕迹或私人项目名。**
 *
 * 为什么要有：0.1.2–0.1.8 把开发时的注释、示例路径和随包 skill 里的私人项目名一起发了出去
 * —— 因为 `lib/` 是由源码逐字生成的，而 `preset/` 是另一个仓库的快照，**发布前没人扫一遍**。
 * npm 的版本不能改，所以这条只能靠"发之前拦住"。
 *
 *   node check-private.mjs            # 扫 lib/ preset/ 与几个根文件
 *   node check-private.mjs --fault    # 塞一个带标记的临时文件，要求它红
 *
 * 两类规则：
 *
 *   1. **通用形状**（写在这个文件里，谁都能看见、谁都能用）：绝对家目录路径、
 *      Windows 用户目录、API key 的形状。这一类正好是当初真正漏出去的东西
 *      （`/home/<user>/…`、`C:\Users\…`），也是别人 fork 之后最可能踩的。
 *   2. **专属词表**（**不**写在这个文件里）：具体项目名、中文物件名之类，
 *      只有作者知道该拦什么。它来自环境变量 `MCART_PRIVATE_MARKERS`（逗号分隔）
 *      或这个仓库里被 gitignore 的 `panel/private-markers.txt`（一行一个，# 开头是注释）。
 *      没配就只跑第 1 类，并在输出里**明说**这一点 —— 门禁的覆盖面必须写在脸上。
 *
 * 这个文件本身在公开仓库里，所以它自己一个字都不能带（以前的版本把词表写死在
 * 这里，等于把要拦的词又贴了一遍）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = ['lib', 'preset']
const FILES = ['cordis.patch.yml', 'README.md', 'build.mjs', 'package.json']
const FAULT = process.argv.includes('--fault')
const PLANT = join(HERE, 'lib', '.private-fault.txt')
const MARKER_FILE = join(HERE, 'private-markers.txt')

// 第 1 类：通用形状。用正则，不用字面量——因为要描述的是"任何人的机器路径"。
const PATTERNS = [
  { label: '家目录绝对路径', test: (text) => /(^|[^A-Za-z0-9_.\-\/])\/(?:home|Users)\/[A-Za-z0-9_.-]+\//.test(text) },
  { label: 'Windows 用户目录', test: (text) => /[A-Za-z]:\\\\?Users\\\\/i.test(text) || /[A-Za-z]:\\Users\\/i.test(text) },
  { label: 'API key 形状', test: (text) => /\bsk-[A-Za-z0-9_-]{16,}/.test(text) },
]

/** 第 2 类：专属词表（gitignore 的文件或环境变量；仓库里没有这份文件也照样能跑）。 */
function privateMarkers() {
  const fromEnv = (process.env.MCART_PRIVATE_MARKERS || '').split(',').map((word) => word.trim()).filter((word) => word !== '')
  if (fromEnv.length > 0) return { markers: fromEnv, source: 'MCART_PRIVATE_MARKERS' }
  if (!existsSync(MARKER_FILE)) return { markers: [], source: null }
  const markers = readFileSync(MARKER_FILE, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.charAt(0) !== '#')
  return { markers: markers, source: 'private-markers.txt' }
}

const { markers, source } = privateMarkers()

if (FAULT) {
  // 故障注入用第 3 类：一个只可能来自本机的路径，所以不靠词表也能证伪。
  writeFileSync(PLANT, '参考 /home/someone-else/projects/demo 与 C:\\Users\\someone\\demo 两处\n')
}
try {
  const hits = []
  const scan = (label, text) => {
    for (const pattern of PATTERNS) {
      if (pattern.test(text)) hits.push(`${label} ← ${pattern.label}`)
    }
    for (const marker of markers) {
      if (text.includes(marker)) hits.push(`${label} ← 词表命中`)
    }
    return hits.length
  }
  const walk = (path, label) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry), label + '/' + entry)
      return
    }
    scan(label, readFileSync(path, 'utf8'))
  }
  for (const root of ROOTS) walk(join(HERE, root), root)
  for (const file of FILES) walk(join(HERE, file), file)
  const coverage = PATTERNS.length + markers.length
  if (hits.length === 0) {
    console.log(`  OK   要发的 ${ROOTS.join('/ ')} 与根文件里没有私有痕迹（` +
      `${PATTERNS.length} 条通用规则` +
      (source === null
        ? '；**专属词表没配**，只跑了通用规则（要更严：设 MCART_PRIVATE_MARKERS 或写 panel/private-markers.txt）'
        : `；${markers.length} 条专属词表来自 ${source}`) + '）')
    console.log('全部通过')
  } else {
    for (const hit of hits.slice(0, 20)) console.log('  FAIL ' + hit + `（命中规则：${coverage} 条在跑）`)
    console.log(`${hits.length} 处私有内容 —— 拒绝发布`)
    process.exitCode = 1
  }
} finally {
  if (FAULT) rmSync(PLANT, { force: true })
}
