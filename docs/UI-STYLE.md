# UI 风格规范（v2：向「自媒体工作台」靠近）

这份规范是**判据**，不是灵感。做样式时逐条对照。

v1 走的是"专业检查器"路线（平、密、窄、静）。用户看过本机的 **自媒体工作台**（`dsh-media-desk`）之后
明确要求：**我们的前端向它靠近**。所以 v2 换语言：**卡片化、圆角、软阴影、衬线标题、点阵背景、胶囊控件**，
只在"必须快速扫读数据"的地方保留工具式密度。

参考实现就在本机：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-media-desk\dist\client.js`
（CSS 是一大段普通文本，设计变量以 `--ink/--card/--r-md/--ease` 命名，可直接对照）。

## 1. 反面清单（v1 残留的"太硬、太像仪表盘"）

- ❌ 纯平无容器的灰底面板（v1 的"去卡片化"）：现在**允许**卡片，但一屏最多两级（页面 → 卡片），不套娃
- ❌ 圆角只有 2/3px 的小方块控件；控件不再是"工具按钮"，而是**胶囊/圆角按钮**
- ❌ 12px 满屏、靠 1px 发丝线分割一切：改用**留白 + 卡片边界**
- ❌ 居中大标题只写"暂无数据"：空状态要有**衬线大字 + 计数 + 一句人话**
- ❌ 装饰性渐变/光斑滥用：渐变只允许出现在**封面/缩略图**这类内容物上，界面骨架不用
- ❌ 无语义的彩色：颜色一律来自 token；内容色（贴图、封面）不受限

## 2. Token 层（照抄参考实现的命名，全部映射 `--dsw-alias-*`）

```css
--ink: label-primary      --ink2: label-secondary   --ink3: label-tertiary
--ink4: label-caption     --on-primary: label-primary-inverted
--bg: bg-base             --card: bg-layer-2        --canvas: color-mix(in srgb, var(--ink) 3.5%, var(--bg))
--line: border-l2         --line-strong: border-l4
--hover: interactive-bg-hover   --active: interactive-bg-active
--primary: button-primary-fill  --primary-hover: button-primary-hover
--accent: link            --glass: color-mix(in srgb, var(--card) 72%, transparent)
--serif: "Songti SC","STSong","Noto Serif SC","Source Han Serif SC",Georgia,serif
--ease: cubic-bezier(.2,.8,.2,1)
--r-xs 4  --r-sm 8  --r-md 12  --r-lg 16  --r-xl 20  --r-panel 28
```

阴影只有两档：`--dsw-elevation-soft`（卡片默认）与 `--dsw-elevation-prominent`（浮层/弹窗）。

## 3. 字体与密度

| 用途 | 值 |
|---|---|
| 基准 | **14px / 22px**，`font-family: var(--dsw-font-family)` |
| 正文/表单 | 13–14px |
| 次要说明/单位 | 12px，`--ink3` |
| 卡片标题 | 15–16px，字重 600；**重要标题用 `--serif`** |
| 空状态大标题 | **26–28px 衬线**，允许"小字 + 大数字 + 小字"混排（如「还有 44 个方块 等你检查」） |
| ID / 路径 / 数字 | 12px `ui-monospace` + `tabular-nums` |
| 列表行高 | 26–28px（比 v1 的 22px 松，但不做 32+ 的"网页列表"） |
| 间距刻度 | 4 / 6 / 8 / 10 / 12 / 16 / 20 |
| 圆角 | 控件 `--r-sm`(8)，卡片 `--r-md`(12)，大容器 `--r-lg`(16)，面板/弹层 `--r-panel`(28)，胶囊 999 |
| 描边 | 1px `--line`；卡片可选 `inset 0 0 0 .5px var(--line-strong)` |
| 动效 | hover 150ms、展开 200ms、视图切换 300ms，`var(--ease)`；**禁止无限循环动画** |

## 4. 骨架与组件

- **背景**：`--canvas` + **点阵**（`radial-gradient` 小点，24px 步距，`--ink` 6% 透明度），让卡片"浮"起来。
- **顶栏**：左侧标题（衬线 16px）+ 右侧圆形图标按钮（26–28px，`--hover` 底）。
- **胶囊页签**：容器 `--r-sm` 圆角 + `--hover` 底；选中项 `--card` 底 + `--ink` 文字 + `--elevation-soft`。
- **卡片**：`--card` 底、1px `--line`、`--r-md` 圆角、`--elevation-soft`、内边距 12–14px。
  卡片标题行（衬线 15–16px + 右侧 12px 计数），内容区距标题 8–10px。
- **资产行**：行高 28px、圆角 8px；hover `--hover`、选中 `--active` + 左侧 2px `--accent` 条；
  左=名称 13px，右=id 12px mono `--ink3`（沿用 v1 的两列对齐，这条是对的，保留）。
- **3D 视口卡片**：`--canvas` 底、`--r-md`、内描边；控制按钮**圆形 26px**、`--glass` 底、浮在右下。
  地面网格与轴指示器保留（它们是功能，不是装饰）。
- **底部输入条（@ 提意见）**：胶囊 36px 高、`--card` 底 + 1px `--line`、左侧 14px 图标、
  占位文案 13px `--ink3`、右侧**圆形 26px 主色按钮**（插入后按钮短暂变为"已插入"）。
- **缩略图条**：24px 方块、8px 圆角、2px 间距，右上角 10px 计数徽标——用于物品栏/最近资产。
- **空状态**：居中的衬线大字 + 计数（真实数字，不许编）+ 一行 12px 说明 + 一个主操作胶囊按钮。
- **焦点**：`box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 50%, transparent)`，不用发光。

## 5. 与 v1 的取舍

| 保留 v1 | 换成 v2 |
|---|---|
| 两列资产行（名称 + 右侧 mono id） | 行高 22 → 28，行变圆角可 hover |
| mono + tabular-nums 显示数字/路径 | 字号 11 → 12 |
| 分组标题 sticky + 计数 | 从"发丝线标题"变成"卡片标题行" |
| 状态三态（空/加载/错误）都要有字 | 空态升级为衬线大字 + 真实计数 |
| 每轮门禁必须能红 | 不变 |

## 6. 判据（`ui-style-test.js` 要跟着改，不许放宽"能红"）

- 卡片：`border-radius: var(--r-md)` + `box-shadow: var(--dsw-elevation-soft)` + 1px `--line` 三者同时存在；
- 背景点阵：`radial-gradient` 且步距 24px；
- 空状态：`--serif` 且字号 ≥26px，且文本里含真实计数（不是"暂无"）；
- 输入条：高度 36px、圆角 999、右侧圆形按钮；
- 顶栏/页签：胶囊页签选中态用 `--card` 底；
- 动效：`transition` 时长 ∈ {120,150,200,300}ms 且使用 `--ease`；**没有** `animation` 无限循环；
- 圆角尺度：只允许 `--r-xs/sm/md/lg/panel` 与 999/50%；**禁止** 2/3px；
- 字号：只允许 11/12/12.5/13/14/15/16/26/28（±1 取整）；
- 行高：列表 28、正文 22、说明 18。
