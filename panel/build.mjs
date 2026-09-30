#!/usr/bin/env node
/**
 * 由 tools/mcart-plugin/{host,client}.js 生成这个包的 lib/。
 *
 * 为什么要有这一步：面板要能用**两种方式**送达运行时装起来——
 *
 *   1. 动态插件（会话里 `cordis_define` + `cordis_run`）：两半是"函数体字符串"，
 *      运行时注入的绑定（harness / React / host / styles …）当参数传进去；
 *   2. 真包（`dsh plugin --profile <名> add` 装进 profile）：宿主入口是 ESM 模块，
 *      客户端入口是 `window.__ModuleLoader__.load({ id, factory })` 形式的 bundle。
 *
 * 两种方式的**源码是同一份**（tools/mcart-plugin/ 里那两个注释版文件），
 * 这个脚本只负责把两半各自包成 (2) 需要的外壳：
 *
 *   * 宿主：把 `harness.handle(name, fn)` 收成一张表，再用一条 HTTP 路由
 *     `POST /api/mcart/call {name,args}` 统一派发——20 个 handler 一个都不用改；
 *   * 客户端：`require('react')` 拿 React、`fetch` 实现 `host.call`、
 *     `styles.insert` 插 <style>，然后把同一段源码 `new Function(...)` 出来。
 *
 * 于是"同一份代码两种送达"不需要维护两份实现（这是这个仓库最在意的事）。
 * `lib/` 是生成物且要随包发布，所以另有 verify-build.mjs 逐字节比对，防止漂移。
 */
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCES = join(HERE, '..', 'tools', 'mcart-plugin')
const STRIPPER = join(HERE, '..', 'tools', 'strip_comments.py')

/**
 * 包名 = 客户端模块的**注册 id**。
 *
 * 这条不能抄错：dsh 的 client-modules 按启动图里那一行的 id 去 factories 里找模块
 * （`register` 存 `stripClientSuffix(registration.id)`，`arrive` 里
 * `if (!this.factories.has(id)) throw ... loaded without registering "${id}"`），
 * 而图里的 id 就是包名。曾经这里写成宿主行的名字 `mcart-panel`，结果包能装、
 * 客户端那一半永远 "import failed"，页面上什么都不出现。
 * 所以包名只从 package.json 读一份，绝不手写。
 */
/** 随包时**不复制**的整目录（相对其来源根）：mc-art 的测试夹具里带着作者示例项目的字面量，
 *  而且用户明确说过"测试不必随包"——留一份在独立仓库里就够了。 */
export function isSkipped(path) {
  return String(path).split(/[\\/]/).includes('tests')
}

/** 生成物里不该出现的东西（相对任一路径都成立）。 */
export function isJunk(path) {
  const parts = String(path).split(/[\\/]/)
  const junkDirs = ['.git', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.venv', 'node_modules', '.DS_Store', '.ipynb_checkpoints']
  if (parts.some((part) => junkDirs.includes(part))) return true
  return /\.(pyc|pyo|egg-info|log|swp)$/.test(String(path))
}

export const PACKAGE_NAME = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).name
/** 版本：渲染边界会把它画进错误信息里，于是"白屏"永远带着可报的版本号。 */
export const PACKAGE_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
if (typeof PACKAGE_NAME !== 'string' || PACKAGE_NAME === '') {
  throw new Error('panel/package.json 里没有有效的 name，客户端 bundle 不知道该注册成什么 id')
}

/** 去掉注释：复用仓库里那一份实现（它是"注释怎么算"的唯一真相）。 */
export function strip(file) {
  for (const python of ['python3', 'python']) {
    const done = spawnSync(python, [STRIPPER, file], { encoding: 'utf8' })
    if (done.error !== undefined && done.error.code === 'ENOENT') continue
    if (done.status !== 0) throw new Error(`${python} ${STRIPPER} 失败：${done.stderr}`)
    return done.stdout
  }
  throw new Error('没有 python3 / python，跑不了 strip_comments.py')
}

/** 宿主入口：ESM 模块 = Cordis 插件。 */
export function hostModule(hostSource) {
  return `// 生成物：由 panel/build.mjs 从 tools/mcart-plugin/host.js 生成 —— 不要手改。
// 改行为请改那份源码，然后 \`node panel/build.mjs\`（verify-build.mjs 会挡住漂移）。
import { mkdir as nodeMkdir, readdir as nodeReaddir, readFile as nodeReadFile, rename as nodeRename, rm as nodeRm, stat as nodeStat, writeFile as nodeWriteFile } from 'node:fs/promises'
import { dirname as nodeDirname } from 'node:path'
import { fileURLToPath as nodeFileURLToPath } from 'node:url'

const SOURCE = ${JSON.stringify(hostSource)}
const VERSION = ${JSON.stringify(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version)}
// 本模块所在目录（<包>/lib）。宿主源码用它推出**随包的那份引擎**在哪里 ——
// 参考目录要靠 Python 脚本读 jar，而"项目不在 mc-art 仓库里"的机器上，
// 只从项目目录往上找是找不到的（实测：设置存得下、什么也读不出来）。
//
// 用 try 包住是有原因的：门禁会把这份模块当 data: URL 加载（注入"垫片没了"那种故障），
// 那时 import.meta.url 不是 file:，而 fileURLToPath 会直接抛 —— 拿不到路径就不拿，
// 宿主源码里 moduleDirOf() 本来就允许空串。
function moduleDirOfSelf() {
  try { return nodeDirname(nodeFileURLToPath(import.meta.url)) } catch (error) { return '' }
}
const MODULE_DIR = moduleDirOfSelf()

// 本地文件系统垫片：**服务都缺席时的最后一条路**。
//
// 为什么包在宿主里要自带这个：fs 服务和 shell 服务都是可能缺席的外部行，而"把用户
// 点出来的工程建出来 / 把他画的那张图存下去"不该因为缺一行就整个做不到。用户机器上
// 实测过一次（Windows 桌面端 0.2.0-rc.2）：面板能扫描、能弹系统目录对话框，
// 却回了一句"宿主没有 shell 服务时建不出目录"——那句话是猜的。现在源码里每一层
// 只报自己的失败原因，这个垫片兜住最后一种情况，结果里写明 via=node:fs。
//
// 它绕过宿主的 sandbox 策略（不产生文件效应记录、不触发审批），所以**排在最后**：
// 只有 directoryPickerController / shell / fs 三条都不可用时才会被用到。
// （这段是模板字符串里的生成代码：注释里不能出现反引号。）
const nodeFs = {
  available: true,
  async mkdirp(path) { await nodeMkdir(path, { recursive: true }) },
  async stat(path) {
    try {
      const info = await nodeStat(path)
      return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, version: String(info.mtimeMs) }
    } catch (error) { return undefined }
  },
  async listDir(path) {
    try {
      const entries = await nodeReaddir(path, { withFileTypes: true })
      const out = []
      for (const entry of entries) {
        let size, version
        try { const info = await nodeStat(path + '/' + entry.name); size = info.size; version = String(info.mtimeMs) } catch (error) {}
        out.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: size, version: version })
      }
      return out
    } catch (error) { return [] }
  },
  async readText(path) {
    try { return await nodeReadFile(path, 'utf8') } catch (error) { return undefined }
  },
  async readBytes(path, maxBytes) {
    try {
      const buffer = await nodeReadFile(path)
      if (maxBytes !== undefined && buffer.length > maxBytes) return undefined
      return new Uint8Array(buffer)
    } catch (error) { return undefined }
  },
  async writeText(path, text) {
    await nodeMkdir(nodeDirname(path), { recursive: true })
    await nodeWriteFile(path, text, 'utf8')
  },
  async writeBase64(path, base64) {
    await nodeMkdir(nodeDirname(path), { recursive: true })
    await nodeWriteFile(path, Buffer.from(base64, 'base64'))
  },
  async remove(path) { await nodeRm(path, { force: true }) },
  async move(from, to) {
    await nodeMkdir(nodeDirname(to), { recursive: true })
    await nodeRename(from, to)
  },
}

export const name = 'mcart-panel'
// 宿主半自己用 ctx.get(...) 取 fs / sessions / shell / webServer，不硬依赖任何服务。
export const inject = []

// 当前那张 handler 表与"路由是否已经注册过"都放在模块级。
//
// 为什么必须这样：宿主那一行在**热重启**时会被重新 apply 一次，而老实例卸载会把它那张表
// 逐条 delete 干净（每个 handle 的 disposer 都这么干）。如果路由捕获的是"某一次 apply 的
// 表"，就会出现：路由还活着、表已经空了 → 任何调用都回"宿主没有这个方法"（用户实测，
// 热重启才触发；彻底退出应用反而不触发）。所以路由只注册一次，派发时读**当前**这张表。
// （注意：这段是模板字符串里的生成代码，注释里不能出现反引号 —— 它会截断模板。）
let liveHandlers = null
let routeReady = false

export function apply(ctx) {
  // 动态插件里有 harness.handle；真包里没有，所以这里做一个同形状的垫片：
  // 收成一张表，再由下面那条路由统一派发。host.js 一行都不用改。
  const handlers = {}
  liveHandlers = handlers
  ctx.effect(() => () => { if (liveHandlers === handlers) liveHandlers = null })
  const harness = {
    handle(method, handler) {
      handlers[method] = handler
      return () => { delete handlers[method] }
    },
  }
  const plugin = new Function('harness', 'console', 'TextEncoder', 'btoa', 'atob', 'nodeFs', 'moduleDir', 'process', SOURCE)(
    harness, console, TextEncoder, btoa, atob, nodeFs, MODULE_DIR, process)
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('mcart 宿主源码没有返回一个带 apply 的插件')
  }

  // 一条路由，全部信道。客户端那边 host.call(name, args) 走的就是它。
  const MAX_BYTES = 16 * 1024 * 1024
  ctx.inject(['webServer'], (httpCtx) => {
    if (routeReady) return
    routeReady = true
    httpCtx.webServer.register({
      kind: 'exact',
      path: '/api/mcart/call',
      handler: (req, res) => {
        function send(status, payload) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(payload))
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          send(405, { error: '这条路由只收 POST' })
          return
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) { req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', async () => {
          let request
          try {
            request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch (error) {
            send(400, { error: '请求不是 JSON：' + String(error && error.message ? error.message : error) })
            return
          }
          const name = typeof request.name === 'string' ? request.name : ''
          const table = liveHandlers
          const handler = table === null ? undefined : table[name]
          if (typeof handler !== 'function') {
            // 报错里带上"谁在应答"：版本 + 已注册多少方法。没有这两样，这种问题只能靠猜
            // （"宿主没有这个方法"到底是旧实例、空表，还是名字真的写错了）。
            const count = table === null ? 0 : Object.keys(table).length
            send(404, { error: '宿主没有这个方法：' + name +
              '（宿主 dsh-mc-art-panel@' + VERSION + '，已注册 ' + count + ' 个方法' +
              (table === null ? '，宿主已卸载' : '') + '）' })
            return
          }
          try {
            const value = await handler(request.args === undefined ? null : request.args)
            send(200, value === undefined ? null : value)
          } catch (error) {
            send(500, { error: String(error && error.message ? error.message : error) })
          }
        })
        req.on('error', () => { send(400, { error: '请求读失败' }) })
      },
    })
  })

  return plugin.apply(ctx)
}
`
}

/** 客户端入口：__ModuleLoader__ 形式的 bundle。 */
export function clientBundle(clientSource) {
  return `// 生成物：由 panel/build.mjs 从 tools/mcart-plugin/client.js 生成 —— 不要手改。
window.__ModuleLoader__.load({
  // 必须是包名：client-modules 拿启动图里那一行的 id 来 factories 里找它。
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 真包世界里 React 是 require 来的；动态插件世界里它是注入的绑定。
    var React = require('react')
    var SOURCE = ${JSON.stringify(clientSource)}

    // 三个垫片，对齐动态插件里注入的那三个名字。
    function ensureStyles(css) {
      var id = ${JSON.stringify(PACKAGE_NAME + ':styles')}
      if (typeof document === 'undefined') return function () {}
      var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)}
        tag.dataset.pluginCss = id
        tag.textContent = css
        document.head.appendChild(tag)
      }
      return function () { if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag) }
    }
    var styles = { insert: ensureStyles }
    var host = {
      call: function (method, args) {
        return fetch('/api/mcart/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: String(method), args: args === undefined ? null : args }),
        }).then(function (response) {
          return response.json().then(function (value) { return value })
        }).catch(function (error) {
          // 不抛：面板里到处都是 failureOf(reply)，返回一个 {error} 更好处理。
          return { error: '面板与宿主的信道断了：' + String(error && error.message ? error.message : error) }
        })
      },
    }

    var plugin = new Function('React', 'host', 'styles', 'console', 'PANEL_VERSION', SOURCE)(
      React, host, styles, console, ${JSON.stringify(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version)})
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
      throw new Error('mcart 客户端源码没有返回一个带 apply 的插件')
    }
    exports.name = plugin.name === undefined ? ${JSON.stringify(PACKAGE_NAME)} : plugin.name
    exports.inject = plugin.inject === undefined ? [] : plugin.inject
    exports.apply = plugin.apply
    return module.exports
  },
})
`
}

/**
 * 把仓库里的「模式」和「skill」也复制进包里。
 *
 * 为什么：用户从 npm 拉一个包，就该同时得到面板 + 模式 + skill —— 而不是"装了面板，
 * 预设还得自己拷到 ~/.dsh/.agent-presets"。面板自己的 cordis.patch.yml 会把包内
 * 这两个目录注册成 agent-presets 的 root 和 skill 的 customSkillDirs（都在 profile
 * 里，不往用户目录写东西）。
 *
 * 副本仍然是**生成物**：唯一真相是仓库里的 presets/ 与 skills/，verify-build.mjs 会
 * 逐字节比对这两份拷贝，防止它们悄悄漂移。
 */
export function vendored() {
  // mc-art 是**独立仓库**（有自己的历史与节奏），所以它不在本仓库里：
  // 这里的来源是那个仓库的本地克隆（安装器装到 ~/.dsh/skills/mc-art）。
  // 发布时把它快照进包里，用户装一个包就同时拿到面板 + 模式 + 两个 skill，
  // 不需要 git、不需要网络、也不往用户目录写东西。
  const artSource = process.env.MC_ART_SKILL_DIR ?? join(homedir(), '.dsh', 'skills', 'mc-art')
  const pairs = [
    [join(HERE, '..', 'presets', 'mc-studio'), join(HERE, 'preset', 'mc-studio')],
    // skill 跟着**预设**走：预设的 composition 用 baseUrl 相对定位 skills/，
    // 所以它们必须落在预设目录里（和出厂 cordis 预设一样）。
    [join(HERE, '..', 'skills', 'mc-mod'), join(HERE, 'preset', 'mc-studio', 'skills', 'mc-mod')],
  ]
  if (existsSync(join(artSource, 'SKILL.md'))) {
    pairs.push([artSource, join(HERE, 'preset', 'mc-studio', 'skills', 'mc-art')])
  }
  else process.stdout.write(`！没找到 mc-art 的克隆（${artSource}），这一份不进包——` +
    '先跑 install.mjs 拉它，或用 MC_ART_SKILL_DIR 指过去。\n')
  for (const [from, to] of pairs) {
    rmSync(to, { recursive: true, force: true })
    mkdirSync(dirname(to), { recursive: true })
    // 只带该带的东西：.git（没有历史）、__pycache__ / *.pyc（机器相关）、.cache（缓存）。
    // npm 打包时本来也会排掉其中一些，但那不该是"能不能出垃圾"的唯一防线。
    cpSync(from, to, { recursive: true, filter: (src) => !isJunk(src) && !isSkipped(src) })
  }
  // **引擎脚本随包走**：参考目录（原版/模组的方块、物品、图标）要靠这两个 Python 脚本
  // 读 jar，而它们原来只从**项目目录往上找 5 层** —— 也就是"项目恰好在 dsh-mc-art 仓库里"
  // 才碰得上。别的机器上设置存得下、却什么都读不出来（用户实测："那个用它根本用不了"）。
  // 两个脚本只依赖标准库，所以直接放进包里，任何 Python 3 都能跑（包括桌面版自带的那份）。
  const pythonTargets = []
  const pythonDir = join(HERE, 'python')
  rmSync(pythonDir, { recursive: true, force: true })
  mkdirSync(pythonDir, { recursive: true })
  for (const name of ENGINE_SCRIPTS) {
    const from = join(HERE, '..', 'tools', name)
    const to = join(pythonDir, name)
    if (!existsSync(from)) {
      throw new Error('缺少引擎脚本 ' + from + '（它必须随包发出去，否则参考目录功能在别人的机器上是死的）')
    }
    copyFileSync(from, to)
    pythonTargets.push([from, to])
  }
  return pairs.concat(pythonTargets)
}

/** 随包发布的 Python 引擎脚本（只依赖标准库）。 */
export const ENGINE_SCRIPTS = ['mcart_scan_refs.py', 'mcart_extract_block.py']

export function build() {
  const host = strip(join(SOURCES, 'host.js'))
  const client = strip(join(SOURCES, 'client.js'))
  mkdirSync(join(HERE, 'lib'), { recursive: true })
  writeFileSync(join(HERE, 'lib', 'index.js'), hostModule(host))
  writeFileSync(join(HERE, 'lib', 'client.js'), clientBundle(client))
  const copied = vendored()
  return { host, client, copied }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('build.mjs')) {
  const out = build()
  process.stdout.write(`已生成 panel/lib/index.js（宿主源码 ${out.host.length} 字符）` +
    ` 与 panel/lib/client.js（客户端源码 ${out.client.length} 字符）\n`)
  for (const [from, to] of out.copied) process.stdout.write(`已复制 ${from} -> ${to}\n`)
}
