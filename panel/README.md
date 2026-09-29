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

## 门禁

```bash
node panel/verify-build.mjs   # lib/ 与源码去注释后重新生成的结果逐字节比对（挡漂移）
node panel/entry-test.mjs     # 两个入口真的加载/apply/派发；含一次真注入
```
