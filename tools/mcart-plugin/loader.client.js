// See loader.host.js: the real client half is fetched from the host and evaluated
// here, so an edit to client.js needs no new package.
//
// `inject` lists what the LOADED half reaches for on ctx.  The runtime can only
// see THIS plugin object's declarations -- the inner plugin's own `inject` is not
// registered with the runtime -- so a service the inner half uses would otherwise
// be rejected as an undeclared dependency.  Adding a service to client.js means
// adding it here too.
return {
  inject: ['timer'],
  async apply(ctx) {
    let reply = null
    // The host half registers its handler before its first await, but the two
    // halves are activated in the same run and this one can win the race.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        reply = await host.call('mcart.source', { half: 'client' })
      } catch (error) {
        reply = null
      }
      if (reply !== null && reply !== undefined && typeof reply.text === 'string'
        && reply.text !== '') break
      await ctx.timer.timeout(250)
    }
    if (reply === null || reply === undefined || typeof reply.text !== 'string' || reply.text === '') {
      const shape = reply === null || reply === undefined ? String(reply)
        : Object.keys(reply).join(',')
      throw new Error('取不到 mcart 客户端源码（返回的字段：' + shape + '）')
    }
    if (typeof Function !== 'function') {
      throw new Error('这个客户端沙箱里没有 Function，加载不了仓库源码（只能退回整包发射）')
    }
    // `React`, `host` and `styles` are the names a client half does not declare
    // for itself.  `Function` compiles in GLOBAL scope, so the wrapper's
    // bindings are not inherited -- every one of them has to be a parameter, or
    // the loaded half sees a bare `styles is not defined`.
    const inner = new Function('React', 'host', 'styles', 'console', 'PANEL_VERSION',
      reply.text)(React, host, styles, console, 'dev')
    if (inner === null || typeof inner !== 'object' || typeof inner.apply !== 'function') {
      throw new Error('mcart 客户端源码没有返回一个带 apply 的插件')
    }
    await inner.apply(ctx)
  },
}
