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

## 门禁

```bash
node panel/verify-build.mjs   # lib/ 与源码去注释后重新生成的结果逐字节比对（挡漂移）
node panel/entry-test.mjs     # 两个入口真的加载/apply/派发；含一次真注入
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
