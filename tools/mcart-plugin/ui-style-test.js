// 样式门禁（判据：`docs/UI-STYLE.md` **v2：向「自媒体工作台」靠近**）。
//
// 为什么要有这条：风格是一整批 CSS 的性质，靠人眼每次审很容易漂回去 —— 一个
// `linear-gradient` 渐变、一个 2px 小圆角、一个 9px 的野间距就能把它打回 v1/AI 味。
// 所以这里读 `client/20-const.js` 里**真正会进包的那段 CSS 字符串**（外加
// `client/99-entry.js` 的**空状态文案**，因为"真实计数"是 DOM 里的事实），逐条对判据：
//
//   §6 的 9 条：卡片三件套 / 点阵背景 24px / 空状态衬线 ≥26px + 真实计数 /
//   输入条 36px+999+圆形按钮 / 胶囊页签选中 --card / 动效时长与 --ease 且无无限动画 /
//   圆角只允许 --r-* 与 999/50% / 字号白名单 / 行高 28·22·18。
//
//   node tools/mcart-plugin/ui-style-test.js
//   node tools/mcart-plugin/ui-style-test.js --fault          # 注入 linear-gradient → 必须红
//   node tools/mcart-plugin/ui-style-test.js --fault-radius   # 注入 2px 小圆角 → 必须红
//   node tools/mcart-plugin/ui-style-test.js --fault-spacing  # 注入 9px 野间距 → 必须红
const nodeFs = require('fs')
const nodePath = require('path')

const REPO = nodePath.resolve(__dirname, '..', '..')
const SOURCE = nodePath.join(REPO, 'tools', 'mcart-plugin', 'client', '20-const.js')
const CLIENT = nodePath.join(REPO, 'tools', 'mcart-plugin', 'client', '99-entry.js')
const FAULT = process.argv.includes('--fault')
const FAULT_RADIUS = process.argv.includes('--fault-radius')
const FAULT_SPACING = process.argv.includes('--fault-spacing')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok || detail === undefined ? '' : '  ← ' + detail))
}

/** 把 `const CSS = [ ... ].join('')` 里的字符串字面量取出来拼成真实 CSS。 */
function cssOf(source) {
  const at = source.indexOf('const CSS = [')
  if (at < 0) throw new Error('20-const.js 里找不到 `const CSS = [`')
  const end = source.indexOf("].join('')", at)
  if (end < 0) throw new Error("CSS 数组没有 `].join('')` 收尾")
  const block = source.slice(at, end)
  const literals = []
  const pattern = /'((?:[^'\\]|\\.)*)'/g
  let match = pattern.exec(block)
  while (match !== null) {
    literals.push(match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    match = pattern.exec(block)
  }
  const css = literals.join('')
  if (css.length < 500) throw new Error('取出来的 CSS 太短（' + css.length + ' 字符），提取规则可能坏了')
  return css
}

function declarations(css) {
  const out = []
  const pattern = /(?:^|[;{])[^;{}]*?([a-z-]+)\s*:\s*([^;}]+)/g
  let match = pattern.exec(css)
  while (match !== null) {
    out.push({ property: match[1], value: match[2].trim() })
    match = pattern.exec(css)
  }
  return out
}
function valuesOf(css, property) {
  return declarations(css).filter((item) => item.property === property).map((item) => item.value)
}
function ruleOf(css, selector) {
  const at = css.indexOf(selector + '{')
  if (at < 0) return ''
  const end = css.indexOf('}', at)
  return end < 0 ? '' : css.slice(at, end + 1)
}

function main() {
  const source = nodeFs.readFileSync(SOURCE, 'utf8')
  const client = nodeFs.readFileSync(CLIENT, 'utf8')
  let css
  try {
    css = cssOf(source)
  } catch (error) {
    console.log('  FAIL ' + error.message)
    return 1
  }

  if (FAULT) css += '.mcart-fault{background:linear-gradient(#fff,#000)}'
  if (FAULT_RADIUS) css += '.mcart-fault{border-radius:2px}'
  if (FAULT_SPACING) css += '.mcart-fault{padding:9px}'
  if (FAULT || FAULT_RADIUS || FAULT_SPACING) {
    console.log('（故障注入生效：' + [FAULT ? 'gradient' : '', FAULT_RADIUS ? 'radius' : '',
      FAULT_SPACING ? 'spacing' : ''].filter(Boolean).join(' + ') + '）')
  }

  console.log('--- 禁止项（§1）')
  check('界面骨架没有线性渐变（只允许内容物渐变）', css.indexOf('linear-gradient') < 0)
  check('没有硬编码灰 rgba(127,127,127（颜色全走 token）', css.indexOf('rgba(127,127,127') < 0)
  check('没有无限循环动画（没有 animation 声明）', !/(?:^|[;{])animation\s*:/.test(css))
  check('没有表情符号当图标', !/[\u{1F300}-\u{1FAFF}]/u.test(css))

  console.log('--- §6.1 卡片三件套')
  const card = ruleOf(css, '.mcart-card')
  check('卡片同时有 r-md 圆角 + --elevation-soft 软阴影 + 1px --line',
    /border-radius:var\(--r-md\)/.test(card)
    && /box-shadow:var\(--dsw-elevation-soft\)/.test(card)
    && /border:1px solid var\(--line\)/.test(card),
    card.slice(0, 160))

  console.log('--- §6.2 背景点阵')
  check('画布背景是 radial-gradient 点阵，步距 24px',
    /background-image:radial-gradient\(/.test(css) && /background-size:24px 24px/.test(css))

  console.log('--- §6.3 空状态：衬线大字 + 真实计数')
  check('空状态大标题用 --serif 且字号 ≥26px',
    /\.mcart-empty-title\{[^}]*font-family:var\(--serif\)/.test(css)
    && /\.mcart-empty-title\{[^}]*font-size:26px/.test(css))
  check('空状态写的是**真实计数**（不是"暂无数据"）',
    /nearby\.projects\.length/.test(client) && client.indexOf('暂无数据') < 0)

  console.log('--- §6.4 底部输入条（@ 提意见）')
  const bar = ruleOf(css, '.mcart-complain')
  const send = ruleOf(css, '.mcart-complain-send')
  check('输入条 36px 高、999 胶囊、--card 底 + 1px --line',
    /height:36px/.test(bar) && /border-radius:999px/.test(bar)
    && /background:var\(--card\)/.test(bar) && /border:1px solid var\(--line\)/.test(bar))
  check('右侧是圆形 26px 主色按钮（插入后再变「已插入」）',
    /width:26px;height:26px/.test(send) && /border-radius:999px/.test(send)
    && /background:var\(--primary\)/.test(send)
    && /data-inserted="1"/.test(css) && client.indexOf('已插入') >= 0)

  console.log('--- §6.5 顶栏 / 胶囊页签')
  check('顶栏标题用衬线 16px',
    /\.mcart-title\{[^}]*font-family:var\(--serif\)/.test(css)
    && /\.mcart-title\{[^}]*font-size:16px/.test(css))
  check('胶囊页签容器 --r-sm + --hover 底',
    /\.mcart-tabs\{[^}]*border-radius:var\(--r-sm\)/.test(css)
    && /\.mcart-tabs\{[^}]*background:var\(--hover\)/.test(css))
  check('选中页签用 --card 底 + --elevation-soft',
    /\.mcart-tab\[data-on="1"\]\{[^}]*background:var\(--card\)/.test(css)
    && /\.mcart-tab\[data-on="1"\]\{[^}]*box-shadow:var\(--dsw-elevation-soft\)/.test(css))
  check('顶栏圆形图标按钮 26px',
    /\.mcart-icon\{[^}]*width:26px;height:26px/.test(css)
    && /\.mcart-icon\{[^}]*border-radius:999px/.test(css))

  console.log('--- §6.6 动效')
  const durations = []
  for (const value of valuesOf(css, 'transition')) {
    for (const match of value.matchAll(/(\d+)ms/g)) durations.push(Number(match[1]))
    if (value.indexOf('var(--ease)') < 0 && /\d+ms/.test(value)) {
      check('transition 使用 --ease（' + value.slice(0, 60) + '）', false)
    }
  }
  const badDuration = durations.filter((ms) => [120, 150, 200, 300].indexOf(ms) < 0)
  check('transition 时长只用 120/150/200/300ms', badDuration.length === 0, badDuration.join(','))
  check('按下是 scale(.98)（120ms，不是位移）',
    /:active\{[^}]*transform:scale\(\.98\)/.test(css))

  console.log('--- §6.7 圆角尺度')
  const radii = valuesOf(css, 'border-radius')
  const allowedRadius = /^(var\(--r-(?:xs|sm|md|lg|xl|panel)\)|999px|50%|0)$/
  const badRadius = radii.filter((value) => !allowedRadius.test(value))
  check('圆角只允许 --r-xs/sm/md/lg/xl/panel 与 999/50%（禁止 2/3px 小方块）',
    badRadius.length === 0, badRadius.join(' ｜ '))
  check('圆角 token 档位齐全（4/8/12/16/20/28）',
    /--r-xs:/.test(css) && /--r-sm:/.test(css) && /--r-md:/.test(css)
    && /--r-lg:/.test(css) && /--r-xl:/.test(css) && /--r-panel:/.test(css))

  console.log('--- §6.8 字号白名单')
  const allowedFont = [11, 12, 12.5, 13, 14, 15, 16, 26, 28]
  const badFont = []
  for (const value of valuesOf(css, 'font-size')) {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(value)
    if (match === null) { badFont.push(value); continue }
    const px = Number(match[1])
    if (!allowedFont.some((size) => Math.abs(size - px) <= 1)) badFont.push(value)
  }
  check('字号只用 11/12/12.5/13/14/15/16/26/28（±1）',
    badFont.length === 0, badFont.join(' ｜ '))

  console.log('--- §6.9 行高')
  check('行高有 28（列表）/ 22（正文）/ 18（说明）三档',
    css.indexOf('line-height:28px') >= 0 && css.indexOf('line-height:22px') >= 0
    && css.indexOf('line-height:18px') >= 0)

  console.log('--- §3 间距刻度')
  {
    const spacingProps = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'gap', 'column-gap', 'row-gap']
    const allowed = [0, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20]
    const bad = []
    for (const item of declarations(css)) {
      if (spacingProps.indexOf(item.property) < 0) continue
      if (item.value.indexOf('calc(') >= 0) continue
      for (const number of item.value.match(/(\d+(?:\.\d+)?)px/g) || []) {
        const value = Number(number.slice(0, -2))
        if (allowed.indexOf(value) < 0) bad.push(item.property + ':' + item.value)
      }
    }
    check('间距只用 4/6/8/10/12/16/20（0/1px 描边除外）', bad.length === 0, bad.slice(0, 6).join(' ｜ '))
  }
  console.log('--- 组件级（§3/§4，沿用 v1 中仍然正确的部分）')
  check('资产行：28px 行高、圆角 r-sm、两列（名称 + mono id）',
    /\.mcart-item\{[^}]*height:28px/.test(css)
    && /\.mcart-item\{[^}]*border-radius:var\(--r-sm\)/.test(css)
    && /\.mcart-item-name\{/.test(css) && /\.mcart-item-id\{/.test(css))
  check('选中行：--active 底 + 左侧 2px --accent 条',
    /\.mcart-item\[data-on="1"\]\{[^}]*background:var\(--active\)/.test(css)
    && /\.mcart-item\[data-on="1"\]\{[^}]*border-left-color:var\(--accent\)/.test(css))
  check('列表卡片标题行：衬线 15px + 计数',
    /\.mcart-group-title\{[^}]*font-family:var\(--serif\)/.test(css)
    && /\.mcart-group-title\{[^}]*font-size:15px/.test(css)
    && /\.mcart-group-count\{/.test(css))
  check('3D 视口：--canvas 底 + r-md + 内描边 + 圆形 26px 玻璃控制键',
    /\.mcart-viewport\{[^}]*background:var\(--canvas\)/.test(css)
    && /\.mcart-viewport\{[^}]*border-radius:var\(--r-md\)/.test(css)
    && /\.mcart-viewport\{[^}]*box-shadow:inset 0 0 0 1px var\(--line-strong\)/.test(css)
    && /\.mcart-zoombtn\{[^}]*border-radius:999px/.test(css)
    && /\.mcart-zoombtn\{[^}]*background:var\(--glass\)/.test(css))
  check('设置是两列属性网格（88px 标签列，右对齐）',
    /\.mcart-prop\{[^}]*grid-template-columns:88px 1fr/.test(css)
    && /\.mcart-prop-label\{[^}]*text-align:right/.test(css))
  check('数字/路径/ID 等宽 + tabular-nums',
    /font-variant-numeric:tabular-nums/.test(css) && /ui-monospace/.test(css)
    && /\.mcart-num\{/.test(css))
  check('焦点：2px accent 半透明外圈（不用发光）',
    /box-shadow:0 0 0 2px color-mix\(in srgb,var\(--accent\) 50%,transparent\)/.test(css))
  check('颜色全部来自 DSH alias token',
    /--ink:var\(--dsw-alias-label-primary/.test(css)
    && /--card:var\(--dsw-alias-bg-layer-2/.test(css)
    && /--accent:var\(--dsw-alias-link/.test(css)
    && /--primary:var\(--dsw-alias-button-primary-fill/.test(css))

  if (FAULT || FAULT_RADIUS || FAULT_SPACING) {
    // 反向夹具：注入的违规必须被上面的断言抓到。退出码 1 = 红（与 ui-test 同体例）。
    const expected = FAULT ? '线性渐变' : FAULT_RADIUS ? '2px 小圆角' : '野间距'
    const caught = failures > 0
    console.log('\n--- 反向夹具 ---')
    check('注入违规后断言变红（命中：' + expected + '）', caught,
      caught ? '' : '注入了违规但所有断言仍然全绿 = 门禁是装饰')
    console.log(caught ? '故障注入被抓住：退出码 1（红）' : '门禁没抓到注入的违规：退出码 2（门禁失效，要修）')
    return caught ? 1 : 2
  }

  console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
  return failures === 0 ? 0 : 1
}

process.exit(main())
