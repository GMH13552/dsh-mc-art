// ── 为什么整个 body 在 `installHost(ctx)` 里（后来人最容易踩的地方）──────────────────
//
// 宿主源码不在一个文件里：真源是 `tools/mcart-plugin/host/` 下的片段，按
// `host.manifest.json` 的顺序**逐字节拼接**成 `tools/mcart-plugin/host.js`（barrel），
// 再由 `panel/build.mjs` 嵌进产物。拼接结果是一个**共享作用域**（片段之间禁 import/export，
// 顶层命名必须唯一）——它整体被包在宿主模块的函数体里，所以最后一个片段
// （`99-entry.js`）的顶层 `return { apply(ctx) { … } }` 就是插件对象。
//
// 因为片段**全部排在入口之前**，body 不能直接写在 `apply(ctx) { … }` 里：那样入口必须在
// 中间。所以 body 原样搬进 `function installHost(ctx) { … }`（函数声明提升），入口只调它一次。
// 语义等价：同一个 `ctx`、同一次执行、同样的顺序；body 里没有顶层 `return`，返回值都是 undefined。
//
// 哪些块**只能整体搬、不能抽成独立片段**（否则就得先抽接口，那是行为风险）：
//   · 任何直接读写闭包状态的函数 —— `preloads` / `langs` / `indexCache` / `textureCache` /
//     `referenceTextures` / `referenceAnimations` / `referenceBlocks` / `vanillaTextureHandles`
//     / `pythonLauncher` / `errors` / `sessions`（下面这一批 let/const 就是它们）；
//   · 任何调 `fsOf()` / `shellOf()` / `subprocessOf()` / `sessionsOf()` 的访问层
//     （`localOf` / `statOf` / `readBytesOf` / `runProcess` / `resolvePython` / `runScanner` …）
//     —— 它们要的是**每次现取**的服务，缓存就错（见下面那条 ⚠️）；
//   · `ctx.effect(() => harness.handle(…))` 的 handler 注册表和结尾的 ready 日志
//     —— 它们**在安装时立即执行**，必须留在 body 末尾、按原顺序。
//
// 搬块规则（批次化拆分时照这个来，别踩）：
//   1. 只能按原顺序搬（拼接顺序 = 清单顺序），中间有块不能跳——要搬后面的，先把它前面的
//      按序搬成片段；
//   2. 可以安全地跨片段移动的：纯函数（数学/几何/解析）、纯常量表（`VANILLA_PARENTS` 之类）、
//      以及不依赖初始化顺序的 `const map = new Map()`；
//   3. 搬完必须 `node panel/build.mjs`（重建 barrel）+ `node panel/source.mjs --check`
//      （barrel == 清单拼接，逐字节）+ `node tools/gates.mjs` 全量。
function installHost(ctx) {
    // ⚠️ 这三个服务**不能在这里缓存**。宿主半和别的行谁先挂载不由我们决定：冷启动时
    // `ctx.get('shell')` 可能还是 undefined，缓存下来就永久是"没有这个服务"
    // —— 桌面端实测就是这个症状：面板写着「宿主没有 shell 服务，请在下面的输入框里直接填路径」，
    // 而同一份包在别的启动顺序里一切正常（和客户端"重启回左栏"是同一个毛病）。
    // 每次用的时候现取，代价是一次属性查找。
    const fsOf = () => ctx.get('fs')
    const sessionsOf = () => ctx.get('sessions')

    // 最近一次从面板听到的会话 id。`atlas.scene` 不带它，但 `atlas.session`/
    // `atlas.settings` 每一次开面板都会带 —— 通知 agent 时用它找到"这个会话的那个 agent"。

    // 同一件事只通知一次：渲染是每帧跑的，不去重就是刷屏。判据是**报告文本本身**，
    // 所以"修了一半、失败原因变了"会再通知一次，"还是同一个毛病"不会。

    /**
     * 把一条报告投进当前会话那个 agent 的上下文（下一个 step 边界就看见）。
     *
     * 为什么是注入而不是"生成一段话让用户去粘"：模组模型千奇百怪，失败原因只有 agent
     * 自己能判；把它投进上下文，它就能自己决定补模型、改 parent、还是回去问人。
     * 官方路径是 `Agent.steer(UserMessage)`（`dsh-agent-loop` 的 `Agent`），退路是
     * `Agent.inbox.append('next-step', …)`；两样都拿不到就把尝试过的路原样带回去。
     * `UserMessage` 的形状在类型里是 `@deepseek-ai/dsh-llm` 的导出，这里**逐层试**并
     * 如实报告哪一层成的 —— 猜一个形状然后说"发不出去"是最没用的结果。
     */
    const shellOf = () => ctx.get('shell')
    const errors = []
    let preloads = new Map()
    let langs = new Map()
    const indexCache = new Map()
    const textureCache = {}
    // Reference (vanilla / mod) blocks are pulled out of the game's jars on
    // demand and held only while something actually uses them.  Nothing here is
    // ever written to disk.
    const referenceTextures = new Map()
    // How to play each extracted animated texture.  Keyed exactly like
    // `referenceTextures`, because a texture id travels alone through the
    // quads and this is the only thing that can tell the viewer "this one is a
    // 16x80 strip of 5 frames at 5 ticks each".
    const referenceAnimations = new Map()
    const referenceBlocks = new Map()
    const refSignatures = new Map()
    let hasWslpath = null

