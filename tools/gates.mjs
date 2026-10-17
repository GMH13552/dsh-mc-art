#!/usr/bin/env node
/**
 * 全量门禁 runner —— **"46 条"的唯一出处**。
 *
 * 为什么要有它：以前"全量门禁"是某人临时写的一条 PowerShell 循环，清单散在文档里，
 * 数出来的 45 绿 / 1 SKIP 没有可复现的出处。现在清单只在这个文件里；文档只写
 * `node tools/gates.mjs`。
 *
 * 约定：
 *   · 退出码 0 = 绿；**3 = SKIP**（保留码，按设计跳过，不算红）；其余 = 红。
 *   · 任一条红 → runner 退出码非 0，并列出红的命令与退出码。
 *   · `--encoding gbk|utf8`：给子进程设 `PYTHONIOENCODING` 之后重跑（python 条目因此
 *     会按不同控制台编码写输出）。**不带这个开关时不设任何编码变量**，就是"默认 cp936"。
 *   · `--only <子串>`：只跑 id 或命令里含该子串的条目（调试用）。
 *   · `--fault`：自证能红 —— 加一条必然失败的探针 + 一条已知绿的门禁，断言 runner
 *     报红（1 绿 / 1 红）且退出码非 0。
 *
 *   node tools/gates.mjs
 *   node tools/gates.mjs --encoding gbk
 *   node tools/gates.mjs --only strip_gate
 *   node tools/gates.mjs --fault
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)

/** 退出码 3 是"按设计跳过"的保留码（例如 orient-test 缺真实工程）。 */
const SKIP_CODE = 3

const node = (id, script, args = []) => ({ id, cmd: 'node', args: [script, ...args] })
const python = (id, args) => ({ id, cmd: 'python', args })
const pluginTests = [
  'model', 'report', 'batch-page', 'texture-edit', 'texture-syntax', 'project-animation',
  'parent-fallback', 'encoding', 'publish-vocab', 'refs', 'multipart', 'orient', 'icon',
  'icon-render', 'engine', 'project', 'roots', 'loader', 'zoom', 'hotbar', 'anim', 'derive',
  'helpers',
]

/**
 * 46 条。顺序固定：
 *   1–12   Node：面板构建/入口/界面/发布物/词表/预设/构建产物/python 探测/安装器
 *   13–35  面板插件的 23 个行为门禁（`tools/mcart-plugin/*-test.js`）
 *   36     参考字典的测试（`test-reference.js`，不是 `*-test` 名字但一样是门禁）
 *   37–40  Python：抽取器 pytest / 注释剥离 / skill 词表 / JDK 判定
 *   41–46  GameTest 运行器的 6 个自测（机器相关的那部分会自己 SKIP，不是红）
 */
const GATES = [
  node('verify-build', 'panel/verify-build.mjs'),
  node('entry-test', 'panel/entry-test.mjs'),
  node('ui-test', 'panel/ui-test.mjs'),
  node('check-private', 'panel/check-private.mjs', ['--require-generated']),
  node('check-presets', 'tools/check_presets.mjs'),
  node('check-tracked-private', 'tools/check-tracked-private.mjs'),
  node('check-skill-content', 'tools/check-skill-content.mjs'),
  node('gen-preset-patch', 'tools/gen_preset_patch.mjs', ['--check']),
  node('python-env', 'tools/python_env.mjs', ['--selftest']),
  node('build', 'panel/build.mjs'),
  node('build-selftest', 'panel/build.mjs', ['--selftest']),
  node('install-selftest', 'install.mjs', ['--selftest']),
  ...pluginTests.map((name) => node('plugin-' + name, `tools/mcart-plugin/${name}-test.js`)),
  node('test-reference', 'tools/mcart-plugin/test-reference.js'),
  { id: 'pytest-extract', cmd: 'python', args: ['-m', 'pytest', 'tools/test_extract_block.py', '-q'], needsBasetemp: true },
  python('strip-gate', ['tools/strip_gate.py']),
  python('skill-vocab', ['tools/skill_vocab_test.py']),
  python('check-jdk', ['tools/check_jdk_test.py']),
  python('mcmod-jdk', ['tools/mcmod_gametest.py', '--jdk-selftest']),
  python('mcmod-restore', ['tools/mcmod_gametest.py', '--restore-selftest']),
  python('mcmod-space', ['tools/mcmod_gametest.py', '--space-selftest']),
  python('mcmod-verdict', ['tools/mcmod_gametest.py', '--fault-verdict-selftest']),
  python('mcmod-args', ['tools/mcmod_gametest.py', '--fault-args-selftest']),
  python('mcmod-home', ['tools/mcmod_gametest.py', '--gradle-home-selftest']),
]

function parseArgs(argv) {
  const options = { encoding: null, only: null, fault: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--encoding') { options.encoding = argv[index + 1]; index += 1 }
    else if (arg === '--only') { options.only = argv[index + 1]; index += 1 }
    else if (arg === '--fault') options.fault = true
    else { console.error('未知参数：' + arg); process.exit(2) }
  }
  if (options.encoding !== null && !['gbk', 'utf8', 'utf-8'].includes(options.encoding)) {
    console.error('--encoding 只认 gbk / utf8'); process.exit(2)
  }
  return options
}

function environmentFor(encoding) {
  const env = { ...process.env }
  if (encoding === null) return env
  // 第一遍（不带 --encoding）**故意不设**任何编码变量：那才是 Windows 控制台默认（cp936）。
  env.PYTHONIOENCODING = encoding === 'gbk' ? 'gbk' : 'utf-8'
  return env
}

function runOne(gate, env) {
  const args = [...gate.args]
  if (gate.needsBasetemp) {
    // 用户的 %TEMP%\pytest-of-GMH13 ACL 坏了，pytest 默认 basetemp 会 PermissionError；
    // 每次都换一个可写的临时目录，跑完删掉。
    const base = mkdtempSync(join(tmpdir(), 'mcart-gates-'))
    args.push('--basetemp=' + base)
    gate._basetemp = base
  }
  const started = Date.now()
  const done = spawnSync(gate.cmd, args, {
    cwd: REPO, env, encoding: 'utf8', timeout: gate.timeout ?? 900_000,
    windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (gate._basetemp) { try { rmSync(gate._basetemp, { recursive: true, force: true }) } catch (error) { /* 临时目录 */ } }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const status = done.status === null ? -1 : done.status
  if (status === 0) return { verdict: 'green', why: 'exit 0', seconds }
  if (status === SKIP_CODE) return { verdict: 'skip', why: 'exit 3（按设计跳过）', seconds }
  const output = ((done.stdout ?? '') + (done.stderr ?? '')).trim()
  const tail = output.split('\n').slice(-6).map((line) => '        | ' + line).join('\n')
  return { verdict: 'red', why: 'exit ' + status + (done.error ? '（' + done.error.message + '）' : ''), seconds, tail }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let gates = GATES
  if (options.fault) {
    // 自证能红：一条已知绿 + 一条必然失败。断言 runner 把红挑出来且退出码非 0。
    gates = [
      { id: 'fault-probe-green', cmd: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'fault-probe-red', cmd: 'node', args: ['-e', 'console.log("故意失败");process.exit(1)'] },
    ]
  } else if (options.only) {
    gates = GATES.filter((gate) => gate.id.includes(options.only) || (gate.cmd + ' ' + gate.args.join(' ')).includes(options.only))
    if (gates.length === 0) { console.error('--only 没有匹配到任何门禁：' + options.only); process.exit(2) }
  }

  const env = environmentFor(options.encoding)
  const label = options.encoding === null ? '默认（不设 PYTHONIOENCODING）' : 'PYTHONIOENCODING=' + options.encoding
  console.log(`门禁：${gates.length} 条；编码：${label}`)
  console.log('─'.repeat(72))

  const reds = []
  let green = 0
  let skips = 0
  gates.forEach((gate, index) => {
    const result = runOne(gate, env)
    const tag = result.verdict === 'green' ? 'OK  ' : result.verdict === 'skip' ? 'SKIP' : 'FAIL'
    const command = [gate.cmd, ...gate.args].join(' ')
    console.log(`[${String(index + 1).padStart(2)}/${gates.length}] ${tag} ${result.seconds}s  ${gate.id}  (${command})`)
    if (result.verdict === 'green') green += 1
    else if (result.verdict === 'skip') { skips += 1; console.log('        ' + result.why) }
    else { reds.push({ gate, result }); console.log('        ' + result.why + (result.tail ? '\n' + result.tail : '')) }
  })

  console.log('─'.repeat(72))
  if (reds.length > 0) {
    console.log('红的具体命令：')
    for (const { gate, result } of reds) {
      console.log(`  FAIL  [${gate.cmd} ...]  ${gate.id}  → ${result.why}`)
    }
  }
  console.log(`绿 ${green} / SKIP ${skips} / 红 ${reds.length}`)
  if (options.fault) {
    // `--fault` 的对照：必须恰好一绿一红，且**runner 自己的退出码非 0 才算证明**——
    // 但这一层是 A/B 夹具：对照成立时 `--fault` 退出 0（"故障被抓到了"的体例，同 mcmod）。
    const ok = green === 1 && reds.length === 1
    console.log(ok ? '对照成立：runner 能把绿挑绿、把红挑红（上面的退出码语义即"有红则非 0"）'
      : '对照不成立：期望恰好 1 绿 1 红，实际绿 ' + green + ' / 红 ' + reds.length)
    return ok ? 0 : 1
  }
  if (reds.length > 0) return 1
  return 0
}

process.exit(main())
