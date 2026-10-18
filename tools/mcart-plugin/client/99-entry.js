/**
 * 「画不出来」在屏幕上的报告。契约见 BRIEF §2.4。
 *
 * 这件事有一条**信任级**的红线：面板曾经把用户的会话日志写坏（0.1.26 往 agent 里塞了一条
 * 没有 `source` 的消息，会话再也打不开）。所以报告**只在屏幕上**：人能读、能一键复制，
 * 而这个文件里**没有**任何 `steer` / inbox / 会话写方法的调用 —— 报告不注入任何地方。
 * 界面门禁（`panel/ui-test.mjs`）静态 + 行为两头都盯着这一条。
 */
const DIAG_REASON = {
  'project-model-missing': '项目包里缺这个模型文件（要补的是项目自己的文件，不是原版的）',
  'vanilla-parent-missing': '原版母模型没取到（参考目录没设对，或那个 jar 里确实没有）',
  'no-reference-directory': '还没有设置参考目录，原版/模组的模型取不到',
  'reference-jar-missing': '参考目录里找不到对应的 jar',
  'extractor-failed': '抽取器跑失败了（多半是 Python 探测或工具本身的毛病）',
  'parent-cycle': '模型 parent 链成环了',
  // 契约后来加的两个取值：模型/链都在，是"贴图"或"面"那一段空掉了。
  'textures-unresolved': '模型解析出来了，但面上引用的贴图取不到（典型：项目模型用了原版的 minecraft:block/…，而参考目录没设或取不到）',
  'no-quads': '整条模型链都完整，但一个面都没产出（例如零厚度平面 + 贴图缺失）',
  'unknown': '原因不明',
}
// ↓ 这两句是报告里最容易指错方向的地方：项目自己的缺失**绝不许**说成"缺的原版母模型"。
const DIAG_KIND = { project: '项目里缺', vanilla: '缺的原版母模型' }
// 报告长度的上限：屏幕是有限的，同一条报告刷屏比不报还糟。
const DIAG_LINES = 20
// 折叠前先显示几行。
const DIAG_SHOW = 8

/**
 * 原因那一行。
 *
 * **兜底是硬要求**：宿主那边的契约会长出新 `reason`（面板比宿主旧是常态），而"原因"
 * 这一行绝不许因为不认识这个词就变成空白 / `undefined`。不认识的取值**把原值照抄**出来，
 * 人至少能拿着那个英文原值去搜、去问；`unknown` 才是"宿主连 reason 都没给"。
 */
function reasonLine(reason) {
  const raw = typeof reason === 'string' ? reason : ''
  if (raw !== '' && Object.prototype.hasOwnProperty.call(DIAG_REASON, raw)) {
    return '原因：' + DIAG_REASON[raw] + '（' + raw + '）'
  }
  if (raw !== '') return '原因：' + raw + '（面板不认识这个 reason，把原值照贴出来）'
  return '原因：unknown（宿主没有给 reason）'
}

const diagnosticOf = (payload) => {
  const raw = payload === null || payload === undefined ? undefined : payload.diagnostic
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  return {
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : 'unknown',
    block: typeof raw.block === 'string' ? raw.block : '',
    missing: arrayOf(raw.missing).filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        kind: entry.kind === 'vanilla' ? 'vanilla' : 'project',
        name: typeof entry.name === 'string' ? entry.name : '',
        fixPath: typeof entry.fixPath === 'string' ? entry.fixPath : '',
      })),
    tried: arrayOf(raw.tried).map((line) => String(line)),
    referenceDirectory: typeof raw.referenceDirectory === 'string' ? raw.referenceDirectory : '',
  }
}

/** 人能照着做的几行字。顺序就是照做的顺序：先一句人话，再原因，再要补的文件。 */
function diagLines(diag, error) {
  const lines = []
  const head = error === null || error === undefined ? '' : String(error).trim()
  if (head !== '') lines.push(head)
  lines.push(reasonLine(diag.reason))
  if (diag.block !== '') lines.push('方块：' + diag.block)
  for (const entry of diag.missing) {
    lines.push('· ' + (DIAG_KIND[entry.kind] || DIAG_KIND.project) + '：'
      + (entry.name === '' ? '（没给名字）' : entry.name)
      + (entry.fixPath === '' ? '' : ' —— 要动这个文件：' + entry.fixPath))
  }
  lines.push(diag.referenceDirectory === ''
    ? '参考目录：没设。点右上角 ⚙ 把 .minecraft / 版本目录 / mods 目录的路径贴进去'
    : '参考目录：' + diag.referenceDirectory)
  if (diag.tried.length > 0) {
    lines.push('已经试过：')
    for (const line of diag.tried) lines.push('  - ' + String(line))
  }
  return lines
}

function diagText(diag, error) {
  const all = diagLines(diag, error)
  if (all.length <= DIAG_LINES) return all.join('\n')
  return all.slice(0, DIAG_LINES).join('\n') + '\n…（还有 ' + (all.length - DIAG_LINES) + ' 行没画出来）'
}

/** 同一个 (原因, 方块, 缺什么) 只留一条：报告反复出现本身就是在刷屏。 */
function reportKeyOf(diag) {
  return diag.reason + '|' + diag.block + '|'
    + diag.missing.map((entry) => entry.kind + ':' + entry.name).join(',')
}

const versionTag = () => '（MC 资产面板 ' + String(PANEL_VERSION) + '）'

/**
 * 「取不到 / 画不出」这类话在屏幕上一定要带版本号：用户报问题时能直接照着说，
 * 免得"你装的是哪一版"来回问。其它正常句子**不加**，加了就是噪音。
 */
function withVersion(text) {
  const line = text === null || text === undefined ? '' : String(text)
  if (line === '') return line
  if (line.indexOf('MC 资产面板') >= 0) return line
  if (!/(画不出|取不到|拿不到|失败|没有返回|没写盘)/.test(line)) return line
  return line + versionTag()
}

/**
 * 贴图句柄的底线：**只写项目自己的包**。
 *
 * `atlas.saveTexture` 收的是贴图句柄（`<ns>:<路径>`），宿主拿它在项目包里定点写；
 * 一个绝对路径或 `..` 就是"写到项目外面去"的形状。客户端在发出去之前先挡下来，
 * 屏幕上说清楚，而不是让宿主去背这个锅。
 */
function safeTextureHandle(id) {
  const text = id === undefined || id === null ? '' : String(id)
  if (text === '') return false
  if (text.indexOf('\u0000') >= 0) return false
  if (/^[a-zA-Z]:/.test(text)) return false
  if (text.charAt(0) === '/' || text.charAt(0) === '\\') return false
  if (text.split(/[\\/]/).indexOf('..') >= 0) return false
  if (text.indexOf('..') >= 0) return false
  return true
}

/**
 * 幽灵预览的归一化。宿主回来的 `atlas.preview` 缺字段是常态（JSON 会丢掉 `undefined`），
 * 而 `ghost.quads.length` 在渲染键里被直接读 —— 少一个 `quads` 就是一次白屏。
 */
const ghostOf = (result, base) => ({
  block: base.block,
  at: base.at,
  variant: base.variant,
  loading: false,
  quads: arrayOf(result.quads),
  textures: objectOf(result.textures),
  textureIds: idsOf(result),
  animations: objectOf(result.animations),
})
function countsOf(list, keyOf, labelOf) {
  // `{key: {count, label}}` for a chip row -- labels come from the data.
  const out = {}
  for (const entry of list || []) {
    const key = keyOf(entry) || ''
    // An entry with no category is not a category: a chip labelled "" would be
    // an unclickable button with a count on it.
    if (key === '') continue
    if (out[key] === undefined) out[key] = { count: 0, label: labelOf(entry) || key }
    out[key].count += 1
  }
  return out
}

function cssColour(colour) {
  if (colour === null || colour === undefined) return 'transparent'
  return 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ',' + (colour[3] / 255) + ')'
}

function hexOf(colour) {
  const c = colour === null || colour === undefined ? [0, 0, 0, 255] : colour
  const two = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)
  return '#' + two(c[0]) + two(c[1]) + two(c[2])
}

function fromHex(text, alpha) {
  const raw = String(text === undefined || text === null ? '' : text).replace('#', '')
  const a = alpha === undefined ? 255 : alpha
  if (raw.length !== 6) return [0, 0, 0, a]
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), a]
}

/** Which faces a texture covers, in words.  The tab order follows the model,
 *  which starts at the bottom, so a grass block opened on 底面 example_soil and
 *  nothing said so -- a label is the honest fix, not a different order. */
function faceLabel(faces) {
  const list = faces === undefined || faces === null ? [] : faces
  if (list.length === 0) return '贴图'
  const top = list.indexOf('up') >= 0
  const bottom = list.indexOf('down') >= 0
  const side = list.some((face) => face === 'north' || face === 'south' || face === 'west' || face === 'east')
  const parts = []
  if (top) parts.push('顶面')
  if (side) parts.push('侧面')
  if (bottom) parts.push('底面')
  return parts.length === 0 ? '贴图' : parts.join('+')
}

function sameColour(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/** Add one colour to a palette, newest last, without duplicates.
 *
 *  Kept out of the render path on purpose.  `<input type="color">` fires its
 *  change event continuously while the picker is being dragged, so anything
 *  that appends there produces one swatch per intermediate colour and the
 *  panel fills up with hundreds of them. */
function addToPalette(palette, colour, limit) {
  if (colour === null || colour === undefined) return palette
  if (palette.some((c) => sameColour(c, colour))) return palette
  const next = palette.concat([colour])
  return next.length > limit ? next.slice(next.length - limit) : next
}

function readPixel(pixels, width, x, y) {
  const at = (y * width + x) * 4
  return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
}

function writePixel(pixels, width, x, y, colour) {
  const at = (y * width + x) * 4
  pixels[at] = colour[0]
  pixels[at + 1] = colour[1]
  pixels[at + 2] = colour[2]
  pixels[at + 3] = colour[3]
}

/** The colours actually used by this sprite, in the same sense the engine's
 *  analyzer means it: opaque pixels only, first-seen order. */
function paletteOf(pixels, limit) {
  const seen = []
  const known = {}
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    const key = pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2] + ',' + pixels[i + 3]
    if (known[key] === true) continue
    known[key] = true
    seen.push([pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]])
    if (seen.length >= limit) break
  }
  return seen
}

let canvasGeneration = 0
let lastDrawKey = ''
// The camera the last frame was drawn with.  A click is a pixel, and turning
// that pixel into "how far up the face did I hit" needs the same projection the
// pick buffer was filled with -- not a fresh one from current state.
let lastCamera = null
// 上一条「画不出来」报告是谁。同一个 key 再来一次只在屏幕上留一行"同一条"，
// 不再把整段报告重画一遍 —— 刷屏的报告等于没有报告。
let lastReportKey = ''

// ---- 「出错时让 AI 知道」：只写输入框草稿，**永不发送** ----------------------
//
// 用户的诉求是"太依赖脚本了：出错的内容会立刻死掉，AI 不知道"。而 0.1.26 的教训是
// 宿主往会话日志里写会写坏会话（所以永久禁掉了注入）。两条的交点就是这里：
// **客户端把报告放进输入框的草稿**，用户自己按回车才发出去 —— 面板这一侧对外
// **零 host 调用**，更没有 `agent.*` / `session.*`。
//
// 输入框的把手（`inputActions.setDraft` / `useInput`）只有 `conversation.input.dock`
// 槽的 props 里有，所以引用条每渲染一遍就把它们记下来；`useInput` 是壳给的**钩子**，
// 只能在渲染时调，所以这里连"这一遍读到的草稿"一起缓存。
const composer = { write: null, draft: '' }
const composerWaiters = []
let composerFilledKey = ''
let autoReportOn = true
let lastAutoVerdict = ''
const AUTO_REPORT_KEY = 'dsh-mc-art.auto-report'
try {
  if (typeof localStorage !== 'undefined' && localStorage !== null && localStorage.getItem(AUTO_REPORT_KEY) === '0') {
    autoReportOn = false
  }
} catch (error) { /* 沙箱里没有 storage：用默认值（开） */ }

function setAutoReport(on) {
  autoReportOn = on === true
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) {
      localStorage.setItem(AUTO_REPORT_KEY, autoReportOn ? '1' : '0')
    }
  } catch (error) { /* 存不下不影响本次会话 */ }
}

/** 输入框的把手什么时候到手。到手之前先排队，到手了就通知（面板要重试一次）。 */
function onComposerReady(callback) {
  if (typeof composer.write === 'function') { callback(); return () => {} }
  composerWaiters.push(callback)
  return () => {
    const at = composerWaiters.indexOf(callback)
    if (at >= 0) composerWaiters.splice(at, 1)
  }
}
function composerCaptured() {
  const waiting = composerWaiters.slice()
  composerWaiters.length = 0
  for (const callback of waiting) {
    try { callback() } catch (error) { /* 等的人自己有问题不该拖垮这里 */ }
  }
}

/**
 * 把一段文本放进输入框草稿。返回值就是屏幕上那句话的依据：
 *   'filled'（放进去了）| 'busy'（草稿里有别人的字，**不覆盖**）| 'done'（同一条已经放过）
 *   | 'off'（开关关了）| 'no-composer'（这个壳没有输入框接口）
 * `manual` = 用户**自己点的按钮**：这时不许再拿"草稿非空"挡他（他就是要放），
 * 而且是**追加**到他写的东西后面，不冲掉。
 */
function autoFillDraft(text, key, manual) {
  const body = text === null || text === undefined ? '' : String(text)
  const name = key === undefined || key === null ? '' : String(key)
  if (body === '') { lastAutoVerdict = 'empty'; return 'empty' }
  if (autoReportOn !== true && manual !== true) { lastAutoVerdict = 'off'; return 'off' }
  if (manual !== true && name !== '' && composerFilledKey === name) { lastAutoVerdict = 'done'; return 'done' }
  if (typeof composer.write !== 'function') { lastAutoVerdict = 'no-composer'; return 'no-composer' }
  const current = String(composer.draft === undefined || composer.draft === null ? '' : composer.draft)
  // **不许覆盖用户正在写的东西。**（自动那条路；用户自己点按钮是另一回事。）
  if (manual !== true && current.trim() !== '') { lastAutoVerdict = 'busy'; return 'busy' }
  const base = manual === true && current.trim() !== '' ? current.replace(/\s+$/, '') + ' ' : ''
  composer.write(base + body)
  composerFilledKey = name
  lastAutoVerdict = 'filled'
  return 'filled'
}

/** 给 AI 看的报告：自包含 —— 版本、资产身份、reason、缺什么（含 fixPath）、参考目录。 */
function reportForAI(diag, error) {
  return '这是「MC 资产面板」自动生成的报告（面板版本 ' + String(PANEL_VERSION)
    + '；只放进草稿，没有发送，按回车之前都可以改）。'
    + '\n' + diagText(diag, error)
    + '\n请按这份报告直接修，不用再问我。'
}
/** 渲染期抛异常时那份报告：没有结构化诊断，但也不能让 AI 干等。 */
function reportForBoundary(error) {
  const message = error !== null && error !== undefined && error.message !== undefined
    ? String(error.message) : String(error)
  return '这是「MC 资产面板」自动生成的报告（面板版本 ' + String(PANEL_VERSION)
    + '；只放进草稿，没有发送）。'
    + '\n面板渲染失败：' + message
    + '\n这一条没有结构化诊断（异常发生在渲染期）。请从这句话入手。'
}
// Frame clock for animated textures, counted in the timer's own ticks (50 ms
// each).  Deliberately not `Date.now()`: the only clock this half is given is
// the timer service, and deriving the frame from the very ticks that trigger
// the redraw means the picture and the clock cannot drift apart.
let animTicks = 0

const roots = {}
const listeners = []
let pending = null
function setPending(next) {
  pending = next
  const copy = listeners.slice()
  for (const listener of copy) listener()
}
function usePending() {
  const pair = React.useState(pending)
  React.useEffect(() => {
    const listener = () => pair[1](pending)
    listeners.push(listener)
    return () => {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    }
  }, [])
  return pair[0]
}

return {
  // 硬依赖（cordis 会等它们就绪再调 apply）：
  //   timer —— 受限沙箱里没有浏览器定时器（setInterval 会把整个 tab 干死），只能用它；
  //   slots —— 注册落点全靠它。**必须声明成硬依赖**：以前只在 apply 里 `ctx.get('slots')`
  //   软取，取不到就静默 return，于是冷启动顺序一变就整块不注册，而屏幕上、日志里
  //   一个字都没有（0.2.1 上"插件 active 但面板不在槽里"就是这么被藏起来的）。
  inject: ['timer', 'slots'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined || slots === null) {
      // 到这儿说明硬依赖没兑现——宁可响，也不要静默地什么都不注册。
      console.error('[mcart] slots 服务没就绪，面板不注册（这条要报给宿主，别静默）')
      return
    }
    // A hard dependency (declared above), so it is present -- not a maybe.
    const timer = ctx.timer
    ctx.effect(() => styles.insert(CSS))

    const tabs = ctx.get('sidebarRightTabs')
    const sidebarRight = ctx.get('sidebarRight')
    // 右侧栏的判据不能只看服务名。有些壳（桌面端实测）不暴露 sidebarRightTabs 服务，
    // 但右侧栏的**槽**是实实在在存在的——只看服务会让面板掉进左栏回退，
    // 看起来像"装了个旧版本"。所以：服务在，或者那个槽已经有条目，都算右侧栏。
    function slotHasEntries(name) {
      try {
        if (typeof slots.entries !== 'function') return false
        const list = slots.entries(name)
        return Array.isArray(list) && list.length > 0
      } catch (error) {
        return false
      }
    }
    // 右侧栏在不在：**必须**有 tabs（注册 tab 的唯一必需品），证据可以是 sidebarRight
    // 服务或右侧栏的槽。没有 tabs 就只能回退左栏——硬进右栏会炸在 tabs.register 上
    // （门禁抓着过我这一版）。
    //
    // 但**不能只在 apply 那一刻采样一次**：冷启动时右侧栏插件可能比我们晚挂载，
    // 于是同一个包"热重载进右栏、重启后进左栏"（用户实测）。所以：先放一个能用的
    // 落点，并等 sidebarRightTabs 出现——出现就搬过去，等不到就一直留在左栏。
    function rightColumnReady() {
      return ctx.get('sidebarRightTabs') !== undefined &&
        (ctx.get('sidebarRight') !== undefined || slotHasEntries('sidebar.right.pane.tab'))
    }
    const tabsReady = ctx.get('sidebarRightTabs')
    const sidebarRightReady = ctx.get('sidebarRight')
    const inRightColumn = tabsReady !== undefined &&
      (sidebarRightReady !== undefined || slotHasEntries('sidebar.right.pane.tab'))

    /**
     * 面板**不允许白屏**。
     *
     * 渲染时抛异常，React 会把整棵子树卸掉 —— 屏幕上什么都不剩，也没有任何提示，
     * 用户只能报"一片空白"。这个边界把错误本身画出来（带包名与版本），于是
     * "空白"这种状态永远带着一句话，能直接贴给我。
     */
    // `React.Component` **不是每个壳都保证有的**：缺了它，`class X extends undefined` 会在
    // 模块求值时就抛 —— 一个为了"别白屏"而加的东西，反过来把整个面板炸掉。所以先问一句，
    // 没有就退化成"直接渲染孩子"（没有边界，但至少能用）。
    const canUseBoundary = typeof React.Component === 'function'
    const PanelBoundary = canUseBoundary
      ? class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error) {
          try { console.error('[mcart] 面板渲染失败', error) } catch (ignored) { /* 没有 console 也不能再炸 */ }
          // 用户的话："出错的内容会立刻死掉，AI 不知道"。所以边界这里也把报告放进
          // 输入框草稿（**只放、不发送**）；对外零 host 调用，绝不碰会话 / agent。
          try {
            autoFillDraft(reportForBoundary(error), 'boundary|'
              + (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)))
          } catch (ignored) { /* 通知失败不该把"报错"这件事本身也弄没 */ }
        }
        render() {
          if (this.state.error === null || this.state.error === undefined) return this.props.children
          const message = this.state.error !== null && this.state.error.message !== undefined
            ? this.state.error.message : this.state.error
          const notice = lastAutoVerdict === 'filled' || lastAutoVerdict === 'done'
            ? '已把这份报告放进输入框（只是草稿，没发送；按回车才会发）'
            : (lastAutoVerdict === 'busy'
              ? '输入框里已经有你写的字，没有动它 —— 报告在上面这段里，选中就能复制'
              : (lastAutoVerdict === 'off'
                ? '「出错时自动把报告放进输入框」现在是关的'
                : (lastAutoVerdict === 'no-composer'
                  ? '这个壳没有给输入框接口 —— 上面这段可以手动选中复制'
                  : '刷新一次；如果仍是这一句，把它连同"MC 资产"面板发给我')))
          return React.createElement('div', { className: 'mcart-root' },
            React.createElement('div', { className: 'mcart-err' },
              '面板渲染失败：' + String(message)),
            React.createElement('div', { className: 'mcart-hint' },
              notice + ' —— 版本：' + String(PANEL_VERSION)),
          )
        }
      }
      : function PanelBoundary(props) { return props.children }

    function Atlas(props) {
      // 故障注入的缝：门禁把它置真，用来证明"渲染抛异常时边界真的会画出那句话"
      // （生产里这面旗永远是 undefined）。
      if (typeof globalThis !== 'undefined' && globalThis.__MCART_FORCE_RENDER_ERROR__ === true) {
        throw new Error('注入的渲染错误')
      }
      const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)
      const indexPair = React.useState(null)
      const failurePair = React.useState(null)
      // 空目录的引导：`emptyRoot` 记着"哪个根目录里一个项目都没有"，`newId` 是用户正在
      // 取的项目名（命名空间与它同名 —— 一个模组一个命名空间，不让在这里分叉）。
      const emptyPair = React.useState(null)
      const newIdPair = React.useState('')
      const noticePair = React.useState(null)
      const nearbyPair = React.useState(null)
      const choicePair = React.useState(null)
      const scenePair = React.useState(null)
      const tickPair = React.useState(0)
      const yawPair = React.useState(0.72)
      const pitchPair = React.useState(0.34)
      const zoomPair = React.useState(1)
      const canvasPair = React.useState(null)
      const scratchPair = React.useState(null)
      const sizePair = React.useState([340, 260])
      // The 3D+hotbar block's height, in the panel.  Only the height: the width
      // is the panel's.  Changing it is enough -- the resize effect reads
      // `clientHeight` and the draw effect keys on the size, so the raster
      // follows without a second path for "resized".
      const viewHPair = React.useState(VIEW_H)
      // The 2D stand-in's canvas, when there is no 3D scene to draw.
      const posterPair = React.useState(null)
      // One line for the item case ("改不了/没有可引用的文件"), shown under the
      // canvas with the other notes rather than in a card that is not open.
      const itemMsgPair = React.useState(null)
      // The last settings save, so the panel can offer the one-line notification.
      const savedSettingsPair = React.useState(null)
      const busyPair = React.useState(false)
      const pickingPair = React.useState(false)
      // 参考目录的手输框内容（与 settings.directory 分开：输入过程中不该直接写盘）。
      const dirDraftPair = React.useState('')
      const draftPair = React.useState('')
      const settingsPair = React.useState(null)
      const savePair = React.useState(null)
      const modsOpenPair = React.useState(false)
      const rootPair = React.useState(roots[sessionId] === undefined ? '' : roots[sessionId])
      const index = indexPair[0], setIndex = indexPair[1]
      const failure = failurePair[0], setFailure = failurePair[1]
      const emptyRoot = emptyPair[0], setEmptyRoot = emptyPair[1]
      const newId = newIdPair[0], setNewId = newIdPair[1]
      const notice = noticePair[0], setNotice = noticePair[1]
      const nearby = nearbyPair[0], setNearby = nearbyPair[1]
      const choice = choicePair[0], setChoice = choicePair[1]
      const scene = scenePair[0], setScene = scenePair[1]
      const tick = tickPair[0], setTick = tickPair[1]
      const yaw = yawPair[0], setYaw = yawPair[1]
      const pitch = pitchPair[0], setPitch = pitchPair[1]
      const zoom = zoomPair[0], setZoom = zoomPair[1]
      const canvas = canvasPair[0], setCanvas = canvasPair[1]
      const scratch = scratchPair[0], setScratch = scratchPair[1]
      const size = sizePair[0], setSize = sizePair[1]
      const viewH = viewHPair[0], setViewH = viewHPair[1]
      const posterCanvas = posterPair[0], setPosterCanvas = posterPair[1]
      const itemMsg = itemMsgPair[0], setItemMsg = itemMsgPair[1]
      const savedSettings = savedSettingsPair[0], setSavedSettings = savedSettingsPair[1]
      const busy = busyPair[0], setBusy = busyPair[1]
      const picking = pickingPair[0], setPicking = pickingPair[1]
      const dirDraft = dirDraftPair[0], setDirDraft = dirDraftPair[1]
      const draft = draftPair[0], setDraft = draftPair[1]
      const settings = settingsPair[0], setSettings = settingsPair[1]
      const saveState = savePair[0], setSaveState = savePair[1]
      const modsOpen = modsOpenPair[0], setModsOpen = modsOpenPair[1]
      const root = rootPair[0], setRoot = rootPair[1]
      const editPair = React.useState(null)
      const undoPair = React.useState([])
      const editTickPair = React.useState(0)
      const editCanvasPair = React.useState(null)
      const editScratchPair = React.useState(null)
      const editBusyPair = React.useState(false)
      const editMsgPair = React.useState(null)
      const voxelPair = React.useState(null)
      const hoverPair = React.useState(null)
      const ghostPair = React.useState(null)
      const iconTickPair = React.useState(0)
      // 贴图纪元：`forgetTextures()` 只是把六张表清空，**它不会让任何 effect 重跑**。
      // 用户实测（"刷新完了之后 2D 贴图没有了"）：清掉 `itemRecipes`/`icons` 之后，
      // 负责把这两张表填回来的 effect 依赖里没有变的东西 —— 配方那个的依赖是
      // `命名空间|第几页|九宫格页|筛选|形态|家族|条目数`，图标那个是 `资产|筛选|页`，
      // 刷新**一个都没变**，于是表清空了却再也没人去取：物品浏览器和那排九格全空白，
      // 左边菜单的方块图标也全没了。清缓存必须同时踢一脚用它的人，所以把纪元号
      // 加进这些 effect 的依赖里。缓存是模块级的，纪元是实例级的，两者各司其职。
      const texEpochPair = React.useState(0)
      // 「画不出来」的报告：`{ diag, error, repeat }`。与 `failure` 分开是因为报告要
      // 折叠、要复制、要去重，而 `failure` 只是一句人读的短句（别的地方也在用）。
      const diagPair = React.useState(null)
      const diagOpenPair = React.useState(false)
      const copiedPair = React.useState('')
      // 「把报告放进输入框」的结果/开关状态（`autoTick` 只是让开关动一次重新渲染一次）。
      const autoStatusPair = React.useState('')
      const autoTickPair = React.useState(0)
      const composerTickPair = React.useState(0)
      const diag = diagPair[0], setDiag = diagPair[1]
      const diagOpen = diagOpenPair[0], setDiagOpen = diagOpenPair[1]
      const copied = copiedPair[0], setCopied = copiedPair[1]
      const autoStatus = autoStatusPair[0], setAutoStatus = autoStatusPair[1]
      const autoTick = autoTickPair[0], setAutoTick = autoTickPair[1]
      const composerTick = composerTickPair[0], setComposerTick = composerTickPair[1]
      const voxel = voxelPair[0], setVoxel = voxelPair[1]
      const hover = hoverPair[0], setHover = hoverPair[1]
      const ghost = ghostPair[0], setGhost = ghostPair[1]
      const iconTick = iconTickPair[0], setIconTick = iconTickPair[1]
      const texEpoch = texEpochPair[0], setTexEpoch = texEpochPair[1]
      const edit = editPair[0], setEdit = editPair[1]
      const undo = undoPair[0], setUndo = undoPair[1]
      const editTick = editTickPair[0], setEditTick = editTickPair[1]
      const editCanvas = editCanvasPair[0], setEditCanvas = editCanvasPair[1]
      const editScratch = editScratchPair[0], setEditScratch = editScratchPair[1]
      const editBusy = editBusyPair[0], setEditBusy = editBusyPair[1]
      const editMsg = editMsgPair[0], setEditMsg = editMsgPair[1]
      const refSourcesPair = React.useState([])
      const refSources = refSourcesPair[0], setRefSources = refSourcesPair[1]
      const itemPair = React.useState(null)
      const item = itemPair[0], setItem = itemPair[1]
      const iconPair = React.useState(null)
      const iconPick = iconPair[0], setIconPick = iconPair[1]
      // The 2D layer of the 3D view -- the game's hotbar.  `item` is the loaded
      // list, `itemOpen` only says whether the BROWSER (source, search, chips,
      // the 40-slot grid) is unfolded.  They used to be one state, so closing the
      // browser threw the list away; now the bar at the bottom keeps its items
      // whether the browser is open or not.
      const itemOpenPair = React.useState(false)
      const itemOpen = itemOpenPair[0], setItemOpen = itemOpenPair[1]
      const hudPagePair = React.useState(1)
      const hudPage = hudPagePair[0], setHudPage = hudPagePair[1]
      // A reference block opened from the item browser: it is not in this
      // project's index, so it cannot go through `open()`.
      const previewPair = React.useState(null)
      const previewItem = previewPair[0], setPreviewItem = previewPair[1]
      const filterPair = React.useState('')
      const filter = filterPair[0], setFilter = filterPair[1]
      const pickGroupPair = React.useState('')
      const pickGroup = pickGroupPair[0], setPickGroup = pickGroupPair[1]
      const pickFamilyPair = React.useState('')
      const pickFamily = pickFamilyPair[0], setPickFamily = pickFamilyPair[1]
      const pickPagePair = React.useState(1)
      const pickPage = pickPagePair[0], setPickPage = pickPagePair[1]

      function activeProjectId() {
        if (choice !== null && choice.project !== undefined && choice.project !== null) return choice.project
        const projects = index === null ? [] : (index.projects || [])
        return projects.length > 0 ? projects[0].id : null
      }

      // 「画不出来」的落点。报告只进 state，只上屏；这里没有一个字节发往会话 / agent。
      function noteDiag(payload, error) {
        const info = diagnosticOf(payload)
        if (info === null) { setDiag(null); return }
        const key = reportKeyOf(info)
        // 同一条（原因+方块+缺什么）再发生一次：屏幕上已有的那条还成立，别再画一遍。
        const repeat = lastReportKey !== '' && lastReportKey === key
        lastReportKey = key
        setDiagOpen(false)
        setCopied('')
        setDiag({ diag: info, error: error === undefined || error === null ? '' : String(error), repeat: repeat, key: key })
      }

      /**
       * 「出错时让 AI 知道」：把这份报告放进输入框的**草稿**。
       *
       *   1. 草稿是空的 → 自动放（用户按一次回车就发，之前都能改）；
       *   2. 草稿里有他正在写的东西 → **一个字节都不动它**，报告卡上留一个按钮让他自己点；
       *   3. 同一条报告不重复塞（`autoFillDraft` 用 key 去重）；
       *   4. 从不到"发送"为止 —— 客户端根本没有发送接口，对外零 host 调用。
       */
      function statusText(verdict) {
        if (verdict === 'filled') return '已放进输入框（只是草稿，没发送；按回车之前都可以改）'
        if (verdict === 'busy') return '输入框里已经有你写的字，没有动它 —— 要放就点左边的按钮'
        if (verdict === 'done') return '同一条报告已经放进过输入框，没有再塞一遍'
        if (verdict === 'off') return '「出错时自动把报告放进输入框」现在是关的'
        if (verdict === 'no-composer') return '这个壳没有给输入框接口 —— 上面那段可以选中复制'
        return '出错时会把这份报告放进输入框（只放草稿，不发送）'
      }
      function placeReport(manual) {
        if (diag === null) return
        const verdict = autoFillDraft(reportForAI(diag.diag, diag.error), 'diag|' + String(diag.key), manual === true)
        setAutoStatus(verdict)
      }

      // 输入框的把手可能比这一次失败晚到手（槽的 props 是渲染时给的）：到手了就重试一次。
      React.useEffect(() => onComposerReady(() => setComposerTick(composerTick + 1)), [])
      // 报告出来时自动放进草稿。`diag.key` 保证同一条只放一次；草稿非空时 `autoFillDraft`
      // 会返回 'busy'，一个字节都不写。
      React.useEffect(() => {
        if (diag === null) return
        const verdict = autoFillDraft(reportForAI(diag.diag, diag.error), 'diag|' + String(diag.key))
        setAutoStatus(verdict)
      }, [diag === null ? '' : String(diag.key), composerTick, autoTick])

      /**
       * 一键复制。**到剪贴板为止**，没有第二条路：绝不把报告送进任何会话 / agent。
       * 浏览器不给剪贴板、或这段代码跑在没有 DOM 的地方（Node 门禁）时，
       * 也只能是"告诉你手动选中上面那段"，绝不许抛 —— 复制失败不该把面板炸掉。
       */
      function copyReport(text) {
        const payload = String(text === undefined || text === null ? '' : text)
        const done = (message) => { try { setCopied(message) } catch (ignored) { /* 不能因为一句提示再炸一次 */ } }
        try {
          const board = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : undefined
          if (board !== undefined && board !== null && typeof board.writeText === 'function') {
            const result = board.writeText(payload)
            if (result !== undefined && result !== null && typeof result.then === 'function') {
              result.then(() => done('已复制到剪贴板'), () => fallbackCopy(payload, done))
            } else { done('已复制到剪贴板') }
            return
          }
        } catch (error) { /* 没有剪贴板就走下面那条 */ }
        fallbackCopy(payload, done)
      }

      function fallbackCopy(text, done) {
        try {
          if (typeof document !== 'undefined' && document !== null && typeof document.createElement === 'function') {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', 'readonly')
            if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(area)
            if (typeof area.select === 'function') area.select()
            const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
            if (document.body && typeof document.body.removeChild === 'function') document.body.removeChild(area)
            done(ok === false ? '没复制成 —— 请手动选中上面那段' : '已复制到剪贴板')
            return
          }
        } catch (error) { /* 没有 DOM 不是错误 */ }
        done('没复制成 —— 请手动选中上面那段')
      }

      function open(target, where) {
        // 换项目就丢像素缓存：缓存按贴图 id 存，而两个项目可以有同名贴图
        // （`examplemod:stone` 换了项目还是那个 id，但文件已经不是同一张）。
        if (lastProject !== target.project) { forgetTextures(); setTexEpoch(texEpoch + 1) }
        lastProject = target.project
        setBusy(true)
        setChoice(target)
        setPreviewItem(null)
        // Switching asset closes whatever was open.  Leaving the previous
        // asset's editor on screen next to a new 3D view invites editing the
        // wrong thing, and the edit buffer belongs to the old texture anyway.
        painting.active = false
        setEdit(null)
        setUndo([])
        setEditMsg(null)
        setVoxel(null)
        setHover(null)
        setGhost(null)
        const want = { root: where, project: target.project, kind: target.kind, id: target.id, have: Object.keys(decoded) }
        host.call('atlas.scene', want).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('scene returned nothing'); return }
          if (result.error !== undefined) {
            setFailure(result.error)
            noteDiag(result, result.error)
            setScene(null)
            return
          }
          setFailure(null)
          // 换了一个画得出来的资产：上一次的报告作废（不然下一条同样的报告会被当成"重复"）。
          lastReportKey = ''
          setDiag(null)
          for (const key of Object.keys(imageNodes)) delete imageNodes[key]
          setScene(sceneOf(result))
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      function firstOfProject(project) {
        if (project === undefined || project === null) return null
        for (const category of CATEGORIES) {
          const items = (project.items && project.items[category.key]) || []
          if (items.length > 0) return { project: project.id, kind: category.key, id: items[0].id }
        }
        return null
      }

      function firstPick(result) {
        const projects = result.projects || []
        for (const category of CATEGORIES) {
          for (const project of projects) {
            const items = (project.items && project.items[category.key]) || []
            if (items.length > 0) return { project: project.id, kind: category.key, id: items[0].id }
          }
        }
        return null
      }

      function scan(where, force, wantProject) {
        if (where === undefined || where === '') { setIndex(null); return }
        if (force !== true && indexes[where] !== undefined) {
          const cached = indexes[where]
          setIndex(cached)
          setFailure(null)
          const project = wantProject === undefined || wantProject === null ? null : (cached.projects || []).filter((p) => p.id === wantProject)[0]
          const first = project !== null && project !== undefined ? firstOfProject(project) : firstPick(cached)
          if (first !== null) open(first, where)
          return
        }
        setBusy(true)
        setFailure(null)
        host.call('atlas.scan', { root: where }).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('scan returned nothing'); return }
          setIndex(result)
          if (result.error !== undefined) { setFailure(result.error); return }
          const projects = result.projects || []
          if (projects.length === 0) {
            // 以前这里直接 setFailure —— 于是"刚开一个空目录"看起来像报错。空目录不是错误，
            // 是**还没开始**：给一张引导卡，让人在这里建出第一个项目。
            setFailure(null)
            setEmptyRoot(where)
            setNewId(String(where).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
            setScene(null)
            return
          }
          setEmptyRoot(null)
          setFailure(null)
          indexes[where] = result
          const project = wantProject === undefined || wantProject === null ? null : projects.filter((p) => p.id === wantProject)[0]
          const first = project !== null && project !== undefined ? firstOfProject(project) : firstPick(result)
          if (first !== null) open(first, where)
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      function commitRoot(next) {
        roots[sessionId] = next
        setRoot(next)
        setDraft('')
        setNotice(null)
        setSettings(null)
        scan(next, false, null)
      }

      function openNearby(rootPath, projectId) {
        roots[sessionId] = rootPath
        setRoot(rootPath)
        setNotice(null)
        scan(rootPath, false, projectId)
      }

      function runPicker(start, onPicked) {
        if (picking === true) return
        setPicking(true)
        setNotice('正在打开系统的目录选择器…（有的环境弹不出来；弹不出来就在下面的输入框里直接贴路径）')
        // 对话框这条路**可能永远不返回**（shell 跑在非交互窗口站上时，
        // FolderBrowserDialog 既不显示也不结束）。但**客户端不许用浏览器计时器**：
        // 动态插件那条送货路的沙箱里没有 setTimeout/setInterval，碰了整个页签会崩
        // （`tools/mcart-plugin/anim-test.js` 就是钉这件事的）。所以期限由**宿主**兜：
        // `atlas.pickDirectory` 自己带 deadline，超时回一个 supported:false + 说明。
        host.call('atlas.pickDirectory', { start: start })
          .then((result) => {
            setPicking(false)
            if (result === null || result === undefined) { setNotice('目录选择器没有返回结果。'); return }
            if (result.error !== undefined) { setNotice(String(result.error)); return }
            if (result.supported === false) {
              setNotice(String(result.detail || '这个环境没有可用的目录选择器，') + '请把路径直接贴进下面的输入框。')
              return
            }
            if (result.cancelled === true) { setNotice(null); return }
            if (typeof result.path === 'string' && result.path.length > 0) { setNotice(null); onPicked(result.path); return }
            setNotice('目录选择器没有返回路径。')
          })
          .catch((error) => {
            setPicking(false)
            setNotice('目录选择器失败：' + String(error && error.message ? error.message : error) +
              '　请把路径直接贴进下面的输入框。')
          })
      }

      function pickDirectory() {
        runPicker(root !== '' ? root : (nearby !== null ? nearby.cwd : ''), commitRoot)
      }

      // 把输入框里的路径写进设置。空字符串 = 取消参考目录，这是有意的：
      // "没设置就不参考外部资源" 是合法状态，不该逼着人一定选一个。
      function applyDirDraft() {
        const wanted = String(dirDraft).trim()
        patchSettings({ directory: wanted }, true)
      }

      function loadSettings() {
        const projectId = activeProjectId()
        if (projectId === null) return
        setSaveState(null)
        setModsOpen(false)
        setSettings({ loading: true })
        host.call('atlas.settings', { root: root, project: projectId }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setSettings({ error: result !== null && result !== undefined && result.error !== undefined ? result.error : '设置读取失败' })
            return
          }
          setSettings(Object.assign({ loading: false }, result))
        }).catch((error) => setSettings({ error: String(error && error.message ? error.message : error) }))
      }

      function openSettings() {
        if (settings !== null) { setSettings(null); return }
        loadSettings()
      }

      function saveSettings(next, rescan) {
        const modMap = {}
        for (const item of next.mods || []) modMap[item.name] = item.on === true
        setSaveState('保存中…')
        host.call('atlas.saveSettings', {
          root: root, project: next.project, directory: next.directory,
          includeGenerated: next.includeGenerated, includeMods: next.includeMods, mods: modMap,
        }).then((result) => {
          const failed = result !== null && result !== undefined && result.error !== undefined
          setSaveState(failed ? ('保存失败：' + result.error) : '已保存')
          if (failed) { setSavedSettings(null); return }
          // What the agent needs to hear, in one line.  The agent reads the same
          // file (`mc_art.project_settings`), so the sentence is a pointer, not a
          // copy: it says what changed and what to do with it.
          const on = (next.mods || []).filter((item) => item.on === true).length
          setSavedSettings({
            path: result.path === undefined ? '' : String(result.path),
            note: '参考目录改成了 ' + (next.directory === '' ? '（空）' : next.directory)
              + '；' + on + '/' + (next.mods || []).length + ' 个 mod 开着，'
              + (next.includeGenerated === false ? '不含' : '含') + '本项目自己的贴图。请按这个重做',
          })
          if (rescan === true) loadSettings()
        }).catch((error) => {
          setSavedSettings(null)
          setSaveState('保存失败：' + String(error && error.message ? error.message : error))
        })
      }

      function patchSettings(patch, rescan) {
        if (settings === null) return
        const next = Object.assign({}, settings, patch)
        setSettings(next)
        saveSettings(next, rescan)
      }

      function toggleMod(name, on) {
        if (settings === null) return
        const mods = (settings.mods || []).map((item) => (item.name === name ? Object.assign({}, item, { on: on }) : item))
        const next = Object.assign({}, settings, { mods: mods })
        setSettings(next)
        saveSettings(next)
      }

      React.useEffect(() => {
        if (root !== '') { scan(root, false, null); return }
        host.call('atlas.session', { sessionId: sessionId })
          .then((result) => {
            const cwd = result !== null && result !== undefined && typeof result.cwd === 'string' && result.cwd.length > 0 ? result.cwd : null
            if (cwd === null) return null
            setNearby({ cwd: cwd, loading: true, projects: [], error: null })
            return host.call('atlas.projects', { path: cwd })
          })
          .then((result) => {
            if (result === null || result === undefined) return
            if (result.error !== undefined) { setNearby({ cwd: result.base || '', loading: false, projects: [], error: result.error }); return }
            setNearby({ cwd: result.base, loading: false, projects: result.projects || [], error: null })
          })
          .catch((error) => setNearby({ cwd: '', loading: false, projects: [], error: String(error && error.message ? error.message : error) }))
      }, [])

      // 参考目录的手输框跟着**已保存的值**走：载入设置、或保存成功之后回到真实值。
      // 依赖是那个字符串本身（不是 settings 对象），所以人正在打字时不会被重置。
      React.useEffect(() => {
        if (settings === null) return
        setDirDraft(typeof settings.directory === 'string' ? settings.directory : '')
      }, [settings === null ? '' : String(settings.directory)])

      React.useEffect(() => {
        if (canvas === null) return
        const width = canvas.clientWidth || 340
        const height = canvas.clientHeight || 240
        if (width !== size[0] || height !== size[1]) setSize([width, height])
      })

      // The 2D stand-in follows the same clock as everything else: a clock keeps
      // ticking, a still sprite is drawn once.  It draws at the size it is shown
      // at, so the scaling is this code's (nearest neighbour) and not the
      // browser's.
      React.useEffect(() => {
        if (posterCanvas === null || posterRecipe === null) return
        const frames = (posterRecipe.frames || []).length
        const frame = frames > 1 ? Math.floor(animTicks / 2) % frames : 0
        drawItemIcon(posterCanvas, posterRecipe, frame, decoded)
      })

      // React attaches `onWheel` as a PASSIVE listener on its root container, so
      // preventDefault() inside it does nothing and the page zoomed instead of
      // the model.  The listener has to go on the element itself, non-passive.
      React.useEffect(() => {
        if (canvas === null) return
        function onWheel(event) {
          event.preventDefault()
          setZoom((previous) => Math.max(0.35, Math.min(3, previous * (event.deltaY > 0 ? 0.92 : 1.08))))
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [canvas])

      function zoomBy(factor) {
        setZoom((previous) => Math.max(0.35, Math.min(3, previous * factor)))
      }

      // Something on screen is animated: something has to keep asking for a new
      // picture.  The draw effect stops when its key is unchanged, so a timer
      // tick is what re-runs it, and the frame number is in that key.
      //
      // The timer exists ONLY while an animated texture is in view.  A still
      // scene must not hold a 20-a-second timer open forever.
      // The big item icon is a third thing that can move: `item/clock` is 64
      // model swaps and a mod's item sprite can be a texture strip.  A still
      // icon has nothing to redraw, so it must not hold the timer open either.
      function projectNamespaceOf(id) {
        const projects = index === null ? [] : (index.projects || [])
        const found = projects.filter((entry) => entry.id === id)[0]
        return found === undefined ? '' : found.namespace
      }

      // What the hotbar is showing: the same filtered list the browser shows
      // (same search, same 展示形式/细分 chips), nine slots at a time -- the game's
      // number.  `hudOn` is whichever asset is on screen, so it gets the game's
      // selected-slot frame, and the bar follows it to another page if it has to.
      const hudView = () => {
        const list = itemFiltered()
        const pages = Math.max(1, Math.ceil(list.length / HUD_SLOTS))
        const page = Math.min(Math.max(1, hudPage), pages)
        return { list: list.slice((page - 1) * HUD_SLOTS, page * HUD_SLOTS),
          page: page, pages: pages, total: list.length }
      }
      const hudOn = previewItem !== null ? previewItem.id
        : (choice !== null && choice.kind === 'block' ? choice.id : '')
      const hudPickedEntry = hudOn === '' ? undefined
        : itemFiltered().filter((entry) => entry.id === hudOn)[0]
      const hudPicked = previewItem !== null
        ? (hudPickedEntry === undefined ? previewItem.id : hudPickedEntry.name)
        : (hudPickedEntry !== undefined ? hudPickedEntry.name
          : (choice === null ? '' : (choice.title || choice.id)))
      // The held slot is always on screen, like the game: if the asset on view
      // sits on another page of the bar, the bar turns to it.
      //
      // ...but ONLY when the selection or the list changes.  This effect used to
      // depend on `hudPage` too, so pressing ‹ › re-ran it, it saw the selected
      // asset living on page 1, and it set the page straight back: the arrows
      // flashed and snapped home ("我按物品栏的左右箭头没用").  Following is keyed
      // on the pair (list, selection), which paging does not change.
      const hudKey = item === null ? '' : [item.source, item.namespace, item.filter,
        item.form, item.family].join('|')
      React.useEffect(() => {
        if (hudOn === '') return
        const token = hudKey + '#' + hudOn
        if (token === hudFollowed) return
        hudFollowed = token
        const at = itemFiltered().map((entry) => entry.id).indexOf(hudOn)
        if (at < 0) return
        const page = Math.floor(at / HUD_SLOTS) + 1
        if (page !== hudView().page) setHudPage(page)
      }, [hudKey, hudOn])
      const hudAnimated = item !== null && itemFiltered().some((entry) => {
        const recipe = itemRecipes[itemKey(item.namespace, entry.id)]
        return recipe !== undefined && recipe !== null
          && (((recipe.frames || []).length > 1) || Object.keys(recipe.animations || {}).length > 0)
      })
      const animating = (scene !== null && Object.keys(scene.animations || {}).length > 0)
        || (ghost !== null && Object.keys(ghost.animations || {}).length > 0)
        || hudAnimated
      React.useEffect(() => {
        if (!animating) return undefined
        // `timer.interval` returns its own disposer; the effect hands it back
        // as the cleanup so React owns the lifetime.
        const dispose = timer.interval(() => {
          animTicks += 1
          setTick((previous) => previous + 1)
        }, 50)
        return () => { if (typeof dispose === 'function') dispose() }
      }, [animating])

      // The bar has to have something in it the moment the panel opens, the way
      // the game always has your items in the hotbar -- so the project's own items
      // are loaded without being asked for.  It is the same single host call the
      // browser makes on its first click, and it happens once: `item` stops being
      // null as soon as the request is in flight, whether it succeeds or not.
      React.useEffect(() => {
        const ours = projectNamespaceOf(activeProjectId())
        if (ours === '') return
        if (item === null) { loadItems('project', ours, 1, '', '', ''); return }
        // A different project is open now, so the bar is showing the wrong pack's
        // items.  A REFERENCE list is a deliberate choice and is left alone.
        if (item.source === 'project' && item.namespace !== ours) loadItems('project', ours, 1, '', '', '')
      }, [index === null ? '' : (index.projects || []).map((project) => project.id).join(','),
        activeProjectId(), item === null ? '' : item.source + '|' + item.namespace])

      React.useEffect(() => {
        // The item grid reads these same decoded pixels, so this has to run for
        // the picker even with no model on screen -- otherwise every slot stays
        // blank: the picture is fetched, but nothing ever reads it back out.
        if (scene === null && item === null) return
        // The ghost brings its own textures, and they need decoding before the
        // overlay can draw them.
        const needed = idsOf(scene).slice()
        // What the MODEL is waiting for.  The icon textures below go into the
        // same decode list but must never hold the model back: a mod icon whose
        // texture is missing from the jar would freeze the 3D view entirely.
        const waiting = needed.slice()
        if (ghost !== null && Array.isArray(ghost.textureIds)) {
          for (const id of idsOf(ghost)) if (needed.indexOf(id) < 0) needed.push(id)
        }
        for (const recipe of iconRecipesInUse()) {
          for (const id of idsOf(recipe)) if (needed.indexOf(id) < 0) needed.push(id)
        }
        let changed = false
        if (scratch !== null) {
          for (const id of needed) {
            if (decoded[id] !== undefined || failedTex[id] === true) continue
            const node = imageNodes[id]
            if (node === undefined || node.complete !== true) continue
            changed = true
            if (!node.naturalWidth || !node.naturalHeight) { failedTex[id] = true; continue }
            // The scratch canvas starts at 256x256, and an animated strip is
            // TALL: water_still is 16x512, lava_still 16x320.  Drawing one onto
            // a 256-tall canvas cut it off at frame 16, so the animation played
            // a few frames and then went transparent -- and reading
            // naturalHeight rows back out of it returned blank pixels rather
            // than failing, so nothing said why.
            const neededWidth = Math.max(scratch.width, node.naturalWidth)
            const neededHeight = Math.max(scratch.height, node.naturalHeight)
            if (neededWidth !== scratch.width || neededHeight !== scratch.height) {
              scratch.width = neededWidth
              scratch.height = neededHeight
            }
            const paint = scratch.getContext('2d')
            paint.clearRect(0, 0, scratch.width, scratch.height)
            paint.drawImage(node, 0, 0)
            const frame = paint.getImageData(0, 0, node.naturalWidth, node.naturalHeight)
            decoded[id] = { width: frame.width, height: frame.height, data: frame.data }
          }
        }
        if (changed) { setTick(tick + 1); return }
        // No model on screen: nothing to rasterise.  But the canvas must be
        // CLEARED, not left alone -- leaving it alone keeps the last model
        // painted there, and since rotating and zooming only re-run this effect,
        // the whole 3D view then looks frozen ("点了血晶之后 3D 卡住了" -- an
        // item-only asset like a material has no block, so there is no scene to
        // draw, and the previous cube simply stayed on the screen).
        if (scene === null) {
          if (canvas === null) return
          const emptyKey = 'empty|' + size[0] + '|' + size[1] + '|' + canvasGeneration
          if (emptyKey === lastDrawKey) return
          lastDrawKey = emptyKey
          clearViewport(canvas, size[0], size[1])
          return
        }
        if (canvas === null) return
        for (const id of waiting) {
          if (decoded[id] === undefined && failedTex[id] !== true) return
        }
        const ghostKey = ghost === null ? '-' : (ghost.block + '@' + ghost.at.join(',') + ':' + ghost.quads.length)
        const hoverKey = voxel === null || hover === null ? '-' : (hover.cell + ':' + hover.face)
        // An animated texture has to be redrawn as time passes, so which frame
        // each one is on is part of "has the picture changed".  Keying on a
        // clock instead would redraw at the timer's rate even when the fastest
        // animation is five ticks long.
        const animations = Object.assign({}, scene.animations || {},
          ghost === null || ghost.animations === undefined ? {} : ghost.animations)
        const animTime = animTicks * 50
        const animKey = Object.keys(animations).sort()
          .map((id) => id + ':' + animationRow(animations[id], animTime)).join(',')
        const key = [scene.kind, scene.id, scene.quads.length, size[0], size[1], canvasGeneration,
          yaw.toFixed(4), pitch.toFixed(4), zoom.toFixed(4), ghostKey, hoverKey, animKey].join('|')
        if (key === lastDrawKey) return
        lastDrawKey = key
        const box = scene.box || { min: [-1, -1, -1], max: [1, 1, 1] }
        const camera = orbitCamera(box, yaw, pitch, zoom, size[0], size[1], Math.PI / 4)
        lastCamera = camera
        const buffer = new Int32Array(size[0] * size[1])
        buffer.fill(-1)
        const colourBuf = new Float64Array(size[0] * size[1] * 4)
        const depthBuf = new Float64Array(size[0] * size[1])
        const pass = { width: size[0], height: size[1], background: [26, 24, 28], camera: camera,
          colour: colourBuf, depth: depthBuf, textures: decoded, animations: animations, timeMs: animTime }
        const bytes = renderScene(Object.assign({ quads: scene.quads, pick: buffer }, pass))
        pickBuffer = buffer
        if (voxel !== null && hover !== null) {
          // Highlight what a left click would break, then show what a right
          // click would place.  Both go through the same depth buffer, so they
          // stay behind whatever is in front of them.
          const marked = scene.quads.filter((quad) => quad.pick !== undefined && quad.pick !== null
            && quad.pick.cell === hover.cell)
          if (marked.length > 0) {
            renderScene(Object.assign({ quads: marked, overlay: 0.45, tint: TINT_REMOVE }, pass))
          }
          const ghostQuads = ghost === null || !Array.isArray(ghost.quads) ? [] : ghost.quads
          const usable = ghostQuads.some((quad) => decoded[quad.tex] !== undefined)
          if (usable) {
            renderScene(Object.assign({ quads: ghostQuads, overlay: 0.5, tint: null }, pass))
          }
        }
        for (let i = 0; i < bytes.length; i++) {
          const value = Math.round(colourBuf[i] * 255)
          bytes[i] = value < 0 ? 0 : (value > 255 ? 255 : value)
        }
        canvas.width = size[0]
        canvas.height = size[1]
        const paint = canvas.getContext('2d')
        const frame = paint.createImageData(size[0], size[1])
        frame.data.set(bytes)
        paint.putImageData(frame, 0, 0)
      })

      /** The icon recipes whose textures have to be decoded right now: the hotbar's
       *  nine and the browser's forty.  Without this the pictures are fetched but
       *  nothing ever reads the pixels back out, and every slot stays blank. */
      function iconRecipesInUse() {
        const out = []
        if (item === null) return out
        const seen = {}
        const add = (entry) => {
          const key = itemKey(item.namespace, entry.id)
          if (seen[key] === true) return
          const recipe = itemRecipes[key]
          if (recipe === undefined || recipe === null) return
          seen[key] = true
          out.push(recipe)
        }
        for (const entry of hudView().list) add(entry)
        for (const entry of itemView().list) add(entry)
        return out
      }

      // One host call per page, because a single item spends almost all of its
      // time opening every jar -- forty separate processes would make the picker
      // unusable, and a page is where the icons are visible anyway.
      React.useEffect(() => {
        if (item === null || item.facts.length === 0) return
        ensureItemPage()
      }, [item === null ? '' : [item.namespace, item.page, hudPage, item.filter, item.form,
        item.family, item.facts.length].join('|'), texEpoch])

      // The grid's thumbnails.  A recipe arrives before its pixels do, so a slot
      // whose textures are still decoding waits for the next tick instead of
      // being baked once as an empty square and cached forever.
      React.useEffect(() => {
        if (item === null) return
        let added = 0
        for (const entry of itemView().list) {
          const key = itemKey(item.namespace, entry.id)
          if (itemUrls[key] !== undefined) continue
          const recipe = itemRecipes[key]
          if (recipe === undefined || recipe === null || recipe.shape === 'none') continue
          let ready = true
          for (const id of idsOf(recipe)) {
            if (decoded[id] === undefined && failedTex[id] !== true) { ready = false; break }
          }
          if (!ready) continue
          const url = itemIconUrl(recipe, decoded, 32)
          if (url === null) continue
          itemUrls[key] = url
          added += 1
        }
        if (added > 0) setIconTick(iconTick + 1)
      })

      // The hotbar's slots are canvases, not background images: the recipe for
      // the page is already here, and an animated icon has to follow the same
      // 50 ms clock the model does, so this runs every render like the model's.
      React.useEffect(() => {
        if (item === null) return
        for (const entry of hudView().list) {
          const key = itemKey(item.namespace, entry.id)
          const canvas = hudCanvases[key]
          if (canvas === undefined || canvas === null) continue
          const recipe = itemRecipes[key]
          const frames = recipe === undefined || recipe === null ? 0 : (recipe.frames || []).length
          const frame = frames > 1 ? Math.floor(animTicks / 2) % frames : 0
          drawItemIcon(canvas, recipe, frame, decoded)
        }
      })

      /** One slot's title, and the one line the bar shows when the icon on screen
       *  is not the icon the game would draw.  A model that resolves to geometry
       *  with no `display.gui` is drawn flat-on and split down the middle in the
       *  game too -- the fix is in the pack, so say where. */
      function slotNote(recipe) {
        if (recipe === undefined || recipe === null) return null
        // **这一格没有图标**：宿主对取不到的那一格会回一个形状完整的 `missing: true`
        // 对象（不再是 `undefined`，那样会被严格 JSON 校验拒收、整页连坐）。它**不是**
        // "代码画的物品"，也不是"整页都坏了" —— 只有这一格缺，原因就在 `error`/`reason` 里。
        if (recipe.missing === true) {
          return '这一格没有图标：' + (recipe.error || recipe.reason || '参考目录里取不到这个物品')
        }
        if (recipe.shape === 'none') {
          return '这个物品是代码画的，没有可用的图标模型'
            + (recipe.error ? ' —— ' + String(recipe.error) : '')
        }
        if (recipe.shape === 'iso' && (recipe.display === null || recipe.display === undefined)) {
          return '物品模型指向几何模型，模型链里没有 display.gui：游戏里物品栏也是这样画的。'
            + '把它改成 item/generated（layer0 指向那张贴图）就有正常的平面图标了'
        }
        const absent = (recipe.missingModels || []).filter((name) => String(name).indexOf('内置:') !== 0)
        if (absent.length > 0) return '模型链缺 ' + absent.join('、')
        return null
      }

      /** The facts that do not need a picture, for a slot's tooltip. */
      function slotFacts(recipe) {
        if (recipe === undefined || recipe === null) return '还没取到这个物品的图标'
        // 缺的那一格：把原因放在**最前面**，悬停就能看到（不是空方块、也不是整页的错）。
        if (recipe.missing === true) {
          return '缺：' + (recipe.error || recipe.reason || '参考目录里取不到这个物品')
        }
        const parts = [recipe.shape === 'iso' ? '等距' : '平铺']
        if (recipe.display !== null && recipe.display !== undefined) {
          parts.push('display.gui ' + JSON.stringify(recipe.display.rotation))
        }
        const absent = []
        const builtin = []
        for (const name of (recipe.missingModels || [])) {
          if (String(name).indexOf('内置:') === 0) builtin.push(String(name).slice(3))
          else absent.push(String(name))
        }
        if (absent.length > 0) parts.push('模型链缺 ' + absent.join('、'))
        // Saying so matters: a built-in base is not the game's own file, and the
        // fix (set a reference directory) is one click away in ⚙.
        if (builtin.length > 0) {
          parts.push('原版母模型用了内置的 ' + builtin.join('、') + '（设了参考目录就从游戏里读）')
        }
        return parts.join(' · ')
      }

      function blockChoices() {
        const out = []
        const seen = {}
        const add = (name, title) => {
          if (typeof name !== 'string' || name === '' || seen[name] === true) return
          seen[name] = true
          out.push({ name: name, title: title || name })
        }
        // Every project under the same root, not just the open one.  The
        // renderer could already resolve one project's blocks from another's -- only this
        // list refused to offer them, which read as the two being isolated.
        const projects = index === null ? [] : (index.projects || [])
        const current = activeProjectId()
        const currentProject = projects.filter((item) => item.id === current)[0]
        const fallback = currentProject === undefined ? '' : currentProject.namespace
        const titleOf = {}
        for (const project of projects) {
          const named = project.id === current
          for (const item of ((project.items && project.items.block) || [])) {
            const qualified = project.namespace + ':' + item.id
            titleOf[qualified] = named ? item.title : (project.title + ' · ' + item.title)
            add(qualified, titleOf[qualified])
          }
        }
        // A cell may name a block without a namespace -- a project's atlas does
        // -- and the id then has no Chinese name, so the hotbar showed a bare
        // `blood_sac`.  Qualify it against the open project, exactly like the
        // cell renderer does, then look the name up again.
        for (const cell of (scene !== null && Array.isArray(scene.cells) ? scene.cells : [])) {
          const raw = String(cell.block)
          const qualified = raw.indexOf(':') >= 0 || fallback === '' ? raw : (fallback + ':' + raw)
          add(qualified, titleOf[qualified] || qualified)
        }
        return out
      }

      function openVoxel() {
        if (scene === null || !Array.isArray(scene.cells)) {
          setEditMsg('这个资产没有可编辑的格子')
          return
        }
        const choices = blockChoices()
        loadRefSources()
        resetPick()
        painting.active = false
        setHover(null)
        setGhost(null)
        setEdit(null)
        setFilter('')
        setVoxel({
          kind: scene.kind, id: scene.id, title: scene.title || scene.id,
          // The 朝向 each cell was placed in has to survive being opened and
          // saved again; dropping it here would silently straighten every log
          // in the structure the first time somebody touched it.
          cells: scene.cells.map((cell) => {
            const kept = { block: cell.block, at: [cell.at[0], cell.at[1], cell.at[2]] }
            if (typeof cell.variant === 'string' && cell.variant !== '') kept.variant = cell.variant
            return kept
          }),
          block: choices.length > 0 ? choices[0].name : '', choices: choices,
          source: 'project', variants: [], axes: [], defaults: {}, flip: false, overrides: {}, manual: false,
          undo: [], busy: false, msg: null,
        })
      }

      // Which namespaces the reference can offer (vanilla, plus every mod).  The
      // block list itself is only fetched when one is actually chosen: AoA3 alone
      // is 1400 blocks, and nobody wants that loaded to look at a wood log.
      function loadRefSources() {
        setRefSources([])
        host.call('atlas.refNamespaces', { root: root, project: activeProjectId() })
          .then((result) => {
            if (result === null || result === undefined || result.error !== undefined) return
            setRefSources(result.namespaces || [])
          }).catch(() => { /* decoration: an empty picker is not fatal */ })
      }

      // ---- the item picker -------------------------------------------------
      //
      // Items live in the REFERENCE (vanilla and the mods), not in the project's
      // atlas, so this is its own little browser: pick a namespace, then filter
      // by PRESENTATION FORM (方块/工具/盔甲/刷怪蛋/物品) and by id family.
      // A page's icons are fetched in ONE host call -- one extractor process --
      // because a single item spends almost all of its time opening every jar.
      function itemKey(namespace, id) { return namespace + ':' + id }

      // `source` is 'project' (our own pack, plus the game root so its models can
      // reach the vanilla parents they inherit) or 'reference' (the game/mods).
      function loadItems(source, namespace, page, filter, form, family) {
        setItem({ source: source, namespace: namespace, facts: [],
          page: page === undefined ? 1 : page,
          filter: filter === undefined ? '' : filter, form: form === undefined ? '' : form,
          family: family === undefined ? '' : family, busy: true, msg: null,
          choices: item === null || item.choices === undefined ? [] : item.choices })
        host.call('atlas.refItems', { root: root, project: activeProjectId(),
          source: source, namespace: namespace })
          .then((result) => {
            const failed = failureOf(result)
            if (failed !== null) {
              setItem((previous) => Object.assign({}, previous, { busy: false,
                msg: '取不到物品：' + failed }))
              return
            }
            const facts = (result.items || []).filter((entry) => entry.parentOnly !== true)
            setItem((previous) => Object.assign({}, previous, { busy: false, facts: facts,
              version: result.version,
              msg: facts.length + ' 个物品' + (result.version === undefined ? '' : ' · ' + result.version) }))
          }).catch((error) => {
            setItem((previous) => Object.assign({}, previous, { busy: false,
              msg: '取不到物品：' + String(error && error.message ? error.message : error) }))
          })
      }

      function openItems() {
        if (itemOpen) { setItemOpen(false); return }
        setItemOpen(true)
        loadRefSources()
        setIconPick(null)
        // The bar already loaded the list, so this is only for the first click on
        // a project with no items, or after a failed attempt.
        const ours = projectNamespaceOf(activeProjectId())
        const stale = item === null || item.facts.length === 0
          || (item.source === 'project' && ours !== '' && item.namespace !== ours)
        if (!stale) return
        if (ours !== '') { loadItems('project', ours, 1, '', '', ''); return }
        const namespace = refSources.length > 0 ? refSources[0].name : 'minecraft'
        loadItems('reference', namespace, 1, '', '', '')
      }

      /** The search needle.  One place, because the chips and the list have to
       *  agree about when a search is on: a chip row whose numbers do not match
       *  what clicking it shows is worse than no chip row. */
      function itemSearch() {
        return item === null ? '' : String(item.filter).trim().toLowerCase()
      }

      /** The filtered list, unpaged.  The browser's 40-slot page and the hotbar's
       *  nine-slot page slice THIS, so a search or a chip narrows both at once
       *  instead of the two rows disagreeing about what is on screen. */
      function itemFiltered() {
        if (item === null) return []
        const needle = itemSearch()
        if (needle !== '') return item.facts.filter((entry) => String(entry.name).toLowerCase().indexOf(needle) >= 0
          || String(entry.id).toLowerCase().indexOf(needle) >= 0)
        return item.facts.filter((entry) => (item.form === '' || entry.form === item.form)
          && (item.family === '' || entry.family === item.family))
      }

      function itemView() {
        const list = itemFiltered()
        const total = list.length
        const pages = Math.max(1, Math.ceil(total / ITEM_PAGE))
        const page = Math.min(Math.max(1, item.page), pages)
        return { list: list.slice((page - 1) * ITEM_PAGE, page * ITEM_PAGE), page: page, pages: pages, total: total }
      }

      function ensureItemPage() {
        if (item === null) return
        const missing = []
        const want = (list) => {
          for (const entry of list) {
            const key = itemKey(item.namespace, entry.id)
            if (itemRecipes[key] === undefined && missing.indexOf(entry.id) < 0) missing.push(entry.id)
          }
        }
        // Both pages in ONE host call: the hotbar's nine are usually a subset of
        // the browser's forty, and a second process for the remainder would cost
        // another full jar scan for nothing.
        want(itemView().list)
        want(hudView().list)
        if (missing.length === 0) return
        host.call('atlas.itemIcons', { root: root, project: activeProjectId(),
          source: item.source, namespace: item.namespace, items: missing }).then((result) => {
          const failed = failureOf(result)
          if (failed !== null) {
            itemFetchError = '取不到物品图标：' + failed
            setIconTick(iconTick + 1)
            return
          }
          itemFetchError = ''
          let added = 0
          for (const id of Object.keys(result.items || {})) {
            const recipe = result.items[id]
            const key = itemKey(item.namespace, id)
            if (itemRecipes[key] !== undefined) continue
            // 一个 `undefined` 值会被当成"没取到"→ 这个 key 永远留在 `missing` 里，
            // 每次 iconTick 都再问一遍宿主（整页连坐的渲染侧那一半）。空值直接跳过，
            // 让宿主回的那个 `missing: true` 的对象进账（它才是"问过了，缺"）。
            if (recipe === undefined || recipe === null) continue
            itemRecipes[key] = recipe
            added += 1
          }
          if (added > 0) setIconTick(iconTick + 1)
        }).catch((error) => {
          itemFetchError = '取不到物品图标：' + String(error && error.message ? error.message : error)
          setIconTick(iconTick + 1)
        })
      }

      // Clicking a slot shows it: our own block goes through `open()` like any
      // other asset (so the 3D view and the inventory form both switch to it),
      // a reference block goes through the preview handler (it is not in this
      // project's index, so there is nothing to `open`).
      /** Does this project have a BLOCK by that id?  An item-only model (a
       *  sprite with no blockstate) has no 3D form and no scene to open. */
      function projectHasBlock(id) {
        const project = index === null ? null
          : (index.projects || []).filter((entry) => entry.id === activeProjectId())[0]
        if (project === null || project === undefined) return false
        return ((project.items && project.items.block) || []).some((entry) => entry.id === id)
      }

      function pickItem(entry) {
        const namespace = item === null ? '' : item.namespace
        setIconPick({ namespace: namespace, id: entry.id })
        if (item !== null && item.source === 'project') {
          if (!projectHasBlock(entry.id)) {
            // Only an icon: say so instead of opening a scene that cannot exist.
            // The editor's own state has to come down with the scene, exactly as
            // `open()` does it -- a voxel editor left pointing at a scene that is
            // no longer on screen is a card whose buttons act on nothing.
            setPreviewItem({ source: 'project', namespace: namespace, id: entry.id, localOnly: true })
            setScene(null)
            setVoxel(null)
            setHover(null)
            setGhost(null)
            setEdit(null)
            setFailure(null)
            return
          }
          setPreviewItem(null)
          open({ project: activeProjectId(), kind: 'block', id: entry.id }, root)
          return
        }
        openReferenceItem(entry)
      }

      /**
       * 选中的东西**不是方块**时，把上一个资产的 3D 从屏幕上撤掉。
       *
       * 用户实测："点那个没有方块模型的物品（胡萝卜、剑）的时候居然预览看不到"。
       * 真机上 `atlas.preview({block:'minecraft:carrot'})` 回的是
       * `{error:'找不到 minecraft:carrot 的模型（参考目录里没有这个方块：minecraft:carrot）'}`
       * —— 对平面物品来说这**是对的**（它本来就不是方块）。错的是客户端：它只在小卡片里
       * 写了一行"3D 取不到"，**没动 scene**，于是屏幕上是**上一个资产**的 3D；
       * 而 2D 回退（poster）的条件是 `scene === null`，所以那个物品自己的图标也不会画。
       * 把场景清干净，下面那条"没 3D 就放 2D"的路才有机会接管。
       */
      function forgetSceneBecauseItem() {
        painting.active = false
        setScene(null)
        setVoxel(null)
        setHover(null)
        setGhost(null)
        setEdit(null)
        setFailure(null)
        lastDrawKey = ''
      }

      function openReferenceItem(entry) {
        const reference = (item === null ? '' : item.namespace) + ':' + entry.id
        setPreviewItem({ source: 'reference', namespace: item === null ? '' : item.namespace, id: entry.id })
        host.call('atlas.preview', { root: root, project: activeProjectId(), block: reference,
          at: [0, 0, 0], variant: null, have: Object.keys(decoded) }).then((result) => {
          const failed = failureOf(result)
          if (failed !== null) {
            // 不是方块（原版/模组里的平面物品）：方块预览失败是正常的，但屏幕不能
            // 停在**上一个**资产上 —— 撤掉 3D，让它的 2D 图标接管，并把原因说出来。
            forgetSceneBecauseItem()
            setItem((previous) => previous === null ? previous : Object.assign({}, previous,
              { msg: '3D 取不到：' + failed }))
            return
          }
          lastDrawKey = ''
          setFailure(null)
          setScene(sceneOf({ kind: 'block', id: reference, title: entry.name || entry.id,
            quads: result.quads, textureIds: idsOf(result), textures: result.textures,
            animations: result.animations, cells: null, palette: [], errors: [],
            box: boxOfQuads(arrayOf(result.quads)), preview: true }))
          setVoxel(null)
          setHover(null)
          setGhost(null)
        }).catch((error) => {
          forgetSceneBecauseItem()
          setItem((previous) => previous === null ? previous : Object.assign({}, previous,
            { msg: '3D 取不到：' + String(error && error.message ? error.message : error) }))
        })
      }

      function pickSource(source) {
        if (voxel === null) return
        if (source === 'project') {
          const choices = blockChoices()
          setFilter('')
          resetPick()
          setVoxel(Object.assign({}, voxel, { source: 'project', choices: choices,
            block: choices.length > 0 ? choices[0].name : '' }))
          setGhost(null)
          return
        }
        const namespace = source.slice(4)
        setVoxel(Object.assign({}, voxel, { source: source, msg: '正在读取 ' + namespace + ' 的方块…' }))
        host.call('atlas.refBlocks', { root: root, project: activeProjectId(), namespace: namespace })
          .then((result) => {
            if (result === null || result === undefined || result.error !== undefined) {
              setVoxel(Object.assign({}, voxel, { msg: '取不到 ' + namespace + ' 的方块：'
                + String(result && result.error ? result.error : '没有返回结果') }))
              return
            }
            const choices = (result.blocks || []).map((item) => ({ name: namespace + ':' + item.id,
              title: item.name, group: item.group || '', groupLabel: item.groupLabel || '',
              family: item.family || '' }))
            if (choices.length === 0) {
              setVoxel(Object.assign({}, voxel, { msg: namespace + ' 里没有方块' }))
              return
            }
            setFilter('')
            resetPick()
            setVoxel(Object.assign({}, voxel, { source: source, choices: choices,
              block: choices[0].name, msg: '参考 ' + namespace + ' · ' + choices.length + ' 个方块' }))
            setGhost(null)
          }).catch((error) => {
            setVoxel(Object.assign({}, voxel, { msg: '取不到方块：' + String(error && error.message ? error.message : error) }))
          })
      }

      function searchMatch(item, needle) {
        return String(item.title).toLowerCase().indexOf(needle) >= 0
          || String(item.name).toLowerCase().indexOf(needle) >= 0
      }

      function groupOfItem(item) { return item.group || '' }
      function familyOfItem(item) { return item.family || '其他' }

      /** The category tallies, counted over whatever the other filter allows,
       *  so a number on a button is never bigger than what clicking it shows. */
      function countsBy(keyOf, within) {
        const counts = {}
        for (const item of (voxel === null ? [] : voxel.choices)) {
          if (within !== null && within(item) !== true) continue
          const value = keyOf(item) || ''
          counts[value] = (counts[value] || 0) + 1
        }
        return counts
      }

      /** Which page of which category is on screen. */
      function choiceView() {
        if (voxel === null) return { list: [], page: 1, pages: 1, total: 0 }
        const needle = String(filter).trim().toLowerCase()
        let list = voxel.choices
        if (needle !== '') {
          list = list.filter((item) => searchMatch(item, needle))
        } else if (pickGroup !== '' || pickFamily !== '') {
          list = list.filter((item) =>
            (pickGroup === '' || groupOfItem(item) === pickGroup)
            && (pickFamily === '' || familyOfItem(item) === pickFamily))
        }
        const total = list.length
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        const shownPage = Math.min(Math.max(1, pickPage), pages)
        return { list: list.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE),
          page: shownPage, pages: pages, total: total }
      }

      function resetPick() {
        setPickGroup('')
        setPickFamily('')
        setPickPage(1)
      }

      // Forget extracted blocks nothing holds any more -- the "delete the block,
      // drop the cache" half of the rule.
      function releaseRefs() {
        const keep = []
        for (const cell of (voxel === null ? [] : voxel.cells)) {
          const raw = String(cell.block)
          const colon = raw.indexOf(':')
          let qualified = null
          if (colon >= 0) qualified = raw
          else if (voxel !== null && voxel.source !== 'project') qualified = voxel.source.slice(4) + ':' + raw
          if (qualified === null) continue
          keep.push(qualified)
          // The host keys an extraction by `block@variant`, so a cell that was
          // placed with an orientation needs BOTH spellings kept.  Only the bare
          // name was ever sent, so every edit dropped and re-extracted those
          // blocks -- and their textures and animation descriptions with them.
          if (typeof cell.variant === 'string' && cell.variant !== '') {
            keep.push(qualified + '@' + cell.variant)
          }
        }
        if (voxel !== null && voxel.source !== 'project' && voxel.block !== '') {
          keep.push(voxel.block)
          // The ghost on screen was extracted under `block@variant` and that is
          // the key the host caches it under.  Only the bare name was sent, so
          // every hover and every edit dropped the extraction behind the picture
          // the user was looking at.
          if (ghost !== null && ghost.block === voxel.block
            && typeof ghost.variant === 'string' && ghost.variant !== '') {
            keep.push(voxel.block + '@' + ghost.variant)
          }
        }
        host.call('atlas.releaseRefs', { keep: keep }).catch(() => { /* cache only */ })
      }

      function voxelWith(cells, x, y, z, block, variant) {
        const out = cells.filter((cell) => !(cell.at[0] === x && cell.at[1] === y && cell.at[2] === z))
        if (block !== null && block !== '') {
          const cell = { block: block, at: [x, y, z] }
          // The 朝向 is part of what was placed, not a view setting: a log lying
          // along X and one standing upright are different blocks in the wall.
          // It was decided by the face that was clicked, and it is written down
          // so reopening the structure cannot straighten it.
          if (typeof variant === 'string' && variant !== '') cell.variant = variant
          out.push(cell)
        }
        return out
      }

      /** What is under the pointer: which cell, which face.  The pick buffer
       *  has already decided what is visible there, so this costs nothing. */
      function voxelTargetAt(event) {
        if (voxel === null || scene === null || canvas === null || pickBuffer === null) return null
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const px = Math.floor((event.clientX - rect.left) / rect.width * canvas.width)
        const py = Math.floor((event.clientY - rect.top) / rect.height * canvas.height)
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null
        const quadIndex = pickBuffer[py * canvas.width + px]
        if (quadIndex === undefined || quadIndex < 0) return null
        const quad = scene.quads[quadIndex]
        const pick = quad === undefined ? undefined : quad.pick
        if (pick === undefined || pick === null) return null
        const cell = (scene.cells || [])[pick.cell]
        if (cell === undefined) return null
        // How far up the face the pointer landed.  A slab's or a staircase's
        // top/bottom half is decided from exactly this in vanilla, and it is not
        // something to ask the user.
        const hitY = faceHitY(quad, px + 0.5, py + 0.5, lastCamera)
        return { cell: pick.cell, face: pick.face, at: cell.at, block: cell.block, hitY: hitY }
      }

      /** Where a placement would land: one step out along the face, unless that
       *  cell is already taken. */
      function placementAt(target) {
        if (target === null) return null
        const step = (scene === null ? {} : (scene.faceStep || {}))[target.face]
        if (step === undefined) return null
        const at = [target.at[0] + step[0], target.at[1] + step[1], target.at[2] + step[2]]
        const occupied = (voxel === null ? [] : voxel.cells).some((cell) =>
          cell.at[0] === at[0] && cell.at[1] === at[1] && cell.at[2] === at[2])
        return occupied ? null : at
      }

      // Icons for what is on screen.  Project blocks and extracted reference
      // blocks come from different halves of the host, so the source decides
      // which one is asked.  Both are decoration: a failure is not fatal.
      React.useEffect(() => {
        if (voxel === null) return
        const source = voxel.source === undefined ? 'project' : voxel.source
        const missing = []
        for (const item of choiceView().list) {
          if (icons[item.name] !== undefined || iconTried[item.name] === true) continue
          if (missing.indexOf(item.name) < 0) missing.push(item.name)
        }
        if (missing.length === 0) return
        const batch = missing.slice(0, ICON_BATCH)
        for (const name of batch) iconTried[name] = true
        let request
        if (source === 'project') {
          request = host.call('atlas.icons', { root: root, project: activeProjectId(), blocks: batch })
        } else {
          const namespace = String(source).slice(4)
          const ids = batch.filter((name) => name.indexOf(namespace + ':') === 0)
            .map((name) => name.slice(namespace.length + 1))
          if (ids.length === 0) return
          request = host.call('atlas.refIcons', { root: root, project: activeProjectId(),
            namespace: namespace, blocks: ids })
        }
        request.then((result) => {
          // 这一批是先记"问过了"再发请求的（不记的话每次渲染都会重发）。代价是
          // 请求本身失败时这几个名字会**永久**留在账上，下一轮渲染直接跳过 ——
          // 一次抖动 = 图标再也不出现，只有刷新/换项目才解得开。所以失败就把名字
          // 退回来，下一次 iconTick 重问。
          if (result === null || result === undefined || result.error !== undefined) {
            for (const name of batch) delete iconTried[name]
            return
          }
          let added = 0
          for (const key of Object.keys(result.icons || {})) {
            const icon = result.icons[key]
            // 批里夹一个空值不许变成"这一个图标永缓存不上"：`icons[key] = undefined` 会让
            // 每个渲染都判定"没取到"、无限重问宿主（一个坏值放大成整页的连锁请求）。
            if (icon === undefined || icon === null) continue
            icons[key] = icon
            added += 1
          }
          // 宿主明确说"这个取不到"的名字：记进 `iconTried`，别每轮再问一遍。
          for (const name of arrayOf(result.failed)) iconTried[name] = true
          if (added > 0) setIconTick(iconTick + 1)
        }).catch(() => {
          // an icon is decoration -- but a thrown call must not blacklist the names
          for (const name of batch) delete iconTried[name]
        })
      // The asset identity is part of the key: opening a DIFFERENT asset keeps
      // source/filter/page unchanged, so without this the effect never re-ran and
      // the new asset's blocks never got icons -- blank hotbar slots.
      }, [voxel === null ? '' : (voxel.source + '|' + voxel.kind + ':' + voxel.id + '|' + voxel.choices.length),
        filter, pickGroup, pickFamily, pickPage, iconTick, texEpoch])

      React.useEffect(() => {
        if (voxel === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        const target = hover === null ? null : placementAt(hover)
        if (target === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        // The orientation is derived HERE, from the face being hovered -- so the
        // ghost is what the click will actually place, not a preview of some
        // other setting.
        const face = hover === null || hover.face === undefined ? 'north' : hover.face
        const hitY = hover === null || hover.hitY === undefined ? 0.5 : hover.hitY
        const wantVariant = variantFor(voxel.axes, voxel.variants, voxel.defaults, face, hitY,
          voxel.flip === true, voxel.overrides)
        // What is around the hovered cell.  A wall dropped next to three existing
        // walls has to show the shape it will actually have, and the host cannot
        // know the structure -- only this side has `cells`.
        const around = aroundOf(voxel.cells, target)
        const wantKey = voxel.block + '|' + String(wantVariant) + '|' + target.join(',')
          + '|' + JSON.stringify(around)
        // Already showing this exact ghost (or already waiting for it)?  Then do
        // NOT ask again -- including after a failure, or a block with no model
        // would be re-requested on every render.
        if (ghost !== null && ghostAsk === wantKey) return
        ghostAsk = wantKey
        setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
          textureIds: [], loading: true })
        host.call('atlas.preview', {
          root: root, project: activeProjectId(), block: voxel.block, at: target,
          variant: wantVariant, have: Object.keys(decoded), around: around,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
              textureIds: [], error: String(result && result.error ? result.error : '没有返回结果') })
            return
          }
          setGhost(ghostOf(result, { block: voxel.block, at: target, variant: wantVariant }))
        }).catch((error) => {
          setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
            textureIds: [], error: String(error && error.message ? error.message : error) })
        })
      })

      // Which 朝向 a block offers is only knowable by extracting it, so ask for
      // the block at the origin whenever the brush changes.  The extraction is
      // cached in the host either way, so this doubles as warming the cache the
      // ghost is about to use.
      const variantKey = voxel === null ? '' : (voxel.source + '|' + voxel.block)
      React.useEffect(() => {
        if (voxel === null || voxel.block === '') return undefined
        let live = true
        host.call('atlas.preview', {
          root: root, project: activeProjectId(), block: voxel.block, at: [0, 0, 0],
          variant: null, have: Object.keys(decoded),
        }).then((result) => {
          if (!live) return
          const keys = result === null || result === undefined || !Array.isArray(result.variants)
            ? [] : result.variants
          const axes = result === null || result === undefined || !Array.isArray(result.axes)
            ? [] : result.axes
          const defaults = result === null || result === undefined || typeof result.defaults !== 'object'
            || result.defaults === null ? {} : result.defaults
          setVoxel((previous) => {
            if (previous === null || previous.block !== voxel.block) return previous
            if ((previous.variants || []).join(',') === keys.join(',')
              && JSON.stringify(previous.axes || []) === JSON.stringify(axes)) return previous
            // A different block must not inherit the previous block's 朝向: the
            // key it named does not exist on the new one.
            return Object.assign({}, previous,
              { variants: keys, axes: axes, defaults: defaults, flip: false, overrides: {}, manual: false })
          })
        }).catch(() => { /* the list is a convenience, not a requirement */ })
        return () => { live = false }
      }, [variantKey])

      function refreshVoxel(state) {
        host.call('atlas.scene', {
          root: root, project: activeProjectId(), kind: state.kind, id: state.id,
          cells: state.cells, have: Object.keys(decoded),
          neighbours: state.neighbours !== false,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setVoxel(Object.assign({}, state, { busy: false,
              msg: '预览失败：' + String(result && result.error ? result.error : '没有返回结果') }))
            return
          }
          setVoxel(Object.assign({}, state, { busy: false }))
          // The draw guard keys on quad count, and swapping one block for
          // another keeps the count the same -- so it is invalidated by hand.
          lastDrawKey = ''
          setScene(sceneOf(result))
          releaseRefs()
        }).catch((error) => {
          setVoxel(Object.assign({}, state, { busy: false, msg: '预览失败：' + String(error && error.message ? error.message : error) }))
        })
      }

      function voxelApply(cells, note) {
        if (voxel === null) return
        const next = Object.assign({}, voxel, {
          cells: cells, busy: true, msg: note,
          undo: voxel.undo.concat([voxel.cells]).slice(-16),
        })
        setVoxel(next)
        refreshVoxel(next)
      }

      function voxelUndo() {
        if (voxel === null || voxel.undo.length === 0) return
        const next = Object.assign({}, voxel, {
          cells: voxel.undo[voxel.undo.length - 1],
          undo: voxel.undo.slice(0, voxel.undo.length - 1),
          msg: '撤销', busy: true,
        })
        setVoxel(next)
        refreshVoxel(next)
      }

      function voxelSave() {
        if (voxel === null || voxel.busy) return
        setVoxel(Object.assign({}, voxel, { busy: true, msg: '保存中…' }))
        host.call('atlas.saveVoxel', {
          root: root, project: activeProjectId(), kind: voxel.kind, id: voxel.id, cells: voxel.cells,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setVoxel(Object.assign({}, voxel, { busy: false,
              msg: '保存失败：' + String(result && result.error ? result.error : '没有返回结果') }))
            return
          }
          delete indexes[root]
          setVoxel(Object.assign({}, voxel, { busy: false,
            msg: '已保存 ' + result.cells + ' 格 -> ' + String(result.file).split('/').pop() }))
        }).catch((error) => {
          setVoxel(Object.assign({}, voxel, { busy: false, msg: '保存失败：' + String(error && error.message ? error.message : error) }))
        })
      }

      function voxelClick(event, action) {
        if (voxel === null || scene === null || canvas === null || pickBuffer === null) return
        const target = voxelTargetAt(event)
        if (target === null) {
          setVoxel(Object.assign({}, voxel, { msg: '那里是空的，点方块上' }))
          return
        }
        const pick = { cell: target.cell, face: target.face }
        const cell = (scene.cells || [])[pick.cell]
        if (cell === undefined) {
          setVoxel(Object.assign({}, voxel, { msg: '格子索引对不上了，刷新一下' }))
          return
        }
        if (action === 'remove') {
          voxelApply(voxelWith(voxel.cells, cell.at[0], cell.at[1], cell.at[2], null, null), '挖掉 ' + cell.block)
          return
        }
        const step = (scene.faceStep || {})[pick.face]
        if (step === undefined) {
          setVoxel(Object.assign({}, voxel, { msg: '认不出这个面：' + String(pick.face) }))
          return
        }
        // Derived from the face that was clicked, at the moment it is clicked --
        // the same input the ghost was built from, so what lands is what was
        // shown.
        const placed = variantFor(voxel.axes, voxel.variants, voxel.defaults, pick.face,
          target.hitY === undefined ? 0.5 : target.hitY, voxel.flip === true, voxel.overrides)
        voxelApply(voxelWith(voxel.cells, cell.at[0] + step[0], cell.at[1] + step[1], cell.at[2] + step[2],
          voxel.block, placed), '放置 ' + voxel.block)
      }

      function voxelCard() {
        if (voxel === null) return null
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '搭建'),
          React.createElement('span', { className: 'mcart-sub' }, (voxel.title || '') + ' · ' + voxel.cells.length + ' 格')))
        rows.push(React.createElement('div', { className: 'mcart-src', key: 'filter' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '搜方块名或 id（共 ' + voxel.choices.length + ' 个）',
            value: filter, onChange: (event) => { setFilter(event.target.value); setPickPage(1) },
          }),
          filter === '' ? null : React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setFilter(''); setPickPage(1) } }, '清空')))

        // 墙/栅栏/玻璃板在原版里是看邻居决定画哪几段的，这份规则是从两版的字节码里
        // 读出来的（`tools/multipart_rules.md`）。默认按邻居推导；留一个开关，因为
        // 没有开关就没法分辨"规则错了"和"我记错了"。这个开关只改画法，不动格子。
        const derivedOn = voxel.neighbours !== false
        rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'neighbours' },
          React.createElement('span', { className: 'mcart-note' }, '连接'),
          React.createElement('button', {
            className: 'mcart-btn mcart-tool', type: 'button',
            'data-on': derivedOn ? '1' : '0',
            title: '墙/栅栏/玻璃板：原版按邻居决定画哪几段。关掉就是抽取器给的那份并集（全部画上），不是"算不出来"。',
            onClick: () => {
              const next = Object.assign({}, voxel, { neighbours: voxel.neighbours === false })
              setVoxel(next)
              refreshVoxel(next)
            },
          }, derivedOn ? '按邻居推导' : '全部画上')))

        // 朝向 comes from the placement, not from a menu.
        //
        // This used to print the blockstate's variant KEYS as buttons.  That is
        // fine for a furnace (four `facing=...`) and useless for anything with
        // two properties: a command block became twelve
        // `conditional=false,facing=down` labels and a staircase became FORTY.
        // Those are not forty choices, they are three questions, and the answer
        // to most of them is already implied by where you clicked.
        const axes = Array.isArray(voxel.axes) ? voxel.axes : []
        if (axes.length > 0) {
          const face = hover === null || hover.face === undefined ? null : hover.face
          const hitY = hover === null || hover.hitY === undefined ? 0.5 : hover.hitY
          const derived = face === null ? {} : deriveVariant(axes, face, hitY, voxel.flip === true)
          const summary = []
          summary.push(React.createElement('span', { className: 'mcart-note', key: '__what' },
            face === null
              ? '朝向由你点的那个面决定——悬停到方块上试试'
              : '点 ' + labelOfValue(face) + ' 面 → ' + variantSummary(axes, derived)))
          // Only the families whose `facing` convention the data cannot settle get
          // a flip.  An axis has no front, so a log never shows this.
          if (derived.facing !== undefined) {
            summary.push(React.createElement('button', {
              key: '__flip', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': voxel.flip === true ? '1' : '0',
              title: '熔炉这类是朝着你，楼梯/活板门那类正相反——盘上没写，只能你说了算',
              onClick: () => setVoxel(Object.assign({}, voxel, { flip: voxel.flip !== true })),
            }, '翻转 180°'))
          }
          if (Object.keys(voxel.overrides || {}).length > 0) {
            summary.push(React.createElement('button', {
              key: '__reset', type: 'button', className: 'mcart-btn mcart-tool',
              onClick: () => setVoxel(Object.assign({}, voxel, { overrides: {} })),
            }, '恢复自动'))
          }
          summary.push(React.createElement('button', {
            key: '__manual', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': voxel.manual === true ? '1' : '0',
            onClick: () => setVoxel(Object.assign({}, voxel, { manual: voxel.manual !== true })),
          }, voxel.manual === true ? '收起 ▴' : '手动 ▾'))
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'orientation' },
            React.createElement('span', { className: 'mcart-note' }, '朝向'), summary))

          // One row per PROPERTY, and each row asks a question a person can
          // answer.  `conditional` is not an orientation, so it gets its own name
          // instead of being read off a composite string.
          if (voxel.manual === true) {
            for (const axis of axes) {
              const picked = (voxel.overrides || {})[axis.name]
              const chips = [React.createElement('button', {
                key: '__auto', type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': picked === undefined ? '1' : '0',
                onClick: () => setVoxel(Object.assign({}, voxel,
                  { overrides: withoutKey(voxel.overrides, axis.name) })),
              }, '自动')]
              for (const value of axis.values) {
                chips.push(React.createElement('button', {
                  key: value, type: 'button', className: 'mcart-btn mcart-tool',
                  'data-on': picked === value ? '1' : '0',
                  onClick: () => setVoxel(Object.assign({}, voxel,
                    { overrides: withKey(voxel.overrides, axis.name, value) })),
                }, labelOfValue(value)))
              }
              rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'axis:' + axis.name },
                React.createElement('span', { className: 'mcart-note' }, labelOfAxis(axis.name)), chips))
            }
            if (axes.some((axis) => axis.name === 'shape')) {
              rows.push(React.createElement('div', { className: 'mcart-hint', key: 'shapenote' },
                '形状（内角/外角）在原版里是看邻居算出来的，这里还没做——默认给你 straight，不是不敢算就说算了。'))
            }
            rows.push(React.createElement('div', { className: 'mcart-hint', key: 'oriennote' },
              '不选就是自动。摆放时按你点的面和位置推导，幽灵预览里看到的就是要放上去的。'))
          }
        }

        // Categories come from the pack itself: a mod that files its models into
        // folders (AoA3: decoration/generation/functional) has stated them, and
        // the shape suffixes (_slab, _stairs, _ore) are the game's own.
        const needle = String(filter).trim().toLowerCase()
        if (needle === '') {
          const groupCounts = countsBy(groupOfItem, null)
          const groupKeys = Object.keys(groupCounts).filter((key) => key !== '').sort()
          if (groupKeys.length > 0) {
            const chips = [React.createElement('button', {
              key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': pickGroup === '' ? '1' : '0',
              onClick: () => { setPickGroup(''); setPickFamily(''); setPickPage(1) },
            }, '全部 ' + voxel.choices.length)]
            for (const key of groupKeys) {
              const label = (voxel.choices.filter((item) => groupOfItem(item) === key)[0] || {}).groupLabel || key
              chips.push(React.createElement('button', {
                key: key, type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': pickGroup === key ? '1' : '0',
                onClick: () => { setPickGroup(key); setPickFamily(''); setPickPage(1) },
              }, label + ' ' + groupCounts[key]))
            }
            rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'groups' },
              React.createElement('span', { className: 'mcart-note' }, '分类'), chips))
          }
          const familyCounts = countsBy(familyOfItem,
            pickGroup === '' ? null : (item) => groupOfItem(item) === pickGroup)
          const familyKeys = Object.keys(familyCounts).sort()
          if (familyKeys.length > 1) {
            const chips = [React.createElement('button', {
              key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': pickFamily === '' ? '1' : '0',
              onClick: () => { setPickFamily(''); setPickPage(1) },
            }, '全部 ' + Object.keys(familyCounts).reduce((sum, key) => sum + familyCounts[key], 0))]
            for (const key of familyKeys) {
              chips.push(React.createElement('button', {
                key: key, type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': pickFamily === key ? '1' : '0',
                onClick: () => { setPickFamily(key); setPickPage(1) },
              }, key + ' ' + familyCounts[key]))
            }
            rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'families' },
              React.createElement('span', { className: 'mcart-note' }, '形状'), chips))
          }
        }

        const view = choiceView()
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'pager' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page <= 1,
            onClick: () => setPickPage(view.page - 1) }, '‹ 上一页'),
          React.createElement('span', { className: 'mcart-note' },
            '第 ' + view.page + ' / ' + view.pages + ' 页 · 共 ' + view.total + ' 个'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page >= view.pages,
            onClick: () => setPickPage(view.page + 1) }, '下一页 ›'),
          React.createElement('input', {
            className: 'mcart-input', type: 'number', min: 1, max: view.pages, value: view.page,
            style: { maxWidth: '66px' },
            onChange: (event) => setPickPage(Number(event.target.value) || 1),
          })))

        rows.push(React.createElement('div', { className: 'mcart-hotbar', key: 'hotbar' },
          view.list.map((item) => React.createElement('button', {
            key: item.name, type: 'button', className: 'mcart-slot',
            'data-on': item.name === voxel.block ? '1' : '0',
            title: item.title + '\n' + item.name,
            style: icons[item.name] === undefined ? {} : { backgroundImage: 'url(' + icons[item.name] + ')' },
            onClick: () => { setVoxel(Object.assign({}, voxel, { block: item.name })); setGhost(null) },
          }))))
        if (refSources.length > 0) {
          const options = [React.createElement('option', { key: 'project', value: 'project' }, '本项目')]
          for (const item of refSources) {
            options.push(React.createElement('option', { key: 'ref:' + item.name, value: 'ref:' + item.name },
              item.name + '（' + item.blocks + ' 个方块）'))
          }
          rows.push(React.createElement('div', { className: 'mcart-src', key: 'source' },
            React.createElement('span', { className: 'mcart-note' }, '方块来源'),
            React.createElement('select', {
              className: 'mcart-select',
              value: voxel.source === undefined ? 'project' : voxel.source,
              onChange: (event) => pickSource(event.target.value),
            }, options)))
        }
        const chosen = voxel.choices.filter((item) => item.name === voxel.block)[0]
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'chosen' },
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            '手持：' + (chosen === undefined ? voxel.block : chosen.title) + '（' + voxel.block + '）')))
        rows.push(React.createElement('div', { className: 'mcart-tools', key: 'tools' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: voxel.undo.length === 0 || voxel.busy,
            onClick: voxelUndo }, '撤销 ' + voxel.undo.length),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: voxel.busy,
            onClick: voxelSave }, voxel.busy ? '…' : '保存'),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setVoxel(null); setHover(null); setGhost(null); painting.active = false } }, '关闭')))
        rows.push(React.createElement('div', { className: 'mcart-hint', key: 'how' },
          '像原版一样：左键破坏，右键放置；拖动仍然是旋转。半透明的方块就是将要放上去的位置，红色高亮是要破坏的那一格。'))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, voxel.msg === null ? '' : withVersion(voxel.msg))))
        if (ghost !== null && ghost.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'ghosterr' }, withVersion('预览拿不到：' + String(ghost.error))))
        }
        return React.createElement('div', { className: 'mcart-card', key: 'voxel' }, rows)
      }

      /** The 2D layer of the 3D view: the game's hotbar.  Nine slots, the asset on
       *  screen wearing the game's selected-slot frame, the item's name floating
       *  above the row, and empty slots padding the last page -- all of which is
       *  what the game's HUD looks like.  `asset` is the menu choice on screen and
       *  is used for one thing only: explaining an asset that is not an item. */
      /** The 2D layer of the 3D view: the game's hotbar.  Nine slots, the asset on
       *  screen wearing the game's selected-slot frame, the item's name floating
       *  above the row, and empty slots padding the last page -- all of which is
       *  what the game's HUD looks like.
       *
       *  NOTHING ELSE GOES IN HERE.  A warning line inside the overlay is not the
       *  game and not readable (the user said so, with a screenshot: "这些提示不
       *  应该放在这里").  The details live on each slot's tooltip and, when
       *  something is actually wrong, on the line under the canvas. */
      function hudBar() {
        const view = hudView()
        const slots = []
        for (const entry of view.list) {
          const key = itemKey(item.namespace, entry.id)
          const recipe = itemRecipes[key]
          const note = slotNote(recipe)
          // 缺图标的那一格：画布上什么也画不出来，所以再给一个"缺"的角标
          // （空画布读起来像"还没加载"）。原因在 tooltip 里，只有这一格受影响。
          const lacking = recipe !== undefined && recipe !== null && recipe.missing === true
          slots.push(React.createElement('button', {
            key: key, type: 'button', className: 'mcart-hudslot',
            'data-on': hudOn === entry.id ? '1' : '0',
            'data-missing': lacking ? '1' : '0',
            title: entry.name + '（' + entry.id + '）'
              + (entry.formLabel ? '\n' + entry.formLabel : '')
              + '\n' + slotFacts(recipe) + (note === null ? '' : '\n' + note),
            onClick: () => pickItem(entry),
          }, React.createElement('canvas', {
            className: 'mcart-hudicon', width: 32, height: 32,
            ref: (node) => {
              if (node === null || node === undefined) delete hudCanvases[key]
              else hudCanvases[key] = node
            },
          }), lacking
            ? React.createElement('span', { className: 'mcart-slotq mcart-slotmissing' }, '缺')
            : null))
        }
        while (slots.length < HUD_SLOTS) {
          slots.push(React.createElement('span', { key: 'empty:' + slots.length,
            className: 'mcart-hudslot mcart-hudempty' }))
        }
        return React.createElement('div', { className: 'mcart-hud', key: 'hud' },
          hudPicked === '' ? null : React.createElement('div', { className: 'mcart-hudname' },
            hudPicked + (view.pages > 1 ? ' · ' + view.page + '/' + view.pages : '')),
          React.createElement('div', { className: 'mcart-hudbar' },
            view.pages > 1 ? React.createElement('button', { className: 'mcart-hudpage', type: 'button',
              disabled: view.page <= 1, title: '上一页物品',
              onClick: () => setHudPage(view.page - 1) }, '‹') : null,
            slots,
            view.pages > 1 ? React.createElement('button', { className: 'mcart-hudpage', type: 'button',
              disabled: view.page >= view.pages,
              title: '下一页物品（第 ' + view.page + ' / ' + view.pages + ' 页）',
              onClick: () => setHudPage(view.page + 1) }, '›') : null))
      }

      function itemCard() {
        if (item === null) return null
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '物品'),
          React.createElement('span', { className: 'mcart-sub' },
            item.source === 'project' ? '本项目' : item.namespace),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            itemFetchError === '' ? '点一格就放到上面的 3D 里看' : withVersion(itemFetchError)),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setItemOpen(false); setIconPick(null) } }, '收起')))
        // Our own pack first, because that is what this project makes.
        const options = []
        const ours = projectNamespaceOf(activeProjectId())
        if (ours !== '') {
          options.push(React.createElement('option', { key: 'project', value: 'project' },
            '本项目 ' + ours + '（' + (item.source === 'project' ? item.facts.length : '…') + '）'))
        }
        for (const entry of refSources) {
          options.push(React.createElement('option', { key: 'ref:' + entry.name, value: 'ref:' + entry.name },
            entry.name + '（' + entry.blocks + ' 个方块）'))
        }
        if (options.length === 0) {
          options.push(React.createElement('option', { key: item.namespace, value: 'ref:' + item.namespace },
            item.namespace))
        }
        rows.push(React.createElement('div', { className: 'mcart-src', key: 'source' },
          React.createElement('span', { className: 'mcart-note' }, '来源'),
          React.createElement('select', {
            className: 'mcart-select',
            value: item.source === 'project' ? 'project' : 'ref:' + item.namespace,
            onChange: (event) => {
              const value = String(event.target.value)
              setIconPick(null)
              setPreviewItem(null)
              if (value === 'project') loadItems('project', ours === '' ? 'minecraft' : ours, 1, '', '', '')
              else loadItems('reference', value.slice(4), 1, '', '', '')
            },
          }, options),
          React.createElement('input', {
            className: 'mcart-input', placeholder: '搜物品名或 id',
            value: item.filter,
            onChange: (event) => setItem(Object.assign({}, item, { filter: event.target.value, page: 1 })),
          })))

        const formCounts = countsOf(item.facts, (entry) => entry.form, (entry) => entry.formLabel || entry.form)
        const forms = Object.keys(formCounts).sort((a, b) => formCounts[b].count - formCounts[a].count)
        if (forms.length > 0 && itemSearch() === '') {
          const chips = [React.createElement('button', {
            key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': item.form === '' ? '1' : '0',
            onClick: () => setItem(Object.assign({}, item, { form: '', family: '', page: 1 })),
          }, '全部 ' + item.facts.length)]
          for (const key of forms) {
            chips.push(React.createElement('button', {
              key: key, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': item.form === key ? '1' : '0',
              onClick: () => setItem(Object.assign({}, item, { form: key, family: '', page: 1 })),
            }, formCounts[key].label + ' ' + formCounts[key].count))
          }
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'forms' },
            React.createElement('span', { className: 'mcart-note' }, '展示形式'), chips))
        }
        const within = item.form === '' ? item.facts
          : item.facts.filter((entry) => entry.form === item.form)
        const familyCounts = countsOf(within, (entry) => entry.family, (entry) => entry.family)
        const families = Object.keys(familyCounts).sort((a, b) => familyCounts[b].count - familyCounts[a].count)
        if (families.length > 1 && itemSearch() === '') {
          const chips = [React.createElement('button', {
            key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': item.family === '' ? '1' : '0',
            onClick: () => setItem(Object.assign({}, item, { family: '', page: 1 })),
          }, '全部 ' + within.length)]
          for (const key of families) {
            chips.push(React.createElement('button', {
              key: key, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': item.family === key ? '1' : '0',
              onClick: () => setItem(Object.assign({}, item, { family: key, page: 1 })),
            }, key + ' ' + familyCounts[key].count))
          }
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'families' },
            React.createElement('span', { className: 'mcart-note' }, '细分'), chips))
        }

        const view = itemView()
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'pager' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page <= 1,
            onClick: () => setItem(Object.assign({}, item, { page: view.page - 1 })) }, '‹ 上一页'),
          React.createElement('span', { className: 'mcart-note' },
            '第 ' + view.page + ' / ' + view.pages + ' 页 · 共 ' + view.total + ' 个'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page >= view.pages,
            onClick: () => setItem(Object.assign({}, item, { page: view.page + 1 })) }, '下一页 ›')))

        const slots = []
        for (const entry of view.list) {
          const key = itemKey(item.namespace, entry.id)
          const url = itemUrls[key]
          const recipe = itemRecipes[key]
          // A code-drawn item (a block entity: cake, backpack) has no sprite to
          // bake, and an empty square reads as "still loading".  Say so instead.
          const blank = recipe !== undefined && recipe !== null && recipe.shape === 'none'
          // **这一格缺图标**（宿主回的 `missing: true`）：画一个说"缺"的角标，并把原因
          // 放进 title —— 不能留白（留白读起来像"还在加载"），也不能影响别的格子。
          const lacking = recipe !== undefined && recipe !== null && recipe.missing === true
          const lackReason = lacking
            ? (recipe.error || recipe.reason || '参考目录里取不到这个物品') : ''
          slots.push(React.createElement('button', {
            key: entry.id, type: 'button', className: 'mcart-slot',
            'data-on': iconPick !== null && iconPick.id === entry.id ? '1' : '0',
            'data-missing': lacking ? '1' : '0',
            title: entry.name + '\n' + entry.id + '\n' + (entry.formLabel || entry.form || '')
              + (lacking ? '\n缺：' + lackReason
                : (blank ? '\n这个物品是代码画的，没有可用的图标模型' : '')),
            style: url === undefined || url === null ? {} : { backgroundImage: 'url(' + url + ')' },
            onClick: () => pickItem(entry),
          }, lacking
            ? React.createElement('span', { className: 'mcart-slotq mcart-slotmissing', title: lackReason }, '缺')
            : (blank ? React.createElement('span', { className: 'mcart-slotq' }, '?') : null)))
        }
        rows.push(React.createElement('div', { className: 'mcart-hotbar', key: 'slots' }, slots))

        // Clicking a slot shows it in the viewer (3D + its inventory form); this
        // line is only the name and the facts that do not need a picture.
        const picked = iconPick === null ? null
          : view.list.filter((entry) => entry.id === iconPick.id)[0]
        if (picked !== undefined && picked !== null) {
          const recipe = itemRecipes[itemKey(iconPick.namespace, iconPick.id)]
          const frames = recipe === undefined || recipe === null ? 0 : (recipe.frames || []).length
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'chosen' },
            React.createElement('span', { className: 'mcart-note mcart-grow' },
              picked.name + '（' + picked.id + '）· ' + (picked.formLabel || picked.form || '')
              + (frames > 1 ? ' · ' + frames + ' 帧（原版按 overrides 换模型）' : '')
              + (recipe !== undefined && recipe !== null && recipe.error ? ' · ' + String(recipe.error) : ''))))
        }
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, item.msg === null ? '' : withVersion(item.msg))))
        return React.createElement('div', { className: 'mcart-card', key: 'items' }, rows)
      }

      function facesForScene() {
        const out = {}
        for (const quad of (scene === null ? [] : (scene.quads || []))) {
          if (quad.pick) continue
          if (typeof quad.tex !== 'string' || typeof quad.face !== 'string') continue
          if (out[quad.tex] === undefined) out[quad.tex] = []
          if (out[quad.tex].indexOf(quad.face) < 0) out[quad.tex].push(quad.face)
        }
        return out
      }

      /** The texture covering the most faces -- the side of a grass block, not
       *  its bottom.  Opening on the bottom and saying nothing is what made an
       *  edit to 草方块 show up as 泥土. */
      function widestTexture(ids, byTexture) {
        let best = 0
        for (let i = 1; i < ids.length; i++) {
          const here = (byTexture[ids[i]] || []).length
          const there = (byTexture[ids[best]] || []).length
          if (here > there) best = i
        }
        return best
      }

      function makeEdit(ids, index, facesByTexture) {
        const frame = decoded[ids[index]]
        const copy = new Uint8ClampedArray(frame.data)
        const byTexture = facesByTexture || {}
        return {
          ids: ids, index: index, w: frame.width, h: frame.height,
          pixels: copy, palette: paletteOf(copy, 32), tool: 'pencil', color: null,
          faces: byTexture[ids[index]] || [],
          facesByTexture: byTexture,
        }
      }

      /** The asset on screen when there is no scene: a selected ITEM.  A block
       *  brings `scene`; an item-only asset (a material like blood_crystal) has no
       *  scene at all, and everything below used to start with `if (scene === null)
       *  return` -- which is why "血晶这种物体" could not be edited or commented
       *  on.  The icon IS the asset, so the icon's textures are what to edit and
       *  the item's model is what to point at. */
      function itemAsset() {
        if (scene !== null || item === null || hudOn === '') return null
        return { namespace: item.namespace, id: hudOn, source: item.source,
          recipe: pickedRecipe, title: hudPicked === '' ? hudOn : hudPicked }
      }

      function openEditor() {
        const asset = itemAsset()
        if (scene === null && asset === null) return
        if (asset !== null) {
          // The item's own layers.  No faces: a flat sprite has no sides, so the
          // editor shows its "贴图" tab, and the pen writes the project file the
          // host resolved from the texture handle.
          setVoxel(null)
          const ids = asset.recipe === null ? []
            : idsOf(asset.recipe).filter((id) => decoded[id] !== undefined)
          if (ids.length === 0) {
            setEdit(null)
            setItemMsg(asset.title + ' 还没有解码成功的贴图，改不了')
            return
          }
          setItemMsg(null)
          setEditMsg(null)
          setUndo([])
          painting.active = false
          setEdit(makeEdit(ids, widestTexture(ids, {}), {}))
          return
        }
        if (scene.kind === 'biome' || scene.kind === 'structure') { openVoxel(); return }
        if (scene.kind !== 'block' && scene.kind !== 'entity') {
          setEditMsg('这个类型还不能改：' + String(scene.kind))
          return
        }
        setVoxel(null)
        const ids = idsOf(scene).filter((id) => decoded[id] !== undefined)
        if (ids.length === 0) {
          setEdit(null)
          setEditMsg('这个资产没有解码成功的贴图，改不了')
          return
        }
        setEditMsg(null)
        setUndo([])
        painting.active = false
        const byTexture = facesForScene()
        setEdit(makeEdit(ids, widestTexture(ids, byTexture), byTexture))
      }

      function closeEditor() {
        painting.active = false
        setEdit(null)
        setUndo([])
        setEditMsg(null)
      }

      function undoOnce() {
        if (edit === null || undo.length === 0) return
        const previous = undo[undo.length - 1]
        setUndo(undo.slice(0, undo.length - 1))
        setEdit(Object.assign({}, edit, { pixels: new Uint8ClampedArray(previous) }))
      }

      function pushUndo() {
        if (edit === null || edit.pixels === undefined) return
        const next = undo.concat([new Uint8ClampedArray(edit.pixels)])
        setUndo(next.length > EDIT_UNDO ? next.slice(next.length - EDIT_UNDO) : next)
      }

      function pixelAt(event, target) {
        return texturePoint(event.currentTarget.getBoundingClientRect(), target,
          event.clientX, event.clientY)
      }

      function applyTool(x, y, first) {
        if (edit === null || edit.pixels === undefined) return
        const w = edit.w, h = edit.h, pixels = edit.pixels
        if (x < 0 || y < 0 || x >= w || y >= h) return
        if (edit.tool === 'picker') {
          const picked = readPixel(pixels, w, x, y)
          setEdit(Object.assign({}, edit, { color: picked[3] === 0 ? null : picked }))
          return
        }
        if (first === true) pushUndo()
        if (edit.tool === 'fill') {
          const from = readPixel(pixels, w, x, y)
          const to = edit.color || [0, 0, 0, 255]
          if (!sameColour(from, to)) {
            const stack = [[x, y]]
            const visited = {}
            while (stack.length > 0) {
              const point = stack.pop()
              const cx = point[0], cy = point[1]
              if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue
              const key = cy * w + cx
              if (visited[key] === true) continue
              visited[key] = true
              if (!sameColour(readPixel(pixels, w, cx, cy), from)) continue
              writePixel(pixels, w, cx, cy, to)
              stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
            }
          }
        } else if (edit.tool === 'eraser') {
          writePixel(pixels, w, x, y, [0, 0, 0, 0])
        } else {
          writePixel(pixels, w, x, y, edit.color || [0, 0, 0, 255])
        }
        setEdit(Object.assign({}, edit))
      }

      function saveEdit() {
        if (edit === null || edit.pixels === undefined || editBusy) return
        if (editScratch === null) { setEditMsg('画布还没准备好'); return }
        // **只写项目自己的包**：句柄必须是包内的相对路径。绝对路径 / `..` 一律不发出去，
        // 屏幕上说清楚是哪一条 —— 让宿主去挡"写到项目外面"是挡不住的。
        const target = edit.ids[edit.index]
        if (!safeTextureHandle(target)) {
          setEditMsg('这条贴图句柄不是项目包里的相对路径，没有写盘：' + String(target)
            + '（只写项目自己的包；要改原版/模组贴图，先在项目包里放一张同名贴图）')
          return
        }
        setEditBusy(true)
        setEditMsg(null)
        // The engine has no binary write, so the pixels leave as an encoded PNG
        // and the host lands the bytes.  The renderer reads `decoded`, so
        // publishing the edit there is what makes the 3D view show it -- with no
        // round trip and no chance of a stale data URL winning.
        editScratch.width = edit.w
        editScratch.height = edit.h
        const paint = editScratch.getContext('2d')
        const frame = paint.createImageData(edit.w, edit.h)
        frame.data.set(edit.pixels)
        paint.putImageData(frame, 0, 0)
        const url = editScratch.toDataURL('image/png')
        // **先验是 PNG 再发**。"临时文件 → 校验是 PNG → 才替换"这条规矩的客户端那一半：
        // 画布给不出 PNG 就一个字节都不发（宿主那一半负责落临时文件、校验、再替换）。
        if (String(url).indexOf('data:image/png') !== 0) {
          setEditBusy(false)
          setEditMsg('画布没有给出 PNG（拿到 ' + String(url).slice(0, 24) + '…），没有写盘')
          return
        }
        const base64 = url.slice(url.indexOf(',') + 1)
        host.call('atlas.saveTexture', {
          root: root, project: activeProjectId(), path: target, base64: base64,
        }).then((result) => {
          setEditBusy(false)
          if (result === null || result === undefined || result.error !== undefined) {
            setEditMsg('保存失败：' + String(result && result.error ? result.error : '没有返回结果'))
            return
          }
          decoded[target] = { width: edit.w, height: edit.h, data: edit.pixels }
          delete failedTex[target]
          lastDrawKey = ''
          setEdit(Object.assign({}, edit, { palette: paletteOf(edit.pixels, 32) }))
          setEditMsg('已保存 ' + target.split('/').pop() + '（' + result.bytes + ' 字节）')
          setEditTick(editTick + 1)
        }).catch((error) => {
          setEditBusy(false)
          setEditMsg('保存失败：' + String(error && error.message ? error.message : error))
        })
      }

      function editorCard() {
        if (edit === null && editMsg === null) return null
        const rows = []
        if (edit === null) {
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'lost' },
            React.createElement('span', { className: 'mcart-bad mcart-grow' }, String(editMsg)),
            React.createElement('button', { className: 'mcart-btn', type: 'button',
              onClick: () => setEditMsg(null) }, '知道了')))
          return React.createElement('div', { className: 'mcart-card', key: 'editor' }, rows)
        }
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '改贴图'),
          React.createElement('span', { className: 'mcart-sub' },
            faceLabel(edit.faces) + ' · ' + edit.w + '×' + edit.h)))
        if (edit.ids.length > 1) {
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'tabs' },
            edit.ids.map((id, index) => React.createElement('button', {
              key: id, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': index === edit.index ? '1' : '0',
              onClick: () => {
                setUndo([]); setEditMsg(null); painting.active = false
                setEdit(makeEdit(edit.ids, index, edit.facesByTexture))
              },
            }, faceLabel((edit.facesByTexture || {})[id]) + ' · ' + id.split('/').pop().replace(/\.png$/, '')))))
        }
        rows.push(React.createElement('div', { className: 'mcart-tools', key: 'tools' },
          [['pencil', '铅笔'], ['eraser', '橡皮'], ['fill', '油漆桶'], ['picker', '吸管']].map((pair) =>
            React.createElement('button', {
              key: pair[0], type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': edit.tool === pair[0] ? '1' : '0',
              onClick: () => setEdit(Object.assign({}, edit, { tool: pair[0] })),
            }, pair[1])),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: undo.length === 0,
            onClick: undoOnce }, '撤销')))
        const current = edit.color || [0, 0, 0, 255]
        const inPalette = edit.palette.some((c) => sameColour(c, current))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'current' },
          React.createElement('input', {
            type: 'color', className: 'mcart-picker', value: hexOf(current),
            title: '取色板以外随便挑',
            // Only the current colour follows the picker.  Dragging it fires
            // this on every step, and appending here used to add one swatch per
            // intermediate colour until the panel was full of them.
            onChange: (event) => setEdit(Object.assign({}, edit,
              { color: fromHex(event.target.value, current[3]) })),
          }),
          React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: inPalette,
            title: '把当前颜色加进色板',
            onClick: () => setEdit(Object.assign({}, edit,
              { palette: addToPalette(edit.palette, current, EDIT_PALETTE) })),
          }, inPalette ? '已在色板' : '＋ 色板'),
          React.createElement('input', {
            type: 'range', className: 'mcart-alpha', min: 0, max: 255, value: current[3],
            onChange: (event) => setEdit(Object.assign({}, edit,
              { color: [current[0], current[1], current[2], Number(event.target.value)] })),
          }),
          React.createElement('span', { className: 'mcart-note' }, hexOf(current)),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            '不透明度 ' + current[3] + ' · 撤销 ' + undo.length)))
        rows.push(React.createElement('div', { className: 'mcart-swatches', key: 'swatches' },
          edit.palette.map((colour) => React.createElement('button', {
            key: colour.join(','), type: 'button', className: 'mcart-swatch',
            style: { background: cssColour(colour) }, title: cssColour(colour),
            onClick: () => setEdit(Object.assign({}, edit, { color: colour })),
          }))))
        rows.push(React.createElement('canvas', {
          key: 'canvas', className: 'mcart-edit-canvas',
          ref: (node) => setEditCanvas(node),
          onPointerDown: (event) => {
            const point = pixelAt(event, edit)
            if (point === null) return
            painting.active = true
            if (event.currentTarget.setPointerCapture) {
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
            }
            applyTool(point[0], point[1], true)
          },
          onPointerMove: (event) => {
            if (!painting.active) return
            const point = pixelAt(event, edit)
            if (point !== null) applyTool(point[0], point[1], false)
          },
          onPointerUp: () => { painting.active = false },
          onPointerLeave: () => { painting.active = false },
        }))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'foot' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: editBusy,
            onClick: saveEdit }, editBusy ? '保存中…' : '保存'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: closeEditor }, '关闭'),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            (edit.ids[edit.index] || '').split('/').pop())))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, editMsg === null ? '' : withVersion(editMsg))))
        return React.createElement('div', { className: 'mcart-card', key: 'editor' }, rows)
      }

      React.useEffect(() => {
        if (edit === null || edit.pixels === undefined) return
        if (editCanvas === null || editScratch === null) return
        editScratch.width = edit.w
        editScratch.height = edit.h
        const source = editScratch.getContext('2d')
        const frame = source.createImageData(edit.w, edit.h)
        frame.data.set(edit.pixels)
        source.putImageData(frame, 0, 0)
        const zoom = Math.max(2, Math.min(EDIT_ZOOM, 320 / Math.max(edit.w, edit.h)))
        editCanvas.width = edit.w * zoom
        editCanvas.height = edit.h * zoom
        const view = editCanvas.getContext('2d')
        view.imageSmoothingEnabled = false
        view.clearRect(0, 0, editCanvas.width, editCanvas.height)
        view.drawImage(editScratch, 0, 0, editCanvas.width, editCanvas.height)
        view.strokeStyle = 'rgba(127,127,127,.30)'
        view.lineWidth = 1
        for (let x = 0; x <= edit.w; x++) {
          view.beginPath(); view.moveTo(x * zoom + 0.5, 0); view.lineTo(x * zoom + 0.5, editCanvas.height); view.stroke()
        }
        for (let y = 0; y <= edit.h; y++) {
          view.beginPath(); view.moveTo(0, y * zoom + 0.5); view.lineTo(editCanvas.width, y * zoom + 0.5); view.stroke()
        }
      })

      /**
       * 把一段引用（`@路径` + 可选的一句话）**追加**到输入框草稿末尾。
       *
       * 这是「@ 提意见」和「告诉 AI」共用的唯一入口：只写草稿、**绝不发送**
       * （0.1.26 写坏会话日志的教训：客户端没有、也不会有会话写入）。
       * 用户的原话是"@提意见 的部分…直接插入对话框就行"，所以不再挂一条
       * "引用给 AI / 插入输入框"的 bar 让人点第二次。
       *
       * 拿不到输入框把手（dock 还没挂上，冷启动少见）时返回 false —— 调用方退回
       * "挂一条 bar"的兜底：宁可退化成两步，也绝不许点了没反应。
       */
      function insertReference(path, note) {
        const target = path === undefined || path === null ? '' : String(path)
        if (target === '') return false
        const sentence = note === undefined || note === null ? '' : String(note)
        const draft = composer.draft === undefined || composer.draft === null ? '' : String(composer.draft)
        const base = draft.replace(/\s+$/, '')
        if (typeof composer.write !== 'function') return false
        const next = (base === '' ? '' : base + ' ') + '@' + target
          + (sentence === '' ? '' : ' ' + sentence) + ' '
        composer.write(next)
        // 本地也记一份：连点两次时第二下读到的是刚写进去的内容，不会把第一下盖掉。
        composer.draft = next
        return true
      }

      function complain() {
        if (scene !== null) {
          const refPath = scene.ref === undefined || scene.ref === null ? '' : String(scene.ref)
          if (refPath === '') {
            // 一句话都没有等于"点了没反应"；这类病我们在别处修过太多次。
            setItemMsg('这个资产没有可以引用的文件路径（报告里的 @ 引用不可用）')
            return
          }
          if (insertReference(refPath)) { setPending(null); return }
          setPending({ path: refPath, title: scene.title || '' })
          return
        }
        const asset = itemAsset()
        if (asset === null) return
        const path = asset.recipe === null || asset.recipe.modelPath === undefined
          ? '' : String(asset.recipe.modelPath)
        if (path === '') {
          // A reference item lives inside a jar: there is no file to point at, and
          // a button that silently does nothing is worse than one that says so.
          setItemMsg(asset.title + ' 在参考的 jar 里，没有可以引用的文件')
          return
        }
        setItemMsg(null)
        if (insertReference(path)) { setPending(null); return }
        setPending({ path: path, title: asset.title })
      }

      /**
       * 「画不出来」的报告卡（BRIEF §2.4）。三件事必须同时成立：
       *   1. 看得懂 —— 原因用中文，缺什么按 `kind` 分开写，每条带能直接照做的路径；
       *   2. 能一键复制 —— 只到剪贴板；太长就折叠，屏幕上不会出现一条几百行的东西；
       *   3. **不注入任何地方** —— 这段代码里没有任何会话 / agent 的写调用。
       */
      function diagnosticCard() {
        if (diag === null) return null
        const info = diag.diag
        const all = diagLines(info, diag.error)
        const full = diagText(info, diag.error)
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '画不出来 · 报告'),
          React.createElement('span', { className: 'mcart-sub' }, versionTag()),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => copyReport(full) }, '复制报告'),
          all.length > DIAG_SHOW ? React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => setDiagOpen(diagOpen !== true) }, diagOpen === true ? '收起' : '展开全部') : null,
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setDiag(null); setCopied('') } }, '关掉')))
        if (diag.repeat === true) {
          rows.push(React.createElement('div', { className: 'mcart-hint', key: 'repeat' },
            '同一条报告：屏幕上只留这一条，不重复刷屏。'))
        }
        const shown = diag.repeat === true ? all.slice(0, 3)
          : (diagOpen === true ? all.slice(0, DIAG_LINES) : all.slice(0, DIAG_SHOW))
        rows.push(React.createElement('pre', { className: 'mcart-report', key: 'text' }, shown.join('\n')))
        // 「出错就死在那里，AI 不知道」的修法：报告直接进输入框**草稿**，用户按回车才发。
        // 草稿里有他正在写的东西时一个字节都不动（`autoFillDraft` 的 'busy'），只留这个按钮。
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'ai' },
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => placeReport(true) }, '把报告放进输入框'),
          React.createElement('span', { className: 'mcart-note mcart-grow' }, statusText(autoStatus)),
          React.createElement('label', { className: 'mcart-switch' },
            React.createElement('input', { type: 'checkbox', checked: autoReportOn === true,
              onChange: (event) => { setAutoReport(event.target.checked); setAutoTick(autoTick + 1) } }),
            React.createElement('span', null, '出错时自动放进输入框'))))
        rows.push(React.createElement('div', { className: 'mcart-reportnote', key: 'note' },
          copied === ''
            ? '上面这段可以选中复制，或点「复制报告」/「把报告放进输入框」。面板不会自动发送；面板不会把它发进任何会话。'
            : copied))
        return React.createElement('div', { className: 'mcart-card', key: 'diag' }, rows)
      }

      function settingsCard() {
        if (settings === null) return null
        const rows = []
        // 属性表：label 固定 88px 右对齐 + 值占满（见 docs/UI-STYLE.md §3）。
        const prop = (key, label, value) => React.createElement('div', { className: 'mcart-prop', key: key },
          React.createElement('span', { className: 'mcart-prop-label' }, label),
          React.createElement('span', { className: 'mcart-prop-value' }, value))
        const group = (key, children) => React.createElement('div', { className: 'mcart-group', key: key }, children)
        const hint = (key, text) => prop(key, '', React.createElement('span', { className: 'mcart-note' }, text))
        if (settings.loading === true) {
          rows.push(React.createElement('div', { className: 'mcart-note', key: 'l' }, '读取设置…'))
        } else if (settings.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'e' }, String(settings.error)))
        } else {
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
            React.createElement('span', { className: 'mcart-title' }, '设置'),
            React.createElement('span', { className: 'mcart-sub' }, settings.title || settings.project || ''),
          ))
          // 组 1：参考目录（行是属性行；组内不画分隔线，组间才有 1px 线）
          const dirRows = []
          dirRows.push(prop('refpath', '参考目录',
            React.createElement('span', { className: 'mcart-path mcart-grow' }, settings.directory || '（未设置）')))
          dirRows.push(prop('pick', '选择', React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: picking,
            onClick: () => runPicker(settings.directory || root, (picked) => patchSettings({ directory: picked }, true)),
          }, picking ? '对话框已打开…' : '选择目录…')))
          // 手输/粘贴这条路是**必须**有的：系统目录对话框在某些环境里弹不出来
          // （shell 服务跑在非交互窗口站上时，FolderBrowserDialog 既不显示也不返回），
          // 而 fs 服务通常是好的 —— 那就让人把路径贴进来。
          // 以前这里只有一个"选择目录…"按钮，于是"点了没反应"就真的没有下一步了。
          dirRows.push(prop('dirinput', '路径', [
            React.createElement('input', {
              className: 'mcart-input', type: 'text', placeholder: '参考目录：%APPDATA%\\.minecraft\\versions\\<版本号>',
              value: dirDraft,
              onChange: (event) => setDirDraft(String(event.target.value)),
              onKeyDown: (event) => { if (event.key === 'Enter') applyDirDraft() },
            }),
            React.createElement('button', { className: 'mcart-btn', type: 'button',
              disabled: dirDraft.trim() === '', onClick: () => applyDirDraft() }, '用这个路径'),
          ]))
          dirRows.push(hint('dirhint', '对话框弹不出来时可以在这里贴路径（.minecraft、版本目录、mods 目录，或单个 jar 都行）。'))
          if (settings.directory !== '' && settings.directory !== undefined) {
            if (settings.scanError !== null && settings.scanError !== undefined) {
              dirRows.push(React.createElement('div', { className: 'mcart-err', key: 'scanerr' },
                '没读到里面的资源：' + String(settings.scanError)))
            } else {
              dirRows.push(hint('shape',
                '识别为 ' + (settings.shape || '？') + ' · ' + (settings.textures || 0) + ' 张贴图 · '
                + ((settings.sources || []).length) + ' 个资源文件'))
            }
          }
          for (const detected of (settings.directory === '' || settings.directory === undefined ? (settings.detected || []) : []).slice(0, 4)) {
            dirRows.push(prop('det' + detected, '检测到', [
              React.createElement('span', { className: 'mcart-path mcart-grow' }, detected),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => patchSettings({ directory: detected }, true) }, '用它'),
            ]))
          }
          if ((settings.directory === '' || settings.directory === undefined) && (settings.detected || []).length === 0) {
            dirRows.push(hint('nodir', '没设置就不参考外部资源。可以指向 .minecraft、某个版本目录、mods 目录，或单个 jar。'))
            dirRows.push(hint('nodir2', '没有自动检测到游戏目录 —— 直接把路径贴进上面的输入框也一样能用。'))
          }
          rows.push(group('dirgroup', dirRows))

          // 组 2：参考范围
          const scopeRows = []
          scopeRows.push(prop('gen', '已生成内容',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: settings.includeGenerated !== false,
                onChange: (event) => patchSettings({ includeGenerated: event.target.checked }) }),
              React.createElement('span', null, '参考本目录已生成内容'))))
          scopeRows.push(hint('genhint', '有助于保持生成风格一致'))
          scopeRows.push(prop('mods', '模组资源',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: settings.includeMods !== false,
                onChange: (event) => patchSettings({ includeMods: event.target.checked }) }),
              React.createElement('span', null, '参考目录中的模组资源文件'))))
          if (settings.includeMods !== false) {
            const mods = settings.mods || []
            const missing = settings.directory === '' || settings.directory === undefined
            const message = missing ? '还没指定参考目录'
              : (mods.length === 0 ? '参考目录里没有找到任何资源命名空间' : ('发现 ' + mods.length + ' 个命名空间'))
            scopeRows.push(prop('modbar', '命名空间', [
              React.createElement('span', { className: 'mcart-note mcart-grow' }, message),
              mods.length === 0 ? null : React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setModsOpen(!modsOpen) }, modsOpen ? '收起 ▴' : '展开 ▾'),
            ]))
            if (modsOpen) {
              const list = []
              for (const mod of mods) {
                const from = (mod.from || []).slice(0, 2).join('、')
                list.push(React.createElement('label', { className: 'mcart-switch', key: mod.name },
                  React.createElement('input', { type: 'checkbox', checked: mod.on === true,
                    onChange: (event) => toggleMod(mod.name, event.target.checked) }),
                  React.createElement('span', { className: 'mcart-grow' }, mod.name,
                    from === '' ? null : React.createElement('span', { className: 'mcart-id' }, from)),
                  React.createElement('span', { className: 'mcart-id' }, mod.count + ' 张贴图'),
                ))
              }
              scopeRows.push(React.createElement('div', { className: 'mcart-mods', key: 'modlist' }, list))
            }
          }
          rows.push(group('scopegroup', scopeRows))

          // 组 3：通知与设置文件
          const notifyRows = []
          notifyRows.push(prop('autoreport', '自动报告',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: autoReportOn === true,
                onChange: (event) => { setAutoReport(event.target.checked); setAutoTick(autoTick + 1) } }),
              React.createElement('span', null, '出错时自动把报告放进输入框'))))
          notifyRows.push(hint('autoreporthint', '只是草稿：不会自动发送，输入框里已经有你写的字时也不动它。'))
          notifyRows.push(prop('foot', '设置文件', [
            React.createElement('span', { className: 'mcart-path mcart-grow' }, settings.file || ''),
            React.createElement('span', { className: 'mcart-bad' }, saveState === null ? '' : saveState),
          ]))
          // Nothing pushes a message into the conversation, so the panel offers
          // the sentence and one click puts it (plus the settings file, which the
          // skill reads) in the composer.  This is the answer to "我改了设置会通知
          // agent 吗": now it can, without the user having to describe the change.
          // 和「@ 提意见」同一条路：**直接追加进输入框草稿**，不再挂 bar 让人点第二次。
          if (savedSettings !== null && savedSettings.path !== '') {
            notifyRows.push(prop('tell', '已保存', [
              React.createElement('span', { className: 'mcart-note mcart-grow' },
                '已保存，要让 AI 按新设置重做的话：'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => {
                  if (insertReference(savedSettings.path, savedSettings.note)) { setSavedSettings(null); return }
                  setPending({ path: savedSettings.path, note: savedSettings.note })
                } },
                '告诉 AI'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setSavedSettings(null) }, '不用了'),
            ]))
          }
          rows.push(group('notifygroup', notifyRows))
        }
        // 提示与报错**必须在这张卡里也出现**：这张设置卡原来不渲染 notice，
        // 于是"选择目录…"失败（对话框弹不出来、没有 shell 服务…）时，
        // 界面上一个字都不变 —— 用户看到的就是"点了没反应，也没有报错"。
        if (notice !== null) rows.push(React.createElement('div', { className: 'mcart-bad', key: 'notice' }, String(notice)))
        if (failure !== null) rows.push(React.createElement('div', { className: 'mcart-err', key: 'failure' }, withVersion(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'settings' }, rows)
      }

      if (root === '') {
        const card = []
        card.push(React.createElement('div', { className: 'mcart-note', key: 'hint' }, '未指定资产路径'))
        card.push(React.createElement('div', { className: 'mcart-bar', key: 'input' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '/path/to/project',
            value: draft, onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && draft !== '') commitRoot(draft) },
          }),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { if (draft !== '') commitRoot(draft) } }, '使用'),
        ))

        if (nearby !== null) {
          if (nearby.loading === true) {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'scanning' }, '正在找本会话目录里的项目…'))
          } else if (nearby.error !== null) {
            card.push(React.createElement('div', { className: 'mcart-err', key: 'nerr' }, String(nearby.error)))
          } else if (nearby.projects.length > 0) {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'found' }, '在 ' + nearby.cwd + ' 里找到：'))
            const rows = []
            for (const project of nearby.projects) {
              rows.push(React.createElement('div', { className: 'mcart-row', key: project.root + '/' + project.id },
                React.createElement('span', { className: 'mcart-grow' }, project.title,
                  project.title === project.id ? null : React.createElement('span', { className: 'mcart-id' }, project.id)),
                React.createElement('button', { className: 'mcart-btn', type: 'button',
                  onClick: () => openNearby(project.root, project.id) }, '打开'),
              ))
            }
            card.push(React.createElement('div', { className: 'mcart-projects', key: 'projects' }, rows))
          } else {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'none' },
              '在 ' + nearby.cwd + ' 里没找到 mc 资产项目。'))
          }
        }

        card.push(React.createElement('div', { className: 'mcart-bar', key: 'buttons' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: picking,
            onClick: pickDirectory }, picking ? '对话框已打开…' : '选择目录…'),
          nearby !== null && nearby.cwd !== '' ? React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => commitRoot(nearby.cwd) }, '用本会话目录') : null,
        ))

        if (notice !== null) card.push(React.createElement('div', { className: 'mcart-bad', key: 'notice' }, String(notice)))
        if (failure !== null) card.push(React.createElement('div', { className: 'mcart-err', key: 'failure' }, withVersion(failure)))
        return React.createElement('div', { className: 'mcart-root' },
          React.createElement('div', { className: 'mcart-bar' },
            React.createElement('span', { className: 'mcart-title' }, 'MC 资产'),
            React.createElement('span', { className: 'mcart-sub' }, inRightColumn ? '右侧栏' : '中央面板'),
          ),
          React.createElement('div', { className: 'mcart-card' }, card),
        )
      }

      // 空目录的引导：一步建项目、一步指参考目录。已有参考目录设置的人看不到这张卡
      // （他们的 scan 会正常返回项目，走的是老路）。
      function guideCard() {
        const id = String(newId).trim()
        const valid = /^[a-z0-9_]{2,32}$/.test(id)
        const reference = settings === null ? null : settings.directory
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '开始一个新模组'),
          React.createElement('span', { className: 'mcart-sub' }, '三步：目录 → 建项目 → 参考目录')))
        rows.push(React.createElement('div', { className: 'mcart-note', key: 'why' },
          '这个目录里还没有项目。一个模组 = 一个命名空间，所以这里只需要取一个名字：' +
          '项目 id 与命名空间同名，之后不会给它长出第二个命名空间。'))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'form' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '项目名，例如 my_mod（小写字母/数字/_）',
            value: newId,
            onChange: (event) => setNewId(String(event.target.value)),
            onKeyDown: (event) => { if (event.key === 'Enter' && valid) createProject() },
          }),
          React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: !valid || busy,
            onClick: () => createProject(),
          }, busy ? '…' : '在这里新建项目')))
        if (id !== '' && !valid) {
          rows.push(React.createElement('div', { className: 'mcart-bad', key: 'badid' },
            '只能用小写字母、数字、下划线，2-32 个字符'))
        }
        const here = emptyRoot === null ? root : emptyRoot
        rows.push(React.createElement('div', { className: 'mcart-hint', key: 'where' }, '建在：' + here))
        rows.push(React.createElement('div', { className: reference === null || reference === '' ? 'mcart-hint' : 'mcart-note', key: 'ref' },
          reference === null || reference === ''
            ? '建完下一步：点右上角 ⚙ 指定参考目录（面板会列出自动探测到的游戏目录）。不指定也能用，只是看不到原版/模组的参照。'
            : '参考目录已经设好了：' + reference))
        if (failure !== null) rows.push(React.createElement('div', { className: 'mcart-err', key: 'err' }, withVersion(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'guide' }, rows)
      }

      // 「这台宿主上我到底能看见什么」——失败时附在错误后面。
      // 建目录/写文件/写字节各有好几条路（宿主服务 → 服务 → node 垫片），
      // 而一句"宿主没有 X 服务"曾经把人带偏过：那句话谁也没查过。所以失败时直接问一句。
      function describeEnv() {
        return host.call('atlas.env', {}).then((env) => {
          if (env === null || env === undefined || env.services === undefined) return ''
          const names = Object.keys(env.services)
          const on = names.filter((key) => env.services[key] === true)
          const off = names.filter((key) => env.services[key] !== true)
          return '（宿主可用：' + (on.length === 0 ? '无' : on.join('、')) +
            '；缺：' + (off.length === 0 ? '无' : off.join('、')) +
            '；shell 方言：' + String(env.shellDialect === null || env.shellDialect === undefined ? '问不到' : env.shellDialect) + '）'
        }).catch(() => '')
      }

      function createProject() {
        const id = String(newId).trim()
        if (!/^[a-z0-9_]{2,32}$/.test(id)) return
        const here = emptyRoot === null ? root : emptyRoot
        setBusy(true)
        setFailure(null)
        host.call('atlas.createProject', { root: here, id: id }).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('新建项目没有返回任何东西'); return }
          const bad = failureOf(result)
          if (bad !== null) {
            setFailure(String(bad))
            describeEnv().then((text) => { if (text !== '') setFailure(String(bad) + ' ' + text) })
            return
          }
          setEmptyRoot(null)
          // 建目录走了哪条路要说出来：`.gitkeep` 占位和 node 垫片都是"服务不在"的
          // 后果，用户有权知道自己的工程是怎么被写下去的（也方便别人报问题时一句话说清）。
          if (typeof result.via === 'string') {
            setNotice('工程建好了：' + id + '（目录用 ' + result.via + ' 建的' +
              (result.placeholder === true ? '，空目录里留了 .gitkeep 占位' : '') + '）')
          }
          scan(here, true, id)
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      const projects = index === null ? [] : (index.projects || [])
      const menu = []
      for (const project of projects) {
        menu.push(React.createElement('div', { className: 'mcart-group', key: 'p' + project.id }, project.title))
        for (const category of CATEGORIES) {
          const items = (project.items && project.items[category.key]) || []
          if (items.length === 0) continue
          menu.push(React.createElement('div', { className: 'mcart-group', key: 'p' + project.id + category.key },
            category.label + ' · ' + items.length))
          for (const item of items) {
            const on = choice !== null && choice.project === project.id && choice.kind === category.key && choice.id === item.id
            menu.push(React.createElement('button', {
              key: project.id + '/' + category.key + '/' + item.id, type: 'button',
              className: 'mcart-item', 'data-on': on ? '1' : '0',
              onClick: () => open({ project: project.id, kind: category.key, id: item.id }, root),
            }, item.title,
              item.title === item.id ? null : React.createElement('span', { className: 'mcart-id' }, item.id)))
          }
        }
      }

      const stage = []
      // Filled in below, appended AFTER the canvas -- see the note there.
      const animRows = []
      if (!isAbsent(scene)) {
        const ids = idsOf(scene)
        const okCount = ids.filter((id) => decoded[id] !== undefined).length
        const bad = ids.filter((id) => failedTex[id] === true).length
        stage.push(React.createElement('div', { className: 'mcart-bar', key: 'row' },
          React.createElement('span', { className: 'mcart-note' },
            scene.quads.length + ' 面 · 贴图 ' + okCount + '/' + ids.length),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setYaw(0.72); setPitch(0.34); setZoom(1) } }, '重置'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: openEditor }, '✎ 手动修改'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: complain }, '@ 提意见'),
        ))
        if (bad > 0) stage.push(React.createElement('div', { className: 'mcart-bad', key: 'bad' }, bad + ' 张贴图解码失败'))
        if (scene.errors && scene.errors.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bad', key: 'notes' }, withVersion(scene.errors.join('；'))))
        }
        // Why this is on screen and not in the console: "the whole strip on one
        // face" has exactly two causes -- `animations` has no entry for that
        // texture id, or the decoded image is not `strip` rows tall -- and one
        // line tells them apart without devtools.
        //
        // TWO THINGS IT MUST NOT DO, both learned from the same complaint
        // ("the tip pops up when I select a block, the layout shifts, I cannot
        // click the block any more, the tip goes away, I can click again, the
        // tip comes back -- it twitches"):
        //   * It must not read the GHOST.  The ghost exists only while a block
        //     is held and hovered, so a ghost's `animations` made this row
        //     appear and disappear with the pointer -- and appearing MOVES the
        //     canvas, which moves what is under the pointer: a loop that feeds
        //     itself.  It reports on the SCENE, which is what is on screen.
        //   * It must not sit ABOVE the canvas.  Anything above pushes the
        //     canvas down whenever it grows, so a click aimed at a block lands
        //     somewhere else.  It is appended after the viewport instead.
        const animIndex = scene === null ? {} : (scene.animations || {})
        // 宿主查过 `.mcmeta` 时说的话（“有文件但读不了”“旁边根本没有这个文件”…）。
        // **它说了就照抄**；只有它没说话时，才轮到下面那句按形状猜的话。
        const animNotes = scene === null ? {} : (scene.animationNotes || {})
        for (const id of Object.keys(animIndex).sort()) {
          const tex = decoded[id]
          const size = tex === undefined ? '还没解码' : (tex.width + '×' + tex.height)
          const strip = tex === undefined ? null
            : stripOf({ width: tex.width, height: tex.height, animation: animIndex[id] })
          // The row actually sampled right now, so "the strip is fine but the
          // picture is not" cannot be mistaken for "the strip was rejected".
          const row = animationRow(animIndex[id], animTicks * 50)
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'anim:' + id },
            '动画 ' + id + ' · 解码 ' + size + ' · 声明 ' + String(animIndex[id].strip) + ' 行'
            + ' · 判定 ' + (tex === undefined ? '等解码' : (strip === null ? '不是条带 ← 会糊' : '单帧 ' + strip))
            + ' · 现在抽第 ' + String(row) + ' 行'))
        }
        for (const id of idsOf(scene)) {
          if (animIndex[id] !== undefined) continue
          const note = animNotes[id]
          if (note !== undefined && note !== null && typeof note.text === 'string' && note.text !== '') {
            // 宿主给了真话（例如"文件在，但我读不了"）——原样显示，**不再**自己下结论。
            animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'noanim:' + id }, note.text))
            continue
          }
          const tex = decoded[id]
          if (tex === undefined) continue
          // Only worth reporting when the shape says "this is a strip": a
          // plain 16x16 static texture having no description is normal.
          if (!(tex.height > tex.width && tex.height % tex.width === 0)) continue
          // 宿主没说话 = 旁边**真的没有** `.mcmeta`（它查过了）。这时这句才是对的，
          // 并且要说清补什么：`<贴图>.png.mcmeta`。
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'noanim:' + id },
            '形状像条带但没有动画描述 ' + id + ' · 解码 ' + tex.width + '×' + tex.height
            + ' ← 会糊；补一个 ' + String(id).split('/').pop() + '.png.mcmeta（animation 段里写明 frametime/frames）'))
        }
        if (scene.palette && scene.palette.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bar', key: 'palette' },
            scene.palette.slice(0, 8).map((entry) => React.createElement('span', { className: 'mcart-chip', key: entry.block },
              (entry.label || entry.block) + ' ×' + entry.count)),
          ))
        }
      }
      // The icon of whatever is selected, which is also what the bar's selected
      // slot draws.  Two things need it before the viewport is built: the poster
      // (below) and the notes (after it).
      // **这里必须收成 null**：`itemRecipes[key]` 在"配方还没取到"时是 `undefined`
      // （JSON 丢字段、或那次运行里资源正在被写），而下游每一处守卫写的都是 `=== null`。
      // 用户实测的崩溃链就是这一条：
      //   pickedRecipe === undefined → itemAsset() 返回的 recipe 是 undefined
      //   → `asset.recipe === null ? … : asset.recipe.textureIds` 放它过去
      //   → Cannot read properties of undefined (reading 'textureIds') → 面板白屏。
      // 与其在每一处读的地方各补一次，不如在这里就只说两种状态：有配方 / 没有(null)。
      const pickedRecipe = hudOn === '' || item === null
        ? null : (itemRecipes[itemKey(item.namespace, hudOn)] || null)
      // The row a block gets, for an asset that has no scene: the same two
      // buttons, because an item is an asset too.
      if (scene === null) {
        const asset = itemAsset()
        if (asset !== null) {
          const ids = idsOf(asset.recipe)
          const okCount = ids.filter((id) => decoded[id] !== undefined).length
          stage.push(React.createElement('div', { className: 'mcart-bar', key: 'itemrow' },
            React.createElement('span', { className: 'mcart-note' },
              '物品 · 贴图 ' + okCount + '/' + ids.length
              + (asset.source === 'project' ? '' : '（参考）')),
            React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: openEditor }, '✎ 手动修改'),
            React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: complain }, '@ 提意见'),
          ))
        }
      }
      // NO MODEL, BUT AN ITEM: put the 2D form where the 3D one would be.  An
      // item-only asset (a material like blood_crystal) is a picture and nothing
      // else, so the picture is what belongs in the viewport -- the user asked for
      // exactly this ("3D没有东西可看的情况应该放2D在上面"), and an empty black
      // rectangle is not an answer.
      //
      // `scene === null` 只是"没东西可画"的**一种**。宿主还会回一个"成功但没有一个面"
      // 的对象（`{quads: []}`，Lead 说的 mist_ladder / 平面物品那种）：那种空对象以前
      // 被当成"有场景"，于是 3D 空着、2D 又被这个条件跳过 —— 屏幕全白，而且一个字都没有。
      // 判据改成"3D 里真的有没有可画的面"，并且下面会**明说**这一条为什么走的 2D。
      const sceneDrawsNothing = scene === null || arrayOf(scene.quads).length === 0
      // 缺图标的那一格没有图画：别画一张空 poster（看起来又像"加载中"），
      // 让它走"没有可用的图标 —— 上面那句说清了原因"那条明说的路。
      const posterRecipe = sceneDrawsNothing && pickedRecipe !== null && pickedRecipe.missing !== true
        ? pickedRecipe : null
      // A square that fits the viewport: a sprite stretched to a 1.3:1 rectangle is
      // a distortion, and `drawItemIcon` fills whatever canvas it is handed.
      const posterSide = Math.max(48, Math.min(size[0], size[1]) - 24)
      stage.push(React.createElement('div', { className: 'mcart-viewport', key: 'viewport' },
        React.createElement('canvas', {
        key: 'canvas', className: 'mcart-canvas',
        // The CSS default is the same number; an inline height is what the grip
        // moves.  `clientHeight` then feeds the size state, so the picture is
        // redrawn at the new resolution instead of being stretched.
        style: { height: viewH + 'px' },
        ref: (node) => { canvasGeneration += 1; setCanvas(node) },
        onPointerDown: (event) => {
          drag.active = true
          drag.moved = 0
          drag.x = event.clientX
          drag.y = event.clientY
          if (event.currentTarget.setPointerCapture) {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
          }
        },
        onPointerMove: (event) => {
          if (!drag.active) {
            if (voxel !== null) {
              const target = voxelTargetAt(event)
              if (target === null) { if (hover !== null) setHover(null) }
              else if (hover === null || hover.cell !== target.cell || hover.face !== target.face) setHover(target)
            }
            return
          }
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          drag.x = event.clientX
          drag.y = event.clientY
          drag.moved += Math.abs(dx) + Math.abs(dy)
          setYaw((previous) => previous - dx * 0.011)
          setPitch((previous) => Math.max(-1.35, Math.min(1.35, previous + dy * 0.011)))
        },
        onPointerUp: (event) => {
          const dragDistance = drag.moved
          drag.active = false
          // A rotation ends with the pointer somewhere else; a click barely
          // moves.  Without this every rotate would also place a block.
          if (dragDistance > 4 || voxel === null) return
          // Vanilla's two buttons: left breaks, right places.
          voxelClick(event, event.button === 2 ? 'place' : 'remove')
        },
        onContextMenu: (event) => { if (event.preventDefault) event.preventDefault() },
        onPointerLeave: () => { drag.active = false },
      }),
        React.createElement('div', { className: 'mcart-zoom' },
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '放大', onClick: () => zoomBy(1.15) }, '＋'),
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '缩小', onClick: () => zoomBy(1 / 1.15) }, '－'),
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '复位视角（旋转与缩放一起）',
            onClick: () => { setYaw(0.72); setPitch(0.34); setZoom(1) } }, '⟲'),
        ),
        // The 2D stand-in, drawn at the size it is shown at (the backing store is
        // the CSS size, so a 16 px sprite is scaled once, by this code, nearest
        // neighbour -- not blurred by the browser).
        posterRecipe === null ? null : React.createElement('canvas', {
          key: 'poster', className: 'mcart-poster',
          width: posterSide, height: posterSide,
          style: { width: posterSide + 'px', height: posterSide + 'px' },
          title: hudPicked,
          ref: (node) => setPosterCanvas(node),
        }),
        // The 2D layer: the game's hotbar, laid over the model instead of in a
        // row of its own beside it.  The model IS the item -- what it looks like
        // standing in the world is the big picture, and what it looks like in a
        // slot is the strip along the bottom, the way the game shows both.
        //
        // It is an absolutely positioned overlay, not a row above or below: a row
        // that appears and disappears MOVES the canvas, which moves whatever is
        // under the pointer, which is the twitching a row above the canvas caused.
        hudBar()))

      // The grip: the whole 3D+hotbar block resizes from its bottom edge.  It sits
      // BELOW the canvas, so dragging it never moves the picture under the pointer
      // (the mistake a control above the canvas caused); it is always present, so
      // it never appears and disappears either.
      stage.push(React.createElement('div', { className: 'mcart-grip', key: 'grip',
        title: '上下拖动调整 3D + 物品栏的高度，双击复位',
        onDoubleClick: () => setViewH(VIEW_H),
        onPointerDown: (event) => {
          gripDrag.active = true
          gripDrag.y = event.clientY
          gripDrag.origin = viewH
          if (event.currentTarget.setPointerCapture) {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
          }
        },
        onPointerMove: (event) => {
          if (!gripDrag.active) return
          setViewH(clampViewH(gripDrag.origin + (event.clientY - gripDrag.y)))
        },
        onPointerUp: () => { gripDrag.active = false },
        onPointerCancel: () => { gripDrag.active = false },
      }, React.createElement('span', { className: 'mcart-gripbar' })))

      // What used to sit INSIDE the 3D view.  It belongs down here: the overlay is
      // meant to look like the game's HUD, and a warning line in the middle of it
      // is neither the game nor readable.  Below the canvas is also the only safe
      // place -- a row that grows above it moves the canvas under the pointer.
      const iconNotes = []
      if (itemMsg !== null) iconNotes.push(String(itemMsg))
      const pickedNote = slotNote(pickedRecipe)
      if (pickedNote !== null) iconNotes.push(pickedNote)
      // An item-only asset (a material like blood_crystal: a model with no
      // blockstate) has no 3D form at all.  The viewport is cleared, so it must
      // SAY why -- an empty black rectangle under a slot that clearly has a
      // picture reads as a viewer that stopped working.
      if (previewItem !== null && previewItem.localOnly === true) {
        iconNotes.push((hudPicked === '' ? previewItem.id : hudPicked)
          + ' 没有方块模型（它是物品，不是方块），所以 3D 里没有东西可看；它的样子就是物品栏里那一格')
      }
      // "一个面都没有"必须被**说出来**：它可能是模型/贴图缺了，也可能是这条 3D 里
      // 本来就没东西。屏幕上一个字都没有，就是用户说的"死了，AI 也不知道"。
      if (scene !== null && arrayOf(scene.quads).length === 0) {
        iconNotes.push(posterRecipe === null
          ? '这一条 3D 里一个面都没有，也没有可用的图标 —— 上面那句"取不到 / 画不出来"就是原因'
          : '这一条 3D 里一个面都没有（模型或贴图那一段是空的）；取景框里画的是它的 2D 图标')
      }
      if (choice !== null && choice.kind !== 'block') {
        iconNotes.push(choice.kind === 'entity'
          ? '实体在游戏里没有物品图标（刷怪蛋的蛋色写在代码里，包里没有）'
          : (choice.kind === 'biome' ? '群系' : '多方块结构') + '在游戏里不是物品')
      }
      if (iconNotes.length > 0) {
        stage.push(React.createElement('div', { className: 'mcart-note', key: 'iconnote' }, iconNotes.join('；')))
      }

      if (animRows.length > 0) {
        stage.push(React.createElement('div', { className: 'mcart-mods', key: 'anims' }, animRows))
      }

      const sources = []
      const allTextures = Object.assign({}, scene === null ? {} : scene.textures,
        ghost === null || ghost.textures === undefined ? {} : ghost.textures)
      // The item picker's own textures ride the same hidden <img> list; without
      // an element per texture there is nothing for the decoder to read.
      for (const recipe of iconRecipesInUse()) {
        if (recipe.textures !== undefined && recipe.textures !== null) Object.assign(allTextures, recipe.textures)
      }
      if (scene !== null || item !== null) {
        for (const id of Object.keys(allTextures)) {
          if (decoded[id] !== undefined) continue
          sources.push(React.createElement('img', {
            key: id, src: allTextures[id], alt: '', style: { display: 'none' },
            ref: (node) => {
              if (node === null || node === undefined) delete imageNodes[id]
              else imageNodes[id] = node
            },
            onLoad: () => setTick(tick + 1),
            onError: () => { failedTex[id] = true; setTick(tick + 1) },
          }))
        }
      }

      return React.createElement('div', { className: 'mcart-root' },
        // 顶栏钉在滚动区顶部（`mcart-head`）：面板很长时"设置/物品列表"不会滚走，
        // 这是专业工具的常规做法（VS Code 标题栏、Blender 属性面板的 header）。
        React.createElement('div', { className: 'mcart-bar mcart-head' },
          React.createElement('span', { className: 'mcart-title' }, 'MC 资产'),
          React.createElement('span', { className: 'mcart-sub' },
            busy ? '加载中…' : (inRightColumn ? '右侧栏' : '中央面板')),
          // The bar at the bottom of the 3D view IS the 物品栏 now, the way the
          // game has it; this button unfolds the browser behind it (来源、搜索、
          // 展示形式、四十格一页), which is the part the game has no equivalent of.
          React.createElement('button', { className: 'mcart-btn mcart-tool', type: 'button',
            title: '物品浏览器：来源、搜索、展示形式都在这里；下面那排物品栏跟着一起筛',
            'data-on': itemOpen ? '1' : '0',
            onClick: openItems }, itemOpen ? '收起列表' : '物品列表'),
          React.createElement('button', { className: 'mcart-icon', type: 'button', title: '设置',
            onClick: openSettings }, settings === null ? '⚙' : '⚙▾'),
        ),
        settings === null ? null : settingsCard(),
        emptyRoot === null ? null : guideCard(),
        React.createElement('div', { className: 'mcart-bar' },
          React.createElement('span', { className: 'mcart-path' }, root),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setRoot(''); setIndex(null); setItem(null); setItemOpen(false); setIconPick(null); setPreviewItem(null); setHudPage(1); setScene(null); setSettings(null); setEdit(null); setVoxel(null); setHover(null); setGhost(null) } }, '换项目'),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            // 刷新 = "磁盘上可能变了，重新读一遍"：先丢像素缓存，再强制重扫索引。
            // 只重扫索引的话，`have` 里还留着旧贴图的 id，宿主永远不会再送新的字节。
            onClick: () => { forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null) } }, '刷新'),
        ),
        failure === null ? null : React.createElement('div', { className: 'mcart-err' }, withVersion(failure)),
        diagnosticCard(),
        React.createElement('div', { className: 'mcart-list' }, menu),
        editorCard(),
        voxelCard(),
        itemOpen ? itemCard() : null,
        React.createElement('div', { className: 'mcart-stage' }, stage),
        React.createElement('div', { style: { display: 'none' } },
          React.createElement('canvas', { ref: setScratch, width: 256, height: 256 }),
          React.createElement('canvas', { ref: setEditScratch, width: 16, height: 16 }),
          sources,
        ),
      )
    }

    function TabTitle() {
      return React.createElement('span', null, 'MC 资产')
    }

    /**
     * 输入框 dock：**主要职责是捕获把手**。
     *
     * 壳把 `inputActions.setDraft` / `useInput` 只交给这个槽的 props，而报告卡、
     * 渲染错误边界、「@ 提意见」都要写草稿 —— 所以每渲染一遍就把把手与"这一遍读到
     * 的草稿"记进模块级 `composer`。**只是草稿**：这里没有、也不会有发送接口。
     *
     * 那条 "引用给 AI / 插入输入框 / 取消" 的 bar 已经**不再出现在正常路径**上：
     * 用户要的是"@提意见 直接插进对话框"，`complain()` 现在直接写草稿并把 pending
     * 清空，所以这里照常返回 null。它只在一种情况露头：点按钮那一刻 dock 还没挂上、
     * 拿不到把手（冷启动少见），`complain()` 会退回 `setPending(...)` 把这条 bar
     * 当兜底挂出来 —— 宁可退化成两步，也绝不许点了没反应。
     */
    function ReferenceBar(props) {
      const current = usePending()
      const draft = props.useInput !== undefined ? props.useInput((state) => state.draft) : ''
      // 输入框的把手只有这里能拿到（`useInput` 是壳给的**钩子**，只能在渲染里调），
      // 所以每渲染一遍就把"能写草稿"和"这一遍读到的草稿"记下来 —— 渲染失败的边界和
      // 报告卡都靠它把报告放进草稿。**只是草稿**：这里没有、也不会有发送接口。
      try {
        if (props.inputActions !== undefined && props.inputActions !== null
          && typeof props.inputActions.setDraft === 'function') {
          const first = typeof composer.write !== 'function'
          composer.write = props.inputActions.setDraft
          if (first) composerCaptured()
        }
        composer.draft = draft === undefined || draft === null ? '' : String(draft)
      } catch (error) { /* 壳给的 props 形状不对也不该把引用条弄没 */ }
      if (current === null || current.path === '') return null
      // `note` is the sentence that goes WITH the reference: a settings change has
      // to say WHAT changed, or `@file` alone leaves the agent to diff it.  It is
      // the answer to "我这里设置修改了会通知agent吗" -- nothing pushes a message
      // into the conversation, so the panel offers the sentence and one click puts
      // it in the composer.
      const note = current.note === undefined || current.note === null ? '' : String(current.note)
      return React.createElement('div', { className: 'mcart-ref' },
        React.createElement('span', null, '引用给 AI'),
        React.createElement('span', { className: 'mcart-ref-path' }, '@' + current.path),
        note === '' ? null : React.createElement('span', { className: 'mcart-ref-path' }, note),
        React.createElement('button', {
          className: 'mcart-btn', type: 'button',
          onClick: () => {
            const text = draft === undefined || draft === null ? '' : String(draft)
            const base = text.length > 0 ? text.replace(/\s+$/, '') + ' ' : ''
            const tail = '@' + current.path + (note === '' ? ' ' : ' ' + note)
            if (props.inputActions !== undefined) props.inputActions.setDraft(base + tail + ' ')
            setPending(null)
          },
        }, '插入输入框'),
        React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: () => setPending(null) }, '取消'),
      )
    }

    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'mc-art-ref', order: 15 },
      (props) => React.createElement(ReferenceBar, { useInput: props.useInput, inputActions: props.inputActions }),
    ))

    let placement = null
    const leftStops = []
    function placeLeft() {
      if (placement !== null) return
      placement = 'left'
      const keep = []
      slots.inject('main', () => {
        const stop = slots.register({ name: 'main', key: 'mcarts' },
          () => React.createElement(PanelBoundary, null, React.createElement(Atlas, { sessionId: '' })))
        keep.push(stop)
        return stop
      })
      slots.inject('sidebar.panellist', () => {
        const stop = slots.register({ name: 'sidebar.panellist', id: 'mcarts', order: 12, label: 'MC 资产' },
          () => React.createElement('span', null, 'MC'))
        keep.push(stop)
        return stop
      })
      leftStops.push(() => { for (const stop of keep) { try { if (typeof stop === 'function') stop() } catch (error) {  } } })
    }
    function placeRight() {
      if (placement === 'right') return
      // **先确认能不能挂上，再撤左栏。**
      //
      // 原来这里是：先 `placement = 'right'`、先把左栏那份撤掉，然后才发现
      // `sidebarRightTabs` 不在、直接 return —— 于是**两处都没有**，右边栏一片空白，
      // 而且 placement 已经写成 'right'，再也不会重试。用户实测就是"刷新之后右边栏
      // 一片空白"。（`slotHasEntries` 让 inRightColumn 为真、而服务恰好不在时就会走到。）
      //
      // 现在：没有 tab 服务、也没有 pane 槽时**什么都不动**（保留左栏那份能用的）；
      // 只要还能挂（服务在，或槽在），就挂上去，然后才撤左栏。
      const rightTabs = ctx.get('sidebarRightTabs')
      // 拿不准就**什么都别动**：左栏那份至少点得开。只挂 pane、不挂 tab 是一种更糟的
      // 失败 —— 面板画在右栏里，但没有任何标签能点开它（用户报的就是"右侧栏打不开"）。
      if (rightTabs === undefined) return
      if (placement === 'left') {
        // 搬到右栏：先把左栏那份撤掉，免得同一个面板在两处都在。
        for (const stop of leftStops) { try { stop() } catch (error) {  } }
        leftStops.length = 0
      }
      placement = 'right'
      ctx.effect(() => rightTabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        priority: 'extension',
        title: () => 'MC 资产',
        guide: [{
          id: TAB_ID + '.open',
          order: 40,
          title: () => 'MC 资产预览',
          description: () => '在右侧栏里看这个项目的方块 / 实体 / 群系 / 多方块结构',
        }],
      }))
      registerPane()
    }

    /** 把面板挂进右栏的 pane 槽（tab 服务在不在都要挂：槽里有壳就行）。 */
    function registerPane() {
      slots.inject('sidebar.right.pane.tab', () => slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        (props) => React.createElement(PanelBoundary, null,
          React.createElement(Atlas, { sessionId: props.sessionId })),
      ))
      slots.inject('sidebar.right.pane.tab.title', () => slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
        () => React.createElement(TabTitle, null),
      ))
    }

    if (inRightColumn) placeRight()
    else {
      placeLeft()
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sidebarRightTabs'], () => { if (rightColumnReady()) placeRight() })
        } catch (error) {  }
      }
    }
  },
}
