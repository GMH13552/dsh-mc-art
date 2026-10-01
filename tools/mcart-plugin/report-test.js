#!/usr/bin/env node
/**
 * 报告契约 + **绝不写会话**。
 *
 * 两个层面，都要能失败：
 *   静态：`panel/lib/index.js` / `panel/lib/client.js` 的**生成物**里（以及它们的源码里）
 *         不许出现任何写会话 / agent inbox 的调用（`steer` / `inbox.append` / `notifyAgent`…）。
 *         `panel/lib/*` 是 build 产物；文件不在就说明"没 build"，不是通过。
 *   运行时：用**间谍 sessions 服务**驱动宿主注册的**全部 handler**，断言零写入。
 *         0.1.26 那次就是在这条路上把用户日志写坏的（`agent.steer` 一条没有 `source`
 *         的消息进了 `agent/inbox/spliced`，会话再也加载不了），所以这条必须有门禁盯着。
 *
 *   node tools/mcart-plugin/report-test.js
 *   node tools/mcart-plugin/report-test.js --fault
 *       # 两条都注入故障：静态那份插入一句 `agent.inbox.append(...)`，
 *       # 运行时那份把 `sessionsOf().steer(...)` 塞回画不出来的分支 —— 必须都变红。
 */
const nodeFs = require('fs')
const nodePath = require('path')

const {
  loadHost, readHostSource, realSubprocess, buildFixture, WORK, fsService,
} = require('./model-test.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const FAULT = process.argv.includes('--fault')

/** 列出随包目录里的 .pyc（`panel/python` 是**发布物**，里面不该有编译产物）。 */
function pycFiles(dir) {
  const out = []
  if (!nodeFs.existsSync(dir)) return out
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...pycFiles(full))
    else if (/\.pyc$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 清掉历史遗留的 .pyc：它们不该在仓库/包里，留着会让"跑完不产生 .pyc"这条断言假红。 */
function clearPyc() {
  const stale = pycFiles(nodePath.join(REPO, 'panel', 'python'))
  if (stale.length > 0) {
    console.log('  （清掉 ' + stale.length + ' 个历史 .pyc —— 随包目录里本来就不该有：'
      + stale.slice(0, 3).map((file) => nodePath.relative(REPO, file)).join('、') + '）')
  }
  for (const file of stale) nodeFs.rmSync(file, { force: true })
  const cacheDir = nodePath.join(REPO, 'panel', 'python', '__pycache__')
  if (nodeFs.existsSync(cacheDir)) nodeFs.rmSync(cacheDir, { recursive: true, force: true })
  return stale.length
}

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// ── 代码视图：剥掉注释，再扫 ─────────────────────────────────────────────────
// 注释里写着"0.1.26 我们曾经 steer 过一次"是**对的**（那是事故记录），
// 所以门禁量的是**代码**里有没有这个调用，不是文件里有没有这个词。
function stripComments(text) {
  let out = ''
  let index = 0
  let quote = null
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (quote !== null) {
      out += char
      if (char === '\\') { out += next === undefined ? '' : next; index += 2; continue }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; index += 1; continue }
    if (char === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 生成物里内嵌的源码字符串（`const SOURCE = "…"` / `var SOURCE = "…"`）。 */
function embeddedSources(text) {
  const out = []
  const pattern = /(?:const|var|let)\s+(?:SOURCE|CLIENT)\s*=\s*("(?:[^"\\]|\\.)*")/g
  let match = pattern.exec(text)
  while (match !== null) {
    try { out.push(JSON.parse(match[1])) } catch (error) { out.push('') }
    match = pattern.exec(text)
  }
  return out
}

/**
 * 禁止出现的调用形状。
 *
 * 不扫裸词：`steer` / `inbox` 在事故注释里必须能继续出现。扫的是**调用**。
 * "sessions 上只许读"这条单独盯着 `sessionsOf()` / `ctx.get('sessions')` 后面
 * 40 个字符里有没有写方法。
 */
const FORBIDDEN = [
  { label: 'agent.steer(...)（0.1.26 写坏会话日志的那条路）', re: /\.steer\s*\(/ },
  { label: 'agent.inbox.append(...)', re: /\.inbox\b[\s\S]{0,24}?\.\s*(append|splice|push)\b/ },
  { label: 'notifyAgent / agentNotices / lastSessionId / agentsOf()', re: /\b(notifyAgent|agentNotices|lastSessionId|agentsOf)\b/ },
  { label: 'sessionsOf().<写方法>()', re: /sessionsOf\s*\(\s*\)[\s\S]{0,40}?\.\s*(append|splice|push|add|write|set|update|delete|remove|steer|inbox)\b/ },
  { label: "ctx.get('sessions').<写方法>()", re: /get\(\s*['"]sessions['"]\s*\)[\s\S]{0,40}?\.\s*(append|splice|push|add|write|set|update|delete|remove|steer|inbox)\b/ },
]

function viewsOf(file) {
  if (!nodeFs.existsSync(file)) return { missing: true, views: [] }
  const raw = nodeFs.readFileSync(file, 'utf8')
  const views = [{ label: '外层代码', code: stripComments(raw) }]
  const embedded = embeddedSources(raw)
  for (let index = 0; index < embedded.length; index++) {
    views.push({ label: '内嵌源码 #' + (index + 1), code: stripComments(embedded[index]) })
  }
  return { missing: false, views: views }
}

function scanViews(file, views, extra) {
  const hits = []
  for (const view of views) {
    const code = extra === undefined ? view.code : view.code + extra
    for (const rule of FORBIDDEN) {
      const match = rule.re.exec(code)
      if (match !== null) hits.push(view.label + ' → ' + rule.label + '（' + JSON.stringify(match[0].slice(0, 60)) + '）')
    }
  }
  return hits
}

// ── 运行时间谍：sessions 服务上**任何一次写入**都要被记下来 ────────────────────
function spySessions(writes) {
  const session = { header: { cwd: 'C:/spy/project' } }
  return new Proxy({
    get(id) {
      writes.push('read: sessions.get(' + String(id) + ')')
      return session
    },
  }, {
    get(target, property) {
      if (property === 'get') return target.get
      if (property === 'then' || property === 'toJSON' || typeof property === 'symbol') return undefined
      writes.push('WRITE: sessions.' + String(property))
      return function () { writes.push('WRITE: sessions.' + String(property) + '() 被调用'); return undefined }
    },
  })
}

const HANDLER_ARGS = {
  'atlas.pickDirectory': { root: WORK, project: 'withref' },
  'atlas.settings': { root: WORK, project: 'withref' },
  'atlas.gameRoots': { root: WORK, project: 'withref' },
  'atlas.saveSettings': { root: WORK, project: 'withref', directory: '' },
  'atlas.saveTexture': { root: WORK, project: 'withref' },
  'atlas.createProject': { root: WORK, project: 'withref' },
  'atlas.saveVoxel': { root: WORK, project: 'withref' },
  'atlas.preview': { root: WORK, project: 'withref', block: 'wref:gone', at: [0, 0, 0], variant: null },
  'atlas.icons': { root: WORK, project: 'withref' },
  'atlas.scan': { root: WORK },
  'atlas.projects': { root: WORK },
  'atlas.env': { root: WORK },
  'atlas.scene': { root: WORK, project: 'withref', kind: 'block', id: 'gone' },
  'atlas.session': { sessionId: 'sess-1' },
  'atlas.refNamespaces': { root: WORK, project: 'withref' },
  'atlas.refItems': { root: WORK, project: 'withref', namespace: 'minecraft' },
  'atlas.itemIcons': { root: WORK, project: 'withref', namespace: 'minecraft' },
  'atlas.icon': { root: WORK, project: 'withref', namespace: 'minecraft', item: 'x' },
  'atlas.refBlocks': { root: WORK, project: 'withref', namespace: 'minecraft' },
  'atlas.refIcons': { root: WORK, project: 'withref', namespace: 'minecraft' },
  'atlas.releaseRefs': { keep: [] },
}

// 故障注入：把 0.1.26 那条注入原样塞回"画不出来"的分支；再把"空 quads 也走诊断"关掉
// （那就是用户看到的"取景框一片空白、屏幕上一个字都没有"）。
const RUNTIME_FAULTS = [
  { from: '          const failed = blockDiagnostic(load, namespace, id, found, built, directory)',
    to: '          const failed = blockDiagnostic(load, namespace, id, found, built, directory)\n'
      + "          if (sessionsOf() !== undefined) sessionsOf().steer({ role: 'user' })" },
  { from: '        if (elements === undefined || quads.length === 0) {',
    to: '        if (elements === undefined) {' },
  { from: "['-B', '-X', 'utf8', scanner]",
    to: "['-X', 'utf8', scanner]" },
]

async function main() {
  buildFixture()
  clearPyc()
  let source = readHostSource()
  if (FAULT) {
    for (const fault of RUNTIME_FAULTS) {
      if (source.indexOf(fault.from) < 0) {
        console.log('  FAIL --fault 没生效：宿主里找不到 —— ' + fault.from.slice(0, 60))
        process.exit(2)
      }
      source = source.replace(fault.from, fault.to)
    }
    console.log('--- 故障注入：静态那份插入 `agent.inbox.append(...)`；运行时塞回 `sessionsOf().steer(...)` '
      + '并关掉"空 quads 也走诊断"')
  }

  // ── 1. 静态禁词门禁 ───────────────────────────────────────────────────────
  console.log('--- 静态：面板不许有写会话的调用')
  {
    // 剥离器自检：不先证明它剥得对，整条门禁可能只是"什么都没扫到"。
    const stripped = stripComments('// a.steer(1)\nx.inbox.append(2)\n/* .steer(3) */\n')
    check('static: 剥离器自检（注释里的调用剥掉、代码里的留下）',
      stripped.indexOf('steer') < 0 && stripped.indexOf('inbox') >= 0, JSON.stringify(stripped))
  }
  const targets = [
    ['tools/mcart-plugin/host.js', nodePath.join(REPO, 'tools', 'mcart-plugin', 'host.js')],
    ['tools/mcart-plugin/client.js', nodePath.join(REPO, 'tools', 'mcart-plugin', 'client.js')],
    ['panel/lib/index.js（生成物）', nodePath.join(REPO, 'panel', 'lib', 'index.js')],
    ['panel/lib/client.js（生成物）', nodePath.join(REPO, 'panel', 'lib', 'client.js')],
  ]
  {
    const injection = FAULT ? "\nagent.inbox.append('next-step', { role: 'user' })\n" : ''
    for (const [label, file] of targets) {
      const found = viewsOf(file)
      if (found.missing) {
        // 生成物可能还没 build：说明，不当通过。
        if (label.indexOf('生成物') >= 0) {
          console.log('  SKIP ' + label + ' 不存在（还没跑 node panel/build.mjs）')
          continue
        }
        check('static: ' + label + ' 存在', false, '文件不存在')
        continue
      }
      // 生成物还要证明"内嵌源码真的被解出来了"，否则这一条只是扫了外层壳。
      if (label.indexOf('生成物') >= 0) {
        check('static: ' + label + ' 的内嵌源码被解出来扫了（不是只扫外层壳）',
          found.views.length > 1 && found.views[1].code.length > 1000,
          found.views.map((view) => view.label + ':' + view.code.length).join(' '))
      }
      const hits = scanViews(file, found.views, injection)
      check('static: ' + label + ' 没有写会话的调用', hits.length === 0, hits.join(' | '))
    }
    // 生成物和源码必须一致：旧生成物会让门禁对着一个没人再维护的副本。
    for (const name of ['index.js', 'client.js']) {
      const generated = nodePath.join(REPO, 'panel', 'lib', name)
      if (!nodeFs.existsSync(generated)) continue
      const views = viewsOf(generated).views
      const embedded = views.length > 1 ? views[1].code : ''
      const sourceName = name === 'index.js' ? 'host.js' : 'client.js'
      check('static: panel/lib/' + name + ' 的内嵌源码就是 tools/mcart-plugin/' + sourceName + '（不是旧副本）',
        embedded.length > 1000 &&
          embedded.replace(/\s+/g, ' ').trim() ===
            stripComments(nodeFs.readFileSync(nodePath.join(REPO, 'tools', 'mcart-plugin', sourceName), 'utf8'))
              .replace(/\s+/g, ' ').trim(),
        '内嵌 ' + embedded.length + ' 字符')
    }
  }

  // ── 2. 报告契约（§2.4）──────────────────────────────────────────────────────
  console.log('--- 报告契约：准确、可复制、≤20 行、不注入')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const out = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gone' })
    const diagnostic = (out && out.diagnostic) || {}
    const text = String(out && out.error)
    check('report: 失败时同时给结构化 diagnostic 与人读文本',
      out !== undefined && typeof out.error === 'string' && out.diagnostic !== undefined)
    check('report: reason 落在 §2.4 的七个值里',
      ['project-model-missing', 'vanilla-parent-missing', 'no-reference-directory',
        'reference-jar-missing', 'extractor-failed', 'parent-cycle', 'unknown'].indexOf(diagnostic.reason) >= 0,
      String(diagnostic.reason))
    check('report: diagnostic.block 是 <ns>:<id>',
      diagnostic.block === 'wref:gone', String(diagnostic.block))
    check('report: missing 每条都有 kind / name / fixPath（都是字符串）',
      Array.isArray(diagnostic.missing) && diagnostic.missing.length > 0 &&
        diagnostic.missing.every((item) => typeof item.kind === 'string' && typeof item.name === 'string' &&
          typeof item.fixPath === 'string' && item.fixPath !== ''),
      JSON.stringify(diagnostic.missing))
    check('report: tried 是字符串数组，且至少两条带真实路径（试过的路要说得出路）',
      Array.isArray(diagnostic.tried) && diagnostic.tried.length >= 3 &&
        diagnostic.tried.every((line) => typeof line === 'string' && line !== '') &&
        diagnostic.tried.filter((line) => /[\\/]/.test(line)).length >= 2,
      JSON.stringify(diagnostic.tried))
    check('report: referenceDirectory 是字符串（没设就是空串）',
      typeof diagnostic.referenceDirectory === 'string', JSON.stringify(diagnostic.referenceDirectory))
    check('report: 人读文本 ≤ 20 行', text.split('\n').length <= 20, text.split('\n').length + ' 行')
    check('report: 人读文本里没有把 project 的写进"缺的原版母模型"',
      !/缺的原版母模型/.test(text), text.split('\n')[2])
    check('report: 报告不注入任何地方（notified=false / notifyVia=null）',
      out.notified === false && out.notifyVia === null,
      JSON.stringify({ notified: out.notified, notifyVia: out.notifyVia }))
    const again = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gone' })
    check('report: 同一份报告第二次逐字节相同（不刷屏的前提）',
      String(again.error) === text, String(again.error).slice(0, 30))

    // 「模型链完整、贴图解不出来」是**另一类**缺陷：它以前返回一个"成功 + quads 空"的对象，
    // 取景框一片空白、屏幕上一个字都没有（用户实测）。空 quads 也必须走同一份诊断。
    const blank = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gate_texmissing' })
    const blankDiag = (blank && blank.diagnostic) || {}
    check('report: 空 quads 不再返回"成功"（必须有 error + diagnostic）',
      blank !== undefined && blank.error !== undefined && blank.diagnostic !== undefined,
      JSON.stringify({ error: blank === undefined ? 'undefined' : String(blank.error).split('\n')[0],
        quads: blank === undefined ? null : (blank.quads === undefined ? '没有这个键' : blank.quads.length) }))
    check('report: 贴图这一类 reason = textures-unresolved',
      blankDiag.reason === 'textures-unresolved', String(blankDiag.reason))
    check('report: 贴图那一条 missing 给的是确切的 PNG 路径',
      Array.isArray(blankDiag.missing) &&
        blankDiag.missing.some((item) => String(item.fixPath).indexOf('textures/block/nope.png') >= 0),
      JSON.stringify(blankDiag.missing))
    check('report: 贴图那份报告也 ≤ 20 行、也不注入',
      String(blank.error).split('\n').length <= 20 && blank.notified === false && blank.notifyVia === null,
      String(blank.error).split('\n').length + ' 行')

    // ── 随包目录不许留 .pyc ────────────────────────────────────────────────
    // `panel/python/` 是**发布物**。抽取器 `import mcart_scan_refs`，Python 默认会在旁边写
    // `__pycache__/*.pyc`，而每个 .pyc 里都嵌着源码字符串（含开发机绝对路径）——
    // 既是路径泄漏，也是只读安装下的写盘隐患。宿主用 `-B`（= PYTHONDONTWRITEBYTECODE，
    // subprocess 契约里没有 env 通道）挡住它。
    const pythonCalls = subprocess.calls.filter((argv) =>
      argv.some((token) => /mcart_(scan_refs|extract_block)\.py$/.test(String(token))))
    check('pyc: 宿主起 Python 时带了 -B（等于 PYTHONDONTWRITEBYTECODE；argv 通道）',
      pythonCalls.length > 0 && pythonCalls.every((argv) => argv.indexOf('-B') >= 0),
      JSON.stringify(pythonCalls.map((argv) => argv.slice(0, 5))))
    const leaked = pycFiles(nodePath.join(REPO, 'panel', 'python'))
    check('pyc: 跑过抽取器之后 panel/python 下没有 .pyc（发布目录不留编译产物）',
      leaked.length === 0, leaked.map((file) => nodePath.relative(REPO, file)).join('、'))
  }

  // ── 3. 运行时间谍：全部 handler，零会话写入 ─────────────────────────────────
  console.log('--- 运行时：间谍 sessions 服务驱动全部 handler')
  {
    const writes = []
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess, sessions: spySessions(writes) })
    const names = Object.keys(handlers).sort()
    const missing = names.filter((name) => HANDLER_ARGS[name] === undefined)
    check('spy: 每个注册的 handler 都在被驱动清单里（不偷偷漏掉）',
      missing.length === 0, missing.join(',') + '（共 ' + names.length + ' 个）')
    let threw = 0
    for (const name of names) {
      try { await handlers[name](HANDLER_ARGS[name] === undefined ? {} : HANDLER_ARGS[name]) }
      catch (error) { threw += 1 }
    }
    check('spy: 全部 handler 跑完没有抛异常', threw === 0, threw + ' 个抛了')
    check('spy: sessions 上零写入（0.1.26 就是把这里写坏的）',
      writes.filter((line) => line.indexOf('WRITE: ') === 0).length === 0,
      JSON.stringify(writes.slice(0, 8)))
    // 读也要看得见：只证明"没写"而没证明"真的接上了间谍"是空的。
    check('spy: 的确读到过 sessions（证明间谍真的接上了，不是没调用）',
      writes.some((line) => line.indexOf('read: sessions.get(') === 0), JSON.stringify(writes.slice(0, 4)))
  }

  // ── 结论 ─────────────────────────────────────────────────────────────────
  // 收尾：故障注入会（故意）在随包目录里留下 .pyc，别让它成为下一次运行的假红。
  clearPyc()
  if (FAULT) {
    const expected = [
      'static: tools/mcart-plugin/host.js 没有写会话的调用',
      'spy: sessions 上零写入（0.1.26 就是把这里写坏的）',
      'report: 空 quads 不再返回"成功"（必须有 error + diagnostic）',
      'report: 贴图这一类 reason = textures-unresolved',
      'pyc: 跑过抽取器之后 panel/python 下没有 .pyc（发布目录不留编译产物）',
    ]
    const missed = expected.filter((label) => failedLabels.indexOf(label) < 0)
    console.log('--- 故障注入结果：' + failures + ' 条断言变红')
    console.log('    变红的：' + (failedLabels.slice(0, 6).join(' | ') || '（一条都没有）'))
    if (missed.length > 0) {
      console.log('  FAIL 故障注入没有让这些断言变红（门禁对它们失效）：' + missed.join(' / '))
      process.exit(1)
    }
    console.log('全部通过（故障注入下这些断言确实会红）')
    process.exit(0)
  }
  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
