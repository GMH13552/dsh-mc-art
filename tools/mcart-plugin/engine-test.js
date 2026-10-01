#!/usr/bin/env node
/**
 * 「参考目录」到底能不能用——端到端那一条链。
 *
 * 用户实测的一句话是判据：「那个用它根本用不了」。查下来是链子断在第一环：
 *
 *   * 读原版/模组 jar 的两个脚本（`mcart_scan_refs.py` / `mcart_extract_block.py`）
 *     原来**只从项目目录往上找 5 层** —— 也就是"你的项目恰好在 dsh-mc-art 仓库里"
 *     才碰得上。别人的机器上：设置存得下、`用它`点得动，然后什么都读不出来；
 *   * Python 也一样：桌面 app 自带 3.12，但**不进 PATH**，`python3`/`python`/`py -3`
 *     在那个进程里全都不存在。
 *
 * 所以这条门禁造一个**完全孤立**的工程目录（/tmp 下，往上没有任何 tools/），造一个
 * 假的 `.minecraft`（一个带`assets/<ns>/textures|lang`的 jar），然后要求整条链跑通：
 * 脚本从**包里**找到 → Python 从"系统 or 捆绑运行时"找到 → 真的读出 jar → JSON 解析。
 *
 *   node tools/mcart-plugin/engine-test.js
 *   node tools/mcart-plugin/engine-test.js --fault   # 掐掉"包自带"那条候选：必须变红
 */
const nodeFs = require('fs')
const nodePath = require('path')
const nodeOs = require('os')
const { execFileSync } = require('child_process')

const REPO = nodePath.resolve(__dirname, '..', '..')
const PANEL = nodePath.join(REPO, 'panel')
const FAULT = process.argv.includes('--fault')
// 「包里那份脚本」的判据：宿主有的地方用 `/`、有的地方用 `\`（moduleDir 来自 path.join），
// 写死 `nodePath.join('panel','python')` 在 Windows 上等于找 `panel\python`，而宿主给的是
// `panel/python` —— 一条看着对、在原生 Windows 上必红的断言。
const PACK_PYTHON = /(^|[\\/])panel[\\/]python[\\/]/

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/** 一个最小的假 jar：assets/<ns>/textures/block/x.png + lang/en_us.json。 */
function makeJar(path, namespace) {
  const stage = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mcart-jar-'))
  const put = (relative, bytes) => {
    const target = nodePath.join(stage, relative)
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
    nodeFs.writeFileSync(target, bytes)
  }
  put('assets/' + namespace + '/textures/block/x.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  put('assets/' + namespace + '/lang/en_us.json', Buffer.from('{"block.' + namespace + '.x":"X"}\n'))
  // 中文名：Windows 上 Python 的 stdio 默认是 GBK，而宿主按 UTF-8 解 —— 名字会变乱码。
  // 实测症状：面板自己的字正常，只有"读出来的名字"是 `����ʯ`。
  put('assets/' + namespace + '/lang/zh_cn.json',
    Buffer.from('{"block.' + namespace + '.x":"星陨石"}\n', 'utf8'))
  put('assets/' + namespace + '/models/block/x.json', Buffer.from('{"parent":"block/cube_all"}\n'))
  // blockstates 是**必需**的：抽取器按它数方块，而面板只认 blocks>0 的命名空间。
  // 少这一样，一个"看着没问题"的 jar 会让整条链回空 —— 第一版夹具就是这么骗过我一次。
  put('assets/' + namespace + '/blockstates/x.json', Buffer.from('{"variants":{"":{"model":"' + namespace + ':block/x"}}}\n'))
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true })
  // 用 python 的 zipfile 打（这里一定有 python —— 没有它这条门禁本身就跑不了）
  execFileSync(pythonForTest(), ['-c', [
    'import os,sys,zipfile',
    'stage,out=sys.argv[1],sys.argv[2]',
    'z=zipfile.ZipFile(out,"w")',
    '[z.write(os.path.join(root,f), os.path.relpath(os.path.join(root,f),stage)) for root,_,files in os.walk(stage) for f in files]',
    'z.close()',
  ].join(';'), stage, path])
  nodeFs.rmSync(stage, { recursive: true, force: true })
}

/**
 * `ctx.subprocess` 的桩 —— 但它是**真起进程**（node:child_process），形状照
 * dsh-subprocess 的契约（argv/cwd/stdio+collect/spawn 回句柄、句柄有 done 与 collected）。
 *
 * 为什么要有这个桩：用户桌面端实测 —— 会话里的 `pwsh` 工具好用，但面板在宿主层
 * `ctx.get('shell')` 是 undefined，于是所有探测都回 `exitCode: null`（"找不到 Python"那段
 * 报错里每一项都写着 exit=null）。面板必须能在**没有 shell 服务**的宿主上跑，
 * 靠的就是这条 argv 路。
 */
function makeSubprocess() {
  const childProcess = require('child_process')
  const reader = (chunks) => ({ readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8'), nextOffset: 0, lossy: false }) })
  // Windows 上可执行名要带扩展名去 PATH 里找（`python` 其实是 `python.exe`）。
  // 少了这一层，这个桩在原生 Windows 上一个都解析不出来，那条"没有 shell 服务"的
  // 用例就红成了假的（桌面端真机上 bundled python 本来就是绝对路径）。
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  return {
    async resolveExecutable(command) {
      if (command.includes('/') || command.includes('\\')) return command
      for (const dir of String(process.env.PATH || '').split(nodePath.delimiter)) {
        if (dir === '') continue
        for (const ext of exts) {
          const candidate = nodePath.join(dir, command + ext)
          if (nodeFs.existsSync(candidate)) return candidate
        }
      }
      throw new Error('not found: ' + command)
    },
    spawn(spec) {
      const child = childProcess.spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = [], err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code })))
      return { stdin: undefined, stdout: child.stdout, stderr: child.stderr, control: undefined,
        collected: { stdout: reader(out), stderr: reader(err) }, done: done,
        terminate: () => child.kill(), waitForExit: async () => true }
    },
  }
}

/** 门禁自己用的 Python：系统 PATH 里的第一个能跑的。 */
function pythonForTest() {
  for (const candidate of ['python3', 'python']) {
    try {
      const out = execFileSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8' }).trim()
      if (out === '1') return candidate
    } catch (error) { /* 试下一个 */ }
  }
  console.log('  FAIL 这台机器上没有可用的 Python 3 —— 参考目录这条路本来就跑不了，门禁不会假装通过')
  process.exit(1)
}

async function main() {
  pythonForTest()
  const WORK = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mcart-engine-'))
  const project = nodePath.join(WORK, 'proj')
  nodeFs.mkdirSync(nodePath.join(project, 'pack', 'assets', 'proj', 'textures', 'block'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(project, 'mc-art.atlas.json'),
    JSON.stringify({ schema: 'mc-art.atlas/1', namespace: 'proj', biomes: [], structures: [], entities: [], blocks: [] }))
  const ref = nodePath.join(WORK, 'ref')
  makeJar(nodePath.join(ref, 'versions', '1.18.2', 'mods', 'probe.jar'), 'probemod')

  // 关键：工程在 /tmp 下，往上**没有** tools/ —— 正是用户那种布局。
  const mod = require('./run.js')
  // 这条链要**执行** Python，所以门禁得给它一个能跑的 shell（0.1.x/0.2.0-rc 两代都行的那套）。
  const shell = require('./run.js').shellService
  const source = require('fs').readFileSync(process.env.MCART_HOST || nodePath.join(__dirname, 'host.js'), 'utf8')
  let patched = source.replace("        push(pkg + '/python/' + base)",
    "        /* --fault: 掐掉包自带的那条候选 */")
  if (process.argv.includes('--fault-utf8')) {
    // 还原编码修复：去掉宿主的 -X utf8，并要求脚本里的 reconfigure 也被去掉（模拟旧版本）
    const before = patched
    patched = patched.replace("const argv = [pythonExe].concat(pythonArgs, ['-X', 'utf8', scanner], tokens === undefined ? [] : tokens)",
      "const argv = [pythonExe].concat(pythonArgs, [scanner], tokens === undefined ? [] : tokens)")
    patched = patched.replace("const result = await runShell(python + ' -B -X utf8 ' + dialect.word(scanner) +",
      "const result = await runShell(python + ' -B ' + dialect.word(scanner) +")
    if (patched === before) {
      console.log('  FAIL --fault-utf8 没生效：宿主里找不到 -X utf8（门禁要跟着改）')
      process.exit(1)
    }
  }
  if (patched === source) {
    console.log("  FAIL 故障注入没生效：找不到 pkg + '/python/' 那条候选（门禁要跟着改）")
    process.exit(1)
  }
  if (FAULT || process.argv.includes('--fault-utf8')) {
    const path = nodePath.join(WORK, 'fault-host.js')
    nodeFs.writeFileSync(path, patched)
    process.env.MCART_HOST = path
  }
  // 故障模式下要重新 require（run.js 在模块加载时读宿主源码）
  delete require.cache[require.resolve('./run.js')]
  const fresh = require('./run.js')
  const handlers = (FAULT ? fresh : mod).buildHandlers({
    nodeFs: (FAULT ? fresh : mod).localFsShim,
    shell: shell,
    // 仓库里跑：moduleDir 指到 panel/lib（真包是 <包>/lib）。故障模式下这里指到别处，
    // 好让"包自带"以外也不残留候选。
    moduleDir: FAULT ? nodePath.join(WORK, 'nosuch', 'lib') : nodePath.join(PANEL, 'lib'),
  })

  const env = await handlers['atlas.env']({ root: project })
  if (process.env.MCART_SHOW_ENGINE === '1') {
    console.log('  [debug] scanner=' + env.scanner)
    console.log('  [debug] extractor=' + env.extractor)
    console.log('  [debug] python=' + env.python)
    console.log('  [debug] pythonCandidates=' + JSON.stringify(env.pythonCandidates))
    console.log('  [debug] moduleDir=' + env.moduleDir)
  }

  if (FAULT) {
    // 前提证明：没有"包自带"那条候选，孤立工程就找不到脚本 —— 这就是用户遇到的状态。
    check('掐掉包自带的候选之后，孤立工程找不到扫描脚本（前提成立）',
      env.scanner === null || env.scanner === undefined || String(env.scanner).indexOf('panel') >= 0 === false,
      String(env.scanner))
    nodeFs.rmSync(WORK, { recursive: true, force: true })
    console.log(failures === 0 ? '全部通过（前提成立：包必须自带引擎）' : failures + ' 项失败')
    process.exit(failures === 0 ? 0 : 1)
  }

  // 包里那份和仓库里那份必须逐字节相同 —— 否则"开发时改的"和"用户跑的"就是两个东西。
  for (const name of ['mcart_scan_refs.py', 'mcart_extract_block.py']) {
    const a = nodeFs.readFileSync(nodePath.join(REPO, 'tools', name), 'utf8')
    const b = nodeFs.readFileSync(nodePath.join(PANEL, 'python', name), 'utf8')
    check('包里那份引擎脚本和仓库里的逐字节相同（' + name + '）', a === b,
      a === b ? '' : '先跑 node panel/build.mjs')
  }
  check('扫描脚本找到了，而且用的是**包里**那一份',
    typeof env.scanner === 'string' && PACK_PYTHON.test(String(env.scanner)),
    String(env.scanner))
  check('抽取脚本也找到了（包里那份）',
    typeof env.extractor === 'string' && PACK_PYTHON.test(String(env.extractor)),
    String(env.extractor))
  check('Python 解释器解析出来了', typeof env.python === 'string' && env.python !== '', String(env.python))
  check('shell 方言是按平台定的（不再靠一次可能失败的探针）',
    env.shellProbe !== null && env.shellProbe !== undefined && typeof env.shellProbe.why === 'string',
    JSON.stringify(env.shellProbe))

  // 真跑一遍：把参考目录指到假 .minecraft，要求读出那个命名空间。
  const saved = await handlers['atlas.saveSettings']({
    root: WORK, project: 'proj', directory: ref, includeGenerated: true, includeMods: true, mods: {},
  })
  check('参考目录存进设置', saved && saved.saved === true, JSON.stringify(saved))
  const namespaces = await handlers['atlas.refNamespaces']({ root: WORK, project: 'proj' })
  check('真的从 jar 里读出了命名空间（整条链跑通）',
    namespaces && Array.isArray(namespaces.namespaces) &&
    namespaces.namespaces.some((item) => item.name === 'probemod' && item.blocks > 0),
    JSON.stringify(namespaces).slice(0, 300))

  // 名字（中文）必须原样穿过 Python → 宿主 → JSON 这条链
  const scannedNames = await handlers['atlas.refBlocks']({ root: WORK, project: 'proj', namespace: 'probemod' })
  check('中文名原样回来（Python 的 stdio 不是 UTF-8 时就会变乱码）',
    scannedNames && Array.isArray(scannedNames.blocks) &&
    scannedNames.blocks.some((item) => item.name === '星陨石'),
    JSON.stringify((scannedNames && scannedNames.blocks) || []).slice(0, 200))

  // 把子进程的 stdio 强制成区域编码（模拟他们的中文 Windows：GBK），要求仍然正确。
  // 宿主那边有 -X utf8，脚本那边 reconfigure 成 UTF-8 —— 两层任一在就够。
  // 前提证明（不靠改仓库里的文件）：同一段探针，不加 -X utf8 时**确实**会乱码。
  // 没有这一条，上面那条断言可能是空的（"无论怎样都过"）。
  const probe = 'import json;print(json.dumps({"n":"星陨石"},ensure_ascii=False))'
  const rawOut = require('child_process').execFileSync(pythonForTest(), ['-c', probe],
    { env: Object.assign({}, process.env, { PYTHONIOENCODING: 'gbk' }) }).toString('utf8')
  const pinnedOut = require('child_process').execFileSync(pythonForTest(), ['-X', 'utf8', '-c', probe],
    { env: Object.assign({}, process.env, { PYTHONIOENCODING: 'gbk' }) }).toString('utf8')
  check('前提：区域编码（gbk）下、不加 -X utf8 时中文确实会乱码（所以这条检查有意义）',
    rawOut.indexOf('星陨石') < 0, rawOut.trim().slice(0, 60))
  // 注意这里**会失败**才是事实：`-X utf8` 被环境里的 `PYTHONIOENCODING` 盖过。
  // 所以真正救场的是脚本自己 `sys.stdout.reconfigure(encoding='utf-8')`（谁也盖不过），
  // 宿主的 `-X utf8` 只是"顺手把别的 Python 程序也摆正"的第二层。两条都留着，
  // 但要知道哪一条是关键的 —— 这个断言就是写下来的那句话。
  check('前提：只有 -X utf8 时仍会被 PYTHONIOENCODING 盖过（所以关键的修复在脚本里）',
    pinnedOut.indexOf('星陨石') < 0, pinnedOut.trim().slice(0, 60))
  const reconfigured = require('child_process').execFileSync(pythonForTest(),
    ['-c', 'import sys;sys.stdout.reconfigure(encoding="utf-8")\n' + probe],
    { env: Object.assign({}, process.env, { PYTHONIOENCODING: 'gbk' }) }).toString('utf8')
  check('前提：脚本自己 reconfigure 成 utf-8 之后，同一段探针就正确了（这是关键那一层）',
    reconfigured.indexOf('星陨石') >= 0, reconfigured.trim().slice(0, 60))

  process.env.PYTHONIOENCODING = 'gbk'
  const forcedHandlers = (FAULT ? require('./run.js') : mod).buildHandlers({
    nodeFs: (FAULT ? require('./run.js') : mod).localFsShim, shell: shell,
    moduleDir: FAULT ? nodePath.join(WORK, 'nosuch', 'lib') : nodePath.join(PANEL, 'lib') })
  const forcedNames = await forcedHandlers['atlas.refBlocks']({ root: WORK, project: 'proj', namespace: 'probemod' })
  delete process.env.PYTHONIOENCODING
  check('即使子进程 stdio 被设成 gbk（中文 Windows 的默认），中文名也原样回来',
    forcedNames && Array.isArray(forcedNames.blocks) &&
    forcedNames.blocks.some((item) => item.name === '星陨石'),
    JSON.stringify((forcedNames && forcedNames.blocks) || []).slice(0, 200))

  const blocks = await handlers['atlas.refBlocks']({ root: WORK, project: 'proj', namespace: 'probemod' })
  check('块列表也读得出来（抽取器那条链）',
    blocks && Array.isArray(blocks.blocks) && blocks.blocks.length > 0,
    JSON.stringify(blocks).slice(0, 240))

  // ── 没有 shell 服务、只有 subprocess：用户桌面端那种宿主 ────────────────────
  //
  // 会话里的 pwsh 工具好用 ≠ 宿主层看得到 shell 服务。面板必须能在这条条件下跑完，
  // 否则用户看到的就是"每一项都是 exit=null"。
  console.log('--- 没有 shell 服务，只有 subprocess（桌面端那种宿主）')
  const noShellHandlers = (FAULT ? require('./run.js') : mod).buildHandlers({
    nodeFs: (FAULT ? require('./run.js') : mod).localFsShim, subprocess: makeSubprocess(),
    moduleDir: FAULT ? nodePath.join(WORK, 'nosuch', 'lib') : nodePath.join(PANEL, 'lib') })
  const noShellEnv = await noShellHandlers['atlas.env']({ root: project })
  check('没有 shell 服务时 Python 仍然解析出来（走 subprocess 的 argv）',
    typeof noShellEnv.python === 'string' && noShellEnv.python !== '' && noShellEnv.pythonVia === 'subprocess',
    'python=' + String(noShellEnv.python) + ' via=' + String(noShellEnv.pythonVia))
  check('没有 shell 服务时脚本也是从包里找到的',
    typeof noShellEnv.scanner === 'string' && PACK_PYTHON.test(String(noShellEnv.scanner)),
    String(noShellEnv.scanner))
  await noShellHandlers['atlas.saveSettings']({
    root: WORK, project: 'proj', directory: ref, includeGenerated: true, includeMods: true, mods: {},
  })
  const nsNoShell = await noShellHandlers['atlas.refNamespaces']({ root: WORK, project: 'proj' })
  check('没有 shell 服务也能从 jar 里读出命名空间',
    nsNoShell && Array.isArray(nsNoShell.namespaces) &&
    nsNoShell.namespaces.some((item) => item.name === 'probemod' && item.blocks > 0),
    JSON.stringify(nsNoShell).slice(0, 260))

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  // Python 跑过会在脚本旁边留 `__pycache__`；那是编译产物，不该跟着包走
  // （里面必然带着源码字符串，`check-private` 会正确地把它当可疑内容拦下来 —— 0.1.16 就拦过一次）。
  nodeFs.rmSync(nodePath.join(PANEL, 'python', '__pycache__'), { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error('THREW', error); process.exit(1) })
