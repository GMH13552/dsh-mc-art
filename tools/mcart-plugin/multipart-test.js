// 墙 / 栅栏 / 玻璃板：原版是看邻居决定画哪些 apply 的。
//
// `mcart_extract_block.py` 只看一个方块，所以它交的是"所有 apply 的并集"，屏幕上写着
// "近似"。搭架子里有格子，格子有邻居，所以并集可以换成"原版真会画的那一部分"。
//
// 规则不是背出来的，是从两版的字节码里读出来的：`tools/multipart_rules.md` 有证据链、
// 类名方法名和重现命令。这个门禁量的是**读数有没有落到屏幕上**，所以每条检查都写成
// "这个场景里原版会画哪几个模型"，而期望值是按那份规则手算的，不是照代码抄的。
//
// 两个参考根各带一个版本目录名（`versions/1.18.2-test` / `versions/1.12.2-test`），
// 因为 `parsed.version` 就是从版本目录名来的 -- 同一个场景在两版必须给出**不同**答案。
const os = require('os')
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')
const { runPython } = require('./python-bin.js')

// `subprocess` 那条缝必须给：原生 Windows 上 `run.js` 默认的 shell 桩是 `bash -c`
// （WSL 的 bash），宿主会拿它去跑 `python3`，Windows 路径被 WSL 解成
// `/mnt/c/...\tools\...` 而整条参考链红掉 —— 那不是被测代码的毛病。真桌面端给的也是
// `ctx.subprocess`（argv，不经 shell），所以这里按**真实形态**驱动。
const { buildHandlers, fsService } = require('./run.js')
const { realSubprocess } = require('./model-test.js')
const handlers = buildHandlers({ fs: fsService, subprocess: realSubprocess() })

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.mp-fixture')
const REF = nodePath.join(os.tmpdir(), 'mcart-mp-refs')
const NS18 = 't18'
const NS12 = 't12'

const FIXTURE = `
import json, os, struct, zlib
work, ref = ${JSON.stringify(WORK)}, ${JSON.stringify(REF)}

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

def png(rgba):
    rows = b''
    for _ in range(16):
        rows += b'\\x00' + bytes(rgba) * 16
    return (b'\\x89PNG\\r\\n\\x1a\\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows))
            + chunk(b'IEND', b''))

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(text)

def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)

def model(frm, to, tex):
    faces = {name: {'texture': tex} for name in ('down', 'up', 'north', 'south', 'west', 'east')}
    return {'textures': {'all': tex}, 'elements': [{'from': frm, 'to': to, 'faces': faces}]}

# 每块料一个自己的贴图名：这样"原版会画哪几个 apply"就是"拿到了哪几个模型"，
# 是一条可以直接断言的事实，而不是去猜面数。
PIECES = {
    'w_up':   ([4, 0, 4], [12, 16, 12], 'block/wpost'),
    'w_low':  ([4, 0, 0], [12, 16, 4],  'block/wlow'),
    'w_tall': ([4, 0, 0], [12, 16, 4],  'block/wtall'),
    'f_post': ([6, 0, 6], [10, 16, 10], 'block/fpost'),
    'f_side': ([7, 0, 0], [9, 16, 7],   'block/fside'),
    'nf_post': ([6, 0, 6], [10, 16, 10], 'block/nfpost'),
    'nf_side': ([7, 0, 0], [9, 16, 7],   'block/nfside'),
    'p_post': ([7, 0, 7], [9, 16, 9],   'block/ppost'),
    'p_side': ([7, 0, 0], [9, 16, 7],   'block/pside'),
    'p_noside': ([7, 0, 0], [9, 16, 1], 'block/pnoside'),
    'cube':   ([0, 0, 0], [16, 16, 16], 'block/solid'),
}

# 1.18.2 的 when 用字符串，1.12.2 的玻璃板用真布尔 -- 和 jar 里那两份文件一致，
# 于是"两种拼法都要认"这条也被门禁压着。
def wall_modern():
    out = [{'when': {'up': 'true'}, 'apply': {'model': 'w_up'}}]
    for name, turn in (('north', 0), ('east', 90), ('south', 180), ('west', 270)):
        for side, piece in (('low', 'w_low'), ('tall', 'w_tall')):
            apply = {'model': piece}
            if turn:
                apply['y'] = turn
            out.append({'when': {name: side}, 'apply': apply})
    return {'multipart': out}

def wall_legacy():
    out = [{'when': {'up': 'true'}, 'apply': {'model': 'w_up'}}]
    for name, turn in (('north', 0), ('east', 90), ('south', 180), ('west', 270)):
        apply = {'model': 'w_low'}
        if turn:
            apply['y'] = turn
        out.append({'when': {name: 'true'}, 'apply': apply})
    return {'multipart': out}

def fence(post, side):
    out = [{'apply': {'model': post}}]
    for name, turn in (('north', 0), ('east', 90), ('south', 180), ('west', 270)):
        apply = {'model': side}
        if turn:
            apply['y'] = turn
        out.append({'when': {name: 'true'}, 'apply': apply})
    return {'multipart': out}

def pane(truth):
    # 'truth' 是这一版在 when 里写字符串还是真布尔（1.18.2 写 "true"，1.12.2 写 true）。
    def value(flag):
        return ('true' if flag else 'false') if truth else flag
    out = [{'apply': {'model': 'p_post'}}]
    for name, turn in (('north', 0), ('east', 90), ('south', 180), ('west', 270)):
        for flag, piece in ((True, 'p_side'), (False, 'p_noside')):
            apply = {'model': piece}
            if turn:
                apply['y'] = turn
            out.append({'when': {name: value(flag)}, 'apply': apply})
    return {'multipart': out}

for ns, version, wall, panes in (( ${JSON.stringify(NS18)}, '1.18.2-test', wall_modern(), True),
                                 ( ${JSON.stringify(NS12)}, '1.12.2-test', wall_legacy(), False)):
    assets = os.path.join(ref, 'r' + version.split('.')[1], 'assets', ns)
    # 版本名只来自目录名（extractor: detail['version'] = basename(version_dir)），
    # 所以两个版本各要一棵带 versions/<name>/ 的根，且资源放在根上的 assets/ 里。
    os.makedirs(os.path.join(ref, 'r' + version.split('.')[1], 'versions', version), exist_ok=True)
    for name, (frm, to, tex) in PIECES.items():
        write(os.path.join(assets, 'models', 'block', name + '.json'), json.dumps(model(frm, to, tex)))
        write_bytes(os.path.join(assets, 'textures', tex + '.png'), png((200, 120, 60, 255)))
    write(os.path.join(assets, 'blockstates', 'wall.json'), json.dumps(wall))
    write(os.path.join(assets, 'blockstates', 'fence.json'), json.dumps(fence('f_post', 'f_side')))
    write(os.path.join(assets, 'blockstates', 'nether_brick_fence.json'),
          json.dumps(fence('nf_post', 'nf_side')))
    write(os.path.join(assets, 'blockstates', 'glass_pane.json'), json.dumps(pane(panes)))
    # 合成探针：形状像栅栏、名字不像的 multipart（红石线/绊线就是这一类）。
    # 家族认不出来时必须退回并集，而不是拿栅栏的规则去套。
    write(os.path.join(assets, 'blockstates', 'wire.json'), json.dumps({'multipart': [
        {'when': {'north': 'side'}, 'apply': {'model': 'w_low'}},
        {'when': {'north': 'up'}, 'apply': {'model': 'w_tall'}}]}))
    # 合成探针：一个"没有无条件 apply"的 multipart 栅栏。条件全不成立时结果就是
    # 一条都不画，用来钉住"空结果是正常答案，不是退回并集的信号"。
    write(os.path.join(assets, 'blockstates', 'postless_fence.json'),
          json.dumps({'multipart': fence('f_post', 'f_side')['multipart'][1:]}))
    write(os.path.join(assets, 'blockstates', 'cube.json'),
          json.dumps({'variants': {'': {'model': 'cube'}}}))

    # 项目本体：一个自己的方块，别的都走参考根。
    project = os.path.join(work, 'p' + version.split('.')[1])
    pack = os.path.join(project, 'pack', 'assets', 'projns')
    write(os.path.join(pack, 'blockstates', 'plain.json'),
          json.dumps({'variants': {'': {'model': 'plain'}}}))
    write(os.path.join(pack, 'models', 'block', 'plain.json'), json.dumps(model([0, 0, 0], [16, 16, 16], 'block/plain')))
    write_bytes(os.path.join(pack, 'textures', 'block', 'plain.png'), png((90, 90, 90, 255)))
    write(os.path.join(project, 'mc-art.atlas.json'),
          json.dumps({'namespace': 'projns', 'structures': [{'id': 's', 'cells': []}]}))
    write(os.path.join(project, 'mc-art.settings.json'),
          json.dumps({'schema': 'mc-art.settings/1',
                      'reference': {'directory': os.path.join(ref, 'r' + version.split('.')[1]),
                                    'includeGenerated': True, 'includeMods': True, 'mods': {}}}))
print('ok')
`

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.rmSync(REF, { recursive: true, force: true })
  const script = nodePath.join(os.tmpdir(), 'mcart-mp-fixture.py')
  nodeFs.writeFileSync(script, FIXTURE)
  const out = runPython([script], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('fixture failed: ' + (out.stderr || out.stdout))
}

// 画出来的模型，按贴图名去重排序：这直接就是"原版会画的那几个 apply"。
// `cell` 把范围限制到某一个格子 -- 邻居的方块也在同一份 quads 里，
// 不限定的话量到的就是"整个场景"而不是"这个方块"。
function drawn(payload, cell) {
  const seen = {}
  for (const quad of payload.quads || []) {
    if (cell !== undefined && (quad.pick === undefined || quad.pick.cell !== cell)) continue
    const parts = String(quad.tex).split('/')
    seen[parts[parts.length - 1]] = true
  }
  return Object.keys(seen).sort()
}

// 一条料有没有伸到某个边界（x=0/1，z=0/1）。用来确认"转了 90 度的那一支"
// 落在它该落的那一面，而不是只确认模型被选中了。
function arms(payload, texture, cell) {
  const seen = {}
  const near = (value, target) => Math.abs(value - target) < 0.02
  // 格子里的坐标已经被平移到了世界位置，所以量"伸到哪个边"之前要先减回格子的原点。
  const at = (cell !== undefined && payload.cells !== undefined && payload.cells[cell] !== undefined)
    ? payload.cells[cell].at : [0, 0, 0]
  for (const quad of payload.quads || []) {
    if (String(quad.tex).indexOf(texture) < 0) continue
    if (cell !== undefined && (quad.pick === undefined || quad.pick.cell !== cell)) continue
    const xs = quad.p.map((point) => point[0] - at[0])
    const zs = quad.p.map((point) => point[2] - at[2])
    if (xs.every((x) => near(x, 1))) seen.e = true
    if (xs.every((x) => near(x, 0))) seen.w = true
    if (zs.every((z) => near(z, 1))) seen.s = true
    if (zs.every((z) => near(z, 0))) seen.n = true
  }
  return Object.keys(seen).sort()
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function scene(version, cells, neighbours) {
  const request = { root: WORK, project: 'p' + version, kind: 'structure', id: 's', cells: cells }
  if (neighbours === false) request.neighbours = false
  const payload = await handlers['atlas.scene'](request)
  if (payload === undefined || payload.error !== undefined) {
    throw new Error('scene failed: ' + (payload === undefined ? 'undefined' : payload.error))
  }
  return payload
}

const cube = (ns, at) => ({ block: ns + ':cube', at: at })

async function main() {
  buildFixture()
  const N18 = NS18 + ':'
  const N12 = NS12 + ':'

  console.log('--- 1.18.2：空气不连，孤立一格墙只有柱子')
  const lone18 = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] }])
  check('孤立墙 = 只有 w_up（post），四个侧面一个都不画',
    same(drawn(lone18, 0), ['wpost']), drawn(lone18, 0))
  check('柱子不伸到任何边界', same(arms(lone18, 'block/w', 0), []), arms(lone18, 'block/w', 0))

  console.log('--- 1.18.2：侧面结实就连（低的那一支）')
  const one = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] }, cube(NS18, [1, 0, 0])])
  check('东边一个满方块 = post + 一条 low', same(drawn(one, 0), ['wlow', 'wpost']), drawn(one, 0))
  check('那一条 low 确实转到了东边（x=1）', same(arms(one, 'block/wlow', 0), ['e']),
    arms(one, 'block/wlow', 0))

  console.log('--- 1.18.2：四边都有满方块 = 四条 low，没有柱子')
  const four = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] },
    cube(NS18, [1, 0, 0]), cube(NS18, [-1, 0, 0]), cube(NS18, [0, 0, 1]), cube(NS18, [0, 0, -1])])
  check('四条 low，一个 tall 都没有', same(drawn(four, 0), ['wlow']), drawn(four, 0))
  check('四条分别落在四个方向', same(arms(four, 'block/wlow', 0), ['e', 'n', 's', 'w']),
    arms(four, 'block/wlow', 0))

  console.log('--- 1.18.2：头顶压着满方块 = 高的那一支，而且不要柱子')
  const tall = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] }, cube(NS18, [0, 1, 0]),
    cube(NS18, [1, 0, 0]), cube(NS18, [-1, 0, 0]), cube(NS18, [0, 0, 1]), cube(NS18, [0, 0, -1])])
  check('四条 tall（isCovered 的 aboveShape 是"我上面那格"，不是邻居上面那格）',
    same(drawn(tall, 0), ['wtall']), drawn(tall, 0))

  // 这一条专门压上面那个读数：把方块摞在邻居头上，而不是我头上。
  const overNeighbour = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] },
    cube(NS18, [1, 0, 0]), cube(NS18, [1, 1, 0])])
  check('邻居头顶上的方块不影响我这一侧的 low/tall（只影响我自己头顶）',
    same(drawn(overNeighbour, 0), ['wlow', 'wpost']), drawn(overNeighbour, 0))

  console.log('--- 1.18.2：一条直墙不要柱子（tallPair 那一支的极性）')
  const straight = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] },
    cube(NS18, [0, 0, 1]), cube(NS18, [0, 0, -1])])
  check('南北两个满方块 = 只有两条 low，没有柱子', same(drawn(straight, 0), ['wlow']),
    drawn(straight, 0))

  console.log('--- 1.18.2：木栅栏不连下界砖栅栏，也不连墙')
  const mixes = await scene('18', [{ block: N18 + 'fence', at: [0, 0, 0] },
    { block: N18 + 'nether_brick_fence', at: [1, 0, 0] }, { block: N18 + 'wall', at: [-1, 0, 0] }])
  check('木栅栏只画自己的柱子（isSameFence 要同木），不往两边长',
    same(drawn(mixes, 0), ['fpost']), drawn(mixes, 0))
  check('下界砖栅栏也只画自己的柱子', same(drawn(mixes, 1), ['nfpost']), drawn(mixes, 1))
  check('墙也不连栅栏（FenceBlock 没有 WALLS 那一支，两边都不成立）',
    same(drawn(mixes, 2), ['wpost']), drawn(mixes, 2))

  console.log('--- 1.18.2：玻璃板和墙互相都连')
  const paneWall = await scene('18', [{ block: N18 + 'glass_pane', at: [0, 0, 0] },
    { block: N18 + 'wall', at: [1, 0, 0] }])
  check('玻璃板往墙那边长出一条 side', same(arms(paneWall, 'block/pside', 0), ['e']),
    arms(paneWall, 'block/pside', 0))
  check('没连上的三面还有 noside，不是三个洞',
    drawn(paneWall, 0).indexOf('pnoside') >= 0 && drawn(paneWall, 0).indexOf('ppost') >= 0,
    drawn(paneWall, 0))
  check('墙也往玻璃板那边长一条（instanceof IronBarsBlock 与 WALLS 互为一支）',
    same(arms(paneWall, 'block/wlow', 1), ['w']), arms(paneWall, 'block/wlow', 1))

  console.log('--- 1.12.2：空气连得上，孤立一格墙是柱子加四臂')
  const lone12 = await scene('12', [{ block: N12 + 'wall', at: [0, 0, 0] }])
  check('孤立墙 = post + 四条 low（BlockAir 报 UNDEFINED，!= SOLID）',
    same(drawn(lone12, 0), ['wlow', 'wpost']), drawn(lone12, 0))
  check('四条臂都伸到边界', same(arms(lone12, 'block/wlow', 0), ['e', 'n', 's', 'w']),
    arms(lone12, 'block/wlow', 0))

  console.log('--- 1.12.2：满方块不连（面是 SOLID），和 1.18.2 正好相反')
  const one12 = await scene('12', [{ block: N12 + 'wall', at: [0, 0, 0] }, cube(NS12, [1, 0, 0])])
  check('东边一个满方块：那一条不画，另外三条（空气）照画',
    same(arms(one12, 'block/wlow', 0), ['n', 's', 'w']), arms(one12, 'block/wlow', 0))
  const four12 = await scene('12', [{ block: N12 + 'wall', at: [0, 0, 0] }, cube(NS12, [0, 1, 0]),
    cube(NS12, [1, 0, 0]), cube(NS12, [-1, 0, 0]), cube(NS12, [0, 0, 1]), cube(NS12, [0, 0, -1])])
  check('四边满方块 + 头顶有块：四条 side 全不画，只有 flag 算出来的那根柱子',
    same(drawn(four12, 0), ['wpost']), JSON.stringify(drawn(four12, 0)))
  // 上面那条只是"少画"，下面这条才是"一条都不画"：一个没有无条件 apply 的
  // multipart 方块，条件全不成立时结果就是空。`keepFlags` 必须把"空"当成一个
  // 正常答案交出去，而不是当成"推导不出来"退回并集。
  const postless = await scene('18', [{ block: N18 + 'postless_fence', at: [0, 0, 0] }])
  const postlessUnion = await scene('18', [{ block: N18 + 'postless_fence', at: [0, 0, 0] }], false)
  // 先证明这个方块真的抽得出来（并集那一次有 4 条 side），再说"四面都不连就是空的"。
  // 少了前一条，一个压根没抽出来的方块也会让后一条通过 —— 空得毫无意义。
  check('探针本身是对的：同一个方块关掉推导后画出 4 条 side',
    same(drawn(postlessUnion, 0), ['fside']), JSON.stringify(drawn(postlessUnion, 0)))
  check('没有无条件 apply 的 multipart：四面都不连时就是空的，不能退回并集',
    same(drawn(postless, 0), []), JSON.stringify(drawn(postless, 0)))
  check('同一个"孤立墙"场景两版答案不同：1.18.2 只有柱子，1.12.2 还有四条臂',
    same(drawn(lone18, 0), ['wpost']) && same(drawn(lone12, 0), ['wlow', 'wpost']),
    '1.18.2=' + drawn(lone18, 0) + ' 1.12.2=' + drawn(lone12, 0))

  console.log('--- 1.12.2：木栅栏**会**连下界砖栅栏和墙（判据只是"面不是满的"）')
  const fenceMix12 = await scene('12', [{ block: N12 + 'fence', at: [0, 0, 0] },
    { block: N12 + 'nether_brick_fence', at: [1, 0, 0] }, { block: N12 + 'wall', at: [-1, 0, 0] }])
  // 1.12.2 空气也连，所以南北本来就有；东西两边证明的是"它连了栅栏和墙"。
  check('木栅栏往东（下界砖栅栏）和往西（墙）都长出了 side',
    same(arms(fenceMix12, 'block/fside', 0), ['e', 'n', 's', 'w']),
    arms(fenceMix12, 'block/fside', 0))

  console.log('--- 1.12.2：玻璃板不连墙，墙却连玻璃板（1.12.2 的连接不对称）')
  const paneWall12 = await scene('12', [{ block: N12 + 'glass_pane', at: [0, 0, 0] },
    { block: N12 + 'wall', at: [1, 0, 0] }])
  check('玻璃板朝墙那一面没有 side（墙给 MIDDLE_POLE_THICK，既不是 SOLID 也不是 MIDDLE_POLE_THIN）',
    same(arms(paneWall12, 'block/pside', 0), []), arms(paneWall12, 'block/pside', 0))
  const wallPane12 = await scene('12', [{ block: N12 + 'wall', at: [0, 0, 0] },
    { block: N12 + 'glass_pane', at: [1, 0, 0] }])
  check('墙朝玻璃板那一面有 side（玻璃板给 MIDDLE_POLE_THIN，!= SOLID）',
    same(arms(wallPane12, 'block/wlow', 0), ['e', 'n', 's', 'w']),
    arms(wallPane12, 'block/wlow', 0))

  console.log('--- 认不出家族的 multipart 不能硬套规则')
  const wire = await scene('18', [{ block: N18 + 'wire', at: [0, 0, 0] }, cube(NS18, [0, 0, -1])])
  check('名字不像墙/栅栏/玻璃板的 multipart 保留并集（两个 apply 都画）',
    same(drawn(wire, 0), ['wlow', 'wtall']), JSON.stringify(drawn(wire, 0)))

  console.log('--- 关掉邻居推导要能拿回抽取器给的那一份并集')
  const union18 = await scene('18', [{ block: N18 + 'wall', at: [0, 0, 0] }], false)
  check('1.18.2 的墙并集 = 9 个 apply（1 柱 + 4 low + 4 tall）',
    same(drawn(union18, 0), ['wlow', 'wpost', 'wtall'])
      && arms(union18, 'block/wlow', 0).length === 4
      && arms(union18, 'block/wtall', 0).length === 4, JSON.stringify(drawn(union18, 0)))
  const union12 = await scene('12', [{ block: N12 + 'wall', at: [0, 0, 0] }], false)
  check('1.12.2 的墙并集 = 5 个 apply（1 柱 + 4 侧）',
    same(drawn(union12, 0), ['wlow', 'wpost']), drawn(union12, 0))

  console.log('--- 屏幕上不该再出现 multipart 的提示')
  check('一个正常的 multipart 场景一条提示都没有（用户要求删掉那两句）',
    (lone18.errors || []).length === 0 && (four.errors || []).length === 0,
    JSON.stringify(lone18.errors))

  console.log('--- 幽灵预览要和落地后一致')
  const ghostNames = (quads) => Object.keys(quads.reduce((seen, quad) => {
    const parts = String(quad.tex).split('/')
    seen[parts[parts.length - 1]] = true
    return seen
  }, {})).sort()
  const ghost = await handlers['atlas.preview']({ root: WORK, project: 'p18', block: N18 + 'wall',
    at: [0, 0, 0], variant: null, around: [{ d: [1, 0, 0], block: N18 + 'cube' }] })
  check('预览收到邻居时，幽灵也只有 post + 一条 low',
    ghost !== undefined && ghost.derived === true && same(ghostNames(ghost.quads), ['wlow', 'wpost']),
    ghost === undefined ? 'undefined' : JSON.stringify({ derived: ghost.derived, texes: ghostNames(ghost.quads) }))
  const ghostAlone = await handlers['atlas.preview']({ root: WORK, project: 'p18', block: N18 + 'wall',
    at: [0, 0, 0], variant: null })
  check('没有邻居时预览就是孤立墙的样子（只有柱子，6 面）',
    ghostAlone !== undefined && ghostAlone.quads.length === 6,
    ghostAlone === undefined ? 'undefined' : ghostAlone.quads.length + ' 面')

  console.log('--- 客户端要把邻居送过去，幽灵才会和落地后一样')
  // `aroundOf` 是纯函数，所以直接把它从客户端源码里抽出来、喂真数据。
  // 只断言"源码里出现了 around"会连"偏移算反了"一起放过，而偏移算反就是墙朝错的方向。
  const clientSrc = nodeFs.readFileSync(process.env.MCART_CLIENT || nodePath.join(__dirname, 'client.js'), 'utf8')
  const codeOnly = clientSrc.replace(/^\s*\/\/.*$/gm, '')
  function extract(name) {
    const start = clientSrc.indexOf('function ' + name + '(')
    if (start < 0) throw new Error('client.js 里没有 ' + name)
    const open = clientSrc.indexOf('{', start)
    let depth = 0
    for (let index = open; index < clientSrc.length; index++) {
      if (clientSrc[index] === '{') depth += 1
      else if (clientSrc[index] === '}') {
        depth -= 1
        if (depth === 0) return clientSrc.slice(start, index + 1)
      }
    }
    throw new Error('花括号没配平：' + name)
  }
  const aroundOf = new Function(extract('aroundOf') + '\nreturn aroundOf')()
  const near = [
    { block: 'n:east', at: [1, 0, 0] },
    { block: 'n:above', at: [0, 1, 0] },
    { block: 'n:aboveNorth', at: [0, 1, -1] },
    { block: 'n:twoAway', at: [0, 0, -2] },
    { block: 'n:here', at: [0, 0, 0] },
    { block: 'n:sidewaysUp', at: [1, 1, 0], variant: 'facing=east' },
  ]
  const around = aroundOf(near, [0, 0, 0])
  check('只送一格以内的邻居，且不含自己这一格',
    same(around.map((item) => item.d.join(',')).sort(),
      ['0,1,-1', '0,1,0', '1,0,0', '1,1,0']), JSON.stringify(around))
  check('偏移是相对被悬停的那一格（换个位置也一样）',
    same(aroundOf([{ block: 'n:east', at: [11, 5, 10] }], [10, 5, 10]).map((item) => item.d),
      [[1, 0, 0]]), JSON.stringify(aroundOf([{ block: 'n:east', at: [11, 5, 10] }], [10, 5, 10])))
  check('格子的朝向跟着邻居一起送（栅栏门只看轴，但轴在 variant 里）',
    JSON.stringify(around.filter((item) => item.variant !== undefined)) ===
      JSON.stringify([{ d: [1, 1, 0], block: 'n:sidewaysUp', variant: 'facing=east' }]),
    JSON.stringify(around.filter((item) => item.variant !== undefined)))
  check('预览请求带上了 around', /atlas\.preview'[\s\S]{0,400}around: around/.test(codeOnly))
  check('场景请求带上了 neighbours 开关',
    /atlas\.scene'[\s\S]{0,400}neighbours: state\.neighbours !== false/.test(codeOnly))
  check('邻居变了会重新问预览（只比对格子本身就会拿旧幽灵）',
    /ghostAsk === wantKey/.test(codeOnly) && /JSON\.stringify\(around\)/.test(codeOnly))
  check('"已经问过什么"记在 ghost 对象外面（记在它身上就会被某条赋值路径漏掉）',
    /let ghostAsk = ''/.test(codeOnly) && !/ghost\.aroundKey/.test(codeOnly))
  // 幽灵一直在闪的成因：身份挂在 ghost 上，而成功那条路是
  // `setGhost(Object.assign({}, result))`，宿主返回的东西里没有这个字段 ——
  // 下一帧身份检查就不成立了，于是每帧重问：ghost 一隐一现。
  // 所以这里直接量"宿主的预览返回值里没有这个字段"，把"不能存在它身上"钉住。
  const preview = await handlers['atlas.preview']({ root: WORK, project: 'p18', block: N18 + 'wall',
    at: [0, 0, 0], variant: null })
  check('宿主返回的预览结果里没有 aroundKey（所以它不能拿来当身份）',
    preview !== undefined && preview.aroundKey === undefined, JSON.stringify(Object.keys(preview || {})))
  check('面板上那个开关真的会重新取场景，不是只改标签',
    /neighbours: voxel\.neighbours === false/.test(codeOnly) && /refreshVoxel\(next\)/.test(codeOnly))

  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
