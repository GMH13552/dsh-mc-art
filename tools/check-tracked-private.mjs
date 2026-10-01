#!/usr/bin/env node
/**
 * 门禁：**所有会被 git 跟踪的文件**里不许有作者/私人项目的痕迹。
 *
 * 为什么不是目录白名单：`panel/check-private.mjs` 只扫 `panel/**` + 4 个根文件，
 * 于是 `tools/emit_atlas.py`、`tools/test_extract_block.py`、`examplemod/**` 里的私人模组
 * 词汇一路躺在会公开的地方。**白名单就是漏掉的原因**，所以这里的判据是
 * `git ls-files`（git 跟踪什么，什么就会推上去），不写任何目录清单。
 *
 * 判据分两层，**性质不同，处理也不同**：
 *
 *   1. **私人名**（作者的模组/项目/资产名，具体见下面的哨兵表）：**一律 FAIL**，
 *      不分注释还是代码 —— 那是隐私，注释里也是泄漏。
 *   2. **第三方模组/整合包名**：只在**代码或断言**里 FAIL（那会让测试依赖"这台机器上
 *      装了什么"，别人拿到必然假红或跳过）；只在**注释/docstring** 里出现的算**提示**，
 *      不阻塞发布 —— 那是实测记录（"某整合包一个命名空间就有 1403 个方块"），有文献价值，
 *      保留。提示单独分组打印，将来想清理有个清单。
 *   3. **形状**（正则，不落字面量）：Windows 用户目录、API key → FAIL。
 *      POSIX 家目录（`/home/<user>/`）→ **只提示**：这个交付物是**原生 Windows 插件**，
 *      WSL/POSIX 侧不在范围内。
 *   4. **外部词表**：`MCART_PRIVATE_MARKERS` / `panel/private-markers.txt`（私人名一类，FAIL）。
 *
 * 内置哨兵故意**拆开写**（`'eye' + 'ball'`）：门禁自己也在 `git ls-files` 里，
 * 写整串会让它命中自己；拆开之后文件文本不含这些词，却仍然查得出别人的文件。
 * 词表用**完整串**，不用子串：只写那个通用英文词会把正常用法一起误报，写完整项目名才准。
 *
 *   node tools/check-tracked-private.mjs
 *   node tools/check-tracked-private.mjs --fault   # 两组对照：注入→红→按字节还原；拿掉 -X utf8→红→还原
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const FAULT = process.argv.includes('--fault')
const MARKER_FILE = join(REPO, 'panel', 'private-markers.txt')
// 故障注入用的文件：跟踪的、平时不含哨兵的文本文件。
const FAULT_TARGET = join(REPO, 'tools', 'emit_atlas.py')
// 第二条判据的故障注入目标：一个真的起 Python 子进程、真的写了 `-X utf8` 的跟踪文件。
const ALIGNMENT_TARGET = join(REPO, 'tools', 'mcmod_gametest.py')

/**
 * 内置哨兵。**逐条拆开拼**（见文件头）：拼出来的词不出现在本文件里，
 * 于是"扫所有跟踪文件"这条判据可以连本文件一起扫，不需要任何豁免名单。
 * 拆的时候要注意：任何一段都不能自己等于另一个哨兵（拼出来的中间串也不能撞上别的哨兵）。
 */
const BLOOD_MEAT = '\u8840\u8089'          // 私人资产名（用 \u 转义写出，源文件里不是这几个字）
const EYE_BALL = '\u773c\u7403'            // 另一个私人命名空间词（同上，转义写）
/** 私人名：**注释里也算泄漏**，一律 FAIL。 */
const PRIVATE_MARKERS = [
  'the' + '_nameless' + '_mist',   // 私人模组名（完整串；子串会把英文用法一起误报）
  'flesh' + 'land',                // 旧示例工程名
  'eye' + 'ball',                  // 私人命名空间词的一段
  'eye' + 'ball' + 'tree',         // 私人命名空间（完整）
  BLOOD_MEAT,
  EYE_BALL,
  'blood' + '_sheep',              // 旧私人资产名
  'blood' + '_slime',
  'crystal' + '_bow',
  // 注意：**不要**加 `gmh13` —— 它会在 `GHM13552`（本仓库公开的 GitHub 账号）上误报。
  // 本机用户名已经由下面的"Windows 用户目录"形状覆盖。
]
/**
 * 第三方模组/整合包名：**代码里** FAIL（把测试绑到"这台机器装了什么"），
 * **注释里**只提示（实测记录，有价值）。用户明确说过交付物是通用插件、不针对某个包。
 */
const THIRD_PARTY_MARKERS = [
  'ao' + 'a3',
]

/**
 * 占位符用户名：**说明文字与夹具**里写的假路径（`/home/someone/…`、`C:\\Users\\probe\\…`、
 * `C:\\Users\\x\\y`）。门禁的覆盖面要写在脸上：这份名单就是"不算泄漏"的**全部**例外，
 * 会打印在输出里；真实用户目录（`C:\\Users\\<真名>`、`/home/<真名>/`）照样命中。
 */
const PLACEHOLDER_USERS = ['someone', 'someone-else', 'user', 'username', 'you', 'your-name',
  'probe', 'example', 'x', 'name', '\u4f60', 'foo', 'bar']

function isPlaceholderUser(name) {
  const text = String(name ?? '').trim().toLowerCase()
  if (text === '') return true
  if (text.includes('<') || text.includes('>') || text.includes('\u2026') || text.includes('...')) return true
  return PLACEHOLDER_USERS.includes(text.replace(/[.]+$/, ''))
}

/** FAIL 的形状：Windows 用户目录 / API key —— 这就是这个交付物关心的那台机器。 */
const SHAPES = [
  { label: 'Windows 用户目录',
    test: (text) => [...text.matchAll(/[A-Za-z]:\\{1,2}Users\\([^\\\s"']*)/gi)]
      .some((match) => !isPlaceholderUser(match[1])) },
  { label: 'API key 形状', test: (text) => /\bsk-[A-Za-z0-9_-]{16,}/.test(text) },
]

/**
 * **只提示**的形状：POSIX 家目录。交付物是**原生 Windows 插件**，WSL/POSIX 侧不在范围内
 * （Lead 明确说过"忘掉 WSL"），所以这类只记录、不阻塞。
 */
const HINT_SHAPES = [
  { label: 'POSIX 家目录路径（WSL 侧，不在交付范围）',
    test: (text) => [...text.matchAll(/(?:^|[^A-Za-z0-9_.\-\/])\/(?:home|Users)\/([A-Za-z0-9_.-]+)\//g)]
      .some((match) => !isPlaceholderUser(match[1])) },
]

function externalMarkers() {
  const fromEnv = (process.env.MCART_PRIVATE_MARKERS || '').split(',').map((word) => word.trim()).filter((word) => word !== '')
  if (fromEnv.length > 0) return { markers: fromEnv, source: 'MCART_PRIVATE_MARKERS' }
  if (!existsSync(MARKER_FILE)) return { markers: [], source: null }
  const markers = readFileSync(MARKER_FILE, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.charAt(0) !== '#')
  return { markers, source: 'private-markers.txt' }
}

/**
 * ── 第二类判据：起 Python 子进程的地方必须"子进程 UTF-8 模式 + 父进程按 UTF-8 解" ──
 *
 * 这条是 panel-host 这轮量出来的同一类洞：宿主起子进程时传 `-X utf8`（并期望自己的
 * stdout 是 UTF-8），而门禁自己起 Python 子进程时只写了 `encoding="utf-8"`、漏了 `-X utf8`
 * —— "门禁要求别人、自己却不满足"。测的是**跟踪文件里的每一个 spawn 点**，包括测试文件。
 *
 * Python 侧（`subprocess.*`，argv 里有 `sys.executable` 或 python 字面量）：
 *   子进程 → `-X utf8` / `-Xutf8` / `PYTHONUTF8` / `PYTHONIOENCODING`；
 *   父进程 → `encoding="utf-8"`，或用二进制句柄（`stdout=`）、`text=False`。
 * JS 侧：只查**直接** spawn 且调用里点了 python 的；走仓库集中封装
 *   （`spawnPython` / `runPython`，内部已经统一给编码与环境）的一律放行。
 */
function balancedCall(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') { depth -= 1; if (depth === 0) return text.slice(openIndex, index + 1) }
  }
  return text.slice(openIndex)
}

function childUtf8(call) {
  // 两种写法都要认：`-Xutf8`（一个词）与 `["-X", "utf8"]`（argv 里两个词）。
  // 注意 `\b` 不能用在 `-` 前面（`"` 和 `-` 都是非单词字符，没有词边界）——第一版就栽在这。
  // 走仓库集中封装的（`pythonEnv()` 内部就是 PYTHONUTF8 + PYTHONIOENCODING）同样算数，
  // 下面另有一条断言盯着那个封装本身没被改坏。
  return /(?<![A-Za-z0-9_])-X\s*,?\s*['"]?\s*utf8/i.test(call) ||
    /(?<![A-Za-z0-9_])-X\b[^)\n]{0,14}\butf8\b/i.test(call) ||
    /PYTHONUTF8|PYTHONIOENCODING|pythonEnv|PYTHON_UTF8_ENV/.test(call)
}

/**
 * 注释不算代码：把块注释填成空白（保行号）、每行在行注释处截断。
 * 不这么做，一行文档注释里的 `spawnSync('python3', …)` 就会被当成真的 spawn 点
 * （第一版就在 `tools/python_env.mjs` 的说明文字上误报过）。
 */
function codeOnly(text, isPy) {
  let out = text
  if (!isPy) out = out.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  return out.split('\n').map((line) => {
    const cut = isPy ? line.indexOf('#') : line.indexOf('//')
    return cut >= 0 ? line.slice(0, cut) : line
  }).join('\n')
}

function parentUtf8(call) {
  return /encoding\s*=\s*['"]utf-?8['"]/i.test(call) || /encoding\s*:\s*['"]utf-?8['"]/i.test(call) ||
    /stdout\s*=/.test(call) || /text\s*=\s*False/.test(call) || /stdio\s*:\s*['"]inherit['"]/.test(call)
}

function spawnAlignment(files) {
  const problems = []
  let exempted = 0
  for (const relative of files) {
    if (!/\.(py|mjs|js)$/.test(relative)) continue
    let buffer
    try { buffer = readFileSync(join(REPO, relative)) } catch (error) { continue }
    if (buffer.includes(0)) continue
    const rawText = buffer.toString('utf8')
    const rawLines = rawText.split('\n')
    const text = codeOnly(rawText, relative.endsWith('.py'))
    const isPy = relative.endsWith('.py')
    const pattern = isPy
      ? /\b(?:subprocess|sp)\s*\.\s*(?:run|Popen|call|check_output|check_call|getoutput)\s*\(/g
      : /\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      const call = balancedCall(text, match.index + match[0].length - 1)
      const pythonish = isPy
        ? /sys\.executable/.test(call) || /['"]python3?(?:\.exe)?['"]/.test(call)
        : /python/i.test(call)
      if (!pythonish) continue
      // 集中封装：编码与环境在 python_env.mjs 里统一给，这里放行。
      if (/spawnPython|runPython/.test(call)) continue
      const line = text.slice(0, match.index).split('\n').length
      // 显式豁免：只给"故意复刻旧写法"的 A/B 夹具用，必须带理由写在近处。
      // 注意要在**原始行**里找标记 —— 标记本身就是 `//` 注释，code-only 文本里已经被截掉了。
      const near = rawLines.slice(Math.max(0, line - 4), line).join('\n')
      if (/utf8-check:\s*exempt/.test(near)) { exempted += 1; continue }
      if (!childUtf8(call)) {
        problems.push({ file: relative, line, what: '起 Python 子进程没给子进程 UTF-8 模式（-X utf8 / PYTHONUTF8）' })
      }
      if (!parentUtf8(call)) {
        problems.push({ file: relative, line, what: '起 Python 子进程没按 UTF-8 解（encoding="utf-8" / 二进制句柄）' })
      }
    }
  }
  return { problems, exempted }
}

/** 跟踪的文件清单。`-z`：文件名里可能有空格/中文。 */
function trackedFiles() {
  const done = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (done.status !== 0) throw new Error('git ls-files 失败：' + String(done.stderr ?? '').trim())
  return String(done.stdout ?? '').split('\0').filter((name) => name !== '')
}

/** 这一行是不是注释/docstring —— 只用于"第三方模组名"的分层判据（私人名不分层）。 */
function documentationLines(rawText, isPy) {
  const out = []
  let inBlock = false
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim()
    let doc = inBlock
    if (isPy) {
      const quotes = (line.match(/"""|'''/g) || []).length
      if (inBlock) { doc = true; if (quotes % 2 === 1) inBlock = false }
      else if (quotes % 2 === 1) { doc = true; inBlock = true }
      if (trimmed.startsWith('#')) doc = true
    } else {
      if (inBlock) { doc = true; if (line.includes('*/')) inBlock = false }
      else if (line.includes('/*')) { doc = true; if (!line.includes('*/')) inBlock = true }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) doc = true
    }
    out.push(doc)
  }
  return out
}

/** 行内注释的起点（-1 = 没有）。粗略就够：只用来分"代码里 / 注释里"。 */
function inlineCommentAt(line, isPy) {
  return isPy ? line.indexOf('#') : line.indexOf('//')
}

/** 扫一遍。返回 `{failures, hints, files}`。二进制文件（含 NUL）跳过。 */
function collect(externalMarkerList) {
  const failures = []
  const hints = []
  const files = trackedFiles()
  for (const relative of files) {
    let buffer
    try { buffer = readFileSync(join(REPO, relative)) } catch (error) { continue }
    if (buffer.includes(0)) continue                      // 二进制：不是"散文"
    const text = buffer.toString('utf8')
    const isPy = relative.endsWith('.py')
    const lines = text.split('\n')
    const docs = documentationLines(text, isPy)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const lower = line.toLowerCase()
      const commentAt = inlineCommentAt(line, isPy)
      const inComment = docs[index] || commentAt >= 0
      // ① 私人名：注释里也算泄漏 → 一律 FAIL。
      for (const marker of PRIVATE_MARKERS.concat(externalMarkerList)) {
        if (lower.includes(marker.toLowerCase())) {
          failures.push({ file: relative, line: index + 1, what: '私人名/词表命中' })
        }
      }
      // ② 第三方模组名：代码里 FAIL，注释里只提示。
      for (const marker of THIRD_PARTY_MARKERS) {
        const at = lower.indexOf(marker.toLowerCase())
        if (at < 0) continue
        const inCode = !inComment && !(commentAt >= 0 && at > commentAt)
        const where = relative + ':' + (index + 1)
        if (inCode) failures.push({ file: relative, line: index + 1, what: '第三方模组名出现在代码/断言里' })
        else hints.push({ where, what: '第三方模组名（只在注释/docstring 里，文献引用）' })
      }
      // ③ 形状：Windows 用户目录 / API key → FAIL；POSIX 家目录 → 提示。
      for (const shape of SHAPES) {
        if (shape.test(line)) failures.push({ file: relative, line: index + 1, what: shape.label })
      }
      for (const shape of HINT_SHAPES) {
        if (shape.test(line)) hints.push({ where: relative + ':' + (index + 1), what: shape.label })
      }
    }
  }
  return { failures, hints, files: files.length }
}

function main() {
  const { markers, source } = externalMarkers()
  const all = markers
  let failures = 0
  const check = (label, ok, detail) => {
    if (!ok) failures += 1
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  }

  if (FAULT) {
    // ① 注入私人词汇 → 必须红 → **按字节还原**（还原也要能证明：字节前后一致）。
    const before = readFileSync(FAULT_TARGET)
    try {
      writeFileSync(FAULT_TARGET, Buffer.concat([before, Buffer.from('\n# ' + BLOOD_MEAT + '\n', 'utf8')]))
      const { failures: found } = collect(all)
      const caught = found.some((hit) => hit.file === 'tools/emit_atlas.py')
      check('① 往 tools/emit_atlas.py 注入一行私人词汇 → 门禁必须红', caught,
        caught ? '' : '居然没抓到（命中的文件：' + JSON.stringify([...new Set(found.map((h) => h.file))].slice(0, 5)) + '）')
    } finally {
      writeFileSync(FAULT_TARGET, before)
    }
    check('① 还原后逐字节相同（注入没有留下任何痕迹）', readFileSync(FAULT_TARGET).equals(before),
      before.length + ' -> ' + readFileSync(FAULT_TARGET).length + ' 字节')

    // ② 把一处 spawn 的 `-X utf8` 拿掉 → 对齐门禁必须红 → 再按字节还原。
    const alignmentBefore = readFileSync(ALIGNMENT_TARGET)
    const poisoned = alignmentBefore.toString('utf8').replace('"-X", "utf8", ', '')
    check('② 夹具本身有效：目标文件里确实有可拿掉的 `-X utf8`', poisoned !== alignmentBefore.toString('utf8'),
      '找不到可替换的片段，说明夹具失效了')
    try {
      writeFileSync(ALIGNMENT_TARGET, Buffer.from(poisoned, 'utf8'))
      const { problems } = spawnAlignment(trackedFiles())
      const caught = problems.some((item) => item.file === 'tools/mcmod_gametest.py')
      check('② 拿掉 `-X utf8` 之后 → 子进程 UTF-8 模式那条必须红', caught,
        caught ? '' : '居然没抓到：' + JSON.stringify(problems.slice(0, 3)))
    } finally {
      writeFileSync(ALIGNMENT_TARGET, alignmentBefore)
    }
    check('② 还原后逐字节相同', readFileSync(ALIGNMENT_TARGET).equals(alignmentBefore),
      alignmentBefore.length + ' -> ' + readFileSync(ALIGNMENT_TARGET).length + ' 字节')

    console.log(failures === 0 ? '全部通过（两组对照都成立：注入会红、还原是字节级的）' : failures + ' 项失败')
    return failures === 0 ? 0 : 1
  }

  const { failures: found, hints, files } = collect(all)
  console.log(`  扫了 git 跟踪的 ${files} 个文件（${PRIVATE_MARKERS.length} 条私人名 + ${THIRD_PARTY_MARKERS.length} 条第三方名` +
    ` + ${SHAPES.length} 条 FAIL 形状 + ${HINT_SHAPES.length} 条提示形状` +
    (source === null ? '；**专属词表没配**（要更严：设 MCART_PRIVATE_MARKERS 或写 panel/private-markers.txt）'
      : `；${all.length} 条专属词表来自 ${source}`) + '）')
  console.log('  判据分层：私人名（含注释）一律 FAIL；**第三方模组名只在代码/断言里 FAIL**，注释里只提示；' +
    'POSIX 家目录只提示（交付物是原生 Windows 插件）')
  console.log('  FAIL 形状里的占位符用户名不算泄漏（说明/夹具用）：' + PLACEHOLDER_USERS.join(' / '))

  const { problems, exempted } = spawnAlignment(trackedFiles())
  check('起 Python 子进程的地方都给了 `-X utf8`（或 PYTHONUTF8）并按 UTF-8 解（含测试文件自己）',
    problems.length === 0, problems.slice(0, 5).map((item) => `${item.file}:${item.line} ${item.what}`).join('；'))
  if (exempted > 0) console.log(`  · 上面这条里有 ${exempted} 处按 \`utf8-check: exempt\` 显式豁免（故意复刻旧写法的 A/B 夹具）`)
  // 集中封装本身也要干净：放行 `pythonEnv()` 的前提是它真的设了那两个变量。
  const envModule = readFileSync(join(REPO, 'tools', 'python_env.mjs'), 'utf8')
  check('集中封装（tools/python_env.mjs）的 pythonEnv() 真的设了 PYTHONUTF8 + PYTHONIOENCODING',
    /PYTHONUTF8/.test(envModule) && /PYTHONIOENCODING/.test(envModule) && /export function pythonEnv/.test(envModule))

  // 提示组：不阻塞发布，但单独列出来，将来想清理有清单。
  const thirdPartyHints = hints.filter((hit) => hit.what.includes('第三方'))
  const shapeHints = hints.filter((hit) => !hit.what.includes('第三方'))
  console.log(`  —— 提示（不阻塞）：注释/docstring 里的第三方模组名 ${thirdPartyHints.length} 处，` +
    `POSIX 家目录 ${shapeHints.length} 处 ——`)
  for (const hit of thirdPartyHints.slice(0, 20)) console.log('  · ' + hit.where + ' ← ' + hit.what)
  for (const hit of shapeHints.slice(0, 10)) console.log('  · ' + hit.where + ' ← ' + hit.what)

  // 扫描结果**必须折进判定**。只打印不计数，门禁就会变成"写着拒绝发布、却返回成功"
  // —— 挂在 prepublishOnly 链里等于没挂。（这条曾经真的存在：`found` 从未进 `failures`，
  // 因为它当时还是未跟踪文件，`git ls-files` 里没有它，0 命中那条路径从没被走到。）
  check('跟踪文件里没有私人名，也没有"把测试绑到某个第三方包"的代码',
    found.length === 0, found.length + ' 处命中')
  if (found.length > 0) {
    for (const hit of found.slice(0, 30)) console.log(`  FAIL ${hit.file}:${hit.line} ← ${hit.what}`)
    console.log(`${found.length} 处命中 —— 拒绝发布`)
  }
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  return failures === 0 ? 0 : 1
}

process.exit(main())
