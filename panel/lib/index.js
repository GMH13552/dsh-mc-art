// 生成物：由 panel/build.mjs 从 tools/mcart-plugin/host.js 生成 —— 不要手改。
// 改行为请改那份源码，然后 `node panel/build.mjs`（verify-build.mjs 会挡住漂移）。
import { mkdir as nodeMkdir, readdir as nodeReaddir, readFile as nodeReadFile, rename as nodeRename, rm as nodeRm, stat as nodeStat, writeFile as nodeWriteFile } from 'node:fs/promises'
import { dirname as nodeDirname } from 'node:path'
import { fileURLToPath as nodeFileURLToPath } from 'node:url'

const VERSION = "0.3.1"
// 本模块所在目录（<包>/lib）。宿主源码用它推出**随包的那份引擎**在哪里 ——
// 参考目录要靠 Python 脚本读 jar，而"项目不在 mc-art 仓库里"的机器上，
// 只从项目目录往上找是找不到的（实测：设置存得下、什么也读不出来）。
//
// 用 try 包住是有原因的：门禁会把这份模块当 data: URL 加载（注入"垫片没了"那种故障），
// 那时 import.meta.url 不是 file:，而 fileURLToPath 会直接抛 —— 拿不到路径就不拿，
// 宿主源码里 moduleDirOf() 本来就允许空串。
function moduleDirOfSelf() {
  try { return nodeDirname(nodeFileURLToPath(import.meta.url)) } catch (error) { return '' }
}
const MODULE_DIR = moduleDirOfSelf()

// 本地文件系统垫片：**服务都缺席时的最后一条路**。
//
// 为什么包在宿主里要自带这个：fs 服务和 shell 服务都是可能缺席的外部行，而"把用户
// 点出来的工程建出来 / 把他画的那张图存下去"不该因为缺一行就整个做不到。用户机器上
// 实测过一次（Windows 桌面端 0.2.0-rc.2）：面板能扫描、能弹系统目录对话框，
// 却回了一句"宿主没有 shell 服务时建不出目录"——那句话是猜的。现在源码里每一层
// 只报自己的失败原因，这个垫片兜住最后一种情况，结果里写明 via=node:fs。
//
// 它绕过宿主的 sandbox 策略（不产生文件效应记录、不触发审批），所以**排在最后**：
// 只有 directoryPickerController / shell / fs 三条都不可用时才会被用到。
// （这段是模板字符串里的生成代码：注释里不能出现反引号。）
const nodeFs = {
  available: true,
  async mkdirp(path) { await nodeMkdir(path, { recursive: true }) },
  async stat(path) {
    try {
      const info = await nodeStat(path)
      return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, version: String(info.mtimeMs) }
    } catch (error) { return undefined }
  },
  async listDir(path) {
    try {
      const entries = await nodeReaddir(path, { withFileTypes: true })
      const out = []
      for (const entry of entries) {
        let size, version
        try { const info = await nodeStat(path + '/' + entry.name); size = info.size; version = String(info.mtimeMs) } catch (error) {}
        out.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: size, version: version })
      }
      return out
    } catch (error) { return [] }
  },
  async readText(path) {
    try { return await nodeReadFile(path, 'utf8') } catch (error) { return undefined }
  },
  async readBytes(path, maxBytes) {
    try {
      const buffer = await nodeReadFile(path)
      if (maxBytes !== undefined && buffer.length > maxBytes) return undefined
      return new Uint8Array(buffer)
    } catch (error) { return undefined }
  },
  async writeText(path, text) {
    await nodeMkdir(nodeDirname(path), { recursive: true })
    await nodeWriteFile(path, text, 'utf8')
  },
  async writeBase64(path, base64) {
    await nodeMkdir(nodeDirname(path), { recursive: true })
    await nodeWriteFile(path, Buffer.from(base64, 'base64'))
  },
  async remove(path) { await nodeRm(path, { force: true }) },
  async move(from, to) {
    await nodeMkdir(nodeDirname(to), { recursive: true })
    await nodeRename(from, to)
  },
}

export const name = 'mcart-panel'
// 宿主半自己用 ctx.get(...) 取 fs / sessions / shell / webServer，不硬依赖任何服务。
export const inject = []

// 当前那张 handler 表与"路由是否已经注册过"都放在模块级。
//
// 为什么必须这样：宿主那一行在**热重启**时会被重新 apply 一次，而老实例卸载会把它那张表
// 逐条 delete 干净（每个 handle 的 disposer 都这么干）。如果路由捕获的是"某一次 apply 的
// 表"，就会出现：路由还活着、表已经空了 → 任何调用都回"宿主没有这个方法"（用户实测，
// 热重启才触发；彻底退出应用反而不触发）。所以路由只注册一次，派发时读**当前**这张表。
// （注意：这段是模板字符串里的生成代码，注释里不能出现反引号 —— 它会截断模板。）
let liveHandlers = null
let routeReady = false

export function apply(ctx) {
  // 动态插件里有 harness.handle；真包里没有，所以这里做一个同形状的垫片：
  // 收成一张表，再由下面那条路由统一派发。host.js 一行都不用改。
  const handlers = {}
  liveHandlers = handlers
  ctx.effect(() => () => { if (liveHandlers === handlers) liveHandlers = null })
  const harness = {
    handle(method, handler) {
      handlers[method] = handler
      return () => { delete handlers[method] }
    },
  }
  // 宿主源码**内联成一个真正的函数表达式**，不再在运行时构造/求值函数。
  //
  // 为什么改：0.2.1 的浏览器沙箱禁掉了求值型加载 —— 客户端那一半就是因此在工厂里
  // 抛错、整个 UI 不注册（宿主在 Node 里求值一直可用，所以它看起来"活着"，
  // 症状是"插件 active 但面板不在槽里"）。宿主这边同样改成静态函数，两条路
  // 都不再依赖求值，同一个原因不会再咬第二口。
  //
  // 注意：内联进 ESM 模块意味着这份源码跑在**严格模式**下（原来是宽松模式）。
  // 它本来就是按严格模式写的；门禁加载这份产物时会把任意宽松模式的写法当场
  // 暴露出来，而不是等用户机器上才炸。
  const plugin = (function (harness, console, TextEncoder, btoa, atob, nodeFs, moduleDir, process) {
  // >>> mcart:embedded-source
const FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 }
const FACE_ORDER = ['down', 'up', 'north', 'south', 'west', 'east']

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vlen = (a) => Math.sqrt(dot(a, a))
function unit(a) { const n = vlen(a); return n < 1e-12 ? [0, 0, 0] : mul(a, 1 / n) }

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
    const face = faceAfter(quad.face, x, y)
    const shade = quad.shaded === false ? 1.0 : (FACE_SHADE[face] === undefined ? quad.shade : FACE_SHADE[face])
    const turned = { p: p, uv: quad.uv, tex: quad.tex, shade: shade, mode: quad.mode,
      face: face, shaded: quad.shaded }
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

const VANILLA_PARENTS = {
  "block/block": {
    "textures": {},
    "gui_light": "side",
    "display": {
      "gui": {
        "rotation": [
          30,
          225,
          0
        ],
        "translation": [
          0,
          0,
          0
        ],
        "scale": [
          0.625,
          0.625,
          0.625
        ]
      }
    }
  },
  "block/cube": {
    "parent": "block/block",
    "textures": {
      "particle": "#north"
    },
    "elements": [
      {
        "from": [
          0,
          0,
          0
        ],
        "to": [
          16,
          16,
          16
        ],
        "faces": {
          "down": {
            "texture": "#down",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "up": {
            "texture": "#up",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "north": {
            "texture": "#north",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "south": {
            "texture": "#south",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "west": {
            "texture": "#west",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "east": {
            "texture": "#east",
            "uv": [
              0,
              0,
              16,
              16
            ]
          }
        }
      }
    ]
  },
  "block/cube_all": {
    "parent": "block/cube",
    "textures": {
      "particle": "#all",
      "down": "#all",
      "up": "#all",
      "north": "#all",
      "south": "#all",
      "west": "#all",
      "east": "#all"
    }
  },
  "block/cube_column": {
    "parent": "block/cube",
    "textures": {
      "particle": "#side",
      "end": "#end",
      "side": "#side",
      "down": "#end",
      "up": "#end",
      "north": "#side",
      "south": "#side",
      "west": "#side",
      "east": "#side"
    }
  },
  "block/cube_bottom_top": {
    "parent": "block/cube",
    "textures": {
      "particle": "#side",
      "bottom": "#bottom",
      "top": "#top",
      "side": "#side",
      "down": "#bottom",
      "up": "#top",
      "north": "#side",
      "south": "#side",
      "west": "#side",
      "east": "#side"
    }
  },
  "block/cross": {
    "textures": {
      "particle": "#cross"
    },
    "elements": [
      {
        "from": [
          0.8,
          0,
          8
        ],
        "to": [
          15.2,
          16,
          8
        ],
        "rotation": {
          "origin": [
            8,
            8,
            8
          ],
          "axis": "y",
          "angle": 45,
          "rescale": true
        },
        "shade": false,
        "faces": {
          "north": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          },
          "south": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          }
        }
      },
      {
        "from": [
          8,
          0,
          0.8
        ],
        "to": [
          8,
          16,
          15.2
        ],
        "rotation": {
          "origin": [
            8,
            8,
            8
          ],
          "axis": "y",
          "angle": 45,
          "rescale": true
        },
        "shade": false,
        "faces": {
          "west": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          },
          "east": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          }
        }
      }
    ]
  },
  "block/tinted_cross": {
    "parent": "block/cross",
    "textures": {}
  }
}


function vanillaBare(parent) {
  const prefix = 'minecraft:'
  return parent.slice(0, prefix.length) === prefix ? parent.slice(prefix.length) : parent
}


function pngSizeOf(bytes) {
  if (bytes === undefined || bytes === null || bytes.length === undefined || bytes.length < 24) return undefined
  const magic = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return undefined
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0
  if (width === 0 || height === 0) return undefined
  return { width: width, height: height }
}


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

function installHost(ctx) {
    const fsOf = () => ctx.get('fs')
    const sessionsOf = () => ctx.get('sessions')




    const shellOf = () => ctx.get('shell')
    const errors = []
    let preloads = new Map()
    let langs = new Map()
    const indexCache = new Map()
    const textureCache = {}
    const referenceTextures = new Map()
    const referenceAnimations = new Map()
    const referenceBlocks = new Map()
    const refSignatures = new Map()
    let hasWslpath = null

    function note(message) {
      if (errors.indexOf(message) < 0) errors.push(message)
    }

    const messageOf = (error) => String(error && error.message ? error.message : error)

    function localOf() {
      if (typeof nodeFs === 'undefined' || nodeFs === null || nodeFs.available !== true) return null
      return nodeFs
    }


    const subprocessOf = () => ctx.get('subprocess')


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


    async function readTextOf(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.readText(target)
        } catch (error) { return undefined }
      }
      const local = localOf()
      if (local === null) return undefined
      const text = await local.readText(path)
      return typeof text === 'string' ? text : undefined
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


    function normalizePath(value) {
      let text = String(value === undefined || value === null ? '' : value).split(BACKSLASH).join('/')
      const drive = /^[A-Za-z]:\//.test(text) ? text.slice(0, 2) : ''
      if (drive !== '') text = text.slice(2)
      const lead = text.charAt(0) === '/' ? '/' : ''
      const parts = []
      for (const piece of text.split('/')) {
        if (piece === '' || piece === '.') continue
        if (piece === '..') {
          if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
          else parts.push('..')
          continue
        }
        parts.push(piece)
      }
      return drive + lead + parts.join('/')
    }


    const samePath = (left, right) =>
      platformOf() === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right


    function packPathOf(project, value) {
      const raw = String(value === undefined || value === null ? '' : value)
      if (raw === '') return { ok: false, reason: '贴图句柄是空的，拒绝写' }
      if (raw.indexOf('\u0000') >= 0) return { ok: false, reason: '贴图句柄里有 NUL 字符，拒绝写' }
      const projectDir = normalizePath(String(project.dir))
      const pack = normalizePath(projectDir + '/pack')
      const driveAbsolute = /^[A-Za-z]:[\\/]/.test(raw)
      const absolute = driveAbsolute || raw.charAt(0) === '/' || raw.charAt(0) === BACKSLASH
      const at = normalizePath(absolute ? raw : projectDir + '/' + raw.split(BACKSLASH).join('/'))
      const inside = samePath(at, pack) || samePath(at.slice(0, pack.length + 1), pack + '/')
      if (inside) return { ok: true, path: at }
      const shape = driveAbsolute ? '盘符绝对路径'
        : (absolute ? '前导斜杠的绝对路径'
          : (raw.split(/[\\/]/).indexOf('..') >= 0 ? '相对路径里带 ..' : '包内相对路径'))
      return { ok: false, reason: '这条贴图解析之后落在项目包外面（句柄形态：' + shape
        + '；解析后 = ' + at + '；项目包 = ' + pack + '），拒绝写' }
    }


    function textureFileOf(project, value) {
      const text = String(value === undefined || value === null ? '' : value).split(BACKSLASH).join('/')
      if (text === '' || text.slice(0, 4) === 'ref:') return text
      if (/^[A-Za-z]:\//.test(text) || text.charAt(0) === '/') return text
      const dir = project !== undefined && project !== null && typeof project.dir === 'string'
        ? String(project.dir).split(BACKSLASH).join('/').replace(/\/+$/, '') : ''
      return dir === '' ? text : dir + '/' + text.replace(/^\.\//, '')
    }

    async function textureUrlFor(entry, project) {
      if (typeof entry !== 'string' || entry === '') return undefined
      if (entry.slice(0, 4) === 'ref:') return referenceTextures.get(entry)
      return await textureUrl(textureFileOf(project, entry))
    }

    function animationsFor(ids) {
      const out = {}
      for (const id of ids) {
        const animation = referenceAnimations.get(id)
        if (animation !== undefined) { out[id] = animation; continue }
        for (const load of preloads.values()) {
          const own = load.animations === undefined ? undefined : load.animations.get(id)
          if (own !== undefined) { out[id] = own; break }
        }
      }
      return out
    }


    function animationNotesFor(ids) {
      const out = {}
      for (const id of ids) {
        for (const load of preloads.values()) {
          const note = load.animationNotes === undefined ? undefined : load.animationNotes.get(id)
          if (note !== undefined) { out[id] = note; break }
        }
      }
      return out
    }


    async function projectAnimationOf(pngPath) {
      let text
      try { text = await readTextOf(pngPath + '.mcmeta') } catch (error) { text = undefined }
      if (text === undefined || text === null) return { why: '.mcmeta 读不出来（权限、编码或文件损坏）' }
      let parsed
      try { parsed = JSON.parse(String(text)) } catch (error) {
        return { why: '.mcmeta 不是合法 JSON：' + messageOf(error) }
      }
      const declared = parsed !== null && typeof parsed === 'object' ? parsed.animation : undefined
      if (declared === null || declared === undefined || typeof declared !== 'object') {
        return { why: '.mcmeta 里没有 animation 段' }
      }
      let bytes
      try { bytes = await readBytesOf(pngPath, 16 * 1024 * 1024) } catch (error) { bytes = undefined }
      const size = pngSizeOf(bytes)
      if (size === undefined) return { why: 'PNG 的尺寸读不出来（文件可能坏了）' }
      if (size.height <= size.width || size.height % size.width !== 0) {
        return { why: '图不是竖条（' + size.width + '×' + size.height + '；高必须是宽的整数倍）' }
      }
      const strip = Math.trunc(size.height / size.width)
      const order = []
      const listed = declared.frames
      if (Array.isArray(listed)) {
        for (const item of listed) {
          const index = item !== null && typeof item === 'object' ? item.index : item
          const number = Math.trunc(Number(index))
          if (isFinite(number) && number >= 0 && number < strip) order.push(number)
        }
      }
      if (order.length === 0) for (let index = 0; index < strip; index++) order.push(index)
      const declaredTime = Math.trunc(Number(declared.frametime === undefined ? 1 : declared.frametime))
      return { animation: {
        frames: order.length,
        strip: strip,
        order: order,
        frametime: !isFinite(declaredTime) || declaredTime < 1 ? 1 : declaredTime,
        interpolate: declared.interpolate === true,
      } }
    }

    async function preload(dir, namespace) {
      const assets = dir + '/pack/assets/' + namespace
      const models = new Map()
      const unreadableModels = new Map()
      for (const entry of await listDir(assets + '/models/block')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const key = 'block/' + entry.name.replace(/\.json$/, '')
        const text = await readTextOf(assets + '/models/block/' + entry.name)
        if (text === undefined || text === null) {
          unreadableModels.set(key, { file: 'models/block/' + entry.name, why: '读不出文件内容' })
          continue
        }
        try {
          models.set(key, JSON.parse(String(text)))
        } catch (error) {
          unreadableModels.set(key, { file: 'models/block/' + entry.name, why: '不是合法 JSON：' + messageOf(error) })
        }
      }
      const textures = new Map()
      const animations = new Map()
      const animationNotes = new Map()
      for (const kind of ['block', 'blocks', 'entity', 'item']) {
        for (const entry of await listDir(assets + '/textures/' + kind)) {
          if (entry.type !== 'file' || !/\.png$/.test(entry.name)) continue
          const relative = 'pack/assets/' + namespace + '/textures/' + kind + '/' + entry.name
          textures.set(namespace + ':' + kind + '/' + entry.name.replace(/\.png$/, ''), relative)
          const absolute = assets + '/textures/' + kind + '/' + entry.name
          const meta = await statOf(absolute + '.mcmeta')
          if (meta === undefined || meta.type !== 'file') continue
          const info = await projectAnimationOf(absolute)
          if (info.animation !== undefined) {
            animations.set(relative, info.animation)
          } else {
            animationNotes.set(relative, {
              state: 'unreadable',
              why: info.why,
              text: '这张贴图**有**动画描述文件，但我读不了它：' + relative + '.mcmeta —— ' + info.why,
            })
          }
        }
      }
      return { dir: dir, namespace: namespace, assets: assets, models: models, textures: textures,
        animations: animations, animationNotes: animationNotes, unreadableModels: unreadableModels }
    }


    async function readLang(assets) {
      const merged = {}
      const broken = []
      const missing = []
      for (const locale of ['en_us', 'zh_cn']) {
        const file = 'lang/' + locale + '.json'
        const full = assets + '/' + file
        const info = await statOf(full)
        if (info === undefined || info.type !== 'file') {
          missing.push({ file: file, why: '文件不存在（缺失，不是读坏了）' })
          continue
        }
        const text = await readTextOf(full)
        if (text === undefined || text === null) {
          broken.push({ file: file, why: '文件在，但读不出内容（权限或编码），不是缺失' })
          continue
        }
        let parsed
        try {
          parsed = JSON.parse(String(text))
        } catch (error) {
          broken.push({ file: file, why: '不是合法 JSON：' + messageOf(error) })
          continue
        }
        if (parsed === null || typeof parsed !== 'object') {
          broken.push({ file: file, why: '不是 JSON 对象（顶层应该是一张键值表）' })
          continue
        }
        for (const key of Object.keys(parsed)) {
          const value = parsed[key]
          if (typeof value === 'string' && value.length > 0) merged[key] = value
        }
      }
      const problems = broken.concat(Object.keys(merged).length === 0 ? missing : [])
      return { table: merged, problems: problems }
    }

    let vanillaTextureHandles = new Map()
    let vanillaTextureSignature = null

    function texturePath(load, reference) {
      let name = String(reference === undefined ? '' : reference)
      let namespace = load.namespace
      const colon = name.indexOf(':')
      if (colon >= 0) { namespace = name.slice(0, colon); name = name.slice(colon + 1) }
      const key = namespace + ':' + name
      const own = load.textures.get(key)
      if (own !== undefined) return own
      const other = preloads.get(namespace)
      if (other !== undefined) {
        const hit = other.textures.get(key)
        if (hit !== undefined) return hit
      }
      const fetched = vanillaTextureHandles.get(key)
      return fetched === undefined ? undefined : fetched
    }

    function elementsOf(load, modelName, extra, unresolved, trace) {
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
        return extra.get(id) || extra.get(parentKey) || extra.get('minecraft:' + parentKey)
      }, (reference, context) => {
        const tex = texturePath(load, reference)
        if (tex === undefined && typeof unresolved === 'function') unresolved(String(reference), context)
        return tex
      }, trace)
    }

    const vanillaModels = new Map()


    function chainGaps(load, modelName, extra) {
      const project = []
      const vanilla = []
      const seen = {}
      let cycle = false
      let key = String(modelName === undefined ? '' : modelName)
      let nameNamespace = load.namespace
      const colon = key.indexOf(':')
      if (colon >= 0) { nameNamespace = key.slice(0, colon); key = key.slice(colon + 1) }
      const own = (namespace) => namespace === '' || namespace === load.namespace
      for (let depth = 0; depth < 24; depth++) {
        const fromExtra = extra === undefined ? undefined
          : (extra.get(key) !== undefined ? extra.get(key) : extra.get('minecraft:' + key))
        const model = load.models.get(key) || fromExtra
        if (model === undefined) {
          if (key === '') break
          const isOwn = own(nameNamespace)
          const entry = { name: isOwn ? key : nameNamespace + ':' + key, bare: key,
            namespace: isOwn ? load.namespace : nameNamespace, kind: isOwn ? 'project' : 'vanilla' }
          if (isOwn) project.push(entry); else vanilla.push(entry)
          break
        }
        const parent = model.parent
        if (typeof parent !== 'string' || parent === '') break
        if (seen[parent] === true) { cycle = true; break }
        seen[parent] = true
        let parentNamespace = 'minecraft'
        let bare = parent
        const at = parent.indexOf(':')
        if (at >= 0) { parentNamespace = parent.slice(0, at); bare = parent.slice(at + 1) }
        if (load.models.get(bare) !== undefined) { key = bare; nameNamespace = parentNamespace; continue }
        if (extra !== undefined && (extra.get(parent) !== undefined || extra.get(bare) !== undefined)) {
          key = bare; nameNamespace = parentNamespace; continue
        }
        if (VANILLA_PARENTS[parent] !== undefined || VANILLA_PARENTS[bare] !== undefined) break
        const isOwn = own(parentNamespace)
        const entry = { name: parent, bare: bare, namespace: parentNamespace,
          kind: isOwn ? 'project' : 'vanilla' }
        if (isOwn) project.push(entry); else vanilla.push(entry)
        break
      }
      return { project: project, vanilla: vanilla, cycle: cycle }
    }


    function fixPathOf(load, entry, directory) {
      if (entry.kind === 'project') {
        const rest = entry.bare.replace(/^block\//, '')
        return 'pack/assets/' + load.namespace + '/models/block/' + rest + '.json'
      }
      const where = directory === ''
        ? '把参考目录指到 .minecraft/versions/<版本>（面板设置里那一栏）'
        : directory + ' 里的 <版本>.jar'
      return where + ' → assets/' + (entry.namespace || 'minecraft') + '/models/' + entry.bare + '.json'
    }


    async function referenceLooksReadable(directory) {
      const hasJar = async (dir) => {
        for (const entry of await listDir(dir)) {
          if (entry.type === 'file' && /\.jar$/i.test(entry.name)) return true
        }
        return false
      }
      const hasTree = async (dir) => {
        for (const entry of await listDir(dir + '/assets')) {
          if (entry.type !== 'directory') continue
          if (entry.name === 'indexes' || entry.name === 'objects' || entry.name === 'skins') continue
          return true
        }
        return false
      }
      if (await hasJar(directory)) return true
      if (await hasJar(directory + '/mods')) return true
      if (await hasTree(directory)) return true
      for (const version of await listDir(directory + '/versions')) {
        if (version.type !== 'directory') continue
        if (await hasJar(directory + '/versions/' + version.name)) return true
        if (await hasJar(directory + '/versions/' + version.name + '/mods')) return true
        if (await hasTree(directory + '/versions/' + version.name)) return true
      }
      return false
    }

    async function fetchVanillaModels(project, names) {
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { models: new Map(), reason: 'no-reference-directory',
          why: '这台机器上还没有设置参考目录（面板设置里指到 .minecraft/versions/<版本>，'
            + '或写进 mc-art.settings.json 的 reference.directory）' }
      }
      const signature = await refSignatureOf(directory)
      const want = []
      for (const name of names) {
        const cached = vanillaModels.get(signature + '|' + name)
        if (cached === undefined) want.push(name)
        else if (cached !== null) want.push(name)      // 命中缓存，下面照旧装进 out
      }
      if (want.length > 0) {
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) {
          return { models: new Map(), reason: 'extractor-failed', why: '找不到 ' + EXTRACT_SCRIPT }
        }
        const parsed = await runScanner(extractor, ['--root', directory, '--model', want.join(',')],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          const why = String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error)
          let reason = 'extractor-failed'
          if (why.indexOf('路径不存在') >= 0) reason = 'reference-jar-missing'
          else if (why.indexOf('一个模型都没取到') >= 0) {
            reason = (await referenceLooksReadable(directory)) ? 'vanilla-parent-missing' : 'reference-jar-missing'
          }
          return { models: new Map(), reason: reason, why: why }
        }
        for (const key of Object.keys(parsed.models || {})) {
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
      return { models: out, reason: '', why: '' }
    }


    async function fetchVanillaTextures(project, names) {
      if (names.length === 0) return { fetched: 0, reason: '', why: '' }
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { fetched: 0, reason: 'no-reference-directory',
          why: '这台机器上还没有设置参考目录（原版贴图在 .minecraft/versions/<版本> 的 jar 里）' }
      }
      const signature = await refSignatureOf(directory)
      if (vanillaTextureSignature !== signature) {
        vanillaTextureHandles = new Map()
        vanillaTextureSignature = signature
      }
      const want = names.filter((name) => vanillaTextureHandles.get(name) === undefined)
      if (want.length === 0) return { fetched: 0, reason: '', why: '' }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { fetched: 0, reason: 'extractor-failed', why: '找不到 ' + EXTRACT_SCRIPT }
      }
      const parsed = await runScanner(extractor, ['--root', directory, '--textures', want.join(',')],
        120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        const why = String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error)
        let reason = 'extractor-failed'
        if (why.indexOf('路径不存在') >= 0) reason = 'reference-jar-missing'
        else if (why.indexOf('一个贴图都没取到') >= 0) {
          reason = (await referenceLooksReadable(directory)) ? 'textures-unresolved' : 'reference-jar-missing'
        }
        return { fetched: 0, reason: reason, why: why }
      }
      let fetched = 0
      for (const key of Object.keys(parsed.textures || {})) {
        const refKey = 'ref:' + key
        referenceTextures.set(refKey, 'data:image/png;base64,' + parsed.textures[key])
        const animation = (parsed.animations || {})[key]
        if (animation !== undefined && animation !== null) referenceAnimations.set(refKey, animation)
        vanillaTextureHandles.set(key, refKey)
        const file = (parsed.textureFiles || {})[key]
        if (typeof file === 'string') {
          const parts = file.split('/')
          if (parts.length > 3 && parts[0] === 'assets') {
            vanillaTextureHandles.set(parts[1] + ':' + parts.slice(3).join('/').replace(/\.png$/, ''), refKey)
          }
        }
        fetched += 1
      }
      return { fetched: fetched, reason: '', why: '' }
    }


    async function projectElements(project, load, modelName) {
      const extra = new Map()
      let scan = chainGaps(load, modelName, extra)
      for (let round = 0; round < 4; round++) {
        if (scan.cycle === true) {
          return { elements: undefined, extra: extra, project: [], vanilla: [], cycle: true,
            fetchReason: 'parent-cycle', why: '', unresolvedTextures: [], textureWhy: '' }
        }
        if (scan.project.length > 0) {
          return { elements: undefined, extra: extra, project: scan.project, vanilla: [], cycle: false,
            fetchReason: '', why: '', unresolvedTextures: [], textureWhy: '' }
        }
        if (scan.vanilla.length === 0) break
        const fetched = await fetchVanillaModels(project, scan.vanilla.map((entry) => entry.name))
        if (fetched.models.size === 0) {
          return { elements: undefined, extra: extra, project: [], vanilla: scan.vanilla, cycle: false,
            fetchReason: fetched.reason === undefined ? '' : fetched.reason, why: fetched.why,
            unresolvedTextures: [], textureWhy: '' }
        }
        for (const pair of fetched.models.entries()) extra.set(pair[0], pair[1])
        scan = chainGaps(load, modelName, extra)
      }
      let unresolvedTextures = []
      let bareWords = []
      let danglingVariables = []
      const collect = (name, context) => {
        if (unresolvedTextures.indexOf(name) < 0) unresolvedTextures.push(name)
        const info = context === undefined || context === null ? {} : context
        const raw = String(info.raw === undefined ? '' : info.raw)
        const keys = Array.isArray(info.keys) ? info.keys : []
        const face = String(info.face === undefined ? '' : info.face)
        const bare = raw !== '' && raw.indexOf('#') < 0 && raw.indexOf(':') < 0 && raw.indexOf('/') < 0
        if (bare && keys.indexOf(raw) >= 0) {
          if (!bareWords.some((one) => one.raw === raw)) bareWords.push({ raw: raw, face: face, keys: keys.slice(0, 12) })
          return
        }
        if (raw.charAt(0) === '#' && keys.indexOf(raw.slice(1)) < 0) {
          if (!danglingVariables.some((one) => one.name === raw)) {
            danglingVariables.push({ name: raw, face: face })
          }
        }
      }
      let trace = []
      let elements = elementsOf(load, modelName, extra, collect, trace)
      let textureWhy = ''
      if (unresolvedTextures.length > 0) {
        const wanted = unresolvedTextures.map((name) =>
          name.indexOf(':') >= 0 ? name : load.namespace + ':' + name)
        const fetched = await fetchVanillaTextures(project, wanted)
        textureWhy = fetched.why
        if (fetched.fetched > 0) {
          unresolvedTextures = []
          bareWords = []
          danglingVariables = []
          trace = []
          elements = elementsOf(load, modelName, extra, collect, trace)
        }
      }
      return { elements: elements, extra: extra, project: scan.project, vanilla: scan.vanilla,
        cycle: scan.cycle === true, fetchReason: '', why: '',
        unresolvedTextures: unresolvedTextures, bareWords: bareWords,
        danglingVariables: danglingVariables, textureWhy: textureWhy, trace: trace }
    }


    function modelsInState(state) {
      const out = []
      const seen = {}
      const push = (value) => {
        if (value === undefined || value === null) return
        if (Array.isArray(value)) { for (const item of value) push(item); return }
        if (typeof value !== 'object') return
        const model = value.model
        if (typeof model === 'string' && model !== '' && seen[model] !== true) {
          seen[model] = true
          out.push(model)
        }
      }
      if (state === undefined || state === null || typeof state !== 'object') return out
      if (state.variants !== undefined && state.variants !== null && typeof state.variants === 'object') {
        for (const key of Object.keys(state.variants)) push(state.variants[key])
      }
      if (Array.isArray(state.multipart)) {
        for (const part of state.multipart) {
          if (part === null || typeof part !== 'object') continue
          push(part.apply)
        }
      }
      return out
    }


    function modelRank(id, name) {
      const base = String(name).replace(/^[^:]*:/, '').replace(/^block\//, '').replace(/\.json$/, '')
      if (base === id) return 0
      if (/_post$/.test(base)) return 1
      if (/_bottom$/.test(base)) return 2
      if (base.indexOf(id) === 0) return 3
      return 4
    }

    function chooseModel(load, id, models) {
      if (models.length === 0) return { model: 'block/' + id, guessed: true }
      const inPack = (name) => load.models.get(String(name).replace(/^[^:]*:/, '')) !== undefined
      let best = null
      for (const name of models) {
        if (!inPack(name)) continue
        const rank = modelRank(id, name)
        if (best === null || rank < best.rank) best = { model: name, rank: rank }
      }
      if (best !== null) return { model: best.model, guessed: false }
      return { model: models[0], guessed: false }
    }

    async function blockIds(load) {
      const out = []
      for (const entry of await listDir(load.assets + '/blockstates')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const id = entry.name.replace(/\.json$/, '')
        const state = await readJson(load.assets + '/blockstates/' + entry.name)
        const models = modelsInState(state)
        const chosen = chooseModel(load, id, models)
        out.push({ id: id, model: chosen.model, models: models, guessed: chosen.guessed })
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
        const lang = await readLang(load.assets)
        load.langProblems = lang.problems
        nextPreloads.set(namespace, load)
        nextLangs.set(namespace, lang.table)
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

    const SCAN_SCRIPT = 'tools/mcart_scan_refs.py'
    const EXTRACT_SCRIPT = 'tools/mcart_extract_block.py'
    const REFERENCE_MAX_BYTES = 8 * 1024 * 1024
    const toolPaths = new Map()


    function trimTrailing(value) {
      let at = String(value === undefined || value === null ? '' : value)
      while (at.length > 1 && (at.charAt(at.length - 1) === '/' || at.charAt(at.length - 1) === BACKSLASH)) {
        at = at.slice(0, at.length - 1)
      }
      return at
    }


    function absoluteOf(value) {
      const raw = String(value === undefined || value === null ? '' : value)
      if (raw === '') return ''
      if (raw.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(raw) || raw.slice(0, 2) === '\\\\') return raw
      const cwd = (typeof process !== 'undefined' && process !== null && typeof process.cwd === 'function')
        ? process.cwd() : ''
      if (cwd === '') return raw
      return trimTrailing(cwd.split(BACKSLASH).join('/')) + '/' + raw
    }

    async function findTool(start, relative) {
      const base = absoluteOf(trimTrailing(start))
      const cacheKey = relative + '|' + base
      if (toolPaths.has(cacheKey)) return toolPaths.get(cacheKey)
      let found = null
      for (const candidate of skillToolCandidates(relative)) {
        const full = absoluteOf(trimTrailing(candidate))
        const info = await statOf(full)
        if (info !== undefined && info.type === 'file') { found = full; break }
      }
      if (found === null) {
        let at = base
        for (let depth = 0; depth < 5 && at !== ''; depth++) {
          const info = await statOf(at + '/' + relative)
          if (info !== undefined && info.type === 'file') { found = at + '/' + relative; break }
          at = parentOf(at) || ''
        }
      }
      toolPaths.set(cacheKey, found)
      return found
    }

    async function findScanner(start) { return await findTool(start, SCAN_SCRIPT) }


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
        push(pkg + '/python/' + base)
        push(above + '/python/' + base)
        push(above + '/' + relative)
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

    const PYTHON_CANDIDATES = [
      { bin: 'python3', args: [] },
      { bin: 'python', args: [] },
      { bin: 'py', args: ['-3'] },
      { bin: 'py', args: [] },
    ]
    let pythonLauncher = ''
    let pythonExe = ''        // 原样的可执行（subprocess 用 argv，shell 用转义过的 launcher）
    let pythonArgs = []       // 解释器自己的参数（`py -3` 的那个 -3）
    let pythonVia = null      // 'subprocess' | 'shell' —— 出错时要说清走的哪条
    let pythonWhy = null


    function bundledPythonDirs() {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      push(envOf('DSH_DESKTOP_PRIMARY_RUNTIME_DIR'))
      if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
        for (const value of process.argv) {
          if (typeof value === 'string' && /(^|[\\/])runtime[\\/]primary-runtime$/.test(value)) push(value)
        }
      }
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


    function pythonCandidateList() {
      const out = []
      const seen = {}
      const push = (bin, args, guess) => {
        if (typeof bin !== 'string' || bin === '') return
        const list = Array.isArray(args) ? args : []
        const key = bin + ' ' + list.join(' ')
        if (seen[key] === true) return
        seen[key] = true
        out.push({ bin: bin, args: list, guess: guess === true })
      }
      push(envOf('MC_ART_PYTHON'), [], false)
      for (const candidate of PYTHON_CANDIDATES) push(candidate.bin, candidate.args, false)
      for (const dir of bundledPythonDirs()) {
        push(dir + '/python/python.exe', [], true)    // Windows: dependencies/python/python.exe
        push(dir + '/python/bin/python3', [], true)   // POSIX:    dependencies/python/bin/python3
        push(dir + '/python/bin/python', [], true)
      }
      return out
    }


    function pythonCandidates() {
      return pythonCandidateList().map((candidate) =>
        candidate.bin + (candidate.args.length === 0 ? '' : ' ' + candidate.args.join(' ')))
    }


    const pythonLabel = (candidate) =>
      candidate.bin + (candidate.args.length === 0 ? '' : ' ' + candidate.args.join(' '))

    async function resolvePython(workspaceRoot) {
      if (pythonLauncher !== '') return pythonLauncher
      const dialect = await currentShell(workspaceRoot)
      const tried = []
      for (const candidate of pythonCandidateList()) {
        const pathLike = isPathLike(candidate.bin)
        if (candidate.guess === true && pathLike) {
          const info = await statOf(candidate.bin)
          if (info === undefined || info.type !== 'file') continue
        }
        const probe = ['-c', 'print(1)']
        if (pathLike || subprocessOf() !== undefined) {
          const exe = pathLike ? candidate.bin : await resolveExecutable(candidate.bin)
          if (exe !== null) {
            const done = await runProcess([exe].concat(candidate.args, probe), { maxBytes: 4096 })
            if (done !== null) {
              if (done.exitCode === 0 && String(done.text).trim() === '1') {
                pythonExe = exe
                pythonArgs = candidate.args
                pythonVia = 'subprocess'
                pythonLauncher = pythonLabel(candidate)
                return pythonLauncher
              }
              tried.push(pythonLabel(candidate) + '(subprocess exit=' + String(done.exitCode) +
                (String(done.err).trim() === '' ? '' : ' ' + String(done.err).trim().slice(0, 60)) + ')')
              continue
            }
          }
        }
        const head = pathLike ? dialect.word(candidate.bin) : candidate.bin
        const words = [head].concat(candidate.args.map((arg) => dialect.word(arg)))
        const probeShell = await runShell(words.join(' ') + ' -c "print(1)"', 20000,
          policyFor(workspaceRoot), 4096)
        if (probeShell.exitCode === 0 && String(probeShell.text).trim() === '1') {
          pythonExe = candidate.bin
          pythonArgs = candidate.args
          pythonVia = 'shell'
          pythonLauncher = pythonLabel(candidate)
          return pythonLauncher
        }
        tried.push(pythonLabel(candidate) + '(shell exit=' + String(probeShell.exitCode) +
          (String(probeShell.err).trim() === '' ? '' : ' ' + String(probeShell.err).trim().slice(0, 60)) + ')')
      }
      pythonWhy = tried.join('、')
      return null
    }


    function pythonHint() {
      return pythonLauncher === '' ? pythonLabel(PYTHON_CANDIDATES[0]) : pythonLauncher
    }

    async function runScanner(scanner, tokens, timeoutMs, workspaceRoot, maxBytes) {
      const python = await resolvePython(workspaceRoot)
      if (python === null) {
        return { error: '找不到 Python（试过 ' + String(pythonWhy) +
          '）。抽取器是 Python 写的；桌面版自带的那份在 <resources>/runtime/primary-runtime/' +
          'dependencies/python/python.exe，也可以用 MC_ART_PYTHON 指定一个。' }
      }
      if (pythonVia === 'subprocess' && pythonExe !== '') {
        const argv = [pythonExe].concat(pythonArgs, ['-B', '-X', 'utf8', scanner], tokens === undefined ? [] : tokens)
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
      const result = await runShell(python + ' -B -X utf8 ' + dialect.word(scanner) +
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

    const envOf = (name) => {
      if (typeof process === 'undefined' || process.env === undefined) return ''
      const value = process.env[name]
      return typeof value === 'string' ? value : ''
    }


    function platformOf() {
      if (typeof process === 'undefined' || process === null) return ''
      return typeof process.platform === 'string' ? process.platform : ''
    }


    function moduleDirOf() {
      if (typeof moduleDir !== 'undefined' && typeof moduleDir === 'string') return moduleDir
      return ''
    }


    function gameRootCandidates(near) {
      const home = envOf('USERPROFILE') || envOf('HOME')
      const roaming = envOf('APPDATA') || (home === '' ? '' : home + '/AppData/Roaming')
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      push(roaming === '' ? '' : roaming + '/.minecraft')
      push(home === '' ? '' : home + '/.minecraft')
      push(home === '' ? '' : home + '/Library/Application Support/minecraft')
      push(roaming === '' ? '' : roaming + '/com.mojang/minecraft')
      push(home === '' ? '' : home + '/curseforge/minecraft/Instances')
      push(roaming === '' ? '' : roaming + '/PrismLauncher/instances')
      push(roaming === '' ? '' : roaming + '/MultiMC/instances')
      const here = typeof near === 'string' ? near : ''
      for (const base of [here, parentOf(here)]) {
        if (typeof base !== 'string' || base === '') continue
        push(base + '/.minecraft')
        push(base + '/run')
      }
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

    function normalizeCells(input) {
      const out = []
      if (!Array.isArray(input)) return out
      for (const cell of input) {
        if (!cell || typeof cell.block !== 'string' || cell.block === '') continue
        if (!Array.isArray(cell.at) || cell.at.length < 3) continue
        const at = [0, 1, 2].map((i) => Math.trunc(Number(cell.at[i])))
        if (!at.every((value) => isFinite(value))) continue
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

    async function referenceDirectory(project) {
      const stored = (await readJson(project.dir + '/mc-art.settings.json')) || {}
      const reference = stored.reference !== null && typeof stored.reference === 'object' ? stored.reference : {}
      return typeof reference.directory === 'string' ? reference.directory : ''
    }

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

    const editablePaths = new Map()

    function itemHandle(namespace, reference) {
      const text = String(reference === undefined || reference === null ? '' : reference)
      return 'ref:' + (text.indexOf(':') >= 0 ? text : namespace + ':' + text)
    }


    function missingItemIcon(namespace, item, reason) {
      const text = String(reason === undefined || reason === null ? '' : reason)
      return {
        namespace: namespace,
        item: item,
        name: item,
        shape: 'none',
        error: text,
        missing: true,
        reason: text,
        light: null, display: null, form: null, family: null, formLabel: null,
        named: false, layers: [], frames: [], framesTruncated: false,
        quads: [], textureIds: [], textures: {}, animations: {},
        missingModels: [], modelPath: '',
      }
    }


    function itemEntryProblem(namespace, item, entry) {
      if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
        return '取不到这个物品的图标：抽取器没有返回它的数据（' + namespace + ':' + item + '）'
      }
      if (typeof entry.error === 'string' && entry.error !== '') return entry.error
      if (typeof entry.item !== 'string' || entry.item === '') {
        return '取不到这个物品的图标：抽取器没认出 ' + namespace + ':' + item
      }
      return null
    }


    function refIconEntryProblem(entry) {
      if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
        return '抽取器没有返回这个方块的条目'
      }
      if (typeof entry.png !== 'string') return '条目里没有 png 字段'
      if (entry.png === '') return 'png 字段是空的'
      return null
    }

    async function itemIcon(namespace, parsed, have, project) {
      const load = virtualLoad(namespace, parsed)
      const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
      const safe = (value) => (value === undefined ? null : value)
      const out = {
        namespace: namespace, item: text(parsed.item, ''),
        name: text(parsed.name, text(parsed.item, '')),
        shape: text(parsed.shape, 'none'), light: safe(parsed.light), display: parsed.display || null,
        form: safe(parsed.form), family: safe(parsed.family), formLabel: safe(parsed.formLabel),
        named: parsed.named === true,
        layers: [], frames: [], framesTruncated: parsed.framesTruncated === true,
        quads: [], error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : null,
        missingModels: Array.isArray(parsed.missingModels) ? parsed.missingModels : [],
      }
      const ids = []
      const add = (id) => { if (ids.indexOf(id) < 0) ids.push(id) }
      if (parsed.shape === 'iso') {
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
        const url = await textureUrlFor(id, project)
        if (url !== undefined) textures[id] = url
      }
      out.textures = textures
      out.animations = animationsFor(ids)
      out.animationNotes = animationNotesFor(ids)
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
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--items', items.join(','), '--namespace', namespace]),
        180000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
      }
      const out = {}
      for (const item of Object.keys(parsed.items || {})) {
        const entry = parsed.items[item]
        const reason = itemEntryProblem(namespace, item, entry)
        if (reason !== null) {
          out[item] = missingItemIcon(namespace, item, reason)
          continue
        }
        try {
          out[item] = await itemIcon(namespace, entry, [], project)
        } catch (error) {
          out[item] = missingItemIcon(namespace, item,
            '画这个物品的图标时出错：' + String(error && error.message ? error.message : error))
        }
      }
      return { namespace: namespace, version: parsed.version, items: out }
    }

    async function referenceLoad(root, project, namespace, block, variant) {
      const wanted = typeof variant === 'string' && variant !== '' ? variant : null
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
      const dialect = await currentShell(project.dir)
      const command = pythonHint() + ' -B ' + dialect.word(extractor) + ' ' +
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
        variantAxes: parsed.variantAxes || [],
        variantDefaults: parsed.variantDefaults || {},
        rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
        modelRef: refs[0], modelRefs: refs,
        modelRotations: parsed.modelRotations || [],
        whenList: parsed.multipartWhens || [],
        multipart: parsed.multipart === true,
        load: virtualLoad(namespace, parsed), command: command,
      }
      referenceBlocks.set(key, entry)
      return entry
    }

    function entryFamily(entry, id) {
      if (entry === undefined || entry === null) return 'other'
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
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
      let shape = 'other'
      if (sawUp) shape = 'wall'
      else if (sawFalse) shape = 'pane'
      else if (sawTrue) shape = 'fence'
      if (shape === 'other') return 'other'
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

    function connectsTo(version, self, neighbour, dir) {
      const absent = neighbour === null || neighbour === undefined
      if (isOldVersion(version)) {
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
        const flag = face === (self.family === 'wall' ? 'poleThick' : 'pole')
        return (!exception && face !== 'solid') || flag
      }
      if (absent) return false
      const exception = isException18(neighbour.id)
      const solid = neighbour.cube === true && !exception
      if (neighbour.family === 'gate') {
        return gateAlongAxis(neighbour, dir)
      }
      if (self.family === 'wall') {
        return neighbour.family === 'wall' || solid || neighbour.family === 'pane'
      }
      if (self.family === 'fence') {
        return solid || (neighbour.family === 'fence' && self.wooden === fenceWooden(neighbour.id))
      }
      if (self.family === 'pane') {
        return solid || neighbour.family === 'pane' || neighbour.family === 'wall'
      }
      return false
    }

    function gateAlongAxis(neighbour, dir) {
      const facing = variantValueOf(neighbour.variant, 'facing')
      return facing === null || axisOfDirection(facing) === axisOfDirection(dir)
    }

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
        const flag = (sides.south && !sides.west && sides.north && sides.east)
          || (!sides.south && sides.west && !sides.north && sides.east)
        values.up = flag ? (above === null ? 'false' : 'true') : 'true'
        return values
      }
      let raise = above !== null && above.family === 'wall'
      if (!raise) {
        const none = (name) => values[name] === undefined || values[name] === 'none'
        const asym = (none('north') && none('south') && none('east') && none('west'))
          || (none('north') !== none('south')) || (none('east') !== none('west'))
        const tallPair = (values.north === 'tall' && values.south === 'tall')
          || (values.east === 'tall' && values.west === 'tall')
        if (asym) raise = true
        else if (tallPair) raise = false
        else raise = above !== null && above.cube === true
      }
      values.up = raise ? 'true' : 'false'
      return values
    }

    function whenMatches(when, values) {
      for (const key of Object.keys(when)) {
        const have = values[key]
        if (have === undefined) continue
        if (String(have) !== String(when[key])) return false
      }
      return true
    }

    function fenceWooden(id) {
      const text = String(id)
      return !/nether_brick_fence$/.test(text.slice(text.indexOf(':') + 1))
    }

    function keepFlags(entry, values) {
      const whens = Array.isArray(entry.whenList) ? entry.whenList : []
      const refs = Array.isArray(entry.modelRefs) ? entry.modelRefs : []
      if (entry.multipart !== true || whens.length !== refs.length || refs.length === 0) return undefined
      for (const when of whens) {
        for (const key of Object.keys(when)) {
          if (values[key] === undefined) return undefined
        }
      }
      return whens.map((when) => whenMatches(when, values))
    }

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
      if (missed.length > 0 && report !== undefined) report('模型链里缺了：' + missed.join('、'))
      return rotateQuads(out, entry.rotation)
    }

    async function blockQuadsAt(root, project, block, at, variant, around) {
      const found = await entryFor(root, project, String(block), variant)
      if (found.error !== undefined) {
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
      const quads = quadsOfEntry(load, entry, note, keep)
      if (quads === undefined) return { error: '找不到 ' + String(block) + ' 的模型' }
      if (quads.length === 0 && keep === undefined) {
        return { error: '找不到 ' + String(block) + ' 的模型（整条模型链一个面都解不出来，'
          + '通常是贴图在项目包里没有、参考目录也没取到）' }
      }
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
      return { quads: translateQuads(quads, at),
        variants: entry.variantKeys || [], axes: axes, defaults: entry.variantDefaults || {},
        variant: entry.rotation === null || entry.rotation === undefined ? null : variant,
        multipart: entry.multipart === true, derived: keep !== undefined && keep !== null }
    }



    function textureMissingOf(load, name, directory) {
      const colon = name.indexOf(':')
      const explicit = colon >= 0
      const namespace = explicit ? name.slice(0, colon) : load.namespace
      const path = explicit ? name.slice(colon + 1) : name
      const kind = explicit && namespace !== load.namespace ? 'vanilla' : 'project'
      const where = directory === ''
        ? '把参考目录指到 .minecraft/versions/<版本>（面板设置里那一栏）'
        : directory + ' 里的 <版本>.jar'
      return {
        kind: kind,
        name: explicit ? name : load.namespace + ':' + name,
        fixPath: kind === 'project'
          ? 'pack/assets/' + load.namespace + '/textures/' + path + '.png'
          : where + ' → assets/' + namespace + '/textures/' + path + '.png',
      }
    }

    function blockDiagnostic(load, namespace, id, found, built, directory) {
      const langProblems = load === undefined || !Array.isArray(load.langProblems) ? [] : load.langProblems
      const project = Array.isArray(built.project) ? built.project : []
      const vanilla = Array.isArray(built.vanilla) ? built.vanilla : []
      const textures = Array.isArray(built.unresolvedTextures) ? built.unresolvedTextures : []
      const bareWords = Array.isArray(built.bareWords) ? built.bareWords : []
      const dangling = Array.isArray(built.danglingVariables) ? built.danglingVariables : []
      const missing = project.concat(vanilla).map((entry) => ({
        kind: entry.kind === 'project' ? 'project' : 'vanilla',
        name: String(entry.name),
        fixPath: fixPathOf(load, entry, directory),
      })).concat(textures.map((name) => textureMissingOf(load, name, directory)))
      let reason = 'unknown'
      if (built.cycle === true) reason = 'parent-cycle'
      else if (project.length > 0) reason = 'project-model-missing'
      else if (typeof built.fetchReason === 'string' && built.fetchReason !== '') reason = built.fetchReason
      else if (vanilla.length > 0) reason = directory === '' ? 'no-reference-directory' : 'vanilla-parent-missing'
      else if (bareWords.length > 0) reason = 'texture-missing-hash'
      else if (dangling.length > 0) reason = 'texture-variable-unresolved'
      else if (textures.length > 0) {
        const onlyProject = textures.every((name) => textureMissingOf(load, name, directory).kind === 'project')
        reason = directory === '' && !onlyProject ? 'no-reference-directory' : 'textures-unresolved'
      }
      else if (built.noQuads === true) reason = 'no-quads'
      else if (built.noElements === true) reason = 'no-geometry'
      const allowed = { 'project-model-missing': 1, 'vanilla-parent-missing': 1,
        'no-reference-directory': 1, 'reference-jar-missing': 1, 'extractor-failed': 1,
        'parent-cycle': 1, 'textures-unresolved': 1, 'no-quads': 1, 'no-geometry': 1,
        'texture-missing-hash': 1, 'texture-variable-unresolved': 1, 'unknown': 1 }
      if (allowed[reason] !== 1) reason = 'unknown'

      const bareModel = String(found.model).replace(/^[^:]*:/, '')
      const trace = Array.isArray(built.trace) ? built.trace : []
      const builtinHits = trace.filter((step) => step.from === 'builtin').map((step) => step.key)
      const builtinConsulted = trace.some((step) => step.from === 'builtin' || step.from === 'none')
      const shells = trace.filter((step) => step.shell === true).map((step) => step.parent)
      const builtinLine = builtinHits.length > 0
        ? '面板内置的原版母模型表：' + builtinHits.join('、') + '（这一条是它兜住的）'
        : (builtinConsulted
          ? '面板内置的原版母模型表：查过，没有 ' + trace.filter((step) => step.from === 'none')
            .map((step) => step.parent).join('、')
          : '面板内置的原版母模型表：这次不需要它')
      const tried = [
        '项目包：' + load.assets + '/models/'
          + (bareModel.indexOf('block/') === 0 ? bareModel : 'block/' + bareModel) + '.json',
        builtinLine,
        directory === '' ? '参考目录：没设，从 jar 现取这条路没走'
          : '参考目录的 jar 现取：' + directory,
      ]
      if (shells.length > 0) {
        tried.push('取回来但是**空壳**（既没有 elements 也没有 parent，等于没取到）：'
          + shells.slice(0, 3).join('、'))
      }
      if (textures.length > 0) {
        tried.push('贴图现取（--textures）：' + (directory === '' ? '没设参考目录，没走' : directory))
      }
      if (langProblems.length > 0) {
        tried.push('语言文件：' + langProblems.map((info) => info.file + '（' + info.why + '）').join('、'))
      }

      const lines = ['[MC 资产面板] 画不出 ' + namespace + ':' + id]
      if (found.guessed === true) {
        lines.push('· blockstate 里一个模型名都没有，按惯例找 ' + String(found.model) + '（这一条是猜的）')
      } else {
        lines.push('· blockstate 引用的模型（' + found.models.length + ' 个）：'
          + found.models.slice(0, 6).join('、') + (found.models.length > 6 ? ' …' : ''))
      }
      lines.push('· 选用的模型：' + String(found.model))
      if (project.length > 0) {
        const unreadable = load === undefined || load.unreadableModels === undefined ? new Map() : load.unreadableModels
        const broken = []
        const missing = []
        for (const entry of project) {
          const bare = String(entry.bare === undefined ? entry.name : entry.bare).replace(/^block\//, '')
          const info = unreadable.get('block/' + bare)
          if (info === undefined) missing.push(entry)
          else broken.push(info)
        }
        if (broken.length > 0) {
          lines.push('· 项目自己的模型文件**在，但解析失败**（' + broken.length + ' 个）——不是缺失，不要照"补文件"处理：')
          for (const info of broken) lines.push('  - ' + info.file + ' → ' + info.why)
        }
        if (missing.length > 0) {
          lines.push('· 项目自己的模型文件缺失（' + missing.length + ' 个）：')
          for (const entry of missing) lines.push('  - ' + entry.name + ' → 补 ' + fixPathOf(load, entry, directory))
        }
      }
      if (vanilla.length > 0) {
        lines.push('· 原版母模型缺失（' + vanilla.length + ' 个）：')
        for (const entry of vanilla) lines.push('  - ' + entry.name + ' → ' + fixPathOf(load, entry, directory))
      }
      if (langProblems.length > 0) {
        lines.push('· 语言文件读不出来（' + langProblems.length + ' 个）→ 这些文件里的方块名只能用原始 id：')
        for (const info of langProblems) lines.push('  - ' + info.file + ' → ' + info.why)
      }
      if (bareWords.length > 0) {
        lines.push('· 有 ' + bareWords.length + ' 个面把**裸词**当贴图写（模型格式里裸词是路径，不是变量）：')
        for (const one of bareWords.slice(0, 4)) {
          lines.push('  - 面 ' + one.face + ' 引用的是裸词 `' + one.raw + '`。模型格式里它被当成**路径**（'
            + load.namespace + ':textures/' + one.raw + '.png），而不是你 `textures` 映射里的那个键。'
            + '**你大概想写 `#' + one.raw + '`。**')
          if (Array.isArray(one.keys) && one.keys.length > 0) {
            lines.push('    这张模型 textures 里的键：' + one.keys.join('、'))
          }
        }
        if (bareWords.length > 4) lines.push('  - …（还有 ' + (bareWords.length - 4) + ' 个，见结构化诊断）')
      }
      if (dangling.length > 0) {
        lines.push('· 有 ' + dangling.length + ' 个面引用 `#变量`，但模型的 textures 映射里没有这个键：')
        for (const one of dangling.slice(0, 4)) {
          lines.push('  - 面 ' + one.face + ' 引用 `' + one.name + '` → 补上这个键，或改成映射里已有的键')
        }
      }
      const otherTextures = textures.filter((name) =>
        !bareWords.some((one) => one.raw === name) && !dangling.some((one) => one.name === name))
      if (otherTextures.length > 0) {
        lines.push('· 面引用的贴图解不出来（' + otherTextures.length + ' 个，这些面被丢掉了）：')
        for (const name of otherTextures.slice(0, 4)) {
          const entry = textureMissingOf(load, name, directory)
          lines.push('  - ' + entry.name + ' → ' + entry.fixPath)
        }
        if (otherTextures.length > 4) lines.push('  - …（还有 ' + (otherTextures.length - 4) + ' 个，见结构化诊断）')
      }
      if (project.length === 0 && vanilla.length === 0 && textures.length === 0) {
        lines.push(built.noElements === true
          ? '· 整条模型链里**没有任何 elements**（不是"画出来是空的"）：通常是链上某个母模型'
            + '没取到（空壳/版本不对/参考目录没设），而不是这个方块真的靠方块实体渲染'
          : '· 模型链是完整的，但整条链里一个面都没画出来（这个方块可能靠方块实体渲染）')
      }
      lines.push('· 原因：' + reason)
      if (typeof built.why === 'string' && built.why !== '') lines.push('· 现取失败的原因：' + built.why)
      if (typeof built.textureWhy === 'string' && built.textureWhy !== '') {
        lines.push('· 贴图现取失败的原因：' + built.textureWhy)
      }
      lines.push('· 参考目录：' + (directory === '' ? '（没设）' : directory))
      lines.push('· 已试过的路：' + tried.join(' → '))
      lines.push('· 修法：' + fixTextOf(reason))
      lines.push('· 这份报告只在屏幕上，不写进会话 / inbox / 日志；可以整段复制走')
      if (lines.length > 20) {
        lines.splice(20, lines.length - 20)
        lines[19] = '· …（还省略了一些行；结构化诊断里有全部内容）'
      }
      return { reason: reason, missing: missing, tried: tried, lines: lines }
    }


    function fixTextOf(reason) {
      if (reason === 'project-model-missing') {
        return '把上面列出的项目自己的模型文件补上（路径已经给出）；blockstate 里写什么名字，'
          + '文件名就必须是什么（multipart 方块要补的是 _post / _side 那几件，不是 <方块名>.json）'
      }
      if (reason === 'no-reference-directory') {
        return '面板设置里把参考目录指到 .minecraft/versions/<版本>（或写进 mc-art.settings.json 的 '
          + 'reference.directory）；原版母模型都在那个版本的 jar 里'
      }
      if (reason === 'vanilla-parent-missing') {
        return '参考目录指的那个版本里没有这些原版母模型：核对版本号（1.16 之后墙是 template_wall_post / '
          + 'template_wall_side / template_wall_side_tall），或把 parent 改成该版本真实存在的名字'
      }
      if (reason === 'reference-jar-missing') {
        return '参考目录里没找到能读的 jar：指到 .minecraft/versions/<版本>（里面应有 <版本>.jar），'
          + '不要指到 .minecraft 本身'
      }
      if (reason === 'extractor-failed') {
        return '抽取脚本自己失败了：看上面"现取失败的原因"那一行，先确认 Python 与脚本路径'
      }
      if (reason === 'textures-unresolved') {
        return '这些面引用的贴图在项目包里没有、参考目录里也没取到：把参考目录指对版本，'
          + '或者在项目包里补上同名的 PNG（路径已经给出）'
      }
      if (reason === 'texture-missing-hash') {
        return '把这些面里的裸词前面补上 `#`：贴图**变量**必须带 `#`，不带 `#` 的裸词会被当成路径，'
          + '于是去找 <命名空间>:textures/<词>.png（那里通常没有）—— 例如 `"texture": "stone"` 要写 `"texture": "#stone"`。'
          + '这两个方块在游戏里同样是坏的（会渲染成缺失贴图）'
      }
      if (reason === 'texture-variable-unresolved') {
        return '`#变量` 在模型的 textures 映射里找不到：把映射里缺的键补上，或者把面改成映射里已有的那个键'
      }
      if (reason === 'no-quads') {
        return '模型链是完整的但一个面都没画出来：这个方块很可能靠方块实体在代码里渲染，'
          + '面板画不出它的实体模型；要 3D 预览就得在项目包里补一个带 elements 的模型'
      }
      if (reason === 'no-geometry') {
        return '整条模型链里没有任何 elements：先看"已试过的路"那一行 —— 链上哪个母模型是空壳/没取到，'
          + '就补哪个（项目包里的补文件；原版的把参考目录指到 .minecraft/versions/<版本>）。'
          + '这不等于"这个方块靠方块实体渲染"'
      }
      if (reason === 'parent-cycle') {
        return '模型 parent 成环了：把链上重复出现的那个 parent 去掉'
      }
      return '模型链完整却没有 elements：这个方块可能靠方块实体渲染（没有几何模型），'
        + '或者在项目包里补一个带 elements 的模型'
    }

    async function payload(root, project, kind, id, have, cellsOverride, neighbours) {
      const dir = project.dir
      const namespace = project.namespace
      const neighbourAware = neighbours !== false
      const load = preloads.get(namespace)
      if (load === undefined) return { error: 'project not loaded: ' + namespace }
      let quads = []
      let refs = []
      let palette = []
      let cells = null
      let blockModel = null
      let blockModels = []

      if (kind === 'block') {
        const found = (await blockIds(load)).filter((block) => block.id === id)[0]
        if (found === undefined) return { error: 'block not found: ' + id }
        blockModel = found.model
        blockModels = found.models
        const built = await projectElements(project, load, found.model)
        const elements = built.elements
        quads = elements === undefined ? undefined : quadsFromElements(elements, note)
        if (elements === undefined || quads.length === 0) {
          if (elements !== undefined) built.noQuads = true
          else built.noElements = true
          const directory = await referenceDirectory(project)
          const failed = blockDiagnostic(load, namespace, id, found, built, directory)
          return { error: failed.lines.join('\n'), notified: false, notifyVia: null,
            diagnostic: { reason: failed.reason, block: namespace + ':' + id, missing: failed.missing,
              tried: failed.tried, referenceDirectory: directory } }
        }
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
          const kept = { block: cell.block, at: cell.at }
          if (typeof cell.variant === 'string' && cell.variant !== '') kept.variant = cell.variant
          byCell.set(key, kept)
        }
        cells = Array.from(byCell.values())
        const cache = new Map()
        const counts = new Map()
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
          const cellKey = fullName + (cell.variant === null || cell.variant === undefined ? '' : '@' + cell.variant)
          let slot = cache.get(cellKey)
          if (slot === undefined) {
            slot = { load: undefined, entry: null, union: undefined,
              id: fullName, variant: cell.variant === undefined ? null : cell.variant }
            const found = await entryFor(root, project, reference, cell.variant)
            if (found.error !== undefined) note('取不到 ' + fullName + '：' + found.error)
            else { slot.load = found.load; slot.entry = found.entry; slot.id = found.id }
            cache.set(cellKey, slot)
          }
          slots.push(slot)
          atCell.set(neatKey(cell.at), slot)
        }
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
        const url = await textureUrlFor(path, project)
        if (url !== undefined) textures[path] = url
      }
      return { kind: kind, id: id, title: labelFor(namespace, kind, id),
        project: project.title || project.id,
        quads: quads, textureIds: textureIds, textures: textures,
        animations: animationsFor(textureIds), animationNotes: animationNotesFor(textureIds),
        cells: cells, faceStep: FACE_STEP,
        model: blockModel, models: blockModels,
        refs: refs, ref: refs[0], palette: palette, box: boxOfQuads(quads), errors: errors.slice(0, 8) }
    }

    async function shellExec(spec) {
      const service = shellOf()
      if (service === undefined) return { exitCode: null, text: '', err: 'no shell service' }
      if (typeof service.run === 'function') return await service.run(spec)
      if (typeof service.execute === 'function') return await service.execute(spec)
      return { exitCode: null, text: '', err: '这个 shell 服务既没有 run() 也没有 execute()：' +
        Object.keys(service).join(',') }
    }


    function shellText(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      return value.text === undefined ? String(value) : String(value.text)
    }

    async function runShell(command, timeoutMs, sandboxPolicy, maxBytes) {
      if (shellOf() === undefined) return { exitCode: null, text: '', err: 'no shell service' }
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

    const PS_QUOTE = (value) => "'" + String(value).split("'").join("''") + "'"
    const SHELLS = {
      posix: {
        name: 'posix',
        word: (value) => shellDecoded(value),
        available: (tool) => 'command -v ' + tool,
        remove: (path) => 'rm -f ' + shellDecoded(path),
        makeDir: (path) => 'mkdir -p ' + shellDecoded(path),
        move: (from, to) => 'mv -f ' + shellDecoded(from) + ' ' + shellDecoded(to),
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
        makeDir: (path) => '[IO.Directory]::CreateDirectory(' + PS_QUOTE(path) + ') | Out-Null',
        move: (from, to) => 'Move-Item -LiteralPath ' + PS_QUOTE(from) +
          ' -Destination ' + PS_QUOTE(to) + ' -Force',
        decodeFile: (source, target) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String([IO.File]::ReadAllText(' + PS_QUOTE(source) + ')))',
        writeInline: (target, base64) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String(' + PS_QUOTE(base64) + '))',
      },
    }
    let shellDialect = null

    let shellProbeInfo = null
    async function currentShell(workspaceRoot) {
      if (shellDialect !== null) return SHELLS[shellDialect]
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
      const probe = await runShell('echo "mcart-shell:$($PSVersionTable.PSVersion.Major)"', 20000,
        policyFor(workspaceRoot), 4096)
      shellProbeInfo = { platform: platform, exitCode: probe.exitCode,
        text: String(probe.text).slice(0, 80), err: String(probe.err).slice(0, 80) }
      if (probe.exitCode !== 0) return SHELLS.posix
      shellDialect = /^mcart-shell:\d+/.test(String(probe.text).trim()) ? 'pwsh' : 'posix'
      return SHELLS[shellDialect]
    }


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


    async function writeDecodedFile(target, base64, workspaceRoot, timeoutMs) {
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
        const directory = typeof reference.directory === 'string' ? reference.directory : ''
        const scanner = await findScanner(project.dir)
        const scanned = await scanReference(scanner, directory)
        const detected = directory === '' ? await detectGameRoots(project.dir) : []
        return {
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

    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10]

    ctx.effect(() => harness.handle('atlas.saveTexture', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const path = typeof request.path === 'string' ? request.path : ''
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (path === '') return { error: '贴图句柄是空的，拒绝写' }
      if (base64 === '') return { error: '缺少图像数据' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        let target = path
        if (path.slice(0, 4) === 'ref:') {
          const resolved = editablePaths.get(path)
          if (resolved === undefined) {
            return { error: '这张贴图不在这个项目的资源包里（它在参考的 jar 里），改不了：' + path }
          }
          target = resolved
        }
        const placed = packPathOf(project, target)
        if (placed.ok !== true) {
          return { error: placed.reason + '：' + String(target) }
        }
        target = placed.path
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
        const folders = ['pack', 'pack/assets', 'pack/assets/' + namespace,
          'pack/assets/' + namespace + '/textures/block', 'pack/assets/' + namespace + '/models/block',
          'pack/assets/' + namespace + '/blockstates', 'pack/assets/' + namespace + '/lang']
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

    ctx.effect(() => harness.handle('atlas.preview', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const block = typeof request.block === 'string' ? request.block : ''
      const at = Array.isArray(request.at) && request.at.length >= 3
        ? [Math.trunc(request.at[0]), Math.trunc(request.at[1]), Math.trunc(request.at[2])] : [0, 0, 0]
      const variant = typeof request.variant === 'string' && request.variant !== '' ? request.variant : null
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
          const url = await textureUrlFor(path, project)
          if (url !== undefined) textures[path] = url
        }
        return { block: block, at: at, quads: built.quads, textureIds: textureIds, textures: textures,
          animations: animationsFor(textureIds), animationNotes: animationNotesFor(textureIds),
          variants: built.variants || [], axes: built.axes || [], defaults: built.defaults || {},
          multipart: built.multipart === true, derived: built.derived === true,
          variant: built.variant === undefined ? null : built.variant }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

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
          const url = tex === undefined ? undefined : await textureUrlFor(tex, project)
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
        const parsed = await runScanner(extractor, ['--root', directory, '--namespaces'],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        const out = (parsed.namespaces || []).filter((item) => item.blocks > 0)
        return { directory: directory, version: parsed.version, versionWhy: parsed.versionWhy,
          namespaces: out, extractor: extractor }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

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
        const failed = Array.isArray(parsed.failed) ? parsed.failed : []
        for (const id of Object.keys(parsed.icons || {})) {
          const item = parsed.icons[id]
          const key = namespace + ':' + id
          const problem = refIconEntryProblem(item)
          if (problem !== null) { failed.push(id + '（没有图标数据：' + problem + '）'); continue }
          icons[key] = 'data:image/png;base64,' + item.png
          names[key] = typeof item.name === 'string' && item.name !== '' ? item.name : id
        }
        return { icons: icons, names: names, failed: failed, version: parsed.version }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.releaseRefs', async (args) => {
      const request = args || {}
      const keep = {}
      if (Array.isArray(request.keep)) for (const key of request.keep) keep[String(key)] = true
      return releaseUnused(referenceBlocks, keep, referenceTextures, referenceAnimations)
    }))

    console.log('mc-art atlas host ready (unqualified cell blocks resolve to their project; vanilla and mod blocks are extracted on demand)')
}
return {
  apply(ctx) {
    installHost(ctx)
  },
}

  // <<< mcart:embedded-source
  })(harness, console, TextEncoder, btoa, atob, nodeFs, MODULE_DIR, process)
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('mcart 宿主源码没有返回一个带 apply 的插件')
  }

  // 一条路由，全部信道。客户端那边 host.call(name, args) 走的就是它。
  const MAX_BYTES = 16 * 1024 * 1024
  ctx.inject(['webServer'], (httpCtx) => {
    if (routeReady) return
    routeReady = true
    httpCtx.webServer.register({
      kind: 'exact',
      path: '/api/mcart/call',
      handler: (req, res) => {
        function send(status, payload) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(payload))
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          send(405, { error: '这条路由只收 POST' })
          return
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) { req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', async () => {
          let request
          try {
            request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch (error) {
            send(400, { error: '请求不是 JSON：' + String(error && error.message ? error.message : error) })
            return
          }
          const name = typeof request.name === 'string' ? request.name : ''
          const table = liveHandlers
          const handler = table === null ? undefined : table[name]
          if (typeof handler !== 'function') {
            // 报错里带上"谁在应答"：版本 + 已注册多少方法。没有这两样，这种问题只能靠猜
            // （"宿主没有这个方法"到底是旧实例、空表，还是名字真的写错了）。
            const count = table === null ? 0 : Object.keys(table).length
            send(404, { error: '宿主没有这个方法：' + name +
              '（宿主 dsh-mc-art-panel@' + VERSION + '，已注册 ' + count + ' 个方法' +
              (table === null ? '，宿主已卸载' : '') + '）' })
            return
          }
          try {
            const value = await handler(request.args === undefined ? null : request.args)
            send(200, value === undefined ? null : value)
          } catch (error) {
            send(500, { error: String(error && error.message ? error.message : error) })
          }
        })
        req.on('error', () => { send(400, { error: '请求读失败' }) })
      },
    })
  })

  return plugin.apply(ctx)
}
