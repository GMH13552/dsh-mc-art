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

function cubeElements(pick) {
  const faces = {}
  for (const face of FACE_ORDER) faces[face] = { texture: pick[face], uv: [0, 0, 16, 16] }
  return [{ from: [0, 0, 0], to: [16, 16, 16], faces: faces }]
}

const CROSS_ELEMENTS = [
  { from: [0.8, 0, 8], to: [15.2, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false,
    faces: { north: { uv: [0, 0, 16, 16], texture: '#cross' }, south: { uv: [0, 0, 16, 16], texture: '#cross' } } },
  { from: [8, 0, 0.8], to: [8, 16, 15.2], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false,
    faces: { west: { uv: [0, 0, 16, 16], texture: '#cross' }, east: { uv: [0, 0, 16, 16], texture: '#cross' } } },
]

const VANILLA_PARENTS = {
  // The vanilla bases a project pack inherits without shipping.  Copied from the
  // 1.18.2 jar, mapping and all, so a pack that parents `block/cube_all` and one
  // that parents `block/cube` land on the same numbers -- and so the icon path
  // (which reads the same table from the extractor) agrees with this one.
  'block/block': { textures: {}, gui_light: 'side', display: { gui: {
    rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } } },
  'block/cube': { parent: 'block/block', textures: { particle: '#north' },
    elements: cubeElements({ down: '#down', up: '#up', north: '#north',
      south: '#south', west: '#west', east: '#east' }) },
  'block/cube_all': { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all',
    north: '#all', south: '#all', west: '#all', east: '#all' } },
  'block/cube_column': { parent: 'block/cube', textures: { particle: '#side', end: '#end', side: '#side',
    down: '#end', up: '#end', north: '#side', south: '#side', west: '#side', east: '#side' } },
  'block/cube_bottom_top': { parent: 'block/cube', textures: { particle: '#side', bottom: '#bottom',
    top: '#top', side: '#side', down: '#bottom', up: '#top', north: '#side',
    south: '#side', west: '#side', east: '#side' } },
  'block/cross': { textures: { particle: '#cross' }, elements: CROSS_ELEMENTS },
  'block/tinted_cross': { parent: 'block/cross', textures: {} },
}

function resolveBlockModel(model, loadParent, resolveTexture) {
  const chain = []
  let node = model
  const seen = {}
  for (let depth = 0; depth < 8 && node !== undefined; depth++) {
    chain.push(node)
    const parent = node.parent
    if (typeof parent !== 'string' || seen[parent] === true) break
    seen[parent] = true
    node = loadParent(parent) || VANILLA_PARENTS[parent] || { textures: {} }
  }
  const textures = {}
  for (let i = chain.length - 1; i >= 0; i--) {
    const table = chain[i].textures
    if (table) for (const key of Object.keys(table)) textures[key] = table[key]
  }
  let elements
  for (const candidate of chain) {
    if (Array.isArray(candidate.elements) && candidate.elements.length > 0) { elements = candidate.elements; break }
  }
  if (elements === undefined) return undefined
  const dereference = (reference) => {
    let name = String(reference === undefined ? '' : reference)
    for (let i = 0; i < 8 && name.charAt(0) === '#'; i++) {
      const next = textures[name.slice(1)]
      if (next === undefined) break
      name = String(next)
    }
    return resolveTexture(name)
  }
  return elements.map((element) => {
    const faces = {}
    for (const face of Object.keys(element.faces || {})) {
      const data = element.faces[face]
      const tex = dereference(data.texture)
      if (tex === undefined) continue
      faces[face] = { tex: tex, uv: data.uv || [0, 0, 16, 16], rotation: data.rotation || 0 }
    }
    return { from: element.from, to: element.to, rotation: element.rotation, shade: element.shade, faces: faces }
  })
}

const FOOT_OFFSET = 1.5078125
const LIGHT0 = unit([0.2, 1.0, -0.7])
const LIGHT1 = unit([-0.2, 1.0, 0.7])
function toWorld(point) { return [point[0] / 16, FOOT_OFFSET - point[1] / 16, -point[2] / 16] }
function entityShade(normal) {
  return 0.4 + 0.6 * (Math.max(0, dot(normal, LIGHT0)) + Math.max(0, dot(normal, LIGHT1)))
}
function place(point, pivot, rotation) {
  let p = point
  for (const axis of ['z', 'y', 'x']) {
    const degrees = rotation === undefined ? 0 : (rotation[axis] || 0)
    if (degrees) p = rotateAbout(p, [0, 0, 0], axis, degrees)
  }
  return add(p, pivot)
}
function modelCorners(x1, y1, z1, x2, y2, z2) {
  return { A: [x1, y1, z1], B: [x2, y1, z1], C: [x2, y2, z1], D: [x1, y2, z1],
    E: [x1, y1, z2], F: [x2, y1, z2], G: [x2, y2, z2], H: [x1, y2, z2] }
}
// The `front` entry's third parameter must be `w`: its body reads `w`.  It was
// renamed to `d2` here once, and every entity then threw `w is not defined`.
// tools/atlas_drift_check.mjs calls each of these to catch exactly that.
const ENTITY_QUADS = [
  ['right', 'FBCG', (u, v, w, h, d) => [u + d + w, v + d, u + d + w + d, v + d + h]],
  ['left', 'AEHD', (u, v, w, h, d) => [u, v + d, u + d, v + d + h]],
  ['top', 'FEAB', (u, v, w, h, d) => [u + d, v, u + d + w, v + d]],
  ['bottom', 'CDHG', (u, v, w, h, d) => [u + d + w, v + d, u + d + w + w, v]],
  ['front', 'BADC', (u, v, w, h, d) => [u + d, v + d, u + d + w, v + d + h]],
  ['back', 'EFGH', (u, v, w, h, d) => [u + 2 * d + w, v + d, u + 2 * d + w + w, v + d + h]],
]

function entityQuads(spec, texId, mode) {
  const quads = []
  const texW = (spec.tex && spec.tex[0]) || 64
  const texH = (spec.tex && spec.tex[1]) || 32
  for (const part of spec.parts) {
    const pivot = part.pivot || [0, 0, 0]
    const rotation = part.rot || {}
    for (const box of part.boxes) {
      const ox = box.at[0], oy = box.at[1], oz = box.at[2]
      const w = box.w, h = box.h, d = box.d
      const inflate = box.inflate || 0
      const table = modelCorners(ox - inflate, oy - inflate, oz - inflate, ox + w + inflate, oy + h + inflate, oz + d + inflate)
      for (const entry of ENTITY_QUADS) {
        const keys = entry[1]
        const rect = entry[2](box.u, box.v, w, h, d)
        const modelPts = [0, 1, 2, 3].map((i) => place(table[keys.charAt(i)], pivot, rotation))
        const normal = unit(toWorld(cross(sub(modelPts[2], modelPts[1]), sub(modelPts[0], modelPts[1]))))
        const u1 = rect[0], v1 = rect[1], u2 = rect[2], v2 = rect[3]
        const uvs = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]].map((pair) => [pair[0] / texW, pair[1] / texH])
        quads.push({ p: modelPts.map(toWorld), uv: uvs, tex: texId, shade: entityShade(normal), mode: mode })
      }
    }
  }
  return quads
}

function boxOfQuads(quads) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const quad of quads) for (const p of quad.p) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i]
    if (p[i] > max[i]) max[i] = p[i]
  }
  if (!isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] }
  return { min: min, max: max }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + '='
  }
  return out
}

const SQUOTE = String.fromCharCode(39)
const BACKSLASH = String.fromCharCode(92)
const PICK_BEGIN = 'MCART_PICK_BEGIN'
const PICK_END = 'MCART_PICK_END'

function utf16leBase64(text) {
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes.push(code & 255, (code >> 8) & 255)
  }
  return toBase64(Uint8Array.from(bytes))
}

function base64OfString(text) {
  return toBase64(new TextEncoder().encode(String(text)))
}

function quoteRaw(b64) {
  return SQUOTE + b64 + SQUOTE
}

function shellDecoded(value) {
  return '"$(printf %s ' + quoteRaw(base64OfString(value)) + ' | base64 -d)"'
}

function parentOf(path) {
  const normalized = String(path).replace(/[\\/]+$/, '')
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(BACKSLASH))
  if (cut < 0) return null
  if (cut === 0) return '/'
  const head = normalized.slice(0, cut)
  const isDrive = head.length === 2 && head.charAt(1) === ':'
  return isDrive ? head + BACKSLASH : head
}

function betweenMarkers(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const begin = raw.indexOf(PICK_BEGIN)
  const end = raw.lastIndexOf(PICK_END)
  if (begin < 0 || end < 0 || end <= begin) return ''
  return raw.slice(begin + PICK_BEGIN.length, end).trim()
}

function beforeStderr(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const cut = raw.indexOf('[stderr]')
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim()
}

// Forget the extracted blocks nothing holds any more.
//
// Why this is a function of its own: a `ref:` handle is SHARED.  `prismarine`,
// `prismarine_stairs` and `prismarine_slab` all resolve
// `assets/minecraft/textures/block/prismarine.png`, so all three entries carry
// the same `ref:minecraft:block/prismarine` -- and that one handle holds both
// the picture AND the description of how it animates.  Deleting it because ONE
// of the three was dropped took the animation away from the two that survived,
// and a surviving entry is never re-extracted (`referenceLoad` finds its cache
// entry and returns it), so the block kept drawing from the decoder's pixels
// with no `animations` entry -- which shows up as the whole 16x64 strip squashed
// onto every face, permanently, until the plugin is restarted.
//
// So: work out what the SURVIVORS still need first, then delete only what
// nothing holds.  `list:` entries are the namespace listings and are not
// geometry, so they are never dropped here.
function releaseUnused(referenceBlocks, keep, referenceTextures, referenceAnimations) {
  const doomed = []
  for (const key of Array.from(referenceBlocks.keys())) {
    if (key.indexOf('list:') === 0) continue
    if (keep[key] === true) continue
    doomed.push(key)
  }
  const stillUsed = {}
  for (const key of Array.from(referenceBlocks.keys())) {
    if (key.indexOf('list:') === 0) continue
    if (doomed.indexOf(key) >= 0) continue
    const entry = referenceBlocks.get(key)
    if (entry === undefined || entry.load === undefined || entry.load.textures === undefined) continue
    for (const value of entry.load.textures.values()) stillUsed[value] = true
  }
  let dropped = 0
  for (const key of doomed) {
    const entry = referenceBlocks.get(key)
    if (entry !== undefined && entry.load !== undefined && entry.load.textures !== undefined) {
      for (const value of entry.load.textures.values()) {
        if (stillUsed[value] === true) continue
        referenceTextures.delete(value)
        referenceAnimations.delete(value)
      }
    }
    referenceBlocks.delete(key)
    dropped += 1
  }
  let held = 0
  for (const key of referenceBlocks.keys()) if (key.indexOf('list:') !== 0) held += 1
  return { dropped: dropped, held: held }
}

return {
  apply(ctx) {
    // ⚠️ 这三个服务**不能在这里缓存**。宿主半和别的行谁先挂载不由我们决定：冷启动时
    // `ctx.get('shell')` 可能还是 undefined，缓存下来就永久是"没有这个服务"
    // —— 桌面端实测就是这个症状：面板写着「宿主没有 shell 服务，请在下面的输入框里直接填路径」，
    // 而同一份包在别的启动顺序里一切正常（和客户端"重启回左栏"是同一个毛病）。
    // 每次用的时候现取，代价是一次属性查找。
    const fsOf = () => ctx.get('fs')
    const sessionsOf = () => ctx.get('sessions')

    // 最近一次从面板听到的会话 id。`atlas.scene` 不带它，但 `atlas.session`/
    // `atlas.settings` 每一次开面板都会带 —— 通知 agent 时用它找到"这个会话的那个 agent"。

    // 同一件事只通知一次：渲染是每帧跑的，不去重就是刷屏。判据是**报告文本本身**，
    // 所以"修了一半、失败原因变了"会再通知一次，"还是同一个毛病"不会。

    /**
     * 把一条报告投进当前会话那个 agent 的上下文（下一个 step 边界就看见）。
     *
     * 为什么是注入而不是"生成一段话让用户去粘"：模组模型千奇百怪，失败原因只有 agent
     * 自己能判；把它投进上下文，它就能自己决定补模型、改 parent、还是回去问人。
     * 官方路径是 `Agent.steer(UserMessage)`（`dsh-agent-loop` 的 `Agent`），退路是
     * `Agent.inbox.append('next-step', …)`；两样都拿不到就把尝试过的路原样带回去。
     * `UserMessage` 的形状在类型里是 `@deepseek-ai/dsh-llm` 的导出，这里**逐层试**并
     * 如实报告哪一层成的 —— 猜一个形状然后说"发不出去"是最没用的结果。
     */
    const shellOf = () => ctx.get('shell')
    const errors = []
    let preloads = new Map()
    let langs = new Map()
    const indexCache = new Map()
    const textureCache = {}
    // Reference (vanilla / mod) blocks are pulled out of the game's jars on
    // demand and held only while something actually uses them.  Nothing here is
    // ever written to disk.
    const referenceTextures = new Map()
    // How to play each extracted animated texture.  Keyed exactly like
    // `referenceTextures`, because a texture id travels alone through the
    // quads and this is the only thing that can tell the viewer "this one is a
    // 16x80 strip of 5 frames at 5 ticks each".
    const referenceAnimations = new Map()
    const referenceBlocks = new Map()
    const refSignatures = new Map()
    let hasWslpath = null

    function note(message) {
      if (errors.indexOf(message) < 0) errors.push(message)
    }

    const messageOf = (error) => String(error && error.message ? error.message : error)

    // ── 文件系统：先问服务，再问本地 ─────────────────────────────────────────
    //
    // `fs` 和 `shell` 都是**可能缺席**的外部依赖，而面板要干的事（扫描工程、写
    // 贴图、建目录）不该因为"这次启动顺序里没有那个服务"就整个不能用。用户机器上
    // 实测过这个症状（Windows 桌面端 0.2.0-rc.2）：面板能建出工程目录的引导卡、
    // 也能弹系统的目录选择器，但"建目录"那一步只回了一句含糊的
    // 「宿主没有 shell 服务时建不出目录」——而这句话是**猜的**：ensureDir 只看了
    // exitCode，既没看服务在不在，也没把 shell 自己的报错带回来。
    //
    // 所以这一版两条规则：
    //   1. 每一层只报**它自己**的失败原因，不再替别人下结论（错误串里逐个列出）；
    //   2. 每件事都有退路：harness 自己的 API → fs 服务 → shell → node:fs 垫片。
    //
    // node:fs 垫片排在最后是有意的：它绕过宿主那条 sandbox 策略（不产生文件效应
    // 记录、不会触发审批）。前面几条都不可用时才用它，并且结果里会写明 via=node:fs，
    // 用户看得见文件是被哪条路写下去的。
    function localOf() {
      if (typeof nodeFs === 'undefined' || nodeFs === null || nodeFs.available !== true) return null
      return nodeFs
    }

    /**
     * `ctx.subprocess`（宿主层那条与 agent 无关的执行缝）——**面板的主要执行方式**。
     *
     * 为什么不能用 `ctx.shell`：用户桌面端实测（0.2.0-rc.2），`pwsh` 工具在**会话层**跑得好好的
     * （会话日志里 260 次工具调用、0 次 shell 报错），但面板在**宿主层** `ctx.get('shell')`
     * 是 undefined —— 所有探测都回 `exitCode: null`，于是"找不到 Python"里每一项都写着
     * `exit=null`，看的人完全不知道是被执行了没成功，还是根本没被执行的。
     * `subprocess` 不需要 shell：给它 argv，它按绝对路径起进程。桌面版自带的那份 Python
     * 就是这么能跑起来的（它压根不在 PATH 里）。
     */
    const subprocessOf = () => ctx.get('subprocess')

    /**
     * 给"可能永远不返回"的调用兜一个期限。
     *
     * 为什么在**宿主**这半边做：客户端不许碰浏览器计时器（动态插件沙箱里没有
     * setTimeout，碰了整个页签会崩 —— `tools/mcart-plugin/anim-test.js` 钉的就是这条），
     * 而宿主半有 `ctx.timer`。所以"目录对话框弹不出来、也永不返回"这件事由宿主负责
     * 回一个 supported:false（而不是让面板的按钮永久停在"对话框已打开…"）。
     */
    async function withDeadline(run, ms) {
      const timer = ctx.get('timer')
      if (timer === undefined || typeof timer.timeout !== 'function') return await run()
      let timeout = false
      const deadline = new Promise((resolve) => {
        timer.timeout(() => { timeout = true; resolve() }, ms)
      })
      const finished = Promise.resolve().then(run).then((value) => ({ value: value }), (error) => ({ error: error }))
      const winner = await Promise.race([finished, deadline.then(() => ({ deadline: true }))])
      if (winner.deadline === true) return { deadlineExpired: true }
      if (winner.error !== undefined) throw winner.error
      return winner.value
    }

    /** 起一个进程并收输出；`null` = 这个运行时装不下 subprocess 那条路。 */
    async function runProcess(argv, options) {
      const settings = options || {}
      const service = subprocessOf()
      if (service === undefined || typeof service.spawn !== 'function') return null
      const maxBytes = settings.maxBytes === undefined ? 1024 * 1024 : settings.maxBytes
      const collect = { maxBytes: maxBytes }
      let handle = null
      try {
        handle = service.spawn({
          argv: argv,
          cwd: settings.cwd === undefined || settings.cwd === '' ? '.' : settings.cwd,
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs: settings.graceMs === undefined ? 5000 : settings.graceMs,
        })
      } catch (error) {
        return { exitCode: null, text: '', err: 'subprocess.spawn 失败：' + messageOf(error), via: 'subprocess' }
      }
      let exitCode = null
      try {
        const done = await handle.done
        exitCode = done === undefined || done === null || done.exitCode === undefined ? null : done.exitCode
      } catch (error) {
        exitCode = null
      }
      const read = (reader) => {
        try { return reader === undefined ? '' : String(reader.readFrom(0).text) } catch (error) { return '' }
      }
      const collected = handle.collected || {}
      return { exitCode: exitCode, text: read(collected.stdout), err: read(collected.stderr), via: 'subprocess' }
    }

    /** 让 subprocess 在同一条执行世界里解析一个可执行名（PATH 由它负责）。 */
    async function resolveExecutable(name) {
      const service = subprocessOf()
      if (service === undefined || typeof service.resolveExecutable !== 'function') return null
      try {
        const found = await service.resolveExecutable(name)
        return typeof found === 'string' && found !== '' ? found : null
      } catch (error) { return null }
    }

    const isPathLike = (value) => String(value).indexOf('/') >= 0 || String(value).indexOf(BACKSLASH) >= 0

    function policyFor(workspaceRoot) {
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined
      return { mode: 'workspace-write', workspaceRoot: workspaceRoot }
    }

    function labelFor(namespace, kind, id) {
      const table = langs.get(namespace)
      if (table === undefined) return id
      const tries = []
      if (kind === 'project') tries.push('mc-art.project.' + namespace)
      else if (kind === 'structure') tries.push('mc-art.structure.' + namespace + '.' + id, 'structure.' + namespace + '.' + id)
      else tries.push(kind + '.' + namespace + '.' + id)
      for (const key of tries) {
        const found = table[key]
        if (typeof found === 'string' && found.length > 0) return found
      }
      return id
    }

    function rel(root, absolute) {
      const prefix = root.charAt(root.length - 1) === '/' ? root : root + '/'
      return absolute.indexOf(prefix) === 0 ? absolute.slice(prefix.length) : absolute
    }

    /** 这一层是不是一个目录（服务在就只问服务；服务不在才问本地）。 */
    async function isDirectoryOf(path) {
      const info = await statOf(path)
      return info !== undefined && info.type === 'directory'
    }

    async function listDir(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          if (info === undefined || info.type !== 'directory') return []
          return await fs.listDir(target)
        } catch (error) { return [] }
      }
      const local = localOf()
      return local === null ? [] : await local.listDir(path)
    }

    async function readJson(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          if (info === undefined || info.type !== 'file') return undefined
          return JSON.parse(await fs.readText(target))
        } catch (error) { return undefined }
      }
      const local = localOf()
      if (local === null) return undefined
      const text = await local.readText(path)
      if (typeof text !== 'string') return undefined
      try { return JSON.parse(text) } catch (error) { return undefined }
    }

    async function statOf(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.stat(target)
        } catch (error) { return undefined }
      }
      const local = localOf()
      return local === null ? undefined : await local.stat(path)
    }

    /** 读原始字节（贴图校验、预览）：fs 服务没有二进制读的替代品，但本地垫片有。 */
    async function readBytesOf(path, maxBytes) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.readBytes(target, undefined, maxBytes)
        } catch (error) { /* 落到本地垫片 */ }
      }
      const local = localOf()
      return local === null ? undefined : await local.readBytes(path, maxBytes)
    }

    async function dirSignature(path) {
      const entries = await listDir(path)
      const parts = []
      for (const entry of entries) {
        parts.push(entry.name + ':' + (entry.version === undefined ? '-' : String(entry.version)) + ':' + (entry.size === undefined ? '-' : String(entry.size)))
      }
      parts.sort()
      return parts.join(',')
    }

    async function signatureOf(root) {
      const pieces = []
      const top = await listDir(root)
      for (const entry of top) {
        if (entry.type !== 'directory' || entry.name.charAt(0) === '.') continue
        const dir = root + '/' + entry.name
        const atlasInfo = await statOf(dir + '/mc-art.atlas.json')
        pieces.push('A' + entry.name + ':' + (atlasInfo === undefined ? 'none' : String(atlasInfo.version) + ':' + String(atlasInfo.size)))
        const assets = await listDir(dir + '/pack/assets')
        for (const ns of assets) {
          if (ns.type !== 'directory') continue
          const base = dir + '/pack/assets/' + ns.name
          pieces.push(await dirSignature(base + '/blockstates'))
          pieces.push(await dirSignature(base + '/models/block'))
          pieces.push(await dirSignature(base + '/lang'))
          for (const kind of ['block', 'blocks', 'entity', 'item']) pieces.push(await dirSignature(base + '/textures/' + kind))
        }
      }
      return pieces.join('|')
    }

    async function textureUrl(path) {
      const info = await statOf(path)
      if (info === undefined || info.type !== 'file') return undefined
      const key = path + '@' + String(info.version) + ':' + String(info.size)
      if (textureCache[key] !== undefined) return textureCache[key]
      try {
        const bytes = await readBytesOf(path, 8 * 1024 * 1024)
        if (bytes === undefined) return undefined
        const url = 'data:image/png;base64,' + toBase64(bytes)
        textureCache[key] = url
        return url
      } catch (error) { return undefined }
    }

    // A texture handle is either a file path (a project's own pack) or a
    // `ref:` key into what was already extracted from a jar.  One dispatcher, so
    // no caller has to know which kind it is holding.
    async function textureUrlFor(entry) {
      if (typeof entry !== 'string' || entry === '') return undefined
      if (entry.slice(0, 4) === 'ref:') return referenceTextures.get(entry)
      return await textureUrl(entry)
    }

    // Animated textures are the ONE thing a texture id alone cannot describe.
    // Every payload that ships texture URLs ships this beside them, so the
    // viewer animates whatever it was actually given instead of a list of
    // block names somebody kept up to date by hand.
    function animationsFor(ids) {
      const out = {}
      for (const id of ids) {
        const animation = referenceAnimations.get(id)
        if (animation !== undefined) out[id] = animation
      }
      return out
    }

    async function preload(dir, namespace) {
      const assets = dir + '/pack/assets/' + namespace
      const models = new Map()
      for (const entry of await listDir(assets + '/models/block')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const parsed = await readJson(assets + '/models/block/' + entry.name)
        if (parsed !== undefined) models.set('block/' + entry.name.replace(/\.json$/, ''), parsed)
      }
      const textures = new Map()
      for (const kind of ['block', 'blocks', 'entity', 'item']) {
        for (const entry of await listDir(assets + '/textures/' + kind)) {
          if (entry.type !== 'file' || !/\.png$/.test(entry.name)) continue
          textures.set(namespace + ':' + kind + '/' + entry.name.replace(/\.png$/, ''),
            assets + '/textures/' + kind + '/' + entry.name)
        }
      }
      return { dir: dir, namespace: namespace, assets: assets, models: models, textures: textures }
    }

    async function readLang(assets) {
      const merged = {}
      for (const locale of ['en_us', 'zh_cn']) {
        const parsed = await readJson(assets + '/lang/' + locale + '.json')
        if (parsed === undefined || parsed === null || typeof parsed !== 'object') continue
        for (const key of Object.keys(parsed)) {
          const value = parsed[key]
          if (typeof value === 'string' && value.length > 0) merged[key] = value
        }
      }
      return merged
    }

    function texturePath(load, reference) {
      let name = String(reference === undefined ? '' : reference)
      let namespace = load.namespace
      const colon = name.indexOf(':')
      if (colon >= 0) { namespace = name.slice(0, colon); name = name.slice(colon + 1) }
      const own = load.textures.get(namespace + ':' + name)
      if (own !== undefined) return own
      const other = preloads.get(namespace)
      return other === undefined ? undefined : other.textures.get(namespace + ':' + name)
    }

    function elementsOf(load, modelName, extra) {
      let key = modelName
      const colon = key.indexOf(':')
      if (colon >= 0) key = key.slice(colon + 1)
      const model = load.models.get(key) || (extra === undefined ? undefined : extra.get(key))
      if (model === undefined) return undefined
      return resolveBlockModel(model, (id) => {
        let parentKey = id
        const c = parentKey.indexOf(':')
        if (c >= 0) parentKey = parentKey.slice(c + 1)
        const own = load.models.get(parentKey)
        if (own !== undefined) return own
        if (extra === undefined) return undefined
        // 现取回来的那份表按 `minecraft:block/x` 存，查的时候带不带命名空间都要能命中。
        return extra.get(id) || extra.get(parentKey) || extra.get('minecraft:' + parentKey)
      }, (reference) => texturePath(load, reference))
    }

    // 现取回来的原版模型，按"参考目录签名 + 名字"缓存。签名变了（换了版本目录）自然失效。
    const vanillaModels = new Map()

    /**
     * 项目模型链里"项目包没有、内置表也没有"的那几个原版母模型。
     *
     * 面板内置的原版母模型表只有 7 条（cube/cross 那几种），而楼梯、台阶、墙、栅栏、
     * 门、活板门、梯子、压力板、按钮继承的原版母模型都不在里面 —— 用户实测：43 个方块
     * 只能画出 16 个。这里不再靠那张手抄表：缺什么就去参考目录的 jar 里现取什么。
     */
    function missingParents(load, modelName, extra, out) {
      const seen = {}
      let key = String(modelName === undefined ? '' : modelName)
      let colon = key.indexOf(':')
      if (colon >= 0) key = key.slice(colon + 1)
      for (let depth = 0; depth < 12; depth++) {
        const model = load.models.get(key) || (extra === undefined ? undefined : extra.get(key))
        if (model === undefined) { if (key !== '') out.push(key); return }
        const parent = model.parent
        if (typeof parent !== 'string' || parent === '' || seen[parent] === true) return
        seen[parent] = true
        const bare = parent.indexOf(':') >= 0 ? parent.slice(parent.indexOf(':') + 1) : parent
        if (load.models.get(bare) !== undefined) { key = bare; continue }
        if (extra !== undefined && (extra.get(bare) !== undefined || extra.get(parent) !== undefined)) { key = bare; continue }
        // 内置表里有就还用内置的（省一次进程），没有才记为"要去 jar 里取"。
        if (VANILLA_PARENTS[parent] !== undefined || VANILLA_PARENTS[bare] !== undefined) return
        out.push(bare.indexOf('block/') === 0 || bare.indexOf('/') > 0 ? bare : bare)
        return
      }
    }

    async function fetchVanillaModels(project, names) {
      const directory = await referenceDirectory(project)
      if (directory === '') return { models: new Map(), why: '这台机器上还没有设置参考目录（面板设置里指到 .minecraft/versions/<版本>）' }
      const signature = await refSignatureOf(directory)
      const want = []
      for (const name of names) {
        const cached = vanillaModels.get(signature + '|' + name)
        if (cached === undefined) want.push(name)
        else if (cached !== null) want.push(name)      // 命中缓存，下面照旧装进 out
      }
      if (want.length > 0) {
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { models: new Map(), why: '找不到 ' + EXTRACT_SCRIPT }
        const parsed = await runScanner(extractor, ['--root', directory, '--model', want.join(',')],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { models: new Map(), why: String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error) }
        }
        for (const key of Object.keys(parsed.models || {})) {
          // 抽取器回的是 `minecraft:block/slab`，而调用方问的是 `block/slab` ——
          // 两个名字都存一份，不然查不到，表现成"取回来了却还是画不出来"。
          const bare = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : key
          vanillaModels.set(signature + '|' + key, parsed.models[key])
          vanillaModels.set(signature + '|' + bare, parsed.models[key])
        }
        for (const name of want) {
          if (vanillaModels.get(signature + '|' + name) === undefined) vanillaModels.set(signature + '|' + name, null)
        }
      }
      const out = new Map()
      for (const name of names) {
        const hit = vanillaModels.get(signature + '|' + name)
        if (hit !== undefined && hit !== null) out.set(name, hit)
      }
      return { models: out, why: '' }
    }

    /** 把项目模型解成元素：缺的原版母模型先去 jar 里取，取不到就带着原因回来。 */
    async function projectElements(project, load, modelName) {
      const extra = new Map()
      const gaps = []
      for (let round = 0; round < 4; round++) {
        const need = []
        missingParents(load, modelName, extra, need)
        if (need.length === 0) return { elements: elementsOf(load, modelName, extra), extra: extra, gaps: gaps }
        const fetched = await fetchVanillaModels(project, need)
        if (fetched.models.size === 0) { gaps.push({ names: need, why: fetched.why }); return { elements: undefined, extra: extra, gaps: gaps } }
        for (const pair of fetched.models.entries()) extra.set(pair[0], pair[1])
      }
      return { elements: elementsOf(load, modelName, extra), extra: extra, gaps: gaps }
    }

    async function blockIds(load) {
      const out = []
      for (const entry of await listDir(load.assets + '/blockstates')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const id = entry.name.replace(/\.json$/, '')
        const state = await readJson(load.assets + '/blockstates/' + entry.name)
        // 默认按"每个方块一个模型文件"来猜：`models/block/<id>.json`。
        // 以前这里是裸 id（`mist_fence`），而模型表里的键是 `block/mist_fence` ——
        // 于是**所有 multipart 方块**（墙、栅栏、门…）都报"项目包里没有这个文件"。
        // 默认按"每个方块一个模型文件"来猜：`models/block/<id>.json`。
        // 以前这里是裸 id（`mist_fence`），而模型表里的键是 `block/mist_fence` —— 于是
        // **所有 multipart 方块**（墙、栅栏、门…）都报"项目包里没有这个文件"。
        let model = 'block/' + id
        if (state !== undefined && state.variants !== undefined) {
          const keys = Object.keys(state.variants)
          if (keys.length > 0) {
            let value = state.variants[keys[0]]
            if (Array.isArray(value)) value = value[0]
            if (value !== undefined && typeof value.model === 'string') model = value.model
          }
        }

        out.push({ id: id, model: model })
      }
      return out
    }

    async function build(root) {
      const staged = []
      const nextPreloads = new Map()
      const nextLangs = new Map()
      for (const entry of await listDir(root)) {
        if (entry.type !== 'directory' || entry.name.charAt(0) === '.') continue
        const dir = root + '/' + entry.name
        const atlas = await readJson(dir + '/mc-art.atlas.json')
        const assets = await listDir(dir + '/pack/assets')
        const namespaces = []
        for (const candidate of assets) if (candidate.type === 'directory') namespaces.push(candidate.name)
        if (namespaces.length === 0 && atlas === undefined) continue
        const namespace = (atlas && typeof atlas.namespace === 'string' && namespaces.indexOf(atlas.namespace) >= 0)
          ? atlas.namespace : namespaces[0]
        if (namespace === undefined) continue
        const load = await preload(dir, namespace)
        nextPreloads.set(namespace, load)
        nextLangs.set(namespace, await readLang(load.assets))
        staged.push({ entry: entry.name, dir: dir, atlas: atlas, namespace: namespace, load: load })
      }
      preloads = nextPreloads
      langs = nextLangs

      const projects = []
      for (const item of staged) {
        const namespace = item.namespace
        const atlas = item.atlas
        const blocks = []
        for (const block of await blockIds(item.load)) {
          blocks.push({ id: block.id, title: labelFor(namespace, 'block', block.id) })
        }
        projects.push({
          id: item.entry, title: labelFor(namespace, 'project', item.entry),
          namespace: namespace, root: root, dir: item.dir, blocks: blocks,
          entities: (atlas && atlas.entities ? atlas.entities : []).map((e) => ({ id: e.id, title: labelFor(namespace, 'entity', e.id) })),
          biomes: (atlas && atlas.biomes ? atlas.biomes : []).map((b) => ({ id: b.id, title: labelFor(namespace, 'biome', b.id) })),
          structures: (atlas && atlas.structures ? atlas.structures : []).map((s) => ({ id: s.id, title: labelFor(namespace, 'structure', s.id) })),
        })
      }
      return { projects: projects, preloads: nextPreloads, langs: nextLangs }
    }

    async function indexOf(root) {
      const signature = await signatureOf(root)
      const cached = indexCache.get(root)
      if (cached !== undefined && cached.signature === signature) {
        preloads = cached.preloads
        langs = cached.langs
        return { projects: cached.projects, cached: true }
      }
      const built = await build(root)
      indexCache.set(root, { signature: signature, projects: built.projects, preloads: built.preloads, langs: built.langs })
      return { projects: built.projects, cached: false }
    }

    async function projectFor(root, projectId) {
      if (root === '' || projectId === '') return undefined
      const index = await indexOf(root)
      return index.projects.filter((item) => item.id === projectId)[0]
    }

    async function looksLikeProject(dir) {
      if ((await statOf(dir + '/mc-art.atlas.json')) !== undefined) return true
      const assets = await listDir(dir + '/pack/assets')
      return assets.length > 0
    }

    // Where does a reference root actually keep its assets?  Not in one shape.
    // For 1.12.2 the vanilla textures live INSIDE the version jar -- that
    // assets/index.json has zero entries under minecraft/textures/block/ -- and
    // Forge keeps every mod in versions/<version>/mods/<name>.jar.  So "scan the
    // reference" means "read jars", and tools/mcart_scan_refs.py is the single
    // implementation of that.  This side only locates it and calls it.
    const SCAN_SCRIPT = 'tools/mcart_scan_refs.py'
    const EXTRACT_SCRIPT = 'tools/mcart_extract_block.py'
    // A whole namespace of blocks is ~190 KB of JSON, and 72 icons ~40 KB.
    const REFERENCE_MAX_BYTES = 8 * 1024 * 1024
    // Both tools live in the same repository, so they share one upward search
    // instead of two that could disagree about where the repo root is.
    const toolPaths = new Map()

    async function findTool(start, relative) {
      if (toolPaths.has(relative)) return toolPaths.get(relative)
      let at = String(start === undefined || start === null ? '' : start)
      while (at.length > 1 && (at.charAt(at.length - 1) === '/' || at.charAt(at.length - 1) === BACKSLASH)) {
        at = at.slice(0, at.length - 1)
      }
      let found = null
      for (let depth = 0; depth < 5 && at !== ''; depth++) {
        const info = await statOf(at + '/' + relative)
        if (info !== undefined && info.type === 'file') { found = at + '/' + relative; break }
        at = parentOf(at) || ''
      }
      // 项目目录往上找不到时，再问**包自己带的**那份和用户的 skills 目录。
      //
      // 为什么必须这样：这两个脚本原来只从项目目录往上找 5 层 —— 于是"项目不在 mc-art
      // 仓库里"的机器上，参考目录整条路都是死的：设置存得下，但什么也读不出来
      // （用户实测："那个用它根本用不了"）。而面板包里**本来就带着**一份完整引擎
      // （preset/mc-studio/skills/mc-art/tools/…），pnpm 把它装在 profile 的
      // node_modules 里，是真文件、Python 读得到。
      if (found === null) {
        for (const candidate of skillToolCandidates(relative)) {
          const info = await statOf(candidate)
          if (info !== undefined && info.type === 'file') { found = candidate; break }
        }
      }
      toolPaths.set(relative, found)
      return found
    }

    async function findScanner(start) { return await findTool(start, SCAN_SCRIPT) }

    /** 包自带的引擎 / 用户 skills 目录里的脚本候选（顺序 = 优先次序）。 */
    function skillToolCandidates(relative) {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      const dir = moduleDirOf()
      if (dir !== '') {
        const pkg = parentOf(dir) || ''                       // <包>/lib → <包>
        const above = pkg === '' ? '' : (parentOf(pkg) || '')  // <包> → profile / 仓库根
        const base = relative.slice(relative.lastIndexOf('/') + 1)
        // **随包的那份**：<包>/python/mcart_scan_refs.py —— 安装后的正常形态，也是唯一
        // 保证"别人的机器上也有"的那一份。两个脚本只依赖标准库，所以随包带一份就够
        // （原来是"项目必须恰好在仓库里"才找得到；verify-build 会挡住它和仓库里那份漂移）。
        push(pkg + '/python/' + base)
        push(above + '/python/' + base)
        // 在仓库里直接跑的形态（最后兜底：本仓库根目录下的 tools/）
        push(above + '/' + relative)
        // 旧形态：万一有人把引擎放在 skill 目录里
        push(pkg + '/preset/mc-studio/skills/mc-art/' + relative)
        push(above + '/preset/mc-studio/skills/mc-art/' + relative)
        push(above + '/skills/mc-art/' + relative)
      }
      const named = envOf('MC_ART_SKILL_DIR')
      if (named !== '') push(named + '/' + relative)
      const home = envOf('USERPROFILE') || envOf('HOME')
      const dshHome = envOf('DSH_HOME') || (home === '' ? '' : home + '/.dsh')
      if (dshHome !== '') push(dshHome + '/skills/mc-art/' + relative)
      if (home !== '') push(home + '/.agents/skills/mc-art/' + relative)
      return out
    }

    // Which Python?  The extractor used to be launched as a hard-coded `python3`,
    // and that single word is what made the whole reference path (blocks, items,
    // icons, namespaces) die on a Windows machine: the interpreter there is
    // `python.exe` or the `py` launcher -- there is no `python3`.
    //
    // The shell service is `bash -c` on every platform, so a probe is the honest
    // way to ask: run the candidate and see whether it answers.  A working answer
    // is cached for the life of the plugin; a total failure is NOT cached, so a
    // machine where Python gets installed mid-session recovers on the next call.
    const PYTHON_CANDIDATES = ['python3', 'python', 'py -3']
    let pythonLauncher = ''
    let pythonExe = ''        // 原样的可执行（subprocess 用 argv，shell 用转义过的 launcher）
    let pythonVia = null      // 'subprocess' | 'shell' —— 出错时要说清走的哪条
    let pythonWhy = null

    /**
     * 捆绑运行时（桌面端自带的那份 Python）。
     *
     * 桌面 app 把 Python 3.12 + numpy/Pillow/… 放在 `<resources>/runtime/primary-runtime/
     * dependencies/python/` 里，**但不进 PATH**（`desktopNodeEnvironment` 给子进程前置的
     * 只有 node/bin）。它给模型看的那条路是一个工具（workspace-dependencies），宿主插件
     * 拿不到 —— 所以这里按桌面端自己用的那几个位置推：环境变量、DSH_HOME 下的安装位、
     * 以及从本模块路径推出来的 resources 目录。
     */
    function bundledPythonDirs() {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      push(envOf('DSH_DESKTOP_PRIMARY_RUNTIME_DIR'))
      // 桌面端把"运行时目录"当 argv 传给 dsh-desktop-host（它自己也是这么找 python 的）。
      if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
        for (const value of process.argv) {
          if (typeof value === 'string' && /(^|[\\/])runtime[\\/]primary-runtime$/.test(value)) push(value)
        }
      }
      // 宿主进程就是 Electron（ELECTRON_RUN_AS_NODE）：<app>/resources/runtime/primary-runtime。
      if (typeof process !== 'undefined' && typeof process.execPath === 'string' && process.execPath !== '') {
        const exeDir = parentOf(process.execPath.split(BACKSLASH).join('/')) || ''
        if (exeDir !== '') push(exeDir + '/resources/runtime/primary-runtime')
      }
      const home = envOf('USERPROFILE') || envOf('HOME')
      const dshHome = envOf('DSH_HOME') || (home === '' ? '' : home + '/.dsh')
      if (dshHome !== '') {
        push(dshHome + '/dsh-runtimes/dsh-primary-runtime')
        push(dshHome + '/dsh-runtimes/dsh-primary-runtime/dependencies')
      }
      const dir = moduleDirOf()
      if (dir !== '') {
        // <resources>/app.asar/dsh/node_modules/<包>/lib → <resources>
        const pkg = parentOf(dir) || ''
        const profile = pkg === '' ? '' : (parentOf(pkg) || '')
        const appDsh = profile === '' ? '' : (parentOf(profile) || '')
        const resources = appDsh === '' ? '' : (parentOf(appDsh) || '')
        if (resources !== '') {
          push(resources + '/runtime/primary-runtime')
          push(resources + '/runtime/primary-runtime/dependencies')
        }
      }
      return out
    }

    /** 候选解释器：环境变量 → 系统 PATH → 桌面端自带的那份。 */
    function pythonCandidates() {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        if (out.indexOf(value) < 0) out.push(value)
      }
      push(envOf('MC_ART_PYTHON'))
      for (const name of PYTHON_CANDIDATES) push(name)
      for (const dir of bundledPythonDirs()) {
        push(dir + '/python/python.exe')    // Windows: dependencies/python/python.exe
        push(dir + '/python/bin/python3')   // POSIX:    dependencies/python/bin/python3
        push(dir + '/python/bin/python')
      }
      return out
    }

    async function resolvePython(workspaceRoot) {
      if (pythonLauncher !== '') return pythonLauncher
      const dialect = await currentShell(workspaceRoot)
      const tried = []
      for (const candidate of pythonCandidates()) {
        const pathLike = isPathLike(candidate)
        // 第一条：subprocess + argv。绝对路径直接用；裸名字先让它解析 PATH。
        if (pathLike || subprocessOf() !== undefined) {
          const exe = pathLike ? candidate : await resolveExecutable(candidate)
          if (exe !== null) {
            const done = await runProcess([exe, '-c', 'print(1)'], { maxBytes: 4096 })
            if (done !== null) {
              if (done.exitCode === 0 && String(done.text).trim() === '1') {
                pythonExe = exe
                pythonVia = 'subprocess'
                pythonLauncher = exe
                return pythonLauncher
              }
              tried.push(candidate + '(subprocess exit=' + String(done.exitCode) +
                (String(done.err).trim() === '' ? '' : ' ' + String(done.err).trim().slice(0, 60)) + ')')
              continue
            }
          }
        }
        // 第二条：shell（老路；服务不在时 exitCode 是 null —— 把这个事实也写进去）
        const command = (pathLike ? dialect.word(candidate) : candidate) + ' -c "print(1)"'
        const probe = await runShell(command, 20000, policyFor(workspaceRoot), 4096)
        if (probe.exitCode === 0 && String(probe.text).trim() === '1') {
          pythonExe = candidate
          pythonVia = 'shell'
          pythonLauncher = pathLike ? dialect.word(candidate) : candidate
          return pythonLauncher
        }
        tried.push(candidate + '(shell exit=' + String(probe.exitCode) +
          (String(probe.err).trim() === '' ? '' : ' ' + String(probe.err).trim().slice(0, 60)) + ')')
      }
      pythonWhy = tried.join('、')
      return null
    }

    /** The launcher for a message the user reads, without probing. */
    function pythonHint() {
      return pythonLauncher === '' ? PYTHON_CANDIDATES[0] : pythonLauncher
    }

    // 参数一律当作**原始字符串数组**交进来，只在这里按方言转义——转义点只有这一个，
    // 就不会出现"某处漏了引号，Windows 上把带空格的路径拆成两个参数"这种事。
    async function runScanner(scanner, tokens, timeoutMs, workspaceRoot, maxBytes) {
      const python = await resolvePython(workspaceRoot)
      if (python === null) {
        return { error: '找不到 Python（试过 ' + String(pythonWhy) +
          '）。抽取器是 Python 写的；桌面版自带的那份在 <resources>/runtime/primary-runtime/' +
          'dependencies/python/python.exe，也可以用 MC_ART_PYTHON 指定一个。' }
      }
      // 有 subprocess 就**按 argv 起**：没有 shell、没有引号、没有方言问题
      // （Windows 的路径里有空格时，这一条比拼命令行可靠得多）。
      if (pythonVia === 'subprocess' && pythonExe !== '') {
        // `-X utf8`：Windows 上 Python 的 stdio 默认是系统区域编码（GBK），
        // 而我们按 UTF-8 解它的输出 —— 中文名字会变成 `����ʯ`（用户实测）。
        // 脚本自己也把 stdout 钉成 UTF-8（reconfigure），这里是第二层。
        const argv = [pythonExe, '-X', 'utf8', scanner].concat(tokens === undefined ? [] : tokens)
        const done = await runProcess(argv, { cwd: workspaceRoot, maxBytes: maxBytes === undefined ? 8 * 1024 * 1024 : maxBytes })
        if (done !== null) {
          if (done.exitCode !== 0) {
            const detail = beforeStderr(done.err === undefined || done.err === null ? '' : done.err)
            return { error: '扫描脚本退出码 ' + done.exitCode + (detail === '' ? '，没有任何错误输出' : '：' + detail) }
          }
          try {
            return JSON.parse(beforeStderr(done.text))
          } catch (error) {
            return { error: '扫描脚本的输出不是 JSON：' + String(done.text).slice(0, 200) }
          }
        }
      }
      const dialect = await currentShell(workspaceRoot)
      const argument = (tokens === undefined ? [] : tokens).map((token) => dialect.word(token)).join(' ')
      const result = await runShell(python + ' -X utf8 ' + dialect.word(scanner) +
        (argument === '' ? '' : ' ' + argument), timeoutMs, policyFor(workspaceRoot), maxBytes)
      if (result.exitCode !== 0) {
        const detail = beforeStderr(result.err === undefined || result.err === null ? '' : result.err)
        return { error: '扫描脚本退出码 ' + result.exitCode + (detail === '' ? '，没有任何错误输出' : '：' + detail) }
      }
      try {
        return JSON.parse(beforeStderr(result.text))
      } catch (error) {
        return { error: '扫描脚本的输出不是 JSON：' + String(result.text).slice(0, 200) }
      }
    }

    // Add or remove a jar and this changes, so the scan is re-run; otherwise the
    // answer is reused instead of opening 29 jars every time the panel opens.
    async function referenceSignature(dir) {
      const pieces = [await dirSignature(dir), await dirSignature(dir + '/mods'), await dirSignature(dir + '/assets')]
      for (const version of await listDir(dir + '/versions')) {
        if (version.type !== 'directory') continue
        pieces.push(version.name)
        pieces.push(await dirSignature(dir + '/versions/' + version.name))
        pieces.push(await dirSignature(dir + '/versions/' + version.name + '/mods'))
      }
      return pieces.join('|')
    }

    const scanCache = new Map()
    async function scanReference(scanner, dir) {
      const empty = { root: dir, shape: '', namespaces: [], sources: [], textures: 0, error: null }
      if (dir === '') return empty
      if (scanner === null || scanner === undefined) {
        return Object.assign({}, empty, { error: '找不到扫描脚本 ' + SCAN_SCRIPT + '（从项目目录往上找了 5 层都没有）。' })
      }
      const signature = await referenceSignature(dir)
      const cached = scanCache.get(dir)
      if (cached !== undefined && cached.signature === signature) return cached.result
      const parsed = await runScanner(scanner, [dir], 180000, dir)
      if (parsed.error !== undefined) return Object.assign({}, empty, { error: String(parsed.error) })
      const result = { root: parsed.root, shape: parsed.shape || '', namespaces: parsed.namespaces || [],
        sources: parsed.sources || [], textures: parsed.textures || 0, error: null }
      scanCache.set(dir, { signature: signature, result: result })
      return result
    }

    // Where might a Minecraft installation be?  Asked of the filesystem, not of
    // the shell: fs reads behave the same on Windows, WSL and Linux.  Nothing is
    // invented -- a candidate is listed only because it exists on disk, and an
    // unreadable parent simply yields no candidates instead of a guess.
    // ── 参考目录的候选：**只靠 fs**，按平台给候选，再 stat 掉不存在的 ────────────
    //
    // 这一段原来是 WSL 形状的：只看 `/root/.minecraft`、`/mnt/c/Users/<user>/…`、
    // `/home/<user>/…`。在原生 Windows 上它一条都不成立 —— 于是设置页"检测到 … 用它"
    // 那一栏永远是空的，而"选择目录…"在某些环境里根本弹不出来（shell 服务跑在非交互
    // 窗口站上时，FolderBrowserDialog 既不显示也不返回），于是用户点开设置，
    // **没有任何办法指定参考目录**，界面上也没有一句话解释。
    // 现在：平台候选（Windows/macOS/Linux）+ 工程旁边 + 实例目录展开一层，逐个 stat。
    const envOf = (name) => {
      if (typeof process === 'undefined' || process.env === undefined) return ''
      const value = process.env[name]
      return typeof value === 'string' ? value : ''
    }

    /** 平台：`process.platform`，问不到就空串（动态插件那种环境）。 */
    function platformOf() {
      if (typeof process === 'undefined' || process === null) return ''
      return typeof process.platform === 'string' ? process.platform : ''
    }

    /** 本模块所在目录（<包>/lib）——随包的那份引擎、以及捆绑运行时都从这里推。 */
    function moduleDirOf() {
      if (typeof moduleDir !== 'undefined' && typeof moduleDir === 'string') return moduleDir
      return ''
    }

    /** 纯函数：按环境给候选（不碰盘），好单独测。 */
    function gameRootCandidates(near) {
      const home = envOf('USERPROFILE') || envOf('HOME')
      const roaming = envOf('APPDATA') || (home === '' ? '' : home + '/AppData/Roaming')
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      // 标准安装位置：Windows 是 %APPDATA%\.minecraft，macOS 是
      // ~/Library/Application Support/minecraft，Linux 是 ~/.minecraft。
      push(roaming === '' ? '' : roaming + '/.minecraft')
      push(home === '' ? '' : home + '/.minecraft')
      push(home === '' ? '' : home + '/Library/Application Support/minecraft')
      push(roaming === '' ? '' : roaming + '/com.mojang/minecraft')
      // 第三方启动器的实例目录（它们是**容器**，真正的游戏目录在子目录里）。
      push(home === '' ? '' : home + '/curseforge/minecraft/Instances')
      push(roaming === '' ? '' : roaming + '/PrismLauncher/instances')
      push(roaming === '' ? '' : roaming + '/MultiMC/instances')
      // 就在工程旁边：模组开发工作区常见 `<repo>/.minecraft`、`<repo>/run`。
      const here = typeof near === 'string' ? near : ''
      for (const base of [here, parentOf(here)]) {
        if (typeof base !== 'string' || base === '') continue
        push(base + '/.minecraft')
        push(base + '/run')
      }
      // WSL 里也能看 Windows 那一侧（旧行为里唯一在 WSL 上真有用的那条）。
      push('/root/.minecraft')
      return out
    }

    const INSTANCE_DIR = /(Instances|instances)$/
    async function looksLikeGameRoot(path) {
      for (const marker of ['versions', 'mods', 'assets', 'config']) {
        const info = await statOf(path + '/' + marker)
        if (info !== undefined && info.type === 'directory') return true
      }
      return false
    }

    async function detectGameRoots(near) {
      const candidates = gameRootCandidates(near)
      const out = []
      const consider = async (path) => {
        const info = await statOf(path)
        if (info === undefined || info.type !== 'directory' || out.indexOf(path) >= 0) return false
        out.push(path)
        return true
      }
      // WSL：Windows 侧的用户目录（原生 Windows 上这一步自然什么也列不出来）。
      if ((typeof process === 'undefined' ? '' : process.platform) !== 'win32') {
        const skip = { Public: true, Default: true, 'Default User': true, 'All Users': true }
        for (const user of (await listDir('/mnt/c/Users')).slice(0, 8)) {
          if (user.type !== 'directory' || skip[user.name] === true) continue
          candidates.push('/mnt/c/Users/' + user.name + '/AppData/Roaming/.minecraft')
        }
      }
      for (const candidate of candidates.slice(0, 32)) {
        if (out.length >= 5) break
        if (!(await consider(candidate))) continue
        if (out.length >= 5 || !INSTANCE_DIR.test(candidate)) continue
        // 实例容器：真正的游戏目录是子目录，认容器自己没用 —— 展开一层。
        for (const child of (await listDir(candidate)).slice(0, 40)) {
          if (out.length >= 5) break
          if (child.type !== 'directory') continue
          const childPath = candidate + '/' + child.name
          if (await looksLikeGameRoot(childPath)) await consider(childPath)
        }
      }
      return out
    }

    async function ensure(namespace) {
      if (preloads.has(namespace)) return preloads.get(namespace)
      for (const other of preloads.values()) if (other.namespace === namespace) return other
      return undefined
    }

    // A manual edit arrives as a whole cell list, so the viewer can render the
    // result before anything is written back.  Everything is re-validated here:
    // the browser is not the authority on what a cell is.
    function normalizeCells(input) {
      const out = []
      if (!Array.isArray(input)) return out
      for (const cell of input) {
        if (!cell || typeof cell.block !== 'string' || cell.block === '') continue
        if (!Array.isArray(cell.at) || cell.at.length < 3) continue
        const at = [0, 1, 2].map((i) => Math.trunc(Number(cell.at[i])))
        if (!at.every((value) => isFinite(value))) continue
        // Only a real choice is written back: stamping `variant: null` on every
        // cell would put a key with no meaning into every saved atlas.
        const cellVariant = typeof cell.variant === 'string' && cell.variant !== '' ? cell.variant : null
        const kept = { block: cell.block, at: at }
        if (cellVariant !== null) kept.variant = cellVariant
        out.push(kept)
      }
      return out
    }

    const FACE_STEP = {
      down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
      south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
    }

    // A reference block is not part of any project's pack: it comes out of the
    // game's version jar or a mod jar, which is why the plugin cannot preload it
    // the way it preloads a project.  It is extracted when first asked for, and
    // `atlas.releaseRefs` drops it again once nothing references it.
    async function referenceDirectory(project) {
      const stored = (await readJson(project.dir + '/mc-art.settings.json')) || {}
      const reference = stored.reference !== null && typeof stored.reference === 'object' ? stored.reference : {}
      return typeof reference.directory === 'string' ? reference.directory : ''
    }

    // Re-stat-ing 30 jars on every single block would be silly, but never
    // re-checking would serve a stale block after the user adds a mod.
    async function refSignatureOf(dir) {
      const cached = refSignatures.get(dir)
      const now = Date.now()
      if (cached !== undefined && now - cached.at < 5000) return cached.value
      const value = await referenceSignature(dir)
      refSignatures.set(dir, { at: now, value: value })
      return value
    }

    function virtualLoad(namespace, parsed) {
      const models = new Map()
      for (const key of Object.keys(parsed.models || {})) {
        const colon = key.indexOf(':')
        const path = colon >= 0 ? key.slice(colon + 1) : key
        if (!models.has(path)) models.set(path, parsed.models[key])
      }
      const textures = new Map()
      const files = parsed.textureFiles || {}
      for (const reference of Object.keys(parsed.textures || {})) {
        const colon = reference.indexOf(':')
        let textureNamespace = colon >= 0 ? reference.slice(0, colon) : namespace
        let texturePath = colon >= 0 ? reference.slice(colon + 1) : reference
        // The extraction knows which archive actually answered; an unqualified
        // ref cannot say whether the pack's own namespace or vanilla won.
        const file = files[reference]
        if (typeof file === 'string') {
          const parts = file.split('/')
          if (parts.length > 3 && parts[0] === 'assets') {
            textureNamespace = parts[1]
            texturePath = parts.slice(3).join('/').replace(/\.png$/, '')
          }
        }
        const key = textureNamespace + ':' + texturePath
        const refKey = 'ref:' + key
        textures.set(key, refKey)
        referenceTextures.set(refKey, 'data:image/png;base64,' + parsed.textures[reference])
        const animation = (parsed.animations || {})[reference]
        if (animation !== undefined && animation !== null) referenceAnimations.set(refKey, animation)
        else referenceAnimations.delete(refKey)
      }
      return { dir: null, namespace: namespace, assets: null, models: models,
        textures: textures, virtual: true }
    }

    function refEntry(namespace, block) {
      return referenceBlocks.get(namespace + ':' + block)
    }

    function refNameOf(namespace, block) {
      const entry = refEntry(namespace, block)
      return entry === undefined ? undefined : entry.name
    }


    // ---- items: the 2D inventory side -------------------------------------
    //
    // A block is drawn from its blockstate; an item is drawn from its ITEM model,
    // and the pack gives two different things depending on which it is:
    //   `iso`  the chain has `elements` (a block item) -- the inventory icon is
    //          the block drawn isometrically, with `display.gui` (vanilla:
    //          rotation [30,225,0], scale 0.625) and the GUI's OWN lighting.
    //   `flat` no elements, `layer0..N` sprites stacked, lit from the front.
    // The extractor hands back `--item ns:name`; everything below only turns
    // that into what the browser needs (ref: handles, quads, data URLs).
    async function referenceLoadItem(root, project, namespace, item, source) {
      const fromProject = source === 'project'
      const key = 'item:' + (fromProject ? 'project:' : '') + namespace + ':' + item
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const signature = await rootsSignature(resolved.roots)
      const cached = referenceBlocks.get(key)
      if (cached !== undefined && cached.signature === signature) return cached
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { error: '找不到 ' + EXTRACT_SCRIPT + '（从项目目录往上找了 5 层都没有）。' }
      }
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--item', namespace + ':' + item]),
        120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || (parsed.error !== undefined && parsed.error !== null)) {
        return { error: String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error) }
      }
      const entry = {
        signature: signature, namespace: namespace, item: item, source: source,
        name: parsed.name || item, version: parsed.version,
        shape: parsed.shape, light: parsed.light, display: parsed.display || null,
        form: parsed.form, family: parsed.family, formLabel: parsed.formLabel,
        layers: parsed.layers || [], frames: parsed.frames || [],
        framesTruncated: parsed.framesTruncated === true,
        modelRefs: parsed.modelRefs || [], modelRotations: parsed.modelRotations || [],
        rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
        parsed: parsed,
      }
      referenceBlocks.set(key, entry)
      return entry
    }

    // Which roots an item query reads.
    //
    // A project's own pack ships `models/item/…` but NOT the vanilla parents
    // those models inherit: `{"parent": "block/cube_all"}` is an UNQUALIFIED
    // reference, which in the game means `minecraft:block/cube_all`.  So the
    // pack alone leaves every chain incomplete -- every one of our own block
    // items came back `shape: none`, i.e. an item with no icon, which is what
    // "看不到我们自己做出来的资源的物品形式" was.
    //
    // Two roots fix it, ordered: the pack first (its own file wins), the game
    // reference second (it completes the vanilla half).  The extractor has
    // taken several `--root`s for block lists all along; the item paths were the
    // two that dropped all but the first.
    async function itemRoots(project, source) {
      const reference = await referenceDirectory(project)
      if (source === 'project') {
        const roots = [project.dir + '/pack']
        if (reference !== '') roots.push(reference)
        return { roots: roots, reference: reference }
      }
      if (reference === '') {
        return { error: '还没有设置参考目录，取不到原版或模组的物品。在设置里指定 .minecraft 或版本目录。' }
      }
      return { roots: [reference], reference: reference }
    }

    /** `--root <一> --root <二>`：交原始字符串，转义留给 runScanner（唯一转义点）。 */
    function rootArgs(roots) {
      const out = []
      for (const one of roots) out.push('--root', one)
      return out
    }

    async function rootsSignature(roots) {
      const parts = []
      for (const one of roots) parts.push(await refSignatureOf(one))
      return parts.join('|')
    }

    // A texture reference as the host's `ref:` handle.  The extractor may hand
    // back a bare `item/clock_00` (an unqualified reference resolves in the
    // item's own namespace), and `virtualLoad` keys its handles by namespace, so
    // the same qualification has to happen here or the picture is blank.
    // ref handle -> the real file in the project's own pack.  Filled while an
    // item is extracted (from the extractor's `textureFiles`), read by
    // `atlas.saveTexture`.  A block's texture ids are already paths; an item's
    // are handles, and without this the pen refused every item texture.
    const editablePaths = new Map()

    function itemHandle(namespace, reference) {
      const text = String(reference === undefined || reference === null ? '' : reference)
      return 'ref:' + (text.indexOf(':') >= 0 ? text : namespace + ':' + text)
    }

    async function itemIcon(namespace, parsed, have, project) {
      const load = virtualLoad(namespace, parsed)
      const out = {
        namespace: namespace, item: parsed.item, name: parsed.name || parsed.item,
        shape: parsed.shape, light: parsed.light, display: parsed.display || null,
        form: parsed.form, family: parsed.family, formLabel: parsed.formLabel,
        named: parsed.named === true,
        layers: [], frames: [], framesTruncated: parsed.framesTruncated === true,
        quads: [], error: parsed.error === undefined ? null : parsed.error,
        // Vanilla parents a project pack does not ship.  Surfaced because a
        // legacy `builtin/generated` (1.12.2's name for `item/generated`) is
        // worth telling the pack author about rather than hiding.
        missingModels: parsed.missingModels || [],
      }
      const ids = []
      const add = (id) => { if (ids.indexOf(id) < 0) ids.push(id) }
      if (parsed.shape === 'iso') {
        // Same geometry path as a block: one ref, its own rotations, then the
        // item's GUI matrix on top -- which the CLIENT applies, because the
        // icon's rotation order and lighting are GUI-specific and the rasteriser
        // lives there.
        const entry = { modelRef: parsed.modelRef || (parsed.modelRefs || [])[0] || null,
          modelRefs: parsed.modelRefs || [], modelRotations: parsed.modelRotations || [],
          rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
          multipart: false, whenList: [] }
        const quads = quadsOfEntry(load, entry, note)
        out.quads = quads === undefined ? [] : quads
        for (const quad of out.quads) add(quad.tex)
      } else {
        out.layers = (parsed.layers || []).map((reference) => itemHandle(namespace, reference))
        for (const frame of parsed.frames || []) {
          out.frames.push({ predicate: frame.predicate || {},
            layers: (frame.layers || []).map((reference) => itemHandle(namespace, reference)) })
        }
        for (const id of out.layers) add(id)
        for (const frame of out.frames) for (const id of frame.layers) add(id)
      }
      out.textureIds = ids
      // The two files an item needs to name: its model (what "@ 提意见" points at,
      // the thing that decides whether the icon is a sprite or geometry) and, for
      // every texture that lives in this project's pack, the path the pen writes.
      out.modelPath = ''
      if (project !== undefined) {
        const model = project.dir + '/pack/assets/' + namespace + '/models/item/' + parsed.item + '.json'
        if ((await statOf(model)) !== undefined) out.modelPath = rel(project.root, model)
      }
      const layerRefs = (parsed.layers || []).concat(
        (parsed.frames || []).reduce((all, frame) => all.concat(frame.layers || []), []))
      for (const reference of layerRefs) {
        const file = (parsed.textureFiles || {})[reference]
        if (typeof file !== 'string' || file === '') continue
        const full = project === undefined ? undefined : project.dir + '/pack/' + file
        if (full === undefined || (await statOf(full)) === undefined) continue
        editablePaths.set(itemHandle(namespace, reference), full)
      }
      const already = {}
      if (Array.isArray(have)) for (const path of have) already[path] = true
      const textures = {}
      for (const id of ids) {
        if (already[id] === true) continue
        const url = await textureUrlFor(id)
        if (url !== undefined) textures[id] = url
      }
      out.textures = textures
      out.animations = animationsFor(ids)
      return out
    }

    async function itemFactsList(project, namespace, source) {
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--list', '--namespace', namespace, '--kind', 'item']),
        180000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
      }
      return { namespace: namespace, version: parsed.version, items: parsed.items || [] }
    }

    async function itemIconPage(project, namespace, items, source) {
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
      // ONE process for the page: a single item spends almost all of its time
      // opening every jar, so forty processes would make the picker unusable.
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--items', items.join(','), '--namespace', namespace]),
        180000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
      }
      const out = {}
      for (const item of Object.keys(parsed.items || {})) {
        out[item] = await itemIcon(namespace, parsed.items[item], [], project)
      }
      return { namespace: namespace, version: parsed.version, items: out }
    }

    async function referenceLoad(root, project, namespace, block, variant) {
      const wanted = typeof variant === 'string' && variant !== '' ? variant : null
      // The cache key includes the variant: `oak_log` upright and `oak_log`
      // lying down are two different extractions of the same block name.
      const key = namespace + ':' + block + (wanted === null ? '' : '@' + wanted)
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { error: '还没有设置参考目录，取不到原版或模组的方块。在设置里指定 .minecraft 或版本目录。' }
      }
      const signature = await refSignatureOf(directory)
      const cached = referenceBlocks.get(key)
      if (cached !== undefined && cached.signature === signature) return cached
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { error: '找不到 ' + EXTRACT_SCRIPT + '（从项目目录往上找了 5 层都没有）。' }
      }
      const blockArg = namespace + ':' + block
      const tokens = ['--root', directory, '--block', blockArg]
      if (wanted !== null) tokens.push('--variant', wanted)
      // 展示给人看的那条命令也按方言拼，免得用户拿去手跑时报"找不到命令"。
      const dialect = await currentShell(project.dir)
      const command = pythonHint() + ' ' + dialect.word(extractor) + ' ' +
        tokens.map((token) => dialect.word(token)).join(' ')
      const parsed = await runScanner(extractor, tokens, 120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error) }
      }
      const refs = parsed.modelRefs || []
      if (refs.length === 0) return { error: '抽出来的方块没有可用的模型：' + key }
      const entry = {
        signature: signature, namespace: namespace, block: block,
        name: parsed.name || block, nameKey: parsed.nameKey, version: parsed.version,
        variant: parsed.variant === undefined ? null : parsed.variant,
        variantKeys: parsed.variantKeys || [],
        // The independent properties behind those keys.  Twelve
        // `conditional=<bool>,facing=<dir>` keys are two questions, not twelve;
        // the viewer needs the questions.
        variantAxes: parsed.variantAxes || [],
        // What each property falls back to when nothing can derive it.  Nothing
        // in the world says whether a command block is conditional, so that one
        // has to come from here or the composed key is incomplete.
        variantDefaults: parsed.variantDefaults || {},
        rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
        // `multipart` arrives as one ref per `apply`, because each carries its
        // OWN x/y rotation (a wall is a post plus four sides at 0/90/180/270).
        // Folding them into one model would have to rotate one element list four
        // ways -- so they stay apart and `quadsOfEntry` rotates each.  For a
        // `variants` block this is just `[refs[0]]` and `[]`, i.e. the same
        // single-model path it has always taken.
        modelRef: refs[0], modelRefs: refs,
        modelRotations: parsed.modelRotations || [],
        // Parallel to `modelRefs`: the `when` clause that says when the game
        // would draw that apply.  Empty for a `variants` blockstate.
        whenList: parsed.multipartWhens || [],
        multipart: parsed.multipart === true,
        load: virtualLoad(namespace, parsed), command: command,
      }
      referenceBlocks.set(key, entry)
      return entry
    }

    // ---- which `apply` the game would draw --------------------------------
    //
    // A wall/fence/pane blockstate lists every piece it COULD show, one `when`
    // clause each, and the game evaluates those clauses against the NEIGHBOURS.
    // A structure is a grid of cells, so we have the neighbours -- which means
    // the union can be replaced by what the game would actually draw.
    //
    // The rules below were READ OUT OF THE GAME'S OWN BYTECODE, one version at a
    // time, never recalled: `tools/multipart_rules.md` has the evidence, the
    // class and method names, and the reproduction commands.  1.18.2 asks
    // whether the neighbour's face toward us is sturdy, plus block tags and
    // three `instanceof`; 1.12.2 asks which `BlockFaceShape` the neighbour
    // reports, which is a property of its FAMILY alone.  Both need only two
    // things about a neighbour -- is it a full cube, which family is it -- and
    // the family is visible in the pack's own `when` clauses, so no table of
    // block names is involved beyond the two exception lists, which are
    // block-name lists in the game as well.
    function entryFamily(entry, id) {
      if (entry === undefined || entry === null) return 'other'
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
      // A fence gate is a `variants` blockstate, not multipart, and the game
      // asks about it with `instanceof FenceGateBlock`.  Its own property list
      // names it: `in_wall` belongs to gates and to nothing else in the game.
      for (const axis of axes) {
        if (axis !== null && typeof axis === 'object' && axis.name === 'in_wall') return 'gate'
      }
      if (entry.multipart !== true) return 'other'
      const whens = Array.isArray(entry.whenList) ? entry.whenList : []
      let sawUp = false
      let sawFalse = false
      let sawTrue = false
      for (const when of whens) {
        for (const key of Object.keys(when)) {
          if (key === 'up') { sawUp = true; continue }
          if (key !== 'north' && key !== 'east' && key !== 'south' && key !== 'west') continue
          if (when[key] === 'false') sawFalse = true
          else sawTrue = true
        }
      }
      // Measured shapes: walls carry `up` (1.12.2 and 1.18.2 alike); panes have
      // applies for the "no side here" case (`false`); fences only ever draw a
      // side when it connects (`true`).
      let shape = 'other'
      if (sawUp) shape = 'wall'
      else if (sawFalse) shape = 'pane'
      else if (sawTrue) shape = 'fence'
      if (shape === 'other') return 'other'
      // The shape alone is not enough.  `redstone_wire`, `tripwire` and
      // `chorus_plant` are multipart with the same four side keys, and the game
      // decides what a wall connects to with BLOCK TAGS (`BlockTags.WALLS`,
      // `FENCES`, `WOODEN_FENCES`) and `instanceof`, not with a shape.  A tag is
      // data, and a resource pack does not carry it -- but block names follow
      // the convention, so the NAME is asked too and a mismatch is refused
      // rather than guessed.  A mod's wall that is not called `*_wall` therefore
      // draws its union instead of a wrong subset -- see `keepFlags`' caller.
      const text = String(id === undefined || id === null ? '' : id)
      const name = text.slice(text.indexOf(':') + 1)
      if (shape === 'wall') return /(^|_)wall$/.test(name) ? 'wall' : 'other'
      if (shape === 'fence') return /(^|_)fence$/.test(name) ? 'fence' : 'other'
      return (/(^|_)pane$/.test(name) || /(^|_)bars$/.test(name)) ? 'pane' : 'other'
    }

    function isFullCubeEntry(load, entry) {
      const refs = Array.isArray(entry.modelRefs) && entry.modelRefs.length > 0
        ? entry.modelRefs : [entry.modelRef]
      const elements = elementsOf(load, refs[0])
      if (!Array.isArray(elements) || elements.length !== 1) return false
      const element = elements[0]
      if (element === undefined || element.rotation !== undefined) return false
      const from = element.from
      const to = element.to
      if (!Array.isArray(from) || !Array.isArray(to)) return false
      return from[0] === 0 && from[1] === 0 && from[2] === 0
        && to[0] === 16 && to[1] === 16 && to[2] === 16
    }

    // The only two block-name lists in either rule -- and in the game they are
    // block-name lists too: no data asks "is this leaves".  Read per version.
    const EXCEPT_18 = { barrier: 1, carved_pumpkin: 1, jack_o_lantern: 1, melon: 1, pumpkin: 1 }
    function isException18(id) {
      const text = String(id)
      const name = text.slice(text.indexOf(':') + 1)
      if (EXCEPT_18[name] === 1) return true
      if (/_leaves$/.test(name)) return true                       // LeavesBlock
      return name === 'shulker_box' || /_shulker_box$/.test(name)  // BlockTags.SHULKER_BOXES
    }
    const EXCEPT_12 = { beacon: 1, cauldron: 1, glass: 1, glowstone: 1, ice: 1, sea_lantern: 1,
      stained_glass: 1, piston: 1, sticky_piston: 1, piston_head: 1, barrier: 1,
      melon_block: 1, pumpkin: 1, lit_pumpkin: 1 }
    function isException12(id) {
      const text = String(id)
      const name = text.slice(text.indexOf(':') + 1)
      if (EXCEPT_12[name] === 1) return true
      if (/_leaves$/.test(name)) return true                        // BlockLeaves
      if (/_trapdoor$/.test(name)) return true                      // BlockTrapDoor
      if (/_stained_glass$/.test(name)) return true                 // BlockStainedGlass
      return name === 'shulker_box' || /_shulker_box$/.test(name)   // BlockShulkerBox
    }

    function isOldVersion(version) {
      const text = String(version === undefined || version === null ? '' : version)
      return text.indexOf('1.12') >= 0 || text.indexOf('1.11') >= 0 || text.indexOf('1.10') >= 0
    }

    function axisOfDirection(name) {
      if (name === 'north' || name === 'south') return 'z'
      if (name === 'east' || name === 'west') return 'x'
      return 'y'
    }

    function variantValueOf(variant, name) {
      if (typeof variant !== 'string' || variant === '') return null
      const parts = variant.split(',')
      for (const part of parts) {
        const at = part.indexOf('=')
        if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1)
      }
      return null
    }

    // Does OUR block connect to THAT neighbour on THAT side?  `dir` is the
    // direction from the neighbour toward us -- measured, not assumed:
    // `BlockWall.getActualState` reads the NORTH property from
    // `canConnectTo(world, pos.north(), EnumFacing.SOUTH)`, and the same
    // opposite-direction pairing holds for all four sides.  It is consulted for
    // one thing only, a fence gate, and there only its AXIS is compared; so the
    // sign cannot matter.  That is worth saying out loud, because a sign error
    // would flip every gate while leaving every other piece correct.
    //
    // `neighbour === null` means AIR, and air is NOT "no neighbour": in 1.12.2
    // `BlockAir.getBlockFaceShape` returns UNDEFINED, which is `!= SOLID`, so a
    // wall or a fence connects to the empty air beside it.  That is why a lone
    // 1.12.2 wall shows its four arms and a lone 1.18.2 wall shows only a post.
    function connectsTo(version, self, neighbour, dir) {
      const absent = neighbour === null || neighbour === undefined
      if (isOldVersion(version)) {
        // 1.12.2: the neighbour reports a BlockFaceShape, and that depends only
        // on its FAMILY -- `getBlockFaceShape` says nothing about the
        // neighbour's own connection state, so this is not recursive.  Every
        // block that does not override it reports SOLID; `Block` is the default
        // and that is the measured base.  The families that DO override it
        // report their own shape.  Everything else is proxied as "a full cube
        // reports SOLID, anything else reports UNDEFINED", which is what the
        // overriders actually do for a face pointing sideways.
        let face = 'undefined'
        if (!absent) {
          if (neighbour.family === 'wall') face = 'poleThick'
          else if (neighbour.family === 'fence') face = 'pole'
          else if (neighbour.family === 'pane') face = 'poleThin'
          else if (neighbour.family !== 'gate') face = neighbour.cube === true ? 'solid' : 'undefined'
          else if (!gateAlongAxis(neighbour, dir)) face = 'undefined'
          else face = 'pole'
        }
        const exception = absent ? false : isException12(neighbour.id)
        if (self.family === 'pane') return (!exception && face === 'solid') || face === 'poleThin'
        // BlockFence:  (!isExcep && face != SOLID) || (face == MIDDLE_POLE && ...)
        // BlockWall:   (!isExcep && face != SOLID) || face == MIDDLE_POLE_THICK
        // Both are "not SOLID" first, so a 1.12.2 wall and a 1.12.2 fence DO
        // meet -- the 1.18.2 split between them is a later rewrite.
        const flag = face === (self.family === 'wall' ? 'poleThick' : 'pole')
        return (!exception && face !== 'solid') || flag
      }
      if (absent) return false
      const exception = isException18(neighbour.id)
      const solid = neighbour.cube === true && !exception
      if (neighbour.family === 'gate') {
        // `FenceGateBlock.connectsToDirection`: a gate connects along its own
        // axis, and the cell's `variant` is where its orientation lives.
        return gateAlongAxis(neighbour, dir)
      }
      if (self.family === 'wall') {
        return neighbour.family === 'wall' || solid || neighbour.family === 'pane'
      }
      if (self.family === 'fence') {
        return solid || (neighbour.family === 'fence' && self.wooden === fenceWooden(neighbour.id))
      }
      if (self.family === 'pane') {
        // No gate branch here: measured, `IronBarsBlock.attachsTo` does not ask
        // about gates at all, so a pane really does not meet a gate.
        return solid || neighbour.family === 'pane' || neighbour.family === 'wall'
      }
      return false
    }

    // A cell with no orientation cannot be derived, and the policy is to draw
    // one piece too many rather than a hole -- so an unknown facing counts as
    // "along our axis".  Measured: `BlockFenceGate.getBlockFaceShape` returns
    // MIDDLE_POLE when `FACING.getAxis() == face.getAxis()`, UNDEFINED
    // otherwise, and UNDEFINED for up/down.
    function gateAlongAxis(neighbour, dir) {
      const facing = variantValueOf(neighbour.variant, 'facing')
      return facing === null || axisOfDirection(facing) === axisOfDirection(dir)
    }

    // The property values the game would compute for this cell's block.  Every
    // value is a STRING, because that is what a `when` clause compares against.
    // `at(dx, dy, dz)` -> { id, family, cube, variant } | null.
    function multipartValues(version, self, at) {
      const names = []
      for (const when of self.whens) {
        for (const key of Object.keys(when)) if (names.indexOf(key) < 0) names.push(key)
      }
      const back = { north: 'south', south: 'north', east: 'west', west: 'east' }
      const steps = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] }
      const sides = {}
      for (const name of Object.keys(steps)) {
        const step = steps[name]
        sides[name] = connectsTo(version, self, at(step[0], 0, step[2]), back[name])
      }
      const v12 = isOldVersion(version)
      const values = {}
      for (const name of Object.keys(sides)) {
        if (names.indexOf(name) < 0) continue
        if (self.family === 'wall' && !v12) {
          // 1.18.2 walls: `low`/`tall`.  `updateSides` builds each side with
          // `makeWallState(isConnected, aboveShape, TEST_D)`, and
          // `isCovered(sideShape, collideShape) = collideShape ⊆ sideShape`.
          // The `aboveShape` there comes from `level.getBlockState(pos.above())`
          // -- the block above ME, not above the neighbour -- so `tall` means
          // "the block on top of ME covers this side's footprint".  Proxied as
          // "the block above me is a full cube", which is what covers it.
          const over = at(0, 1, 0)
          const covered = over !== null && over.cube === true
          values[name] = sides[name] ? (covered ? 'tall' : 'low') : 'none'
        } else {
          values[name] = sides[name] ? 'true' : 'false'
        }
      }
      if (names.indexOf('up') < 0) return values
      const above = at(0, 1, 0)
      if (self.family === 'wall' && v12) {
        // 1.12.2: `up = flag ? !isAirBlock(pos.up()) : true`, with
        // `flag = (N && !W && S && W..)` read from `BlockWall.getActualState`.
        // Note that in 1.12.2 AIR ITSELF CONNECTS (BlockAir reports UNDEFINED,
        // which is `!= SOLID`), so a lone wall has all four sides connected and
        // the flag is false -> the post stays.  The flag is only true in the
        // measured narrow case of a wall between two full blocks with nothing
        // solid east or west.
        const flag = (sides.south && !sides.west && sides.north && sides.east)
          || (!sides.south && sides.west && !sides.north && sides.east)
        values.up = flag ? (above === null ? 'false' : 'true') : 'true'
        return values
      }
      // 1.18.2: `shouldRaisePost`, read from `clo.a(cov,cov,dqh)`.  Its first
      // branch asks about the block ABOVE being a wall whose own `up` is true;
      // we approximate that with "is a wall" and say so -- the fully recursive
      // version would have to walk the column.
      let raise = above !== null && above.family === 'wall'
      if (!raise) {
        const none = (name) => values[name] === undefined || values[name] === 'none'
        const asym = (none('north') && none('south') && none('east') && none('west'))
          || (none('north') !== none('south')) || (none('east') !== none('west'))
        const tallPair = (values.north === 'tall' && values.south === 'tall')
          || (values.east === 'tall' && values.west === 'tall')
        // Measured order: asymmetric -> post; a tall run -> NO post; otherwise
        // the post depends on what is above -- `aboveState.is(WALL_POST_OVERRIDE)`
        // or `isCovered(aboveShape, POST_TEST)`, i.e. "a block on top holding
        // the post down".  The proxy is a full cube above me; a torch or sign
        // (the tag half) is not covered by it and will miss a post.
        if (asym) raise = true
        else if (tallPair) raise = false
        else raise = above !== null && above.cube === true
      }
      values.up = raise ? 'true' : 'false'
      return values
    }

    // Fail-open on purpose: a key we cannot derive must not silently delete a
    // piece of the model.  Drawing one piece too many is visible and fixable;
    // drawing none is a hole that looks like a modelling mistake.
    function whenMatches(when, values) {
      for (const key of Object.keys(when)) {
        const have = values[key]
        if (have === undefined) continue
        if (String(have) !== String(when[key])) return false
      }
      return true
    }

    // The only fence whose wooden-ness differs from the rest of vanilla.  The
    // game asks a TAG (`WOODEN_FENCES`), and a tag is not in a resource pack --
    // a mod's fence will be classified wooden here -- but getting vanilla right
    // is what the 1.18.2 `isSameFence` rule needs, and 1.12.2 does not ask at
    // all.  Said plainly rather than guessed at silently.
    function fenceWooden(id) {
      const text = String(id)
      return !/nether_brick_fence$/.test(text.slice(text.indexOf(':') + 1))
    }

    // The `keep` flags for one multipart entry sitting among these neighbours.
    // Returns undefined when the entry is not multipart, or when its `when`
    // clauses do not line up with its refs, or when a key they ask about could
    // not be derived at all -- in those cases the union stands, because guessing
    // which clause belongs to which piece would be worse.
    function keepFlags(entry, values) {
      const whens = Array.isArray(entry.whenList) ? entry.whenList : []
      const refs = Array.isArray(entry.modelRefs) ? entry.modelRefs : []
      if (entry.multipart !== true || whens.length !== refs.length || refs.length === 0) return undefined
      for (const when of whens) {
        for (const key of Object.keys(when)) {
          if (values[key] === undefined) return undefined
        }
      }
      // "Every flag false" is NOT a failure.  A 1.12.2 wall walled in by solid
      // blocks on all four sides, with a block above it, really does draw
      // nothing -- the game hides the whole thing.  Reading that as "we could
      // not decide" would put a post where the game leaves a hole.
      return whens.map((when) => whenMatches(when, values))
    }

    // One block name -> a loaded entry, whether it lives in the open project's
    // own pack or has to be pulled out of the reference jars.  The cell
    // renderer, the ghost and the neighbour lookup all need that answer, and
    // three copies of it is three places for the namespace fallback to drift.
    async function entryFor(root, project, reference, variant) {
      const colon = reference.indexOf(':')
      const namespace = colon >= 0 ? reference.slice(0, colon) : project.namespace
      const name = colon >= 0 ? reference.slice(colon + 1) : reference
      if (name === '') return { error: '方块名是空的' }
      const load = await ensure(namespace)
      if (load !== undefined) {
        return { load: load, id: namespace + ':' + name,
          entry: { modelRef: 'block/' + name, rotation: null, multipart: false, version: null } }
      }
      const ref = await referenceLoad(root, project, namespace, name, variant)
      if (ref.error !== undefined) return { error: ref.error }
      return { load: ref.load, id: ref.namespace + ':' + ref.block, entry: ref }
    }

    // What the connection rules need to know about one neighbour.  Everything
    // here is a property of the BLOCK, never of its own connection state, which
    // is why this is not recursive: the game's `isSideSolid` and
    // `getBlockFaceShape` are static answers about the neighbour, not "does the
    // neighbour connect back".
    function describeEntry(load, entry, id, variant) {
      if (entry === null || entry === undefined) return null
      if (entry.cubeMemo === undefined) entry.cubeMemo = isFullCubeEntry(load, entry)
      return { id: id, family: entryFamily(entry, id), cube: entry.cubeMemo === true,
        variant: variant === undefined ? null : variant,
        version: entry.version === undefined ? null : entry.version }
    }

    function neatKey(at) {
      return at[0] + ',' + at[1] + ',' + at[2]
    }


    // All the geometry one extracted entry contributes.
    //
    // A `variants` entry is ONE ref and rotates as a whole, which is all this
    // ever had to do.  A `multipart` entry is one ref per `apply` and each
    // carries its OWN x/y -- `prismarine_wall` is the post plus four sides at
    // 0/90/180/270 -- so they are rotated one at a time and then the union is
    // handed to the blockstate-level rotation, which stays LAST because the
    // element's own rotation is in model space and the variant's is in block
    // space.  Rotating them in the other order is the bug `faceAfter` documents.
    //
    // `keep`, when given, is one flag per ref: the game would not draw the
    // others HERE, because a neighbour decides (see `multipartValues`).  A kept
    // ref that cannot be resolved is still reported -- but a skipped one is not
    // "missing", so it is not reported either.
    function quadsOfEntry(load, entry, report, keep) {
      const refs = Array.isArray(entry.modelRefs) && entry.modelRefs.length > 0
        ? entry.modelRefs : [entry.modelRef]
      const rotations = Array.isArray(entry.modelRotations) ? entry.modelRotations : []
      let out = []
      const missed = []
      for (let index = 0; index < refs.length; index++) {
        if (keep !== undefined && keep[index] !== true) continue
        const elements = elementsOf(load, refs[index])
        if (elements === undefined) { missed.push(refs[index]); continue }
        const own = index < rotations.length ? rotations[index] : null
        out = out.concat(rotateQuads(quadsFromElements(elements, report), own))
      }
      if (out.length === 0) return undefined
      // Not fatal -- three of a wall's four sides still draw -- but it must not
      // be silent either: a missing piece looks like a modelling mistake.
      if (missed.length > 0 && report !== undefined) report('模型链里缺了：' + missed.join('、'))
      return rotateQuads(out, entry.rotation)
    }

    // One block, at one coordinate -- what the viewer draws as the translucent
    // "about to place here" ghost.  It goes through the same lookup the cells
    // do, so the ghost cannot disagree with what will actually appear.
    //
    // `around` is what makes that true for a wall: the ghost of a wall dropped
    // next to three existing walls must show the same shape the placed block
    // will have, so the caller sends the neighbours it can see, as
    // `[{ d: [dx,dy,dz], block: 'ns:name', variant? }]` offsets from `at`.
    async function blockQuadsAt(root, project, block, at, variant, around) {
      const found = await entryFor(root, project, String(block), variant)
      if (found.error !== undefined) {
        // The old message names the missing model; keep it, because the viewer
        // shows it verbatim next to the brush.
        return { error: found.error.indexOf('方块名是空的') >= 0
          ? found.error : '找不到 ' + String(block) + ' 的模型（' + found.error + '）' }
      }
      const load = found.load
      const entry = found.entry
      let keep
      if (entry.multipart === true) {
        const whens = Array.isArray(entry.whenList) ? entry.whenList : []
        const refs = Array.isArray(entry.modelRefs) ? entry.modelRefs : []
        const family = entryFamily(entry, found.id)
        if (whens.length > 0 && whens.length === refs.length && family !== 'other') {
          const id = found.id
          // Neighbours are resolved one by one and CACHED by `referenceLoad`,
          // so a ghost dragged over a wall does not re-extract the world: the
          // scene already extracted every one of them.
          const known = new Map()
          for (const item of Array.isArray(around) ? around : []) {
            if (item === null || typeof item !== 'object') continue
            if (!Array.isArray(item.d) || item.d.length < 3) continue
            if (typeof item.block !== 'string' || item.block === '') continue
            const offset = [Math.trunc(item.d[0]), Math.trunc(item.d[1]), Math.trunc(item.d[2])]
            const other = await entryFor(root, project, item.block,
              typeof item.variant === 'string' && item.variant !== '' ? item.variant : null)
            if (other.error !== undefined) continue
            const colon = item.block.indexOf(':')
            const otherId = colon >= 0 ? item.block : project.namespace + ':' + item.block
            known.set(neatKey(offset), describeEntry(other.load, other.entry, otherId,
              typeof item.variant === 'string' && item.variant !== '' ? item.variant : null))
          }
          const self = { id: id, family: entryFamily(entry, id), whens: whens, wooden: fenceWooden(id) }
          const values = multipartValues(entry.version, self,
            (dx, dy, dz) => known.get(neatKey([dx, dy, dz])) || null)
          keep = keepFlags(entry, values)
        }
      }
      // The rotation goes on LAST, after the element rotations inside
      // `quadsFromElements` -- see `quadsOfEntry`.
      const quads = quadsOfEntry(load, entry, note, keep)
      if (quads === undefined) return { error: '找不到 ' + String(block) + ' 的模型' }
      // Two things the viewer needs and only the extraction has: the 朝向
      // choices, and whether the ghost itself is a block that a neighbour
      // decides (so it can say "按邻居" next to it).
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
      return { quads: translateQuads(quads, at),
        variants: entry.variantKeys || [], axes: axes, defaults: entry.variantDefaults || {},
        variant: entry.rotation === null || entry.rotation === undefined ? null : variant,
        multipart: entry.multipart === true, derived: keep !== undefined && keep !== null }
    }

    async function payload(root, project, kind, id, have, cellsOverride, neighbours) {
      const dir = project.dir
      const namespace = project.namespace
      // On by default, because it is what the game does.  The viewer can turn it
      // off to see the extraction's own union -- which is the only way to tell
      // "our rules are wrong" from "the picture is right and I misremembered".
      const neighbourAware = neighbours !== false
      const load = preloads.get(namespace)
      if (load === undefined) return { error: 'project not loaded: ' + namespace }
      let quads = []
      let refs = []
      let palette = []
      let cells = null

      if (kind === 'block') {
        const found = (await blockIds(load)).filter((block) => block.id === id)[0]
        if (found === undefined) return { error: 'block not found: ' + id }
        const built = await projectElements(project, load, found.model)
        const elements = built.elements
        if (elements === undefined) {
          // 画不出来时**不要只说一句英文**：把"哪一层断的、试过哪些路、抽取器原话"
          // 整理成一份报告，注入当前会话那个 agent 的上下文（下一个 step 边界它就看见），
          // 同时也作为错误文本回给面板 —— 拿不到 agent 时人还能自己看到原因。
          const directory = await referenceDirectory(project)
          const lines = ['[MC 资产面板] 画不出 ' + namespace + ':' + id]
          lines.push('· 它自己的模型：' + String(found.model)
            + (load.models.get(String(found.model).replace(/^[^:]*:/, '').replace(/^block\//, 'block/')) === undefined
              ? '（项目包里没有这个文件）' : '（在项目包里）'))
          lines.push('· 缺的原版母模型：' + (built.gaps.length === 0
            ? '（链上没缺，是别的原因）'
            : built.gaps.map((gap) => gap.names.join('、')).join('；')))
          for (const gap of built.gaps) if (gap.why !== '') lines.push('· 现取失败的原因：' + gap.why)
          lines.push('· 已试过的路：项目包 → 面板内置的原版母模型表 → 从参考目录的 jar 现取')
          lines.push('· 参考目录：' + (directory === '' ? '（没设）' : directory))
          lines.push('· 修法：补上 <命名空间>:block/<名字> 的模型文件，或把 parent 改成原版真实存在的名字'
            + '（1.16 之后墙是 template_wall_post/side/side_tall）；参考目录没设的话先在面板里指到 .minecraft/versions/<版本>。')
          const report = lines.join('\n')
          // **0.1.27：注入停用。** 0.1.26 这里 `agent.steer({role:'user', content:[…]})` 写的
          // 那条消息没有 `source`（v4 要求 producer-owned source kind），宿主把它当合法输入
          // 落进了持久化日志的 `agent/inbox/spliced`，于是那个会话**再也加载不了**
          // （"历史加载失败：stored log is corrupt"，甚至整个窗口消失）。
          // 往别人的持久化日志里写字，形状不对不是"没生效"，是**把日志写坏** ——
          // 在拿真实校验器验过一条 UserMessage 之前，这条路上不再写任何东西，
          // 报告只留在屏幕上（人自己决定要不要交给 AI）。
          const notice = { sent: false, via: null,
            why: '注入已停用（0.1.26 写坏了会话日志）；报告在屏幕上，人自己决定怎么用' }
          const how = notice.sent === true ? '已经发给 AI（' + notice.via + '）'
            : '这条报告没有注入到 AI 上下文（' + String(notice.why) + '）'
          return { error: report + '\n· ' + how, notified: notice.sent === true, notifyVia: notice.via || null }
        }
        quads = quadsFromElements(elements, note)
        refs = [rel(root, load.assets + '/textures/block/' + id + '.png'),
          rel(root, load.assets + '/models/block/' + id + '.json'),
          rel(root, load.assets + '/blockstates/' + id + '.json')]
      } else if (kind === 'entity') {
        const source = (project.entities || []).filter((item) => item.id === id)[0]
        if (source === undefined) return { error: 'entity not found: ' + id }
        const full = (await readJson(dir + '/mc-art.atlas.json')) || {}
        const spec = (full.entities || []).filter((item) => item.id === id)[0]
        if (spec === undefined) return { error: 'entity spec missing: ' + id }
        for (const layer of spec.layers || []) {
          const path = load.assets + '/textures/' + layer.texture
          quads = quads.concat(entityQuads(layer.model, path, layer.mode || 'opaque'))
          refs.push(rel(root, path))
        }
        refs.push(rel(root, dir + '/mc-art.atlas.json'))
        refs = refs.concat((spec.refs || []).map((r) => rel(root, dir + '/' + r)))
      } else {
        const full = (await readJson(dir + '/mc-art.atlas.json')) || {}
        const list = kind === 'biome' ? (full.biomes || []) : (full.structures || [])
        const item = list.filter((entry) => entry.id === id)[0]
        if (item === undefined) return { error: kind + ' not found: ' + id }
        const source = cellsOverride === undefined || cellsOverride === null
          ? (item.cells || []) : normalizeCells(cellsOverride)
        const byCell = new Map()
        for (const cell of source) {
          if (!cell || !Array.isArray(cell.at) || typeof cell.block !== 'string') continue
          const key = cell.at[0] + ',' + cell.at[1] + ',' + cell.at[2]
          const previous = byCell.get(key)
          if (previous !== undefined && previous.block !== cell.block) {
            note('格子重叠 ' + key + '：' + previous.block + ' 与 ' + cell.block + '，以后者为准')
          }
          // Rebuilt cell by cell rather than passed through: dropping `variant`
          // here is silent in exactly the way it was silent in the viewer's own
          // editor -- every log in the structure straightens up and nothing
          // says why.
          const kept = { block: cell.block, at: cell.at }
          if (typeof cell.variant === 'string' && cell.variant !== '') kept.variant = cell.variant
          byCell.set(key, kept)
        }
        // Fixed order, so `pick.cell` is an index the viewer can send straight
        // back: after every edit the scene is re-fetched and indices refreshed.
        cells = Array.from(byCell.values())
        const cache = new Map()
        const counts = new Map()
        // Two passes, because a wall's own shape depends on its NEIGHBOURS and
        // a neighbour's shape depends on nothing (see `describeEntry`) -- so
        // every cell can be resolved first, and then each one asked about the
        // cells next to it.
        const slots = []
        const atCell = new Map()
        for (let index = 0; index < cells.length; index++) {
          const cell = cells[index]
          const reference = String(cell.block)
          const colon = reference.indexOf(':')
          const cellNamespace = colon >= 0 ? reference.slice(0, colon) : namespace
          const cellBlock = colon >= 0 ? reference.slice(colon + 1) : reference
          const fullName = cellNamespace + ':' + cellBlock
          counts.set(fullName, (counts.get(fullName) || 0) + 1)
          // A cell that turned its block is a different extraction from the
          // same block left alone, so the cache key carries the variant too.
          const cellKey = fullName + (cell.variant === null || cell.variant === undefined ? '' : '@' + cell.variant)
          let slot = cache.get(cellKey)
          if (slot === undefined) {
            slot = { load: undefined, entry: null, union: undefined,
              id: fullName, variant: cell.variant === undefined ? null : cell.variant }
            // A structure may hold a vanilla or mod block; a cell that cannot
            // be resolved is reported rather than silently dropped.
            const found = await entryFor(root, project, reference, cell.variant)
            if (found.error !== undefined) note('取不到 ' + fullName + '：' + found.error)
            else { slot.load = found.load; slot.entry = found.entry; slot.id = found.id }
            // The UNION of every apply stays cached and stays the fallback: it
            // is what the extraction itself shipped, and when a neighbour
            // cannot be derived the drawing has to fall back to something.
            cache.set(cellKey, slot)
          }
          slots.push(slot)
          atCell.set(neatKey(cell.at), slot)
        }
        // A coordinate the structure does not use is AIR, and air is a
        // neighbour like any other -- it is exactly what makes a lone wall keep
        // its post.  So a miss returns null rather than being skipped.
        const offsetAt = (index, dx, dy, dz) => {
          const cell = cells[index]
          const slot = atCell.get(neatKey([cell.at[0] + dx, cell.at[1] + dy, cell.at[2] + dz]))
          if (slot === undefined || slot.entry === null || slot.load === undefined) return null
          return describeEntry(slot.load, slot.entry, slot.id, slot.variant)
        }
        const unionOf = (slot) => {
          if (slot.union === undefined) {
            const built = quadsOfEntry(slot.load, slot.entry, note)
            slot.union = built === undefined ? [] : built
            if (slot.union.length === 0) note('no model for cell block ' + slot.id)
          }
          return slot.union
        }
        for (let index = 0; index < cells.length; index++) {
          const cell = cells[index]
          const slot = slots[index]
          let cellQuads = []
          if (slot.load !== undefined && slot.entry !== null) {
            let keep
            if (neighbourAware && slot.entry.multipart === true) {
              const whens = Array.isArray(slot.entry.whenList) ? slot.entry.whenList : []
              const family = entryFamily(slot.entry, slot.id)
              // `other` means we could not say WHICH rule applies.  Deriving
              // "no side connects" from a rule we do not have would delete the
              // arms of a block we simply failed to recognise -- a hole, and
              // the worst of the available answers.  So an unknown family keeps
              // the extraction's own union.
              if (whens.length > 0 && family !== 'other') {
                const self = { id: slot.id, family: family, whens: whens,
                  wooden: fenceWooden(slot.id) }
                const values = multipartValues(slot.entry.version, self,
                  (dx, dy, dz) => offsetAt(index, dx, dy, dz))
                keep = keepFlags(slot.entry, values)
              }
            }
            const built = keep === undefined
              ? unionOf(slot) : quadsOfEntry(slot.load, slot.entry, note, keep)
            cellQuads = built === undefined ? [] : built
          }
          // Tag every quad with the cell and face it came from: that pair is
          // what turns a click on the 2D image back into a grid coordinate.
          const tagged = translateQuads(cellQuads, cell.at).map((quad) => ({
            p: quad.p, uv: quad.uv, tex: quad.tex, shade: quad.shade, mode: quad.mode,
            shaded: quad.shaded, pick: { cell: index, face: quad.face || '' },
          }))
          quads = quads.concat(tagged)
        }
        palette = Array.from(counts.keys()).map((key) => {
          const at = key.indexOf(':')
          const cellNamespace = at >= 0 ? key.slice(0, at) : namespace
          const cellBlock = at >= 0 ? key.slice(at + 1) : key
          // A vanilla block's name comes from the extraction (the game's own lang
          // file), not from the project pack -- which has never heard of it.
          const fromReference = refNameOf(cellNamespace, cellBlock)
          return { block: key, label: fromReference || labelFor(cellNamespace, 'block', cellBlock), count: counts.get(key) }
        })
        palette.sort((a, b) => b.count - a.count)
        refs = [rel(root, dir + '/mc-art.atlas.json')].concat((item.refs || []).map((r) => rel(root, dir + '/' + r)))
      }

      const textureIds = []
      const seenTex = {}
      for (const quad of quads) if (seenTex[quad.tex] !== true) { seenTex[quad.tex] = true; textureIds.push(quad.tex) }
      const already = {}
      if (Array.isArray(have)) for (const path of have) already[path] = true
      const textures = {}
      for (const path of textureIds) {
        if (already[path] === true) continue
        const url = await textureUrlFor(path)
        if (url !== undefined) textures[path] = url
      }
      return { kind: kind, id: id, title: labelFor(namespace, kind, id),
        project: project.title || project.id,
        quads: quads, textureIds: textureIds, textures: textures,
        animations: animationsFor(textureIds),
        cells: cells, faceStep: FACE_STEP,
        refs: refs, ref: refs[0], palette: palette, box: boxOfQuads(quads), errors: errors.slice(0, 8) }
    }

    // 这个 shell 服务的**执行方法叫什么**，两代不一样：
    //   0.1.x（本仓库开发用的那套）：`resolve(request)` + `run(spec)`（交互式还有 `start(spec)`）
    //   0.2.0-rc.x（Windows 桌面端）：`resolve(request)` + `execute(spec)`，**没有 run/start**
    // 实测报错就是 `shellOf(...).run is not a function`。形状子集是兼容的（都回
    // {exitCode, stdout:{text}, stderr:{text}}），所以这里只做方法名探测。
    async function shellExec(spec) {
      const service = shellOf()
      if (service === undefined) return { exitCode: null, text: '', err: 'no shell service' }
      if (typeof service.run === 'function') return await service.run(spec)
      if (typeof service.execute === 'function') return await service.execute(spec)
      return { exitCode: null, text: '', err: '这个 shell 服务既没有 run() 也没有 execute()：' +
        Object.keys(service).join(',') }
    }

    /** 把两代的结果形状收成同一种（stdout/stderr 可能是 {text} 也可能是字符串）。 */
    function shellText(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      return value.text === undefined ? String(value) : String(value.text)
    }

    async function runShell(command, timeoutMs, sandboxPolicy, maxBytes) {
      if (shellOf() === undefined) return { exitCode: null, text: '', err: 'no shell service' }
      // The cap is per call, not a constant: a namespace listing is genuinely
      // ~190 KB (AoA3 alone is 1403 blocks), and the 64 KB default truncated it
      // into invalid JSON.  A silently cut payload is worse than a slow one.
      const request = { command: command, timeoutMs: timeoutMs === undefined ? 20000 : timeoutMs,
        stdoutMaxBytes: maxBytes === undefined ? 64 * 1024 : maxBytes }
      if (sandboxPolicy !== undefined) request.sandboxPolicy = sandboxPolicy
      const spec = shellOf().resolve(request)
      const result = await shellExec(spec)
      return { exitCode: result.exitCode === undefined ? null : result.exitCode,
        text: shellText(result.stdout), err: shellText(result.stderr) }
    }

    async function available(tool) {
      const dialect = await currentShell('')
      const result = await runShell(dialect.available(tool), 10000)
      return result.exitCode === 0 && String(result.text).trim().length > 0
    }

    // ── 这个 shell 说的是哪种方言 ────────────────────────────────────────────
    // DSH 按平台换 shell：POSIX 上是 `bash -c`，Windows 上是
    // `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`——dsh-base 的
    // cordis.patch.yml 里 bash 那几行在 win32 上 disabled、pwsh 那几行启用
    // （tool-bash/tool-pwsh 同理）。所以 `$(printf … | base64 -d)`、`rm -f`、
    // `mv -f`、`command -v` 在 Windows 上一个都不是命令。
    //
    // 这里是"谁在给我跑命令"的唯一真相：探一次，然后所有命令都按方言拼。
    // 探法：`$($PSVersionTable.PSVersion.Major)` 在 bash 里是个跑不通的命令替换
    // （展开成空），在 PowerShell 里展开成 5 或 7。
    const PS_QUOTE = (value) => "'" + String(value).split("'").join("''") + "'"
    const SHELLS = {
      posix: {
        name: 'posix',
        word: (value) => shellDecoded(value),
        available: (tool) => 'command -v ' + tool,
        remove: (path) => 'rm -f ' + shellDecoded(path),
        makeDir: (path) => 'mkdir -p ' + shellDecoded(path),
        move: (from, to) => 'mv -f ' + shellDecoded(from) + ' ' + shellDecoded(to),
        // 从暂存文件解开（命令行里只有路径）；writeInline 只在没有 fs 服务时兜底。
        decodeFile: (source, target) =>
          'base64 -d < ' + shellDecoded(source) + ' > ' + shellDecoded(target),
        writeInline: (target, base64) =>
          'printf %s ' + quoteRaw(base64) + ' | base64 -d > ' + shellDecoded(target),
      },
      pwsh: {
        name: 'pwsh',
        word: (value) => PS_QUOTE(value),
        available: (tool) => '(Get-Command ' + PS_QUOTE(tool) + ' -ErrorAction SilentlyContinue) -ne $null',
        remove: (path) => 'Remove-Item -LiteralPath ' + PS_QUOTE(path) + ' -Force -ErrorAction SilentlyContinue',
        // -Force 让"已存在"也返回成功（幂等）；[IO.Directory] 比 New-Item 少一层 cmdlet 开销。
        makeDir: (path) => '[IO.Directory]::CreateDirectory(' + PS_QUOTE(path) + ') | Out-Null',
        move: (from, to) => 'Move-Item -LiteralPath ' + PS_QUOTE(from) +
          ' -Destination ' + PS_QUOTE(to) + ' -Force',
        // .NET 一次解码；暂存文件的内容由 fs 服务写（见 writeDecodedFile），
        // 所以命令行里同样只有路径——Windows 的 32767 字符上限碰不到。
        decodeFile: (source, target) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String([IO.File]::ReadAllText(' + PS_QUOTE(source) + ')))',
        writeInline: (target, base64) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String(' + PS_QUOTE(base64) + '))',
      },
    }
    let shellDialect = null
    /** 诊断用：平台与探针各说了什么（`atlas.env` 里回读）。 */
    let shellProbeInfo = null
    async function currentShell(workspaceRoot) {
      if (shellDialect !== null) return SHELLS[shellDialect]
      // **先看平台，再看探针**。平台是事实，探针是猜测 —— 而"探针失败就当成 POSIX"
      // 曾经在 Windows 上造成过一句彻头彻尾错的提示：所有命令都按 bash 拼，
      // `command -v powershell.exe` 自然找不到，于是面板说
      // 「这个环境既没有 powershell.exe（Windows/WSL）也没有 zenity/kdialog/yad」。
      // 用户当场就问"为啥啊" —— 因为 Windows 上 powershell.exe 怎么可能没有。
      const platform = platformOf()
      if (platform === 'win32') {
        shellProbeInfo = { platform: platform, dialect: 'pwsh', why: '按平台定的（没跑探针）' }
        shellDialect = 'pwsh'
        return SHELLS.pwsh
      }
      if (platform === 'linux' || platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos' || platform === 'aix') {
        shellProbeInfo = { platform: platform, dialect: 'posix', why: '按平台定的（没跑探针）' }
        shellDialect = 'posix'
        return SHELLS.posix
      }
      // 平台问不到（只在动态插件那种没有 `process` 的环境里）才让探针说话。
      const probe = await runShell('echo "mcart-shell:$($PSVersionTable.PSVersion.Major)"', 20000,
        policyFor(workspaceRoot), 4096)
      shellProbeInfo = { platform: platform, exitCode: probe.exitCode,
        text: String(probe.text).slice(0, 80), err: String(probe.err).slice(0, 80) }
      // 探不通就不下结论、也不缓存：服务没起来的时候不该把这个会话钉在错的方言上。
      if (probe.exitCode !== 0) return SHELLS.posix
      shellDialect = /^mcart-shell:\d+/.test(String(probe.text).trim()) ? 'pwsh' : 'posix'
      return SHELLS[shellDialect]
    }

    /**
     * 这台机器上的 Windows PowerShell 在哪。
     *
     * 以前只用 `command -v powershell.exe`（`Get-Command`）问 shell —— 那等于把
     * "能不能弹目录对话框"押在"宿主进程的 PATH 恰好和用户终端一样"上。现在先看
     * **绝对路径**（SystemRoot 下那个是 Windows 自带的固定位置），再看 PATH，最后 `pwsh`。
     */
    async function windowsPowerShell() {
      const root = (envOf('SystemRoot') || 'C:/Windows').split(BACKSLASH).join('/')
      const absolute = [
        root + '/System32/WindowsPowerShell/v1.0/powershell.exe',
        'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ]
      for (const candidate of absolute) {
        const info = await statOf(candidate)
        if (info !== undefined && info.type === 'file') return candidate
      }
      for (const name of ['powershell.exe', 'pwsh']) {
        if (shellOf() !== undefined && await available(name)) return name
      }
      return null
    }

    /**
     * 把 base64 解成一个文件——**分两步，命令行里永远只有路径**。
     *
     * 为什么不直接把 base64 拼进命令：Windows 的命令行总长上限约 32767 字符，
     * 一张 128×128 的贴图 base64 就有几十 KB，塞进 `pwsh -Command` 会失败，
     * 而且失败得含糊（"命令行太长"）。而且图片内容本来就不该经过一个会被日志和
     * 引号规则来回揉的通道。
     *
     * 所以：base64 当**文本**用 fs 服务写进一个暂存文件（同一条 sandbox 策略，
     * 且 fsOf().writeText 对长度没意见），shell 只负责"把这个文件解成字节"。
     * 没有 fs 服务时才退回把 payload 拼进命令的老办法（那时数据也小）。
     */
    async function writeDecodedFile(target, base64, workspaceRoot, timeoutMs) {
      // 第一条路：fs 写暂存文本 + shell 解码（都带同一条 sandbox 策略）。
      if (shellOf() !== undefined) {
        const dialect = await currentShell(workspaceRoot)
        const policy = policyFor(workspaceRoot)
        const staging = target + '.mcart-b64'
        const staged = await writeTextFile(staging, base64, workspaceRoot)
        if (staged.ok !== true) {
          return { ok: false, exitCode: null, err: String(staged.detail), step: 1, steps: 2 }
        }
        const done = await runShell(dialect.decodeFile(staging, target), timeoutMs, policy)
        const cleanup = await runShell(dialect.remove(staging), 15000, policy)
        if (done.exitCode === 0) {
          return { ok: true, steps: 2, dialect: dialect.name, stagingRemoved: cleanup.exitCode === 0 }
        }
        // shell 在但这一步没过：只有本地垫片还能试，否则就是它的报错。
        const local = localOf()
        if (local === null) {
          return { ok: false, exitCode: done.exitCode, err: done.err, step: 2, steps: 2 }
        }
        try {
          await local.writeBase64(target, base64)
          return { ok: true, steps: 1, dialect: dialect.name, via: 'node:fs',
            shellSaid: 'exit=' + String(done.exitCode) }
        } catch (error) {
          return { ok: false, exitCode: done.exitCode,
            err: beforeStderr(String(done.err)) + ' | node:fs: ' + messageOf(error), step: 2, steps: 2 }
        }
      }
      // 没有 shell：base64 直接交给本地垫片写字节，一步到位、没有暂存文件。
      const local = localOf()
      if (local === null) {
        return { ok: false, exitCode: null, step: 0, steps: 1,
          err: '宿主既没有 shell 服务，也没有本地文件系统垫片' }
      }
      try {
        await local.writeBase64(target, base64)
        return { ok: true, steps: 1, via: 'node:fs' }
      } catch (error) {
        return { ok: false, exitCode: null, step: 0, steps: 1, err: messageOf(error) }
      }
    }

    /**
     * 建目录（幂等）——**四条路，逐条报自己的失败原因**。
     *
     * 顺序是有讲究的：
     *   1. `directoryPickerController.createDirectory(parent, name)`：harness 自己的
     *      "新建文件夹"API（目录选择器用的就是它），非递归、已存在会抛 EEXIST，
     *      所以先 stat 过才调；
     *   2. `shell`：方言拼出来的真 mkdir（0.1.x / 0.2.0-rc 都能用）；
     *   3. `fs` 服务：写一个占位文件进去——`dsh-fs-local` 的 writeFileAtomic 第一件事
     *      就是 `mkdir(dirname, {recursive:true})`（两代都是），所以父目录会被建出来。
     *      代价是空目录里多一个 `.gitkeep`（git 本来也追踪不了空目录，不是纯负担）；
     *   4. `node:fs` 垫片：最后的退路，结果里写 via=node:fs。
     *
     * 返回 { ok, via, placeholder, detail }，绝不返回裸布尔——调用方要能把
     * "到底哪条路试过、各说什么"原样端给用户。
     */
    async function ensureDir(path, workspaceRoot, depth) {
      if (await isDirectoryOf(path)) return { ok: true, via: 'existing' }
      const tried = []
      const level = depth === undefined ? 0 : depth
      const picker = ctx.get('directoryPickerController')
      if (picker !== undefined && typeof picker.createDirectory === 'function') {
        const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        if (cut > 0) {
          const parent = path.slice(0, cut)
          const name = path.slice(cut + 1)
          try {
            await picker.createDirectory(parent, name)
            return { ok: true, via: 'directoryPickerController' }
          } catch (error) {
            // 这个 API 是**非递归**的：父目录不在就 ENOENT（'textures/block' 这种
            // 中间层不在目录清单里时就会撞上）。先把父目录建出来，再试一次；
            // 深度上限只是防呆，正常调用不会接近它。
            if (level < 8) {
              const up = await ensureDir(parent, workspaceRoot, level + 1)
              if (up.ok === true) {
                try {
                  await picker.createDirectory(parent, name)
                  return { ok: true, via: 'directoryPickerController' }
                } catch (again) { tried.push('directoryPickerController: ' + messageOf(again)) }
              } else {
                tried.push('directoryPickerController: ' + messageOf(error) +
                  '；父目录也建不出来：' + String(up.detail))
              }
            } else tried.push('directoryPickerController: ' + messageOf(error))
          }
        } else tried.push('directoryPickerController: 路径里没有父目录')
      } else tried.push('directoryPickerController: 宿主没有这个服务')
      if (shellOf() !== undefined) {
        const done = await shellFileOp(workspaceRoot, (dialect) => dialect.makeDir(path), 20000)
        if (done.ok === true) return { ok: true, via: 'shell' }
        const detail = beforeStderr(done.err === undefined || done.err === null ? '' : done.err)
        tried.push('shell: 退出码 ' + String(done.exitCode) + (detail === '' ? '，没有错误输出' : '，' + detail))
      } else tried.push('shell: 宿主没有这个服务')
      if (fsOf() !== undefined) {
        try {
          const target = await fsOf().resolve(path + '/.gitkeep')
          await fsOf().writeText(target, '', undefined, undefined, policyFor(workspaceRoot))
          return { ok: true, via: 'fs', placeholder: true }
        } catch (error) { tried.push('fs: ' + messageOf(error)) }
      } else tried.push('fs: 宿主没有这个服务')
      const local = localOf()
      if (local !== null) {
        try {
          await local.mkdirp(path)
          return { ok: true, via: 'node:fs' }
        } catch (error) { tried.push('node:fs: ' + messageOf(error)) }
      } else tried.push('node:fs: 这个运行时里没有文件系统垫片')
      return { ok: false, detail: tried.join('；') }
    }

    /** 一条收尾命令（删/移），按方言拼；shell 不行时落到本地垫片。 */
    async function shellFileOp(workspaceRoot, build, timeoutMs) {
      if (shellOf() === undefined) return { ok: false, exitCode: null, err: 'no shell service' }
      const dialect = await currentShell(workspaceRoot)
      const done = await runShell(build(dialect), timeoutMs, policyFor(workspaceRoot))
      return { ok: done.exitCode === 0, exitCode: done.exitCode, err: done.err }
    }

    async function removeFile(path, workspaceRoot) {
      const done = await shellFileOp(workspaceRoot, (dialect) => dialect.remove(path), 15000)
      if (done.ok === true) return { ok: true, via: 'shell' }
      const local = localOf()
      if (local === null) return { ok: false, detail: String(done.err) }
      try {
        await local.remove(path)
        return { ok: true, via: 'node:fs' }
      } catch (error) { return { ok: false, detail: messageOf(error) } }
    }

    async function moveFile(from, to, workspaceRoot) {
      const done = await shellFileOp(workspaceRoot, (dialect) => dialect.move(from, to), 20000)
      if (done.ok === true) return { ok: true, via: 'shell' }
      const local = localOf()
      if (local === null) return { ok: false, exitCode: done.exitCode, detail: String(done.err) }
      try {
        await local.move(from, to)
        return { ok: true, via: 'node:fs' }
      } catch (error) {
        return { ok: false, exitCode: done.exitCode, detail: messageOf(error) }
      }
    }

    async function runDialog(command, sandboxPolicy, workspaceRoot) {
      if (shellOf() === undefined) return ''
      const request = { command: command, stdoutMaxBytes: 64 * 1024 }
      if (sandboxPolicy !== undefined) request.sandboxPolicy = sandboxPolicy
      const spec = shellOf().resolve(request)
      // 交互式（要边跑边读输出，比如弹系统目录对话框）只有 0.1.x 那代有 `start`；
      // 0.2.0-rc 只有 `execute`，那就等它跑完再收输出 —— 目录对话框本来也是"选完才返回"。
      if (typeof shellOf().start === 'function') {
        const process = await shellOf().start(spec)
        await process.done
        return String(process.readOutput().delta)
      }
      const done = await shellExec(spec)
      return shellText(done.stdout)
    }

    async function convertPath(flag, value) {
      const trimmed = String(value === undefined || value === null ? '' : value).trim()
      if (trimmed === '') return null
      if (hasWslpath === null) hasWslpath = await available('wslpath')
      if (hasWslpath !== true) return null
      const result = await runShell('wslpath ' + flag + ' ' + shellDecoded(trimmed), 15000)
      if (result.exitCode !== 0) return null
      const converted = beforeStderr(result.text)
      return converted === '' ? null : converted
    }

    // The fs service is the abstraction for writing, and it takes the sandbox
    // policy PER CALL.  Omitting it left the backend its own default, and the
    // write was fenced off -- which showed up as a bare "写入失败" with no why.
    // Now: fs first (with an explicit policy), shell second (also explicit), and
    // both failures are reported verbatim -- plus the local shim third, because
    // "one of these two services is missing" must not mean "cannot write".
    async function writeTextFile(path, text, workspaceRoot) {
      const policy = policyFor(workspaceRoot)
      let fsDetail = null
      if (fsOf() !== undefined) {
        try {
          const target = await fsOf().resolve(path)
          await fsOf().writeText(target, text, undefined, undefined, policy)
          return { ok: true, via: 'fs' }
        } catch (error) {
          fsDetail = messageOf(error)
        }
      } else {
        fsDetail = 'no fs service'
      }
      let shellDetail = 'no shell service'
      if (shellOf() !== undefined) {
        const dialect = await currentShell(workspaceRoot)
        const result = await runShell(dialect.writeInline(path, base64OfString(text)), 20000, policy)
        if (result.exitCode === 0) return { ok: true, via: 'shell' }
        const detail = beforeStderr(result.err === undefined || result.err === null ? '' : result.err)
        shellDetail = 'exit=' + result.exitCode + (detail === '' ? '' : ' err=' + detail)
      }
      const local = localOf()
      if (local !== null) {
        try {
          await local.writeText(path, text)
          return { ok: true, via: 'node:fs' }
        } catch (error) {
          return { ok: false, detail: 'fs: ' + fsDetail + ' | shell: ' + shellDetail +
            ' | node:fs: ' + messageOf(error) }
        }
      }
      return { ok: false, detail: 'fs: ' + fsDetail + ' | shell: ' + shellDetail +
        ' | node:fs: 这个运行时里没有文件系统垫片' }
    }

    ctx.effect(() => harness.handle('atlas.pickDirectory', async (args) => {
      const request = args || {}
      const start = typeof request.start === 'string' ? request.start : ''
      // 不要因为"没有 shell 服务"就放弃：subprocess 一样能起 powershell.exe 弹对话框
      // （用户桌面端就是这种宿主：会话里的 pwsh 好用，宿主层拿不到 shell 服务）。
      if (shellOf() === undefined && subprocessOf() === undefined) {
        return { supported: false, detail: '宿主既没有 shell 服务也没有 subprocess，起不了目录对话框。' }
      }
      try {
        const powerShell = await windowsPowerShell()
        if (powerShell !== null) {
          const winStart = await convertPath('-w', start)
          const lines = [
            '$ProgressPreference = "SilentlyContinue"',
            'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
            "$d.Description = '选择目录'",
            '$d.ShowNewFolderButton = $false',
          ]
          if (winStart !== null) lines.push("$d.SelectedPath = '" + winStart.split("'").join("''") + "'")
          lines.push('if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write("' + PICK_BEGIN + '" + $d.SelectedPath + "' + PICK_END + '") }')
          // 优先 argv 起（不需要 shell 服务）。桌面端实测：会话里的 pwsh 工具好用，
          // 但宿主层拿不到 shell 服务 —— 那种情况下这条路是唯一能弹对话框的。
          const encoded = utf16leBase64(lines.join('\n'))
          const dialog = await withDeadline(async () => {
            let text = ''
            const argvRun = await runProcess([powerShell, '-NoProfile', '-STA', '-EncodedCommand', encoded],
              { cwd: start, maxBytes: 64 * 1024, graceMs: 3000 })
            if (argvRun !== null) text = String(argvRun.text)
            if (text === '' && shellOf() !== undefined) {
              const quoting = await currentShell(start)
              text = await runDialog(quoting.word(powerShell) + ' -NoProfile -STA -EncodedCommand ' + encoded,
                policyFor(start))
            }
            return text
          }, 120000)
          if (dialog !== null && typeof dialog === 'object' && dialog.deadlineExpired === true) {
            return { supported: false, platform: platformOf() || null,
              detail: '目录对话框 120 秒没有返回 —— 这条路在你的环境里可能用不了（对话框既不显示也不结束）。' }
          }
          const output = String(dialog)
          const picked = betweenMarkers(output)
          if (picked === '') return { supported: true, cancelled: true, via: 'windows', exe: powerShell }
          const converted = await convertPath('-u', picked)
          const usable = converted !== null ? converted : picked
          const info = await statOf(usable)
          if (info !== undefined && info.type === 'directory') return { path: usable, raw: picked, via: 'windows', exe: powerShell }
          return { supported: true, error: '你选的是 ' + picked + '，但宿主打不开它（转换后：' + usable + '）。' }
        }
        const linuxPickers = [
          { tool: 'zenity', command: 'zenity --file-selection --directory --title="选择目录"' },
          { tool: 'yad', command: 'yad --file --directory --title="选择目录"' },
          { tool: 'kdialog', command: 'kdialog --getexistingdirectory "$HOME" "选择目录"' },
        ]
        for (const picker of linuxPickers) {
          if (!(await available(picker.tool))) continue
          const picked = beforeStderr(await runDialog(picker.command))
          if (picked === '') return { supported: true, cancelled: true, via: picker.tool }
          const info = await statOf(picked)
          if (info !== undefined && info.type === 'directory') return { path: picked, raw: picked, via: picker.tool }
          return { supported: true, error: '选择器返回了 ' + picked + '，但打不开这个目录。' }
        }
        // 措辞要**如实**：说的是"这台宿主里没找到可用的对话框"，并且把平台与试过的东西
        // 都写出来 —— 上一版在这里断言"没有 powershell.exe"，而 Windows 上那句话
        // 基本一定是错的（真实原因是方言探针失败，命令按 bash 拼的）。
        return { supported: false, platform: platformOf() || null, shellDialect: shellDialect,
          detail: '这个宿主里没找到能用的目录对话框（平台 ' + (platformOf() || '问不到') +
            '；试过 powershell.exe 的绝对路径与 PATH、以及 zenity/yad/kdialog）。' }
      } catch (error) {
        return { error: '目录选择器出错：' + String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.settings', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const file = project.dir + '/mc-art.settings.json'
        const stored = (await readJson(file)) || {}
        const reference = stored.reference !== null && typeof stored.reference === 'object' ? stored.reference : {}
        const chosen = reference.mods !== null && typeof reference.mods === 'object' ? reference.mods : {}
        // No directory is invented here.  This used to fall back to
        // <project>/refroot, purely because that folder happened to exist, so the
        // panel reported the 12 hand-picked textures in it as "the reference"
        // while the real vanilla + mod assets were never opened.  Unset stays
        // unset, and the panel says so instead of showing a wrong answer.
        const directory = typeof reference.directory === 'string' ? reference.directory : ''
        const scanner = await findScanner(project.dir)
        const scanned = await scanReference(scanner, directory)
        const detected = directory === '' ? await detectGameRoots(project.dir) : []
        return {
          // Both the absolute file and the workspace-relative one: the skill
          // reads the file, and "@ 提意见"/"让 AI 知道" needs a path it can name.
          // Guessing `<project>/mc-art.settings.json` is the guess that breaks
          // when a project is not a direct child of the root.
          path: rel(root, file),
          project: project.id, title: project.title, file: file,
          directory: directory,
          shape: scanned.shape, textures: scanned.textures,
          sources: (scanned.sources || []).slice(0, 80),
          scanError: scanned.error,
          scanner: scanner,
          detected: detected,
          includeGenerated: reference.includeGenerated !== false,
          includeMods: reference.includeMods !== false,
          mods: (scanned.namespaces || []).map((item) => ({ name: item.name, count: item.count,
            from: item.from || [], on: chosen[item.name] !== false })),
        }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // 「面板到底去哪儿找过游戏目录」——一条命令看清候选与命中。
    // 设置页那条"检测到 … 用它"曾经在 Windows 上永远是空的（检测逻辑是 WSL 形状的），
    // 而界面上没有别的办法指定参考目录。这条方法让"为什么没检测到"变成一句话。
    ctx.effect(() => harness.handle('atlas.gameRoots', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = projectId === '' ? undefined : await projectFor(root, projectId)
        const near = project === undefined ? root : project.dir
        return { near: near, candidates: gameRootCandidates(near), detected: await detectGameRoots(near),
          platform: typeof process === 'undefined' ? null : process.platform }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.saveSettings', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const mods = {}
        if (request.mods !== null && typeof request.mods === 'object') {
          for (const key of Object.keys(request.mods)) {
            if (typeof request.mods[key] === 'boolean') mods[key] = request.mods[key]
          }
        }
        const file = project.dir + '/mc-art.settings.json'
        // Merge, do not replace.  This writer used to emit a fixed object, so
        // any field it did not know about -- `reference.version`, say -- was
        // silently deleted the next time the panel saved.  A file that declares
        // its own schema version must not lose what a newer reader added.
        const stored = (await readJson(file)) || {}
        const storedReference = stored.reference !== null && typeof stored.reference === 'object'
          ? stored.reference : {}
        const payload = Object.assign({}, stored, {
          schema: 'mc-art.settings/1',
          reference: Object.assign({}, storedReference, {
            directory: typeof request.directory === 'string' ? request.directory : '',
            includeGenerated: request.includeGenerated !== false,
            includeMods: request.includeMods !== false,
            mods: mods,
          }),
        })
        const outcome = await writeTextFile(file, JSON.stringify(payload, null, 2) + '\n', root)
        if (outcome.ok !== true) return { error: String(outcome.detail) }
        return { saved: true, file: file, path: rel(root, file), via: outcome.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The fs service has no binary write: `writeText` decodes and re-encodes
    // UTF-8, which corrupts a PNG.  Bytes therefore go through the shell the
    // same way the settings file already does -- and the result is read back
    // and checked, because a half-written or non-PNG file would only show up
    // much later as a mysteriously broken texture.
    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10]

    ctx.effect(() => harness.handle('atlas.saveTexture', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const path = typeof request.path === 'string' ? request.path : ''
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (path === '' || base64 === '') return { error: '缺少贴图路径或图像数据' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        // An ITEM's textures arrive as `ref:` handles (`ref:<命名空间>:item/<物品>`),
        // because that is how the flat-icon path names them; a block's arrive as
        // paths.  The pen writes FILES, so a handle has to be resolved to the one
        // it stands for -- this is the whole reason "血晶这种物体不能修改贴图".
        // The map is filled while the item is extracted, from the extractor's own
        // `textureFiles`, so it is the real file and not a guess from the name.
        let target = path
        if (path.slice(0, 4) === 'ref:') {
          const resolved = editablePaths.get(path)
          if (resolved === undefined) {
            const pack0 = project.dir + '/pack/assets/'
            return { error: '这张贴图不在这个项目的资源包里（它在参考的 jar 里），改不了：' + path }
          }
          target = resolved
        }
        const pack = project.dir + '/pack/assets/'
        if (target.indexOf(pack) !== 0) {
          // This is a brush, not a general file writer.
          return { error: '这张贴图不在这个项目的资源包里，拒绝写：' + target }
        }
        // Write beside the original, check it, and only then move it into place.
        // Writing straight over the texture meant a bad encode destroyed the
        // sprite *before* anyone noticed it was not a PNG.
        //
        // 三个动作（写/移/删）都按 shell 方言拼：Windows 上这条路径原来写的
        // `printf | base64 -d`、`mv -f`、`rm -f` 一个都不是命令，而贴图正是
        // 面板最核心的写入——不修的话 Windows 用户"能看不能改"。
        // 这里**不再**用 shellOf() 提前退出：写字节的退路是 node:fs 垫片，
        // 移/删也各有一条，四条路都断了才会在下面逐条报出来。
        const temp = target + '.mcart-tmp'
        async function discard(reason) {
          const cleanup = await removeFile(temp, root)
          return { error: reason + (cleanup.ok === true ? '（原文件没有被改动）' : '（临时文件也没清掉：' + temp + '）') }
        }
        const written = await writeDecodedFile(temp, base64, root, 30000)
        if (written.ok !== true) {
          const detail = beforeStderr(written.err === undefined || written.err === null ? '' : written.err)
          return await discard('写入失败（退出码 ' + written.exitCode + '，第 ' + written.step + '/' + written.steps + ' 步）' +
            (detail === '' ? '，没有错误输出' : '：' + detail))
        }
        const staged = await statOf(temp)
        if (staged === undefined || staged.type !== 'file') return await discard('写完之后读不到临时文件')
        if (staged.size === undefined || staged.size === 0) return await discard('写出来的是个空文件')
        const bytes = await readBytesOf(temp, 8 * 1024 * 1024)
        if (bytes === undefined) return await discard('写完之后读不出它的字节')
        for (let i = 0; i < PNG_MAGIC.length; i++) {
          if (bytes[i] !== PNG_MAGIC[i]) {
            return await discard('写出来的不是 PNG（开头 ' + Array.prototype.slice.call(bytes, 0, 8).join(',') + '）')
          }
        }
        const moved = await moveFile(temp, target, root)
        if (moved.ok !== true) {
          return await discard('换上新图失败（退出码 ' + String(moved.exitCode) + '）：' + String(moved.detail))
        }
        const info = await statOf(target)
        if (info === undefined || info.type !== 'file') return { error: '换上新图之后读不到它：' + target }
        return { saved: true, path: target, bytes: info.size }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The atlas is normally produced by tools/emit_atlas.py; this is the one
    // place the viewer writes it, and only the `cells` of one entry.  A manual
    // structure therefore makes `emit_atlas.py --check` report drift, which is
    // the truth: the file is no longer only what the generator produced.
    // 新建一个项目（= 一个模组 = 一个命名空间）。
    //
    // 为什么要有它：空目录里面板只能说"没找到项目"，新手卡在第一步。这里写最小骨架 ——
    // `mc-art.atlas.json` + `pack/assets/<命名空间>/` 下的几个空目录（宿主靠这两样认项目）。
    // **一个模组一个命名空间**是硬约束：目录里已经有别的命名空间就拒绝，免得一个模组里
    // 长出第二个命名空间（那正好是"一个命名空间一个真相"要防的事）。
    const PROJECT_ID = /^[a-z0-9_]{2,32}$/
    ctx.effect(() => harness.handle('atlas.createProject', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const id = typeof request.id === 'string' ? request.id.trim() : ''
      const asked = typeof request.namespace === 'string' ? request.namespace.trim() : ''
      const namespace = asked === '' ? id : asked
      if (root === '') return { error: '没有给定根目录' }
      if (!PROJECT_ID.test(id)) return { error: '项目 id 只能用小写字母、数字、下划线，2-32 个字符：' + JSON.stringify(id) }
      if (!PROJECT_ID.test(namespace)) return { error: '命名空间只能用小写字母、数字、下划线，2-32 个字符：' + JSON.stringify(namespace) }
      try {
        const dir = root + '/' + id
        if ((await statOf(dir + '/mc-art.atlas.json')) !== undefined) {
          return { error: '这个目录里已经有项目了：' + id }
        }
        const existing = (await listDir(dir + '/pack/assets')).filter((entry) => entry.type === 'directory')
        const others = existing.map((entry) => entry.name)
        if (others.length > 0 && others.indexOf(namespace) < 0) {
          return { error: '这个项目的资源包里已经有命名空间 ' + others.join('、') +
            '。一个模组只用一个命名空间：用已有的那个，或者换一个目录。' }
        }
        // **先建目录再写文件**——但不是因为 fs.writeText 建不了父目录
        // （`dsh-fs-local` 的 writeFileAtomic 第一句就是 mkdir recursive；第一版之所以
        // 看到 ENOENT，是本地测试桩的 writeText 比真货**严**：桩不建父目录。桩比被替身的
        // 东西更严，是一个永远不会红的门禁。桩已经改成和真货一样），而是因为骨架目录本来
        // 就该由"建项目"这一步建出来，而不是碰到哪个文件才顺手长出来。
        const folders = ['pack', 'pack/assets', 'pack/assets/' + namespace,
          'pack/assets/' + namespace + '/textures/block', 'pack/assets/' + namespace + '/models/block',
          'pack/assets/' + namespace + '/blockstates', 'pack/assets/' + namespace + '/lang']
        // 建目录这件事有四条路（见 ensureDir）。同一个项目里的目录只要第一条路走通了
        // 就不再试后面的——失败了却要一次说清，所以失败时把原因并起来。
        //
        // **项目目录自己也要先建出来**：`directoryPickerController.createDirectory` 是
        // 非递归的（父目录必须在），所以不能只建 pack —— 之前只建 pack 的那版，
        // 一旦走到选择器那条路就是 ENOENT（门禁当场抓到）。
        const used = {}
        let placeholder = false
        const targets = [dir].concat(folders.map((folder) => dir + '/' + folder))
        for (const target of targets) {
          const made = await ensureDir(target, root)
          if (made.ok !== true) {
            return { error: '建目录失败：' + rel(root, target) + ' → ' + String(made.detail),
              dir: dir, folders: folders.length }
          }
          used[made.via] = (used[made.via] === undefined ? 0 : used[made.via]) + 1
          if (made.placeholder === true) placeholder = true
        }
        const atlas = { schema: 'mc-art.atlas/1', namespace: namespace,
          biomes: [], structures: [], entities: [], blocks: [] }
        const wrote = await writeTextFile(dir + '/mc-art.atlas.json', JSON.stringify(atlas, null, 2) + '\n', root)
        if (wrote.ok !== true) return { error: '写 atlas 失败：' + String(wrote.detail) }
        return { created: true, id: id, namespace: namespace, dir: dir,
          atlas: rel(root, dir + '/mc-art.atlas.json'), folders: folders.length,
          via: Object.keys(used).sort().map((key) => key + '×' + used[key]).join(' + '),
          placeholder: placeholder, atlasVia: wrote.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.saveVoxel', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const kind = request.kind === 'biome' ? 'biome' : (request.kind === 'structure' ? 'structure' : '')
      const id = typeof request.id === 'string' ? request.id : ''
      if (kind === '' || id === '') return { error: '只有群系和多方块结构能这样改' }
      const cells = normalizeCells(request.cells)
      if (cells.length === 0) return { error: '一格都没有，拒绝把结构写空' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        // One cell holds one block.  Two at the same coordinate have exactly
        // equal depth, so the strict test keeps whichever drew first and the
        // other disappears without a word while the palette still counts it.
        const taken = {}
        for (const cell of cells) {
          const at = cell.at.join(',')
          if (taken[at] === true) return { error: '同一个格子放了两个方块：' + at }
          taken[at] = true
        }
        const file = project.dir + '/mc-art.atlas.json'
        const atlas = await readJson(file)
        if (atlas === undefined) return { error: '读不了图谱：' + file }
        const key = kind === 'biome' ? 'biomes' : 'structures'
        const list = Array.isArray(atlas[key]) ? atlas[key] : []
        const item = list.filter((entry) => entry.id === id)[0]
        if (item === undefined) return { error: '图谱里没有这个 ' + kind + '：' + id }
        item.cells = cells
        const outcome = await writeTextFile(file, JSON.stringify(atlas, null, 2) + '\n', root)
        if (outcome.ok !== true) return { error: String(outcome.detail) }
        return { saved: true, file: file, kind: kind, id: id, cells: cells.length, via: outcome.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The ghost for one block at one coordinate, plus the textures it needs.
    ctx.effect(() => harness.handle('atlas.preview', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const block = typeof request.block === 'string' ? request.block : ''
      // `at` is optional: the viewer asks for the brush block at the origin
      // just to learn its 朝向 choices, before anything is hovered.
      const at = Array.isArray(request.at) && request.at.length >= 3
        ? [Math.trunc(request.at[0]), Math.trunc(request.at[1]), Math.trunc(request.at[2])] : [0, 0, 0]
      const variant = typeof request.variant === 'string' && request.variant !== '' ? request.variant : null
      // The neighbours the viewer can see around the hovered cell.  Offsets are
      // relative to `at`, so the ghost is drawn from the same rules the placed
      // block will be.
      const around = Array.isArray(request.around) ? request.around.slice(0, 32) : []
      if (block === '') return { error: '预览需要方块名' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const built = await blockQuadsAt(root, project, block, at, variant, around)
        if (built.error !== undefined) return { error: built.error }
        const textureIds = []
        const seen = {}
        for (const quad of built.quads) if (seen[quad.tex] !== true) { seen[quad.tex] = true; textureIds.push(quad.tex) }
        const already = {}
        if (Array.isArray(request.have)) for (const path of request.have) already[path] = true
        const textures = {}
        for (const path of textureIds) {
          if (already[path] === true) continue
          const url = await textureUrlFor(path)
          if (url !== undefined) textures[path] = url
        }
        return { block: block, at: at, quads: built.quads, textureIds: textureIds, textures: textures,
          animations: animationsFor(textureIds),
          variants: built.variants || [], axes: built.axes || [], defaults: built.defaults || {},
          multipart: built.multipart === true, derived: built.derived === true,
          variant: built.variant === undefined ? null : built.variant }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // A 16x16 icon per block, for the hotbar.  The first texture the model
    // reaches is the one a player would recognise.
    ctx.effect(() => harness.handle('atlas.icons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const wanted = Array.isArray(request.blocks) ? request.blocks.slice(0, 120) : []
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const icons = {}
        const failed = []
        for (const block of wanted) {
          if (typeof block !== 'string' || block === '' || icons[block] !== undefined) continue
          const reference = block
          const colon = reference.indexOf(':')
          const namespace = colon >= 0 ? reference.slice(0, colon) : project.namespace
          const name = colon >= 0 ? reference.slice(colon + 1) : reference
          const load = await ensure(namespace)
          if (load === undefined) { failed.push(reference + '（资源包 ' + namespace + ' 没载入）'); continue }
          const elements = elementsOf(load, 'block/' + name)
          if (elements === undefined) { failed.push(reference + '（没有模型）'); continue }
          const first = elements.length > 0 && elements[0].faces !== undefined
            ? Object.keys(elements[0].faces)[0] : undefined
          const tex = first === undefined ? undefined : elements[0].faces[first].tex
          const url = tex === undefined ? undefined : await textureUrlFor(tex)
          if (url === undefined) { failed.push(reference + '（没有贴图）'); continue }
          icons[block] = url
        }
        return { icons: icons, failed: failed.slice(0, 6) }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.scan', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      if (root === '') return { rootSpecified: false, projects: [], errors: [] }
      errors.length = 0
      const index = await indexOf(root)
      const projects = index.projects.map((project) => ({
        id: project.id, title: project.title, namespace: project.namespace, root: project.root,
        items: {
          biome: project.biomes.map((item) => ({ id: item.id, title: item.title })),
          structure: project.structures.map((item) => ({ id: item.id, title: item.title })),
          entity: project.entities.map((item) => ({ id: item.id, title: item.title })),
          block: project.blocks.map((item) => ({ id: item.id, title: item.title })),
        },
      }))
      return { rootSpecified: true, root: root, projects: projects, errors: errors.slice(0, 8), cached: index.cached }
    }))

    ctx.effect(() => harness.handle('atlas.projects', async (args) => {
      const request = args || {}
      const base = typeof request.path === 'string' ? request.path : ''
      if (base === '') return { error: '没有给定目录' }
      try {
        const parents = []
        const addParent = (value) => { if (value !== null && value !== undefined && parents.indexOf(value) < 0) parents.push(value) }
        if (await looksLikeProject(base)) addParent(parentOf(base))
        const entries = await listDir(base)
        for (const entry of entries) {
          if (entry.type !== 'directory') continue
          const child = entry.target !== undefined && typeof entry.target.displayPath === 'string' && entry.target.displayPath.length > 0
            ? entry.target.displayPath : base + '/' + entry.name
          if (await looksLikeProject(child)) addParent(base)
        }
        const results = []
        for (const parent of parents) {
          const index = await indexOf(parent)
          for (const project of index.projects) {
            results.push({ root: parent, id: project.id, title: project.title, namespace: project.namespace, dir: project.dir })
          }
        }
        return { base: base, projects: results }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // 「这台机器上我到底能看见什么」——一句话问清。
    //
    // 存在的理由很具体：面板上一句"宿主没有 shell 服务时建不出目录"曾经让人以为
    // 服务真的不在，而实际上那句话谁也没查过。现在失败信息自己带原因（见 ensureDir），
    // 这个方法把同一件事变成**可读的一行**：哪些服务在、哪条退路可用、方言是什么。
    // 别人机器上再出问题，让他们点一下这个，比猜十轮快。
    ctx.effect(() => harness.handle('atlas.env', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' && request.root !== '' ? request.root : '.'
      const picker = ctx.get('directoryPickerController')
      const services = {
        fs: fsOf() !== undefined,
        shell: shellOf() !== undefined,
        sessions: sessionsOf() !== undefined,
        webServer: ctx.get('webServer') !== undefined,
        directoryPickerController: picker !== undefined && typeof picker.createDirectory === 'function',
        localFs: localOf() !== null,
        subprocess: ctx.get('subprocess') !== undefined,
      }
      let dialect = null
      if (services.shell) {
        try { dialect = (await currentShell('')).name } catch (error) { dialect = 'probe failed: ' + messageOf(error) }
      }
      const missing = Object.keys(services).filter((key) => services[key] !== true)
      // 参考目录这条路依赖的三样东西分别在哪儿 —— 它们每一个都曾经"看着有、其实没有"，
      // 而失败信息里说不清。这里一次答完：脚本路径、Python 解释器、捆绑运行时目录、
      // 以及 shell 方言是**按平台定的**还是探针说的。
      const scanner = await findScanner(root)
      const extractor = await findTool(root, EXTRACT_SCRIPT)
      let python = null
      try { python = await resolvePython(root) } catch (error) { python = 'probe failed: ' + messageOf(error) }
      return { services: services, shellDialect: dialect,
        platform: platformOf() || null,
        node: typeof process === 'undefined' ? null : process.version,
        missing: missing,
        scanner: scanner, extractor: extractor, python: python, pythonVia: pythonVia,
        pythonCandidates: pythonCandidates().slice(0, 8),
        bundledPythonDirs: bundledPythonDirs(),
        shellProbe: shellProbeInfo,
        powershell: platformOf() === 'win32' ? await windowsPowerShell() : null,
        moduleDir: moduleDirOf() || null,
        note: missing.length === 0 ? '每一条路都在。'
          : '缺 ' + missing.join('、') + '；每一件写入都会自动走能用的那条路（建目录/写文件/写字节各有退路），结果里会写 via=…' }
    }))

    ctx.effect(() => harness.handle('atlas.scene', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      if (root === '') return { error: 'no asset root specified' }
      try {
        const index = await indexOf(root)
        const project = index.projects.filter((item) => item.id === request.project)[0]
        if (project === undefined) return { error: 'project not found: ' + request.project }
        return await payload(root, project, request.kind, request.id, request.have, request.cells,
          request.neighbours)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.session', async (args) => {
      const request = args || {}
      try {
        const id = typeof request.sessionId === 'string' ? request.sessionId : ''
        const session = (sessionsOf() === undefined || id === '') ? undefined : sessionsOf().get(id)
        if (session === undefined) return { cwd: null }
        const cwd = session.header.cwd
        return { cwd: typeof cwd === 'string' ? cwd : null }
      } catch (error) {
        return { cwd: null, error: String(error && error.message ? error.message : error) }
      }
    }))

    // Which namespaces the reference can offer, so the builder can let the user
    // pick vanilla or a mod instead of only the open project's own blocks.
    ctx.effect(() => harness.handle('atlas.refNamespaces', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { namespaces: [], directory: '', reason: '没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        // The count must be BLOCKSTATES in the version the extractor will
        // actually read.  The PNG scanner counts textures across every installed
        // version, so it reported "minecraft 13209 张" for a namespace this tool
        // can offer 407 blocks out of -- a number you cannot get.
        const parsed = await runScanner(extractor, ['--root', directory, '--namespaces'],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        // A mod that ships only sounds or textures is not a choice; listing it
        // only to say "没有方块" when picked is noise.
        const out = (parsed.namespaces || []).filter((item) => item.blocks > 0)
        return { directory: directory, version: parsed.version, versionWhy: parsed.versionWhy,
          namespaces: out, extractor: extractor }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The item picker's list: names, presentation form and family, no textures
    // (a page's icons are fetched separately, one process for the whole page).
    ctx.effect(() => harness.handle('atlas.refItems', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '') return { error: '没有指定命名空间' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        return await itemFactsList(project, namespace, source)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // One page of icons, recipes and textures together.
    ctx.effect(() => harness.handle('atlas.itemIcons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const wanted = Array.isArray(request.items) ? request.items.slice(0, 60) : []
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '' || wanted.length === 0) return { items: {} }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        return await itemIconPage(project, namespace, wanted.filter((id) => typeof id === 'string' && id !== ''), source)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // One item, with its texture payload (the big preview, and the 3D switch).
    ctx.effect(() => harness.handle('atlas.icon', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const item = typeof request.item === 'string' ? request.item : ''
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '' || item === '') return { error: '图标需要一个命名空间和一个物品名' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const entry = await referenceLoadItem(root, project, namespace, item, source)
        if (entry.error !== undefined) return { error: entry.error }
        return await itemIcon(namespace, entry.parsed, request.have, project)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.refBlocks', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      if (namespace === '') return { error: '没有指定命名空间' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { error: '还没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        const signature = await refSignatureOf(directory)
        const cacheKey = 'list:' + namespace
        const cached = referenceBlocks.get(cacheKey)
        if (cached !== undefined && cached.signature === signature) return cached.value
        const parsed = await runScanner(extractor, ['--root', directory, '--list', '--namespace', namespace],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        const value = { namespace: namespace, version: parsed.version, blocks: parsed.blocks || [] }
        referenceBlocks.set(cacheKey, { signature: signature, value: value })
        return value
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // Icons for a whole namespace in ONE process.  One process per block measured
    // at ~0.4s, which would be half a minute of nothing for a hotbar row.
    ctx.effect(() => harness.handle('atlas.refIcons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const wanted = Array.isArray(request.blocks) ? request.blocks.slice(0, 120) : []
      if (namespace === '' || wanted.length === 0) return { icons: {}, names: {} }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { error: '还没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        const parsed = await runScanner(extractor,
          ['--root', directory, '--namespace', namespace, '--icons', wanted.join(',')],
          180000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        const icons = {}
        const names = {}
        for (const id of Object.keys(parsed.icons || {})) {
          const item = parsed.icons[id]
          // Keyed exactly like a project icon so the hotbar does not care which
          // kind of block it is holding.
          icons[namespace + ':' + id] = 'data:image/png;base64,' + item.png
          names[namespace + ':' + id] = item.name
        }
        return { icons: icons, names: names, failed: parsed.failed || [], version: parsed.version }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // Drop extracted blocks nothing references any more.  The user's rule:
    // extract on demand, keep what is actually used, forget it when the block is
    // deleted.  `keep` is what the caller still holds, so this cannot guess.
    // What SURVIVES decides which shared `ref:` handles may go -- see
    // `releaseUnused`, which is where that lives so it can be tested on its own.
    ctx.effect(() => harness.handle('atlas.releaseRefs', async (args) => {
      const request = args || {}
      const keep = {}
      if (Array.isArray(request.keep)) for (const key of request.keep) keep[String(key)] = true
      return releaseUnused(referenceBlocks, keep, referenceTextures, referenceAnimations)
    }))

    console.log('mc-art atlas host ready (unqualified cell blocks resolve to their project; vanilla and mod blocks are extracted on demand)')
  },
}
