#!/usr/bin/env node
/**
 * 模型解析到位了吗 —— 项目自己的模型 / 原版母模型 / multipart / Python 探测。
 *
 * 用户实测的两件事都在这条链上：
 *   1. 那份**自相矛盾**的报告（"项目包里没有这个文件" + "缺的原版母模型"）——
 *      旧 `missingParents()` 把"根模型缺失"也想成原版母模型，再拿项目命名空间的名字
 *      去原版 jar 里现取，当然取不到，然后把人引向"改 parent"。
 *   2. 所有 multipart 方块画不出来 —— 旧 `blockIds()` 只读 `variants` 的第一个 key，
 *      原版墙 / 栅栏 / 玻璃板（用户工程里的 6 个墙 + fence / fence_gate / trapdoor /
 *      button / pressure_plate / ladder）全都被猜成 `block/<方块名>`，而那个文件不存在。
 *
 * 这里用**真的抽取器**（真的 Python、真的参考根）驱动**真的宿主源码**，量的是
 * `atlas.scene` 回来的 quads 与 `diagnostic`，不是字符串是否出现。
 *
 *   node tools/mcart-plugin/model-test.js
 *   node tools/mcart-plugin/model-test.js --fault
 *       # 把宿主改回三处旧逻辑（命名空间盲 / 只读 variants / 只试 python3），
 *       # 断言**必须变红** —— 不能变红的断言不算门禁。
 *
 * 真实工程（只读）：
 *   $env:MCART_REAL_PROJECT='<某个 mc-art 工程目录>'; node tools/mcart-plugin/model-test.js
 *   设了它才会跑那一段（不设就打印"跳过"，因为仓库里不许出现私人路径）。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const os = require('os')
const { runPython } = require('./python-bin.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.model-fixture')
const REF = nodePath.join(os.tmpdir(), 'mcart-model-ref')
const FAULT = process.argv.includes('--fault')

// ── 旧的（错的）逻辑，逐条改回去：--fault 靠的就是这几处替换 ────────────────────
const FAULTS = [
  { label: '命名空间盲：根模型缺失也记成"缺的原版母模型"（旧的 missingParents）',
    from: "      const own = (namespace) => namespace === '' || namespace === load.namespace",
    to: '      const own = (namespace) => false' },
  { label: 'blockIds 只读 variants：multipart 直接被忽略（旧的读法）',
    from: '      if (Array.isArray(state.multipart)) {',
    to: '      if (false && Array.isArray(state.multipart)) {' },
  { label: 'findTool 向上找优先、按 relative 缓存、交出相对路径（旧的读法）',
    from: '    async function findTool(start, relative) {\n      const base = absoluteOf(trimTrailing(start))',
    to: '    async function findTool(start, relative) {\n'
      + '      {\n'
      + "        if (toolPaths.has(relative)) return toolPaths.get(relative)\n"
      + "        let oldAt = String(start === undefined || start === null ? '' : start)\n"
      + "        for (let oldDepth = 0; oldDepth < 5 && oldAt !== ''; oldDepth++) {\n"
      + "          const oldInfo = await statOf(oldAt + '/' + relative)\n"
      + "          if (oldInfo !== undefined && oldInfo.type === 'file') { toolPaths.set(relative, oldAt + '/' + relative); return oldAt + '/' + relative }\n"
      + "          oldAt = parentOf(oldAt) || ''\n"
      + '        }\n'
      + '      }\n'
      + '      const base = absoluteOf(trimTrailing(start))' },
  { label: '贴图不去参考目录现取（只在项目包里找，找不到就丢面）',
    from: '        const fetched = await fetchVanillaTextures(project, wanted)',
    to: "        const fetched = { fetched: 0, reason: 'textures-unresolved', why: '--fault' }" },
  { label: 'quads 为空时返回"成功"（旧的静默空取景框）',
    from: '        if (elements === undefined || quads.length === 0) {',
    to: '        if (elements === undefined) {' },
]

/** 原样的宿主源码（不套本文件的 --fault 替换）——别的门禁要自己注入故障时用它。 */
function readHostSource() {
  return nodeFs.readFileSync(nodePath.join(__dirname, 'host.js'), 'utf8')
}

function hostSource() {
  const source = readHostSource()
  if (!FAULT) return source
  let patched = source
  for (const fault of FAULTS) {
    if (patched.indexOf(fault.from) < 0) {
      console.log('  FAIL --fault 没生效：宿主里找不到 —— ' + fault.label)
      process.exit(2)
    }
    patched = patched.replace(fault.from, fault.to)
  }
  return patched
}

// ── 宿主加载器：和 run.js 同一套"返回值必须可无损 JSON"的校验 ──────────────────
// （照抄 run.js 的 jsonProblem：垫片比真运行宽松的话，门禁就是假的。）
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

const quietConsole = Object.assign(Object.create(console), { log: () => {} })

function loadHost(source, options) {
  const opts = options || {}
  const handlers = {}
  const services = { fs: opts.fs, shell: opts.shell, subprocess: opts.subprocess,
    directoryPickerController: opts.picker, sessions: opts.sessions }
  const ctx = {
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    effect: (fn) => fn(),
  }
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
  const plugin = new Function('harness', 'console', 'TextEncoder', 'btoa', 'atob', 'nodeFs', 'moduleDir', 'process',
    source)(globalThis.harness, quietConsole, TextEncoder, btoa, atob,
    opts.nodeFs === undefined ? undefined : opts.nodeFs,
    nodePath.join(REPO, 'panel', 'lib'), process)
  plugin.apply(ctx)
  return handlers
}

const { fsService } = require('./run.js')

// ── 真起进程的 subprocess 桩：形状照 dsh-subprocess 的契约，argv 全部记下来 ─────
function resolveOnPath(name) {
  if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
    return nodeFs.existsSync(name) ? name : null
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  for (const dir of String(process.env.PATH || '').split(nodePath.delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = nodePath.join(dir, name + ext)
      try { if (nodeFs.statSync(candidate).isFile()) return candidate } catch (error) { /* 试下一个 */ }
    }
  }
  return null
}

function realSubprocess() {
  const childProcess = require('child_process')
  const calls = []
  const reader = (text) => ({ readFrom: () => ({ text: String(text === undefined || text === null ? '' : text), nextOffset: 0, lossy: false }) })
  return {
    calls: calls,
    async resolveExecutable(name) {
      const found = resolveOnPath(name)
      if (found === null) throw new Error('not found: ' + name)
      return found
    },
    spawn(spec) {
      calls.push(spec.argv.slice())
      const done = childProcess.spawnSync(spec.argv[0], spec.argv.slice(1),
        { cwd: spec.cwd, encoding: 'utf8', maxBuffer: 32 << 20, timeout: 180000 })
      return { collected: { stdout: reader(done.stdout), stderr: reader(done.stderr) },
        done: Promise.resolve({ exitCode: done.status === null ? 124 : done.status }) }
    },
  }
}

// ── 纯模拟的 subprocess 桩：专门用来量"Python 探测的判据" ─────────────────────
function fakeSubprocess(run) {
  const calls = []
  const reader = (text) => ({ readFrom: () => ({ text: String(text === undefined || text === null ? '' : text), nextOffset: 0, lossy: false }) })
  return {
    calls: calls,
    async resolveExecutable(name) {
      if (name === '') throw new Error('empty')
      return 'C:/fake-bin/' + name + '.exe'
    },
    spawn(spec) {
      calls.push(spec.argv.slice())
      const verdict = run(spec.argv)
      return { collected: { stdout: reader(verdict.stdout), stderr: reader(verdict.stderr) },
        done: Promise.resolve({ exitCode: verdict.exitCode === undefined ? 1 : verdict.exitCode }) }
    },
  }
}

/** 本机那种真实的坏形状：python3 是 0 字节 Store 存根（9009），py -3 指向已删的解释器（101）。 */
function realMachineRun(argv) {
  const bin = nodePath.basename(String(argv[0])).toLowerCase()
  if (bin.indexOf('python3') === 0) return { exitCode: 9009, stdout: '', stderr: '' }
  if (bin === 'py' || bin.indexOf('py.') === 0) {
    return { exitCode: 101, stdout: '', stderr: "Unable to create process using 'C:\\gone\\python.exe'" }
  }
  return { exitCode: 0, stdout: '1\n', stderr: '' }
}

let failures = 0
const failedLabels = []
function check(label, ok, detail) {
  if (!ok) { failures += 1; failedLabels.push(label) }
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const FIXTURE = `
import json, os, struct, zlib

work, ref = ${JSON.stringify(WORK)}, ${JSON.stringify(REF)}

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

def png(rgba):
    rows = b''
    for _ in range(4):
        rows += b'\\x00' + bytes(rgba) * 4
    return (b'\\x89PNG\\r\\n\\x1a\\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 4, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows))
            + chunk(b'IEND', b''))

def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(obj if isinstance(obj, str) else json.dumps(obj))

def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)

FACES = ('down', 'up', 'north', 'south', 'west', 'east')

def cube(tex):
    return {'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16],
                          'faces': {name: {'texture': tex} for name in FACES}}]}

def variants(mapping):
    return {'variants': {key: {'model': value} for key, value in mapping.items()}}

def multipart(pairs):
    return {'multipart': [{'when': when, 'apply': {'model': model}} for when, model in pairs]}

# ---- 参考根：一棵已解包的资源树，形状和版本 jar 里的 assets/ 一样 --------------
VANILLA = ['block/block', 'block/door_bottom', 'block/door_top',
           'block/template_wall_post', 'block/template_wall_side', 'block/template_wall_side_tall',
           'block/slab', 'block/slab_top', 'block/stairs', 'block/stairs_inner', 'block/stairs_outer',
           'block/template_fence_post', 'block/template_fence_side',
           'block/template_fence_gate', 'block/template_fence_gate_open',
           'block/template_fence_gate_wall', 'block/template_fence_gate_wall_open',
           'block/template_trapdoor_bottom', 'block/template_trapdoor_open', 'block/template_trapdoor_top',
           'block/ladder', 'block/button', 'block/button_pressed',
           'block/pressure_plate_up', 'block/pressure_plate_down']
for name in VANILLA:
    if name == 'block/block':
        write(os.path.join(ref, 'assets', 'minecraft', 'models', name + '.json'), {'textures': {}})
        continue
    # 每张脸都引用 #all：项目的模型只要给一个 all 贴图就能整条链解出来。
    body = {'textures': {'all': '#all'},
            'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16],
                          'faces': {face: {'texture': '#all'} for face in FACES}}]}
    write(os.path.join(ref, 'assets', 'minecraft', 'models', name + '.json'), body)
# 参考根里**故意没有**的原版母模型：用来量 vanilla-parent-missing。
# （'block/definitely_not_a_real_parent' 不在 VANILLA 里。）
# 也放一张原版贴图：项目的模型直接引用 minecraft:block/stone 时，要从这里现取。
write_bytes(os.path.join(ref, 'assets', 'minecraft', 'textures', 'block', 'stone.png'), png((120, 120, 120, 255)))

def project(name, namespace, directory):
    base = os.path.join(work, name)
    assets = os.path.join(base, 'pack', 'assets', namespace)
    tex = namespace + ':block/solid'
    write_bytes(os.path.join(assets, 'textures', 'block', 'solid.png'), png((180, 140, 90, 255)))

    def model(rel, body):
        write(os.path.join(assets, 'models', 'block', rel + '.json'), body)

    def state(rel, body):
        write(os.path.join(assets, 'blockstates', rel + '.json'), body)

    def project_model(parent):
        # 项目自己的模型：给 all 贴图，parent 指向原版母模型（自己不带 elements）。
        return {'parent': parent, 'textures': {'all': tex}}

    # 1. 一个正常的、不依赖参考目录的方块（parent 落在宿主内置表里）。
    state('solo', variants({'': namespace + ':block/solo'}))
    model('solo', {'parent': 'block/cube_all', 'textures': {'all': tex}})

    # 2. 项目自己的模型文件**缺失**（blockstate 指着它，文件不在）。
    state('gone', variants({'': namespace + ':block/gone'}))

    # 3. 项目模型在，parent 指向一个**原版也不存在**的名字。
    state('orphan', variants({'': namespace + ':block/orphan'}))
    model('orphan', project_model('minecraft:block/definitely_not_a_real_parent'))

    # 4. 链正常但没设参考目录时用它：parent 是真原版母模型。
    state('refless_door', variants({'': namespace + ':block/refless_door_bottom'}))
    model('refless_door_bottom', project_model('minecraft:block/door_bottom'))

    # 4b. **贴图**这条路：面引用原版贴图（minecraft:block/stone）——
    # 项目包里没有这个 PNG，但参考目录的 jar/资源树里有，必须能现取回来、画出面。
    state('gate_texvanilla', variants({'': namespace + ':block/gate_texvanilla'}))
    model('gate_texvanilla', {'textures': {'all': 'minecraft:block/stone'},
        'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16],
                      'faces': {face: {'texture': '#all'} for face in FACES}}]})

    # 4c. 面引用一个**哪儿都没有**的贴图：不许静默返回"成功 + 空 quads"，必须给报告。
    state('gate_texmissing', variants({'': namespace + ':block/gate_texmissing'}))
    model('gate_texmissing', {'textures': {'all': namespace + ':block/nope'},
        'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16],
                      'faces': {face: {'texture': '#all'} for face in FACES}}]})

    # ---- 用户要的十个族：门 / 墙 / 台阶 / 半砖 / 栅栏 / 栅栏门 / 活板门 / 梯子 / 按钮 / 压力板
    # 门：真实 mist_door 的形状 —— 4 个朝向 x 2 个 half x 2 个 hinge x 2 个 open = 32 条 variants。
    door = {}
    for facing in ('east', 'north', 'south', 'west'):
        for half in ('lower', 'upper'):
            for hinge in ('left', 'right'):
                for opened in ('false', 'true'):
                    piece = ('bottom' if half == 'lower' else 'top') + ('_hinge' if hinge == 'right' else '')
                    door['facing=%s,half=%s,hinge=%s,open=%s' % (facing, half, hinge, opened)] = \\
                        namespace + ':block/gate_door_' + piece
    state('gate_door', variants(door))
    model('gate_door_bottom', project_model('minecraft:block/door_bottom'))
    model('gate_door_bottom_hinge', project_model('minecraft:block/door_bottom'))
    model('gate_door_top', project_model('minecraft:block/door_top'))
    model('gate_door_top_hinge', project_model('minecraft:block/door_top'))

    # 墙：multipart，post / side / side_tall（项目里**没有** gate_wall.json 这个文件）。
    wall = [(None, namespace + ':block/gate_wall_post')]
    for direction in ('north', 'east', 'south', 'west'):
        wall.append(({direction: 'low'}, namespace + ':block/gate_wall_side'))
        wall.append(({direction: 'tall'}, namespace + ':block/gate_wall_side_tall'))
    state('gate_wall', multipart(wall))
    model('gate_wall_post', project_model('minecraft:block/template_wall_post'))
    model('gate_wall_side', project_model('minecraft:block/template_wall_side'))
    model('gate_wall_side_tall', project_model('minecraft:block/template_wall_side_tall'))

    # 栅栏：multipart。
    state('gate_fence', multipart([(None, namespace + ':block/gate_fence_post')]
        + [({d: 'true'}, namespace + ':block/gate_fence_side') for d in ('north', 'east', 'south', 'west')]))
    model('gate_fence_post', project_model('minecraft:block/template_fence_post'))
    model('gate_fence_side', project_model('minecraft:block/template_fence_side'))

    # 半砖 / 台阶 / 栅栏门 / 活板门：variants，每个形态一个模型。
    state('gate_slab', variants({'type=bottom': namespace + ':block/gate_slab',
                                 'type=double': namespace + ':block/gate_slab_double',
                                 'type=top': namespace + ':block/gate_slab_top'}))
    model('gate_slab', project_model('minecraft:block/slab'))
    model('gate_slab_double', project_model('minecraft:block/slab'))
    model('gate_slab_top', project_model('minecraft:block/slab_top'))

    stairs = {}
    for facing in ('east', 'north', 'south', 'west'):
        for half in ('bottom', 'top'):
            for shape in ('straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'):
                piece = 'gate_stairs' + ('' if shape == 'straight' else '_' + shape.split('_')[0])
                stairs['facing=%s,half=%s,shape=%s' % (facing, half, shape)] = namespace + ':block/' + piece
    state('gate_stairs', variants(stairs))
    model('gate_stairs', project_model('minecraft:block/stairs'))
    model('gate_stairs_inner', project_model('minecraft:block/stairs_inner'))
    model('gate_stairs_outer', project_model('minecraft:block/stairs_outer'))

    fence_gate = {}
    for facing in ('east', 'north', 'south', 'west'):
        for in_wall in ('false', 'true'):
            for opened in ('false', 'true'):
                suffix = ('_wall' if in_wall == 'true' else '') + ('_open' if opened == 'true' else '')
                fence_gate['facing=%s,in_wall=%s,open=%s' % (facing, in_wall, opened)] = \\
                    namespace + ':block/gate_fence_gate' + suffix
    state('gate_fence_gate', variants(fence_gate))
    model('gate_fence_gate', project_model('minecraft:block/template_fence_gate'))
    model('gate_fence_gate_open', project_model('minecraft:block/template_fence_gate_open'))
    model('gate_fence_gate_wall', project_model('minecraft:block/template_fence_gate_wall'))
    model('gate_fence_gate_wall_open', project_model('minecraft:block/template_fence_gate_wall_open'))

    trapdoor = {}
    for facing in ('east', 'north', 'south', 'west'):
        for half in ('bottom', 'top'):
            for opened in ('false', 'true'):
                piece = 'gate_trapdoor_open' if opened == 'true' else 'gate_trapdoor_' + half
                trapdoor['facing=%s,half=%s,open=%s' % (facing, half, opened)] = namespace + ':block/' + piece
    state('gate_trapdoor', variants(trapdoor))
    model('gate_trapdoor_bottom', project_model('minecraft:block/template_trapdoor_bottom'))
    model('gate_trapdoor_open', project_model('minecraft:block/template_trapdoor_open'))
    model('gate_trapdoor_top', project_model('minecraft:block/template_trapdoor_top'))

    state('gate_ladder', variants({facing: namespace + ':block/gate_ladder'
                                   for facing in ('east', 'north', 'south', 'west')}))
    model('gate_ladder', project_model('minecraft:block/ladder'))

    state('gate_button', variants({'face=wall,facing=east,powered=false': namespace + ':block/gate_button',
                                   'face=wall,facing=east,powered=true': namespace + ':block/gate_button_pressed'}))
    model('gate_button', project_model('minecraft:block/button'))
    model('gate_button_pressed', project_model('minecraft:block/button_pressed'))

    state('gate_pressure_plate', variants({'powered=false': namespace + ':block/gate_pressure_plate',
                                           'powered=true': namespace + ':block/gate_pressure_plate_down'}))
    model('gate_pressure_plate', project_model('minecraft:block/pressure_plate_up'))
    model('gate_pressure_plate_down', project_model('minecraft:block/pressure_plate_down'))

    write(os.path.join(base, 'mc-art.atlas.json'),
          {'namespace': namespace, 'structures': [{'id': 's', 'cells': []}]})
    write(os.path.join(base, 'mc-art.settings.json'),
          {'schema': 'mc-art.settings/1',
           'reference': {'directory': directory, 'includeGenerated': True, 'includeMods': True, 'mods': {}}})

project('withref', 'wref', ref)
project('noref', 'nref', '')
print('ok')
`

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.rmSync(REF, { recursive: true, force: true })
  const script = nodePath.join(os.tmpdir(), 'mcart-model-fixture.py')
  nodeFs.writeFileSync(script, FIXTURE)
  const out = runPython([script], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('fixture failed: ' + (out.stderr || out.stdout))
}

const PROJECTS = { withref: 'wref', noref: 'nref' }

async function main() {
  buildFixture()
  const source = hostSource()
  if (FAULT) {
    console.log('--- 故障注入：' + FAULTS.map((fault) => fault.label).join('；'))
  }

  const families = [
    ['gate_door', 'gate_door_bottom'],
    ['gate_wall', 'gate_wall_post'],
    ['gate_stairs', 'gate_stairs'],
    ['gate_slab', 'gate_slab'],
    ['gate_fence', 'gate_fence_post'],
    ['gate_fence_gate', 'gate_fence_gate'],
    ['gate_trapdoor', 'gate_trapdoor_bottom'],
    ['gate_ladder', 'gate_ladder'],
    ['gate_button', 'gate_button'],
    ['gate_pressure_plate', 'gate_pressure_plate'],
    ['gate_texvanilla', 'gate_texvanilla'],
  ]

  // ── 1. 十个族都能画出来 ────────────────────────────────────────────────────
  console.log('--- 门/墙/台阶/半砖/栅栏/栅栏门/活板门/梯子/按钮/压力板')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    let wallModels = []
    for (const [id, expected] of families) {
      const out = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: id })
      if (id === 'gate_wall') wallModels = Array.isArray(out.models) ? out.models : []
      const ok = out !== undefined && out.error === undefined && Array.isArray(out.quads) && out.quads.length > 0
      check('user_blocks:' + id + ' 画得出来（quads > 0）', ok,
        out === undefined ? 'undefined' : (out.error === undefined ? String(out.quads.length) + ' 面' : String(out.error).split('\n')[0]))
      check('user_blocks:' + id + ' 选的代表模型是 ' + expected,
        out !== undefined && out.model === PROJECTS.withref + ':block/' + expected,
        out === undefined ? 'undefined' : String(out.model))
      check('user_blocks:' + id + ' 把引用的全部模型回给了客户端',
        out !== undefined && Array.isArray(out.models) && out.models.length > 0,
        out === undefined ? 'undefined' : JSON.stringify(out.models))
    }
    check('user_blocks: 墙引用的三个模型都收齐了（post / side / side_tall）',
      JSON.stringify(wallModels) ===
        JSON.stringify(['wref:block/gate_wall_post', 'wref:block/gate_wall_side', 'wref:block/gate_wall_side_tall']),
      JSON.stringify(wallModels))
  }

  // ── 2. 项目自己的模型缺失：绝不许说成"缺的原版母模型"，也别去 jar 取 ────────
  console.log('--- 项目自己的模型缺失（那份自相矛盾报告的根因）')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const out = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gone' })
    const text = String(out === undefined || out.error === undefined ? '' : out.error)
    const diagnostic = (out && out.diagnostic) || {}
    check('proj_missing: 有结构化诊断，reason = project-model-missing',
      diagnostic.reason === 'project-model-missing', String(diagnostic.reason))
    check('proj_missing: missing 里每一条 kind 都是 project（不许混进 vanilla）',
      Array.isArray(diagnostic.missing) && diagnostic.missing.length > 0 &&
        diagnostic.missing.every((item) => item.kind === 'project'),
      JSON.stringify(diagnostic.missing))
    check('proj_missing: 给的是能直接照做的项目内路径',
      Array.isArray(diagnostic.missing) &&
        diagnostic.missing[0].fixPath === 'pack/assets/wref/models/block/gone.json',
      JSON.stringify(diagnostic.missing && diagnostic.missing[0]))
    check('proj_missing: 人读文本里不再出现"缺的原版母模型"这句话',
      text.indexOf('缺的原版母模型') < 0, text.split('\n').slice(0, 3).join(' / '))
    check('proj_missing: 人读文本里写明了要补哪个文件',
      text.indexOf('pack/assets/wref/models/block/gone.json') >= 0)
    check('proj_missing: 一条命令行都没起 —— 项目命名空间的名字绝不交给原版 jar',
      subprocess.calls.length === 0, JSON.stringify(subprocess.calls))
    check('proj_missing: 报告没有注入任何地方（notified=false / notifyVia=null）',
      out !== undefined && out.notified === false && out.notifyVia === null,
      JSON.stringify({ notified: out && out.notified, notifyVia: out && out.notifyVia }))
    // 上限与确定性：同一份报告不重复刷屏的前提是"同样的输入给同样的字节"。
    const again = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gone' })
    check('proj_missing: 连问两次文本逐字节相同（客户端才好按 dedupeKey 去重）',
      String(again.error) === text, String(again.error).slice(0, 40))
    check('proj_missing: 人读文本 ≤ 20 行', text.split('\n').length <= 20, text.split('\n').length + ' 行')
  }

  // ── 3. 原版母模型缺失（参考目录指对了，但那个版本里没有这个名字）────────────
  console.log('--- 原版母模型缺失')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const out = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'orphan' })
    const diagnostic = (out && out.diagnostic) || {}
    check('vanilla_missing: reason = vanilla-parent-missing',
      diagnostic.reason === 'vanilla-parent-missing', String(diagnostic.reason))
    check('vanilla_missing: missing 里那条是 vanilla，名字指向那个不存在的原版母模型',
      Array.isArray(diagnostic.missing) && diagnostic.missing.length === 1 &&
        diagnostic.missing[0].kind === 'vanilla' &&
        diagnostic.missing[0].name === 'minecraft:block/definitely_not_a_real_parent',
      JSON.stringify(diagnostic.missing))
    check('vanilla_missing: 报告写清了参考目录里取不到',
      String(out.error).split('\n').some((line) => line.indexOf('原版母模型缺失') >= 0), String(out.error).split('\n')[1])
    check('vanilla_missing: 真的去 jar/参考根里取过（起了抽取器）',
      subprocess.calls.length > 0, JSON.stringify(subprocess.calls.length))
  }

  // ── 4. 链完整但没设参考目录 ───────────────────────────────────────────────
  console.log('--- 没设参考目录')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const out = await handlers['atlas.scene']({ root: WORK, project: 'noref', kind: 'block', id: 'refless_door' })
    const text = String(out === undefined || out.error === undefined ? '' : out.error)
    const diagnostic = (out && out.diagnostic) || {}
    check('no_ref: reason = no-reference-directory',
      diagnostic.reason === 'no-reference-directory', String(diagnostic.reason))
    check('no_ref: referenceDirectory 是空串（没设就是没设）',
      diagnostic.referenceDirectory === '', JSON.stringify(diagnostic.referenceDirectory))
    check('no_ref: 说清了去哪里设（面板设置 / .minecraft/versions）',
      text.indexOf('.minecraft/versions') >= 0, text.split('\n').slice(-2).join(' / '))
    check('no_ref: 没设参考目录时不会去起抽取器（也没地方可取）',
      subprocess.calls.length === 0, JSON.stringify(subprocess.calls))
    check('no_ref: 这一条是原版母模型缺，不是项目自己的模型缺（两边不许混）',
      text.indexOf('项目自己的模型文件缺失') < 0 && text.indexOf('原版母模型缺失') >= 0,
      text.split('\n').slice(0, 4).join(' / '))
    // 不依赖参考目录的方块在同一个工程里必须照样画得出来。
    const solo = await handlers['atlas.scene']({ root: WORK, project: 'noref', kind: 'block', id: 'solo' })
    check('no_ref: 内置母模型表能覆盖的方块照样画得出来（parent = block/cube_all）',
      solo !== undefined && solo.error === undefined && solo.quads.length > 0,
      solo === undefined ? 'undefined' : (solo.error === undefined ? solo.quads.length + ' 面' : String(solo.error).split('\n')[0]))
  }

  // ── 5. 贴图：原版贴图从参考目录现取；取不到必须报，不许静默空 ────────────────
  console.log('--- 贴图：原版贴图现取 / 空 quads 必须报')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const vanillaTex = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gate_texvanilla' })
    check('tex_vanilla: 面引用 minecraft:block/stone 时能从参考目录现取到贴图并画出来',
      vanillaTex !== undefined && vanillaTex.error === undefined && vanillaTex.quads.length > 0,
      vanillaTex === undefined ? 'undefined'
        : (vanillaTex.error === undefined ? vanillaTex.quads.length + ' 面' : String(vanillaTex.error).split('\n')[0]))
    const missing = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gate_texmissing' })
    const diagnostic = (missing && missing.diagnostic) || {}
    check('tex_missing: 空 quads 不许返回"成功"（以前取景框一片空白、屏幕一个字都没有）',
      missing !== undefined && missing.error !== undefined,
      JSON.stringify({ error: missing === undefined ? 'undefined' : String(missing.error).split('\n')[0],
        quads: missing === undefined ? null : (missing.quads === undefined ? '没有这个键' : missing.quads.length) }))
    check('tex_missing: reason = textures-unresolved（不是 unknown，也不是"缺的原版母模型"）',
      diagnostic.reason === 'textures-unresolved', String(diagnostic.reason))
    check('tex_missing: 报告点名是哪张贴图，并给出能直接照做的路径',
      Array.isArray(diagnostic.missing) && diagnostic.missing.length > 0 &&
        diagnostic.missing[0].name === 'wref:block/nope' &&
        String(diagnostic.missing[0].fixPath).indexOf('textures/block/nope.png') >= 0,
      JSON.stringify(diagnostic.missing))
    check('tex_missing: 人读文本里有"贴图"这一节，没有把项目贴图说成原版母模型',
      String(missing.error).indexOf('贴图') >= 0 && String(missing.error).indexOf('缺的原版母模型') < 0,
      String(missing.error).split('\n')[4])
  }
  {
    // 没设参考目录：原版贴图无处可取 → reason 必须是 no-reference-directory，且不许静默。
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const out = await handlers['atlas.scene']({ root: WORK, project: 'noref', kind: 'block', id: 'gate_texvanilla' })
    const diagnostic = (out && out.diagnostic) || {}
    check('tex_noref: 没设参考目录时也报出来（不是静默空），reason = no-reference-directory',
      out !== undefined && out.error !== undefined && diagnostic.reason === 'no-reference-directory',
      JSON.stringify({ reason: diagnostic.reason,
        error: out === undefined ? 'undefined' : String(out.error).split('\n')[0] }))
  }

  // ── 6. Python 探测的判据（§2.3）：真跑一次、退出码 0 且输出 1 ────────────────
  console.log('--- Python 探测（§2.3）')
  {
    // 本机那种真实的坏形状：python3 是 0 字节 Store 存根（9009），python 好的，
    // py / py -3 指向一个已被删掉的解释器（101）。命中的应该是 python。
    // --fault：把 Store 存根谎报成"能跑"（旧判据"命令存在就算有"），这几条必须变红。
    const machine = fakeSubprocess(FAULT
      ? () => ({ exitCode: 0, stdout: '1\n', stderr: '' })
      : realMachineRun)
    const handlers = loadHost(source, { fs: fsService, subprocess: machine })
    const env = await handlers['atlas.env']({ root: WORK })
    const successful = machine.calls.filter((argv) => argv.indexOf('-c') >= 0 && argv[argv.indexOf('-c') + 1] === 'print(1)')
    check('python: 每个被试的候选都真的跑了一次 `-c print(1)`（不是"命令存在就算"）',
      machine.calls.length > 0 && successful.length === machine.calls.length,
      JSON.stringify(machine.calls))
    check('python: 先试 python3 再试 python（§2.3 的顺序，且坏的那个不短路）',
      JSON.stringify(machine.calls.map((argv) => argv.slice(0, -2)))
        === JSON.stringify([['C:/fake-bin/python3.exe'], ['C:/fake-bin/python.exe']]),
      JSON.stringify(machine.calls.map((argv) => argv.slice(0, -2))))
    check('python: 0 字节 Store 存根 python3（退出码 9009）被拒，选了 python',
      env.python === 'python' && env.pythonVia === 'subprocess',
      JSON.stringify({ python: env.python, via: env.pythonVia }))
  }
  {
    // 四个候选全废：报出来的必须是 null，而且 `py -3` 是**按 argv 拆开**起的
    //（bin=py, args=['-3']），不是一个整串可执行名 —— 后者在 subprocess 那条路上
    // 永远解析不出来，而"只有 py 能用"的 Windows 机器很常见。
    const dead = fakeSubprocess((argv) => {
      const bin = nodePath.basename(String(argv[0])).toLowerCase()
      if (bin.indexOf('python3') === 0) return { exitCode: 9009, stdout: '', stderr: '' }
      if (bin.indexOf('py') === 0) return { exitCode: 101, stdout: '', stderr: 'Unable to create process using ...' }
      return { exitCode: 9009, stdout: '', stderr: '' }
    })
    const handlers = loadHost(source, { fs: fsService, subprocess: dead })
    const env = await handlers['atlas.env']({ root: WORK })
    const head = dead.calls.slice(0, 4)
    check('python: 探测顺序是 §2.3 的 python3 → python → py -3 → py',
      JSON.stringify(head.map((argv) => argv.slice(0, -2))) === JSON.stringify([
        ['C:/fake-bin/python3.exe'], ['C:/fake-bin/python.exe'],
        ['C:/fake-bin/py.exe', '-3'], ['C:/fake-bin/py.exe']]),
      JSON.stringify(head.map((argv) => argv.slice(0, -2))))
    check('python: 坏注册表的 py -3（退出码 101）也被拒，接着才试 py',
      head[2] !== undefined && head[2][1] === '-3' && head[3] !== undefined && head[3].length === 3,
      JSON.stringify(head))
    check('python: 四个候选全废时 python = null（不假装有）',
      env.python === null, JSON.stringify({ python: env.python, via: env.pythonVia }))
  }
  {
    // 显式指定的路径优先（§2.3 的"可覆盖"）。
    const machine = fakeSubprocess((argv) =>
      String(argv[0]).indexOf('custom-python') >= 0 ? { exitCode: 0, stdout: '1\n' } : { exitCode: 9009, stdout: '' })
    const handlers = loadHost(source, { fs: fsService, subprocess: machine })
    process.env.MC_ART_PYTHON = 'C:/custom/custom-python.exe'
    let env
    try { env = await handlers['atlas.env']({ root: WORK }) }
    finally { delete process.env.MC_ART_PYTHON }
    check('python: MC_ART_PYTHON 指定的解释器优先命中',
      env.pythonVia === 'subprocess' && String(env.python).indexOf('custom-python') >= 0 &&
        machine.calls.length === 1,
      JSON.stringify({ python: env.python, calls: machine.calls }))
  }

  // ── 7. findTool：先问 env 再问工程，脚本路径必须是绝对的、且是包里那份 ────────
  // 用户实测"45 个方块 28 个画不出来"的根因：`atlas.env` 用 root='.' 先问一次，
  // `findTool` 把**相对路径** `./tools/mcart_extract_block.py` 按下 `relative` 一个键缓存，
  // 之后 runScanner 用 `cwd = project.dir` 起进程 → Python 找不到脚本 → extractor-failed。
  console.log('--- findTool：面板每次开面板都会先问一次 env（root="."）')
  {
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const absolute = (value) => typeof value === 'string' &&
      (value.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(value))
    const first = await handlers['atlas.env']({ root: '.' })
    const second = await handlers['atlas.env']({ root: WORK })
    check('findTool: 第一次（root="."）给的就是绝对路径',
      absolute(first.extractor) && absolute(first.scanner), JSON.stringify(first.extractor))
    check('findTool: 第二次（工程目录）没有被第一次污染，仍是绝对路径',
      absolute(second.extractor) && absolute(second.scanner), JSON.stringify(second.extractor))
    check('findTool: 两次都指向**包内**那份（和宿主同版本）',
      String(first.extractor).indexOf('panel/python') >= 0 &&
        String(second.extractor).indexOf('panel/python') >= 0,
      JSON.stringify({ first: first.extractor, second: second.extractor }))
    // 真的画一遍：被污染时这一条会以 extractor-failed 红掉（用户实测的那批方块）。
    const wall = await handlers['atlas.scene']({ root: WORK, project: 'withref', kind: 'block', id: 'gate_wall' })
    check('findTool: 先问过 env 之后，需要去 jar 现取原版母模型的墙照样画得出来',
      wall !== undefined && wall.error === undefined && wall.quads.length > 0,
      wall === undefined ? 'undefined'
        : (wall.error === undefined ? wall.quads.length + ' 面' : String(wall.error).split('\n')[0]))
  }

  // ── 8. 真实工程（只读，可选）：MCART_REAL_PROJECT 指到工程目录 ──────────────
  // 用户的原话是"45 个方块 28 个画不出来"，所以这里**扫全部方块**，不是挑十个。
  // 逐个数：模型链断的（有 error）必须为 0；模型链完整但没有 quads 的（贴图取不到）
  // 单独列出来当 FINDING（那是另一件事，不能混进来装作解析成功）。
  const real = process.env.MCART_REAL_PROJECT || ''
  if (real === '') {
    console.log('--- 真实工程：跳过（设 MCART_REAL_PROJECT=<工程目录> 才跑；仓库里不许出现私人路径）')
  } else {
    const projectDir = nodePath.resolve(real)
    console.log('--- 真实工程（只读，扫全部方块）：' + nodePath.basename(projectDir))
    const subprocess = realSubprocess()
    const handlers = loadHost(source, { fs: fsService, subprocess: subprocess })
    const root = nodePath.dirname(projectDir)
    const projectId = nodePath.basename(projectDir)
    const listed = await handlers['atlas.scan']({ root: root })
    const project = ((listed && listed.projects) || []).filter((item) => item.id === projectId)[0]
    const blocks = project === undefined || project.items === undefined || !Array.isArray(project.items.block)
      ? [] : project.items.block
    check('real: 工程被扫出来了、方块清单拿得到',
      project !== undefined && blocks.length > 0,
      project === undefined ? JSON.stringify(listed).slice(0, 200) : String(blocks.length) + ' 个方块')
    const broken = []
    const blank = []
    let drawn = 0
    if (blocks.length > 0) {
      for (const block of blocks) {
        const out = await handlers['atlas.scene']({ root: root, project: projectId, kind: 'block', id: block.id })
        if (out === undefined || out.error !== undefined) {
          broken.push(block.id + '：' + String(out && out.error).split('\n')[0])
        } else if (!Array.isArray(out.quads) || out.quads.length === 0) {
          blank.push(block.id + '（模型在，但没有 quads：贴图取不到）')
        } else drawn += 1
      }
      console.log('    解析率：' + drawn + '/' + blocks.length
        + '（模型链断 ' + broken.length + '，模型在但没 quads ' + blank.length + '）')
    }
    check('real: 没有任何方块因为模型链断裂画不出来（用户实测的 28 个就是这一类）',
      blocks.length > 0 && broken.length === 0, broken.slice(0, 6).join(' | '))
    check('real: 每个方块至少有可解析的模型（模型链完整率 = 100%）',
      blocks.length > 0 && broken.length === 0,
      blocks.length === 0 ? '工程没扫出来' : (blocks.length - broken.length) + '/' + blocks.length)
    for (const line of blank) console.log('    FINDING 模型在但画不出：' + line)
  }

  // ── 结论 ─────────────────────────────────────────────────────────────────
  if (FAULT) {
    // 故障注入下**必须**有断言变红，否则这些断言就是摆设。
    const expected = ['user_blocks:gate_wall 画得出来（quads > 0）',
      'proj_missing: missing 里每一条 kind 都是 project（不许混进 vanilla）',
      'python: 0 字节 Store 存根 python3（退出码 9009）被拒，选了 python',
      'findTool: 第一次（root="."）给的就是绝对路径',
      'findTool: 先问过 env 之后，需要去 jar 现取原版母模型的墙照样画得出来',
      'tex_vanilla: 面引用 minecraft:block/stone 时能从参考目录现取到贴图并画出来',
      'tex_missing: 空 quads 不许返回"成功"（以前取景框一片空白、屏幕一个字都没有）',
      'tex_missing: reason = textures-unresolved（不是 unknown，也不是"缺的原版母模型"）']
    const missed = expected.filter((label) => failedLabels.indexOf(label) < 0)
    console.log('--- 故障注入结果：' + failures + ' 条断言变红')
    console.log('    变红的：' + (failedLabels.slice(0, 6).join(' | ') || '（一条都没有）'))
    if (missed.length > 0) {
      console.log('  FAIL 故障注入没有让这些断言变红（门禁对它们失效）：' + missed.join(' / '))
      process.exit(1)
    }
    console.log('全部通过（故障注入下这些断言确实会红）')
    process.exit(0)
  }
  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

// 被 report-test.js 复用：同一个夹具、同一个宿主加载器、同一套 A/B 替换。
module.exports = { loadHost, hostSource, readHostSource, realSubprocess, fakeSubprocess, realMachineRun,
  buildFixture, jsonProblem, WORK, REF, PROJECTS, FAULTS, REPO, fsService,
  runMain }

function runMain() {
  main().then((count) => process.exit(count === 0 ? 0 : 1))
    .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
}

if (require.main === module) runMain()
