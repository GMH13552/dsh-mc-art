# 在这台机器上用 CUA 自查面板 UI（可复现）

面板的视觉/交互问题，靠"读代码"是看不出来的（历史上因此漏过：报告在撒谎、状态截断、
布局裁切）。这个仓库现在有一条**能自己看**的通路：官方的 computer-use provider + 本机已装的
CUA 驱动，agent 可以自己开面板、自己截图、自己放大核对。

> 本文件里**不写任何具体的机器路径或用户名**（发布门禁会拒绝）。命令里一律用环境变量或
> 占位符表达；本机实际位置按占位符替换即可。

## 组成（都是官方件）

| 件 | 说明 |
|---|---|
| `cua-driver`（本机已装） | 由 Cua 的 Windows 安装器装到 `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\`，并加入 PATH；`Get-Command cua-driver` 能找到即可 |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp@<与 DSH 相同版本>` | 官方 npm 包（maintainers 含 `@deepseek.com` 账号，仓库 `deepseek-ai/deepseek-harness` 的 `packages/experimental/computer-use-cua-driver-mcp`） |
| `@deepseek-ai/dsh-computer-use@<同版本>` | 官方 `computerUse` 服务（provider 的 peer） |
| `<仓库>/.local/cua-bundle/`（**已 gitignore**） | 本地 bundle：根导出的默认类提供服务，`./provider` 子路径挂 provider；`node_modules` 自带上面两个包 |

## 为什么用"本地 bundle 包一层"

- provider 包**不是 bundle**（没有 `dsh.bundle`），`plugin_manager install_bundle <包名>` 会以
  `not-bundle` 拒绝；
- pnpm 对 `link:` 形式的 bundle **不会**把它声明的依赖装进 profile；
- 而 profile 解析行名只从**它自己的** `node_modules` 开始 —— 所以让 bundle 自己成为宿主：
  `index.js` 提供 `computerUse` 服务（re-export 官方 Service 类），`provider.js` re-export provider，
  `cordis.patch.yml` 显式插**两行**（`install_bundle` 不会自动为 bundle 自身插行）。

## 挂载 / 重装

```powershell
# 依赖只装一次（在 bundle 目录里）：npm install
plugin_manager install_bundle  target = <仓库>\.local\cua-bundle
```
装好后这套 MCP 工具会出现：`mcp__cua-driver-mcp__{list_windows,get_window_state,click,type_text,...}`。

**宿主侧改动需要彻底重启 DSH 才生效**：Node 的 ESM 缓存按**路径**命中，重新 enable 拿到的还是
旧模块；这也是"重建之后宿主变成 0 个方法"的根因。

## 截图评审的标准动作

1. `list_windows` → 找 `DeepSeek Harness.exe` 的 `pid` + `window_id`；
2. `get_window_state(pid, window_id, include_accessibility_tree:false, include_screenshot:true, max_dimension:1600)`
   → 返回窗口截图（Electron 的 UIA 树只有 3 个元素，**a11y 走不通，只能靠像素**）；
3. 打开面板：右上角"右侧栏"图标的像素坐标 ≈ `(窗口截图宽 - 23, 59)`（1568×1000 的截图空间）；
4. 面板空状态会**自动列出会话目录下的模组工程**，点「用本会话目录」即可进入资产列表；
5. `zoom(pid, window_id, x1,y1,x2,y2)` 放大细节（区域宽 ≤ 500），逐条对照
   [`docs/UI-STYLE.md`](./UI-STYLE.md) 评审；
6. 文字输入：Chromium 的输入框**后台投递会被丢**，必须 `delivery_mode:"foreground"`（驱动会临时
   切前台、输入、还原焦点）；UIA `set_value` 在 Electron 上不可用。

## 已知坑

- 坐标属于"**返回的那张截图**"的像素空间（`max_dimension` 会缩放）；窗口被移动/缩放后要**重新截图**
  再点；
- 前台投递要求目标窗口能被激活；如果桌面当前没有前台窗口（锁屏 / 用户切走），
  `press_key`/`type_text` 的 foreground 会失败——**此时不要盲目重试**，等窗口回到前台或让用户按一次键；
- 面板落点有竞态：重启后有时落在**中央面板**而不是右侧栏（右侧栏服务晚挂载）；0.3.2 起会自动重试
  迁移并撤掉回退落点；
- 面板宿主在**反复重建 + HMR** 之后可能变成"已卸载且 0 个方法"：0.3.2 起界面会给可执行提示并自动
  重试一次；彻底恢复仍需重启 DSH。
