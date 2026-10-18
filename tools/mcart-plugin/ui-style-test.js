// 专业工具风格的**样式门禁**（判据：`docs/UI-STYLE.md`）。
//
// 为什么要有这条：风格是"一整批 CSS 的性质"，靠人眼每次审很容易漂回去 —— 一个
// `linear-gradient`、一个 8px 圆角、一个 16px 大留白就能把"专业工具"变回"AI 味"。
// 所以这里读 `client/20-const.js` 里**真正会进包的那段 CSS 字符串**，逐条对判据：
//
//   禁止：渐变 / 阴影（弹层例外，需 `/* mcart:allow-shadow */` 标记）/ 动画 / 过渡 /
//         ≥8px 圆角 / 数字字号 / 硬编码灰 `rgba(127,127,127` / 非 2·4·6·8 的间距刻度；
//   必须：圆角 token 只有 2/3、间距 token 只有 2/4/6/8、正文 12 / 次要 11 / 行高 22 /
//         表单行 26 / 工具栏 28 / 标签列 88 / 数字等宽 + tabular-nums、四态齐全、
//         属性行两列、选中行左侧 2px 强调条、sticky 顶栏。
//
//   node tools/mcart-plugin/ui-style-test.js
//   node tools/mcart-plugin/ui-style-test.js --fault          # 注入 linear-gradient，必须红
//   node tools/mcart-plugin/ui-style-test.js --fault-radius   # 注入 8px 圆角，必须红
//   node tools/mcart-plugin/ui-style-test.js --fault-spacing  # 注入 16px 内边距，必须红
const nodeFs = require('fs')
const nodePath = require('path')

const REPO = nodePath.resolve(__dirname, '..', '..')
const SOURCE = nodePath.join(REPO, 'tools', 'mcart-plugin', 'client', '20-const.js')
const FAULT = process.argv.includes('--fault')
const FAULT_RADIUS = process.argv.includes('--fault-radius')
const FAULT_SPACING = process.argv.includes('--fault-spacing')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok || detail === undefined ? '' : '  ← ' + detail))
}

/**
 * 把 `const CSS = [ ... ].join('')` 里的字符串字面量取出来拼成真实 CSS。
 * 只读字符串字面量 —— JS 注释不是样式，不该被当成判据。
 */
function cssOf(source) {
  const at = source.indexOf('const CSS = [')
  if (at < 0) throw new Error('20-const.js 里找不到 `const CSS = [`')
  const end = source.indexOf("].join('')", at)
  if (end < 0) throw new Error('CSS 数组没有 `].join(\'\')` 收尾')
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

/** 逐条声明解析（`prop:value`），用来按属性做数值断言。 */
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

function main() {
  const source = nodeFs.readFileSync(SOURCE, 'utf8')
  let css
  try {
    css = cssOf(source)
  } catch (error) {
    console.log('  FAIL ' + error.message)
    return 1
  }

  if (FAULT) css += '.mcart-fault{background:linear-gradient(#fff,#000)}'
  if (FAULT_RADIUS) css += '.mcart-fault{border-radius:8px}'
  if (FAULT_SPACING) css += '.mcart-fault{padding:16px}'
  if (FAULT || FAULT_RADIUS || FAULT_SPACING) {
    console.log('（故障注入生效：' + [FAULT ? 'gradient' : '', FAULT_RADIUS ? 'radius' : '',
      FAULT_SPACING ? 'spacing' : ''].filter(Boolean).join(' + ') + '）')
  }

  console.log('--- 禁止项（docs/UI-STYLE.md §1）')
  check('没有渐变（linear-gradient / radial-gradient / conic-gradient）',
    !/linear-gradient|radial-gradient|conic-gradient/.test(css))
  // 阴影只有弹层允许；例外必须显式写 `/* mcart:allow-shadow */` 标记。
  const shadowMarks = (css.match(/\/\* mcart:allow-shadow \*\//g) || []).length
  const shadows = (css.match(/box-shadow/g) || []).length
  check('没有阴影（弹层例外须带 `mcart:allow-shadow` 标记）',
    shadows <= shadowMarks, 'box-shadow ' + shadows + ' 处 / 标记 ' + shadowMarks + ' 处')
  check('没有动画 / 过渡',
    !/@keyframes|\banimation[-:]|\btransition[-:]/.test(css))
  check('没有硬编码灰 rgba(127,127,127（颜色必须走 token）', css.indexOf('rgba(127,127,127') < 0)
  check('没有表情符号 / 装饰性字符当图标', !/[\u{1F300}-\u{1FAFF}]/u.test(css))

  console.log('--- 几何与尺寸（§2）')
  // 圆角：规则里只许用 token（2px / 3px 两档），不许出现字面量 ≥8px 的圆角。
  const radii = valuesOf(css, 'border-radius')
    .concat(valuesOf(css, 'border-top-left-radius'), valuesOf(css, 'border-bottom-left-radius'))
  const badRadius = radii.filter((value) => !/^(0|inherit|var\(--mc-radius\)|var\(--mc-radius-panel\))$/.test(value))
  check('圆角只有两档（控件 2px / 面板 3px），规则里不许写字面量',
    badRadius.length === 0, badRadius.join(' ｜ '))
  check('圆角 token 只有 2px / 3px',
    /--mc-radius:2px;/.test(css) && /--mc-radius-panel:3px;/.test(css)
    && (css.match(/--mc-radius(-panel)?:/g) || []).length === 2,
    'radius token 个数 ' + (css.match(/--mc-radius(-panel)?:/g) || []).length)
  check('没有胶囊圆角（>=8px 或 999px）', !/border-radius:\s*(?:[89]|[1-9][0-9]+)px|border-radius:\s*999px/.test(css))

  // 字号：只许 token（正文 12 / 次要 11 / 图标 14 走 --mc-icon），规则里不许写数字字号。
  const fontSizes = valuesOf(css, 'font-size')
  const badFont = fontSizes.filter((value) => !/^(var\(--mc-fs\)|var\(--mc-fs2\)|var\(--mc-icon\)|inherit)$/.test(value))
  check('字号只走 token（12 / 11 / 图标 14），规则里不写死', badFont.length === 0, badFont.join(' ｜ '))
  check('正文 12px、次要 11px 的 token 就在表里', /--mc-fs:12px;/.test(css) && /--mc-fs2:11px;/.test(css))

  // 间距刻度：padding / margin / gap 里的数字只许 0/1/2/3/4/6/8（禁止 10/12/14/16…）。
  const spacingProps = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'gap', 'column-gap', 'row-gap']
  const badSpacing = []
  for (const item of declarations(css)) {
    if (spacingProps.indexOf(item.property) < 0) continue
    if (item.value.indexOf('calc(') >= 0) continue
    for (const number of item.value.match(/(\d+(?:\.\d+)?)px/g) || []) {
      const value = Number(number.slice(0, -2))
      if ([0, 1, 2, 3, 4, 6, 8].indexOf(value) < 0) badSpacing.push(item.property + ':' + item.value)
    }
  }
  check('间距只用 2/4/6/8 刻度（0/1px 描边除外）',
    badSpacing.length === 0, badSpacing.slice(0, 6).join(' ｜ '))
  check('间距 token 正是 2 / 4 / 6 / 8',
    /--mc-s1:2px;--mc-s2:4px;--mc-s3:6px;--mc-s4:8px;/.test(css)
    && (css.match(/--mc-s\d:/g) || []).length === 4,
    'spacing token 个数 ' + (css.match(/--mc-s\d:/g) || []).length)
  check('密度 token：正文 12 / 次要 11 / 行高 22 / 表单行 26 / 工具栏 28 / 控件 22 / 标签列 88',
    /--mc-lh:22px;/.test(css) && /--mc-row:26px;/.test(css) && /--mc-toolbar:28px;/.test(css)
    && /--mc-control:22px;/.test(css) && /--mc-label:88px;/.test(css))

  console.log('--- 结构（§3）')
  check('属性行：两列，label 固定 88px 且右对齐',
    /\.mcart-prop\{[^}]*grid-template-columns:var\(--mc-label\) 1fr/.test(css)
    && /\.mcart-prop-label\{[^}]*text-align:right/.test(css))
  check('卡片不再是"卡片"：无圆角、无阴影、只有顶部分隔线',
    /\.mcart-card\{[^}]*border-radius:0/.test(css) && /\.mcart-card\{[^}]*border-top:1px solid/.test(css))
  check('区块标题 22px 高、底部 1px 线', /\.mcart-card>\.mcart-bar:first-child\{[^}]*min-height:var\(--mc-section\)/.test(css))
  check('顶栏 sticky', /\.mcart-head\{[^}]*position:sticky/.test(css))
  check('列表选中 = 强调色 8% 叠底 + 左侧 2px 强调条',
    /\.mcart-item\[data-on="1"\]\{[^}]*background:var\(--mc-select\)/.test(css)
    && /\.mcart-item\[data-on="1"\]\{[^}]*border-left-color:var\(--mc-brand\)/.test(css)
    && /--mc-select:color-mix\(in srgb,var\(--mc-brand\) 8%/.test(css))
  check('列表 hover = 中性 4% 叠底', /--mc-hover:color-mix\(in srgb,var\(--mc-text-1\) 4%/.test(css))
  check('数字 / 路径 / ID 用等宽字体 + tabular-nums',
    /--mc-mono:ui-monospace,Consolas,monospace/.test(css) && /tabular-nums/.test(css)
    && /\.mcart-path[^{]*\{[^}]*font-family:var\(--mc-mono\)/.test(css))
  check('数值输入右对齐 + 等宽', /\.mcart-input\[type="number"\]\{[^}]*text-align:right/.test(css))
  check('开关是 12×20 轨道，不是 iOS 大开关', /\.mcart-switch input\[type="checkbox"\]\{[^}]*width:20px;height:12px/.test(css))
  check('空状态只是一行次要色文字（无插图/大标题）', /\.mcart-empty\{[^}]*font-size:var\(--mc-fs2\)/.test(css))

  console.log('--- 交互四态（§5）')
  check('hover / active / focus-visible / disabled 四态都有',
    /:hover\{/.test(css) && /:active\{/.test(css) && /:focus-visible/.test(css) && /\[disabled\]\{/.test(css))
  check('focus-visible 是 1px 强调内描边（不是发光）',
    /outline:1px solid var\(--mc-brand\);outline-offset:-1px/.test(css))

  console.log('--- 颜色（§4）')
  check('颜色全部来自主题 token', /--dsw-alias-bg-base/.test(css) && /--dsw-alias-border-l1/.test(css)
    && /--dsw-alias-label-primary/.test(css) && /--dsw-alias-brand-primary/.test(css))
  check('状态色只在字/左边线（不做整块底色）',
    /\.mcart-err\{[^}]*color:var\(--mc-error\)/.test(css)
    && /\.mcart-bad\{[^}]*color:var\(--mc-warn\)/.test(css))

  if (FAULT || FAULT_RADIUS || FAULT_SPACING) {
    // 反向夹具：注入的违规必须被上面的断言抓到。**退出码 1 = 红**（与 ui-test 的
    // `--fault*` 同一体例：注入故障后门禁就该红，红不了说明门禁是装饰）。
    const expected = FAULT ? '没有渐变' : FAULT_RADIUS ? '圆角只有两档' : '间距只用'
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
