const fs = require('fs')
function load(source) {
  const start = source.indexOf('const EDIT_ZOOM')
  // The end marker is a COMMENT, and this gate also runs against the emitted
  // (stripped) half: `indexOf` then returned -1, `slice(start, -1)` cut the last
  // character off, and the failure looked like "Unexpected token 'function'".
  const marked = source.indexOf('/** The colours actually used')
  const end = marked >= 0 ? marked : source.indexOf('function paletteOf(')
  const body = source.slice(start, end) + source.slice(source.indexOf('function paletteOf('), source.lastIndexOf('\nreturn {'))
  return new Function(body + '; return {cssColour, fromHex, hexOf, addToPalette, faceLabel, sameColour, readPixel, writePixel, paletteOf, EDIT_ZOOM, EDIT_UNDO, VIEW_H, VIEW_H_MIN, VIEW_H_MAX, clampViewH, texturePoint};')()
}
// The default used to be a working copy under /tmp, which a reboot wipes -- and
// then the gate failed for a reason that had nothing to do with the code.  Same
// rule as the other gates: read the repository unless MCART_CLIENT says otherwise.
const path = process.argv[2] || process.env.MCART_CLIENT || require('path').join(__dirname, 'client.js')
const source = fs.readFileSync(path, 'utf8')
const api = load(source)

let fail = 0
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail += 1
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok ? '' : '  得到 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want)))
}

const px = new Uint8ClampedArray([255,0,0,255, 0,0,0,0, 255,0,0,255, 0,0,255,128])
check('paletteOf 跳过全透明像素', api.paletteOf(px, 32), [[255,0,0,255],[0,0,255,128]])
check('paletteOf 按首次出现去重', api.paletteOf(px, 32).length, 2)
check('paletteOf 有上限', api.paletteOf(px, 1), [[255,0,0,255]])
check('readPixel (x=1,y=1) 在 2 宽的图里', api.readPixel(px, 2, 1, 1), [0,0,255,128])

// 3x3 空图，写到 (x=1,y=1) -> 偏移 (1*3+1)*4 = 16
const g = new Uint8ClampedArray(3*3*4)
api.writePixel(g, 3, 1, 1, [1,2,3,4])
check('writePixel 落在 (x=1,y=1) 的偏移 16', Array.from(g.slice(16, 20)), [1,2,3,4])
check('writePixel 只动那一个像素', g.filter((v) => v !== 0).length, 4)
api.writePixel(g, 3, 0, 2, [9,8,7,6])
check('writePixel (x=0,y=2) -> 偏移 24', Array.from(g.slice(24, 28)), [9,8,7,6])

check('sameColour 全等才真', [api.sameColour([1,2,3,4],[1,2,3,4]), api.sameColour([1,2,3,4],[1,2,3,5])], [true,false])
check('cssColour 透明', api.cssColour(null), 'transparent')
check('缩放 18 / 撤销 24', [api.EDIT_ZOOM, api.EDIT_UNDO], [18, 24])

// 3D+物品栏那一块的高度由底边的手柄拖：拖动量必须被夹在范围内，否则一次拖过头
// 就把模型挤到只剩一条缝（下限）或者让面板滚出屏幕（上限）。
check('默认高度在范围里', [api.VIEW_H_MIN < api.VIEW_H, api.VIEW_H < api.VIEW_H_MAX], [true, true])
check('拖到范围内就按拖动量走', api.clampViewH(300), 300)
check('往上拖过头夹在下限', api.clampViewH(-400), api.VIEW_H_MIN)
check('往下拖过头夹在上限', api.clampViewH(99999), api.VIEW_H_MAX)
check('边界本身不被推开', [api.clampViewH(api.VIEW_H_MIN), api.clampViewH(api.VIEW_H_MAX)],
  [api.VIEW_H_MIN, api.VIEW_H_MAX])
check('半像素取整（canvas 高度要是整数）', api.clampViewH(197.6), 198)

// 画笔把点击换算成贴图格子。画布是替换元素：`width:100%` + `height:auto` +
// `max-height:52vh` + `object-fit:contain`，所以**盒子 ≠ 画**：盒子比画宽的时候，
// 画按高度缩放、左右留边居中。按整块盒子算就会点错格子，侧边栏越宽错得越多
// （用户："我点了a格子 但被上色或者擦掉的是左边的格子 尤其是我把侧边栏拉宽"）。
const wideBox = { left: 100, top: 50, width: 800, height: 400 }   // 2:1 的盒子装 1:1 的画
const square = { w: 16, h: 16 }
check('盒子比画宽：点画的左边缘就是第 0 格',
  api.texturePoint(wideBox, square, 100 + 200, 50 + 200), [0, 8])
check('盒子比画宽：点画的右边缘是最后一格（不是外面）',
  api.texturePoint(wideBox, square, 100 + 200 + 400 - 1, 50 + 200), [15, 8])
check('盒子比画宽：中心还是中心',
  api.texturePoint(wideBox, square, 100 + 400, 50 + 200), [8, 8])
check('盒子正好合画时和原来一样（不留边就不该有偏移）',
  api.texturePoint({ left: 0, top: 0, width: 320, height: 320 }, square, 160, 160), [8, 8])
check('非方形贴图也不留错边（32x16 在方盒子里）',
  api.texturePoint({ left: 0, top: 0, width: 320, height: 320 }, { w: 32, h: 16 }, 0, 160), [0, 8])
// 真注入：把 texturePoint 整个换回"按整块盒子算"（原来的写法），
// 同一处点击必须算出那个错的格子，证明上面几条抓得住。
const oldWay = load(source.replace(
  /function texturePoint\(rect, target, clientX, clientY\) \{[\s\S]*?\n\}/,
  `function texturePoint(rect, target, clientX, clientY) {
  if (rect.width === 0 || rect.height === 0) return null
  return [
    Math.floor((clientX - rect.left) / rect.width * target.w),
    Math.floor((clientY - rect.top) / rect.height * target.h),
  ]
}`))
check('注入"按整块盒子算"（原来的写法）：点画的左边缘被算成第 4 格（错的那个）',
  oldWay.texturePoint(wideBox, square, 100 + 200, 50 + 200), [4, 8])

// 拖动系统取色器会连着发很多次事件；色板只能因为明确要求才变
const base = [[1, 2, 3, 255], [4, 5, 6, 255]]
check('加已有的颜色：色板不变', api.addToPalette(base, [1, 2, 3, 255], 64), base)
check('加新颜色：多一个', api.addToPalette(base, [9, 9, 9, 255], 64).length, 3)
check('透明不算颜色', api.addToPalette(base, null, 64), base)
check('色板有上限', api.addToPalette(base, [7, 7, 7, 255], 3).length, 3)
check('超上限丢最旧的', api.addToPalette([[1,1,1,255],[2,2,2,255],[3,3,3,255]], [4,4,4,255], 3)[0], [2, 2, 2, 255])
check('hex 往返', api.hexOf(api.fromHex('#1a2b3c', 200)), '#1a2b3c')

// 页签要说清楚它管哪些面：草方块默认不能停在“底面”
check('只有 up -> 顶面', api.faceLabel(['up']), '顶面')
check('只有 down -> 底面', api.faceLabel(['down']), '底面')
check('四个侧 -> 侧面', api.faceLabel(['north','south','west','east']), '侧面')
check('顶+侧 -> 顶面+侧面', api.faceLabel(['up','north','east']), '顶面+侧面')
check('全六面', api.faceLabel(['up','down','north','south','west','east']), '顶面+侧面+底面')
check('没有面 -> 贴图', api.faceLabel([]), '贴图')

const w = 3, h = 3
const grid = new Uint8ClampedArray(w*h*4)
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) api.writePixel(grid, w, x, y, [0,0,0,255])
api.writePixel(grid, w, 1, 1, [255,255,255,255])
api.writePixel(grid, w, 2, 2, [255,255,255,255])
const stack = [[1,1]], visited = {}
while (stack.length) {
  const p = stack.pop(), x = p[0], y = p[1]
  if (x < 0 || y < 0 || x >= w || y >= h) continue
  const k = y*w + x
  if (visited[k]) continue
  visited[k] = true
  if (!api.sameColour(api.readPixel(grid, w, x, y), [255,255,255,255])) continue
  api.writePixel(grid, w, x, y, [9,9,9,255])
  stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1])
}
check('油漆桶对角不漏', api.readPixel(grid, w, 2, 2), [255,255,255,255])
check('油漆桶填了起点', api.readPixel(grid, w, 1, 1), [9,9,9,255])

// CONSTANT-SCAN: 常量用了但没声明 —— 语法检查抓不到，只有真跑到那一行才会炸。
{
  const src = fs.readFileSync(path, 'utf8')
  const declared = new Set()
  for (const m of src.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of src.matchAll(/\b(EDIT_[A-Z_]+|MCART_[A-Z_]+)\b/g)) {
    if (!declared.has(m[1])) {
      fail += 1
      console.log('  FAIL 常量 ' + m[1] + ' 被用到但没声明（只会在跑到那一行时炸）')
    }
  }
}

console.log(fail === 0 ? '  全部通过' : '  ' + fail + ' 条失败')
process.exit(fail === 0 ? 0 : 1)
