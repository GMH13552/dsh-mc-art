# The panel (`mcart`)

A Cordis plugin in this deployment. It is the **hand** that edits a project's
atlas; the `mc-art` engine is what draws. Everything it writes lands in the
project's own pack, so the skill and the engine see the change immediately — there
is no second copy to sync.

Entry points: a tab named **MC 资产** in the right column, or the centre panel.

## What is on screen

```
MC 资产            [物品列表] [⚙]
<资产根目录>        [换项目] [刷新]
┌ 菜单：群系 / 结构 / 实体 / 方块  （每个项目一组，点一项就在 3D 里打开）
├ （编辑器卡片，打开时才有）
├ （搭建器卡片 = 结构/群系的格子编辑器，打开时才有）
├ （物品浏览器卡片，展开时才有）
└ 3D 取景框：模型 + 底部一层 2D 物品栏（九格）
  ── 底边拖动条：上下拖动改高度，双击复位（140–760 px）
  ── 画布下面：一行说明（只有真有问题时才出现）
```

### The 3D view and its hotbar

- **拖动旋转，滚轮缩放**，右上角 `＋ / － / ⟲`（复位视角）。底边有一条**拖动手柄**
  调整这块的高度；双击复位。
- 底部是**游戏样式的物品栏**：本项目物品，**九格一页**，`‹ ›` 翻页，
  选中格有白框，物品名浮在栏上方，末页用空格子补齐；**会动的图标跟着模型同一个
  50 ms 时钟**。
- **没有 3D 可看时，把 2D 画进取景框**：物品只有物品模型（没有方块模型）时，
  用物品自己的贴图在中间画一块正方形。这时画布下面是说明，不是黑框。
- 取景框里**只有**名字和九格。任何告警都在**画布下面**——取景框里的每一行都会
  让画布移位，而画布一动，指针底下的东西就变（"抽搐"就是这么来的）。

### The item browser (`物品列表`)

- **来源**：`本项目 <命名空间>`，加上参考目录里每个模组/原版命名空间（带方块数）。
- **搜索**、**展示形式** chips（方块/工具/盔甲/刷怪蛋/物品）、**细分** chips（id 尾段）。
- 每页 **40 格**（8×5），缩略图是烘出来的 data URL。
- 点一格：本项目且**有方块**的 → 直接在 3D 里打开它；**没有方块模型的**（材料类）
  → 只显示图标（并在画布下面说清楚）；参考的 → 走 `atlas.preview` 预览。
- 面板打开时会**自动取一次本项目物品**，所以物品栏不是空的。

### `✎ 手动修改`（像素编辑器）

- 工具：**铅笔 / 油漆桶 / 取色 / 橡皮**；调色板 + 不透明度；**撤销 24 步**。
- 一张贴图一个页签；方块还有**按面**的页签（同一张图铺在哪些面上）。
- **保存** 走 `atlas.saveTexture`：先写临时文件 → 校验是不是 PNG → 才替换原文件。
  **只写项目 pack 里的贴图**；参考（jar 里）的贴图会明确拒绝。
- 平铺物品的贴图 id 是 `ref:` 句柄，宿主会用它从抽取器那里拿到的 `textureFiles`
  解析成真文件（`stat` 确认过），所以**物品贴图也能改**。
- 已知限制：物品浏览器的缩略图**烘一次就记住**（`itemUrls`），手动改完贴图后
  那一格可能还是旧图，重开面板才刷新。

### `@ 提意见`

在输入框上方挂一条"引用给 AI"，把 `@<路径>` 插进输入框。路径是**资产的身份**：

- 方块/实体/群系/结构 → atlas 里的那条引用（`<项目>/mc-art.atlas.json` 或模型文件）；
- **只是物品**的 → 它的 `models/item/<id>.json`（"图标为什么长这样"的成因文件）；
- 参考（jar 里）的资产 → 没有文件可引用，面板会**明说**，而不是给一个死按钮。

设置保存成功后，设置卡里还会多一行 **`告诉 AI`**：把
`@<项目>/mc-art.settings.json` **和一句"改了什么"**一起放进输入框——
因为动态插件没法往会话里推消息，通知只能这样做：**一句话 + 一次点击**。

### `⚙ 设置`

- **参考目录**：游戏目录或某个版本目录（`.minecraft` / `versions/<版本>`）。
  "选择目录…"优先用系统自己的对话框；识别出形状（版本、贴图数、资源文件数）后
  还会列几个**检测到的**候选让你一键采用。
- **includeGenerated**（把项目自己已产出的贴图也当参考，避免新方块向原版石头的
  风格漂移）与 **includeMods**，以及**逐个 mod 的开关**（新装的 mod 默认是开的）。
- 保存写 `atlas.saveSettings` → `<项目>/mc-art.settings.json`。
  **这就是技能侧读的那份文件**（`mc_art.project_settings`），不是第二份。

## What it writes (and refuses)

| 动作 | 宿主调用 | 写到哪 |
|---|---|---|
| 保存一张贴图 | `atlas.saveTexture` | `<项目>/pack/assets/<ns>/textures/…png`（连 `ref:` 句柄也解析到项目文件） |
| 保存结构/群系格子 | `atlas.saveVoxel` | `<项目>/mc-art.atlas.json` 的 `cells` |
| 保存设置 | `atlas.saveSettings` | `<项目>/mc-art.settings.json` |

**它拒绝**：写项目 pack 之外的任何路径（画笔不是通用文件写入器）；把结构写成空；
同一个格子放两个方块；对没有解码成功贴图的资产开编辑器（会说明原因）。

## What the panel does NOT do

- 它不改 Java 代码，不编译，不跑游戏。**行为验证在游戏里**（见 `gametest.md`）。
- 它不生成 datagen 输出。它在 `pack/` 里改的就是资源**唯一真相**；
  mod 工程里的那份资源应当由 datagen 从 atlas 生成，而不是手写。
