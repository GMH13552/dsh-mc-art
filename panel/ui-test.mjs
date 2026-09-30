#!/usr/bin/env node
/**
 * 面板 UI 的**渲染门禁**：设置卡上该有的东西，真的画出来了吗？
 *
 * 为什么要有这一条：仓库原来只有"入口能不能装载"（`entry-test.mjs`）——它证明
 * `apply()` 不炸、槽注册对了，但**一帧都没画过**。于是这样的窟窿没人拦得住：
 *
 *   用户点开 ⚙ 设置，只有一个"选择目录…"按钮。那个按钮靠系统对话框，而对话框在某些
 *   环境里既不显示也不返回（shell 服务跑在非交互窗口站上时），于是"点了没反应、
 *   也**没有报错**"——因为设置卡当时压根不渲染 `notice`，而且没有任何手动输入路径的地方。
 *
 * 所以这里用一个小到够用的假 React（这个面板只用到 createElement / useState /
 * useEffect）真渲染一遍，然后**按按钮的文字去点它**，断言屏幕上出现什么。
 * 同时逐条断言"缺了就会出事"的东西：手输框、可见的提示、检测到的候选目录。
 *
 *   node panel/ui-test.mjs          # 渲染 + 交互 + 断言
 *   node panel/ui-test.mjs --fault  # 把设置卡里的手输框删掉，要求上面的断言变红
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = join(HERE, '..', 'tools', 'mcart-plugin', 'client.js')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

// ── 假 React：只实现这个面板用到的那三个 API，行为对齐真 React 的语义 ────────────
function createReact() {
  const store = []
  const effects = []
  let cursor = 0
  let dirty = false
  return {
    api: {
      createElement: (type, props, ...children) => ({
        type: type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      }),
      useState: (initial) => {
        const at = cursor++
        if (!(at in store)) store[at] = typeof initial === 'function' ? initial() : initial
        return [store[at], (next) => {
          const value = typeof next === 'function' ? next(store[at]) : next
          if (value !== store[at]) { store[at] = value; dirty = true }
        }]
      },
      useEffect: (fn, deps) => {
        const at = cursor++
        const previous = effects[at]
        const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps) &&
          deps.length === previous.deps.length && deps.every((item, index) => item === previous.deps[index])
        if (!same) effects[at] = { deps: deps, pending: fn, previous: previous }
      },
    },
    beginPass: () => { cursor = 0; dirty = false },
    isDirty: () => dirty,
    /** 跑这一遍登记下来的 effect；返回有没有跑（跑过就要再渲染一遍）。 */
    flushEffects: () => {
      let ran = false
      for (const slot of effects) {
        if (slot === undefined || slot.pending === undefined) continue
        const stop = slot.pending()
        slot.pending = undefined
        slot.cleanup = typeof stop === 'function' ? stop : undefined
        ran = true
      }
      return ran
    },
  }
}

/** 把渲染出来的元素树摊平，方便按文字/类型找东西。 */
function walk(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/**
 * 渲染一个组件，并把"点某个按钮"做成可调用：`click(label)` 会找到按钮点下去，
 * 然后继续把 effect / promise 抽干，直到界面稳定。
 */
/** 假宿主：**同一个对象**既交给插件（组件闭包捕获它），也用来记调用。 */
function makeHost(hostCalls) {
  return {
    call: async (name, args) => {
      hostCalls.push({ name: name, args: args })
      const made = await handlers(name, args)
      return made === undefined ? {} : made
    },
  }
}

async function mount(component, props, host, react) {
  let tree = null
  // 槽里注册的通常是 `() => <Atlas …/>` 这种包装：它自己不用 hook，真正的组件是里层。
  // 假 React 没有"调用函数组件"的机制，所以这里手工穿一层（穿到不是函数为止）。
  function resolve(element) {
    let node = element
    for (let depth = 0; depth < 4 && node !== null && typeof node === 'object' && typeof node.type === 'function'; depth++) {
      node = node.type(node.props)
    }
    return node
  }
  async function settle(limit) {
    let quiet = 0
    for (let pass = 0; pass < (limit === undefined ? 60 : limit); pass++) {
      react.beginPass()
      tree = resolve(component(props))
      const ran = react.flushEffects()
      // 抽干 effect 里发出的 host.call：它们大多要两三个 tick 才有结果，
      // 而"这一遍没跑 effect"不等于"界面稳定了"（promise 还没回来）。
      await new Promise((resolveTick) => setTimeout(resolveTick, 0))
      await new Promise((resolveTick) => setImmediate(resolveTick))
      if (!ran && !react.isDirty()) quiet += 1
      else quiet = 0
      if (quiet >= 3) return
    }
  }
  function nodes() { return walk(tree, []) }
  function buttons() {
    return nodes().filter((node) => node.type === 'button')
  }
  function byText(label) {
    return nodes().filter((node) => textOf(node) === label)[0]
  }
  await settle()
  return {
    settle: settle,
    text: () => textOf(tree),
    buttons: () => buttons().map((button) => textOf(button)),
    has: (label) => nodes().some((node) => textOf(node).indexOf(label) >= 0),
    inputs: () => nodes().filter((node) => node.type === 'input'),
    /** 按文字点按钮（真实的 onClick，不是模拟事件）。 */
    async click(label) {
      const button = buttons().filter((node) => textOf(node) === label)[0]
      if (button === undefined) throw new Error('屏幕上没有写着「' + label + '」的按钮。现在有：' + buttons().map(textOf).join(' / '))
      await button.props.onClick()
      await settle()
    },
    /** 直接调某个按钮的 onClick（返回值也拿到，便于断言 promise）。 */
    buttonProps(label) {
      const button = buttons().filter((node) => textOf(node) === label)[0]
      return button === undefined ? undefined : button.props
    },
  }
}

// ── 假宿主：把面板要问的问题都答上，答什么由这个用例决定 ────────────────────────
const PROJECT = { id: 'ui_probe', title: 'UI 探针', namespace: 'ui_probe', root: '/tmp/ui-shop' }
const CWD = '/tmp/ui-shop'
let pickerReply = { supported: false, detail: '宿主没有 shell 服务，' }
let savedSettings = null
let handlers = async () => ({})

function makeHandlers(options) {
  const settings = {
    path: 'ui_probe/mc-art.settings.json', project: PROJECT.id, title: PROJECT.title,
    file: CWD + '/ui_probe/mc-art.settings.json', directory: '',
    shape: '', textures: 0, sources: [], scanError: null, scanner: null,
    detected: options.detected || [], includeGenerated: true, includeMods: false, mods: [],
  }
  return async (name, args) => {
    if (name === 'atlas.session') return { cwd: CWD }
    if (name === 'atlas.projects') return { base: CWD, projects: [Project_dir()] }
    if (name === 'atlas.scan') {
      return { rootSpecified: true, root: (args || {}).root, cached: false, errors: [],
        projects: [{ id: PROJECT.id, title: PROJECT.title, namespace: PROJECT.namespace, root: (args || {}).root,
          items: { biome: [], structure: [], entity: [], block: [] } }] }
    }
    if (name === 'atlas.settings') return Object.assign({}, settings, savedSettings === null ? {} : { directory: savedSettings })
    if (name === 'atlas.saveSettings') { savedSettings = (args || {}).directory; return { saved: true, file: settings.file, path: settings.path, via: 'fs' } }
    if (name === 'atlas.pickDirectory') return pickerReply
    if (name === 'atlas.scene') return { kind: 'block', id: '', quads: [], textureIds: [], textures: {}, animations: {}, cells: null, refs: [], box: null, errors: [] }
    if (name === 'atlas.itemIcons' || name === 'atlas.icons' || name === 'atlas.refIcons') return { icons: {}, items: {}, names: {}, failed: [] }
    if (name === 'atlas.refNamespaces') return { namespaces: [], directory: '', reason: '没有设置参考目录' }
    return {}
  }
}
const Project_dir = () => ({ root: CWD, id: PROJECT.id, title: PROJECT.title, namespace: PROJECT.namespace, dir: CWD + '/' + PROJECT.id })

/** 用（可被 --fault 改写的）源码搭出插件，并拿到它注册的那个组件。 */
function buildPanel(source, host, reactApi) {
  const seen = []
  const slots = {
    inject: (slot, callback) => callback(),
    register: (settings, component) => {
      seen.push({ settings: settings, component: component })
      return () => {}
    },
    entries: () => [],
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    inject: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    timer: { interval: () => () => {}, timeout: async () => {} },
  }
  const styles = { insert: () => () => {}, remove: () => {} }
  const plugin = new Function('React', 'host', 'styles', 'console', source)(
    reactApi, host, styles, console)
  plugin.apply(ctx)
  const main = seen.filter((item) => item.settings.name === 'main')[0]
  if (main === undefined) throw new Error('客户端没有注册 main 槽：' + seen.map((i) => i.settings.name).join(','))
  return main.component
}

async function main() {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const faulted = FAULT
    ? source.replace(/rows\.push\(React\.createElement\('div', \{ className: 'mcart-bar', key: 'dirinput' \}[\s\S]*?\)\)\n/, '')
    : source
  if (FAULT && faulted === source) {
    console.log('  FAIL --fault 没生效：源码里找不到设置卡的手输框那一段（门禁要跟着改）')
    process.exit(1)
  }

  console.log('--- 设置卡：手输路径 + 可见提示 + 检出的候选目录')
  handlers = makeHandlers({ detected: ['C:\\Users\\probe\\AppData\\Roaming\\.minecraft'] })
  pickerReply = { supported: false, detail: '宿主没有 shell 服务，' }
  savedSettings = null
  const calls = []
  // 顺序与"同一个实例"都要紧：假 React 和假宿主各只能造一份 ——
  // 插件（组件闭包）和渲染循环用的是同一对，否则 hook 状态和调用记录会分家。
  const react = createReact()
  const host = makeHost(calls)
  const component = buildPanel(faulted, host, react.api)
  const ui = await mount(component, { sessionId: 'ui-test' }, host, react)

  // 进到"有项目"的状态：先用本会话目录，再点 ⚙。
  if (process.env.UI_DEBUG === '1') {
    console.log('  [debug] host 调用：', calls.map((call) => call.name).join(', '))
    console.log('  [debug] 首屏按钮：', ui.buttons().join(' / '))
    console.log('  [debug] 首屏文本：', ui.text().replace(/\s+/g, ' ').slice(0, 300))
  }
  await ui.click('用本会话目录')
  await ui.click('⚙')

  const inputs = ui.inputs()
  const dirInput = inputs.filter((node) => String(node.props.placeholder || '').indexOf('参考目录路径') >= 0)[0]
  check('设置卡里有可以手输参考目录的输入框', dirInput !== undefined,
    '输入框：' + JSON.stringify(inputs.map((node) => node.props.placeholder || node.props.type)))
  check('输入框配着"用这个路径"按钮', ui.buttonProps('用这个路径') !== undefined, ui.buttons().join(' / '))
  check('系统对话框那条路还在（选择目录…）', ui.buttonProps('选择目录…') !== undefined, ui.buttons().join(' / '))
  check('检测到的候选目录画出来了（带"用它"）',
    ui.has('C:\\Users\\probe\\AppData\\Roaming\\.minecraft') && ui.buttonProps('用它') !== undefined,
    ui.buttons().join(' / '))

  // 对话框弹不出来：提示必须**出现在设置卡里**（这就是"点了没反应也没有报错"的修法）。
  await ui.click('选择目录…')
  const said = ui.text()
  check('对话框不可用时，设置卡里能看到原因（不再是一片安静）',
    said.indexOf('宿主没有 shell 服务') >= 0, said.slice(-260))
  check('并且明确告诉用户去用输入框', said.indexOf('输入框') >= 0, said.slice(-160))

  // 手输一条路径 → 它必须真的写进设置。
  if (dirInput !== undefined) {
    dirInput.props.onChange({ target: { value: 'D:\\games\\.minecraft' } })
    await ui.settle()
    const again = ui.inputs().filter((node) => String(node.props.placeholder || '').indexOf('参考目录路径') >= 0)[0]
    check('输入框里能看到刚打的字（受控输入）',
      again !== undefined && again.props.value === 'D:\\games\\.minecraft',
      again === undefined ? '输入框没了' : JSON.stringify(again.props.value))
    await ui.click('用这个路径')
    const wrote = calls.filter((call) => call.name === 'atlas.saveSettings').pop()
    check('点"用这个路径"真的把路径写进了设置',
      wrote !== undefined && wrote.args && wrote.args.directory === 'D:\\games\\.minecraft',
      JSON.stringify(wrote && wrote.args))
  }

  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error('THREW', error); process.exit(1) })
