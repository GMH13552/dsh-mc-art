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
python ../../tools/mcmod_gametest.py          # 裁决 + 机器可读 JSON
python ../../tools/mcmod_gametest.py --fault  # 必须失败，否则这个闭环是摆设
```

## 三、快速开始

### 1. 一条命令装好

```bash
git clone https://github.com/GMH13552/dsh-mc-art.git
sh dsh-mc-art/install.sh   # Windows: dsh-mc-art\install.bat
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

`presets/mc-studio/` 是一个 agent preset（**模式**）：装好之后，模式选择里就有
**MC 模组工作室**。它 = 完整编码/文件/命令能力 + 两个 skill 的路由 + 一段"工作室"人格
（先读 `mc-mod`/`mc-art`、面板从哪来、裁判怎么跑、版本矩阵在哪）。

```bash
node install.mjs     # 或 sh install.sh / install.bat：装 skill + 模式 + 面板包
```

**这个模式刻意不带 `tool-cordis`。** 那套工具集能动态挂载插件，但它注册的 Host Inspect provider
是**进程级**的：同一进程里已经有别的会话用着它时，这一行会**挂载失败**并报
`Host Cordis inspect provider "Service" is already registered`（实测；出厂的创造模式用的是同一行、
同一个注册表）。面板因此改由**装进 profile 的真包**提供（见第五节），模式自己不需要那套工具集
——于是"完整 / 无 Cordis"两个模式并成了一个。要改面板源码，用仓库里的 loader 动态发射一次
（开发用，见 `panel/README.md`）。门禁 `node tools/check_presets.mjs` 盯着"别把那一行加回来"。

### 升级插件后必须**彻底退出**应用（关窗口不够）

宿主那一半（`mcart-panel` 那一行）是**进程启动时挂载**的：升级只换了磁盘上的文件，
老进程里挂着的那份宿主还活着，于是你会看到"客户端是新的、宿主是旧的"这种怪事 ——
实测症状：面板报 `宿主没有这个方法：atlas.pickDirectory`，而在别的启动顺序下同一个包一切正常。

- **Electron 桌面端**：任务管理器里把 `DeepSeek Harness.exe` 及其子进程都结束掉，再启动
  （托盘常驻时关窗口不算退出）。
- **命令行起的 web**：`Ctrl-C` 那个进程即可，然后重新 `dsh web`。

判据很简单：**换了包版本 → 必须重启进程**。客户端那半会热重载，宿主那半不会。

### 两代 DSH 对"预设"的模型不一样（踩过）

| | 0.1.x（本仓库开发用的这套） | 0.2.0-rc.x（Windows 桌面端） |
|---|---|---|
| 包 | `dsh-agent-presets`（复数） | `dsh-agent-preset`（单数）+ `…-registry` |
| 预设从哪来 | **扫目录**：`.agent-presets/`、包内 root（`roots` 键） | **组合里的行**：`@deepseek-ai/dsh-agent-preset`，config = `{id,name,description,order,plugins}` |
| 注册表 Config | `roots` / `includeShippedRoot` / `includeUserRoot` | 只有 `default` / `selectedDefault`（**没有 roots**） |

所以"包内 `preset/` + 给 `agent-presets` 行加一个 root"这招在桌面端会**无声失效**（它打在
一个不存在的行 id 上，而我们验证过"打不存在的行无害"）。同一批行换一种送达方式就行：
`presets/mc-studio/desktop-generation.patch.yml` 是把源预设的 18 行包成一条
`@deepseek-ai/dsh-agent-preset`（skill 那行指到装好的包
`node_modules/dsh-mc-art-panel/preset/mc-studio/skills`），追加到该 profile 的
`cordis.patch.yml` 末尾、重启即生效。⚠️ 这份是**手工生成**的（还没接进 `build.mjs`），
改源预设时要一起重新生成。

（另：桌面端那代的 skill 根照旧扫 `~/.dsh/skills`，所以 skill 只靠用户目录也能送达。）

## 五、DSH 插件

**面板在 npm 上叫 `dsh-mc-art-panel`，而且它不只是面板**：包里同时带着「MC 模组工作室」模式
和两个 skill（`mc-mod` + `mc-art`），装一个包就全有 —— 不用再跑安装器，也不往用户目录写东西。
别人拿到它有三条路，都验证过：

**一条命令装好**（已发布到 npm：`dsh-mc-art-panel@0.1.0`）：

```bash
dsh plugin --profile web add dsh-mc-art-panel
# （桌面端 profile 通常叫 desktop：--profile desktop）
# 国内想走镜像：加 --registry=https://registry.npmmirror.com/（已同步，实测）
# 不想依赖 npm：dsh plugin --profile web add \
#   https://github.com/GMH13552/dsh-mc-art/releases/latest/download/dsh-mc-art-panel.tgz
# 重启 DSH → 右侧栏出现「MC 资产」
```

| 怎么给 | 别人怎么装 | 备注 |
|---|---|---|
| **npm 包名**（现在走这条） | 插件对话框里填 `dsh-mc-art-panel`，或上面那条命令 | 实测：装完 bundles 里有它、组合里有 `- id: mcart-panel`；npmmirror 已同步 |
| Release tarball | 上面注释里那条 URL | 不需要 npm 账号；文件名不带版本号 + `releases/latest/download/` = 命令永久有效 |
| 本地目录 | `dsh plugin --profile web add /path/to/dsh-mc-art/panel` | 克隆了仓库的人 / 改面板源码时用 |

打包与发版（我这边已经做过一次，记下来）：

```bash
cd panel && npm pack --pack-destination /tmp          # 出 dsh-mc-art-panel-0.1.0.tgz
gh release create v0.1.0 /tmp/dsh-mc-art-panel-0.1.0.tgz --title … --notes …
cp /tmp/dsh-mc-art-panel-0.1.0.tgz /tmp/dsh-mc-art-panel.tgz
gh release upload v0.1.0 /tmp/dsh-mc-art-panel.tgz --clobber   # 不带版本号的那份，给 latest/download 用
```

⚠️ **不要填本仓库的 GitHub 地址**：包在 `panel/` 子目录里，pnpm 会把整个仓库当成一个
`0.0.0` 的空包装上（**不报错**），但它没有 `dsh.bundle.patch`，于是不会进 bundle 栈——
用户看到的是"装好了但什么都没发生"。DSH 判定"装上来的算不算插件"看的就是这一条。

发布（需要你的 npm 账号，本机 `npm adduser` 之后）：

```bash
cd panel
npm version patch        # 或 minor/major；版本号是别人升级的唯一线索
npm publish              # prepublishOnly 会先跑 verify-build + entry-test，漂移就发不出去
npm view dsh-mc-art-panel version   # 回读确认
```

发完之后，`node install.mjs --panel-spec dsh-mc-art-panel` 就是纯 npm 路径了（默认仍用本地目录，
这样克隆仓库的人离线也能装）。DSH 目前**不支持插件自动更新**，升级 = 改版本号重发，别人重新装。

**发布这件事上的几个坑**（都值得先说清）：

- **装不用登录，发必须登录**，而且要一个**邮箱已验证**的免费账号：<https://www.npmjs.com/signup>。
  命令行侧 `npm login`（npm 9+ 默认走浏览器授权：它打印一个网址，在浏览器里点一下即可；
  WSL 里自动开浏览器可能失败，把网址复制到 Windows 浏览器打开也一样）。
- **不想走浏览器就用 Token**：网页 → 头像 → Access Tokens → Generate New Token（发布用
  **Automation** 类型），然后 `npm config set //registry.npmjs.org/:_authToken=<token>`。
  开了 2FA 时这条最省事（否则每次发布都要 OTP）。Token 是密码级的东西，别提交进仓库。
- **发布只能去官方 registry**：`registry.npmmirror.com` 是只读镜像，往那儿 publish 会被拒。
  如果你为装包把 registry 换成了镜像，发布时要显式指回官方：
  `npm publish --registry https://registry.npmjs.org/`。
- **名字被占就加 scope**：`@你的用户名/dsh-mc-art-panel`。客户端注册的 id 是从 `package.json`
  的 `name` 读的，所以改名后 id 自动跟着变（不用动代码）；`publishConfig.access: public`
  已经设好了（scoped 包不加这个会被当成私有、发不出去）。

- **GitHub topics**：`dsh-plugin`、`deepseek-harness`、`cordis-plugin`、`agent-skill`、
  `minecraft`、`minecraft-mod`、`gametest`
- **形态**：DSH 动态 Cordis 插件（host 半 + client 半）。两半由 `new Function` 编译，
  所以运行时注入的绑定必须**逐个显式传参**（host：`harness`/`console`/`TextEncoder`/`btoa`/`atob`；
  client：`React`/`host`/`styles`/`console`）——少一个就会在浏览器页里炸，
  而那边只能看到 Run 卡片上一句 `x is not defined`。
- **门禁**：`node tools/mcart-plugin/loader-test.js` 用真实的两个半文件跑通加载器，
  并注入"少传一个绑定"证明它会当场炸。
- **真包形态与"送达"门禁**：`panel/` 是同一份源码包成的真包（`dsh plugin --profile web add <路径>`）。
  它有四道门：`verify-build.mjs`（挡漂移）、`entry-test.mjs`（两个入口真的装载，`--fault` 会红）、
  `serve-check.mjs`（**对着跑着的实例**查启动图 + bundle 字节 + 真浏览器里的激活痕迹）。
  第三道不是装饰：客户端 bundle 必须注册成**包名**，早先抄错成宿主行的名字，
  包能装、前两道全绿，**页面上却什么都不出现**。细节见 `panel/README.md`。

## 六、通用流程与版本

- **流程（七阶段）**：定目标 → 定有什么 → 出美术 → 写 atlas → 生成代码/资源 →
  **游戏内验证** → 人眼验证 → 分支与移植，每阶段写清"什么算过"：
  `skills/mc-mod/references/workflow.md`
- **版本矩阵**：`≤1.12.2` **没有 GameTest**（只有"能编译、服务端起来、日志干净"）；
  Forge 的 GameTest 要 `1.18.1+ / 39.0.88+`；1.18.2 实测 `Java 17 / DataVersion 2975 /
  pack_format 9-8-9`；"怎么查而不是猜"（读 `version.json`、`javap` 映射 jar）：
  `skills/mc-mod/references/versions.md`
- **Windows（原生，不需要 WSL）**：安装用 `install.bat`（POSIX 用 `sh install.sh`，两者都是
  薄壳，逻辑在同一份 `install.mjs` 里）。要注意三件事，都是实测过的：
  1. **Python 的名字**：Windows 上没有 `python3`，装完叫 `python` 或 `py`。面板宿主、
     三门禁、GameTest 工具都会自己探测（`python3` → `python` → `py -3`），你只要让它进 PATH。
  2. **shell 不是 bash**：DSH 在 win32 上把 bash 那几行 disabled、启用 PowerShell
     （`dsh-base` 的 `cordis.patch.yml`）。所以面板里所有 shell 命令都按方言拼
     （`rm -f`/`mv -f`/`$(printf|base64 -d)` → `Remove-Item`/`Move-Item`/`.NET`），
     门禁 `node tools/mcart-plugin/shell-dialect-test.js` 会把捕获到的命令**交给真的
     Windows PowerShell 执行**来验（本机跑过：12 项全绿；谎报方言则 8 项红）。
  3. **JDK 版本要对**：1.18.2 的模组要 **JDK 17**；只有 21 会在 Gradle/Forge 配置阶段就失败。
  `./gradlew` 在 Windows 上是 `gradlew.bat`，`tools/mcmod_gametest.py` 自己会选。

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
