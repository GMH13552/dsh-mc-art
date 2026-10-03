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
// ↑ 四条是老门禁。下面这些是这一轮新增的，每条都对应一个用户实测过的症状：
const FAULT_FORGET = process.argv.includes('--fault-forget')       // 六张缓存表少清一张
const FAULT_INJECT = process.argv.includes('--fault-inject')       // 红线：把文本塞进会话/agent
const FAULT_DIAGNOSTIC = process.argv.includes('--fault-diagnostic') // 项目自己的缺失说成"缺的原版母模型"
const FAULT_VERSION = process.argv.includes('--fault-version')     // 报错不带版本号
const FAULT_COPY = process.argv.includes('--fault-copy')           // 复制报告不设防
const FAULT_SCENE = process.argv.includes('--fault-scene')         // 畸形场景不归一化 → 白屏
const FAULT_SIDEBAR = process.argv.includes('--fault-sidebar')     // 右侧栏没服务时两处都没有
const FAULT_PNG = process.argv.includes('--fault-png')             // 非 PNG 也发给宿主
const FAULT_SAVEPATH = process.argv.includes('--fault-savepath')   // 不挡绝对路径句柄
const FAULT_FACES = process.argv.includes('--fault-faces')         // 按面编辑退化
const FAULT_POSTER = process.argv.includes('--fault-poster')       // 2D 回退被拉宽
// 未知 reason 的兜底：把"原值照贴"改回"只说原因不明"，要求新契约取值在屏幕上没有原值。
const FAULT_REASON = process.argv.includes('--fault-reason')
// 「不许覆盖用户正在写的东西」这条去掉 → 草稿非空时也会被报告冲掉。
const FAULT_AUTOFILL = process.argv.includes('--fault-autofill')
// 平面物品预览空白：把"没面也算没东西画"和"参考物品失败时清场景"一起还原成旧行为。
const FAULT_FLAT_BLANK = process.argv.includes('--fault-flat-blank')
// 缺图标的那一格被渲染成静默空白（旧行为）：没有"缺"角标、title 里也没有原因。
const FAULT_MISSING_BLANK = process.argv.includes('--fault-missing-blank')
// 忽略宿主给的 `animationNotes`（旧行为）→ ".mcmeta 在但读不了"又被说成"没有动画描述"。
const FAULT_ANIMNOTES = process.argv.includes('--fault-animnotes')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

// ── 假 React：只实现这个面板用到的那三个 API，行为对齐真 React 的语义 ────────────
//
// hook 状态按**渲染归属**分桶：同一个面板里有两个注册点（`main` 里的 Atlas 和
// `conversation.input.dock` 里的引用条）。真 React 里它们是两棵子树、状态互不干扰；
// 用一个数组存就会互相踩（引用条的 useState 读到 Atlas 的第 0 个状态），
// 于是"插入输入框只是写输入框"这条根本没法真跑。所以 store 按 owner 分。
function createReact() {
  const stores = new Map()
  const effectStores = new Map()
  const cursors = new Map()
  let owner = 'main'
  let dirty = false
  const bucket = (map) => {
    if (!map.has(owner)) map.set(owner, [])
    return map.get(owner)
  }
  const at = () => { const index = cursors.get(owner) || 0; cursors.set(owner, index + 1); return index }
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
        const store = bucket(stores)
        const index = at()
        if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
        return [store[index], (next) => {
          const value = typeof next === 'function' ? next(store[index]) : next
          if (value !== store[index]) { store[index] = value; dirty = true }
        }]
      },
      useEffect: (fn, deps) => {
        const store = bucket(effectStores)
        const index = at()
        const previous = store[index]
        const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps) &&
          deps.length === previous.deps.length && deps.every((item, at) => item === previous.deps[at])
        if (!same) store[index] = { deps: deps, pending: fn, previous: previous }
      },
    },
    /** 下一遍渲染算谁的 hook（`main` / `dock` 各算各的）。 */
    beginPass: (name) => {
      owner = name === undefined ? 'main' : name
      cursors.set(owner, 0)
      dirty = false
    },
    isDirty: () => dirty,
    /** 跑这一遍登记下来的 effect；返回有没有跑（跑过就要再渲染一遍）。 */
    flushEffects: () => {
      let ran = false
      for (const store of effectStores.values()) {
        for (const slot of store) {
          if (slot === undefined || slot.pending === undefined) continue
          const stop = slot.pending()
          slot.pending = undefined
          slot.cleanup = typeof stop === 'function' ? stop : undefined
          ran = true
        }
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

// ── 假画布 / 假 <img>：让"像素真的解码了"在 Node 里也能跑 ────────────────────────
//
// 3D 视图和像素编辑器的路是：宿主送 base64 贴图 → 面板画一个隐藏 <img> → 解码 effect
// 把 <img> 画进隐藏 canvas 再读回像素（`decoded`）。Node 里没有浏览器，所以这里给 ref
// 一个够用的假件。有了它，"手动修改 → 按面编辑 → 保存发出去的确实是 PNG"才能用**行为**
// 验，而不是只搜源码里的字符串（字符串在、路不通，正是这个仓库吃过的亏）。
//
// 这一版把 canvas 做成**真的像素缓冲**：`putImageData` / `drawImage` 真的落字节，于是
// "取景框里到底有没有东西"可以用**像素**量（用户报的正是"预览看不到"），而不是看源码里
// 有没有那个分支。`renderScene` 与 `drawItemIcon` 是纯函数，喂真缓冲就能真画出来。
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_DATA_URL = 'data:image/png;base64,'
  + Buffer.from(PNG_MAGIC.concat([0, 0, 0, 0, 0, 0, 0, 0])).toString('base64')
const JPEG_DATA_URL = 'data:image/jpeg;base64,'
  + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')
// 假贴图：16×16 全不透明的橙棕色，四角再点一个亮块 —— 画的出来就一定数得到非透明像素。
function fakePixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const bright = (x < 3 && y < 3) || (x >= width - 3 && y >= height - 3)
      data[at] = bright ? 250 : 190
      data[at + 1] = bright ? 240 : 110
      data[at + 2] = bright ? 90 : 60
      data[at + 3] = 255
    }
  }
  return data
}
function makeFakeCanvas(width, height) {
  const canvas = { _w: 0, _h: 0, _data: new Uint8ClampedArray(0), clientWidth: 340, clientHeight: 240 }
  const resize = () => {
    const w = Math.max(0, Math.floor(canvas._w) || 0)
    const h = Math.max(0, Math.floor(canvas._h) || 0)
    canvas._data = new Uint8ClampedArray(w * h * 4)
  }
  Object.defineProperty(canvas, 'width', { get: () => canvas._w, set: (value) => { canvas._w = value; resize() } })
  Object.defineProperty(canvas, 'height', { get: () => canvas._h, set: (value) => { canvas._h = value; resize() } })
  canvas.width = width === undefined ? 256 : width
  canvas.height = height === undefined ? 256 : height
  canvas.getContext = () => fakeContext(canvas)
  canvas.toDataURL = (mime) => (mime === 'image/png' ? PNG_DATA_URL : JPEG_DATA_URL)
  canvas.addEventListener = () => {}
  canvas.removeEventListener = () => {}
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 340, height: 240 })
  canvas.setPointerCapture = () => {}
  return canvas
}
function fakeContext(canvas) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height
  const blit = (source, sourceWidth, sourceHeight, dx, dy, dw, dh) => {
    const targetWidth = Math.max(1, Math.round(dw === undefined ? sourceWidth : dw))
    const targetHeight = Math.max(1, Math.round(dh === undefined ? sourceHeight : dh))
    const ox = Math.round(dx || 0), oy = Math.round(dy || 0)
    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth))
        const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight))
        const tx = ox + x, ty = oy + y
        if (!inside(tx, ty)) continue
        const from = (sy * sourceWidth + sx) * 4, to = (ty * canvas.width + tx) * 4
        canvas._data[to] = source[from]
        canvas._data[to + 1] = source[from + 1]
        canvas._data[to + 2] = source[from + 2]
        canvas._data[to + 3] = source[from + 3]
      }
    }
  }
  return {
    imageSmoothingEnabled: false,
    createImageData: (width, height) => ({ width: width, height: height, data: new Uint8ClampedArray(width * height * 4) }),
    getImageData: (x, y, width, height) => {
      const out = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const sx = x + col, sy = y + row
          if (!inside(sx, sy)) continue
          const from = (sy * canvas.width + sx) * 4, to = (row * width + col) * 4
          out[to] = canvas._data[from]
          out[to + 1] = canvas._data[from + 1]
          out[to + 2] = canvas._data[from + 2]
          out[to + 3] = canvas._data[from + 3]
        }
      }
      return { width: width, height: height, data: out }
    },
    putImageData: (frame, dx, dy) => { blit(frame.data, frame.width, frame.height, dx, dy, frame.width, frame.height) },
    clearRect: (x, y, width, height) => {
      for (let row = 0; row < Math.round(height); row++) {
        for (let col = 0; col < Math.round(width); col++) {
          const tx = Math.round(x) + col, ty = Math.round(y) + row
          if (!inside(tx, ty)) continue
          const at = (ty * canvas.width + tx) * 4
          canvas._data[at] = 0; canvas._data[at + 1] = 0; canvas._data[at + 2] = 0; canvas._data[at + 3] = 0
        }
      }
    },
    drawImage: (source, dx, dy, dw, dh) => {
      const sw = source.naturalWidth || source.width || 0
      const sh = source.naturalHeight || source.height || 0
      if (source._data === undefined || source._data === null || !(sw > 0) || !(sh > 0)) return
      blit(source._data, sw, sh, dx, dy, dw, dh)
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: () => {},
  }
}
function fakeCanvas() { return makeFakeCanvas(256, 256) }
/** 假 <img>：一上来就 complete，像素是真的 —— 解码那条路才真的把字节搬进 `decoded`。
 *  尺寸可调：动画那段夹具要一张**竖条**贴图（16×64），不然"形状像条带"那句根本不会轮到。 */
let fakeImageSize = { width: 16, height: 16 }
function fakeImage() {
  const width = fakeImageSize.width, height = fakeImageSize.height
  const img = {
    complete: true, naturalWidth: width, naturalHeight: height, width: width, height: height,
    _data: fakePixels(width, height),
    addEventListener: () => {}, removeEventListener: () => {},
  }
  return img
}
/** 上一次喂进去的假画布（按 className 记），用来量像素 —— 真 React 会自己调 ref，
 *  假 React 只能我们手动调，所以量的时候要拿"这一遍真的交出去的那个对象"。 */
const wiredCanvases = new Map()
/** 这一遍喂进去的画布，**按树里的顺序**（物品栏那一排要按格子对号入座）。 */
let wiredCanvasSeq = []
function wiredByClass(className) {
  return wiredCanvasSeq.filter((item) => item.className === className).map((item) => item.canvas)
}
/** 一块画布上有多少个不透明像素（2D 图标就是这么量的）。 */
function opaquePixels(canvas) {
  if (canvas === undefined || canvas === null || canvas._data === null) return 0
  let count = 0
  for (let at = 3; at < canvas._data.length; at += 4) if (canvas._data[at] > 0) count += 1
  return count
}
/** 把屏幕上所有 canvas / img 的 ref 都喂上假件，报告喂了几个。 */
function wireRefs(ui) {
  let canvases = 0, images = 0
  wiredCanvasSeq = []
  for (const node of ui.nodes()) {
    if (typeof node.props.ref !== 'function') continue
    if (node.type === 'canvas') {
      const made = fakeCanvas()
      // 真 React 会把 width/height 属性落到 DOM 元素上（poster 的边长就是这么定的）。
      if (typeof node.props.width === 'number') made.width = node.props.width
      if (typeof node.props.height === 'number') made.height = node.props.height
      const name = node.props.className === undefined ? 'canvas' : String(node.props.className)
      wiredCanvases.set(name, made)
      wiredCanvasSeq.push({ className: name, canvas: made })
      node.props.ref(made)
      canvases += 1
    } else if (node.type === 'img') { node.props.ref(fakeImage()); images += 1 }
  }
  return { canvases: canvases, images: images }
}
/**
 * 取景框里到底有没有东西 —— **用像素量**，不是看源码里有没有那个分支。
 *
 * 3D 那半：`renderScene` 把背景铺成 [26,24,28] 不透明，所以"和背景不一样"的像素就是模型。
 * 2D 那半：poster 画在透明底上，非透明像素就是那张图标。
 */
function measureViewport(ui) {
  const nodes = ui.nodes()
  const hasView = nodes.some((node) => node.props && node.props.className === 'mcart-canvas')
  const hasPoster = nodes.some((node) => node.props && node.props.className === 'mcart-poster')
  const view = wiredCanvases.get('mcart-canvas')
  const poster = wiredCanvases.get('mcart-poster')
  let scenePixels = 0, posterPixels = 0
  if (hasView && view !== undefined && view._data !== null) {
    for (let at = 0; at < view._data.length; at += 4) {
      const distance = Math.abs(view._data[at] - 26) + Math.abs(view._data[at + 1] - 24)
        + Math.abs(view._data[at + 2] - 28) + Math.abs(view._data[at + 3] - 255)
      if (distance > 24) scenePixels += 1
    }
  }
  if (hasPoster && poster !== undefined && poster._data !== null) {
    for (let at = 3; at < poster._data.length; at += 4) if (poster._data[at] > 0) posterPixels += 1
  }
  return { hasView: hasView, hasPoster: hasPoster, scenePixels: scenePixels, posterPixels: posterPixels,
    drawn: scenePixels + posterPixels }
}
/** 一边喂 ref 一边量：先渲染 → 交假画布 → 再渲染（这一遍才真的画）→ 量像素。 */
async function pixelsOf(ui) {
  for (let pass = 0; pass < 3; pass++) {
    await ui.settle()
    wireRefs(ui)
    await ui.settle()
  }
  return measureViewport(ui)
}
/** 反复喂 ref + 等稳定：解码 effect 要下一遍渲染才读得到刚登记的节点。 */
async function decodeTextures(ui) {
  const wired = { canvases: 0, images: 0 }
  for (let pass = 0; pass < 3; pass++) {
    await ui.settle()
    const now = wireRefs(ui)
    wired.canvases += now.canvases
    wired.images += now.images
    await ui.settle()
  }
  return wired
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

async function mount(component, props, host, react, owner) {
  let tree = null
  const me = owner === undefined ? 'main' : owner
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
        // 真 React 在提交阶段还会调 `componentDidCatch(error, info)`。面板的边界在这里
        // 把报告放进输入框草稿（"渲染失败不能只是死在那里"），所以这一步必须仿真出来，
        // 否则那条路在门禁里永远跑不到。
        if (typeof instance.componentDidCatch === 'function') {
          try { instance.componentDidCatch(error, { componentStack: '' }) } catch (ignored) { /* 边界自己抛了也不该带走渲染 */ }
        }
        node = instance.render()
      }
    }
    return node
  }

  async function settle(limit) {
    let quiet = 0
    for (let pass = 0; pass < (limit === undefined ? 60 : limit); pass++) {
      react.beginPass(me)
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
    nodes: () => nodes(),
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
    /** 按 title 点按钮：物品栏/九宫格那几格是 <button><canvas/></button>，文字是空的，
     *  名字只在 `title` 里。 */
    async clickTitle(fragment) {
      const button = buttons().filter((node) => String(node.props.title || '').indexOf(fragment) >= 0)[0]
      if (button === undefined) {
        throw new Error('屏幕上没有 title 包含「' + fragment + '」的按钮。现在有：'
          + buttons().map((node) => String(node.props.title || textOf(node))).join(' / '))
      }
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
  const o = options || {}
  const settings = {
    path: 'ui_probe/mc-art.settings.json', project: PROJECT.id, title: PROJECT.title,
    file: CWD + '/ui_probe/mc-art.settings.json', directory: '',
    shape: '', textures: 0, sources: [], scanError: null, scanner: null,
    detected: o.detected || [], includeGenerated: true, includeMods: false, mods: [],
  }
  return async (name, args) => {
    if (name === 'atlas.session') return { cwd: CWD }
    if (name === 'atlas.projects') return { base: CWD, projects: [Project_dir()] }
    if (name === 'atlas.scan') {
      return { rootSpecified: true, root: (args || {}).root, cached: false, errors: [],
        projects: [{ id: PROJECT.id, title: PROJECT.title, namespace: PROJECT.namespace, root: (args || {}).root,
          // 有物品可选：下面那条"recipe 缺失"的用例要从菜单点进去。
          // `structure` 那条是给"方块图标"行为检查用的：只有结构/群系才会进
          // `openVoxel()`，而 `voxel` 非空时 `atlas.icons` 那条 effect 才会跑。
          items: { biome: [], structure: [{ id: 'example_struct', title: '示例结构' }],
            entity: [{ id: 'example_entity', title: '示例实体' }],
            block: [{ id: 'example_block', title: '示例方块' }] } }] }
    }
    if (name === 'atlas.settings') return Object.assign({}, settings, savedSettings === null ? {} : { directory: savedSettings })
    if (name === 'atlas.saveSettings') { savedSettings = (args || {}).directory; return { saved: true, file: settings.file, path: settings.path, via: 'fs' } }
    if (name === 'atlas.pickDirectory') return pickerReply
    if (name === 'atlas.scene') {
      // 这个用例要哪一份就答哪一份：`sceneReply` 可以是对象，也可以是拿请求算的
      // 函数（"画不出来 / 畸形 JSON / 逐面贴图"三段各要一份不同的答案）。
      if (o.sceneReply !== undefined) return typeof o.sceneReply === 'function' ? o.sceneReply(args) : o.sceneReply
      // 结构/群系才会走 `openVoxel()`（它就认这两种），`voxel` 有值之后左边菜单的
      // 方块图标那条 effect（`atlas.icons`）才会真的跑 —— "刷新清完有没有人再填"
      // 的行为检查要靠它。别的一律按方块答（quads 空、cells 空）。
      // 请求里是 `id`（项目资产）或 `block`（引用资产），两个都要看。
      const asked = String((args || {}).id || (args || {}).block || '')
      const wantStructure = asked.indexOf('struct') >= 0
      return { kind: wantStructure ? 'structure' : 'block', id: '', quads: [],
        textureIds: [], textures: {}, animations: {},
        cells: wantStructure ? [] : null, refs: [], box: null, errors: [],
        // `@ 提意见` 要有东西可引用：`ref` 空的时候那条引用栏根本不出现。
        ref: o.sceneRef === undefined ? null : o.sceneRef,
        choices: [{ name: 'example_block', title: '示例方块' }] }
    }
    if (name === 'atlas.itemIcons' || name === 'atlas.icons' || name === 'atlas.refIcons') {
      if (o.iconReply !== undefined) return typeof o.iconReply === 'function' ? o.iconReply(args) : o.iconReply
      return { icons: {}, items: {}, names: {}, failed: [] }
    }
    // 点一个**参考**物品时客户端发的那一条（`openReferenceItem`）。真机上的形状：
    // 方块物品回 quads；平面物品回 `{error:'找不到 … 的模型（参考目录里没有这个方块：…）'}`。
    if (name === 'atlas.preview') {
      if (o.previewReply !== undefined) return typeof o.previewReply === 'function' ? o.previewReply(args) : o.previewReply
      return { error: '预览需要一个真的答复（这个用例没给 previewReply）' }
    }
    // 物品浏览器要"有东西可选"，`ensureItemPage` 才会真的去取配方（它要求 facts 非空）。
    if (name === 'atlas.refItems') {
      if (o.itemFacts !== undefined) {
        return { items: typeof o.itemFacts === 'function' ? o.itemFacts(args) : o.itemFacts, version: '1.18.2' }
      }
      return { items: [{ id: 'example_item', name: '示例物品', form: 'flat', family: '材料' }], version: '1.20.1' }
    }
    if (name === 'atlas.refNamespaces') {
      if (o.refNamespaces !== undefined) return { namespaces: o.refNamespaces, directory: 'C:/games/.minecraft', version: '1.18.2' }
      return { namespaces: [], directory: '', reason: '没有设置参考目录' }
    }
    if (name === 'atlas.saveTexture') return { saved: true, bytes: 96 }
    return {}
  }
}
const Project_dir = () => ({ root: CWD, id: PROJECT.id, title: PROJECT.title, namespace: PROJECT.namespace, dir: CWD + '/' + PROJECT.id })

/** 用（可被 --fault 改写的）源码搭出插件，并拿到它注册的那些组件。 */
function buildPanel(source, host, reactApi, options) {
  const o = options || {}
  const seen = []
  const slots = {
    inject: (slot, callback) => callback(),
    register: (settings, component) => {
      seen.push({ settings: settings, component: component })
      return () => {}
    },
    entries: (name) => (o.slotEntries === undefined || o.slotEntries[name] === undefined
      ? [] : o.slotEntries[name]),
  }
  const ctx = {
    // 右侧栏的判据是"服务在，或者那个槽已经有条目"——所以这里的 `get` 要能按用例
    // 只给槽、不给服务（用户实测过的那个形状：面板两处都不见了）。
    get: (name) => {
      if (name === 'slots') return slots
      return o.services === undefined ? undefined : o.services[name]
    },
    inject: (names, callback) => { if (o.fireInject === true && typeof callback === 'function') callback(); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    timer: { interval: () => () => {}, timeout: async () => {} },
  }
  const styles = { insert: () => () => {}, remove: () => {} }
  const plugin = new Function('React', 'host', 'styles', 'console', 'PANEL_VERSION', source)(
    reactApi, host, styles, console, '0.0.0-test')
  plugin.apply(ctx)
  const main = seen.filter((item) => item.settings.name === 'main')[0]
  if (o.allowMissingMain !== true && main === undefined) throw new Error('客户端没有注册 main 槽：' + seen.map((i) => i.settings.name).join(','))
  const dock = seen.filter((item) => item.settings.name === 'conversation.input.dock')[0]
  return {
    main: main === undefined ? null : main.component,
    dock: dock === undefined ? null : dock.component,
    registered: seen.map((item) => item.settings.name),
  }
}

async function main() {
  // 浏览器替身：缩略图那一格（`itemIconUrl`）用 `document.createElement('canvas')` 烘图，
  // Node 里没有 document。给它一个够用的替身，那条路才跑得起来（复制报告的兜底也用它）。
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { value: '', setAttribute: () => {}, select: () => {} }),
    execCommand: () => true,
    body: { appendChild: () => {}, removeChild: () => {} },
  }
  const source = readFileSync(SOURCE_PATH, 'utf8')
  let faulted = source
  // A/B 表。每条门禁都得有**能红**的那一半：注入该缺陷、要求对应的断言变红。
  // 一次只跑一个，好让"哪一条红了"说话。
  const FAULTS = [
    { flag: FAULT_JSON, name: '--fault-json', hint: '源码里找不到 idsOf(asset.recipe) 那一处',
      apply: (src) => src.replace('const ids = idsOf(asset.recipe)',
        "const ids = asset.recipe === null ? [] : (asset.recipe.textureIds || [])") },
    { flag: FAULT_REFRESH, name: '--fault-refresh', hint: '找不到刷新按钮里那句 forgetTextures()',
      apply: (src) => src.replace('onClick: () => { forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null) }',
        'onClick: () => scan(root, true, null)') },
    // 只删纪元那一脚，缓存照旧清 —— 用户实测的那个回归就是这个形状：
    // 表清空了，可没人再把它填回来（物品浏览器/九宫格/左边菜单全空白）。
    { flag: FAULT_EPOCH, name: '--fault-epoch', hint: '找不到刷新按钮里那句 setTexEpoch',
      apply: (src) => src.replace('forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null)',
        'forgetTextures(); scan(root, true, null)') },
    { flag: FAULT, name: '--fault', hint: '源码里找不到设置卡的手输框那一段',
      apply: (src) => src.replace(/rows\.push\(React\.createElement\('div', \{ className: 'mcart-bar', key: 'dirinput' \}[\s\S]*?\)\)\n/, '') },
    // 六张缓存表少清一张（用户实测："3D 换了、菜单图标还是旧的"）。
    { flag: FAULT_FORGET, name: '--fault-forget', hint: '找不到 forgetTextures 里清 itemRecipes 那一句',
      apply: (src) => src.replace('  for (const key of Object.keys(itemRecipes)) delete itemRecipes[key]\n', '') },
    // 红线：把"插入输入框"改成往 agent 里塞消息（0.1.26 那条写坏会话日志的形状）。
    { flag: FAULT_INJECT, name: '--fault-inject', hint: '找不到"插入输入框"里写进 draft 的那一句',
      apply: (src) => src.replace("if (props.inputActions !== undefined) props.inputActions.setDraft(base + tail + ' ')",
        "host.call('agent.steer', { text: base + tail })") },
    // 项目自己的缺失被说成"缺的原版母模型" —— 用户贴的那份报告就是这么指错方向的。
    { flag: FAULT_DIAGNOSTIC, name: '--fault-diagnostic', hint: '找不到 DIAG_KIND 那一行',
      apply: (src) => src.replace("{ project: '项目里缺', vanilla: '缺的原版母模型' }",
        "{ project: '缺的原版母模型', vanilla: '缺的原版母模型' }") },
    // 「取不到」不带版本号：用户报问题时说不清是哪一版。
    { flag: FAULT_VERSION, name: '--fault-version', hint: '找不到 versionTag 的定义',
      apply: (src) => src.replace("const versionTag = () => '（MC 资产面板 ' + String(PANEL_VERSION) + '）'",
        "const versionTag = () => ''") },
    // 复制报告不设防：没有剪贴板的地方当场抛（点击没反应/面板炸）。
    { flag: FAULT_COPY, name: '--fault-copy', hint: '找不到 copyReport 的定义',
      apply: (src) => src.replace('function copyReport(text) {',
        'function copyReport(text) { return navigator.clipboard.writeText(String(text))') },
    // 畸形场景（JSON 丢字段/类型不对）不再归一化 → 渲染时抛 → 白屏。
    { flag: FAULT_SCENE, name: '--fault-scene', hint: '找不到 sceneOf 里归一化 errors 的那一句',
      apply: (src) => src.replace('errors: arrayOf(payload.errors),', 'errors: payload.errors,') },
    // 右侧栏只有槽、没有 tabs 服务时直接进右栏 → 两处都没有（用户实测"右边栏一片空白"）。
    { flag: FAULT_SIDEBAR, name: '--fault-sidebar', hint: '找不到 apply 里那句 inRightColumn 的判断',
      apply: (src) => src.replace('if (inRightColumn) placeRight()',
        "if (slotHasEntries('sidebar.right.pane.tab')) placeRight()") },
    // 画布给的不是 PNG 也照发（宿主就无从"先验是 PNG 再替换"）。
    { flag: FAULT_PNG, name: '--fault-png', hint: '找不到 saveEdit 里取 PNG 的那一句',
      apply: (src) => src.replace("editScratch.toDataURL('image/png')", "editScratch.toDataURL('image/jpeg')") },
    // 不挡绝对路径 / `..` 的贴图句柄 → 可能写到项目包外面去。
    { flag: FAULT_SAVEPATH, name: '--fault-savepath', hint: '找不到 saveEdit 里的句柄守卫',
      apply: (src) => src.replace('if (!safeTextureHandle(target)) {', 'if (false && !safeTextureHandle(target)) {') },
    // 按面编辑退化：贴图与面的对应关系丢掉（草方块会开在泥土那一面）。
    { flag: FAULT_FACES, name: '--fault-faces', hint: '找不到 facesForScene 的定义',
      apply: (src) => src.replace('function facesForScene() {', 'function facesForScene() { return {}') },
    // 2D 回退被拉成面板那么宽（不是方图）——用户要的是"方方正正那张图"。
    { flag: FAULT_POSTER, name: '--fault-poster', hint: '找不到 posterSide 那一句',
      apply: (src) => src.replace('Math.max(48, Math.min(size[0], size[1]) - 24)', 'Math.max(48, size[0] - 24)') },
    // 契约会长新 reason（宿主比面板新是常态）：把兜底链整条改回旧的"只说原因不明"
    // （连同 `diagnosticOf` 里把"没给 reason"折成 `unknown` 那一句）。
    { flag: FAULT_REASON, name: '--fault-reason', hint: '找不到 reasonLine 的两条兜底',
      apply: (src) => src
        .replace("  if (raw !== '') return '原因：' + raw + '（面板不认识这个 reason，把原值照贴出来）'\n"
          + "  return '原因：unknown（宿主没有给 reason）'",
          "  return '原因：' + (DIAG_REASON[raw] || DIAG_REASON.unknown)")
        .replace("typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : 'unknown'",
          "typeof raw.reason === 'string' ? raw.reason : ''") },
    // 「不许覆盖用户正在写的东西」：去掉守卫 → 用户草稿被报告冲掉。
    { flag: FAULT_AUTOFILL, name: '--fault-autofill', hint: '找不到 autoFillDraft 里的"不覆盖草稿"守卫',
      apply: (src) => src.replace("  if (manual !== true && current.trim() !== '') { lastAutoVerdict = 'busy'; return 'busy' }",
        "  if (false && manual !== true && current.trim() !== '') { lastAutoVerdict = 'busy'; return 'busy' }") },
    // 用户实测："点胡萝卜/剑 预览看不到"。把两处一起还原：2D 回退只认 `scene === null`，
    // 且参考物品预览失败时**不清场景**（上一个资产的 3D 留在屏幕上）。
    { flag: FAULT_FLAT_BLANK, name: '--fault-flat-blank', hint: '找不到新的 poster 判据 / 清场景那一处',
      apply: (src) => src
        .replace('const sceneDrawsNothing = scene === null || arrayOf(scene.quads).length === 0',
          'const sceneDrawsNothing = scene === null')
        .replace('            forgetSceneBecauseItem()\n', '') },
    // 缺图标的那一格：把"缺"的特判全部去掉（角标、title、tooltip、poster），
    // 要求"这一格缺"的断言变红 —— 用户看到的会是空方块，一个字的解释都没有。
    { flag: FAULT_MISSING_BLANK, name: '--fault-missing-blank', hint: '找不到 missing 特判的那几处',
      apply: (src) => src
        .replace("        if (recipe.missing === true) {\n          return '这一格没有图标：'",
          "        if (false && recipe.missing === true) {\n          return '这一格没有图标：'")
        .replace("        if (recipe.missing === true) {\n          return '缺：'",
          "        if (false && recipe.missing === true) {\n          return '缺：'")
        .replaceAll('const lacking = recipe !== undefined && recipe !== null && recipe.missing === true',
          'const lacking = false')
        .replace('const posterRecipe = sceneDrawsNothing && pickedRecipe !== null && pickedRecipe.missing !== true',
          'const posterRecipe = sceneDrawsNothing && pickedRecipe !== null') },
    // 忽略宿主查过的 `.mcmeta` 真话：C（文件在但读不了）会被说成"没有动画描述"。
    { flag: FAULT_ANIMNOTES, name: '--fault-animnotes', hint: '找不到 animNotes 那一行',
      apply: (src) => src.replace('const animNotes = scene === null ? {} : (scene.animationNotes || {})',
        'const animNotes = {}') },
  ]
  const chosen = FAULTS.filter((entry) => entry.flag)
  if (chosen.length > 1) {
    console.log('  FAIL 一次只跑一个 --fault（现在：' + chosen.map((entry) => entry.name).join(' ') + '）')
    process.exit(1)
  }
  if (chosen.length === 1) {
    faulted = chosen[0].apply(source)
    if (faulted === source) {
      console.log('  FAIL ' + chosen[0].name + ' 没生效：' + chosen[0].hint + '（门禁要跟着改）')
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
  // 一个实例：`main` 和 `conversation.input.dock` 必须来自同一次 build（模块级状态
  // —— 输入框把手、去重账、解码表 —— 都在那次 build 的闭包里）。
  const panel0 = buildPanel(faulted, host, react.api)
  const component = panel0.main
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
    // 引用条先挂上：输入框的把手只有它拿得到。渲染失败的这一路要能把报告放进草稿，
    // 靠的就是它 —— 也就是说这一条测的是真壳里的顺序。
    const boundaryDrafts = []
    const callsBeforeBoom = calls.length
    await mount(panel0.dock, { sessionId: 'ui-test',
      useInput: (selector) => selector({ draft: '' }),
      inputActions: { setDraft: (text) => boundaryDrafts.push(text) },
    }, host, react, 'dock')
    const boom = await mount(component, { sessionId: 'ui-test' }, host, react)
    check('渲染抛异常时，屏幕上出现错误文字（不是空白）',
      boom.text().indexOf('面板渲染失败') >= 0 && boom.text().indexOf('注入的渲染错误') >= 0,
      boom.text().slice(0, 160) || '（空白）')
    check('并且带着可报的版本号', boom.text().indexOf('0.0.0-test') >= 0, boom.text().slice(0, 200))
    check('渲染失败也把报告放进输入框草稿（只放草稿、不发送），并且告诉用户放好了',
      boundaryDrafts.length === 1
      && boundaryDrafts[0].indexOf('面板渲染失败：注入的渲染错误') >= 0
      && boundaryDrafts[0].indexOf('0.0.0-test') >= 0
      && boundaryDrafts[0].indexOf('只放进草稿') >= 0
      && boom.text().indexOf('已把这份报告放进输入框') >= 0,
      JSON.stringify(boundaryDrafts).slice(0, 200))
    check('渲染失败这一路没有向宿主发任何东西（更不是写会话）',
      calls.length === callsBeforeBoom, '多了 ' + (calls.length - callsBeforeBoom) + ' 个 host 调用')
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
    && /itemFetchError === '' \? '点一格就放到上面的 3D 里看' : withVersion\(itemFetchError\)/.test(faulted))
  check('图标"问过了"的账在请求失败时会退回来（一次抖动不该让图标永久不出现）',
    /for \(const name of batch\) delete iconTried\[name\]/.test(faulted))

  // ── 行为检查：刷新之后，补表的那几个 effect 真的**重跑**了吗 ───────────────────
  //
  // 上面那几条都是**源码形状**检查（依赖数组里有没有纪元）。形状对了不等于行为对了，
  // 而用户看到的是行为："刷新完了之后 2D 贴图没有了"。所以这里真的把面板挂起来、
  // 点「刷新」，数宿主收到了几次 `atlas.itemIcons` —— 配方被清掉之后必须**再问一次**，
  // 否则物品浏览器的缩略图和那一排九格就是空白，而且不会自己回来。
  // `--fault-epoch`（清缓存但不踢纪元）下这一条必须红。
  console.log('--- 刷新之后补表的 effect 真的重跑（行为检查，不是形状）')
  //
  // 形状检查（依赖数组里有没有纪元）挡不住"依赖写对了但 effect 因为别的原因不跑"。
  // 这里把面板真的挂起来、真的点「刷新」，数宿主收到了几次请求：
  // 配方被清掉之后必须**再问一次**，否则物品浏览器的缩略图和那一排九格就是空白，
  // 而且不会自己回来。`--fault-epoch`（清缓存但不踢纪元）下这两条必须红。
  const refreshUi = await mount(component, { sessionId: 'ui-test' }, host, react)
  if (refreshUi.buttonProps('用本会话目录') !== undefined) await refreshUi.click('用本会话目录')
  const countOf = (name) => calls.filter((call) => call.name === name).length
  // 前提：物品卡确实开着（`item` 非空）。`ensureItemPage` 在 `item === null` 时直接
  // 返回，那样"刷新之后有没有再取一次"就成了空断言 —— 所以先把前提钉住。
  // （不能拿 `atlas.refItems` 当前提：物品是**前面那几段用例**载入的，而那时调用记录
  //   已经被 `calls.length = 0` 清过一次，这里看不到。）
  if (refreshUi.buttonProps('物品列表') !== undefined) await refreshUi.click('物品列表')
  await refreshUi.settle()
  check('物品卡开着（前提：item 非空，刷新才会去补配方）',
    refreshUi.buttonProps('收起') !== undefined,
    '按钮：' + refreshUi.buttons().join(' / '))

  const recipesBefore = countOf('atlas.itemIcons')
  await refreshUi.click('刷新')
  await refreshUi.settle()
  check('刷新之后配方会再取一次（不然缩略图和九宫格空白，而且不会自己回来）',
    countOf('atlas.itemIcons') > recipesBefore,
    '刷新前 ' + recipesBefore + ' 次，刷新后 ' + countOf('atlas.itemIcons') + ' 次')

  // 方块图标那两张表（`icons` / `iconTried`）：`voxel` 有值那条 effect 才会跑，
  // 而 `voxel` 只有"手动修改一个结构/群系"才会被建起来（见 openVoxel）。
  const openedStructure = await refreshUi.clickLabel('示例结构').then(() => true).catch(() => false)
  await refreshUi.settle()
  const openedEditor = await refreshUi.clickLabel('手动修改').then(() => true).catch(() => false)
  await refreshUi.settle()
  const iconsBefore = countOf('atlas.icons')
  check('打开结构资产并进编辑会去取方块图标（前提：'
    + (openedStructure ? '' : '没找到结构按钮；') + (openedEditor ? '' : '没找到「手动修改」按钮；')
    + '）', iconsBefore > 0, '取图标调用次数 = ' + iconsBefore
    + '，宿主收过的：' + calls.map((call) => call.name).join(','))
  await refreshUi.click('刷新')
  await refreshUi.settle()
  check('刷新之后方块图标会再取一次（不然左边菜单只剩空框）',
    countOf('atlas.icons') > iconsBefore,
    '刷新前 ' + iconsBefore + ' 次，刷新后 ' + countOf('atlas.icons') + ' 次')

  // ══════════════════════════════════════════════════════════════════════════
  // 下面这一段是这一轮加的。每一条都对着用户实测过的一个症状，而且每一条都有
  // 对应的 `--fault-*`（见表头）能把它打红。
  // ══════════════════════════════════════════════════════════════════════════

  // ── 红线：报告只上屏 / 只进输入框，绝不写会话或 agent ────────────────────────
  //
  // 这不是功能，是信任：0.1.26 面板往 agent 里塞了一条没有 `source` 的消息，用户的
  // 会话日志被写坏、那个会话再也打不开。静态+行为两头盯着：
  //   1. 客户端源码里没有会话 / agent 的写入口；
  //   2. 「@ 提意见」「插入输入框」真的只写输入框 —— 宿主一个字节都没收到。
  console.log('--- 红线：报告只上屏 / 只进输入框，绝不写会话或 agent')
  const injections = []
  for (const line of faulted.split('\n')) {
    if (/^\s*(\*|\/\/)/.test(line)) continue   // 注释里出现这些词是说明，不是调用
    if (/steer|inbox|notifyAgent|agentNotices|lastSessionId|\.append\s*\(|\bsessions\s*\(|\bagents\s*\(/.test(line)) {
      injections.push(line.trim().slice(0, 90))
    }
  }
  check('客户端里没有会话 / agent 的写入口（steer / inbox / append / sessions / agents）',
    injections.length === 0, injections.join(' ｜ '))
  check('报告的去向只有剪贴板（有「复制报告」，走 writeText，且有 execCommand 兜底）',
    faulted.indexOf("'复制报告'") >= 0 && faulted.indexOf('writeText') >= 0
    && faulted.indexOf('execCommand') >= 0)
  check('报告卡自己写着"不会把它发进任何会话"',
    faulted.indexOf('面板不会把它发进任何会话') >= 0)

  const injectCalls = []
  const draftCalls = []
  handlers = makeHandlers({ sceneRef: 'pack/assets/ui_probe/models/block/example_block.json' })
  const reactA = createReact()
  const hostA = makeHost(injectCalls)
  const builtA = buildPanel(faulted, hostA, reactA.api)
  const uiA = await mount(builtA.main, { sessionId: 'ui-test' }, hostA, reactA, 'main')
  if (uiA.buttonProps('用本会话目录') !== undefined) await uiA.click('用本会话目录')
  await uiA.settle()
  const beforeComplain = injectCalls.length
  const couldComplain = await uiA.click('@ 提意见').then(() => true).catch(() => false)
  check('资产旁边有「@ 提意见」（没有它，用户只能自己描述问题）',
    couldComplain === true, uiA.buttons().join(' / '))
  check('点「@ 提意见」不向宿主发一个字（更没有任何会话写入）',
    injectCalls.length === beforeComplain, injectCalls.slice(beforeComplain).map((call) => call.name).join(' / '))

  check('客户端注册了输入框上方那条引用栏（conversation.input.dock）',
    builtA.dock !== null && builtA.dock !== undefined, builtA.registered.join(','))
  const uiDock = builtA.dock === null || builtA.dock === undefined ? null : await mount(builtA.dock, {
    sessionId: 'ui-test',
    useInput: (selector) => selector({ draft: '我本来打了一半的话 ' }),
    inputActions: { setDraft: (text) => draftCalls.push(text) },
  }, hostA, reactA, 'dock')
  check('引用栏画出来了，并且写着引用的是哪个文件',
    uiDock !== null && uiDock.text().indexOf('引用给 AI') >= 0
    && uiDock.text().indexOf('@pack/assets/ui_probe/models/block/example_block.json') >= 0,
    uiDock === null ? '没注册 dock' : uiDock.text().slice(0, 160))
  const beforeInsert = injectCalls.length
  const inserted = uiDock !== null && await uiDock.click('插入输入框').then(() => true).catch(() => false)
  check('点「插入输入框」只把文本放进输入框（@路径 + 一句话，用户自己按发送）',
    inserted === true && draftCalls.length === 1
    && draftCalls[0].indexOf('@pack/assets/ui_probe/models/block/example_block.json') >= 0
    && draftCalls[0].indexOf('我本来打了一半的话') >= 0,
    JSON.stringify(draftCalls))
  check('「插入输入框」同样不向宿主发任何东西（尤其没有 agent.steer / inbox）',
    injectCalls.length === beforeInsert, injectCalls.slice(beforeInsert).map((call) => call.name).join(' / '))

  // ── 画不出来：结构化 diagnostic 要看得懂、能复制、太长能折叠 ─────────────────
  function sceneMount(reply) {
    handlers = makeHandlers({ sceneReply: reply })
    const callsHere = []
    const reactHere = createReact()
    const hostHere = makeHost(callsHere)
    return { calls: callsHere, host: hostHere, react: reactHere,
      built: buildPanel(faulted, hostHere, reactHere.api) }
  }
  console.log('--- 画不出来：结构化 diagnostic 看得懂 / 能复制 / 太长能折叠')
  const SHORT_DIAG = {
    reason: 'project-model-missing',
    block: 'ui_probe:mist_door_lower',
    missing: [{ kind: 'project', name: 'ui_probe:block/mist_door_lower',
      fixPath: 'pack/assets/ui_probe/models/block/mist_door_lower.json' }],
    tried: ['项目包 pack/assets/ui_probe → 没有 models/block/mist_door_lower.json'],
    referenceDirectory: '',
  }
  const LONG_DIAG = {
    reason: 'vanilla-parent-missing',
    block: 'ui_probe:many_things',
    missing: Array.from({ length: 12 }, (unused, index) => ({
      kind: index === 0 ? 'project' : 'vanilla',
      name: (index === 0 ? 'ui_probe:' : 'minecraft:') + 'block/missing_' + index,
      fixPath: 'pack/assets/ui_probe/models/block/missing_' + index + '.json',
    })),
    tried: ['项目包 → 没有', '面板内置的原版母模型表 → 没有', '参考目录的 jar → 没有', '抽取器 → 退出码 2'],
    referenceDirectory: '',
  }
  const diagA = sceneMount({ error: '画不出 ui_probe:mist_door_lower', diagnostic: SHORT_DIAG })
  const uiDiag = await mount(diagA.built.main, { sessionId: 'ui-test' }, diagA.host, diagA.react, 'main')
  if (uiDiag.buttonProps('用本会话目录') !== undefined) await uiDiag.click('用本会话目录')
  await uiDiag.settle()
  const diagSaid = uiDiag.text()
  check('画不出来时屏幕上有报告卡（不是一片安静）', diagSaid.indexOf('画不出来 · 报告') >= 0, diagSaid.slice(0, 200))
  check('原因写成人话，并留下机器可判的 reason',
    diagSaid.indexOf('项目包里缺这个模型文件') >= 0 && diagSaid.indexOf('project-model-missing') >= 0)
  check('点名是哪一件资产', diagSaid.indexOf('ui_probe:mist_door_lower') >= 0)
  check('项目自己的缺失写成"项目里缺"，并给能直接照做的文件路径',
    diagSaid.indexOf('项目里缺：ui_probe:block/mist_door_lower') >= 0
    && diagSaid.indexOf('pack/assets/ui_probe/models/block/mist_door_lower.json') >= 0,
    diagSaid.slice(0, 400))
  check('项目自己的缺失**不许**写成"缺的原版母模型"（用户贴的那份报告就是这么指错方向的）',
    diagSaid.indexOf('缺的原版母模型：ui_probe:block/mist_door_lower') < 0)
  check('没设参考目录时明说去哪设（⚙ → 参考目录）',
    diagSaid.indexOf('参考目录：没设') >= 0 && diagSaid.indexOf('⚙') >= 0)
  check('报告带面板版本号（报问题时能一句说清是哪一版）', diagSaid.indexOf('0.0.0-test') >= 0)
  check('短报告不出现折叠按钮（能一眼看完的东西不该多一次点击）',
    uiDiag.buttonProps('展开全部') === undefined, uiDiag.buttons().join(' / '))
  const callsBeforeCopy = diagA.calls.length
  const copied = await uiDiag.click('复制报告').then(() => true).catch(() => false)
  check('点「复制报告」不炸（没有剪贴板的地方也只是让人手动选中）',
    copied === true && /已复制|没复制成/.test(uiDiag.text()), uiDiag.text().slice(-160))
  check('复制只到剪贴板 / 选中，宿主一个调用都没有（更不是"发给 AI"）',
    diagA.calls.length === callsBeforeCopy, diagA.calls.slice(callsBeforeCopy).map((call) => call.name).join(' / '))

  const diagB = sceneMount({ error: '画不出 ui_probe:many_things', diagnostic: LONG_DIAG })
  const uiLong = await mount(diagB.built.main, { sessionId: 'ui-test' }, diagB.host, diagB.react, 'main')
  if (uiLong.buttonProps('用本会话目录') !== undefined) await uiLong.click('用本会话目录')
  await uiLong.settle()
  check('长报告默认折叠，并且有「展开全部」', uiLong.buttonProps('展开全部') !== undefined, uiLong.buttons().join(' / '))
  check('折叠时不会一次铺满屏幕（后面的条目还看不到）',
    uiLong.text().indexOf('block/missing_11') < 0, uiLong.text().slice(0, 200))
  await uiLong.click('展开全部')
  check('展开后能看到后面的条目', uiLong.text().indexOf('block/missing_11') >= 0)
  // 同一条报告再发生一次（点刷新会重新取同一个资产）：屏幕上只留一条，不重复刷屏。
  await uiLong.click('刷新')
  await uiLong.settle()
  const repeatText = uiLong.text()
  check('同一条报告不重复刷屏（第二次只说一句"同一条"）',
    repeatText.indexOf('同一条报告') >= 0 && (repeatText.split('原因：').length - 1) === 1,
    '屏幕上出现 ' + (repeatText.split('原因：').length - 1) + ' 次"原因："')

  // ── 诊断契约会长新取值：不认识的 reason 也要把原值显示出来 ─────────────────────
  //
  // 宿主（A 流）后来加了 `textures-unresolved` / `no-quads`。面板比宿主旧是常态，
  // 所以**兜底分支**才是硬要求：不认识的取值必须把原值照抄在屏幕上，绝不许空白 /
  // `undefined`，也绝不许因为不认识就一条都不画（那正好是用户看到的"白屏且没有字"）。
  console.log('--- 诊断契约新增/未知取值：屏幕上一定有字，且原值照贴')
  const reasonCases = [
    { reason: 'textures-unresolved', zh: '面上引用的贴图取不到' },
    { reason: 'no-quads', zh: '一个面都没产出' },
    { reason: 'a-future-reason-this-panel-does-not-know', zh: null },
  ]
  for (const entry of reasonCases) {
    const one = sceneMount({ error: '画不出 ui_probe:mist_ladder', diagnostic: {
      reason: entry.reason, block: 'ui_probe:mist_ladder', missing: [],
      tried: ['项目包 → 模型找到了', '贴图 minecraft:block/oak_planks → 没取到'],
      referenceDirectory: '',
    } })
    const uiOne = await mount(one.built.main, { sessionId: 'ui-test' }, one.host, one.react, 'main')
    if (uiOne.buttonProps('用本会话目录') !== undefined) await uiOne.click('用本会话目录')
    await uiOne.settle()
    const said = uiOne.text()
    check('reason=' + entry.reason + '：屏幕上有报告卡，不是一个字都没有',
      said.indexOf('画不出来 · 报告') >= 0 && said.length > 0, said.slice(0, 200))
    check('reason=' + entry.reason + '：原值原样出现在屏幕上（兜底不是空白）',
      said.indexOf(entry.reason) >= 0 && said.indexOf('原因：') >= 0, said.slice(0, 240))
    check('reason=' + entry.reason + '：屏幕上没有 undefined / null 这种机器味',
      said.indexOf('undefined') < 0 && said.indexOf('原因：null') < 0)
    if (entry.zh !== null) {
      check('reason=' + entry.reason + '：有对应的中文说明', said.indexOf(entry.zh) >= 0, said.slice(0, 240))
    } else {
      check('reason=' + entry.reason + '：不认识的取值也要说清"面板不认识、照原样贴出来"',
        said.indexOf('面板不认识这个 reason') >= 0, said.slice(0, 240))
    }
  }
  // 老契约：宿主连 reason 都没给时，也要有字（`unknown` 这条兜底同样不许空白）。
  const noReason = sceneMount({ error: '画不出 ui_probe:mist_ladder', diagnostic: { block: 'ui_probe:mist_ladder' } })
  const uiNoReason = await mount(noReason.built.main, { sessionId: 'ui-test' }, noReason.host, noReason.react, 'main')
  if (uiNoReason.buttonProps('用本会话目录') !== undefined) await uiNoReason.click('用本会话目录')
  await uiNoReason.settle()
  check('宿主没给 reason 时也有一句话（绝不空白）',
    uiNoReason.text().indexOf('原因：原因不明（unknown）') >= 0 && uiNoReason.text().indexOf('undefined') < 0,
    uiNoReason.text().slice(0, 200))

  // ── 出错不让 AI 干等：报告只进「输入框草稿」，永不发送 ──────────────────────────
  //
  // 用户原话："太依赖脚本了，导致很多灵活的内容或者出错的内容会立刻死掉而无法通知 agent"。
  // 而 0.1.26 的教训是宿主写会话会写坏日志 —— 所以正确的形态在**客户端**这一侧：
  // 把报告放进输入框的**草稿**，用户按一次回车才发。这一节要证的就是：
  //   草稿空 → 自动放；草稿非空 → 一个字节都不动（只留按钮）；永远到不了"发送"。
  console.log('--- 出错不让 AI 干等：报告只进「输入框草稿」，永不发送')
  const AI_DIAG = {
    reason: 'textures-unresolved',
    block: 'ui_probe:mist_ladder',
    missing: [{ kind: 'vanilla', name: 'minecraft:block/oak_planks',
      fixPath: '(原版贴图：设了参考目录就从游戏 jar 现取)' }],
    tried: ['项目包 → 模型在', '贴图 minecraft:block/oak_planks → 没取到'],
    referenceDirectory: '',
  }
  function autoRun(draftStart) {
    const callsHere = []
    const drafts = []
    const state = { draft: draftStart }
    const reactHere = createReact()
    const hostHere = makeHost(callsHere)
    return { calls: callsHere, drafts: drafts, state: state, react: reactHere, host: hostHere,
      built: buildPanel(faulted, hostHere, reactHere.api) }
  }
  /** 引用条先挂（输入框的把手只有它拿得到），再让资产失败 —— 这就是真壳里的顺序。 */
  async function fireFailure(run) {
    handlers = makeHandlers({ sceneReply: { error: '画不出 ui_probe:mist_ladder', diagnostic: AI_DIAG } })
    await mount(run.built.dock, { sessionId: 'ui-test',
      useInput: (selector) => selector({ draft: run.state.draft }),
      inputActions: { setDraft: (text) => { run.state.draft = text; run.drafts.push(text) } },
    }, run.host, run.react, 'dock')
    const ui = await mount(run.built.main, { sessionId: 'ui-test' }, run.host, run.react, 'main')
    if (ui.buttonProps('用本会话目录') !== undefined) await ui.click('用本会话目录')
    await ui.settle()
    return ui
  }
  const autoEmpty = autoRun('')
  const uiAuto = await fireFailure(autoEmpty)
  check('草稿是空的时候：报告自动进了草稿（用户按回车才发）',
    autoEmpty.drafts.length === 1, JSON.stringify(autoEmpty.drafts))
  const wroteDraft = autoEmpty.drafts.length === 0 ? '' : autoEmpty.drafts[0]
  check('自动放进草稿的报告是自包含的：面板版本 + 资产身份 + reason',
    wroteDraft.indexOf('0.0.0-test') >= 0 && wroteDraft.indexOf('ui_probe:mist_ladder') >= 0
    && wroteDraft.indexOf('textures-unresolved') >= 0, wroteDraft.slice(0, 240))
  check('自包含：缺什么 + 能照做的路径（fixPath）+ 参考目录状态 + 一句"这是报告"',
    wroteDraft.indexOf('minecraft:block/oak_planks') >= 0 && wroteDraft.indexOf('设了参考目录') >= 0
    && wroteDraft.indexOf('参考目录') >= 0 && wroteDraft.indexOf('MC 资产面板') >= 0,
    wroteDraft.slice(0, 420))
  const nonAtlas = autoEmpty.calls.filter((call) => !/^atlas\./.test(call.name))
  const writeish = autoEmpty.calls.filter((call) => /agent|steer|inbox|append|send|message/i.test(call.name))
  check('自动放报告 = 零 host 调用（没有 agent.* / session.*，也没有任何"发送"）',
    nonAtlas.length === 0 && writeish.length === 0,
    nonAtlas.concat(writeish).map((call) => call.name).join(','))
  const beforeManual = autoEmpty.calls.length
  await uiAuto.click('把报告放进输入框')
  check('点「把报告放进输入框」还是只写草稿：没有再发一个 host 调用',
    autoEmpty.calls.length === beforeManual && autoEmpty.drafts.length >= 2,
    'host 调用 +' + (autoEmpty.calls.length - beforeManual) + '，草稿写了 ' + autoEmpty.drafts.length + ' 次')
  check('报告卡自己写着"不会自动发送 / 不会发进任何会话"',
    uiAuto.text().indexOf('不会自动发送') >= 0 && uiAuto.text().indexOf('不会把它发进任何会话') >= 0,
    uiAuto.text().slice(0, 200))

  // 草稿里有用户正在写的东西 → 一个字节都不动，只留按钮让他自己点。
  const autoBusy = autoRun('我正在写别的东西 ')
  const uiBusy = await fireFailure(autoBusy)
  check('草稿里有用户写的字时：自动那一次**没有**动它',
    autoBusy.drafts.length === 0, JSON.stringify(autoBusy.drafts))
  check('但报告卡上给了「把报告放进输入框」按钮（用户自己点）',
    uiBusy.buttonProps('把报告放进输入框') !== undefined, uiBusy.buttons().join(' / '))
  await uiBusy.click('把报告放进输入框')
  check('点了才放，而且把用户写的字留在前面（追加，不冲掉）',
    autoBusy.drafts.length === 1 && autoBusy.drafts[0].indexOf('我正在写别的东西') >= 0
    && autoBusy.drafts[0].indexOf('textures-unresolved') >= 0, JSON.stringify(autoBusy.drafts))

  // 设置开关：默认开，位置在 ⚙ 设置卡里。
  await uiBusy.click('⚙')
  const autoLabel = uiBusy.nodes().filter((node) => node.type === 'label'
    && textOf(node).indexOf('出错时自动把报告放进输入框') >= 0)[0]
  const autoBox = autoLabel === undefined ? undefined : walk(autoLabel, []).filter((node) => node.type === 'input')[0]
  check('设置卡里有「出错时自动把报告放进输入框」开关，默认是开的',
    autoBox !== undefined && autoBox.props.checked === true,
    autoLabel === undefined ? '找不到那一行' : '子节点 ' + autoLabel.children.length)

  // ── 右侧栏：只有槽、没有服务时，不许"两处都没有" ──────────────────────────────
  //
  // 用户实测："刷新之后右边栏一片空白"。原因的形状是：`slotHasEntries()` 让
  // `inRightColumn` 为真、可 `sidebarRightTabs` 服务恰好不在，于是流程进了 `placeRight()`
  // 又立刻 return —— 左栏那份已经撤了，右栏什么都没挂。
  console.log('--- 右侧栏：只有槽、没有 tabs 服务时也不许"两处都没有"')
  const tabsStub = { register: () => () => {} }
  const sidebarCases = [
    { label: '只有槽、没有 sidebarRightTabs 服务：面板仍然挂得上（挂不上就是屏幕上什么都没有）',
      options: { slotEntries: { 'sidebar.right.pane.tab': [{ key: 'mc-art.atlas' }] } },
      expect: 'main' },
    { label: '服务和槽都在：面板挂进右栏 pane（不是掉回左栏）',
      options: { slotEntries: { 'sidebar.right.pane.tab': [{ key: 'mc-art.atlas' }] },
        services: { sidebarRightTabs: tabsStub, sidebarRight: {} },
        allowMissingMain: true },
      expect: 'sidebar.right.pane.tab' },
  ]
  handlers = makeHandlers({})
  for (const entry of sidebarCases) {
    let built = null, thrown = null
    try { built = buildPanel(faulted, makeHost([]), createReact().api, entry.options) } catch (error) { thrown = error }
    if (entry.expect === 'main') {
      check(entry.label, thrown === null, thrown === null ? '' : String(thrown.message))
    } else {
      check(entry.label,
        thrown === null && built !== null && built.registered.indexOf(entry.expect) >= 0,
        built === null ? String(thrown && thrown.message) : built.registered.join(','))
    }
  }

  // ── 畸形 JSON / 类型不对：一律不许白屏 ───────────────────────────────────────
  //
  // 宿主与面板之间走 JSON，`undefined` 字段会被丢掉，"少一个字段"是常态而不是异常。
  // 这里给一份**每个字段都不对**的答复，要求面板照常画出来（出现渲染边界就算失败）。
  console.log('--- 畸形 JSON / 类型不对：一律不许白屏')
  handlers = makeHandlers({ sceneReply: {
    kind: 'block', id: 'ui_probe:bad', quads: { length: 2 }, textureIds: {},
    textures: 'nope', animations: [], errors: 'boom', palette: 'x', refs: 0, box: 0, cells: null,
  } })
  const reactD2 = createReact()
  const hostD2 = makeHost([])
  const builtD2 = buildPanel(faulted, hostD2, reactD2.api)
  const uiBad = await mount(builtD2.main, { sessionId: 'ui-test' }, hostD2, reactD2, 'main')
  if (uiBad.buttonProps('用本会话目录') !== undefined) await uiBad.click('用本会话目录')
  await uiBad.settle()
  check('缺字段 / 类型不对的场景照常渲染（不是白屏、也不该走渲染边界）',
    uiBad.text().indexOf('面板渲染失败') < 0 && uiBad.text().indexOf('MC 资产') >= 0 && uiBad.text().length > 0,
    uiBad.text().slice(0, 160) || '（空白）')
  check('畸形贴图清单也能老实报数（0 面 · 贴图 0/0，不糊涂）',
    uiBad.text().indexOf('0 面 · 贴图 0/0') >= 0, uiBad.text().slice(0, 220))

  // ── 像素编辑器：按面编辑 / 保存发出去的是真 PNG / 只写项目自己的包 ───────────
  const TEX_SIDE = 'ui_probe:block/example_side'
  const TEX_TOP = 'ui_probe:block/example_top'
  const quadOf = (tex, face) => ({ p: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    uv: [[0, 1], [1, 1], [1, 0], [0, 0]], tex: tex, face: face })
  const sceneWithTextures = (ids) => ({
    kind: 'block', id: 'example_block', title: '示例方块',
    quads: [quadOf(ids[0], 'north'), quadOf(ids[0], 'south'), quadOf(ids[0], 'east'), quadOf(ids[0], 'west'),
      quadOf(ids[1], 'up')],
    textureIds: ids,
    textures: ids.reduce((table, id) => { table[id] = PNG_DATA_URL; return table }, {}),
    animations: {}, cells: null, refs: [], errors: [], palette: [], box: null,
  })
  const ITEM_RECIPE = { shape: 'flat', frames: [], animations: {},
    textureIds: ['ui_probe:item/example_item'],
    textures: { 'ui_probe:item/example_item': PNG_DATA_URL },
    layers: [{ texture: 'ui_probe:item/example_item' }] }
  function editorHandlers(ids) {
    return makeHandlers({ sceneReply: sceneWithTextures(ids),
      iconReply: { icons: {}, names: {}, failed: [], items: { example_item: ITEM_RECIPE } } })
  }
  async function openEditorOn(ids) {
    handlers = editorHandlers(ids)
    const callsHere = []
    const reactHere = createReact()
    const hostHere = makeHost(callsHere)
    const built = buildPanel(faulted, hostHere, reactHere.api)
    const ui = await mount(built.main, { sessionId: 'ui-test' }, hostHere, reactHere, 'main')
    if (ui.buttonProps('用本会话目录') !== undefined) await ui.click('用本会话目录')
    const wired = await decodeTextures(ui)
    const opened = await ui.clickLabel('手动修改').then(() => true).catch(() => false)
    await ui.settle()
    return { ui: ui, calls: callsHere, wired: wired, opened: opened }
  }
  console.log('--- 像素编辑器：按面编辑 / 保存发出去的是真 PNG / 只写项目自己的包')
  const editRun = await openEditorOn([TEX_SIDE, TEX_TOP])
  check('假画布 / 假 <img> 接上了（前提：解码链路真的跑过）',
    editRun.wired.canvases > 0 && editRun.wired.images > 0,
    'canvas ' + editRun.wired.canvases + ' / img ' + editRun.wired.images)
  check('贴图解码成功（前提：下面按面编辑才有图可改）',
    editRun.ui.text().indexOf('· 贴图 2/2') >= 0, editRun.ui.text().slice(0, 200))
  check('能打开像素编辑器', editRun.opened === true && editRun.ui.text().indexOf('改贴图') >= 0,
    editRun.ui.buttons().join(' / '))
  check('按面编辑：哪张贴图盖哪些面写在标签上（草方块不会开在泥土那一面）',
    editRun.ui.text().indexOf('侧面 · example_side') >= 0
    && editRun.ui.text().indexOf('顶面 · example_top') >= 0,
    editRun.ui.text().slice(0, 260))
  const saved = await editRun.ui.click('保存').then(() => true).catch(() => false)
  await editRun.ui.settle()
  const saveCall = editRun.calls.filter((call) => call.name === 'atlas.saveTexture').pop()
  const sent = saveCall === undefined ? Buffer.alloc(0) : Buffer.from(String(saveCall.args.base64), 'base64')
  check('保存发出去的是**真 PNG 的字节**（宿主才能"先落临时文件 → 校验 → 再替换"）',
    saveCall !== undefined && Buffer.from(PNG_MAGIC).equals(sent.slice(0, 8)),
    saveCall === undefined ? ('没调用 atlas.saveTexture（保存按钮点了 ' + saved + '）') : sent.slice(0, 8).toString('hex'))
  check('保存用的是项目包内的贴图句柄 + 当前项目（不是绝对路径、不是别的包）',
    saveCall !== undefined && saveCall.args.path === TEX_SIDE && saveCall.args.project === PROJECT.id,
    JSON.stringify(saveCall === undefined ? null : { path: saveCall.args.path, project: saveCall.args.project }))

  // 句柄是绝对路径时：一个字节都不许写盘。
  const editEvil = await openEditorOn(['C:\\Users\\probe\\evil.png', TEX_TOP])
  await editEvil.ui.click('保存').then(() => true).catch(() => false)
  await editEvil.ui.settle()
  check('贴图句柄是绝对路径时一个字节都不写盘，并在屏幕上说清楚（只写项目自己的包）',
    editEvil.calls.filter((call) => call.name === 'atlas.saveTexture').length === 0
    && editEvil.ui.text().indexOf('没有写盘') >= 0,
    editEvil.ui.text().slice(0, 240))

  // ── 3D 没东西可看时放 2D：那张图是方的，不被拉宽 ─────────────────────────────
  console.log('--- 3D 没东西可看时放 2D：方图，不许被拉成面板那么宽')
  handlers = editorHandlers([TEX_SIDE, TEX_TOP])
  const reactP = createReact()
  const hostP = makeHost([])
  const builtP = buildPanel(faulted, hostP, reactP.api)
  const uiP = await mount(builtP.main, { sessionId: 'ui-test' }, hostP, reactP, 'main')
  if (uiP.buttonProps('用本会话目录') !== undefined) await uiP.click('用本会话目录')
  await decodeTextures(uiP)
  if (uiP.buttonProps('物品列表') !== undefined) await uiP.click('物品列表')
  await uiP.settle()
  const pickedItem = await uiP.clickTitle('示例物品').then(() => true).catch(() => false)
  await uiP.settle()
  await decodeTextures(uiP)
  const posters = uiP.nodes().filter((node) => node.props && node.props.className === 'mcart-poster')
  const poster = posters[0]
  check('选中一个没有方块模型的物品时，2D 那张图出现在取景框里（不是一块黑板）',
    pickedItem === true && poster !== undefined && uiP.text().indexOf('3D 里没有东西可看') >= 0,
    pickedItem !== true ? '菜单里没点中物品' : uiP.text().slice(0, 200))
  check('2D 回退是方的，而且不超出取景框较窄的那条边（不能拉成 1.3:1）',
    poster !== undefined && poster.props.width === poster.props.height
    && poster.props.width <= 240 && poster.props.width >= 48,
    poster === undefined ? '没有 poster canvas' : ('width=' + poster.props.width + ' height=' + poster.props.height))

  // ── 每种条目的预览都不许是空白（用户："点胡萝卜/剑 居然预览看不到"）──────────────
  //
  // 真机复现（证据 §11）：`atlas.preview {block:'minecraft:carrot'}` 回的是
  // `{error:'找不到 minecraft:carrot 的模型（参考目录里没有这个方块：minecraft:carrot）'}`
  // —— 对平面物品来说这是**对的**（它不是方块）；`atlas.itemIcons` 那边 shape='flat'、
  // layers/贴图都在。错的是客户端：它只在小卡片里写了一行"3D 取不到"、**没动 scene**，
  // 于是屏幕上留着上一个资产；而 2D 回退的条件是 `scene === null`，那个物品自己的图标
  // 也不会画 —— 用户看到的就是"预览看不到"。
  // 这一节逐条**真画**（renderScene / drawItemIcon 跑在真像素缓冲上），然后**量像素**。
  console.log('--- 每种条目的预览都不许是空白（①方块 ②方块物品 ③平面物品 ④实体）')
  const REF_BLOCK_TEX = 'ref:minecraft:block/stone'
  const FLAT_TEX = 'ref:minecraft:item/carrot'
  const ONE_QUAD = (tex) => ({ p: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]],
    tex: tex, face: 'north' })
  const ONE_QUAD_SOLID = (tex) => ({ p: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]],
    tex: tex, face: 'north' })
  const oneQuadScene = (kind, id) => ({ kind: kind, id: id, title: id,
    quads: [ONE_QUAD_SOLID(REF_BLOCK_TEX)], textureIds: [REF_BLOCK_TEX],
    textures: { [REF_BLOCK_TEX]: PNG_DATA_URL }, animations: {},
    cells: null, refs: [], box: null, errors: [], palette: [] })
  const flatRecipe = (tex) => ({ shape: 'flat', layers: [tex], textureIds: [tex],
    textures: { [tex]: PNG_DATA_URL }, frames: [], animations: {} })
  function viewportHandlers(flatPreview) {
    return makeHandlers({
      refNamespaces: [{ name: 'minecraft', blocks: 1235, textures: 900 }],
      sceneReply: (args) => oneQuadScene((args || {}).kind || 'block', String((args || {}).id || 'x')),
      // ① 项目里的方块、②③ 参考命名空间里的方块物品与平面物品
      itemFacts: (args) => (String((args || {}).source) === 'reference'
        ? [{ id: 'stone', name: '石头', form: 'block', family: '建筑' },
          { id: 'carrot', name: '胡萝卜', form: 'item', family: '食物' }]
        : [{ id: 'example_item', name: '示例物品', form: 'item', family: '材料' }]),
      previewReply: (args) => {
        const block = String((args || {}).block || '')
        if (block.indexOf('carrot') >= 0) {
          // 真机上平面物品的形状：方块预览**失败**（它不是方块）。
          return flatPreview === undefined
            ? { error: '找不到 ' + block + ' 的模型（参考目录里没有这个方块：' + block + '）' }
            : flatPreview
        }
        return { block: block, at: [0, 0, 0], quads: [ONE_QUAD_SOLID(REF_BLOCK_TEX)],
          textureIds: [REF_BLOCK_TEX], textures: { [REF_BLOCK_TEX]: PNG_DATA_URL }, animations: {} }
      },
      iconReply: { icons: {}, names: {}, failed: [], items: {
        stone: { shape: 'iso', display: { rotation: [30, 225, 0] }, quads: [ONE_QUAD(REF_BLOCK_TEX)],
          textureIds: [REF_BLOCK_TEX], textures: { [REF_BLOCK_TEX]: PNG_DATA_URL }, animations: {}, frames: [] },
        carrot: flatRecipe(FLAT_TEX),
        example_item: flatRecipe(FLAT_TEX),
      } },
    })
  }
  async function openViewportPanel(flatPreview) {
    handlers = viewportHandlers(flatPreview)
    const callsHere = []
    const reactHere = createReact()
    const hostHere = makeHost(callsHere)
    const built = buildPanel(faulted, hostHere, reactHere.api)
    const ui = await mount(built.main, { sessionId: 'ui-test' }, hostHere, reactHere, 'main')
    if (ui.buttonProps('用本会话目录') !== undefined) await ui.click('用本会话目录')
    await ui.settle()
    return ui
  }
  async function pickReferenceItem(ui, title) {
    // 物品浏览器先开起来（它默认列本项目），再把来源切到参考命名空间。第二次调用时
    // 来源已经是参考了 —— 那就别再去切一遍（找不到 value='project' 的选择框不是错误）。
    if (ui.buttonProps('物品列表') !== undefined) await ui.click('物品列表')
    await ui.settle()
    await pixelsOf(ui)
    const out = ui.nodes().filter((node) => node.type === 'select' && String(node.props.value) === 'project')[0]
    if (out !== undefined) {
      out.props.onChange({ target: { value: 'ref:minecraft' } })
      await ui.settle()
    } else {
      const inside = ui.nodes().filter((node) => node.type === 'select'
        && String(node.props.value) === 'ref:minecraft')[0]
      if (inside === undefined) return false
    }
    return ui.clickTitle(title).then(() => true).catch(() => false)
  }

  const uiView = await openViewportPanel(undefined)
  // ① 方块：左边菜单点一个方块，3D 里必须有画出来的像素。
  await uiView.clickLabel('示例方块').then(() => true).catch(() => false)
  const blockPixels = await pixelsOf(uiView)
  check('①方块：取景框里真的有画出来的像素（不是空白）',
    blockPixels.scenePixels > 0, JSON.stringify(blockPixels))
  // ④ 实体：菜单里的实体，同样要画出东西来。
  await uiView.clickLabel('示例实体').then(() => true).catch(() => false)
  const entityPixels = await pixelsOf(uiView)
  check('④实体：取景框里真的有画出来的像素（不是空白）',
    entityPixels.scenePixels > 0, JSON.stringify(entityPixels))
  // ② 方块物品（参考命名空间的石头）：方块预览成功 → 3D 里有东西。
  const pickedStone = await pickReferenceItem(uiView, '石头')
  const stonePixels = await pixelsOf(uiView)
  check('②方块物品：预览里有画出来的像素（不是空白）',
    pickedStone === true && stonePixels.scenePixels > 0,
    pickedStone !== true ? '没点中石头那一格' : JSON.stringify(stonePixels))
  // ③ 平面物品（胡萝卜）：方块预览**失败**（真机形状）→ 必须放它自己的 2D 图标，
  //    而且屏幕上要说出来；屏幕绝不能停在上一个资产上。
  const pickedCarrot = await pickReferenceItem(uiView, '胡萝卜')
  const carrotPixels = await pixelsOf(uiView)
  check('③平面物品：取景框里放的是它自己的 2D 图标，而且真的画出了像素',
    pickedCarrot === true && carrotPixels.hasPoster === true && carrotPixels.posterPixels > 0,
    pickedCarrot !== true ? '没点中胡萝卜那一格' : JSON.stringify(carrotPixels))
  check('③平面物品：屏幕上说清了"3D 取不到 / 为什么"（不许静默）',
    uiView.text().indexOf('取不到') >= 0 || uiView.text().indexOf('一个面都没有') >= 0,
    uiView.text().slice(0, 240))

  // 反向夹具：平面物品那一路回一个"非 null 但没有几何"的 scene（Lead 说的 (a) 形状）——
  // 旧代码会把它当成"有场景"，3D 空着、2D 又被 `scene === null` 跳过：屏幕全白且无声。
  const uiHollow = await openViewportPanel({ quads: [], textureIds: [], textures: {}, animations: {} })
  const pickedHollow = await pickReferenceItem(uiHollow, '胡萝卜')
  const hollowPixels = await pixelsOf(uiHollow)
  check('反向夹具（非 null 但没有几何的 scene）：照样要画出它自己的 2D 图标',
    pickedHollow === true && hollowPixels.hasPoster === true && hollowPixels.posterPixels > 0,
    pickedHollow !== true ? '没点中胡萝卜那一格' : JSON.stringify(hollowPixels))
  check('反向夹具：屏幕上明说"这一条 3D 里一个面都没有"（不许是一个静默的空对象）',
    uiHollow.text().indexOf('一个面都没有') >= 0, uiHollow.text().slice(0, 240))

  // ── 一页里有一个取不到图标的格子：只有那一格"缺"，其余照常 ──────────────────────
  //
  // panel-host 把"一个取不到图标的物品会让整页一起失败"修在了宿主侧：坏格现在回一个
  // **形状完整的 `missing: true` 对象**（带 error/reason），不再回 `undefined`（那样会被
  // 严格 JSON 校验当场拒收，真运行时的 `cloneJson` 同样拒）。渲染这一侧必须特判它：
  // 坏格给一个"缺"的样子 + 原因，好格照常画 —— 一个坏值不许放大成整页的异常。
  console.log('--- 缺图标的那一格：只有这一格"缺"，其余照常（按像素）')
  const MISSING_TEX = 'ui_probe:item/nothing_yet'
  const MISSING_RECIPE = {
    namespace: PROJECT.namespace, item: 'nothing_yet', name: 'nothing_yet', shape: 'none',
    error: '参考目录里没有这个物品：ui_probe:nothing_yet', missing: true, reason: 'reference-item-missing',
    light: null, display: null, form: null, family: null, formLabel: null, named: false,
    layers: [], frames: [], framesTruncated: false, quads: [], textureIds: [], textures: {}, animations: {},
    missingModels: [], modelPath: '',
  }
  const GOOD_FLAT_RECIPE = flatRecipe(MISSING_TEX)
  handlers = makeHandlers({
    itemFacts: [{ id: 'good_item', name: '好物品', form: 'item', family: '材料' },
      { id: 'nothing_yet', name: '缺物品', form: 'item', family: '材料' }],
    iconReply: { icons: {}, names: {}, failed: [], items: {
      good_item: GOOD_FLAT_RECIPE, nothing_yet: MISSING_RECIPE } },
  })
  const reactM = createReact()
  const callsM = []
  const hostM = makeHost(callsM)
  const builtM = buildPanel(faulted, hostM, reactM.api)
  const uiM = await mount(builtM.main, { sessionId: 'ui-test' }, hostM, reactM, 'main')
  if (uiM.buttonProps('用本会话目录') !== undefined) await uiM.click('用本会话目录')
  await uiM.settle()
  if (uiM.buttonProps('物品列表') !== undefined) await uiM.click('物品列表')
  await decodeTextures(uiM)
  const slotFor = (id) => uiM.nodes().filter((node) => node.type === 'button'
    && node.props.className === 'mcart-slot' && String(node.props.title || '').indexOf('\n' + id + '\n') >= 0)[0]
  const goodSlot = slotFor('good_item')
  const badSlot = slotFor('nothing_yet')
  check('一页里两格都在（前提）', goodSlot !== undefined && badSlot !== undefined,
    uiM.buttons().join(' / ').slice(0, 200))
  check('好格照常拿到了图标（背景图是烘出来的 PNG）',
    goodSlot !== undefined && String((goodSlot.props.style || {}).backgroundImage || '').indexOf('data:image/png') >= 0,
    JSON.stringify(goodSlot === undefined ? null : goodSlot.props.style))
  check('坏格**不是**空的：有"缺"的角标，而且 title 里带着原因',
    badSlot !== undefined && badSlot.props['data-missing'] === '1'
    && textOf(badSlot).indexOf('缺') >= 0
    && String(badSlot.props.title || '').indexOf('参考目录里没有这个物品') >= 0,
    badSlot === undefined ? '没有那一格' : JSON.stringify({ flag: badSlot.props['data-missing'], text: textOf(badSlot), title: String(badSlot.props.title || '').slice(0, 120) }))
  check('好格没有被坏格带坏（它没有 data-missing）',
    goodSlot !== undefined && (goodSlot.props['data-missing'] === undefined || goodSlot.props['data-missing'] === '0'))
  // 像素：物品栏那排九格里，好物品那格画出来了、缺物品那格没有画（它本来就画不出来），
  // 但坏格在**屏幕上**有"缺"的角标与原因 —— 空白的那一格必须带着解释。
  const hudIcons = wiredByClass('mcart-hudicon')
  const goodHud = opaquePixels(hudIcons[0])
  const badHud = opaquePixels(hudIcons[1])
  check('物品栏（2D 那排）里：好物品那格真的画出了像素，缺物品那格没画',
    hudIcons.length >= 2 && goodHud > 0 && badHud === 0,
    'hud 画布 ' + hudIcons.length + ' 块，好格 ' + goodHud + ' 像素，缺格 ' + badHud + ' 像素')
  const hudMissing = uiM.nodes().filter((node) => node.type === 'button'
    && node.props.className === 'mcart-hudslot' && node.props['data-missing'] === '1')
  check('缺物品在物品栏里也标着"缺"，原因在 tooltip 里（不是一格空画布）',
    hudMissing.length === 1 && textOf(hudMissing[0]).indexOf('缺') >= 0
    && String(hudMissing[0].props.title || '').indexOf('参考目录里没有这个物品') >= 0,
    JSON.stringify(hudMissing.map((node) => String(node.props.title || '').slice(0, 90))))
  // 一个坏值也不该变成"无限重问宿主"：稳定之后请求次数不再涨。
  const pageAsksBefore = callsM.filter((call) => call.name === 'atlas.itemIcons').length
  await uiM.settle()
  await uiM.settle()
  const pageAsksAfter = callsM.filter((call) => call.name === 'atlas.itemIcons').length
  check('一个缺的格子不会让宿主被反复重问（稳定后请求次数不再涨）',
    pageAsksAfter === pageAsksBefore, pageAsksBefore + ' -> ' + pageAsksAfter)

  // ── 动画描述：宿主查过 .mcmeta 就照它说，不许自己按形状下结论 ────────────────────
  //
  // 用户报："项目自己的动图在面板里糊，而且提示说'没有动画描述'，可 `.mcmeta` 明明在"。
  // 宿主只查参考贴图、从不读项目自己的 `.png.mcmeta` —— 那条已在宿主侧修好；剩下的
  // **情况 C** 是：`.mcmeta` 在、但读不了（坏 JSON / 没有 animation 段 / 图不是竖条）。
  // 现在宿主把真话放进 `scene.animationNotes[id].text`，屏幕必须**照抄**它，而不是退回
  // "形状像条带但没有动画描述" —— 文件明明在，那句话就是在指责产物。
  console.log('--- 动画描述：A 合法 / B 真没有 / C 有但读不了（宿主说了就照抄）')
  const ANIM_TEX = 'ui_probe:block/example_anim'
  const animScene = (animations, animationNotes) => ({
    kind: 'block', id: 'example_anim', title: '示例动图',
    quads: [ONE_QUAD_SOLID(ANIM_TEX)], textureIds: [ANIM_TEX],
    textures: { [ANIM_TEX]: PNG_DATA_URL }, animations: animations || {},
    animationNotes: animationNotes || {}, cells: null, refs: [], box: null, errors: [], palette: [],
  })
  async function animRun(reply) {
    handlers = makeHandlers({ sceneReply: reply })
    const reactA = createReact()
    const hostA = makeHost([])
    const built = buildPanel(faulted, hostA, reactA.api)
    const ui = await mount(built.main, { sessionId: 'ui-test' }, hostA, reactA, 'main')
    if (ui.buttonProps('用本会话目录') !== undefined) await ui.click('用本会话目录')
    await ui.settle()
    // 竖条贴图（16×192 = 12 帧 × 16）：只有形状像条带，"没有动画描述"那句才有机会出现，
    // 而且 `strip` 必须真的能整除（12×16=192），否则判定会走上"不是条带"那条。
    fakeImageSize = { width: 16, height: 192 }
    try { await decodeTextures(ui) } finally { fakeImageSize = { width: 16, height: 16 } }
    return ui
  }
  // A：`.mcmeta` 合法 —— 宿主会把它放进 `animations`，那一行画出"单帧 12"。
  const uiAnimA = await animRun(animScene({ [ANIM_TEX]: { strip: 12, frames: 12, frametime: 4 } }, {}))
  const saidA = uiAnimA.text()
  check('A（.mcmeta 合法）：画出动画那一行，两句"没有/读不了"都不出现',
    saidA.indexOf('动画 ' + ANIM_TEX) >= 0 && saidA.indexOf('判定 单帧 12') >= 0
    && saidA.indexOf('没有动画描述') < 0 && saidA.indexOf('读不了') < 0,
    saidA.slice(0, 300))
  // B：旁边**真的没有** `.mcmeta`（宿主没话说）—— 这时那句形状判断才是对的。
  const uiAnimB = await animRun(animScene({}, {}))
  const saidB = uiAnimB.text()
  check('B（真没有 .mcmeta）：才轮到"没有动画描述"，而且说清补哪个文件',
    saidB.indexOf('没有动画描述') >= 0 && saidB.indexOf('.png.mcmeta') >= 0
    && saidB.indexOf('读不了') < 0, saidB.slice(0, 320))
  // C：`.mcmeta` 在、但读不了 —— 必须原样显示宿主那句真话，绝不说"没有动画描述"。
  const NOTE_C = '这张贴图**有**动画描述文件，但我读不了它：'
    + 'pack/assets/ui_probe/textures/block/example_anim.png.mcmeta —— 坏 JSON（第 3 行多了个逗号）'
  const uiAnimC = await animRun(animScene({}, { [ANIM_TEX]: { state: 'unreadable', text: NOTE_C } }))
  const saidC = uiAnimC.text()
  check('C（.mcmeta 在但读不了）：原样显示宿主的真话（文件在、读不了、原因）',
    saidC.indexOf('有**动画描述文件，但我读不了它') >= 0 && saidC.indexOf('坏 JSON') >= 0,
    saidC.slice(-260))
  check('C：**绝不**出现"没有动画描述"（文件明明在，那句话是在指责产物）',
    saidC.indexOf('没有动画描述') < 0, saidC.slice(-260))

  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error('THREW', error); process.exit(1) })
