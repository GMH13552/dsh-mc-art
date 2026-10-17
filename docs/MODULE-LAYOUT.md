# 模块布局：片段 → barrel → `lib/`

面板插件的两半源码（`tools/mcart-plugin/host.js`、`client.js`）是**生成物**。
真源是 `tools/mcart-plugin/<half>/` 下的**片段**，按 `tools/mcart-plugin/<half>.manifest.json`
里的顺序拼接。这份文档说明怎么增删片段、片段有什么规则、门禁怎么验证。

## 一、三个角色

```
tools/mcart-plugin/host/            host 的片段（多个 .js，共享作用域）
tools/mcart-plugin/host.manifest.json  片段顺序（JSON 字符串数组，**入口片段列最后**）
tools/mcart-plugin/host.js          **生成物**：barrel = 清单拼接结果 = 完整源码
tools/mcart-plugin/client/…         client 同理
tools/mcart-plugin/client.manifest.json
tools/mcart-plugin/client.js        **生成物**

panel/source.mjs                    **唯一**拼接实现（读清单 → 拼；`--write` 写 barrel）
panel/build.mjs                     先 `--write` 再生成 panel/lib/（去注释 + 内联包装）
panel/verify-build.mjs              校验 barrel == 清单拼接（逐字节）且 lib == 源码
tools/gates.mjs                     全量门禁（46 条）
tools/mcart-plugin/client-body.js   门禁的**取体助手**（不是片段，不进任何清单）
```

`tools/mcart-plugin/client-body.js` 是门禁用的工具脚本，不是插件源码的一部分：
它不参与拼接、不出现在 `client.manifest.json` 里，也不会被 build 打进 `lib/`。
`icon-test.js` / `icon-render-test.js` 用它把"整段顶层声明"取出来求值 —— 以前它们用
`indexOf('const sub =')` … `indexOf('const CSS = [')` 做字符串下标切片，那要求 CSS 必须
排在绘制代码之后，**等于门禁在决定片段顺序**（拆分后顺序一换就切空、exit 2）。现在与
片段顺序无关：去掉最后那个顶层 `return {…}`（插件对象），剩下的声明整段求值，
门禁在尾部 append 自己的 `return {…}` 暴露要测的名字。源码形状不对时它明确抛错，
不会静默切出空区域。

为什么 barrel 还要留一份完整源码：仓库里有 15+ 个门禁、`install.mjs` 的加载器改写、
以及随包物的对比都直接读 `host.js`/`client.js`。让 barrel 保持**完整源码**（只是内容由
片段生成），这些消费者零改动；真源的唯一性由 `panel/source.mjs` 保证。

## 二、片段的规则

1. **共享作用域**：片段是同一段函数体的一部分，**禁止 `import`/`export`**（也不要用
   `require` 的模块语法）——拼接后它们在同一作用域里互相可见。
2. **每个片段必须以换行结尾**：拼接是逐字节的（`parts.join('')`），少了换行会把下一段
   粘在同一行。`source.mjs` 会直接报错。
3. **顺序即语义**：清单顺序就是拼接顺序。顶层 `const`/`function` 在被使用之前定义。
4. **入口片段列最后**：入口负责 `return { apply(...) }`（host）或客户端注册（client），
   它必须能看到前面所有片段里的声明。
5. 清单路径**相对 `tools/mcart-plugin/`**；不许 `..`、不许绝对路径、不许重复项。
6. 片段目录里的 `.js` 文件如果没进清单，**不会**被拼接；而"片段目录有文件、清单却是空的"
   会直接报错（这是故意的：静默忽略片段的症状是"某些函数突然不存在"）。

## 三、增删片段

新增一个片段：

```bash
# 1) 在对应的片段目录里新建一个片段文件：
#    编号前缀 + 领域名（.js 结尾、文件末尾留一个换行）
#    例：host 下新建 "40-域名字.js"，client 下同理
# 2) 把它按位置写进清单（入口保持最后）：
#    tools/mcart-plugin/host.manifest.json 或 tools/mcart-plugin/client.manifest.json
node panel/source.mjs --write     # 或 node panel/source.mjs host --write 只写一半
node panel/build.mjs              # build 自己会先 --write，再生成 lib/
node tools/gates.mjs              # 全量门禁
```

删除片段：从清单里删掉那一行 → 删文件 → `node panel/source.mjs --write` → `node panel/build.mjs`。
**不要手改 barrel**：它会在下一次 `--write`/build 时被覆盖；手改造成的漂移由
`panel/verify-build.mjs` 的 `barrel == 拼接` 断言当场抓住（`--fault-barrel` 证明它会红）。

## 四、过渡期（legacy）与报错

| 状态 | 行为 |
| --- | --- |
| 清单 `[]` 且片段目录不存在 | **legacy 单文件模式**：barrel 就是真源，行为不变（本机制上线时的兼容态） |
| 清单 `[]` 但片段目录里有 `.js` | **报错**：列出被静默忽略的片段，要求写进清单 |
| 清单指向不存在的文件 | **报错**：点名文件与完整路径 |
| 清单不是字符串数组 / 有重复 / 有 `..` / 片段缺结尾换行 | **报错** |

`node panel/source.mjs --check` 会打印当前是 `split` 还是 `legacy`，并在 split 模式下
逐字节比对 barrel 与拼接结果（不一致退出码 1）。

## 五、门禁怎么验证

- `panel/source.mjs --selftest`：临时树里证明拼接顺序、`--write`、`--check`、四种报错，
  以及 `--fault` 下"老行为（忽略清单）会丢声明"。
- `panel/verify-build.mjs`：`barrel == 清单拼接`（逐字节）＋ `lib == 源码`；
  `--fault-barrel` 把 barrel 弄坏，要求比对当场红。
- `tools/strip_gate.py`：`panel/source.mjs` 的拼接结果与 barrel 逐字节一致；
  **清单里每个片段声明的名字都出现在 barrel 里**（漏拼一个片段就会红）；
  剥注释后声明一个不少。
- `tools/mcart-plugin/report-test.js`：静态扫描的对象是**拼接源码**，并交叉验证
  barrel 与拼接一致（不是信任某个可能过期的副本）。
- `tools/gates.mjs`：46 条一起跑；任一条红退出码非 0。

## 六、常见问题

- **"barrel 与拼接结果不同"**：片段改了但没 `--write`/build。跑 `node panel/source.mjs --write`。
- **"清单指向不存在的文件"**：清单先落地、片段文件还没写（或名字拼错）。补齐文件或改清单。
- **"片段缺结尾换行"**：给文件末尾补一个 `\n`。
- **门禁直接读 barrel 看到旧内容**：先 `node panel/build.mjs`（它先 `--write`）。
  这是"生成物"的常态，和 `panel/lib/` 一样。
