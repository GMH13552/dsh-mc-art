// 原版母模型表（`VANILLA_PARENTS`）是**生成物**，定义在：
//   tools/mcart-plugin/host/06-vanilla-parents.generated.js  ← tools/mcart-plugin/vanilla-parents.json
// 它必须排在 05 之前（清单保证）；改表请改 JSON，别改生成片段。

/**
 * `minecraft:block/cube_all` → `block/cube_all`；别的命名空间原样返回。
 *
 * `VANILLA_PARENTS` 的键是**不带命名空间**的，而原版 1.18.2 自己的模型写的是
 * **带**命名空间的 `minecraft:block/cube_all` —— 本项目生成的模型照原版写，
 * 于是 `VANILLA_PARENTS['minecraft:block/cube_all']` 查不到，
 * 整条链退化成 `{textures:{}}`、**一个面都画不出来**（面板报
 * "模型链是完整的，但整条链里一个面都没画出来"，并让人以为是方块实体）。
 *
 * 只有 `minecraft` 才剥前缀：别的命名空间本来就不该命中原版表。
 */
function vanillaBare(parent) {
  const prefix = 'minecraft:'
  return parent.slice(0, prefix.length) === prefix ? parent.slice(prefix.length) : parent
}

/**
 * PNG 的像素尺寸（只看 IHDR 头，前 24 字节）。认不出就 undefined。
 *
 * 项目 `.mcmeta` 那条路要它才算得出 `strip`（竖条有几帧）—— 抽取器那边有 `png_size`，
 * 宿主这边以前没有，于是项目自己的动图**没有**帧数可言。
 */
function pngSizeOf(bytes) {
  if (bytes === undefined || bytes === null || bytes.length === undefined || bytes.length < 24) return undefined
  const magic = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return undefined
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0
  if (width === 0 || height === 0) return undefined
  return { width: width, height: height }
}

/**
 * 一个从**别处取回来**的母模型，是不是"能用"的？
 *
 * `loadParent()` 可能回一个**真值但空**的壳（`{}` / `{textures:{}}`）：那是"文件取到了、
 * 里面既没有 `elements` 也没有 `parent`"。对这条链来说它等于**没解析到** —— 而旧代码
 * `loadParent(parent) || VANILLA_PARENTS[...]` 把它当成"解析到了"，于是**短路掉内置母模型表**，
 * 链到此为止：一个面都没有，报告还写着"这个方块可能靠方块实体渲染 / 原因：unknown"
 * （用户实测：同族逐字同形的模型都能画，就那一个不行）。
 *
 * 判据只有两条：**有非空 `elements`**，或者**还有可继续的 `parent`**。
 * 唯一的例外是 `block/block`（只带 `display`、既没有 elements 也没有 parent）——
 * 它只会来自 `VANILLA_PARENTS`，不会经过这个函数，所以不受影响。
 */
function parentModelUsable(candidate) {
  if (candidate === null || typeof candidate !== 'object') return false
  if (Array.isArray(candidate.elements) && candidate.elements.length > 0) return true
  if (typeof candidate.parent === 'string' && candidate.parent !== '') return true
  return false
}

function resolveBlockModel(model, loadParent, resolveTexture, trace) {
  const chain = []
  let node = model
  const seen = {}
  for (let depth = 0; depth < 8 && node !== undefined; depth++) {
    chain.push(node)
    const parent = node.parent
    if (typeof parent !== 'string' || seen[parent] === true) break
    seen[parent] = true
    // 兜底链**只接受能用的模型**：取回来的空壳不算数，继续往下走到内置表。
    const loaded = loadParent(parent)
    let next
    if (parentModelUsable(loaded)) {
      next = loaded
      if (Array.isArray(trace)) trace.push({ parent: parent, from: 'loaded' })
    } else {
      const key = VANILLA_PARENTS[parent] !== undefined ? parent
        : (VANILLA_PARENTS[vanillaBare(parent)] !== undefined ? vanillaBare(parent) : '')
      if (key !== '') {
        next = VANILLA_PARENTS[key]
        if (Array.isArray(trace)) {
          trace.push({ parent: parent, from: 'builtin', key: key,
            shell: loaded === undefined || loaded === null ? false : true })
        }
      } else {
        if (Array.isArray(trace)) {
          trace.push({ parent: parent, from: 'none',
            shell: loaded === undefined || loaded === null ? false : true })
        }
        next = { textures: {} }
      }
    }
    node = next
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
  // 每个面的上下文（面名 / 原始写法 / 这张模型 textures 的键）都要交给 `resolveTexture`：
  // 报告里那句"面 up 引用的是裸词 stone，你大概想写 #stone"没有它就说不出来。
  const textureKeys = Object.keys(textures)
  const dereference = (reference, context) => {
    let name = String(reference === undefined ? '' : reference)
    for (let i = 0; i < 8 && name.charAt(0) === '#'; i++) {
      const next = textures[name.slice(1)]
      if (next === undefined) break
      name = String(next)
    }
    return resolveTexture(name, context)
  }
  return elements.map((element, elementIndex) => {
    const faces = {}
    for (const face of Object.keys(element.faces || {})) {
      const data = element.faces[face]
      const raw = String(data === undefined || data.texture === undefined ? '' : data.texture)
      const tex = dereference(data.texture,
        { face: face, element: elementIndex, raw: raw, keys: textureKeys })
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

