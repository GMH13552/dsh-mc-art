const nodeFs = require('fs'), nodePath = require('path'), cp = require('child_process')
// Path is overridable so the SAME tests can be run against the source that was
// actually emitted, not just the local build.  Reading a hardcoded path made a
// "verify the emitted host" step silently test the local file instead.
const body = nodeFs.readFileSync(process.env.MCART_HOST || require('path').join(__dirname, 'host.js'), 'utf8')

const fsService = {
  async resolve(p) { return nodePath.resolve(String(p)) },
  async stat(p) {
    try { const s = nodeFs.statSync(p); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, version: String(s.mtimeMs) } }
    catch (e) { return undefined }
  },
  async listDir(p) {
    try {
      return nodeFs.readdirSync(p, { withFileTypes: true }).map((d) => {
        let size, version
        try { const s = nodeFs.statSync(nodePath.join(p, d.name)); size = s.size; version = String(s.mtimeMs) } catch (e) {}
        return { name: d.name, type: d.isDirectory() ? 'directory' : 'file', size, version }
      })
    } catch (e) { return [] }
  },
  async readText(p) { return nodeFs.readFileSync(p, 'utf8') },
  async readBytes(p) { return new Uint8Array(nodeFs.readFileSync(p)) },
  async writeText(p, text) { nodeFs.writeFileSync(p, text); return {} },
}

const shellService = {
  resolve(spec) { return spec },
  async run(spec) {
    const started = Date.now()
    const out = cp.spawnSync('bash', ['-c', spec.command], { encoding: 'utf8', timeout: spec.timeoutMs || 60000, maxBuffer: 16 << 20 })
    const ms = Date.now() - started
    if (process.env.MCART_SHOW_SHELL === '1') process.stderr.write('  [shell ' + ms + 'ms] ' + spec.command.slice(0, 100) + '\n')
    return { exitCode: out.status === null ? 124 : out.status, stdout: { text: out.stdout || '' }, stderr: { text: out.stderr || '' } }
  },
  start() { throw new Error('not used') },
}

// The runtime validates every value a handler returns -- `cloneJson` in
// cordis-host-runner rejects `undefined`, functions, class instances, Map/Set,
// Date and anything else that is not lossless JSON.  This stub did NOT, and the
// difference is not cosmetic: a rotated preview carried `pick: undefined`
// (`rotateQuads` copies the key through), which passed EVERY gate here and then
// failed at the RPC boundary in the real GUI with
// "result.quads[11].pick must be lossless JSON data".  A stub that is laxer
// than the thing it stands in for is a gate that cannot fail.
function jsonProblem(value, path, depth) {
  if (depth > 24) return path + ' 太深了'
  if (value === undefined) return path + ' 是 undefined'
  if (value === null) return null
  const kind = typeof value
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') return path + ' 是 ' + kind
  if (kind !== 'object') return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const bad = jsonProblem(value[index], path + '[' + index + ']', depth + 1)
      if (bad !== null) return bad
    }
    return null
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    return path + ' 不是普通对象（' + String(value.constructor && value.constructor.name) + '）'
  }
  for (const key of Object.keys(value)) {
    const bad = jsonProblem(value[key], path + '.' + key, depth + 1)
    if (bad !== null) return bad
  }
  return null
}

const handlers = {}
const ctx = { get: (n) => (n === 'fs' ? fsService : n === 'shell' ? shellService : undefined), effect: (fn) => fn() }
globalThis.harness = {
  handle: (name, fn) => {
    handlers[name] = async (args) => {
      const out = await fn(args)
      const bad = jsonProblem(out, name + ' 的返回值', 0)
      if (bad !== null) throw new Error('宿主返回值不是可无损 JSON 的数据：' + bad)
      return out
    }
  },
}
const plugin = new Function(body)()
plugin.apply(ctx)
module.exports = { handlers }

if (require.main === module) {
  ;(async () => {
    const target = process.argv[2] || ''
    console.log('--- atlas.settings（未设置参考目录）')
    let r = await handlers['atlas.settings']({ root: '/home/gmh/mc-art', project: 'fleshland' })
    console.log('  directory=', JSON.stringify(r.directory), ' shape=', JSON.stringify(r.shape), ' scanError=', r.scanError)
    console.log('  scanner=', r.scanner)
    console.log('  detected=', r.detected)
    console.log('  mods=', (r.mods || []).length, ' includeGenerated=', r.includeGenerated, ' includeMods=', r.includeMods)

    if (target !== '') {
      console.log('--- atlas.settings（参考目录=' + target + '）')
      const t0 = Date.now()
      r = await handlers['atlas.settings']({ root: '/home/gmh/mc-art', project: 'fleshland', directory: target })
      r = await handlers['atlas.saveSettings']({ root: '/home/gmh/mc-art', project: 'fleshland', directory: target, includeGenerated: true, includeMods: true, mods: {} })
      console.log('  save:', JSON.stringify(r))
      const t1 = Date.now()
      r = await handlers['atlas.settings']({ root: '/home/gmh/mc-art', project: 'fleshland' })
      const t2 = Date.now()
      console.log('  directory=', r.directory)
      console.log('  shape=', r.shape, '| 贴图', r.textures, '| 来源', (r.sources || []).length)
      console.log('  scanError=', r.scanError)
      console.log('  mods=', (r.mods || []).length, (r.mods || []).slice(0, 5).map((m) => m.name + ':' + m.count).join(' '))
      console.log('  第一次(冷) ' + (t1 - t0) + 'ms，第二次(缓存) ' + (t2 - t1) + 'ms')
    }
  })().catch((e) => { console.error('THREW', e); process.exit(1) })
}
