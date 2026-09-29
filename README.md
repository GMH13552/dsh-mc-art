# dsh-mc-art · 从描述到可验证的 Minecraft mod

> A Cordis panel plugin for the DeepSeek Harness + the **mod-making skill**, plus a
> verification loop that lets **the real game** decide whether a mod is correct.
>
> **DSH 插件 + 做模组的 skill + 一个裁判。** 插件负责看和改，skill 负责流程，
> 裁判是 Mojang 自带的 `GameTestServer`（无窗口服务端，**退出码 = 失败的必要测试数**）。

美术引擎在另一个仓库：[`GMH13552/mc-art`](https://github.com/GMH13552/mc-art)
（确定性引擎：扫描资源根 / 出证据 / 栅格化 / 度量）。这个仓库**不含**它的副本 ——
同一个东西放两个仓库就会漂移。

---

## 里面有什么

| 路径 | 是什么 |
|---|---|
| `skills/mc-mod/` | **做模组的 skill**：插件说明书、通用流程（七阶段）、版本矩阵、GameTest 闭环、踩过的坑 |
| `tools/mcart-plugin/` | **面板插件**（DSH 动态 Cordis 插件）源码 + 加载器 + 门禁 |
| `tools/mcart_extract_block.py` | 抽取器：把一个方块/物品读成几何 + 贴图 + 表现形态（1.12.2 / 1.18.2 两套规则） |
| `tools/mcart_scan_refs.py` | 参考扫描：从游戏目录/模组 jar 里列出命名空间与方块 |
| `tools/mcmod_gametest.py` | **判定工具**：跑 `GameTestServer`、读退出码、解析日志、给裁决；`--fault` 注入错误断言 |
| `fleshland/mod/` | 一个**完整可运行的模组骨架**（Forge 1.18.2）：故意不带资源，只带代码 + 两条 GameTest |
| `presets/mc-studio/` | **MC 模组工作室**模式（agent preset）：把面板能力 + 流程 + 裁判包装成一个可选的模式 |
| `panel/` | 面板的**真包**形态：`dsh plugin --profile web add <路径>` 装进 profile，重启就在（不用发射动态插件） |

## 一、面板（`mcart`）

一个 Cordis 动态插件，把项目里的资产变成可以**看和改**的东西：

- **3D 取景框 + 游戏样式的九格物品栏**：选中格白框、翻页、名字浮层；**没有 3D 可看时
  把 2D 形式画进取景框**（物品只有物品模型时）；底边可拖动改高度（140–760 px，双击复位）。
- **物品浏览器**：按来源（本项目 / 原版 / 每个模组）、展示形式（方块/工具/盔甲/刷怪蛋/物品）、
  细分家族筛选，一页 40 格；点一格就放到 3D 里看。
- **像素编辑器**：铅笔 / 油漆桶 / 取色 / 橡皮，调色板、不透明度、撤销 24 步，方块可按面编辑；
  保存走"临时文件 → 校验是 PNG → 才替换原文件"，**只写项目自己的资源包**。
- **结构 / 群系编辑器**：按格放置（左键破坏、右键放置），带朝向、撤销与保存。
- **`@ 提意见`**：把资产的身份（atlas 引用，或物品的 `models/item/<id>.json`）插进输入框；
  设置改完还能一键把"改了什么"连同 `mc-art.settings.json` 一起插进去。
- **⚙ 设置**：参考目录（游戏目录或某个版本目录）、已产出的贴图是否也当参考、逐个模组开关。

面板**只写三个接口**：`atlas.saveTexture` / `atlas.saveVoxel` / `atlas.saveSettings`，
且只写进项目自己的包，从不写进 jar。完整说明书：`skills/mc-mod/references/panel.md`。

## 二、判定：让游戏自己说

`GameTestServer` 跑完注册的测试就退出，**退出码 = 失败的必要测试数量**。
本仓库实测（Forge 1.18.2 / 40.2.0）：

| 跑法 | 服务端说 | 退出码 |
|---|---|---|
| 正常 | `All 2 required tests passed :)` | 0 |
| `--fault`（把断言改错） | `fleshblockplaces failed! 放下去的血肉块不是血肉块 at 1,-59,1 (relative: 1,1,1)` + `1 required tests failed :(` | 1 |

首次构建约 26 分钟（Gradle + MC/Forge 依赖 + 450 MB 资源），之后**每次约 1 分钟**。

```bash
cd fleshland/mod
python3 ../../tools/mcmod_gametest.py          # 裁决 + 机器可读 JSON
python3 ../../tools/mcmod_gametest.py --fault  # 必须失败，否则这个闭环是摆设
```

## 三、快速开始

### 1. 一条命令装好

```bash
git clone https://github.com/GMH13552/dsh-mc-art.git
sh dsh-mc-art/install.sh
```

它做五件事：装 `mc-mod`；**把美术引擎 `mc-art` 拉下来**（已存在就 `git pull --ff-only`）；
把面板加载器里的 `MCART_HOME` **指向这次克隆的真实路径**（不用再手改）；装模式 `mc-studio`；
自检依赖（Python / Pillow / JDK）。可重复执行。

**面板有两种装法**（同一份源码，`panel/` 里是真包）：

```bash
dsh plugin --profile web add "$PWD/panel"    # 真包：重启 DSH 就在，不用发射
```

或者用动态插件（`loader.host.js` + `loader.client.js` 交给 `cordis_define`/`cordis_run`）——
模式的人格已经写了**会话开始时自己拉起来，不用等你开口**。
之所以还要发射，是因为它现在是**动态插件**——重启就没了。要做到"重启就在"，得按官方那条
文件级插件路径打包（`package.json` 的 `exports["./client"]` + `dsh.client` 元数据，
再用 `dsh plugin --profile <名> add`），那是一次独立的打包工程。

```bash
sh install.sh --no-cordis-tools   # 把模式里的 Cordis 工具行关掉（见第四节的限制）
```

> **美术引擎不是子模块，但它会被自动装。** `install.sh` 会 clone（或更新）它。
> 为什么不做成 `git submodule`：它有自己的仓库、历史和节奏，本来也独立可用（一台确定性引擎）；
> 子模块会把它钉在某个 commit 上（更新要手动 bump），而最常见的坑是 `git clone` 忘了
> `--recursive` —— "装好了"却少了半个引擎。想手动装也一样：
> `git clone https://github.com/GMH13552/mc-art.git ~/.dsh/skills/mc-art`

### 2. 用面板（作为 DSH 动态插件）

面板由一次 `cordis_define` 定义、`cordis_run` 激活。但**发射的不是整个插件源码，
而是一个加载器**（`loader.host.js` + `loader.client.js`，各约 1.3 KB）——
它在激活时从仓库读 `host.js` / `client.js` 并执行。好处：改界面不用再把 200 多 KB
逐字重打一遍，**重跑同一个包**即可。

⚠️ **安装时改一处**：`loader.host.js` 顶部的

```js
const MCART_HOME = '/home/gmh/mc-art/tools/mcart-plugin'
```

改成你自己的克隆路径；把它的内容作为 `code.host`、`loader.client.js` 作为 `code.client`
交给 DSH 的 `cordis_define`，再 `cordis_run`。

> **代价说清楚**：运行的就是磁盘上那份源码——审批粒度从"这一份代码"变成"那个文件以后的内容"。

### 3. 依赖

| 需要 | 用来做什么 |
|---|---|
| Node + DeepSeek Harness | 跑面板插件 |
| Python 3.10+ | 抽取器、扫描器、判定工具 |
| JDK 17 | 编译/运行 1.18.2 的模组（1.20.5+ 要 21） |
| 一份 Minecraft 安装 | 当**参考目录**：原版/模组的模型与贴图从那里读 |

## 四、作为独立模式（agent preset）

`presets/mc-studio/` 是一个 agent preset（**模式**）：把它拷到
`${DSH_HOME:-$HOME/.dsh}/.agent-presets/mc-studio/`，重启 DSH 后模式选择里就有
**MC 模组工作室**。它 = 完整编码能力 + Cordis 工具（用来把面板拉起来）+ 一段"工作室"人格
（先读 `mc-mod`/`mc-art`、面板怎么激活、裁判怎么跑、版本矩阵在哪）。

```bash
cp -r dsh-mc-art/presets/mc-studio ~/.dsh/.agent-presets/
```

**一条已知限制（实测）**：它的 `tool-cordis` 行会注册 Host Inspect provider，而那个注册表是
**进程级**的——所以**同一进程里不能同时有两个带 Cordis 工具集的会话**。这不是本模式引入的：
出厂的"创造模式"用的是同一行、同一个注册表，性质一样（验证方式：在已有 Cordis 会话的进程里
挂载一份同样的行 → `Host Cordis inspect provider "Service" is already registered`）。
想让它和别的模式并存，把那行加 `disabled: true`（代价：模式里不能自己激活面板）。
`agent.cordis.yml` 的其余部分已通过 `standingKeyFor` 真挂载验证。

## 五、DSH 插件

- **GitHub topics**：`dsh-plugin`、`deepseek-harness`、`cordis-plugin`、`agent-skill`、
  `minecraft`、`minecraft-mod`、`gametest`
- **形态**：DSH 动态 Cordis 插件（host 半 + client 半）。两半由 `new Function` 编译，
  所以运行时注入的绑定必须**逐个显式传参**（host：`harness`/`console`/`TextEncoder`/`btoa`/`atob`；
  client：`React`/`host`/`styles`/`console`）——少一个就会在浏览器页里炸，
  而那边只能看到 Run 卡片上一句 `x is not defined`。
- **门禁**：`node tools/mcart-plugin/loader-test.js` 用真实的两个半文件跑通加载器，
  并注入"少传一个绑定"证明它会当场炸。

## 六、通用流程与版本

- **流程（七阶段）**：定目标 → 定有什么 → 出美术 → 写 atlas → 生成代码/资源 →
  **游戏内验证** → 人眼验证 → 分支与移植，每阶段写清"什么算过"：
  `skills/mc-mod/references/workflow.md`
- **版本矩阵**：`≤1.12.2` **没有 GameTest**（只有"能编译、服务端起来、日志干净"）；
  Forge 的 GameTest 要 `1.18.1+ / 39.0.88+`；1.18.2 实测 `Java 17 / DataVersion 2975 /
  pack_format 9-8-9`；"怎么查而不是猜"（读 `version.json`、`javap` 映射 jar）：
  `skills/mc-mod/references/versions.md`
- **Windows**：整套是跨平台的，但有 6 处 POSIX 假设正在修（`python3`、`command -v`、
  贴图保存用的 `rm/printf|base64 -d/mv`、`./gradlew`、`mc-art` 的 bash 启动器、文档命令拼法）。

## 七、实测记录（不是宣传）

- GameTest：正常绿 / 注入红（见上表）。
- 正交相机的贴图插值：条纹宽度 **1.03**（正确）vs **2.81**（旧的透视插值，远侧压到一半）。
- 面板点击偏移：盒子比画宽时，点"画出来的左边缘"会被算成**第 4 格**（该是第 0 格）。
- 平铺图标曾因"依赖活的 `<img>`"而**全空（0 像素）**，立方体不受影响。

## 八、没包含什么

- 美术引擎（`mc-art`）的副本 —— 它在[自己的仓库](https://github.com/GMH13552/mc-art)里。
- 本地美术项目与个人笔记：这是**工具**仓库，不带创作数据。
- `fleshland/mod/` 故意**不带资源**：一个命名空间有两份资源就是两个真相；
  模组工程里的那份资源应当由 datagen 从 atlas 生成。

## 相关仓库

- [`GMH13552/mc-art`](https://github.com/GMH13552/mc-art) —— 美术 skill（确定性引擎）
- [`GMH13552/mc-art-pipeline`](https://github.com/GMH13552/mc-art-pipeline) —— 旧架构，已归档
- [`GMH13552/dsh-longrun-suite`](https://github.com/GMH13552/dsh-longrun-suite)、
  [`GMH13552/dsh-timer-scheduler`](https://github.com/GMH13552/dsh-timer-scheduler) —— 其他 DSH 插件

## 许可

未附许可证。要开源请加一个 `LICENSE`（例如 MIT）。
