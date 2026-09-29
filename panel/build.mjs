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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCES = join(HERE, '..', 'tools', 'mcart-plugin')
const STRIPPER = join(HERE, '..', 'tools', 'strip_comments.py')

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
const SOURCE = ${JSON.stringify(hostSource)}

export const name = 'mcart-panel'
// 宿主半自己用 ctx.get(...) 取 fs / sessions / shell / webServer，不硬依赖任何服务。
export const inject = []

export function apply(ctx) {
  // 动态插件里有 harness.handle；真包里没有，所以这里做一个同形状的垫片：
  // 收成一张表，再由下面那条路由统一派发。host.js 一行都不用改。
  const handlers = {}
  const harness = {
    handle(method, handler) {
      handlers[method] = handler
      return () => { delete handlers[method] }
    },
  }
  const plugin = new Function('harness', 'console', 'TextEncoder', 'btoa', 'atob', SOURCE)(
    harness, console, TextEncoder, btoa, atob)
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('mcart 宿主源码没有返回一个带 apply 的插件')
  }

  // 一条路由，全部信道。客户端那边 host.call(name, args) 走的就是它。
  const MAX_BYTES = 16 * 1024 * 1024
  ctx.inject(['webServer'], (httpCtx) => {
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
          const handler = handlers[name]
          if (typeof handler !== 'function') {
            send(404, { error: '宿主没有这个方法：' + name })
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
  id: 'mcart-panel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 真包世界里 React 是 require 来的；动态插件世界里它是注入的绑定。
    var React = require('react')
    var SOURCE = ${JSON.stringify(clientSource)}

    // 三个垫片，对齐动态插件里注入的那三个名字。
    function ensureStyles(css) {
      var id = 'mcart-panel:styles'
      if (typeof document === 'undefined') return function () {}
      var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'mcart-panel'
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

    var plugin = new Function('React', 'host', 'styles', 'console', SOURCE)(React, host, styles, console)
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
      throw new Error('mcart 客户端源码没有返回一个带 apply 的插件')
    }
    exports.name = plugin.name === undefined ? 'mcart-panel' : plugin.name
    exports.inject = plugin.inject === undefined ? [] : plugin.inject
    exports.apply = plugin.apply
    return module.exports
  },
})
`
}

export function build() {
  const host = strip(join(SOURCES, 'host.js'))
  const client = strip(join(SOURCES, 'client.js'))
  mkdirSync(join(HERE, 'lib'), { recursive: true })
  writeFileSync(join(HERE, 'lib', 'index.js'), hostModule(host))
  writeFileSync(join(HERE, 'lib', 'client.js'), clientBundle(client))
  return { host, client }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('build.mjs')) {
  const out = build()
  process.stdout.write(`已生成 panel/lib/index.js（宿主源码 ${out.host.length} 字符）` +
    ` 与 panel/lib/client.js（客户端源码 ${out.client.length} 字符）\n`)
}
