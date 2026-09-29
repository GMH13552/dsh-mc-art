#!/usr/bin/env node
/**
 * 送达门禁：装进 profile 的那个包，**真的被浏览器收到了吗、真的跑起来了吗**？
 *
 * 为什么需要它：`--dump-config` 只证明"组合里有一行"，`entry-test.mjs` 只证明
 * "两个入口在 Node 里能装载"。真正会静默出事的是这两者之间那一层——
 * dsh 的 client-modules 按**启动图里那一行的 id**（= 包名）去 factories 里找模块，
 * 找不到就只在页面顶上写一行 "Failed to load plugins: <包名>"。
 * 这一层用任何离线门禁都测不到：包能装、入口能跑，页面上却什么都不出现。
 *
 * 这个脚本对着一个**真在跑的实例**做三件事：
 *   1. 从首页 HTML 的启动图里取出我们那一行（id / url / rev / inject）；
 *   2. 取那条 bundle 的真实字节，与 panel/lib/client.js 逐字符比对
 *      （服务器只允许追加 `;` 和 sourceMappingURL 注释）；
 *   3. 用真浏览器打开页面，要求我们的客户端半留下激活痕迹
 *      （它 apply 时会插一个 `<style data-plugin="<包名>">`），
 *      并且页面上没有 "Failed to load plugins"。
 *
 * 用法（要先有一个装着本包的实例在跑；临时实例的起法见 panel/README.md）：
 *
 *   node panel/serve-check.mjs --url http://127.0.0.1:3099 --token <首页 URL 里的 token>
 *   node panel/serve-check.mjs --url … --token … --chrome /path/to/chrome --cdp-port 9334
 *
 * 未指定的 chrome 会按常见位置找一个；找不到就只跑第 1、2 步并明说第 3 步没跑。
 */
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).name
const LOCAL_BUNDLE = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--' + name + ' 后面要跟一个值')
  return value
}

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  OK   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

const BASE = (arg('url', 'http://127.0.0.1:3099')).replace(/\/$/, '')
const TOKEN = arg('token', '')
const CDP_PORT = Number(arg('cdp-port', '9334'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 带 token 取首页，并把服务器给的 cookie 留在手上（后续 bundle 请求要用它）。 */
async function fetchIndex() {
  const first = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' })
  const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const page = await fetch(`${BASE}/`, { headers: cookie === '' ? {} : { cookie } })
  return { html: await page.text(), cookie, status: page.status }
}

/** 从首页 HTML 的启动图里抠出我们那一行。 */
function graphEntry(html) {
  const match = new RegExp('"id":"' + PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '","url":"([^"]+)"').exec(html)
  if (match === null) return null
  const url = match[1].replace(/&amp;/g, '&')
  const inject = new RegExp('"id":"' + PACKAGE_NAME + '"[^}]*?"inject":\\[([^\\]]*)\\]').exec(html)
  return { url, inject: inject === null ? '(没读到)' : inject[1] }
}

function findChrome() {
  const explicit = arg('chrome', '')
  if (explicit !== '') return explicit
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.env.HOME === undefined ? [] : [
      join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome'),
      join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux/chrome'),
    ]),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter((value) => value !== undefined && value !== '')
  for (const path of candidates) if (existsSync(path)) return path
  return null
}

/** 真浏览器：加载页面，读激活痕迹。返回 null 表示这一层没跑。 */
async function browserCheck(chrome) {
  const profile = mkdtempSync(join(tmpdir(), 'mcart-serve-check-'))
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })
  try {
    let targets = null
    for (let i = 0; i < 40; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        if (targets.some((t) => t.type === 'page')) break
      } catch {}
      await wait(500)
    }
    const page = (targets ?? []).find((t) => t.type === 'page')
    if (page === undefined) { check('浏览器起来了', false, '连不上 CDP'); return null }

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const pending = new Map()
    const errors = []
    let id = 0
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return }
      if (message.method === 'Runtime.exceptionThrown') {
        errors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 200))
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200))
      }
    }
    const send = (method, params = {}) => new Promise((resolve) => {
      const ticket = ++id
      pending.set(ticket, resolve)
      ws.send(JSON.stringify({ id: ticket, method, params }))
    })
    await new Promise((resolve) => { ws.onopen = resolve })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(TOKEN)}` })
    await wait(22000)
    const expression = `JSON.stringify({
      banner: document.body.innerText.includes('Failed to load plugins'),
      stylePlugin: [...document.querySelectorAll('style[data-plugin]')].map(s => s.dataset.plugin).filter(n => n === ${JSON.stringify(PACKAGE_NAME)}),
      cssChars: (document.querySelector('style[data-plugin=' + JSON.stringify(${JSON.stringify(PACKAGE_NAME)}) + ']') || {textContent:''}).textContent.length,
    })`
    const out = await send('Runtime.evaluate', { expression, returnByValue: true })
    ws.close()
    const state = JSON.parse(out.result?.result?.value ?? '{}')
    const ours = errors.filter((e) => /mcart|mc-art/i.test(e))
    check('页面上没有 "Failed to load plugins"', state.banner !== true)
    check('客户端半真的 apply 了（插出 data-plugin 样式表）',
      (state.stylePlugin ?? []).includes(PACKAGE_NAME) && state.cssChars > 0,
      'data-plugin=' + JSON.stringify(state.stylePlugin) + ' css=' + state.cssChars + ' 字符')
    check('没有与这个包相关的控制台错误', ours.length === 0, ours.join(' | '))
    return { errors, state }
  } finally {
    child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

// ── 1. 启动图 ───────────────────────────────────────────────────────────────
console.log('--- 启动图（首页 HTML 里那一行）')
const index = await fetchIndex()
check('首页取得到（HTTP 200）', index.status === 200, 'HTTP ' + index.status)
const entry = graphEntry(index.html)
check(`启动图里有 ${PACKAGE_NAME}`, entry !== null)
check('那一行带 inject 列表（客户端要靠它拿 React 与服务）',
  entry !== null && entry.inject !== '(没读到)' && entry.inject.trim() !== '', entry === null ? '' : entry.inject)

// ── 2. 送到的字节 ───────────────────────────────────────────────────────────
if (entry !== null) {
  console.log('--- 送到浏览器的字节')
  const served = await (await fetch(new URL(entry.url, BASE), { headers: { cookie: index.cookie } })).text()
  // 服务器会在末尾追加 `;\n//# sourceMappingURL=…`；除此之外必须逐字符相同。
  const tail = served.slice(LOCAL_BUNDLE.length)
  check('服务器送的就是 panel/lib/client.js（只允许多一段 sourceMappingURL 尾巴）',
    served.startsWith(LOCAL_BUNDLE) && /^;\n\/\/# sourceMappingURL=/.test(tail),
    served.length + ' 送到 / ' + LOCAL_BUNDLE.length + ' 本地 / 尾巴 ' + JSON.stringify(tail.slice(0, 60)))
  check('bundle 里注册的 id 就是包名',
    served.includes(`id: ${JSON.stringify(PACKAGE_NAME)}`),
    '实际注册成 ' + JSON.stringify((/id: "[^"]*"/.exec(served) ?? ['(没找到)'])[0]))
}

// ── 3. 真浏览器 ─────────────────────────────────────────────────────────────
console.log('--- 真浏览器里加载')
const chrome = findChrome()
if (chrome === null) {
  console.log('  SKIP 没找到 chrome/chromium（用 --chrome 指定），第 3 步没跑')
} else {
  await browserCheck(chrome)
}

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
