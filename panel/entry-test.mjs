#!/usr/bin/env node
/**
 * 两个入口真的能装载吗？——不启动 DSH 也能测。
 *
 * 包能"装进 profile"只证明打包元数据对（`--dump-config` 里那一行）；真正会出事的是
 * **运行时**：宿主入口 `apply(ctx)` 会不会炸、那条派发路由有没有注册上、
 * 客户端 bundle 在被页面加载时会不会抛。这两件事都能在 Node 里用桩验证——
 * 手法和仓库里其它门禁一致：喂真实的包、注入故障、要求检查报错。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  OK   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

// ── 宿主入口 ────────────────────────────────────────────────────────────────
console.log('--- 宿主入口（lib/index.js）')
const routes = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const ctx = {
  get: (name) => (name === 'webServer' ? webServer : undefined),
  // 真 Cordis 的 ctx.inject(names, cb) 交回来的 ctx 上，**服务就是属性**
  // （`httpCtx.webServer`）——你那个 timer-scheduler 也是这么写的。
  inject: (names, callback) => callback({ webServer: webServer }),
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
  provide: () => () => {},
}
const host = await import(join(HERE, 'lib', 'index.js'))
check('模块导出了 name / inject / apply',
  host.name === 'mcart-panel' && Array.isArray(host.inject) && typeof host.apply === 'function')
let hostFailed = null
try { await host.apply(ctx) } catch (error) { hostFailed = error }
check('apply(ctx) 不炸', hostFailed === null, hostFailed === null ? '' : String(hostFailed && hostFailed.message))
check('注册了派发路由 /api/mcart/call',
  routes.length === 1 && routes[0].path === '/api/mcart/call' && routes[0].kind === 'exact',
  JSON.stringify(routes.map((r) => r.path)))

/** 用假 req/res 调一次派发路由，把 JSON 响应读回来。 */
function callRoute(body) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = { method: 'POST', url: '/api/mcart/call', on: (kind, fn) => { listeners[kind] = fn },
      destroy: () => {} }
    let status = 0
    let text = ''
    const res = { writeHead: (code) => { status = code }, end: (value) => { text = value; resolve({ status, text }) } }
    routes[0].handler(req, res)
    queueMicrotask(() => {
      if (listeners.data !== undefined) listeners.data(Buffer.from(JSON.stringify(body)))
      if (listeners.end !== undefined) listeners.end()
    })
  })
}

const unknown = await callRoute({ name: 'no.such.method', args: null })
check('不认识的方法会明说，而不是静默', unknown.status === 404 && /没有这个方法/.test(unknown.text), unknown.text)
const known = await callRoute({ name: 'atlas.session', args: { sessionId: 'x' } })
let parsed = null
try { parsed = JSON.parse(known.text) } catch (error) { /* 下面会报 */ }
check('认识的方法真的被派发到（拿回可解析的 JSON）',
  parsed !== null && known.status !== 500, known.text.slice(0, 90))
const notPost = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/api/mcart/call', on: () => {}, destroy: () => {} }
  routes[0].handler(req, { writeHead: (c) => resolve(c), end: () => {} })
})
check('GET 被拒（只收 POST）', notPost === 405, String(notPost))

// ── 客户端入口 ──────────────────────────────────────────────────────────────
console.log('--- 客户端入口（lib/client.js，__ModuleLoader__ 形式）')
const bundle = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')
let loaded = null
const registered = []
const React = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {}, useRef: () => ({ current: null }),
  useMemo: (fn) => fn(), useCallback: (fn) => fn(),
}
const window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
// 客户端 bundle 期望的 require：真页面里它给的是同一个 React 实例与各服务包。
const require = (name) => {
  if (name === 'react') return React
  throw new Error('这个门禁不认识的模块：' + name)
}
const run = new Function('window', 'require', 'fetch', bundle + '\nreturn window.__ModuleLoader__.load && null;')
run(window, require, () => Promise.resolve({ json: () => Promise.resolve({}) }))
check('bundle 调用了 __ModuleLoader__.load 且带 id', loaded !== null && loaded.id === 'mcart-panel',
  JSON.stringify(loaded && loaded.id))
let clientFailed = null
let moduleExports = null
try {
  moduleExports = loaded.factory(require)
} catch (error) { clientFailed = error }
check('factory 能执行（React 通过 require 拿到）', clientFailed === null,
  clientFailed === null ? '' : String(clientFailed && clientFailed.message))
check('导出的是 Cordis 插件（inject + apply）',
  moduleExports !== null && Array.isArray(moduleExports.inject) && typeof moduleExports.apply === 'function',
  moduleExports === null ? 'null' : JSON.stringify(Object.keys(moduleExports || {})))

const clientCtx = {
  get: (name) => (name === 'slots' ? {
    inject: (slot, callback) => callback(),
    register: (options, factory) => { registered.push(options.name + ':' + (options.key || options.id)); return () => {} },
  } : undefined),
  effect: (fn) => { fn(); return () => {} },
  timer: { interval: () => () => {}, timeout: async () => {} },
}
let applyFailed = null
try { await moduleExports.apply(clientCtx) } catch (error) { applyFailed = error }
check('客户端 apply(ctx) 不炸', applyFailed === null, applyFailed === null ? '' : String(applyFailed && applyFailed.message))

// 真注入：把宿主入口那层垫片去掉（模拟"直接当动态插件跑"），派发路由就不该存在。
const withoutShim = readFileSync(join(HERE, 'lib', 'index.js'), 'utf8')
  .replace('const harness = {', 'const harness = null && {')
const injectedRoutes = []
const probeCtx = {
  get: () => undefined,
  inject: (names, callback) => callback({ webServer: { register: (r) => { injectedRoutes.push(r); return () => {} } } }),
  effect: (fn) => { fn(); return () => {} }, on: () => () => {}, provide: () => () => {},
}
let injectedFailed = null
try {
  const mod = await import('data:text/javascript,' + encodeURIComponent(withoutShim))
  await mod.apply(probeCtx)
} catch (error) { injectedFailed = error }
// 注意：路由是在 apply 之前注册的，所以这里**不能**断言"没注册路由"——
// 第一版就是这么写的，抓到自己一个错误假设。要证明的是"垫片是必需的"：
// 没有它，那份未改动的宿主源码一行都跑不了。
check('注入"宿主垫片没了"：当场炸（说明这个垫片是必需的，不是装饰）',
  injectedFailed !== null && /harness|handle/.test(String(injectedFailed.message)),
  injectedFailed === null ? '居然没炸' : String(injectedFailed.message).slice(0, 80))

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
