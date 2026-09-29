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
  const shellService = {
    resolve(spec) { return spec },
    async run(spec) {
      const command = String(spec.command)
      record.commands.push(command)
      if (command.indexOf('mcart-shell') >= 0) {
        // --fault：谎报 POSIX（真实 shell 仍是 PowerShell）——测"方言猜错了门禁红不红"。
        return { exitCode: 0, stdout: { text: FAULT ? 'mcart-shell:\n' : 'mcart-shell:5\n' }, stderr: { text: '' } }
      }
      if (command.indexOf('print(1)') >= 0) {
        return { exitCode: 0, stdout: { text: '1\n' }, stderr: { text: '' } }
      }
      return execute(command, record)
    },
    start() { throw new Error('not used') },
  }
  const handlers = {}
  const ctx = {
    get: (name) => (name === 'fs' ? fsService : name === 'shell' ? shellService : undefined),
    effect: (fn) => fn(),
  }
  globalThis.harness = { handle: (name, fn) => { handlers[name] = fn } }
  const body = nodeFs.readFileSync(process.env.MCART_HOST || HOST, 'utf8')
  new Function(body)().apply(ctx)
  return handlers
}

;(async () => {
  console.log('--- A. 装成 Windows PowerShell，检查宿主发出的命令')
  const record = { commands: [], fsWrites: [], executed: [] }
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

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => { console.error('THREW', error); process.exit(1) })
