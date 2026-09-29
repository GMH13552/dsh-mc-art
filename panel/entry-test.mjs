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
/**
 * 包名就是客户端模块的注册 id：dsh 的 client-modules 按启动图里那一行的 id
 * 去 factories 里找模块（找不到就 `bundle … loaded without registering "…"`）。
 * 这里也从这个唯一真相读，避免门禁自己抄错。
 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).name
/** `--fault`：把注册 id 改错，要求门禁当场失败（证明它真的在看这一条）。 */
const FAULT = process.argv.includes('--fault')
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
let bundle = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')
if (FAULT) {
  const before = bundle
  bundle = bundle.replace(/(__ModuleLoader__\.load\(\{[\s\S]*?\bid: )"[^"]*"/, '$1"wrong-id"')
  if (bundle === before) {
    console.log('  FAIL 故障注入没生效：没能在 bundle 里找到 __ModuleLoader__.load({ id: … })')
    failures += 1
  }
}
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
check('bundle 注册的 id 就是包名（client-modules 按启动图里那一行的 id 找模块）',
  loaded !== null && loaded.id === PACKAGE_NAME,
  '注册成 ' + JSON.stringify(loaded && loaded.id) + '，图里那一行要的是 ' + JSON.stringify(PACKAGE_NAME))
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

/** 跑一次客户端 apply，返回它注册了哪些槽、以及"晚到的服务"怎么触发。 */
function clientRun(options) {
  const seen = []
  const lateCallbacks = []
  // 右侧栏插件同时提供两个服务；晚到的情形也是两个一起到（实测如此）。
  let tabsPresent = options.tabs === true || options.services === true
  let sidebarRightPresent = options.sidebarRight === true || options.services === true
  const slots = {
    inject: (slot, callback) => callback(),
    register: (settings) => {
      const key = settings.name + ':' + (settings.key || settings.id)
      seen.push(key)
      // 真的撤掉，这样"搬到右栏后左栏那份没了"是可验证的（返回的 disposer 会被调用）
      return () => { const at = seen.indexOf(key); if (at >= 0) seen.splice(at, 1) }
    },
    entries: (name) => ((options.slotEntries || []).includes(name) ? [{ id: 'shell-own' }] : []),
  }
  const ctx = {
    get: (name) => {
      if (name === 'slots') return slots
      if (tabsPresent && name === 'sidebarRightTabs') return { register: () => () => {} }
      if (sidebarRightPresent && name === 'sidebarRight') return {}
      return undefined
    },
    inject: (names, callback) => { lateCallbacks.push(callback); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    timer: { interval: () => () => {}, timeout: async () => {} },
  }
  const result = moduleExports.apply(ctx)
  return {
    seen,
    result,
    /** 右侧栏服务"晚到"了：服务出现后触发回调，面板应当从左边搬过去。 */
    arriveLate() {
      tabsPresent = true
      sidebarRightPresent = true
      for (const callback of lateCallbacks) callback()
    },
  }
}

let applyFailed = null
try { await moduleExports.apply({ get: () => undefined, effect: (fn) => fn(), timer: { interval: () => () => {}, timeout: async () => {} } }) }
catch (error) { applyFailed = error }
check('客户端 apply(ctx) 不炸（连 slots 都没有时）', applyFailed === null,
  applyFailed === null ? '' : String(applyFailed && applyFailed.message))

// 右栏判据：服务在 → 右栏；服务不在但槽在（桌面端那种壳）→ 也必须进右栏；
// 两者都没有 → 才回退到左栏。这三条是实测出来的区别，不是我想当然。
const byService = clientRun({ services: true }).seen
check('两个服务都在 → 右侧栏', byService.some((key) => key.startsWith('sidebar.right.pane.tab:')), byService.join(' '))
const noSidebarRight = clientRun({ tabs: true, slotEntries: ['sidebar.right.pane.tab'] }).seen
check('有 tabs、没有 sidebarRight 服务（桌面端）→ 也进右侧栏',
  noSidebarRight.some((key) => key.startsWith('sidebar.right.pane.tab:')) &&
  !noSidebarRight.some((key) => key.startsWith('sidebar.panellist:')), noSidebarRight.join(' '))
const noTabs = clientRun({ slotEntries: ['sidebar.right.pane.tab'] }).seen
check('没有 tabs（注册不了 tab）→ 回退左栏，且不炸',
  noTabs.some((key) => key.startsWith('sidebar.panellist:')) &&
  !noTabs.some((key) => key.startsWith('sidebar.right.pane.tab:')), noTabs.join(' '))
const fallbackRun = clientRun({})
check('什么都没有 → 回退左栏',
  fallbackRun.seen.some((key) => key.startsWith('sidebar.panellist:')) &&
  !fallbackRun.seen.some((key) => key.startsWith('sidebar.right.pane.tab:')), fallbackRun.seen.join(' '))
// 冷启动实测：右侧栏插件比我们晚挂载 → 原来它把面板留在左栏，重启后就成了左栏。
// 现在服务一出现就搬过去，并且把左栏那份撤掉（同一个面板不该两处都在）。
const lateRun = clientRun({})
check('服务晚到之前，先有一个能用的落点（左栏）',
  lateRun.seen.some((key) => key.startsWith('sidebar.panellist:')), lateRun.seen.join(' '))
lateRun.arriveLate()
check('服务晚到之后，搬到右侧栏且撤掉左栏那份',
  lateRun.seen.some((key) => key.startsWith('sidebar.right.pane.tab:')) &&
  !lateRun.seen.some((key) => key.startsWith('sidebar.panellist:')) &&
  !lateRun.seen.some((key) => key.startsWith('main:')), lateRun.seen.join(' '))

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
