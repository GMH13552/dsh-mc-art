#!/usr/bin/env node
/**
 * 发布前门禁：**要发出去的东西里，不许有作者的机器痕迹或私人项目名。**
 *
 * 为什么要有：0.1.2–0.1.8 把开发时的注释、示例路径和随包 skill 里的私人项目名一起发了出去
 * —— 因为 `lib/` 是由源码逐字生成的，而 `preset/` 是另一个仓库的快照，**发布前没人扫一遍**。
 * npm 的版本不能改，所以这条只能靠"发之前拦住"。
 *
 *   node check-private.mjs                        # 扫 lib/ preset/ python/ 与几个根文件
 *   node check-private.mjs --fault                # 塞一个带标记的临时文件，要求它红
 *   node check-private.mjs --require-generated    # **发布**用：缺生成物就非零退出
 *
 * 为什么有 `--require-generated`：`panel/preset/` 是 gitignore 的**生成物**（`panel/vendor.mjs`
 * 或 `build.mjs` 生成），全新 clone 上不存在。以前 `walk()` 直接 `statSync` 一个不存在的根，
 * 于是整个门禁变成一段 ENOENT 未捕获异常 —— 既不是"通过"也不是"发现私有内容"。
 * 现在的规矩：
 *   * 缺某个根 → 打印一行明确的"这一层**没扫**"，继续扫其它根（结论里也写清覆盖率缺口）；
 *   * 发布流程用 `--require-generated`：缺生成物 / 缺随包的 mc-art skill 就**非零退出**，
 *     绝不让"没扫到"伪装成"没问题"。
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExampleAsset, isJunk, isSkipped } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// `python/` 也要扫：随包发的引擎脚本是另一个仓库里来的，里面同样可能残留
// 作者的项目名（0.1.15 就是这么漏过一次：一个 docstring 里的示例方块名）。
const ROOTS = ['lib', 'preset', 'python']
const FILES = ['cordis.patch.yml', 'README.md', 'build.mjs', 'package.json']
const FAULT = process.argv.includes('--fault')
const REQUIRE_GENERATED = process.argv.includes('--require-generated')
const PLANT = join(HERE, 'lib', '.private-fault.txt')
const MARKER_FILE = join(HERE, 'private-markers.txt')

/**
 * `--require-generated` 时要逐条 stat 的随包内容。缺任何一条都是"发出去的包是残的"，
 * 不能只靠"没扫到私有痕迹"就放行 —— 少一个 skill 的包同样扫不出私有痕迹。
 */
const REQUIRED_GENERATED = [
  ['lib/index.js', '宿主入口（生成物）'],
  ['lib/client.js', '客户端入口（生成物）'],
  ['preset/mc-studio/preset.yml', '随包的「MC 模组工作室」模式'],
  ['preset/mc-studio/skills/mc-mod/SKILL.md', '随包的 mc-mod skill'],
  ['preset/mc-studio/skills/mc-art/SKILL.md', '随包的 mc-art skill（缺它 = 发出去的包少一个 skill）'],
  ['python/mcart_scan_refs.py', '随包的扫描器'],
  ['python/mcart_extract_block.py', '随包的提取器'],
]

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

/** `--fault` 时被我们新建出来的根：结束后删掉，别给仓库留空目录。 */
const createdRoots = []
if (FAULT) {
  // 故障注入用第 3 类：一个只可能来自本机的路径，所以不靠词表也能证伪。
  try {
    mkdirSync(join(HERE, 'lib'), { recursive: true })
    writeFileSync(PLANT, '参考 /home/someone-else/projects/demo 与 C:\\Users\\someone\\demo 两处\n')
  } catch (error) { /* lib 建不出来就算了，下面会报 */ }
  // 每个要扫的根都塞一份：少扫一个目录时，--fault 必须能说话。
  for (const root of ROOTS) {
    const dir = join(HERE, root)
    try {
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); createdRoots.push(dir) }
      writeFileSync(join(dir, '.private-fault.txt'), '参考 /home/someone-else/projects/demo\n')
    } catch (error) { /* 根建不出来就算了，下面会报 */ }
  }
  // 许可证那一条也要能红：往"会被发布"的位置塞一个假 png，形状就是源树里的
  // `examples/example_family/refs/*`（实测那 4 张是 Mojang 原版贴图）。
  try {
    const fakeRefs = join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art',
      'examples', 'example_family', 'refs')
    const missingDirs = []
    let at = fakeRefs
    while (!existsSync(at) && at !== dirname(at)) { missingDirs.push(at); at = dirname(at) }
    for (const dir of missingDirs.reverse()) { mkdirSync(dir, { recursive: true }); createdRoots.push(dir) }
    writeFileSync(join(fakeRefs, '.private-fault.png'), '假的 Mojang 素材（只用来证明这条门禁能红）\n')
  } catch (error) { /* 建不出来就算了，下面会报 */ }
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
  // "什么会发出去"只有一份判据：`panel/build.mjs` 的 isJunk / isSkipped / isExampleAsset。
  // 这里**导入**它们，而不是再抄一份集合 —— 抄一份就等于允许两边漂移。
  // （`.pytest-tmp/` 那次就是这么被抓到的：它里面是带作者机器路径的中间产物，
  //   而 `examples/**/refs` 更严重：那是 Mojang 原版素材，随 MIT 的包再分发是许可问题。）
  /** 发版物里**绝对不许出现**的东西（就算过滤器将来回退，这里也要拦一次）。 */
  const FORBIDDEN = [
    { label: 'Mojang 原版素材（examples/**/refs、examples/**/textures）—— 再分发是许可问题',
      test: (rel) => isExampleAsset(rel) },
    // 只在 preset/ 里判：`package.json:files` 对 `python/**` 明写了
    // `!python/**/__pycache__` / `!python/**/*.pyc`（npm 打包会排掉），而 `preset/**` 没有
    // 任何排除 —— `.pytest-tmp/` 就是这么发出去的。判据要对准"真的会发出去的东西"。
    { label: 'preset/ 里的字节码缓存或 pytest 临时目录（npm 不会替你排掉 preset/**）',
      test: (rel) => rel.startsWith('preset/') &&
        (/(^|\/)__pycache__\//.test(rel) || /\.py[co]$/.test(rel) ||
         /(^|\/)(\.pytest-tmp|\.pytest_cache)\//.test(rel)) },
  ]
  /** `python/` 下的字节码缓存：npm 排得掉，所以只提示（跑过引擎脚本就会长出来）。 */
  const pythonCache = (rel) => rel.startsWith('python/') &&
    (/(^|\/)__pycache__\//.test(rel) || /\.py[co]$/.test(rel))

  /** 没扫到的层（不存在的根/文件）。绝不静默：结论里要写清缺口。 */
  const missing = []
  /** 包里出现了"绝不能发"的东西（过滤器回退 / 手工塞进来 / 旧生成物残留）。 */
  const forbidden = []
  /** 不会随包、但值得说一句的（python/ 下的缓存）。 */
  const notices = []
  const walk = (path, label) => {
    if (!existsSync(path)) { missing.push(label); return }
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        // `.git` / `node_modules` 整棵跳过（不进包，也没必要走一遍）；别的目录都走到文件级，
        // 这样 FORBIDDEN 才能对"已经在包里的东西"说话。
        if (entry === '.git' || entry === 'node_modules') continue
        walk(join(path, entry), label + '/' + entry)
      }
      return
    }
    for (const rule of FORBIDDEN) {
      if (rule.test(label)) { forbidden.push(label + ' ← ' + rule.label); return }
    }
    if (pythonCache(label)) notices.push(label)
    if (isJunk(label) || isSkipped(label)) return
    scan(label, readFileSync(path, 'utf8'))
  }
  for (const root of ROOTS) walk(join(HERE, root), root)
  for (const file of FILES) walk(join(HERE, file), file)

  for (const label of missing) {
    console.log('  SKIP ' + label + ' 不存在 —— 这一层**没扫**' +
      (label === 'preset'
        ? '（它是生成物：先跑 `node panel/vendor.mjs` 或 `node panel/build.mjs`）'
        : ''))
  }
  if (forbidden.length === 0) {
    console.log('  OK   随包物里没有"绝不能发"的东西（Mojang 素材 / preset 里的字节码缓存 / pytest 临时目录）')
  } else {
    for (const hit of forbidden.slice(0, 20)) console.log('  FAIL 不该随包的东西在包里：' + hit)
    console.log(`${forbidden.length} 处不该随包的内容 —— 拒绝发布（先跑 \`node panel/build.mjs\` 重新生成）`)
    process.exitCode = 1
  }
  if (notices.length > 0) {
    console.log(`  · ${notices.length} 个 python/ 下的字节码缓存（npm 的 files 排得掉，且 ` +
      '`node panel/build.mjs` 会清掉）—— 例如 ' + notices[0])
  }
  const coverage = PATTERNS.length + markers.length
  if (hits.length === 0) {
    const scanned = ROOTS.filter((root) => !missing.includes(root))
    console.log(`  OK   要发的 ${scanned.join('/ ')} 与根文件里没有私有痕迹（` +
      `${PATTERNS.length} 条通用规则` +
      (source === null
        ? '；**专属词表没配**，只跑了通用规则（要更严：设 MCART_PRIVATE_MARKERS 或写 panel/private-markers.txt）'
        : `；${markers.length} 条专属词表来自 ${source}`) + '）')
    if (missing.length === 0 && forbidden.length === 0 && !REQUIRE_GENERATED) console.log('全部通过')
    else if (missing.length > 0) console.log(`注意：有 ${missing.length} 层没扫到（见上面的 SKIP）—— 这份"没有私有痕迹"**不覆盖**它们。` +
      '发布请用 `--require-generated`（缺生成物直接失败）。')
  } else {
    for (const hit of hits.slice(0, 20)) console.log('  FAIL ' + hit + `（命中规则：${coverage} 条在跑）`)
    console.log(`${hits.length} 处私有内容 —— 拒绝发布`)
    process.exitCode = 1
  }

  // 发布路径的完整性门禁：缺生成物 / 缺随包的 skill —— 那是"发出去的包是残的"，
  // 而"扫不出私有痕迹"完全不能排除这种情况。
  if (REQUIRE_GENERATED) {
    const absent = REQUIRED_GENERATED.filter(([relative]) => !existsSync(join(HERE, relative)))
    if (absent.length === 0) {
      console.log(`  OK   --require-generated：随包的 ${REQUIRED_GENERATED.length} 份内容都在` +
        '（lib/ + preset/ + python/ + mc-mod skill + mc-art skill）')
      if (hits.length === 0 && forbidden.length === 0) console.log('全部通过')
    } else {
      for (const [relative, why] of absent) console.log(`  FAIL 随包内容缺失：${relative}（${why}）`)
      console.log(`${absent.length} 份该随包的内容不在 —— 拒绝发布` +
        '（跑 `node panel/build.mjs --release` 生成；它会在缺 mc-art 克隆时硬失败）')
      process.exitCode = 1
    }
  }
} finally {
  if (FAULT) {
    for (const root of ROOTS) rmSync(join(HERE, root, '.private-fault.txt'), { force: true })
    for (const dir of createdRoots) rmSync(dir, { recursive: true, force: true })
  }
}
