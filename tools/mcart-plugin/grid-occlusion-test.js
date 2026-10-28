// 地面网格必须参与深度：**不能盖在方块上**。
//
// 用户实测的原话："方块的 3D 视图确实感觉有透明感，主要是那个网格线能透过方块看到"。
// 根因是渲染顺序：3D 结果先 putImageData，之后又用 canvas 2D 描网格线 —— 那等于
// 网格画在所有像素之上，方块看起来就像半透明。现在网格写进像素/深度缓冲。
//
// 这条门禁直接执行**产物里的** drawGroundGridInto：用假相机喂两个缓冲，
// 断言背景上有线、而方块（深度更近）覆盖的像素一个点都不许被网格染色。
const fs = require('fs')
const path = require('path')

const CLIENT = process.env.MCART_CLIENT || path.join(__dirname, 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || !detail ? '' : '  -> ' + detail))
}

/** 从产物里取出一个顶层函数（按花括号配平）。 */
function extract(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('产物里没有 ' + name)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth += 1
    else if (src[index] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, index + 1)
    }
  }
  throw new Error('花括号没配平：' + name)
}

const body = extract('drawGroundGridInto')
const make = new Function(body + '\nreturn drawGroundGridInto')
const drawGroundGridInto = make()

/** 假相机：世界 (x,y,z) → 屏幕 (x*10+60, z*10+60)，相机深度恒为 5。 */
const camera = { project: (point) => [point[0] * 10 + 60, point[2] * 10 + 60, 5] }
const box = { min: [-8, -8, -8], max: [8, 8, 8] }
const WIDTH = 120
const HEIGHT = 120

function freshBuffers() {
  const colour = new Float64Array(WIDTH * HEIGHT * 4)      // 全黑背景
  const depth = new Float64Array(WIDTH * HEIGHT)           // 0 = 最近的方块像素
  depth.fill(Infinity)
  return { colour: colour, depth: depth }
}

// ── 1. 背景上确实画了线 ────────────────────────────────────────────────────────
const empty = freshBuffers()
drawGroundGridInto(empty.colour, empty.depth, WIDTH, HEIGHT, camera, box)
let drawn = 0
for (let i = 0; i < empty.colour.length; i += 4) if (empty.colour[i] > 0) drawn += 1
check('背景上画得出地面网格（有不透明的线像素）', drawn > 50, drawn + ' 个像素')

// ── 2. 方块覆盖的像素一个点都不许被染色 ───────────────────────────────────────
const OCCLUDER = 0.5
const blocked = freshBuffers()
for (let y = 40; y <= 80; y++) {
  for (let x = 40; x <= 80; x++) {
    const index = y * WIDTH + x
    blocked.depth[index] = 1          // 比网格（深度 5）更近：这里被方块挡住了
    const target = index * 4
    blocked.colour[target] = OCCLUDER
    blocked.colour[target + 1] = OCCLUDER
    blocked.colour[target + 2] = OCCLUDER
  }
}
drawGroundGridInto(blocked.colour, blocked.depth, WIDTH, HEIGHT, camera, box)
let stained = 0
for (let y = 40; y <= 80; y++) {
  for (let x = 40; x <= 80; x++) {
    const target = (y * WIDTH + x) * 4
    if (blocked.colour[target] !== OCCLUDER || blocked.colour[target + 1] !== OCCLUDER
      || blocked.colour[target + 2] !== OCCLUDER) stained += 1
  }
}
check('方块挡住的地方，网格一个像素都不许画上去（"网格线透过方块"就是这个 bug）',
  stained === 0, stained + ' 个像素被网格染色了')

// ── 3. 网格只在背景处出现：线必须在 occluder 之外还看得见 ─────────────────────
let outsideLines = 0
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const index = y * WIDTH + x
    if (blocked.depth[index] !== Infinity) continue
    if (blocked.colour[index * 4] > 0) outsideLines += 1
  }
}
check('挡住之外的背景仍然有网格线（修好遮挡不等于把网格删了）', outsideLines > 50, outsideLines + ' 个像素')

// ── 4. 渲染路径必须用缓冲版本，不能再有画布版本 ───────────────────────────────
check('渲染路径调用 drawGroundGridInto(colourBuf, depthBuf, …)',
  /drawGroundGridInto\(colourBuf, depthBuf, size\[0\], size\[1\], camera, box\)/.test(src))
check('渲染路径里不再出现画布版网格（它会盖在方块上）',
  !/drawGroundGrid\(paint, camera/.test(src))

// ── 反向夹具：去掉深度判定 → 第 2 条必须红 ───────────────────────────────────
if (process.argv.indexOf('--fault') >= 0) {
  const broken = body.replace('if (!(z <= depth[index])) continue', 'if (false) continue')
  if (broken === body) {
    console.log('  FAIL 故障注入没生效（找不到深度判定那一行）')
    failures += 1
  } else {
    const makeBroken = new Function(broken + '\nreturn drawGroundGridInto')
    const runBroken = makeBroken()
    const faulted = freshBuffers()
    for (let y = 40; y <= 80; y++) {
      for (let x = 40; x <= 80; x++) {
        const index = y * WIDTH + x
        faulted.depth[index] = 1
        const target = index * 4
        faulted.colour[target] = OCCLUDER
        faulted.colour[target + 1] = OCCLUDER
        faulted.colour[target + 2] = OCCLUDER
      }
    }
    runBroken(faulted.colour, faulted.depth, WIDTH, HEIGHT, camera, box)
    let faultedStains = 0
    for (let y = 40; y <= 80; y++) {
      for (let x = 40; x <= 80; x++) {
        const target = (y * WIDTH + x) * 4
        if (faulted.colour[target] !== OCCLUDER) faultedStains += 1
      }
    }
    check('故障注入（删掉深度判定）后，方块区域确实被网格染色了', faultedStains > 0, faultedStains + ' 个像素')
  }
}

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
