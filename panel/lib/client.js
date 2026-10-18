// 生成物：由 panel/build.mjs 从 tools/mcart-plugin/client.js 生成 —— 不要手改。
window.__ModuleLoader__.load({
  // 必须是包名：client-modules 拿启动图里那一行的 id 来 factories 里找它。
  id: "dsh-mc-art-panel",
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 真包世界里 React 是 require 来的；动态插件世界里它是注入的绑定。
    var React = require('react')

    // 三个垫片，对齐动态插件里注入的那三个名字。
    function ensureStyles(css) {
      var id = "dsh-mc-art-panel:styles"
      if (typeof document === 'undefined') return function () {}
      var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = "dsh-mc-art-panel"
        tag.dataset.pluginCss = id
        tag.textContent = css
        document.head.appendChild(tag)
      }
      return function () { if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag) }
    }
    var styles = { insert: ensureStyles }
    var host = {
      call: function (method, args) {
        return fetch('/api/mcart/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: String(method), args: args === undefined ? null : args }),
        }).then(function (response) {
          return response.json().then(function (value) { return value })
        }).catch(function (error) {
          // 不抛：面板里到处都是 failureOf(reply)，返回一个 {error} 更好处理。
          return { error: '面板与宿主的信道断了：' + String(error && error.message ? error.message : error) }
        })
      },
    }

    // 源码**内联**成函数体，不做运行时求值：浏览器的沙箱禁掉了求值型加载
    // （0.2.1 起），而这一半正是被那个禁令打死的。静态函数体在同样的沙箱里执行。
    var plugin = (function (React, host, styles, console, PANEL_VERSION) {
    // >>> mcart:embedded-source
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vlen = (a) => Math.sqrt(dot(a, a))
function unit(a) { const n = vlen(a); return n < 1e-12 ? [0, 0, 0] : mul(a, 1 / n) }


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
    position: position, target: target, right: right, up: up, forward: forward,
    focal: focal, width: width, height: height,
  }
}


function boxCorners(box) {
  const out = []
  for (let i = 0; i < 8; i++) {
    out.push([
      (i & 1) === 1 ? box.max[0] : box.min[0],
      (i & 2) === 2 ? box.max[1] : box.min[1],
      (i & 4) === 4 ? box.max[2] : box.min[2],
    ])
  }
  return out
}


function orbitCamera(box, yaw, pitch, zoom, width, height, fovY) {
  const centre = mul(add(box.min, box.max), 0.5)
  const corners = boxCorners(box)
  const cp = Math.cos(pitch)
  const direction = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp]
  const hud = Math.min(56, Math.max(0, height * 0.2))
  const usableH = Math.max(32, height - hud)
  const margin = 0.88
  const halfW = Math.max(1, width * margin / 2)
  const halfH = Math.max(1, usableH * margin / 2)
  const z = Math.max(zoom, 0.01)
  let distance = Math.max(vlen(sub(box.max, box.min)) / 2, 0.05)
    / Math.sin(fovY / 2) / z * 1.2
  let camera = null
  for (let pass = 0; pass < 6; pass++) {
    camera = makeCamera(add(centre, mul(direction, distance)), centre, width, height, fovY)
    let worst = 0
    for (const corner of corners) {
      const p = camera.project(corner)
      if (p === null) { worst = Math.max(worst, 8); continue }
      worst = Math.max(worst, Math.abs(p[0] - width / 2) / halfW,
        Math.abs(p[1] - height / 2) / halfH)
    }
    if (worst <= 1 && worst >= 0.9) break
    distance *= Math.max(0.5, worst)
  }
  const shift = (hud / 2) * (distance / Math.max(camera.focal, 1e-6))
  const target = sub(centre, mul(camera.up, shift))
  return makeCamera(add(target, mul(direction, distance)), target, width, height, fovY)
}

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
  const colour = options.colour === undefined ? new Float64Array(width * height * 4) : options.colour
  const depth = options.depth === undefined ? new Float64Array(width * height) : options.depth
  const overlay = options.overlay === undefined ? null : options.overlay
  const tint = options.tint === undefined ? null : options.tint
  const backgroundAlpha = options.backgroundAlpha === undefined ? 1 : options.backgroundAlpha
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


const FACE_AXIS = { down: 'y', up: 'y', north: 'z', south: 'z', west: 'x', east: 'x' }
const FACE_OPPOSITE = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' }
const HORIZONTAL_FACES = { north: true, south: true, west: true, east: true }

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


function canonicalVariant(parts) {
  return Object.keys(parts).sort().map((name) => name + '=' + parts[name]).join(',')
}


function deriveVariant(axes, face, hitY, flip) {
  const out = {}
  const horizontal = HORIZONTAL_FACES[face] === true
  for (const axis of axes) {
    const name = axis.name
    if (name === 'axis') {
      if (FACE_AXIS[face] !== undefined) out[name] = FACE_AXIS[face]
      continue
    }
    if (name === 'facing') {
      const value = flip && horizontal ? FACE_OPPOSITE[face] : face
      if (value !== undefined && axis.values.indexOf(value) >= 0) out[name] = value
      continue
    }
    if (name === 'half') {
      const value = face === 'down' ? 'top' : (face === 'up' ? 'bottom' : (hitY > 0.5 ? 'top' : 'bottom'))
      if (axis.values.indexOf(value) >= 0) out[name] = value
      continue
    }
  }
  return out
}


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
  if (Object.keys(parts).length !== axes.length) return null
  const key = canonicalVariant(parts)
  return (keys || []).indexOf(key) >= 0 ? key : null
}


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


const GUI_FACE_SHADE = { up: 1.0, east: 0.637, north: 0.435,
  down: 0.4, south: 0.4, west: 0.4 }
const GUI_FACE_SHADE_FLAT = { up: 1.0, east: 0.417, north: 0.624,
  down: 0.4, south: 0.841, west: 0.543 }


function guiItemRotation(quads, rotation, table) {
  const yaw = rotation === undefined || rotation === null ? 0 : (rotation[1] || 0)
  const pitch = rotation === undefined || rotation === null ? 0 : (rotation[0] || 0)
  const shade = table === undefined || table === null ? GUI_FACE_SHADE : table
  return quads.map((quad) => {
    let p = quad.p
    if (yaw) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'y', yaw))
    if (pitch) p = p.map((point) => rotateAbout(point, [0.5, 0.5, 0.5], 'x', pitch))
    const lit = quad.shaded === false ? (quad.shade === undefined ? 1.0 : quad.shade)
      : (shade[quad.face] === undefined ? 1.0 : shade[quad.face])
    return { p: p, uv: quad.uv, tex: quad.tex, shade: lit, mode: quad.mode,
      face: quad.face, shaded: quad.shaded }
  })
}


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


function drawGroundGrid(paint, camera, width, height, box) {
  const ground = box.min[1]
  const spanX = Math.max(box.max[0] - box.min[0], 1)
  const spanZ = Math.max(box.max[2] - box.min[2], 1)
  const extent = Math.max(spanX, spanZ) * 1.6
  const step = extent / 8
  const cx = (box.min[0] + box.max[0]) / 2
  const cz = (box.min[2] + box.max[2]) / 2
  const half = extent / 2
  const line = (from, to, style) => {
    const a = camera.project(from)
    const b = camera.project(to)
    if (a === null || b === null) return
    paint.strokeStyle = style
    paint.beginPath()
    paint.moveTo(a[0], a[1])
    paint.lineTo(b[0], b[1])
    paint.stroke()
  }
  paint.lineWidth = 1
  for (let i = -4; i <= 4; i++) {
    const at = i * step
    const strong = i === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.06)'
    line([cx + at, ground, cz - half], [cx + at, ground, cz + half], strong)
    line([cx - half, ground, cz + at], [cx + half, ground, cz + at], strong)
  }
  return { extent: extent, step: step }
}


function drawItemIcon(canvas, recipe, frameIndex, decoded) {
  const width = canvas.width, height = canvas.height
  const paint = canvas.getContext('2d')
  paint.clearRect(0, 0, width, height)
  if (recipe === null || recipe === undefined) return
  if (recipe.shape === 'iso') {
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
  const out = new Uint8ClampedArray(width * height * 4)
  for (const id of layers) {
    const texture = decoded === undefined ? undefined : decoded[id]
    if (texture === undefined || texture.data === undefined) continue
    const sw = texture.width
    const sh = texture.height
    if (!(sw > 0 && sh > 0)) continue
    const animation = (recipe.animations || {})[id]
    const strip = stripOf({ width: sw, height: sh, animation: animation })
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


function clearViewport(canvas, width, height) {
  canvas.width = width
  canvas.height = height
  const paint = canvas.getContext('2d')
  if (paint !== null && paint !== undefined) paint.clearRect(0, 0, width, height)
}


function itemIconUrl(recipe, decoded, size) {
  if (recipe === null || recipe === undefined) return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  drawItemIcon(canvas, recipe, 0, decoded)
  return canvas.toDataURL('image/png')
}


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
  '.mcart-root{'
    + '--mc-bg-0:var(--dsw-alias-bg-base,Canvas);'
    + '--mc-bg-1:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));'
    + '--mc-bg-2:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));'
    + '--mc-overlay:var(--dsw-alias-bg-overlay,rgba(24,24,28,.98));'
    + '--mc-line-1:var(--dsw-alias-border-l1,rgba(255,255,255,.13));'
    + '--mc-line-2:var(--dsw-alias-border-l2,rgba(255,255,255,.24));'
    + '--mc-text-1:var(--dsw-alias-label-primary,rgba(236,236,241,.94));'
    + '--mc-text-2:var(--dsw-alias-label-secondary,rgba(236,236,241,.58));'
    + '--mc-brand:var(--dsw-alias-brand-primary,#4f9cf9);'
    + '--mc-brand-bar:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f9cf9) 75%,'
    + 'var(--dsw-alias-label-primary,#ececf1));'
    + '--mc-error:var(--dsw-alias-state-error-primary,#e06c6c);'
    + '--mc-warn:var(--dsw-alias-state-warn-primary,#e0a06c);'
    + '--mc-ok:var(--dsw-alias-state-success-primary,#7fc98a);'
    + '--mc-idle:var(--dsw-alias-state-idle-primary,rgba(236,236,241,.6));'
    + '--mc-hover:color-mix(in srgb,var(--mc-text-1) 4%,transparent);'
    + '--mc-active:color-mix(in srgb,var(--mc-text-1) 8%,transparent);'
    + '--mc-select:color-mix(in srgb,var(--mc-brand) 8%,transparent);'
    + '--mc-s1:2px;--mc-s2:4px;--mc-s3:6px;--mc-s4:8px;'
    + '--mc-fs:12px;--mc-fs2:11px;--mc-lh:22px;--mc-row:26px;--mc-toolbar:28px;'
    + '--mc-control:22px;--mc-section:22px;--mc-label:88px;--mc-icon:14px;'
    + '--mc-radius:2px;--mc-radius-panel:3px;'
    + '--mc-mono:ui-monospace,Consolas,monospace;'
    + '--mc-canvas-bg:#141317;--mc-hud-bg:rgba(20,20,24,.8);'
    + 'display:flex;flex-direction:column;gap:var(--mc-s4);padding:var(--mc-s4);'
    + 'height:100%;box-sizing:border-box;overflow:hidden;container-type:inline-size;'
    + 'color:var(--mc-text-1);background:var(--mc-bg-0);'
    + 'font:var(--mc-fs)/var(--mc-lh) system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.mcart-title{font-size:var(--mc-fs2);font-weight:600;color:var(--mc-text-2)}',
  '.mcart-sub{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-note{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-hint{font-size:var(--mc-fs2);line-height:14px;color:var(--mc-text-2);'
    + 'padding-left:calc(var(--mc-label) + var(--mc-s3))}',
  '.mcart-path,.mcart-id,.mcart-report,.mcart-reportnote{font-family:var(--mc-mono);'
    + 'font-size:var(--mc-fs2);font-variant-numeric:tabular-nums}',
  '.mcart-path{color:var(--mc-text-2);word-break:break-all;min-width:0}',
  '.mcart-id{color:var(--mc-text-2);margin-left:var(--mc-s2)}',
  '.mcart-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-group{display:flex;flex-direction:column}',
  '.mcart-group+.mcart-group{border-top:1px solid var(--mc-line-1);'
    + 'margin-top:var(--mc-s2);padding-top:var(--mc-s2)}',
  '.mcart-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;'
    + 'height:var(--mc-toolbar);min-height:var(--mc-toolbar);gap:var(--mc-s2);'
    + 'padding:0 var(--mc-s4);margin:calc(-1 * var(--mc-s4)) calc(-1 * var(--mc-s4)) 0;'
    + 'background:var(--mc-bg-0);border-bottom:1px solid var(--mc-line-1)}',
  '.mcart-head>.mcart-title{color:var(--mc-text-1)}',
  '.mcart-headpath{font-family:var(--mc-mono);font-size:var(--mc-fs2);color:var(--mc-text-2);'
    + 'font-variant-numeric:tabular-nums;min-width:0;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap}',
  '.mcart-headgrow{flex:1;min-width:var(--mc-s2)}',
  '.mcart-head .mcart-btn,.mcart-head .mcart-icon{background:transparent;border-color:transparent;'
    + 'height:var(--mc-control);flex:none}',
  '.mcart-head .mcart-btn:hover,.mcart-head .mcart-icon:hover{background:var(--mc-hover)}',
  '.mcart-head .mcart-btn+.mcart-btn,.mcart-head .mcart-btn+.mcart-icon,'
    + ' .mcart-head .mcart-icon+.mcart-btn,.mcart-head .mcart-icon+.mcart-icon{'
    + 'border-left:1px solid var(--mc-line-1);border-radius:0;padding-left:var(--mc-s1)}',
  '.mcart-toolbar{display:flex;align-items:center;gap:var(--mc-s2);height:var(--mc-toolbar);'
    + 'min-height:var(--mc-toolbar)}',
  '.mcart-toolbar-facts{font-family:var(--mc-mono);font-size:var(--mc-fs2);'
    + 'font-variant-numeric:tabular-nums;color:var(--mc-text-2);white-space:nowrap}',
  '.mcart-toolbar-grow{flex:1;min-width:var(--mc-s2)}',
  '.mcart-primary{color:var(--mc-brand);border-color:var(--mc-brand);background:transparent}',
  '.mcart-primary:hover{background:var(--mc-select);border-color:var(--mc-brand)}',
  '.mcart-bar{display:flex;align-items:center;gap:var(--mc-s2);flex-wrap:wrap}',
  '.mcart-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;'
    + 'flex-direction:column;gap:var(--mc-s4);scrollbar-width:thin;'
    + 'scrollbar-color:var(--dsw-scrollbar-thumb,var(--mc-line-2)) transparent;'
    + 'overscroll-behavior:contain}',
  '.mcart-stage{flex:1;min-height:0;display:flex;flex-direction:column;gap:var(--mc-s2)}',
  '.mcart-card{border:0;border-top:1px solid var(--mc-line-1);border-radius:0;'
    + 'padding:var(--mc-s2) 0;display:flex;flex-direction:column;gap:var(--mc-s2);'
    + 'background:transparent}',
  '.mcart-card>.mcart-bar:first-child{min-height:var(--mc-section);height:var(--mc-section);'
    + 'padding:0;border-bottom:1px solid var(--mc-line-1)}',
  '.mcart-prop{display:grid;grid-template-columns:var(--mc-label) 1fr;align-items:center;'
    + 'min-height:var(--mc-row);column-gap:var(--mc-s3);padding:1px 0}',
  '.mcart-prop-label{font-size:var(--mc-fs2);color:var(--mc-text-2);text-align:right;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mcart-prop-value{display:flex;align-items:center;gap:var(--mc-s2);min-width:0;'
    + 'font-size:var(--mc-fs2);color:var(--mc-text-1)}',
  '.mcart-src{display:flex;align-items:center;gap:var(--mc-s2)}',
  '.mcart-tabs,.mcart-tools{display:flex;gap:var(--mc-s2);flex-wrap:wrap;align-items:center}',
  '.mcart-btn{height:var(--mc-control);padding:0 var(--mc-s3);box-sizing:border-box;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);'
    + 'background:var(--mc-bg-1);color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs2);'
    + 'line-height:20px;white-space:nowrap;cursor:pointer;flex:none}',
  '.mcart-btn:hover{background:var(--mc-active);border-color:var(--mc-line-2)}',
  '.mcart-btn:active{background:var(--mc-active)}',
  '.mcart-btn[disabled]{opacity:.4;cursor:default;background:var(--mc-bg-1)}',
  '.mcart-tool[data-on="1"]{background:var(--mc-select);border-color:var(--mc-brand)}',
  '.mcart-icon{width:var(--mc-control);height:var(--mc-control);display:inline-flex;'
    + 'align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--mc-radius);'
    + 'background:none;color:var(--mc-text-2);font:inherit;font-size:var(--mc-icon);'
    + 'line-height:1;cursor:pointer}',
  '.mcart-icon:hover{background:var(--mc-hover);color:var(--mc-text-1)}',
  '.mcart-icon[data-on="1"]{background:var(--mc-select);color:var(--mc-text-1)}',
  '.mcart-input,.mcart-select{height:var(--mc-control);box-sizing:border-box;min-width:0;'
    + 'padding:0 var(--mc-s3);border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);'
    + 'background:var(--mc-bg-2);color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs2)}',
  '.mcart-input{flex:1}',
  '.mcart-select{flex:1;padding:0 var(--mc-s1)}',
  '.mcart-input:hover,.mcart-select:hover{border-color:var(--mc-line-2)}',
  '.mcart-input:disabled,.mcart-select:disabled{opacity:.4;cursor:default}',
  '.mcart-input[type="number"]{text-align:right;font-family:var(--mc-mono);'
    + 'font-variant-numeric:tabular-nums}',
  '.mcart-input[type="range"],.mcart-alpha{accent-color:var(--mc-brand)}',
  '.mcart-slot[disabled],.mcart-swatch[disabled]{opacity:.4;cursor:default}',
  '.mcart-btn:focus-visible,.mcart-icon:focus-visible,.mcart-input:focus-visible,'
    + '.mcart-select:focus-visible,.mcart-item:focus-visible,.mcart-slot:focus-visible,'
    + '.mcart-hudslot:focus-visible,.mcart-swatch:focus-visible,.mcart-picker:focus-visible,'
    + '.mcart-hudpage:focus-visible,.mcart-switch:focus-within{'
    + 'outline:1px solid var(--mc-brand);outline-offset:-1px}',
  '.mcart-switch{display:flex;align-items:center;gap:var(--mc-s2);min-height:var(--mc-row);'
    + 'font-size:var(--mc-fs2);cursor:pointer}',
  '.mcart-switch input[type="checkbox"]{appearance:none;-webkit-appearance:none;'
    + 'width:20px;height:12px;margin:0;flex:none;position:relative;border-radius:var(--mc-radius);'
    + 'border:1px solid var(--mc-line-2);background:var(--mc-bg-2);cursor:pointer}',
  '.mcart-switch input[type="checkbox"]::after{content:"";position:absolute;top:1px;left:1px;'
    + 'width:8px;height:8px;border-radius:var(--mc-radius);background:var(--mc-text-2)}',
  '.mcart-switch input[type="checkbox"]:checked{background:var(--mc-brand);border-color:var(--mc-brand)}',
  '.mcart-switch input[type="checkbox"]:checked::after{left:9px;background:var(--mc-bg-0)}',
  '.mcart-empty{font-size:var(--mc-fs2);color:var(--mc-text-2);padding:var(--mc-s2) 0}',
  '.mcart-loading{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-bad,.mcart-err{font-size:var(--mc-fs2);line-height:14px;word-break:break-all;'
    + 'border-left:2px solid;padding-left:var(--mc-s3)}',
  '.mcart-bad{color:var(--mc-warn);border-left-color:var(--mc-warn)}',
  '.mcart-err{color:var(--mc-error);border-left-color:var(--mc-error)}',
  '.mcart-details{font-size:var(--mc-fs2);line-height:14px;color:var(--mc-text-2);'
    + 'margin-top:var(--mc-s1)}',
  '.mcart-details>summary{cursor:pointer;width:max-content}',
  '.mcart-details>.mcart-report{margin:var(--mc-s1) 0 0}',
  '.mcart-list{flex:1;min-height:0;overflow:auto;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s1)}',
  '.mcart-row{display:flex;align-items:center;gap:var(--mc-s2);height:var(--mc-lh);'
    + 'padding:0 var(--mc-s2);border-left:2px solid transparent}',
  '.mcart-row:hover{background:var(--mc-hover)}',
  '.mcart-item{display:flex;align-items:center;gap:var(--mc-s2);width:100%;'
    + 'height:var(--mc-lh);padding:0 var(--mc-s2);text-align:left;'
    + 'border:0;border-left:2px solid transparent;border-radius:0;background:none;'
    + 'color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs);cursor:pointer}',
  '.mcart-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-item-id{flex:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    + 'font-family:var(--mc-mono);font-size:var(--mc-fs2);font-variant-numeric:tabular-nums;'
    + 'color:var(--mc-text-2);text-align:right}',
  '.mcart-group-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;'
    + 'height:var(--mc-section);min-height:var(--mc-section);padding:0 var(--mc-s2);'
    + 'background:var(--mc-bg-0);border-bottom:1px solid var(--mc-line-1);'
    + 'font-size:var(--mc-fs2);font-weight:600;color:var(--mc-text-2)}',
  '.mcart-item:hover{background:var(--mc-hover)}',
  '.mcart-item:active{background:var(--mc-active)}',
  '.mcart-item[data-on="1"]{background:var(--mc-select);border-left-color:var(--mc-brand-bar)}',
  '.mcart-projects{max-height:240px;overflow:auto;display:flex;flex-direction:column;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);padding:var(--mc-s1)}',
  '.mcart-mods{border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s1) var(--mc-s2);display:flex;flex-direction:column;max-height:200px;'
    + 'overflow:auto}',
  '.mcart-chip{font-size:var(--mc-fs2);padding:0 var(--mc-s3);height:var(--mc-control);'
    + 'box-sizing:border-box;border-radius:var(--mc-radius);background:var(--mc-bg-1);'
    + 'color:var(--mc-text-2)}',
  '.mcart-list,.mcart-hotbar,.mcart-swatches,.mcart-projects,.mcart-mods{'
    + 'scrollbar-width:thin;scrollbar-color:var(--dsw-scrollbar-thumb,var(--mc-line-2)) transparent;'
    + 'overscroll-behavior:contain}',
  '.mcart-canvas{width:100%;height:100%;min-height:180px;display:block;'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-canvas-bg);'
    + 'border:1px solid var(--mc-line-1);cursor:grab;touch-action:none}',
  '.mcart-canvas:active{cursor:grabbing}',
  '.mcart-viewport{position:relative;flex:1;min-height:0}',
  '.mcart-zoom{position:absolute;right:var(--mc-s2);top:var(--mc-s2);display:flex;'
    + 'gap:var(--mc-s1);opacity:.9}',
  '.mcart-zoom:hover{opacity:1}',
  '.mcart-zoombtn{width:var(--mc-control);height:var(--mc-control);padding:0;display:inline-flex;'
    + 'align-items:center;justify-content:center;font-size:var(--mc-fs);line-height:1;'
    + 'background:var(--mc-hud-bg);border-color:var(--mc-line-2);color:var(--mc-text-1)}',
  '.mcart-axis{position:absolute;left:var(--mc-s2);bottom:var(--mc-s2);pointer-events:none;'
    + 'opacity:.75}',
  '.mcart-axis line{stroke:var(--mc-text-2);stroke-width:1;stroke-linecap:butt}',
  '.mcart-axis-x{opacity:.9}',
  '.mcart-axis-y{opacity:.65}',
  '.mcart-axis-z{opacity:.45}',
  '.mcart-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'image-rendering:pixelated;pointer-events:none}',
  '.mcart-grip{display:flex;align-items:center;justify-content:center;height:5px;'
    + 'cursor:ns-resize;touch-action:none}',
  '.mcart-gripbar{width:32px;height:1px;background:var(--mc-line-2)}',
  '.mcart-grip:hover .mcart-gripbar{background:var(--mc-brand)}',
  '.mcart-hud{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
    + 'align-items:center;gap:var(--mc-s1);padding:0 var(--mc-s2) var(--mc-s2);pointer-events:none}',
  '.mcart-hudname{position:absolute;right:var(--mc-s2);'
    + 'bottom:calc(var(--mc-control) + var(--mc-s4));font-family:var(--mc-mono);'
    + 'font-size:var(--mc-fs2);font-variant-numeric:tabular-nums;color:var(--mc-text-2);'
    + 'background:none;border:0;padding:0;pointer-events:none;white-space:nowrap}',
  '.mcart-hudbar{display:flex;align-items:center;gap:var(--mc-s1);padding:var(--mc-s1);'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-hud-bg);'
    + 'border:1px solid var(--mc-line-2);pointer-events:auto}',
  '.mcart-hudslot{width:var(--mc-control);height:var(--mc-control);padding:0;flex:none;'
    + 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;'
    + 'border-radius:var(--mc-radius);border:1px solid var(--mc-line-2);'
    + 'background:var(--mc-bg-1);cursor:pointer}',
  '.mcart-hudslot:hover{border-color:var(--mc-brand)}',
  '.mcart-hudslot[data-on="1"]{border-color:var(--mc-brand);outline:1px solid var(--mc-brand);'
    + 'outline-offset:-2px}',
  '.mcart-hudicon{width:18px;height:18px;display:block;image-rendering:pixelated}',
  '.mcart-hudempty{background:transparent;border-color:var(--mc-line-1);cursor:default}',
  '.mcart-hudpage{width:12px;height:var(--mc-control);padding:0;flex:none;font:inherit;'
    + 'font-size:var(--mc-fs);line-height:1;color:var(--mc-text-2);background:none;border:0;'
    + 'cursor:pointer}',
  '.mcart-hudpage:hover{color:var(--mc-text-1)}',
  '.mcart-hudpage[disabled]{opacity:.4;cursor:default}',
  '.mcart-hotbar{display:flex;gap:var(--mc-s1);flex-wrap:wrap;max-height:124px;overflow:auto}',
  '.mcart-slot{width:var(--mc-control);height:var(--mc-control);box-sizing:border-box;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);background:none;'
    + 'background-size:cover;image-rendering:pixelated;padding:0;flex:none;cursor:pointer}',
  '.mcart-slot:hover{border-color:var(--mc-line-2);background-color:var(--mc-hover)}',
  '.mcart-slot[data-on="1"]{border-color:var(--mc-brand);outline:1px solid var(--mc-brand);'
    + 'outline-offset:-2px}',
  '.mcart-slotq{font-size:var(--mc-fs);line-height:1;color:var(--mc-text-2)}',
  '.mcart-slotmissing{font-size:var(--mc-fs2);font-weight:600;color:var(--mc-warn)}',
  '.mcart-slot[data-missing="1"],.mcart-hudslot[data-missing="1"]{border-color:var(--mc-warn)}',
  '.mcart-edit{display:flex;flex-direction:column;gap:var(--mc-s2)}',
  '.mcart-edit-canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain;'
    + 'image-rendering:pixelated;border-radius:var(--mc-radius);background:var(--mc-canvas-bg);'
    + 'margin:var(--mc-s2) 0;cursor:crosshair;touch-action:none}',
  '.mcart-swatches{display:flex;gap:var(--mc-s1);flex-wrap:wrap;max-height:56px;overflow:auto}',
  '.mcart-swatch{width:16px;height:16px;box-sizing:border-box;border-radius:var(--mc-radius);'
    + 'border:1px solid var(--mc-line-2);cursor:pointer;padding:0;flex:none}',
  '.mcart-swatch:hover{border-color:var(--mc-text-2)}',
  '.mcart-color{width:var(--mc-control);height:var(--mc-control);box-sizing:border-box;'
    + 'border-radius:var(--mc-radius);border:1px solid var(--mc-line-1);flex:none}',
  '.mcart-picker{width:32px;height:var(--mc-control);padding:0;border:1px solid var(--mc-line-1);'
    + 'border-radius:var(--mc-radius);background:none;flex:none;cursor:pointer}',
  '.mcart-ref{display:flex;align-items:center;gap:var(--mc-s2);flex-wrap:wrap;'
    + 'padding:var(--mc-s2) var(--mc-s4);border:1px solid var(--mc-line-1);'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-bg-1);font-size:var(--mc-fs2)}',
  '.mcart-ref-path{font-family:var(--mc-mono);color:var(--mc-text-2);word-break:break-all}',
  '.mcart-report{white-space:pre-wrap;word-break:break-word;background:var(--mc-bg-2);'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s3);margin:var(--mc-s1) 0;line-height:14px;max-height:240px;'
    + 'overflow:auto;user-select:text}',
  '.mcart-reportnote{color:var(--mc-text-2);word-break:break-all}',
  '.mcart-stack{display:flex;flex-direction:column;align-items:stretch;gap:var(--mc-s2)}',
  '.mcart-stack>.mcart-btn{align-self:flex-start}',
  '.mcart-prop-value{flex-wrap:wrap}',
  '.mcart-prop-value>.mcart-input{flex:1 1 96px}',
  '.mcart-prop-value>.mcart-btn{flex:none}',
  '@container (max-width:260px){'
    + '.mcart-prop{grid-template-columns:64px 1fr}'
    + '.mcart-hint{padding-left:0}'
    + '.mcart-item-id{max-width:46%}}',
].join('')

const CATEGORIES = [
  { key: 'biome', label: '群系' },
  { key: 'structure', label: '结构' },
  { key: 'entity', label: '实体' },
  { key: 'block', label: '方块' },
]
const TAB_ID = 'mc-art.atlas'

let lastProject = ''
const decoded = {}
const failedTex = {}
const indexes = {}
const imageNodes = {}
const drag = { active: false, x: 0, y: 0, moved: 0 }
let pickBuffer = null
let ghostAsk = ''
const icons = {}
const iconTried = {}
const itemRecipes = {}
const itemUrls = {}
let itemFetchError = ''


function forgetTextures() {
  for (const key of Object.keys(decoded)) delete decoded[key]
  for (const key of Object.keys(failedTex)) delete failedTex[key]
  for (const key of Object.keys(itemUrls)) delete itemUrls[key]
  for (const key of Object.keys(icons)) delete icons[key]
  for (const key of Object.keys(iconTried)) delete iconTried[key]
  for (const key of Object.keys(itemRecipes)) delete itemRecipes[key]
  itemFetchError = ''
}
const hudCanvases = {}
const TINT_REMOVE = [0.85, 0.2, 0.18]
const painting = { active: false }

const EDIT_ZOOM = 18
const EDIT_UNDO = 24
const EDIT_PALETTE = 64

let hudFollowed = ''
const VIEW_H = 240
const VIEW_H_MIN = 140
const VIEW_H_MAX = 760
const gripDrag = { active: false, y: 0, origin: 0 }
const clampViewH = (value) => Math.max(VIEW_H_MIN, Math.min(VIEW_H_MAX, Math.round(value)))

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

const PAGE_SIZE = 20
const ICON_BATCH = 80
const ITEM_PAGE = 40
const HUD_SLOTS = 9



const isAbsent = (value) => value === null || value === undefined
const idsOf = (value) => (isAbsent(value) || !Array.isArray(value.textureIds) ? [] : value.textureIds)
const objectOf = (value) => (isAbsent(value) || typeof value !== 'object' ? {} : value)
const arrayOf = (value) => (Array.isArray(value) ? value : [])


const sceneOf = (payload) => ({
  kind: payload.kind,
  id: payload.id,
  title: payload.title,
  project: payload.project,
  quads: arrayOf(payload.quads),
  textureIds: idsOf(payload),
  textures: objectOf(payload.textures),
  animations: objectOf(payload.animations),
  animationNotes: objectOf(payload.animationNotes),
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


const DIAG_REASON = {
  'project-model-missing': '项目包里缺这个模型文件（要补的是项目自己的文件，不是原版的）',
  'vanilla-parent-missing': '原版母模型没取到（参考目录没设对，或那个 jar 里确实没有）',
  'no-reference-directory': '还没有设置参考目录，原版/模组的模型取不到',
  'reference-jar-missing': '参考目录里找不到对应的 jar',
  'extractor-failed': '抽取器跑失败了（多半是 Python 探测或工具本身的毛病）',
  'parent-cycle': '模型 parent 链成环了',
  'textures-unresolved': '模型解析出来了，但面上引用的贴图取不到（典型：项目模型用了原版的 minecraft:block/…，而参考目录没设或取不到）',
  'no-quads': '整条模型链都完整，但一个面都没产出（例如零厚度平面 + 贴图缺失）',
  'unknown': '原因不明',
}
const DIAG_KIND = { project: '项目里缺', vanilla: '缺的原版母模型' }
const DIAG_LINES = 20
const DIAG_SHOW = 8


function reasonLine(reason) {
  const raw = typeof reason === 'string' ? reason : ''
  if (raw !== '' && Object.prototype.hasOwnProperty.call(DIAG_REASON, raw)) {
    return '原因：' + DIAG_REASON[raw] + '（' + raw + '）'
  }
  if (raw !== '') return '原因：' + raw + '（面板不认识这个 reason，把原值照贴出来）'
  return '原因：unknown（宿主没有给 reason）'
}

const diagnosticOf = (payload) => {
  const raw = payload === null || payload === undefined ? undefined : payload.diagnostic
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  return {
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : 'unknown',
    block: typeof raw.block === 'string' ? raw.block : '',
    missing: arrayOf(raw.missing).filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        kind: entry.kind === 'vanilla' ? 'vanilla' : 'project',
        name: typeof entry.name === 'string' ? entry.name : '',
        fixPath: typeof entry.fixPath === 'string' ? entry.fixPath : '',
      })),
    tried: arrayOf(raw.tried).map((line) => String(line)),
    referenceDirectory: typeof raw.referenceDirectory === 'string' ? raw.referenceDirectory : '',
  }
}


function diagLines(diag, error) {
  const lines = []
  const head = error === null || error === undefined ? '' : String(error).trim()
  if (head !== '') lines.push(head)
  lines.push(reasonLine(diag.reason))
  if (diag.block !== '') lines.push('方块：' + diag.block)
  for (const entry of diag.missing) {
    lines.push('· ' + (DIAG_KIND[entry.kind] || DIAG_KIND.project) + '：'
      + (entry.name === '' ? '（没给名字）' : entry.name)
      + (entry.fixPath === '' ? '' : ' —— 要动这个文件：' + entry.fixPath))
  }
  lines.push(diag.referenceDirectory === ''
    ? '参考目录：没设。点右上角 ⚙ 把 .minecraft / 版本目录 / mods 目录的路径贴进去'
    : '参考目录：' + diag.referenceDirectory)
  if (diag.tried.length > 0) {
    lines.push('已经试过：')
    for (const line of diag.tried) lines.push('  - ' + String(line))
  }
  return lines
}

function diagText(diag, error) {
  const all = diagLines(diag, error)
  if (all.length <= DIAG_LINES) return all.join('\n')
  return all.slice(0, DIAG_LINES).join('\n') + '\n…（还有 ' + (all.length - DIAG_LINES) + ' 行没画出来）'
}


function reportKeyOf(diag) {
  return diag.reason + '|' + diag.block + '|'
    + diag.missing.map((entry) => entry.kind + ':' + entry.name).join(',')
}

const versionTag = () => '（MC 资产面板 ' + String(PANEL_VERSION) + '）'


function withVersion(text) {
  const line = text === null || text === undefined ? '' : String(text)
  if (line === '') return line
  if (line.indexOf('MC 资产面板') >= 0) return line
  if (!/(画不出|取不到|拿不到|失败|没有返回|没写盘)/.test(line)) return line
  return line + versionTag()
}


function isHostUnloaded(text) {
  const line = text === null || text === undefined ? '' : String(text)
  return /宿主已卸载|已注册 0 个方法|宿主没有这个方法/.test(line)
}
function hostRecoveryHint() {
  return {
    title: '面板宿主没有加载成功——插件刚重建过时会出现这种情况。',
    action: '请完全退出并重新打开 DSH（不是刷新页面）。',
  }
}


function safeTextureHandle(id) {
  const text = id === undefined || id === null ? '' : String(id)
  if (text === '') return false
  if (text.indexOf('\u0000') >= 0) return false
  if (/^[a-zA-Z]:/.test(text)) return false
  if (text.charAt(0) === '/' || text.charAt(0) === '\\') return false
  if (text.split(/[\\/]/).indexOf('..') >= 0) return false
  if (text.indexOf('..') >= 0) return false
  return true
}


const ghostOf = (result, base) => ({
  block: base.block,
  at: base.at,
  variant: base.variant,
  loading: false,
  quads: arrayOf(result.quads),
  textures: objectOf(result.textures),
  textureIds: idsOf(result),
  animations: objectOf(result.animations),
})
function countsOf(list, keyOf, labelOf) {
  const out = {}
  for (const entry of list || []) {
    const key = keyOf(entry) || ''
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
let lastBodyScroll = 0
let lastOpened = null
let lastCamera = null
let lastReportKey = ''

const composer = { write: null, draft: '' }
const composerWaiters = []
let composerFilledKey = ''
let autoReportOn = true
let lastAutoVerdict = ''
const AUTO_REPORT_KEY = 'dsh-mc-art.auto-report'
try {
  if (typeof localStorage !== 'undefined' && localStorage !== null && localStorage.getItem(AUTO_REPORT_KEY) === '0') {
    autoReportOn = false
  }
} catch (error) { /* 沙箱里没有 storage：用默认值（开） */ }

function setAutoReport(on) {
  autoReportOn = on === true
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) {
      localStorage.setItem(AUTO_REPORT_KEY, autoReportOn ? '1' : '0')
    }
  } catch (error) { /* 存不下不影响本次会话 */ }
}


function onComposerReady(callback) {
  if (typeof composer.write === 'function') { callback(); return () => {} }
  composerWaiters.push(callback)
  return () => {
    const at = composerWaiters.indexOf(callback)
    if (at >= 0) composerWaiters.splice(at, 1)
  }
}
function composerCaptured() {
  const waiting = composerWaiters.slice()
  composerWaiters.length = 0
  for (const callback of waiting) {
    try { callback() } catch (error) { /* 等的人自己有问题不该拖垮这里 */ }
  }
}


function autoFillDraft(text, key, manual) {
  const body = text === null || text === undefined ? '' : String(text)
  const name = key === undefined || key === null ? '' : String(key)
  if (body === '') { lastAutoVerdict = 'empty'; return 'empty' }
  if (autoReportOn !== true && manual !== true) { lastAutoVerdict = 'off'; return 'off' }
  if (manual !== true && name !== '' && composerFilledKey === name) { lastAutoVerdict = 'done'; return 'done' }
  if (typeof composer.write !== 'function') { lastAutoVerdict = 'no-composer'; return 'no-composer' }
  const current = String(composer.draft === undefined || composer.draft === null ? '' : composer.draft)
  if (manual !== true && current.trim() !== '') { lastAutoVerdict = 'busy'; return 'busy' }
  const base = manual === true && current.trim() !== '' ? current.replace(/\s+$/, '') + ' ' : ''
  composer.write(base + body)
  composerFilledKey = name
  lastAutoVerdict = 'filled'
  return 'filled'
}


function reportForAI(diag, error) {
  return '这是「MC 资产面板」自动生成的报告（面板版本 ' + String(PANEL_VERSION)
    + '；只放进草稿，没有发送，按回车之前都可以改）。'
    + '\n' + diagText(diag, error)
    + '\n请按这份报告直接修，不用再问我。'
}

function reportForBoundary(error) {
  const message = error !== null && error !== undefined && error.message !== undefined
    ? String(error.message) : String(error)
  return '这是「MC 资产面板」自动生成的报告（面板版本 ' + String(PANEL_VERSION)
    + '；只放进草稿，没有发送）。'
    + '\n面板渲染失败：' + message
    + '\n这一条没有结构化诊断（异常发生在渲染期）。请从这句话入手。'
}
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
  inject: ['timer', 'slots'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined || slots === null) {
      console.error('[mcart] slots 服务没就绪，面板不注册（这条要报给宿主，别静默）')
      return
    }
    const timer = ctx.timer
    ctx.effect(() => styles.insert(CSS))

    const tabs = ctx.get('sidebarRightTabs')
    const sidebarRight = ctx.get('sidebarRight')
    function slotHasEntries(name) {
      try {
        if (typeof slots.entries !== 'function') return false
        const list = slots.entries(name)
        return Array.isArray(list) && list.length > 0
      } catch (error) {
        return false
      }
    }
    function rightColumnReady() {
      return ctx.get('sidebarRightTabs') !== undefined &&
        (ctx.get('sidebarRight') !== undefined || slotHasEntries('sidebar.right.pane.tab'))
    }
    const tabsReady = ctx.get('sidebarRightTabs')
    const sidebarRightReady = ctx.get('sidebarRight')
    const inRightColumn = tabsReady !== undefined &&
      (sidebarRightReady !== undefined || slotHasEntries('sidebar.right.pane.tab'))


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
          try {
            autoFillDraft(reportForBoundary(error), 'boundary|'
              + (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)))
          } catch (ignored) { /* 通知失败不该把"报错"这件事本身也弄没 */ }
        }
        render() {
          if (this.state.error === null || this.state.error === undefined) return this.props.children
          const message = this.state.error !== null && this.state.error.message !== undefined
            ? this.state.error.message : this.state.error
          const notice = lastAutoVerdict === 'filled' || lastAutoVerdict === 'done'
            ? '已把这份报告放进输入框（只是草稿，没发送；按回车才会发）'
            : (lastAutoVerdict === 'busy'
              ? '输入框里已经有你写的字，没有动它 —— 报告在上面这段里，选中就能复制'
              : (lastAutoVerdict === 'off'
                ? '「出错时自动把报告放进输入框」现在是关的'
                : (lastAutoVerdict === 'no-composer'
                  ? '这个壳没有给输入框接口 —— 上面这段可以手动选中复制'
                  : '刷新一次；如果仍是这一句，把它连同"MC 资产"面板发给我')))
          return React.createElement('div', { className: 'mcart-root' },
            React.createElement('div', { className: 'mcart-err' },
              '面板渲染失败：' + String(message)),
            React.createElement('div', { className: 'mcart-hint' },
              notice + ' —— 版本：' + String(PANEL_VERSION)),
          )
        }
      }
      : function PanelBoundary(props) { return props.children }


    function failureView(text) {
      const raw = text === null || text === undefined ? '' : String(text)
      if (!isHostUnloaded(raw)) return React.createElement('div', { className: 'mcart-err' }, withVersion(raw))
      const hint = hostRecoveryHint()
      return React.createElement('div', { className: 'mcart-err' },
        React.createElement('div', null, hint.title),
        React.createElement('div', null, hint.action),
        React.createElement('details', { className: 'mcart-details' },
          React.createElement('summary', null, '详情'),
          React.createElement('pre', { className: 'mcart-report' }, withVersion(raw))))
    }

    function Atlas(props) {
      if (typeof globalThis !== 'undefined' && globalThis.__MCART_FORCE_RENDER_ERROR__ === true) {
        throw new Error('注入的渲染错误')
      }
      const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)
      const indexPair = React.useState(null)
      const failurePair = React.useState(null)
      let hostRetried = false

      function reportFailure(message, retry) {
        const text = message === null || message === undefined ? '' : String(message)
        if (isHostUnloaded(text) && !hostRetried && typeof retry === 'function') {
          hostRetried = true
          try {
            timer.timeout(() => { retry() }, 1000)
            return true
          } catch (error) { hostRetried = false }
        }
        setFailure(text)
        return false
      }
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
      const viewHPair = React.useState(VIEW_H)
      const posterPair = React.useState(null)
      const itemMsgPair = React.useState(null)
      const savedSettingsPair = React.useState(null)
      const busyPair = React.useState(false)
      const pickingPair = React.useState(false)
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
      const texEpochPair = React.useState(0)
      const diagPair = React.useState(null)
      const diagOpenPair = React.useState(false)
      const copiedPair = React.useState('')
      const autoStatusPair = React.useState('')
      const autoTickPair = React.useState(0)
      const composerTickPair = React.useState(0)
      const diag = diagPair[0], setDiag = diagPair[1]
      const diagOpen = diagOpenPair[0], setDiagOpen = diagOpenPair[1]
      const copied = copiedPair[0], setCopied = copiedPair[1]
      const autoStatus = autoStatusPair[0], setAutoStatus = autoStatusPair[1]
      const autoTick = autoTickPair[0], setAutoTick = autoTickPair[1]
      const composerTick = composerTickPair[0], setComposerTick = composerTickPair[1]
      const voxel = voxelPair[0], setVoxel = voxelPair[1]
      const hover = hoverPair[0], setHover = hoverPair[1]
      const ghost = ghostPair[0], setGhost = ghostPair[1]
      const iconTick = iconTickPair[0], setIconTick = iconTickPair[1]
      const texEpoch = texEpochPair[0], setTexEpoch = texEpochPair[1]
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
      const itemOpenPair = React.useState(false)
      const itemOpen = itemOpenPair[0], setItemOpen = itemOpenPair[1]
      const hudPagePair = React.useState(1)
      const hudPage = hudPagePair[0], setHudPage = hudPagePair[1]
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

      function noteDiag(payload, error) {
        const info = diagnosticOf(payload)
        if (info === null) { setDiag(null); return }
        const key = reportKeyOf(info)
        const repeat = lastReportKey !== '' && lastReportKey === key
        lastReportKey = key
        setDiagOpen(false)
        setCopied('')
        setDiag({ diag: info, error: error === undefined || error === null ? '' : String(error), repeat: repeat, key: key })
      }


      function statusText(verdict) {
        if (verdict === 'filled') return '已放进输入框（只是草稿，没发送；按回车之前都可以改）'
        if (verdict === 'busy') return '输入框里已经有你写的字，没有动它 —— 要放就点左边的按钮'
        if (verdict === 'done') return '同一条报告已经放进过输入框，没有再塞一遍'
        if (verdict === 'off') return '「出错时自动把报告放进输入框」现在是关的'
        if (verdict === 'no-composer') return '这个壳没有给输入框接口 —— 上面那段可以选中复制'
        return '出错时会把这份报告放进输入框（只放草稿，不发送）'
      }
      function placeReport(manual) {
        if (diag === null) return
        const verdict = autoFillDraft(reportForAI(diag.diag, diag.error), 'diag|' + String(diag.key), manual === true)
        setAutoStatus(verdict)
      }

      React.useEffect(() => onComposerReady(() => setComposerTick(composerTick + 1)), [])
      React.useEffect(() => {
        if (diag === null) return
        const verdict = autoFillDraft(reportForAI(diag.diag, diag.error), 'diag|' + String(diag.key))
        setAutoStatus(verdict)
      }, [diag === null ? '' : String(diag.key), composerTick, autoTick])


      function copyReport(text) {
        const payload = String(text === undefined || text === null ? '' : text)
        const done = (message) => { try { setCopied(message) } catch (ignored) { /* 不能因为一句提示再炸一次 */ } }
        try {
          const board = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : undefined
          if (board !== undefined && board !== null && typeof board.writeText === 'function') {
            const result = board.writeText(payload)
            if (result !== undefined && result !== null && typeof result.then === 'function') {
              result.then(() => done('已复制到剪贴板'), () => fallbackCopy(payload, done))
            } else { done('已复制到剪贴板') }
            return
          }
        } catch (error) { /* 没有剪贴板就走下面那条 */ }
        fallbackCopy(payload, done)
      }

      function fallbackCopy(text, done) {
        try {
          if (typeof document !== 'undefined' && document !== null && typeof document.createElement === 'function') {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', 'readonly')
            if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(area)
            if (typeof area.select === 'function') area.select()
            const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
            if (document.body && typeof document.body.removeChild === 'function') document.body.removeChild(area)
            done(ok === false ? '没复制成 —— 请手动选中上面那段' : '已复制到剪贴板')
            return
          }
        } catch (error) { /* 没有 DOM 不是错误 */ }
        done('没复制成 —— 请手动选中上面那段')
      }

      function open(target, where) {
        lastOpened = { project: target.project, kind: target.kind, id: target.id }
        setZoom(1)
        if (lastProject !== target.project) { forgetTextures(); setTexEpoch(texEpoch + 1) }
        lastProject = target.project
        setBusy(true)
        setChoice(target)
        setPreviewItem(null)
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
          if (result.error !== undefined) {
            if (reportFailure(result.error, () => open(target, where))) return
            noteDiag(result, result.error)
            setScene(null)
            return
          }
          setFailure(null)
          hostRetried = false
          lastReportKey = ''
          setDiag(null)
          for (const key of Object.keys(imageNodes)) delete imageNodes[key]
          setScene(sceneOf(result))
        }).catch((error) => {
          setBusy(false)
          reportFailure(String(error && error.message ? error.message : error), () => open(target, where))
        })
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


      function rememberedPick(projects) {
        if (lastOpened === null) return null
        for (const project of projects || []) {
          if (project.id !== lastOpened.project) continue
          const items = (project.items && project.items[lastOpened.kind]) || []
          for (const item of items) {
            if (item.id === lastOpened.id) return { project: project.id, kind: lastOpened.kind, id: item.id }
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
          hostRetried = false
          const project = wantProject === undefined || wantProject === null ? null : (cached.projects || []).filter((p) => p.id === wantProject)[0]
          const remembered = wantProject === undefined || wantProject === null ? rememberedPick(cached.projects) : null
          const first = remembered
            || (project !== null && project !== undefined ? firstOfProject(project) : firstPick(cached))
          if (first !== null) open(first, where)
          return
        }
        setBusy(true)
        setFailure(null)
        host.call('atlas.scan', { root: where }).then((result) => {
          setBusy(false)
          if (result === null || result === undefined) { setFailure('scan returned nothing'); return }
          setIndex(result)
          if (result.error !== undefined) { reportFailure(result.error, () => scan(where, true, null)); return }
          const projects = result.projects || []
          if (projects.length === 0) {
            setFailure(null)
            setEmptyRoot(where)
            setNewId(String(where).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
            setScene(null)
            return
          }
          setEmptyRoot(null)
          setFailure(null)
          hostRetried = false
          indexes[where] = result
          const project = wantProject === undefined || wantProject === null ? null : projects.filter((p) => p.id === wantProject)[0]
          const remembered = wantProject === undefined || wantProject === null ? rememberedPick(projects) : null
          const first = remembered
            || (project !== null && project !== undefined ? firstOfProject(project) : firstPick(result))
          if (first !== null) open(first, where)
        }).catch((error) => {
          setBusy(false)
          reportFailure(String(error && error.message ? error.message : error), () => scan(where, true, null))
        })
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
        host.call('atlas.pickDirectory', { start: start })
          .then((result) => {
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
            setPicking(false)
            setNotice('目录选择器失败：' + String(error && error.message ? error.message : error) +
              '　请把路径直接贴进下面的输入框。')
          })
      }

      function pickDirectory() {
        runPicker(root !== '' ? root : (nearby !== null ? nearby.cwd : ''), commitRoot)
      }

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

      React.useEffect(() => {
        if (posterCanvas === null || posterRecipe === null) return
        const frames = (posterRecipe.frames || []).length
        const frame = frames > 1 ? Math.floor(animTicks / 2) % frames : 0
        drawItemIcon(posterCanvas, posterRecipe, frame, decoded)
      })

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

      function projectNamespaceOf(id) {
        const projects = index === null ? [] : (index.projects || [])
        const found = projects.filter((entry) => entry.id === id)[0]
        return found === undefined ? '' : found.namespace
      }

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
        const dispose = timer.interval(() => {
          animTicks += 1
          setTick((previous) => previous + 1)
        }, 50)
        return () => { if (typeof dispose === 'function') dispose() }
      }, [animating])

      React.useEffect(() => {
        const ours = projectNamespaceOf(activeProjectId())
        if (ours === '') return
        if (item === null) { loadItems('project', ours, 1, '', '', ''); return }
        if (item.source === 'project' && item.namespace !== ours) loadItems('project', ours, 1, '', '', '')
      }, [index === null ? '' : (index.projects || []).map((project) => project.id).join(','),
        activeProjectId(), item === null ? '' : item.source + '|' + item.namespace])

      React.useEffect(() => {
        if (scene === null && item === null) return
        const needed = idsOf(scene).slice()
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
        drawGroundGrid(paint, camera, size[0], size[1], box)
      })


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

      React.useEffect(() => {
        if (item === null || item.facts.length === 0) return
        ensureItemPage()
      }, [item === null ? '' : [item.namespace, item.page, hudPage, item.filter, item.form,
        item.family, item.facts.length].join('|'), texEpoch])

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


      function slotNote(recipe) {
        if (recipe === undefined || recipe === null) return null
        if (recipe.missing === true) {
          return '这一格没有图标：' + (recipe.error || recipe.reason || '参考目录里取不到这个物品')
        }
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


      function slotFacts(recipe) {
        if (recipe === undefined || recipe === null) return '还没取到这个物品的图标'
        if (recipe.missing === true) {
          return '缺：' + (recipe.error || recipe.reason || '参考目录里取不到这个物品')
        }
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

      function loadRefSources() {
        setRefSources([])
        host.call('atlas.refNamespaces', { root: root, project: activeProjectId() })
          .then((result) => {
            if (result === null || result === undefined || result.error !== undefined) return
            setRefSources(result.namespaces || [])
          }).catch(() => { /* decoration: an empty picker is not fatal */ })
      }

      function itemKey(namespace, id) { return namespace + ':' + id }

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
        const ours = projectNamespaceOf(activeProjectId())
        const stale = item === null || item.facts.length === 0
          || (item.source === 'project' && ours !== '' && item.namespace !== ours)
        if (!stale) return
        if (ours !== '') { loadItems('project', ours, 1, '', '', ''); return }
        const namespace = refSources.length > 0 ? refSources[0].name : 'minecraft'
        loadItems('reference', namespace, 1, '', '', '')
      }


      function itemSearch() {
        return item === null ? '' : String(item.filter).trim().toLowerCase()
      }


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
        want(itemView().list)
        want(hudView().list)
        if (missing.length === 0) return
        host.call('atlas.itemIcons', { root: root, project: activeProjectId(),
          source: item.source, namespace: item.namespace, items: missing }).then((result) => {
          const failed = failureOf(result)
          if (failed !== null) {
            itemFetchError = '取不到物品图标：' + failed
            setIconTick(iconTick + 1)
            return
          }
          itemFetchError = ''
          let added = 0
          for (const id of Object.keys(result.items || {})) {
            const recipe = result.items[id]
            const key = itemKey(item.namespace, id)
            if (itemRecipes[key] !== undefined) continue
            if (recipe === undefined || recipe === null) continue
            itemRecipes[key] = recipe
            added += 1
          }
          if (added > 0) setIconTick(iconTick + 1)
        }).catch((error) => {
          itemFetchError = '取不到物品图标：' + String(error && error.message ? error.message : error)
          setIconTick(iconTick + 1)
        })
      }


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


      function forgetSceneBecauseItem() {
        painting.active = false
        setScene(null)
        setVoxel(null)
        setHover(null)
        setGhost(null)
        setEdit(null)
        setFailure(null)
        lastDrawKey = ''
      }

      function openReferenceItem(entry) {
        const reference = (item === null ? '' : item.namespace) + ':' + entry.id
        setPreviewItem({ source: 'reference', namespace: item === null ? '' : item.namespace, id: entry.id })
        host.call('atlas.preview', { root: root, project: activeProjectId(), block: reference,
          at: [0, 0, 0], variant: null, have: Object.keys(decoded) }).then((result) => {
          const failed = failureOf(result)
          if (failed !== null) {
            forgetSceneBecauseItem()
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
          forgetSceneBecauseItem()
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


      function countsBy(keyOf, within) {
        const counts = {}
        for (const item of (voxel === null ? [] : voxel.choices)) {
          if (within !== null && within(item) !== true) continue
          const value = keyOf(item) || ''
          counts[value] = (counts[value] || 0) + 1
        }
        return counts
      }


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
          if (typeof cell.variant === 'string' && cell.variant !== '') {
            keep.push(qualified + '@' + cell.variant)
          }
        }
        if (voxel !== null && voxel.source !== 'project' && voxel.block !== '') {
          keep.push(voxel.block)
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
          if (typeof variant === 'string' && variant !== '') cell.variant = variant
          out.push(cell)
        }
        return out
      }


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
        const hitY = faceHitY(quad, px + 0.5, py + 0.5, lastCamera)
        return { cell: pick.cell, face: pick.face, at: cell.at, block: cell.block, hitY: hitY }
      }


      function placementAt(target) {
        if (target === null) return null
        const step = (scene === null ? {} : (scene.faceStep || {}))[target.face]
        if (step === undefined) return null
        const at = [target.at[0] + step[0], target.at[1] + step[1], target.at[2] + step[2]]
        const occupied = (voxel === null ? [] : voxel.cells).some((cell) =>
          cell.at[0] === at[0] && cell.at[1] === at[1] && cell.at[2] === at[2])
        return occupied ? null : at
      }

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
          if (result === null || result === undefined || result.error !== undefined) {
            for (const name of batch) delete iconTried[name]
            return
          }
          let added = 0
          for (const key of Object.keys(result.icons || {})) {
            const icon = result.icons[key]
            if (icon === undefined || icon === null) continue
            icons[key] = icon
            added += 1
          }
          for (const name of arrayOf(result.failed)) iconTried[name] = true
          if (added > 0) setIconTick(iconTick + 1)
        }).catch(() => {
          for (const name of batch) delete iconTried[name]
        })
      }, [voxel === null ? '' : (voxel.source + '|' + voxel.kind + ':' + voxel.id + '|' + voxel.choices.length),
        filter, pickGroup, pickFamily, pickPage, iconTick, texEpoch])

      React.useEffect(() => {
        if (voxel === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        const target = hover === null ? null : placementAt(hover)
        if (target === null) { ghostAsk = ''; if (ghost !== null) setGhost(null); return }
        const face = hover === null || hover.face === undefined ? 'north' : hover.face
        const hitY = hover === null || hover.hitY === undefined ? 0.5 : hover.hitY
        const wantVariant = variantFor(voxel.axes, voxel.variants, voxel.defaults, face, hitY,
          voxel.flip === true, voxel.overrides)
        const around = aroundOf(voxel.cells, target)
        const wantKey = voxel.block + '|' + String(wantVariant) + '|' + target.join(',')
          + '|' + JSON.stringify(around)
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
          setGhost(ghostOf(result, { block: voxel.block, at: target, variant: wantVariant }))
        }).catch((error) => {
          setGhost({ block: voxel.block, at: target, variant: wantVariant, quads: [], textures: {},
            textureIds: [], error: String(error && error.message ? error.message : error) })
        })
      })

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
          React.createElement('span', { className: 'mcart-note mcart-grow' }, voxel.msg === null ? '' : withVersion(voxel.msg))))
        if (ghost !== null && ghost.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'ghosterr' }, withVersion('预览拿不到：' + String(ghost.error))))
        }
        return React.createElement('div', { className: 'mcart-card', key: 'voxel' }, rows)
      }



      function hudBar() {
        const view = hudView()
        const slots = []
        for (const entry of view.list) {
          const key = itemKey(item.namespace, entry.id)
          const recipe = itemRecipes[key]
          const note = slotNote(recipe)
          const lacking = recipe !== undefined && recipe !== null && recipe.missing === true
          slots.push(React.createElement('button', {
            key: key, type: 'button', className: 'mcart-hudslot',
            'data-on': hudOn === entry.id ? '1' : '0',
            'data-missing': lacking ? '1' : '0',
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
          }), lacking
            ? React.createElement('span', { className: 'mcart-slotq mcart-slotmissing' }, '缺')
            : null))
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
            itemFetchError === '' ? '点一格就放到上面的 3D 里看' : withVersion(itemFetchError)),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setItemOpen(false); setIconPick(null) } }, '收起')))
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
          const blank = recipe !== undefined && recipe !== null && recipe.shape === 'none'
          const lacking = recipe !== undefined && recipe !== null && recipe.missing === true
          const lackReason = lacking
            ? (recipe.error || recipe.reason || '参考目录里取不到这个物品') : ''
          slots.push(React.createElement('button', {
            key: entry.id, type: 'button', className: 'mcart-slot',
            'data-on': iconPick !== null && iconPick.id === entry.id ? '1' : '0',
            'data-missing': lacking ? '1' : '0',
            title: entry.name + '\n' + entry.id + '\n' + (entry.formLabel || entry.form || '')
              + (lacking ? '\n缺：' + lackReason
                : (blank ? '\n这个物品是代码画的，没有可用的图标模型' : '')),
            style: url === undefined || url === null ? {} : { backgroundImage: 'url(' + url + ')' },
            onClick: () => pickItem(entry),
          }, lacking
            ? React.createElement('span', { className: 'mcart-slotq mcart-slotmissing', title: lackReason }, '缺')
            : (blank ? React.createElement('span', { className: 'mcart-slotq' }, '?') : null)))
        }
        rows.push(React.createElement('div', { className: 'mcart-hotbar', key: 'slots' }, slots))

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
          React.createElement('span', { className: 'mcart-note mcart-grow' }, item.msg === null ? '' : withVersion(item.msg))))
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


      function itemAsset() {
        if (scene !== null || item === null || hudOn === '') return null
        return { namespace: item.namespace, id: hudOn, source: item.source,
          recipe: pickedRecipe, title: hudPicked === '' ? hudOn : hudPicked }
      }

      function openEditor() {
        const asset = itemAsset()
        if (scene === null && asset === null) return
        if (asset !== null) {
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
        const target = edit.ids[edit.index]
        if (!safeTextureHandle(target)) {
          setEditMsg('这条贴图句柄不是项目包里的相对路径，没有写盘：' + String(target)
            + '（只写项目自己的包；要改原版/模组贴图，先在项目包里放一张同名贴图）')
          return
        }
        setEditBusy(true)
        setEditMsg(null)
        editScratch.width = edit.w
        editScratch.height = edit.h
        const paint = editScratch.getContext('2d')
        const frame = paint.createImageData(edit.w, edit.h)
        frame.data.set(edit.pixels)
        paint.putImageData(frame, 0, 0)
        const url = editScratch.toDataURL('image/png')
        if (String(url).indexOf('data:image/png') !== 0) {
          setEditBusy(false)
          setEditMsg('画布没有给出 PNG（拿到 ' + String(url).slice(0, 24) + '…），没有写盘')
          return
        }
        const base64 = url.slice(url.indexOf(',') + 1)
        host.call('atlas.saveTexture', {
          root: root, project: activeProjectId(), path: target, base64: base64,
        }).then((result) => {
          setEditBusy(false)
          if (result === null || result === undefined || result.error !== undefined) {
            setEditMsg('保存失败：' + String(result && result.error ? result.error : '没有返回结果'))
            return
          }
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
          React.createElement('span', { className: 'mcart-note mcart-grow' }, editMsg === null ? '' : withVersion(editMsg))))
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


      function insertReference(path, note) {
        const target = path === undefined || path === null ? '' : String(path)
        if (target === '') return false
        const sentence = note === undefined || note === null ? '' : String(note)
        const draft = composer.draft === undefined || composer.draft === null ? '' : String(composer.draft)
        const base = draft.replace(/\s+$/, '')
        if (typeof composer.write !== 'function') return false
        const next = (base === '' ? '' : base + ' ') + '@' + target
          + (sentence === '' ? '' : ' ' + sentence) + ' '
        composer.write(next)
        composer.draft = next
        return true
      }

      function complain() {
        if (scene !== null) {
          const refPath = scene.ref === undefined || scene.ref === null ? '' : String(scene.ref)
          if (refPath === '') {
            setItemMsg('这个资产没有可以引用的文件路径（报告里的 @ 引用不可用）')
            return
          }
          if (insertReference(refPath)) { setPending(null); return }
          setPending({ path: refPath, title: scene.title || '' })
          return
        }
        const asset = itemAsset()
        if (asset === null) return
        const path = asset.recipe === null || asset.recipe.modelPath === undefined
          ? '' : String(asset.recipe.modelPath)
        if (path === '') {
          setItemMsg(asset.title + ' 在参考的 jar 里，没有可以引用的文件')
          return
        }
        setItemMsg(null)
        if (insertReference(path)) { setPending(null); return }
        setPending({ path: path, title: asset.title })
      }


      function diagnosticCard() {
        if (diag === null) return null
        const info = diag.diag
        const all = diagLines(info, diag.error)
        const full = diagText(info, diag.error)
        const rows = []
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
          React.createElement('span', { className: 'mcart-title' }, '画不出来 · 报告'),
          React.createElement('span', { className: 'mcart-sub' }, versionTag()),
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => copyReport(full) }, '复制报告'),
          all.length > DIAG_SHOW ? React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => setDiagOpen(diagOpen !== true) }, diagOpen === true ? '收起' : '展开全部') : null,
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => { setDiag(null); setCopied('') } }, '关掉')))
        if (diag.repeat === true) {
          rows.push(React.createElement('div', { className: 'mcart-hint', key: 'repeat' },
            '同一条报告：屏幕上只留这一条，不重复刷屏。'))
        }
        const shown = diag.repeat === true ? all.slice(0, 3)
          : (diagOpen === true ? all.slice(0, DIAG_LINES) : all.slice(0, DIAG_SHOW))
        rows.push(React.createElement('pre', { className: 'mcart-report', key: 'text' }, shown.join('\n')))
        rows.push(React.createElement('div', { className: 'mcart-bar', key: 'ai' },
          React.createElement('button', { className: 'mcart-btn', type: 'button',
            onClick: () => placeReport(true) }, '把报告放进输入框'),
          React.createElement('span', { className: 'mcart-note mcart-grow' }, statusText(autoStatus)),
          React.createElement('label', { className: 'mcart-switch' },
            React.createElement('input', { type: 'checkbox', checked: autoReportOn === true,
              onChange: (event) => { setAutoReport(event.target.checked); setAutoTick(autoTick + 1) } }),
            React.createElement('span', null, '出错时自动放进输入框'))))
        rows.push(React.createElement('div', { className: 'mcart-reportnote', key: 'note' },
          copied === ''
            ? '上面这段可以选中复制，或点「复制报告」/「把报告放进输入框」。面板不会自动发送；面板不会把它发进任何会话。'
            : copied))
        return React.createElement('div', { className: 'mcart-card', key: 'diag' }, rows)
      }

      function settingsCard() {
        if (settings === null) return null
        const rows = []
        const prop = (key, label, value) => React.createElement('div', { className: 'mcart-prop', key: key },
          React.createElement('span', { className: 'mcart-prop-label' }, label),
          React.createElement('span', { className: 'mcart-prop-value' }, value))
        const group = (key, children) => React.createElement('div', { className: 'mcart-group', key: key }, children)
        const hint = (key, text) => prop(key, '', React.createElement('span', { className: 'mcart-note' }, text))
        if (settings.loading === true) {
          rows.push(React.createElement('div', { className: 'mcart-note', key: 'l' }, '读取设置…'))
        } else if (settings.error !== undefined) {
          rows.push(React.createElement('div', { className: 'mcart-err', key: 'e' }, String(settings.error)))
        } else {
          rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
            React.createElement('span', { className: 'mcart-title' }, '设置'),
            React.createElement('span', { className: 'mcart-sub' }, settings.title || settings.project || ''),
          ))
          const dirRows = []
          dirRows.push(prop('refpath', '参考目录',
            React.createElement('span', { className: 'mcart-path mcart-grow' }, settings.directory || '（未设置）')))
          dirRows.push(prop('pick', '选择', React.createElement('button', {
            className: 'mcart-btn', type: 'button', disabled: picking,
            onClick: () => runPicker(settings.directory || root, (picked) => patchSettings({ directory: picked }, true)),
          }, picking ? '对话框已打开…' : '选择目录…')))
          dirRows.push(prop('dirinput', '路径', [
            React.createElement('input', {
              className: 'mcart-input', type: 'text', placeholder: '参考目录：%APPDATA%\\.minecraft\\versions\\<版本号>',
              value: dirDraft,
              onChange: (event) => setDirDraft(String(event.target.value)),
              onKeyDown: (event) => { if (event.key === 'Enter') applyDirDraft() },
            }),
            React.createElement('button', { className: 'mcart-btn', type: 'button',
              disabled: dirDraft.trim() === '', onClick: () => applyDirDraft() }, '用这个路径'),
          ]))
          dirRows.push(hint('dirhint', '对话框弹不出来时可以在这里贴路径（.minecraft、版本目录、mods 目录，或单个 jar 都行）。'))
          if (settings.directory !== '' && settings.directory !== undefined) {
            if (settings.scanError !== null && settings.scanError !== undefined) {
              dirRows.push(React.createElement('div', { className: 'mcart-err', key: 'scanerr' },
                '没读到里面的资源：' + String(settings.scanError)))
            } else {
              dirRows.push(hint('shape',
                '识别为 ' + (settings.shape || '？') + ' · ' + (settings.textures || 0) + ' 张贴图 · '
                + ((settings.sources || []).length) + ' 个资源文件'))
            }
          }
          for (const detected of (settings.directory === '' || settings.directory === undefined ? (settings.detected || []) : []).slice(0, 4)) {
            dirRows.push(prop('det' + detected, '检测到', [
              React.createElement('span', { className: 'mcart-path mcart-grow' }, detected),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => patchSettings({ directory: detected }, true) }, '用它'),
            ]))
          }
          if ((settings.directory === '' || settings.directory === undefined) && (settings.detected || []).length === 0) {
            dirRows.push(hint('nodir', '没设置就不参考外部资源。可以指向 .minecraft、某个版本目录、mods 目录，或单个 jar。'))
            dirRows.push(hint('nodir2', '没有自动检测到游戏目录 —— 直接把路径贴进上面的输入框也一样能用。'))
          }
          rows.push(group('dirgroup', dirRows))

          const scopeRows = []
          scopeRows.push(prop('gen', '已生成内容',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: settings.includeGenerated !== false,
                onChange: (event) => patchSettings({ includeGenerated: event.target.checked }) }),
              React.createElement('span', null, '参考本目录已生成内容'))))
          scopeRows.push(hint('genhint', '有助于保持生成风格一致'))
          scopeRows.push(prop('mods', '模组资源',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: settings.includeMods !== false,
                onChange: (event) => patchSettings({ includeMods: event.target.checked }) }),
              React.createElement('span', null, '参考目录中的模组资源文件'))))
          if (settings.includeMods !== false) {
            const mods = settings.mods || []
            const missing = settings.directory === '' || settings.directory === undefined
            const message = missing ? '还没指定参考目录'
              : (mods.length === 0 ? '参考目录里没有找到任何资源命名空间' : ('发现 ' + mods.length + ' 个命名空间'))
            scopeRows.push(prop('modbar', '命名空间', [
              React.createElement('span', { className: 'mcart-note mcart-grow' }, message),
              mods.length === 0 ? null : React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setModsOpen(!modsOpen) }, modsOpen ? '收起 ▴' : '展开 ▾'),
            ]))
            if (modsOpen) {
              const list = []
              for (const mod of mods) {
                const from = (mod.from || []).slice(0, 2).join('、')
                list.push(React.createElement('label', { className: 'mcart-switch', key: mod.name },
                  React.createElement('input', { type: 'checkbox', checked: mod.on === true,
                    onChange: (event) => toggleMod(mod.name, event.target.checked) }),
                  React.createElement('span', { className: 'mcart-grow' }, mod.name,
                    from === '' ? null : React.createElement('span', { className: 'mcart-id' }, from)),
                  React.createElement('span', { className: 'mcart-id' }, mod.count + ' 张贴图'),
                ))
              }
              scopeRows.push(React.createElement('div', { className: 'mcart-mods', key: 'modlist' }, list))
            }
          }
          rows.push(group('scopegroup', scopeRows))

          const notifyRows = []
          notifyRows.push(prop('autoreport', '自动报告',
            React.createElement('label', { className: 'mcart-switch' },
              React.createElement('input', { type: 'checkbox', checked: autoReportOn === true,
                onChange: (event) => { setAutoReport(event.target.checked); setAutoTick(autoTick + 1) } }),
              React.createElement('span', null, '出错时自动把报告放进输入框'))))
          notifyRows.push(hint('autoreporthint', '只是草稿：不会自动发送，输入框里已经有你写的字时也不动它。'))
          notifyRows.push(prop('foot', '设置文件', [
            React.createElement('span', { className: 'mcart-path mcart-grow' }, settings.file || ''),
            React.createElement('span', { className: 'mcart-bad' }, saveState === null ? '' : saveState),
          ]))
          if (savedSettings !== null && savedSettings.path !== '') {
            notifyRows.push(prop('tell', '已保存', [
              React.createElement('span', { className: 'mcart-note mcart-grow' },
                '已保存，要让 AI 按新设置重做的话：'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => {
                  if (insertReference(savedSettings.path, savedSettings.note)) { setSavedSettings(null); return }
                  setPending({ path: savedSettings.path, note: savedSettings.note })
                } },
                '告诉 AI'),
              React.createElement('button', { className: 'mcart-btn', type: 'button',
                onClick: () => setSavedSettings(null) }, '不用了'),
            ]))
          }
          rows.push(group('notifygroup', notifyRows))
        }
        if (notice !== null) rows.push(React.createElement('div', { className: 'mcart-bad', key: 'notice' }, String(notice)))
        if (failure !== null) rows.push(React.createElement('div', { key: 'failure' }, failureView(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'settings' }, rows)
      }

      if (root === '') {
        const card = []
        card.push(React.createElement('div', { className: 'mcart-note', key: 'hint' }, '未指定资产路径'))
        card.push(React.createElement('div', { className: 'mcart-stack', key: 'input' },
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
        if (failure !== null) card.push(React.createElement('div', { key: 'failure' }, failureView(failure)))
        return React.createElement('div', { className: 'mcart-root' },
          React.createElement('div', { className: 'mcart-head' },
            React.createElement('span', { className: 'mcart-headpath' }, '未选择项目'),
            React.createElement('span', { className: 'mcart-headgrow' }),
          ),
          React.createElement('div', { className: 'mcart-card' }, card),
        )
      }

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
        if (failure !== null) rows.push(React.createElement('div', { key: 'err' }, failureView(failure)))
        return React.createElement('div', { className: 'mcart-card', key: 'guide' }, rows)
      }

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
        const prefix = projects.length > 1 ? project.title + ' · ' : ''
        for (const category of CATEGORIES) {
          const items = (project.items && project.items[category.key]) || []
          if (items.length === 0) continue
          menu.push(React.createElement('div', {
            className: 'mcart-group-head', key: 'p' + project.id + category.key,
          }, prefix + category.label + ' · ' + items.length))
          for (const item of items) {
            const on = choice !== null && choice.project === project.id && choice.kind === category.key && choice.id === item.id
            menu.push(React.createElement('button', {
              key: project.id + '/' + category.key + '/' + item.id, type: 'button',
              className: 'mcart-item', 'data-on': on ? '1' : '0',
              title: item.id,
              onClick: () => open({ project: project.id, kind: category.key, id: item.id }, root),
            },
            React.createElement('span', { className: 'mcart-item-name' }, item.title),
            item.title === item.id ? null
              : React.createElement('span', { className: 'mcart-item-id' }, item.id)))
          }
        }
      }

      const stage = []
      const animRows = []
      if (!isAbsent(scene)) {
        const ids = idsOf(scene)
        const okCount = ids.filter((id) => decoded[id] !== undefined).length
        const bad = ids.filter((id) => failedTex[id] === true).length
        stage.push(React.createElement('div', { className: 'mcart-toolbar', key: 'row' },
          React.createElement('span', { className: 'mcart-toolbar-facts' },
            scene.quads.length + ' 面 · 贴图 ' + okCount + '/' + ids.length),
          React.createElement('span', { className: 'mcart-toolbar-grow' }),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '重置视角（旋转与缩放一起）',
            'aria-label': '重置', onClick: () => { setYaw(0.72); setPitch(0.34); setZoom(1) },
          }, '⟲'),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '手动修改（按面编辑这张贴图）',
            'aria-label': '手动修改', onClick: openEditor,
          }, '✎'),
          React.createElement('button', {
            className: 'mcart-btn mcart-primary', type: 'button', onClick: complain,
          }, '@ 提意见'),
        ))
        if (bad > 0) stage.push(React.createElement('div', { className: 'mcart-bad', key: 'bad' }, bad + ' 张贴图解码失败'))
        if (scene.errors && scene.errors.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bad', key: 'notes' }, withVersion(scene.errors.join('；'))))
        }
        const animIndex = scene === null ? {} : (scene.animations || {})
        const animNotes = scene === null ? {} : (scene.animationNotes || {})
        for (const id of Object.keys(animIndex).sort()) {
          const tex = decoded[id]
          const size = tex === undefined ? '还没解码' : (tex.width + '×' + tex.height)
          const strip = tex === undefined ? null
            : stripOf({ width: tex.width, height: tex.height, animation: animIndex[id] })
          const row = animationRow(animIndex[id], animTicks * 50)
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'anim:' + id },
            '动画 ' + id + ' · 解码 ' + size + ' · 声明 ' + String(animIndex[id].strip) + ' 行'
            + ' · 判定 ' + (tex === undefined ? '等解码' : (strip === null ? '不是条带 ← 会糊' : '单帧 ' + strip))
            + ' · 现在抽第 ' + String(row) + ' 行'))
        }
        for (const id of idsOf(scene)) {
          if (animIndex[id] !== undefined) continue
          const note = animNotes[id]
          if (note !== undefined && note !== null && typeof note.text === 'string' && note.text !== '') {
            animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'noanim:' + id }, note.text))
            continue
          }
          const tex = decoded[id]
          if (tex === undefined) continue
          if (!(tex.height > tex.width && tex.height % tex.width === 0)) continue
          animRows.push(React.createElement('div', { className: 'mcart-hint', key: 'noanim:' + id },
            '形状像条带但没有动画描述 ' + id + ' · 解码 ' + tex.width + '×' + tex.height
            + ' ← 会糊；补一个 ' + String(id).split('/').pop() + '.png.mcmeta（animation 段里写明 frametime/frames）'))
        }
        if (scene.palette && scene.palette.length > 0) {
          stage.push(React.createElement('div', { className: 'mcart-bar', key: 'palette' },
            scene.palette.slice(0, 8).map((entry) => React.createElement('span', { className: 'mcart-chip', key: entry.block },
              (entry.label || entry.block) + ' ×' + entry.count)),
          ))
        }
      }
      const pickedRecipe = hudOn === '' || item === null
        ? null : (itemRecipes[itemKey(item.namespace, hudOn)] || null)
      if (scene === null) {
        const asset = itemAsset()
        if (asset !== null) {
          const ids = idsOf(asset.recipe)
          const okCount = ids.filter((id) => decoded[id] !== undefined).length
          stage.push(React.createElement('div', { className: 'mcart-toolbar', key: 'itemrow' },
            React.createElement('span', { className: 'mcart-toolbar-facts' },
              '物品 · 贴图 ' + okCount + '/' + ids.length
              + (asset.source === 'project' ? '' : '（参考）')),
            React.createElement('span', { className: 'mcart-toolbar-grow' }),
            React.createElement('button', {
              className: 'mcart-icon', type: 'button', title: '手动修改（按面编辑这张贴图）',
              'aria-label': '手动修改', onClick: openEditor,
            }, '✎'),
            React.createElement('button', {
              className: 'mcart-btn mcart-primary', type: 'button', onClick: complain,
            }, '@ 提意见'),
          ))
        }
      }
      const sceneDrawsNothing = scene === null || arrayOf(scene.quads).length === 0
      const posterRecipe = sceneDrawsNothing && pickedRecipe !== null && pickedRecipe.missing !== true
        ? pickedRecipe : null
      const posterSide = Math.max(48, Math.min(size[0], size[1]) - 24)
      stage.push(React.createElement('div', { className: 'mcart-viewport', key: 'viewport' },
        React.createElement('canvas', {
        key: 'canvas', className: 'mcart-canvas',
        style: { minHeight: viewH + 'px' },
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
          if (dragDistance > 4 || voxel === null) return
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
        posterRecipe === null ? null : React.createElement('canvas', {
          key: 'poster', className: 'mcart-poster',
          width: posterSide, height: posterSide,
          style: { width: posterSide + 'px', height: posterSide + 'px' },
          title: hudPicked,
          ref: (node) => setPosterCanvas(node),
        }),
        React.createElement('svg', {
          className: 'mcart-axis', width: 34, height: 34, viewBox: '-17 -17 34 34', 'aria-hidden': 'true',
        },
          React.createElement('line', { x1: 0, y1: 0, x2: 12, y2: 0, className: 'mcart-axis-x' }),
          React.createElement('line', { x1: 0, y1: 0, x2: 0, y2: -12, className: 'mcart-axis-y' }),
          React.createElement('line', { x1: 0, y1: 0, x2: -7, y2: 9, className: 'mcart-axis-z' })),
        hudBar()))

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

      const iconNotes = []
      if (itemMsg !== null) iconNotes.push(String(itemMsg))
      const pickedNote = slotNote(pickedRecipe)
      if (pickedNote !== null) iconNotes.push(pickedNote)
      if (previewItem !== null && previewItem.localOnly === true) {
        iconNotes.push((hudPicked === '' ? previewItem.id : hudPicked)
          + ' 没有方块模型（它是物品，不是方块），所以 3D 里没有东西可看；它的样子就是物品栏里那一格')
      }
      if (scene !== null && arrayOf(scene.quads).length === 0) {
        iconNotes.push(posterRecipe === null
          ? '这一条 3D 里一个面都没有，也没有可用的图标 —— 上面那句"取不到 / 画不出来"就是原因'
          : '这一条 3D 里一个面都没有（模型或贴图那一段是空的）；取景框里画的是它的 2D 图标')
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

      const forgetProject = () => {
        setRoot(''); setIndex(null); setItem(null); setItemOpen(false); setIconPick(null)
        setPreviewItem(null); setHudPage(1); setScene(null); setSettings(null); setEdit(null)
        setVoxel(null); setHover(null); setGhost(null)
      }
      return React.createElement('div', { className: 'mcart-root' },
        React.createElement('div', { className: 'mcart-head' },
          React.createElement('span', { className: 'mcart-headpath', title: root },
            root === '' ? '未选择项目' : root),
          React.createElement('span', { className: 'mcart-headgrow' }),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '物品列表（浏览器）',
            'aria-label': '物品列表', 'data-on': itemOpen ? '1' : '0',
            onClick: openItems,
          }, '▤'),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '设置', 'aria-label': '设置',
            onClick: openSettings,
          }, settings === null ? '⚙' : '⚙▾'),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '回到项目根（换一个项目）',
            'aria-label': '返回项目根', onClick: forgetProject,
          }, '⌂'),
          React.createElement('button', {
            className: 'mcart-icon', type: 'button', title: '刷新资产（重新读磁盘）',
            'aria-label': '刷新', onClick: () => { forgetTextures(); setTexEpoch(texEpoch + 1); scan(root, true, null) },
          }, '↻'),
        ),
        React.createElement('div', {
          className: 'mcart-body',
          ref: (node) => {
            if (node !== null && node !== undefined) { try { node.scrollTop = lastBodyScroll } catch (error) { /* 不是真 DOM */ } }
          },
          onScroll: (event) => { lastBodyScroll = event.currentTarget.scrollTop },
        },
        settings === null ? null : settingsCard(),
        emptyRoot === null ? null : guideCard(),
        failure === null ? null : failureView(failure),
        diagnosticCard(),
        React.createElement('div', { className: 'mcart-list' }, menu),
        editorCard(),
        voxelCard(),
        itemOpen ? itemCard() : null,
        ),
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
      try {
        if (props.inputActions !== undefined && props.inputActions !== null
          && typeof props.inputActions.setDraft === 'function') {
          const first = typeof composer.write !== 'function'
          composer.write = props.inputActions.setDraft
          if (first) composerCaptured()
        }
        composer.draft = draft === undefined || draft === null ? '' : String(draft)
      } catch (error) { /* 壳给的 props 形状不对也不该把引用条弄没 */ }
      if (current === null || current.path === '') return null
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
      const rightTabs = ctx.get('sidebarRightTabs')
      if (rightTabs === undefined) return
      if (placement === 'left') {
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


    function retryRight() {
      let tries = 0
      let dispose = null
      let done = false
      const stop = () => {
        done = true
        if (typeof dispose === 'function') { try { dispose() } catch (error) { /* 已释放 */ } }
        dispose = null
      }
      const tickOnce = () => {
        if (done) return
        if (placement === 'right') { stop(); return }
        if (rightColumnReady()) { stop(); placeRight(); return }
        tries += 1
        if (tries >= 10) stop()
      }
      try {
        dispose = timer.interval(tickOnce, 500)
      } catch (error) {
        dispose = null
      }
      ctx.effect(() => () => stop())
      return stop
    }

    if (inRightColumn) placeRight()
    else {
      placeLeft()
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sidebarRightTabs'], () => { if (rightColumnReady()) placeRight() })
        } catch (error) { /* 没有 inject 就靠下面的轮询 */ }
      }
      retryRight()
    }
  },
}

    // <<< mcart:embedded-source
    })(React, host, styles, console, "0.3.2")
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
      throw new Error('mcart 客户端源码没有返回一个带 apply 的插件')
    }
    exports.name = plugin.name === undefined ? "dsh-mc-art-panel" : plugin.name
    exports.inject = plugin.inject === undefined ? [] : plugin.inject
    exports.apply = plugin.apply
    return module.exports
  },
})
