const FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 }
const FACE_ORDER = ['down', 'up', 'north', 'south', 'west', 'east']

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vlen = (a) => Math.sqrt(dot(a, a))
function unit(a) { const n = vlen(a); return n < 1e-12 ? [0, 0, 0] : mul(a, 1 / n) }

// north's second corner is (x2,y1,z1): an earlier copy of this file had
// (x2,y2,z1) twice, which silently turned every north face into a triangle.
function faceCorners(x1, y1, z1, x2, y2, z2, face) {
  if (face === 'down') return [[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]]
  if (face === 'up') return [[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]]
  if (face === 'north') return [[x2, y2, z1], [x2, y1, z1], [x1, y1, z1], [x1, y2, z1]]
  if (face === 'south') return [[x1, y2, z2], [x1, y1, z2], [x2, y1, z2], [x2, y2, z2]]
  if (face === 'west') return [[x1, y2, z1], [x1, y1, z1], [x1, y1, z2], [x1, y2, z2]]
  return [[x2, y2, z2], [x2, y1, z2], [x2, y1, z1], [x2, y2, z1]]
}

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

// A blockstate's own rotation of the whole model, applied LAST -- after
// `quadsFromElements` has already applied each element's own `rotation`.
// Minecraft does it in that order (the variant state wraps the baked model),
// and an element `rotation` is expressed in model space, so rotating the raw
// `from`/`to` instead would put the two in the wrong order for every
// cross/stairs model.
//
// x is applied first, then y with its sign FLIPPED.  Both halves were checked
// against vanilla 1.12.2 rather than recalled: `furnace` puts its front face on
// the north side and declares `facing=east` as `y: 90`, which only lands that
// face on +X if the y rotation is applied as -90.  (`oak_log` cannot settle it
// -- a log is symmetric, so `axis=x` and `axis=z` look alike.)
const FACE_VECTORS = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
  south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
}

function faceAfter(face, x, y) {
  const vector = FACE_VECTORS[face]
  if (vector === undefined) return face
  let p = vector
  if (x) p = rotateAbout(p, [0, 0, 0], 'x', x)
  if (y) p = rotateAbout(p, [0, 0, 0], 'y', -y)
  for (const name of FACE_ORDER) {
    const want = FACE_VECTORS[name]
    if (Math.abs(p[0] - want[0]) < 1e-6 && Math.abs(p[1] - want[1]) < 1e-6 && Math.abs(p[2] - want[2]) < 1e-6) return name
  }
  return face
}

function rotateQuads(quads, rotation) {
  if (rotation === undefined || rotation === null) return quads
  const x = rotation.x || 0
  const y = rotation.y || 0
  if (x === 0 && y === 0) return quads
  return quads.map((quad) => {
    let p = x ? quad.p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'x', x)) : quad.p
    p = y ? p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'y', -y)) : p
    // The shade table is keyed by DIRECTION, and rotating the model moves the
    // surfaces: leaving the old name on a quad lights the block as if it had
    // not turned.  `shaded: false` is the model saying "do not shade this"
    // (a cross), and that survives the rotation untouched.
    const face = faceAfter(quad.face, x, y)
    const shade = quad.shaded === false ? 1.0 : (FACE_SHADE[face] === undefined ? quad.shade : FACE_SHADE[face])
    const turned = { p: p, uv: quad.uv, tex: quad.tex, shade: shade, mode: quad.mode,
      face: face, shaded: quad.shaded }
    // `pick` is attached by the CELL renderer, AFTER this, and a quad straight
    // out of `quadsFromElements` has no such key at all.  Copying it through
    // unconditionally wrote `pick: undefined` into every ROTATED quad -- and the
    // runtime rejects `undefined` anywhere in a handler's result
    // ("result.quads[11].pick must be lossless JSON data").  So every rotated
    // ghost failed at the RPC boundary -- a furnace facing east, and one
    // `multipart` apply -- while every local gate stayed green, because the gate
    // stub did not validate what the runtime does.  (Both ends fixed: see
    // `jsonProblem` in run.js.)
    if (quad.pick !== undefined) turned.pick = quad.pick
    return turned
  })
}

function degenerate(corners) {
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = corners[i], b = corners[j]
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return true
    }
  }
  return false
}

function quadsFromElements(elements, report) {
  const quads = []
  for (const element of elements) {
    const x1 = element.from[0], y1 = element.from[1], z1 = element.from[2]
    const x2 = element.to[0], y2 = element.to[1], z2 = element.to[2]
    const rotation = element.rotation
    const emitted = {}
    for (const face of Object.keys(element.faces || {})) {
      const data = element.faces[face]
      if (data === undefined || data.tex === undefined) continue
      let corners = faceCorners(x1, y1, z1, x2, y2, z2, face)
      if (rotation) {
        corners = corners.map((p) => rotateAbout(p, rotation.origin || [0, 0, 0], rotation.axis || 'y', rotation.angle || 0))
      }
      corners = corners.map((p) => [p[0] / 16, p[1] / 16, p[2] / 16])
      if (degenerate(corners)) {
        if (report !== undefined) report('退化面 ' + face + '：四角有重合，已跳过（几何代码写错了）')
        continue
      }
      const uv = data.uv || [0, 0, 16, 16]
      const base = [[uv[0], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]]]
      const steps = Math.trunc(data.rotation || 0) / 90
      const uvs = [0, 1, 2, 3].map((i) => {
        const pick = base[((i - steps) % 4 + 4) % 4]
        return [pick[0] / 16, pick[1] / 16]
      })
      const fingerprint = corners.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6) + ',' + p[2].toFixed(6)).sort().join('|')
        + '#' + uvs.map((pair) => pair[0] + ',' + pair[1]).join('|') + '#' + data.tex
      if (emitted[fingerprint] === true) continue
      emitted[fingerprint] = true
      quads.push({ p: corners, uv: uvs, tex: data.tex, shade: element.shade === false ? 1.0 : FACE_SHADE[face],
        mode: 'opaque', face: face, shaded: element.shade !== false })
    }
  }
  return quads
}

function translateQuads(quads, offset) {
  if (!offset || (offset[0] === 0 && offset[1] === 0 && offset[2] === 0)) return quads
  return quads.map((quad) => ({
    p: quad.p.map((p) => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]),
    uv: quad.uv, tex: quad.tex, shade: quad.shade, mode: quad.mode, face: quad.face,
    shaded: quad.shaded,
  }))
}

