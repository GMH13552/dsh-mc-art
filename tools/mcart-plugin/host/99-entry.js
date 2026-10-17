// ── 宿主入口 ────────────────────────────────────────────────────────────────
// 真源是 `tools/mcart-plugin/host/` 下的片段，按 `host.manifest.json` 的顺序拼接；
// `tools/mcart-plugin/host.js` 是 `node panel/source.mjs host --write` 生成的 barrel，
// `panel/build.mjs` 把那份源码嵌进产物。改行为请改片段，不要改 barrel。
//
// body 在 `installHost(ctx)` 里而不是直接写在 `apply` 里：片段按清单拼接，body 的
// 各段（未来的 20-…、30-…）都排在入口之前，所以需要先定义、再在入口里调用。
// `installHost` 拿到的是同一个 `ctx`、按同一顺序执行 —— 除这层包装外与拆分前逐字节相同
// （本批次落地脚本用"把同一层包装套在旧源码上"做过逐字节比对）。
return {
  apply(ctx) {
    installHost(ctx)
  },
}
