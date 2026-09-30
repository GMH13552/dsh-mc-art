# dsh-mc-art-panel

MC 资产面板的**真包**形态：装进 profile 就在，不用在会话里发射动态插件。

```bash
dsh plugin --profile web add /path/to/dsh-mc-art/panel    # 或 npm 上的包名
# 重启 DSH → 右侧栏出现「MC 资产」
```

## 它凭什么"装完就在"

`package.json` 里三个字段决定一切（形状照 `@deepseek-ai/dsh-*` 的包抄的）：

```json
"main": "lib/index.js",
"exports": { "./client": "./lib/client.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": [...] } }
```

`dsh plugin … add` 把包记进 profile 的 `dsh.profile.bundles`，启动时 `cordis.patch.yml`
把自己的那一行插进组合——`dsh --profile <名> --dump-config` 里能看到：

```
# == dsh-mc-art-panel
- id: mcart-panel
  name: dsh-mc-art-panel
```

## 升级之后记得重启进程

宿主的行是启动时挂载的，`dsh plugin add` 只换文件：不重启的话，客户端可能已经热重载成新版，
而宿主还是老实例（实测症状：面板报 `宿主没有这个方法：…`）。桌面端要把 Electron 主进程也退出
（托盘常驻时关窗口不算），命令行起的 web 则 `Ctrl-C` 后重启。

## 这个包带什么

装一个包，面板、模式、两个 skill 一起到位——不需要再跑仓库里的安装器，也不会往你的
用户目录写任何东西：

```
panel/                        包根
├── lib/                      宿主与客户端（由 build.mjs 从 tools/mcart-plugin/ 生成）
├── cordis.patch.yml          ① 把面板插进组合  ② 把包内预设目录注册成 agent-presets 的一个 root
└── preset/mc-studio/         「MC 模组工作室」模式
    ├── agent.cordis.yml      预设的宿主组合（自带 skill-filesystem 行）
    ├── preset.yml            名字与说明
    └── skills/               随预设走的 skill：mc-mod、mc-art
```

**多大**：解包后约 1.1 MB（压缩后 306 kB）——`lib/` 250 KB、`mc-art` skill 826 KB
（引擎 `mc_art/` + 60 个测试 + 文档；它就是一份完整可离线用的美术引擎）、`mc-mod` skill 41 KB、
模式本身 17 KB。

`panel/preset/` 是**打包时生成的**（`prepare` → `panel/vendor.mjs`），仓库里不留副本：
所以这个仓库不携带 mc-art 的内容（它是独立仓库）。

**里面没有任何美术素材**：参考贴图/模型是引擎在运行时扫 asset root、版本 jar、mods 得到的
（那是 `mc-art` 的设计，不是打包进来的资源）。砍掉的是纯垃圾：`.git`、`__pycache__`、`*.pyc`、
`.pytest_cache`、`.cache`（含 `references/.cache/` 那份派生缓存——它跟机器和资产相关，
随包发还可能给出过期结果）。排除之前磁盘副本虚胖到 2.4 MB；npm 打包时本来也会排掉一部分，
但那不该是唯一防线。

两处机制，都照 DSH 出厂预设的做法：

- **模式**：`cordis.patch.yml` 给 `agent-presets` 那一行加了一个 root（`trust: system`），
  路径用 `!!js` 从 `baseUrl` 算 —— 在 profile 组合里 **`baseUrl` 就是 profile 目录**（实测），
  所以 `node_modules/dsh-mc-art-panel/preset` 正好落在装好的包上。
- **skill**：预设自己带 `skills/`，用
  `process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))` 定位
  （预设组合里 `baseUrl` 是**预设自己的目录**）。这正是出厂 `cordis` 预设带它那两份
  composition skill 的方式；web 组合里基础的 `skill-filesystem` 行是 disabled 的，
  **本地 skill 归预设管**。

`cert`：`mc-art` 是独立仓库（有自己的历史），这里放的是它的一份**快照**（发布时从克隆复制，
约 2.9 MB）。想跟上游最新：跑仓库里的 `install.mjs`，它会把 mc-art clone/更新到
`~/.dsh/skills/mc-art`；`~/.dsh/skills` 是默认 skill 根，两边不会冲突（同名时预设层优先）。

怎么验（本机真跑过）：用 DSH 自己的发现逻辑扫装好的包 ——

```bash
# 在某个装了这个包的 profile 里
node -e 'import("/…/@deepseek-ai/dsh-agent-presets/lib/index.js").then(async (m) => {
  const r = await m.discoverPresets([{ path: "/…/profiles/<名>/node_modules/dsh-mc-art-panel/preset", trust: "system" }],
    new URL("file:///…/@deepseek-ai/dsh/"))
  console.log(r.map((p) => p.id + " / " + p.name + " / broken=" + (p.broken ?? "no")).join("\n"))
})'
# → mc-studio / MC 模组工作室 / broken=no
```

## 同一份源码，两种送达

`lib/` 是**生成物**（`node build.mjs`），来源是仓库里的 `tools/mcart-plugin/{host,client}.js`
——和动态插件用的是同一份源码。这个包只是把两半各包一层壳：

| | 动态插件 | 真包 |
|---|---|---|
| 宿主 `harness.handle` | 运行时注入 | `lib/index.js` 收成一张表 + 一条 `POST /api/mcart/call` 派发路由 |
| 客户端 `React` / `host` / `styles` | 运行时注入 | `require('react')` / `fetch` / 插 `<style>` |

所以面板的行为改动**只改一处**（那两份源码），两边都跟着变。

### 客户端模块的 id 就是包名（踩过一次）

`lib/client.js` 里的 `window.__ModuleLoader__.load({ id })`，那个 id **必须是包名**
（`dsh-mc-art-panel`）。dsh 的 client-modules 按启动图里那一行的 id 去 factories 里找模块，
找不到只在页面顶上写一行 `Failed to load plugins`：

```js
// dsh-client-modules/lib/client.js
if (!this.factories.has(id)) throw new Error(`bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
```

曾经这里抄成了宿主行的名字 `mcart-panel`：包装得上、`--dump-config` 里有那一行、
两个入口单独测都过，**页面上却什么都不出现**。现在 id 从 `package.json` 的 `name` 读一份
（`build.mjs` 里的 `PACKAGE_NAME`），`entry-test.mjs` 与 `serve-check.mjs` 都拿同一个真相来判。

### shell 在 Windows 上是 PowerShell，不是 bash

面板的宿主半要起 Python、要写二进制贴图，这些都经过 DSH 的 shell 服务。而 DSH 按平台换 shell：
POSIX 上是 `bash -c`，**Windows 上是 `pwsh … -Command <整串>`**（`dsh-base` 的 `cordis.patch.yml`
里 bash 那几行在 win32 上 disabled、pwsh 那几行启用）。所以 `$(printf … | base64 -d)`、`rm -f`、
`mv -f`、`command -v` 一个都不能写死——宿主现在探一次方言，然后按方言拼：

| 要做的事 | POSIX | PowerShell |
|---|---|---|
| 传一个参数 | `"$(printf %s <base64> | base64 -d)"`（绕开所有引号问题） | `'值'`（单引号里 `''` 表示一个 `'`） |
| 判断有没有某个命令 | `command -v x` | `(Get-Command 'x' -ErrorAction SilentlyContinue) -ne $null` |
| 删 / 移 | `rm -f` / `mv -f` | `Remove-Item -Force` / `Move-Item -Force` |
| 把 base64 解成文件 | `base64 -d < 暂存 > 目标` | `[IO.File]::WriteAllBytes(目标, [Convert]::FromBase64String([IO.File]::ReadAllText(暂存)))` |

**图片数据不进命令行**：Windows 的命令行总长上限约 32767 字符，一张 128×128 贴图的 base64
就有几十 KB。所以 base64 先用 `fs.writeText` 当文本落成一个暂存文件（同一条 sandbox 策略），
shell 只做"把这个文件解成字节"这一件事——命令行里永远只有路径。

`node tools/mcart-plugin/shell-dialect-test.js` 验这件事：它把 shell 桩装成 Windows PowerShell，
捕获宿主真正发出的命令，然后**逐条交给真的 Windows PowerShell 执行**，最后比对贴图字节；
`--fault` 让探针谎报 POSIX，要求门禁变红（实测：正常 12 项全绿，谎报 8 项红）。

## 宿主服务缺席时，面板自己还有退路

`fs` 和 `shell` 都是**组合里可能不在**的行。用户在 Windows 桌面端（0.2.0-rc.2）实测到过：
面板能扫描、能弹系统目录对话框，点"在这里新建项目"却回一句
「建目录失败：pack（宿主没有 shell 服务时建不出目录）」——而那句话是**猜的**
（`ensureDir` 只看了 exitCode，既没查服务在不在，也没把 shell 自己的报错带回来）。

现在每一件事都有退路，且**走哪条路会写在结果里**（面板会提示「目录用 … 建的」）：

| 要做的 | 第一条 | 第二条 | 第三条 | 最后一条 |
|---|---|---|---|---|
| 建目录 | `directoryPickerController.createDirectory`（harness 自己的"新建文件夹"API，非递归，缺父目录时先补父目录） | `shell`（按方言 `mkdir -p` / `[IO.Directory]::CreateDirectory`） | `fs.writeText(<目录>/.gitkeep)` —— `dsh-fs-local` 的 writer 第一件事就是 `mkdir recursive`，代价是空目录里多个 `.gitkeep` | `node:fs` 垫片 |
| 写文本 | `fs.writeText`（带显式 sandbox 策略） | `shell` 重定向 | `node:fs` 垫片 | — |
| 写字节（贴图） | `fs` 落 base64 暂存 + `shell` 解码 | `node:fs` 垫片直接写字节 | — | — |
| 移 / 删 | `shell` 方言 | `node:fs` 垫片 | — | — |
| 读（扫描/预览） | `fs` 服务 | `node:fs` 垫片 | — | — |

`node:fs` 垫片在**宿主入口里自带**（`build.mjs` 生成 `lib/index.js` 时内联，改不了发布包的行为
也不依赖仓库里的 `tools/`）。它排在最后是有意的：它绕过宿主的 sandbox 策略（不产生文件效应记录、
不触发审批），只有前面几条都不可用时才用，结果里会写明 `via=node:fs`。

四条路全断时，错误里会**逐个点名**每一条说了什么，而不是含糊一句"没有 shell 服务"。
想知道这台机器上到底有什么，问一句 `atlas.env`：它回 `{fs, shell, sessions, webServer,
directoryPickerController, localFs}` 的在场情况、shell 方言、platform 与 node 版本。

门禁：`node tools/mcart-plugin/project-test.js` 用 `buildHandlers()` 把"谁缺席"造成四种状态
（只有 fs / 只有垫片 / 只有目录选择器 / 什么都没有），并逐条断言结果与 `via`；
把任意一条退路掐掉（变异测试做过：掐垫片 → 8 项红；掐 fs 那条 → 3 项红；去掉"先建项目目录" → 3 项红），
门禁必须变红。`node panel/entry-test.mjs` 另外用**发布出去的那份 `lib/index.js`**、
在"一个服务都没有"的 ctx 上真建一个工程，证明垫片随着包发得出去。

## 注释剥离器吞过 313 行代码（0.1.13 之前每个版本都中）

`lib/` 里的源码是 `tools/strip_comments.py` 剥掉注释后的结果。老规则是"任意位置的
`/* … */`"，而宿主源码里有一句**行注释**提到了 glob：

```js
// Forge keeps every mod in versions/<version>/mods/*.jar.  So "scan the
```

那个 `/*` 被当成块注释开头，一路吃到 313 行之后的 `*/`。发出去的宿主因此**少了十个声明**：
`SCAN_SCRIPT`、`EXTRACT_SCRIPT`、`REFERENCE_MAX_BYTES`、`toolPaths`、`findTool`、
`findScanner`、`PYTHON_CANDIDATES`、`resolvePython`、`itemRoots`、`roots` —— 整条参考/提取通道。
生成物照样解析、`verify-build` 照样绿（它比对的是"再剥一次"的结果，自证不了），
直到用户点开 ⚙ 设置，页面回一句 `findScanner is not defined`。
实测：`0.1.2` 到 `0.1.12` 每一份发布物都缺这两个定义。

现在三件事一起：

* 规则改成**行首才算**（`^[ \t]*/\*`）：行内 `/*` 一律不碰——宁可少剥一层，不能吞代码；
* 触发它的两处注释改写了措辞（含 glob 的那句、`models/item/*` 那句）；
* 新增 `tools/strip_gate.py`：比对注释源与生成物里**声明的名字**，少一个就红；
  `--fault` 用同一份夹具做 A/B（新规则一个都不吞、老规则必吞），证明这条检查能红。
  同时 `entry-test.mjs` 从**行为**层面再拦一次：对发出去的那份真跑
  `atlas.settings` / `atlas.refNamespaces` / `atlas.refBlocks` / `atlas.refItems`，
  任何 `is not defined` 都算失败。

复现验证（做过）：把规则改回贪婪版 + 按原样插回那句 glob 注释 → `strip_gate.py` 报
「缺 labelFor、localOf、messageOf、policyFor、prefix、rel、tries」，`entry-test.mjs` 报
`localOf is not defined`，两个门禁同时红。

## 参考目录：对话框不可靠，所以必须能手输

用户在 Windows 上点开 ⚙ 设置、点"选择目录…"，**没反应，也没有报错**。两个原因叠在一起：

* 那个按钮靠系统对话框，而对话框在有些环境里既不显示也不返回（shell 服务跑在非交互
  窗口站上时，`FolderBrowserDialog` 就是这么个结局）——按钮于是永久停在"对话框已打开…"；
* 设置卡当时**不渲染 `notice`**，而且**没有任何手动输入路径的地方**，所以"没反应"之后
  真的没有下一步。

四条改动：

1. 设置卡里加了**手输框 + "用这个路径"**：对话框弹不出来时把路径贴进去就行
   （`.minecraft`、版本目录、mods 目录、单个 jar 都接受）；
2. 设置卡现在也渲染 `notice` / `failure`，失败一定有字；
3. `runPicker` 有 120 秒上限：超时就放开按钮，并写明"请把路径贴进下面的输入框"；
4. `detectGameRoots` 原来只认 WSL 形状的路径（`/root/.minecraft`、`/mnt/c/Users/…`、
   `/home/…`），在原生 Windows 上一条都不成立 —— 所以"检测到 … 用它"那一栏永远是空的。
   现在按平台给候选（`%APPDATA%\.minecraft`、`~/Library/Application Support/minecraft`、
   `~/.minecraft`）、**加上工程旁边的** `.minecraft`/`run`、并展开启动器实例目录一层
   （CurseForge / Prism / MultiMC 的容器里才是真正的游戏目录），逐个 `stat` 只报存在的。
   想知道"它到底去哪儿找过"，`atlas.gameRoots` 一条命令回候选与命中。

门禁：`node panel/ui-test.mjs` —— 一个只实现 `createElement`/`useState`/`useEffect` 的假 React
真渲染一遍设置卡，然后**按按钮的文字去点**，断言：手输框在、`用这个路径` 在、检测到的候选
带 `用它`、对话框不可用时**原因出现在设置卡里**、打字后点按钮真的把路径写进
`atlas.settings`。`--fault` 把那一行输入框从源码里删掉，要求这些断言变红。
`node tools/mcart-plugin/roots-test.js` 用 Windows 形状的环境变量造一棵假树，
断言候选/命中/展开/上限都对；`--fault` 换回老的 WSL 形状逻辑，要求它**找不到**这台机器。

## 门禁

```bash
node panel/verify-build.mjs   # lib/ 与源码去注释后重新生成的结果逐字节比对（挡漂移）
node panel/entry-test.mjs     # 两个入口真的加载/apply/派发；含一次真注入
node panel/ui-test.mjs        # 假 React 真渲染设置卡并按文字点按钮（--fault 证明能红）
node tools/mcart-plugin/roots-test.js  # 参考目录检测按平台给候选（--fault 证明老逻辑找不到）
python3 tools/strip_gate.py   # 剥离器不许吞代码：声明的名字一个都不能少（--fault 证明能红）
node panel/serve-check.mjs --url http://127.0.0.1:3099 --token <token>   # 真送达：对着跑着的实例查
```

`serve-check.mjs` 管的是前两个门禁够不着的那一层——**装进 profile 之后，浏览器到底收到没有**。
它对着一个真在跑的实例：读首页启动图里我们那一行 → 取 bundle 真实字节与 `lib/client.js`
逐字符比对 → 用真浏览器打开页面，要求我们的客户端半留下激活痕迹
（它 apply 时会插一个 `<style data-plugin="dsh-mc-art-panel">`）且没有 `Failed to load plugins`。

临时实例的起法（验证完就该删）：

```bash
dsh plugin --profile mcart-check add /path/to/dsh-mc-art/panel
# 把 "@deepseek-ai/dsh-web-app" 加进那个 profile 的 package.json 的 dsh.profile.bundles
dsh --profile mcart-check --port 3099 --no-open     # 启动日志里会打带 token 的 URL
node panel/serve-check.mjs --url http://127.0.0.1:3099 --token <那串 token>
```
