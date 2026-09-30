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
// 第二个故障模式：把"JSON 丢字段"那处的守卫还原成旧的 `=== null` 写法
// （用户实测的崩溃：`Cannot read properties of undefined (reading 'textureIds')`）。
const FAULT_JSON = process.argv.includes('--fault-json')
// 第三个故障模式：把"刷新时丢像素缓存"那一句删掉（用户实测："改完纹理点刷新看不到新的"）。
const FAULT_REFRESH = process.argv.includes('--fault-refresh')
// 第四个故障模式：清缓存但**不踢纪元**（用户实测："刷新完了之后 2D 贴图没有了"）。
const FAULT_EPOCH = process.argv.includes('--fault-epoch')

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
      Component: class Component {
        constructor(props) { this.props = props || {}; this.state = this.state || {} }
        setState(next) { this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next) }
      },
      // **和真 React 一样**：只有一个孩子时 `props.children` 就是那个孩子本身，
      // 不是数组。差别在这里会咬人：渲染边界 render() 返回 `this.props.children`，
      // 拿到数组就没人再往下渲染了（面板会渲染成空 —— 正是"白屏"那个症状）。
      createElement: (type, props, ...children) => {
        const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
        const merged = Object.assign({}, props || {})
        if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids
        return { type: type, props: merged,
          children: kids }
      },
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
  /**
   * 沿"组件链"下降：槽里注册的包装 → 渲染边界（类组件）→ Atlas（函数组件），
   * 直到遇到宿主元素（div 之类）为止。**不递归调用树里的其他函数组件** ——
   * 假 React 没有 React 那套"每个组件自己的 hook 状态"，递归调用会把 hook 顺序搞乱。
   *
   * 链上函数组件抛出的异常，交给栈里最近的类边界（`getDerivedStateFromError`），
   * 这就是"渲染炸了不能白屏"要验证的那条路径。
   */
  function renderChain(element, stack) {
    let node = element
    for (let depth = 0; depth < 8; depth++) {
      if (node === null || node === undefined || typeof node !== 'object' || typeof node.type !== 'function') return node
      const type = node.type
      const props = node.props || {}
      const isClass = type.prototype !== undefined && typeof type.prototype.render === 'function'
      if (isClass) {
        const instance = new type(props)
        instance.props = props
        if (instance.state === undefined || instance.state === null) instance.state = {}
        stack.push(instance)
        node = instance.render()
        continue
      }
      try {
        node = type(props)
      } catch (error) {
        let boundaryAt = -1
        for (let at = stack.length - 1; at >= 0; at--) {
          const ctor = stack[at].constructor || {}
          if (typeof ctor.getDerivedStateFromError === 'function') { boundaryAt = at; break }
        }
        if (boundaryAt < 0) throw error
        const instance = stack[boundaryAt]
        instance.state = instance.constructor.getDerivedStateFromError(error)
        stack.length = boundaryAt + 1
        node = instance.render()
      }
    }
    return node
  }

  async function settle(limit) {
    let quiet = 0
    for (let pass = 0; pass < (limit === undefined ? 60 : limit); pass++) {
      react.beginPass()
      tree = renderChain(component(props), [])
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
    /** 按"文字包含"点按钮：菜单里那一行是 `标题id` 连在一起的，精确匹配会找不到。 */
    async clickLabel(fragment) {
      const button = buttons().filter((node) => textOf(node).indexOf(fragment) >= 0)[0]
      if (button === undefined) throw new Error('屏幕上没有文字包含「' + fragment + '」的按钮。现在有：' + buttons().map(textOf).join(' / '))
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
          // 有物品可选：下面那条"recipe 缺失"的用例要从菜单点进去
          items: { biome: [], structure: [], entity: [], block: [{ id: 'example_block', title: '示例方块' }] } }] }
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
  const plugin = new Function('React', 'host', 'styles', 'console', 'PANEL_VERSION', source)(
    reactApi, host, styles, console, '0.0.0-test')
  plugin.apply(ctx)
  const main = seen.filter((item) => item.settings.name === 'main')[0]
  if (main === undefined) throw new Error('客户端没有注册 main 槽：' + seen.map((i) => i.settings.name).join(','))
  return main.component
}

async function main() {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  let faulted = source
  if (FAULT_JSON) {
    faulted = source.replace('const ids = idsOf(asset.recipe)',
      "const ids = asset.recipe === null ? [] : (asset.recipe.textureIds || [])")
    if (faulted === source) {
      console.log('  FAIL --fault-json 没生效：找不到 idsOf(asset.recipe) 那一处（门禁要跟着改）')
      process.exit(1)
    }
  } else if (FAULT_REFRESH) {
    faulted = source.replace('onClick: () => { forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null) }',
      'onClick: () => scan(root, true, null)')
    if (faulted === source) {
      console.log('  FAIL --fault-refresh 没生效：找不到刷新按钮里那句 forgetTextures()（门禁要跟着改）')
      process.exit(1)
    }
  } else if (FAULT_EPOCH) {
    // 只删纪元那一脚，缓存照旧清 —— 用户实测的那个回归就是这个形状：
    // 表清空了，可没人再把它填回来（物品浏览器/九宫格/左边菜单全空白）。
    faulted = source.replace('forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null)',
      'forgetTextures(); scan(root, true, null)')
    if (faulted === source) {
      console.log('  FAIL --fault-epoch 没生效：找不到刷新按钮里那句 setTexEpoch（门禁要跟着改）')
      process.exit(1)
    }
  } else if (FAULT) {
    faulted = source.replace(/rows\.push\(React\.createElement\('div', \{ className: 'mcart-bar', key: 'dirinput' \}[\s\S]*?\)\)\n/, '')
    if (faulted === source) {
      console.log('  FAIL --fault 没生效：源码里找不到设置卡的手输框那一段（门禁要跟着改）')
      process.exit(1)
    }
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

  // ── 渲染炸了不许白屏：边界必须把错误画出来 ────────────────────────────────
  console.log('--- 渲染异常：边界要把话画出来（而不是一片空白）')
  globalThis.__MCART_FORCE_RENDER_ERROR__ = true
  try {
    const boom = await mount(component, { sessionId: 'ui-test' }, host, react)
    check('渲染抛异常时，屏幕上出现错误文字（不是空白）',
      boom.text().indexOf('面板渲染失败') >= 0 && boom.text().indexOf('注入的渲染错误') >= 0,
      boom.text().slice(0, 160) || '（空白）')
    check('并且带着可报的版本号', boom.text().indexOf('0.0.0-test') >= 0, boom.text().slice(0, 200))
  } finally {
    globalThis.__MCART_FORCE_RENDER_ERROR__ = false
  }

  // ── 用户实测那次崩溃的前提：选中一个物品，但它的 recipe 不在 ──────────────────
  //
  // 宿主与面板走 JSON，`undefined` 字段会被丢掉 —— 于是"没有这个物品的配方"到客户端
  // 就是 `undefined`，而旧代码只写了 `=== null` 守卫：
  //   `asset.recipe === null ? [] : asset.recipe.textureIds`  → 当场抛
  //   "Cannot read properties of undefined (reading 'textureIds')" → 白屏。
  // 这里复现它，要求：**面板照常渲染**（出现边界那句话就算失败）。
  console.log('--- 物品的配方缺失（JSON 丢字段那种）：不许白屏')
  globalThis.__MCART_FORCE_RENDER_ERROR__ = false
  calls.length = 0
  // 注意：**必须复用同一个假 React 实例** —— 组件的 hook 是绑在它上面的，
  // 换一个新实例等于状态分家（第一次换实例时表现是"这次挂载一个 host 调用都没有"）。
  const itemUi = await mount(component, { sessionId: 'ui-test' }, host, react)
  if (itemUi.buttonProps('用本会话目录') !== undefined) await itemUi.click('用本会话目录')
  if (process.env.UI_DEBUG === '1') {
    console.log('  [debug] 物品用例屏上：' + itemUi.text().slice(0, 200) + ' || 按钮：' + itemUi.buttons().join(' / '))
    console.log('  [debug] 这次挂载的 host 调用：' + calls.map((call) => call.name).join(', '))
  }
  // 菜单里的物品按钮：点了它会去取 3D/图标，而它的 recipe 不存在
  const clicked = await itemUi.clickLabel('示例方块').then(() => true).catch(() => false)
  check('能点开一个"配方缺失"的物品（菜单里有它）', clicked === true, itemUi.buttons().join(' / '))
  const itemText = itemUi.text()
  check('配方缺失时面板照常渲染（不是白屏、也不该走边界）',
    itemText.indexOf('面板渲染失败') < 0 && itemText.length > 0, itemText.slice(0, 160) || '（空白）')

  // ── 形状不变量：每一次读 `.textureIds` 都必须是"总取值" ─────────────────────
  //
  // 用户实测的崩溃是 `Cannot read properties of undefined (reading 'textureIds')`：
  // 宿主与面板走 JSON，**`undefined` 字段会被丢掉**，所以"少一个字段"是常态，
  // 而代码里大量守卫只写了 `=== null`（107 处）。与其逐个补，不如把这条钉死：
  // 发出去的客户端里，任何 `.textureIds` 的读取要么走 idsOf()，要么先 Array.isArray，
  // 要么是在归一化构造里（`textureIds: idsOf(...)`）。
  const rawReads = faulted.split('\n').filter((line) => /\.textureIds\b/.test(line)).filter((line) => {
    if (line.indexOf('idsOf(') >= 0) return false
    if (line.indexOf('Array.isArray') >= 0) return false
    if (/textureIds:\s*idsOf\(/.test(line)) return false
    if (/^\s*(\*|\/\/)/.test(line)) return false
    return true
  })
  check('客户端里没有"裸读 .textureIds"的地方（JSON 丢字段不会白屏）',
    rawReads.length === 0, rawReads.map((line) => line.trim().slice(0, 90)).join(' ｜ '))

  // ── 刷新必须丢掉像素缓存（用户实测："agent 改完纹理，点刷新看不到新的"）──────────
  //
  // 这是**源码形状**检查，不是行为检查，我把它标清楚：场景请求带 `have:
  // Object.keys(decoded)`，宿主只送客户端没有的贴图；而解码要真的 canvas（`scratch`），
  // Node 里没有，所以"缓存有没有丢"没法在这条门禁里跑出来。钉住的是那三件事：
  // 清空函数存在且清三张表、刷新按钮调它、换项目也调它。
  console.log('--- 刷新/换项目会丢像素缓存（源码形状检查）')
  // **六张表**都要清：三张像素级的（decoded/failedTex/itemUrls）+ 三张按名字记的
  // （icons/iconTried/itemRecipes —— 左边菜单的方块图标、物品浏览器、配方）。
  // 只清前三个的时候用户实测过："3D 换了、菜单图标还是旧的"。
  const clearedTables = ['decoded', 'failedTex', 'itemUrls', 'icons', 'iconTried', 'itemRecipes']
  check('有 forgetTextures()，而且六张缓存表都清（像素级 3 张 + 按名字记的 3 张）',
    /function forgetTextures\(\)/.test(faulted) &&
    clearedTables.every((name) => new RegExp('delete ' + name + '\\[key\\]').test(faulted)),
    clearedTables.filter((name) => !new RegExp('delete ' + name + '\\[key\\]').test(faulted)).join('、') + ' 没清')
  // 注意范围：源码别处有一处正当的 `delete imageNodes[key]`（打开新资产时清节点），
  // 所以要**只看 forgetTextures 的函数体**，别把那一处当成违规。
  const forgetBody = (faulted.match(/function forgetTextures\(\) \{[\s\S]*?\n\}/) || [''])[0]
  check('forgetTextures 里**没有**清 imageNodes（ref 登记的 <img>，清了会让解码永远等不到 complete）',
    forgetBody !== '' && !/delete imageNodes\[/.test(forgetBody),
    forgetBody === '' ? '函数体都没匹配到（门禁要跟着改）' : '函数体里清了 imageNodes')
  check('刷新按钮先丢缓存再强制重扫（否则 have 里还留着旧 id，宿主永远不会再送）',
    /onClick: \(\) => \{ forgetTextures\(\); setTexEpoch\(texEpoch \+ 1\); scan\(root, true, null\) \}/.test(faulted),
    '（刷新按钮没接上 forgetTextures）')
  check('换项目时也丢（同名贴图跨项目会串味）',
    /if \(lastProject !== target\.project\) \{ forgetTextures\(\); setTexEpoch\(texEpoch \+ 1\) \}/.test(faulted))

  // ── 清空之后必须有人把它填回来（用户实测："刷新完了之后 2D 贴图没有了"）─────────
  //
  // 上一轮只做了"清"，没做"再取"：`itemRecipes`（物品浏览器 + 九宫格）和 `icons`
  // （左边菜单的方块图标）都是被 effect 填的，而那两个 effect 的依赖里**没有**刷新
  // 会改的东西（依赖是"命名空间|页|筛选|形态|家族|条目数"和"资产|筛选|页"）——
  // 表清空了、依赖没变、effect 不重跑，于是屏幕上就是一片空白。
  // 机制是一个纪元号（texEpoch），所以这里断言的是"纪元在依赖里"，不是某个变量名巧合。
  console.log('--- 清了缓存必须再取（源码形状检查，同上一段理由）')
  const itemEffect = (faulted.match(/\}, \[item === null \? '' : \[[\s\S]*?\]\)/) || [''])[0]
  check('物品配方的 effect 依赖里有纪元（不然清完 itemRecipes 没人再取：浏览器和九宫格空白）',
    itemEffect !== '' && /texEpoch\]/.test(itemEffect), itemEffect === '' ? '没匹配到那个 effect 的依赖数组' : itemEffect.slice(0, 90))
  const iconEffect = (faulted.match(/\}, \[voxel === null \? '' : \(voxel\.source[\s\S]*?iconTick[^\]]*\]\)/) || [''])[0]
  check('方块图标的 effect 依赖里有纪元（不然左边菜单的图标清完不回来）',
    iconEffect !== '' && /texEpoch/.test(iconEffect), iconEffect === '' ? '没匹配到那个 effect 的依赖数组' : iconEffect.slice(0, 90))
  check('刷新会踢纪元、换项目也会踢', [/setTexEpoch\(texEpoch \+ 1\); scan\(root, true, null\)/,
    /\{ forgetTextures\(\); setTexEpoch\(texEpoch \+ 1\) \}/].every((re) => re.test(faulted)))
  check('取不到图标时屏幕上有话（静默失败 = 图标凭空消失，没人知道为什么）',
    /itemFetchError = '取不到物品图标：' \+ failed/.test(faulted)
    && /itemFetchError === '' \? '点一格就放到上面的 3D 里看' : itemFetchError/.test(faulted))
  check('图标"问过了"的账在请求失败时会退回来（一次抖动不该让图标永久不出现）',
    /for \(const name of batch\) delete iconTried\[name\]/.test(faulted))

  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error('THREW', error); process.exit(1) })
