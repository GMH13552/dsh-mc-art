// The 2D inventory icon -- the thing the user asked for by name
// ("给这个 3D 渲染加一个 2D UI 的物品栏展示").
//
// An icon is NOT a small 3D view.  Vanilla draws a block item with the GUI's
// own matrix (`display.gui`: rotation [30,225,0], scale 0.625, orthographic) and
// with the GUI's OWN lighting, whose face brightness (up 1.0, east 0.637,
// north 0.435) is not the world's (1.0/0.8/0.6).  Both halves were measured in
// `vanilla3d/tools/render_item_model.py` rather than recalled, and both are
// easy to get subtly wrong:
//
//   * the item matrix is Rx(30)*Ry(225) -- yaw FIRST, then pitch.  Swapping the
//     order still draws a cube, so the picture looks plausible and every
//     string-based check passes;
//   * the face name has to follow the vertices through those same rotations.
//     Get it wrong and the icon is shaded with the wrong row of the table.
//
// So this gate does not assert that the code contains a rotation.  It draws the
// icon for a REAL extractor output, measures the pixels, and checks the three
// brightness levels that came out; then it PATCHES the source to inject each of
// the two mistakes above and requires the same measurement to complain.  A check
// that cannot fail on the bug it names is not a check.
//
// The other half is the two ways an item animates: `overrides` (vanilla's clock
// is 64 model swaps) and an animated texture strip (`.mcmeta`).  Both are driven
// through the same frame clock and both are measured here.
const os = require('os')
const nodeFs = require('fs')
const nodePath = require('path')
const cp = require('child_process')

// The same service stubs every other host gate uses, so what runs here is the
// emitted host -- not a re-implementation of it.
const { handlers } = require('./run.js')

// 1x1 opaque PNG, for the "can the pen write this item texture" check.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.icon-fixture')
const REF = nodePath.join(os.tmpdir(), 'mcart-icon-refroot')
const NS = 'testicon'
const PROJ = 'proj'

// A block item, a flat tool, a two-layer spawn egg, a three-frame clock, an
// animated strip and a code-drawn item (`parent: builtin/entity`, which has no
// icon data anywhere in the pack).
const FIXTURE = `
import json, os, struct, zlib
work, ref, ns, proj = ${JSON.stringify(WORK)}, ${JSON.stringify(REF)}, ${JSON.stringify(NS)}, ${JSON.stringify(PROJ)}

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

def png(width, height, rows):
    body = b''
    for y in range(height):
        body += b'\\x00' + bytes(rows[y]) * width
    return (b'\\x89PNG\\r\\n\\x1a\\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(body))
            + chunk(b'IEND', b''))

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(text)

def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)

assets = os.path.join(ref, 'assets', ns)
# The GUI matrix lives on the block parent, exactly as vanilla puts it on
# block/block; an item model that does not reach it has no icon transform.
write(os.path.join(assets, 'models', 'block', 'block.json'), json.dumps({
    'gui_light': 'side',
    'display': {'gui': {'rotation': [30, 225, 0], 'translation': [0, 0, 0],
                        'scale': [0.625, 0.625, 0.625]}}}))
faces = {name: {'texture': '#all'} for name in ('down', 'up', 'north', 'south', 'west', 'east')}
write(os.path.join(assets, 'models', 'block', 'cube.json'), json.dumps({
    'parent': 'block/block', 'textures': {'all': 'block/boulder', 'particle': '#all'},
    'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16], 'faces': faces}]}))
write(os.path.join(assets, 'models', 'item', 'boulder.json'),
      json.dumps({'parent': 'testicon:block/cube'}))
write_bytes(os.path.join(assets, 'textures', 'block', 'boulder.png'), png(16, 16, [[255, 255, 255, 255]] * 16))

write(os.path.join(assets, 'models', 'item', 'generated.json'), json.dumps({
    'gui_light': 'front',
    'display': {'gui': {'rotation': [0, 0, 0], 'translation': [0, 0, 0], 'scale': [1, 1, 1]}}}))
# The same vanilla parents again, under the minecraft namespace, because that is what an
# UNQUALIFIED reference means in the game (and what a project pack therefore
# needs from the game root).
vanilla = os.path.join(ref, 'assets', 'minecraft')
write(os.path.join(vanilla, 'models', 'block', 'block.json'), json.dumps({
    'gui_light': 'side',
    'display': {'gui': {'rotation': [30, 225, 0], 'translation': [0, 0, 0],
                        'scale': [0.625, 0.625, 0.625]}}}))
write(os.path.join(vanilla, 'models', 'block', 'cube.json'), json.dumps({
    'parent': 'block/block', 'textures': {'all': '#all', 'particle': '#all'},
    'elements': [{'from': [0, 0, 0], 'to': [16, 16, 16],
                  'faces': {name: {'texture': '#all'} for name in ('down', 'up', 'north', 'south', 'west', 'east')}}]}))
write(os.path.join(vanilla, 'models', 'item', 'generated.json'), json.dumps({
    'gui_light': 'front',
    'display': {'gui': {'rotation': [0, 0, 0], 'translation': [0, 0, 0], 'scale': [1, 1, 1]}}}))
write(os.path.join(assets, 'models', 'item', 'handheld.json'),
      json.dumps({'parent': 'item/generated'}))
for name in ('egg', 'ticker_00', 'ticker_01', 'ticker_02', 'lava_gem'):
    write(os.path.join(assets, 'models', 'item', name + '.json'),
          json.dumps({'parent': 'item/generated', 'textures': {'layer0': 'item/' + name}}))
# A tool is a tool because its model chain reaches item/handheld (that is what
# the game asks), not because its name contains "tool".
write(os.path.join(assets, 'models', 'item', 'flat_tool.json'),
      json.dumps({'parent': 'item/handheld', 'textures': {'layer0': 'item/flat_tool'}}))
write(os.path.join(assets, 'models', 'item', 'egg.json'), json.dumps({
    'parent': 'item/generated', 'textures': {'layer0': 'item/egg_base', 'layer1': 'item/egg_overlay'}}))
write_bytes(os.path.join(assets, 'textures', 'item', 'egg_base.png'), png(16, 16, [[200, 30, 30, 255]] * 16))
write_bytes(os.path.join(assets, 'textures', 'item', 'egg_overlay.png'), png(16, 16, [[30, 30, 220, 255]] * 16))
# 64 model swaps is what vanilla's clock is; three is enough to measure the same
# mechanism without writing 64 files.
write(os.path.join(assets, 'models', 'item', 'ticker.json'), json.dumps({
    'parent': 'item/generated', 'textures': {'layer0': 'item/ticker_00'},
    'overrides': [{'predicate': {'time': 0.0}, 'model': 'item/ticker_00'},
                  {'predicate': {'time': 0.4}, 'model': 'item/ticker_01'},
                  {'predicate': {'time': 0.8}, 'model': 'item/ticker_02'}]}))
for index, colour in enumerate(((255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255))):
    write_bytes(os.path.join(assets, 'textures', 'item', 'ticker_0%d.png' % index),
                png(16, 16, [colour] * 16))
write_bytes(os.path.join(assets, 'textures', 'item', 'flat_tool.png'), png(16, 16, [[10, 200, 10, 255]] * 16))
# A four-frame vertical strip, one distinct colour per row.
write_bytes(os.path.join(assets, 'textures', 'item', 'lava_gem.png'),
            png(16, 64, [[255, 0, 0, 255]] * 16 + [[0, 255, 0, 255]] * 16
                       + [[0, 0, 255, 255]] * 16 + [[255, 255, 0, 255]] * 16))
write(os.path.join(assets, 'textures', 'item', 'lava_gem.png.mcmeta'),
      json.dumps({'animation': {'frametime': 2}}))
# A block entity item: its model says parent: builtin/entity, and the drawing
# code lives in the game, so there is nothing on disk to bake.
write(os.path.join(assets, 'models', 'item', 'codething.json'),
      json.dumps({'parent': 'builtin/entity'}))

project = os.path.join(work, proj)
# The index takes a project's namespace from its pack directory, so a project
# with an atlas file but no pack is skipped entirely ("找不到项目").
write(os.path.join(project, 'pack', 'assets', 'projns', 'lang', 'zh_cn.json'),
      json.dumps({'block.projns.plain': '占位', 'item.projns.projthing': '本项目方块',
                  'item.projns.projflat': '本项目平图'}))
# A project pack ships its item models but NOT the vanilla parents they inherit,
# and {"parent": "block/cube"} is UNQUALIFIED -- in the game that means
# minecraft:block/cube.  So the pack alone resolves nothing.
write(os.path.join(project, 'pack', 'assets', 'projns', 'models', 'item', 'projthing.json'),
      json.dumps({'parent': 'projns:block/projthing'}))
write(os.path.join(project, 'pack', 'assets', 'projns', 'models', 'block', 'projthing.json'),
      json.dumps({'parent': 'block/cube', 'textures': {'all': 'projns:block/projthing'}}))
write_bytes(os.path.join(project, 'pack', 'assets', 'projns', 'textures', 'block', 'projthing.png'),
            png(16, 16, [[240, 240, 240, 255]] * 16))
write(os.path.join(project, 'pack', 'assets', 'projns', 'models', 'item', 'projflat.json'),
      json.dumps({'parent': 'item/generated', 'textures': {'layer0': 'projns:item/projflat'}}))
write_bytes(os.path.join(project, 'pack', 'assets', 'projns', 'textures', 'item', 'projflat.png'),
            png(16, 16, [[20, 200, 20, 255]] * 16))
write(os.path.join(project, 'mc-art.atlas.json'),
      json.dumps({'namespace': 'projns', 'structures': [{'id': 's', 'cells': []}]}))
write(os.path.join(project, 'mc-art.settings.json'),
      json.dumps({'schema': 'mc-art.settings/1',
                  'reference': {'directory': ref, 'includeGenerated': True,
                                'includeMods': True, 'mods': {}}}))
print('ok')
`

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label
    + (ok || detail === undefined ? '' : '  -> ' + detail))
}

function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.rmSync(REF, { recursive: true, force: true })
  const script = nodePath.join(os.tmpdir(), 'mcart-icon-fixture.py')
  nodeFs.writeFileSync(script, FIXTURE)
  const out = cp.spawnSync('python3', [script], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('fixture failed: ' + (out.stderr || out.stdout))
}

// ---------------------------------------------------------------------------
// the client half, sliced out of the file that is actually emitted
// ---------------------------------------------------------------------------
//
// `drawItemIcon` reads the module-level frame clock, and `itemIconUrl` uses
// `document.createElement`; the slice has no such names, so the loader supplies
// them as parameters -- the same values the browser would, made measurable.
function loadClient(patches) {
  let source = nodeFs.readFileSync(process.env.MCART_CLIENT
    || nodePath.join(__dirname, 'client.js'), 'utf8')
  for (const patch of patches || []) {
    if (source.indexOf(patch[0]) < 0) throw new Error('注入失败，没找到：' + patch[0].slice(0, 60))
    source = source.replace(patch[0], patch[1])
  }
  const start = source.indexOf('const sub =')
  const end = source.indexOf('const CSS = [')
  // `failureOf` sits just above `countsOf`, both after the CSS array.  The doc
  // comment above it is included when there IS one -- this gate also runs
  // against the STRIPPED file (`MCART_CLIENT=...`), which has no comments at
  // all, and a slice that starts at a comment that is not there returns -1 and
  // silently cuts off the function.
  const failureAt = source.indexOf('function failureOf(')
  const commentAt = source.lastIndexOf('/**', failureAt)
  const commentEnd = commentAt < 0 ? -1 : source.indexOf('*/', commentAt)
  const counts = source.slice(commentEnd >= 0 && commentEnd < failureAt ? commentAt : failureAt,
    source.indexOf('function cssColour'))
  const body = 'let animTicks = 0\n' + source.slice(start, end) + counts
  return new Function('document', body + `
    return { renderScene: renderScene, guiItemRotation: guiItemRotation, iconCamera: iconCamera,
      drawItemIcon: drawItemIcon, itemIconUrl: itemIconUrl, clearViewport: clearViewport,
      rotateAbout: rotateAbout,
      boxOfQuads: boxOfQuads, animationRow: animationRow,
      stripOf: stripOf, GUI_FACE_SHADE: GUI_FACE_SHADE,
      countsOf: countsOf, failureOf: failureOf,
      setTicks: function (value) { animTicks = value } }`)(fakeDocument())
}

/** A canvas stand-in with real pixels: `drawImage` composites nearest-neighbour
 *  source-over, which is what makes a LAYER ORDER or a STRIP ROW measurable. */
function fakeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  function blit(node, args) {
    const src = node._pixels
    if (src === undefined) return
    const sourceWidth = node.naturalWidth
    const sourceHeight = node.naturalHeight
    let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight, dx = 0, dy = 0, dw = width, dh = height
    if (args.length >= 8) { sx = args[0]; sy = args[1]; sw = args[2]; sh = args[3]; dx = args[4]; dy = args[5]; dw = args[6]; dh = args[7] }
    else if (args.length === 4) { dx = args[0]; dy = args[1]; dw = args[2]; dh = args[3] }
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const px = dx + x, py = dy + y
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const u = Math.floor(sx + ((x + 0.5) * sw) / dw)
      const v = Math.floor(sy + ((y + 0.5) * sh) / dh)
      if (u < 0 || v < 0 || u >= sourceWidth || v >= sourceHeight) continue
      const from = (v * sourceWidth + u) * 4
      const to = (py * width + px) * 4
      const alpha = src[from + 3] / 255
      if (alpha <= 0) continue
      for (let c = 0; c < 3; c++) data[to + c] = Math.round(src[from + c] * alpha + data[to + c] * (1 - alpha))
      data[to + 3] = Math.max(data[to + 3], src[from + 3])
    }
  }
  const context = {
    imageSmoothingEnabled: true,
    clearRect: () => { data.fill(0) },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (frame) => { data.set(frame.data.subarray(0, data.length)) },
    drawImage: function (node) { blit(node, Array.prototype.slice.call(arguments, 1)) },
  }
  return {
    width: width, height: height, _data: data,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,' + fingerprint(data),
  }
}

function fakeDocument() {
  return { createElement: () => fakeCanvas(32, 32) }
}

function fingerprint(data) {
  let hash = 2166136261
  for (let i = 0; i < data.length; i++) { hash ^= data[i]; hash = Math.imul(hash, 16777619) >>> 0 }
  return hash.toString(16)
}

function solid(width, height, colour) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = colour[0]; data[i * 4 + 1] = colour[1]
    data[i * 4 + 2] = colour[2]; data[i * 4 + 3] = colour[3]
  }
  return { width: width, height: height, data: data }
}

function strip(width, rows) {
  const data = new Uint8ClampedArray(width * rows.length * width * 4)
  for (let row = 0; row < rows.length; row++) {
    for (let i = 0; i < width * width; i++) {
      const at = (row * width * width + i) * 4
      data[at] = rows[row][0]; data[at + 1] = rows[row][1]
      data[at + 2] = rows[row][2]; data[at + 3] = rows[row][3]
    }
  }
  return { width: width, height: width * rows.length, data: data }
}

/** The distinct red levels among the opaque pixels, biggest first. */
function levels(data) {
  const seen = {}
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue
    seen[data[i]] = (seen[data[i]] || 0) + 1
  }
  return Object.keys(seen).map(Number).sort((a, b) => b - a)
}

function coverage(data) {
  let opaque = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 250) opaque += 1
  return opaque / (data.length / 4)
}

function solidColour(data) {
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 250) return [data[i], data[i + 1], data[i + 2]]
  return null
}

// One distinct colour per face, so the icon's pixels say WHICH faces are on
// screen and how bright each one came out -- not merely that something was
// drawn.  The face brightness is the GUI's own table (up 1.0, east 0.637,
// north 0.435); the world's would be 1.0/0.8/0.6.
const FACE_COLOURS = { up: [255, 255, 255], down: [128, 0, 0], north: [0, 0, 255],
  south: [0, 255, 0], west: [255, 255, 0], east: [255, 0, 0] }
const GUI_SHADE = { up: 1.0, east: 0.637, north: 0.435, down: 0.4, south: 0.4, west: 0.4 }

/** The three faces vanilla's GUI view shows, and what each must measure. */
function expectedColours() {
  return ['up', 'east', 'north'].map((face) => ({
    face: face,
    colour: FACE_COLOURS[face].map((value) => Math.round(value * GUI_SHADE[face])),
  }))
}

/** Every distinct opaque colour in the picture, with how many pixels it has. */
function colours(data) {
  const out = {}
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue
    const key = data[i] + ',' + data[i + 1] + ',' + data[i + 2]
    out[key] = (out[key] || 0) + 1
  }
  return out
}

/** Paint each face of the model its own colour, keeping the real geometry. */
function faceTextured(quads) {
  const decoded = {}
  const painted = quads.map((quad) => {
    const id = 'tex:' + quad.face
    decoded[id] = solid(16, 16, FACE_COLOURS[quad.face].concat([255]))
    return { p: quad.p, uv: quad.uv, tex: id, shade: quad.shade, mode: quad.mode,
      face: quad.face, shaded: quad.shaded }
  })
  return { quads: painted, decoded: decoded }
}

/** Everything that can be measured about one iso icon. */
function measureIso(api, quads, display, size) {
  const canvas = fakeCanvas(size, size)
  const painted = faceTextured(quads)
  api.drawItemIcon(canvas, { shape: 'iso', display: display, quads: painted.quads,
    animations: {}, textureIds: Object.keys(painted.decoded) }, 0, painted.decoded)
  const gui = display === null || display === undefined ? { rotation: [0, 0, 0] } : display
  const rotated = api.guiItemRotation(painted.quads, gui.rotation)
  // The orthographic icon camera: everything inside the canvas, and the model
  // filling it (fill 0.98), not floating in a corner.
  const camera = api.iconCamera(rotated, size, size, 0.98)
  const xs = [], ys = []
  for (const quad of rotated) for (const point of quad.p) {
    const projected = camera.project(point)
    xs.push(projected[0]); ys.push(projected[1])
  }
  const extent = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs),
    Math.max.apply(null, ys) - Math.min.apply(null, ys)) / size
  const inside = Math.min.apply(null, xs) >= -0.5 && Math.max.apply(null, xs) <= size + 0.5
    && Math.min.apply(null, ys) >= -0.5 && Math.max.apply(null, ys) <= size + 0.5
  const found = colours(canvas._data)
  const wanted = expectedColours()
  return { found: found, wanted: wanted,
    exact: wanted.every((entry) => found[entry.colour.join(',')] !== undefined)
      && Object.keys(found).length === wanted.length,
    coverage: coverage(canvas._data), extent: extent, inside: inside }
}

function isoPasses(measured) {
  return measured.exact && measured.coverage > 0.35 && measured.inside && measured.extent > 0.9
}

/** The same picture when the chain declares NO `display` at all: the game does
 *  not transform it, so a straight-on cube shows exactly ONE face (the one
 *  facing the camera) instead of three.  That difference is the check for
 *  "`display` absent must not silently fall back to the GUI matrix". */
function measureUnrotated(api, quads, size) {
  const canvas = fakeCanvas(size, size)
  const painted = faceTextured(quads)
  api.drawItemIcon(canvas, { shape: 'iso', display: null, quads: painted.quads,
    animations: {}, textureIds: Object.keys(painted.decoded) }, 0, painted.decoded)
  const found = colours(canvas._data)
  // `south` is the face the orthographic icon camera looks at, and its
  // brightness comes from the IDENTITY-orientation table, not the GUI one.
  const flat = { up: 1.0, east: 0.417, north: 0.624, down: 0.4, south: 0.841, west: 0.543 }
  const want = FACE_COLOURS.south.map((value) => Math.round(value * flat.south))
  return { found: found, want: want,
    oneFace: Object.keys(found).length === 1 && found[want.join(',')] !== undefined }
}

// ---------------------------------------------------------------------------
// static: a call to a helper that does not exist
// ---------------------------------------------------------------------------
//
// `guiItemRotation` was written against `rotateAbout`/`faceAfter`/`boxOfQuads`
// -- names that exist in the HOST and were never defined in the client.  Nothing
// said a word: the file parses, every string check passes, and the icon dies
// with "rotateAbout is not defined" the moment it is drawn.  So the first check
// is a real one: every bare (non-method) call in the client resolves to
// something declared in the client, or to a known builtin.
function codeOnly(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const c = source[i]
    if (quote !== null) {
      if (c === '\\') { i += 2; out += '  '; continue }
      if (c === quote) { quote = null; out += c; i += 1; continue }
      out += c === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

function undefinedCalls(source) {
  // Comments are prose: without this, every English word in one reads as a call
  // (and the count of "missing" names drowns the real one).
  const code = codeOnly(source)
  const called = {}
  for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called[match[1]] = true
  const declared = {}
  for (const match of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared[match[1]] = true
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared[match[1]] = true
  for (const match of code.matchAll(/=\s*[A-Za-z_$][\w$]*Pair\[[01]\],\s*([A-Za-z_$][\w$]*)/g)) declared[match[1]] = true
  for (const match of code.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared[name] = true
    }
  }
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared[name] = true
    }
  }
  const builtins = {}
  for (const name of ('Math JSON Object Array String Number Boolean Symbol BigInt Date RegExp Error'
    + ' TypeError parseInt parseFloat isNaN isFinite isInteger encodeURIComponent decodeURIComponent'
    + ' React Promise Set Map WeakMap Uint8ClampedArray Uint8Array Int32Array Float64Array Float32Array'
    + ' ArrayBuffer setTimeout clearTimeout setInterval clearInterval console window document Image fetch'
    + ' requestAnimationFrame super this typeof new void delete await if for while switch catch return'
    + ' function of apply').split(' ')) builtins[name] = true
  return Object.keys(called).filter((name) => declared[name] !== true && builtins[name] !== true).sort()
}

// ---------------------------------------------------------------------------
async function main() {
  buildFixture()
  const REQUEST = { root: WORK, project: PROJ, namespace: NS }

  const client = nodeFs.readFileSync(process.env.MCART_CLIENT
    || nodePath.join(__dirname, 'client.js'), 'utf8')

  console.log('--- 静态：不存在的函数（客户端里定义了没有）')
  const missing = undefinedCalls(client)
  check('每个被调用的名字都有定义', missing.length === 0, missing.join(' '))
  check('图标用的几何工具在客户端里真的有',
    client.indexOf('function rotateAbout(') >= 0 && client.indexOf('function boxOfQuads(') >= 0)

  console.log('--- 宿主：物品清单（分类来自数据）')
  const list = await handlers['atlas.refItems'](REQUEST)
  check('拿到了物品清单', list !== undefined && !list.error && (list.items || []).length > 0,
    list === undefined ? 'undefined' : list.error)
  const byId = {}
  for (const entry of list.items || []) byId[entry.id] = entry
  // `models/item/generated` is a PARENT, not an item; offering it would put a
  // nameless square in the grid.
  check('模板模型被标成 parentOnly 并被排除', byId.generated !== undefined
    && byId.generated.parentOnly === true, JSON.stringify(byId.generated))
  check('方块物品归到"方块（等距图标）"', byId.boulder !== undefined
    && byId.boulder.form === 'block', JSON.stringify(byId.boulder && byId.boulder.form))
  check('工具归到工具/武器（平铺）', byId.flat_tool !== undefined
    && byId.flat_tool.form === 'tool', JSON.stringify(byId.flat_tool && byId.flat_tool.form))
  check('扁平物品有 layer 贴图', byId.ticker !== undefined
    && Array.isArray(byId.ticker.layers) && byId.ticker.layers.length === 1,
    JSON.stringify(byId.ticker && byId.ticker.layers))
  check('两层物品（刷怪蛋）数出两层', byId.egg !== undefined
    && Array.isArray(byId.egg.layers) && byId.egg.layers.length === 2,
    JSON.stringify(byId.egg && byId.egg.layers))

  console.log('--- 宿主：一页图标（一个进程，一次取完）')
  const ids = ['boulder', 'flat_tool', 'egg', 'ticker', 'lava_gem', 'codething']
  const page = await handlers['atlas.itemIcons'](Object.assign({ items: ids }, REQUEST))
  check('一页回来没有报错', page !== undefined && !page.error, page === undefined ? 'undefined' : page.error)
  const recipes = (page && page.items) || {}
  check('每个 id 都有配方', ids.every((id) => recipes[id] !== undefined), Object.keys(recipes).join(' '))
  const boulder = recipes.boulder || {}
  check('方块物品是 iso，并带上 GUI 矩阵', boulder.shape === 'iso'
    && boulder.display !== null && JSON.stringify(boulder.display.rotation) === '[30,225,0]',
    JSON.stringify({ shape: boulder.shape, display: boulder.display }))
  check('iso 有真实的几何面', (boulder.quads || []).length === 6, (boulder.quads || []).length + ' 面')
  check('iso 的贴图都取到了图', (boulder.textureIds || []).length > 0
    && boulder.textureIds.every((id) => typeof boulder.textures[id] === 'string'
      && boulder.textures[id].indexOf('data:image/png;base64,') === 0),
    JSON.stringify(Object.keys(boulder.textures || {})))
  check('光照明说了是 side（定向）', boulder.light === 'side', boulder.light)
  const tool = recipes.flat_tool || {}
  check('工具是 flat、贴图铺满（front）', tool.shape === 'flat' && tool.light === 'front'
    && (tool.layers || []).length === 1 && (tool.quads || []).length === 0,
    JSON.stringify({ shape: tool.shape, light: tool.light, layers: tool.layers, quads: (tool.quads || []).length }))
  check('钟：64 个 overrides 变成 64 帧（真实原版就是 64）', (recipes.ticker.frames || []).length === 3
    && recipes.ticker.frames[1].layers[0] !== recipes.ticker.frames[0].layers[0],
    JSON.stringify((recipes.ticker.frames || []).map((frame) => frame.layers)))
  check('两层的物品两层都取到图（蛋的底 + 花纹）',
    (recipes.egg.textureIds || []).length === 2 && (recipes.egg.layers || []).length === 2,
    JSON.stringify(recipes.egg.layers))
  check('带 .mcmeta 的物品贴图带上了动画描述',
    Object.keys(recipes.lava_gem.animations || {}).length === 1,
    JSON.stringify(recipes.lava_gem.animations))
  check('代码画的物品说清楚为什么画不出来（不是静默空白）',
    recipes.codething.shape === 'none' && typeof recipes.codething.error === 'string'
    && recipes.codething.error.length > 0, JSON.stringify(recipes.codething.error))

  console.log('--- 宿主：单个物品（大图那条路）')
  const one = await handlers['atlas.icon'](Object.assign({ item: 'boulder' }, REQUEST))
  check('单取和整页取出来的是同一个东西',
    one !== undefined && !one.error && one.shape === boulder.shape
    && (one.textureIds || []).length === (boulder.textureIds || []).length,
    one === undefined ? 'undefined' : one.error)

  console.log('--- 客户端：真的画一个 2D 图标，然后量像素')
  const api = loadClient(null)
  const measured = measureIso(api, boulder.quads, boulder.display, 64)
  // Six faces, six colours: the picture has to contain exactly the three the
  // vanilla GUI view shows, each at the GUI's own brightness for that face.
  const wanted = measured.wanted.map((entry) => entry.face + '=' + entry.colour.join(',')).join(' ')
  check('图标正好是顶/东/北三面，各按 GUI 光照（' + wanted + '）', measured.exact,
    Object.keys(measured.found).sort().join(' | '))
  check('图标占满了格子（不是角落里一个小点）', measured.coverage > 0.35,
    measured.coverage.toFixed(3))
  check('正交相机把模型装进画布并按 fill 放大', measured.inside && measured.extent > 0.9,
    'extent=' + measured.extent.toFixed(3) + ' inside=' + measured.inside)
  // `itemIconUrl` bakes one frame into a data URL for the grid; it has to be the
  // SAME picture the big canvas draws, otherwise the grid and the preview
  // disagree about what the item looks like.
  const textureId = boulder.textureIds[0]
  const decodedStone = {}
  decodedStone[textureId] = solid(16, 16, [255, 255, 255, 255])
  const recipeFor = { shape: 'iso', display: boulder.display, quads: boulder.quads,
    animations: {}, textureIds: [textureId] }
  const baked = api.itemIconUrl(recipeFor, decodedStone, 32)
  const direct = fakeCanvas(32, 32)
  api.drawItemIcon(direct, recipeFor, 0, decodedStone)
  check('缩略图和大图是同一张画（像素指纹相同）',
    baked === 'data:image/png;base64,' + fingerprint(direct._data),
    String(baked).slice(0, 40))
  // A texture that is not decoded yet must not be drawn as an empty square and
  // cached forever: the grid waits for the pixels (checked by the URL effect).
  const empty = fakeCanvas(32, 32)
  api.drawItemIcon(empty, recipeFor, 0, {})
  check('贴图还没解码时画布是空的（所以要先等解码再烘 URL）', coverage(empty._data) === 0,
    String(coverage(empty._data)))

  console.log('--- 客户端：注入错误，检查必须报错')
  // 1) the world's face shading instead of the GUI's
  const world = loadClient([['const GUI_FACE_SHADE = { up: 1.0, east: 0.637, north: 0.435,\n  down: 0.4, south: 0.4, west: 0.4 }',
    'const GUI_FACE_SHADE = { up: 1.0, east: 0.8, north: 0.6,\n  down: 0.5, south: 0.5, west: 0.5 }']])
  const worldMeasured = measureIso(world, boulder.quads, boulder.display, 64)
  check('注入世界光照（1.0/0.8/0.6）时，像素量出来的颜色不对', !worldMeasured.exact,
    Object.keys(worldMeasured.found).sort().join(' | '))
  check('注入世界光照时整套检查判不合格', !isoPasses(worldMeasured))
  // 2) pitch before yaw -- still a cube, still plausible, wrong picture
  const swapped = loadClient([[
    "    if (yaw) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'y', yaw))\n    if (pitch) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'x', pitch))",
    "    if (pitch) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'x', pitch))\n    if (yaw) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'y', yaw))"]])
  const swappedMeasured = measureIso(swapped, boulder.quads, boulder.display, 64)
  check('把 yaw/pitch 顺序换掉：看到的不是那三面了', !swappedMeasured.exact,
    Object.keys(swappedMeasured.found).sort().join(' | '))
  check('把 yaw/pitch 顺序换掉：整套检查判不合格', !isoPasses(swappedMeasured))
  // 3) shading by the rotated face name instead of the model-space one -- which
  //    is what I first wrote, and which the six-colour cube catches: after the
  //    GUI rotation no face points exactly along an axis any more, so every
  //    lookup falls back and the bright/medium/dark ordering is lost.
  const rotatedFace = loadClient([[
    "    const lit = quad.shaded === false ? (quad.shade === undefined ? 1.0 : quad.shade)\n      : (shade[quad.face] === undefined ? 1.0 : shade[quad.face])",
    "    const face = FACE_ORDER.slice().sort((a, b) => {\n      const va = FACE_VECTORS[a], vb = FACE_VECTORS[b]\n      const na = va[0] * p[0][0] + va[1] * p[0][1] + va[2] * p[0][2]\n      const nb = vb[0] * p[0][0] + vb[1] * p[0][1] + vb[2] * p[0][2]\n      return nb - na\n    })[0]\n    const lit = shade[face] === undefined ? 1.0 : shade[face]"],
    ["const GUI_FACE_SHADE = { up: 1.0, east: 0.637, north: 0.435,",
      "const FACE_ORDER = ['down', 'up', 'north', 'south', 'west', 'east']\nconst FACE_VECTORS = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }\nconst GUI_FACE_SHADE = { up: 1.0, east: 0.637, north: 0.435,"]])
  const rotatedMeasured = measureIso(rotatedFace, boulder.quads, boulder.display, 64)
  check('按"转到哪一面就按哪一面"着色（我第一次就是这么写的）：颜色不对',
    !rotatedMeasured.exact, Object.keys(rotatedMeasured.found).sort().join(' | '))
  check('按旋转后的面名着色：整套检查判不合格', !isoPasses(rotatedMeasured))

  console.log('--- 客户端：平铺图标的图层、帧、动画带')
  const flatCanvas = fakeCanvas(32, 32)
  // 面板递进来的就是这些：解码后的像素。`<img>` 在解码完成的那一刻就被摘掉了
  // （隐藏列表跳过已解码的 id），靠那个节点画图正是"非方块没法显示"的成因，
  // 所以这里一个节点都不给。
  const flatDecoded = {
    a: solid(16, 16, [200, 30, 30, 255]),
    b: solid(16, 16, [30, 30, 220, 255]),
  }
  api.drawItemIcon(flatCanvas, { shape: 'flat', layers: ['a', 'b'], animations: {} }, 0, flatDecoded)
  check('上层压住下层（蛋的花纹画在底色上面）',
    JSON.stringify(solidColour(flatCanvas._data)) === JSON.stringify([30, 30, 220]),
    JSON.stringify(solidColour(flatCanvas._data)))
  const overrides = fakeCanvas(32, 32)
  api.drawItemIcon(overrides, { shape: 'flat', frames: [{ layers: ['a'] }, { layers: ['b'] }], animations: {} },
    1, flatDecoded)
  check('第 2 帧画的是第 2 帧的模型（钟就是这样走的）',
    JSON.stringify(solidColour(overrides._data)) === JSON.stringify([30, 30, 220]),
    JSON.stringify(solidColour(overrides._data)))
  api.drawItemIcon(overrides, { shape: 'flat', frames: [{ layers: ['a'] }, { layers: ['b'] }], animations: {} },
    0, flatDecoded)
  check('第 1 帧画的是第 1 帧的模型',
    JSON.stringify(solidColour(overrides._data)) === JSON.stringify([200, 30, 30]),
    JSON.stringify(solidColour(overrides._data)))

  // 注入：把平铺这条路退回原来那种写法——"有一个活的 <img> 节点才画"。
  // 面板在贴图解码完的那一刻就把 <img> 摘掉了，所以这一注入必须让同一张图变空白；
  // 上面的测量要是抓不到它，那它就不是在量"非方块能不能显示"。
  const nodeOnly = loadClient([[
    "    const texture = decoded === undefined ? undefined : decoded[id]\n    if (texture === undefined || texture.data === undefined) continue",
    "    const texture = undefined\n    if (texture === undefined) continue"]])
  const blankFlat = fakeCanvas(32, 32)
  nodeOnly.drawItemIcon(blankFlat, { shape: 'flat', layers: ['a'], animations: {} }, 0, flatDecoded)
  check('注入"平铺要 <img> 节点才画"（原来的写法）：同一张图立刻变空白',
    coverage(blankFlat._data) === 0, String(coverage(blankFlat._data)))

  const rows = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]
  const stripDecoded = { s: strip(16, rows) }
  const animation = { frames: 4, frametime: 2, strip: 4 }
  const stripRecipe = { shape: 'flat', layers: ['s'], animations: { s: animation } }
  const moved = []
  for (const ticks of [0, 2, 4, 6]) {
    api.setTicks(ticks)
    const canvas = fakeCanvas(32, 32)
    api.drawItemIcon(canvas, stripRecipe, 0, stripDecoded)
    moved.push(solidColour(canvas._data))
  }
  check('动画带按 frametime 换行（0/2/4/6 tick -> 四行的颜色）',
    JSON.stringify(moved) === JSON.stringify([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]),
    JSON.stringify(moved))
  api.setTicks(2)
  const still = fakeCanvas(32, 32)
  api.drawItemIcon(still, { shape: 'flat', layers: ['s'], animations: {} }, 0, stripDecoded)
  check('没有动画描述时整张图当一格画（不会自己乱切）',
    JSON.stringify(solidColour(still._data)) === JSON.stringify([255, 0, 0]),
    JSON.stringify(solidColour(still._data)))
  api.setTicks(0)

  const nothing = fakeCanvas(32, 32)
  api.drawItemIcon(nothing, recipes.codething, 0, {})
  check('代码画的物品：不画、不炸（格子会自己写一个问号）', coverage(nothing._data) === 0,
    String(coverage(nothing._data)))

  // 点一个没有方块模型的物品（血晶这种"只是个物品"的材料）：`pickItem` 会把 scene 置空。
  // 置空之后**必须把画布擦掉**——留着就是上一张模型图还在屏幕上，而旋转/缩放只是再跑一遍
  // 同一个效果，所以整个 3D 看起来"卡住了"（用户点的正是血晶）。
  const stale = fakeCanvas(32, 32)
  api.drawItemIcon(stale, { shape: 'flat', layers: ['a'], animations: {} }, 0, flatDecoded)
  check('先有一张图（这就是"卡住"时屏幕上残留的那张）', coverage(stale._data) > 0,
    String(coverage(stale._data)))
  const cleared = fakeCanvas(32, 32)
  cleared._data.set(stale._data)
  api.clearViewport(cleared, 32, 32)
  check('没有模型可画时画布被擦干净（不是留着上一张）', coverage(cleared._data) === 0,
    String(coverage(cleared._data)))
  // 另一半是接线：没有模型那一段必须是"擦掉再返回"，不能只是 return。
  // 这两条是看代码结构的（行为那一条上面已经量了），所以第二条把那一句删掉，
  // 要求第一条**真的会红**——不然它只是一句自我安慰。
  const noScene = (text) => {
    const at = text.indexOf('if (scene === null) {')
    // 里面那一句是 10 空格缩进（分支自己的 null 检查），要的是它后面 8 空格的那一句。
    return text.slice(at, text.indexOf('\n        if (canvas === null) return', at))
  }
  check('scene 为空时那一段擦画布（不是直接 return）',
    noScene(client).indexOf('clearViewport(canvas, size[0], size[1])') >= 0)
  const withoutClear = client.replace('          clearViewport(canvas, size[0], size[1])\n', '')
  const patched = noScene(withoutClear)
  check('注入"删掉擦画布那一句"：同一条断言立刻不成立（所以它不是空话）',
    patched.indexOf('clearViewport(canvas, size[0], size[1])') < 0)

  console.log('--- 宿主：本项目自己的资源（项目 pack + 游戏根，两棵树）')
  // The pack alone cannot resolve `block/cube`: that is an unqualified name, so
  // the chain needs the game root too.  Without the second root every one of our
  // own block items came back with no icon at all.
  const alone = await handlers['atlas.icon']({ root: WORK, project: PROJ, namespace: NS,
    source: 'reference', item: 'projthing' })
  check('只拿参考目录问项目命名空间：取不到（这就是两个根的必要性）',
    alone !== undefined && (alone.error !== undefined || alone.shape === 'none'),
    JSON.stringify(alone && (alone.error || alone.shape)))
  const mine = await handlers['atlas.refItems']({ root: WORK, project: PROJ,
    namespace: 'projns', source: 'project' })
  check('本项目能列成物品', mine !== undefined && !mine.error
    && (mine.items || []).some((entry) => entry.id === 'projthing'), mine && mine.error)
  const minePage = await handlers['atlas.itemIcons']({ root: WORK, project: PROJ,
    namespace: 'projns', source: 'project', items: ['projthing', 'projflat'] })
  check('本项目物品的图标配方出得来', minePage !== undefined && !minePage.error,
    minePage === undefined ? 'undefined' : minePage.error)
  const mineThing = (minePage && minePage.items && minePage.items.projthing) || {}
  check('本项目方块物品是 iso，GUI 矩阵来自 vanilla 的 block/block',
    mineThing.shape === 'iso' && mineThing.display !== null
      && JSON.stringify(mineThing.display.rotation) === '[30,225,0]',
    JSON.stringify({ shape: mineThing.shape, display: mineThing.display }))
  check('本项目方块物品有几何与贴图', (mineThing.quads || []).length === 6
    && (mineThing.textureIds || []).length > 0, (mineThing.quads || []).length + ' 面')
  const mineFlat = (minePage && minePage.items && minePage.items.projflat) || {}
  check('本项目平图物品是 flat + layer0', mineFlat.shape === 'flat'
    && (mineFlat.layers || []).length === 1, JSON.stringify({ shape: mineFlat.shape, layers: mineFlat.layers }))
  // 用户问："为什么对于血晶这种物体 不能修改贴图或者提意见？"——因为那两个按钮只在有 scene
  // 的时候才画，而"只是个物品"的资产没有 scene。现在它们对物品也工作，靠的是宿主给两样东西：
  // 物品模型文件的路径（@ 提意见引用它）和贴图句柄背后真正的文件（画笔写它）。
  check('本项目物品报出自己的模型文件路径（@ 提意见 指向它）',
    typeof mineFlat.modelPath === 'string' && mineFlat.modelPath.indexOf('models/item/projflat.json') > 0,
    JSON.stringify(mineFlat.modelPath))
  const flatHandle = (mineFlat.textureIds || [])[0]
  check('平图物品的贴图是 ref: 句柄（画笔写不了句柄，所以宿主得解析）',
    typeof flatHandle === 'string' && flatHandle.indexOf('ref:') === 0, String(flatHandle))
  const saved = await handlers['atlas.saveTexture']({ root: WORK, project: PROJ,
    path: flatHandle, base64: TINY_PNG })
  check('用 ref: 句柄保存：宿主解析到项目 pack 里的真文件并写进去',
    saved !== undefined && saved.saved === true
      && String(saved.path).indexOf('/pack/assets/projns/textures/item/projflat.png') > 0,
    JSON.stringify(saved))
  const refused = await handlers['atlas.saveTexture']({ root: WORK, project: PROJ,
    path: 'ref:projns:item/nowhere', base64: TINY_PNG })
  check('解析不到的句柄：拒绝，并且说清楚（不是悄悄写别处）',
    refused !== undefined && refused.error !== undefined && String(refused.error).indexOf('改不了') > 0,
    JSON.stringify(refused))
  const outside = await handlers['atlas.saveTexture']({ root: WORK, project: PROJ,
    path: '/tmp/mcart-must-not-be-written.png', base64: TINY_PNG })
  check('包外的路径仍然拒绝（画笔不是通用写文件工具）',
    outside !== undefined && String(outside.error).indexOf('拒绝写') > 0, JSON.stringify(outside))

  const mineMeasured = measureIso(api, mineThing.quads, mineThing.display, 64)
  check('本项目方块物品画出来和 vanilla 方块一样是那三面', mineMeasured.exact,
    Object.keys(mineMeasured.found).sort().join(' | '))

  console.log('--- 宿主：参考设置的"联动"契约（面板写的文件 = 技能读的那个文件）')
  // 用户问过两件事："参考目录和 mcart skill 联动了没？""我改了设置会通知 agent 吗？"
  // 第一件是文件契约：面板写 `<项目>/mc-art.settings.json`，技能侧
  // `mc_art.project_settings` 读的正是这个名字。这里量的是**写下去的那个文件**，
  // 不是"两边都提到过这个字符串"。
  // The fixture keeps its own settings file (it points `reference.directory` at the
  // fixture's game tree), so this has to put it back EXACTLY -- deleting it took the
  // reference root away from every later check ("还没有设置参考目录").
  const settingsFile = nodePath.join(WORK, 'proj', 'mc-art.settings.json')
  const settingsBefore2 = nodeFs.existsSync(settingsFile) ? nodeFs.readFileSync(settingsFile) : null
  const savedRef = await handlers['atlas.saveSettings']({ root: WORK, project: PROJ,
    directory: '/tmp/mcart-ref-root', includeGenerated: false, includeMods: true,
    mods: { minecraft: true, aoa3: false } })
  check('保存设置返回工作区相对路径（@ 引用要用它）',
    savedRef !== undefined && savedRef.saved === true && savedRef.path === 'proj/mc-art.settings.json',
    JSON.stringify(savedRef))
  const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(WORK, 'proj', 'mc-art.settings.json'), 'utf8'))
  check('落盘的 schema 和字段名就是技能侧读的那套',
    onDisk.schema === 'mc-art.settings/1'
      && onDisk.reference && onDisk.reference.directory === '/tmp/mcart-ref-root'
      && onDisk.reference.includeGenerated === false
      && onDisk.reference.mods && onDisk.reference.mods.aoa3 === false,
    JSON.stringify(onDisk.reference))
  const readBack = await handlers['atlas.settings']({ root: WORK, project: PROJ })
  check('读回来是同一个文件、同一个相对路径',
    readBack !== undefined && readBack.path === 'proj/mc-art.settings.json'
      && readBack.directory === '/tmp/mcart-ref-root',
    JSON.stringify({ path: readBack && readBack.path, dir: readBack && readBack.directory }))
  if (settingsBefore2 === null) nodeFs.unlinkSync(settingsFile)
  else nodeFs.writeFileSync(settingsFile, settingsBefore2)
  check('检查完把 fixture 的设置文件原样放回（不把参考目录留给后面的检查）',
    (settingsBefore2 === null) === !nodeFs.existsSync(settingsFile)
    && (settingsBefore2 === null || nodeFs.readFileSync(settingsFile).equals(settingsBefore2)))

  console.log('--- 客户端：链上没有 display.gui 就不转（游戏也不转）')
  const unrotated = measureUnrotated(api, boulder.quads, 64)
  check('没有 display 时画面只剩正对的那一面（' + unrotated.want.join(',') + '）',
    unrotated.oneFace, Object.keys(unrotated.found).sort().join(' | '))
  const forced = loadClient([[
    "    const hasDisplay = recipe.display !== null && recipe.display !== undefined\n    const rotation = hasDisplay ? (recipe.display.rotation || [0, 0, 0]) : [0, 0, 0]\n    const quads = guiItemRotation(recipe.quads || [], rotation,\n      hasDisplay ? GUI_FACE_SHADE : GUI_FACE_SHADE_FLAT",
    "    const rotation = (recipe.display || {}).rotation || [30, 225, 0]\n    const quads = guiItemRotation(recipe.quads || [], rotation, GUI_FACE_SHADE"]])
  const forcedMeasured = measureUnrotated(forced, boulder.quads, 64)
  check('注入"没有 display 也硬套 GUI 矩阵"：画面变成三面，检查报错',
    !forcedMeasured.oneFace, Object.keys(forcedMeasured.found).sort().join(' | '))

  console.log('--- 客户端：`error: null` 不是错误')
  // The extractor answers `error: null` on purpose for every flat item ("no
  // elements is the normal state of a generated item").  A key-exists test made
  // every flat item -- every tool, every sword, a project's own sprite -- read as
  // "取不到" in the single-item path while the page path was fine.
  const flatOne = await handlers['atlas.icon'](Object.assign({ item: 'flat_tool' }, REQUEST))
  check('单取一个平铺物品是成功的（不是 "null"）',
    flatOne !== undefined && flatOne.shape === 'flat' && typeof flatOne.error !== 'string',
    JSON.stringify({ shape: flatOne && flatOne.shape, error: flatOne && flatOne.error }))
  check('failureOf 把 error:null 当成没有错误', api.failureOf({ error: null }) === null
    && api.failureOf({ shape: 'flat' }) === null
    && api.failureOf({ error: '坏了' }) === '坏了'
    && api.failureOf(null) === '没有返回结果', JSON.stringify([api.failureOf({ error: null })]))
  const keyTest = loadClient([[
    "function failureOf(reply) {\n  if (reply === null || reply === undefined) return '没有返回结果'\n  if (reply.error === undefined || reply.error === null) return null\n  return String(reply.error)\n}",
    "function failureOf(reply) {\n  if (reply === null || reply === undefined) return '没有返回结果'\n  if (reply.error !== undefined) return String(reply.error)\n  return null\n}"]])
  check('注入"有 error 键就算失败"：error:null 立刻变成失败，检查报错',
    keyTest.failureOf({ error: null }) === 'null', String(keyTest.failureOf({ error: null })))

  console.log('--- 客户端：分类计数')
  const counted = api.countsOf([{ form: 'block' }, { form: 'block' }, { form: 'tool' }, { form: '' }],
    (entry) => entry.form, (entry) => entry.form === 'block' ? '方块' : '别的')
  check('按字段数出来的计数和标签', JSON.stringify(counted) === JSON.stringify({
    block: { count: 2, label: '方块' }, tool: { count: 1, label: '别的' } }), JSON.stringify(counted))

  console.log('--- 客户端：面板接线（界面上真的会出现）')
  check('物品浏览器只在展开时占位', /itemOpen \? itemCard\(\) : null/.test(client))
  check('顶栏按钮开的是浏览器（文字按钮，不是 emoji）',
    /onClick: openItems \}, itemOpen \? '收起列表' : '物品列表'/.test(client)
    && client.indexOf('🎒') < 0)
  check('打开面板会去取这一页的配方', /ensureItemPage\(\)/.test(client)
    && /if \(item === null \|\| item\.facts\.length === 0\) return/.test(client))
  check('图标的贴图进了要解码的清单', /for \(const recipe of iconRecipesInUse\(\)\) \{\s*\n\s*for \(const id of \(recipe\.textureIds \|\| \[\]\)\)/.test(client))
  check('图标的贴图也进了隐藏 img 列表（不解码就是空白）',
    /Object\.assign\(allTextures, recipe\.textures\)/.test(client))
  check('图标会动的时候时钟才开着', /\|\| hudAnimated/.test(client))
  // An icon whose texture never arrives (a jar missing that png) must not hold
  // the MODEL back: readiness is checked over the model's own textures only.
  check('图标的贴图不会挡住模型的绘制', /const waiting = needed\.slice\(\)/.test(client)
    && /for \(const id of waiting\) \{/.test(client))
  check('搜索时分类行收起来（数字对不上就不显示）',
    (client.match(/&& itemSearch\(\) === ''/g) || []).length === 2)
  check('格子里的缩略图缓存真的会被写', /itemUrls\[key\] = url/.test(client))
  check('没有图标可烘的时候格子上写问号', /className: 'mcart-slotq'/.test(client))

  console.log('--- 客户端：物品栏是 3D 视图里的一层 2D（不是旁边另起一行）')
  // 用户的话：“能不能不要有这个物品栏显示的东西了 整合到我们的3D显示里面 给这个
  // 3D显示加一层2D 就仿照游戏画面 下面一排是物品栏”.  So it is an overlay INSIDE
  // the viewport element, and the old separate row is gone rather than moved.
  check('物品栏画在 3D 视图里（viewport 的子节点）',
    /key: 'viewport'/.test(client) && /hudBar\(\)\)\)/.test(client))
  check('旁边那行「物品栏形式」删掉了，不是换个地方',
    client.indexOf("key: 'itemform'") < 0 && client.indexOf('function itemFormNote(') < 0
    && client.indexOf('mcart-iconview') < 0)
  check('一排九格，就是游戏那个数', /const HUD_SLOTS = 9/.test(client)
    && /while \(slots\.length < HUD_SLOTS\)/.test(client)
    && /mcart-hudempty/.test(client))
  check('选中的那一格是游戏的高亮框', /'data-on': hudOn === entry\.id \? '1' : '0'/.test(client)
    && /\.mcart-hudslot\[data-on="1"\]\{/.test(client))
  check('每一格是真的画布，跟着同一个 50ms 时钟',
    /drawItemIcon\(canvas, recipe, frame, decoded\)/.test(client)
    && /const frame = frames > 1 \? Math\.floor\(animTicks \/ 2\) % frames : 0/.test(client))
  check('物品栏和浏览器共用一份筛过的清单（两排不会各说各话）',
    /function itemFiltered\(\)/.test(client) && /const list = itemFiltered\(\)/.test(client)
    && /want\(itemView\(\)\.list\)/.test(client) && /want\(hudView\(\)\.list\)/.test(client))
  check('画这一排的贴图也要进解码清单', /for \(const entry of hudView\(\)\.list\) add\(entry\)/.test(client))
  check('打开面板就有东西：本项目物品自动取一次',
    /if \(item === null\) \{ loadItems\('project', ours, 1, '', '', ''\); return \}/.test(client))
  check('换到别的项目会重新取（参考列表是用户选的，不动）',
    /item\.source === 'project' && item\.namespace !== ours/.test(client))
  // 用户报："我按物品栏的左右箭头没用 闪一下又回第一页了"。原因是那条"跟着选中项翻页"
  // 的效果把 hudPage 也放进了依赖里：一按箭头它就重跑，看到选中项在第 1 页，又把页翻回去。
  // 现在它只按 (清单, 选中项) 跟着走，翻页不会触发它。
  check('屏幕上那个资产自己翻到它那一页',
    /if \(page !== hudView\(\)\.page\) setHudPage\(page\)/.test(client))
  check('跟着选中项翻页的那条效果不依赖 hudPage（不然箭头会被它顶回去）',
    /\}, \[hudKey, hudOn\]\)/.test(client)
    && /const token = hudKey \+ '#' \+ hudOn/.test(client)
    && /let hudFollowed = ''/.test(client))
  // 注入：把 hudPage 放回依赖里（就是原来的写法），那条断言必须不成立。
  const withPageDep = client.replace('}, [hudKey, hudOn])', '}, [hudKey, hudOn, hudPage])')
  check('注入"把 hudPage 放回依赖"：同一条断言立刻不成立',
    !/\}, \[hudKey, hudOn\]\)/.test(withPageDep))

  check('没 3D 可看时把 2D 画在取景框里（按最短边取方形，不拉伸）',
    /const posterRecipe = scene === null && pickedRecipe !== null \? pickedRecipe : null/.test(client)
    && /const posterSide = Math\.max\(48, Math\.min\(size\[0\], size\[1\]\) - 24\)/.test(client)
    && /className: 'mcart-poster'/.test(client)
    && /drawItemIcon\(posterCanvas, posterRecipe, frame, decoded\)/.test(client)
    && /\.mcart-poster\{/.test(client))
  check('关了浏览器不清空这一排', /if \(itemOpen\) \{ setItemOpen\(false\); return \}/.test(client)
    && /setItemOpen\(false\); setIconPick\(null\)/.test(client))
  check('每一格的说明是形状/display/帧数，坏了才在屏幕上说',
    /function slotFacts\(/.test(client) && /function slotNote\(/.test(client)
    && /display\.gui /.test(client) && /没有可用的图标模型/.test(client))
  check('物品模型指向没有 display 的几何模型时，说出改法',
    /item\/generated（layer0 指向那张贴图）/.test(client))
  check('实体/群系/结构明说没有物品形式', /蛋色写在代码里/.test(client))
  // 用户问："为什么对于血晶这种物体 不能修改贴图或者提意见？"：那两个按钮原来只在
  // `if (scene !== null)` 里画，而"只是个物品"的资产没有 scene。现在物品也有一行，
  // 两个按钮走同一套（画笔写它的贴图，提意见引用它的模型文件）。
  check('没有 scene 的物品也能进"手动修改"',
    /function openEditor\(\) \{\s*\n\s*const asset = itemAsset\(\)/.test(client)
    && /const ids = asset\.recipe === null \? \[\]/.test(client))
  check('没有 scene 的物品也能"提意见"（引用它的模型文件）',
    /const path = asset\.recipe === null \|\| asset\.recipe\.modelPath === undefined/.test(client)
    && /setPending\(\{ path: path, title: asset\.title \}\)/.test(client))
  const itemRow = client.slice(client.indexOf("key: 'itemrow'"), client.indexOf("key: 'viewport'"))
  check('物品那一行带着和方块同一套的两个按钮',
    itemRow.indexOf("'✎ 手动修改'") >= 0 && itemRow.indexOf("'@ 提意见'") >= 0
    && itemRow.indexOf('onClick: openEditor') >= 0 && itemRow.indexOf('onClick: complain') >= 0)
  // 真注入：把物品那条分支去掉，回到原来的 `if (scene === null) return`。
  const noItemBranch = client.replace(
    '        const asset = itemAsset()\n        if (scene === null && asset === null) return',
    '        if (scene === null) return')
  check('注入"恢复成 scene === null 直接返回"：上面那条断言立刻不成立',
    !/function openEditor\(\) \{\s*\n\s*const asset = itemAsset\(\)/.test(noItemBranch)
    && noItemBranch !== client)

  check('只是物品、没有方块模型的（血晶这种）会说清 3D 里没东西可看',
    /没有方块模型（它是物品，不是方块）/.test(client))
  check('点这种物品时编辑器状态跟着收起来（不能指着一个不在屏幕上的场景）',
    /setPreviewItem\(\{ source: 'project', namespace: namespace, id: entry\.id, localOnly: true \}\)\n            setScene\(null\)\n            setVoxel\(null\)\n            setHover\(null\)\n            setGhost\(null\)\n            setEdit\(null\)\n            setFailure\(null\)/.test(client))

  console.log('--- 那些提示不在 3D 视口里，3D 那一块能拖着调高度')
  // 用户第二次的反馈："这些提示不应该放在这里"（截图就是那两行告警）+ "这个窗口最好
  // 我能调整大小（我说的是3D+2D）".  So: the overlay holds the game's HUD and nothing
  // else, the notes live under the canvas, and the height is draggable.
  const hud = client.slice(client.indexOf('function hudBar('), client.indexOf('function itemCard('))
  check('物品栏这一层里只剩名字和格子，没有告警行',
    hud.indexOf('mcart-hudnote') < 0 && hud.indexOf('iconNotes') < 0
    && client.indexOf('.mcart-hudnote{') < 0,
    hud.length + ' 字符的 hudBar')
  check('提示挪到画布下面（stage 里、viewport 之后）',
    /const iconNotes = \[\]/.test(client)
    && /className: 'mcart-note', key: 'iconnote'/.test(client)
    && client.indexOf("key: 'iconnote'") > client.indexOf("key: 'viewport'"))
  check('高度是状态，canvas 用它（不是写死 240）',
    /const viewHPair = React\.useState\(VIEW_H\)/.test(client)
    && /style: \{ height: viewH \+ 'px' \}/.test(client))
  check('底部有拖动手柄，双击复位', /className: 'mcart-grip', key: 'grip'/.test(client)
    && /onDoubleClick: \(\) => setViewH\(VIEW_H\)/.test(client)
    && /\.mcart-grip\{/.test(client) && /cursor:ns-resize/.test(client))
  check('拖动量进 clamp（上下越界都夹住）',
    /setViewH\(clampViewH\(gripDrag\.origin \+ \(event\.clientY - gripDrag\.y\)\)\)/.test(client)
    && /const clampViewH = \(value\) => Math\.max\(VIEW_H_MIN, Math\.min\(VIEW_H_MAX, Math\.round\(value\)\)\)/.test(client))
  check('拖动状态在 React 外面（每帧读，晚一帧就会从错的高度开始拖）',
    /const gripDrag = \{ active: false, y: 0, origin: 0 \}/.test(client))
  check('手柄在画布下面，不在上面（上面会长高时把画布推走）',
    client.indexOf("key: 'grip'") > client.indexOf("key: 'viewport'"))

  check('保存设置后给出一句"告诉 AI"，并带上设置文件路径',
    /setSavedSettings\(\{/.test(client)
    && /'告诉 AI'/.test(client)
    && /setPending\(\{ path: savedSettings\.path, note: savedSettings\.note \}\)/.test(client))
  check('那句话会被一起插进输入框（不只是 @ 一个路径）',
    /const tail = '@' \+ current\.path \+ \(note === '' \? ' ' : ' ' \+ note\)/.test(client)
    && /参考目录改成了/.test(client))
  // 真注入：把那一行按钮去掉，上面第一条必须不成立。
  const noTell = client.replace(/React\.createElement\('button', \{ className: 'mcart-btn', type: 'button',\n\s*onClick: \(\) => setPending\(\{ path: savedSettings\.path, note: savedSettings\.note \}\) \},\n\s*'告诉 AI'\)/, '')
  check('注入"把告诉 AI 那个按钮删掉"：上面那条断言立刻不成立',
    noTell !== client && !/'告诉 AI'/.test(noTell))
  check('来源里有「本项目」', /'本项目 ' \+ ours/.test(client))
  check('点本项目里的格子是打开它（3D + 这一格），不是另开一个面板',
    /item\.source === 'project'\) \{/.test(client)
    && /setPreviewItem\(null\)/.test(client)
    && /open\(\{ project: activeProjectId\(\), kind: 'block', id: entry\.id \}, root\)/.test(client)
    && client.indexOf('pickItem3d') < 0 && client.indexOf('iconPick.show') < 0)
  check('参考方块走预览那条路', /function openReferenceItem\(/.test(client))
  check('两次取物品都带上 source 给宿主',
    /source: source, namespace: namespace/.test(client)
    && /source: item\.source, namespace: item\.namespace/.test(client))
  check('内置的原版母模型会在屏幕上说出来（不假装是从游戏里读的）',
    /内置:/.test(client) && /原版母模型用了内置的/.test(client))

  console.log(failures === 0 ? '全部通过' : (failures + ' 项失败'))
  return failures
}

main().then((count) => process.exit(count === 0 ? 0 : 1))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
