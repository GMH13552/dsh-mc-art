#!/usr/bin/env node
/**
 * 内置 Minecraft 启动器的门禁。
 *
 * 为什么要有：启动器会**真的起进程**、**真的写盘**（natives、日志），失败方式还特别
 * 安静 —— 参数拼错一个字，JVM 报的是"找不到主类"；日志没接上，界面上就是"点了没反应"。
 * 所以这里用夹具把整条链路钉死：
 *
 *   1. 造一个假版本目录：父/子两代 JSON（`inheritsFrom`）、rules（osx 的库要被过滤掉）、
 *      natives（真的 zip，要能解出来）、各种 `${…}` 占位符、缺 `downloads` 的库（要按
 *      name 推 maven 路径）；
 *   2. 造一个假 `java.cmd`：`-version` 会答 `openjdk version "17.0.8"`（JDK 探测要真跑），
 *      真启动时把完整参数落到 `args.txt` 再退出 0；
 *   3. 断言：占位符全替换、classpath 有客户端 jar / 父库 / 子库 / maven 推出来的库、
 *      osx 库不在、natives 解出来、dryRun 不写盘不起进程、launchStatus 读到退出码、
 *      launchStop 杀得掉且**没有残留进程**。
 *
 * 真机冒烟（默认模式，最多一次）：找本机 `1.18.2-Forge_40.3.12` + Java 17，先 dryRun
 * 看 `-p` 模块路径，再真启动 ≤90 秒（日志出现 Setting user / LWJGL / OpenAL /
 * ModLauncher 任一即成功），然后 launchStop，并核对没有残留 java 进程。
 * 找不到游戏目录/Java 17 时只打印 SKIP（夹具结论仍然有效）。
 *
 *   node tools/mcart-plugin/launch-test.js
 *   node tools/mcart-plugin/launch-test.js --fault           # 删掉占位符替换 → 必须红
 *   node tools/mcart-plugin/launch-test.js --fault-natives   # 不解压 natives → 必须红
 *   node tools/mcart-plugin/launch-test.js --fault-kill      # launchStop 不杀 → 必须红
 */
const nodeFs = require('fs')
const nodePath = require('path')
const nodeOs = require('os')
const nodeCp = require('child_process')

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(__dirname, '.launch-fixture')
const HOST = nodePath.join(__dirname, 'host.js')
const FAULT = process.argv.includes('--fault')
const FAULT_NATIVES = process.argv.includes('--fault-natives')
const FAULT_KILL = process.argv.includes('--fault-kill')
const FAULT_MODE = FAULT || FAULT_NATIVES || FAULT_KILL

const SMOKE_VERSION = '1.18.2-Forge_40.3.12'
// 判据只用**强标志**：真的进到游戏里了（Setting user / LWJGL / OpenAL）。
// ModLauncher 只说明 Forge 的启动器接手了——实测过一次"ModLauncher 之后立刻崩在 Log4j"，
// 那种情况不该算成功，所以弱判据已经删掉。
const SMOKE_STRONG = ['Setting user', 'LWJGL', 'OpenAL']
const SMOKE_MARKERS = SMOKE_STRONG

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

const at = (value) => String(value === undefined || value === null ? '' : value).split(nodePath.sep).join('/')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readText = (file) => {
  try { return nodeFs.readFileSync(file, 'utf8') } catch (error) { return '' }
}
const writeText = (file, text) => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
  nodeFs.writeFileSync(file, text, 'utf8')
}

// ── 造夹具 ────────────────────────────────────────────────────────────────────
function makeStoredZip(file, entries) {
  const tables = (() => {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
      table[index] = value >>> 0
    }
    return table
  })()
  const crc32 = (buffer) => {
    let value = 0xffffffff
    for (const byte of buffer) value = (value >>> 8) ^ tables[(value ^ byte) & 0xff]
    return (value ^ 0xffffffff) >>> 0
  }
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, data)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8)
    directory.writeUInt16LE(0, 10)
    directory.writeUInt16LE(0, 12)
    directory.writeUInt16LE(0, 14)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(data.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const centralStart = offset
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
  nodeFs.writeFileSync(file, Buffer.concat(local.concat([centralBuffer, end])))
}

function touch(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
  nodeFs.writeFileSync(file, text === undefined ? '' : text)
}

/** 夹具：假游戏根 + 假项目 + 两个假 java。 */
function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const root = WORK
  const game = nodePath.join(root, 'game')
  const proj = nodePath.join(root, 'proj')
  const javaDir = nodePath.join(root, 'java')
  const gameDir = nodePath.join(root, 'run')

  // 项目（日志落在项目目录里）：只要 mc-art.atlas.json 就够 launchProjectDir 认。
  touch(nodePath.join(proj, 'mc-art.atlas.json'), '{\n  "schema": "mc-art.atlas/1",\n  "namespace": "demo"\n}\n')
  nodeFs.mkdirSync(nodePath.join(proj, 'pack', 'assets', 'demo'), { recursive: true })

  // 假游戏根
  nodeFs.mkdirSync(nodePath.join(game, 'versions', 'parent'), { recursive: true })
  nodeFs.mkdirSync(nodePath.join(game, 'versions', 'fixture'), { recursive: true })
  nodeFs.mkdirSync(nodePath.join(game, 'assets', 'indexes'), { recursive: true })
  touch(nodePath.join(game, 'assets', 'indexes', '1.18.json'), '{}\n')
  touch(nodePath.join(game, 'versions', 'fixture', 'fixture.jar'), 'fake client jar\n')

  // 库：父库 / 子库 / 缺 downloads（要按 name 推 maven）/ osx-only（要被 rules 掉）/
  //     同时带 artifact 与 natives 的 lwjgl（artifact 进 classpath，classifier 解压）
  touch(nodePath.join(game, 'libraries', 'com', 'example', 'parentlib', '1.0', 'parentlib-1.0.jar'))
  touch(nodePath.join(game, 'libraries', 'com', 'example', 'childlib', '2.0', 'childlib-2.0.jar'))
  touch(nodePath.join(game, 'libraries', 'com', 'example', 'nodownloads', '3.0', 'nodownloads-3.0.jar'))
  touch(nodePath.join(game, 'libraries', 'com', 'example', 'osxonly', '1.0', 'osxonly-1.0.jar'))
  touch(nodePath.join(game, 'libraries', 'org', 'lwjgl', 'lwjgl', '3.2.2', 'lwjgl-3.2.2.jar'))
  makeStoredZip(nodePath.join(game, 'libraries', 'org', 'lwjgl', 'lwjgl', '3.2.2', 'lwjgl-3.2.2-natives-windows.jar'),
    [{ name: 'test-natives.txt', data: 'natives-ok' }])

  const parentJson = {
    id: 'parent',
    mainClass: 'com.example.ParentMain',
    type: 'release',
    assets: '1.18',
    assetIndex: { id: '1.18' },
    javaVersion: { component: 'java-runtime-beta', majorVersion: 17 },
    libraries: [
      { name: 'com.example:parentlib:1.0', downloads: { artifact: { path: 'com/example/parentlib/1.0/parentlib-1.0.jar' } } },
      {
        name: 'org.lwjgl:lwjgl:3.2.2',
        downloads: {
          artifact: { path: 'org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar' },
          classifiers: { 'natives-windows': { path: 'org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar' } },
        },
        natives: { windows: 'natives-windows' },
      },
      {
        name: 'com.example:osxonly:1.0',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: { artifact: { path: 'com/example/osxonly/1.0/osxonly-1.0.jar' } },
      },
    ],
    arguments: {
      jvm: ['-Dparent.prop=${version_name}', '-Dparent.libdir=${library_directory}'],
      game: ['--parentArg', '${auth_player_name}'],
    },
  }
  writeText(nodePath.join(game, 'versions', 'parent', 'parent.json'), JSON.stringify(parentJson, null, 2) + '\n')

  const childJson = {
    id: 'fixture',
    inheritsFrom: 'parent',
    mainClass: 'com.example.FixtureMain',
    type: 'release',
    libraries: [
      { name: 'com.example:childlib:2.0', downloads: { artifact: { path: 'com/example/childlib/2.0/childlib-2.0.jar' } } },
      { name: 'com.example:nodownloads:3.0' },
    ],
    arguments: {
      jvm: [
        '-cp', '${classpath}',
        '-Dnatives=${natives_directory}',
        '-Dlibdir=${library_directory}',
        '-DgameDir=${game_directory}',
        '-Dassets=${assets_root}',
        '-Dindex=${assets_index_name}',
        '-Dlauncher=${launcher_name}/${launcher_version}',
        '-Dsep=${classpath_separator}',
      ],
      game: [
        '--username', '${auth_player_name}',
        '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}',
        '--userType', '${user_type}',
        '--versionType', '${version_type}',
        '--version', '${version_name}',
        '--gameDir', '${game_directory}',
        '--assetsDir', '${assets_root}',
        '--assetIndex', '${assets_index_name}',
        '--clientid', '${clientid}',
      ],
    },
  }
  writeText(nodePath.join(game, 'versions', 'fixture', 'fixture.json'), JSON.stringify(childJson, null, 2) + '\n')

  // 假 java：`-version` 要答得像 17（JDK 探测真的会跑它），真启动时把参数落到 args.txt。
  nodeFs.mkdirSync(javaDir, { recursive: true })
  writeText(nodePath.join(javaDir, 'java.cmd'), [
    '@echo off',
    'set "OUT=%~dp0args.txt"',
    'if "%1"=="-version" set "OUT=%~dp0args-version.txt"',
    'echo %* > "%OUT%"',
    'if "%1"=="-version" echo openjdk version "17.0.8" 2023-07-18 LTS 1>&2',
    'if "%1"=="-version" echo OpenJDK Runtime Environment 1>&2',
    'exit /b 0',
    '',
  ].join('\r\n'))
  writeText(nodePath.join(javaDir, 'java-slow.cmd'), [
    '@echo off',
    'if "%1"=="-version" echo openjdk version "17.0.8" 2023-07-18 LTS 1>&2',
    'if "%1"=="-version" exit /b 0',
    'echo %* > "%~dp0args-slow.txt"',
    'ping -n 90 127.0.0.1 > nul',
    'exit /b 0',
    '',
  ].join('\r\n'))

  nodeFs.mkdirSync(gameDir, { recursive: true })
  return {
    root: root, game: game, proj: proj, java: nodePath.join(javaDir, 'java.cmd'),
    javaSlow: nodePath.join(javaDir, 'java-slow.cmd'), gameDir: gameDir,
    argsFile: nodePath.join(javaDir, 'args.txt'),
    argsSlowFile: nodePath.join(javaDir, 'args-slow.txt'),
    marker: at(game),
  }
}

// ── subprocess 桩：和真宿主同形状（spawn → handle{collected,done,terminate,waitForExit}）──
function makeSubprocess() {
  const collector = () => {
    const chunks = []
    let total = 0
    return {
      push(chunk) { chunks.push(chunk); total += chunk.length },
      readFrom(fromByte) {
        const buffer = Buffer.concat(chunks)
        const start = Math.max(0, Math.min(buffer.length, Number(fromByte) || 0))
        return { text: buffer.subarray(start).toString('utf8'), nextOffset: buffer.length, lossy: false }
      },
    }
  }
  return {
    spawn(spec) {
      const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.argv[0])
      const child = nodeCp.spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: Object.assign({}, process.env, spec.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: isBatch,
        detached: process.platform !== 'win32',
      })
      const stdout = collector()
      const stderr = collector()
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      let settled = false
      let settle = null
      const done = new Promise((resolve) => { settle = resolve })
      const finish = (outcome) => {
        if (settled) return
        settled = true
        settle(outcome)
      }
      child.on('error', () => finish({ exitCode: null, signal: null }))
      child.on('exit', (code, signal) => finish({ exitCode: code, signal: signal }))
      const terminate = () => {
        if (process.platform === 'win32') {
          try { nodeCp.spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }) } catch (error) { /* 已退出 */ }
        } else {
          try { process.kill(-child.pid, 'SIGTERM') } catch (error) { try { process.kill(child.pid, 'SIGKILL') } catch (again) { /* 已退出 */ } }
        }
      }
      return {
        stdout: child.stdout, stderr: child.stderr,
        collected: { stdout: stdout, stderr: stderr },
        done: done, terminate: terminate,
        waitForExit: async () => { await done; return true },
      }
    },
    async resolveExecutable(name) {
      // 只给 PATH 解析一个最小的形状；夹具里的 java 走绝对路径，不经过这里。
      return name
    },
  }
}

// ── 进程核对（冒烟/停止都必须证明"没有残留"）────────────────────────────────
function processesMatching(marker) {
  if (marker === '') return []
  if (process.platform === 'win32') {
    // 排除自己：这条 PowerShell 的命令行里带着 marker 字符串，不排除就永远"有残留"。
    const script = "$me=$PID; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null"
      + " -and $_.ProcessId -ne $me -and $_.CommandLine.Contains('"
      + String(marker).split("'").join("''")
      + "') -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name }"
    const done = nodeCp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true })
    return String(done.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  }
  const done = nodeCp.spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 20000 })
  return String(done.stdout || '').split(/\r?\n/).filter((line) => line.indexOf(marker) >= 0)
}

function killMatching(marker) {
  for (const row of processesMatching(marker)) {
    const pid = Number(String(row).split(/\s+/)[0])
    if (!(pid > 0)) continue
    try {
      if (process.platform === 'win32') nodeCp.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true })
      else process.kill(pid, 'SIGKILL')
    } catch (error) { /* 可能已经退出 */ }
  }
}

function processAlive(pid) {
  if (!(Number(pid) > 0)) return false
  if (process.platform === 'win32') {
    const done = nodeCp.spawnSync('tasklist', ['/FI', 'PID eq ' + String(pid), '/NH'], { encoding: 'utf8', windowsHide: true })
    return String(done.stdout || '').indexOf(String(pid)) >= 0
  }
  try { process.kill(Number(pid), 0); return true } catch (error) { return false }
}

// ── 故障注入：改的是**真实宿主源码的副本**，不是复制的实现 ──────────────────
function applyFault(source) {
  if (FAULT) {
    const anchor = 'function launchSubstitute(text, values) {'
    if (source.indexOf(anchor) < 0) throw new Error('故障注入失败：找不到 launchSubstitute（门禁要跟着改）')
    return source.replace(anchor, anchor + ' return String(text)')
  }
  if (FAULT_NATIVES) {
    const anchor = 'async function launchExtractZip(jar, dest, workspaceRoot) {'
    if (source.indexOf(anchor) < 0) throw new Error('故障注入失败：找不到 launchExtractZip（门禁要跟着改）')
    return source.replace(anchor, anchor + " return { ok: false, detail: 'fault: 不解压' }")
  }
  if (FAULT_KILL) {
    const anchor = 'async function launchStop(state) {'
    if (source.indexOf(anchor) < 0) throw new Error('故障注入失败：找不到 launchStop（门禁要跟着改）')
    return source.replace(anchor, anchor + " return { stopped: true, exitCode: state === null ? null : state.exitCode, detail: 'fault: 没杀' }")
  }
  return source
}

// ── 真机冒烟：找本机的 1.18.2 Forge + Java 17 ────────────────────────────────
function findSmokeGameRoot() {
  const candidates = []
  const push = (value) => {
    const text = at(value)
    if (text === '' || candidates.indexOf(text) >= 0) return
    candidates.push(text)
  }
  if (typeof process.env.MCART_SMOKE_GAME_ROOT === 'string' && process.env.MCART_SMOKE_GAME_ROOT !== '') {
    push(process.env.MCART_SMOKE_GAME_ROOT)
  }
  const home = process.env.USERPROFILE || process.env.HOME || nodeOs.homedir()
  const appdata = process.env.APPDATA || ''
  if (appdata !== '') push(nodePath.join(appdata, '.minecraft'))
  push(nodePath.join(home, '.minecraft'))
  push(nodePath.join(REPO, '.minecraft'))
  push(nodePath.join(nodePath.dirname(REPO), '.minecraft'))
  // 整合包目录（`~/Release 2.8.3/.minecraft` 这种）—— 用户目录下一层，量小且常见。
  try {
    for (const entry of nodeFs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      push(nodePath.join(home, entry.name, '.minecraft'))
    }
  } catch (error) { /* 读不了用户目录就当没有 */ }
  for (const candidate of candidates) {
    if (nodeFs.existsSync(nodePath.join(candidate, 'versions', SMOKE_VERSION))) return candidate
  }
  return ''
}

async function main() {
  const fixture = buildFixture()

  // 故障注入必须在 require('./run.js') 之前定好 MCART_HOST（run.js 加载时读）。
  let source = nodeFs.readFileSync(process.env.MCART_HOST || HOST, 'utf8')
  if (FAULT_MODE) {
    const patched = applyFault(source)
    touch(nodePath.join(WORK, 'fault-host.js'), patched)
    process.env.MCART_HOST = nodePath.join(WORK, 'fault-host.js')
  }
  const { buildHandlers, fsService, localFsShim } = require('./run.js')
  const handlers = buildHandlers({ fs: fsService, nodeFs: localFsShim, subprocess: makeSubprocess() })
  const call = (name, args) => handlers[name](args === undefined ? {} : args)

  const gameRoot = at(fixture.game)
  const projectRoot = at(fixture.root)
  const logFile = at(nodePath.join(fixture.proj, 'mc-art.launch.log'))
  let startedPid = 0
  let slowPid = 0
  let smokeMarker = ''

  try {
    if (FAULT_MODE) console.log('（故障注入生效：' + (FAULT ? '占位符不替换' : FAULT_NATIVES ? 'natives 不解压' : 'launchStop 不杀进程') + '）')
    console.log('--- 1. atlas.launchTargets（游戏根 / 版本 / JDK 真探测）')
    const targets = await call('atlas.launchTargets', { root: projectRoot, project: 'proj', gameRoot: gameRoot })
    check('找到夹具游戏根', Array.isArray(targets.gameRoots) && targets.gameRoots.map(at).indexOf(gameRoot) >= 0,
      JSON.stringify(targets.gameRoots))
    const version = (targets.versions || []).filter((item) => item.id === 'fixture')[0]
    check('版本条目：hasJar / mainClass / inheritedFrom',
      version !== undefined && version.hasJar === true && version.mainClass === 'com.example.FixtureMain'
      && version.inheritedFrom === 'parent', JSON.stringify(version))
    check('版本条目带 javaMajor（从 javaVersion.majorVersion 读）',
      version !== undefined && version.javaMajor === 17, JSON.stringify(version === undefined ? null : version.javaMajor))
    check('JDK 探测真的跑了：可用的都解析出 major，失败的带原因',
      Array.isArray(targets.javas) && targets.javas.every((item) => Number(item.major) > 0)
      && (targets.javas.length > 0 || (targets.javaRejected || []).length > 0),
      JSON.stringify({ javas: (targets.javas || []).length, rejected: (targets.javaRejected || []).length }))
    check('JDK 探测把 17 排在最前（1.18.2 这一代要它）',
      (targets.javas || []).length === 0 || targets.javas[0].major === 17 || !targets.javas.some((item) => item.major === 17),
      JSON.stringify((targets.javas || []).map((item) => item.major)))

    console.log('--- 2. atlas.launch dryRun（只拼参数，不写盘不起进程）')
    const dry = await call('atlas.launch', {
      root: projectRoot, project: 'proj', gameRoot: gameRoot, versionId: 'fixture',
      javaPath: at(fixture.java), gameDir: at(fixture.gameDir), memoryMb: 8192, dryRun: true,
    })
    check('dryRun 回参数数组 + mainClass', dry.dryRun === true && Array.isArray(dry.args)
      && dry.mainClass === 'com.example.FixtureMain', JSON.stringify(dry.error))
    const args = Array.isArray(dry.args) ? dry.args : []
    const cpAt = args.indexOf('-cp')
    const classpath = cpAt >= 0 ? String(args[cpAt + 1]) : ''
    check('参数里有 -cp 且正好在 mainClass 前面',
      cpAt >= 0 && args[cpAt + 2] === 'com.example.FixtureMain', args.slice(0, 4).join(' '))
    check('classpath 含客户端 jar', classpath.indexOf(at(nodePath.join(fixture.game, 'versions', 'fixture', 'fixture.jar'))) >= 0,
      classpath.slice(0, 120))
    check('classpath 含父库 / 子库', classpath.indexOf('parentlib-1.0.jar') >= 0 && classpath.indexOf('childlib-2.0.jar') >= 0)
    check('缺 downloads 的库按 name 推出 maven 路径', classpath.indexOf('nodownloads/3.0/nodownloads-3.0.jar') >= 0,
      classpath.slice(0, 200))
    check('osx 专用库被 rules 过滤掉', classpath.indexOf('osxonly') < 0)
    check('占位符全部替换（没有 ${…} 残留）',
      !args.some((arg) => String(arg).indexOf('${') >= 0) && Array.isArray(dry.leftover) && dry.leftover.length === 0,
      JSON.stringify((dry.leftover || []).concat(args.filter((arg) => String(arg).indexOf('${') >= 0).slice(0, 2))))
    check('父版本的 arguments 被合进来（jvm + game）',
      args.some((arg) => String(arg).indexOf('-Dparent.prop=fixture') >= 0)
      && args.some((arg) => String(arg) === '--parentArg') && args.some((arg) => String(arg) === 'Player'))
    check('内存由 memoryMb 决定（8 GB）', args.indexOf('-Xmx8192m') >= 0 && args.indexOf('-Xms2048m') >= 0,
      args.filter((arg) => /^-Xm/.test(String(arg))).join(' '))
    check('gameDir / assets / assetIndex 都替换成绝对路径',
      args.some((arg) => String(arg) === at(fixture.gameDir))
      && args.some((arg) => String(arg).indexOf(at(nodePath.join(fixture.game, 'assets'))) >= 0)
      && args.some((arg) => String(arg) === '--assetIndex') && args.some((arg) => String(arg) === '1.18'))
    check('natives 只列了 windows 那一条', (dry.nativesList || []).length === 1
      && String(dry.nativesList[0]).indexOf('lwjgl-3.2.2-natives-windows.jar') >= 0, JSON.stringify(dry.nativesList))
    check('dryRun 不建 natives 目录、不起进程',
      dry.nativesDir !== null && !nodeFs.existsSync(dry.nativesDir)
      && (await call('atlas.launchStatus', {})).running === false)

    console.log('--- 3. 真启动（假 java：参数落盘后退出 0）+ 读退出码 + natives 解压')
    const launched = await call('atlas.launch', {
      root: projectRoot, project: 'proj', gameRoot: gameRoot, versionId: 'fixture',
      javaPath: at(fixture.java), gameDir: at(fixture.gameDir), memoryMb: 4,
    })
    check('真启动返回 pid / startedAt', Number(launched.pid) > 0 && typeof launched.startedAt === 'string',
      JSON.stringify({ pid: launched.pid, error: launched.error }))
    startedPid = Number(launched.pid) || 0
    let status = null
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await call('atlas.launchStatus', {})
      if (status.running !== true) break
      await sleep(100)
    }
    check('launchStatus 读到退出码 0', status !== null && status.exitCode === 0, JSON.stringify(status === null ? null : status.exitCode))
    check('launchStatus 的日志尾巴带 pid 与退出行', Array.isArray(status.tail)
      && status.tail.some((line) => line.indexOf('[mc-art] pid=') >= 0)
      && status.tail.some((line) => line.indexOf('[mc-art] exit code=0') >= 0), JSON.stringify(status.tail.slice(0, 3)))
    check('日志写在项目目录（mc-art.launch.log）', at(status.logFile) === logFile, at(status.logFile))
    const recorded = readText(fixture.argsFile)
    check('假 java 收到的参数里没有 ${…}', recorded !== '' && recorded.indexOf('${') < 0, recorded.slice(0, 160))
    check('假 java 收到的参数含 -cp 与 mainClass', /(?:^|\s)-cp(?:\s|$)/.test(recorded) && recorded.indexOf('com.example.FixtureMain') >= 0,
      recorded.slice(0, 160))
    check('natives 解压出来了（test-natives.txt = natives-ok）',
      nodeFs.existsSync(nodePath.join(dry.nativesDir, 'test-natives.txt'))
      && readText(nodePath.join(dry.nativesDir, 'test-natives.txt')) === 'natives-ok')
    check('natives marker 写了（下次跳过解压）', nodeFs.existsSync(nodePath.join(dry.nativesDir, '.mcart-natives.json')))

    console.log('--- 4. launchStop（先温和后强杀整棵树）+ 没有残留进程')
    const slow = await call('atlas.launch', {
      root: projectRoot, project: 'proj', gameRoot: gameRoot, versionId: 'fixture',
      javaPath: at(fixture.javaSlow), gameDir: at(fixture.gameDir), memoryMb: 4,
    })
    slowPid = Number(slow.pid) || 0
    check('慢速假 java 起来了', slowPid > 0, JSON.stringify(slow.error))
    await sleep(800)
    const runningStatus = await call('atlas.launchStatus', {})
    check('运行中 running=true 且 pid 一致', runningStatus.running === true && Number(runningStatus.pid) === slowPid,
      JSON.stringify({ running: runningStatus.running, pid: runningStatus.pid }))
    const second = await call('atlas.launch', {
      root: projectRoot, project: 'proj', gameRoot: gameRoot, versionId: 'fixture',
      javaPath: at(fixture.java), gameDir: at(fixture.gameDir), memoryMb: 4,
    })
    check('同一时间只允许一个游戏（第二次启动被人话拒绝）',
      second.error !== undefined && /已经有一个游戏在跑/.test(String(second.error)), String(second.error))
    const stopped = await call('atlas.launchStop', {})
    check('launchStop 回 stopped:true', stopped.stopped === true, JSON.stringify(stopped))
    const after = await call('atlas.launchStatus', {})
    check('停止后 running=false', after.running === false, JSON.stringify({ running: after.running, exitCode: after.exitCode }))
    check('停止后没有残留进程（命令行还带着夹具路径的都算）', processesMatching(fixture.marker).length === 0,
      JSON.stringify(processesMatching(fixture.marker).slice(0, 3)))
    check('停止后 launchStop 不会假装成功（再调一次说没有在跑）', (await call('atlas.launchStop', {})).stopped !== true)

    console.log('--- 5. 日志只保留尾部 200 行')
    // 用一个**新的**启动状态来测截断：上一个状态在退出后已经被 status 收过一次尾了。
    const quiet = await call('atlas.launch', {
      root: projectRoot, project: 'proj', gameRoot: gameRoot, versionId: 'fixture',
      javaPath: at(fixture.java), gameDir: at(fixture.gameDir), memoryMb: 4096,
    })
    check('（截断测试用）快速假 java 又起了一次', Number(quiet.pid) > 0, JSON.stringify(quiet.error))
    await sleep(1500)
    const bigLog = nodePath.join(fixture.proj, 'mc-art.launch.log')
    nodeFs.writeFileSync(bigLog, Array.from({ length: 500 }, (_, index) => 'line ' + String(index)).join('\n') + '\n', 'utf8')
    const trimmed = await call('atlas.launchStatus', {})
    check('launchStatus 把日志收成 200 行', readText(bigLog).split('\n').filter((line) => line !== '').length === 200,
      String(readText(bigLog).split('\n').filter((line) => line !== '').length))
    check('日志尾巴最多 80 行', Array.isArray(trimmed.tail) && trimmed.tail.length <= 80, String((trimmed.tail || []).length))

    // ── 真机冒烟（只在默认模式跑；故障注入时不碰真游戏）────────────────────
    if (FAULT_MODE) {
      console.log('--- 6. 真机冒烟：故障注入模式跳过')
    } else {
      console.log('--- 6. 真机冒烟（1.18.2-Forge_40.3.12 + Java 17，≤90 秒）')
      const smokeGameRoot = findSmokeGameRoot()
      if (smokeGameRoot === '') {
        console.log('  SKIP 没找到带 ' + SMOKE_VERSION + ' 的游戏根（可用 MCART_SMOKE_GAME_ROOT 指定）')
      } else {
        smokeMarker = smokeGameRoot
        // 游戏要往 gameDir 里写 logs/config/mods。有些环境里这个 JDK 的完整性级别
        // 只写得进项目目录（本机就是：Mojang runtime 在 %APPDATA% 下、带 Low 标签，
        // 写 .minecraft 会被拒），所以允许用 MCART_SMOKE_GAME_DIR 指一个它写得进去的
        // 目录（模组开发通常就是项目里的 run/）。
        const smokeGameDir = typeof process.env.MCART_SMOKE_GAME_DIR === 'string'
          ? at(process.env.MCART_SMOKE_GAME_DIR) : ''
        if (smokeGameDir !== '') {
          nodeFs.mkdirSync(process.env.MCART_SMOKE_GAME_DIR, { recursive: true })
          console.log('  冒烟 gameDir = ' + smokeGameDir + '（来自 MCART_SMOKE_GAME_DIR）')
        } else {
          console.log('  冒烟 gameDir = 游戏根（默认）；若 JDK 写不了它会自动 SKIP，并提示设 MCART_SMOKE_GAME_DIR')
        }
        const smokeProject = nodePath.join(WORK, 'smoke')
        touch(nodePath.join(smokeProject, 'mc-art.atlas.json'), '{\n  "schema": "mc-art.atlas/1",\n  "namespace": "smoke"\n}\n')
        nodeFs.mkdirSync(nodePath.join(smokeProject, 'pack', 'assets', 'smoke'), { recursive: true })
        const smokeTargets = await call('atlas.launchTargets', { root: at(WORK), project: 'smoke', gameRoot: smokeGameRoot })
        const java17 = (smokeTargets.javas || []).filter((item) => item.major === 17)[0]
        check('冒烟：本机探测到 Java 17', java17 !== undefined,
          JSON.stringify((smokeTargets.javas || []).map((item) => item.major)))
        if (java17 !== undefined) {
          const drySmoke = await call('atlas.launch', {
            root: at(WORK), project: 'smoke', gameRoot: smokeGameRoot, versionId: SMOKE_VERSION,
            javaPath: java17.path, gameDir: smokeGameDir, memoryMb: 4096, dryRun: true,
          })
          check('冒烟 dryRun：Forge 的 -p 模块路径拼出来了（BootstrapLauncher 靠它找模块）',
            Array.isArray(drySmoke.args) && drySmoke.args.indexOf('-p') >= 0
            && drySmoke.args.some((arg) => String(arg).indexOf('bootstraplauncher') >= 0)
            && drySmoke.args.some((arg) => String(arg).indexOf('securejarhandler') >= 0),
            JSON.stringify((drySmoke.args || []).filter((arg) => String(arg).indexOf('bootstraplauncher') >= 0).slice(0, 1)))
          check('冒烟 dryRun：占位符全部替换', Array.isArray(drySmoke.leftover) && drySmoke.leftover.length === 0,
            JSON.stringify(drySmoke.leftover))
          check('冒烟 dryRun：mainClass 是 BootstrapLauncher', drySmoke.mainClass === 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            String(drySmoke.mainClass))
          if (drySmoke.error === undefined || drySmoke.error === null) {
            const begun = Date.now()
            const real = await call('atlas.launch', {
              root: at(WORK), project: 'smoke', gameRoot: smokeGameRoot, versionId: SMOKE_VERSION,
              javaPath: java17.path, gameDir: smokeGameDir, memoryMb: 4096,
            })
            check('冒烟：真启动拿到 pid', Number(real.pid) > 0, JSON.stringify({ pid: real.pid, error: real.error }))
            let found = ''
            let lastStatus = null
            let smokeLog = ''
            if (Number(real.pid) > 0) {
              while (Date.now() - begun < 90000) {
                lastStatus = await call('atlas.launchStatus', { lines: 400 })
                smokeLog = readText(lastStatus.logFile)
                // 先等强判据（真的进游戏了）；到 90 秒还只有 ModLauncher 也算过。
                const strong = SMOKE_STRONG.filter((marker) => smokeLog.indexOf(marker) >= 0)[0]
                if (strong !== undefined) { found = strong; break }
                if (lastStatus.running !== true) break
                await sleep(1000)
              }
            }
            const head = smokeLog.split(/\r?\n/).filter((line) => line !== '').slice(0, 10)
            console.log('  日志头几行：')
            for (const line of head) console.log('    | ' + line.slice(0, 200))
            if (found === '' && /AccessDeniedException|拒绝访问|Access is denied/i.test(smokeLog)) {
              // 环境限制（不是启动器拼错）：JDK 写不了 gameDir。给出可复现的下一步。
              console.log('  SKIP 真机冒烟：这个 JDK 写不了 gameDir（日志里是 AccessDenied）。'
                + '游戏起不来不是参数问题，换成它写得进去的目录再测：'
                + 'set MCART_SMOKE_GAME_DIR=<项目>\\run 之后重跑本门禁。')
            } else {
              check('冒烟：日志出现启动标志（' + (found === '' ? SMOKE_MARKERS.join(' / ') : found) + '）', found !== '',
                '用时 ' + String(Math.round((Date.now() - begun) / 1000)) + 's')
            }
            if (lastStatus !== null) {
              console.log('  冒烟状态：running=' + String(lastStatus.running) + ' exitCode=' + String(lastStatus.exitCode)
                + ' pid=' + String(lastStatus.pid))
            }
            // 不管成没成都收尾：先 launchStop，再核对没有残留 java 进程。
            let stopResult = null
            try { stopResult = await call('atlas.launchStop', {}) } catch (error) { stopResult = { detail: String(error && error.message ? error.message : error) } }
            console.log('  冒烟收尾：launchStop → ' + JSON.stringify(stopResult))
            await sleep(1500)
            const leftovers = processesMatching(smokeMarker)
            if (leftovers.length > 0) killMatching(smokeMarker)
            check('冒烟收尾：没有残留 java 进程', processesMatching(smokeMarker).length === 0, JSON.stringify(leftovers.slice(0, 3)))
            check('冒烟收尾：launchStatus 说不在跑',
              (await call('atlas.launchStatus', {})).running !== true)
          }
        }
      }
    }
  } catch (error) {
    check('门禁本身没炸：' + String(error && error.stack ? error.stack.split('\n')[0] : error), false)
    console.error(error)
  } finally {
    // 无论如何都不许把进程留在后台。
    try { await call('atlas.launchStop', {}) } catch (error) { /* 可能没有在跑的 */ }
    for (const marker of [fixture.marker, smokeMarker]) {
      if (marker === '') continue
      const leftovers = processesMatching(marker)
      if (leftovers.length > 0) {
        console.log('  清理残留进程：' + JSON.stringify(leftovers.slice(0, 3)))
        killMatching(marker)
      }
    }
    if (startedPid > 0 && processAlive(startedPid)) {
      try { if (process.platform === 'win32') nodeCp.spawnSync('taskkill', ['/T', '/F', '/PID', String(startedPid)], { windowsHide: true }) } catch (error) { /* ignore */ }
    }
    nodeFs.rmSync(WORK, { recursive: true, force: true })
  }

  if (FAULT_MODE) {
    // 故障注入的对照：注入的坏行为必须被上面的断言抓住（红 = exit 1）。
    const caught = failures > 0
    console.log('\n' + (caught
      ? '故障注入被抓住：' + String(failures) + ' 条断言变红 → 退出码 1（红）'
      : '门禁没抓到注入的违规：退出码 2（门禁失效，要修）'))
    process.exit(caught ? 1 : 2)
  }
  console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('THREW', error)
  try { nodeFs.rmSync(WORK, { recursive: true, force: true }) } catch (cleanup) { /* ignore */ }
  process.exit(1)
})
