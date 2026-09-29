// Behavioural checks for block orientation (方块朝向).
//
// Driven end to end: extractor -> host -> quads.  A string check cannot tell
// whether the rotation was applied, applied in the right order, applied about
// the wrong point, or applied with the y sign backwards -- and the y sign is
// the whole difference between a furnace that faces east and one that faces
// west.  So this asks the running host for the quads and reads their normals.
const path = require('path')
// Same reasoning as anim-test: a hardcoded /tmp path made the mirror's copy of
// this test grade the working copy instead of what was emitted.
const { handlers } = require(process.env.MCART_RUN || path.join(__dirname, 'run.js'))

const PROJECT = { root: '/home/gmh/mc-art', project: 'fleshland' }

// WHICH MINECRAFT this measures is not this file's business to guess.
//
// The reference directory lives in the project's settings, and an earlier
// `test-reference.js` used to leave it pointing at `.minecraft` -- where the
// extractor auto-picks 1.12.2 -- so a whole sweep reported ten failures about
// blocks from another version for no reason at all.  A version the assertions
// were not written for is a CONFIGURATION fact, not a regression, so say which
// one it is out loud and exit 3 (skipped) instead of adding ten lines of red
// noise.
//
// 1.12.2, because that is what these numbers were measured against: a 1.12.2
// furnace declares four `facing` variants, and the 1.18.2 install's
// `minecraft:furnace` resolves through a mod to `forge_marker` data with eight
// `facing`+`lit` keys and no variant rotation at all -- so "the default variant
// has no rotation" and "facing=east lands on +X" are statements about a
// different blockstate shape, not about this code.  Re-deriving them for 1.18.2
// is real work and is NOT done.
const EXPECTED = '1.12.2'

async function requireVersion() {
  const refs = await handlers['atlas.refNamespaces'](PROJECT)
  const version = String(refs.version || '')
  if (version.indexOf(EXPECTED) >= 0) return
  console.log('跳过：参考目录现在量到的是 ' + (version || '（认不出）') + '，这批断言是按 '
    + EXPECTED + ' 量的。')
  console.log('     改 /home/gmh/mc-art/fleshland/mc-art.settings.json 的 reference.directory 再跑。')
  process.exit(3)
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// The quad's own winding, so the sign is a fact about the geometry rather than
// a convention this test invented.  `faceEast` etc. below compare against the
// face NAME the host reported, which is itself part of what is being checked.
function normalOf(quad) {
  const a = quad.p[0], b = quad.p[1], c = quad.p[2]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const len = Math.hypot(n[0], n[1], n[2]) || 1
  return n.map((x) => Math.round(x / len))
}

// Which axis a normal actually points along, ignoring the winding's sign.
function axisOf(normal) {
  const abs = normal.map(Math.abs)
  if (abs[0] === 1) return 'x'
  if (abs[1] === 1) return 'y'
  return 'z'
}

async function preview(block, variant) {
  const result = await handlers['atlas.preview'](Object.assign({}, PROJECT,
    { block: block, at: [0, 0, 0], variant: variant === undefined ? null : variant }))
  if (result === null || result === undefined || result.error !== undefined) {
    throw new Error(block + ' ' + variant + ' -> ' + (result && result.error))
  }
  return result
}

function facesWith(result, needle) {
  return result.quads.filter((quad) => String(quad.tex).indexOf(needle) >= 0)
}

;(async () => {
  await requireVersion()
  // --- the choices are reported, so the viewer has something to offer --------
  const furnace = await preview('minecraft:furnace', null)
  check('方块朝向导出的朝向清单来自 blockstate 本身',
    furnace.variants.length === 4 && furnace.variants.indexOf('facing=east') >= 0,
    JSON.stringify(furnace.variants))

  // --- default: the orientation the model was drawn in ----------------------
  // A furnace's model puts `front` on the north face.  Picking the alphabetically
  // first variant gave `facing=east`, i.e. the block opened facing a direction
  // nobody chose.
  const front = facesWith(await preview('minecraft:furnace', null), 'front_off')
  check('默认取没有旋转的那个变体（熔炉开口朝北，不是按字母排到的 east）',
    front.length > 0 && front[0].face === 'north', front.map((q) => q.face).join(','))

  // --- y is applied NEGATED, and north must land on east -------------------
  // This is the assertion the whole sign question rests on: `facing=east` is
  // `y: 90`, and a log is symmetric so it cannot settle it.
  const east = facesWith(await preview('minecraft:furnace', 'facing=east'), 'front_off')
  check('facing=east 把开口转到 +X（y 取负，不是正）',
    east.length > 0 && east[0].face === 'east' && axisOf(normalOf(east[0])) === 'x'
      && normalOf(east[0])[0] === 1,
    east.map((q) => q.face + ' ' + JSON.stringify(normalOf(q))).join(' | '))
  const south = facesWith(await preview('minecraft:furnace', 'facing=south'), 'front_off')
  check('facing=south 把开口转到 +Z',
    south.length > 0 && south[0].face === 'south' && normalOf(south[0])[2] === 1,
    south.map((q) => q.face).join(','))
  const west = facesWith(await preview('minecraft:furnace', 'facing=west'), 'front_off')
  check('facing=west 把开口转到 -X',
    west.length > 0 && normalOf(west[0])[0] === -1, west.map((q) => q.face).join(','))

  // --- x first, then y: a log is the case that needs both -------------------
  // oak_log declares axis=z as `x: 90` and axis=x as `x: 90, y: 90`; applying
  // them in the other order lands both on the same axis, which is the bug that
  // looks like "it works" until something asymmetric is drawn.
  const upright = facesWith(await preview('minecraft:oak_log', null), 'log_oak_top')
  check('默认原木竖着（年轮面朝上下）',
    upright.length > 0 && upright.every((q) => axisOf(normalOf(q)) === 'y'),
    upright.map((q) => q.face).join(','))
  const alongZ = facesWith(await preview('minecraft:oak_log', 'axis=z'), 'log_oak_top')
  check('axis=z 的年轮面朝 ±Z', alongZ.length > 0 && alongZ.every((q) => axisOf(normalOf(q)) === 'z'),
    alongZ.map((q) => q.face).join(','))
  const alongX = facesWith(await preview('minecraft:oak_log', 'axis=x'), 'log_oak_top')
  check('axis=x 的年轮面朝 ±X（先 x 再 y，顺序反了就还是 Z）',
    alongX.length > 0 && alongX.every((q) => axisOf(normalOf(q)) === 'x'),
    alongX.map((q) => q.face).join(','))

  // --- the shade follows the surface, because it is a brightness per face ----
  const logShades = alongX.map((q) => q.shade)
  check('转过之后明暗跟着面走（不然竖着的光照贴到横着的原木上）',
    logShades.every((value) => Math.abs(value - 0.6) < 1e-9), JSON.stringify(logShades))
  check('未旋转时年轮面仍是上下两种亮度',
    upright.map((q) => q.shade).sort().join(',') === '0.5,1',
    JSON.stringify(upright.map((q) => q.shade)))

  // --- a placed cell keeps its own orientation -----------------------------
  const scene = await handlers['atlas.scene'](Object.assign({}, PROJECT,
    { kind: 'biome', id: 'fleshland', cells: [
      { block: 'minecraft:oak_log', at: [0, 0, 0], variant: 'axis=x' },
      { block: 'minecraft:oak_log', at: [1, 0, 0] },
    ] }))
  if (scene.error !== undefined) {
    // A missing project fixture must not read as a pass.
    check('格子里的朝向跟着格子走', false, '拿不到场景：' + scene.error)
  } else {
    const rings = scene.quads.filter((quad) => String(quad.tex).indexOf('log_oak_top') >= 0)
    const axisX = rings.filter((q) => axisOf(normalOf(q)) === 'x')
    const axisY = rings.filter((q) => axisOf(normalOf(q)) === 'y')
    check('格子里的朝向跟着格子走：同一场景里一格是横的（±X），一格是竖的（±Y）',
      axisX.length === 2 && axisY.length === 2,
      'x=' + axisX.length + ' y=' + axisY.length)
  }

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => { console.error('THREW', error); process.exit(1) })
