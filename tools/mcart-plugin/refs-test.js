// The two things that only go wrong on the SECOND block.
//
// Both were reported by a user, not found by a test: place a prismarine block
// (fine), then place another one -- or one of its stairs -- and every face of
// the first one turns into the whole texture strip squashed flat.  Neither had
// anything to do with sampling: the strip判定 was already correct on screen
// (`判定 单帧 4`).  What was missing was the DATA.
//
//   1. `prismarine`, `prismarine_stairs` and `prismarine_slab` all resolve
//      `assets/minecraft/textures/block/prismarine.png`, so all three entries
//      carry ONE `ref:` handle -- and that handle holds the picture AND the
//      animation description.  Dropping any one of the three used to delete it.
//   2. A `multipart` blockstate is a list of `apply`s, each with its OWN y
//      rotation.  Baking them into one model draws all four wall sides the same
//      way; before this existed they had no geometry at all.
//
// So this drives the REAL handlers, with a REAL extractor run, against a
// synthetic reference root.  A string assertion would have passed through both
// bugs; these measure the quads and the payload that actually come back.
const os = require('os')
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')
const { runPython } = require('./python-bin.js')

// Reuse the same service stubs the other host gates use, so what runs here is
// the emitted host, not a re-implementation of it.
//
// `subprocess` 那条缝必须给：原生 Windows 上 `run.js` 默认的 shell 桩是 `bash -c`
// （WSL 的 bash），宿主会拿它去跑 `python3`，Windows 路径被 WSL 解成
// `/mnt/c/...\tools\...` 而整条参考链红掉 —— 那不是被测代码的毛病。真桌面端给的也是
// `ctx.subprocess`（argv，不经 shell），所以这里按**真实形态**驱动。
const { buildHandlers, fsService } = require('./run.js')
const { realSubprocess } = require('./model-test.js')
const handlers = buildHandlers({ fs: fsService, subprocess: realSubprocess() })

// The project has to live INSIDE the repository: the host finds the extractor by
// walking up from the project directory (`findTool`, five levels), so a fixture
// in /tmp reports "找不到 tools/mcart_extract_block.py" and every check here fails
// for the wrong reason.  The reference root can be anywhere -- it is handed to
// the extractor as `--root` -- so that one stays in /tmp.
const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.refs-fixture')
const REF = nodePath.join(os.tmpdir(), 'mcart-refs-refroot')
const NS = 'testref'
const PROJ = 'proj'

const FIXTURE = `
import json, os, struct, zlib
work, ref, ns, proj = ${JSON.stringify(WORK)}, ${JSON.stringify(REF)}, ${JSON.stringify(NS)}, ${JSON.stringify(PROJ)}

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

def png(width, height, frames):
    rows = b''
    for y in range(height):
        rows += b'\\x00' + bytes(frames[y // (height // len(frames))]) * width
    return (b'\\x89PNG\\r\\n\\x1a\\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
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

def cube(frm, to, tex):
    faces = {name: {'texture': tex} for name in ('down', 'up', 'north', 'south', 'west', 'east')}
    return {'textures': {'all': tex}, 'elements': [{'from': frm, 'to': to, 'faces': faces}]}

assets = os.path.join(ref, 'assets', ns)
# Two blocks that resolve the SAME texture file: they will share one ref: handle.
for name in ('pair_a', 'pair_b'):
    write(os.path.join(assets, 'blockstates', name + '.json'),
          json.dumps({'variants': {'': {'model': 'shared_cube'}}}))
write(os.path.join(assets, 'models', 'block', 'shared_cube.json'),
      json.dumps(cube([0, 0, 0], [16, 16, 16], 'block/shared')))
write_bytes(os.path.join(assets, 'textures', 'block', 'shared.png'),
            png(16, 64, [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255), (255, 255, 0, 255)]))
write(os.path.join(assets, 'textures', 'block', 'shared.png.mcmeta'),
      json.dumps({'animation': {'frametime': 2}}))

# A multipart block whose two applies are the SAME thin tab, the second turned
# 90 degrees: whether the per-apply rotation was applied is then a question about
# where the tab ended up, not about which model was picked.
write(os.path.join(assets, 'blockstates', 'edge.json'),
      json.dumps({'multipart': [{'apply': {'model': 'edge'}},
                                {'apply': {'model': 'edge', 'y': 90}}]}))
write(os.path.join(assets, 'models', 'block', 'edge.json'),
      json.dumps(cube([7, 0, 0], [9, 16, 1], 'block/solid')))
write_bytes(os.path.join(assets, 'textures', 'block', 'solid.png'), png(16, 16, [(240, 240, 240, 255)]))

# (also 1.12.2 shape: walls there are boolean sides, not low/tall -- the when
# values come from the pack either way, so the filter must not assume a spelling)
# A plain variants block whose only variant is turned 90 degrees: the OTHER
# way a rotation reaches a quad, and the one that broke the real GUI.
write(os.path.join(assets, 'blockstates', 'turned.json'),
      json.dumps({'variants': {'': {'model': 'edge', 'y': 90}}}))

project = os.path.join(work, proj)
pack = os.path.join(project, 'pack', 'assets', 'projns')
write(os.path.join(pack, 'blockstates', 'plain.json'),
      json.dumps({'variants': {'': {'model': 'plain'}}}))
write(os.path.join(pack, 'models', 'block', 'plain.json'), json.dumps(cube([0, 0, 0], [16, 16, 16], 'block/plain')))
write_bytes(os.path.join(pack, 'textures', 'block', 'plain.png'), png(16, 16, [(90, 90, 90, 255)]))
write(os.path.join(project, 'mc-art.atlas.json'),
      json.dumps({'namespace': 'projns', 'structures': [{'id': 's', 'cells': []}]}))
write(os.path.join(project, 'mc-art.settings.json'),
      json.dumps({'schema': 'mc-art.settings/1',
                  'reference': {'directory': ref, 'includeGenerated': True, 'includeMods': True, 'mods': {}}}))
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
  const script = nodePath.join(os.tmpdir(), 'mcart-refs-fixture.py')
  nodeFs.writeFileSync(script, FIXTURE)
  const out = runPython([script], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('fixture failed: ' + (out.stderr || out.stdout))
}

function scene(cells) {
  return handlers['atlas.scene']({ root: WORK, project: PROJ, kind: 'structure', id: 's', cells: cells })
}

async function main() {
  buildFixture()
  const HANDLE = 'ref:' + NS + ':block/shared'

  console.log('--- multipart：每个 apply 自己转')
  const wall = await scene([{ block: NS + ':edge', at: [0, 0, 0] }])
  check('multipart 方块有几何（以前是"这个方块没有几何模型"）',
    wall !== undefined && !wall.error && wall.quads.length > 0,
    wall === undefined ? 'undefined' : (wall.error || (wall.quads.length + ' 面')))
  const points = []
  for (const quad of (wall.quads || [])) for (const point of quad.p) points.push(point)
  const minZ = Math.min.apply(null, points.map((p) => p[2]))
  const maxX = Math.max.apply(null, points.map((p) => p[0]))
  // Unrotated the tab sits at z = 0..1/16 and x = 7/16..9/16.  Turned 90 degrees
  // about the block centre it lands at x = 1: so BOTH extremes prove the second
  // apply was rotated, and dropping the rotation leaves maxX at 0.5625.
  check('两个 apply 都画了，第二个确实转了 90°（一个在 -Z 边，一个到了 +X 边）',
    minZ <= 0.07 && maxX >= 0.93, 'minZ=' + minZ.toFixed(4) + ' maxX=' + maxX.toFixed(4))
  // 这条以前是反过来的：那时候"四面全画"是近似，所以要求屏幕上说一句"这是近似"。
  // 现在按邻居推导了（pkg-41），用户要求把那两句提示删掉，所以这里改成盯着它别回来。
  // 是文字检查，但它是"用户看得见的东西不许出现"这类要求，行为检查表达不了。
  check('屏幕上不再出现 multipart 提示（用户要求删掉了）',
    !(wall.errors || []).some((line) => String(line).indexOf('multipart') >= 0), wall.errors)

  console.log('--- 共用的 ref: 句柄，丢掉一个方块不能带走另一个的动画')
  const first = await scene([{ block: NS + ':pair_a', at: [0, 0, 0] }])
  check('第一个方块拿到了动画描述', first.animations[HANDLE] !== undefined, Object.keys(first.animations))
  const both = await scene([{ block: NS + ':pair_a', at: [0, 0, 0] },
    { block: NS + ':pair_b', at: [1, 0, 0] }])
  check('两个方块共用同一个句柄（这就是成因）',
    both.animations[HANDLE] !== undefined && both.textures[HANDLE] !== undefined,
    Object.keys(both.animations))
  const released = await handlers['atlas.releaseRefs']({ keep: [NS + ':pair_a'] })
  // Two entries go (pair_b and the multipart probe) and exactly one is left, so
  // this checks WHICH one survived rather than a count that happened to match.
  check('只留下 keep 里那一个条目', released.held === 1 && released.dropped >= 1, JSON.stringify(released))
  const after = await scene([{ block: NS + ':pair_a', at: [0, 0, 0] }])
  check('幸存方块的动画描述还在 —— 没有它客户端就会把整条图带糊在一张脸上',
    after.animations[HANDLE] !== undefined, JSON.stringify(Object.keys(after.animations)))
  check('贴图句柄也还在', after.textures[HANDLE] !== undefined, JSON.stringify(Object.keys(after.textures)))

  console.log('--- 真的没人用了，才该删掉')
  const empty = await handlers['atlas.releaseRefs']({ keep: [] })
  check('最后一个持有者被释放', empty.dropped >= 1, JSON.stringify(empty))
  const again = await scene([{ block: NS + ':pair_a', at: [0, 0, 0] }])
  check('重新抽取之后贴图和动画都回来了（缓存不是坏的）',
    again.textures[HANDLE] !== undefined && again.animations[HANDLE] !== undefined,
    JSON.stringify(Object.keys(again.animations)))

  console.log('--- 幽灵预览的返回值必须是可无损 JSON 的（运行时会拒 undefined）')
  // The real runtime rejects `undefined` anywhere in a handler's result
  // (`cloneJson`), and `rotateQuads` used to copy `pick` through even when the
  // quad had none -- so EVERY rotated preview failed at the RPC boundary.  This
  // is the same call the GUI makes, and `run.js` now enforces that contract.
  const multipartGhost = await handlers['atlas.preview']({
    root: WORK, project: PROJ, block: NS + ':edge', at: [0, 0, 0], variant: null })
  check('multipart 的幽灵预览回来了（每个 apply 都被转过）',
    multipartGhost !== undefined && multipartGhost.quads.length > 0, multipartGhost === undefined ? 'undefined' : multipartGhost.quads.length + ' 面')
  const turnedGhost = await handlers['atlas.preview']({
    root: WORK, project: PROJ, block: NS + ':turned', at: [0, 0, 0], variant: null })
  check('variants 里带 y 旋转的幽灵预览也回来了',
    turnedGhost !== undefined && turnedGhost.quads.length > 0, turnedGhost === undefined ? 'undefined' : turnedGhost.quads.length + ' 面')

  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
