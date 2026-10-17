// ⚠ 清单顺序 = 文件名顺序 = `client.manifest.json` 里的排列（00-math → 10-icon →
// 20-const → 99-entry）。片段之间**只许在函数体里**互相引用；不许在顶层直接执行
// 后面文件里的声明（顶层 const 在求值时受 TDZ 约束，抛了会让整个客户端半边不注册，
// 屏幕上看不出原因）。要在顶层用到什么，就把它挪到更靠前的片段里。
//
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

