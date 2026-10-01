// The plugin's real code lives in the repository and is READ FROM DISK when this
// package activates.  What is emitted is only this file.
//
// Why: every change to the panel used to cost re-typing ~233 KB into one
// `cordis_define` call (94 of those in a single session), and a restart lost the
// plugin entirely.  A one-line CSS fix is not worth that.
//
// THE TRADEOFF, STATED PLAINLY.  What runs is whatever
// `tools/mcart-plugin/{host,client}.js` contain **at activation time**.
// Approving this package approves that arrangement, not one frozen copy of the
// code -- a grant here means "run the files", so an edit to those files takes
// effect the next time the package is activated.
//
// This is a TRACKED, PUBLIC file, so the committed value must be a neutral
// placeholder -- never a real machine path (that leaks somebody's home directory
// into the repository, and it is wrong for everyone else anyway).
// `install.mjs` rewrites this line to the local clone when you run it, and the
// shipped panel does not use this file at all (the npm package has a real
// `cordis.patch.yml`); this is only the dynamic-plugin dev path.
const MCART_HOME = '/path/to/dsh-mc-art/tools/mcart-plugin'

return {
  async apply(ctx) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('动态插件里没有 fs 服务，读不了 ' + MCART_HOME)
    const read = async (half) => {
      const path = MCART_HOME + '/' + half + '.js'
      const target = await fs.resolve(path)
      const text = await fs.readText(target)
      if (typeof text !== 'string' || text.length === 0) throw new Error(path + ' 是空的')
      return text
    }
    // Registered BEFORE the first await, because the client half asks for its own
    // source through this handle and both halves belong to the same run.
    const cache = {}
    ctx.effect(() => harness.handle('mcart.source', async (args) => {
      const request = args || {}
      const half = request.half === 'client' ? 'client' : 'host'
      if (cache[half] === undefined) cache[half] = await read(half)
      return { half: half, text: cache[half] }
    }))
    const text = await read('host')
    // `Function` is the same constructor the runtime uses to evaluate a package
    // body.  If a sandbox ever drops it, say so here rather than throwing a bare
    // ReferenceError 200 lines later.
    if (typeof Function !== 'function') {
      throw new Error('这个宿主沙箱里没有 Function，加载不了仓库源码（只能退回整包发射）')
    }
    // COMPILED IN GLOBAL SCOPE, so the wrapper's own bindings are NOT inherited:
    // everything host.js uses that the runtime injects has to be a parameter.
    // (`ctx` arrives as `apply`'s argument; the intrinsics come with the realm.)
    const inner = new Function('harness', 'console', 'TextEncoder', 'btoa', 'atob',
      text)(harness, console, TextEncoder, btoa, atob)
    if (inner === null || typeof inner !== 'object' || typeof inner.apply !== 'function') {
      throw new Error('mcart 宿主源码没有返回一个带 apply 的插件')
    }
    console.log('mc-art：宿主源码读自 ' + MCART_HOME + '/host.js（' + text.length + ' 字符）')
    await inner.apply(ctx)
  },
}
