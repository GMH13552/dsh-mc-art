#!/usr/bin/env node
/**
 * **唯一**的 Python 探测策略（BRIEF §2.3）。仓库里每一处要跑 Python 的 JS 都走这里，
 * 不许再各自 `spawnSync('python3', …)`。
 *
 * 判据只有一条，而且是**行为**判据，不是存在性判据：
 *
 *     真的跑一次 `-c "print(1)"`，要求 **退出码 0** *且* **stdout trim 后恰好是 `1`**。
 *
 * 为什么不能只看"命令在不在"或"不是 ENOENT"：Windows 上 `%LOCALAPPDATA%\Microsoft\
 * WindowsApps\python3.exe` 常常是 **0 字节的 Store 存根**——命令"存在"，真跑起来退出码
 * 9009、没有任何输出。本仓库的 `panel/build.mjs` 因此直接在 `node panel/verify-build.mjs`
 * 第一行抛 `python3 …strip_comments.py 失败：`（stderr 还是空的，所以那句话什么都没解释）。
 * 更坏的一种存根是"退出码 0、零输出"：只看退出码的实现会把它当成成功，于是剥离器返回空串，
 * 产物**静默**变成空的。所以 stdout 也必须看。
 *
 * 同理，`py -3` 在这台机器上指向一个已被删除的解释器，退出码 101：
 * "启动器命令存在"不等于"它能启动任何东西"。
 *
 * 候选顺序（先探到先用，探中即缓存）：
 *
 *   1. 显式覆盖：环境变量 `MC_ART_PYTHON` / `MCART_PYTHON`，或 CLI `--python <path>`
 *      —— 显式路径排第一，但它自己坏了也**不**让整条链失败（自愈：继续往下试，
 *      把那次失败照样记进 `rejected`，并在消息里说出来）。
 *   2. **DSH 桌面端自带的 Python**（`<resources>/runtime/primary-runtime/dependencies/
 *      python/python.exe`）。它不依赖用户 PATH，是"别人拿到就能用"最靠谱的一份；
 *      位置按桌面端自己的规矩推（环境变量、argv、process.execPath、DSH_HOME、
 *      Windows 常规安装位）。
 *   3. PATH 上的 `python3` → `python` → `py -3` → `py`。
 *
 * 用法：
 *
 *   node tools/python_env.mjs                          # 探一次，打印结果（探不到则非零退出）
 *   node tools/python_env.mjs --json                   # 同上，机器可读
 *   node tools/python_env.mjs <script.py> [args…]      # 用探到的解释器跑脚本，透传退出码
 *   node tools/python_env.mjs --selftest               # 自测（伪造 Store 存根 / 坏 py 启动器）
 *   node tools/python_env.mjs --selftest --fault       # A/B：证明"老判据"真的会选错
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = dirname(HERE)

/** 探测用的命令行。改它等于改判据，所以只有这一处。 */
export const PROBE_ARGS = ['-c', 'print(1)']
export const PROBE_EXPECTED = '1'

/**
 * 跑 Python 时的编码环境（Windows 上必须显式给）。
 *
 * Windows 的 Python 默认按**控制台代码页**（本机 cp936/GBK）编码 stdout，而宿主/客户端
 * 源码里有 `⚙` 这类字符 —— `strip_comments.py` 直接 `sys.stdout.write` 就
 * `UnicodeEncodeError: 'gbk' codec can't encode character '\u2699'`，退出码 1，
 * 而 build.mjs 拿到的 stderr 是一段 Python traceback。生成物本身是 UTF-8，
 * 所以把解释器的 IO 编码也钉成 UTF-8。
 */
export const PYTHON_UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }

/** `process.env` + 上面那两个变量。 */
export function pythonEnv(env = process.env) {
  return Object.assign({}, env, PYTHON_UTF8_ENV)
}

/** PATH 上的候选，顺序就是 §2.3 的顺序。 */
export const PATH_CANDIDATES = [
  { spec: 'python3', bin: 'python3', prefix: [] },
  { spec: 'python', bin: 'python', prefix: [] },
  { spec: 'py -3', bin: 'py', prefix: ['-3'] },
  { spec: 'py', bin: 'py', prefix: [] },
]

/** 显式覆盖用的环境变量名（顺序即优先级）。 */
export const EXPLICIT_ENV = ['MC_ART_PYTHON', 'MCART_PYTHON']

const firstLine = (text) => String(text).split('\n')[0].trim().slice(0, 160)

/**
 * 把一行"命令"解析成候选。
 *
 * 带空格的绝对路径（`C:\Program Files\Python\python.exe`）必须整体当成一个可执行文件，
 * 不能按空格拆 —— 按空格拆正是 Windows 上"路径含空格就炸"的经典来源。所以规则是：
 * **整串确实是一个存在的文件** → 一个候选；否则按空白拆成 bin + prefix（为了 `py -3`）。
 */
export function candidateOf(text, source = 'explicit') {
  const raw = String(text).trim()
  const parts = raw.split(/\s+/).filter((part) => part !== '')
  if (raw !== '' && parts.length > 1 && existsSync(raw)) {
    return { spec: raw, bin: raw, prefix: [], source }
  }
  return { spec: raw, bin: parts[0] ?? '', prefix: parts.slice(1), source }
}

/**
 * 真正跑一次。返回五件事：**退出码、stdout、stderr、是不是"没这个命令"、人话原因**。
 * `ok` 就是 §2.3 的判据，别的地方不许再自己写一遍。
 */
export function probe(candidate, options = {}) {
  const spawn = options.spawn ?? spawnSync
  const env = pythonEnv(options.env ?? process.env)
  const args = candidate.prefix.concat(PROBE_ARGS)
  const done = spawn(candidate.bin, args, {
    encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 20000, env,
  })
  const stdout = String(done.stdout ?? '')
  const stderr = String(done.stderr ?? '')
  const code = done.error === undefined ? undefined : done.error.code
  const missing = code === 'ENOENT' || code === 'EACCES'
  const status = done.status === undefined ? null : done.status
  const ok = !missing && status === 0 && stdout.trim() === PROBE_EXPECTED
  let reason
  if (missing) reason = '找不到这个命令（' + code + '）'
  else if (status === null) reason = '没跑起来' + (done.error === undefined ? '' : '：' + firstLine(done.error.message))
  else if (status !== 0) reason = '退出码 ' + status + (stderr.trim() === '' ? '（没有输出）' : '：' + firstLine(stderr))
  else reason = '退出码 0，但输出不是 ' + JSON.stringify(PROBE_EXPECTED) + '：' + JSON.stringify(stdout.slice(0, 40))
  return {
    ok, spec: candidate.spec, bin: candidate.bin, prefix: candidate.prefix, source: candidate.source,
    status, stdout, stderr, missing, reason, error: done.error,
  }
}

/** 从某个可执行文件往上取 n 层目录（用来找桌面端的 resources/runtime）。 */
function ancestorsOf(file, levels) {
  const out = []
  let dir = dirname(String(file))
  for (let i = 0; i < levels && dir !== '' && dir !== dirname(dir); i++) {
    out.push(dir)
    dir = dirname(dir)
  }
  return out
}

/**
 * DSH 桌面端把 Python 放在哪 —— 按桌面端自己用的那几个规矩推，不写死某个用户的路径。
 * 桌面端给子进程前置的 PATH 里**没有** python，所以这份必须靠推导，不能靠 PATH。
 */
export function runtimeDirs(env = process.env) {
  const out = []
  const push = (value, speculative = false) => {
    if (typeof value !== 'string' || value === '') return
    const trimmed = value.replace(/[\\/]+$/, '')
    if (trimmed === '' || out.indexOf(trimmed) >= 0) return
    // speculative = "推出来的、可能是别的东西的位置"（execPath 往上数、常规安装位）。
    // 这种目录先看一眼在不在，不在就不列 —— 否则在普通机器上会白探十几个不存在的路径，
    // 把真实的候选和拒绝理由淹掉。判据本身仍然是行为判据：列出来的每一条都真跑。
    if (speculative && !existsSync(trimmed)) return
    out.push(trimmed)
  }
  push(env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR)
  push(env.DSH_PRIMARY_RUNTIME_DIR)
  for (const value of process.argv) {
    if (typeof value === 'string' && /(^|[\\/])runtime[\\/]primary-runtime$/.test(value)) push(value)
  }
  // 宿主进程就是 Electron（ELECTRON_RUN_AS_NODE）时，execPath 在 <resources>/… 底下。
  for (const dir of ancestorsOf(process.execPath, 3)) {
    push(join(dir, 'resources', 'runtime', 'primary-runtime'), true)
  }
  const home = env.USERPROFILE || env.HOME
  const dshHome = env.DSH_HOME || (home === undefined || home === '' ? '' : join(home, '.dsh'))
  if (dshHome !== '') {
    push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime'), true)
    push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies'), true)
  }
  // Windows 常规安装位（desktop 安装器把运行时放在这里）。
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'), true)
  if (env.ProgramFiles) push(join(env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime'), true)
  return out
}

/** 桌面端自带解释器的候选（Windows 的 python.exe 与 POSIX 的 bin/python3 两种布局都试）。 */
export function bundledCandidates(env = process.env, extraDirs = []) {
  const out = []
  for (const dir of runtimeDirs(env).concat(extraDirs)) {
    out.push({ spec: join(dir, 'dependencies', 'python', 'python.exe'), bin: join(dir, 'dependencies', 'python', 'python.exe'), prefix: [], source: 'bundled' })
    out.push({ spec: join(dir, 'python', 'python.exe'), bin: join(dir, 'python', 'python.exe'), prefix: [], source: 'bundled' })
    out.push({ spec: join(dir, 'dependencies', 'python', 'bin', 'python3'), bin: join(dir, 'dependencies', 'python', 'bin', 'python3'), prefix: [], source: 'bundled' })
    out.push({ spec: join(dir, 'python', 'bin', 'python3'), bin: join(dir, 'python', 'bin', 'python3'), prefix: [], source: 'bundled' })
  }
  return out
}

/** 完整候选链：显式 → 桌面端自带 → PATH。去重（按可执行文件 + 前缀）。 */
export function candidateList(env = process.env, extraDirs = []) {
  const out = []
  const seen = new Set()
  const push = (candidate) => {
    if (candidate === null || candidate === undefined || candidate.bin === '') return
    const key = candidate.bin + ' ' + candidate.prefix.join(' ')
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }
  for (const name of EXPLICIT_ENV) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') push(candidateOf(value, name))
  }
  for (const candidate of bundledCandidates(env, extraDirs)) push(candidate)
  for (const candidate of PATH_CANDIDATES) push({ ...candidate, source: 'PATH' })
  return out
}

/**
 * 探一次，返回第一个真的能应答的候选。没探到返回 `found: false` + 每一条为什么不行。
 * `rejected` 是给人看的证据：哪条、退出码多少、说了什么。
 */
export function findPython(options = {}) {
  const env = options.env ?? process.env
  const list = options.candidates ?? candidateList(env, options.extraDirs ?? [])
  const rejected = []
  for (const candidate of list) {
    const result = probe(candidate, options)
    if (result.ok) {
      return {
        found: true, candidate, spec: candidate.spec, bin: candidate.bin, prefix: candidate.prefix,
        source: candidate.source, rejected, probe: result,
      }
    }
    rejected.push(result)
  }
  return { found: false, candidate: null, spec: null, bin: null, prefix: [], source: null, rejected, probe: null }
}

/** 命中后缓存（探测要起进程，不该每个文件都探一次）。 */
let cache = null
export function findPythonCached(options = {}) {
  if (cache === null) cache = findPython(options)
  return cache
}
export function resetPythonCache() { cache = null }

/** 人话：探不到时该说什么（把每一条试过的和它的退出码都列出来）。 */
export function noPythonMessage(result) {
  const lines = ['找不到可用的 Python —— 下面每一条都真跑过 `-c "print(1)"`，没有一条同时满足「退出码 0」和「输出 1」：']
  for (const item of result.rejected) lines.push('  · ' + item.spec + '（' + item.source + '）→ ' + item.reason)
  lines.push('装一个 Python 3，或用 MC_ART_PYTHON 指一个真的能跑的解释器（不要指 Windows Store 的 python3 存根）。')
  return lines.join('\n')
}

/**
 * 用探到的解释器跑一次，返回 `{found, done}`（`done` 就是 spawnSync 的结果）。
 * 编码/环境在这里统一给，调用方不用各自记得设 PYTHONUTF8。探不到就抛（消息里带完整证据）。
 */
export function spawnPython(args, options = {}) {
  const found = options.cached === false ? findPython(options) : findPythonCached(options)
  if (!found.found) throw new Error(noPythonMessage(found))
  const spawn = options.spawn ?? spawnSync
  const done = spawn(found.bin, found.prefix.concat(args), {
    encoding: 'utf8', windowsHide: true,
    env: pythonEnv(options.env ?? process.env),
    ...(options.spawnOptions ?? {}),
  })
  return { found, done }
}

/** 同上，只要 spawnSync 的结果。 */
export function runPython(args, options = {}) {
  return spawnPython(args, options).done
}

/** 读取解释器版本（`install.mjs` 的自检要报准，不猜）。 */
export function pythonVersion(found, options = {}) {
  const spawn = options.spawn ?? spawnSync
  const done = spawn(found.bin, found.prefix.concat(['-c', 'import sys;print(".".join(map(str,sys.version_info[:3])))']),
    { encoding: 'utf8', windowsHide: true, env: pythonEnv(options.env ?? process.env), timeout: options.timeout ?? 20000 })
  return done.status === 0 ? String(done.stdout).trim() : ''
}

// ── 自测 ────────────────────────────────────────────────────────────────────
//
// 判据必须能红。这里伪造两类**真实见过**的机器状态，要求探测拒绝它们：
//
//   * `python3` = 0 字节 Store 存根：退出码 9009、无输出（本机就是）；
//   * `py -3` 指向已删除的解释器：退出码 101、stderr 一句 "Unable to create process"。
//
// 而 `--fault` 跑的是**老实现**（build.mjs 原来那段），要求它在这两组答复下选错 ——
// 这样"新判据有用"才是被证明的，不是被声称的。

/** 按 bin+prefix 分发的假 spawn（探测调用形如 bin + prefix + ['-c','print(1)']）。 */
function scriptedSpawn(table, calls = []) {
  const spawn = (bin, args) => {
    const prefix = args.slice(0, Math.max(0, args.length - PROBE_ARGS.length))
    const key = [bin].concat(prefix).join(' ')
    calls.push(key)
    const reply = table[key]
    if (reply === undefined) {
      const error = new Error('spawnSync ' + bin + ' ENOENT')
      error.code = 'ENOENT'
      return { error, status: null, stdout: '', stderr: '', signal: null }
    }
    return { status: reply.status === undefined ? null : reply.status, stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '', error: reply.error, signal: null }
  }
  return { spawn, calls }
}

/** 老实现（build.mjs:67-73 的语义，原样复刻，只为了让 --fault 能拿它做对照）。 */
function legacyStrip(spawn, file = 'strip_comments.py') {
  for (const python of ['python3', 'python']) {
    // utf8-check: exempt —— 这是"老实现"的复刻，只给 `--fault` 当 A/B 对照用：
    // `spawn` 是注入进来的**假** spawn（不起真子进程），而且它复刻的正是那段有病的旧代码。
    const done = spawn(python, [file], { encoding: 'utf8' })
    if (done.error !== undefined && done.error.code === 'ENOENT') continue
    if (done.status !== 0) throw new Error(python + ' ' + file + ' 失败：' + String(done.stderr ?? ''))
    return done.stdout
  }
  throw new Error('没有 python3 / python')
}

const STORE_STUB = { status: 9009, stdout: '' }
const BROKEN_PY = { status: 101, stdout: '', stderr: 'Unable to create process using C:\\gone\\python.exe' }
const GOOD = { status: 0, stdout: '1\n' }

function selftest(fault) {
  let failures = 0
  const check = (name, ok, detail) => {
    if (ok) console.log('  OK   ' + name)
    else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
  }

  if (fault) {
    console.log('--- A/B：老实现（build.mjs 原来那段）在同样答复下会不会选错')
    const onlyPath = PATH_CANDIDATES.slice(0, 2)   // 老实现只有 python3 / python

    // ① Store 存根（退出码 9009）：老实现不继续找 python，直接抛。
    {
      const { spawn } = scriptedSpawn({ python3: STORE_STUB, python: GOOD })
      let threw = null
      try { legacyStrip(spawn) } catch (error) { threw = error }
      check('老实现撞上 Store 存根（9009）时直接抛、不回退到 python', threw !== null,
        threw === null ? '居然没抛（那它返回了 ' + JSON.stringify(legacyStrip(spawn)) + '）' : firstLine(threw.message))
      const { spawn: goodSpawn } = scriptedSpawn({ python3: STORE_STUB, python: GOOD })
      const found = findPython({ spawn: goodSpawn, candidates: onlyPath })
      check('同一组答复下新判据选中 python（这就是差别）', found.found && found.spec === 'python',
        JSON.stringify(found.spec))
    }

    // ② 退出码 0、零输出的伪存根：老实现当成成功并返回空串（产物静默变空）。
    {
      const { spawn } = scriptedSpawn({ python3: { status: 0, stdout: '' }, python: GOOD })
      const legacy = legacyStrip(spawn)
      check('老实现把「退出码 0、零输出」当成功，返回空串（静默产出坏产物）', legacy === '',
        JSON.stringify(legacy))
      const { spawn: goodSpawn } = scriptedSpawn({ python3: { status: 0, stdout: '' }, python: GOOD })
      const found = findPython({ spawn: goodSpawn, candidates: onlyPath })
      check('新判据拒绝它并回退到 python', found.found && found.spec === 'python' &&
        found.rejected.length === 1 && /输出不是/.test(found.rejected[0].reason),
        JSON.stringify(found.rejected.map((r) => r.reason)))
    }

    // ③ Windows 上只有 `py` 启动器：老实现根本没有 py 候选。
    {
      const { spawn, calls } = scriptedSpawn({ py: GOOD })
      let legacy = null
      try { legacy = legacyStrip(spawn) } catch (error) { legacy = null }
      check('老实现只试 python3 / python，只有 py 的机器上它直接放弃',
        legacy === null && calls.join(',') === 'python3,python', calls.join(','))
      const { spawn: goodSpawn } = scriptedSpawn({ 'py -3': BROKEN_PY, py: GOOD })
      const found = findPython({ spawn: goodSpawn })
      check('新判据在坏 py -3（101）之后用 py 拿到 1', found.found && found.spec === 'py',
        JSON.stringify(found.spec))
    }

    console.log(failures === 0 ? '全部通过（对照成立：老判据确实会选错/直接放弃）' : failures + ' 项失败')
    return failures === 0 ? 0 : 1
  }

  console.log('--- 伪造机器状态')
  {
    const { spawn, calls } = scriptedSpawn({ python3: STORE_STUB, python: GOOD })
    const found = findPython({ spawn, candidates: candidateList({}, []) })
    check('0 字节 Store 存根（9009、无输出）被拒，继续用 python', found.found && found.spec === 'python' &&
      found.source === 'PATH', JSON.stringify({ spec: found.spec, source: found.source }))
    check('拒的依据是退出码 9009（不是"命令不存在"）',
      found.rejected.some((r) => r.spec === 'python3' && r.status === 9009 && r.missing === false),
      JSON.stringify(found.rejected.map((r) => [r.spec, r.status, r.missing])))
    check('没探到之前不会拿"命令存在"当命中（python3 只是被拒的一条）', calls.includes('python3') && calls.includes('python'),
      calls.join(','))
  }
  {
    const { spawn } = scriptedSpawn({ 'py -3': BROKEN_PY, py: GOOD })
    const found = findPython({ spawn, candidates: candidateList({}, []) })
    check('坏 py 启动器（退出码 101）被拒，继续用 py', found.found && found.spec === 'py',
      JSON.stringify({ spec: found.spec, rejected: found.rejected.map((r) => [r.spec, r.status, r.reason]) }))
  }
  {
    const { spawn } = scriptedSpawn({ python3: { status: 0, stdout: '' }, python: GOOD })
    const found = findPython({ spawn, candidates: PATH_CANDIDATES })
    const rejected = found.rejected.find((item) => item.spec === 'python3')
    check('退出码 0 但零输出 → 仍然被拒（产物不会静默变空）',
      found.found && found.spec === 'python' && rejected !== undefined && /输出不是/.test(rejected.reason),
      JSON.stringify(rejected === undefined ? found.rejected.map((r) => r.reason) : rejected.reason))
  }
  {
    const { spawn } = scriptedSpawn({ python3: { status: 0, stdout: '2' }, python: GOOD })
    const found = findPython({ spawn, candidates: PATH_CANDIDATES })
    const rejected = found.rejected.find((item) => item.spec === 'python3')
    check('退出码 0 但输出是 2 → 被拒（判据是"恰好 1"，不是"有个输出就行"）',
      found.found && found.spec === 'python' && rejected !== undefined && /输出不是/.test(rejected.reason),
      JSON.stringify(rejected === undefined ? found.rejected.map((r) => r.reason) : rejected.reason))
  }
  {
    const explicit = 'C:/tools/py/python.exe'
    const { spawn } = scriptedSpawn({ [explicit]: GOOD, python: GOOD })
    const found = findPython({ spawn, env: { MC_ART_PYTHON: explicit } })
    check('显式 MC_ART_PYTHON 排第一（PATH 上的 python 不抢先）',
      found.found && found.bin === explicit && found.source === 'MC_ART_PYTHON',
      JSON.stringify({ bin: found.bin, source: found.source }))
  }
  {
    const { spawn } = scriptedSpawn({ python: GOOD })
    const found = findPython({ spawn, env: { MC_ART_PYTHON: 'C:/nope/python.exe' } })
    check('显式路径自己坏了也不把整条链卡死：自愈到 python，并记下那次失败',
      found.found && found.spec === 'python' &&
      found.rejected.some((r) => r.source === 'MC_ART_PYTHON' && r.missing),
      JSON.stringify(found.rejected.map((r) => [r.spec, r.missing])))
  }
  {
    const runtime = 'C:/fake/desktop-runtime'
    const bundledBin = join(runtime, 'dependencies', 'python', 'python.exe')
    const { spawn } = scriptedSpawn({ [bundledBin]: GOOD, python3: STORE_STUB, python: GOOD })
    const found = findPython({ spawn, env: { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: runtime } })
    check('桌面端自带的 Python 排在 PATH 之前（Store 存根根本没轮到）',
      found.found && found.bin === bundledBin && found.source === 'bundled',
      JSON.stringify({ bin: found.bin, source: found.source }))
    const list = candidateList({ DSH_DESKTOP_PRIMARY_RUNTIME_DIR: runtime })
    check('桌面端目录会展开成 python.exe 与 bin/python3 两种布局',
      list.some((c) => c.source === 'bundled' && c.bin.endsWith('python.exe')) &&
      list.some((c) => c.source === 'bundled' && c.bin.endsWith(sep + 'python3')))
  }
  {
    resetPythonCache()
    const { spawn, calls } = scriptedSpawn({ python: GOOD })
    findPythonCached({ spawn })
    const afterFirst = calls.length
    findPythonCached({ spawn })
    check('命中后缓存（第二次不再起进程）', afterFirst > 0 && calls.length === afterFirst,
      afterFirst + ' → ' + calls.length)
    resetPythonCache()
  }
  {
    // 真机器：这一条同时验证"本机那条 Store 存根确实被拒"。
    const found = findPython()
    check('真实机器上探到一个能跑的解释器（真的起进程验证过）', found.found,
      found.found ? '' : noPythonMessage(found))
    if (found.found) {
      console.log('       选中 ' + found.bin + '（来源 ' + found.source + '）' +
        '，版本 ' + (pythonVersion(found) || '读不出来'))
      for (const item of found.rejected) {
        console.log('       拒绝 ' + item.spec + '（' + item.source + '）→ ' + item.reason)
      }
    }
  }

  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  return failures === 0 ? 0 : 1
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main(argv) {
  if (argv.includes('--selftest')) {
    const fault = argv.includes('--fault')
    console.log(fault ? '--- python_env 自测（--fault：对照老实现）' : '--- python_env 自测')
    return selftest(fault)
  }
  const rest = argv.slice()
  const pythonAt = rest.indexOf('--python')
  if (pythonAt >= 0) {
    const value = rest[pythonAt + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error('--python 后面要跟一个解释器路径')
      return 2
    }
    rest.splice(pythonAt, 2)
    process.env.MC_ART_PYTHON = value
  }
  const found = findPython()
  if (!found.found) {
    console.error(noPythonMessage(found))
    return 2
  }
  const positional = rest.filter((item) => !item.startsWith('--'))
  if (positional.length === 0) {
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ spec: found.spec, bin: found.bin, source: found.source,
        version: pythonVersion(found), rejected: found.rejected.map((r) => ({ spec: r.spec, source: r.source, status: r.status, reason: r.reason })) }, null, 2))
      return 0
    }
    console.log('Python：' + found.bin + (found.prefix.length > 0 ? ' ' + found.prefix.join(' ') : '') +
      '（来源 ' + found.source + '，版本 ' + (pythonVersion(found) || '读不出来') + '）')
    for (const item of found.rejected) console.log('  拒绝 ' + item.spec + '（' + item.source + '）→ ' + item.reason)
    return 0
  }
  // 跑一个脚本：stdio 直接继承（输出、颜色、交互都原样），退出码透传。
  const done = spawnSync(found.bin, found.prefix.concat(positional),
    { stdio: 'inherit', windowsHide: true, env: pythonEnv() })
  if (done.error !== undefined) {
    console.error('跑 ' + positional[0] + ' 失败：' + done.error.message)
    return 2
  }
  return done.status === null ? 1 : done.status
}

if (process.argv[1] !== undefined &&
    (process.argv[1].endsWith('python_env.mjs') || process.argv[1].endsWith('python_env'))) {
  process.exit(main(process.argv.slice(2)))
}
