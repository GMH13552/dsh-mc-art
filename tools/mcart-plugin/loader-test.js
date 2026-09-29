// The loader pair, exercised end to end in Node.
//
// `loader.host.js` is what a package emits now: it reads
// `tools/mcart-plugin/host.js` off disk, compiles it, and runs it.  That trades
// one frozen copy of the code for "whatever the file says at activation", and it
// introduces the one failure mode a compiler would have caught: `new Function`
// compiles in GLOBAL scope, so every binding the runtime injects (`harness`,
// `console`, `TextEncoder`, `btoa`, `atob` on the host; `React`, `host`,
// `styles` on the client) has to be handed in as a parameter.  Forget one and the
// loaded half dies at run time with `x is not defined` -- inside a browser page,
// where the only evidence is a Run card.
//
// So this gate does not check that the loader file "looks right".  It loads the
// REAL host.js and the REAL client.js through the REAL loader code, with a stub
// harness, and requires that the handlers and the slots actually appear; then it
// breaks the arrangement in three ways a reader would not notice.
const nodeFs = require('fs')
const nodePath = require('path')

const HERE = __dirname
const LOADER_HOST = nodePath.join(HERE, 'loader.host.js')
const LOADER_CLIENT = nodePath.join(HERE, 'loader.client.js')

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  OK   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

function source(file) { return nodeFs.readFileSync(file, 'utf8') }

/** A stand-in for the wrapper the runtime uses on a Host body. */
function runBody(text, names, values) {
  const make = new Function(names.join(','), text)
  return make.apply(null, values)
}

function hostEnv(overrides) {
  const handlers = {}
  const disposers = []
  const logs = []
  const harness = {
    handle: (method, fn) => { handlers[method] = fn; return () => { delete handlers[method] } },
  }
  const fsStub = (overrides || {}).fs || {
    resolve: async (path) => ({ path: path }),
    readText: async (target) => source(target.path),
  }
  const ctx = {
    get: (name) => (name === 'fs' ? fsStub : undefined),
    effect: (fn) => { const d = fn(); disposers.push(d); return () => { } },
    on: () => () => { },
  }
  return { handlers: handlers, disposers: disposers, logs: logs, harness: harness, ctx: ctx }
}

const RELAY = { harness: null, console: null, TextEncoder: TextEncoder, btoa: btoa, atob: atob }

async function loadHost(overrides) {
  const env = hostEnv(overrides)
  const plugin = runBody(source(LOADER_HOST), ['harness', 'console', 'TextEncoder', 'btoa', 'atob'],
    [env.harness, { log: (line) => env.logs.push(String(line)) }, TextEncoder, btoa, atob])
  await plugin.apply(env.ctx)
  return { env: env, plugin: plugin }
}

/** The same chain, with `ctx.get('fs')` handed a directory that has nothing in it. */
async function expectThrows(run) {
  try { await run(); return null } catch (error) { return error }
}

async function main() {
  console.log('--- 宿主那一半：从磁盘读 host.js 并跑起来')
  const host = await loadHost()
  check('mcart.source 挂上了（客户端那一半要靠它拿源码）',
    typeof host.env.handlers['mcart.source'] === 'function')
  const reply = await host.env.handlers['mcart.source']({ half: 'client' })
  check('mcart.source 真的返回 client.js 的内容',
    typeof reply.text === 'string' && reply.text === source(nodePath.join(HERE, 'client.js')),
    '拿到 ' + (reply && typeof reply.text === 'string' ? reply.text.length : typeof reply) + ' 字符')
  const wanted = ['atlas.scan', 'atlas.settings', 'atlas.itemIcons', 'atlas.icon', 'atlas.preview']
  const missing = wanted.filter((name) => typeof host.env.handlers[name] !== 'function')
  check('加载进来的宿主真的把自己的 handler 都挂上了', missing.length === 0, missing.join('、'))
  check('宿主启动那行日志说明源码是从哪个文件读的',
    host.env.logs.some((line) => line.indexOf('host.js') >= 0),
    JSON.stringify(host.env.logs))
  check('加载进来的宿主返回值是带 apply 的插件',
    host.plugin !== null && typeof host.plugin.apply === 'function')

  console.log('--- 客户端那一半：拿到源码后在这里编译并跑起来')
  const registered = []
  const slots = {
    inject: (name, callback) => { registered.push('inject:' + name); callback() },
    register: (options, factory) => { registered.push('register:' + options.name + ':' + (options.key || options.id)); return () => { } },
  }
  const styles = { insert: (css) => { registered.push('styles:' + css.length); return () => { } } }
  const ReactStub = { createElement: () => null, useState: () => [null, () => { }], useEffect: () => { }, useRef: () => ({ current: null }) }
  const clientHost = { call: async (method, args) => host.env.handlers[method](args) }
  const clientCtx = {
    get: (name) => (name === 'slots' ? slots : (name === 'sidebarRightTabs' ? undefined : undefined)),
    effect: (fn) => { fn(); return () => { } },
    timer: { timeout: async () => { }, interval: () => () => { } },
  }
  const clientPlugin = runBody(source(LOADER_CLIENT), ['React', 'host', 'styles', 'console'],
    [ReactStub, clientHost, styles, { log: () => { }, error: () => { } }])
  await clientPlugin.apply(clientCtx)
  check('加载进来的客户端真的注册了界面', registered.some((line) => line.indexOf('register:main') === 0),
    JSON.stringify(registered.slice(0, 6)))
  check('客户端的样式表也插进去了', registered.some((line) => line.indexOf('styles:') === 0))

  console.log('--- 注入：这三种坏法必须报出来，而不是安静地少一半')
  const notFound = await expectThrows(() => loadHost({ fs: {
    resolve: async (path) => ({ path: path }),
    readText: async () => { throw new Error('ENOENT: ' + '/home/gmh/mc-art/tools/mcart-plugin/host.js') },
  } }))
  check('host.js 读不到时会报错（含路径）',
    notFound !== null && String(notFound.message).indexOf('host.js') >= 0,
    notFound === null ? '没有报错' : String(notFound.message))

  const empty = await expectThrows(() => loadHost({ fs: {
    resolve: async (path) => ({ path: path }),
    readText: async () => '',
  } }))
  check('文件是空的也会报错', empty !== null && String(empty.message).indexOf('空的') >= 0,
    empty === null ? '没有报错' : String(empty.message))

  // The client asking a host that never registered `mcart.source` -- the race the
  // retry loop exists for, and the message has to say what came back.
  const brokenHost = { call: async () => ({ half: 'client' }) }
  const brokenClient = runBody(source(LOADER_CLIENT), ['React', 'host', 'styles', 'console'],
    [ReactStub, brokenHost, styles, { log: () => { }, error: () => { } }])
  const noSource = await expectThrows(() => brokenClient.apply(clientCtx))
  check('拿不到源码时报出返回了什么字段',
    noSource !== null && String(noSource.message).indexOf('返回的字段') >= 0,
    noSource === null ? '没有报错' : String(noSource.message))

  // The compile-in-global-scope trap, injected: compile host.js WITHOUT handing it
  // `harness`.  Reading the loader would not show this; running it does.
  const noHarness = await expectThrows(async () => {
    const text = source(nodePath.join(HERE, 'host.js'))
    const plugin = runBody(text, ['console', 'TextEncoder', 'btoa', 'atob'],
      [{ log: () => { } }, TextEncoder, btoa, atob])
    return plugin.apply(hostEnv().ctx)
  })
  check('少传一个 wrapper 绑定就会当场炸（这就是要逐个显式传的原因）',
    noHarness !== null && /harness is not defined/.test(String(noHarness.message)),
    noHarness === null ? '居然没炸' : String(noHarness.message))

  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
