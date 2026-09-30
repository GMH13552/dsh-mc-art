#!/usr/bin/env node
/**
 * shell 方言门禁：面板在 **Windows（PowerShell）** 上发出的命令，真能用吗？
 *
 * 为什么需要它：DSH 按平台换 shell——POSIX 上是 `bash -c`，Windows 上是
 * `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`（dsh-base 的
 * cordis.patch.yml 里 bash 那几行在 win32 上 disabled、pwsh 那几行启用）。
 * 面板宿主原来写死了 `$(printf … | base64 -d)`、`rm -f`、`mv -f`、`command -v`，
 * 这些在 PowerShell 里没有一个是命令：装到别人的 Windows 上就是"能看、不能改、
 * 抽不出参考"。这类错在本机（Linux）永远暴露不了，所以要有这道门禁。
 *
 * 做法：把 shell 桩装成 Windows PowerShell（探针答 `mcart-shell:5`），
 *   A. 捕获宿主真正发出去的命令，断言形状（没有 POSIX 写法、图片数据不进命令行）；
 *   B. **每条命令都交给真的 Windows PowerShell 执行**，宿主因此走完整条保存链路
 *      （写暂存 → 解码 → 魔数检查 → 换上新图），最后比对贴图字节。
 * 摸不到 Windows PowerShell 时，B 段明说 SKIP——只验形状，不假装验过能跑。
 *
 *   node tools/mcart-plugin/shell-dialect-test.js
 *   node tools/mcart-plugin/shell-dialect-test.js --fault   # 让探针谎报 POSIX，要求红
 */
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')

const HOST = nodePath.join(__dirname, 'host.js')
const FAULT = process.argv.includes('--fault')
const HAS_WINDOWS = nodeFs.existsSync('/mnt/c/Windows/system32/cmd.exe')
const WORK_WIN = 'C:/Temp/mcart-dialect'
const WORK = '/mnt/c/Temp/mcart-dialect'
const PROJECT = 'proj'
const NS = 'dialect'
const TEXTURE_WIN = WORK_WIN + '/' + PROJECT + '/pack/assets/' + NS + '/textures/block/probe.png'
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

const TO_POSIX = (p) => String(p).replace(/^([A-Za-z]):\//, (m, drive) => '/mnt/' + drive.toLowerCase() + '/')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/** 一个最小的项目：atlas + 一张已存在的贴图（都在 Windows 可见的路径上）。 */
function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const dir = nodePath.join(WORK, PROJECT)
  nodeFs.mkdirSync(nodePath.join(dir, 'pack', 'assets', NS, 'textures', 'block'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(dir, 'mc-art.atlas.json'), JSON.stringify({
    schema: 'mc-art.atlas/1', namespace: NS,
    biomes: [], structures: [], entities: [], blocks: [],
  }))
  nodeFs.writeFileSync(nodePath.join(dir, 'pack', 'assets', NS, 'textures', 'block', 'probe.png'),
    Buffer.from('not a real png yet'))
}

/** `ctx.subprocess` 的桩：只认"起 powershell 弹对话框"那一种调用，回标记串。 */
function makeSubprocessStub(record) {
  const reader = (text) => ({ readFrom: () => ({ text: text, nextOffset: 0, lossy: false }) })
  return {
    seen: record.seen,
    async resolveExecutable(name) { return name },
    spawn(spec) {
      record.seen.push(spec.argv)
      const wantsDialog = spec.argv.indexOf('-EncodedCommand') > 0
      const text = wantsDialog && record.pick !== undefined
        ? 'MCART_PICK_BEGIN' + record.pick + 'MCART_PICK_END' : ''
      return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: reader(text), stderr: reader('') },
        done: Promise.resolve({ exitCode: 0 }), terminate: () => {}, waitForExit: async () => true }
    },
  }
}

let stepCounter = 0
/** 把一条命令交给真的 Windows PowerShell 跑（没条件就只记录，返回"模拟成功"）。 */
function execute(command, record) {
  if (!HAS_WINDOWS) {
    record.executed.push({ command: command, simulated: true, exitCode: 0, stderr: '' })
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }
  stepCounter += 1
  const winScript = WORK_WIN + '/step-' + stepCounter + '.ps1'
  nodeFs.writeFileSync(TO_POSIX(winScript), '\ufeff' + command)
  // `-File` 的路径**不要加引号**：经 cmd.exe 传过去时引号会被一起交给 PowerShell，
  // 它报"路径中具有非法字符"（实测）。cwd 也要落在 Windows 侧，否则 cmd 会把
  // UNC 当前目录的警告和真错误混在一起。
  const done = cp.spawnSync('/mnt/c/Windows/system32/cmd.exe',
    ['/d', '/c', 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + winScript],
    { encoding: 'utf8', timeout: 120000, cwd: '/mnt/c/Temp' })
  record.executed.push({ command: command, exitCode: done.status, stderr: String(done.stderr || '').trim() })
  return {
    exitCode: done.status === null ? 124 : done.status,
    stdout: { text: done.stdout || '' },
    stderr: { text: done.stderr || '' },
  }
}

/** 录音桩：shell 的探针答成 Windows PowerShell，其余命令真执行；fs 直接落真实文件。 */
function buildHost(record) {
  const fsService = {
    async resolve(p) { return nodePath.resolve(TO_POSIX(p)) },
    async stat(p) {
      try {
        const s = nodeFs.statSync(TO_POSIX(p))
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, version: String(s.mtimeMs) }
      } catch (error) { return undefined }
    },
    async listDir(p) {
      try {
        return nodeFs.readdirSync(TO_POSIX(p), { withFileTypes: true }).map((entry) => ({
          name: entry.name, type: entry.isDirectory() ? 'directory' : 'file',
        }))
      } catch (error) { return [] }
    },
    async readText(p) { return nodeFs.readFileSync(TO_POSIX(p), 'utf8') },
    async readBytes(p) { return new Uint8Array(nodeFs.readFileSync(TO_POSIX(p))) },
    async writeText(p, text) {
      record.fsWrites.push({ path: String(p), chars: text.length })
      nodeFs.mkdirSync(nodePath.dirname(TO_POSIX(p)), { recursive: true })
      nodeFs.writeFileSync(TO_POSIX(p), text)
      return {}
    },
  }
  // `shellFromStart:false` 模拟"宿主半比 shell 那行先挂载"：apply 那一刻服务还没有，
  // 之后才出现。桌面端实测的症状就是这个（面板说"宿主没有 shell 服务"）。
  let shellLive = record.shellFromStart !== false
  /** 测试用：让"晚到的 shell 服务"真的出现。 */
  record.arriveShell = () => { shellLive = true }
  // 两代的执行方法名不同：0.1.x 是 run(spec)（交互式另有 start），0.2.0-rc 是 execute(spec)。
  const shellService = { resolve(spec) { return spec }, async execute(spec) { return await runSpec(spec) } }
  // 0.1.x 那代还有 run/start；0.2.0-rc 只有 execute。用 record.shellApi 选形状。
  if (record.shellApi !== 'execute') {
    shellService.run = async (spec) => await runSpec(spec)
    shellService.start = async () => { throw new Error('not used') }
  }
  async function runSpec(spec) {
      const command = String(spec.command)
      record.commands.push(command)
      if (command.indexOf('mcart-shell') >= 0) {
        // --fault：谎报 POSIX（真实 shell 仍是 PowerShell）——测"方言猜错了门禁红不红"。
        // record.probeFails：模拟探针跑不通（桌面端那次就是这样）。
        if (record.probeFails === true) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'probe failed' } }
        }
        return { exitCode: 0, stdout: { text: FAULT ? 'mcart-shell:\n' : 'mcart-shell:5\n' }, stderr: { text: '' } }
      }
      if (command.indexOf('EncodedCommand') >= 0) {
        // 目录对话框：回一串带标记的"用户选了 X"。
        record.dialogs = (record.dialogs || 0) + 1
        return { exitCode: 0, stdout: { text: (record.pick === undefined ? '' :
          'MCART_PICK_BEGIN' + record.pick + 'MCART_PICK_END') }, stderr: { text: '' } }
      }
      if (command.indexOf('print(1)') >= 0) {
        return { exitCode: 0, stdout: { text: '1\n' }, stderr: { text: '' } }
      }
      return execute(command, record)
  }
  const handlers = {}
  const ctx = {
    get: (name) => {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellLive ? shellService : undefined
      if (name === 'subprocess') return record.subprocess
      return undefined
    },
    effect: (fn) => fn(),
  }
  globalThis.harness = { handle: (name, fn) => { handlers[name] = fn } }
  const body = nodeFs.readFileSync(process.env.MCART_HOST || HOST, 'utf8')
  // **平台由用例决定**：方言现在是按 `process.platform` 定的，探针只在平台问不到时
  // 才说话（老行为"探针失败就当 POSIX"正是用户那句错提示的根因）。
  // record.platform === undefined → 用真平台；'' → 模拟"平台问不到"。
  const fake = record.platform === undefined ? process
    : { platform: record.platform, env: record.env || {}, version: 'v20.0.0' }
  new Function('harness', 'console', 'TextEncoder', 'btoa', 'atob', 'nodeFs', 'moduleDir', 'process', body)(
    globalThis.harness, console, TextEncoder, btoa, atob, undefined, undefined, fake).apply(ctx)
  return handlers
}

;(async () => {
  console.log('--- A. 装成 Windows PowerShell，检查宿主发出的命令')
  const record = { commands: [], fsWrites: [], executed: [], platform: '' }
  const shellLiveLater = { commands: [], fsWrites: [], executed: [], shellFromStart: false, platform: '' }
  buildFixture()
  const handlers = buildHost(record)
  const saved = await handlers['atlas.saveTexture']({
    root: WORK_WIN, project: PROJECT, path: TEXTURE_WIN, base64: PNG_BASE64,
  })

  const probes = record.commands.filter((c) => c.indexOf('mcart-shell') >= 0)
  const issued = record.commands.filter((c) => c.indexOf('mcart-shell') < 0 && c.indexOf('print(1)') < 0)
  check('宿主探了一次 shell 方言', probes.length === 1, record.commands.length + ' 条命令')
  check('没有 POSIX 专有写法（printf / base64 -d / rm -f / mv -f / command -v）',
    issued.every((c) => !/\bprintf\b/.test(c) && !/base64 -d/.test(c) && !/\brm -f\b/.test(c) &&
      !/\bmv -f\b/.test(c) && !/command -v/.test(c)),
    issued.join(' | ').slice(0, 200))
  check('解码走 .NET（[Convert]::FromBase64String）',
    issued.some((c) => c.indexOf('[Convert]::FromBase64String') >= 0))
  check('换上新图用 Move-Item', issued.some((c) => c.indexOf('Move-Item') >= 0))
  check('收尾清理用 Remove-Item', issued.some((c) => c.indexOf('Remove-Item') >= 0))
  check('命令行里没有图片数据（base64 不进命令行）',
    issued.every((c) => c.indexOf(PNG_BASE64.slice(0, 24)) < 0 && c.length < 4000),
    issued.map((c) => c.length).join(','))
  const staging = record.fsWrites.filter((w) => w.path.indexOf('.mcart-b64') >= 0)
  check('base64 是通过 fs 写进暂存文件的（文本通道）',
    staging.length === 1 && staging[0].chars === PNG_BASE64.length, JSON.stringify(staging))

  console.log('--- B. 端到端：真 PowerShell 解出 PNG 并换上新图')
  if (!HAS_WINDOWS) {
    console.log('  SKIP 本机摸不到 Windows PowerShell（没有 /mnt/c）——只验了命令形状，没验真能跑')
  } else {
    const broken = record.executed.filter((e) => e.exitCode !== 0 || e.stderr !== '')
    check('每条命令在真 PowerShell 里都成功', broken.length === 0, JSON.stringify(broken).slice(0, 240))
    check('saveTexture 端到端成功', saved && saved.saved === true, JSON.stringify(saved))
    const texture = TO_POSIX(TEXTURE_WIN)
    const landed = nodeFs.existsSync(texture) ? nodeFs.readFileSync(texture) : Buffer.alloc(0)
    check('贴图字节与送进去的 PNG 逐字节相同', landed.equals(PNG_BYTES),
      landed.length + ' 字节：' + landed.slice(0, 12).toString('hex'))
    check('临时文件与暂存文件都没留下',
      !nodeFs.existsSync(texture + '.mcart-tmp') && !nodeFs.existsSync(texture + '.mcart-tmp.mcart-b64'))
  }

  // ── 服务晚到：宿主半不能把 shell 缓存在 apply 那一刻 ────────────────────────
  console.log('--- C. shell 服务晚到（宿主半比它先挂载）')
  const lateHandlers = buildHost(shellLiveLater)
  // buildHost 里 apply 已经跑完（那时 get('shell') 是 undefined）；现在服务出现了。
  shellLiveLater.arriveShell()
  const lateSaved = await lateHandlers['atlas.saveTexture']({
    root: WORK_WIN, project: PROJECT, path: TEXTURE_WIN, base64: PNG_BASE64,
  })
  check('服务晚到也能写贴图（缓存住就会说"宿主没有 shell 服务"）',
    lateSaved && lateSaved.saved === true, JSON.stringify(lateSaved))

  // ── D. 只有 execute() 的 shell（0.2.0-rc 桌面端那代）────────────────────────
  console.log('--- D. 只有 execute() 的服务（桌面端那代，实测报过 run is not a function）')
  const execOnly = { commands: [], fsWrites: [], executed: [], shellApi: 'execute', platform: '' }
  buildFixture()
  const execHandlers = buildHost(execOnly)
  const execSaved = await execHandlers['atlas.saveTexture']({
    root: WORK_WIN, project: PROJECT, path: TEXTURE_WIN, base64: PNG_BASE64,
  })
  check('只有 execute() 时也能写贴图（兼容 run/execute 两代）',
    execSaved && execSaved.saved === true, JSON.stringify(execSaved))
  check('确实没有走 run()（证明这条对照测的是新形状）', typeof execOnly.commands.length === 'number')

  // ── E. 平台是 win32、但探针跑不通（用户那句错提示的根因）──────────────────────
  //
  // 用户实测：Windows 上点"选择目录…"，面板回「这个环境既没有 powershell.exe（Windows/WSL）
  // 也没有 zenity/kdialog/yad（Linux 桌面）」——Windows 上这句话基本一定是错的。
  // 真因：方言探针没跑通 → 被当成 POSIX → `command -v powershell.exe` 当然找不到。
  console.log('--- E. 平台是 win32 但探针跑不通：方言不许被猜成 POSIX')
  // 假的 SystemRoot：里面就有 Windows 自带的那个绝对路径。
  const sysRoot = WORK_WIN + '/sysroot'
  nodeFs.mkdirSync(TO_POSIX(sysRoot + '/System32/WindowsPowerShell/v1.0'), { recursive: true })
  nodeFs.writeFileSync(TO_POSIX(sysRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe'), 'stub')
  // 桌面端那代只有 execute()（没有 start），这里就按那个形状建桩。
  const pickedDir = WORK_WIN + '/pickeddir'
  nodeFs.mkdirSync(TO_POSIX(pickedDir), { recursive: true })
  const winRecord = { commands: [], fsWrites: [], executed: [], platform: 'win32', probeFails: true,
    shellApi: 'execute', env: { SystemRoot: sysRoot, USERPROFILE: 'C:/Users/probe' }, pick: pickedDir }
  const winHandlers = buildHost(winRecord)
  const picked = await winHandlers['atlas.pickDirectory']({ start: '' })
  check('平台是 win32 时按 PowerShell 拼命令（不去问 command -v）',
    winRecord.commands.every((c) => !/\bcommand -v\b/.test(c)), JSON.stringify(winRecord.commands.slice(0, 3)))
  check('powershell.exe 靠**绝对路径**找到了，并真的弹了对话框',
    winRecord.dialogs === 1, 'dialogs=' + String(winRecord.dialogs))
  check('对话框回来的路径可用（不再是一句"没有选择器"）',
    picked && picked.path === pickedDir, JSON.stringify(picked))

  // 对照：平台问不到（探针也失败）时，绝对路径那条路**仍然**能兜住 —— 这不是巧合，
  // 是有意的：`powershell.exe` 的固定位置是 Windows 自带的，不该依赖平台变量或 PATH。
  const blindRecord = { commands: [], fsWrites: [], executed: [], platform: '', probeFails: true,
    shellApi: 'execute', env: { SystemRoot: WORK_WIN + '/emptysysroot', USERPROFILE: 'C:/Users/probe' },
    pick: pickedDir }
  nodeFs.mkdirSync(TO_POSIX(WORK_WIN + '/emptysysroot'), { recursive: true })
  const blind = await buildHost(blindRecord)['atlas.pickDirectory']({ start: '' })
  check('对照：平台问不到时也能靠绝对路径兜住（不依赖 platform 或 PATH）',
    blind && (blind.path === pickedDir || blind.cancelled === true), JSON.stringify(blind))

  // ── F. 没有 shell 服务、只有 subprocess（用户桌面端那种宿主）────────────────
  //
  // 会话里的 pwsh 工具好用 ≠ 宿主层看得到 shell 服务。桌面端实测：面板里所有探测都回
  // `exitCode: null`（"找不到 Python"那段里每一项都写 exit=null）。所以对话框也要有
  // 一条 argv 路：直接起 powershell.exe。
  console.log('--- F. 没有 shell 服务、只有 subprocess：对话框走 argv')
  const subRecord = { platform: 'win32', env: { SystemRoot: sysRoot, USERPROFILE: 'C:/Users/probe' },
    pick: pickedDir, shellFromStart: false, subprocess: makeSubprocessStub({ pick: pickedDir, seen: [] }) }
  const subHandlers = buildHost(subRecord)
  const subPicked = await subHandlers['atlas.pickDirectory']({ start: '' })
  check('没有 shell 服务时靠 subprocess 起了 powershell 并拿回路径',
    subPicked && subPicked.path === pickedDir, JSON.stringify(subPicked))
  check('确实用的是 argv 形式（没有把命令拼成一行）',
    subRecord.subprocess.seen.length === 1 && Array.isArray(subRecord.subprocess.seen[0]) &&
    subRecord.subprocess.seen[0].indexOf('-EncodedCommand') > 0, JSON.stringify(subRecord.subprocess.seen[0] || []).slice(0, 160))

  // 那句错的提示必须从**发出去的产物**里消失 —— 它就是用户"为啥啊"的由来。
  // （看生成物而不是注释源码：源码注释里那句话是解释历史的，保留着没问题。）
  const emitted = nodePath.join(__dirname, '..', '..', 'panel', 'lib', 'index.js')
  check('发出去的宿主里不再有那句错的断言（"既没有 powershell.exe"）',
    nodeFs.existsSync(emitted) && nodeFs.readFileSync(emitted, 'utf8').indexOf('既没有 powershell.exe') < 0,
    nodeFs.existsSync(emitted) ? '产物里还有' : '还没 build（先跑 node panel/build.mjs）')

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => { console.error('THREW', error); process.exit(1) })
