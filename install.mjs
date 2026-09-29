#!/usr/bin/env node
/**
 * 装好这套东西：两个 skill + 两个模式。**安装逻辑只有这一份**。
 *
 *   node install.mjs                       # 装/更新（skill + 模式 + 面板包）
 *   node install.mjs --no-panel            # 不装面板包（只装 skill + 模式）
 *   node install.mjs --profile web         # 面板装进哪个 profile（默认 web）
 *   node install.mjs --panel-spec <spec>   # 面板从哪来：默认本仓库的 panel/ 目录，
 *                                          # 发布后也可以直接给 npm 包名 dsh-mc-art-panel
 *
 * 为什么逻辑在 JS 里、而不是各写一份 sh / bat：
 *   三个理由，都是踩出来的。
 *   1. **Windows**。原来的 install.sh 有两处只在 Windows 上炸：把 `C:\Users\...` 这种
 *      反斜杠路径写进 JS 字符串（`\U` 是转义，路径当场坏掉），以及 `--no-cordis-tools`
 *      那条分支里写死了 `python3`（Windows 上叫 python / py）。同一份逻辑写两遍，
 *      这种错就会各修一次、各漏一次。
 *   2. **依赖**。Node 是 DSH 自己的前提，一定有；Python 是 mc-art 引擎的前提，
 *      安装器不该额外要求它（改 MCART_HOME 原来要 python，现在是一行 replace）。
 *   3. **可测**。这份文件能在任何平台上用 `DSH_HOME=/tmp/...` 真跑一遍，
 *      `--selftest` 还能验那个 Windows 路径函数——.bat 做不到这件事。
 *
 * 两个壳：`install.sh`（POSIX）与 `install.bat`（Windows cmd）都只是找到 node 再转给它。
 *
 * 为什么美术引擎不放进这个仓库、也不做成 git submodule：
 *   `mc-art` 有自己的仓库、自己的历史和节奏，本来也独立可用（它是一台确定性引擎）。
 *   做成子模块会把它钉在某个 commit 上，而且要更新就得手动 bump；最常见的坑是
 *   `git clone` 忘了 `--recursive`，于是"装好了"但少了半个引擎。
 *   所以这里**拉它**，并且用 `git pull` 更新它——安装与更新是同一条命令。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
const IS_WINDOWS = process.platform === 'win32'
const ART_REPO = process.env.MC_ART_REPO ?? 'https://github.com/GMH13552/mc-art.git'
const PYTHON_CANDIDATES = ['python3', 'python', 'py -3']
/** 装哪个模式。只有一个：不带 tool-cordis 的那个（原因见 tools/check_presets.mjs）。 */
export const PRESETS = ['mc-studio']
/** 以前发布过、现在不该再留着的模式目录：装的时候顺手清掉。 */
export const LEGACY_PRESETS = ['mc-studio-nocordis']

export function say(line = '') {
  process.stdout.write(line + '\n')
}

/**
 * 写进 JS 单引号字符串里的路径：反斜杠必须换成正斜杠。
 *
 * 这是 Windows 上安装器最容易出的那个错：`C:\Users\GMH13\mc-art` 一旦进了
 * `const MCART_HOME = '...'`，`\U`、`\G`、`\m` 都被当成转义序列，路径静默变样，
 * 而报错要到用户点了面板才出现。Node 在 Windows 上认正斜杠，所以换成 `/` 最省事。
 */
export function toJsPath(path) {
  return String(path).replace(/\\/g, '/')
}

/** `--selftest`：只验能在这里验的东西，不碰安装。 */
function selftest() {
  let failures = 0
  const check = (name, ok, detail) => {
    if (ok) say('  OK   ' + name)
    else { failures += 1; say('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
  }
  const windowsPath = 'C:\\Users\\GMH13\\mc-art\\tools\\mcart-plugin'
  const converted = toJsPath(windowsPath)
  /** 把值放进单引号字符串字面量，再让 JS 真的求值一次——这才是 loader 读到的东西。 */
  const evaluate = (value) => new Function('return ' + "'" + value + "'")()
  check('Windows 路径写成 JS 字符串后没有反斜杠', converted.indexOf('\\') < 0, converted)
  check('Windows 路径转换结果正确', converted === 'C:/Users/GMH13/mc-art/tools/mcart-plugin', converted)
  check('POSIX 路径不受影响', toJsPath('/home/gmh/mc-art/tools/mcart-plugin') === '/home/gmh/mc-art/tools/mcart-plugin')
  check('转换后的值放进字面量求值，还是同一个路径（loader 真读到的就是它）',
    evaluate(converted) === converted, evaluate(converted))
  // 反过来说：不转换就会坏，而坏法是静默的（路径变样，但要到用户点面板才报错）。
  check('不转换的话它会被 JS 当转义吃掉（所以上面那条转换是必需的）',
    evaluate(windowsPath) !== windowsPath, JSON.stringify(evaluate(windowsPath)))
  say(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('install.mjs') &&
    process.argv.includes('--selftest')) selftest()

/** 跑一条命令，返回 {code, out}；找不到这个程序时 code 为 null 且 missing 为真。 */
export function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (done.error !== undefined && done.error.code === 'ENOENT') return { code: null, missing: true, out: '' }
  return { code: done.status, missing: false, out: String(done.stdout ?? '') + String(done.stderr ?? '') }
}

/** 复制目录：先删掉目标，避免旧文件（比如已经删掉的文件）残留。 */
function copyDir(from, to) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

function findPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const parts = candidate.split(' ')
    const probe = run(parts[0], parts.slice(1).concat(['-c', 'import sys;print(1)']))
    if (probe.code === 0 && probe.out.indexOf('1') >= 0) return candidate
  }
  return null
}

/** `--name value`；没给就给默认。 */
export function option(argv, name, fallback) {
  const at = argv.indexOf('--' + name)
  if (at < 0) return fallback
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 后面要跟一个值`)
  return value
}

export function install(argv = process.argv.slice(2)) {
  if (argv.includes('--no-cordis-tools')) {
    say('注：--no-cordis-tools 不再需要了——模式已经不带 tool-cordis（面板由装好的包提供）。')
  }
  // 三个开关除了给测试用，也是给真实用户的：装到别处（--dsh-home），
  // 用镜像拉美术引擎（--art-repo，国内直连 github 常常很慢），
  // 或者指定面板装进哪个 profile（--profile）。
  const dshRoot = option(argv, 'dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const artRepo = option(argv, 'art-repo', ART_REPO)
  const profile = option(argv, 'profile', 'web')
  const withPanel = !argv.includes('--no-panel')
  const panelSpec = option(argv, 'panel-spec', join(HERE, 'panel'))
  const skills = join(dshRoot, 'skills')
  const presetsDir = join(dshRoot, '.agent-presets')
  const wanted = PRESETS

  say(`安装到 ${dshRoot}${IS_WINDOWS ? '（Windows）' : ''}`)
  mkdirSync(skills, { recursive: true })
  mkdirSync(presetsDir, { recursive: true })

  // ── 1) mc-mod：就在本仓库里 ──────────────────────────────────────────────
  const mcMod = join(skills, 'mc-mod')
  copyDir(join(HERE, 'skills', 'mc-mod'), mcMod)
  say(`✓ skill  mc-mod     -> ${mcMod}`)

  // ── 2) mc-art：独立仓库，clone 或更新 ───────────────────────────────────
  const mcArt = join(skills, 'mc-art')
  if (existsSync(join(mcArt, '.git'))) {
    const pulled = run('git', ['-C', mcArt, 'pull', '--ff-only', '--quiet'])
    if (pulled.code === 0) say('✓ skill  mc-art     已更新（git pull --ff-only）')
    else say(`！skill  mc-art     git pull 没成功（本地有改动或没网？）：${mcArt}`)
  } else {
    const cloned = run('git', ['clone', '--quiet', artRepo, mcArt])
    if (cloned.code === 0) say(`✓ skill  mc-art     -> ${mcArt}`)
    else say(`！skill  mc-art     拉不下来：${artRepo}（装好后可手动 git clone 到 ${mcArt}）`)
  }

  // ── 3) 面板加载器：把 MCART_HOME 指到这次克隆的真实路径 ─────────────────
  // 这一步原来写在 README 里让人手动改；脚本知道路径，就不该让人改。
  const loader = join(HERE, 'tools', 'mcart-plugin', 'loader.host.js')
  const loaderHome = toJsPath(join(HERE, 'tools', 'mcart-plugin'))
  if (existsSync(loader)) {
    const before = readFileSync(loader, 'utf8')
    const pattern = /const MCART_HOME = '[^']*'/
    if (!pattern.test(before)) {
      say(`！loader  找不到 "const MCART_HOME = '...'" 这一行，没改动：${loader}`)
      say('        面板的加载器靠它找 host.js / client.js；这一行被改名了就要同步改这里。')
    } else {
      const after = before.replace(pattern, `const MCART_HOME = '${loaderHome}'`)
      if (after === before) say(`✓ loader  MCART_HOME 已经是 ${loaderHome}`)
      else {
        writeFileSync(loader, after)
        say(`✓ loader  MCART_HOME -> ${loaderHome}`)
      }
    }
  }

  // ── 4) 模式（只有一个；顺手清掉历史上发布过的变体）─────────────────────
  for (const name of LEGACY_PRESETS) {
    const stale = join(presetsDir, name)
    if (existsSync(stale)) {
      rmSync(stale, { recursive: true, force: true })
      say(`✓ preset ${name.padEnd(18)} 已删除（两个模式合成一个了；面板改由包提供）`)
    }
  }
  for (const name of wanted) {
    const source = join(HERE, 'presets', name)
    if (!existsSync(source)) { say(`！preset ${name}  仓库里没有这个目录，跳过`); continue }
    copyDir(source, join(presetsDir, name))
    say(`✓ preset ${name} -> ${join(presetsDir, name)}`)
  }

  // ── 5) 面板包：装进 profile，重启后就在（不用动态发射）───────────────────
  if (withPanel) {
    const probe = run('dsh', ['--version'])
    if (probe.missing === true) {
      say(`！面板   PATH 里没有 dsh，装不了。手动跑一次：`)
      say(`        dsh plugin --profile ${profile} add ${panelSpec}`)
    } else {
      say(`装面板进 profile ${profile}（${panelSpec}）…`)
      const added = run('dsh', ['plugin', '--profile', profile, 'add', panelSpec], { stdio: 'inherit' })
      if (added.code === 0) say(`✓ 面板   已装进 profile ${profile}（重启 DSH 后右侧栏出现「MC 资产」）`)
      else {
        say(`！面板   装失败（dsh 退出码 ${added.code}）。手动跑一次看报错：`)
        say(`        dsh plugin --profile ${profile} add ${panelSpec}`)
      }
    }
  } else {
    say('（--no-panel：没装面板包）')
  }

  // ── 5) 依赖自检：只说事实 ───────────────────────────────────────────────
  say('')
  say('依赖自检：')
  const git = run('git', ['--version'])
  if (git.code === 0) say('  ✓ ' + git.out.trim())
  else say('  ！git 没找到（拉 mc-art、装模组工程都要用）')

  const python = findPython()
  if (python !== null) {
    const parts = python.split(' ')
    const version = run(parts[0], parts.slice(1).concat(['-c', 'import sys;print(".".join(map(str,sys.version_info[:3])))']))
    say(`  ✓ ${python} ${version.out.trim()}`)
    const pillow = run(parts[0], parts.slice(1).concat(['-c', 'import PIL;print(PIL.__version__)']))
    if (pillow.code === 0 && pillow.out.trim() !== '') say(`  ✓ Pillow ${pillow.out.trim()}（mc-art 需要）`)
    else say(`  ！mc-art 需要 Pillow：${python} -m pip install pillow`)
  } else {
    say(`  ！没找到 Python（试过 ${PYTHON_CANDIDATES.join(' / ')}）——抽取器、判定工具、mc-art 都要它`)
    if (IS_WINDOWS) say('        Windows 上装完 Python 通常叫 python 或 py；装的时候勾上 "Add to PATH"。')
    else say('        装一个 Python 3，或者用你发行版的包管理器。')
  }

  const java = run('java', ['-version'])
  if (java.code === 0) {
    // `java -version` 把版本写在 stderr 里，形如 openjdk version "17.0.20.1" 2026-08-18；
    // 早先的写法把引号后面的日期也吞了进去，于是"自检"那行本身就是个坏示范。
    const quoted = /version "([^"]+)"/.exec(java.out)
    const version = quoted === null ? java.out.trim().split('\n')[0] : quoted[1]
    say(`  ✓ java ${version}（1.18.2 模组要 17；1.20.5+ 要 21）`)
  } else {
    say('  ！没找到 java（编译/运行模组要用）')
  }

  const loaderHint = IS_WINDOWS
    ? 'tools\\mcart-plugin\\loader.host.js'
    : 'tools/mcart-plugin/loader.host.js'
  const pythonHint = python === null ? (IS_WINDOWS ? 'python' : 'python3') : python
  say('')
  say('下一步：')
  say('  1. 重启 DSH：模式名单里有「MC 模组工作室」，右侧栏里应当出现「MC 资产」面板')
  say('  2. 面板没出现的话（面板是装进 profile 的包）：')
  say(`       dsh plugin --profile ${profile} add ${panelSpec}`)
  say(`     （开发面板时才用动态发射那条路：${loaderHint} 作为 code.host、`)
  say('     loader.client.js 作为 code.client，交给 cordis_define + cordis_run）')
  say('  3. 判定一次：cd fleshland/mod && ' + pythonHint + ' ../../tools/mcmod_gametest.py')
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('install.mjs') &&
    !process.argv.includes('--selftest')) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    say('用法：node install.mjs [--no-panel] [--profile <名>] [--panel-spec <spec>]' +
      ' [--dsh-home <路径>] [--art-repo <git 地址>] [--selftest]')
    process.exit(0)
  }
  process.exit(install())
}


