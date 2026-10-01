#!/usr/bin/env node
/**
 * 发布物里不许带「作者环境」的痕迹。
 *
 * 起因是**从 npm 上把包拉下来解包**查到的（不是猜的）：`package/python/mcart_extract_block.py`
 * 的 docstring 里写着 `see AGENT.md #8`（作者 gitignore 掉的私人笔记，消费者机器上根本没有），
 * 并且把某一个第三方模组当成"磁盘长什么样"的实测例子（`mods/[虚无世界] AoX-….jar`、
 * `assets/<那个模组>/…`）。这套东西的卖点是"通用、别人拿到能直接用"，那些字符串正好相反。
 *
 * 判据（都在**发布的那份** `panel/python/**` 上量，源码 `tools/mcart_*.py` 一起量，
 * 好在 build 之前就红）：
 *   1. 不许出现指向**仓库外 / 没随包发布**的文件名（`AGENT.md`、`private-markers.txt`…）；
 *   2. 不许出现已知的**第三方模组名**（清单来自上面那次审计）+ 一条哨兵名（只给 --fault 用）；
 *   3. 不许出现**作者机器路径**的形状（`/home/<user>/`、`C:\Users\…`）；
 *   4. 本机如果配了词表（`panel/private-markers.txt` 或 `MCART_PRIVATE_MARKERS`），也要过一遍。
 *
 * 为什么不在 `check-private.mjs` 里：那份词表是**作者本机**的（被 gitignore），换台机器就漏；
 * 这条把"形状"和"审计出来的名字"写进仓库，跟着包一起发也能跑。
 *
 *   node tools/mcart-plugin/publish-vocab-test.js
 *   node tools/mcart-plugin/publish-vocab-test.js --fault
 *       # 往 tools/mcart_extract_block.py 的 docstring 里塞 `see AGENT.md #9` + 一个模组名，
 *       # 跑 build，要求**发布的那份**被门禁抓到；然后还原、重建、复核逐字节复原。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')
const EXTRACT_SOURCE = nodePath.join(REPO, 'tools', 'mcart_extract_block.py')
const EXTRACT_PUBLISHED = nodePath.join(REPO, 'panel', 'python', 'mcart_extract_block.py')
const BUILD = nodePath.join(REPO, 'panel', 'build.mjs')

const PAIRS = [
  { label: 'mcart_extract_block.py', source: 'tools/mcart_extract_block.py', published: 'panel/python/mcart_extract_block.py' },
  { label: 'mcart_scan_refs.py', source: 'tools/mcart_scan_refs.py', published: 'panel/python/mcart_scan_refs.py' },
]

// 规则一：仓库外 / 没随包发布的文件名。消费者机器上不可能有这些东西。
const EXTERNAL_NOTES = ['AGENT.md', 'private-markers.txt', 'BRIEF.md', 'EVIDENCE-', '.team/']
// 规则二：**发布物里**的第三方模组名。这份清单来自那次 npm 包审计（当时 `ao`+`a3` 命中 16 处，
// 还有 achony / travelersbackpack / ars_nouveau）。
// 逐条**拆开拼**（`'ao' + 'a3'`）：这条门禁自己也要能被 `check-tracked-private.mjs` 扫，
// 拼出来的词不出现在本文件里，于是不需要任何豁免名单（和 win-native 那条门禁同一个约定）。
// `mcartauditsentinel` 是**哨兵**：它不是任何真实模组，只出现在 --fault 的注入里，
// 用来证明"发布的那份被改脏之后门禁真的会红"。
const THIRD_PARTY = ['ao' + 'a3', 'acho' + 'ny', 'travelers' + 'backpack', 'ars' + '_nouveau',
  '\u865a\u65e0\u4e16\u754c', 'mcartauditsentinel']
// 规则三：作者机器路径的形状（正则，不写死任何人的用户名）。
const MACHINE_PATHS = [
  { label: '家目录绝对路径', re: /(^|[^A-Za-z0-9_.-])\/(?:home|Users)\/[A-Za-z0-9_.-]+\// },
  { label: 'Windows 用户目录', re: /[A-Za-z]:[\\/]{1,2}Users[\\/]/i },
]

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

/** 本机词表（有就用，没有就只用仓库自带的三类规则）。 */
function localMarkers() {
  const fromEnv = (process.env.MCART_PRIVATE_MARKERS || '').split(',').map((word) => word.trim())
    .filter((word) => word !== '')
  if (fromEnv.length > 0) return fromEnv
  const file = nodePath.join(REPO, 'panel', 'private-markers.txt')
  if (!nodeFs.existsSync(file)) return []
  return nodeFs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim()).filter((line) => line !== '' && line.charAt(0) !== '#')
}

/** 一行行的扫：返回 [{line, rule, text}]。 */
function scan(text, markers) {
  const hits = []
  const lines = String(text).split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const needle of EXTERNAL_NOTES) {
      if (line.indexOf(needle) >= 0) hits.push({ line: index + 1, rule: '引用未随包发布的文件：' + needle, text: line.trim().slice(0, 120) })
    }
    for (const needle of THIRD_PARTY) {
      if (line.toLowerCase().indexOf(needle.toLowerCase()) >= 0) {
        hits.push({ line: index + 1, rule: '第三方模组名：' + needle, text: line.trim().slice(0, 120) })
      }
    }
    for (const rule of MACHINE_PATHS) {
      if (rule.re.test(line)) hits.push({ line: index + 1, rule: '作者机器路径（' + rule.label + '）', text: line.trim().slice(0, 120) })
    }
    for (const marker of markers) {
      if (line.indexOf(marker) >= 0) hits.push({ line: index + 1, rule: '本机词表：' + marker, text: line.trim().slice(0, 120) })
    }
  }
  return hits
}

function readIfExists(file) {
  return nodeFs.existsSync(file) ? nodeFs.readFileSync(file, 'utf8') : null
}

function runBuild() {
  const done = cp.spawnSync(process.execPath, [BUILD], { cwd: REPO, encoding: 'utf8', timeout: 300000 })
  return { status: done.status, out: String(done.stdout || '').trim().split('\n').slice(-1)[0], err: String(done.stderr || '').trim() }
}

async function main() {
  const markers = localMarkers()
  console.log('--- 规则：未随包发布的文件名 ' + JSON.stringify(EXTERNAL_NOTES)
    + '；第三方模组名 ' + THIRD_PARTY.length + ' 条；作者机器路径 ' + MACHINE_PATHS.length + ' 条；本机词表 '
    + (markers.length === 0 ? '（没配）' : markers.length + ' 条'))
  console.log('--- 源码与发布物（都扫；源码先红，免得脏东西进 build）')
  for (const pair of PAIRS) {
    const sourceText = readIfExists(nodePath.join(REPO, pair.source))
    const publishedText = readIfExists(nodePath.join(REPO, pair.published))
    if (sourceText === null) { check(pair.label + ' 源码存在', false, pair.source); continue }
    if (publishedText === null) {
      // 发布的那份不在 = 没 build。这不是"通过"，要说出来。
      check(pair.label + ' 发布的那份存在（先跑 node panel/build.mjs）', false, pair.published)
      continue
    }
    // 发布的那份必须就是源码（不然扫的是一个没人维护的旧副本）。
    check(pair.label + ' 发布的那份与源码逐字节相同（不是旧副本）',
      Buffer.from(sourceText, 'utf8').equals(Buffer.from(publishedText, 'utf8')),
      '源码 ' + Buffer.byteLength(sourceText) + ' 字节 / 发布 ' + Buffer.byteLength(publishedText) + ' 字节')
    const sourceHits = scan(sourceText, markers)
    check(pair.source + ' 没有私人笔记引用 / 第三方模组名 / 机器路径', sourceHits.length === 0,
      sourceHits.slice(0, 4).map((hit) => hit.line + ':' + hit.rule).join(' | '))
    const publishedHits = scan(publishedText, markers)
    check(pair.published + '（发布的那份）同上', publishedHits.length === 0,
      publishedHits.slice(0, 4).map((hit) => hit.line + ':' + hit.rule).join(' | '))
  }

  if (!FAULT) {
    console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
    return failures
  }

  // ── 反向夹具：往 docstring 里塞一行，build 之后发布的那份必须被抓到 ─────────
  console.log('--- --fault：往 tools/mcart_extract_block.py 注入 `see AGENT.md #9` + 一个模组名，再 build')
  const original = nodeFs.readFileSync(EXTRACT_SOURCE)
  const originalPublished = nodeFs.readFileSync(EXTRACT_PUBLISHED)
  const originalHash = require('crypto').createHash('sha256').update(original).digest('hex')
  let observed = null
  let restoreOk = null
  let restoreHash = null
  try {
    const text = original.toString('utf8')
    const cut = text.indexOf('\n')
    const injected = text.slice(0, cut + 1)
      + '# --fault: see AGENT.md #9 / mods/mcartauditsentinel-1.0.jar\n'
      + text.slice(cut + 1)
    nodeFs.writeFileSync(EXTRACT_SOURCE, injected)
    const built = runBuild()
    check('fault: 注入之后 build 成功', built.status === 0, JSON.stringify(built))
    const publishedText = readIfExists(EXTRACT_PUBLISHED)
    const hits = publishedText === null ? [] : scan(publishedText, markers)
    observed = hits
    console.log('    发布的那份被扫到的：' + (hits.length === 0 ? '（一条都没有）'
      : hits.map((hit) => hit.line + ':' + hit.rule).join(' | ')))
  } finally {
    nodeFs.writeFileSync(EXTRACT_SOURCE, original)
    const rebuilt = runBuild()
    const back = nodeFs.readFileSync(EXTRACT_SOURCE)
    restoreHash = require('crypto').createHash('sha256').update(back).digest('hex')
    const publishedBack = readIfExists(EXTRACT_PUBLISHED)
    restoreOk = rebuilt.status === 0 && restoreHash === originalHash && publishedBack !== null
      && Buffer.from(publishedBack, 'utf8').equals(originalPublished)
    console.log('    还原：源码 sha256=' + restoreHash + '（注入前 ' + originalHash + '），build exit='
      + rebuilt.status + '，发布的那份逐字节复原=' + String(publishedBack !== null && Buffer.from(publishedBack, 'utf8').equals(originalPublished)))
  }
  check('fault: 注入之后**发布的那份**被门禁抓到（≥1 条）',
    observed !== null && observed.length > 0,
    observed === null ? '没扫到' : JSON.stringify(observed.map((hit) => hit.rule)))
  check('fault: 注入了 AGENT.md 与哨兵模组名这两条都被抓到',
    observed !== null
      && observed.some((hit) => hit.rule.indexOf('AGENT.md') >= 0)
      && observed.some((hit) => hit.rule.indexOf('mcartauditsentinel') >= 0),
    JSON.stringify(observed === null ? [] : observed.map((hit) => hit.rule)))
  check('fault: 还原之后源码与发布物都逐字节复原（夹具不会把仓库改脏）', restoreOk === true,
    '源码 sha256=' + String(restoreHash) + '，注入前=' + originalHash)

  console.log(failures === 0 ? '全部通过（故障注入下这些断言确实会红）' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
