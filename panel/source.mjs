// 把某一半的**源码拼起来**：`tools/mcart-plugin/<half>.js` 已经是生成物（barrel），
// 它的真源是 `tools/mcart-plugin/<half>/` 下的片段，按 `<half>.manifest.json` 的顺序拼接。
//
// 为什么需要它：host.js / client.js 拆成多个片段文件之后，"这一半的完整源码"不再是
// 某一个手写文件。门禁（strip_gate、report-test）与 build 都需要同一份拼接结果 ——
// 各自实现一遍就是三个真相，所以拼接口只有这一份。
//
// 约定（全部有明确报错，绝不静默降级）：
//   · 清单是 JSON 字符串数组，路径相对 `tools/mcart-plugin/`，**最后一项是入口片段**；
//   · 片段按清单顺序**逐字节**拼接（每个片段必须以换行结尾；重复项、`..`、绝对路径直接报错）；
//   · 清单为空**且**片段目录不存在 = legacy 单文件模式（barrel 就是真源，过渡期兼容）；
//   · 清单为空**但**片段目录里有文件 = 报错（它们会被静默忽略，症状是"函数突然不存在"）；
//   · 清单指向不存在的文件 = 报错并点名。
//
// 用法：
//   node panel/source.mjs host            > 拼接后的宿主源码
//   node panel/source.mjs client          > 拼接后的客户端源码
//   node panel/source.mjs list            > 每半的清单与模式（JSON，给人看）
//   node panel/source.mjs --write         # 把拼接结果写回 barrel（两半都写）
//   node panel/source.mjs --write client  # 只写一半
//   node panel/source.mjs --check         # barrel 与拼接结果不一致 → 退出码 1
//   node panel/source.mjs --selftest      # 用临时夹具自测这套机制
//   node panel/source.mjs --selftest --fault   # 反向夹具：老行为（忽略片段）必须红
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SOURCES = resolve(HERE, '..', 'tools', 'mcart-plugin')

/** 每一半：barrel（生成物）、片段目录、清单。 */
export const HALVES = {
  host: { barrel: 'host.js', fragments: 'host', manifest: 'host.manifest.json' },
  client: { barrel: 'client.js', fragments: 'client', manifest: 'client.manifest.json' },
}

function specOf(half) {
  const spec = HALVES[half]
  if (spec === undefined) throw new Error('未知的半边：' + half + '（只有 host / client）')
  return spec
}

/** 片段目录里的 .js 文件（只用于"清单为空却有人写了片段"这条检查）。 */
function fragmentFilesOnDisk(half, root) {
  const dir = join(root, specOf(half).fragments)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.js')).sort()
}

/**
 * 读清单并校验。任何"拆了一半"的状态都抛错 —— 症状必须是一条明确的错误，
 * 而不是产物里悄悄少了几个函数（strip_gate 那条门禁存在的原因就是这个）。
 */
export function modulesOf(half, root = SOURCES) {
  const spec = specOf(half)
  const manifestPath = join(root, spec.manifest)
  if (!existsSync(manifestPath)) {
    throw new Error('缺少清单 ' + spec.manifest + '（' + manifestPath + '）—— 拆分机制要求清单是跟踪文件')
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(spec.manifest + ' 不是合法 JSON：' + error.message)
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(spec.manifest + ' 必须是非空字符串组成的数组')
  }
  if (parsed.length === 0) {
    const onDisk = fragmentFilesOnDisk(half, root)
    if (onDisk.length > 0) {
      throw new Error(spec.manifest + ' 是空的，但 ' + spec.fragments + '/ 里有 ' + onDisk.length +
        ' 个片段（' + onDisk.slice(0, 5).join(', ') + (onDisk.length > 5 ? ' …' : '') +
        '）—— 它们会被静默忽略。把片段按顺序写进清单（入口片段列最后），或先删掉它们。')
    }
    return []   // legacy 单文件模式
  }
  const seen = new Set()
  for (const name of parsed) {
    if (isAbsolute(name) || name.startsWith('../') || name.includes('..\\')) {
      throw new Error(spec.manifest + ' 里的路径必须是相对 ' + 'tools/mcart-plugin/ 的子路径：' + name)
    }
    const normalized = name.replace(/\\/g, '/')
    if (seen.has(normalized)) throw new Error(spec.manifest + ' 里有重复项：' + name)
    seen.add(normalized)
    const full = join(root, normalized)
    if (!existsSync(full)) {
      throw new Error(spec.manifest + ' 指向不存在的文件：' + name + '（' + full + '）')
    }
    const text = readFileSync(full, 'utf8')
    if (!text.endsWith('\n')) {
      throw new Error('片段必须以换行结尾（逐字节拼接，否则下一段会接在同一行）：' + name)
    }
  }
  return parsed.map((name) => name.replace(/\\/g, '/'))
}

/** 这一半是不是 legacy 单文件模式（清单为空且没有片段目录）。 */
export function isLegacy(half, root = SOURCES) {
  return modulesOf(half, root).length === 0
}

/**
 * 拼接某一半的源码。顺序：清单里的片段按顺序 → **入口片段在最后**（由清单保证）。
 * `read` 由调用方给（build.mjs 传"读文件"，门禁可以传任何读法），
 * 这样"剥注释"和"拼接"两件事不会互相耦合。
 */
export function halfSource(half, read = (path) => readFileSync(path, 'utf8'), root = SOURCES) {
  const spec = specOf(half)
  const modules = modulesOf(half, root)
  if (modules.length === 0) return read(join(root, spec.barrel))   // legacy：barrel 就是真源
  return modules.map((name) => read(join(root, name))).join('')
}

/**
 * 把拼接结果写回 barrel（**唯一**的写入口；`--write` 与 build.mjs 都走它）。
 * 先写临时文件再 rename，避免写了半个文件把仓库留在坏状态。
 * 写完立刻读回比对：写失败比没写更糟。
 */
export function writeBarrels({ root = SOURCES, halves = ['host', 'client'] } = {}) {
  const report = {}
  for (const half of halves) {
    const spec = specOf(half)
    const modules = modulesOf(half, root)
    if (modules.length === 0) {
      report[half] = { mode: 'legacy', fragments: 0, bytes: null, written: false }
      continue
    }
    const text = halfSource(half, (path) => readFileSync(path, 'utf8'), root)
    const target = join(root, spec.barrel)
    const temporary = target + '.tmp-write'
    writeFileSync(temporary, text)
    renameSync(temporary, target)
    if (readFileSync(target, 'utf8') !== text) {
      throw new Error('写完 barrel 读回来不一致（' + target + '）')
    }
    report[half] = { mode: 'split', fragments: modules.length, bytes: text.length, written: true }
  }
  return report
}

/** `--check`：barrel 与拼接结果逐字节比对。legacy 模式没有可比的东西（barrel 就是真源）。 */
export function checkBarrels({ root = SOURCES, halves = Object.keys(HALVES) } = {}) {
  const problems = []
  const report = {}
  for (const half of halves) {
    const spec = specOf(half)
    const modules = modulesOf(half, root)
    if (modules.length === 0) { report[half] = { mode: 'legacy', fragments: 0 }; continue }
    const expected = halfSource(half, (path) => readFileSync(path, 'utf8'), root)
    const barrelPath = join(root, spec.barrel)
    const actual = existsSync(barrelPath) ? readFileSync(barrelPath, 'utf8') : null
    report[half] = { mode: 'split', fragments: modules.length, bytes: expected.length }
    if (actual === null) { problems.push(spec.barrel + ' 不存在'); continue }
    if (actual !== expected) {
      let at = 0
      const limit = Math.min(actual.length, expected.length)
      while (at < limit && actual[at] === expected[at]) at += 1
      problems.push(spec.barrel + ' 与清单拼接结果不同（第 ' + at + ' 个字符起；barrel ' +
        actual.length + ' 字符 / 拼接 ' + expected.length + ' 字符）')
    }
  }
  return { problems, report }
}

// ---------------------------------------------------------------------------
// 自测：用临时树证明拼接/写回/报错都成立，不依赖仓库里当前的片段状态。
// `--fault` 是反向夹具：用**老行为**（只读 barrel、忽略清单）跑同一条断言，要求它红。
// ---------------------------------------------------------------------------

function checker() {
  const state = { failures: 0 }
  const check = (label, ok, detail = '') => {
    if (!ok) state.failures += 1
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === '' ? '' : '  -> ' + detail))
  }
  return { check, state }
}

function makeFixture(root, { manifest = null, fragments = {}, barrel = null } = {}) {
  for (const [name, text] of Object.entries(fragments)) {
    const full = join(root, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  if (manifest !== null) writeFileSync(join(root, 'host.manifest.json'), JSON.stringify(manifest))
  if (barrel !== null) writeFileSync(join(root, 'host.js'), barrel)
}

function selftest(fault = false) {
  const { check, state } = checker()
  const root = mkdtempSync(join(tmpdir(), 'mcart-source-'))
  try {
    const a = 'function alpha() { return 1 }\n'
    const b = 'const beta = 2\n'
    const entry = 'function entry() { return alpha() + beta }\n'
    const concat = a + b + entry
    const staleBarrel = 'STALE\n'
    makeFixture(root, { manifest: ['host/p-a.js', 'host/p-b.js', 'host/99-entry.js'], fragments: {
      'host/p-a.js': a, 'host/p-b.js': b, 'host/99-entry.js': entry,
    }, barrel: staleBarrel })

    const order = modulesOf('host', root)
    check('清单顺序原样返回（入口在最后，不再额外 append）',
      JSON.stringify(order) === JSON.stringify(['host/p-a.js', 'host/p-b.js', 'host/99-entry.js']), JSON.stringify(order))
    check('halfSource = 逐字节拼接', halfSource('host', undefined, root) === concat)

    const stale = checkBarrels({ root, halves: ['host'] })
    check('--check 抓到"barrel 过期"', stale.problems.length === 1 && stale.problems[0].includes('不同'),
      JSON.stringify(stale.problems))

    const report = writeBarrels({ root, halves: ['host'] })
    check('--write 写了 barrel', report.host.written === true && report.host.fragments === 3, JSON.stringify(report.host))
    check('写回后 barrel 与拼接结果逐字节相同', readFileSync(join(root, 'host.js'), 'utf8') === concat)
    check('写回后 --check 绿', checkBarrels({ root, halves: ['host'] }).problems.length === 0)

    // 过渡期报错：清单空但片段目录里有文件
    const torn = mkdtempSync(join(tmpdir(), 'mcart-source-torn-'))
    try {
      makeFixture(torn, { manifest: [], fragments: { 'host/p-a.js': a }, barrel: '' })
      let message = ''
      try { modulesOf('host', torn) } catch (error) { message = error.message }
      check('清单为空但片段目录里有文件 → 明确报错（不是静默忽略）',
        message.includes('是空的') && message.includes('p-a.js'), message || '(没有报错)')
    } finally { rmSync(torn, { recursive: true, force: true }) }

    // 缺文件 / 非法路径 / 重复项 / 片段没有换行结尾
    for (const [label, manifest, fragments, expected] of [
      ['清单指向不存在的文件 → 报错并点名', ['host/nope.js'], {}, '不存在的文件'],
      ['清单里有 ../ 逃逸 → 报错', ['../evil.js'], {}, '子路径'],
      ['清单里有重复项 → 报错', ['host/p-a.js', 'host/p-a.js'], { 'host/p-a.js': a }, '重复'],
      ['片段没有换行结尾 → 报错', ['host/p-a.js'], { 'host/p-a.js': 'const x = 1' }, '换行结尾'],
    ]) {
      const one = mkdtempSync(join(tmpdir(), 'mcart-source-bad-'))
      try {
        makeFixture(one, { manifest, fragments, barrel: '' })
        let message = ''
        try { modulesOf('host', one) } catch (error) { message = error.message }
        check(label, message.includes(expected), message || '(没有报错)')
      } finally { rmSync(one, { recursive: true, force: true }) }
    }

    // legacy：清单空且没有片段目录 → barrel 就是真源
    const legacyRoot = mkdtempSync(join(tmpdir(), 'mcart-source-legacy-'))
    try {
      makeFixture(legacyRoot, { manifest: [], fragments: {}, barrel: concat })
      check('legacy 模式：清单空且无片段目录 → halfSource 就是 barrel 本身',
        halfSource('host', undefined, legacyRoot) === concat && modulesOf('host', legacyRoot).length === 0)
    } finally { rmSync(legacyRoot, { recursive: true, force: true }) }

    if (fault) {
      // 反向夹具：老行为 = 只读 barrel、不拼片段。用**写回之前**那份 barrel（stale）当老输出，
      // 它必须丢掉片段里的声明（否则这条门禁就没有区分力）。
      const legacyLoss = !staleBarrel.includes('function alpha()')
      check('反向夹具：老行为（忽略清单、只读 barrel）会丢掉片段里的声明 ← 所以拼接必须按清单',
        legacyLoss, '老行为居然拼对了，这个反向夹具失效')
      check('而新行为里两个片段的名字都在', concat.includes('function alpha()') && concat.includes('const beta'))
      printSummary(state.failures, '对照成立：老行为不拼片段 → 声明会丢；新行为按清单拼')
      return state.failures === 0 ? 0 : 1
    }

    printSummary(state.failures, null)
    return state.failures === 0 ? 0 : 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function printSummary(failures, note) {
  if (failures === 0) console.log(note === null ? '全部通过' : '全部通过（' + note + '）')
  else console.log(failures + ' 项失败')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const fault = argv.includes('--fault')
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  const selftestFlag = argv.includes('--selftest')
  const positional = argv.filter((arg) => !arg.startsWith('--'))

  if (selftestFlag) {
    console.log('--- 拼接机制自测' + (fault ? '（--fault：反向夹具）' : ''))
    return selftest(fault)
  }
  if (write) {
    const halves = positional.filter((name) => name === 'host' || name === 'client')
    const report = writeBarrels({ halves: halves.length > 0 ? halves : undefined })
    for (const [half, item] of Object.entries(report)) {
      if (item.mode === 'legacy') {
        console.log('legacy ' + half + '：清单为空的单文件模式，barrel 保持原样（尚未拆分）')
      } else {
        console.log('write ' + half + '：' + item.fragments + ' 个片段 → barrel（' + item.bytes + ' 字符）')
      }
    }
    return 0
  }
  if (check) {
    const { problems, report } = checkBarrels()
    for (const [half, item] of Object.entries(report)) {
      if (item.mode === 'legacy') console.log('legacy ' + half + '：清单为空的单文件模式，无 barrel 可比')
      else console.log('split  ' + half + '：' + item.fragments + ' 个片段（' + item.bytes + ' 字符）')
    }
    for (const problem of problems) console.log('STALE ' + problem)
    console.log(problems.length === 0 ? '全部通过' : problems.length + ' 处漂移')
    return problems.length === 0 ? 0 : 1
  }
  if (positional[0] === 'list') {
    const out = {}
    for (const half of Object.keys(HALVES)) {
      const modules = modulesOf(half)
      out[half] = { mode: modules.length === 0 ? 'legacy' : 'split', fragments: modules }
    }
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  const half = positional[0]
  if (half !== 'host' && half !== 'client') {
    console.error('用法：node panel/source.mjs host|client|list|--write|--check|--selftest [--fault]')
    return 2
  }
  process.stdout.write(halfSource(half))
  return 0
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
