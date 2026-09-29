// Two ways a 2D item icon comes out wrong, both found by looking at a rendered
// sheet rather than at the code:
//
//   1. THE PROJECTION.  `iconCamera` is orthographic: screen x/y ARE model x/y,
//      with no perspective divide.  `renderScene` interpolated texture
//      coordinates with the PERSPECTIVE formula anyway (`u = Σ(w·uv/z) / Σ(w/z)`),
//      which is only correct when the camera divides by depth.  Under an
//      orthographic camera every face that has any depth across it came out
//      warped -- a cube's three visible faces subtly, and a cross's diagonal
//      plane badly enough to split the sprite down the middle.
//
//      So this gate does not search the source for a flag.  It draws a striped
//      texture on a plane that ramps in depth and measures the STRIPE WIDTHS:
//      under the correct interpolation they are all equal, under the wrong one
//      the far side is compressed to half.  Then it injects the fault (drop the
//      flag) and requires the same measurement to break.
//
//   2. THE PACK.  An item model that resolves to geometry with no `display.gui`
//      is drawn flat-on and, for `block/cross`, cut in half -- that is what the
//      game does too, so the icon looks broken in the inventory of the shipped
//      mod.  Vanilla's own flower items point at `item/generated` instead.  This
//      gate asks the HOST for the project's items and fails if any of them is
//      iso without a display, naming the file to change.
const os = require('os')
const nodeFs = require('fs')
const nodePath = require('path')

const { handlers } = require('./run.js')

const CLIENT = process.env.MCART_CLIENT || nodePath.join(__dirname, 'client.js')
const REPO = nodePath.resolve(__dirname, '..', '..')
const PROJECT = process.env.MCART_PROJECT || 'fleshland'

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  OK   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

/** The number is the evidence, so it is printed whether the check passes or not. */
function note(text) { console.log('       ' + text) }

function loadClient(patches) {
  let source = nodeFs.readFileSync(CLIENT, 'utf8')
  for (const patch of patches || []) {
    if (source.indexOf(patch[0]) < 0) throw new Error('注入失败，没找到：' + patch[0].slice(0, 60))
    source = source.replace(patch[0], patch[1])
  }
  const start = source.indexOf('const sub =')
  const end = source.indexOf('const CSS = [')
  const failureAt = source.indexOf('function failureOf(')
  const commentAt = source.lastIndexOf('/**', failureAt)
  const commentEnd = commentAt < 0 ? -1 : source.indexOf('*/', commentAt)
  const tail = source.slice(commentEnd >= 0 && commentEnd < failureAt ? commentAt : failureAt,
    source.indexOf('function cssColour'))
  const body = 'let animTicks = 0\n' + source.slice(start, end) + tail
  return new Function('document', body + `
    return { renderScene: renderScene, iconCamera: iconCamera, drawItemIcon: drawItemIcon,
      setTicks: function (value) { animTicks = value } }`)({
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  })
}

/** Eight 2-px vertical stripes.  Even in the texture, so uneven on screen is the
 *  renderer's doing and nothing else's. */
function stripeTexture() {
  const width = 16, height = 16
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.floor(x / 2) % 2 === 0 ? 255 : 0
      const at = (y * width + x) * 4
      data[at] = value; data[at + 1] = value; data[at + 2] = value; data[at + 3] = 255
    }
  }
  return { width: width, height: height, data: data }
}

/** A face whose depth ramps across its whole width: z=0 on the left edge, z=1 on
 *  the right.  Under the icon camera that is a 1:2 depth ratio, which is exactly
 *  the case the perspective formula gets wrong. */
function slantedQuad() {
  return { p: [[0, 0, 0], [0, 1, 0], [1, 1, 1], [1, 0, 1]],
    uv: [[0, 0], [0, 1], [1, 1], [1, 0]],
    tex: 'stripes', shade: 1, shaded: false, mode: 'opaque', face: 'north' }
}

const SIZE = 256

/** The widths of the stripe runs along the middle row, minus the two end runs
 *  (they are clipped by the face's edge and would be partial by construction). */
function stripeWidths(pixels) {
  const y = SIZE >> 1
  const runs = []
  let current = null
  for (let x = 0; x < SIZE; x++) {
    const at = (y * SIZE + x) * 4
    const bright = pixels[at] >= 128
    if (current !== null && current.bright === bright) current.width += 1
    else { current = { bright: bright, width: 1 }; runs.push(current) }
  }
  const interior = runs.slice(1, runs.length - 1).map((run) => run.width)
  return interior
}

function evenness(pixels) {
  const widths = stripeWidths(pixels)
  if (widths.length < 4) return { ratio: Infinity, widths: widths }
  const min = Math.min.apply(null, widths)
  const max = Math.max.apply(null, widths)
  return { ratio: min <= 0 ? Infinity : max / min, widths: widths }
}

async function main() {
  const api = loadClient()
  const quad = slantedQuad()
  const textures = { stripes: stripeTexture() }
  const camera = api.iconCamera([quad], SIZE, SIZE, 0.98)

  const render = (extra) => api.renderScene(Object.assign({ width: SIZE, height: SIZE,
    background: [0, 0, 0], backgroundAlpha: 0, camera: camera, quads: [quad],
    textures: textures, animations: {}, timeMs: 0 }, extra))

  console.log('--- 正交相机下的贴图插值（条纹宽度应处处相等）')
  const flat = evenness(render({ orthographic: true }))
  note('orthographic:true  最宽/最窄 = ' + flat.ratio.toFixed(2) + '  条纹宽 ' + JSON.stringify(flat.widths))
  check('orthographic:true 时条纹等宽', flat.ratio <= 1.1)

  // The fault: the same picture with the flag off.  If this stays even, the
  // measurement above proves nothing -- it has to be able to fail.
  const warped = evenness(render({ orthographic: false }))
  note('orthographic:false 最宽/最窄 = ' + warped.ratio.toFixed(2) + '  条纹宽 ' + JSON.stringify(warped.widths))
  check('注入故障（orthographic:false）时同一处测量报错：远侧被压到一半',
    warped.ratio >= 1.5 && warped.ratio > 1.1)

  // And through the REAL icon path, which is where the user saw it.
  const recipe = { shape: 'iso', display: null, quads: [quad], animations: {}, frames: [] }
  const canvas = { width: SIZE, height: SIZE, _data: null, getContext: null }
  const paint = {
    clearRect: () => { canvas._data.fill(0) },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (frame) => { canvas._data.set(frame.data) },
    drawImage: () => { },
  }
  canvas._data = new Uint8ClampedArray(SIZE * SIZE * 4)
  canvas.getContext = () => paint
  api.drawItemIcon(canvas, recipe, 0, textures)
  const icon = evenness(canvas._data)
  note('drawItemIcon       最宽/最窄 = ' + icon.ratio.toFixed(2) + '  条纹宽 ' + JSON.stringify(icon.widths))
  check('drawItemIcon 画出来的图标也是等宽的（它自己带上了这个标记）', icon.ratio <= 1.1)

  // The fault, at the call site this time: remove the flag from `drawItemIcon`
  // and the icon path must go back to the warped measurement.
  const patched = loadClient([['orthographic: true,', '']])
  const badCanvas = { width: SIZE, height: SIZE, _data: new Uint8ClampedArray(SIZE * SIZE * 4) }
  badCanvas.getContext = () => Object.assign({}, paint, {
    clearRect: () => { badCanvas._data.fill(0) },
    putImageData: (frame) => { badCanvas._data.set(frame.data) },
  })
  patched.drawItemIcon(badCanvas, recipe, 0, textures)
  const bad = evenness(badCanvas._data)
  check('注入故障（drawItemIcon 不带标记）时图标立刻变歪',
    bad.ratio > 1.1, '最宽/最窄 = ' + bad.ratio.toFixed(2))

  console.log('--- 项目里的物品模型会不会在游戏里画歪')
  const root = REPO
  const scan = await handlers['atlas.scan']({ root: root })
  const project = (scan.projects || []).filter((entry) => entry.id === PROJECT)[0]
  if (project === undefined) {
    check('找到项目 ' + PROJECT, false, '扫描结果里没有它')
  } else {
    const list = await handlers['atlas.refItems']({ root: root, project: PROJECT,
      source: 'project', namespace: project.namespace })
    const facts = (list.items || []).filter((entry) => entry.parentOnly !== true)
    check('拿到 ' + PROJECT + ' 的物品清单', facts.length > 0, String(facts.length) + ' 个')
    const page = await handlers['atlas.itemIcons']({ root: root, project: PROJECT, source: 'project',
      namespace: project.namespace, items: facts.map((entry) => entry.id) })
    const crippled = []
    const counted = { flat: 0, iso: 0, none: 0 }
    for (const entry of facts) {
      const recipe = (page.items || {})[entry.id]
      if (recipe === undefined) continue
      if (counted[recipe.shape] !== undefined) counted[recipe.shape] += 1
      if (recipe.shape === 'iso' && (recipe.display === null || recipe.display === undefined)) {
        crippled.push(entry.id)
      }
    }
    check('每种物品都真的取到了配方', Object.keys(page.items || {}).length === facts.length,
      Object.keys(page.items || {}).length + '/' + facts.length)
    console.log('      形状：' + JSON.stringify(counted))
    // The rule, and the reason this gate exists: `models/item/X.json` must not
    // point at geometry that has no `display.gui`.  Vanilla's flowers put
    // `item/generated` (layer0 = the block texture) in front of `block/cross`.
    check('没有「物品模型指向没有 display 的几何模型」的物品',
      crippled.length === 0,
      crippled.length === 0 ? '' : crippled.join('、')
        + ' ← 把 models/item/<名字>.json 改成 item/generated（layer0 指向那张贴图）')
  }

  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
