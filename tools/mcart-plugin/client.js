// ---- rasteriser: a copy of tools/atlas_core.mjs, proven by tools/atlas_oracle.mjs
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vlen = (a) => Math.sqrt(dot(a, a))
function unit(a) { const n = vlen(a); return n < 1e-12 ? [0, 0, 0] : mul(a, 1 / n) }

/** Rotate `point` about `origin` on one axis, in degrees.  Same convention as
 *  the host's own `rotateAbout`, so a quad the host rotated and a quad this
 *  side rotates for the GUI icon agree about which way is which. */
function rotateAbout(point, origin, axis, degrees) {
  if (!degrees) return point
  const angle = (degrees * Math.PI) / 180
  const p = sub(point, origin)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  let r
  if (axis === 'x') r = [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]
  else if (axis === 'y') r = [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]
  else r = [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]
  return add(r, origin)
}

/** The axis-aligned box around a set of quads.  An empty set is a unit cube
 *  rather than infinities, so a camera built from it still has a scale. */
function boxOfQuads(quads) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const quad of quads || []) for (const p of quad.p) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i]
    if (p[i] > max[i]) max[i] = p[i]
  }
  if (!isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] }
  return { min: min, max: max }
}

function makeCamera(position, target, width, height, fovY) {
  const forward = unit(sub(target, position))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const focal = height / 2 / Math.tan(fovY / 2)
  return {
    project: function (point) {
      const offset = sub(point, position)
      const x = dot(offset, right)
      const y = dot(offset, up)
      const z = dot(offset, forward)
      if (z <= 0.02) return null
      return [width / 2 + (x * focal) / z, height / 2 - (y * focal) / z, z]
    },
  }
}

function orbitCamera(box, yaw, pitch, zoom, width, height, fovY) {
  const centre = mul(add(box.min, box.max), 0.5)
  const radius = Math.max(vlen(sub(box.max, box.min)) / 2, 0.05)
  const fit = radius / Math.sin(fovY / 2) / zoom
  const cp = Math.cos(pitch)
  const direction = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp]
  return makeCamera(add(centre, mul(direction, fit * 1.05)), centre, width, height, fovY)
}

// Which ROW of an animated strip to sample right now.
//
// An animated texture is a vertical strip: frame 0 on top, each next frame
// below it.  A model's UV covers ONE frame, so sampling `v * height` lands in
// the wrong row and every frame gets smeared across the face -- which is
// exactly what a still-looking 动态方块 was.
//
// `frametime` is in ticks (1 tick = 50 ms), the unit the game itself uses, and
// a pack may repeat or reorder frames: `lava_still` declares 38 playback steps
// over a 20-row strip.  So the order list is followed rather than the index.
const EMPTY_ANIMATIONS = {}

function animationRow(animation, timeMs) {
  if (animation === undefined || animation === null) return 0
  const order = Array.isArray(animation.order) && animation.order.length > 0 ? animation.order : null
  const frames = order === null ? animation.frames : order.length
  if (!(frames > 1)) return 0
  const ticks = Math.max(1, animation.frametime || 1)
  const step = Math.floor((timeMs || 0) / (ticks * 50))
  const index = ((step % frames) + frames) % frames
  return order === null ? index : order[index]
}

// Is this texture a strip whose frame height the UV mapping can divide by?
// A texture that merely happens to be tall must be sampled as one image.
function stripOf(texture) {
  const animation = texture === undefined ? undefined : texture.animation
  if (animation === undefined || animation === null) return null
  const strip = animation.strip
  if (!(strip > 1) || texture.width <= 0) return null
  if (texture.height !== strip * texture.width) return null
  return strip
}

function renderScene(options) {
  const width = options.width
  const height = options.height
  const background = options.background
  const camera = options.camera
  // An overlay pass reuses the caller's colour and depth buffers, tests against
  // the depth already in them, writes neither depth nor pick, and mixes its
  // tint in.  That is what keeps the "about to place here" ghost hidden behind
  // a wall it is actually behind.
  const colour = options.colour === undefined ? new Float64Array(width * height * 4) : options.colour
  const depth = options.depth === undefined ? new Float64Array(width * height) : options.depth
  const overlay = options.overlay === undefined ? null : options.overlay
  const tint = options.tint === undefined ? null : options.tint
  // A fresh pass initialises whatever it was handed; an overlay pass must
  // preserve both buffers.  Keying this on "did the caller pass a buffer"
  // instead was a black screen: the client hands its buffers to the first pass
  // too, so depth stayed 0 and the strict test rejected every pixel.
  // An ITEM icon is drawn on nothing: the slot behind it must show through, so
  // the background alpha is the caller's (`backgroundAlpha: 0`).  Every world
  // render keeps 1, and a transparent background that is never written would
  // otherwise come out black where no quad covers it.
  const backgroundAlpha = options.backgroundAlpha === undefined ? 1 : options.backgroundAlpha
  // Which projection the camera hands back.  `iconCamera` is orthographic and
  // says so; `makeCamera`/`orbitCamera` divide by depth and are not.
  const orthographic = options.orthographic === true
  if (overlay === null) {
    for (let i = 0; i < width * height; i++) {
      colour[i * 4] = background[0] / 255
      colour[i * 4 + 1] = background[1] / 255
      colour[i * 4 + 2] = background[2] / 255
      colour[i * 4 + 3] = backgroundAlpha
      depth[i] = Infinity
    }
  }
  // Optional pick buffer: which quad won each pixel.  A click on the image then
  // resolves to a cell and a face without a second scene traversal, because the
  // depth test has already decided what is visible there.
  const pick = options.pick === undefined ? null : options.pick
  for (let quadIndex = 0; quadIndex < options.quads.length; quadIndex++) {
    const quad = options.quads[quadIndex]
    const texture = options.textures[quad.tex]
    if (texture === undefined) continue
    const mode = quad.mode || 'opaque'
    const shade = quad.shade === undefined ? 1 : quad.shade
    for (const indices of [[0, 1, 2], [0, 2, 3]]) {
      const points = [quad.p[indices[0]], quad.p[indices[1]], quad.p[indices[2]]]
      const uvs = [quad.uv[indices[0]], quad.uv[indices[1]], quad.uv[indices[2]]]
      const screen = []
      let visible = true
      for (const point of points) {
        const projected = camera.project(point)
        if (projected === null) { visible = false; break }
        screen.push(projected)
      }
      if (!visible) continue
      const s0 = screen[0], s1 = screen[1], s2 = screen[2]
      const minx = Math.max(0, Math.floor(Math.min(s0[0], s1[0], s2[0])))
      const maxx = Math.min(width - 1, Math.ceil(Math.max(s0[0], s1[0], s2[0])))
      const miny = Math.max(0, Math.floor(Math.min(s0[1], s1[1], s2[1])))
      const maxy = Math.min(height - 1, Math.ceil(Math.max(s0[1], s1[1], s2[1])))
      if (minx > maxx || miny > maxy) continue
      const area = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1])
      if (Math.abs(area) < 1e-9) continue
      const tw = texture.width
      const th = texture.height
      const data = texture.data
      const blend = mode === 'blend'
      // One decision per quad, not per pixel.
      const animation = (options.animations || EMPTY_ANIMATIONS)[quad.tex]
      const strip = stripOf({ width: tw, height: th, animation: animation })
      const row = strip === null ? 0 : animationRow(animation, options.timeMs)
      for (let y = miny; y <= maxy; y++) {
        const gy = y + 0.5
        for (let x = minx; x <= maxx; x++) {
          const gx = x + 0.5
          const w0 = ((s1[0] - gx) * (s2[1] - gy) - (s2[0] - gx) * (s1[1] - gy)) / area
          const w1 = ((s2[0] - gx) * (s0[1] - gy) - (s0[0] - gx) * (s2[1] - gy)) / area
          const w2 = 1 - w0 - w1
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
          // ORTHOGRAPHIC: no perspective divide, so nothing has to be undone and
          // the texture coordinate is interpolated LINEARLY.  Running the
          // perspective formula under `iconCamera` warped every face that has any
          // depth across it -- a cube's three visible faces and, worst of all, a
          // cross's diagonal plane, whose sprite came out split down the middle.
          // The world camera is a real perspective camera and keeps that path.
          let zs, u, v
          if (orthographic) {
            zs = w0 * s0[2] + w1 * s1[2] + w2 * s2[2]
            if (!(zs > 1e-9)) continue
            u = w0 * uvs[0][0] + w1 * uvs[1][0] + w2 * uvs[2][0]
            v = w0 * uvs[0][1] + w1 * uvs[1][1] + w2 * uvs[2][1]
          } else {
            const inv = w0 / s0[2] + w1 / s1[2] + w2 / s2[2]
            if (!(inv > 1e-9)) continue
            zs = 1 / inv
            u = (w0 * uvs[0][0] / s0[2] + w1 * uvs[1][0] / s1[2] + w2 * uvs[2][0] / s2[2]) / inv
            v = (w0 * uvs[0][1] / s0[2] + w1 * uvs[1][1] / s1[2] + w2 * uvs[2][1] / s2[2]) / inv
          }
          let tx = Math.trunc(u * tw)
          // A strip sample lands inside one frame; a plain texture keeps
          // covering the whole image, which is what a static sprite means.
          let ty = strip === null ? Math.trunc(v * th) : row * tw + Math.trunc(v * tw)
          if (tx < 0) tx = 0; else if (tx > tw - 1) tx = tw - 1
          if (ty < 0) ty = 0; else if (ty > th - 1) ty = th - 1
          const index = (ty * tw + tx) * 4
          const alpha = data[index + 3] / 255
          if (overlay === null) {
            if (blend) {
              if (!(alpha > 0)) continue
              if (!(zs <= depth[y * width + x])) continue
            } else {
              if (!(alpha >= 0.5)) continue
              if (!(zs < depth[y * width + x])) continue
            }
            depth[y * width + x] = zs
            if (pick !== null) pick[y * width + x] = quadIndex
          } else if (!(zs <= depth[y * width + x] + 1e-6)) {
            // A coplanar ghost must still show, so the overlay's depth test is
            // inclusive where the scene's is strict.
            continue
          }
          const target = (y * width + x) * 4
          const r = tint === null ? (data[index] / 255) * shade : tint[0]
          const g = tint === null ? (data[index + 1] / 255) * shade : tint[1]
          const b = tint === null ? (data[index + 2] / 255) * shade : tint[2]
          if (overlay !== null) {
            colour[target] = r * overlay + colour[target] * (1 - overlay)
            colour[target + 1] = g * overlay + colour[target + 1] * (1 - overlay)
            colour[target + 2] = b * overlay + colour[target + 2] * (1 - overlay)
          } else if (blend) {
            colour[target] = r * alpha + colour[target] * (1 - alpha)
            colour[target + 1] = g * alpha + colour[target + 1] * (1 - alpha)
            colour[target + 2] = b * alpha + colour[target + 2] * (1 - alpha)
          } else {
            colour[target] = r
            colour[target + 1] = g
            colour[target + 2] = b
          }
          colour[target + 3] = 1
        }
      }
    }
  }
  const bytes = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < bytes.length; i++) {
    const value = Math.round(colour[i] * 255)
    bytes[i] = value < 0 ? 0 : (value > 255 ? 255 : value)
  }
  return bytes
}

// ---- orientation: what the placement itself already says --------------------
//
// Vanilla never asks the player which way a block should face.  It computes the
// blockstate FROM the placement -- which face was clicked, where on that face,
// and which way the player looks.  So does this.  A few of those rules are exact
// and a few are per-block Java that nothing on disk records; the exact ones need
// no input at all, and the inexact one is one click away in the ghost.

// A pillar's axis is the axis of the face you clicked.  Exact: vanilla's
// BlockLog is `facing.getAxis()`.
const FACE_AXIS = { down: 'y', up: 'y', north: 'z', south: 'z', west: 'x', east: 'x' }
const FACE_OPPOSITE = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' }
const HORIZONTAL_FACES = { north: true, south: true, west: true, east: true }

// The game's own words where it has them; anything else keeps its id, because
// inventing a translation is worse than showing the real token.
const VALUE_LABEL = {
  down: '下', up: '上', north: '北', south: '南', west: '西', east: '东',
  x: 'X 轴', y: 'Y 轴', z: 'Z 轴', none: '无',
  true: '是', false: '否',
  top: '上半', bottom: '下半',
  straight: '直', inner_left: '内左', inner_right: '内右',
  outer_left: '外左', outer_right: '外右',
  save: '保存', load: '读取', corner: '角', data: '数据',
}
const AXIS_LABEL = {
  facing: '朝向', axis: '朝向（轴）', half: '上下', rotation: '旋转',
  conditional: '有条件', shape: '形状', mode: '模式',
  powered: '通电', locked: '锁定', delay: '延迟', open: '开合',
}

function labelOfValue(value) { return VALUE_LABEL[value] === undefined ? String(value) : VALUE_LABEL[value] }
function labelOfAxis(name) { return AXIS_LABEL[name] === undefined ? String(name) : AXIS_LABEL[name] }

function withKey(table, name, value) {
  const next = Object.assign({}, table || {})
  next[name] = value
  return next
}
function withoutKey(table, name) {
  const next = Object.assign({}, table || {})
  delete next[name]
  return next
}

/** One spelling for `name=value` pairs, so a composed key matches the pack's. */
function canonicalVariant(parts) {
  return Object.keys(parts).sort().map((name) => name + '=' + parts[name]).join(',')
}

/** What each property takes FROM THE PLACEMENT, ignoring any hand-set value. */
function deriveVariant(axes, face, hitY, flip) {
  const out = {}
  const horizontal = HORIZONTAL_FACES[face] === true
  for (const axis of axes) {
    const name = axis.name
    if (name === 'axis') {
      // Exact, and a flip cannot change it: an axis has no front.
      if (FACE_AXIS[face] !== undefined) out[name] = FACE_AXIS[face]
      continue
    }
    if (name === 'facing') {
      // NOT exact.  Vanilla computes `facing` in per-block code: a furnace ends
      // up facing the player (`getHorizontalFacing().getOpposite()`) while a
      // staircase ends up facing the way the player looks
      // (`getHorizontalFacing()`).  Those differ by 180 degrees and nothing on
      // disk says which family a block is in.  The default is the furnace family
      // (the majority: chests, dispensers, droppers, ...); the flip selects the
      // other, and the ghost shows which one you are about to get.
      const value = flip && horizontal ? FACE_OPPOSITE[face] : face
      if (value !== undefined && axis.values.indexOf(value) >= 0) out[name] = value
      continue
    }
    if (name === 'half') {
      // Exact: vanilla takes the top half for a click on the bottom face, the
      // bottom half for a click on the top face, and otherwise whichever half of
      // the side the pointer hit.
      const value = face === 'down' ? 'top' : (face === 'up' ? 'bottom' : (hitY > 0.5 ? 'top' : 'bottom'))
      if (axis.values.indexOf(value) >= 0) out[name] = value
      continue
    }
    // `rotation` (signs, banners, skulls) is computed from the player's yaw and
    // has no clicked-face equivalent.  There is no player here, so nothing is
    // derived and the property keeps the pack's own default unless set by hand.
  }
  return out
}

/** The variant key to ask for, or null to let the extractor choose.
 *
 *  Three sources, in order: what was set by hand, what the placement implies,
 *  and what the block defaults to.  The third one is not a fallback of
 *  convenience -- `conditional` on a command block has no placement rule and
 *  never will, so without a default the composed key would be incomplete and
 *  the derived `facing` would be thrown away with it.
 */
function variantFor(axes, keys, defaults, face, hitY, flip, overrides) {
  if (!Array.isArray(axes) || axes.length === 0) return null
  const derived = deriveVariant(axes, face, hitY, flip)
  const fallback = defaults || {}
  const parts = {}
  for (const axis of axes) {
    const hand = (overrides || {})[axis.name]
    const value = hand !== undefined ? hand : (derived[axis.name] !== undefined ? derived[axis.name] : fallback[axis.name])
    if (value !== undefined) parts[axis.name] = value
  }
  // Every property has to have an answer or the key is not a key.
  if (Object.keys(parts).length !== axes.length) return null
  const key = canonicalVariant(parts)
  // A variant the pack does not declare is not a variant.  Asking for nothing
  // beats sending a key that cannot match.
  return (keys || []).indexOf(key) >= 0 ? key : null
}

/**
 * The cells within one step of `at`, as offsets from it.
 *
 * A wall, a fence or a pane is drawn differently depending on its neighbours,
 * and the neighbours live here -- the host is asked about one block at a time.
 * So the ghost preview is handed the little neighbourhood it needs, which is
 * what makes the translucent "about to place here" block the same shape as the
 * block that lands.
 *
 * The one step covers everything the measured rules ask about: the four sides,
 * the cell above this one (a wall's `up`), and the cells above the four sides
 * (a wall side's `low`/`tall`).
 */
function aroundOf(cells, at) {
  const out = []
  if (!Array.isArray(cells) || !Array.isArray(at)) return out
  for (const cell of cells) {
    if (cell === null || typeof cell !== 'object' || !Array.isArray(cell.at)) continue
    if (typeof cell.block !== 'string' || cell.block === '') continue
    const d = [cell.at[0] - at[0], cell.at[1] - at[1], cell.at[2] - at[2]]
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue
    if (Math.abs(d[0]) > 1 || Math.abs(d[1]) > 1 || Math.abs(d[2]) > 1) continue
    const item = { d: d, block: cell.block }
    if (typeof cell.variant === 'string' && cell.variant !== '') item.variant = cell.variant
    out.push(item)
  }
  return out
}


// ---------------------------------------------------------------------------
// the 2D inventory icon
//
// Two shapes, and neither is "a nice 2:1 isometric cube":
//
//   iso   a block item.  Vanilla draws it with `display.gui` -- rotation
//         [30,225,0], scale 0.625, orthographic -- and with the GUI's OWN
//         lighting.  Two details decide the shading and both are measured in
//         `vanilla3d/tools/render_item_model.py`: the item matrix is
//         Rx(30)*Ry(225) (yaw FIRST, then pitch), and the normals go through the
//         same scale(16,-16,16) as the vertices, so they are y-flipped.  The
//         face brightness that falls out (up 1.0, east 0.637, north 0.435) is
//         NOT the world's face shading (1.0/0.8/0.6) -- drawing the icon with
//         the world table is exactly what makes a hand-rolled icon look wrong.
//   flat  a generated item: `layer0..N` sprites stacked, lit from the front, so
//         no directional shading at all.  That is what `gui_light: front` means
//         in 1.18.2, and in 1.12.2 it is the same question `isGui3d()` asks.
// ---------------------------------------------------------------------------
// The brightness is keyed by the face in MODEL space, not by which way it ends
// up pointing.  The item lights are fixed relative to the item, so a top face is
// a top face whatever the icon's matrix is; the rotation only decides which
// faces you can SEE.  (Measured, not reasoned: rotating the geometry by the GUI
// matrix and then shading, the icon of a six-colour cube shows exactly the up,
// east and north faces at 1.0, 0.637 and 0.435.  `icon-test.js` draws that cube
// and reads the colours back.)
const GUI_FACE_SHADE = { up: 1.0, east: 0.637, north: 0.435,
  down: 0.4, south: 0.4, west: 0.4 }
// The SAME measurement with the model matrix left at identity, which is what a
// chain with no `display` gets.  The GUI lights are set up in eye space, so the
// brightness of a named face belongs to the orientation it was measured in:
// reusing the table above here would be the same mistake as reusing the world's
// table there.  Derived by `vanilla3d/tools/render_item_model.py` with
// `IDENT` in place of `item_matrix()`; only `south` faces the icon camera.
const GUI_FACE_SHADE_FLAT = { up: 1.0, east: 0.417, north: 0.624,
  down: 0.4, south: 0.841, west: 0.543 }

/** Yaw first, then pitch -- vanilla's Rx(30)*Ry(225), about the block centre. */
function guiItemRotation(quads, rotation, table) {
  const yaw = rotation === undefined || rotation === null ? 0 : (rotation[1] || 0)
  const pitch = rotation === undefined || rotation === null ? 0 : (rotation[0] || 0)
  const shade = table === undefined || table === null ? GUI_FACE_SHADE : table
  return quads.map((quad) => {
    let p = quad.p
    // Yaw first, then pitch: vanilla's item matrix is Rx(30)*Ry(225).  Swapping
    // the two still draws a cube, which is why it has to be measured.
    if (yaw) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'y', yaw))
    if (pitch) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'x', pitch))
    // A model that says `shade: false` (a cross) is full bright in the world
    // renderer too, so it stays full bright here instead of being shaded by a
    // table meant for solid faces.
    const lit = quad.shaded === false ? (quad.shade === undefined ? 1.0 : quad.shade)
      : (shade[quad.face] === undefined ? 1.0 : shade[quad.face])
    return { p: p, uv: quad.uv, tex: quad.tex, shade: lit, mode: quad.mode,
      face: quad.face, shaded: quad.shaded }
  })
}

/** An orthographic camera that fits `quads` into a square, like vanilla's GUI. */
function iconCamera(quads, width, height, fill) {
  const box = boxOfQuads(quads)
  const spanX = Math.max(box.max[0] - box.min[0], 1e-6)
  const spanY = Math.max(box.max[1] - box.min[1], 1e-6)
  const ppu = Math.min(width, height) * (fill === undefined ? 0.98 : fill) / Math.max(spanX, spanY)
  const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2]
  const mid = (box.min[2] + box.max[2]) / 2
  return {
    project: function (point) {
      return [width / 2 + (point[0] - centre[0]) * ppu,
        height / 2 - (point[1] - centre[1]) * ppu,
        mid + 1 - point[2] + 0.5]
    },
  }
}

/** One icon frame into a canvas.  `decoded` holds one entry per texture id:
 *  the pixels, and whatever else the decode step kept. */
function drawItemIcon(canvas, recipe, frameIndex, decoded) {
  const width = canvas.width, height = canvas.height
  const paint = canvas.getContext('2d')
  paint.clearRect(0, 0, width, height)
  if (recipe === null || recipe === undefined) return
  if (recipe.shape === 'iso') {
    // No `display` anywhere in the chain means the game does not transform it
    // either: `block/cross` (the flower/sapling shape) declares none, so its
    // item is drawn straight on.  Forcing the 30/225 GUI matrix there shows an
    // angle the game never shows.
    const hasDisplay = recipe.display !== null && recipe.display !== undefined
    const rotation = hasDisplay ? (recipe.display.rotation || [0, 0, 0]) : [0, 0, 0]
    const quads = guiItemRotation(recipe.quads || [], rotation,
      hasDisplay ? GUI_FACE_SHADE : GUI_FACE_SHADE_FLAT)
    if (quads.length === 0) return
    const bytes = renderScene({ width: width, height: height,
      background: [0, 0, 0], backgroundAlpha: 0, orthographic: true,
      camera: iconCamera(quads, width, height, 0.98), quads: quads,
      textures: decoded, animations: recipe.animations || {},
      timeMs: animTicks * 50 })
    const frame = paint.createImageData(width, height)
    frame.data.set(bytes)
    paint.putImageData(frame, 0, 0)
    return
  }
  const frames = recipe.frames && recipe.frames.length > 0 ? recipe.frames : null
  const layers = frames === null ? (recipe.layers || [])
    : (frames[((frameIndex || 0) % frames.length + frames.length) % frames.length].layers || [])
  // Every layer is blitted from the DECODED PIXELS, nearest neighbour, source
  // over.  It used to paste the live <img> with `drawImage`, and that is the whole
  // of "非方块没法显示": the panel removes that <img> as soon as the pixels are
  // decoded (the hidden list skips ids that are already decoded), so from that
  // moment a flat icon had nothing to paste and painted ZERO pixels -- measured,
  // while a cube next to it painted 2744.  Reading only `decoded` makes this path
  // a pure function of the same data the iso path uses, so nothing about the DOM
  // can blank an icon again.
  const out = new Uint8ClampedArray(width * height * 4)
  for (const id of layers) {
    const texture = decoded === undefined ? undefined : decoded[id]
    if (texture === undefined || texture.data === undefined) continue
    const sw = texture.width
    const sh = texture.height
    if (!(sw > 0 && sh > 0)) continue
    const animation = (recipe.animations || {})[id]
    const strip = stripOf({ width: sw, height: sh, animation: animation })
    // A strip sample stays inside one frame; a plain texture is the whole image.
    const top = strip === null ? 0 : animationRow(animation, animTicks * 50) * sw
    const rows = strip === null ? sh : sw
    for (let y = 0; y < height; y++) {
      const sy = top + Math.floor((y * rows) / height)
      if (sy < 0 || sy >= sh) continue
      for (let x = 0; x < width; x++) {
        const sx = Math.floor((x * sw) / width)
        const from = (sy * sw + sx) * 4
        const alpha = texture.data[from + 3] / 255
        if (alpha <= 0) continue
        const to = (y * width + x) * 4
        out[to] = texture.data[from] * alpha + out[to] * (1 - alpha)
        out[to + 1] = texture.data[from + 1] * alpha + out[to + 1] * (1 - alpha)
        out[to + 2] = texture.data[from + 2] * alpha + out[to + 2] * (1 - alpha)
        out[to + 3] = Math.max(out[to + 3], texture.data[from + 3])
      }
    }
  }
  const frame = paint.createImageData(width, height)
  frame.data.set(out)
  paint.putImageData(frame, 0, 0)
}

/** Blank the viewport for a size.  Setting `width`/`height` is what actually
 *  discards the old bitmap (and is why this is not just a `clearRect`): the
 *  canvas may have been sized for a different scene. */
function clearViewport(canvas, width, height) {
  canvas.width = width
  canvas.height = height
  const paint = canvas.getContext('2d')
  if (paint !== null && paint !== undefined) paint.clearRect(0, 0, width, height)
}

/** A data URL for one slot of the grid: the same recipe, frame 0, small. */
function itemIconUrl(recipe, decoded, size) {
  if (recipe === null || recipe === undefined) return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  drawItemIcon(canvas, recipe, 0, decoded)
  return canvas.toDataURL('image/png')
}

/** How far up the clicked face the pointer landed, as a 0..1 fraction. */
function faceHitY(quad, pixelX, pixelY, camera) {
  if (quad === undefined || camera === undefined || camera === null) return 0.5
  const screen = []
  for (const point of quad.p) {
    const projected = camera.project(point)
    if (projected === null) return 0.5
    screen.push(projected)
  }
  for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
    const a = screen[triangle[0]], b = screen[triangle[1]], c = screen[triangle[2]]
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    if (Math.abs(area) < 1e-9) continue
    const w0 = ((b[0] - pixelX) * (c[1] - pixelY) - (c[0] - pixelX) * (b[1] - pixelY)) / area
    const w1 = ((c[0] - pixelX) * (a[1] - pixelY) - (a[0] - pixelX) * (c[1] - pixelY)) / area
    const w2 = 1 - w0 - w1
    if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue
    const weights = [w0, w1, w2]
    let y = 0
    for (let i = 0; i < 3; i++) y += quad.p[triangle[i]][1] * weights[i]
    const ys = quad.p.map((point) => point[1])
    const min = Math.min(ys[0], ys[1], ys[2], ys[3])
    const max = Math.max(ys[0], ys[1], ys[2], ys[3])
    return max - min < 1e-6 ? 0.5 : (y - min) / (max - min)
  }
  return 0.5
}

/** The derived properties in words, for the one-line summary. */
function variantSummary(axes, props) {
  const parts = []
  for (const axis of axes) {
    const value = props[axis.name]
    if (value === undefined) continue
    parts.push(labelOfAxis(axis.name) + ' ' + labelOfValue(value))
  }
  return parts.length === 0 ? '按方块默认' : parts.join(' · ')
}

const CSS = [
  '.mcart-root{display:flex;flex-direction:column;gap:8px;padding:10px;height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;font-size:12px}',
  '.mcart-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.mcart-title{font-size:13px;font-weight:600}',
  '.mcart-sub{opacity:.6;font-size:11px}',
  '.mcart-path{opacity:.75;font-size:11px;word-break:break-all;flex:1;min-width:0}',
  '.mcart-list{overflow:auto;border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:4px;max-height:220px}',
  '.mcart-group{font-size:10px;letter-spacing:.05em;text-transform:uppercase;opacity:.55;padding:6px 6px 2px}',
  '.mcart-item{display:block;width:100%;text-align:left;background:none;border:0;border-radius:6px;color:inherit;font:inherit;font-size:12px;padding:4px 6px;cursor:pointer}',
  '.mcart-item:hover{background:rgba(127,127,127,.16)}',
  '.mcart-item[data-on="1"]{background:rgba(127,127,127,.28);font-weight:600}',
  '.mcart-id{font-size:10px;opacity:.45;margin-left:4px}',
  '.mcart-stage{flex:none;display:flex;flex-direction:column;gap:6px}',
  '.mcart-canvas{width:100%;height:240px;display:block;border-radius:8px;background:#1a181c;border:1px solid rgba(127,127,127,.25);cursor:grab;touch-action:none}',
  '.mcart-canvas:active{cursor:grabbing}',
  '.mcart-btn{background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.3);border-radius:6px;color:inherit;font:inherit;font-size:11px;padding:3px 8px;cursor:pointer;flex:none}',
  '.mcart-btn:hover{background:rgba(127,127,127,.26)}',
  '.mcart-btn[disabled]{opacity:.35;cursor:default}',
  '.mcart-icon{background:none;border:0;color:inherit;font:inherit;font-size:13px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer}',
  '.mcart-icon:hover{background:rgba(127,127,127,.2)}',
  '.mcart-input{flex:1;min-width:0;background:rgba(0,0,0,.18);border:1px solid rgba(127,127,127,.3);border-radius:6px;color:inherit;font:inherit;font-size:11px;padding:4px 6px}',
  '.mcart-card{border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;background:rgba(127,127,127,.04)}',
  '.mcart-row{display:flex;align-items:center;gap:6px;border-radius:6px;padding:2px 4px}',
  '.mcart-row:hover{background:rgba(127,127,127,.14)}',
  '.mcart-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-projects{max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:1px;border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:3px}',
  '.mcart-switch{display:flex;align-items:flex-start;gap:6px;cursor:pointer;padding:2px 0}',
  '.mcart-switch input{margin:1px 0 0 0;flex:none}',
  '.mcart-hint{font-size:10px;opacity:.5;margin-left:19px}',
  '.mcart-mods{border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:3px 6px;display:flex;flex-direction:column;gap:1px;max-height:160px;overflow:auto}',
  '.mcart-chip{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(127,127,127,.16)}',
  '.mcart-note{opacity:.66;font-size:11px}',
  '.mcart-bad{font-size:11px;color:#e0a06c;word-break:break-all}',
  '.mcart-err{font-size:11px;color:#e06c6c;word-break:break-all}',
  '.mcart-edit{display:flex;flex-direction:column;gap:6px}',
  '.mcart-edit-canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain;image-rendering:pixelated;border-radius:4px;background:#111;cursor:crosshair;touch-action:none}',
  '.mcart-tools{display:flex;gap:4px;flex-wrap:wrap;align-items:center}',
  '.mcart-tool[data-on="1"]{background:rgba(127,127,127,.42);font-weight:600}',
  '.mcart-swatches{display:flex;gap:3px;flex-wrap:wrap;max-height:56px;overflow:auto}',
  '.mcart-swatch{width:16px;height:16px;border-radius:3px;border:1px solid rgba(127,127,127,.5);cursor:pointer;padding:0;flex:none}',
  '.mcart-color{width:22px;height:22px;border-radius:4px;border:1px solid rgba(127,127,127,.5);flex:none}',
  '.mcart-tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center}',
  '.mcart-picker{width:36px;height:24px;padding:0;border:1px solid rgba(127,127,127,.5);border-radius:4px;background:none;flex:none}',
  '.mcart-alpha{flex:1;min-width:60px}',
  '.mcart-select{flex:1;min-width:0;background:rgba(0,0,0,.18);border:1px solid rgba(127,127,127,.3);border-radius:6px;color:inherit;font:inherit;font-size:11px;padding:3px 4px}',
  '.mcart-hotbar{display:flex;gap:3px;flex-wrap:wrap;max-height:124px;overflow:auto}',
  '.mcart-slot{width:26px;height:26px;border:1px solid rgba(127,127,127,.4);border-radius:4px;background:none;background-size:cover;image-rendering:pixelated;padding:0;flex:none;cursor:pointer}',
  '.mcart-slot:hover{background-color:rgba(127,127,127,.22)}',
  '.mcart-slot[data-on="1"]{outline:2px solid currentColor;outline-offset:1px}',
  '.mcart-slotq{font-size:13px;line-height:1;opacity:.6}',
  '.mcart-icon[data-on="1"]{background:rgba(127,127,127,.3)}',
  '.mcart-viewport{position:relative;flex:none}',
  '.mcart-zoom{position:absolute;right:6px;top:6px;display:flex;gap:3px;opacity:.72}',
  '.mcart-zoom:hover{opacity:1}',
  '.mcart-zoombtn{width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;background:rgba(20,20,24,.62);border-color:rgba(200,200,210,.45)}',
  '.mcart-hud{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:4px;padding:0 6px 6px;pointer-events:none}',
  '.mcart-hudname{font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(20,20,24,.72);border:1px solid rgba(200,200,210,.28);text-shadow:0 1px 2px rgba(0,0,0,.85)}',
  '.mcart-hudbar{display:flex;align-items:center;gap:3px;padding:3px;border-radius:8px;background:rgba(20,20,24,.64);border:1px solid rgba(200,200,210,.32);pointer-events:auto}',
  '.mcart-hudslot{width:34px;height:34px;padding:0;flex:none;display:flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid rgba(120,120,130,.45);background:rgba(0,0,0,.32);cursor:pointer}',
  '.mcart-hudslot:hover{border-color:rgba(240,240,250,.8);background:rgba(255,255,255,.14)}',
  '.mcart-hudslot[data-on="1"]{border-color:#f2f2f6;box-shadow:inset 0 0 0 1px #f2f2f6,0 0 6px rgba(0,0,0,.6)}',
  '.mcart-hudicon{width:30px;height:30px;display:block;image-rendering:pixelated}',
  '.mcart-hudempty{background:rgba(0,0,0,.22);border-color:rgba(120,120,130,.26);cursor:default}',
  '.mcart-hudpage{width:16px;height:34px;padding:0;flex:none;font:inherit;font-size:12px;line-height:1;color:inherit;background:none;border:0;cursor:pointer;opacity:.7}',
  '.mcart-hudpage:hover{opacity:1}',
  '.mcart-hudpage[disabled]{opacity:.22;cursor:default}',
  '.mcart-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;pointer-events:none}',
  '.mcart-grip{display:flex;align-items:center;justify-content:center;height:13px;cursor:ns-resize;touch-action:none}',
  '.mcart-gripbar{width:46px;height:4px;border-radius:999px;background:rgba(127,127,127,.42)}',
  '.mcart-grip:hover .mcart-gripbar{background:rgba(210,210,220,.8)}',
  '.mcart-grip:active .mcart-gripbar{background:rgba(235,235,245,.95)}',
  '.mcart-src{display:flex;align-items:center;gap:6px}',
  '.mcart-ref{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 6px;padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.3);font-size:12px}',
  '.mcart-ref-path{opacity:.66;word-break:break-all}',
].join('')

const CATEGORIES = [
  { key: 'biome', label: '群系' },
  { key: 'structure', label: '结构' },
  { key: 'entity', label: '实体' },
  { key: 'block', label: '方块' },
]

const TAB_ID = 'mc-art.atlas'

const decoded = {}
const failedTex = {}
const indexes = {}
const imageNodes = {}
const drag = { active: false, x: 0, y: 0, moved: 0 }
let pickBuffer = null
// Which ghost request is already on screen (or already in flight).  Kept
// OUTSIDE the ghost object on purpose: it used to live on the ghost as
// `aroundKey`, and the success path replaced the ghost with the host's
// reply -- which has no such field -- so the identity check failed on the
// very next render and asked again.  The ghost flickered forever.  A field
// that one setter forgets is a field that will be forgotten again.
let ghostAsk = ''
// Block icon data URLs, cached per block name across openings of the panel.
const icons = {}
// Names we have already asked about.  Without this a block whose icon cannot be
// produced stays "missing" forever, the icon effect re-fires on every iconTick,
// and the panel spins asking for the same dead names.
const iconTried = {}
// `namespace:item` -> the icon recipe, and its data URL for the grid.  The grid
// draws every slot at once; the big preview keeps the recipe so it can ANIMATE
// (`item/clock` is 64 model swaps, and a mod's item texture may be a strip).
const itemRecipes = {}
const itemUrls = {}
// The hotbar's slot canvases, keyed like `itemRecipes`.  Module scope for the
// same reason: the draw effect needs them across renders without a state update
// per slot, and a ref callback is what fills them in.
const hudCanvases = {}
const TINT_REMOVE = [0.85, 0.2, 0.18]
// A stroke is one undo step, so the pen has to know whether it is still down.
const painting = { active: false }

const EDIT_ZOOM = 18
const EDIT_UNDO = 24
const EDIT_PALETTE = 64

// The (list, selection) pair the bar has already turned to.  Module scope for the
// same reason `lastDrawKey` is: the effect needs to remember it across renders,
// and putting it in state would re-render to say "no change".
let hudFollowed = ''
// The 3D+hotbar block: default height, and the range the grip may drag it to.
// Generous at the top because the panel scrolls; stingy at the bottom because
// below ~140 px the hotbar covers the model it is supposed to be showing.
const VIEW_H = 240
const VIEW_H_MIN = 140
const VIEW_H_MAX = 760
// The grip drag lives outside React for the same reason `drag` and `painting`
// do: it is read on every pointer move, and a state field read one render late
// is a drag that starts from the wrong height.
const gripDrag = { active: false, y: 0, origin: 0 }
const clampViewH = (value) => Math.max(VIEW_H_MIN, Math.min(VIEW_H_MAX, Math.round(value)))

// Where in a TEXTURE a pointer landed.
//
// The editor canvas is a replaced element: `width:100%`, `height:auto`, capped by
// `max-height:52vh`, and `object-fit:contain`.  So its BOX and its PICTURE are not
// the same rectangle -- as soon as the box is wider than the picture's aspect
// (which is what a wide side panel does), the picture is scaled to the box height
// and centred with margins left and right.  Mapping the whole box put every click
// on the wrong pixel, and the error grew with the panel width -- the case the user
// reported ("我点了a格子 但被上色或者擦掉的是左边的格子 尤其是我把侧边栏拉宽").
// Compute the drawn rectangle first, then map inside it.  `contain` means ONE
// scale for both axes, so a box that already matches the picture's aspect lands
// exactly on the old arithmetic.
function texturePoint(rect, target, clientX, clientY) {
  if (rect === undefined || rect === null) return null
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  if (!(target.w > 0) || !(target.h > 0)) return null
  const scale = Math.min(rect.width / target.w, rect.height / target.h)
  if (!(scale > 0)) return null
  const left = rect.left + (rect.width - target.w * scale) / 2
  const top = rect.top + (rect.height - target.h * scale) / 2
  return [Math.floor((clientX - left) / scale), Math.floor((clientY - top) / scale)]
}

// Blocks per page.  The user's complaint about the first cut ("只显示前面240算什么")
// was right: a bigger ceiling is still a ceiling.  Categories narrow the list and
// the rest is PAGED, so every block is reachable rather than merely present.
const PAGE_SIZE = 20
// Reference textures are HD (AoA3 runs ~12 KB per icon, 17 MB for a whole
// namespace), so icons are fetched a batch at a time and never all at once.
const ICON_BATCH = 80
// The item browser: 40 slots a page (8 x 5).  The hotbar at the bottom of the
// 3D view is the game's OWN number -- nine slots -- because that is what it is
// imitating: one row, one click, the thing you are holding.
const ITEM_PAGE = 40
const HUD_SLOTS = 9

/**
 * Is this reply a failure?  "Has an `error` key" is NOT the same question: the
 * extractor answers `error: null` on purpose for every flat item (no elements is
 * the normal state of a generated item), so a key-exists test turned every flat
 * item into "取不到" -- a tool, a sword, a project's own sprite.
 */
/**
 * 缺失判定与"总取值"。
 *
 * 为什么需要：面板和宿主之间走 JSON，而 **JSON 会把 `undefined` 的字段整条丢掉**。
 * 于是宿主那边的"没有这个字段"到客户端就是 `undefined`，而代码里大量守卫只写了
 * `=== null`（107 处）。用户实测的崩溃就是这么来的：
 *   `const ids = asset.recipe === null ? [] : (asset.recipe.textureIds || [])`
 * `recipe` 不在时是 `undefined`，`=== null` 放它过去 → 读 `.textureIds` 当场抛
 * `Cannot read properties of undefined (reading 'textureIds')`（面板白屏）。
 *
 * 所以形状取值一律走这里：缺失（null/undefined）与非数组都给空数组，永不抛。
 */
const isAbsent = (value) => value === null || value === undefined
const idsOf = (value) => (isAbsent(value) || !Array.isArray(value.textureIds) ? [] : value.textureIds)
const objectOf = (value) => (isAbsent(value) || typeof value !== 'object' ? {} : value)
const arrayOf = (value) => (Array.isArray(value) ? value : [])

/**
 * 把宿主回来的场景**归一化**再存进 state。
 *
 * 为什么在"存"这一侧做：JSON 会丢掉 `undefined` 字段，所以"少一个字段"是常态而不是
 * 异常。以前是把 payload 原样存进 `scene`，之后每个读它的人都得自己防 —— 漏一处就是
 * 一次白屏（用户实测 `asset.recipe` 那处就是这么炸的）。现在存之前补齐：数组字段一律
 * 是数组，对象字段一律是对象，可空的保持 null。
 */
const sceneOf = (payload) => ({
  kind: payload.kind,
  id: payload.id,
  title: payload.title,
  project: payload.project,
  quads: arrayOf(payload.quads),
  textureIds: idsOf(payload),
  textures: objectOf(payload.textures),
  animations: objectOf(payload.animations),
  cells: isAbsent(payload.cells) ? null : payload.cells,
  faceStep: payload.faceStep,
  refs: arrayOf(payload.refs),
  ref: isAbsent(payload.ref) ? null : payload.ref,
  palette: arrayOf(payload.palette),
  box: isAbsent(payload.box) ? null : payload.box,
  errors: arrayOf(payload.errors),
  preview: payload.preview === true,
})

function failureOf(reply) {
  if (reply === null || reply === undefined) return '没有返回结果'
  if (reply.error === undefined || reply.error === null) return null
  return String(reply.error)
}
function countsOf(list, keyOf, labelOf) {
  // `{key: {count, label}}` for a chip row -- labels come from the data.
  const out = {}
  for (const entry of list || []) {
    const key = keyOf(entry) || ''
    // An entry with no category is not a category: a chip labelled "" would be
    // an unclickable button with a count on it.
    if (key === '') continue
    if (out[key] === undefined) out[key] = { count: 0, label: labelOf(entry) || key }
    out[key].count += 1
  }
  return out
}

function cssColour(colour) {
  if (colour === null || colour === undefined) return 'transparent'
  return 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ',' + (colour[3] / 255) + ')'
}

function hexOf(colour) {
  const c = colour === null || colour === undefined ? [0, 0, 0, 255] : colour
  const two = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)
  return '#' + two(c[0]) + two(c[1]) + two(c[2])
}

function fromHex(text, alpha) {
  const raw = String(text === undefined || text === null ? '' : text).replace('#', '')
  const a = alpha === undefined ? 255 : alpha
  if (raw.length !== 6) return [0, 0, 0, a]
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), a]
}

/** Which faces a texture covers, in words.  The tab order follows the model,
 *  which starts at the bottom, so a grass block opened on 底面 flesh_soil and
 *  nothing said so -- a label is the honest fix, not a different order. */
function faceLabel(faces) {
  const list = faces === undefined || faces === null ? [] : faces
  if (list.length === 0) return '贴图'
  const top = list.indexOf('up') >= 0
  const bottom = list.indexOf('down') >= 0
  const side = list.some((face) => face === 'north' || face === 'south' || face === 'west' || face === 'east')
  const parts = []
  if (top) parts.push('顶面')
  if (side) parts.push('侧面')
  if (bottom) parts.push('底面')
  return parts.length === 0 ? '贴图' : parts.join('+')
}

function sameColour(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/** Add one colour to a palette, newest last, without duplicates.
 *
 *  Kept out of the render path on purpose.  `<input type="color">` fires its
 *  change event continuously while the picker is being dragged, so anything
 *  that appends there produces one swatch per intermediate colour and the
 *  panel fills up with hundreds of them. */
function addToPalette(palette, colour, limit) {
  if (colour === null || colour === undefined) return palette
  if (palette.some((c) => sameColour(c, colour))) return palette
  const next = palette.concat([colour])
  return next.length > limit ? next.slice(next.length - limit) : next
}

function readPixel(pixels, width, x, y) {
  const at = (y * width + x) * 4
  return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
}

function writePixel(pixels, width, x, y, colour) {
  const at = (y * width + x) * 4
  pixels[at] = colour[0]
  pixels[at + 1] = colour[1]
  pixels[at + 2] = colour[2]
  pixels[at + 3] = colour[3]
}

/** The colours actually used by this sprite, in the same sense the engine's
 *  analyzer means it: opaque pixels only, first-seen order. */
function paletteOf(pixels, limit) {
  const seen = []
  const known = {}
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    const key = pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2] + ',' + pixels[i + 3]
    if (known[key] === true) continue
    known[key] = true
    seen.push([pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]])
    if (seen.length >= limit) break
  }
  return seen
}

let canvasGeneration = 0
let lastDrawKey = ''
// The camera the last frame was drawn with.  A click is a pixel, and turning
// that pixel into "how far up the face did I hit" needs the same projection the
// pick buffer was filled with -- not a fresh one from current state.
let lastCamera = null
// Frame clock for animated textures, counted in the timer's own ticks (50 ms
// each).  Deliberately not `Date.now()`: the only clock this half is given is
// the timer service, and deriving the frame from the very ticks that trigger
// the redraw means the picture and the clock cannot drift apart.
let animTicks = 0

const roots = {}
const listeners = []
let pending = null
function setPending(next) {
  pending = next
  const copy = listeners.slice()
  for (const listener of copy) listener()
}
function usePending() {
  const pair = React.useState(pending)
  React.useEffect(() => {
    const listener = () => pair[1](pending)
    listeners.push(listener)
    return () => {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    }
  }, [])
  return pair[0]
}

return {
  // The client half runs in a restricted sandbox and browser timer globals are
  // NOT there: reaching for `setInterval` took the whole tab down with
  // "setInterval is not available in a dynamic client half".  Anything that
  // needs to tick has to come from this injected service.
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    // A hard dependency (declared above), so it is present -- not a maybe.
    const timer = ctx.timer
    ctx.effect(() => styles.insert(CSS))

    const tabs = ctx.get('sidebarRightTabs')
    const sidebarRight = ctx.get('sidebarRight')
    // 右侧栏的判据不能只看服务名。有些壳（桌面端实测）不暴露 sidebarRightTabs 服务，
    // 但右侧栏的**槽**是实实在在存在的——只看服务会让面板掉进左栏回退，
    // 看起来像"装了个旧版本"。所以：服务在，或者那个槽已经有条目，都算右侧栏。
    function slotHasEntries(name) {
      try {
        if (typeof slots.entries !== 'function') return false
        const list = slots.entries(name)
        return Array.isArray(list) && list.length > 0
      } catch (error) {
        return false
      }
    }
    // 右侧栏在不在：**必须**有 tabs（注册 tab 的唯一必需品），证据可以是 sidebarRight
    // 服务或右侧栏的槽。没有 tabs 就只能回退左栏——硬进右栏会炸在 tabs.register 上
    // （门禁抓着过我这一版）。
    //
    // 但**不能只在 apply 那一刻采样一次**：冷启动时右侧栏插件可能比我们晚挂载，
    // 于是同一个包"热重载进右栏、重启后进左栏"（用户实测）。所以：先放一个能用的
    // 落点，并等 sidebarRightTabs 出现——出现就搬过去，等不到就一直留在左栏。
    function rightColumnReady() {
      return ctx.get('sidebarRightTabs') !== undefined &&
        (ctx.get('sidebarRight') !== undefined || slotHasEntries('sidebar.right.pane.tab'))
    }
    const tabsReady = ctx.get('sidebarRightTabs')
    const sidebarRightReady = ctx.get('sidebarRight')
    const inRightColumn = tabsReady !== undefined &&
      (sidebarRightReady !== undefined || slotHasEntries('sidebar.right.pane.tab'))

    /**
     * 面板**不允许白屏**。
     *
     * 渲染时抛异常，React 会把整棵子树卸掉 —— 屏幕上什么都不剩，也没有任何提示，
     * 用户只能报"一片空白"。这个边界把错误本身画出来（带包名与版本），于是
     * "空白"这种状态永远带着一句话，能直接贴给我。
     */
    // `React.Component` **不是每个壳都保证有的**：缺了它，`class X extends undefined` 会在
    // 模块求值时就抛 —— 一个为了"别白屏"而加的东西，反过来把整个面板炸掉。所以先问一句，
    // 没有就退化成"直接渲染孩子"（没有边界，但至少能用）。
    const canUseBoundary = typeof React.Component === 'function'
    const PanelBoundary = canUseBoundary
      ? class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error) {
          try { console.error('[mcart] 面板渲染失败', error) } catch (ignored) { /* 没有 console 也不能再炸 */ }
        }
        render() {
          if (this.state.error === null || this.state.error === undefined) return this.props.children
          const message = this.state.error !== null && this.state.error.message !== undefined
            ? this.state.error.message : this.state.error
          return React.createElement('div', { className: 'mcart-root' },
            React.createElement('div', { className: 'mcart-err' },
              '面板渲染失败：' + String(message)),
            React.createElement('div', { className: 'mcart-hint' },
              '刷新一次；如果仍是这一句，把它连同"MC 资产"面板发给我 —— 版本：' + String(PANEL_VERSION)),
          )
        }
      }
      : function PanelBoundary(props) { return props.children }

    function Atlas(props) {
      // 故障注入的缝：门禁把它置真，用来证明"渲染抛异常时边界真的会画出那句话"
      // （生产里这面旗永远是 undefined）。
      if (typeof globalThis !== 'undefined' && globalThis.__MCART_FORCE_RENDER_ERROR__ === true) {
        throw new Error('注入的渲染错误')
      }
      const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)
      const indexPair = React.useState(null)
      const failurePair = React.useState(null)
      // 空目录的引导：`emptyRoot` 记着"哪个根目录里一个项目都没有"，`newId` 是用户正在
      // 取的项目名（命名空间与它同名 —— 一个模组一个命名空间，不让在这里分叉）。
      const emptyPair = React.useState(null)
      const newIdPair = React.useState('')
      const noticePair = React.useState(null)
      const nearbyPair = React.useState(null)
      const choicePair = React.useState(null)
      const scenePair = React.useState(null)
      const tickPair = React.useState(0)
      const yawPair = React.useState(0.72)
      const pitchPair = React.useState(0.34)
      const zoomPair = React.useState(1)
      const canvasPair = React.useState(null)
      const scratchPair = React.useState(null)
      const sizePair = React.useState([340, 260])
      // The 3D+hotbar block's height, in the panel.  Only the height: the width
      // is the panel's.  Changing it is enough -- the resize effect reads
      // `clientHeight` and the draw effect keys on the size, so the raster
      // follows without a second path for "resized".
      const viewHPair = React.useState(VIEW_H)
      // The 2D stand-in's canvas, when there is no 3D scene to draw.
      const posterPair = React.useState(null)
      // One line for the item case ("改不了/没有可引用的文件"), shown under the
      // canvas with the other notes rather than in a card that is not open.
      const itemMsgPair = React.useState(null)
      // The last settings save, so the panel can offer the one-line notification.
      const savedSettingsPair = React.useState(null)
      const busyPair = React.useState(false)
      const pickingPair = React.useState(false)
      // 参考目录的手输框内容（与 settings.directory 分开：输入过程中不该直接写盘）。
      const dirDraftPair = React.useState('')
      const draftPair = React.useState('')
      const settingsPair = React.useState(null)
      const savePair = React.useState(null)
      const modsOpenPair = React.useState(false)
      const rootPair = React.useState(roots[sessionId] === undefined ? '' : roots[sessionId])
      const index = indexPair[0], setIndex = indexPair[1]
      const failure = failurePair[0], setFailure = failurePair[1]
      const emptyRoot = emptyPair[0], setEmptyRoot = emptyPair[1]
      const newId = newIdPair[0], setNewId = newIdPair[1]
      const notice = noticePair[0], setNotice = noticePair[1]
      const nearby = nearbyPair[0], setNearby = nearbyPair[1]
      const choice = choicePair[0], setChoice = choicePair[1]
      const scene = scenePair[0], setScene = scenePair[1]
      const tick = tickPair[0], setTick = tickPair[1]
      const yaw = yawPair[0], setYaw = yawPair[1]
      const pitch = pitchPair[0], setPitch = pitchPair[1]
      const zoom = zoomPair[0], setZoom = zoomPair[1]
      const canvas = canvasPair[0], setCanvas = canvasPair[1]
      const scratch = scratchPair[0], setScratch = scratchPair[1]
      const size = sizePair[0], setSize = sizePair[1]
      const viewH = viewHPair[0], setViewH = viewHPair[1]
      const posterCanvas = posterPair[0], setPosterCanvas = posterPair[1]
      const itemMsg = itemMsgPair[0], setItemMsg = itemMsgPair[1]
      const savedSettings = savedSettingsPair[0], setSavedSettings = savedSettingsPair[1]
      const busy = busyPair[0], setBusy = busyPair[1]
      const picking = pickingPair[0], setPicking = pickingPair[1]
      const dirDraft = dirDraftPair[0], setDirDraft = dirDraftPair[1]
      const draft = draftPair[0], setDraft = draftPair[1]
      const settings = settingsPair[0], setSettings = settingsPair[1]
      const saveState = savePair[0], setSaveState = savePair[1]
      const modsOpen = modsOpenPair[0], setModsOpen = modsOpenPair[1]
      const root = rootPair[0], setRoot = rootPair[1]
      const editPair = React.useState(null)
      const undoPair = React.useState([])
      const editTickPair = React.useState(0)
      const editCanvasPair = React.useState(null)
      const editScratchPair = React.useState(null)
      const editBusyPair = React.useState(false)
      const editMsgPair = React.useState(null)
      const voxelPair = React.useState(null)
      const hoverPair = React.useState(null)
      const ghostPair = React.useState(null)
      const iconTickPair = React.useState(0)
      const voxel = voxelPair[0], setVoxel = voxelPair[1]
      const hover = hoverPair[0], setHover = hoverPair[1]
      const ghost = ghostPair[0], setGhost = ghostPair[1]
      const iconTick = iconTickPair[0], setIconTick = iconTickPair[1]
      const edit = editPair[0], setEdit = editPair[1]
      const undo = undoPair[0], setUndo = undoPair[1]
      const editTick = editTickPair[0], setEditTick = editTickPair[1]
      const editCanvas = editCanvasPair[0], setEditCanvas = editCanvasPair[1]
      const editScratch = editScratchPair[0], setEditScratch = editScratchPair[1]
      const editBusy = editBusyPair[0], setEditBusy = editBusyPair[1]
      const editMsg = editMsgPair[0], setEditMsg = editMsgPair[1]
      const refSourcesPair = React.useState([])
      const refSources = refSourcesPair[0], setRefSources = refSourcesPair[1]
      const itemPair = React.useState(null)
      const item = itemPair[0], setItem = itemPair[1]
      const iconPair = React.useState(null)
      const iconPick = iconPair[0], setIconPick = iconPair[1]
      // The 2D layer of the 3D view -- the game's hotbar.  `item` is the loaded
      // list, `itemOpen` only says whether the BROWSER (source, search, chips,
      // the 40-slot grid) is unfolded.  They used to be one state, so closing the
      // browser threw the list away; now the bar at the bottom keeps its items
      // whether the browser is open or not.
      const itemOpenPair = React.useState(false)
      const itemOpen = itemOpenPair[0], setItemOpen = itemOpenPair[1]
      const hudPagePair = React.useState(1)
      const hudPage = hudPagePair[0], setHudPage = hudPagePair[1]
      // A reference block opened from the item browser: it is not in this
      // project's index, so it cannot go through `open()`.
      const previewPair = React.useState(null)
      const previewItem = previewPair[0], setPreviewItem = previewPair[1]
      const filterPair = React.useState('')
      const filter = filterPair[0], setFilter = filterPair[1]
      const pickGroupPair = React.useState('')
      const pickGroup = pickGroupPair[0], setPickGroup = pickGroupPair[1]
      const pickFamilyPair = React.useState('')
      const pickFamily = pickFamilyPair[0], setPickFamily = pickFamilyPair[1]
      const pickPagePair = React.useState(1)
      const pickPage = pickPagePair[0], setPickPage = pickPagePair[1]

      function activeProjectId() {
        if (choice !== null && choice.project !== undefined && choice.project !== null) return choice.project
        const projects = index === null ? [] : (index.projects || [])
        return projects.length > 0 ? projects[0].id : null
      }

      function open(target, where) {
        setBusy(true)
        setChoice(target)
        setPreviewItem(null)
        // Switching asset closes whatever was open.  Leaving the previous
        // asset's editor on screen next to a new 3D view invites editing the
        // wrong thing, and the edit buffer belongs to the old texture anyway.
        painting.active = false
        setEdit(null)
        setUndo([])
        setEditMsg(null)
        setVoxel(null)
        setHover(null)
        setGhost(null)
        const want = { root: where, project: target.project, kind: target.kind, id: target.id, have: Object.keys(decoded) }
        host.call('atlas.scene', want).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('scene returned nothing'); return }
          if (result.error !== undefined) { setFailure(result.error); setScene(null); return }
          setFailure(null)
          for (const key of Object.keys(imageNodes)) delete imageNodes[key]
          setScene(sceneOf(result))
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      function firstOfProject(project) {
        if (project === undefined || project === null) return null
        for (const category of CATEGORIES) {
          const items = (project.items && project.items[category.key]) || []
          if (items.length > 0) return { project: project.id, kind: category.key, id: items[0].id }
        }
        return null
      }

      function firstPick(result) {
        const projects = result.projects || []
        for (const category of CATEGORIES) {
          for (const project of projects) {
            const items = (project.items && project.items[category.key]) || []
            if (items.length > 0) return { project: project.id, kind: category.key, id: items[0].id }
          }
        }
        return null
      }

      function scan(where, force, wantProject) {
        if (where === undefined || where === '') { setIndex(null); return }
        if (force !== true && indexes[where] !== undefined) {
          const cached = indexes[where]
          setIndex(cached)
          setFailure(null)
          const project = wantProject === undefined || wantProject === null ? null : (cached.projects || []).filter((p) => p.id === wantProject)[0]
          const first = project !== null && project !== undefined ? firstOfProject(project) : firstPick(cached)
          if (first !== null) open(first, where)
          return
        }
        setBusy(true)
        setFailure(null)
        host.call('atlas.scan', { root: where }).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('scan returned nothing'); return }
          setIndex(result)
          if (result.error !== undefined) { setFailure(result.error); return }
          const projects = result.projects || []
          if (projects.length === 0) {
            // 以前这里直接 setFailure —— 于是"刚开一个空目录"看起来像报错。空目录不是错误，
            // 是**还没开始**：给一张引导卡，让人在这里建出第一个项目。
            setFailure(null)
            setEmptyRoot(where)
            setNewId(String(where).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
            setScene(null)
            return
          }
          setEmptyRoot(null)
          setFailure(null)
          indexes[where] = result
          const project = wantProject === undefined || wantProject === null ? null : projects.filter((p) => p.id === wantProject)[0]
          const first = project !== null && project !== undefined ? firstOfProject(project) : firstPick(result)
          if (first !== null) open(first, where)
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      function commitRoot(next) {
        roots[sessionId] = next
        setRoot(next)
        setDraft('')
        setNotice(null)
        setSettings(null)
        scan(next, false, null)
      }

      function openNearby(rootPath, projectId) {
        roots[sessionId] = rootPath
        setRoot(rootPath)
        setNotice(null)
        scan(rootPath, false, projectId)
      }

      function runPicker(start, onPicked) {
        if (picking === true) return
        setPicking(true)
        setNotice('正在打开系统的目录选择器…（有的环境弹不出来；弹不出来就在下面的输入框里直接贴路径）')
        // 对话框这条路**可能永远不返回**：shell 服务跑在非交互窗口站上时，
        // FolderBrowserDialog 既不显示也不结束，按钮就永久停在"对话框已打开…"，
        // 用户看到的是"点了没反应、也没有报错"。给它一个上限，超时就把按钮放开、
        // 并把下一步说清楚（真要等下去的对话框，用户自己会再点一次）。
        const timer = setTimeout(() => {
          setPicking(false)
          setNotice('目录对话框 120 秒没有返回。这条路在你的环境里可能用不了 —— 请把路径直接贴进下面的输入框。')
        }, 120000)
        host.call('atlas.pickDirectory', { start: start })
          .then((result) => {
            clearTimeout(timer)
            setPicking(false)
            if (result === null || result === undefined) { setNotice('目录选择器没有返回结果。'); return }
            if (result.error !== undefined) { setNotice(String(result.error)); return }
            if (result.supported === false) {
              setNotice(String(result.detail || '这个环境没有可用的目录选择器，') + '请把路径直接贴进下面的输入框。')
              return
            }
            if (result.cancelled === true) { setNotice(null); return }
            if (typeof result.path === 'string' && result.path.length > 0) { setNotice(null); onPicked(result.path); return }
            setNotice('目录选择器没有返回路径。')
          })
          .catch((error) => {
            clearTimeout(timer)
            setPicking(false)
            setNotice('目录选择器失败：' + String(error && error.message ? error.message : error) +
              '　请把路径直接贴进下面的输入框。')
          })
      }

      function pickDirectory() {
        runPicker(root !== '' ? root : (nearby !== null ? nearby.cwd : ''), commitRoot)
      }

      // 把输入框里的路径写进设置。空字符串 = 取消参考目录，这是有意的：
      // "没设置就不参考外部资源" 是合法状态，不该逼着人一定选一个。
      function applyDirDraft() {
        const wanted = String(dirDraft).trim()
        patchSettings({ directory: wanted }, true)
      }

      function loadSettings() {
        const projectId = activeProjectId()
        if (projectId === null) return
        setSaveState(null)
        setModsOpen(false)
        setSettings({ loading: true })
        host.call('atlas.settings', { root: root, project: projectId }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setSettings({ error: result !== null && result !== undefined && result.error !== undefined ? result.error : '设置读取失败' })
            return
          }
          setSettings(Object.assign({ loading: false }, result))
        }).catch((error) => setSettings({ error: String(error && error.message ? error.message : error) }))
      }

      function openSettings() {
        if (settings !== null) { setSettings(null); return }
        loadSettings()
      }

      function saveSettings(next, rescan) {
        const modMap = {}
        for (const item of next.mods || []) modMap[item.name] = item.on === true
        setSaveState('保存中…')
        host.call('atlas.saveSettings', {
          root: root, project: next.project, directory: next.directory,
          includeGenerated: next.includeGenerated, includeMods: next.includeMods, mods: modMap,
        }).then((result) => {
          const failed = result !== null && result !== undefined && result.error !== undefined
          setSaveState(failed ? ('保存失败：' + result.error) : '已保存')
          if (failed) { setSavedSettings(null); return }
          // What the agent needs to hear, in one line.  The agent reads the same
          // file (`mc_art.project_settings`), so the sentence is a pointer, not a
          // copy: it says what changed and what to do with it.
          const on = (next.mods || []).filter((item) => item.on === true).length
          setSavedSettings({
            path: result.path === undefined ? '' : String(result.path),
            note: '参考目录改成了 ' + (next.directory === '' ? '（空）' : next.directory)
              + '；' + on + '/' + (next.mods || []).length + ' 个 mod 开着，'
              + (next.includeGenerated === false ? '不含' : '含') + '本项目自己的贴图。请按这个重做',
          })
          if (rescan === true) loadSettings()
        }).catch((error) => {
          setSavedSettings(null)
          setSaveState('保存失败：' + String(error && error.message ? error.message : error))
        })
      }

      function patchSettings(patch, rescan) {
        if (settings === null) return
        const next = Object.assign({}, settings, patch)
        setSettings(next)
        saveSettings(next, rescan)
      }

      function toggleMod(name, on) {
        if (settings === null) return
        const mods = (settings.mods || []).map((item) => (item.name === name ? Object.assign({}, item, { on: on }) : item))
        const next = Object.assign({}, settings, { mods: mods })
        setSettings(next)
        saveSettings(next)
      }

      React.useEffect(() => {
        if (root !== '') { scan(root, false, null); return }
        host.call('atlas.session', { sessionId: sessionId })
          .then((result) => {
            const cwd = result !== null && result !== undefined && typeof result.cwd === 'string' && result.cwd.length > 0 ? result.cwd : null
            if (cwd === null) return null
            setNearby({ cwd: cwd, loading: true, projects: [], error: null })
            return host.call('atlas.projects', { path: cwd })
          })
          .then((result) => {
            if (result === null || result === undefined) return
            if (result.error !== undefined) { setNearby({ cwd: result.base || '', loading: false, projects: [], error: result.error }); return }
            setNearby({ cwd: result.base, loading: false, projects: result.projects || [], error: null })
          })
          .catch((error) => setNearby({ cwd: '', loading: false, projects: [], error: String(error && error.message ? error.message : error) }))
      }, [])

      // 参考目录的手输框跟着**已保存的值**走：载入设置、或保存成功之后回到真实值。
      // 依赖是那个字符串本身（不是 settings 对象），所以人正在打字时不会被重置。
      React.useEffect(() => {
        if (settings === null) return
        setDirDraft(typeof settings.directory === 'string' ? settings.directory : '')
      }, [settings === null ? '' : String(settings.directory)])

      React.useEffect(() => {
        if (canvas === null) return
        const width = canvas.clientWidth || 340
        const height = canvas.clientHeight || 240
        if (width !== size[0] || height !== size[1]) setSize([width, height])
      })

      // The 2D stand-in follows the same clock as everything else: a clock keeps
      // ticking, a still sprite is drawn once.  It draws at the size it is shown
      // at, so the scaling is this code's (nearest neighbour) and not the
      // browser's.
      React.useEffect(() => {
        if (posterCanvas === null || posterRecipe === null) return
        const frames = (posterRecipe.frames || []).length
        const frame = frames > 1 ? Math.floor(animTicks / 2) % frames : 0
        drawItemIcon(posterCanvas, posterRecipe, frame, decoded)
      })

      // React attaches `onWheel` as a PASSIVE listener on its root container, so
      // preventDefault() inside it does nothing and the page zoomed instead of
      // the model.  The listener has to go on the element itself, non-passive.
      React.useEffect(() => {
        if (canvas === null) return
        function onWheel(event) {
          event.preventDefault()
          setZoom((previous) => Math.max(0.35, Math.min(3, previous * (event.deltaY > 0 ? 0.92 : 1.08))))
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [canvas])

      function zoomBy(factor) {
        setZoom((previous) => Math.max(0.35, Math.min(3, previous * factor)))
      }

      // Something on screen is animated: something has to keep asking for a new
      // picture.  The draw effect stops when its key is unchanged, so a timer
      // tick is what re-runs it, and the frame number is in that key.
      //
      // The timer exists ONLY while an animated texture is in view.  A still
      // scene must not hold a 20-a-second timer open forever.
      // The big item icon is a third thing that can move: `item/clock` is 64
      // model swaps and a mod's item sprite can be a texture strip.  A still
      // icon has nothing to redraw, so it must not hold the timer open either.
      function projectNamespaceOf(id) {
        const projects = index === null ? [] : (index.projects || [])
        const found = projects.filter((entry) => entry.id === id)[0]
        return found === undefined ? '' : found.namespace
      }

      // What the hotbar is showing: the same filtered list the browser shows
      // (same search, same 展示形式/细分 chips), nine slots at a time -- the game's
      // number.  `hudOn` is whichever asset is on screen, so it gets the game's
      // selected-slot frame, and the bar follows it to another page if it has to.
      const hudView = () => {
        const list = itemFiltered()
        const pages = Math.max(1, Math.ceil(list.length / HUD_SLOTS))
        const page = Math.min(Math.max(1, hudPage), pages)
        return { list: list.slice((page - 1) * HUD_SLOTS, page * HUD_SLOTS),
          page: page, pages: pages, total: list.length }
      }
      const hudOn = previewItem !== null ? previewItem.id
        : (choice !== null && choice.kind === 'block' ? choice.id : '')
      const hudPickedEntry = hudOn === '' ? undefined
        : itemFiltered().filter((entry) => entry.id === hudOn)[0]
      const hudPicked = previewItem !== null
        ? (hudPickedEntry === undefined ? previewItem.id : hudPickedEntry.name)
        : (hudPickedEntry !== undefined ? hudPickedEntry.name
          : (choice === null ? '' : (choice.title || choice.id)))
      // The held slot is always on screen, like the game: if the asset on view
      // sits on another page of the bar, the bar turns to it.
      //
      // ...but ONLY when the selection or the list changes.  This effect used to
      // depend on `hudPage` too, so pressing ‹ › re-ran it, it saw the selected
      // asset living on page 1, and it set the page straight back: the arrows
      // flashed and snapped home ("我按物品栏的左右箭头没用").  Following is keyed
      // on the pair (list, selection), which paging does not change.
      const hudKey = item === null ? '' : [item.source, item.namespace, item.filter,
        item.form, item.family].join('|')
      React.useEffect(() => {
        if (hudOn === '') return
        const token = hudKey + '#' + hudOn
        if (token === hudFollowed) return
        hudFollowed = token
        const at = itemFiltered().map((entry) => entry.id).indexOf(hudOn)
        if (at < 0) return
        const page = Math.floor(at / HUD_SLOTS) + 1
        if (page !== hudView().page) setHudPage(page)
      }, [hudKey, hudOn])
      const hudAnimated = item !== null && itemFiltered().some((entry) => {
        const recipe = itemRecipes[itemKey(item.namespace, entry.id)]
        return recipe !== undefined && recipe !== null
          && (((recipe.frames || []).length > 1) || Object.keys(recipe.animations || {}).length > 0)
      })
      const animating = (scene !== null && Object.keys(scene.animations || {}).length > 0)
        || (ghost !== null && Object.keys(ghost.animations || {}).length > 0)
        || hudAnimated
      React.useEffect(() => {
        if (!animating) return undefined
        // `timer.interval` returns its own disposer; the effect hands it back
        // as the cleanup so React owns the lifetime.
        const dispose = timer.interval(() => {
          animTicks += 1
          setTick((previous) => previous + 1)
        }, 50)
        return () => { if (typeof dispose === 'function') dispose() }
      }, [animating])

      // The bar has to have something in it the moment the panel opens, the way
      // the game always has your items in the hotbar -- so the project's own items
      // are loaded without being asked for.  It is the same single host call the
      // browser makes on its first click, and it happens once: `item` stops being
      // null as soon as the request is in flight, whether it succeeds or not.
      React.useEffect(() => {
        const ours = projectNamespaceOf(activeProjectId())
        if (ours === '') return
        if (item === null) { loadItems('project', ours, 1, '', '', ''); return }
        // A different project is open now, so the bar is showing the wrong pack's
        // items.  A REFERENCE list is a deliberate choice and is left alone.
        if (item.source === 'project' && item.namespace !== ours) loadItems('project', ours, 1, '', '', '')
      }, [index === null ? '' : (index.projects || []).map((project) => project.id).join(','),
        activeProjectId(), item === null ? '' : item.source + '|' + item.namespace])

      React.useEffect(() => {
        // The item grid reads these same decoded pixels, so this has to run for
        // the picker even with no model on screen -- otherwise every slot stays
        // blank: the picture is fetched, but nothing ever reads it back out.
        if (scene === null && item === null) return
        // The ghost brings its own textures, and they need decoding before the
        // overlay can draw them.
        const needed = idsOf(scene).slice()
        // What the MODEL is waiting for.  The icon textures below go into the
        // same decode list but must never hold the model back: a mod icon whose
        // texture is missing from the jar would freeze the 3D view entirely.
        const waiting = needed.slice()
        if (ghost !== null && Array.isArray(ghost.textureIds)) {
          for (const id of idsOf(ghost)) if (needed.indexOf(id) < 0) needed.push(id)
        }
        for (const recipe of iconRecipesInUse()) {
          for (const id of idsOf(recipe)) if (needed.indexOf(id) < 0) needed.push(id)
        }
        let changed = false
        if (scratch !== null) {
          for (const id of needed) {
            if (decoded[id] !== undefined || failedTex[id] === true) continue
            const node = imageNodes[id]
            if (node === undefined || node.complete !== true) continue
            changed = true
            if (!node.naturalWidth || !node.naturalHeight) { failedTex[id] = true; continue }
            // The scratch canvas starts at 256x256, and an animated strip is
            // TALL: water_still is 16x512, lava_still 16x320.  Drawing one onto
            // a 256-tall canvas cut it off at frame 16, so the animation played
            // a few frames and then went transparent -- and reading
            // naturalHeight rows back out of it returned blank pixels rather
            // than failing, so nothing said why.
            const neededWidth = Math.max(scratch.width, node.naturalWidth)
            const neededHeight = Math.max(scratch.height, node.naturalHeight)
            if (neededWidth !== scratch.width || neededHeight !== scratch.height) {
              scratch.width = neededWidth
              scratch.height = neededHeight
            }
            const paint = scratch.getContext('2d')
            paint.clearRect(0, 0, scratch.width, scratch.height)
            paint.drawImage(node, 0, 0)
            const frame = paint.getImageData(0, 0, node.naturalWidth, node.naturalHeight)
            decoded[id] = { width: frame.width, height: frame.height, data: frame.data }
          }
        }
        if (changed) { setTick(tick + 1); return }
        // No model on screen: nothing to rasterise.  But the canvas must be
        // CLEARED, not left alone -- leaving it alone keeps the last model
        // painted there, and since rotating and zooming only re-run this effect,
        // the whole 3D view then looks frozen ("点了血晶之后 3D 卡住了" -- an
        // item-only asset like a material has no block, so there is no scene to
        // draw, and the previous cube simply stayed on the screen).
        if (scene === null) {
          if (canvas === null) return
          const emptyKey = 'empty|' + size[0] + '|' + size[1] + '|' + canvasGeneration
          if (emptyKey === lastDrawKey) return
          lastDrawKey = emptyKey
          clearViewport(canvas, size[0], size[1])
          return
        }
        if (canvas === null) return
        for (const id of waiting) {
          if (decoded[id] === undefined && failedTex[id] !== true) return
        }
        const ghostKey = ghost === null ? '-' : (ghost.block + '@' + ghost.at.join(',') + ':' + ghost.quads.length)
        const hoverKey = voxel === null || hover === null ? '-' : (hover.cell + ':' + hover.face)
        // An animated texture has to be redrawn as time passes, so which frame
        // each one is on is part of "has the picture changed".  Keying on a
        // clock instead would redraw at the timer's rate even when the fastest
        // animation is five ticks long.
        const animations = Object.assign({}, scene.animations || {},
          ghost === null || ghost.animations === undefined ? {} : ghost.animations)
        const animTime = animTicks * 50
        const animKey = Object.keys(animations).sort()
          .map((id) => id + ':' + animationRow(animations[id], animTime)).join(',')
        const key = [scene.kind, scene.id, scene.quads.length, size[0], size[1], canvasGeneration,
          yaw.toFixed(4), pitch.toFixed(4), zoom.toFixed(4), ghostKey, hoverKey, animKey].join('|')
        if (key === lastDrawKey) return
        lastDrawKey = key
        const box = scene.box || { min: [-1, -1, -1], max: [1, 1, 1] }
        const camera = orbitCamera(box, yaw, pitch, zoom, size[0], size[1], Math.PI / 4)
        lastCamera = camera
        const buffer = new Int32Array(size[0] * size[1])
        buffer.fill(-1)
        const colourBuf = new Float64Array(size[0] * size[1] * 4)
        const depthBuf = new Float64Array(size[0] * size[1])
        const pass = { width: size[0], height: size[1], background: [26, 24, 28], camera: camera,
          colour: colourBuf, depth: depthBuf, textures: decoded, animations: animations, timeMs: animTime }
        const bytes = renderScene(Object.assign({ quads: scene.quads, pick: buffer }, pass))
        pickBuffer = buffer
        if (voxel !== null && hover !== null) {
          // Highlight what a left click would break, then show what a right
          // click would place.  Both go through the same depth buffer, so they
          // stay behind whatever is in front of them.
          const marked = scene.quads.filter((quad) => quad.pick !== undefined && quad.pick !== null
            && quad.pick.cell === hover.cell)
          if (marked.length > 0) {
            renderScene(Object.assign({ quads: marked, overlay: 0.45, tint: TINT_REMOVE }, pass))
          }
          const ghostQuads = ghost === null || !Array.isArray(ghost.quads) ? [] : ghost.quads
          const usable = ghostQuads.some((quad) => decoded[quad.tex] !== undefined)
          if (usable) {
            renderScene(Object.assign({ quads: ghostQuads, overlay: 0.5, tint: null }, pass))
          }
        }
        for (let i = 0; i < bytes.length; i++) {
          const value = Math.round(colourBuf[i] * 255)
          bytes[i] = value < 0 ? 0 : (value > 255 ? 255 : value)
        }
        canvas.width = size[0]
        canvas.height = size[1]
        const paint = canvas.getContext('2d')
        const frame = paint.createImageData(size[0], size[1])
        frame.data.set(bytes)
        paint.putImageData(frame, 0, 0)
      })

      /** The icon recipes whose textures have to be decoded right now: the hotbar's
       *  nine and the browser's forty.  Without this the pictures are fetched but
       *  nothing ever reads the pixels back out, and every slot stays blank. */
      function iconRecipesInUse() {
        const out = []
        if (item === null) return out
        const seen = {}
        const add = (entry) => {
          const key = itemKey(item.namespace, entry.id)
          if (seen[key] === true) return
          const recipe = itemRecipes[key]
          if (recipe === undefined || recipe === null) return
          seen[key] = true
          out.push(recipe)
        }
        for (const entry of hudView().list) add(entry)
        for (const entry of itemView().list) add(entry)
        return out
      }

      // One host call per page, because a single item spends almost all of its
      // time opening every jar -- forty separate processes would make the picker
      // unusable, and a page is where the icons are visible anyway.
      React.useEffect(() => {
        if (item === null || item.facts.length === 0) return
        ensureItemPage()
      }, [item === null ? '' : [item.namespace, item.page, hudPage, item.filter, item.form,
        item.family, item.facts.length].join('|')])

      // The grid's thumbnails.  A recipe arrives before its pixels do, so a slot
      // whose textures are still decoding waits for the next tick instead of
      // being baked once as an empty square and cached forever.
      React.useEffect(() => {
        if (item === null) return
        let added = 0
        for (const entry of itemView().list) {
          const key = itemKey(item.namespace, entry.id)
          if (itemUrls[key] !== undefined) continue
          const recipe = itemRecipes[key]
          if (recipe === undefined || recipe === null || recipe.shape === 'none') continue
          let ready = true
          for (const id of idsOf(recipe)) {
            if (decoded[id] === undefined && failedTex[id] !== true) { ready = false; break }
          }
          if (!ready) continue
          const url = itemIconUrl(recipe, decoded, 32)
          if (url === null) continue
          itemUrls[key] = url
          added += 1
        }
        if (added > 0) setIconTick(iconTick + 1)
      })

      // The hotbar's slots are canvases, not background images: the recipe for
      // the page is already here, and an animated icon has to follow the same
      // 50 ms clock the model does, so this runs every render like the model's.
      React.useEffect(() => {
        if (item === null) return
        for (const entry of hudView().list) {
          const key = itemKey(item.namespace, entry.id)
          const canvas = hudCanvases[key]
          if (canvas === undefined || canvas === null) continue
          const recipe = itemRecipes[key]
          const frames = recipe === undefined || recipe === null ? 0 : (recipe.frames || []).length
          const frame = frames > 1 ? Math.floor(animTicks / 2) % frames : 0
          drawItemIcon(canvas, recipe, frame, decoded)
        }
      })

      /** One slot's title, and the one line the bar shows when the icon on screen
       *  is not the icon the game would draw.  A model that resolves to geometry
       *  with no `display.gui` is drawn flat-on and split down the middle in the
       *  game too -- the fix is in the pack, so say where. */
      function slotNote(recipe) {
        if (recipe === undefined || recipe === null) return null
        if (recipe.shape === 'none') {
          return '这个物品是代码画的，没有可用的图标模型'
            + (recipe.error ? ' —— ' + String(recipe.error) : '')
        }
        if (recipe.shape === 'iso' && (recipe.display === null || recipe.display === undefined)) {
          return '物品模型指向几何模型，模型链里没有 display.gui：游戏里物品栏也是这样画的。'
            + '把它改成 item/generated（layer0 指向那张贴图）就有正常的平面图标了'
        }
        const absent = (recipe.missingModels || []).filter((name) => String(name).indexOf('内置:') !== 0)
        if (absent.length > 0) return '模型链缺 ' + absent.join('、')
        return null
      }

      /** The facts that do not need a picture, for a slot's tooltip. */
      function slotFacts(recipe) {
        if (recipe === undefined || recipe === null) return '还没取到这个物品的图标'
        const parts = [recipe.shape === 'iso' ? '等距' : '平铺']
        if (recipe.display !== null && recipe.display !== undefined) {
          parts.push('display.gui ' + JSON.stringify(recipe.display.rotation))
        }
        const absent = []
        const builtin = []
        for (const name of (recipe.missingModels || [])) {
          if (String(name).indexOf('内置:') === 0) builtin.push(String(name).slice(3))
          else absent.push(String(name))
        }
        if (absent.length > 0) parts.push('模型链缺 ' + absent.join('、'))
        // Saying so matters: a built-in base is not the game's own file, and the
        // fix (set a reference directory) is one click away in ⚙.
        if (builtin.length > 0) {
          parts.push('原版母模型用了内置的 ' + builtin.join('、') + '（设了参考目录就从游戏里读）')
        }
        return parts.join(' · ')
      }

      function blockChoices() {
        const out = []
        const seen = {}
        const add = (name, title) => {
          if (typeof name !== 'string' || name === '' || seen[name] === true) return
          seen[name] = true
          out.push({ name: name, title: title || name })
        }
        // Every project under the same root, not just the open one.  The
        // renderer could already resolve one project's blocks from another's -- only this
        // list refused to offer them, which read as the two being isolated.
        const projects = index === null ? [] : (index.projects || [])
        const current = activeProjectId()
        const currentProject = projects.filter((item) => item.id === current)[0]
        const fallback = currentProject === undefined ? '' : currentProject.namespace
        const titleOf = {}
        for (const project of projects) {
          const named = project.id === current
          for (const item of ((project.items && project.items.block) || [])) {
            const qualified = project.namespace + ':' + item.id
            titleOf[qualified] = named ? item.title : (project.title + ' · ' + item.title)
            add(qualified, titleOf[qualified])
          }
        }
        // A cell may name a block without a namespace -- a project's atlas does
        // -- and the id then has no Chinese name, so the hotbar showed a bare
        // `blood_sac`.  Qualify it against the open project, exactly like the
        // cell renderer does, then look the name up again.
        for (const cell of (scene !== null && Array.isArray(scene.cells) ? scene.cells : [])) {
          const raw = String(cell.block)
          const qualified = raw.indexOf(':') >= 0 || fallback === '' ? raw : (fallback + ':' + raw)
          add(qualified, titleOf[qualified] || qualified)
        }
        return out
      }

      function openVoxel() {
        if (scene === null || !Array.isArray(scene.cells)) {
          setEditMsg('这个资产没有可编辑的格子')
          return
        }
        const choices = blockChoices()
        loadRefSources()
        resetPick()
        painting.active = false
        setHover(null)
        setGhost(null)
        setEdit(null)
        setFilter('')
        setVoxel({
          kind: scene.kind, id: scene.id, title: scene.title || scene.id,
          // The 朝向 each cell was placed in has to survive being opened and
          // saved again; dropping it here would silently straighten every log
          // in the structure the first time somebody touched it.
          cells: scene.cells.map((cell) => {
            const kept = { block: cell.block, at: [cell.at[0], cell.at[1], cell.at[2]] }
            if (typeof cell.variant === 'string' && cell.variant !== '') kept.variant = cell.variant
            return kept
          }),
          block: choices.length > 0 ? choices[0].name : '', choices: choices,
          source: 'project', variants: [], axes: [], defaults: {}, flip: false, overrides: {}, manual: false,
          undo: [], busy: false, msg: null,
        })
      }

      // Which namespaces the reference can offer (vanilla, plus every mod).  The
      // block list itself is only fetched when one is actually chosen: AoA3 alone
      // is 1400 blocks, and nobody wants that loaded to look at a wood log.
      function loadRefSources() {
        setRefSources([])
        host.call('atlas.refNamespaces', { root: root, project: activeProjectId() })
          .then((result) => {
            if (result === null || result === undefined || result.error !== undefined) return
            setRefSources(result.namespaces || [])
          }).catch(() => { /* decoration: an empty picker is not fatal */ })
      }

      // ---- the item picker -------------------------------------------------
      //
      // Items live in the REFERENCE (vanilla and the mods), not in the project's
      // atlas, so this is its own little browser: pick a namespace, then filter
      // by PRESENTATION FORM (方块/工具/盔甲/刷怪蛋/物品) and by id family.
      // A page's icons are fetched in ONE host call -- one extractor process --
      // because a single item spends almost all of its time opening every jar.
      function itemKey(namespace, id) { return namespace + ':' + id }

      // `source` is 'project' (our own pack, plus the game root so its models can
      // reach the vanilla parents they inherit) or 'reference' (the game/mods).
      function loadItems(source, namespace, page, filter, form, family) {
        setItem({ source: source, namespace: namespace, facts: [],
          page: page === undefined ? 1 : page,
          filter: filter === undefined ? '' : filter, form: form === undefined ? '' : form,
          family: family === undefined ? '' : family, busy: true, msg: null,
          choices: item === null || item.choices === undefined ? [] : item.choices })
        host.call('atlas.refItems', { root: root, project: activeProjectId(),
          source: source, namespace: namespace })
          .then((result) => {
            const failed = failureOf(result)
            if (failed !== null) {
              setItem((previous) => Object.assign({}, previous, { busy: false,
                msg: '取不到物品：' + failed }))
              return
            }
            const facts = (result.items || []).filter((entry) => entry.parentOnly !== true)
            setItem((previous) => Object.assign({}, previous, { busy: false, facts: facts,
              version: result.version,
              msg: facts.length + ' 个物品' + (result.version === undefined ? '' : ' · ' + result.version) }))
          }).catch((error) => {
            setItem((previous) => Object.assign({}, previous, { busy: false,
              msg: '取不到物品：' + String(error && error.message ? error.message : error) }))
          })
      }

      function openItems() {
        if (itemOpen) { setItemOpen(false); return }
        setItemOpen(true)
        loadRefSources()
        setIconPick(null)
        // The bar already loaded the list, so this is only for the first click on
        // a project with no items, or after a failed attempt.
        const ours = projectNamespaceOf(activeProjectId())
        const stale = item === null || item.facts.length === 0
          || (item.source === 'project' && ours !== '' && item.namespace !== ours)
        if (!stale) return
        if (ours !== '') { loadItems('project', ours, 1, '', '', ''); return }
        const namespace = refSources.length > 0 ? refSources[0].name : 'minecraft'
        loadItems('reference', namespace, 1, '', '', '')
      }

      /** The search needle.  One place, because the chips and the list have to
       *  agree about when a search is on: a chip row whose numbers do not match
       *  what clicking it shows is worse than no chip row. */
      function itemSearch() {
        return item === null ? '' : String(item.filter).trim().toLowerCase()
      }

      /** The filtered list, unpaged.  The browser's 40-slot page and the hotbar's
       *  nine-slot page slice THIS, so a search or a chip narrows both at once
       *  instead of the two rows disagreeing about what is on screen. */
      function itemFiltered() {
        if (item === null) return []
        const needle = itemSearch()
        if (needle !== '') return item.facts.filter((entry) => String(entry.name).toLowerCase().indexOf(needle) >= 0
          || String(entry.id).toLowerCase().indexOf(needle) >= 0)
        return item.facts.filter((entry) => (item.form === '' || entry.form === item.form)
          && (item.family === '' || entry.family === item.family))
      }

      function itemView() {
        const list = itemFiltered()
        const total = list.length
        const pages = Math.max(1, Math.ceil(total / ITEM_PAGE))
        const page = Math.min(Math.max(1, item.page), pages)
        return { list: list.slice((page - 1) * ITEM_PAGE, page * ITEM_PAGE), page: page, pages: pages, total: total }
      }

      function ensureItemPage() {
        if (item === null) return
        const missing = []
        const want = (list) => {
          for (const entry of list) {
            const key = itemKey(item.namespace, entry.id)
            if (itemRecipes[key] === undefined && missing.indexOf(entry.id) < 0) missing.push(entry.id)
          }
        }
        // Both pages in ONE host call: the hotbar's nine are usually a subset of
        // the browser's forty, and a second process for the remainder would cost
        // another full jar scan for nothing.
        want(itemView().list)
        want(hudView().list)
        if (missing.length === 0) return
        host.call('atlas.itemIcons', { root: root, project: activeProjectId(),
          source: item.source, namespace: item.namespace, items: missing }).then((result) => {
          if (failureOf(result) !== null) return
          let added = 0
          for (const id of Object.keys(result.items || {})) {
            const recipe = result.items[id]
            const key = itemKey(item.namespace, id)
            if (itemRecipes[key] !== undefined) continue
            itemRecipes[key] = recipe
            added += 1
          }
          if (added > 0) setIconTick(iconTick + 1)
        }).catch(() => {  })
      }

      // Clicking a slot shows it: our own block goes through `open()` like any
      // other asset (so the 3D view and the inventory form both switch to it),
      // a reference block goes through the preview handler (it is not in this
      // project's index, so there is nothing to `open`).
      /** Does this project have a BLOCK by that id?  An item-only model (a
       *  sprite with no blockstate) has no 3D form and no scene to open. */
      function projectHasBlock(id) {
        const project = index === null ? null
          : (index.projects || []).filter((entry) => entry.id === activeProjectId())[0]
        if (project === null || project === undefined) return false
        return ((project.items && project.items.block) || []).some((entry) => entry.id === id)
      }

      function pickItem(entry) {
        const namespace = item === null ? '' : item.namespace
        setIconPick({ namespace: namespace, id: entry.id })
        if (item !== null && item.source === 'project') {
          if (!projectHasBlock(entry.id)) {
            // Only an icon: say so instead of opening a scene that cannot exist.
            // The editor's own state has to come down with the scene, exactly as
            // `open()` does it -- a voxel editor left pointing at a scene that is
            // no longer on screen is a card whose buttons act on nothing.
            setPreviewItem({ source: 'project', namespace: namespace, id: entry.id, localOnly: true })
            setScene(null)
            setVoxel(null)
            setHover(null)
            setGhost(null)
            setEdit(null)
            setFailure(null)
            return
          }
          setPreviewItem(null)
          open({ project: activeProjectId(), kind: 'block', id: entry.id }, root)
          return
        }
        openReferenceItem(entry)
      }

      function openReferenceItem(entry) {
        const reference = (item === null ? '' : item.namespace) + ':' + entry.id
        setPreviewItem({ source: 'reference', namespace: item === null ? '' : item.namespace, id: entry.id })
        host.call('atlas.preview', { root: root, project: activeProjectId(), block: reference,
          at: [0, 0, 0], variant: null, have: Object.keys(decoded) }).then((result) => {
          const failed = failureOf(result)
          if (failed !== null) {
            setItem((previous) => previous === null ? previous : Object.assign({}, previous,
              { msg: '3D 取不到：' + failed }))
            return
          }
          lastDrawKey = ''
          setFailure(null)
          setScene(sceneOf({ kind: 'block', id: reference, title: entry.name || entry.id,
            quads: result.quads, textureIds: idsOf(result), textures: result.textures,
            animations: result.animations, cells: null, palette: [], errors: [],
            box: boxOfQuads(arrayOf(result.quads)), preview: true }))
          setVoxel(null)
          setHover(null)
          setGhost(null)
        }).catch((error) => {
          setItem((previous) => previous === null ? previous : Object.assign({}, previous,
            { msg: '3D 取不到：' + String(error && error.message ? error.message : error) }))
        })
      }

      function pickSource(source) {
        if (voxel === null) return
        if (source === 'project') {
          const choices = blockChoices()
          setFilter('')
          resetPick()
          setVoxel(Object.assign({}, voxel, { source: 'project', choices: choices,
            block: choices.length > 0 ? choices[0].name : '' }))
          setGhost(null)
          return
        }
        const namespace = source.slice(4)
        setVoxel(Object.assign({}, voxel, { source: source, msg: '正在读取 ' + namespace + ' 的方块…' }))
        host.call('atlas.refBlocks', { root: root, project: activeProjectId(), namespace: namespace })
          .then((result) => {
            if (result === null || result === undefined || result.error !== undefined) {
              setVoxel(Object.assign({}, voxel, { msg: '取不到 ' + namespace + ' 的方块：'
                + String(result && result.error ? result.error : '没有返回结果') }))
              return
            }
            const choices = (result.blocks || []).map((item) => ({ name: namespace + ':' + item.id,
              title: item.name, group: item.group || '', groupLabel: item.groupLabel || '',
              family: item.family || '' }))
            if (choices.length === 0) {
              setVoxel(Object.assign({}, voxel, { msg: namespace + ' 里没有方块' }))
              return
            }
            setFilter('')
            resetPick()
            setVoxel(Object.assign({}, voxel, { source: source, choices: choices,
              block: choices[0].name, msg: '参考 ' + namespace + ' · ' + choices.length + ' 个方块' }))
            setGhost(null)
          }).catch((error) => {
            setVoxel(Object.assign({}, voxel, { msg: '取不到方块：' + String(error && error.message ? error.message : error) }))
          })
      }

      function searchMatch(item, needle) {
        return String(item.title).toLowerCase().indexOf(needle) >= 0
          || String(item.name).toLowerCase().indexOf(needle) >= 0
      }

      function groupOfItem(item) { return item.group || '' }
      function familyOfItem(item) { return item.family || '其他' }

      /** The category tallies, counted over whatever the other filter allows,
       *  so a number on a button is never bigger than what clicking it shows. */
      function countsBy(keyOf, within) {
        const counts = {}
        for (const item of (voxel === null ? [] : voxel.choices)) {
          if (within !== null && within(item) !== true) continue
          const value = keyOf(item) || ''
          counts[value] = (counts[value] || 0) + 1
        }
        return counts
      }

      /** Which page of which category is on screen. */
      function choiceView() {
        if (voxel === null) return { list: [], page: 1, pages: 1, total: 0 }
        const needle = String(filter).trim().toLowerCase()
        let list = voxel.choices
        if (needle !== '') {
          list = list.filter((item) => searchMatch(item, needle))
        } else if (pickGroup !== '' || pickFamily !== '') {
          list = list.filter((item) =>
            (pickGroup === '' || groupOfItem(item) === pickGroup)
            && (pickFamily === '' || familyOfItem(item) === pickFamily))
        }
        const total = list.length
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        const shownPage = Math.min(Math.max(1, pickPage), pages)
        return { list: list.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE),
          page: shownPage, pages: pages, total: total }
      }

      function resetPick() {
        setPickGroup('')
        setPickFamily('')
        setPickPage(1)
      }

      // Forget extracted blocks nothing holds any more -- the "delete the block,
      // drop the cache" half of the rule.
      function releaseRefs() {
        const keep = []
        for (const cell of (voxel === null ? [] : voxel.cells)) {
          const raw = String(cell.block)
          const colon = raw.indexOf(':')
          let qualified = null
          if (colon >= 0) qualified = raw
          else if (voxel !== null && voxel.source !== 'project') qualified = voxel.source.slice(4) + ':' + raw
          if (qualified === null) continue
          keep.push(qualified)
          // The host keys an extraction by `block@variant`, so a cell that was
          // placed with an orientation needs BOTH spellings kept.  Only the bare
          // name was ever sent, so every edit dropped and re-extracted those
          // blocks -- and their textures and animation descriptions with them.
          if (typeof cell.variant === 'string' && cell.variant !== '') {
            keep.push(qualified + '@' + cell.variant)
          }
        }
        if (voxel !== null && voxel.source !== 'project' && voxel.block !== '') {
          keep.push(voxel.block)
          // The ghost on screen was extracted under `block@variant` and that is
          // the key the host caches it under.  Only the bare name was sent, so
          // every hover and every edit dropped the extraction behind the picture
          // the user was looking at.
          if (ghost !== null && ghost.block === voxel.block
            && typeof ghost.variant === 'string' && ghost.variant !== '') {
            keep.push(voxel.block + '@' + ghost.variant)
          }
        }
        host.call('atlas.releaseRefs', { keep: keep }).catch(() => { /* cache only */ })
      }

      function voxelWith(cells, x, y, z, block, variant) {
        const out = cells.filter((cell) => !(cell.at[0] === x && cell.at[1] === y && cell.at[2] === z))
        if (block !== null && block !== '') {
          const cell = { block: block, at: [x, y, z] }
          // The 朝向 is part of what was placed, not a view setting: a log lying
          // along X and one standing upright are different blocks in the wall.
          // It was decided by the face that was clicked, and it is written down
          // so reopening the structure cannot straighten it.
          if (typeof variant === 'string' && variant !== '') cell.variant = variant
          out.push(cell)
        }
        return out
      }

      /** What is under the pointer: which cell, which face.  The pick buffer
       *  has already decided what is visible there, so this costs nothing. */
      function voxelTargetAt(event) {
        if (voxel === null || scene === null || canvas === null || pickBuffer === null) return null
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const px = Math.floor((event.clientX - rect.left) / rect.width * canvas.width)
        const py = Math.floor((event.clientY - rect.top) / rect.height * canvas.height)
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null
        const quadIndex = pickBuffer[py * canvas.width + px]
        if (quadIndex === undefined || quadIndex < 0) return null
        const quad = scene.quads[quadIndex]
        const pick = quad === undefined ? undefined : quad.pick
        if (pick === undefined || pick === null) return null
        const cell = (scene.cells || [])[pick.cell]
        if (cell === undefined) return null
        // How far up the face the pointer landed.  A slab's or a staircase's
        // top/bottom half is decided from exactly this in vanilla, and it is not
        // something to ask the user.
        const hitY = faceHitY(quad, px + 0.5, py + 0.5, lastCamera)
        return { cell: pick.cell, face: pick.face, at: cell.at, block: cell.block, hitY: hitY }
      }

      /** Where a placement would land: one step out along the face, unless that
       *  cell is already taken. */
      function placementAt(target) {
        if (target === null) return null
        const step = (scene === null ? {} : (scene.faceStep || {}))[target.face]
        if (step === undefined) return null
        const at = [target.at[0] + step[0], target.at[1] + step[1], target.at[2] + step[2]]
        const occupied = (voxel === null ? [] : voxel.cells).some((cell) =>
          cell.at[0] === at[0] && cell.at[1] === at[1] && cell.at[2] === at[2])
        return occupied ? null : at
      }

      // Icons for what is on screen.  Project blocks and extracted reference
      // blocks come from different halves of the host, so the source decides
      // which one is asked.  Both are decoration: a failure is not fatal.
      React.useEffect(() => {
        if (voxel === null) return
        const source = voxel.source === undefined ? 'project' : voxel.source
        const missing = []
        for (const item of choiceView().list) {
          if (icons[item.name] !== undefined || iconTried[item.name] === true) continue
          if (missing.indexOf(item.name) < 0) missing.push(item.name)
        }
        if (missing.length === 0) return
        const batch = missing.slice(0, ICON_BATCH)
        for (const name of batch) iconTried[name] = true
        let request
        if (source === 'project') {
          request = host.call('atlas.icons', { root: root, project: activeProjectId(), blocks: batch })
        } else {
          const namespace = String(source).slice(4)
          const ids = batch.filter((name) => name.indexOf(namespace + ':') === 0)
            .map((name) => name.slice(namespace.length + 1))
          if (ids.length === 0) return
          request = host.call('atlas.refIcons', { root: root, project: activeProjectId(),
            namespace: namespace, blocks: ids })
        }
        request.then((result) => {
          if (result === null || result === undefined || result.error !== undefined) return
          let added = 0
          for (const key of Object.keys(result.icons || {})) { icons[key] = result.icons[key]; added += 1 }
          if (added > 0) setIconTick(iconTick + 1)
        }).catch(() => { /* an icon is decoration */ })
      // The asset identity is part of the key: opening a DIFFERENT asset keeps
      // source/filter/page unchanged, so without this the effect never re-ran and
      // the new asset's blocks never got icons -- blank hotbar slots.
      }, [voxel === null ? '' : (voxel.source + '|' + voxel.kind + ':' + voxel.id + '|' + voxel.choices.length),
        filter, pickGroup, pickFamily, pickPage, iconTick])

      React.useEffect(() => {
        if (voxel === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        const target = hover === null ? null : placementAt(hover)
        if (target === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        // The orientation is derived HERE, from the face being hovered -- so the
        // ghost is what the click will actually place, not a preview of some
        // other setting.
        const face = hover === null || hover.face === undefined ? 'north' : hover.face
        const hitY = hover === null || hover.hitY === undefined ? 0.5 : hover.hitY
        const wantVariant = variantFor(voxel.axes, voxel.variants, voxel.defaults, face, hitY,
          voxel.flip === true, voxel.overrides)
        // What is around the hovered cell.  A wall dropped next to three existing
        // walls has to show the shape it will actually have, and the host cannot
        // know the structure -- only this side has `cells`.
        const around = aroundOf(voxel.cells, target)
        const wantKey = voxel.block + '|' + String(wantVariant) + '|' + target.join(',')
          + '|' + JSON.stringify(around)
        // Already showing this exact ghost (or already waiting for it)?  Then do
        // NOT ask again -- including after a failure, or a block with no model
        // would be re-requested on every render.
        if (ghost !== null && ghostAsk === wantKey) return
        ghostAsk = wantKey
        setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
          textureIds: [], loading: true })
        host.call('atlas.preview', {
          root: root, project: activeProjectId(), block: voxel.block, at: target,
          variant: wantVariant, have: Object.keys(decoded), around: around,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
              textureIds: [], error: String(result && result.error ? result.error : '没有返回结果') })
            return
          }
          setGhost(Object.assign({ loading: false }, result))
        }).catch((error) => {
          setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
            textureIds: [], error: String(error && error.message ? error.message : error) })
        })
      })

      // Which 朝向 a block offers is only knowable by extracting it, so ask for
      // the block at the origin whenever the brush changes.  The extraction is
      // cached in the host either way, so this doubles as warming the cache the
      // ghost is about to use.
      const variantKey = voxel === null ? '' : (voxel.source + '|' + voxel.block)
      React.useEffect(() => {
        if (voxel === null || voxel.block === '') return undefined
        let live = true
        host.call('atlas.preview', {
          root: root, project: activeProjectId(), block: voxel.block, at: [0, 0, 0],
          variant: null, have: Object.keys(decoded),
        }).then((result) => {
          if (!live) return
          const keys = result === null || result === undefined || !Array.isArray(result.variants)
            ? [] : result.variants
          const axes = result === null || result === undefined || !Array.isArray(result.axes)
            ? [] : result.axes
          const defaults = result === null || result === undefined || typeof result.defaults !== 'object'
            || result.defaults === null ? {} : result.defaults
          setVoxel((previous) => {
            if (previous === null || previous.block !== voxel.block) return previous
            if ((previous.variants || []).join(',') === keys.join(',')
              && JSON.stringify(previous.axes || []) === JSON.stringify(axes)) return previous
            // A different block must not inherit the previous block's 朝向: the
            // key it named does not exist on the new one.
            return Object.assign({}, previous,
              { variants: keys, axes: axes, defaults: defaults, flip: false, overrides: {}, manual: false })
          })
        }).catch(() => { /* the list is a convenience, not a requirement */ })
        return () => { live = false }
      }, [variantKey])

      function refreshVoxel(state) {
        host.call('atlas.scene', {
          root: root, project: activeProjectId(), kind: state.kind, id: state.id,
          cells: state.cells, have: Object.keys(decoded),
          neighbours: state.neighbours !== false,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setVoxel(Object.assign({}, state, { busy: false,
              msg: '预览失败：' + String(result && result.error ? result.error : '没有返回结果') }))
            return
          }
          setVoxel(Object.assign({}, state, { busy: false }))
          // The draw guard keys on quad count, and swapping one block for
          // another keeps the count the same -- so it is invalidated by hand.
          lastDrawKey = ''
          setScene(sceneOf(result))
          releaseRefs()
        }).catch((error) => {
          setVoxel(Object.assign({}, state, { busy: false, msg: '预览失败：' + String(error && error.message ? error.message : error) }))
        })
      }

      function voxelApply(cells, note) {
        if (voxel === null) return
        const next = Object.assign({}, voxel, {
          cells: cells, busy: true, msg: note,
          undo: voxel.undo.concat([voxel.cells]).slice(-16),
        })
        setVoxel(next)
        refreshVoxel(next)
      }

      function voxelUndo() {
        if (voxel === null || voxel.undo.length === 0) return
        const next = Object.assign({}, voxel, {
          cells: voxel.undo[voxel.undo.length - 1],
          undo: voxel.undo.slice(0, voxel.undo.length - 1),
          msg: '撤销', busy: true,
        })
        setVoxel(next)
        refreshVoxel(next)
      }

      function voxelSave() {
        if (voxel === null || voxel.busy) return
        setVoxel(Object.assign({}, voxel, { busy: true, msg: '保存中…' }))
        host.call('atlas.saveVoxel', {
          root: root, project: activeProjectId(), kind: voxel.kind, id: voxel.id, cells: voxel.cells,
        }).then((result) => {
          if (result === null || result === undefined || result.error !== undefined) {
            setVoxel(Object.assign({}, voxel, { busy: false,
              msg: '保存失败：' + String(result && result.error ? result.error : '没有返回结果') }))
            return
          }
          delete indexes[root]
          setVoxel(Object.assign({}, voxel, { busy: false,
            msg: '已保存 ' + result.cells + ' 格 -> ' + String(result.file).split('/').pop() }))
        }).catch((error) => {
          setVoxel(Object.assign({}, voxel, { busy: false, msg: '保存失败：' + String(error && error.message ? error.message : error) }))
        })
      }

      function voxelClick(event, action) {
        if (voxel === null || scene === null || canvas === null || pickBuffer === null) return
        const target = voxelTargetAt(event)
        if (target === null) {
          setVoxel(Object.assign({}, voxel, { msg: '那里是空的，点方块上' }))
          return
        }
        const pick = { cell: target.cell, face: target.face }
        const cell = (scene.cells || [])[pick.cell]
        if (cell === undefined) {
          setVoxel(Object.assign({}, voxel, { msg: '格子索引对不上了，刷新一下' }))
          return
        }
        if (action === 'remove') {
          voxelApply(voxelWith(voxel.cells, cell.at[0], cell.at[1], cell.at[2], null, null), '挖掉 ' + cell.block)
          return
        }
        const step = (scene.faceStep || {})[pick.face]
        if (step === undefined) {
          setVoxel(Object.assign({}, voxel, { msg: '认不出这个面：' + String(pick.face) }))
          return
        }
        // Derived from the face that was clicked, at the moment it is clicked --
        // the same input the ghost was built from, so what lands is what was
        // shown.
        const placed = variantFor(voxel.axes, voxel.variants, voxel.defaults, pick.face,
          target.hitY === undefined ? 0.5 : target.hitY, voxel.flip === true, voxel.overrides)
        voxelApply(voxelWith(voxel.cells, cell.at[0] + step[0], cell.at[1] + step[1], cell.at[2] + step[2],
          voxel.block, placed), '放置 ' + voxel.block)
      }

      function voxelCard() {
        if (voxel === null) return null
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '搭建'),
          React.createElement('span', { className: 'mcart-sub' }, (voxel.title || '') + ' · ' + voxel.cells.length + ' 格')))
        rows.push(React.createElement('div', { className: 'mcart-src', key: 'filter' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '搜方块名或 id（共 ' + voxel.choices.length + ' 个）',
            value: filter, onChange: (event) => { setFilter(event.target.value); setPickPage(1) },
          }),
          filter === '' ? null : React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setFilter(''); setPickPage(1) } }, '清空')))

        // 墙/栅栏/玻璃板在原版里是看邻居决定画哪几段的，这份规则是从两版的字节码里
        // 读出来的（`tools/multipart_rules.md`）。默认按邻居推导；留一个开关，因为
        // 没有开关就没法分辨"规则错了"和"我记错了"。这个开关只改画法，不动格子。
        const derivedOn = voxel.neighbours !== false
        rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'neighbours' },
          React.createElement('span', { className: 'mcart-note' }, '连接'),
          React.createElement('button', {
            className: 'mcart-btn mcart-tool', type: 'button',
            'data-on': derivedOn ? '1' : '0',
            title: '墙/栅栏/玻璃板：原版按邻居决定画哪几段。关掉就是抽取器给的那份并集（全部画上），不是"算不出来"。',
            onClick: () => {
              const next = Object.assign({}, voxel, { neighbours: voxel.neighbours === false })
              setVoxel(next)
              refreshVoxel(next)
            },
          }, derivedOn ? '按邻居推导' : '全部画上')))

        // 朝向 comes from the placement, not from a menu.
        //
        // This used to print the blockstate's variant KEYS as buttons.  That is
        // fine for a furnace (four `facing=...`) and useless for anything with
        // two properties: a command block became twelve
        // `conditional=false,facing=down` labels and a staircase became FORTY.
        // Those are not forty choices, they are three questions, and the answer
        // to most of them is already implied by where you clicked.
        const axes = Array.isArray(voxel.axes) ? voxel.axes : []
        if (axes.length > 0) {
          const face = hover === null || hover.face === undefined ? null : hover.face
          const hitY = hover === null || hover.hitY === undefined ? 0.5 : hover.hitY
          const derived = face === null ? {} : deriveVariant(axes, face, hitY, voxel.flip === true)
          const summary = []
          summary.push(React.createElement('span', { className: 'mcart-note', key: '__what' },
            face === null
              ? '朝向由你点的那个面决定——悬停到方块上试试'
              : '点 ' + labelOfValue(face) + ' 面 → ' + variantSummary(axes, derived)))
          // Only the families whose `facing` convention the data cannot settle get
          // a flip.  An axis has no front, so a log never shows this.
          if (derived.facing !== undefined) {
            summary.push(React.createElement('button', {
              key: '__flip', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': voxel.flip === true ? '1' : '0',
              title: '熔炉这类是朝着你，楼梯/活板门那类正相反——盘上没写，只能你说了算',
              onClick: () => setVoxel(Object.assign({}, voxel, { flip: voxel.flip !== true })),
            }, '翻转 180°'))
          }
          if (Object.keys(voxel.overrides || {}).length > 0) {
            summary.push(React.createElement('button', {
              key: '__reset', type: 'button', className: 'mcart-btn mcart-tool',
              onClick: () => setVoxel(Object.assign({}, voxel, { overrides: {} })),
            }, '恢复自动'))
          }
          summary.push(React.createElement('button', {
            key: '__manual', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': voxel.manual === true ? '1' : '0',
            onClick: () => setVoxel(Object.assign({}, voxel, { manual: voxel.manual !== true })),
          }, voxel.manual === true ? '收起 ▴' : '手动 ▾'))
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'orientation' },
            React.createElement('span', { className: 'mcart-note' }, '朝向'), summary))

          // One row per PROPERTY, and each row asks a question a person can
          // answer.  `conditional` is not an orientation, so it gets its own name
          // instead of being read off a composite string.
          if (voxel.manual === true) {
            for (const axis of axes) {
              const picked = (voxel.overrides || {})[axis.name]
              const chips = [React.createElement('button', {
                key: '__auto', type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': picked === undefined ? '1' : '0',
                onClick: () => setVoxel(Object.assign({}, voxel,
                  { overrides: withoutKey(voxel.overrides, axis.name) })),
              }, '自动')]
              for (const value of axis.values) {
                chips.push(React.createElement('button', {
                  key: value, type: 'button', className: 'mcart-btn mcart-tool',
                  'data-on': picked === value ? '1' : '0',
                  onClick: () => setVoxel(Object.assign({}, voxel,
                    { overrides: withKey(voxel.overrides, axis.name, value) })),
                }, labelOfValue(value)))
              }
              rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'axis:' + axis.name },
                React.createElement('span', { className: 'mcart-note' }, labelOfAxis(axis.name)), chips))
            }
            if (axes.some((axis) => axis.name === 'shape')) {
              rows.push(React.createElement('div', { className: 'mcart-hint', key: 'shapenote' },
                '形状（内角/外角）在原版里是看邻居算出来的，这里还没做——默认给你 straight，不是不敢算就说算了。'))
            }
            rows.push(React.createElement('div', { className: 'mcart-hint', key: 'oriennote' },
              '不选就是自动。摆放时按你点的面和位置推导，幽灵预览里看到的就是要放上去的。'))
          }
        }

        // Categories come from the pack itself: a mod that files its models into
        // folders (AoA3: decoration/generation/functional) has stated them, and
        // the shape suffixes (_slab, _stairs, _ore) are the game's own.
        const needle = String(filter).trim().toLowerCase()
        if (needle === '') {
          const groupCounts = countsBy(groupOfItem, null)
          const groupKeys = Object.keys(groupCounts).filter((key) => key !== '').sort()
          if (groupKeys.length > 0) {
            const chips = [React.createElement('button', {
              key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': pickGroup === '' ? '1' : '0',
              onClick: () => { setPickGroup(''); setPickFamily(''); setPickPage(1) },
            }, '全部 ' + voxel.choices.length)]
            for (const key of groupKeys) {
              const label = (voxel.choices.filter((item) => groupOfItem(item) === key)[0] || {}).groupLabel || key
              chips.push(React.createElement('button', {
                key: key, type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': pickGroup === key ? '1' : '0',
                onClick: () => { setPickGroup(key); setPickFamily(''); setPickPage(1) },
              }, label + ' ' + groupCounts[key]))
            }
            rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'groups' },
              React.createElement('span', { className: 'mcart-note' }, '分类'), chips))
          }
          const familyCounts = countsBy(familyOfItem,
            pickGroup === '' ? null : (item) => groupOfItem(item) === pickGroup)
          const familyKeys = Object.keys(familyCounts).sort()
          if (familyKeys.length > 1) {
            const chips = [React.createElement('button', {
              key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': pickFamily === '' ? '1' : '0',
              onClick: () => { setPickFamily(''); setPickPage(1) },
            }, '全部 ' + Object.keys(familyCounts).reduce((sum, key) => sum + familyCounts[key], 0))]
            for (const key of familyKeys) {
              chips.push(React.createElement('button', {
                key: key, type: 'button', className: 'mcart-btn mcart-tool',
                'data-on': pickFamily === key ? '1' : '0',
                onClick: () => { setPickFamily(key); setPickPage(1) },
              }, key + ' ' + familyCounts[key]))
            }
            rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'families' },
              React.createElement('span', { className: 'mcart-note' }, '形状'), chips))
          }
        }

        const view = choiceView()
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'pager' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page <= 1,
            onClick: () => setPickPage(view.page - 1) }, '‹ 上一页'),
          React.createElement('span', { className: 'mcart-note' },
            '第 ' + view.page + ' / ' + view.pages + ' 页 · 共 ' + view.total + ' 个'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page >= view.pages,
            onClick: () => setPickPage(view.page + 1) }, '下一页 ›'),
          React.createElement('input', {
            className: 'mcart-input', type: 'number', min: 1, max: view.pages, value: view.page,
            style: { maxWidth: '66px' },
            onChange: (event) => setPickPage(Number(event.target.value) || 1),
          })))

        rows.push(React.createElement('div', { className: 'mcart-hotbar', key: 'hotbar' },
          view.list.map((item) => React.createElement('button', {
            key: item.name, type: 'button', className: 'mcart-slot',
            'data-on': item.name === voxel.block ? '1' : '0',
            title: item.title + '\n' + item.name,
            style: icons[item.name] === undefined ? {} : { backgroundImage: 'url(' + icons[item.name] + ')' },
            onClick: () => { setVoxel(Object.assign({}, voxel, { block: item.name })); setGhost(null) },
          }))))
        if (refSources.length > 0) {
          const options = [React.createElement('option', { key: 'project', value: 'project' }, '本项目')]
          for (const item of refSources) {
            options.push(React.createElement('option', { key: 'ref:' + item.name, value: 'ref:' + item.name },
              item.name + '（' + item.blocks + ' 个方块）'))
          }
          rows.push(React.createElement('div', { className: 'mcart-src', key: 'source' },
            React.createElement('span', { className: 'mcart-note' }, '方块来源'),
            React.createElement('select', {
              className: 'mcart-select',
              value: voxel.source === undefined ? 'project' : voxel.source,
              onChange: (event) => pickSource(event.target.value),
            }, options)))
        }
        const chosen = voxel.choices.filter((item) => item.name === voxel.block)[0]
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'chosen' },
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            '手持：' + (chosen === undefined ? voxel.block : chosen.title) + '（' + voxel.block + '）')))
        rows.push(React.createElement('div', { className: 'mcart-tools', key: 'tools' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: voxel.undo.length === 0 || voxel.busy,
            onClick: voxelUndo }, '撤销 ' + voxel.undo.length),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: voxel.busy,
            onClick: voxelSave }, voxel.busy ? '…' : '保存'),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setVoxel(null); setHover(null); setGhost(null); painting.active = false } }, '关闭')))
        rows.push(React.createElement('div', { className: 'mcart-hint', key: 'how' },
          '像原版一样：左键破坏，右键放置；拖动仍然是旋转。半透明的方块就是将要放上去的位置，红色高亮是要破坏的那一格。'))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, voxel.msg === null ? '' : String(voxel.msg))))
        if (ghost !== null && ghost.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'ghosterr' }, '预览拿不到：' + String(ghost.error)))
        }
        return React.createElement('div', { className: 'mcart-card', key: 'voxel' }, rows)
      }

      /** The 2D layer of the 3D view: the game's hotbar.  Nine slots, the asset on
       *  screen wearing the game's selected-slot frame, the item's name floating
       *  above the row, and empty slots padding the last page -- all of which is
       *  what the game's HUD looks like.  `asset` is the menu choice on screen and
       *  is used for one thing only: explaining an asset that is not an item. */
      /** The 2D layer of the 3D view: the game's hotbar.  Nine slots, the asset on
       *  screen wearing the game's selected-slot frame, the item's name floating
       *  above the row, and empty slots padding the last page -- all of which is
       *  what the game's HUD looks like.
       *
       *  NOTHING ELSE GOES IN HERE.  A warning line inside the overlay is not the
       *  game and not readable (the user said so, with a screenshot: "这些提示不
       *  应该放在这里").  The details live on each slot's tooltip and, when
       *  something is actually wrong, on the line under the canvas. */
      function hudBar() {
        const view = hudView()
        const slots = []
        for (const entry of view.list) {
          const key = itemKey(item.namespace, entry.id)
          const recipe = itemRecipes[key]
          const note = slotNote(recipe)
          slots.push(React.createElement('button', {
            key: key, type: 'button', className: 'mcart-hudslot',
            'data-on': hudOn === entry.id ? '1' : '0',
            title: entry.name + '（' + entry.id + '）'
              + (entry.formLabel ? '\n' + entry.formLabel : '')
              + '\n' + slotFacts(recipe) + (note === null ? '' : '\n' + note),
            onClick: () => pickItem(entry),
          }, React.createElement('canvas', {
            className: 'mcart-hudicon', width: 32, height: 32,
            ref: (node) => {
              if (node === null || node === undefined) delete hudCanvases[key]
              else hudCanvases[key] = node
            },
          })))
        }
        while (slots.length < HUD_SLOTS) {
          slots.push(React.createElement('span', { key: 'empty:' + slots.length,
            className: 'mcart-hudslot mcart-hudempty' }))
        }
        return React.createElement('div', { className: 'mcart-hud', key: 'hud' },
          hudPicked === '' ? null : React.createElement('div', { className: 'mcart-hudname' },
            hudPicked + (view.pages > 1 ? ' · ' + view.page + '/' + view.pages : '')),
          React.createElement('div', { className: 'mcart-hudbar' },
            view.pages > 1 ? React.createElement('button', { className: 'mcart-hudpage', type: 'button',
              disabled: view.page <= 1, title: '上一页物品',
              onClick: () => setHudPage(view.page - 1) }, '‹') : null,
            slots,
            view.pages > 1 ? React.createElement('button', { className: 'mcart-hudpage', type: 'button',
              disabled: view.page >= view.pages,
              title: '下一页物品（第 ' + view.page + ' / ' + view.pages + ' 页）',
              onClick: () => setHudPage(view.page + 1) }, '›') : null))
      }

      function itemCard() {
        if (item === null) return null
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '物品'),
          React.createElement('span', { className: 'mcart-sub' },
            item.source === 'project' ? '本项目' : item.namespace),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            '点一格就放到上面的 3D 里看'),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setItemOpen(false); setIconPick(null) } }, '收起')))
        // Our own pack first, because that is what this project makes.
        const options = []
        const ours = projectNamespaceOf(activeProjectId())
        if (ours !== '') {
          options.push(React.createElement('option', { key: 'project', value: 'project' },
            '本项目 ' + ours + '（' + (item.source === 'project' ? item.facts.length : '…') + '）'))
        }
        for (const entry of refSources) {
          options.push(React.createElement('option', { key: 'ref:' + entry.name, value: 'ref:' + entry.name },
            entry.name + '（' + entry.blocks + ' 个方块）'))
        }
        if (options.length === 0) {
          options.push(React.createElement('option', { key: item.namespace, value: 'ref:' + item.namespace },
            item.namespace))
        }
        rows.push(React.createElement('div', { className: 'mcart-src', key: 'source' },
          React.createElement('span', { className: 'mcart-note' }, '来源'),
          React.createElement('select', {
            className: 'mcart-select',
            value: item.source === 'project' ? 'project' : 'ref:' + item.namespace,
            onChange: (event) => {
              const value = String(event.target.value)
              setIconPick(null)
              setPreviewItem(null)
              if (value === 'project') loadItems('project', ours === '' ? 'minecraft' : ours, 1, '', '', '')
              else loadItems('reference', value.slice(4), 1, '', '', '')
            },
          }, options),
          React.createElement('input', {
            className: 'mcart-input', placeholder: '搜物品名或 id',
            value: item.filter,
            onChange: (event) => setItem(Object.assign({}, item, { filter: event.target.value, page: 1 })),
          })))

        const formCounts = countsOf(item.facts, (entry) => entry.form, (entry) => entry.formLabel || entry.form)
        const forms = Object.keys(formCounts).sort((a, b) => formCounts[b].count - formCounts[a].count)
        if (forms.length > 0 && itemSearch() === '') {
          const chips = [React.createElement('button', {
            key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': item.form === '' ? '1' : '0',
            onClick: () => setItem(Object.assign({}, item, { form: '', family: '', page: 1 })),
          }, '全部 ' + item.facts.length)]
          for (const key of forms) {
            chips.push(React.createElement('button', {
              key: key, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': item.form === key ? '1' : '0',
              onClick: () => setItem(Object.assign({}, item, { form: key, family: '', page: 1 })),
            }, formCounts[key].label + ' ' + formCounts[key].count))
          }
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'forms' },
            React.createElement('span', { className: 'mcart-note' }, '展示形式'), chips))
        }
        const within = item.form === '' ? item.facts
          : item.facts.filter((entry) => entry.form === item.form)
        const familyCounts = countsOf(within, (entry) => entry.family, (entry) => entry.family)
        const families = Object.keys(familyCounts).sort((a, b) => familyCounts[b].count - familyCounts[a].count)
        if (families.length > 1 && itemSearch() === '') {
          const chips = [React.createElement('button', {
            key: '__all', type: 'button', className: 'mcart-btn mcart-tool',
            'data-on': item.family === '' ? '1' : '0',
            onClick: () => setItem(Object.assign({}, item, { family: '', page: 1 })),
          }, '全部 ' + within.length)]
          for (const key of families) {
            chips.push(React.createElement('button', {
              key: key, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': item.family === key ? '1' : '0',
              onClick: () => setItem(Object.assign({}, item, { family: key, page: 1 })),
            }, key + ' ' + familyCounts[key].count))
          }
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'families' },
            React.createElement('span', { className: 'mcart-note' }, '细分'), chips))
        }

        const view = itemView()
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'pager' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page <= 1,
            onClick: () => setItem(Object.assign({}, item, { page: view.page - 1 })) }, '‹ 上一页'),
          React.createElement('span', { className: 'mcart-note' },
            '第 ' + view.page + ' / ' + view.pages + ' 页 · 共 ' + view.total + ' 个'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: view.page >= view.pages,
            onClick: () => setItem(Object.assign({}, item, { page: view.page + 1 })) }, '下一页 ›')))

        const slots = []
        for (const entry of view.list) {
          const key = itemKey(item.namespace, entry.id)
          const url = itemUrls[key]
          const recipe = itemRecipes[key]
          // A code-drawn item (a block entity: cake, backpack) has no sprite to
          // bake, and an empty square reads as "still loading".  Say so instead.
          const blank = recipe !== undefined && recipe !== null && recipe.shape === 'none'
          slots.push(React.createElement('button', {
            key: entry.id, type: 'button', className: 'mcart-slot',
            'data-on': iconPick !== null && iconPick.id === entry.id ? '1' : '0',
            title: entry.name + '\n' + entry.id + '\n' + (entry.formLabel || entry.form || '')
              + (blank ? '\n这个物品是代码画的，没有可用的图标模型' : ''),
            style: url === undefined || url === null ? {} : { backgroundImage: 'url(' + url + ')' },
            onClick: () => pickItem(entry),
          }, blank ? React.createElement('span', { className: 'mcart-slotq' }, '?') : null))
        }
        rows.push(React.createElement('div', { className: 'mcart-hotbar', key: 'slots' }, slots))

        // Clicking a slot shows it in the viewer (3D + its inventory form); this
        // line is only the name and the facts that do not need a picture.
        const picked = iconPick === null ? null
          : view.list.filter((entry) => entry.id === iconPick.id)[0]
        if (picked !== undefined && picked !== null) {
          const recipe = itemRecipes[itemKey(iconPick.namespace, iconPick.id)]
          const frames = recipe === undefined || recipe === null ? 0 : (recipe.frames || []).length
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'chosen' },
            React.createElement('span', { className: 'mcart-note mcart-grow' },
              picked.name + '（' + picked.id + '）· ' + (picked.formLabel || picked.form || '')
              + (frames > 1 ? ' · ' + frames + ' 帧（原版按 overrides 换模型）' : '')
              + (recipe !== undefined && recipe !== null && recipe.error ? ' · ' + String(recipe.error) : ''))))
        }
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, item.msg === null ? '' : String(item.msg))))
        return React.createElement('div', { className: 'mcart-card', key: 'items' }, rows)
      }

      function facesForScene() {
        const out = {}
        for (const quad of (scene === null ? [] : (scene.quads || []))) {
          if (quad.pick) continue
          if (typeof quad.tex !== 'string' || typeof quad.face !== 'string') continue
          if (out[quad.tex] === undefined) out[quad.tex] = []
          if (out[quad.tex].indexOf(quad.face) < 0) out[quad.tex].push(quad.face)
        }
        return out
      }

      /** The texture covering the most faces -- the side of a grass block, not
       *  its bottom.  Opening on the bottom and saying nothing is what made an
       *  edit to 草方块 show up as 泥土. */
      function widestTexture(ids, byTexture) {
        let best = 0
        for (let i = 1; i < ids.length; i++) {
          const here = (byTexture[ids[i]] || []).length
          const there = (byTexture[ids[best]] || []).length
          if (here > there) best = i
        }
        return best
      }

      function makeEdit(ids, index, facesByTexture) {
        const frame = decoded[ids[index]]
        const copy = new Uint8ClampedArray(frame.data)
        const byTexture = facesByTexture || {}
        return {
          ids: ids, index: index, w: frame.width, h: frame.height,
          pixels: copy, palette: paletteOf(copy, 32), tool: 'pencil', color: null,
          faces: byTexture[ids[index]] || [],
          facesByTexture: byTexture,
        }
      }

      /** The asset on screen when there is no scene: a selected ITEM.  A block
       *  brings `scene`; an item-only asset (a material like blood_crystal) has no
       *  scene at all, and everything below used to start with `if (scene === null)
       *  return` -- which is why "血晶这种物体" could not be edited or commented
       *  on.  The icon IS the asset, so the icon's textures are what to edit and
       *  the item's model is what to point at. */
      function itemAsset() {
        if (scene !== null || item === null || hudOn === '') return null
        return { namespace: item.namespace, id: hudOn, source: item.source,
          recipe: pickedRecipe, title: hudPicked === '' ? hudOn : hudPicked }
      }

      function openEditor() {
        const asset = itemAsset()
        if (scene === null && asset === null) return
        if (asset !== null) {
          // The item's own layers.  No faces: a flat sprite has no sides, so the
          // editor shows its "贴图" tab, and the pen writes the project file the
          // host resolved from the texture handle.
          setVoxel(null)
          const ids = asset.recipe === null ? []
            : idsOf(asset.recipe).filter((id) => decoded[id] !== undefined)
          if (ids.length === 0) {
            setEdit(null)
            setItemMsg(asset.title + ' 还没有解码成功的贴图，改不了')
            return
          }
          setItemMsg(null)
          setEditMsg(null)
          setUndo([])
          painting.active = false
          setEdit(makeEdit(ids, widestTexture(ids, {}), {}))
          return
        }
        if (scene.kind === 'biome' || scene.kind === 'structure') { openVoxel(); return }
        if (scene.kind !== 'block' && scene.kind !== 'entity') {
          setEditMsg('这个类型还不能改：' + String(scene.kind))
          return
        }
        setVoxel(null)
        const ids = idsOf(scene).filter((id) => decoded[id] !== undefined)
        if (ids.length === 0) {
          setEdit(null)
          setEditMsg('这个资产没有解码成功的贴图，改不了')
          return
        }
        setEditMsg(null)
        setUndo([])
        painting.active = false
        const byTexture = facesForScene()
        setEdit(makeEdit(ids, widestTexture(ids, byTexture), byTexture))
      }

      function closeEditor() {
        painting.active = false
        setEdit(null)
        setUndo([])
        setEditMsg(null)
      }

      function undoOnce() {
        if (edit === null || undo.length === 0) return
        const previous = undo[undo.length - 1]
        setUndo(undo.slice(0, undo.length - 1))
        setEdit(Object.assign({}, edit, { pixels: new Uint8ClampedArray(previous) }))
      }

      function pushUndo() {
        if (edit === null || edit.pixels === undefined) return
        const next = undo.concat([new Uint8ClampedArray(edit.pixels)])
        setUndo(next.length > EDIT_UNDO ? next.slice(next.length - EDIT_UNDO) : next)
      }

      function pixelAt(event, target) {
        return texturePoint(event.currentTarget.getBoundingClientRect(), target,
          event.clientX, event.clientY)
      }

      function applyTool(x, y, first) {
        if (edit === null || edit.pixels === undefined) return
        const w = edit.w, h = edit.h, pixels = edit.pixels
        if (x < 0 || y < 0 || x >= w || y >= h) return
        if (edit.tool === 'picker') {
          const picked = readPixel(pixels, w, x, y)
          setEdit(Object.assign({}, edit, { color: picked[3] === 0 ? null : picked }))
          return
        }
        if (first === true) pushUndo()
        if (edit.tool === 'fill') {
          const from = readPixel(pixels, w, x, y)
          const to = edit.color || [0, 0, 0, 255]
          if (!sameColour(from, to)) {
            const stack = [[x, y]]
            const visited = {}
            while (stack.length > 0) {
              const point = stack.pop()
              const cx = point[0], cy = point[1]
              if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue
              const key = cy * w + cx
              if (visited[key] === true) continue
              visited[key] = true
              if (!sameColour(readPixel(pixels, w, cx, cy), from)) continue
              writePixel(pixels, w, cx, cy, to)
              stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
            }
          }
        } else if (edit.tool === 'eraser') {
          writePixel(pixels, w, x, y, [0, 0, 0, 0])
        } else {
          writePixel(pixels, w, x, y, edit.color || [0, 0, 0, 255])
        }
        setEdit(Object.assign({}, edit))
      }

      function saveEdit() {
        if (edit === null || edit.pixels === undefined || editBusy) return
        if (editScratch === null) { setEditMsg('画布还没准备好'); return }
        setEditBusy(true)
        setEditMsg(null)
        // The engine has no binary write, so the pixels leave as an encoded PNG
        // and the host lands the bytes.  The renderer reads `decoded`, so
        // publishing the edit there is what makes the 3D view show it -- with no
        // round trip and no chance of a stale data URL winning.
        editScratch.width = edit.w
        editScratch.height = edit.h
        const paint = editScratch.getContext('2d')
        const frame = paint.createImageData(edit.w, edit.h)
        frame.data.set(edit.pixels)
        paint.putImageData(frame, 0, 0)
        const url = editScratch.toDataURL('image/png')
        const base64 = url.slice(url.indexOf(',') + 1)
        host.call('atlas.saveTexture', {
          root: root, project: activeProjectId(), path: edit.ids[edit.index], base64: base64,
        }).then((result) => {
          setEditBusy(false)
          if (result === null || result === undefined || result.error !== undefined) {
            setEditMsg('保存失败：' + String(result && result.error ? result.error : '没有返回结果'))
            return
          }
          const target = edit.ids[edit.index]
          decoded[target] = { width: edit.w, height: edit.h, data: edit.pixels }
          delete failedTex[target]
          lastDrawKey = ''
          setEdit(Object.assign({}, edit, { palette: paletteOf(edit.pixels, 32) }))
          setEditMsg('已保存 ' + target.split('/').pop() + '（' + result.bytes + ' 字节）')
          setEditTick(editTick + 1)
        }).catch((error) => {
          setEditBusy(false)
          setEditMsg('保存失败：' + String(error && error.message ? error.message : error))
        })
      }

      function editorCard() {
        if (edit === null && editMsg === null) return null
        const rows = []
        if (edit === null) {
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'lost' },
            React.createElement('span', { className: 'mcart-bad mcart-grow' }, String(editMsg)),
            React.createElement('button', { className: 'mcart-btn', type: 'button',
              onClick: () => setEditMsg(null) }, '知道了')))
          return React.createElement('div', { className: 'mcart-card', key: 'editor' }, rows)
        }
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '改贴图'),
          React.createElement('span', { className: 'mcart-sub' },
            faceLabel(edit.faces) + ' · ' + edit.w + '×' + edit.h)))
        if (edit.ids.length > 1) {
          rows.push(React.createElement('div', { className: 'mcart-tabs', key: 'tabs' },
            edit.ids.map((id, index) => React.createElement('button', {
              key: id, type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': index === edit.index ? '1' : '0',
              onClick: () => {
                setUndo([]); setEditMsg(null); painting.active = false
                setEdit(makeEdit(edit.ids, index, edit.facesByTexture))
              },
            }, faceLabel((edit.facesByTexture || {})[id]) + ' · ' + id.split('/').pop().replace(/\.png$/, '')))))
        }
        rows.push(React.createElement('div', { className: 'mcart-tools', key: 'tools' },
          [['pencil', '铅笔'], ['eraser', '橡皮'], ['fill', '油漆桶'], ['picker', '吸管']].map((pair) =>
            React.createElement('button', {
              key: pair[0], type: 'button', className: 'mcart-btn mcart-tool',
              'data-on': edit.tool === pair[0] ? '1' : '0',
              onClick: () => setEdit(Object.assign({}, edit, { tool: pair[0] })),
            }, pair[1])),
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: undo.length === 0,
            onClick: undoOnce }, '撤销')))
        const current = edit.color || [0, 0, 0, 255]
        const inPalette = edit.palette.some((c) => sameColour(c, current))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'current' },
          React.createElement('input', {
            type: 'color', className: 'mcart-picker', value: hexOf(current),
            title: '取色板以外随便挑',
            // Only the current colour follows the picker.  Dragging it fires
            // this on every step, and appending here used to add one swatch per
            // intermediate colour until the panel was full of them.
            onChange: (event) => setEdit(Object.assign({}, edit,
              { color: fromHex(event.target.value, current[3]) })),
          }),
          React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: inPalette,
            title: '把当前颜色加进色板',
            onClick: () => setEdit(Object.assign({}, edit,
              { palette: addToPalette(edit.palette, current, EDIT_PALETTE) })),
          }, inPalette ? '已在色板' : '＋ 色板'),
          React.createElement('input', {
            type: 'range', className: 'mcart-alpha', min: 0, max: 255, value: current[3],
            onChange: (event) => setEdit(Object.assign({}, edit,
              { color: [current[0], current[1], current[2], Number(event.target.value)] })),
          }),
          React.createElement('span', { className: 'mcart-note' }, hexOf(current)),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            '不透明度 ' + current[3] + ' · 撤销 ' + undo.length)))
        rows.push(React.createElement('div', { className: 'mcart-swatches', key: 'swatches' },
          edit.palette.map((colour) => React.createElement('button', {
            key: colour.join(','), type: 'button', className: 'mcart-swatch',
            style: { background: cssColour(colour) }, title: cssColour(colour),
            onClick: () => setEdit(Object.assign({}, edit, { color: colour })),
          }))))
        rows.push(React.createElement('canvas', {
          key: 'canvas', className: 'mcart-edit-canvas',
          ref: (node) => setEditCanvas(node),
          onPointerDown: (event) => {
            const point = pixelAt(event, edit)
            if (point === null) return
            painting.active = true
            if (event.currentTarget.setPointerCapture) {
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
            }
            applyTool(point[0], point[1], true)
          },
          onPointerMove: (event) => {
            if (!painting.active) return
            const point = pixelAt(event, edit)
            if (point !== null) applyTool(point[0], point[1], false)
          },
          onPointerUp: () => { painting.active = false },
          onPointerLeave: () => { painting.active = false },
        }))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'foot' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: editBusy,
            onClick: saveEdit }, editBusy ? '保存中…' : '保存'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: closeEditor }, '关闭'),
          React.createElement('span', { className: 'mcart-note mcart-grow' },
            (edit.ids[edit.index] || '').split('/').pop())))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'msg' },
          React.createElement('span', { className: 'mcart-note mcart-grow' }, editMsg === null ? '' : String(editMsg))))
        return React.createElement('div', { className: 'mcart-card', key: 'editor' }, rows)
      }

      React.useEffect(() => {
        if (edit === null || edit.pixels === undefined) return
        if (editCanvas === null || editScratch === null) return
        editScratch.width = edit.w
        editScratch.height = edit.h
        const source = editScratch.getContext('2d')
        const frame = source.createImageData(edit.w, edit.h)
        frame.data.set(edit.pixels)
        source.putImageData(frame, 0, 0)
        const zoom = Math.max(2, Math.min(EDIT_ZOOM, 320 / Math.max(edit.w, edit.h)))
        editCanvas.width = edit.w * zoom
        editCanvas.height = edit.h * zoom
        const view = editCanvas.getContext('2d')
        view.imageSmoothingEnabled = false
        view.clearRect(0, 0, editCanvas.width, editCanvas.height)
        view.drawImage(editScratch, 0, 0, editCanvas.width, editCanvas.height)
        view.strokeStyle = 'rgba(127,127,127,.30)'
        view.lineWidth = 1
        for (let x = 0; x <= edit.w; x++) {
          view.beginPath(); view.moveTo(x * zoom + 0.5, 0); view.lineTo(x * zoom + 0.5, editCanvas.height); view.stroke()
        }
        for (let y = 0; y <= edit.h; y++) {
          view.beginPath(); view.moveTo(0, y * zoom + 0.5); view.lineTo(editCanvas.width, y * zoom + 0.5); view.stroke()
        }
      })

      function complain() {
        if (scene !== null) {
          setPending({ path: scene.ref || '', title: scene.title || '' })
          return
        }
        const asset = itemAsset()
        if (asset === null) return
        const path = asset.recipe === null || asset.recipe.modelPath === undefined
          ? '' : String(asset.recipe.modelPath)
        if (path === '') {
          // A reference item lives inside a jar: there is no file to point at, and
          // a button that silently does nothing is worse than one that says so.
          setItemMsg(asset.title + ' 在参考的 jar 里，没有可以引用的文件')
          return
        }
        setItemMsg(null)
        setPending({ path: path, title: asset.title })
      }

      function settingsCard() {
        if (settings === null) return null
        const rows = []
        if (settings.loading === true) {
          rows.push(React.createElement('div', { className: 'mcart-note', key: 'l' }, '读取设置…'))
        } else if (settings.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'e' }, String(settings.error)))
        } else {
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
            React.createElement('span', { className: 'mcart-title' }, '设置'),
            React.createElement('span', { className: 'mcart-sub' }, settings.title || settings.project || ''),
          ))
          rows.push(React.createElement('div', { className: 'mcart-note', key: 'reflabel' }, '参考目录'))
          rows.push(React.createElement('div', { className: 'mcart-path', key: 'refpath' }, settings.directory || '（未设置）'))
          const dirButtons = [
            React.createElement('button', { className: 'mcart-btn', type: 'button', key: 'pick', disabled: picking,
              onClick: () => runPicker(settings.directory || root, (picked) => patchSettings({ directory: picked }, true)) },
              picking ? '对话框已打开…' : '选择目录…'),
          ]
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'dirbuttons' }, dirButtons))
          // 手输/粘贴这条路是**必须**有的：系统目录对话框在某些环境里弹不出来
          // （shell 服务跑在非交互窗口站上时，FolderBrowserDialog 既不显示也不返回），
          // 而 fs 服务通常是好的 —— 那就让人把路径贴进来。
          // 以前这里只有一个"选择目录…"按钮，于是"点了没反应"就真的没有下一步了。
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'dirinput' },
            React.createElement('input', {
              className: 'mcart-input mcart-grow', type: 'text',
              placeholder: '参考目录路径，例如 C:\\Users\\你\\AppData\\Roaming\\.minecraft',
              value: dirDraft,
              onChange: (event) => setDirDraft(String(event.target.value)),
              onKeyDown: (event) => { if (event.key === 'Enter') applyDirDraft() },
            }),
            React.createElement('button', { className: 'mcart-btn', type: 'button',
              disabled: dirDraft.trim() === '', onClick: () => applyDirDraft() }, '用这个路径'),
          ))
          rows.push(React.createElement('div', { className: 'mcart-hint', key: 'dirhint' },
            '对话框弹不出来时可以在这里贴路径（.minecraft、版本目录、mods 目录，或单个 jar 都行）。'))
          if (settings.directory !== '' && settings.directory !== undefined) {
            if (settings.scanError !== null && settings.scanError !== undefined) {
              rows.push(React.createElement('div', { className: 'mcart-err', key: 'scanerr' }, '没读到里面的资源：' + String(settings.scanError)))
            } else {
              rows.push(React.createElement('div', { className: 'mcart-hint', key: 'shape' },
                '识别为 ' + (settings.shape || '？') + ' · ' + (settings.textures || 0) + ' 张贴图 · '
                + ((settings.sources || []).length) + ' 个资源文件'))
            }
          }
          for (const hint of (settings.directory === '' || settings.directory === undefined ? (settings.detected || []) : []).slice(0, 4)) {
            rows.push(React.createElement('div', { className: 'mcart-bar', key: 'det' + hint },
              React.createElement('span', { className: 'mcart-note mcart-grow' }, '检测到 ' + hint),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => patchSettings({ directory: hint }, true) }, '用它'),
            ))
          }
          if ((settings.directory === '' || settings.directory === undefined) && (settings.detected || []).length === 0) {
            rows.push(React.createElement('div', { className: 'mcart-hint', key: 'nodir' },
              '没设置就不参考外部资源。可以指向 .minecraft、某个版本目录、mods 目录，或单个 jar。'))
            rows.push(React.createElement('div', { className: 'mcart-hint', key: 'nodir2' },
              '没有自动检测到游戏目录 —— 直接把路径贴进上面的输入框也一样能用。'))
          }

          rows.push(React.createElement('label', { className: 'mcart-switch', key: 'gen' },
            React.createElement('input', { type: 'checkbox', checked: settings.includeGenerated !== false,
              onChange: (event) => patchSettings({ includeGenerated: event.target.checked }) }),
            React.createElement('span', null, '参考本目录已生成内容'),
          ))
          rows.push(React.createElement('div', { className: 'mcart-hint', key: 'genhint' }, '有助于保持生成风格一致'))

          rows.push(React.createElement('label', { className: 'mcart-switch', key: 'mods' },
            React.createElement('input', { type: 'checkbox', checked: settings.includeMods !== false,
              onChange: (event) => patchSettings({ includeMods: event.target.checked }) }),
            React.createElement('span', null, '参考目录中的模组资源文件'),
          ))

          if (settings.includeMods !== false) {
            const mods = settings.mods || []
            const missing = settings.directory === '' || settings.directory === undefined
            const message = missing ? '还没指定参考目录'
              : (mods.length === 0 ? '参考目录里没有找到任何资源命名空间' : ('发现 ' + mods.length + ' 个命名空间'))
            rows.push(React.createElement('div', { className: 'mcart-bar', key: 'modbar' },
              React.createElement('span', { className: 'mcart-note' }, message),
              mods.length === 0 ? null : React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setModsOpen(!modsOpen) }, modsOpen ? '收起 ▴' : '展开 ▾'),
            ))
            if (modsOpen) {
              const list = []
              for (const item of mods) {
                const from = (item.from || []).slice(0, 2).join('、')
                list.push(React.createElement('label', { className: 'mcart-switch', key: item.name },
                  React.createElement('input', { type: 'checkbox', checked: item.on === true,
                    onChange: (event) => toggleMod(item.name, event.target.checked) }),
                  React.createElement('span', { className: 'mcart-grow' }, item.name,
                    from === '' ? null : React.createElement('span', { className: 'mcart-id' }, from)),
                  React.createElement('span', { className: 'mcart-id' }, item.count + ' 张贴图'),
                ))
              }
              rows.push(React.createElement('div', { className: 'mcart-mods', key: 'modlist' }, list))
            }
          }

          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'foot' },
            React.createElement('span', { className: 'mcart-note mcart-grow' }, settings.file || ''),
            React.createElement('span', { className: 'mcart-bad' }, saveState === null ? '' : saveState),
          ))
          // Nothing pushes a message into the conversation, so the panel offers
          // the sentence and one click puts it (plus the settings file, which the
          // skill reads) in the composer.  This is the answer to "我改了设置会通知
          // agent 吗": now it can, without the user having to describe the change.
          if (savedSettings !== null && savedSettings.path !== '') {
            rows.push(React.createElement('div', { className: 'mcart-bar', key: 'tell' },
              React.createElement('span', { className: 'mcart-note mcart-grow' },
                '已保存，要让 AI 按新设置重做的话：'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setPending({ path: savedSettings.path, note: savedSettings.note }) },
                '告诉 AI'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setSavedSettings(null) }, '不用了'),
            ))
          }
        }
        // 提示与报错**必须在这张卡里也出现**：这张设置卡原来不渲染 notice，
        // 于是"选择目录…"失败（对话框弹不出来、没有 shell 服务…）时，
        // 界面上一个字都不变 —— 用户看到的就是"点了没反应，也没有报错"。
        if (notice !== null) rows.push(React.createElement('div', { className: 'mcart-bad', key: 'notice' }, String(notice)))
        if (failure !== null) rows.push(React.createElement('div', { className: 'mcart-err', key: 'failure' }, String(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'settings' }, rows)
      }

      if (root === '') {
        const card = []
        card.push(React.createElement('div', { className: 'mcart-note', key: 'hint' }, '未指定资产路径'))
        card.push(React.createElement('div', { className: 'mcart-bar', key: 'input' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '/path/to/project',
            value: draft, onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && draft !== '') commitRoot(draft) },
          }),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { if (draft !== '') commitRoot(draft) } }, '使用'),
        ))

        if (nearby !== null) {
          if (nearby.loading === true) {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'scanning' }, '正在找本会话目录里的项目…'))
          } else if (nearby.error !== null) {
            card.push(React.createElement('div', { className: 'mcart-err', key: 'nerr' }, String(nearby.error)))
          } else if (nearby.projects.length > 0) {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'found' }, '在 ' + nearby.cwd + ' 里找到：'))
            const rows = []
            for (const project of nearby.projects) {
              rows.push(React.createElement('div', { className: 'mcart-row', key: project.root + '/' + project.id },
                React.createElement('span', { className: 'mcart-grow' }, project.title,
                  project.title === project.id ? null : React.createElement('span', { className: 'mcart-id' }, project.id)),
                React.createElement('button', { className: 'mcart-btn', type: 'button',
                  onClick: () => openNearby(project.root, project.id) }, '打开'),
              ))
            }
            card.push(React.createElement('div', { className: 'mcart-projects', key: 'projects' }, rows))
          } else {
            card.push(React.createElement('div', { className: 'mcart-note', key: 'none' },
              '在 ' + nearby.cwd + ' 里没找到 mc 资产项目。'))
          }
        }

        card.push(React.createElement('div', { className: 'mcart-bar', key: 'buttons' },
          React.createElement('button', { className: 'mcart-btn', type: 'button', disabled: picking,
            onClick: pickDirectory }, picking ? '对话框已打开…' : '选择目录…'),
          nearby !== null && nearby.cwd !== '' ? React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => commitRoot(nearby.cwd) }, '用本会话目录') : null,
        ))

        if (notice !== null) card.push(React.createElement('div', { className: 'mcart-bad', key: 'notice' }, String(notice)))
        if (failure !== null) card.push(React.createElement('div', { className: 'mcart-err', key: 'failure' }, String(failure)))
        return React.createElement('div', { className: 'mcart-root' },
          React.createElement('div', { className: 'mcart-bar' },
            React.createElement('span', { className: 'mcart-title' }, 'MC 资产'),
            React.createElement('span', { className: 'mcart-sub' }, inRightColumn ? '右侧栏' : '中央面板'),
          ),
          React.createElement('div', { className: 'mcart-card' }, card),
        )
      }

      // 空目录的引导：一步建项目、一步指参考目录。已有参考目录设置的人看不到这张卡
      // （他们的 scan 会正常返回项目，走的是老路）。
      function guideCard() {
        const id = String(newId).trim()
        const valid = /^[a-z0-9_]{2,32}$/.test(id)
        const reference = settings === null ? null : settings.directory
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '开始一个新模组'),
          React.createElement('span', { className: 'mcart-sub' }, '三步：目录 → 建项目 → 参考目录')))
        rows.push(React.createElement('div', { className: 'mcart-note', key: 'why' },
          '这个目录里还没有项目。一个模组 = 一个命名空间，所以这里只需要取一个名字：' +
          '项目 id 与命名空间同名，之后不会给它长出第二个命名空间。'))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'form' },
          React.createElement('input', {
            className: 'mcart-input', placeholder: '项目名，例如 my_mod（小写字母/数字/_）',
            value: newId,
            onChange: (event) => setNewId(String(event.target.value)),
            onKeyDown: (event) => { if (event.key === 'Enter' && valid) createProject() },
          }),
          React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: !valid || busy,
            onClick: () => createProject(),
          }, busy ? '…' : '在这里新建项目')))
        if (id !== '' && !valid) {
          rows.push(React.createElement('div', { className: 'mcart-bad', key: 'badid' },
            '只能用小写字母、数字、下划线，2-32 个字符'))
        }
        const here = emptyRoot === null ? root : emptyRoot
        rows.push(React.createElement('div', { className: 'mcart-hint', key: 'where' }, '建在：' + here))
        rows.push(React.createElement('div', { className: reference === null || reference === '' ? 'mcart-hint' : 'mcart-note', key: 'ref' },
          reference === null || reference === ''
            ? '建完下一步：点右上角 ⚙ 指定参考目录（面板会列出自动探测到的游戏目录）。不指定也能用，只是看不到原版/模组的参照。'
            : '参考目录已经设好了：' + reference))
        if (failure !== null) rows.push(React.createElement('div', { className: 'mcart-err', key: 'err' }, String(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'guide' }, rows)
      }

      // 「这台宿主上我到底能看见什么」——失败时附在错误后面。
      // 建目录/写文件/写字节各有好几条路（宿主服务 → 服务 → node 垫片），
      // 而一句"宿主没有 X 服务"曾经把人带偏过：那句话谁也没查过。所以失败时直接问一句。
      function describeEnv() {
        return host.call('atlas.env', {}).then((env) => {
          if (env === null || env === undefined || env.services === undefined) return ''
          const names = Object.keys(env.services)
          const on = names.filter((key) => env.services[key] === true)
          const off = names.filter((key) => env.services[key] !== true)
          return '（宿主可用：' + (on.length === 0 ? '无' : on.join('、')) +
            '；缺：' + (off.length === 0 ? '无' : off.join('、')) +
            '；shell 方言：' + String(env.shellDialect === null || env.shellDialect === undefined ? '问不到' : env.shellDialect) + '）'
        }).catch(() => '')
      }

      function createProject() {
        const id = String(newId).trim()
        if (!/^[a-z0-9_]{2,32}$/.test(id)) return
        const here = emptyRoot === null ? root : emptyRoot
        setBusy(true)
        setFailure(null)
        host.call('atlas.createProject', { root: here, id: id }).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('新建项目没有返回任何东西'); return }
          const bad = failureOf(result)
          if (bad !== null) {
            setFailure(String(bad))
            describeEnv().then((text) => { if (text !== '') setFailure(String(bad) + ' ' + text) })
            return
          }
          setEmptyRoot(null)
          // 建目录走了哪条路要说出来：`.gitkeep` 占位和 node 垫片都是"服务不在"的
          // 后果，用户有权知道自己的工程是怎么被写下去的（也方便别人报问题时一句话说清）。
          if (typeof result.via === 'string') {
            setNotice('工程建好了：' + id + '（目录用 ' + result.via + ' 建的' +
              (result.placeholder === true ? '，空目录里留了 .gitkeep 占位' : '') + '）')
          }
          scan(here, true, id)
        }).catch((error) => { setBusy(false); setFailure(String(error && error.message ? error.message : error)) })
      }

      const projects = index === null ? [] : (index.projects || [])
      const menu = []
      for (const project of projects) {
        menu.push(React.createElement('div', { className: 'mcart-group', key: 'p' + project.id }, project.title))
        for (const category of CATEGORIES) {
          const items = (project.items && project.items[category.key]) || []
          if (items.length === 0) continue
          menu.push(React.createElement('div', { className: 'mcart-group', key: 'p' + project.id + category.key },
            category.label + ' · ' + items.length))
          for (const item of items) {
            const on = choice !== null && choice.project === project.id && choice.kind === category.key && choice.id === item.id
            menu.push(React.createElement('button', {
              key: project.id + '/' + category.key + '/' + item.id, type: 'button',
              className: 'mcart-item', 'data-on': on ? '1' : '0',
              onClick: () => open({ project: project.id, kind: category.key, id: item.id }, root),
            }, item.title,
              item.title === item.id ? null : React.createElement('span', { className: 'mcart-id' }, item.id)))
          }
        }
      }

      const stage = []
      // Filled in below, appended AFTER the canvas -- see the note there.
      const animRows = []
      if (!isAbsent(scene)) {
        const ids = idsOf(scene)
        const okCount = ids.filter((id) => decoded[id] !== undefined).length
        const bad = ids.filter((id) => failedTex[id] === true).length
        stage.push(React.createElement('div', { className: 'mcart-bar', key: 'row' },
          React.createElement('span', { className: 'mcart-note' },
            scene.quads.length + ' 面 · 贴图 ' + okCount + '/' + ids.length),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setYaw(0.72); setPitch(0.34); setZoom(1) } }, '重置'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: openEditor }, '✎ 手动修改'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: complain }, '@ 提意见'),
        ))
        if (bad > 0) stage.push(React.createElement('div', { className: 'mcart-bad', key: 'bad' }, bad + ' 张贴图解码失败'))
        if (scene.errors && scene.errors.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bad', key: 'notes' }, scene.errors.join('；')))
        }
        // Why this is on screen and not in the console: "the whole strip on one
        // face" has exactly two causes -- `animations` has no entry for that
        // texture id, or the decoded image is not `strip` rows tall -- and one
        // line tells them apart without devtools.
        //
        // TWO THINGS IT MUST NOT DO, both learned from the same complaint
        // ("the tip pops up when I select a block, the layout shifts, I cannot
        // click the block any more, the tip goes away, I can click again, the
        // tip comes back -- it twitches"):
        //   * It must not read the GHOST.  The ghost exists only while a block
        //     is held and hovered, so a ghost's `animations` made this row
        //     appear and disappear with the pointer -- and appearing MOVES the
        //     canvas, which moves what is under the pointer: a loop that feeds
        //     itself.  It reports on the SCENE, which is what is on screen.
        //   * It must not sit ABOVE the canvas.  Anything above pushes the
        //     canvas down whenever it grows, so a click aimed at a block lands
        //     somewhere else.  It is appended after the viewport instead.
        const animIndex = scene === null ? {} : (scene.animations || {})
        for (const id of Object.keys(animIndex).sort()) {
          const tex = decoded[id]
          const size = tex === undefined ? '还没解码' : (tex.width + '×' + tex.height)
          const strip = tex === undefined ? null
            : stripOf({ width: tex.width, height: tex.height, animation: animIndex[id] })
          // The row actually sampled right now, so "the strip is fine but the
          // picture is not" cannot be mistaken for "the strip was rejected".
          const row = animationRow(animIndex[id], animTicks * 50)
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'anim:' + id },
            '动画 ' + id + ' · 解码 ' + size + ' · 声明 ' + String(animIndex[id].strip) + ' 行'
            + ' · 判定 ' + (tex === undefined ? '等解码' : (strip === null ? '不是条带 ← 会糊' : '单帧 ' + strip))
            + ' · 现在抽第 ' + String(row) + ' 行'))
        }
        for (const id of idsOf(scene)) {
          if (animIndex[id] !== undefined) continue
          const tex = decoded[id]
          if (tex === undefined) continue
          // Only worth reporting when the shape says "this is a strip": a
          // plain 16x16 static texture having no description is normal.
          if (!(tex.height > tex.width && tex.height % tex.width === 0)) continue
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'noanim:' + id },
            '形状像条带但没有动画描述 ' + id + ' · 解码 ' + tex.width + '×' + tex.height + ' ← 会糊'))
        }
        if (scene.palette && scene.palette.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bar', key: 'palette' },
            scene.palette.slice(0, 8).map((entry) => React.createElement('span', { className: 'mcart-chip', key: entry.block },
              (entry.label || entry.block) + ' ×' + entry.count)),
          ))
        }
      }
      // The icon of whatever is selected, which is also what the bar's selected
      // slot draws.  Two things need it before the viewport is built: the poster
      // (below) and the notes (after it).
      // **这里必须收成 null**：`itemRecipes[key]` 在"配方还没取到"时是 `undefined`
      // （JSON 丢字段、或那次运行里资源正在被写），而下游每一处守卫写的都是 `=== null`。
      // 用户实测的崩溃链就是这一条：
      //   pickedRecipe === undefined → itemAsset() 返回的 recipe 是 undefined
      //   → `asset.recipe === null ? … : asset.recipe.textureIds` 放它过去
      //   → Cannot read properties of undefined (reading 'textureIds') → 面板白屏。
      // 与其在每一处读的地方各补一次，不如在这里就只说两种状态：有配方 / 没有(null)。
      const pickedRecipe = hudOn === '' || item === null
        ? null : (itemRecipes[itemKey(item.namespace, hudOn)] || null)
      // The row a block gets, for an asset that has no scene: the same two
      // buttons, because an item is an asset too.
      if (scene === null) {
        const asset = itemAsset()
        if (asset !== null) {
          const ids = idsOf(asset.recipe)
          const okCount = ids.filter((id) => decoded[id] !== undefined).length
          stage.push(React.createElement('div', { className: 'mcart-bar', key: 'itemrow' },
            React.createElement('span', { className: 'mcart-note' },
              '物品 · 贴图 ' + okCount + '/' + ids.length
              + (asset.source === 'project' ? '' : '（参考）')),
            React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: openEditor }, '✎ 手动修改'),
            React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: complain }, '@ 提意见'),
          ))
        }
      }
      // NO MODEL, BUT AN ITEM: put the 2D form where the 3D one would be.  An
      // item-only asset (a material like blood_crystal) is a picture and nothing
      // else, so the picture is what belongs in the viewport -- the user asked for
      // exactly this ("3D没有东西可看的情况应该放2D在上面"), and an empty black
      // rectangle is not an answer.
      const posterRecipe = scene === null && pickedRecipe !== null ? pickedRecipe : null
      // A square that fits the viewport: a sprite stretched to a 1.3:1 rectangle is
      // a distortion, and `drawItemIcon` fills whatever canvas it is handed.
      const posterSide = Math.max(48, Math.min(size[0], size[1]) - 24)
      stage.push(React.createElement('div', { className: 'mcart-viewport', key: 'viewport' },
        React.createElement('canvas', {
        key: 'canvas', className: 'mcart-canvas',
        // The CSS default is the same number; an inline height is what the grip
        // moves.  `clientHeight` then feeds the size state, so the picture is
        // redrawn at the new resolution instead of being stretched.
        style: { height: viewH + 'px' },
        ref: (node) => { canvasGeneration += 1; setCanvas(node) },
        onPointerDown: (event) => {
          drag.active = true
          drag.moved = 0
          drag.x = event.clientX
          drag.y = event.clientY
          if (event.currentTarget.setPointerCapture) {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
          }
        },
        onPointerMove: (event) => {
          if (!drag.active) {
            if (voxel !== null) {
              const target = voxelTargetAt(event)
              if (target === null) { if (hover !== null) setHover(null) }
              else if (hover === null || hover.cell !== target.cell || hover.face !== target.face) setHover(target)
            }
            return
          }
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          drag.x = event.clientX
          drag.y = event.clientY
          drag.moved += Math.abs(dx) + Math.abs(dy)
          setYaw((previous) => previous - dx * 0.011)
          setPitch((previous) => Math.max(-1.35, Math.min(1.35, previous + dy * 0.011)))
        },
        onPointerUp: (event) => {
          const dragDistance = drag.moved
          drag.active = false
          // A rotation ends with the pointer somewhere else; a click barely
          // moves.  Without this every rotate would also place a block.
          if (dragDistance > 4 || voxel === null) return
          // Vanilla's two buttons: left breaks, right places.
          voxelClick(event, event.button === 2 ? 'place' : 'remove')
        },
        onContextMenu: (event) => { if (event.preventDefault) event.preventDefault() },
        onPointerLeave: () => { drag.active = false },
      }),
        React.createElement('div', { className: 'mcart-zoom' },
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '放大', onClick: () => zoomBy(1.15) }, '＋'),
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '缩小', onClick: () => zoomBy(1 / 1.15) }, '－'),
          React.createElement('button', { className: 'mcart-btn mcart-zoombtn', type: 'button',
            title: '复位视角（旋转与缩放一起）',
            onClick: () => { setYaw(0.72); setPitch(0.34); setZoom(1) } }, '⟲'),
        ),
        // The 2D stand-in, drawn at the size it is shown at (the backing store is
        // the CSS size, so a 16 px sprite is scaled once, by this code, nearest
        // neighbour -- not blurred by the browser).
        posterRecipe === null ? null : React.createElement('canvas', {
          key: 'poster', className: 'mcart-poster',
          width: posterSide, height: posterSide,
          style: { width: posterSide + 'px', height: posterSide + 'px' },
          title: hudPicked,
          ref: (node) => setPosterCanvas(node),
        }),
        // The 2D layer: the game's hotbar, laid over the model instead of in a
        // row of its own beside it.  The model IS the item -- what it looks like
        // standing in the world is the big picture, and what it looks like in a
        // slot is the strip along the bottom, the way the game shows both.
        //
        // It is an absolutely positioned overlay, not a row above or below: a row
        // that appears and disappears MOVES the canvas, which moves whatever is
        // under the pointer, which is the twitching a row above the canvas caused.
        hudBar()))

      // The grip: the whole 3D+hotbar block resizes from its bottom edge.  It sits
      // BELOW the canvas, so dragging it never moves the picture under the pointer
      // (the mistake a control above the canvas caused); it is always present, so
      // it never appears and disappears either.
      stage.push(React.createElement('div', { className: 'mcart-grip', key: 'grip',
        title: '上下拖动调整 3D + 物品栏的高度，双击复位',
        onDoubleClick: () => setViewH(VIEW_H),
        onPointerDown: (event) => {
          gripDrag.active = true
          gripDrag.y = event.clientY
          gripDrag.origin = viewH
          if (event.currentTarget.setPointerCapture) {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* not fatal */ }
          }
        },
        onPointerMove: (event) => {
          if (!gripDrag.active) return
          setViewH(clampViewH(gripDrag.origin + (event.clientY - gripDrag.y)))
        },
        onPointerUp: () => { gripDrag.active = false },
        onPointerCancel: () => { gripDrag.active = false },
      }, React.createElement('span', { className: 'mcart-gripbar' })))

      // What used to sit INSIDE the 3D view.  It belongs down here: the overlay is
      // meant to look like the game's HUD, and a warning line in the middle of it
      // is neither the game nor readable.  Below the canvas is also the only safe
      // place -- a row that grows above it moves the canvas under the pointer.
      const iconNotes = []
      if (itemMsg !== null) iconNotes.push(String(itemMsg))
      const pickedNote = slotNote(pickedRecipe)
      if (pickedNote !== null) iconNotes.push(pickedNote)
      // An item-only asset (a material like blood_crystal: a model with no
      // blockstate) has no 3D form at all.  The viewport is cleared, so it must
      // SAY why -- an empty black rectangle under a slot that clearly has a
      // picture reads as a viewer that stopped working.
      if (previewItem !== null && previewItem.localOnly === true) {
        iconNotes.push((hudPicked === '' ? previewItem.id : hudPicked)
          + ' 没有方块模型（它是物品，不是方块），所以 3D 里没有东西可看；它的样子就是物品栏里那一格')
      }
      if (choice !== null && choice.kind !== 'block') {
        iconNotes.push(choice.kind === 'entity'
          ? '实体在游戏里没有物品图标（刷怪蛋的蛋色写在代码里，包里没有）'
          : (choice.kind === 'biome' ? '群系' : '多方块结构') + '在游戏里不是物品')
      }
      if (iconNotes.length > 0) {
        stage.push(React.createElement('div', { className: 'mcart-note', key: 'iconnote' }, iconNotes.join('；')))
      }

      if (animRows.length > 0) {
        stage.push(React.createElement('div', { className: 'mcart-mods', key: 'anims' }, animRows))
      }

      const sources = []
      const allTextures = Object.assign({}, scene === null ? {} : scene.textures,
        ghost === null || ghost.textures === undefined ? {} : ghost.textures)
      // The item picker's own textures ride the same hidden <img> list; without
      // an element per texture there is nothing for the decoder to read.
      for (const recipe of iconRecipesInUse()) {
        if (recipe.textures !== undefined && recipe.textures !== null) Object.assign(allTextures, recipe.textures)
      }
      if (scene !== null || item !== null) {
        for (const id of Object.keys(allTextures)) {
          if (decoded[id] !== undefined) continue
          sources.push(React.createElement('img', {
            key: id, src: allTextures[id], alt: '', style: { display: 'none' },
            ref: (node) => {
              if (node === null || node === undefined) delete imageNodes[id]
              else imageNodes[id] = node
            },
            onLoad: () => setTick(tick + 1),
            onError: () => { failedTex[id] = true; setTick(tick + 1) },
          }))
        }
      }

      return React.createElement('div', { className: 'mcart-root' },
        React.createElement('div', { className: 'mcart-bar' },
          React.createElement('span', { className: 'mcart-title' }, 'MC 资产'),
          React.createElement('span', { className: 'mcart-sub' },
            busy ? '加载中…' : (inRightColumn ? '右侧栏' : '中央面板')),
          // The bar at the bottom of the 3D view IS the 物品栏 now, the way the
          // game has it; this button unfolds the browser behind it (来源、搜索、
          // 展示形式、四十格一页), which is the part the game has no equivalent of.
          React.createElement('button', { className: 'mcart-btn mcart-tool', type: 'button',
            title: '物品浏览器：来源、搜索、展示形式都在这里；下面那排物品栏跟着一起筛',
            'data-on': itemOpen ? '1' : '0',
            onClick: openItems }, itemOpen ? '收起列表' : '物品列表'),
          React.createElement('button', { className: 'mcart-icon', type: 'button', title: '设置',
            onClick: openSettings }, settings === null ? '⚙' : '⚙▾'),
        ),
        settings === null ? null : settingsCard(),
        emptyRoot === null ? null : guideCard(),
        React.createElement('div', { className: 'mcart-bar' },
          React.createElement('span', { className: 'mcart-path' }, root),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setRoot(''); setIndex(null); setItem(null); setItemOpen(false); setIconPick(null); setPreviewItem(null); setHudPage(1); setScene(null); setSettings(null); setEdit(null); setVoxel(null); setHover(null); setGhost(null) } }, '换项目'),
          React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: () => scan(root, true, null) }, '刷新'),
        ),
        failure === null ? null : React.createElement('div', { className: 'mcart-err' }, String(failure)),
        React.createElement('div', { className: 'mcart-list' }, menu),
        editorCard(),
        voxelCard(),
        itemOpen ? itemCard() : null,
        React.createElement('div', { className: 'mcart-stage' }, stage),
        React.createElement('div', { style: { display: 'none' } },
          React.createElement('canvas', { ref: setScratch, width: 256, height: 256 }),
          React.createElement('canvas', { ref: setEditScratch, width: 16, height: 16 }),
          sources,
        ),
      )
    }

    function TabTitle() {
      return React.createElement('span', null, 'MC 资产')
    }

    function ReferenceBar(props) {
      const current = usePending()
      const draft = props.useInput !== undefined ? props.useInput((state) => state.draft) : ''
      if (current === null || current.path === '') return null
      // `note` is the sentence that goes WITH the reference: a settings change has
      // to say WHAT changed, or `@file` alone leaves the agent to diff it.  It is
      // the answer to "我这里设置修改了会通知agent吗" -- nothing pushes a message
      // into the conversation, so the panel offers the sentence and one click puts
      // it in the composer.
      const note = current.note === undefined || current.note === null ? '' : String(current.note)
      return React.createElement('div', { className: 'mcart-ref' },
        React.createElement('span', null, '引用给 AI'),
        React.createElement('span', { className: 'mcart-ref-path' }, '@' + current.path),
        note === '' ? null : React.createElement('span', { className: 'mcart-ref-path' }, note),
        React.createElement('button', {
          className: 'mcart-btn', type: 'button',
          onClick: () => {
            const text = draft === undefined || draft === null ? '' : String(draft)
            const base = text.length > 0 ? text.replace(/\s+$/, '') + ' ' : ''
            const tail = '@' + current.path + (note === '' ? ' ' : ' ' + note)
            if (props.inputActions !== undefined) props.inputActions.setDraft(base + tail + ' ')
            setPending(null)
          },
        }, '插入输入框'),
        React.createElement('button', { className: 'mcart-btn', type: 'button', onClick: () => setPending(null) }, '取消'),
      )
    }

    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'mc-art-ref', order: 15 },
      (props) => React.createElement(ReferenceBar, { useInput: props.useInput, inputActions: props.inputActions }),
    ))

    let placement = null
    const leftStops = []
    function placeLeft() {
      if (placement !== null) return
      placement = 'left'
      const keep = []
      slots.inject('main', () => {
        const stop = slots.register({ name: 'main', key: 'mcarts' },
          () => React.createElement(PanelBoundary, null, React.createElement(Atlas, { sessionId: '' })))
        keep.push(stop)
        return stop
      })
      slots.inject('sidebar.panellist', () => {
        const stop = slots.register({ name: 'sidebar.panellist', id: 'mcarts', order: 12, label: 'MC 资产' },
          () => React.createElement('span', null, 'MC'))
        keep.push(stop)
        return stop
      })
      leftStops.push(() => { for (const stop of keep) { try { if (typeof stop === 'function') stop() } catch (error) {  } } })
    }
    function placeRight() {
      if (placement === 'right') return
      // **先确认能不能挂上，再撤左栏。**
      //
      // 原来这里是：先 `placement = 'right'`、先把左栏那份撤掉，然后才发现
      // `sidebarRightTabs` 不在、直接 return —— 于是**两处都没有**，右边栏一片空白，
      // 而且 placement 已经写成 'right'，再也不会重试。用户实测就是"刷新之后右边栏
      // 一片空白"。（`slotHasEntries` 让 inRightColumn 为真、而服务恰好不在时就会走到。）
      //
      // 现在：没有 tab 服务、也没有 pane 槽时**什么都不动**（保留左栏那份能用的）；
      // 只要还能挂（服务在，或槽在），就挂上去，然后才撤左栏。
      const rightTabs = ctx.get('sidebarRightTabs')
      // 拿不准就**什么都别动**：左栏那份至少点得开。只挂 pane、不挂 tab 是一种更糟的
      // 失败 —— 面板画在右栏里，但没有任何标签能点开它（用户报的就是"右侧栏打不开"）。
      if (rightTabs === undefined) return
      if (placement === 'left') {
        // 搬到右栏：先把左栏那份撤掉，免得同一个面板在两处都在。
        for (const stop of leftStops) { try { stop() } catch (error) {  } }
        leftStops.length = 0
      }
      placement = 'right'
      ctx.effect(() => rightTabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        priority: 'extension',
        title: () => 'MC 资产',
        guide: [{
          id: TAB_ID + '.open',
          order: 40,
          title: () => 'MC 资产预览',
          description: () => '在右侧栏里看这个项目的方块 / 实体 / 群系 / 多方块结构',
        }],
      }))
      registerPane()
    }

    /** 把面板挂进右栏的 pane 槽（tab 服务在不在都要挂：槽里有壳就行）。 */
    function registerPane() {
      slots.inject('sidebar.right.pane.tab', () => slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        (props) => React.createElement(PanelBoundary, null,
          React.createElement(Atlas, { sessionId: props.sessionId })),
      ))
      slots.inject('sidebar.right.pane.tab.title', () => slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
        () => React.createElement(TabTitle, null),
      ))
    }

    if (inRightColumn) placeRight()
    else {
      placeLeft()
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sidebarRightTabs'], () => { if (rightColumnReady()) placeRight() })
        } catch (error) {  }
      }
    }
  },
}
